/* ================================================================
   SOKONI ENTERPRISE INTELLIGENCE PLATFORM
   Intelligence Log  v1.0.0

   Immutable audit trail for every intelligent decision made
   anywhere on the platform.

   Every log entry records:
     - What decision was made
     - Which source was used (VERIFIED / CALCULATED / PREDICTED)
     - How confident we were
     - How long it took
     - Which inputs were used
     - Which module triggered it
     - Who the user was (uid, role)
     - Whether it succeeded or failed
     - Any error details

   Log entries are batched (max 25 per write) to minimise
   Firestore writes. Entries are flushed on:
     - Batch size threshold (25 entries)
     - Time threshold (every 10s)
     - Page unload / visibilitychange

   Firestore schema:
     intelligenceLog/{auto} {
       decisionId, decisionType, source, module, uid, role,
       confidence, latencyMs, hasValue, reason,
       inputSummary, ts, sessionId, platform
     }

     intelligenceMetrics/{date-module} {
       date, module, totalDecisions, avgLatencyMs,
       bySource: { verified:n, calculated:n, predicted:n, error:n }
       byConfidence: { verified:n, high:n, medium:n, low:n, unknown:n }
       updatedAt
     }

   Usage:
     import log from './sokoni-intelligence-log.js';
     log.log({ decisionId, decisionType, source, module, uid, latencyMs, confidence, reason });
     log.error({ decisionId, module, error, context });

   Exposes: window.SokoniIntelLog + ES default export
================================================================ */

const BATCH_MAX     = 25;
const FLUSH_MS      = 10_000;
const MAX_QUEUE     = 500;       /* hard cap — drop oldest if queue overflows */
const FIRESTORE_COLL = 'intelligenceLog';
const METRICS_COLL   = 'intelligenceMetrics';

/* PII field names — stripped before writing to Firestore */
const PII_FIELDS = new Set([
  'phone', 'email', 'name', 'password', 'pin', 'secret',
  'token', 'idNumber', 'passportNo', 'nationalId',
]);

