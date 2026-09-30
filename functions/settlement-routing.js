/* ================================================================
   SOKONI — Settlement Routing (feature-flagged, staged migration)
   functions/settlement-routing.js

   Controls, per payment method, whether funds settle via the legacy path
   (direct-to-seller / existing engine) or the canonical Merchant-of-Record
   path (Bravilex collection account → Settlement Engine → seller net).

   SAFETY: defaults are 100% LEGACY. With no config doc, resolveRoute() returns
   'legacy' for every method, so this module changes NOTHING until an admin
   explicitly enables a path. A global killSwitch forces everything back to
   legacy instantly (one-click rollback).

   Modes per method:
     • legacy — current production behaviour (no change)
     • shadow — run the canonical engine in parallel for validation, but DO NOT
                change money movement (safe dry-run against live traffic)
     • mor    — route through the Bravilex collection account (activation)

   Rollout controls: per-seller allowlist (canary), deterministic percentage
   rollout (stable per seller), and the global killSwitch.

   Config doc: settlementConfig/routing
================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const crypto                 = require('crypto');
const admin                  = require('firebase-admin');

const REGION = 'us-central1';
const CONFIG_PATH = 'settlementConfig/routing';

function _db()  { return admin.firestore(); }
function _now() { return admin.firestore.FieldValue.serverTimestamp(); }
function _assertAdmin(req) {
  if (!req.auth?.token?.admin && !req.auth?.token?.superAdmin)
    throw new HttpsError('permission-denied', 'Admin access required');
}

/* Payment methods under migration control. */
const METHODS = ['intasend', 'mpesa_daraja', 'card', 'wallet', 'smartpos', 'qr', 'subscription', 'bank'];
const MODES   = ['legacy', 'shadow', 'mor'];

/* Safe defaults — everything legacy, rollout 0%, empty allowlist. */
function _defaultConfig() {
  const methods = {};
  for (const m of METHODS) methods[m] = { mode: 'legacy', rolloutPct: 0, allowlist: [] };
  return { killSwitch: false, methods, version: 0 };
}

/* Deterministic 0–99 bucket for a seller (stable across calls). */
function _bucket(sellerId) {
  if (!sellerId) return 100; // no seller → never in a percentage rollout
  const h = crypto.createHash('sha256').update(String(sellerId)).digest();
  return h[0] % 100;
}

async function _loadConfig(db) {
  try {
    const snap = await db.doc(CONFIG_PATH).get();
    if (!snap.exists) return _defaultConfig();
    const d = snap.data() || {};
    const def = _defaultConfig();
    return {
      killSwitch: !!d.killSwitch,
      methods: { ...def.methods, ...(d.methods || {}) },
      version: d.version || 0,
    };
  } catch (_) {
    return _defaultConfig(); // fail safe → legacy
  }
}

/* Resolve the settlement route for a payment. NEVER throws — on any error,
   returns legacy so live money movement is never blocked by this module. */
async function resolveRoute(db, method, ctx = {}) {
  const cfg = await _loadConfig(db);
  const rule = cfg.methods[method] || { mode: 'legacy', rolloutPct: 0, allowlist: [] };
  const legacy = (reason) => ({ method, mode: 'legacy', useMoR: false, shadow: false, reason, version: cfg.version });

  if (cfg.killSwitch) return legacy('killSwitch active — forced legacy');
  if (rule.mode === 'legacy') return legacy('method mode=legacy');

  const sellerId = ctx.sellerId || null;
  const allow = Array.isArray(rule.allowlist) && sellerId && rule.allowlist.includes(sellerId);
  const inPct = _bucket(sellerId) < (rule.rolloutPct || 0);
  const active = allow || inPct;

  if (rule.mode === 'shadow') {
    // Shadow always computes for the selected cohort but never moves money via MoR.
    return { method, mode: 'shadow', useMoR: false, shadow: active,
             reason: active ? 'shadow cohort — compute only' : 'not in shadow cohort', version: cfg.version };
  }
  if (rule.mode === 'mor') {
    return active
      ? { method, mode: 'mor', useMoR: true, shadow: false,
          reason: allow ? 'allowlisted seller' : `in ${rule.rolloutPct}% rollout`, version: cfg.version }
      : legacy(`mor enabled but seller not in cohort (${rule.rolloutPct}%)`);
  }
  return legacy('unknown mode → legacy');
}

/* ── Admin CFs ─────────────────────────────────────────────────── */

exports._h = exports._h || {};   // handler registry consumed by settlementDispatch
exports.settlementGetRoutingConfig = onCall(
  { region: REGION, enforceAppCheck: true },
  exports._h.settlementGetRoutingConfig = async (req) => {
    _assertAdmin(req);
    const cfg = await _loadConfig(_db());
    return { config: cfg, methods: METHODS, modes: MODES, configPath: CONFIG_PATH };
  },
);

exports.settlementSetRoutingConfig = onCall(
  { region: REGION, enforceAppCheck: true },
  exports._h.settlementSetRoutingConfig = async (req) => {
    _assertAdmin(req);
    const { method, mode, rolloutPct, allowlist, killSwitch } = req.data || {};
    const db = _db();

    /* Global kill-switch toggle (emergency rollback). */
    if (typeof killSwitch === 'boolean') {
      await db.doc(CONFIG_PATH).set(
        { killSwitch, updatedAt: _now(), updatedBy: req.auth.uid, version: admin.firestore.FieldValue.increment(1) },
        { merge: true },
      );
      return { ok: true, killSwitch };
    }

    /* Per-method update with validation. */
    if (!METHODS.includes(method)) throw new HttpsError('invalid-argument', `method must be one of: ${METHODS.join(', ')}`);
    if (mode && !MODES.includes(mode)) throw new HttpsError('invalid-argument', `mode must be one of: ${MODES.join(', ')}`);
    const pct = rolloutPct == null ? undefined : Math.max(0, Math.min(100, Math.round(rolloutPct)));
    if (rolloutPct != null && (Number.isNaN(pct))) throw new HttpsError('invalid-argument', 'rolloutPct must be 0–100');
    if (allowlist != null && !Array.isArray(allowlist)) throw new HttpsError('invalid-argument', 'allowlist must be an array of sellerIds');

    const update = { updatedAt: _now(), updatedBy: req.auth.uid, version: admin.firestore.FieldValue.increment(1) };
    const rule = {};
    if (mode) rule.mode = mode;
    if (pct != null) rule.rolloutPct = pct;
    if (allowlist != null) rule.allowlist = allowlist.slice(0, 500);
    update[`methods.${method}`] = rule;

    await db.doc(CONFIG_PATH).set(update, { merge: true });

    /* Audit — never delete settlement config history. */
    await db.collection('settlementConfigAudit').add({
      action: 'routing_update', method, rule, by: req.auth.uid, at: _now(),
    });
    return { ok: true, method, rule };
  },
);

module.exports.resolveRoute   = resolveRoute;
module.exports.METHODS        = METHODS;
module.exports.MODES          = MODES;
module.exports._defaultConfig = _defaultConfig;
