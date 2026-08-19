/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — RECEIPT RENDERER
   ══════════════════════════════════════════════════════════════════════════════
   ONE receipt for every completed sale, whether it began at the counter, on the
   phone, or through online checkout. It COMPOSES authorities that are already
   proven and adds no arithmetic and no data path of its own:

     SokoniCash        payment lines, change, balance
     SokoniFulfilment  pickup / delivery, destination, rider
     the order         identity, items, totals, SERVER timestamp

   ── THE PHONE IS THE RECEIPT SYSTEM ─────────────────────────────────────────
   `render()` returns a STRUCTURE, not a printer job. The screen renders it, Share
   sends it, and the P58E prints it if one happens to be paired. A merchant with no
   printer has a complete receipt; printing is an output, never a prerequisite.

   ── TIME COMES FROM THE SERVER ──────────────────────────────────────────────
   `createdAt` must be the server timestamp carried on the order. A phone clock is
   user-settable and must never be the authority on a financial record. The device
   only FORMATS it for display. A receipt with no server time says so rather than
   quietly substituting `new Date()`.

   ── IT NEVER INVENTS ────────────────────────────────────────────────────────
   No rider means "Not yet assigned". No customer means the block is absent, not
   filled with a placeholder. A pickup NEVER shows a destination. Unknown is stated
   or omitted — never guessed.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  function _cash () { return global.SokoniCash; }
  function _ful () { return global.SokoniFulfilment; }

  var _s = function (v, n) { return String(v == null ? '' : v).slice(0, n || 120).trim(); };

  /* Display formatting only. The stored value is untouched. */
  function formatTime (ts, locale) {
    var d = null;
    if (ts && typeof ts.toDate === 'function') d = ts.toDate();
    else if (ts instanceof Date) d = ts;
    else if (typeof ts === 'number' && isFinite(ts)) d = new Date(ts);
    else if (typeof ts === 'string' && ts) { var p = new Date(ts); if (!isNaN(p.getTime())) d = p; }
    if (!d || isNaN(d.getTime())) return null;
    try {
      return d.toLocaleString(locale || 'en-KE',
        { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
    } catch (_) { return d.toISOString(); }
  }

  function render (order, opts) {
    var o = order || {};
    var settings = opts || {};
    var out = { blocks: [], warnings: [] };

    /* ── identity ── */
    var shop = o.shop || settings.shop || {};
    out.blocks.push({ type: 'identity', lines: [
      'SOKONI',
      _s(shop.name || shop.storeName) || null,
      _s(shop.phone) || null,
    ].filter(Boolean) });

    /* ── reference + time ── */
    var ref = _s(o.receiptId || o.saleId || o.orderNumber || o.ref || o.id, 64);
    var when = formatTime(o.createdAt || o.serverTimestamp, settings.locale);
    if (!when) {
      /* Stated, never substituted. A receipt that prints the device clock as though
         it were the record's time is a financial document telling a small lie. */
      out.warnings.push('no server timestamp on this order');
    }
    out.blocks.push({ type: 'reference', lines: [
      ref ? 'Receipt ' + ref : 'Receipt reference missing',
      when || 'Time not recorded',
    ] });

    /* ── items ── */
    var items = Array.isArray(o.items) ? o.items : [];
    out.blocks.push({
      type: 'items',
      rows: items.map(function (it) {
        var qty = Number(it.qty || it.quantity || 1);
        var lineMinor = typeof it.lineMinor === 'number' ? it.lineMinor : null;
        return {
          qty: qty,
          name: _s(it.name || it.title || 'Item'),
          amount: lineMinor != null && _cash() ? _cash().fromMinor(lineMinor) : null,
        };
      }),
    });
    if (!items.length) out.warnings.push('this order carries no line items');

    /* ── total: the order's authoritative figure, never recomputed here ── */
    var totalMinor = typeof o.totalMinor === 'number' ? o.totalMinor : null;
    out.blocks.push({ type: 'total',
      label: 'TOTAL',
      amount: totalMinor != null && _cash() ? _cash().fromMinor(totalMinor) : null });
    if (totalMinor == null) out.warnings.push('no authoritative total on this order');

    /* ── payment: straight from the settlement, not re-derived ── */
    if (o.settlement && _cash()) {
      out.blocks.push(_cash().receiptPayment(o.settlement));
    } else if (o.payment && o.payment.method) {
      out.blocks.push({ heading: 'PAYMENT', lines: [{ label: _s(o.payment.method).toUpperCase(), amount: null }] });
    } else {
      out.blocks.push({ heading: 'PAYMENT', lines: [{ label: 'Not recorded', amount: null }] });
      out.warnings.push('no payment recorded');
    }

    /* ── fulfilment: pickup or delivery, from the contract ── */
    if (o.fulfilment && _ful()) {
      out.blocks.push(_ful().receiptFulfilment(o.fulfilment));
    } else {
      out.blocks.push({ heading: 'FULFILMENT', lines: ['Not recorded'] });
      out.warnings.push('no fulfilment recorded');
    }

    /* ── customer: present only when the order actually has one ── */
    var c = o.customer || {};
    var cLines = [_s(c.name), _s(c.phone, 32)].filter(Boolean);
    if (cLines.length) out.blocks.push({ heading: 'CUSTOMER', lines: cLines });

    /* Printing is an OUTPUT. A receipt is complete without it. */
    out.printable = true;
    out.shareable = true;
    return out;
  }

  /* Plain text for Share / WhatsApp / a 58mm printer alike. One composition, so the
     shared copy and the printed copy cannot describe different sales. */
  function toText (receipt) {
    var L = [];
    (receipt.blocks || []).forEach(function (b) {
      if (b.type === 'identity' || b.type === 'reference') { L.push.apply(L, b.lines); L.push(''); return; }
      if (b.type === 'items') {
        b.rows.forEach(function (r) {
          L.push(r.qty + ' x ' + r.name + (r.amount ? '   ' + r.amount : ''));
        });
        L.push(''); return;
      }
      if (b.type === 'total') { L.push(b.label + '   ' + (b.amount || '—')); L.push(''); return; }
      if (b.heading) {
        L.push(b.heading);
        if (b.subheading) L.push(b.subheading);
        (b.lines || []).forEach(function (l) {
          L.push(typeof l === 'string' ? l : (l.label + (l.amount ? '   ' + l.amount : '')));
        });
        L.push('');
      }
    });
    return L.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  global.SokoniReceipt = { render: render, toText: toText, formatTime: formatTime };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).SokoniReceipt;
}