/* ── Intelligence Log Engine ─────────────────────────────────── */
class SokoniIntelligenceLog {
  constructor() {
    this._queue      = [];        /* pending log entries */
    this._db         = null;
    this._sessionId  = _sessionId();
    this._flushTimer = null;
    this._flushing   = false;
    this._disabled   = false;     /* kill-switch */
    this._platform   = typeof window !== 'undefined' ? 'web' : 'node';

    /* Wire page-unload flush */
    if (typeof window !== 'undefined') {
      window.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') this.flush();
      });
      window.addEventListener('pagehide', () => this.flush());
    }
  }

  /* ── Core log() ──────────────────────────────────────────── */

  /**
   * Log an intelligence decision.
   *
   * @param {object} entry
   * @param {string} entry.decisionId
   * @param {string} entry.decisionType
   * @param {string} entry.source        — SOURCE constant
   * @param {string} entry.module
   * @param {string} [entry.uid]
   * @param {string} [entry.role]
   * @param {string} entry.confidence
   * @param {number} entry.latencyMs
   * @param {boolean} [entry.hasValue]
   * @param {string} [entry.reason]
   * @param {object} [entry.inputs]      — will be stripped of PII
   */
  log(entry = {}) {
    if (this._disabled) return;

    const record = {
      decisionId:   entry.decisionId   ?? _genId(),
      decisionType: entry.decisionType ?? 'unknown',
      source:       entry.source        ?? 'unknown',
      module:       entry.module        ?? 'unknown',
      uid:          entry.uid           ?? null,
      role:         entry.role          ?? null,
      confidence:   entry.confidence    ?? 'unknown',
      latencyMs:    Math.round(entry.latencyMs ?? 0),
      hasValue:     entry.hasValue      ?? true,
      reason:       _truncate(entry.reason ?? '', 200),
      inputSummary: _summariseInputs(entry.inputs),
      sessionId:    this._sessionId,
      platform:     this._platform,
      ts:           entry.ts ?? Date.now(),
      _type:        'decision',
    };

    this._enqueue(record);
  }

  /**
   * Log a failed decision or engine error.
   */
  error(entry = {}) {
    if (this._disabled) return;

    const record = {
      decisionId:   entry.decisionId   ?? _genId(),
      decisionType: entry.decisionType ?? 'unknown',
      source:       'error',
      module:       entry.module        ?? 'unknown',
      uid:          entry.uid           ?? null,
      confidence:   'unknown',
      latencyMs:    Math.round(entry.latencyMs ?? 0),
      hasValue:     false,
      errorMessage: _truncate(entry.error?.message ?? String(entry.error ?? ''), 500),
      errorStack:   _truncate(entry.error?.stack?.split('\n')[0] ?? '', 200),
      context:      _truncate(String(entry.context ?? ''), 200),
      sessionId:    this._sessionId,
      platform:     this._platform,
      ts:           Date.now(),
      _type:        'error',
    };

    this._enqueue(record);
  }

  /**
   * Log a security-relevant event (fake GPS, replay attack, etc.).
   */
  security(entry = {}) {
    if (this._disabled) return;

    const record = {
      decisionId:   _genId(),
      decisionType: 'security_event',
      source:       'security',
      module:       entry.module     ?? 'unknown',
      uid:          entry.uid        ?? null,
      eventType:    entry.eventType  ?? 'unknown',
      severity:     entry.severity   ?? 'medium',
      detail:       _truncate(entry.detail ?? '', 500),
      ip:           entry.ip         ?? null,
      sessionId:    this._sessionId,
      platform:     this._platform,
      ts:           Date.now(),
      _type:        'security',
    };

    /* Security events are flushed immediately */
    this._enqueue(record);
    this.flush();
  }

  /**
   * Log a performance measurement.
   */
  perf(module, operation, durationMs, metadata = {}) {
    if (this._disabled) return;
    this._enqueue({
      decisionId:   _genId(),
      decisionType: 'performance',
      source:       'measured',
      module,
      operation,
      durationMs:   Math.round(durationMs),
      ...metadata,
      sessionId:    this._sessionId,
      ts:           Date.now(),
      _type:        'perf',
    });
  }

  /* ── Queue management ────────────────────────────────────── */

  _enqueue(record) {
    /* Hard cap — prevent unbounded memory growth */
    if (this._queue.length >= MAX_QUEUE) {
      this._queue.shift();    /* drop oldest */
    }
    this._queue.push(record);

    /* Flush immediately at batch max */
    if (this._queue.length >= BATCH_MAX) {
      this.flush();
      return;
    }

    /* Start/reset timer */
    if (!this._flushTimer) {
      this._flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
    }
  }

  /* ── Flush ───────────────────────────────────────────────── */

  async flush() {
    if (this._flushing || this._queue.length === 0) return;
    this._flushing = true;
    clearTimeout(this._flushTimer);
    this._flushTimer = null;

    /* Snapshot and drain queue */
    const batch = this._queue.splice(0, BATCH_MAX);

    try {
      const db = await this._getDB();
      if (!db) {
        /* No Firestore — emit to console (dev only) */
        if (_isDev()) batch.forEach(r => console.debug('[SokoniEIP]', r._type, r));
        return;
      }

      const { collection, writeBatch, doc, serverTimestamp } = await import(
        'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
      );

      const wb    = writeBatch(db);
      const coll  = collection(db, FIRESTORE_COLL);
      const today = new Date().toISOString().slice(0, 10);

      /* Collect metrics deltas */
      const metricsDelta = {};

      for (const entry of batch) {
        /* Write log entry */
        const ref = doc(coll);
        wb.set(ref, { ...entry, serverTs: serverTimestamp() });

        /* Accumulate metrics */
        if (entry._type === 'decision') {
          const mKey = `${today}-${entry.module}`;
          if (!metricsDelta[mKey]) {
            metricsDelta[mKey] = { module: entry.module, date: today, n: 0, totalMs: 0, bySource: {}, byConf: {} };
          }
          const m = metricsDelta[mKey];
          m.n++;
          m.totalMs += entry.latencyMs;
          m.bySource[entry.source] = (m.bySource[entry.source] ?? 0) + 1;
          m.byConf[entry.confidence] = (m.byConf[entry.confidence] ?? 0) + 1;
        }
      }

      /* Write metrics aggregates */
      const { FieldValue } = await import(
        'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
      ).then(m => ({ FieldValue: m.increment ? m : { increment: m.increment } })).catch(() => ({}));

      for (const [mKey, m] of Object.entries(metricsDelta)) {
        const mRef = doc(db, METRICS_COLL, mKey);
        wb.set(mRef, {
          module:         m.module,
          date:           m.date,
          totalDecisions: (m.n),
          totalLatencyMs: (m.totalMs),
          bySource:       m.bySource,
          byConfidence:   m.byConf,
          updatedAt:      serverTimestamp(),
        }, { merge: true });
      }

      await wb.commit();

    } catch (e) {
      /* Don't re-enqueue — log to console instead */
      console.warn('[SokoniIntelLog] Flush failed:', e.message);
      if (_isDev()) batch.forEach(r => console.debug('[SokoniEIP drop]', r));
    } finally {
      this._flushing = false;

      /* If more entries accumulated during flush, schedule next */
      if (this._queue.length > 0) {
        this._flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
      }
    }
  }

  /* ── Firestore init ──────────────────────────────────────── */

  async _getDB() {
    if (this._db) return this._db;
    try {
      const { getFirestore } = await import(
        'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
      );
      const { app } = await import('./firebase.js');
      this._db = getFirestore(app);
      return this._db;
    } catch (_) {
      return null;
    }
  }

  /* ── Query API (admin/analytics use) ────────────────────── */

  /**
   * Fetch recent decisions for a module.
   * @param {object} opts
   * @param {string} [opts.module]
   * @param {string} [opts.decisionType]
   * @param {string} [opts.source]
   * @param {number} [opts.limitN=50]
   * @param {Date}   [opts.since]
   * @returns {Promise<object[]>}
   */
  async query({ module, decisionType, source, limitN = 50, since } = {}) {
    const db = await this._getDB();
    if (!db) return [];

    const { collection, query, where, orderBy, limit, getDocs, Timestamp } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
    );

    const constraints = [orderBy('ts', 'desc'), limit(limitN)];
    if (module)       constraints.unshift(where('module',       '==', module));
    if (decisionType) constraints.unshift(where('decisionType', '==', decisionType));
    if (source)       constraints.unshift(where('source',       '==', source));
    if (since)        constraints.push(where('ts',              '>=', since.getTime()));

    const q    = query(collection(db, FIRESTORE_COLL), ...constraints);
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  /**
   * Fetch aggregated metrics for a date range.
   */
  async getMetrics({ module, startDate, endDate } = {}) {
    const db = await this._getDB();
    if (!db) return [];

    const { collection, query, where, getDocs, orderBy } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
    );

    const constraints = [orderBy('date', 'desc')];
    if (module)    constraints.unshift(where('module', '==', module));
    if (startDate) constraints.push(where('date', '>=', startDate));
    if (endDate)   constraints.push(where('date', '<=', endDate));

    const q    = query(collection(db, METRICS_COLL), ...constraints);
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  /* ── Control ─────────────────────────────────────────────── */

  /** Disable logging (e.g., for automated tests) */
  disable() { this._disabled = true; }

  /** Re-enable */
  enable()  { this._disabled = false; }

  /** How many entries are queued (waiting to flush) */
  get pending() { return this._queue.length; }

  /** Get in-memory queue (diagnostic) */
  get queue() { return [...this._queue]; }
}

