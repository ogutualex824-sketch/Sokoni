/* ================================================================
   SOKONI GIP — Fleet Manager  v1.0.0

   Manages the digital twin registry for all tracked assets:
   vehicles, motorcycles, bicycles, ambulances, SmartPOS devices,
   field agents, and future drone units.

   Firestore collections used:
     gipAssets/{assetId}  — asset registry (metadata + current status)
     gipFleet/{assetId}   — vehicle-specific data (health, maintenance)

   Exposes: window.SokoniGIPFleet  +  ES default export
================================================================ */

import { db, auth } from './firebase.js';
import {
  doc, setDoc, updateDoc, getDoc, getDocs,
  collection, query, where, orderBy, limit,
  serverTimestamp, Timestamp, deleteField,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

/* ── Vehicle type config ──────────────────────────────────────── */

const VEHICLE_TYPES = {
  bicycle:    { emoji: '🚲', capacityKg: 15,   fuelType: 'none',     avgSpeedKph: 18 },
  motorbike:  { emoji: '🛵', capacityKg: 30,   fuelType: 'petrol',   avgSpeedKph: 35 },
  car:        { emoji: '🚗', capacityKg: 200,  fuelType: 'petrol',   avgSpeedKph: 50 },
  van:        { emoji: '🚐', capacityKg: 800,  fuelType: 'diesel',   avgSpeedKph: 40 },
  truck:      { emoji: '🚛', capacityKg: 3000, fuelType: 'diesel',   avgSpeedKph: 30 },
  ambulance:  { emoji: '🚑', capacityKg: 500,  fuelType: 'petrol',   avgSpeedKph: 70 },
  tuk_tuk:    { emoji: '🛺', capacityKg: 100,  fuelType: 'petrol',   avgSpeedKph: 25 },
  electric:   { emoji: '⚡', capacityKg: 50,   fuelType: 'electric', avgSpeedKph: 30 },
  drone:      { emoji: '🚁', capacityKg: 5,    fuelType: 'electric', avgSpeedKph: 60 },
};

/* Health score thresholds */
const HEALTH_GRADE = [
  { min: 90, grade: 'A', label: 'Excellent' },
  { min: 75, grade: 'B', label: 'Good' },
  { min: 60, grade: 'C', label: 'Fair' },
  { min: 40, grade: 'D', label: 'Poor' },
  { min:  0, grade: 'F', label: 'Critical — ground immediately' },
];

/* Days before expiry that we flag as "expiring soon" */
const EXPIRY_WARN_DAYS = 30;

/* ── Helpers ──────────────────────────────────────────────────── */

function _daysUntil(tsOrDate) {
  if (!tsOrDate) return null;
  const d = tsOrDate.toDate ? tsOrDate.toDate() : new Date(tsOrDate);
  return Math.floor((d.getTime() - Date.now()) / 86_400_000);
}

function _yyyymmdd(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function _healthGrade(score) {
  return HEALTH_GRADE.find(g => score >= g.min) ?? HEALTH_GRADE[HEALTH_GRADE.length - 1];
}

/* ══════════════════════════════════════════════════════════════
   FleetManager
══════════════════════════════════════════════════════════════ */

export default class FleetManager {

  constructor() {
    this._localCache = new Map();   /* assetId → asset doc */
    this._unsubscribers = [];
  }

  /* ── Asset registration ────────────────────────────────────── */

  /**
   * Register a new asset in the fleet.
   * Idempotent — calling with the same assetId updates the record.
   *
   * @param {object} asset
   *   Required: assetId, uid, name, vehicleType, module
   *   Optional: make, model, year, plate, color, capacityKg, fuelType,
   *             insuranceExpiry, inspectionExpiry, region
   */
  async register(asset) {
    const {
      assetId, uid, name, vehicleType = 'motorbike', module = 'delivery', region = 'nairobi',
      make = '', model = '', year = null, plate = '', color = '',
      capacityKg = null, fuelType = null,
      insuranceExpiry = null, inspectionExpiry = null,
    } = asset;

    if (!assetId || !uid) throw new Error('[Fleet] assetId and uid are required');

    const vtConfig = VEHICLE_TYPES[vehicleType] ?? VEHICLE_TYPES.motorbike;

    const record = {
      assetId,
      uid,
      name,
      vehicleType,
      module,
      region,
      make, model, year, plate, color,
      capacityKg:        capacityKg ?? vtConfig.capacityKg,
      fuelType:          fuelType   ?? vtConfig.fuelType,
      emoji:             vtConfig.emoji,
      insuranceExpiry:   insuranceExpiry ? Timestamp.fromDate(new Date(insuranceExpiry)) : null,
      inspectionExpiry:  inspectionExpiry ? Timestamp.fromDate(new Date(inspectionExpiry)) : null,
      /* Runtime state */
      status:            'offline',
      isOnline:          false,
      currentFuelLevel:  null,
      currentBatteryLevel: null,
      odometerKm:        0,
      lastServiceKm:     0,
      nextServiceKm:     5000,
      rating:            5.0,
      totalDeliveries:   0,
      totalDistanceKm:   0,
      /* Timestamps */
      registeredAt:  serverTimestamp(),
      updatedAt:     serverTimestamp(),
    };

    await setDoc(doc(db, 'gipAssets', assetId), record, { merge: true });
    this._localCache.set(assetId, record);
    return assetId;
  }

  /* ── Asset update ──────────────────────────────────────────── */

  async update(assetId, data) {
    if (!assetId) throw new Error('[Fleet] assetId required');
    const sanitized = { ...data, updatedAt: serverTimestamp() };
    await updateDoc(doc(db, 'gipAssets', assetId), sanitized);
    /* Merge into local cache */
    const cached = this._localCache.get(assetId) ?? {};
    this._localCache.set(assetId, { ...cached, ...sanitized });
  }

  /* ── Vehicle health score ──────────────────────────────────── */

  /**
   * Compute a composite vehicle health score (0–100).
   *
   * Scoring breakdown:
   *   Fuel / battery level   20 pts
   *   Odometer vs service    25 pts
   *   Insurance validity     20 pts
   *   Inspection validity    20 pts
   *   Tracker heartbeat      15 pts
   *
   * @param {string|object} assetIdOrDoc — assetId string or existing asset doc
   * @returns {Promise<{healthScore, grade, label, issues[], requiresAttention, requiresImmediate}>}
   */
  async health(assetIdOrDoc) {
    let vehicle;
    if (typeof assetIdOrDoc === 'string') {
      vehicle = this._localCache.get(assetIdOrDoc);
      if (!vehicle) {
        const snap = await getDoc(doc(db, 'gipAssets', assetIdOrDoc));
        if (!snap.exists()) throw new Error('[Fleet] Asset not found: ' + assetIdOrDoc);
        vehicle = snap.data();
        this._localCache.set(assetIdOrDoc, vehicle);
      }
    } else {
      vehicle = assetIdOrDoc;
    }

    const issues = [];
    let score = 100;

    /* ── Fuel / battery (20 pts) ── */
    const fuelLevel = vehicle.currentFuelLevel ?? vehicle.currentBatteryLevel;
    if (fuelLevel !== null) {
      if (fuelLevel < 10)      { score -= 20; issues.push({ type: 'fuel',     severity: 'critical', msg: `${vehicle.fuelType === 'electric' ? 'Battery' : 'Fuel'} critically low (${fuelLevel}%)` }); }
      else if (fuelLevel < 25) { score -= 12; issues.push({ type: 'fuel',     severity: 'high',     msg: `${vehicle.fuelType === 'electric' ? 'Battery' : 'Fuel'} low (${fuelLevel}%)` }); }
      else if (fuelLevel < 40) { score -=  5; issues.push({ type: 'fuel',     severity: 'info',     msg: `Refuel soon (${fuelLevel}%)` }); }
    }

    /* ── Odometer vs next service (25 pts) ── */
    const nextService = vehicle.nextServiceKm ?? 5000;
    const odometer    = vehicle.odometerKm    ?? 0;
    const lastService = vehicle.lastServiceKm ?? 0;
    const kmSinceService = odometer - lastService;
    const kmToService    = nextService - kmSinceService;
    if (kmToService < 0)       { score -= 25; issues.push({ type: 'service',  severity: 'critical', msg: `Overdue for service by ${Math.abs(kmToService).toLocaleString()} km` }); }
    else if (kmToService < 200){ score -= 15; issues.push({ type: 'service',  severity: 'high',     msg: `Service due in ${kmToService} km` }); }
    else if (kmToService < 500){ score -=  5; issues.push({ type: 'service',  severity: 'info',     msg: `Service in ${kmToService} km` }); }

    /* ── Insurance (20 pts) ── */
    const insuranceDays = _daysUntil(vehicle.insuranceExpiry);
    if (insuranceDays === null)               { score -= 10; issues.push({ type: 'insurance', severity: 'info', msg: 'Insurance expiry not recorded' }); }
    else if (insuranceDays < 0)               { score -= 20; issues.push({ type: 'insurance', severity: 'critical', msg: `Insurance EXPIRED ${Math.abs(insuranceDays)} days ago` }); }
    else if (insuranceDays < EXPIRY_WARN_DAYS){ score -=  8; issues.push({ type: 'insurance', severity: 'high',    msg: `Insurance expires in ${insuranceDays} days` }); }

    /* ── Inspection / NTSA (20 pts) ── */
    const inspectionDays = _daysUntil(vehicle.inspectionExpiry);
    if (inspectionDays === null)               { score -= 10; issues.push({ type: 'inspection', severity: 'info',     msg: 'Inspection expiry not recorded' }); }
    else if (inspectionDays < 0)               { score -= 20; issues.push({ type: 'inspection', severity: 'critical', msg: `Inspection EXPIRED ${Math.abs(inspectionDays)} days ago` }); }
    else if (inspectionDays < EXPIRY_WARN_DAYS){ score -=  8; issues.push({ type: 'inspection', severity: 'high',    msg: `Inspection expires in ${inspectionDays} days` }); }

    /* ── Tracker heartbeat (15 pts) ── */
    const lastUpdate = vehicle.updatedAt?.toDate ? vehicle.updatedAt.toDate() : null;
    if (!lastUpdate) {
      score -= 10; issues.push({ type: 'tracker', severity: 'info', msg: 'No tracker heartbeat recorded' });
    } else {
      const staleMinutes = Math.floor((Date.now() - lastUpdate.getTime()) / 60_000);
      if (staleMinutes > 120)  { score -= 15; issues.push({ type: 'tracker', severity: 'high', msg: `Tracker silent for ${staleMinutes} min` }); }
      else if (staleMinutes > 30) { score -= 5; issues.push({ type: 'tracker', severity: 'info', msg: `Tracker last seen ${staleMinutes} min ago` }); }
    }

    score = Math.max(0, Math.min(100, score));
    const { grade, label } = _healthGrade(score);

    return {
      assetId:          vehicle.assetId,
      healthScore:      score,
      grade,
      label,
      issues,
      requiresAttention: issues.some(i => i.severity === 'high'),
      requiresImmediate: issues.some(i => i.severity === 'critical'),
    };
  }

  /* ── Daily utilization stats ───────────────────────────────── */

  /**
   * Get or compute daily stats for an asset.
   * Reads from gipDispatch — counts completed jobs + total distance for the day.
   */
  async dailyStats(assetId, date = _yyyymmdd()) {
    const since = new Date(date + 'T00:00:00Z');
    const until = new Date(date + 'T23:59:59Z');

    const snap = await getDocs(query(
      collection(db, 'gipDispatch'),
      where('assignedAssetId', '==', assetId),
      where('status',          '==', 'delivered'),
      where('deliveredAt',     '>=', Timestamp.fromDate(since)),
      where('deliveredAt',     '<=', Timestamp.fromDate(until)),
      orderBy('deliveredAt',   'asc'),
      limit(200)
    ));

    let totalDistanceKm = 0, totalEarningsKES = 0, onlineMinutes = 0;
    const jobs = snap.docs.map(d => d.data());

    jobs.forEach(j => {
      totalDistanceKm  += j.distanceKm      ?? 0;
      totalEarningsKES += j.earningsKES     ?? 0;
    });

    return {
      date,
      assetId,
      deliveries:      jobs.length,
      totalDistanceKm: Math.round(totalDistanceKm * 100) / 100,
      totalEarningsKES,
      onlineMinutes,    /* Requires separate online-time tracker */
      avgDeliveryKm:   jobs.length ? Math.round(totalDistanceKm / jobs.length * 10) / 10 : 0,
    };
  }

  /* ── Fleet list ────────────────────────────────────────────── */

  /**
   * Fetch all registered assets in a region.
   */
  async listByRegion(region, module = null) {
    const q = module
      ? query(collection(db, 'gipAssets'), where('region', '==', region), where('module', '==', module), limit(500))
      : query(collection(db, 'gipAssets'), where('region', '==', region), limit(500));

    const snap = await getDocs(q);
    return snap.docs.map(d => {
      const data = d.data();
      this._localCache.set(data.assetId, data);
      return data;
    });
  }

  /**
   * Get a single asset by ID (cache-first).
   */
  async get(assetId) {
    if (this._localCache.has(assetId)) return this._localCache.get(assetId);
    const snap = await getDoc(doc(db, 'gipAssets', assetId));
    if (!snap.exists()) return null;
    const data = snap.data();
    this._localCache.set(assetId, data);
    return data;
  }

  /* ── Fleet health report ───────────────────────────────────── */

  /**
   * Compute health for all vehicles in a region.
   * Returns [{assetId, healthScore, grade, requiresImmediate, issues}] sorted by score asc.
   */
  async healthReport(region, module = null) {
    const assets = await this.listByRegion(region, module);
    const results = await Promise.allSettled(assets.map(a => this.health(a)));
    return results
      .map((r, i) => r.status === 'fulfilled' ? r.value : { assetId: assets[i].assetId, healthScore: 0, grade: 'F', error: r.reason?.message })
      .sort((a, b) => a.healthScore - b.healthScore);
  }

  /* ── Maintenance scheduling ────────────────────────────────── */

  /**
   * Record a completed service event — resets the service counter.
   */
  async recordService(assetId, { odometerKm, notes = '', cost = 0 } = {}) {
    const asset = await this.get(assetId);
    if (!asset) throw new Error('[Fleet] Asset not found: ' + assetId);

    const nextService = odometerKm + 5000;

    await updateDoc(doc(db, 'gipAssets', assetId), {
      odometerKm,
      lastServiceKm: odometerKm,
      nextServiceKm: nextService,
      updatedAt:     serverTimestamp(),
    });

    /* Log to sub-collection for audit trail */
    await setDoc(doc(collection(db, 'gipAssets', assetId, 'serviceHistory')), {
      assetId,
      odometerKm,
      nextServiceKm: nextService,
      notes,
      cost,
      servicedAt: serverTimestamp(),
    });
  }

  /* ── Cleanup ───────────────────────────────────────────────── */

  destroy() {
    this._unsubscribers.forEach(u => u());
    this._unsubscribers = [];
    this._localCache.clear();
  }

  /* ── Static helpers ─────────────────────────────────────────── */

  static get VEHICLE_TYPES() { return VEHICLE_TYPES; }
  static healthGrade(score)   { return _healthGrade(score); }
}

if (typeof window !== 'undefined') window.SokoniGIPFleet = FleetManager;
