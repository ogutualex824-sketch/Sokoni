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

   SUPPLY CATALOGUE IS NOW BACKED (Slice L)
     It reads procurement.getSupplyCatalogue: a supplier business resolved through
     businesses/{id}.ownerId, its own products carrying wholesalePrice > 0, and a
     positive field allowlist. It does NOT read the b2b-wholesale handler, which a
     trace found filtering on a field set on 0 of 108 production products and
     defaulting every missing minimum order to 10. A minimum order nobody set is a
     dash here. Reaching a catalogue needs supply.enabled, NOT discoverable — a
     business may supply a counterparty it already knows without being listed.

   FIND SUPPLIERS IS NOW BACKED (Slice M)
     It reads procurement.findSuppliers with narrowing equality facets and no free-text
     box — the server has no text search, and a box that filtered only the loaded page
     would misreport the network as smaller than it is. An empty directory says that no
     business is advertising Supply, because that is the truth: participation and listing
     are separate opt-ins and nobody has switched them on. It does NOT say "no suppliers
     found", which would read as a failed search.

   STILL DELIBERATELY UNAVAILABLE
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

   ONE WRITE, AND ONLY ONE (Slice M). Placing a purchase order from a supplier's catalogue
   is the single mutating action on this surface, and it happens only on an explicit click.
   It calls the canonical engine twice and constructs nothing of its own: addSupplier to
   establish the buyer-supplier relationship (idempotent for a SOKONI counterparty, so
   re-ordering never mints a duplicate), then createPurchaseOrder, which assigns the PO
   number and computes subtotal, VAT and total SERVER-SIDE under its own authority gate.
   The draft shown before submission is labelled an estimate and is never restated as a
   confirmed figure — after placement, every number displayed is the server's.

   Approving, sending, receiving and paying remain out. They are separate
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
      { id: 'find',      name: 'Find Suppliers',  icon: '🔍', backed: true },
      { id: 'catalogue', name: 'Supply Catalogue', icon: '🗂️', backed: true },
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
  /* How the server-reported total relates to VAT. The engine never infers VAT: it follows the
     supplier's own status (vatBasis), and when that is unknown the total EXCLUDES VAT. This
     only words the server's basis — it computes nothing. Absent basis = an older engine. */
  function vatPhrase (basis) {
    if (basis === 'unknown_supplier_status') return ' excluding VAT (VAT as stated on the supplier’s tax invoice)';
    if (basis === 'supplier_exempt')         return ' (VAT-exempt supply)';
    if (basis === 'supplier_zero_rated')     return ' (zero-rated supply, VAT 0%)';
    if (basis === 'supplier_registered')     return ' including VAT';
    return '';
  }

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
    '.sup-btn-sm{font-size:12px;padding:6px 11px;border-radius:9px}',
    '.sup-btn-ghost{background:transparent;color:var(--txt2)}',
    '.sup-btn-primary{background:var(--acc);border-color:var(--acc);color:#06121f}',
    '.sup-btn-primary:hover{filter:brightness(1.06)}',
    '.sup-btn[disabled]{opacity:.55;cursor:progress}',
    /* Discovery facets */
    '.sup-facets{display:flex;flex-wrap:wrap;gap:8px;margin:2px 0 14px}',
    '.sup-facet{border:1px solid var(--line);background:var(--surface-2);color:var(--txt);',
      'font:inherit;font-size:13px;padding:8px 11px;border-radius:10px;min-width:0;flex:1 1 130px}',
    '.sup-facet:focus{outline:none;border-color:var(--acc-line)}',
    '.sup-crumb{margin-bottom:8px}',
    /* Draft-order strip and footer */
    '.sup-orderbar{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:0 0 14px;',
      'padding:10px 13px;border:1px solid var(--acc-line);border-radius:12px;background:var(--surface-2);font-size:13px}',
    '.sup-orderbar .sup-est{color:var(--txt3);font-size:12px}',
    '.sup-orderbar button{margin-left:auto}',
    '.sup-orderfoot{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin-top:14px}',
    '.sup-est-big{font-size:15px;font-weight:800;color:var(--txt)}',
    '.sup-qty{width:88px;border:1px solid var(--line);background:var(--surface-2);color:var(--txt);',
      'font:inherit;font-size:13px;padding:6px 9px;border-radius:8px}',
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
      /* The supplier whose catalogue is open. Null means "my own catalogue" — the server
         defaults to the viewer's business, so the two cases share one code path. */
      supplier: null,
      /* A draft order being composed on this device. It is NOT a purchase order and is
         never presented as one: no poNumber, no server total, nothing is persisted until
         the buyer explicitly submits it through the canonical engine. */
      order: null,
      facets: { category: '', city: '', county: '' },
      submitting: false,
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
      find: { op: 'findSuppliers', title: 'Find Suppliers',
        sub: 'Businesses that have opted into supply AND into being listed. Two separate ' +
             'consents: a supplier may trade with you without appearing here.',
        /* The wording matters. "No suppliers found" reads as a failed search; this is not a
           failed search, it is an accurate report that nobody has opted in yet. */
        empty: 'No businesses are currently advertising Supply to your network.',
        facets: true,
        cols: [
          { h: 'Business', strong: true, f: function (r) { return text(r.name); } },
          { h: 'Category', f: function (r) { return text(r.category); } },
          { h: 'Town',     f: function (r) { return text(r.city); } },
          { h: 'County',   f: function (r) { return text(r.county); } },
          { h: 'Supplies', f: function (r) {
              var cats = r.supply && r.supply.categories;
              return (Array.isArray(cats) && cats.length) ? esc(cats.slice(0, 3).join(', ')) : NEUTRAL;
            } },
          { h: 'Min order', f: function (r) { return money(r.supply && r.supply.minOrderValue); } },
          { h: 'Lead time', f: function (r) {
              var d = r.supply && r.supply.leadDays;
              return (typeof d === 'number' && isFinite(d)) ? esc(String(d)) + ' days' : NEUTRAL;
            } },
          { h: '', f: function (r) {
              return '<button class="sup-btn sup-btn-sm" type="button" data-view-supply="' +
                esc(r.businessId) + '" data-supply-name="' + esc(r.name || r.businessId) +
                '">View supply</button>';
            } },
        ],
        note: 'Listing is not endorsement. SOKONI makes no vetting, verification or quality ' +
              'claim about a business shown here, and none of these figures is estimated — ' +
              'a dash means the supplier did not state that term.' },
      catalogue: { op: 'getSupplyCatalogue', title: 'Supply Catalogue',
        sub: 'Wholesale offers, resolved through canonical business identity. Opened without ' +
             'a supplier this is YOUR catalogue: what this business currently offers others.',
        empty: 'No wholesale offers published for this business yet.',
        cols: [
          { h: 'Product',   strong: true, f: function (r) { return text(r.name); } },
          { h: 'Category',  f: function (r) { return text(r.category); } },
          { h: 'Wholesale', f: function (r) { return money(r.wholesalePrice); } },
          /* A minimum order the supplier never set is a DASH. The catalogue this replaces
             defaulted it to 10 and presented that as a term of trade. */
          { h: 'Min order', f: function (r) { return count(r.minWholesaleQty); } },
          { h: 'Retail',    f: function (r) { return money(r.retailPrice); } },
          /* Three states, not two. Unknown availability is a dash, never 'Out of stock'. */
          { h: 'Available', f: function (r) {
              if (r.inStock === true)  return 'In stock';
              if (r.inStock === false) return 'Out of stock';
              return NEUTRAL;
            } },
          /* Only another business's catalogue is orderable. Your own catalogue is what you
             OFFER; an "add to order" there would mean buying from yourself. */
          { h: '', f: function (r) {
              if (!state.supplier) return '';
              return '<button class="sup-btn sup-btn-sm" type="button" data-add-line="' +
                esc(r.productId) + '">Add</button>';
            } },
        ],
        note: 'Every figure is a wholesale term the supplier published itself, read from the ' +
              'procurement engine. No saving or discount is computed here, no minimum order is ' +
              'assumed, exact stock levels are never exposed, and no supplier is vetted or ' +
              'endorsed by this surface.' },
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

    /* ── discovery facets ────────────────────────────────────────────────
       Narrowing filters only, matching the server's equality facets exactly. There is no
       free-text box: the server has no text search, and a box that silently filtered only
       the current page would misreport the network as smaller than it is. */
    function facetsHtml () {
      var f = state.facets;
      var box = function (k, ph) {
        return '<input class="sup-facet" type="text" data-facet="' + k + '" placeholder="' +
          esc(ph) + '" value="' + esc(f[k] || '') + '">';
      };
      return '<div class="sup-facets">' + box('category', 'Category') + box('city', 'Town') +
        box('county', 'County') +
        '<button class="sup-btn sup-btn-sm" type="button" data-facet-apply="1">Apply</button>' +
        (f.category || f.city || f.county
          ? '<button class="sup-btn sup-btn-sm sup-btn-ghost" type="button" data-facet-clear="1">Clear</button>'
          : '') +
        '</div>';
    }

    /* ── catalogue heading, with the breadcrumb back to discovery ──────── */
    function catalogueHead (def) {
      if (!state.supplier) {
        return '<h2 class="sup-h2">Supply Catalogue</h2>' +
          '<p class="sup-sub">What this business currently offers other businesses.</p>';
      }
      return '<div class="sup-crumb">' +
          '<button class="sup-btn sup-btn-sm sup-btn-ghost" type="button" data-back-find="1">‹ Find Suppliers</button>' +
        '</div>' +
        '<h2 class="sup-h2">' + esc(state.supplier.name || state.supplier.businessId) + '</h2>' +
        '<p class="sup-sub">' + esc(def.sub) + '</p>';
    }

    /* ── the draft-order strip ────────────────────────────────────────────
       Deliberately labelled a DRAFT. Nothing here has reached the server, there is no PO
       number, and the estimate is the buyer's own quantities against the supplier's own
       published prices — the authoritative total, with VAT, is computed by the engine on
       submission and only then displayed as a fact. */
    function orderEstimate () {
      var t = 0, known = true;
      state.order.lines.forEach(function (l) {
        if (typeof l.wholesalePrice === 'number' && isFinite(l.wholesalePrice)) t += l.wholesalePrice * l.qty;
        else known = false;
      });
      return known ? t : null;
    }
    function orderBar () {
      var est = orderEstimate();
      return '<div class="sup-orderbar">' +
        '<span><b>' + count(state.order.lines.length) + '</b> item(s) drafted for <b>' +
          esc(state.order.supplierName) + '</b></span>' +
        '<span class="sup-est">Estimate ' + money(est) + '</span>' +
        '<button class="sup-btn sup-btn-sm" type="button" data-open-order="1">Review order</button>' +
        '</div>';
    }

    function renderOrder () {
      var o = state.order;
      if (!o || !o.lines.length) {
        return '<h2 class="sup-h2">Draft order</h2>' +
          stateBlock('📭', 'Nothing drafted yet',
            'Open a supplier from Find Suppliers and add products from its catalogue.', 'empty');
      }
      var est = orderEstimate();
      return '<div class="sup-crumb">' +
          '<button class="sup-btn sup-btn-sm sup-btn-ghost" type="button" data-back-catalogue="1">‹ Back to catalogue</button>' +
        '</div>' +
        '<h2 class="sup-h2">Draft order — ' + esc(o.supplierName) + '</h2>' +
        '<p class="sup-sub">Not yet submitted. Nothing is recorded until you place it.</p>' +
        table([
          { h: 'Product', strong: true, f: function (r) { return text(r.name); } },
          { h: 'Unit price', f: function (r) { return money(r.wholesalePrice); } },
          { h: 'Supplier minimum', f: function (r) { return count(r.minWholesaleQty); } },
          { h: 'Quantity', f: function (r) {
              return '<input class="sup-qty" type="number" min="1" step="1" value="' +
                esc(String(r.qty)) + '" data-qty="' + esc(r.productId) + '">';
            } },
          { h: 'Line', f: function (r) {
              return (typeof r.wholesalePrice === 'number' && isFinite(r.wholesalePrice))
                ? money(r.wholesalePrice * r.qty) : NEUTRAL;
            } },
          { h: '', f: function (r) {
              return '<button class="sup-btn sup-btn-sm sup-btn-ghost" type="button" data-remove-line="' +
                esc(r.productId) + '">Remove</button>';
            } },
        ], o.lines, null) +
        '<div class="sup-orderfoot">' +
          '<div class="sup-est-big">Estimate ' + money(est) + '</div>' +
          '<button class="sup-btn sup-btn-primary" type="button" data-place-order="1"' +
            (state.submitting ? ' disabled' : '') + '>' +
            (state.submitting ? 'Placing…' : 'Place purchase order') + '</button>' +
        '</div>' +
        (belowMinimum(o)
          ? stateBlock('⚠️', 'Below a stated minimum',
              'One or more lines is under the quantity that supplier stated. The order can ' +
              'still be placed — the minimum is the supplier’s term, not a system rule — ' +
              'but they may decline it.', 'warn')
          : '') +
        '<p class="sup-note">The estimate multiplies your quantities by the supplier’s ' +
        'published wholesale prices. It is NOT the order total: the purchase order total, ' +
        'with VAT as it applies to this supplier, is calculated by the procurement engine when the order is placed, ' +
        'and only that figure is authoritative. Placing this order creates a supplier ' +
        'relationship with that business if you do not already have one.</p>';
    }

    function renderList (def, data) {
      var rows = (data && (data.items || data.orders || data.products || data.suppliers)) || [];
      var head = '<h2 class="sup-h2">' + esc(def.title) + '</h2><p class="sup-sub">' + esc(def.sub) + '</p>';
      if (def.facets) head += facetsHtml();
      if (def.id === 'catalogue') head = catalogueHead(def);
      /* The draft strip belongs to the shopping context only. Showing it over Invoices or
         Stock would imply those sections have something to do with the draft. */
      if ((def.id === 'catalogue' || def.id === 'find') && state.order && state.order.lines.length) {
        head += orderBar();
      }

      if (!rows.length) {
        /* The reason differs by section and must not be flattened into one sentence. An
           empty directory is a real state of the network; an empty catalogue is a real
           state of one supplier. Neither is a failed query. */
        var why = def.id === 'find'
          ? 'Supply participation and directory listing are both opt-in, and no business has ' +
            'switched them on yet. This is a real, empty result from the server — not a ' +
            'failed search and not a placeholder.'
          : 'Nothing has been recorded for this business. This is a real, empty result from ' +
            'the server — not a placeholder.';
        return head + stateBlock('📭', def.empty, why, 'empty') +
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

        /* The draft order is composed locally and has no read of its own. It is not in NAV:
           it is reachable only from a catalogue, because an order without a supplier is not
           a thing this workspace can express. */
        if (id === 'order') { main.innerHTML = renderOrder(); return; }

        var def = LIST_SECTIONS[id];
        if (!def) { main.innerHTML = stateBlock('❓', 'Unknown section', 'That section does not exist.', 'error'); return; }

        var payload = Object.assign({}, def.query || {});
        if (opts && opts.cursor) payload.cursor = opts.cursor;
        if (def.supplierSide) payload.supplierBusinessId = state.merchantId;

        /* Discovery facets are narrowing equality filters, sent only when set. An empty box
           must not become `category: ""`, which the server would treat as a real filter. */
        if (def.facets) {
          ['category', 'city', 'county'].forEach(function (k) {
            if (state.facets[k]) payload[k] = state.facets[k];
          });
        }
        /* The catalogue of a supplier opened from discovery. Omitted means the viewer's own
           catalogue, which is the server's documented default — one code path, two uses. */
        if (id === 'catalogue' && state.supplier) {
          payload.supplierBusinessId = state.supplier.businessId;
        }

        var data = await read(def.op, payload);
        var prior = (opts && opts.cursor && state.cache[id]) ? state.cache[id] : null;
        if (prior) {
          var merged = (prior.items || []).concat(data.items || data.orders || data.products || data.suppliers || []);
          data = { items: merged, nextCursor: data.nextCursor };
        }
        state.cache[id] = { items: data.items || data.orders || data.products || data.suppliers || [], nextCursor: data.nextCursor || null };
        main.innerHTML = renderList(Object.assign({ id: id }, def), state.cache[id]);
      } catch (e) {
        /* A failed read shows the failure. It never falls back to sample rows, and it never
           renders zeroes that would read as a real, empty business. */
        main.innerHTML = stateBlock('⚠️', 'Could not load this section',
          'The server did not return this data (' + text((e && e.message) || 'error') + '). ' +
          'Nothing is shown rather than a guess. Try again.', 'error');
      }
    }

    /* ── navigation ──────────────────────────────────────────────────────── */
    function goSection (id) {
      state.section = id;
      host.querySelectorAll('[data-sec]').forEach(function (b) {
        b.setAttribute('aria-current', b.getAttribute('data-sec') === id ? 'true' : 'false');
      });
      loadSection(id);
    }

    /* ── draft order ─────────────────────────────────────────────────────────
       Composed entirely on this device. The ONLY figures copied out of the catalogue are
       the supplier's own published price and stated minimum; the quantity is the buyer's.
       Nothing here is written anywhere until placeOrder() runs. */
    function catalogueRow (productId) {
      var cached = state.cache.catalogue;
      var rows = (cached && cached.items) || [];
      for (var i = 0; i < rows.length; i++) if (rows[i].productId === productId) return rows[i];
      return null;
    }

    /* DERIVED at render time, never cached on the draft. A cached flag goes stale the moment
       a quantity changes by any path the setter does not own, and a stale "below minimum"
       warning is worse than none: it either nags about a line that is now fine, or stays
       silent on one that is not. */
    function belowMinimum (order) {
      return !!(order && order.lines.some(function (l) {
        return typeof l.minWholesaleQty === 'number' && isFinite(l.minWholesaleQty) &&
               l.qty < l.minWholesaleQty;
      }));
    }

    function addLine (productId) {
      var row = catalogueRow(productId);
      if (!row || !state.supplier) return;
      if (!state.order || state.order.supplierBusinessId !== state.supplier.businessId) {
        /* One draft, one supplier. A purchase order is placed WITH a supplier, so switching
           supplier starts a new draft rather than silently mixing counterparties. */
        state.order = {
          supplierBusinessId: state.supplier.businessId,
          supplierName: state.supplier.name || state.supplier.businessId,
          lines: [],
        };
      }
      var existing = null;
      state.order.lines.forEach(function (l) { if (l.productId === productId) existing = l; });
      if (existing) { existing.qty += 1; }
      else {
        state.order.lines.push({
          productId: row.productId,
          name: row.name,
          wholesalePrice: row.wholesalePrice,
          /* Carried for the warning only. A supplier who stated no minimum gets NO minimum:
             this is never defaulted, so nothing is enforced that they did not ask for. */
          minWholesaleQty: row.minWholesaleQty,
          /* The buyer's own starting quantity. Where the supplier stated a minimum we start
             there, which is a convenience, not a claim — it is editable and visibly theirs. */
          qty: (typeof row.minWholesaleQty === 'number' && isFinite(row.minWholesaleQty) && row.minWholesaleQty > 0)
            ? row.minWholesaleQty : 1,
        });
      }
      loadSection('catalogue');
    }

    function removeLine (productId) {
      if (!state.order) return;
      state.order.lines = state.order.lines.filter(function (l) { return l.productId !== productId; });
      if (!state.order.lines.length) state.order = null;
      loadSection(state.section);
    }

    function syncQtysFromDom () {
      if (!state.order || !host.querySelectorAll) return;
      var inputs = host.querySelectorAll('[data-qty]');
      if (!inputs || !inputs.length) return;
      Array.prototype.forEach.call(inputs, function (i) {
        setQty(i.getAttribute('data-qty'), i.value);
      });
    }

    function setQty (productId, raw) {
      if (!state.order) return;
      var n = Math.floor(Number(raw));
      if (!isFinite(n) || n < 1) n = 1;
      state.order.lines.forEach(function (l) { if (l.productId === productId) l.qty = n; });
    }

    /* THE ONLY WRITE THIS MODULE PERFORMS, and it happens solely on an explicit click.
       It calls the canonical procurement engine — addSupplier to establish the relationship
       (idempotent for a SOKONI counterparty, so re-ordering never mints a duplicate), then
       createPurchaseOrder. No order is constructed here: the engine assigns the PO number,
       computes subtotal, VAT and total server-side, and applies its own authority gates.
       This surface does not decide anything financial. */
    async function placeOrder () {
      if (!state.order || !state.order.lines.length || state.submitting) return;
      /* Read the quantity fields straight from the DOM first. A buyer who types a quantity
         and clicks Place without leaving the field would otherwise submit the previous
         value — ordering a different amount than the one on screen. */
      syncQtysFromDom();
      var main = doc.getElementById('sup-main');
      state.submitting = true;
      if (main) main.innerHTML = renderOrder();
      try {
        var link = await read('addSupplier', {
          supplierBusinessId: state.order.supplierBusinessId,
        });
        var supplierId = link && link.supplierId;
        if (!supplierId) throw new Error('supplier-link-failed');

        var po = await read('createPurchaseOrder', {
          supplierId: supplierId,
          items: state.order.lines.map(function (l) {
            return { productId: l.productId, name: l.name, qty: l.qty, unitCost: l.wholesalePrice };
          }),
        });

        state.submitting = false;
        var placed = state.order;
        state.order = null;
        /* Everything reported back is the SERVER's, including the total. Nothing from the
           draft estimate is repeated as if it had been confirmed. */
        if (main) {
          main.innerHTML = '<h2 class="sup-h2">Purchase order placed</h2>' +
            stateBlock('✅', text(po && po.poNumber),
              'Placed with ' + (placed.supplierName || 'the supplier') + '. ' +
              'Total ' + money(po && po.total) + vatPhrase(po && po.vatBasis) +
              ', as calculated by the procurement engine.', 'ok') +
            '<p class="sup-note">The order is raised, not sent. Approval and sending are ' +
            'separate authorised actions with their own gates — open Purchase Orders to ' +
            'continue.</p>' +
            '<button class="sup-btn" type="button" data-sec="pos">Open Purchase Orders</button>';
        }
        state.cache = {};
      } catch (e) {
        state.submitting = false;
        if (main) {
          main.innerHTML = renderOrder() +
            stateBlock('⚠️', 'The order was not placed',
              'The server refused this order (' + text((e && e.message) || 'error') + '). ' +
              'Nothing was recorded. Your draft is unchanged.', 'error');
        }
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
      /* ── discovery → catalogue ─────────────────────────────────────── */
      var view = ev.target.closest && ev.target.closest('[data-view-supply]');
      if (view) {
        state.supplier = {
          businessId: view.getAttribute('data-view-supply'),
          name: view.getAttribute('data-supply-name') || null,
        };
        delete state.cache.catalogue;
        goSection('catalogue');
        return;
      }
      var backFind = ev.target.closest && ev.target.closest('[data-back-find]');
      if (backFind) { state.supplier = null; delete state.cache.catalogue; goSection('find'); return; }
      var backCat = ev.target.closest && ev.target.closest('[data-back-catalogue]');
      if (backCat) { goSection('catalogue'); return; }
      var openOrder = ev.target.closest && ev.target.closest('[data-open-order]');
      if (openOrder) { goSection('order'); return; }

      /* ── facets ────────────────────────────────────────────────────── */
      var apply = ev.target.closest && ev.target.closest('[data-facet-apply]');
      if (apply) {
        host.querySelectorAll('[data-facet]').forEach(function (i) {
          state.facets[i.getAttribute('data-facet')] = String(i.value || '').trim();
        });
        delete state.cache.find;
        loadSection('find');
        return;
      }
      var clear = ev.target.closest && ev.target.closest('[data-facet-clear]');
      if (clear) {
        state.facets = { category: '', city: '', county: '' };
        delete state.cache.find;
        loadSection('find');
        return;
      }

      /* ── draft order composition ───────────────────────────────────── */
      var add = ev.target.closest && ev.target.closest('[data-add-line]');
      if (add) { addLine(add.getAttribute('data-add-line')); return; }
      var rm = ev.target.closest && ev.target.closest('[data-remove-line]');
      if (rm) { removeLine(rm.getAttribute('data-remove-line')); return; }
      var place = ev.target.closest && ev.target.closest('[data-place-order]');
      if (place) { placeOrder(); return; }

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

    /* Quantity edits are read on change, not re-rendered on every keystroke — retyping a
       number must not fight the cursor. The draft is re-read from the DOM before submission
       regardless, so an unblurred field cannot be silently dropped. */
    function onChange (ev) {
      var q = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-qty');
      if (q) { setQty(q, ev.target.value); }
    }

    host.addEventListener('click', onClick);
    host.addEventListener('change', onChange);
    render();

    return {
      refresh: function () { state.cache = {}; render(); },
      destroy: function () {
        state.destroyed = true;
        try { host.removeEventListener('click', onClick); } catch (_) {}
        try { host.removeEventListener('change', onChange); } catch (_) {}
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
