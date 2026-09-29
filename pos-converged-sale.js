/* ================================================================
   SOKONI SmartPOS — converged sale (6b, cash).

   ONE PHYSICAL SALE = ONE SERVER SALE. SmartPOS used to finish a sale on the device
   (IndexedDB), push the stock delta straight to canonical products/{id}, and queue a
   client-written posTransactions document that a trigger then copied into
   posRetailSales. Three writers, no commission debt, and a sale the server never judged.

   From 6b the ONLY thing that makes a SmartPOS sale real is posCompleteCheckout — the
   callable that prices the cart from canonical products, proves the merchant, moves
   canonical stock in its own transaction, records the commission debt and issues the
   receipt. This module is the till's side of that contract:

     • tender    — cash only. Everything else is refused on the till AND on the server.
     • products  — every line must name a canonical products/{id}; a till-only product
                   cannot be sold (PRODUCT_NOT_CANONICAL), because the server has no price
                   or stock for it.
     • scope     — the SHOP, from Firestore (SokoniMerchantData.resolveShopId), cached for
                   offline use; never a guess, never the device's say-so.
     • payload   — SokoniMerchantData.buildSale with saleToken = the local txn id, so the
                   idempotency key is fixed at the moment of sale and every retry, sync or
                   replay carries the SAME key → the server records it once.
     • outcome   — ACCEPTED (server saleId), SYNC_REJECTED (a refusal: never retried), or
                   LOCAL_PENDING (no answer yet: retried with the same key).

   Pure logic plus injected I/O, so it runs unchanged under Node for certification.
   ================================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PosConvergedSale = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CALLABLE = 'posCompleteCheckout';
  var SCOPE_CACHE_KEY = 'sokoni_pos_converged_scope';

  /* ── Tender ────────────────────────────────────────────────────────────────
     Cash is the one tender SmartPOS can settle on the server today. The others are
     shown as unavailable WITH a reason — never hidden, never silently accepted. */
  var TENDERS = { cash: true };
  var TENDER_UNAVAILABLE = {
    mpesa:      'M-PESA at the till returns with SOKONI Pay (IntaSend). Take cash for now.',
    mpesa_till: 'Manual Till payments cannot be confirmed by SOKONI, so they cannot settle a sale.',
    card:       'Card at the till returns with SOKONI Pay (IntaSend). Take cash for now.',
    split:      'Split payments return with SOKONI Pay. Take the full amount in cash for now.',
    qr:         'SOKONI QR activates with your business wallet.',
    gift_card:  'Gift cards are temporarily unavailable. Stored-value payments will return when server verification is enabled.',
  };

  function tenderCheck(method) {
    var m = String(method || '').toLowerCase();
    if (TENDERS[m]) return { ok: true, method: m };
    return {
      ok: false, reason: 'TENDER_REFUSED', method: m || 'none',
      message: TENDER_UNAVAILABLE[m] || ('This payment method (' + (m || 'none') + ') cannot be accepted at the till.'),
    };
  }

  /* ── Products ──────────────────────────────────────────────────────────────
     A till row is canonical when it is linked (marketplaceId) or was seeded from the
     catalogue (source:'canonical', whose local id IS the canonical id). Anything else
     exists only on this device. */
  function canonicalProductId(row) {
    if (!row) return null;
    if (row.marketplaceId) return String(row.marketplaceId);
    if (row.source === 'canonical' && row.id) return String(row.id);
    return null;
  }

  /* items: the till's cart lines ({id, qty, price, name}). getLocal(id) → the till's product row. */
  async function resolveLines(items, getLocal) {
    var lines = [], missing = [];
    for (var i = 0; i < (items || []).length; i++) {
      var it = items[i];
      var row = null;
      try { row = await getLocal(it.id); } catch (_) { row = null; }
      var pid = canonicalProductId(row);
      if (!pid) { missing.push(it.name || String(it.id)); continue; }
      lines.push({ productId: pid, qty: Number(it.qty) || 0, price: Number(it.price) || 0, name: it.name || '', localId: String(it.id) });
    }
    if (missing.length) {
      return {
        ok: false, reason: 'PRODUCT_NOT_CANONICAL', missing: missing,
        message: 'Not in your SOKONI catalogue: ' + missing.join(', ') + '. Add it to your products before selling it here.',
      };
    }
    return { ok: true, lines: lines };
  }

  /* ── Shop scope ───────────────────────────────────────────────────────────
     Resolved from Firestore when online and cached per uid; offline uses the cache ONLY
     when it belongs to the signed-in uid. No cache and no network → no sale: the till
     must confirm its shop once before it can sell offline. */
  async function resolveScope(o) {
    var uid = o.uid, storage = o.storage, MD = o.merchantData;
    if (!uid) return { ok: false, reason: 'NOT_AUTHORISED', message: 'Sign in to record sales.' };
    var cached = null;
    try { cached = JSON.parse((storage && storage.getItem(SCOPE_CACHE_KEY)) || 'null'); } catch (_) { cached = null; }
    if (cached && cached.uid !== uid) cached = null;

    if (o.online && o.db) {
      try {
        var r = await MD.resolveShopId({ uid: uid, db: o.db });
        if (!r || !r.shopId) {
          try { storage && storage.removeItem(SCOPE_CACHE_KEY); } catch (_) {}
          return { ok: false, reason: 'NOT_AUTHORISED', message: 'No SOKONI shop is on record for this account, so sales cannot be recorded.' };
        }
        var scope = MD.resolveScope({ uid: uid, activeShopId: r.shopId, source: r.source });
        if (scope.ok) { try { storage && storage.setItem(SCOPE_CACHE_KEY, JSON.stringify({ uid: uid, shopId: scope.shopId, source: r.source, at: Date.now() })); } catch (_) {} }
        return scope.ok ? scope : { ok: false, reason: 'NOT_AUTHORISED', message: 'This shop could not be confirmed.' };
      } catch (_) { /* network trouble while online — fall through to the cache */ }
    }
    if (cached && cached.shopId) {
      var s = MD.resolveScope({ uid: uid, activeShopId: cached.shopId, source: 'cache' });
      if (s.ok) return s;
    }
    return { ok: false, reason: 'SCOPE_UNCONFIRMED', message: 'Connect to the internet once so SOKONI can confirm your shop, then sell.' };
  }

  /* ── Payload ─────────────────────────────────────────────────────────────── */
  function buildPayload(o) {
    var MD = o.merchantData;
    var p = MD.buildSale({
      scope: o.scope,
      cart: o.lines,
      payments: [{ method: 'cash', amount: Number(o.tendered) || 0 }],
      saleToken: o.txnId,
      branchId: o.branchId,
      shiftId: o.shiftId,
      discountTotal: o.discountTotal,
      taxTotal: o.taxTotal,
      checkoutStartedAt: o.checkoutStartedAt,
    });
    /* The local id travels in metadata so the server sale names the till record it settles. */
    p.metadata = Object.assign({}, p.metadata, { source: 'pos.js', localTxnId: String(o.txnId) });
    return p;
  }

  /* ── Outcome classification ─────────────────────────────────────────────────
     A REFUSAL is the server judging the sale — retrying the same key gets the same
     answer, so it is never retried. Anything else (no network, timeout, a crash, a
     concurrent attempt still running) is not an answer; the same key is retried and
     the server returns the one sale it recorded, if it recorded one. */
  var PERMANENT = { 'invalid-argument': 1, 'failed-precondition': 1, 'permission-denied': 1, 'not-found': 1, 'out-of-range': 1 };

  function _code(err) {
    var c = String((err && err.code) || '');
    return c.indexOf('functions/') === 0 ? c.slice(10) : c;
  }

  function classify(err) {
    var code = _code(err), msg = String((err && err.message) || '');
    if (!PERMANENT[code]) return { permanent: false, code: code || 'unknown', message: msg };
    var reason = 'REFUSED';
    if (/price mismatch|subtotal mismatch|total mismatch/i.test(msg))                    reason = 'PRICE_CHANGED';
    else if (/insufficient stock/i.test(msg))                                            reason = 'STOCK_UNAVAILABLE';
    else if (/cannot be accepted at the till|payment method/i.test(msg))                  reason = 'TENDER_REFUSED';
    else if (code === 'not-found' || /belongs to another shop|has no owner|unreadable owner/i.test(msg)) reason = 'PRODUCT_NOT_CANONICAL';
    else if (code === 'permission-denied')                                               reason = 'NOT_AUTHORISED';
    return { permanent: true, code: code, reason: reason, message: msg };
  }

  /* callable(payload) → { data } | data. Never throws. */
  async function submit(payload, callable) {
    var data;
    try {
      var res = await callable(payload);
      data = (res && res.data !== undefined) ? res.data : res;
    } catch (err) {
      var c = classify(err);
      if (c.permanent) return { status: 'SYNC_REJECTED', reason: c.reason, code: c.code, message: c.message };
      return { status: 'LOCAL_PENDING', code: c.code, message: c.message };
    }
    /* An answer without a sale id is not an acceptance. Retrying the same key is safe. */
    if (!data || !data.saleId) return { status: 'LOCAL_PENDING', code: 'no_sale_id', message: 'The server did not return a sale.' };
    return { status: 'ACCEPTED', saleId: String(data.saleId), receipt: data.receipt || null, cached: !!data.cached };
  }

  /* ── Settling a queued (offline / unanswered) sale ─────────────────────────
     deps: { transactions: {getById, save}, adjustStock(id, delta, reason, cashierId),
             queueCompat(record), callable }
     Returns the settled outcome; THROWS only for LOCAL_PENDING so the sync engine retries. */
  async function settleQueued(item, deps) {
    var d = (item && item.data) || {};
    if (!d.payload || !d.payload.idempotencyKey || !d.localTxnId) {
      /* A malformed entry can never become a sale; retrying it would only fill the DLQ. */
      return { status: 'SYNC_REJECTED', reason: 'REFUSED', message: 'Queued sale is incomplete.' };
    }
    var out = await submit(d.payload, deps.callable);
    if (out.status === 'LOCAL_PENDING') {
      var e = new Error('converged sale not yet answered: ' + (out.code || '') + ' ' + (out.message || ''));
      e.pending = true;
      throw e;
    }
    await applyOutcome(d.localTxnId, out, deps);
    return out;
  }

  /* Record the server's decision on the till's own record, then write the compat
     projection. ACCEPTED keeps the local stock movement (it mirrors the server's).
     SYNC_REJECTED gives the local stock back — the sale did not happen. */
  async function applyOutcome(localTxnId, out, deps) {
    var txn = await deps.transactions.getById(localTxnId);
    if (!txn) return;
    if (txn.serverStatus === 'ACCEPTED' || txn.serverStatus === 'SYNC_REJECTED') return;   /* already settled */
    if (out.status === 'ACCEPTED') {
      txn.serverStatus = 'ACCEPTED';
      txn.canonicalSaleId = out.saleId;
      txn.status = 'completed';
    } else {
      txn.serverStatus = 'SYNC_REJECTED';
      txn.serverReason = out.reason;
      txn.serverMessage = out.message || '';
      txn.status = 'failed';
      for (var i = 0; i < (txn.items || []).length; i++) {
        var it = txn.items[i];
        try { await deps.adjustStock(it.id, Number(it.qty) || 0, 'converged:rejected:' + txn.id, txn.cashierId); } catch (_) {}
      }
    }
    txn.serverDecidedAt = Date.now();
    await deps.transactions.save(txn);
    if (deps.queueCompat) await deps.queueCompat(compatRecord(txn));
  }

  /* posTransactions is now a PROJECTION written after the server decided, naming the
     authoritative sale. It is never the sale (the mirror no longer copies it). */
  function compatRecord(txn) {
    var r = {};
    Object.keys(txn).forEach(function (k) { if (k.charAt(0) !== '_') r[k] = txn[k]; });
    r.recordKind = 'converged_projection';
    r.canonicalSaleId = txn.canonicalSaleId || null;
    return r;
  }

  /* A void or refund on a converged sale would move stock and money on the till only.
     The server owns this sale; reversing it arrives with the server-side void/refund
     authority. A sale that never reached the server (rejected) has nothing to reverse. */
  function reversalBlock(txn) {
    var s = txn && txn.serverStatus;
    if (s === 'ACCEPTED' || s === 'LOCAL_PENDING') {
      return 'This sale is recorded by SOKONI. Voids and refunds for it are not available on the till yet — nothing has been changed.';
    }
    if (s === 'SYNC_REJECTED') return 'SOKONI did not accept this sale, so there is nothing to void or refund. Its stock was already returned.';
    return null;
  }

  return {
    CALLABLE: CALLABLE,
    SCOPE_CACHE_KEY: SCOPE_CACHE_KEY,
    TENDER_UNAVAILABLE: TENDER_UNAVAILABLE,
    tenderCheck: tenderCheck,
    canonicalProductId: canonicalProductId,
    resolveLines: resolveLines,
    resolveScope: resolveScope,
    buildPayload: buildPayload,
    classify: classify,
    submit: submit,
    settleQueued: settleQueued,
    applyOutcome: applyOutcome,
    compatRecord: compatRecord,
    reversalBlock: reversalBlock,
  };
}));
