/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — ORDERS workspace for AdminOS
   sokoni-aos-orders.js

   The order desk, built on what `adminGetOrders` actually returns and on what the
   writers actually write.

   ── THE CONTRACT, READ RATHER THAN ASSUMED ──────────────────────────────────────────────
   adminGetOrders returns ONE key — `orders` — and each entry is the RAW Firestore
   document (`{ id, ...d.data() }`), capped at 200, newest first, with one optional
   `status` equality filter. There is no total, no facet count, no aggregate, and no
   prior period.

   Because it returns raw documents, the field set is whatever the writers wrote — and
   THEY DISAGREE. Two server writers alone diverge:

       api-gateway.js      orderId · buyerId · subtotal · status:'pending_payment'
       manual-till-orders  id · uid · buyerUid · amount · total · orderTotal · channel

   and `order-advance-authority.js` reads the seller under `sellerUid | sellerId |
   vendorId`, the rider under `riderId | riderUid | driverId | assignedRider`, and the
   buyer under `buyerId | uid | userId | customerId`. This module reads the same unions
   and WRITES NONE of them. Converging those vocabularies is separate work; inventing a
   single one here would simply add a ninth spelling.

   ── WHAT THIS PLATFORM DOES NOT HAVE ────────────────────────────────────────────────────
   An order desk is exactly where invented figures look unremarkable, so each of these is
   declared with its reason and asserted absent by `scripts/test-aos-orders.js`:

     • NO TREND ARROWS. "+15.3% vs last month" needs a prior-period count. Nothing returns
       one. A page compared with itself is not a trend.

     • NO SPARKLINES. There is no time series behind a capped page of documents.

     • NO PLATFORM TOTAL. The read is capped at 200 with no count query, so every figure
       counts what was LOADED and says so.

     • NO STATUS FACETS. Tab counts come from the loaded page, not from the collection.
       The callable takes one status filter and returns rows, never counts.

     • NO CARD BRANDS. There is no "Visa •••• 4242" on a SOKONI order. Payment is M-PESA
       and IntaSend; card is not implemented on this platform. Rendering a card brand
       would be a fabrication with a logo on it.

     • NO CARRIERS AND NO SIGNATURE. There is no FedEx, UPS or USPS field, and nothing
       captures a signature. Fulfilment is a SOKONI rider plus `trackingCode`, which is
       what the delivery rail actually writes.

     • NO MARKETPLACE CHANNELS. Amazon, eBay, Walmart, TikTok Shop and Shopify POS are not
       integrations this platform has. `channel`, `source` and `hub` are shown verbatim
       when present — never mapped onto a storefront that does not exist.

     • NO GROSS REVENUE. Revenue is a payments question, and production payments carry
       UPPERCASE states where `succeeded` is never written. Summing the totals of one page
       of orders and calling it revenue would be wrong twice over. The strip reports the
       VALUE OF THE LOADED ORDERS, named for exactly what it measures.

   ── ABSENT IS NOT ZERO ──────────────────────────────────────────────────────────────────
   The existing table renders `KES ${o.total || 0}`. An order written by the gateway has
   no `total` at all — it has `subtotal` — so that row displays a confident **KES 0** for
   an order whose value is simply recorded elsewhere. This module reads the union in a
   declared precedence and says "not recorded" when none of them is present.

   ── ONE WRITER ──────────────────────────────────────────────────────────────────────────
   ADDITIVE. Renders beside the existing table; returns false if it cannot, leaving that
   table to run. It performs no read and no write of its own: a status change delegates to
   `adminUpdateOrderStatus`, which AdminOS already owns.

   There is deliberately NO refund control. On this platform, writing a refund request IS
   the refund — the document auto-credits a wallet — so a one-click admin button would be
   an execution path wearing the word "request". Refunds stay where they are: requested by
   a cashier, approved by an owner, with the server setting fee and net.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  var CSS_ID = 'sokoni-aos-orders-css';

  function esc (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function ms (t) {
    if (!t) return null;
    if (typeof t.toMillis === 'function') return t.toMillis();
    if (t.seconds) return t.seconds * 1000;
    if (t._seconds) return t._seconds * 1000;
    var n = typeof t === 'number' ? t : Date.parse(t);
    return isFinite(n) ? n : null;
  }
  function when (t) {
    var m = ms(t);
    if (!m) return null;
    return new Date(m).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function clock (t) {
    var m = ms(t);
    if (!m) return null;
    return new Date(m).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' });
  }

  /* ── FIELD UNIONS ───────────────────────────────────────────────────────────
     Read exactly the spellings order-advance-authority.js reads. First present wins,
     and the precedence is declared rather than discovered by a reader later. */
  var MONEY_FIELDS  = ['total', 'orderTotal', 'amount', 'grandTotal', 'subtotal'];
  var BUYER_ID      = ['buyerId', 'buyerUid', 'uid', 'userId', 'customerId'];
  var BUYER_NAME    = ['buyerName', 'customerName', 'userName'];
  var BUYER_CONTACT = ['buyerPhone', 'buyerEmail', 'customerPhone', 'customerEmail', 'phone', 'email'];
  var SELLER_ID     = ['sellerUid', 'sellerId', 'vendorId'];
  var RIDER_ID      = ['riderId', 'riderUid', 'driverId', 'assignedRider'];
  var CHANNEL       = ['channel', 'source', 'hub', 'hubType', 'type'];
  var PAY_STATE     = ['paymentStatus', 'paymentState'];
  var PAY_REF       = ['mpesaReceiptNumber', 'mpesaReceipt', 'transactionId', 'paymentRef', 'paymentReference'];

  function pick (o, fields) {
    for (var i = 0; i < fields.length; i++) {
      var v = o && o[fields[i]];
      if (v !== undefined && v !== null && v !== '') return { key: fields[i], value: v };
    }
    return null;
  }

  /* Money. Returns the field it came FROM, because `subtotal` is not `total` and a
     reader deciding whether to chase a discrepancy needs to know which was recorded. */
  function money (o) {
    var m = pick(o, MONEY_FIELDS);
    if (!m) return null;
    var n = typeof m.value === 'number' ? m.value : parseFloat(m.value);
    if (!isFinite(n)) return null;
    return { amount: n, field: m.key, currency: o.currency || 'KES' };
  }
  function fmtMoney (m) {
    if (!m) return null;
    return m.currency + ' ' + m.amount.toLocaleString('en-KE', { maximumFractionDigits: 2 });
  }

  function orderNo (o) {
    var id = o.id || o.orderId || '';
    return id ? String(id) : '';
  }
  function buyerOf (o) {
    var n = pick(o, BUYER_NAME);
    var c = pick(o, BUYER_CONTACT);
    var i = pick(o, BUYER_ID);
    if (n) return { text: String(n.value), sub: c ? String(c.value) : (i ? String(i.value) : ''), named: true };
    if (c) return { text: String(c.value), sub: i ? String(i.value) : '', named: false };
    if (i) return { text: String(i.value), sub: '', named: false };
    return { text: 'No customer recorded', sub: '', named: false };
  }
  function initials (o) {
    var b = buyerOf(o);
    if (!b.named) return '#';
    var p = b.text.replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean);
    if (!p.length) return '#';
    return (p[0][0] + (p[1] ? p[1][0] : '')).toUpperCase();
  }
  var TONES = ['a', 'b', 'c', 'd', 'e', 'f'];
  function tone (o) {
    var s = String(orderNo(o) || '');
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return TONES[Math.abs(h) % TONES.length];
  }

  /* ── STATUS ─────────────────────────────────────────────────────────────────
     The stages `order-advance-authority.js` actually governs, plus the states the
     writers set directly. Anything else a writer invents still renders — it is shown
     verbatim in a neutral tone rather than being dropped or renamed. */
  var TERMINAL_OK  = ['delivered', 'completed'];
  var IN_FLIGHT    = ['accepted', 'preparing', 'ready', 'assigned', 'picked_up', 'halfway', 'near'];
  var WAITING      = ['received', 'pending', 'pending_payment', 'awaiting_attestation', 'paid', 'confirmed'];
  var BAD          = ['cancelled', 'canceled', 'refunded', 'failed', 'disputed', 'rejected'];

  function statusOf (o) { return String(o.status || '').toLowerCase() || 'not recorded'; }
  function statusTone (s) {
    if (TERMINAL_OK.indexOf(s) > -1) return 'ok';
    if (IN_FLIGHT.indexOf(s) > -1)   return 'info';
    if (WAITING.indexOf(s) > -1)     return 'warn';
    if (BAD.indexOf(s) > -1)         return 'bad';
    return 'muted';
  }
  function prettyStatus (s) { return s.replace(/_/g, ' '); }

  /* Fulfilment, from the fields the delivery rail writes. No carrier, because no field
     names one. */
  function fulfilment (o) {
    var delivered = o.deliveredAt ? (when(o.deliveredAt) || null) : null;
    var track = o.trackingCode || o.trackingNumber || null;
    var rider = pick(o, RIDER_ID);
    var type = o.fulfillmentType || o.fulfilmentType || null;
    return { delivered: delivered, track: track, rider: rider ? String(rider.value) : null, type: type };
  }
  function payment (o) {
    var st = pick(o, PAY_STATE);
    var ref = pick(o, PAY_REF);
    return {
      method: o.paymentMethod || null,
      state: st ? String(st.value) : null,
      ref: ref ? String(ref.value) : null,
      refField: ref ? ref.key : null,
      paidAt: o.paidAt ? (when(o.paidAt) || null) : null,
      verified: o.paymentVerified === true,
      verifiedKnown: o.paymentVerified === true || o.paymentVerified === false,
    };
  }
  function itemsOf (o) {
    var it = o.items || o.lines || o.products;
    return Array.isArray(it) ? it : null;
  }

  function render (host, state) {
    var orders = state.orders;

    /* ── COUNTS OF THE LOADED PAGE ──────────────────────────────────────────── */
    var byStatus = {};
    orders.forEach(function (o) {
      var s = statusOf(o);
      byStatus[s] = (byStatus[s] || 0) + 1;
    });
    var statuses = Object.keys(byStatus).sort(function (a, b) { return byStatus[b] - byStatus[a]; });

    var byChannel = {};
    orders.forEach(function (o) {
      var c = pick(o, CHANNEL);
      var k = c ? String(c.value) : '';
      if (k) byChannel[k] = (byChannel[k] || 0) + 1;
    });
    var channels = Object.keys(byChannel).sort();

    /* VALUE, not revenue — and only over the orders whose value is actually recorded.
       Averaging across rows with no figure would divide by a denominator that includes
       orders contributing nothing, quietly depressing the average. */
    var priced = [], currencies = {};
    orders.forEach(function (o) {
      var m = money(o);
      if (m) { priced.push(m); currencies[m.currency] = true; }
    });
    var curList = Object.keys(currencies);
    var mixedCurrency = curList.length > 1;
    var sum = priced.reduce(function (a, m) { return a + m.amount; }, 0);
    var valueKnown = priced.length > 0 && !mixedCurrency;
    var valueText = valueKnown
      ? fmtMoney({ amount: sum, currency: curList[0] })
      : (mixedCurrency ? 'mixed' : '&mdash;');
    var avgText = valueKnown
      ? fmtMoney({ amount: sum / priced.length, currency: curList[0] })
      : (mixedCurrency ? 'mixed' : '&mdash;');

    var fulfilled = orders.filter(function (o) { return TERMINAL_OK.indexOf(statusOf(o)) > -1; }).length;
    var waiting   = orders.filter(function (o) { return WAITING.indexOf(statusOf(o)) > -1; }).length;

    var can = state.can || { status: true };

    var visible = orders.filter(function (o) {
      if (state.status !== 'all' && statusOf(o) !== state.status) return false;
      if (state.channel !== 'all') {
        var c = pick(o, CHANNEL);
        if (!c || String(c.value) !== state.channel) return false;
      }
      if (!state.q) return true;
      var b = buyerOf(o);
      var p = payment(o);
      return (orderNo(o) + ' ' + b.text + ' ' + b.sub + ' ' + statusOf(o) + ' ' + (p.ref || ''))
        .toLowerCase().indexOf(state.q) > -1;
    });

    var stat = function (label, n, t, sub) {
      return '<div class="odx-stat odx-stat--' + t + '">' +
        '<div class="odx-stat-n">' + n + '</div>' +
        '<div class="odx-stat-l">' + esc(label) + '</div>' +
        '<div class="odx-stat-s">' + esc(sub) + '</div></div>';
    };

    var open = state.open ? orders.filter(function (o) { return orderNo(o) === state.open; })[0] : null;

    host.innerHTML =
      '<div class="odx">' +

      /* ── STRIP. Every card names its scope; none is a platform figure. ────── */
      '<div class="odx-strip">' +
        stat('Loaded', orders.length, 'info', 'this page, not a platform total') +
        stat('Value of loaded orders', valueText, 'ok',
             mixedCurrency ? 'more than one currency on this page'
                           : (valueKnown ? priced.length + ' of ' + orders.length + ' carry a figure'
                                         : 'no order on this page records a value')) +
        stat('Average of those', avgText, 'info',
             valueKnown ? 'mean of the ' + priced.length + ' priced' : 'nothing to average') +
        stat('Fulfilled', fulfilled, 'ok', 'delivered or completed, of those loaded') +
        stat('Awaiting fulfilment', waiting, 'warn', 'of those loaded') +
      '</div>' +

      /* ── STATUS TABS, derived from the page rather than declared ──────────── */
      '<div class="odx-tabs">' +
        '<button class="odx-tab' + (state.status === 'all' ? ' is-on' : '') +
          '" data-odx="status" data-v="all">All <span>' + orders.length + '</span></button>' +
        statuses.map(function (s) {
          return '<button class="odx-tab' + (state.status === s ? ' is-on' : '') +
            '" data-odx="status" data-v="' + esc(s) + '">' + esc(prettyStatus(s)) +
            ' <span>' + byStatus[s] + '</span></button>';
        }).join('') +
      '</div>' +

      /* ── TOOLBAR ─────────────────────────────────────────────────────────── */
      '<div class="odx-tools">' +
        '<input class="odx-in" type="search" placeholder="Filter loaded orders…" ' +
          'value="' + esc(state.qRaw || '') + '" data-odx="q" aria-label="Filter orders">' +
        (channels.length
          ? '<select class="odx-sel" data-odx="channel" aria-label="Channel">' +
              '<option value="all">All channels</option>' +
              channels.map(function (c) {
                return '<option value="' + esc(c) + '"' + (state.channel === c ? ' selected' : '') +
                  '>' + esc(c) + ' (' + byChannel[c] + ')</option>';
              }).join('') +
            '</select>'
          : '') +
        '<span class="odx-showing">' + visible.length + ' of ' + orders.length + ' shown</span>' +
      '</div>' +

      /* ── TABLE ───────────────────────────────────────────────────────────── */
      (visible.length
        ? '<div class="odx-tw"><table class="odx-t"><thead><tr>' +
            '<th>Order</th><th>Customer</th><th>Status</th><th>Payment</th>' +
            '<th>Fulfilment</th><th class="odx-r">Value</th><th>Placed</th><th></th>' +
          '</tr></thead><tbody>' +
          visible.map(function (o) {
            var id = orderNo(o);
            var b = buyerOf(o);
            var p = payment(o);
            var f = fulfilment(o);
            var m = money(o);
            var s = statusOf(o);
            var ch = pick(o, CHANNEL);
            var d = when(o.createdAt), t = clock(o.createdAt);
            return '<tr' + (state.open === id ? ' class="is-open"' : '') + ' data-odx="open" data-id="' + esc(id) + '">' +
              '<td><div class="odx-id">#' + esc(id.slice(0, 10)) + '</div>' +
                /* Shown verbatim. Never mapped onto a storefront this platform lacks. */
                '<small>' + (ch ? esc(String(ch.value)) : 'channel not recorded') + '</small></td>' +
              '<td><div class="odx-c">' +
                '<span class="odx-av odx-av--' + tone(o) + '">' + esc(initials(o)) + '</span>' +
                '<div><div class="odx-c-n' + (b.named ? '' : ' odx-c-n--derived') + '">' + esc(b.text) + '</div>' +
                (b.sub ? '<div class="odx-c-s">' + esc(b.sub) + '</div>' : '') +
              '</div></div></td>' +
              '<td><span class="odx-st odx-st--' + statusTone(s) + '">' + esc(prettyStatus(s)) + '</span></td>' +
              '<td class="odx-dim">' +
                (p.method ? esc(p.method) : 'method not recorded') +
                (p.state ? '<small>' + esc(prettyStatus(String(p.state).toLowerCase())) + '</small>' : '') +
              '</td>' +
              '<td class="odx-dim">' +
                (f.delivered ? 'delivered ' + esc(f.delivered)
                  : f.track ? esc(f.track)
                  : f.rider ? 'rider assigned'
                  : f.type ? esc(f.type) : 'not dispatched') +
              '</td>' +
              /* An order with no recorded figure says so. It is not KES 0. */
              '<td class="odx-r' + (m ? '' : ' odx-dim') + '">' +
                (m ? esc(fmtMoney(m)) + (m.field !== 'total' ? '<small>' + esc(m.field) + '</small>' : '')
                   : 'not recorded') +
              '</td>' +
              '<td class="odx-dim">' + (d ? esc(d) + (t ? '<small>' + esc(t) + '</small>' : '')
                                          : 'not recorded') + '</td>' +
              '<td class="odx-r"><button class="odx-btn sm" data-odx="open" data-id="' + esc(id) +
                '">View</button></td>' +
            '</tr>';
          }).join('') +
          '</tbody></table></div>'
        : '<div class="odx-none"><b>' +
            (orders.length ? 'No loaded order matches this filter' : 'No orders returned') +
          '</b><span>' + (orders.length ? 'Clear the filter or choose another status.'
            : 'This read returned an empty page.') + '</span></div>') +

      /* ── DETAIL ──────────────────────────────────────────────────────────── */
      (open ? detail(open, can) : '') +

      /* ── WHAT THIS DESK IS NOT ───────────────────────────────────────────── */
      '<div class="odx-note">' +
        '<b>About these numbers.</b> Every figure is <b>of the ' + orders.length +
        ' orders loaded</b> — this read is capped and returns rows, never counts, so there ' +
        'is no platform total and no status facet behind the tabs. There is no ' +
        'month-on-month change because no prior-period figure exists anywhere, and the ' +
        'value shown is <b>the sum of the loaded orders</b>, not revenue: revenue is a ' +
        'payments question and these are orders.' +
      '</div>' +
      '<div class="odx-note">' +
        '<b>What this platform does not record.</b> There is no card brand or last four ' +
        'digits — payment here is M-PESA and IntaSend, and a card logo would be an ' +
        'invention. There is no carrier and no signature: fulfilment is a SOKONI rider ' +
        'with a tracking code. Channels are shown exactly as written; this platform has ' +
        'no Amazon, eBay or TikTok Shop integration to map them onto. Orders are also ' +
        'written by more than one producer, so a value may be recorded as ' +
        '<code>total</code>, <code>amount</code> or <code>subtotal</code> — the field is ' +
        'named beside the figure whenever it is not <code>total</code>.' +
      '</div>' +
      '</div>';
  }

  /* ── DETAIL PANEL ─────────────────────────────────────────────────────────── */
  function detail (o, can) {
    var id = orderNo(o);
    var b = buyerOf(o);
    var p = payment(o);
    var f = fulfilment(o);
    var m = money(o);
    var s = statusOf(o);
    var items = itemsOf(o);
    var seller = pick(o, SELLER_ID);

    var row = function (k, v, dim) {
      return '<div class="odx-row"><span>' + esc(k) + '</span><b' + (dim ? ' class="odx-dim"' : '') +
        '>' + v + '</b></div>';
    };
    var said = function (v, absent) { return v ? esc(String(v)) : '<i>' + esc(absent) + '</i>'; };

    /* Only the money fields actually present are listed. A zero is never printed for a
       line the writer did not record. */
    var lines = '';
    ['subtotal', 'shipping', 'deliveryFee', 'tax', 'discount'].forEach(function (k) {
      var v = o[k];
      if (typeof v === 'number' && isFinite(v)) {
        lines += row(k, esc(fmtMoney({ amount: v, currency: o.currency || 'KES' })));
      }
    });

    return '<div class="odx-detail">' +
      '<div class="odx-d-head">' +
        '<div><h3>Order #' + esc(id.slice(0, 12)) + '</h3>' +
          '<span class="odx-st odx-st--' + statusTone(s) + '">' + esc(prettyStatus(s)) + '</span></div>' +
        '<button class="odx-btn ghost" data-odx="close">Close</button>' +
      '</div>' +

      '<div class="odx-d-grid">' +
        '<section><h4>Summary</h4>' +
          lines +
          row('Recorded value', m ? esc(fmtMoney(m)) : '<i>not recorded</i>') +
          (m && m.field !== 'total'
            ? '<div class="odx-hint">This order records its value as <code>' + esc(m.field) +
              '</code>, not <code>total</code> — one of several order shapes in this ' +
              'collection.</div>' : '') +
          row('Placed', said(when(o.createdAt), 'not recorded')) +
        '</section>' +

        '<section><h4>Customer</h4>' +
          row('Name', b.named ? esc(b.text) : '<i>no name on the order</i>') +
          row('Contact', said(b.sub, 'not recorded')) +
          /* The account identifier is shown even when there is no name, because "not
             recorded" twice would hide the one thing this order does establish about the
             buyer — and it names the FIELD, since the writers disagree on the spelling. */
          (function () {
            var i = pick(o, BUYER_ID);
            return row('Account', i
              ? '<code>' + esc(String(i.value)) + '</code>' +
                (i.key !== 'buyerId' ? '<small>' + esc(i.key) + '</small>' : '')
              : '<i>no buyer recorded</i>');
          }()) +
          row('Seller', seller ? esc(String(seller.value)) + (seller.key !== 'sellerUid'
              ? '<small>' + esc(seller.key) + '</small>' : '') : '<i>not recorded</i>') +
        '</section>' +

        '<section><h4>Payment</h4>' +
          row('Method', said(p.method, 'not recorded')) +
          row('State', p.state ? esc(prettyStatus(String(p.state).toLowerCase())) : '<i>not recorded</i>') +
          row('Paid on', said(p.paidAt, 'no payment date recorded')) +
          row('Reference', p.ref ? '<code>' + esc(p.ref) + '</code>' + (p.refField
              ? '<small>' + esc(p.refField) + '</small>' : '') : '<i>not recorded</i>') +
          /* Absent is unknown. An order whose writer never set the flag is not "unverified". */
          row('Verified', p.verifiedKnown ? (p.verified ? 'yes' : 'no')
                                          : '<i>this writer records no verification flag</i>') +
        '</section>' +

        '<section><h4>Fulfilment</h4>' +
          row('Type', said(f.type, 'not recorded')) +
          row('Tracking', f.track ? '<code>' + esc(f.track) + '</code>' : '<i>no tracking code</i>') +
          row('Rider', said(f.rider, 'none assigned')) +
          row('Delivered', said(f.delivered, 'not delivered')) +
          '<div class="odx-hint">No carrier and no signature: this platform delivers with ' +
            'its own riders and records a tracking code, not a courier consignment.</div>' +
        '</section>' +
      '</div>' +

      '<section class="odx-items"><h4>Items' + (items ? ' (' + items.length + ')' : '') + '</h4>' +
        (items && items.length
          ? items.map(function (i) {
              var q = i.quantity != null ? i.quantity : i.qty;
              var up = typeof i.unitPrice === 'number' ? i.unitPrice
                     : (typeof i.price === 'number' ? i.price : null);
              return '<div class="odx-item">' +
                '<div><b>' + esc(i.name || i.title || i.productName || 'Unnamed line') + '</b>' +
                (i.productId || i.id ? '<small>' + esc(String(i.productId || i.id)) + '</small>' : '') +
                '</div>' +
                '<span class="odx-dim">' + (q != null ? '× ' + esc(q) : '<i>qty not recorded</i>') + '</span>' +
                '<span>' + (up != null ? esc(fmtMoney({ amount: up, currency: o.currency || 'KES' }))
                                       : '<i class="odx-dim">no unit price</i>') + '</span>' +
              '</div>';
            }).join('')
          : '<div class="odx-hint">This order records no line items.</div>') +
      '</section>' +

      '<div class="odx-actions">' +
        (can.status
          ? '<button class="odx-btn" data-odx="advance" data-id="' + esc(id) + '">Change status…</button>'
          : '') +
        /* Deliberately no refund control — see the header. */
        '<span class="odx-hint">A status change is written by <code>adminUpdateOrderStatus</code> ' +
          'and audited. There is no refund button here: on this platform a refund request ' +
          'document credits a wallet on creation, so it is owner-approved, never a ' +
          'one-click admin action.</span>' +
      '</div>' +
    '</div>';
  }

  function mount (opts) {
    var o = opts || {};
    var host = o.host;
    if (!host || !Array.isArray(o.orders)) return false;
    injectCss();

    var A0 = o.actions || {};
    var state = {
      orders: o.orders, q: '', qRaw: '', status: 'all', channel: 'all', open: null,
      can: { status: !!A0.updateStatus },
    };
    var draw = function () { render(host, state); };
    draw();

    if (host.__odxOff) { try { host.__odxOff(); } catch (_) {} }
    var bound = [];
    var on = function (type, fn) { host.addEventListener(type, fn); bound.push([type, fn]); };
    host.__odxOff = function () {
      for (var i = 0; i < bound.length; i++) host.removeEventListener(bound[i][0], bound[i][1]);
      bound = [];
    };

    on('click', function (ev) {
      var b = ev.target.closest && ev.target.closest('[data-odx]');
      if (!b) return;
      var k = b.getAttribute('data-odx');
      if (k === 'status') { state.status = b.getAttribute('data-v'); state.open = null; return draw(); }
      if (k === 'open')   { state.open = b.getAttribute('data-id'); return draw(); }
      if (k === 'close')  { state.open = null; return draw(); }
      if (k === 'advance' && A0.updateStatus) return A0.updateStatus(b.getAttribute('data-id'));
    });

    on('change', function (ev) {
      var el = ev.target;
      var k = el.getAttribute && el.getAttribute('data-odx');
      if (k === 'channel') { state.channel = el.value; return draw(); }
    });

    var t = null;
    on('input', function (ev) {
      var el = ev.target;
      if (!el.getAttribute || el.getAttribute('data-odx') !== 'q') return;
      var v = el.value;
      clearTimeout(t);
      t = setTimeout(function () {
        state.qRaw = v; state.q = String(v || '').trim().toLowerCase();
        draw();
        var again = host.querySelector('[data-odx="q"]');
        if (again) { again.focus(); try { again.setSelectionRange(v.length, v.length); } catch (_) {} }
      }, 180);
    });
    return true;
  }

  function injectCss () {
    if (document.getElementById(CSS_ID)) return;
    var l = document.createElement('link');
    l.id = CSS_ID; l.rel = 'stylesheet'; l.href = 'sokoni-aos-orders.css';
    document.head.appendChild(l);
  }

  var api = {
    mount: mount, _render: render, _money: money, _buyerOf: buyerOf,
    _statusTone: statusTone, _fulfilment: fulfilment, _payment: payment, _pick: pick,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SokoniAOSOrders = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