/* ── Private helpers ─────────────────────────────────────────── */

function _genId() {
  return 'IL-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

function _sessionId() {
  try {
    let id = sessionStorage.getItem('_sk_sess');
    if (!id) { id = 'S-' + Date.now().toString(36); sessionStorage.setItem('_sk_sess', id); }
    return id;
  } catch (_) { return 'S-' + Date.now().toString(36); }
}

function _truncate(str, max) {
  if (typeof str !== 'string') return String(str ?? '').slice(0, max);
  return str.length > max ? str.slice(0, max) + '…' : str;
}

function _isDev() {
  try { return location.hostname === 'localhost' || location.hostname.includes('127.0.0.1'); }
  catch (_) { return false; }
}

function _summariseInputs(inputs) {
  if (!inputs || typeof inputs !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(inputs)) {
    if (PII_FIELDS.has(k)) continue;
    if (typeof v === 'number')  { out[k] = v; continue; }
    if (typeof v === 'boolean') { out[k] = v; continue; }
    if (typeof v === 'string')  { out[k] = v.slice(0, 50); continue; }
    if (Array.isArray(v))       { out[k] = `Array(${v.length})`; continue; }
    if (typeof v === 'object' && v !== null) { out[k] = '{…}'; continue; }
  }
  return Object.keys(out).length ? out : null;
}

/* ── Singleton ───────────────────────────────────────────────── */
const log = new SokoniIntelligenceLog();
export { SokoniIntelligenceLog };
export default log;

if (typeof window !== 'undefined') {
  window.SokoniIntelLog = log;
}
