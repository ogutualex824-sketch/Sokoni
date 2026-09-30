/* ================================================================
   SOKONI — Settlement Provider Registry (per-gateway abstraction)
   functions/settlement-providers.js

   Declares, per payment gateway, whether native SPLIT settlement is
   supported and whether it is ENABLED. The Settlement Executor consults this
   to choose between:
     • split               — gateway distributes funds directly (platform
                             commission → Bravilex, seller net → seller account)
     • collect_then_payout — SOKONI collects 100%, then pays the seller net
                             (the existing, always-available workflow)

   Behaviour is CONFIG-DRIVEN, never hardcoded at call sites. Code provides safe
   capability defaults; the Firestore doc settlementConfig/providers can toggle
   splitEnabled per gateway (default OFF → everything falls back, no change).
================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin                  = require('firebase-admin');

const REGION = 'us-central1';
const CONFIG_PATH = 'settlementConfig/providers';

function _db()  { return admin.firestore(); }
function _now() { return admin.firestore.FieldValue.serverTimestamp(); }
function _assertAdmin(req) {
  if (!req.auth?.token?.admin && !req.auth?.token?.superAdmin)
    throw new HttpsError('permission-denied', 'Admin access required');
}

/* Capability defaults per gateway. supportsSplit reflects what the provider CAN
   do; splitEnabled (config) reflects whether we've verified + turned it on.
   Everything ships splitEnabled=false so the fallback path is always used. */
function _defaults() {
  return {
    intasend:     { supportsSplit: true,  splitEnabled: false, adapter: 'intasend', note: 'split via IntaSend split/wallets API — verify in sandbox before enabling' },
    mpesa_daraja: { supportsSplit: false, splitEnabled: false, adapter: null,       note: 'Daraja STK cannot split a single charge natively → collect-then-payout' },
    card:         { supportsSplit: true,  splitEnabled: false, adapter: 'intasend', note: 'card via IntaSend; split inherits IntaSend capability' },
    wallet:       { supportsSplit: false, splitEnabled: false, adapter: null,       note: 'internal wallet — settled in-ledger, no external split' },
    smartpos:     { supportsSplit: false, splitEnabled: false, adapter: null,       note: 'terminal-dependent' },
    qr:           { supportsSplit: false, splitEnabled: false, adapter: null,       note: 'QR → M-Pesa, no native split' },
    subscription: { supportsSplit: false, splitEnabled: false, adapter: 'intasend', note: 'platform-only revenue, split not applicable' },
    bank:         { supportsSplit: false, splitEnabled: false, adapter: null,       note: 'manual bank transfer' },
  };
}

async function _load(db) {
  const def = _defaults();
  try {
    const snap = await db.doc(CONFIG_PATH).get();
    if (!snap.exists) return def;
    const d = snap.data() || {};
    const merged = {};
    for (const k of Object.keys(def)) merged[k] = { ...def[k], ...(d[k] || {}) };
    return merged;
  } catch (_) {
    return def; // fail safe → all fallback
  }
}

/* Resolve the effective settlement capability for one gateway.
   Returns { provider, supportsSplit, splitEnabled, canSplit, adapter, reason }. */
async function getProviderSettlement(db, provider) {
  const cfg = await _load(db);
  const p = cfg[provider];
  if (!p) return { provider, supportsSplit: false, splitEnabled: false, canSplit: false, adapter: null, reason: 'unknown provider → fallback' };
  const canSplit = !!(p.supportsSplit && p.splitEnabled);
  return {
    provider, supportsSplit: !!p.supportsSplit, splitEnabled: !!p.splitEnabled,
    canSplit, adapter: p.adapter || null,
    reason: canSplit ? 'native split enabled'
      : !p.supportsSplit ? 'provider cannot split natively'
      : 'split supported but not enabled',
  };
}

/* ── Admin CFs ─────────────────────────────────────────────────── */

exports._h = exports._h || {};   // handler registry consumed by settlementDispatch
exports.settlementGetProviders = onCall(
  { region: REGION, enforceAppCheck: true },
  exports._h.settlementGetProviders = async (req) => {
    _assertAdmin(req);
    return { providers: await _load(_db()), configPath: CONFIG_PATH };
  },
);

exports.settlementSetProvider = onCall(
  { region: REGION, enforceAppCheck: true },
  exports._h.settlementSetProvider = async (req) => {
    _assertAdmin(req);
    const { provider, splitEnabled } = req.data || {};
    const def = _defaults();
    if (!def[provider]) throw new HttpsError('invalid-argument', `provider must be one of: ${Object.keys(def).join(', ')}`);
    if (typeof splitEnabled !== 'boolean') throw new HttpsError('invalid-argument', 'splitEnabled must be boolean');
    /* Guard: cannot enable split on a provider that can't split natively. */
    if (splitEnabled && !def[provider].supportsSplit)
      throw new HttpsError('failed-precondition', `${provider} does not support native split settlement`);

    await _db().doc(CONFIG_PATH).set({ [provider]: { splitEnabled }, updatedAt: _now(), updatedBy: req.auth.uid }, { merge: true });
    await _db().collection('settlementConfigAudit').add({
      action: 'provider_split_toggle', provider, splitEnabled, by: req.auth.uid, at: _now(),
    });
    return { ok: true, provider, splitEnabled };
  },
);

module.exports.getProviderSettlement = getProviderSettlement;
module.exports._defaults = _defaults;
