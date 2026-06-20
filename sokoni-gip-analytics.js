/* ================================================================
   SOKONI GIP — Analytics Engine  v1.0.0

   Provides:
   • Driver performance scores (safety, efficiency, rating composite)
   • Vehicle health scoring (mileage, fuel, service intervals)
   • Regional demand aggregation (heatmap data by module + time)
   • Daily / weekly / monthly driver summaries
   • Shift scheduling suggestions (demand-based, deterministic)
   • AI integration hooks (GPT-4 / Claude for insight generation)
     — AI calls are batched and rate-limited; never per-event

   Firestore collections read:
     gipDispatch       — completed job history
     gipLocations      — live asset status
     gipAssets         — asset metadata
     gipAlerts         — alert history

   Firestore collections written:
     gipAnalytics/{date}/{assetId}  — daily driver summaries
     gipHeatData/{region}/{date}    — hourly demand heat snapshots

   Exposes: window.SokoniGIPAnalytics  +  ES default export
================================================================ */

import { db } from './firebase.js';
import {
  collection, doc, setDoc, updateDoc, getDoc, getDocs,
  query, where, orderBy, limit, serverTimestamp,
  Timestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

/* ── Constants ──────────────────────────────────────────────── */

/* Thresholds for driver safety scoring */
const SPEED_LIMIT_KMH  = 80;    /* Above this → speed deduction */
const IDEAL_SPEED_KMH  = 40;    /* Optimal city delivery speed */
const MAX_IDLE_MINUTES = 15;    /* Idle > 15 min per shift → deduction */

/* Vehicle health thresholds */
const SERVICE_INTERVAL_KM = 5_000;
const FUEL_CRITICAL_PCT   = 15;
const BATTERY_CRITICAL_PCT = 20;

/* Demand heat aggregation — grid resolution in degrees */
const HEAT_GRID_DEG = 0.01;  /* ~1.1 km cell at equator */

/* ── Utility ────────────────────────────────────────────────── */

function _yyyymmdd(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function _hourOfDay(date = new Date()) {
  return date.getHours();
}

function _daysSince(timestamp) {
  if (!timestamp) return 999;
  const ms = timestamp.toDate ? timestamp.toDate().getTime() : new Date(timestamp).getTime();
  return Math.floor((Date.now() - ms) / 86_400_000);
}

/** Clamp value to [min, max] */
function _clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

/** Snap lat/lng to heat-grid cell centre */
function _gridKey(lat, lng) {
  const gLat = Math.round(lat / HEAT_GRID_DEG) * HEAT_GRID_DEG;
  const gLng = Math.round(lng / HEAT_GRID_DEG) * HEAT_GRID_DEG;
  return `${gLat.toFixed(4)},${gLng.toFixed(4)}`;
}

/* ══════════════════════════════════════════════════════════════
   GIPAnalytics
══════════════════════════════════════════════════════════════ */

export default class GIPAnalytics {

  _heatAccumulator = new Map();  /* gridKey → { lat, lng, module→count } */
  _heatFlushTimer  = null;
  _aiEnabled       = false;      /* Opt-in; requires sokoni-config API key */

  constructor(options = {}) {
    this._aiEnabled = options.aiEnabled ?? false;
    this._region    = options.region    ?? 'nairobi';
  }

  /* ══════════════════════════════════════════════════════════
     DRIVER ANALYTICS
  ══════════════════════════════════════════════════════════ */

  /**
   * Compute a composite driver score (0–100) from historical job data.
   * Returns { overall, safety, efficiency, reliability, rating, details }
   */
  async computeDriverScore(assetId, days = 30) {
    const jobs   = await this._getCompletedJobs(assetId, days);
    const alerts = await this._getAssetAlerts(assetId, days);
    const meta   = await this._getAssetMeta(assetId);

    if (!jobs.length) {
      return { overall: null, jobCount: 0, reason: 'insufficient_data' };
    }

    /* ── Safety score (0–100) ── */
    const speedingCount = alerts.filter(a => a.type === 'speeding').length;
    const geofenceBreaches = alerts.filter(a => a.type === 'geofence_breach').length;
    const sosEvents     = alerts.filter(a => a.type === 'sos').length;
    const safetyDeduct  = _clamp(speedingCount * 5 + geofenceBreaches * 3 + sosEvents * 10, 0, 40);
    const safetyScore   = _clamp(100 - safetyDeduct, 60, 100);

    /* ── Efficiency score (0–100) ── */
    const totalDist = jobs.reduce((s, j) => s + (j.distanceKm ?? 0), 0);
    const totalTime = jobs.reduce((s, j) => {
      if (!j.pickedUpAt || !j.deliveredAt) return s;
      return s + (j.deliveredAt.toDate().getTime() - j.pickedUpAt.toDate().getTime());
    }, 0);
    const avgSpeedKmh = totalTime > 0
      ? (totalDist / (totalTime / 3_600_000))
      : IDEAL_SPEED_KMH;
    const speedDeviation = Math.abs(avgSpeedKmh - IDEAL_SPEED_KMH) / IDEAL_SPEED_KMH;
    const efficiencyScore = _clamp(100 - speedDeviation * 40, 55, 100);

    /* ── Reliability score (0–100): on-time deliveries ── */
    const jobsWithETA = jobs.filter(j => j.estimatedETA && j.deliveredAt);
    let onTime = 0;
    jobsWithETA.forEach(j => {
      const eta      = j.estimatedETA.toDate?.() ?? new Date(j.estimatedETA);
      const delivered = j.deliveredAt.toDate?.() ?? new Date(j.deliveredAt);
      if (delivered <= new Date(eta.getTime() + 5 * 60_000)) onTime++;  /* +5 min grace */
    });
    const onTimeRate      = jobsWithETA.length ? onTime / jobsWithETA.length : 1;
    const reliabilityScore = _clamp(onTimeRate * 100, 50, 100);

    /* ── Rating score (0–100): from customer ratings ── */
    const ratingRaw   = meta.rating ?? 4.0;
    const ratingScore = _clamp((ratingRaw / 5) * 100, 0, 100);

    /* ── Overall composite (weighted) ── */
    const overall = Math.round(
      safetyScore      * 0.30 +
      efficiencyScore  * 0.25 +
      reliabilityScore * 0.25 +
      ratingScore      * 0.20
    );

    const result = {
      assetId,
      overall,
      safety:      Math.round(safetyScore),
      efficiency:  Math.round(efficiencyScore),
      reliability: Math.round(reliabilityScore),
      rating:      Math.round(ratingScore),
      details: {
        jobCount:         jobs.length,
        totalDistanceKm:  Math.round(totalDist),
        avgSpeedKmh:      Math.round(avgSpeedKmh),
        onTimeRate:       Math.round(onTimeRate * 100),
        speedingIncidents: speedingCount,
        sosEvents,
        customerRating:   ratingRaw,
        periodDays:       days,
      },
      computedAt: new Date().toISOString(),
    };

    /* Persist to Firestore */
    try {
      await setDoc(
        doc(db, 'gipAnalytics', _yyyymmdd(), 'drivers', assetId),
        { ...result, updatedAt: serverTimestamp() },
        { merge: true }
      );
    } catch (e) {
      console.warn('[GIPAnalytics] score persist:', e.message);
    }

    return result;
  }

  /**
   * Generate a daily summary for a driver.
   * Intended to be called by a Cloud Function at end-of-day.
   */
  async dailyDriverSummary(assetId, date = _yyyymmdd()) {
    const since = new Date(date + 'T00:00:00Z');
    const until = new Date(date + 'T23:59:59Z');

    const jobs = await this._getCompletedJobsBetween(assetId, since, until);
    const totalKm      = jobs.reduce((s, j) => s + (j.distanceKm ?? 0), 0);
    const totalJobs    = jobs.length;
    const earnEstimate = jobs.reduce((s, j) => s + this._estimateEarning(j), 0);
    const onTimePct    = await this._calcOnTimePct(jobs);

    const summary = {
      assetId, date, totalJobs,
      totalKm:      Math.round(totalKm * 10) / 10,
      earnEstimateKES: Math.round(earnEstimate),
      onTimePct:    Math.round(onTimePct),
      avgJobDistKm: totalJobs ? Math.round((totalKm / totalJobs) * 10) / 10 : 0,
      updatedAt:    serverTimestamp(),
    };

    await setDoc(doc(db, 'gipAnalytics', date, 'driverSummaries', assetId), summary, { merge: true });
    return summary;
  }

  /* ══════════════════════════════════════════════════════════
     VEHICLE HEALTH
  ══════════════════════════════════════════════════════════ */

  /**
   * Compute vehicle health score (0–100).
   * @param {object} vehicle — from gipAssets or gipLocations
   */
  computeVehicleHealth(vehicle) {
    let score = 100;
    const issues = [];

    /* ── Fuel ── */
    const fuel = vehicle.fuelLevel ?? 100;
    if (fuel < FUEL_CRITICAL_PCT) {
      score -= 20; issues.push({ type: 'fuel_critical', value: fuel });
    } else if (fuel < 30) {
      score -= 8;  issues.push({ type: 'fuel_low', value: fuel });
    }

    /* ── Battery (EVs / GPS devices) ── */
    const battery = vehicle.batteryLevel ?? 100;
    if (battery < BATTERY_CRITICAL_PCT) {
      score -= 15; issues.push({ type: 'battery_critical', value: battery });
    } else if (battery < 40) {
      score -= 5; issues.push({ type: 'battery_low', value: battery });
    }

    /* ── Mileage / service interval ── */
    const kmSinceService = vehicle.kmSinceService ?? 0;
    if (kmSinceService > SERVICE_INTERVAL_KM) {
      const overdue = kmSinceService - SERVICE_INTERVAL_KM;
      score -= _clamp(Math.floor(overdue / 500) * 3, 0, 25);
      issues.push({ type: 'service_overdue', km: Math.round(overdue) });
    }

    /* ── Inspection expiry ── */
    const inspDays = _daysSince(vehicle.inspectionExpiry);
    if (inspDays > 0) {
      score -= _clamp(inspDays * 2, 0, 20);
      issues.push({ type: 'inspection_expired', daysAgo: inspDays });
    } else if (inspDays > -30) {
      score -= 5;
      issues.push({ type: 'inspection_due_soon', daysRemaining: -inspDays });
    }

    /* ── Insurance expiry ── */
    const insDays = _daysSince(vehicle.insuranceExpiry);
    if (insDays > 0) {
      score -= 25; issues.push({ type: 'insurance_expired', daysAgo: insDays });
    } else if (insDays > -14) {
      score -= 10; issues.push({ type: 'insurance_expiring_soon', daysRemaining: -insDays });
    }

    /* ── Last heartbeat (connectivity) ── */
    const heartbeatMinutes = vehicle.lastHeartbeat
      ? (Date.now() - (vehicle.lastHeartbeat.toDate?.() ?? new Date(vehicle.lastHeartbeat)).getTime()) / 60_000
      : 0;
    if (heartbeatMinutes > 60) {
      score -= 10; issues.push({ type: 'tracker_offline', minutesAgo: Math.round(heartbeatMinutes) });
    }

    const healthScore = _clamp(score, 0, 100);
    return {
      vehicleId: vehicle.id ?? vehicle.assetId,
      healthScore,
      grade: healthScore >= 85 ? 'A' : healthScore >= 70 ? 'B' : healthScore >= 55 ? 'C' : healthScore >= 40 ? 'D' : 'F',
      issues,
      requiresAttention: healthScore < 70,
      requiresImmediate: healthScore < 40,
      computedAt: new Date().toISOString(),
    };
  }

  /* ══════════════════════════════════════════════════════════
     DEMAND HEATMAP
  ══════════════════════════════════════════════════════════ */

  /**
   * Record an order/request event for heatmap aggregation.
   * Call this whenever an order is placed, a ride is requested, etc.
   * Accumulates in memory and flushes to Firestore every 60 s.
   */
  recordDemandEvent(lat, lng, module = 'delivery', weight = 1) {
    if (typeof lat !== 'number' || typeof lng !== 'number') return;
    const key = _gridKey(lat, lng);
    const cell = this._heatAccumulator.get(key) ?? { lat, lng };
    cell[module] = (cell[module] ?? 0) + weight;
    this._heatAccumulator.set(key, cell);

    clearTimeout(this._heatFlushTimer);
    this._heatFlushTimer = setTimeout(() => this._flushHeatData(), 60_000);
  }

  /**
   * Flush accumulated heat data to Firestore.
   * Safe to call at any time (also called on destroy).
   */
  async _flushHeatData() {
    if (!this._heatAccumulator.size) return;
    const date = _yyyymmdd();
    const hour = _hourOfDay();
    const region = this._region;

    const points = [...this._heatAccumulator.values()].map(cell => ({
      lat:    cell.lat,
      lng:    cell.lng,
      counts: Object.entries(cell)
        .filter(([k]) => k !== 'lat' && k !== 'lng')
        .reduce((acc, [k, v]) => { acc[k] = v; return acc; }, {}),
    }));

    try {
      await setDoc(
        doc(db, 'gipHeatData', region, date, String(hour)),
        { region, date, hour, points, updatedAt: serverTimestamp() },
        { merge: true }
      );
      this._heatAccumulator.clear();
    } catch (e) {
      console.warn('[GIPAnalytics] heatmap flush:', e.message);
    }
  }

  /**
   * Load historical heat data for a region + date range.
   * Returns array of { lat, lng, weight } suitable for Leaflet.heat.
   */
  async getHeatPoints(region, date, module = null, hours = null) {
    const filter = [
      where('region', '==', region),
      where('date',   '==', date),
    ];
    if (hours) filter.push(where('hour', 'in', hours));

    const snap = await getDocs(query(
      collection(db, 'gipHeatData', region, date),
      limit(24)
    ));

    const leafletPoints = [];
    snap.docs.forEach(d => {
      const { points = [] } = d.data();
      points.forEach(p => {
        let weight = 0;
        if (module) {
          weight = (p.counts?.[module] ?? 0) / 10;
        } else {
          weight = Object.values(p.counts ?? {}).reduce((s, v) => s + v, 0) / 20;
        }
        if (weight > 0) leafletPoints.push([p.lat, p.lng, Math.min(1, weight)]);
      });
    });

    return leafletPoints;
  }

  /* ══════════════════════════════════════════════════════════
     FLEET SUMMARY
  ══════════════════════════════════════════════════════════ */

  /**
   * Real-time fleet summary suitable for the command center header.
   */
  async getFleetSummary(region) {
    const q = query(
      collection(db, 'gipLocations'),
      where('region',   '==', region),
      where('isOnline', '==', true)
    );
    const snap = await getDocs(q);
    const assets = snap.docs.map(d => d.data());

    const summary = {
      total:       assets.length,
      available:   assets.filter(a => a.status === 'available').length,
      busy:        assets.filter(a => a.status === 'busy').length,
      en_route:    assets.filter(a => a.status === 'en_route').length,
      byModule:    {},
      region,
      computedAt:  new Date().toISOString(),
    };

    assets.forEach(a => {
      const m = a.module ?? 'unknown';
      summary.byModule[m] = (summary.byModule[m] ?? 0) + 1;
    });

    return summary;
  }

  /* ══════════════════════════════════════════════════════════
     SHIFT SCHEDULING SUGGESTIONS
     Deterministic demand-based — no AI needed for routine shifts
  ══════════════════════════════════════════════════════════ */

  /**
   * Suggest driver shifts based on historical demand patterns.
   * Returns { hour → suggestedDriverCount } for the given module.
   */
  async suggestShifts(region, module, days = 14) {
    const hourlyDemand = new Array(24).fill(0);
    const datesSampled = [];

    for (let i = 1; i <= days; i++) {
      const d = _yyyymmdd(new Date(Date.now() - i * 86_400_000));
      datesSampled.push(d);
    }

    await Promise.all(datesSampled.map(async (date) => {
      try {
        const snap = await getDocs(
          collection(db, 'gipHeatData', region, date)
        );
        snap.docs.forEach(d => {
          const { hour, points = [] } = d.data();
          const totalDemand = points.reduce((s, p) => s + (p.counts?.[module] ?? 0), 0);
          hourlyDemand[hour] += totalDemand;
        });
      } catch {}
    }));

    const maxDemand = Math.max(...hourlyDemand, 1);
    const suggestions = hourlyDemand.map((demand, hour) => ({
      hour,
      label:         `${String(hour).padStart(2, '0')}:00`,
      demandIndex:   Math.round((demand / maxDemand) * 100),
      suggestedCount: Math.max(1, Math.ceil((demand / maxDemand) * 20)),
    }));

    return { region, module, days, suggestions };
  }

  /* ══════════════════════════════════════════════════════════
     AI INTEGRATION HOOKS (cost-efficient, batched)
  ══════════════════════════════════════════════════════════ */

  /**
   * Generate a natural-language operations briefing.
   * Only called on explicit admin request — never per-event.
   * Requires SOKONI_CLAUDE_KEY in Firebase Functions secrets.
   */
  async generateOpsInsight(region, date = _yyyymmdd()) {
    if (!this._aiEnabled) {
      return { error: 'AI analytics disabled. Enable via options.aiEnabled = true.' };
    }

    const [fleet, shifts] = await Promise.all([
      this.getFleetSummary(region),
      this.suggestShifts(region, 'delivery', 7),
    ]);

    /* Call the SOKONI AI Cloud Function (implemented in functions/index.js) */
    try {
      const res = await fetch('/api/gip/ai-insight', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ region, date, fleet, shifts }),
      });
      if (!res.ok) throw new Error('AI endpoint returned ' + res.status);
      return res.json();
    } catch (e) {
      return { error: e.message };
    }
  }

  /* ══════════════════════════════════════════════════════════
     PRIVATE HELPERS
  ══════════════════════════════════════════════════════════ */

  async _getCompletedJobs(assetId, days) {
    const since = Timestamp.fromDate(new Date(Date.now() - days * 86_400_000));
    try {
      const snap = await getDocs(query(
        collection(db, 'gipDispatch'),
        where('assignedAssetId', '==', assetId),
        where('status',          '==', 'delivered'),
        orderBy('deliveredAt',   'desc'),
        limit(200)
      ));
      return snap.docs.map(d => d.data());
    } catch (e) {
      console.warn('[GIPAnalytics] _getCompletedJobs:', e.message);
      return [];
    }
  }

  async _getCompletedJobsBetween(assetId, since, until) {
    try {
      const snap = await getDocs(query(
        collection(db, 'gipDispatch'),
        where('assignedAssetId', '==', assetId),
        where('status',          '==', 'delivered'),
        where('deliveredAt',     '>=', Timestamp.fromDate(since)),
        where('deliveredAt',     '<=', Timestamp.fromDate(until)),
        orderBy('deliveredAt',   'asc'),
        limit(200)
      ));
      return snap.docs.map(d => d.data());
    } catch (e) {
      return [];
    }
  }

  async _getAssetAlerts(assetId, days) {
    const since = Timestamp.fromDate(new Date(Date.now() - days * 86_400_000));
    try {
      const snap = await getDocs(query(
        collection(db, 'gipAlerts'),
        where('assetId',   '==', assetId),
        where('createdAt', '>=', since),
        limit(100)
      ));
      return snap.docs.map(d => d.data());
    } catch {
      return [];
    }
  }

  async _getAssetMeta(assetId) {
    try {
      const snap = await getDoc(doc(db, 'gipAssets', assetId));
      return snap.exists() ? snap.data() : {};
    } catch {
      return {};
    }
  }

  async _calcOnTimePct(jobs) {
    const withETA = jobs.filter(j => j.estimatedETA && j.deliveredAt);
    if (!withETA.length) return 100;
    let onTime = 0;
    withETA.forEach(j => {
      const eta = j.estimatedETA.toDate?.() ?? new Date(j.estimatedETA);
      const del = j.deliveredAt.toDate?.()  ?? new Date(j.deliveredAt);
      if (del <= new Date(eta.getTime() + 5 * 60_000)) onTime++;
    });
    return (onTime / withETA.length) * 100;
  }

  _estimateEarning(job) {
    const basePerKm = 40;   /* KES per km — configurable */
    const base      = 50;   /* KES base fare */
    return base + (job.distanceKm ?? 0) * basePerKm;
  }

  /* ── Cleanup ─────────────────────────────────────────────── */

  async destroy() {
    clearTimeout(this._heatFlushTimer);
    await this._flushHeatData();
  }
}

if (typeof window !== 'undefined') window.SokoniGIPAnalytics = GIPAnalytics;
