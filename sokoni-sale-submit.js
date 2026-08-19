/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — SALE SUBMISSION (idempotent)
   ══════════════════════════════════════════════════════════════════════════════
   The server is ALREADY idempotent and this module does not second-guess it.
   `posCompleteCheckout` requires an `idempotencyKey`, claims it atomically via
   create() on posIdempotency/{key}, and:

     status complete    -> returns the ORIGINAL { saleId, receipt, cached: true }
     status processing  -> throws 'already-exists' ("Checkout already in progress")

   Stock, counters and payment all run exactly once per key. So there is no second
   sale authority to write, and writing one would be the worst outcome available.

   ── THE CLIENT-SIDE TRAP THIS EXISTS TO CLOSE ───────────────────────────────
   A merchant double-taps Complete Sale. The first call is still `processing`, so
   the second throws 'already-exists'. A naive UI shows "failed", the merchant taps
   again — and if the retry mints a NEW key, the guard is bypassed and the customer
   is charged twice. The duplicate is created by the CLIENT giving up on its key,
   not by the server.

   So the rules here are:
     · the key is derived from the CART, not from the clock — the same cart at the
       same attempt yields the same key
     · it is PERSISTED, so a refresh mid-sale resumes the same attempt
     · 'already-exists' is NOT a failure. It means the sale is in flight: wait and
       retry the SAME key until it resolves
     · a new key is minted only when a sale genuinely COMPLETES, or when the
       merchant explicitly abandons the cart
   ══════════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var STORE_KEY = 'sokoni.sale.attempt';

  function _store () {
    try { return global.sessionStorage || null; } catch (_) { return null; }
  }

  /* A stable fingerprint of what is being sold. Two different carts must not share
     a key (that would make the second sale look like a replay of the first and
     silently return the wrong receipt), and the SAME cart must keep its key across
     a re-render or a refresh. */
  function fingerprint (spec) {
    var s = spec || {};
    var items = (s.items || []).map(function (i) {
      return [i.productId, i.qty || i.quantity || 1, i.price].join(':');
    }).sort().join('|');
    var tenders = (s.tenders || []).map(function (t) {
      return [t.method, t.amountMinor].join(':');
    }).sort().join('|');
    return [s.merchantId || '', s.branchId || '', items, tenders, s.totalMinor || 0].join('#');
  }

  /* Deterministic, collision-resistant enough for a till, and readable in logs. */
  function _hash (str) {
    var h1 = 0x811c9dc5, h2 = 0x01000193;
    for (var i = 0; i < str.length; i++) {
      h1 ^= str.charCodeAt(i); h1 = (h1 * 0x01000193) >>> 0;
      h2 = ((h2 ^ str.charCodeAt(i)) * 0x85ebca6b) >>> 0;
    }
    return (h1.toString(16) + h2.toString(16)).padStart(16, '0');
  }

  /* The key for THIS attempt. Reused while the cart is unchanged; a changed cart
     starts a new attempt, because it is a different sale. */
  function keyFor (spec, opts) {
    var fp = fingerprint(spec);
    var st = _store();
    if (st && !(opts && opts.fresh)) {
      try {
        var raw = st.getItem(STORE_KEY);
        if (raw) {
          var prev = JSON.parse(raw);
          if (prev && prev.fp === fp && prev.key) return prev.key;
        }
      } catch (_) {}
    }
    /* `nonce` distinguishes a deliberately retried sale of an IDENTICAL cart — a
       customer buying the same thing twice in a row is a second sale, not a replay,
       and only an explicit `fresh` may start one. */
    var nonce = (opts && opts.nonce) || _hash(fp + '::' + (opts && opts.startedAt || 0));
    var key = 'sale_' + _hash(fp) + '_' + nonce.slice(0, 8);
    if (st) { try { st.setItem(STORE_KEY, JSON.stringify({ fp: fp, key: key })); } catch (_) {} }
    return key;
  }

  function clear () {
    var st = _store();
    if (st) { try { st.removeItem(STORE_KEY); } catch (_) {} }
  }

  var IN_FLIGHT = /already-exists|already in progress/i;

  /* Submit, and treat "in flight" as a state to wait out rather than an error to
     report. `callable` is the shell's posCompleteCheckout wrapper; nothing here
     talks to Firestore directly. */
  async function submit (callable, payload, opts) {
    var o = opts || {};
    var attempts = o.attempts || 6;
    var waitMs = o.waitMs || 700;
    var sleep = o.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    if (!payload || !payload.idempotencyKey) throw new Error('submit() requires an idempotencyKey');

    var lastErr = null;
    for (var i = 0; i < attempts; i++) {
      try {
        var res = await callable(payload);
        var data = (res && res.data) || res || {};
        clear();                       /* the sale is done; the next one is new */
        return { ok: true, data: data, cached: !!data.cached, attempts: i + 1 };
      } catch (e) {
        var msg = (e && (e.message || e.code)) || '';
        if (!IN_FLIGHT.test(String(msg))) {
          /* A REAL failure. The key is deliberately NOT cleared: a retry must reuse
             it, or the guard is bypassed and the customer pays twice. */
          return { ok: false, error: msg, retryable: true, keyPreserved: true, attempts: i + 1 };
        }
        lastErr = msg;
        if (o.onWaiting) { try { o.onWaiting(i + 1); } catch (_) {} }
        await sleep(waitMs * (i + 1));
      }
    }
    /* Still in flight after every attempt. The sale may yet complete server-side, so
       this is explicitly NOT a failure the merchant should answer by selling again. */
    return { ok: false, inFlight: true, error: lastErr, keyPreserved: true, attempts: attempts };
  }

  global.SokoniSaleSubmit = {
    fingerprint: fingerprint, keyFor: keyFor, clear: clear, submit: submit,
    _hash: _hash, STORE_KEY: STORE_KEY,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).SokoniSaleSubmit;
}
