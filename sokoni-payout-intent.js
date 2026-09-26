/* ═══════════════════════════════════════════════════════════════════════════
   sokoni-payout-intent.js — ONE stable idempotency key per withdrawal intent.

   requestSellerPayout dedupes on the key it is given (payoutRequests/pout_{key}):
   the SERVER owns the payout identity and the dedupe. What the client must never
   do is mint a NEW key for the SAME intent — provider-dashboard.html sent
   'po_' + Date.now(), so a double tap, a retry after a timeout, a reload or a
   second tab each became a separate withdrawal.

   The key for (user, amount, destination) lives in localStorage — shared by every
   tab of the origin — for up to 15 minutes. A second tab, a reload or a retry
   reuses it; two tabs that both start at once re-read after a short settle and
   converge on the same key (last writer wins, for both). It is released only on a
   DEFINITIVE server answer (success, or a refusal that created nothing); an
   unknown outcome (timeout, network) keeps it, so a retry cannot duplicate.

   Not a security control: a client can always send any key. It only stops
   SOKONI's own forms from turning one intent into two financial requests.
   UMD — window.SokoniPayoutIntent in the page, require() in tests.
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SokoniPayoutIntent = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const TTL_MS = 15 * 60 * 1000;
  const SETTLE_MS = 60;
  /* Refusals that prove no payout was created — safe to release the key. */
  const DEFINITIVE = /(^|\/)(invalid-argument|failed-precondition|permission-denied|resource-exhausted|not-found|unauthenticated)$/;

  const slot = (uid, amount, destination) => 'sk_payout_intent_' + [
    String(uid || 'anon'), String(Math.round(Number(amount) || 0)), String(destination || '').replace(/[^0-9A-Za-z]/g, ''),
  ].join('_');
  const store = (s) => s || (typeof localStorage !== 'undefined' ? localStorage : null);
  function read(st, k, nowMs) {
    try { const v = JSON.parse(st.getItem(k) || 'null'); return v && v.key && nowMs - Number(v.at) < TTL_MS ? v : null; } catch (_) { return null; }
  }
  function newKey(rand) {
    if (typeof rand === 'function') return 'po_' + rand();
    const c = typeof crypto !== 'undefined' ? crypto : null;
    const r = c && c.randomUUID ? c.randomUUID().replace(/-/g, '') : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    return 'po_' + r;
  }

  /** The key for this intent — reused if one is live, else created and settled. */
  async function acquire({ uid, amount, destination, storage, now = Date.now, rand, sleep } = {}) {
    const st = store(storage);
    const k = slot(uid, amount, destination);
    if (st) { const cur = read(st, k, now()); if (cur) return cur.key; }
    const key = newKey(rand);
    if (!st) return key;
    try { st.setItem(k, JSON.stringify({ key, at: now() })); } catch (_) { return key; }
    await (sleep || ((ms) => new Promise((r) => setTimeout(r, ms))))(SETTLE_MS);
    const won = read(st, k, now());
    return won ? won.key : key;
  }

  /** Forget the key: the intent concluded (success) or created nothing. */
  function release({ uid, amount, destination, storage } = {}) {
    const st = store(storage);
    if (st) try { st.removeItem(slot(uid, amount, destination)); } catch (_) { /* noop */ }
  }

  /** Should this error release the key? Only if it proves nothing was created. */
  function isDefinitive(err) { return !!(err && typeof err.code === 'string' && DEFINITIVE.test(err.code)); }

  return { acquire, release, isDefinitive, slot, TTL_MS, SETTLE_MS };
}));
