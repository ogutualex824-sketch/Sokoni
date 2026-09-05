/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — MERCHANT V2 · SUPPLY WORKSPACE  (Slice J1)
   ══════════════════════════════════════════════════════════════════════════════
   Supply is a SEPARATE operational system from Sales. Sales is selling to your
   customers; Supply is acquiring, receiving, storing and supplying stock between
   businesses. This module is the merchant-facing surface over the canonical
   procurement engine certified in Slices A-I.

   WHAT THIS MODULE MAY DISPLAY
   Every figure on this surface comes from an authoritative, merchant-scoped API.
   There is no local computation over listing prices, no multiplier, no seeded
   sample, and no fallback catalogue. Where a capability has no authoritative
   backing yet, the section says so plainly instead of rendering something
   plausible — the failure mode this codebase has already paid for twice, in
   pos-bi.html's mock* fallbacks and sokoni-b2b.js's 37 invented businesses.

   THREE SECTIONS ARE DELIBERATELY UNAVAILABLE
     Find Suppliers      — discovery has no backing query, and participation in
                           supply is NOT the same as consent to appear in a
                           public directory. That is a visibility decision, not a
                           missing SELECT.
     Supply Catalogue    — a real wholesale engine exists (b2b-wholesale.js) but
                           its client is the fabricated catalogue. Reusing that
                           here would reproduce the exact defect it is tracked as.
     Time-ordered views  — the read layer orders by document id on purpose; a
                           createdAt ordering would silently EXCLUDE documents
                           missing that field and needs composite indexes nobody
                           has authorised.

   BUSINESS IDENTITY IS NOT NEGOTIABLE
   Every read is scoped by the merchantId that SokoniShell.merchantContext()
   resolved from the server. This module never falls back to activeShopId (a
   different identifier space), never reads localStorage for identity, and never
   picks a business for an owner who has more than one. An ambiguous owner gets a
   selection state and NO data — showing the wrong business's spend, stock and
   payables is worse than showing nothing.

   NO WRITES. This surface reads. Approving, sending, receiving and paying are
   authority-bearing actions with their own certified gates; a later slice wires
   them deliberately rather than as a side effect of building a dashboard.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  /* ── The sections, and what each is allowed to claim ─────────────────────── */
  var NAV = [
    { group: 'Overview', items: [
      { id: 'overview', name: 'Overview', icon: '📊', backed: true },
    ] },
    { group: 'Buy', items: [
      { id: 'suppliers', name: 'Suppliers',       icon: '🏭', backed: true },
      { id: 'pos',       name: 'Purchase Orders', icon: '📄', backed: true },
      { id: 'incoming',  name: 'Incoming Orders', icon: '📥', backed: true },
      { id: 'receiving', name: 'Receiving / GRN', icon: '📦', backed: true },
      { id: 'invoices',  name: 'Invoices',        icon: '🧾', backed: true },
      { id: 'payments',  name: 'Payments',        icon: '💳', backed: true },
      { id: 'find',      name: 'Find Suppliers',  icon: '🔍', backed: false,
        why: 'Supplier discovery needs its own backing slice. A business opting into supply ' +
             'has not thereby agreed to appear in a public directory, so this is a visibility ' +
             'decision as much as a missing query. Nothing is shown rather than a guess.' },
      { id: 'catalogue', name: 'Supply Catalogue', icon: '🗂️', backed: false,
        why: 'The wholesale engine exists but has no authoritative client yet. The existing ' +
             'B2B catalogue is fabricated sample data and is deliberately not reused here.' },
    ] },
    { group: 'My Supply', items: [
      { id: 'mysupply',    name: 'Products I Supply', icon: '🏷️', backed: true },
      { id: 'bizorders',   name: 'Business Orders',   icon: '📬', backed: true },
      { id: 'performance', name: 'Supply Performance', icon: '⭐', backed: true },
    ] },
    { group: 'Warehouse', items: [
      { id: 'stock',     name: 'Stock',           icon: '🏬', backed: true },
      { id: 'movements', name: 'Stock Movements', icon: '🔁', backed: true },
    ] },
    { group: 'Analytics', items: [
      { id: 'procurement', name: 'Procurement', icon: '📈', backed: true },
      { id: 'spend',       name: 'Spend',       icon: '💰', backed: true },
      { id: 'forecast',    name: 'Forecast',    icon: '🔮', backed: true },
    ] },
    { group: 'Drafts', items: [
      { id: 'queue', name: 'Offline Queue', icon: '📋', backed: true },
    ] },
  ];

  var UNAVAILABLE = {};
  NAV.forEach(function (g) { g.items.forEach(function (i) { if (!i.backed) UNAVAILABLE[i.id] = i.why; }); });

  var NEUTRAL = '—';

  function esc (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* A money figure is rendered ONLY from a real number. An absent value is the
     neutral dash, never 0 — an unknown shown as zero is an invented fact. */
  function money (n) {
    if (typeof n !== 'number' || !isFinite(n)) return NEUTRAL;
    return 'KES ' + Math.round(n).toLocaleString('en-KE');
  }
  function count (n) {
    if (typeof n !== 'number' || !isFinite(n)) return NEUTRAL;
    return n.toLocaleString('en-KE');
  }
  function text (v) { return (v === null || v === undefined || v === '') ? NEUTRAL : esc(v); }

  function stateBlock (icon, title, detail, tone) {
    return '<div class="state" data-supply-state="' + esc(tone || 'info') + '">' +
             '<span class="ico">' + esc(icon) + '</span>' +
             '<b>' + esc(title) + '</b>' +
             '<small>' + esc(detail) + '</small>' +
           '</div>';
  }

  /* ── CSS. Scoped to the module root so it cannot leak into the shell. ────── */
  var CSS = [
    '.sup{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--txt);font-size:14px}',
    '.sup-head{padding:14px 16px 10px;border-bottom:1px solid var(--line);flex:0 0 auto}',
    '.sup-title{font-size:19px;font-weight:900;letter-spacing:-.02em;display:flex;align-items:center;gap:8px}',
    '.sup-biz{font-size:12.5px;color:var(--txt2);margin-top:3px}',
    '.sup-biz b{color:var(--txt);font-weight:700}',
    '.sup-body{flex:1 1 auto;min-height:0;display:flex;overflow:hidden}',
    '.sup-nav{flex:0 0 208px;overflow-y:auto;border-right:1px solid var(--line);padding:10px 8px 24px}',
    '.sup-grp{font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--txt3);',
      'font-weight:800;padding:12px 10px 5px}',
    '.sup-link{display:flex;align-items:center;gap:9px;width:100%;border:0;background:transparent;',
      'color:var(--txt2);font:inherit;font-size:13.5px;text-align:left;padding:9px 10px;border-radius:9px;cursor:pointer}',
    '.sup-link:hover{background:var(--surface-2);color:var(--txt)}',
    '.sup-link[aria-current="true"]{background:var(--acc-dim);color:var(--txt);font-weight:700;',
      'box-shadow:inset 0 0 0 1px var(--acc-line)}',
    '.sup-link .ic{width:19px;text-align:center;flex:0 0 auto}',
    '.sup-link .tag{margin-left:auto;font-size:9.5px;letter-spacing:.05em;text-transform:uppercase;',
      'color:var(--txt3);border:1px solid var(--line);border-radius:999px;padding:2px 6px;font-weight:800}',
    '.sup-main{flex:1 1 auto;min-width:0;overflow-y:auto;padding:16px}',
    '.sup-h2{font-size:15.5px;font-weight:800;margin:0 0 3px}',
    '.sup-sub{font-size:12.5px;color:var(--txt2);margin:0 0 14px}',
    '.sup-tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:10px;margin-bottom:16px}',
    '.sup-tile{background:var(--surface-2);border:1px solid var(--line);border-radius:12px;padding:12px 13px}',
    '.sup-tile .k{font-size:11px;color:var(--txt2);font-weight:700;letter-spacing:.02em}',
    '.sup-tile .v{font-size:20px;font-weight:900;letter-spacing:-.02em;margin-top:5px}',
    '.sup-tile .s{font-size:11px;color:var(--txt3);margin-top:2px}',
    '.sup-tbl-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:12px}',
    '.sup-tbl{width:100%;border-collapse:collapse;font-size:13px;min-width:520px}',
    '.sup-tbl th{text-align:left;font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;',
      'color:var(--txt3);font-weight:800;padding:9px 12px;border-bottom:1px solid var(--line);white-space:nowrap}',
    '.sup-tbl td{padding:10px 12px;border-bottom:1px solid var(--line);color:var(--txt2);white-space:nowrap}',
    '.sup-tbl tr:last-child td{border-bottom:0}',
    '.sup-tbl td.strong{color:var(--txt);font-weight:700}',
    '.sup-more{display:flex;justify-content:center;padding:12px}',
    '.sup-btn{border:1px solid var(--line);background:var(--surface-2);color:var(--txt);font:inherit;',
      'font-size:13px;font-weight:700;padding:9px 15px;border-radius:10px;cursor:pointer}',
    '.sup-btn:hover{border-color:var(--acc-line)}',
    '.sup-note{font-size:11.5px;color:var(--txt3);margin-top:10px;line-height:1.5}',
    '.sup-choice{display:flex;flex-direction:column;gap:8px;max-width:420px;margin:14px auto 0;text-align:left}',
    '.sup-choice button{border:1px solid var(--line);background:var(--surface-2);color:var(--txt);',
      'font:inherit;font-size:13.5px;font-weight:700;padding:12px 14px;border-radius:11px;cursor:pointer;text-align:left}',
    '.sup-choice button:hover{border-color:var(--acc-line)}',
    '.sup-choice small{display:block;font-weight:500;color:var(--txt3);margin-top:3px;font-size:11.5px}',
    /* Phone: the rail becomes a horizontal scroller so no destination is lost. */
    '@media(max-width:760px){',
      '.sup-body{flex-direction:column}',
      '.sup-nav{flex:0 0 auto;display:flex;gap:6px;overflow-x:auto;overflow-y:hidden;',
        'border-right:0;border-bottom:1px solid var(--line);padding:8px 10px;white-space:nowrap}',
      '.sup-grp{display:none}',
      '.sup-link{width:auto;flex:0 0 auto;padding:8px 12px}',
      '.sup-link .tag{display:none}',
      '.sup-main{padding:13px}',
      '.sup-tiles{grid-template-columns:repeat(auto-fill,minmax(140px,1fr))}',
    '}',
  ].join('');

  function injectCss (doc) {
    if (doc.getElementById('sup-css')) return;
    var st = doc.createElement('style');
    st.id = 'sup-css';
    st.textContent = CSS;
    doc.head.appendChild(st);
  }

  /* ══════════════════════════════════════════════════════════════════════════
     MOUNT
  ══════════════════════════════════════════════════════════════════════════ */
  function mount (host, ctx) {
    var c = ctx || {};
    var doc = host.ownerDocument || global.document;
    injectCss(doc);

    var state = {
      section: 'overview',
      merchantId: null,
      merchantName: null,
      choices: [],
      identityError: null,
      cache: {},      /* section -> { items, nextCursor, error } */
      destroyed: false,
    };

    /* The ONE way this module learns which business it is looking at. */
    function readContext () {
      var mc = null;
      try { mc = typeof c.merchantContext === 'function' ? c.merchantContext() : null; } catch (_) { mc = null; }
      if (!mc && global.SokoniShell && typeof global.SokoniShell.merchantContext === 'function') {
        try { mc = global.SokoniShell.merchantContext(); } catch (_) { mc = null; }
      }
      if (!mc) { state.merchantId = null; state.identityError = 'context-unavailable'; state.choices = []; return; }
      state.merchantId   = mc.merchantId || null;
      state.merchantName = mc.name || null;
      state.choices      = Array.isArray(mc.choices) ? mc.choices : [];
      state.identityError = mc.merchantId ? null : (mc.error || 'unresolved');
    }

    function callable (name) {
      if (typeof c.callable === 'function') return c.callable(name);
      return null;
    }

    /* Every read goes through here, so no section can invent its own data path. */
    async function read (name, payload) {
      var fn = callable(name);
      if (!fn) throw new Error('unavailable');
      if (!state.merchantId) throw new Error('no-merchant');
      var res = await fn(Object.assign({ merchantId: state.merchantId }, payload || {}));
      var d = (res && res.data) ? res.data : res;
      if (!d || typeof d !== 'object') throw new Error('malformed');
      return d;
    }

    /* ── rendering ───────────────────────────────────────────────────────── */
    function navHtml () {
      return NAV.map(function (g) {
        return '<div class="sup-grp">' + esc(g.group) + '</div>' +
          g.items.map(function (i) {
            return '<button class="sup-link" type="button" data-sec="' + esc(i.id) + '"' +
              (state.section === i.id ? ' aria-current="true"' : '') + '>' +
              '<span class="ic" aria-hidden="true">' + esc(i.icon) + '</span>' +
              '<span>' + esc(i.name) + '</span>' +
              (i.backed ? '' : '<span class="tag">soon</span>') +
              '</button>';
          }).join('');
      }).join('');
    }

    function shell (inner) {
      var who = state.merchantId
        ? 'Business <b>' + esc(state.merchantName || state.merchantId) + '</b>'
        : 'No business selected';
      return '<div class="sup">' +
        '<div class="sup-head">' +
          '<div class="sup-title">📦 Supply</div>' +
          '<div class="sup-biz">' + who + ' · buying, receiving, warehousing and supplying between businesses</div>' +
        '</div>' +
        '<div class="sup-body">' +
          '<nav class="sup-nav" aria-label="Supply sections">' + navHtml() + '</nav>' +
          '<div class="sup-main" id="sup-main">' + inner + '</div>' +
        '</div>' +
      '</div>';
    }

    /* An unresolved business STOPS the workspace. It does not degrade into
       another business's data, and it does not render zeroes. */
    function identityBlock () {
      if (state.identityError === 'owner-has-multiple-businesses' && state.choices.length) {
        return stateBlock('🏢', 'Choose a business',
          'This account owns more than one business. Supply data belongs to exactly one of ' +
          'them, so nothing is shown until you pick — the alternative is showing you another ' +
          'business’s spend, stock and payables.', 'choose') +
          '<div class="sup-choice">' + state.choices.map(function (ch) {
            return '<button type="button" data-choose="' + esc(ch.businessId) + '">' +
              esc(ch.name || ch.businessId) +
              '<small>' + esc(ch.businessId) + (ch.supplyEnabled ? ' · supplies other businesses' : '') + '</small>' +
              '</button>';
          }).join('') + '</div>';
      }
      if (state.identityError === 'no-business-for-owner') {
        return stateBlock('🏢', 'No business on this account',
          'Supply works against a business record. This account has none yet, so there is ' +
          'nothing to show.', 'none');
      }
      return stateBlock('🏢', 'Business not resolved',
        'The active business could not be resolved (' + text(state.identityError) + '), so no ' +
        'Supply data is shown. Nothing here falls back to another identifier.', 'error');
    }

    function tiles (rows) {
      return '<div class="sup-tiles">' + rows.map(function (r) {
        return '<div class="sup-tile"><div class="k">' + esc(r.k) + '</div>' +
          '<div class="v">' + r.v + '</div>' +
          (r.s ? '<div class="s">' + esc(r.s) + '</div>' : '') + '</div>';
      }).join('') + '</div>';
    }

    function table (cols, rows, cursor) {
      if (!rows.length) return '';
      return '<div class="sup-tbl-wrap"><table class="sup-tbl"><thead><tr>' +
        cols.map(function (col) { return '<th>' + esc(col.h) + '</th>'; }).join('') +
        '</tr></thead><tbody>' +
        rows.map(function (r) {
          return '<tr>' + cols.map(function (col) {
            return '<td' + (col.strong ? ' class="strong"' : '') + '>' + col.f(r) + '</td>';
          }).join('') + '</tr>';
        }).join('') +
        '</tbody></table>' +
        (cursor ? '<div class="sup-more"><button class="sup-btn" type="button" data-more="1">Load more</button></div>' : '') +
        '</div>';
    }

    var LIST_SECTIONS = {
      suppliers: { op: 'listSuppliers', title: 'Suppliers',
        sub: 'Businesses you buy from — SOKONI counterparties and external suppliers alike.',
        empty: 'No suppliers recorded for this business yet.',
        cols: [
          { h: 'Supplier', strong: true, f: function (r) { return text(r.name); } },
          { h: 'Type',   f: function (r) { return r.isSokoniBusiness ? 'SOKONI business' : 'External'; } },
          { h: 'Phone',  f: function (r) { return text(r.phone); } },
          { h: 'Terms',  f: function (r) { return r.paymentTerms ? esc(r.paymentTerms) + ' days' : NEUTRAL; } },
          { h: 'Balance', f: function (r) { return money(r.currentBalance); } },
          { h: 'Status', f: function (r) { return text(r.status); } },
        ] },
      pos: { op: 'listPurchaseOrders', title: 'Purchase Orders',
        sub: 'Orders you have raised. Approval and sending happen through their own authorised actions.',
        empty: 'No purchase orders yet.',
        cols: [
          { h: 'PO', strong: true, f: function (r) { return text(r.poNumber); } },
          { h: 'Supplier', f: function (r) { return text(r.supplierName); } },
          { h: 'Status',   f: function (r) { return text(r.status); } },
          { h: 'Items',    f: function (r) { return count(r.itemCount); } },
          { h: 'Total',    f: function (r) { return money(r.total); } },
        ] },
      incoming: { op: 'getInboundSupplyOrders', title: 'Incoming Orders',
        sub: 'Orders other businesses have placed WITH you. Supplier-side authority, separate from your buying.',
        empty: 'No business has placed a supply order with you yet.',
        supplierSide: true,
        cols: [
          { h: 'PO', strong: true, f: function (r) { return text(r.poNumber); } },
          { h: 'Buyer',  f: function (r) { return text(r.buyerBusinessId); } },
          { h: 'Status', f: function (r) { return text(r.status); } },
          { h: 'Total',  f: function (r) { return money(r.total); } },
        ] },
      receiving: { op: 'listGRNs', title: 'Receiving / GRN',
        sub: 'Goods received notes. Receipt is the canonical event that moves warehouse stock.',
        empty: 'Nothing received yet.',
        cols: [
          { h: 'GRN', strong: true, f: function (r) { return text(r.grnId); } },
          { h: 'PO',       f: function (r) { return text(r.poId); } },
          { h: 'Branch',   f: function (r) { return text(r.branchId); } },
          { h: 'Received', f: function (r) { return count(r.totalReceived); } },
          { h: 'Discrepancies', f: function (r) { return count(r.discrepancyCount); } },
        ] },
      invoices: { op: 'listSupplierInvoices', title: 'Invoices',
        sub: 'Supplier invoices raised against your orders.',
        empty: 'No supplier invoices yet.',
        cols: [
          { h: 'Invoice', strong: true, f: function (r) { return text(r.invoiceNumber); } },
          { h: 'PO',     f: function (r) { return text(r.poId); } },
          { h: 'Total',  f: function (r) { return money(r.total); } },
          { h: 'Status', f: function (r) { return text(r.status); } },
          { h: 'Due',    f: function (r) { return text(r.dueDate); } },
        ] },
      payments: { op: 'listSupplierInvoices', title: 'Payments',
        sub: 'Invoices recorded as paid. This is a BOOKKEEPING record — it does not itself move money.',
        empty: 'No payments recorded yet.',
        query: { status: 'paid' },
        cols: [
          { h: 'Invoice', strong: true, f: function (r) { return text(r.invoiceNumber); } },
          { h: 'Total',  f: function (r) { return money(r.total); } },
          { h: 'Method', f: function (r) { return text(r.paymentMethod); } },
          { h: 'Recorded', f: function (r) { return r.paidAt ? 'Yes' : NEUTRAL; } },
        ],
        note: 'Recording a payment writes the ledger and the supplier balance. Settlement over ' +
              'M-Pesa, bank or wallet is a separate capability that does not exist yet, so ' +
              'nothing here should be read as funds having moved.' },
      mysupply: { op: 'listWarehouseStock', title: 'Products I Supply',
        sub: 'What this business holds and can offer other businesses.',
        empty: 'No stock recorded for this business yet.',
        cols: [
          { h: 'Product', strong: true, f: function (r) { return text(r.name || r.productId); } },
          { h: 'Branch', f: function (r) { return text(r.branchId); } },
          { h: 'Stock',  f: function (r) { return count(r.stockQty); } },
          { h: 'Cost',   f: function (r) { return money(r.costPrice); } },
        ],
        note: 'Wholesale pricing and public listing need the B2B authority slice; this shows ' +
              'holdings only, not an offer.' },
      bizorders: { op: 'getInboundSupplyOrders', title: 'Business Orders',
        sub: 'Orders to fulfil for other SOKONI businesses.',
        empty: 'No business orders to fulfil.',
        supplierSide: true,
        cols: [
          { h: 'PO', strong: true, f: function (r) { return text(r.poNumber); } },
          { h: 'Buyer',  f: function (r) { return text(r.buyerBusinessId); } },
          { h: 'Status', f: function (r) { return text(r.status); } },
          { h: 'Total',  f: function (r) { return money(r.total); } },
        ] },
      stock: { op: 'listWarehouseStock', title: 'Warehouse Stock',
        sub: 'Holdings by branch. Updated only by an authoritative receipt.',
        empty: 'No warehouse stock recorded yet.',
        cols: [
          { h: 'Product', strong: true, f: function (r) { return text(r.name || r.productId); } },
          { h: 'Branch',  f: function (r) { return text(r.branchId); } },
          { h: 'Stock',   f: function (r) { return count(r.stockQty); } },
          { h: 'Reorder at', f: function (r) { return count(r.reorderPoint); } },
        ] },
      movements: { op: 'listStockMovements', title: 'Stock Movements',
        sub: 'Every recorded stock change, with the receipt that caused it.',
        empty: 'No stock movements recorded yet.',
        cols: [
          { h: 'Type', strong: true, f: function (r) { return text(r.type); } },
          { h: 'Product', f: function (r) { return text(r.productId); } },
          { h: 'Qty',     f: function (r) { return count(r.qty); } },
          { h: 'Ref',     f: function (r) { return text(r.refId); } },
        ],
        note: 'Ordered by record id, not by time. Chronological views need an index decision ' +
              'that has not been made, and ordering by a timestamp would silently drop older ' +
              'records that do not carry one.' },
    };

    function renderList (def, data) {
      var rows = (data && (data.items || data.orders)) || [];
      var head = '<h2 class="sup-h2">' + esc(def.title) + '</h2><p class="sup-sub">' + esc(def.sub) + '</p>';
      if (!rows.length) {
        return head + stateBlock('📭', def.empty,
          'Nothing has been recorded for this business. This is a real, empty result from the ' +
          'server — not a placeholder.', 'empty') +
          (def.note ? '<p class="sup-note">' + esc(def.note) + '</p>' : '');
      }
      return head + table(def.cols, rows, data.nextCursor) +
        (def.note ? '<p class="sup-note">' + esc(def.note) + '</p>' : '');
    }

    function renderOverview (d) {
      if (!d) return '';
      var head = '<h2 class="sup-h2">Overview</h2>' +
        '<p class="sup-sub">Live procurement position for this business.</p>';
      return head + tiles([
        { k: 'Open purchase orders', v: count(d.openPOs && d.openPOs.count), s: money(d.openPOs && d.openPOs.totalValue) },
        { k: 'Pending approval',     v: count(d.pendingApproval && d.pendingApproval.count) },
        { k: 'Goods to receive',     v: count(d.goodsToReceive && d.goodsToReceive.count) },
        { k: 'Pending invoices',     v: count(d.pendingInvoices && d.pendingInvoices.count), s: money(d.pendingInvoices && d.pendingInvoices.totalValue) },
        { k: 'Overdue invoices',     v: count(d.overdueInvoices && d.overdueInvoices.count) },
      ]) + '<p class="sup-note">Every figure is read from the procurement engine for this ' +
           'business. A dash means the server did not report that figure — never zero standing ' +
           'in for unknown.</p>';
    }

    function renderUnavailable (id) {
      var item = null;
      NAV.forEach(function (g) { g.items.forEach(function (i) { if (i.id === id) item = i; }); });
      return '<h2 class="sup-h2">' + esc(item ? item.name : id) + '</h2>' +
        stateBlock('🚧', 'Not available yet', UNAVAILABLE[id] || 'This section has no authoritative backing yet.', 'unavailable') +
        '<p class="sup-note">Nothing is displayed here because there is no authoritative source ' +
        'to display. Sample or illustrative data would be indistinguishable from real supplier ' +
        'listings and prices, which is precisely the defect this workspace avoids.</p>';
    }

    /* ── section loading ─────────────────────────────────────────────────── */
    async function loadSection (id, opts) {
      var main = doc.getElementById('sup-main');
      if (!main) return;

      if (UNAVAILABLE[id]) { main.innerHTML = renderUnavailable(id); return; }
      if (!state.merchantId) { main.innerHTML = identityBlock(); return; }

      main.innerHTML = stateBlock('⏳', 'Loading', 'Reading from the procurement engine.', 'loading');

      try {
        if (id === 'overview' || id === 'procurement' || id === 'spend') {
          var d = await read('getProcurementDashboard');
          main.innerHTML = renderOverview(d);
          return;
        }
        if (id === 'forecast') {
          var f = await read('getProcurementForecast');
          var items = (f && f.items) || [];
          main.innerHTML = '<h2 class="sup-h2">Forecast</h2>' +
            '<p class="sup-sub">Reorder projection from recorded consumption.</p>' +
            (items.length
              ? table([
                  { h: 'Product', strong: true, f: function (r) { return text(r.productId); } },
                  { h: 'Reorder point', f: function (r) { return count(r.reorderPoint); } },
                  { h: 'Reorder qty',   f: function (r) { return count(r.reorderQty); } },
                ], items, null)
              : stateBlock('📭', 'No forecast yet',
                  'A forecast needs recorded consumption history for this business.', 'empty'));
          return;
        }
        if (id === 'performance') {
          main.innerHTML = '<h2 class="sup-h2">Supply Performance</h2>' +
            '<p class="sup-sub">Per-supplier delivery and quality history.</p>' +
            stateBlock('📊', 'Choose a supplier',
              'Performance is reported per supplier. Open a supplier from the Suppliers list ' +
              'to see its history — no aggregate is shown, because none is computed server-side.',
              'choose');
          return;
        }
        if (id === 'queue') {
          var drafts = [];
          if (global.PosSuppliers && typeof global.PosSuppliers.reconcileLocalDrafts === 'function') {
            var out = await global.PosSuppliers.reconcileLocalDrafts();
            drafts = (out && out.records) || [];
          }
          main.innerHTML = '<h2 class="sup-h2">Offline Queue</h2>' +
            '<p class="sup-sub">Purchase orders composed on this device that have not reached the server.</p>' +
            (drafts.length
              ? table([
                  { h: 'Draft', strong: true, f: function (r) { return text(r.localId); } },
                  { h: 'State',  f: function (r) { return text(r.state); } },
                  { h: 'Reason', f: function (r) { return text(r.reason); } },
                ], drafts, null)
              : stateBlock('📭', 'Nothing queued',
                  'Every purchase order composed on this device has reached the server.', 'empty')) +
            '<p class="sup-note">A queued draft is submitted only by an explicit action, and never ' +
            'automatically. Drafts belonging to another business on this device are never submitted here.</p>';
          return;
        }

        var def = LIST_SECTIONS[id];
        if (!def) { main.innerHTML = stateBlock('❓', 'Unknown section', 'That section does not exist.', 'error'); return; }

        var payload = Object.assign({}, def.query || {});
        if (opts && opts.cursor) payload.cursor = opts.cursor;
        if (def.supplierSide) payload.supplierBusinessId = state.merchantId;

        var data = await read(def.op, payload);
        var prior = (opts && opts.cursor && state.cache[id]) ? state.cache[id] : null;
        if (prior) {
          var merged = (prior.items || []).concat(data.items || data.orders || []);
          data = { items: merged, nextCursor: data.nextCursor };
        }
        state.cache[id] = { items: data.items || data.orders || [], nextCursor: data.nextCursor || null };
        main.innerHTML = renderList(def, state.cache[id]);
      } catch (e) {
        /* A failed read shows the failure. It never falls back to sample rows, and it never
           renders zeroes that would read as a real, empty business. */
        main.innerHTML = stateBlock('⚠️', 'Could not load this section',
          'The server did not return this data (' + text((e && e.message) || 'error') + '). ' +
          'Nothing is shown rather than a guess. Try again.', 'error');
      }
    }

    /* ── events ──────────────────────────────────────────────────────────── */
    function onClick (ev) {
      var link = ev.target.closest && ev.target.closest('[data-sec]');
      if (link) {
        state.section = link.getAttribute('data-sec');
        host.querySelectorAll('[data-sec]').forEach(function (b) {
          b.setAttribute('aria-current', b === link ? 'true' : 'false');
        });
        loadSection(state.section);
        return;
      }
      var more = ev.target.closest && ev.target.closest('[data-more]');
      if (more) {
        var cur = state.cache[state.section];
        if (cur && cur.nextCursor) loadSection(state.section, { cursor: cur.nextCursor });
        return;
      }
      var choose = ev.target.closest && ev.target.closest('[data-choose]');
      if (choose) {
        var bid = choose.getAttribute('data-choose');
        var resolver = (typeof c.resolveMerchantContext === 'function')
          ? c.resolveMerchantContext
          : (global.SokoniShell && global.SokoniShell.resolveMerchantContext);
        if (typeof resolver !== 'function') return;
        Promise.resolve(resolver(bid)).then(function () {
          readContext();
          render();
        });
      }
    }

    function render () {
      readContext();
      host.innerHTML = shell(state.merchantId ? '' : identityBlock());
      if (state.merchantId) loadSection(state.section);
    }

    host.addEventListener('click', onClick);
    render();

    return {
      refresh: function () { state.cache = {}; render(); },
      destroy: function () {
        state.destroyed = true;
        try { host.removeEventListener('click', onClick); } catch (_) {}
        host.innerHTML = '';
      },
      /* Exposed for certification — never for display logic. */
      _state: state,
      _sections: NAV,
      _unavailable: UNAVAILABLE,
    };
  }

  global.SokoniMerchantSupply = { mount: mount, NAV: NAV, UNAVAILABLE: UNAVAILABLE };
})(typeof window !== 'undefined' ? window : this);
