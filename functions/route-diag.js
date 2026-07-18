/**
 * route-diag.js — receiver for client-side routing anomaly beacons.
 *
 * WHY THIS EXISTS
 * sokoni-root-guard.js has been beaconing every root-route anomaly to POST /api/diag since
 * it shipped. That path had no rewrite and no function behind it, so every report from every
 * affected device returned 404 and was discarded. The instrumentation was built, deployed,
 * and never connected — which is exactly why the root-route bug "could not be reproduced
 * anywhere I control". The evidence existed; nothing was listening.
 *
 * DESIGN CONSTRAINTS
 *  · sendBeacon cannot read a response and cannot carry auth. This endpoint is therefore
 *    PUBLIC and UNAUTHENTICATED by necessity. It is treated as hostile input throughout:
 *    nothing it writes is ever trusted, executed, or used for authorization.
 *  · It only ever appends to a diagnostics collection. No business collection is touched.
 *  · Every field is length-capped and type-checked before it is written, so a malicious
 *    client cannot inflate documents or smuggle structure into Firestore.
 *  · Rate-limited per IP so it cannot be used to run up write costs.
 *  · Always answers 204, even on rejection. A beacon has no error path, and telling an
 *    attacker which payloads were rejected is free reconnaissance.
 *
 * Written by: the reporting client (public). Read by: engineers, admin tooling.
 * Retention: 30 days (TTL policy on expiresAt). This is debug telemetry, not a record.
 */
'use strict';

const { onRequest } = require('firebase-functions/v2/https');
const logger        = require('firebase-functions/logger');
const admin         = require('firebase-admin');

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const COLLECTION   = 'routeDiagnostics';
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/* Per-IP budget. Generous enough for a real incident (a device retrying while broken),
   tight enough that the endpoint cannot be turned into a write amplifier. */
const RATE_MAX    = 20;
const RATE_WINDOW = 60 * 1000;
const _hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const rec = _hits.get(ip);
  if (!rec || now - rec.start > RATE_WINDOW) { _hits.set(ip, { start: now, n: 1 }); return false; }
  rec.n++;
  /* Bounded memory: this map lives for the container's lifetime, so prune aggressively. */
  if (_hits.size > 5000) {
    for (const [k, v] of _hits) if (now - v.start > RATE_WINDOW) _hits.delete(k);
  }
  return rec.n > RATE_MAX;
}

/* ── Sanitisers. Untrusted input in, known-shaped primitives out. ── */
const str = (v, max) => (typeof v === 'string' && v.length ? v.slice(0, max) : null);
const bool = (v) => (typeof v === 'boolean' ? v : null);
const int = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null);
const enumOf = (v, allowed) => (typeof v === 'string' && allowed.includes(v) ? v : null);

/* The exact field set sokoni-root-guard.js collect() produces. Anything else is dropped —
   an allowlist, so a new client field cannot silently start writing unbounded data. */
function sanitiseDiag(d) {
  if (!d || typeof d !== 'object') return null;
  return {
    url:           str(d.url, 512),
    path:          str(d.path, 256),
    referrer:      str(d.referrer, 512),
    navType:       enumOf(d.navType, ['navigate', 'reload', 'back_forward', 'prerender']),
    redirectCount: int(d.redirectCount),
    fromCache:     bool(d.fromCache),
    displayMode:   enumOf(d.displayMode, ['standalone', 'ios-standalone', 'browser']),
    template:      str(d.template, 64),
    swScript:      str(d.swScript, 128),
    cacheVersion:  str(d.cacheVersion, 128),
    buildVersion:  str(d.buildVersion, 64),
    ua:            str(d.ua, 200),
    clientTs:      int(d.ts),
    collectError:  str(d.collectError, 200),
    anomaly:       str(d.anomaly, 120),

    /* ── SW lifecycle telemetry (sokoni-sw-telemetry.js) ──
       Same allowlist discipline: every field type-checked and length-capped, so a
       hostile client cannot inflate documents or smuggle structure into Firestore. */
    event: enumOf(d.event, [
      'sw_install_started', 'sw_install_completed', 'sw_install_failed',
      'sw_activate_started', 'sw_activate_completed', 'sw_activate_failed',
      'sw_update_available', 'sw_update_applied',
      'sw_no_controller', 'sw_version_mismatch',
      'shell_asset_failed', 'offline_fallback_used',
    ]),
    buildCommit:           str(d.buildCommit, 40),
    buildTime:             str(d.buildTime, 40),
    expectedCacheVersion:  str(d.expectedCacheVersion, 128),
    cacheVersionMatchesBuild: bool(d.cacheVersionMatchesBuild),
    onlineStatus:          enumOf(d.onlineStatus, ['online', 'offline']),
    servedFrom:            enumOf(d.servedFrom, ['cache', 'network']),
    networkType:           str(d.networkType, 24),
    downlink:              int(d.downlink),
    rtt:                   int(d.rtt),
    saveData:              bool(d.saveData),
    installationDuration:  int(d.installationDuration),
    activationDuration:    int(d.activationDuration),
    sinceLoadMs:           int(d.sinceLoadMs),
    shellAsset:            str(d.shellAsset, 200),
    shellAssetStatus:      int(d.shellAssetStatus),
    note:                  str(d.note, 200),
  };
}

exports.routeDiag = onRequest(
  { timeoutSeconds: 10, memory: '256MiB', invoker: 'public', cors: false },
  async (req, res) => {
    /* Beacons are POST-only. Answer cheaply and identically to everything else. */
    if (req.method !== 'POST') { res.status(405).end(); return; }

    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    if (rateLimited(ip)) { res.status(204).end(); return; }

    try {
      /* sendBeacon sends a Blob; Cloud Functions may hand it over parsed or raw. */
      let body = req.body;
      if (Buffer.isBuffer(body)) body = JSON.parse(body.toString('utf8'));
      else if (typeof body === 'string') body = JSON.parse(body);

      const kind = enumOf(body && body.kind, ['root-route-anomaly', 'sw-lifecycle']);
      const diag = sanitiseDiag(body && body.diag);

      /* Unknown shape: acknowledge and drop. Never echo why. */
      if (!kind || !diag || !diag.anomaly) { res.status(204).end(); return; }

      const now = Date.now();
      await db.collection(COLLECTION).add({
        kind,
        ...diag,
        /* Server-observed, never client-supplied — these are the fields we can actually trust. */
        serverTs:  admin.firestore.FieldValue.serverTimestamp(),
        ipHash:    require('crypto').createHash('sha256').update(ip).digest('hex').slice(0, 16),
        country:   str(req.headers['x-appengine-country'], 8),
        expiresAt: admin.firestore.Timestamp.fromMillis(now + RETENTION_MS),
      });

      /* Surface in Cloud Logging too, so an incident is visible without querying Firestore. */
      logger.warn('[route-diag] anomaly reported', {
        anomaly: diag.anomaly, path: diag.path, template: diag.template,
        fromCache: diag.fromCache, swScript: diag.swScript,
        cacheVersion: diag.cacheVersion, displayMode: diag.displayMode,
      });
    } catch (err) {
      /* Telemetry must never become an incident of its own. Log and swallow. */
      logger.error('[route-diag] failed to record beacon', { message: err && err.message });
    }

    res.status(204).end();
  }
);
