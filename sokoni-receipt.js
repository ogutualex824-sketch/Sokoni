/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — THE UNIVERSAL RECEIPT CONTRACT
   ══════════════════════════════════════════════════════════════════════════════
   ONE renderer for every receipt SOKONI produces. Owner sale, employee sale,
   pickup, delivery, online order, test receipt, sample receipt — all of them come
   through here. There is no production renderer plus a separate development one,
   because the moment those exist they drift, and the branded thing you tested is
   no longer the branded thing the customer receives.

   It COMPOSES authorities that are already proven and adds no arithmetic and no
   data path of its own:

     SokoniCash        payment lines, change, balance, overpayment
     SokoniFulfilment  pickup / delivery, destination, rider
     the order         identity, items, totals, SERVER timestamp
     the shop record   merchant identity — ONE source, not a receipt-only copy

   ── MANDATORY ON EVERY RECEIPT ──────────────────────────────────────────────
     · SOKONI branding                    · items, quantities, prices, totals
     · the SOKONI QR                      · payment details
     · shop logo when available           · delivery / pickup where applicable
     · shop name (always)                 · "Powered by SOKONI"
     · shop contact where configured      · Bravilex operating identity
     · receipt number                     · a way back into SOKONI
     · SERVER date and time               · "Served by", when it is knowable

   ── THE PHONE IS THE RECEIPT SYSTEM ─────────────────────────────────────────
   render() returns a STRUCTURE, not a printer job. The PHONE is the canonical
   presentation; the P58E is an optional physical output of the same data through
   a different adapter. A merchant with no printer has a complete receipt, and
   nobody has to open POS Setup before they can sell.

   ── TIME COMES FROM THE SERVER ──────────────────────────────────────────────
   A phone clock is user-settable and must never be the authority on a financial
   record. The device only FORMATS it. A receipt with no server time says so
   rather than quietly substituting new Date().

   ── IT NEVER INVENTS ────────────────────────────────────────────────────────
   Every conditional line is ABSENT when its data is absent — no logo, no email,
   no KRA PIN, no terminal, no "Served by". A terminal id appears only when a real
   terminal exists, because a phone sale has none and printing one would put a
   fiction on a tax-adjacent document.

   NOTE ON KRA PIN: shops/{uid} has no tax field today (see firestore.rules — the
   updatable set is name/phone/email/address/city/…). It is therefore read from
   the merchant's tax profile when one is supplied, and omitted otherwise.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var PLATFORM = 'SOKONI';
  var BRAVILEX = 'Bravilex International Co. Limited';
  /* The attribution is fixed by the brand authority: SOKONI, then who owns it.
     Rendered as PLATFORM above this line, so the closing reads
       SOKONI / Developed / owned / operated by / Bravilex International Co. Limited
     rather than collapsing the platform and the company into one claim. */
  var POWERED_BY = 'Developed / owned / operated by';
  var TAGLINE = 'Digital commerce for everyday business';
  var SAMPLE_NOTICE = 'SAMPLE / TEST — NOT A SALES RECORD';

  /* ── THE QR DESTINATION ─────────────────────────────────────────────────────
     Exactly the URL two production writers already build — payment-trust.js:83
     and fulfilment-scan.js:142. A third spelling of the customer receipt surface
     would be the same defect as a twelfth spelling of a delivery destination, so
     this constant is asserted against those files by the test suite.

     It encodes the RECEIPT NUMBER and nothing else. That number is already printed
     in full on the paper the customer is holding, so the QR discloses nothing the
     receipt does not. A QR must never carry a phone number, a uid, an amount, a
     token or an address — a photographed receipt would then leak them to anyone
     who scans the picture. */
  var RECEIPT_URL_BASE = 'https://mysokoni.co.ke/payment-receipt.html?ref=';

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

  /* ── WHO SERVED THE CUSTOMER ────────────────────────────────────────────────
     Authoritative or absent. When an EMPLOYEE rang the sale up the receipt names
     the employee — never the shop owner, because a receipt crediting the owner for
     an employee's sale is a false record, and it is exactly the record a shift
     dispute turns on. When the server did not say who served, the line is OMITTED
     rather than filled in with the likeliest person. */
  var SERVER_ROLES = ['owner', 'employee', 'staff', 'cashier', 'manager'];

  /* The employee NUMBER, and only for a named server. An employee number with
     no name attached identifies a payroll record rather than a person, which
     is the opposite of what a customer-facing receipt is for. */
  function employeeNoLine (order) {
    var sb = (order && order.servedBy) || null;
    if (!sb || !_s(sb.name, 60)) return null;
    var no = _s(sb.employeeNo || sb.employeeNumber || sb.staffNo || sb.code, 24);
    return no ? 'Employee No: ' + no : null;
  }

  function servedByLine (order) {
    var sb = (order && order.servedBy) || null;
    if (!sb) return null;
    var name = _s(sb.name, 60);
    /* An employee sale with no employee name does NOT fall through to the owner. */
    if (!name) return null;
    var role = _s(sb.role, 20).toLowerCase();
    if (role && SERVER_ROLES.indexOf(role) === -1) return null;
    return 'Served by: ' + name;
  }

  /* The role, as a customer-facing word. `label` is preferred because the merchant
     identity authority computes it server-side; the map is only a fallback for a
     caller that supplied a bare role. An unknown role yields NO line rather than a
     guess — and there is no line at all without a valid Served by, so a role can
     never appear attached to nobody. */
  /* `cashier` used to collapse to 'Staff'. On a customer receipt that discards
     the one role a customer can act on — the person at the till who can take a
     return. `staff` and `employee` stay generic because they ARE generic. */
  var ROLE_LABEL = { owner: 'Owner', manager: 'Manager', cashier: 'Cashier',
                     staff: 'Staff', employee: 'Staff' };

  function servedRoleLine (order) {
    if (!servedByLine(order)) return null;
    var sb = order.servedBy;
    var label = _s(sb.label, 24);
    if (!label) label = ROLE_LABEL[_s(sb.role, 20).toLowerCase()] || '';
    return label ? 'Role: ' + label : null;
  }

  function render (order, opts) {
    var o = order || {};
    var settings = opts || {};
    var out = { blocks: [], warnings: [] };
    var shop = o.shop || settings.shop || {};
    var tax = o.tax || settings.tax || {};
    var isSample = settings.sample === true || o.sample === true;

    /* ── 0. SAMPLE / TEST — the SAME branding, clearly marked ────────────────
       A test receipt IS a SOKONI receipt. Stripping the branding for tests is how
       you end up certifying a document nobody will ever receive. */
    if (isSample) {
      out.sample = true;
      out.blocks.push({ type: 'notice', text: SAMPLE_NOTICE });
    }

    /* ── 1. MERCHANT IDENTITY — one source, every line conditional ──────────── */
    var shopName = _s(shop.name || shop.storeName);
    var logo = _s(shop.logo || shop.logoUrl, 500) || null;
    out.blocks.push({
      type: 'identity',
      platform: PLATFORM,
      logo: logo,
      shopName: shopName || null,
      /* ── NO LOGO IS NOT A BROKEN LOGO ────────────────────────────────────
         When the merchant has not uploaded one, the SHOP NAME becomes the visual
         identity and the SOKONI mark stays. What must never render is an empty
         frame or a broken-image icon: a receipt that looks broken makes the shop
         look broken, and most new merchants have no logo on their first day. */
      mark: logo ? { kind: 'logo', src: logo, alt: shopName || PLATFORM }
                 : { kind: 'wordmark', text: shopName || PLATFORM, platform: PLATFORM },
      lines: [
        _s(shop.phone, 32),
        _s(shop.email, 80),
        [_s(shop.address), _s(shop.city || shop.town)].filter(Boolean).join(', '),
        _s(tax.kraPin || tax.pin || shop.kraPin) ? 'KRA PIN: ' + _s(tax.kraPin || tax.pin || shop.kraPin, 32) : '',
        /* BRANCH. A multi-branch merchant whose receipts cannot say WHICH branch
           sold the item cannot reconcile a till, settle a dispute, or accept a
           return at the right counter. Printed only when the shop record
           actually carries one — a single-branch shop gets no empty line. */
        _s(shop.branch || shop.branchName || shop.branchLabel)
          ? 'Branch: ' + _s(shop.branch || shop.branchName || shop.branchLabel, 40) : '',
      ].filter(Boolean),
    });
    if (!shopName) out.warnings.push('the shop has no name on its record');

    /* ── 2. SALE INFORMATION ────────────────────────────────────────────────── */
    var ref = _s(o.receiptId || o.saleId || o.orderNumber || o.ref || o.id, 64);
    var when = formatTime(o.createdAt || o.serverTimestamp, settings.locale);
    if (!when) out.warnings.push('no server timestamp on this order');
    var saleLines = [
      ref ? 'RECEIPT ' + ref : 'Receipt reference missing',
      when ? when.date + ' · ' + when.time : 'Time not recorded',
    ];
    var served = servedByLine(o);
    if (served) {
      saleLines.push(served);
      var roleLine = servedRoleLine(o);
      if (roleLine) saleLines.push(roleLine);
      /* EMPLOYEE NUMBER. The name answers 'who', the number answers 'which
         record' — two cashiers called John are not a hypothetical in a chain.
         Same rule as the name: only when the order actually carries it. */
      var empNo = employeeNoLine(o);
      if (empNo) saleLines.push(empNo);
    } else out.warnings.push('who served this sale is not recorded');
    /* A terminal id ONLY when a real terminal exists. */
    if (_s(o.terminalId)) saleLines.push('Terminal: ' + _s(o.terminalId, 40));
    out.blocks.push({ type: 'reference', lines: saleLines });

    /* ── 3. CUSTOMER — present only when the order has one ───────────────────── */
    var c = o.customer || {};
    var cLines = [_s(c.name), _s(c.phone, 32)].filter(Boolean);
    if (cLines.length) out.blocks.push({ heading: 'CUSTOMER', lines: cLines });

    /* ── 4. ITEMS — a real grid: product, qty, amount ────────────────────────── */
    var items = Array.isArray(o.items) ? o.items : [];
    /* UNIT PRICE was already computed on every row and then never shown.

       It is added as a COLUMN only when at least one line has qty > 1. At qty 1
       the unit price and the line amount are the same number, so on 32-column
       paper a fourth column would cost ~8 characters of product name to print
       a value the customer can already read. Where quantity actually varies —
       the case that makes a receipt hard to check — the column appears. */
    var _multi = items.some(function (it) { return Number(it.qty || it.quantity || 1) > 1; });
    var _hasUnit = items.some(function (it) { return typeof it.unitMinor === 'number'; });
    var _showUnit = _multi && _hasUnit;
    out.blocks.push({
      type: 'items',
      showUnit: _showUnit,
      columns: _showUnit ? ['PRODUCT', 'QTY', 'UNIT', 'AMOUNT'] : ['PRODUCT', 'QTY', 'AMOUNT'],
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
      /* A SPLIT sale can carry a reference PER TENDER — one M-Pesa code, one
         card reference. A single trailing REF line cannot say which tender it
         belongs to, so per-tender references are printed against their own
         tender and the trailing REF is kept only for the single-tender case
         it was written for. */
      var _tenders = (o.settlement && o.settlement.tenders) || [];
      var _perTender = [];
      _tenders.forEach(function (t) {
        var r = _s(t && (t.reference || t.mpesaCode || t.receiptNumber || t.terminalRef), 64);
        /* A REFERENCE IS A STRING LINE, NOT AN AMOUNT.
           Pushed as {label, amount} it lands in the 9-character amount column,
           and a 10-character M-Pesa code comes out silently CLIPPED — an
           authoritative-looking number that is not the one the gateway holds.
           As a plain line it wraps to the paper width and stays whole. */
        if (r) _perTender.push(_s(t.method, 20).toUpperCase() + ' REF: ' + r);
        var tid = _s(t && t.terminalId, 40);
        if (tid) _perTender.push(_s(t.method, 20).toUpperCase() + ' TERMINAL: ' + tid);
      });
      if (_perTender.length) pay.lines = pay.lines.concat(_perTender);
      else if (reference) pay.lines = pay.lines.concat(['REF: ' + reference]);
      out.blocks.push(pay);
    } else if (o.payment && o.payment.method) {
      out.blocks.push({ heading: 'PAYMENT', lines: [{ label: _s(o.payment.method).toUpperCase(), amount: null }] });
    } else {
      out.blocks.push({ heading: 'PAYMENT', lines: [{ label: 'Not recorded', amount: null }] });
      out.warnings.push('no payment recorded');
    }

    /* ── 7. FULFILMENT — pickup or delivery, from the contract ───────────────── */
    /* An ordinary counter sale has no fulfilment, and printing 'FULFILMENT / Not recorded'
       on it stated something about delivery that the sale never had — on every receipt, on
       thermal paper. The block now appears ONLY when the order genuinely carries a
       fulfilment: a delivery prints its destination, a pickup prints that it was collected
       at the shop, and a counter sale prints nothing at all.

       The warning is kept for a delivery-shaped order whose fulfilment failed to build, so a
       genuinely missing destination is still visible to the caller — just not to the
       customer holding the paper. */
    if (o.fulfilment && _ful()) {
      var _f = _ful().receiptFulfilment(o.fulfilment);
      /* receiptFulfilment ALSO returns a 'Not recorded' block for a typeless object, so the
         second source of that line is suppressed here rather than only the first. */
      var _empty = _f && _f.lines && _f.lines.length === 1 && _f.lines[0] === 'Not recorded';
      if (_empty) out.warnings.push('fulfilment present but not recorded');
      else out.blocks.push(_f);
    }

    /* ── 8. THE CLOSE — and it brings the customer back INTO SOKONI ──────────── */
    out.blocks.push({
      type: 'closing',
      /* The heart is NOT decoration in this file: it is the only non-ASCII
         character in the composition, and the paper adapter proves its
         transliteration against it. Removing it silently made two printer
         assertions vacuous. Platform named per the brand authority; heart kept
         because a test needs something real to transliterate. */
      thanks: 'Thank you for shopping with ' + PLATFORM + ' ❤',
      help: 'Message us on SOKONI',
      /* The QR is functional, not decorative: it resolves to the customer's own
         receipt on SOKONI. With no receipt number there is NO QR — one pointing
         nowhere is worse than none, because the customer scans it, lands on an
         error and concludes SOKONI is broken. */
      /* The caption says VERIFY, not just view: the QR resolves to SOKONI's own
         record of this sale, which is what makes it usable for a return or a
         dispute rather than a decorative link. */
      qr: ref ? { url: RECEIPT_URL_BASE + encodeURIComponent(ref),
                  caption: 'Scan to view or verify this receipt' } : null,
      keep: 'Keep this receipt for your records.',
      poweredBy: POWERED_BY,
      company: BRAVILEX,
      tagline: TAGLINE,
      /* The year comes from the SERVER timestamp, or is omitted. Falling back to
         new Date() would put the device clock on the document after this file
         spent two blocks explaining that it never does. */
      copyright: '© ' + (when ? when.date.slice(-4) + ' ' : '') + BRAVILEX,
    });
    if (!ref) out.warnings.push('no receipt number, so the receipt carries no QR');

    out.printable = true;
    out.shareable = true;
    return out;
  }

  /* ══════════════════════════════════════════════════════════════════════════
     TEXT ADAPTER — Share, WhatsApp, and the 58mm printer alike
     ══════════════════════════════════════════════════════════════════════════
     ONE composition, so the shared copy and the printed copy cannot describe two
     different sales. `cols` is the paper width in characters: 32 for 58mm, 42 for
     80mm — the same widths pos-printer.js uses. Content REFLOWS to the width
     rather than overflowing it, because a wrapped product name is still legible
     and a truncated one is a different product. */
  var DEFAULT_COLS = 32;

  /* ── THE PRINTER IS NOT THE PHONE ───────────────────────────────────────────
     ESC/POS thermal printers render a single-byte codepage. A heart, an em dash or
     a middle dot comes out of the P58E as one or two garbage glyphs — so the PAPER
     adapter transliterates to ASCII while the phone and WhatsApp keep the real
     characters. Same receipt data, two presentation adapters. */
  var ASCII_MAP = [
    [/[❤♥]️?/g, ''], [/[·•]/g, '-'], [/[—–]/g, '-'],
    [/©/g, '(c)'], [/[“”]/g, '"'], [/[‘’]/g, "'"], [/…/g, '...'],
  ];
  function _ascii (str) {
    var out = String(str == null ? '' : str);
    ASCII_MAP.forEach(function (m) { out = out.replace(m[0], m[1]); });
    /* Anything still outside printable ASCII would come out of the printer as noise. */
    return out.replace(/[^\x20-\x7E\n]/g, '');
  }

  function _wrap (text, width) {
    var words = String(text || '').split(/\s+/).filter(Boolean);
    var lines = [], cur = '';
    words.forEach(function (w) {
      /* A single word longer than the column is hard-split. Nothing else can be
         done with it, and dropping it would lose the product name entirely. */
      while (w.length > width) {
        if (cur) { lines.push(cur); cur = ''; }
        lines.push(w.slice(0, width));
        w = w.slice(width);
      }
      if (!cur) cur = w;
      else if (cur.length + 1 + w.length <= width) cur += ' ' + w;
      else { lines.push(cur); cur = w; }
    });
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  }

  var _padL = function (s, n) { s = String(s == null ? '' : s); return s.length >= n ? s : new Array(n - s.length + 1).join(' ') + s; };
  var _padR = function (s, n) { s = String(s == null ? '' : s); return s.length >= n ? s : s + new Array(n - s.length + 1).join(' '); };
  var _centre = function (s, n) {
    s = String(s == null ? '' : s);
    if (s.length >= n) return s;
    return new Array(Math.floor((n - s.length) / 2) + 1).join(' ') + s;
  };

  function toText (receipt, opts) {
    var o = opts || {};
    var cols = Math.max(20, o.cols || DEFAULT_COLS);
    var L = [];
    var rule = new Array(cols + 1).join('-');
    /* AMOUNT right-aligned, QTY right-aligned, PRODUCT takes what is left. */
    var amtW = Math.min(10, Math.max(7, Math.floor(cols * 0.3)));
    var qtyW = 5;
    var nameW = cols - amtW - qtyW;

    /* When the UNIT column is present the name column pays for it, because the
       paper width is fixed. A wrapped product name is still legible; a receipt
       wider than the paper is not printed at all. */
    function row (name, qty, amount, unit, unitW) {
      var nw = nameW - (unitW || 0);
      var chunks = _wrap(name, nw);
      return chunks.map(function (chunk, i) {
        var last = (i === chunks.length - 1);
        var tail = '';
        if (last) {
          tail = _padL(qty == null ? '' : qty, qtyW);
          if (unitW) tail += _padL(unit == null ? '' : unit, unitW);
          tail += _padL(amount == null ? '' : amount, amtW);
        }
        return (_padR(chunk, nw) + tail).replace(/\s+$/, '');
      });
    }

    (receipt.blocks || []).forEach(function (b) {
      if (b.type === 'notice') {
        _wrap(b.text, cols).forEach(function (l) { L.push(_centre(l, cols)); });
        L.push(rule);
        return;
      }
      if (b.type === 'identity') {
        /* On paper a logo cannot be a URL, so the mark degrades to the wordmark in
           BOTH cases — the shop name is the identity, never a broken box. */
        L.push(_centre(b.platform, cols));
        if (b.shopName) L.push(_centre(b.shopName, cols));
        b.lines.forEach(function (l) { _wrap(l, cols).forEach(function (x) { L.push(_centre(x, cols)); }); });
        L.push(rule);
        return;
      }
      if (b.type === 'reference') { b.lines.forEach(function (l) { L.push(l); }); L.push(rule); return; }
      if (b.type === 'items') {
        var uW = b.showUnit ? Math.min(9, Math.max(6, amtW - 1)) : 0;
        var hdr = _padR(b.columns[0], nameW - uW) + _padL(b.columns[1], qtyW);
        if (uW) hdr += _padL(b.columns[2], uW);
        hdr += _padL(b.columns[b.columns.length - 1], amtW);
        L.push(hdr);
        L.push(rule);
        b.rows.forEach(function (r) { L.push.apply(L, row(r.name, r.qty, r.amount, r.unit, uW)); });
        L.push(rule);
        return;
      }
      if (b.type === 'total') {
        (b.lines || []).forEach(function (l) { L.push(_padR(l.label, cols - amtW) + _padL(l.amount, amtW)); });
        L.push(_padR(b.label, cols - amtW) + _padL(b.amount || '—', amtW));
        L.push(rule);
        return;
      }
      if (b.type === 'closing') {
        L.push('');
        _wrap(b.thanks, cols).forEach(function (l) { L.push(_centre(l, cols)); });
        L.push('');
        L.push(_centre(b.help, cols));
        /* The URL is pushed WHOLE. Hard-wrapping it to the column would split it
           mid-path, and a split URL is not tappable in WhatsApp — which is where
           most of these receipts actually go. The printer wraps it itself. */
        if (b.qr) {
          L.push(_centre('[ SOKONI QR ]', cols));
          _wrap(b.qr.caption, cols).forEach(function (l) { L.push(_centre(l, cols)); });
          L.push(b.qr.url);
        }
        if (b.keep) { L.push(''); _wrap(b.keep, cols).forEach(function (l) { L.push(_centre(l, cols)); }); }
        L.push('');
        L.push(_centre(PLATFORM, cols));
        _wrap(b.poweredBy, cols).forEach(function (l) { L.push(_centre(l, cols)); });
        _wrap(b.company, cols).forEach(function (l) { L.push(_centre(l, cols)); });
        /* `copyright` is deliberately NOT printed: on a 32-column receipt it is a
           second Bravilex line directly under the first. It stays in the structure
           for the digital footer, where there is room for it. */
        return;
      }
      if (b.heading) {
        L.push(b.heading);
        if (b.subheading) L.push(b.subheading);
        (b.lines || []).forEach(function (l) {
          if (typeof l === 'string') { _wrap(l, cols).forEach(function (x) { L.push(x); }); return; }
          L.push(l.amount ? _padR(l.label, cols - amtW) + _padL(l.amount, amtW) : l.label);
        });
        L.push(rule);
      }
    });
    var text = L.join('\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, '')
      /* Blank LINES off the top and tail — NOT leading spaces, which are the
         centring of the very first line. A plain .trim() here flattened SOKONI to
         the left margin on every single receipt. */
      .replace(/^\n+/, '').replace(/\n+$/, '');
    return o.ascii ? _ascii(text) : text;
  }

  global.SokoniReceiptDoc = {
    render: render, toText: toText, formatTime: formatTime,
    servedByLine: servedByLine, servedRoleLine: servedRoleLine, ROLE_LABEL: ROLE_LABEL,
    employeeNoLine: employeeNoLine,
    PLATFORM: PLATFORM, BRAVILEX: BRAVILEX, POWERED_BY: POWERED_BY, TAGLINE: TAGLINE,
    SAMPLE_NOTICE: SAMPLE_NOTICE, RECEIPT_URL_BASE: RECEIPT_URL_BASE,
    DEFAULT_COLS: DEFAULT_COLS, SERVER_ROLES: SERVER_ROLES,
  };
  /* NOTE: NOT `SokoniReceipt` — that global belongs to the existing POS receipt
     path (pos-checkout.html, pos-marketplace.html and pos-printer.js all call
     .print()/.doc() on it). Claiming it would break printing on any page that
     loads both, and the page would look healthy until someone pressed Print. */
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).SokoniReceiptDoc;
}
