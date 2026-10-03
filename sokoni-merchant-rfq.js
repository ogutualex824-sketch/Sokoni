/* ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
   SokoniMerchantRfq — B2B RFQs & quotations inside merchant-v2 (sokoni-f3, 2026-10-03)
   ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
   Server authority: functions/rfq.js → rfqDispatch {op} (create / listMine / listReceived / get / decline / quote /
   respond / cancel), plus procurement.findSuppliers (discovery) and setSupplyParticipation (consent). This module
   renders and calls; it never decides a status, a price, a VAT rate or a lead.

   Owner decisions (2026-10-03): a supplier pays a lead fee per RFQ it RECEIVES (price + VAT wording from b2bLeadPrice; admin-configurable), invoiced monthly, and only if it
   has switched on "Receive paid RFQs"; no % on wholesale orders; an accepted quote becomes a purchase order paid
   through SOKONI and held until delivery (payment ships with its own server purpose — shown as not available yet).
   Messaging is SOKONI's one conversation system (tx 'rfq', when the messages server accepts it).

   Identity: keyed on a BUSINESS via the shell's merchantContext() — the same identifier space as Supply, never the
   shop scope. Every call carries that merchantId; the server authorizes it.
   ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';
  var SECTIONS = [
    { id: 'mine',     name: 'My RFQs',         icon: '📋' },
    { id: 'new',      name: 'New RFQ',          icon: '✍️' },
    { id: 'received', name: 'RFQs Received',    icon: '📥' },
    { id: 'consent',  name: 'Receive RFQs',     icon: '🔔' },
  ];
  var STATUS = { submitted: 'Open', converted: 'Ordered', cancelled: 'Cancelled', expired: 'Expired',
    received: 'New', viewed: 'Viewed', quoted: 'Quoted', declined: 'Declined', accepted: 'Accepted', rejected: 'Rejected', closed: 'Closed' };
  function esc (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function kes (n) { var v = Number(n); return isFinite(v) && v >= 0 ? 'KES ' + v.toLocaleString('en-KE', { maximumFractionDigits: 2 }) : '—'; }
  function when (ms) { if (!ms) return '—'; try { return new Date(ms).toLocaleDateString('en-KE', { day: 'numeric', month: 'short' }); } catch (e) { return '—'; } }
  var isId = function (v) { return typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v); };
  var CSS = '.rfq{display:flex;flex-direction:column;gap:12px;color:var(--text,#eee)}'
    + '.rfq-tabs{display:flex;gap:6px;flex-wrap:wrap}.rfq-tab{padding:8px 12px;border-radius:10px;border:1px solid var(--line,#2a2a2a);background:transparent;color:inherit;cursor:pointer;font:inherit;font-size:13px}'
    + '.rfq-tab[aria-current="true"]{background:var(--accent,#71ff00);color:#000;border-color:transparent;font-weight:700}'
    + '.rfq-card{border:1px solid var(--line,#2a2a2a);border-radius:12px;padding:12px 14px;background:var(--card,rgba(255,255,255,.02))}'
    + '.rfq-row{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}.rfq-muted{opacity:.65;font-size:12px}'
    + '.rfq-btn{padding:8px 12px;border-radius:9px;border:1px solid var(--line,#333);background:transparent;color:inherit;cursor:pointer;font:inherit;font-size:13px}'
    + '.rfq-btn.pri{background:var(--accent,#71ff00);color:#000;border-color:transparent;font-weight:700}.rfq-btn[disabled]{opacity:.5;cursor:not-allowed}'
    + '.rfq-in{width:100%;box-sizing:border-box;padding:9px;border-radius:8px;border:1px solid var(--line,#333);background:rgba(255,255,255,.04);color:inherit;font:inherit}'
    + '.rfq-grid{display:grid;grid-template-columns:2fr 1fr 1fr 1fr auto;gap:6px;align-items:center}'
    + '.rfq-note{font-size:12px;padding:10px 12px;border-radius:10px;background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.25)}'
    + '.rfq-msg{font-size:13px;min-height:18px}'
    + '@media(max-width:640px){.rfq-grid{grid-template-columns:1fr 1fr}}';

  function mount (host, ctx) {
    var c = ctx || {};
    var doc = host.ownerDocument || global.document;
    if (!doc.getElementById('rfq-css')) { var st = doc.createElement('style'); st.id = 'rfq-css'; st.textContent = CSS; doc.head.appendChild(st); }
    var state = { section: 'mine', merchantId: null, merchantName: null, identityError: null, data: {}, draft: { items: [{ name: '', qty: '', unit: '', targetPriceKES: '' }], picked: [] }, open: null, busy: false };

    function readContext () {
      var mc = null;
      try { mc = typeof c.merchantContext === 'function' ? c.merchantContext() : null; } catch (e) { mc = null; }
      state.merchantId = mc && mc.merchantId || null;
      state.merchantName = mc && mc.name || null;
      state.identityError = state.merchantId ? null : ((mc && mc.error) || 'unresolved');
    }
    function fn (name) { return typeof c.callable === 'function' ? c.callable(name) : null; }
    async function call (name, payload) {
      var f = fn(name); if (!f) throw new Error('This feature is not available right now.');
      if (!state.merchantId) throw new Error('Choose your business first.');
      var res = await f(Object.assign({ merchantId: state.merchantId }, payload || {}));
      return (res && res.data) ? res.data : res;
    }
    var rfq = function (op, payload) { return call('rfqDispatch', Object.assign({ op: op }, payload || {})); };
    function errText (e) { return (e && e.message) ? String(e.message).replace(/^.*?:\s*/, '') : 'Something went wrong — please try again.'; }
    function msg (t, color) { var m = host.querySelector('[data-rfq-msg]'); if (m) { m.textContent = t || ''; m.style.color = color || ''; } }

    /* ── renderers ── */
    function tabs () {
      return '<div class="rfq-tabs" role="tablist">' + SECTIONS.map(function (s) {
        return '<button type="button" class="rfq-tab" role="tab" data-rfq-sec="' + s.id + '"' + (state.section === s.id ? ' aria-current="true"' : '') + '>' + s.icon + ' ' + esc(s.name) + '</button>';
      }).join('') + '</div>';
    }
    function frame (inner) {
      host.innerHTML = '<div class="rfq"><div class="rfq-row"><div><div style="font-size:18px;font-weight:900">📋 RFQs &amp; Quotes</div>'
        + '<div class="rfq-muted">Business <b>' + esc(state.merchantName || state.merchantId || '—') + '</b> · request quotations from suppliers, and quote on requests you receive</div></div></div>'
        + tabs() + '<div class="rfq-msg" data-rfq-msg role="status"></div><div data-rfq-body>' + inner + '</div></div>';
    }
    function loading () { return '<div class="rfq-card rfq-muted">Loading…</div>'; }
    function failed (e) { return '<div class="rfq-card">Could not load this — ' + esc(errText(e)) + ' This is not an empty list. <button type="button" class="rfq-btn" data-rfq-retry>Retry</button></div>'; }

    function quoteBlock (rq, r) {
      var q = rq.quote;
      if (!q) return '<div class="rfq-muted">' + esc(STATUS[rq.status] || rq.status) + (rq.status === 'declined' ? ' — the supplier declined' : ' — no quotation yet') + '</div>';
      var lines = (q.lines || []).map(function (l) { return '<div class="rfq-muted">' + esc(l.name) + ' × ' + esc(l.qty) + ' @ ' + kes(l.unitPriceKES) + '</div>'; }).join('');
      var expired = q.validUntilMs && Date.now() > q.validUntilMs;
      var acts = '';
      if (r.status === 'submitted' && q.status === 'quoted' && !expired) {
        acts = '<button type="button" class="rfq-btn pri" data-rfq-accept="' + esc(r.rfqId) + '" data-sup="' + esc(rq.supplierBusinessId) + '" data-ver="' + esc(q.version) + '">Accept quote</button> '
          + '<button type="button" class="rfq-btn" data-rfq-reject="' + esc(r.rfqId) + '" data-sup="' + esc(rq.supplierBusinessId) + '">Reject</button>';
      }
      return lines + '<div class="rfq-row" style="margin-top:4px"><div>Subtotal ' + kes(q.subtotalKES) + ' · VAT ' + (q.vatRate ? q.vatRate + '% ' + kes(q.vatKES) : 'none (declared by supplier)') + ' · Delivery ' + kes(q.deliveryFeeKES) + '</div><b>' + kes(q.totalKES) + '</b></div>'
        + '<div class="rfq-muted">Version ' + esc(q.version) + ' · valid until ' + when(q.validUntilMs) + (expired ? ' · <b>expired</b>' : '') + (q.notes ? ' · ' + esc(q.notes) : '') + '</div>'
        + (rq.poId ? '<div style="margin-top:6px">✅ Purchase order created — open <b>Supply → Purchase Orders</b>. Paying through SOKONI (held until delivery) is not available yet.</div>' : '')
        + (acts ? '<div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">' + acts + '</div>' : '');
    }
    function renderMine () {
      var d = state.data.mine;
      if (!d) return loading();
      if (d.error) return failed(d.error);
      if (!d.rfqs.length) return '<div class="rfq-card">You have not sent an RFQ yet. <button type="button" class="rfq-btn pri" data-rfq-sec="new">New RFQ</button></div>';
      return d.rfqs.map(function (r) {
        return '<div class="rfq-card"><div class="rfq-row"><b>' + esc(r.title) + '</b><span class="rfq-muted">' + esc(STATUS[r.status] || r.status) + ' · ' + when(r.createdAtMs) + (r.mode === 'open' ? ' · open RFQ' : '') + '</span></div>'
          + '<div class="rfq-muted">' + (r.items || []).map(function (i) { return esc(i.name) + ' × ' + esc(i.qty) + ' ' + esc(i.unit); }).join(' · ') + ' · deliver to ' + esc(r.deliveryLocation) + '</div>'
          + (r.recipients || []).map(function (rq) { return '<div class="rfq-card" style="margin-top:8px"><div class="rfq-row"><b>' + esc(rq.supplierName || 'Supplier') + '</b>'
            + '<button type="button" class="rfq-btn" data-rfq-chat="' + esc(r.rfqId) + '__' + esc(rq.supplierBusinessId) + '">💬 Message supplier</button></div>' + quoteBlock(rq, r) + '</div>'; }).join('')
          + (r.status === 'submitted' ? '<div style="margin-top:8px"><button type="button" class="rfq-btn" data-rfq-cancel="' + esc(r.rfqId) + '">Cancel RFQ</button></div>' : '') + '</div>';
      }).join('');
    }
    function renderNew () {
      var dr = state.draft;
      var rows = dr.items.map(function (it, i) {
        return '<div class="rfq-grid"><input class="rfq-in" data-item="' + i + '" data-f="name" placeholder="Item (e.g. Cement 50kg)" maxlength="200" value="' + esc(it.name) + '">'
          + '<input class="rfq-in" data-item="' + i + '" data-f="qty" type="number" min="1" placeholder="Qty" value="' + esc(it.qty) + '">'
          + '<input class="rfq-in" data-item="' + i + '" data-f="unit" placeholder="Unit" maxlength="30" value="' + esc(it.unit) + '">'
          + '<input class="rfq-in" data-item="' + i + '" data-f="targetPriceKES" type="number" min="0" placeholder="Target price (opt.)" value="' + esc(it.targetPriceKES) + '">'
          + '<button type="button" class="rfq-btn" data-rfq-rmitem="' + i + '" aria-label="Remove item">✕</button></div>';
      }).join('');
      var picked = dr.picked.map(function (p) { return '<span class="rfq-btn" style="cursor:default">' + esc(p.name) + ' <button type="button" class="rfq-btn" data-rfq-unpick="' + esc(p.id) + '" aria-label="Remove supplier" style="padding:0 6px">✕</button></span>'; }).join(' ');
      return '<div class="rfq-card"><div style="font-weight:800;margin-bottom:6px">What do you need?</div>' + rows
        + '<button type="button" class="rfq-btn" data-rfq-additem style="margin-top:6px">+ Add item</button>'
        + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:10px"><input class="rfq-in" data-rfq-f="title" placeholder="Title (optional)" maxlength="150">'
        + '<input class="rfq-in" data-rfq-f="neededBy" type="date" aria-label="Needed by"></div>'
        + '<input class="rfq-in" data-rfq-f="deliveryLocation" placeholder="Delivery location *" maxlength="200" style="margin-top:6px">'
        + '<textarea class="rfq-in" data-rfq-f="notes" rows="2" placeholder="Notes for suppliers (optional)" maxlength="1000" style="margin-top:6px"></textarea></div>'
        + '<div class="rfq-card"><div style="font-weight:800;margin-bottom:6px">Who should quote?</div>'
        + '<label style="display:flex;gap:6px;align-items:center"><input type="radio" name="rfqMode" value="direct" checked> Suppliers I choose (up to 10)</label>'
        + '<div style="display:flex;gap:6px;margin:6px 0"><input class="rfq-in" data-rfq-f="supQuery" placeholder="Search suppliers by category (e.g. cement)"><button type="button" class="rfq-btn" data-rfq-find>Search</button></div>'
        + '<div data-rfq-found></div><div style="margin:6px 0">' + (picked || '<span class="rfq-muted">No suppliers chosen yet.</span>') + '</div>'
        + '<label style="display:flex;gap:6px;align-items:center;margin-top:8px"><input type="radio" name="rfqMode" value="open"> Open RFQ — SOKONI sends it to up to 5 suppliers in a category who accept RFQs</label>'
        + '<input class="rfq-in" data-rfq-f="openCategory" placeholder="Category for an open RFQ (e.g. cement)" style="margin-top:6px"></div>'
        + '<div class="rfq-note">Suppliers who receive your RFQ reply in SOKONI with a quotation. Your phone and email are not shared. Prices, VAT and totals come from the supplier\'s quote.</div>'
        + '<button type="button" class="rfq-btn pri" data-rfq-send' + (state.busy ? ' disabled' : '') + '>Send RFQ</button>';
    }
    function renderReceived () {
      var d = state.data.received;
      if (!d) return loading();
      if (d.error) return failed(d.error);
      if (state.open) return renderOpen();
      if (!d.rfqs.length) return '<div class="rfq-card">No RFQs received yet. Buyers can send you RFQs once you switch on <button type="button" class="rfq-btn" data-rfq-sec="consent">Receive RFQs</button>.</div>';
      return d.rfqs.map(function (v) {
        return '<div class="rfq-card"><div class="rfq-row"><b>' + esc(v.title) + '</b><span class="rfq-muted">' + esc(STATUS[v.status] || v.status) + ' · ' + when(v.receivedAtMs) + '</span></div>'
          + '<div style="margin-top:6px"><button type="button" class="rfq-btn pri" data-rfq-open="' + esc(v.rfqId) + '">Open</button></div></div>';
      }).join('');
    }
    function renderOpen () {
      var o = state.open;
      if (o.loading) return loading();
      if (o.error) return failed(o.error);
      var r = o.data.rfq, mq = o.data.myQuote, st = o.data.status;
      var canQuote = r.status === 'submitted' && ['accepted', 'closed', 'declined'].indexOf(st) === -1 && Date.now() <= (r.expiresAtMs || 0);
      var lines = (r.items || []).map(function (it, i) {
        var prev = mq && mq.lines && mq.lines[i];
        return '<div class="rfq-grid"><div>' + esc(it.name) + ' <span class="rfq-muted">(' + esc(it.qty) + ' ' + esc(it.unit) + (it.targetPriceKES ? ', target ' + kes(it.targetPriceKES) : '') + ')</span></div>'
          + '<input class="rfq-in" data-q="' + i + '" data-qf="qty" type="number" min="1" value="' + esc(prev ? prev.qty : it.qty) + '" aria-label="Quantity"' + (canQuote ? '' : ' disabled') + '>'
          + '<input class="rfq-in" data-q="' + i + '" data-qf="unitPriceKES" type="number" min="0" step="0.01" placeholder="Unit price KES" value="' + esc(prev ? prev.unitPriceKES : '') + '" aria-label="Unit price"' + (canQuote ? '' : ' disabled') + '><span></span><span></span></div>';
      }).join('');
      return '<div class="rfq-card"><button type="button" class="rfq-btn" data-rfq-back>← Back</button>'
        + '<div class="rfq-row" style="margin-top:8px"><b>' + esc(r.title) + '</b><span class="rfq-muted">from ' + esc(r.buyerName || 'a SOKONI business') + ' · ' + esc(STATUS[st] || st) + '</span></div>'
        + '<div class="rfq-muted">Deliver to ' + esc(r.deliveryLocation) + (r.neededBy ? ' · needed by ' + esc(r.neededBy) : '') + (r.notes ? ' · ' + esc(r.notes) : '') + '</div>'
        + '<div style="margin-top:10px">' + lines + '</div>'
        + (canQuote ? '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-top:8px">'
          + '<select class="rfq-in" data-qx="vatRate" aria-label="VAT on this quote"><option value="">VAT on this quote *</option><option value="16"' + (mq && mq.vatRate === 16 ? ' selected' : '') + '>16% VAT (I am VAT-registered)</option><option value="0"' + (mq && mq.vatRate === 0 ? ' selected' : '') + '>No VAT</option></select>'
          + '<input class="rfq-in" data-qx="deliveryFeeKES" type="number" min="0" placeholder="Delivery fee KES" value="' + esc(mq ? mq.deliveryFeeKES : '') + '">'
          + '<input class="rfq-in" data-qx="validDays" type="number" min="1" max="30" placeholder="Valid for (days)" value="' + esc(7) + '"></div>'
          + '<textarea class="rfq-in" data-qx="notes" rows="2" maxlength="1000" placeholder="Terms / notes (optional)" style="margin-top:6px">' + esc(mq ? mq.notes : '') + '</textarea>'
          + '<div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap"><button type="button" class="rfq-btn pri" data-rfq-quote="' + esc(r.rfqId) + '">' + (mq ? 'Send updated quote' : 'Send quote') + '</button>'
          + '<button type="button" class="rfq-btn" data-rfq-decline="' + esc(r.rfqId) + '">Decline</button>'
          + '<button type="button" class="rfq-btn" data-rfq-chat="' + esc(r.rfqId) + '__' + esc(state.merchantId) + '">💬 Message buyer</button></div>'
          : '<div class="rfq-muted" style="margin-top:8px">' + (mq ? 'Your quote: ' + kes(mq.totalKES) + ' (version ' + esc(mq.version) + ')' : '') + ' This RFQ is no longer open for quotes.</div>')
        + '</div>';
    }
    /* The lead price is admin-configurable (adminSetB2bLeadPrice) and its VAT wording is the commercial authority's
       (b2bLeadPrice, sokoni-2f). Both are rendered from the server, never hard-coded here. While the price is unknown
       a supplier cannot opt in: consent to a fee needs the fee in front of them. Switching OFF is always allowed. */
    function renderConsent () {
      var p = state.data.leadPrice, known = !!(p && !p.error && Number(p.priceKES) > 0);
      var price = known ? '<b>' + kes(p.priceKES) + (p.vat ? ' ' + esc(p.vat) : '') + ' per RFQ received</b>, invoiced monthly'
        : p && p.error ? '<b>— (the lead price could not be loaded; you can switch on once it is shown)</b>'
        : '<b>— (loading the lead price…)</b>';
      return '<div class="rfq-card"><div style="font-weight:800">Receive paid RFQs</div>'
        + '<div class="rfq-note" style="margin:8px 0">Each RFQ you receive is a business lead. SOKONI charges ' + price + '. There is no commission on the orders you win. You only receive RFQs while this is on, and you can switch it off at any time.</div>'
        + '<div class="rfq-muted">Your business must also be set up to supply other businesses (Supply → Products I Supply).</div>'
        + '<div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap"><button type="button" class="rfq-btn pri" data-rfq-consent="on"' + (known ? '' : ' disabled aria-disabled="true"') + '>Receive paid RFQs</button><button type="button" class="rfq-btn" data-rfq-consent="off">Stop receiving RFQs</button></div></div>';
    }
    function renderBody () {
      var b = host.querySelector('[data-rfq-body]'); if (!b) return;
      b.innerHTML = state.section === 'mine' ? renderMine() : state.section === 'new' ? renderNew() : state.section === 'received' ? renderReceived() : renderConsent();
    }
    function render () {
      readContext();
      if (!state.merchantId) { frame('<div class="rfq-card">B2B RFQs are for SOKONI businesses. ' + (state.identityError === 'context-unavailable' ? 'Your business could not be loaded — reload.' : 'Choose or register your business first.') + '</div>'); return; }
      frame(''); load(state.section);
    }

    /* ── loads ── */
    function load (sec) {
      renderBody();
      if (sec === 'mine') rfq('listMine').then(function (d) { state.data.mine = { rfqs: (d && d.rfqs) || [] }; renderBody(); }).catch(function (e) { state.data.mine = { error: e }; renderBody(); });
      if (sec === 'consent' && !(state.data.leadPrice && !state.data.leadPrice.error)) call('b2bLeadPrice', {}).then(function (d) { state.data.leadPrice = d || { error: true }; renderBody(); }).catch(function () { state.data.leadPrice = { error: true }; renderBody(); });
      if (sec === 'received' && !state.open) rfq('listReceived').then(function (d) { state.data.received = { rfqs: (d && d.rfqs) || [] }; renderBody(); }).catch(function (e) { state.data.received = { error: e }; renderBody(); });
    }
    function readDraft () {
      host.querySelectorAll('[data-item]').forEach(function (el) { var i = +el.getAttribute('data-item'), f = el.getAttribute('data-f'); if (state.draft.items[i]) state.draft.items[i][f] = el.value; });
    }
    function field (k) { var el = host.querySelector('[data-rfq-f="' + k + '"]'); return el ? String(el.value || '').trim() : ''; }

    /* ── actions ── */
    async function send () {
      readDraft();
      var items = state.draft.items.filter(function (i) { return String(i.name || '').trim(); }).map(function (i) { return { name: i.name, qty: Number(i.qty), unit: i.unit, targetPriceKES: i.targetPriceKES === '' ? null : Number(i.targetPriceKES) }; });
      var mode = (host.querySelector('input[name="rfqMode"]:checked') || {}).value || 'direct';
      var payload = { items: items, title: field('title'), deliveryLocation: field('deliveryLocation'), neededBy: field('neededBy') || undefined, notes: field('notes') };
      if (mode === 'open') payload.open = { category: field('openCategory') }; else payload.supplierBusinessIds = state.draft.picked.map(function (p) { return p.id; });
      state.busy = true; msg('Sending…');
      try {
        var r = await rfq('create', payload);
        msg('Sent to ' + ((r && r.recipients) || []).length + ' supplier(s). You will see their quotations in My RFQs.', '#71ff00');
        state.draft = { items: [{ name: '', qty: '', unit: '', targetPriceKES: '' }], picked: [] }; state.data.mine = null; state.section = 'mine'; frame(''); load('mine');
      } catch (e) { msg(errText(e), '#ff6b6b'); }
      state.busy = false;
    }
    async function find () {
      var box = host.querySelector('[data-rfq-found]'); if (!box) return;
      var q = field('supQuery').toLowerCase();
      box.innerHTML = '<div class="rfq-muted">Searching…</div>';
      try {
        var d = await call('findSuppliers', q ? { category: q } : {});
        var list = ((d && (d.suppliers || d.items)) || []).filter(function (s) { return s && s.supply && s.supply.acceptsLeads === true; });
        box.innerHTML = list.length ? list.slice(0, 20).map(function (s) {
          return '<div class="rfq-row rfq-card" style="padding:8px 10px;margin:4px 0"><span>' + esc((s.supply && s.supply.displayName) || s.name || 'Supplier') + ' <span class="rfq-muted">' + esc([s.city, s.county].filter(Boolean).join(', ')) + '</span></span>'
            + '<span style="display:flex;gap:6px"><a class="rfq-btn" href="seller-public.html?business=' + encodeURIComponent(s.businessId) + '" target="_blank" rel="noopener">Storefront</a>'
            + '<button type="button" class="rfq-btn pri" data-rfq-pick="' + esc(s.businessId) + '" data-name="' + esc((s.supply && s.supply.displayName) || s.name || 'Supplier') + '">Add</button></span></div>';
        }).join('') : '<div class="rfq-muted">No supplier accepting RFQs matches that yet.</div>';
      } catch (e) { box.innerHTML = '<div class="rfq-muted">Supplier search is not available right now — ' + esc(errText(e)) + '</div>'; }
    }
    async function openRfq (id) {
      state.open = { loading: true }; renderBody();
      try { state.open = { data: await rfq('get', { rfqId: id }) }; } catch (e) { state.open = { error: e }; }
      renderBody();
    }
    async function quote (id) {
      var lines = [];
      (state.open && state.open.data.rfq.items || []).forEach(function (it, i) {
        var q = host.querySelector('[data-q="' + i + '"][data-qf="qty"]'), p = host.querySelector('[data-q="' + i + '"][data-qf="unitPriceKES"]');
        if (p && String(p.value).trim() !== '') lines.push({ name: it.name, qty: Number(q && q.value), unitPriceKES: Number(p.value) });
      });
      var x = function (k) { var el = host.querySelector('[data-qx="' + k + '"]'); return el ? el.value : ''; };
      if (x('vatRate') === '') { msg('Choose the VAT on your quote — SOKONI never assumes it.', '#ff6b6b'); return; }
      msg('Sending quote…');
      try {
        var r = await rfq('quote', { rfqId: id, lines: lines, vatRate: Number(x('vatRate')), deliveryFeeKES: x('deliveryFeeKES') === '' ? 0 : Number(x('deliveryFeeKES')), validDays: Number(x('validDays')), notes: x('notes') });
        msg('Quote sent: ' + kes(r.totalKES) + ' (version ' + r.version + ').', '#71ff00'); openRfq(id);
      } catch (e) { msg(errText(e), '#ff6b6b'); }
    }
    function chat (txId) {
      if (!isId(String(txId).replace('__', '_'))) return;
      if (global.SokoniInbox && typeof global.SokoniInbox.openForTransaction === 'function') { global.SokoniInbox.openForTransaction('rfq', txId); return; }
      msg('Messaging for RFQs is not available yet — it opens here as soon as SOKONI messages accept RFQ conversations.', '#fbbf24');
    }

    function onClick (ev) {
      var t = ev.target && ev.target.closest ? ev.target : null; if (!t) return;
      var b;
      if ((b = t.closest('[data-rfq-sec]'))) { state.section = b.getAttribute('data-rfq-sec'); state.open = null; frame(''); load(state.section); return; }
      if (t.closest('[data-rfq-retry]')) { state.data = {}; frame(''); load(state.section); return; }
      if (t.closest('[data-rfq-additem]')) { readDraft(); if (state.draft.items.length < 50) state.draft.items.push({ name: '', qty: '', unit: '', targetPriceKES: '' }); renderBody(); return; }
      if ((b = t.closest('[data-rfq-rmitem]'))) { readDraft(); state.draft.items.splice(+b.getAttribute('data-rfq-rmitem'), 1); if (!state.draft.items.length) state.draft.items.push({ name: '', qty: '', unit: '', targetPriceKES: '' }); renderBody(); return; }
      if (t.closest('[data-rfq-find]')) { find(); return; }
      if ((b = t.closest('[data-rfq-pick]'))) { readDraft(); var id = b.getAttribute('data-rfq-pick'); if (isId(id) && !state.draft.picked.some(function (p) { return p.id === id; }) && state.draft.picked.length < 10) state.draft.picked.push({ id: id, name: b.getAttribute('data-name') }); renderBody(); return; }
      if ((b = t.closest('[data-rfq-unpick]'))) { readDraft(); var u = b.getAttribute('data-rfq-unpick'); state.draft.picked = state.draft.picked.filter(function (p) { return p.id !== u; }); renderBody(); return; }
      if (t.closest('[data-rfq-send]')) { send(); return; }
      if ((b = t.closest('[data-rfq-open]'))) { openRfq(b.getAttribute('data-rfq-open')); return; }
      if (t.closest('[data-rfq-back]')) { state.open = null; state.data.received = null; load('received'); return; }
      if ((b = t.closest('[data-rfq-quote]'))) { quote(b.getAttribute('data-rfq-quote')); return; }
      if ((b = t.closest('[data-rfq-decline]'))) { var did = b.getAttribute('data-rfq-decline'); if (global.confirm && !global.confirm('Decline this RFQ?')) return; rfq('decline', { rfqId: did }).then(function () { msg('Declined.'); openRfq(did); }).catch(function (e) { msg(errText(e), '#ff6b6b'); }); return; }
      if ((b = t.closest('[data-rfq-accept]'))) {
        if (global.confirm && !global.confirm('Accept this quotation? It becomes a purchase order with this supplier.')) return;
        b.disabled = true;
        rfq('respond', { rfqId: b.getAttribute('data-rfq-accept'), supplierBusinessId: b.getAttribute('data-sup'), action: 'accept', expectedVersion: Number(b.getAttribute('data-ver')) })
          .then(function () { msg('Accepted — a purchase order was created (Supply → Purchase Orders).', '#71ff00'); state.data.mine = null; load('mine'); })
          .catch(function (e) { b.disabled = false; msg(errText(e), '#ff6b6b'); });
        return;
      }
      if ((b = t.closest('[data-rfq-reject]'))) { rfq('respond', { rfqId: b.getAttribute('data-rfq-reject'), supplierBusinessId: b.getAttribute('data-sup'), action: 'reject' }).then(function () { state.data.mine = null; load('mine'); }).catch(function (e) { msg(errText(e), '#ff6b6b'); }); return; }
      if ((b = t.closest('[data-rfq-cancel]'))) { if (global.confirm && !global.confirm('Cancel this RFQ?')) return; rfq('cancel', { rfqId: b.getAttribute('data-rfq-cancel') }).then(function () { state.data.mine = null; load('mine'); }).catch(function (e) { msg(errText(e), '#ff6b6b'); }); return; }
      if ((b = t.closest('[data-rfq-chat]'))) { chat(b.getAttribute('data-rfq-chat')); return; }
      if ((b = t.closest('[data-rfq-consent]'))) {
        var on = b.getAttribute('data-rfq-consent') === 'on';
        var lp = state.data.leadPrice;
        if (on && !(lp && !lp.error && Number(lp.priceKES) > 0)) { msg('The lead price is not shown yet — you can switch on once it is.', '#fbbf24'); return; }
        if (on && global.confirm && !global.confirm('Receive paid RFQs? Each RFQ you receive costs ' + kes(lp.priceKES) + (lp.vat ? ' ' + lp.vat : '') + ', invoiced monthly.')) return;
        /* supply.enabled must accompany every participation update (the server refuses an implicit one); switching
           RFQs on keeps supply enabled, switching them off leaves supply as it is but withdraws lead consent. */
        call('setSupplyParticipation', { businessId: state.merchantId, supply: { enabled: true, acceptsLeads: on } })
          .then(function () { msg(on ? 'You now receive paid RFQs.' : 'You no longer receive RFQs.', '#71ff00'); })
          .catch(function (e) { msg(errText(e), '#ff6b6b'); });
      }
    }
    host.addEventListener('click', onClick);
    render();
    return { refresh: function () { state.data = {}; render(); }, destroy: function () { try { host.removeEventListener('click', onClick); } catch (e) {} host.innerHTML = ''; }, _state: state, _sections: SECTIONS };
  }
  global.SokoniMerchantRfq = { mount: mount, SECTIONS: SECTIONS };
})(typeof window !== 'undefined' ? window : this);
