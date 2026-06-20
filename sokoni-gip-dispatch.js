/* ================================================================
   SOKONI GIP — Smart Dispatch Engine  v1.0.0

   Deterministic nearest-driver dispatch with workload balancing.
   AI is NOT used for individual dispatch decisions — this keeps
   cost near-zero and latency under 500 ms for every assignment.
   AI analytics (demand forecasting, shift scheduling) live in
   sokoni-gip-analytics.js and run on a separate schedule.

   Scoring weights (tunable without redeployment via gipConfig):
     Distance     40% — nearest driver wins on default
     Workload     30% — prefer drivers with fewer active jobs
     Rating       20% — proven performers get priority
     VehicleMatch 10% — right vehicle type for the job

   Dispatch lifecycle:
     PENDING → ASSIGNED → ACCEPTED → PICKED_UP → DELIVERED
                      ↘ (timeout/reject) → re-dispatch up to 3×
                                         ↘ FAILED

   Firestore collection:
     gipDispatch/{jobId} — full job record
     gipAssets/{assetId} — asset metadata (rating, completedJobs)
     gipLocations/{assetId} — live GPS (to score by distance)

   Exposes: window.SokoniGIPDispatch  +  ES default export
================================================================ */

import { db, auth } from './firebase.js';
import {
  collection, doc, setDoc, updateDoc, getDoc, getDocs,
  onSnapshot, query, where, orderBy, limit, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

/* ── Constants ──────────────────────────────────────────────── */

const WEIGHTS = {
  distance:     0.40,
  workload:     0.30,
  rating:       0.20,
  vehicleMatch: 0.10,
};

const ACCEPT_TIMEOUT_MS  = 60_000;   /* 60 s to accept before re-dispatch */
const MAX_DISPATCH_TRIES = 3;        /* Max candidates tried per job */
const CANDIDATE_RADIUS_KM = 15;      /* Search radius for candidates */
const MAX_CANDIDATES     = 20;       /* Max drivers pulled per region */

/* Average speed (km/h) by vehicle type — for ETA estimation */
const AVG_SPEED_KMH = {
  bike:  25,
  rider: 20,
  car:   40,
  van:   35,
  truck: 30,
};

/* ── Private utility ────────────────────────────────────────── */

function _haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function _jobId() {
  return 'JOB-' + Date.now().toString(36).toUpperCase() + '-' +
         Math.random().toString(36).slice(2, 5).toUpperCase();
}

function _etaMinutes(distanceKm, vehicleType) {
  const speed = AVG_SPEED_KMH[vehicleType] ?? 30;
  return Math.ceil((distanceKm / speed) * 60) + 2; /* +2 min buffer */
}

/* ── DispatchEngine ─────────────────────────────────────────── */

export default class DispatchEngine {

  _activeTimeouts = new Map();   /* jobId → timeout handle */
  _jobListeners   = new Map();   /* jobId → Firestore unsub */
  _eventHandlers  = new Map();

  constructor(gipEngine = null) {
    this._gip = gipEngine;
  }

  /* ── Event bus ── */
  on(event, fn) {
    if (!this._eventHandlers.has(event)) this._eventHandlers.set(event, new Set());
    this._eventHandlers.get(event).add(fn);
    return () => this._eventHandlers.get(event).delete(fn);
  }
  _emit(event, data) {
    this._eventHandlers.get(event)?.forEach(fn => { try { fn(data); } catch(e) {} });
  }

  /* ══════════════════════════════════════════════════════════
     PUBLIC API
  ══════════════════════════════════════════════════════════ */

  /**
   * Submit a dispatch job and return the jobId.
   *
   * @param {object} job
   * @param {string} job.module         — 'food'|'delivery'|'rides'|'mechanics'|'healthcare'
   * @param {string} [job.orderId]      — linked order id
   * @param {number} job.pickupLat
   * @param {number} job.pickupLng
   * @param {number} job.dropoffLat
   * @param {number} job.dropoffLng
   * @param {string} [job.pickupAddress]
   * @param {string} [job.dropoffAddress]
   * @param {string} [job.vehicleType]  — 'bike'|'car'|'van'|'truck'
   * @param {string} [job.priority]     — 'low'|'normal'|'high'|'urgent'
   * @param {string} [job.region]       — region key
   */
  async dispatch(job) {
    const jobId = _jobId();
    const region = job.region ?? 'nairobi';

    const distanceKm = _haversineKm(
      job.pickupLat, job.pickupLng,
      job.dropoffLat, job.dropoffLng
    );

    const jobRecord = {
      id:             jobId,
      module:         job.module    ?? 'delivery',
      orderId:        job.orderId   ?? null,
      pickupLat:      job.pickupLat,
      pickupLng:      job.pickupLng,
      dropoffLat:     job.dropoffLat,
      dropoffLng:     job.dropoffLng,
      pickupAddress:  job.pickupAddress  ?? '',
      dropoffAddress: job.dropoffAddress ?? '',
      vehicleType:    job.vehicleType    ?? 'bike',
      priority:       job.priority       ?? 'normal',
      region,
      distanceKm:     Math.round(distanceKm * 100) / 100,
      status:         'pending',
      tryCount:       0,
      candidateIds:   [],
      assignedAssetId: null,
      createdAt:      serverTimestamp(),
    };

    await setDoc(doc(db, 'gipDispatch', jobId), jobRecord);
    this._emit('job:created', jobRecord);

    /* Kick off async assignment (do not await — returns immediately) */
    this._findAndAssign(jobId, jobRecord, []).catch(e =>
      console.error('[GIPDispatch] dispatch error:', e)
    );

    return jobId;
  }

  /**
   * Manually assign a specific driver to a job (dispatcher override).
   */
  async manualAssign(jobId, assetId) {
    const jobSnap = await getDoc(doc(db, 'gipDispatch', jobId));
    if (!jobSnap.exists()) throw new Error('Job not found: ' + jobId);
    const job = jobSnap.data();
    if (!['pending', 'assigned'].includes(job.status)) {
      throw new Error(`Cannot override job in status: ${job.status}`);
    }
    this._clearJobTimeout(jobId);
    await this._assignToAsset(jobId, assetId, job, true);
  }

  /**
   * Cancel a pending or assigned job.
   */
  async cancelJob(jobId, reason = '') {
    this._clearJobTimeout(jobId);
    const unsub = this._jobListeners.get(jobId);
    if (unsub) { unsub(); this._jobListeners.delete(jobId); }
    await updateDoc(doc(db, 'gipDispatch', jobId), {
      status:      'cancelled',
      cancelReason: reason,
      cancelledAt: serverTimestamp(),
    });
    this._emit('job:cancelled', { jobId, reason });
  }

  /**
   * Mark a job as accepted by the assigned driver.
   * (Called by driver app when they tap "Accept".)
   */
  async acceptJob(jobId, assetId) {
    this._clearJobTimeout(jobId);
    const etaSnap = await getDoc(doc(db, 'gipDispatch', jobId));
    if (!etaSnap.exists()) return;
    const job = etaSnap.data();

    await updateDoc(doc(db, 'gipDispatch', jobId), {
      status:     'accepted',
      acceptedAt: serverTimestamp(),
    });

    /* Update driver status to en_route */
    await updateDoc(doc(db, 'gipLocations', assetId), {
      status: 'en_route', updatedAt: serverTimestamp(),
    });

    this._emit('job:accepted', { jobId, assetId });

    /* Watch for pickup confirmation */
    this._watchJob(jobId);
  }

  /**
   * Mark job as picked up.
   */
  async markPickedUp(jobId, assetId) {
    await updateDoc(doc(db, 'gipDispatch', jobId), {
      status:     'picked_up',
      pickedUpAt: serverTimestamp(),
    });
    this._emit('job:picked_up', { jobId, assetId });
  }

  /**
   * Mark job as delivered / complete.
   */
  async markDelivered(jobId, assetId, { rating = null, otp = null } = {}) {
    this._clearJobTimeout(jobId);
    const unsub = this._jobListeners.get(jobId);
    if (unsub) { unsub(); this._jobListeners.delete(jobId); }

    const update = {
      status:      'delivered',
      deliveredAt: serverTimestamp(),
    };
    if (otp !== null) update.otpVerified = true;

    await updateDoc(doc(db, 'gipDispatch', jobId), update);

    /* Update driver back to available */
    await updateDoc(doc(db, 'gipLocations', assetId), {
      status: 'available', currentJobId: null, updatedAt: serverTimestamp(),
    });

    /* Update driver's completed job count */
    if (assetId) {
      try {
        const { increment } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
        await updateDoc(doc(db, 'gipAssets', assetId), {
          completedJobs: increment(1),
          updatedAt:     serverTimestamp(),
        });
      } catch {}
    }

    this._emit('job:delivered', { jobId, assetId, rating });
  }

  /**
   * Get all active (non-terminal) jobs.
   */
  async getActiveJobs(region = null) {
    const filters = [
      where('status', 'in', ['pending', 'assigned', 'accepted', 'picked_up']),
      orderBy('createdAt', 'desc'),
      limit(100),
    ];
    if (region) filters.unshift(where('region', '==', region));
    const snap = await getDocs(query(collection(db, 'gipDispatch'), ...filters));
    return snap.docs.map(d => d.data());
  }

  /**
   * Subscribe to active jobs in real-time (for command center).
   */
  watchActiveJobs(region, callback) {
    const q = query(
      collection(db, 'gipDispatch'),
      where('region', '==', region),
      where('status', 'in', ['pending', 'assigned', 'accepted', 'picked_up']),
      orderBy('createdAt', 'desc'),
      limit(200)
    );
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => d.data())),
      e    => console.warn('[GIPDispatch] watchActiveJobs:', e.message)
    );
  }

  /**
   * Get job history for a specific driver.
   */
  async getDriverHistory(assetId, days = 7) {
    const since = new Date(Date.now() - days * 86_400_000);
    const q = query(
      collection(db, 'gipDispatch'),
      where('assignedAssetId', '==', assetId),
      where('status', '==', 'delivered'),
      orderBy('deliveredAt', 'desc'),
      limit(100)
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => d.data()).filter(j =>
      j.deliveredAt?.toDate?.() >= since
    );
  }

  /* ══════════════════════════════════════════════════════════
     INTERNAL: SCORING & ASSIGNMENT
  ══════════════════════════════════════════════════════════ */

  async _findAndAssign(jobId, job, excludeIds = []) {
    if (excludeIds.length >= MAX_DISPATCH_TRIES) {
      await updateDoc(doc(db, 'gipDispatch', jobId), {
        status:    'failed',
        failedAt:  serverTimestamp(),
        failReason: 'No available drivers after ' + MAX_DISPATCH_TRIES + ' attempts',
      });
      this._emit('job:failed', { jobId, reason: 'no_drivers' });
      return;
    }

    /* Pull available assets in the region */
    const candidates = await this._queryCandidates(job, excludeIds);

    if (!candidates.length) {
      /* Retry in 30 s if no drivers currently available */
      const t = setTimeout(() => this._findAndAssign(jobId, job, excludeIds), 30_000);
      this._activeTimeouts.set(jobId + '_retry', t);
      await updateDoc(doc(db, 'gipDispatch', jobId), {
        status: 'pending', waitingForDriver: true,
      });
      this._emit('job:waiting', { jobId });
      return;
    }

    /* Score each candidate */
    const scored = candidates
      .map(c => ({ ...c, score: this._scoreCandidate(c, job) }))
      .sort((a, b) => b.score - a.score);

    const best = scored[0];
    await this._assignToAsset(jobId, best.assetId, job, false);
  }

  async _queryCandidates(job, excludeIds) {
    const q = query(
      collection(db, 'gipLocations'),
      where('region',   '==',  job.region ?? 'nairobi'),
      where('status',   '==',  'available'),
      where('isOnline', '==',  true),
      limit(MAX_CANDIDATES)
    );
    const snap = await getDocs(q);
    const raw  = snap.docs
      .map(d => d.data())
      .filter(a =>
        !excludeIds.includes(a.assetId) &&
        _haversineKm(a.lat, a.lng, job.pickupLat, job.pickupLng) <= CANDIDATE_RADIUS_KM
      );

    /* Enrich with asset metadata (rating, completedJobs) */
    return Promise.all(raw.map(async a => {
      try {
        const meta = await getDoc(doc(db, 'gipAssets', a.assetId));
        return { ...a, ...(meta.exists() ? meta.data() : {}) };
      } catch {
        return a;
      }
    }));
  }

  /**
   * Score a single candidate 0–1. Higher = better assignment.
   * Scoring is fully deterministic — no AI call.
   */
  _scoreCandidate(candidate, job) {
    /* ─ Distance score (closer = higher) ─ */
    const distKm  = _haversineKm(candidate.lat, candidate.lng, job.pickupLat, job.pickupLng);
    const distScore = Math.max(0, 1 - distKm / CANDIDATE_RADIUS_KM);

    /* ─ Workload score (fewer active jobs = higher) ─ */
    const activeJobs   = candidate.activeJobs ?? 0;
    const workloadScore = Math.max(0, 1 - activeJobs / 5);

    /* ─ Rating score (0–5 normalized to 0–1) ─ */
    const rating      = candidate.rating ?? 4.0;
    const ratingScore = Math.min(1, rating / 5);

    /* ─ Vehicle match (exact type = 1, compatible = 0.5, mismatch = 0) ─ */
    const wantedType = job.vehicleType ?? 'bike';
    const haveType   = candidate.vehicleType ?? candidate.type ?? 'bike';
    const vehicleMatch =
      haveType === wantedType ? 1.0 :
      (wantedType === 'bike'  && ['rider', 'courier'].includes(haveType)) ? 0.7 :
      (wantedType === 'car'   && ['van', 'vehicle', 'rental'].includes(haveType)) ? 0.5 : 0;

    return (
      WEIGHTS.distance     * distScore    +
      WEIGHTS.workload     * workloadScore +
      WEIGHTS.rating       * ratingScore  +
      WEIGHTS.vehicleMatch * vehicleMatch
    );
  }

  async _assignToAsset(jobId, assetId, job, isManual) {
    const distKm    = _haversineKm(
      job.pickupLat, job.pickupLng,
      /* estimate from driver loc */
      this._gip?._assets?.get(assetId)?.lat ?? job.pickupLat,
      this._gip?._assets?.get(assetId)?.lng ?? job.pickupLng,
    );
    const etaMin    = _etaMinutes(distKm, job.vehicleType ?? 'bike');
    const etaStamp  = new Date(Date.now() + etaMin * 60_000);

    const tryCount = (job.tryCount ?? 0) + 1;

    await updateDoc(doc(db, 'gipDispatch', jobId), {
      status:          'assigned',
      assignedAssetId: assetId,
      assignedAt:      serverTimestamp(),
      estimatedETA:    etaStamp,
      estimatedETAMin: etaMin,
      isManualOverride: isManual ?? false,
      tryCount,
    });

    /* Mark driver as busy */
    await updateDoc(doc(db, 'gipLocations', assetId), {
      status:       'busy',
      currentJobId: jobId,
      updatedAt:    serverTimestamp(),
    });

    this._emit('job:assigned', { jobId, assetId, etaMin, isManual });

    /* Start acceptance timeout */
    this._startAcceptTimeout(jobId, assetId, job, tryCount);
  }

  _startAcceptTimeout(jobId, assetId, job, tryCount) {
    this._clearJobTimeout(jobId);
    const t = setTimeout(async () => {
      const snap = await getDoc(doc(db, 'gipDispatch', jobId));
      if (!snap.exists()) return;
      const current = snap.data();

      if (current.status !== 'assigned') return; /* Already accepted or cancelled */

      this._emit('job:timeout', { jobId, assetId, tryCount });

      /* Release the driver */
      try {
        await updateDoc(doc(db, 'gipLocations', assetId), {
          status: 'available', currentJobId: null, updatedAt: serverTimestamp(),
        });
      } catch {}

      /* Re-dispatch, excluding this driver */
      const excluded = (current.candidateIds ?? []).concat([assetId]);
      await updateDoc(doc(db, 'gipDispatch', jobId), {
        status:      'pending',
        candidateIds: excluded,
        tryCount,
      });

      this._findAndAssign(jobId, { ...job, tryCount }, excluded).catch(e =>
        console.error('[GIPDispatch] re-dispatch error:', e)
      );
    }, ACCEPT_TIMEOUT_MS);

    this._activeTimeouts.set(jobId, t);
  }

  _watchJob(jobId) {
    if (this._jobListeners.has(jobId)) return;
    const unsub = onSnapshot(doc(db, 'gipDispatch', jobId), snap => {
      if (!snap.exists()) return;
      const data = snap.data();
      if (['delivered', 'cancelled', 'failed'].includes(data.status)) {
        unsub();
        this._jobListeners.delete(jobId);
      }
      this._emit('job:update', data);
    });
    this._jobListeners.set(jobId, unsub);
  }

  _clearJobTimeout(jobId) {
    const t = this._activeTimeouts.get(jobId);
    if (t) { clearTimeout(t); this._activeTimeouts.delete(jobId); }
    const r = this._activeTimeouts.get(jobId + '_retry');
    if (r) { clearTimeout(r); this._activeTimeouts.delete(jobId + '_retry'); }
  }

  /* ── Cleanup ─────────────────────────────────────────────── */

  destroy() {
    this._activeTimeouts.forEach(t => clearTimeout(t));
    this._activeTimeouts.clear();
    this._jobListeners.forEach(u => u());
    this._jobListeners.clear();
    this._eventHandlers.clear();
  }
}

if (typeof window !== 'undefined') window.SokoniGIPDispatch = DispatchEngine;
