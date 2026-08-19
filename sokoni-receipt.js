/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — RECEIPT RENDERER
   ══════════════════════════════════════════════════════════════════════════════
   ONE branded receipt for every completed sale, whether it began at the counter,
   on the phone, or through online checkout. It COMPOSES authorities that are
   already proven and adds no arithmetic and no data path of its own:

     SokoniCash        payment lines, change, balance, overpayment
     SokoniFulfilment  pickup / delivery, destination, rider
     the order         identity, items, totals, SERVER timestamp
     the shop record   merchant identity — ONE source, not a receipt-only copy

   ── THE PHONE IS THE RECEIPT SYSTEM ─────────────────────────────────────────
   render() returns a STRUCTURE, not a printer job. The screen renders it, Share
   sends it, and the P58E prints it if one happens to be paired. A merchant with no
   printer has a complete receipt; printing is an output, never a prerequisite —
   and no merchant should have to visit POS Setup before they can sell.

   ── TIME COMES FROM THE SERVER ──────────────────────────────────────────────
   A phone clock is user-settable and must never be the authority on a financial
   record. The device only FORMATS it. A receipt with no server time says so rather
   than quietly substituting new Date().

   ── IT NEVER INVENTS ────────────────────────────────────────────────────────
   Every identity line is conditional. No logo, no email, no KRA PIN, no terminal,
   no cashier — those lines are simply ABSENT. A terminal id appears only when a
   real terminal exists, because a phone sale has no terminal and printing one
   would put a fiction on a tax-adjacent document.

   NOTE ON KRA PIN: shops/{uid} has no tax field today (see firestore.rules — the
   updatable set is name/phone/email/address/city/…). It is therefore read from the
   merchant's tax profile when one is supplied, and omitted otherwise. It is NOT
   invented, and NOT stored as a receipt-only copy.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var BRAVILEX = 'BRAVILEX INTERNATIONAL CO. LIMITED';
  var TAGLINE = 'Digital commerce for everyday business';

  function _cash () { return global.SokoniCash; }
  function _ful () { return global.SokoniFulfilment; }

  var _s = function (v, n) { return String(v == null ? '' : v).slice(0, n || 120).trim(); };
  var _money = function (minor) {
    return (typeof minor === 'number' && _cash()) ? _cash().fromMinor(minor) : null;
  };

  function formatTime (ts, locale) {
    var d = null;
    if (ts && typeof ts.toDate === 'function') d = ts.toDate();
    else if (ts instanceof Date) d = ts;
    else if (typeof ts === 'number' && isFinite(ts)) d = new Date(ts);
    else if (typeof ts === 'string' && ts) { var p = new Date(ts); if (!isNaN(p.getTime())) d = p; }
    if (!d || isNaN(d.getTime())) return null;
    try {
      return {
        date: d.toLocaleDateString(locale || 'en-KE', { day: '2-digit', month: 'short', year: 'numeric' }),
        time: d.toLocaleTimeString(locale || 'en-KE', { hour: '2-digit', minute: '2-digit', hour12: false }),
      };
    } catch (_) { return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16) }; }
  }

  function render (order, opts) {
    var o = order || {};
    var settings = opts || {};
    var out = { blocks: [], warnings: [] };
    var shop = o.shop || settings.shop || {};
    var tax = o.tax || settings.tax || {};

    /* ── 1. MERCHANT IDENTITY — one source, every line conditional ── */
    var shopName = _s(shop.name || shop.storeName);
    out.blocks.push({
      type: 'identity',
      logo: _s(shop.logo || shop.logoUrl, 500) || null,
      shopName: shopName || null,
      platform: 'SOKONI',
      poweredBy: 'Powered by ' + BRAVILEX,
      lines: [
        _s(shop.phone, 32),
        _s(shop.email, 80),
        [_s(shop.address), _s(shop.city || shop.town)].filter(Boolean).join(', '),
        /* Tax identity only when the merchant actually has one on file. */
        _s(tax.kraPin || tax.pin || shop.kraPin) ? 'KRA PIN: ' + _s(tax.kraPin || tax.pin || shop.kraPin, 32) : '',
      ].filter(Boolean),
    });
    if (!shopName) out.warnings.push('the shop has no name on its record');

    /* ── 2. SALE INFORMATION ── */
    var ref = _s(o.receiptId || o.saleId || o.orderNumber || o.ref || o.id, 64);
    var when = formatTime(o.createdAt || o.serverTimestamp, settings.locale);
    if (!when) out.warnings.push('no server timestamp on this order');
    var saleLines = [
      ref ? 'Receipt ' + ref : 'Receipt reference missing',
      when ? when.date + ' · ' + when.time : 'Time not recorded',
    ];
    /* A terminal id ONLY when a real terminal exists. A phone sale has none, and a
       fabricated one on a tax-adjacent document is a fiction. */
    if (_s(o.terminalId)) saleLines.push('Terminal: ' + _s(o.terminalId, 40));
    if (_s(o.cashierName || (o.cashier && o.cashier.name))) {
      saleLines.push('Served by: ' + _s(o.cashierName || o.cashier.name));
    }
    out.blocks.push({ type: 'reference', lines: saleLines });

    /* ── 3. CUSTOMER — present only when the order has one ── */
    var c = o.customer || {};
    var cLines = [_s(c.name), _s(c.phone, 32)].filter(Boolean);
    if (cLines.length) out.blocks.push({ heading: 'CUSTOMER', lines: cLines });

    /* ── 4. ITEMS — product, qty, unit price, line total ── */
    var items = Array.isArray(o.items) ? o.items : [];
    out.blocks.push({
      type: 'items',
      rows: items.map(function (it) {
        var qty = Number(it.qty || it.quantity || 1);
        var unit = typeof it.unitMinor === 'number' ? it.unitMinor : null;
        var line = typeof it.lineMinor === 'number' ? it.lineMinor
                 : (unit != null ? unit * qty : null);
        return { qty: qty, name: _s(it.name || it.title || 'Item'),
                 unit: _money(unit), amount: _money(line) };
      }),
    });
    if (!items.length) out.warnings.push('this order carries no line items');

    /* ── 5. TOTALS — the order's authoritative figures, never recomputed here ── */
    var t = o.totals || {};
    var totalMinor = typeof o.totalMinor === 'number' ? o.totalMinor
                   : (typeof t.totalMinor === 'number' ? t.totalMinor : null);
    var sumLines = [];
    if (typeof t.subtotalMinor === 'number') sumLines.push({ label: 'Subtotal', amount: _money(t.subtotalMinor) });
    if (typeof t.discountMinor === 'number' && t.discountMinor > 0) sumLines.push({ label: 'Discount', amount: '-' + _money(t.discountMinor) });
    if (typeof t.deliveryMinor === 'number' && t.deliveryMinor > 0) sumLines.push({ label: 'Delivery', amount: _money(t.deliveryMinor) });
    if (typeof t.taxMinor === 'number' && t.taxMinor > 0) sumLines.push({ label: 'Tax', amount: _money(t.taxMinor) });
    out.blocks.push({ type: 'total', lines: sumLines, label: 'TOTAL', amount: _money(totalMinor) });
    if (totalMinor == null) out.warnings.push('no authoritative total on this order');

    /* ── 6. PAYMENT — straight from the settlement, plus any gateway reference ── */
    if (o.settlement && _cash()) {
      var pay = _cash().receiptPayment(o.settlement);
      var reference = _s(o.paymentRef || (o.payment && (o.payment.reference || o.payment.mpesaCode)), 64);
      if (reference) pay.lines = pay.lines.concat([{ label: 'REF', amount: reference }]);
      out.blocks.push(pay);
    } else if (o.payment && o.payment.method) {
      out.blocks.push({ heading: 'PAYMENT', lines: [{ label: _s(o.payment.method).toUpperCase(), amount: null }] });
    } else {
      out.blocks.push({ heading: 'PAYMENT', lines: [{ label: 'Not recorded', amount: null }] });
      out.warnings.push('no payment recorded');
    }

    /* ── 7. FULFILMENT — pickup or delivery, from the contract ── */
    if (o.fulfilment && _ful()) out.blocks.push(_ful().receiptFulfilment(o.fulfilment));
    else { out.blocks.push({ heading: 'FULFILMENT', lines: ['Not recorded'] }); out.warnings.push('no fulfilment recorded'); }

    /* ── 8. THE CLOSE — and it brings the customer back to SOKONI, not elsewhere ── */
    out.blocks.push({
      type: 'closing',
      thanks: 'Thank you for shopping with us',
      note: 'Your business means a lot to us.',
      help: 'Need help with your order? Message us on SOKONI.',
      platform: 'SOKONI',
      tagline: TAGLINE,
      poweredBy: 'Powered by',
      company: BRAVILEX,
      /* The year comes from the SERVER timestamp, or is omitted. Falling back to
         new Date() would put the device clock on the document after this file spent
         two blocks explaining that it never does — a small lie is still a lie, and
         a copyright without a year is perfectly ordinary. */
      copyright: '© ' + (when ? when.date.slice(-4) + ' ' : '') + BRAVILEX,
    });

    out.printable = true;
    out.shareable = true;
    return out;
  }

  /* Plain text for Share, WhatsApp, or a 58mm printer alike. ONE composition, so the
     shared copy and the printed copy cannot describe different sales. */
  function toText (receipt) {
    var L = [];
    var rule = '------------------------------';
    (receipt.blocks || []).forEach(function (b) {
      if (b.type === 'identity') {
        if (b.shopName) L.push(b.shopName);
        L.push(b.platform);
        L.push(b.poweredBy);
        L.push.apply(L, b.lines);
        L.push(rule); return;
      }
      if (b.type === 'reference') { L.push.apply(L, b.lines); L.push(rule); return; }
      if (b.type === 'items') {
        b.rows.forEach(function (r) {
          L.push(r.qty + ' x ' + r.name);
          if (r.unit || r.amount) L.push('    ' + (r.unit ? r.unit + ' ea' : '') + (r.amount ? '   ' + r.amount : ''));
        });
        L.push(rule); return;
      }
      if (b.type === 'total') {
        (b.lines || []).forEach(function (l) { L.push(l.label + '   ' + l.amount); });
        L.push(b.label + '   ' + (b.amount || '—'));
        L.push(rule); return;
      }
      if (b.type === 'closing') {
        L.push(b.thanks); L.push(b.note); L.push(''); L.push(b.help); L.push('');
        L.push(b.platform); L.push(b.tagline); L.push('');
        L.push(b.poweredBy); L.push(b.company); L.push(b.copyright);
        return;
      }
      if (b.heading) {
        L.push(b.heading);
        if (b.subheading) L.push(b.subheading);
        (b.lines || []).forEach(function (l) {
          L.push(typeof l === 'string' ? l : (l.label + (l.amount ? '   ' + l.amount : '')));
        });
        L.push(rule);
      }
    });
    return L.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /* ── WHY NOT `SokoniReceipt` ────────────────────────────────────────────────
     That global is ALREADY TAKEN. pos-checkout.html, pos-marketplace.html and
     pos-printer.js all call `window.SokoniReceipt.print()` / `.doc()`, and this
     module has neither method. Claiming the name would have silently broken POS
     printing on any page that loads both — a page would look fine until a merchant
     tried to print. The existing POS receipt path is left exactly as it is. */
  global.SokoniReceiptDoc = { render: render, toText: toText, formatTime: formatTime,
                              BRAVILEX: BRAVILEX, TAGLINE: TAGLINE };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).SokoniReceiptDoc;
}
