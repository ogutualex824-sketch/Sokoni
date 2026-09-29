/* ════════════════════════════════════════════════════════════════════════════
   SOKONI Trust Queues — disputes and reports for AdminOS AND super admin (2026-09-29)

   ONE admin surface, mounted by both hosts (admin-os.html › Financial › Disputes and Fraud › Reports Queue;
   super-admin.html › Disputes and › Trust reports). Before this, AdminOS listed only status 'open' disputes (every new
   dispute was moved to 'under_review' by a trigger, so the list was always empty), super admin had no disputes or
   content-report view at all, and conversation reports (moderationQueue) reached no admin workspace.

   Every read and write is a SERVER authority; this file holds no business state and invents no figure:
     disputes              adminOsDispatch › adminGetDisputes · adminGetDisputeDetail · aosResolveDispute
                           (all delegate to functions/disputes.js — the same core trust-safety.html uses)
     listing / user reports tsGetReports · tsReviewReport            (functions/trust-safety.js)
     conversation reports   messagesDispatch › adminGetReports · adminReviewReport   (functions/messages.js)
   "Resolved" / "Actioned" is shown only after the server returns. A failed read says so — never an empty list.

   mount(host, { view: 'disputes' | 'reports', callable: (fnName) => (payload) => Promise, onToast? })
   ════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SokoniTrustQueues = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var REASONS = {
    not_received: 'Item not received', wrong_item: 'Wrong item sent', not_as_described: 'Not as described',
    counterfeit: 'Counterfeit product', damaged: 'Arrived damaged', defective: 'Defective / not working',
    overcharged: 'Wrong amount charged', other: 'Other issue',
  };
  var D_STATUS = {
    open: { l: 'Open — awaiting seller', t: 'act' }, investigating: { l: 'Investigating', t: 'wait' },
    under_review: { l: 'Under review', t: 'wait' }, seller_responded: { l: 'Seller responded', t: 'act' },
    resolved: { l: 'Resolved', t: 'done' }, closed: { l: 'Closed', t: 'done' },
  };
  var D_FILTERS = [['active', 'Active'], ['final', 'Resolved & closed'], ['all', 'All']];
  var R_FILTERS = [['pending', 'Pending'], ['escalated', 'Escalated'], ['actioned', 'Actioned'], ['dismissed', 'Dismissed']];
  var C_FILTERS = [['pending', 'Pending'], ['reviewed', 'Reviewed']];

  var CSS = [
    '.stq{--q-bg:#0b0b0d;--q-card:#141418;--q-line:rgba(255,255,255,.09);--q-txt:#ececec;--q-sub:#9a9aa2;--q-mut:#6d6d75;',
    '--q-acc:#71ff00;--q-warn:#ffb020;--q-bad:#ff5a5f;--q-blue:#64b4ff;color:var(--q-txt);font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;position:relative}',
    '.stq *{box-sizing:border-box}',
    '.stq-top{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:12px}',
    '.stq-chips{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;flex:1;min-width:0}',
    '.stq-chips::-webkit-scrollbar{display:none}',
    '.stq-chip{flex:0 0 auto;min-height:40px;padding:0 14px;border-radius:999px;border:1px solid var(--q-line);background:transparent;',
    'color:var(--q-sub);font:inherit;font-size:12.5px;font-weight:700;cursor:pointer}',
    '.stq-chip.on{border-color:rgba(113,255,0,.45);background:rgba(113,255,0,.12);color:var(--q-acc)}',
    '.stq-chip:focus-visible,.stq-btn:focus-visible,.stq-row:focus-visible{outline:2px solid var(--q-acc);outline-offset:2px}',
    '.stq-seg{display:flex;gap:4px;padding:4px;border-radius:14px;background:rgba(255,255,255,.04);border:1px solid var(--q-line);margin-bottom:10px;width:max-content;max-width:100%}',
    '.stq-seg button{min-height:38px;padding:0 14px;border-radius:10px;border:0;background:transparent;color:var(--q-sub);font:inherit;font-size:12.5px;font-weight:800;cursor:pointer}',
    '.stq-seg button.on{background:var(--q-card);color:var(--q-txt)}',
    '.stq-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:40px;padding:0 14px;border-radius:11px;',
    'border:1px solid var(--q-line);background:rgba(255,255,255,.05);color:var(--q-txt);font:inherit;font-size:12.5px;font-weight:800;cursor:pointer}',
    '.stq-btn.solid{background:var(--q-acc);border-color:var(--q-acc);color:#000}',
    '.stq-btn.bad{border-color:rgba(255,90,95,.4);color:#ff8a8d;background:rgba(255,90,95,.08)}',
    '.stq-btn.warn{border-color:rgba(255,176,32,.4);color:#ffc45e;background:rgba(255,176,32,.08)}',
    '.stq-btn[disabled]{opacity:.5;cursor:default}',
    '.stq-list{display:grid;gap:8px}',
    '.stq-row{display:grid;grid-template-columns:1fr auto;gap:6px 12px;padding:13px 14px;border-radius:14px;background:var(--q-card);',
    'border:1px solid var(--q-line);cursor:pointer;text-align:left;color:inherit;font:inherit;width:100%}',
    '.stq-row:hover{border-color:rgba(255,255,255,.18)}',
    '.stq-row .t{font-weight:800;font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
    '.stq-row .s{grid-column:1/-1;font-size:12px;color:var(--q-sub);overflow:hidden;text-overflow:ellipsis}',
    '.stq-row .a{font-weight:900;font-variant-numeric:tabular-nums;color:var(--q-txt)}',
    '.stq-row .m{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:6px;align-items:center}',
    '.stq-pill{display:inline-flex;align-items:center;min-height:24px;padding:0 9px;border-radius:999px;font-size:11px;font-weight:800;',
    'border:1px solid var(--q-line);color:var(--q-sub)}',
    '.stq-pill.act{color:#ffc45e;border-color:rgba(255,176,32,.35);background:rgba(255,176,32,.08)}',
    '.stq-pill.wait{color:var(--q-blue);border-color:rgba(100,180,255,.3);background:rgba(100,180,255,.08)}',
    '.stq-pill.bad{color:#ff8a8d;border-color:rgba(255,90,95,.35);background:rgba(255,90,95,.08)}',
    '.stq-pill.ok{color:var(--q-acc);border-color:rgba(113,255,0,.3);background:rgba(113,255,0,.08)}',
    '.stq-state{padding:34px 18px;text-align:center;color:var(--q-sub);border:1px dashed var(--q-line);border-radius:14px}',
    '.stq-state b{display:block;color:var(--q-txt);font-size:14.5px;margin-bottom:4px}',
    '.stq-err{color:#ff8a8d;font-size:12.5px;margin-top:8px}',
    '.stq-scrim{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:10050}',
    '.stq-drawer{position:fixed;top:0;right:0;bottom:0;width:min(560px,100%);z-index:10051;background:var(--q-bg);border-left:1px solid var(--q-line);',
    'display:flex;flex-direction:column;box-shadow:-20px 0 60px rgba(0,0,0,.5);animation:stqIn .18s ease both}',
    '@keyframes stqIn{from{transform:translateX(24px);opacity:0}to{transform:none;opacity:1}}',
    '@media (prefers-reduced-motion:reduce){.stq-drawer{animation:none}}',
    '.stq-dh{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--q-line)}',
    '.stq-dh .t{flex:1;min-width:0;font-weight:900;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.stq-x{width:44px;height:44px;border-radius:12px;border:1px solid var(--q-line);background:transparent;color:var(--q-txt);font-size:20px;cursor:pointer}',
    '.stq-db{flex:1;min-height:0;overflow-y:auto;padding:14px 16px}',
    '.stq-df{padding:12px 16px 16px;border-top:1px solid var(--q-line);display:grid;gap:8px}',
    '.stq-lbl{font-size:10.5px;font-weight:900;letter-spacing:.06em;text-transform:uppercase;color:var(--q-mut);margin:16px 0 6px}',
    '.stq-lbl:first-child{margin-top:0}',
    '.stq-box{padding:11px 12px;border-radius:12px;background:var(--q-card);border:1px solid var(--q-line);font-size:13px;white-space:pre-wrap;word-break:break-word}',
    '.stq-kv{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12.5px}.stq-kv span:nth-child(odd){color:var(--q-mut)}',
    '.stq-tl{list-style:none;margin:0;padding:0;display:grid;gap:8px}',
    '.stq-tl li{padding-left:14px;border-left:2px solid var(--q-line);font-size:12.5px}.stq-tl li small{display:block;color:var(--q-mut)}',
    '.stq-ta{width:100%;min-height:84px;padding:11px 12px;border-radius:12px;border:1px solid var(--q-line);background:rgba(255,255,255,.05);',
    'color:var(--q-txt);font:inherit;font-size:16px;resize:vertical}',
    '.stq-ta:focus{outline:none;border-color:rgba(113,255,0,.45)}',
    '.stq-fav{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
    '.stq-fav button{min-height:48px;border-radius:12px;border:1px solid var(--q-line);background:transparent;color:var(--q-sub);font:inherit;font-weight:800;cursor:pointer}',
    '.stq-fav button.on{border-color:rgba(113,255,0,.45);background:rgba(113,255,0,.1);color:var(--q-acc)}',
    '.stq-acts{display:flex;flex-wrap:wrap;gap:8px}',
    '.stq a{color:var(--q-acc)}',
  ].join('');

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function kes(n) { return typeof n === 'number' && isFinite(n) ? 'KES ' + n.toLocaleString('en-KE') : '—'; }
  function when(iso) {
    var ms = typeof iso === 'string' ? Date.parse(iso) : (iso && iso.seconds ? iso.seconds * 1000 : (iso && iso._seconds ? iso._seconds * 1000 : 0));
    if (!ms) return '—';
    var d = (Date.now() - ms) / 1000;
    if (d < 3600) return Math.max(1, Math.round(d / 60)) + ' min ago';
    if (d < 86400) return Math.round(d / 3600) + ' h ago';
    if (d < 86400 * 30) return Math.round(d / 86400) + ' d ago';
    return new Date(ms).toISOString().slice(0, 10);
  }
  function safeUrl(u) { return typeof u === 'string' && /^https:\/\//i.test(u) ? u : null; }
  function unwrap(r) { return r && typeof r === 'object' && 'data' in r && r.data && typeof r.data === 'object' ? r.data : r; }
  function errMsg(e, fallback) {
    var m = e && (e.message || e.code);
    return m && !/^internal$/i.test(m) ? String(m).replace(/^FirebaseError:\s*/, '') : fallback;
  }

  function mount(host, ctx) {
    if (!host) throw new Error('trust queues: host is required');
    ctx = ctx || {};
    if (typeof ctx.callable !== 'function') throw new Error('trust queues: callable is required');
    var doc = host.ownerDocument || document;
    if (!doc.getElementById('stq-css')) { var st = doc.createElement('style'); st.id = 'stq-css'; st.textContent = CSS; doc.head.appendChild(st); }
    var call = function (fn, payload) { return Promise.resolve(ctx.callable(fn)(payload || {})).then(unwrap); };
    var toast = function (m, k) { try { if (ctx.onToast) ctx.onToast(m, k); } catch (_) {} };

    var S = {
      view: ctx.view === 'reports' ? 'reports' : 'disputes',
      dFilter: 'active', rKind: 'listings', rFilter: 'pending', cFilter: 'pending',
      phase: 'loading', rows: [], error: null,
      open: null, detail: null, detailErr: null, busy: false, opErr: null,
      form: { favorBuyer: null, note: '', action: null },
    };
    var el = doc.createElement('div'); el.className = 'stq'; host.innerHTML = ''; host.appendChild(el);
    var lastFocus = null;

    function load() {
      S.phase = 'loading'; S.error = null; paint();
      var p;
      if (S.view === 'disputes') p = call('adminOsDispatch', { op: 'adminGetDisputes', status: S.dFilter, limit: 150 }).then(function (d) { return d.disputes || []; });
      else if (S.rKind === 'listings') p = call('tsGetReports', { status: S.rFilter, limit: 100 }).then(function (d) { return d.reports || []; });
      else p = call('messagesDispatch', { op: 'adminGetReports', status: S.cFilter }).then(function (d) { return d.reports || []; });
      return p.then(function (rows) { S.rows = rows; S.phase = 'ready'; paint(); })
        .catch(function (e) { S.phase = 'error'; S.error = errMsg(e, 'The queue could not be loaded.'); paint(); });
    }

    function chips(list, cur, act) {
      return '<div class="stq-chips" role="tablist">' + list.map(function (f) {
        return '<button class="stq-chip' + (f[0] === cur ? ' on' : '') + '" role="tab" aria-selected="' + (f[0] === cur) + '" data-act="' + act + '" data-v="' + f[0] + '">' + esc(f[1]) + '</button>';
      }).join('') + '</div>';
    }

    function topHTML() {
      var h = '';
      if (S.view === 'reports') {
        h += '<div class="stq-seg" role="tablist"><button class="' + (S.rKind === 'listings' ? 'on' : '') + '" data-act="kind" data-v="listings">Listings &amp; users</button>' +
          '<button class="' + (S.rKind === 'conversations' ? 'on' : '') + '" data-act="kind" data-v="conversations">Conversations</button></div>';
      }
      var f = S.view === 'disputes' ? chips(D_FILTERS, S.dFilter, 'dfilter')
        : S.rKind === 'listings' ? chips(R_FILTERS, S.rFilter, 'rfilter') : chips(C_FILTERS, S.cFilter, 'cfilter');
      return h + '<div class="stq-top">' + f + '<button class="stq-btn" data-act="refresh" aria-label="Refresh">↻ Refresh</button></div>';
    }

    function listHTML() {
      if (S.phase === 'loading') return '<div class="stq-state" aria-live="polite">Loading…</div>';
      if (S.phase === 'error') return '<div class="stq-state" role="alert"><b>Could not load this queue</b>' + esc(S.error) +
        '<div style="margin-top:12px"><button class="stq-btn" data-act="refresh">Try again</button></div></div>';
      if (!S.rows.length) return '<div class="stq-state"><b>' + (S.view === 'disputes' ? 'No disputes here' : 'No reports here') + '</b>Nothing matches this filter.</div>';
      return '<div class="stq-list">' + S.rows.map(function (r, i) {
        if (S.view === 'disputes') {
          var st = D_STATUS[r.status] || { l: r.status || '—', t: '' };
          return '<button class="stq-row" data-act="open" data-i="' + i + '">' +
            '<span class="t">' + esc(REASONS[r.reason] || r.reason || 'Dispute') + ' · #' + esc(String(r.orderId || r.id).slice(-8)) + '</span>' +
            '<span class="a">' + kes(r.amount) + '</span>' +
            '<span class="s">' + esc(r.buyerName || r.buyerId || '—') + ' → ' + esc(r.sellerName || r.sellerId || '—') + '</span>' +
            '<span class="m"><span class="stq-pill ' + st.t + '">' + esc(st.l) + '</span>' +
              (r.sellerResponse ? '<span class="stq-pill">Seller replied</span>' : '') +
              (r.evidenceCount ? '<span class="stq-pill">' + r.evidenceCount + ' evidence</span>' : '') +
              '<span class="stq-pill">' + esc(when(r.createdAt)) + '</span></span></button>';
        }
        if (S.rKind === 'listings') {
          var c = r.context || {};
          return '<button class="stq-row" data-act="open" data-i="' + i + '">' +
            '<span class="t">' + esc(r.entityType === 'product' ? (c.productName || r.entityId) : (r.entityType || 'report') + ' · ' + (r.entityId || '')) + '</span>' +
            '<span class="a">' + esc(r.severity || '') + '</span>' +
            '<span class="s">' + esc(r.reason || '—') + (r.detail ? ' — ' + esc(r.detail) : '') + '</span>' +
            '<span class="m"><span class="stq-pill">' + esc(r.entityType || '—') + '</span>' +
              (r.entityType === 'product' ? '<span class="stq-pill ' + (c.isVisible === false || r.productHidden ? 'bad' : 'ok') + '">' + (c.isVisible === false || r.productHidden ? 'hidden' : 'live') + '</span>' : '') +
              '<span class="stq-pill">' + esc(when(r.createdAt)) + '</span></span></button>';
        }
        return '<button class="stq-row" data-act="open" data-i="' + i + '">' +
          '<span class="t">Conversation · ' + esc(String(r.conversationId || '').slice(0, 40)) + '</span><span class="a"></span>' +
          '<span class="s">' + esc(r.reason || '—') + (r.details ? ' — ' + esc(r.details) : '') + '</span>' +
          '<span class="m"><span class="stq-pill">' + esc(r.status || '—') + '</span><span class="stq-pill">' + esc(when(r.createdAt)) + '</span></span></button>';
      }).join('') + '</div>';
    }

    /* ── drawer ── */
    function drawerHTML() {
      if (!S.open) return '';
      var body = '', foot = '', title = '';
      var r = S.open;
      if (S.view === 'disputes') {
        title = 'Dispute · #' + String(r.orderId || r.id).slice(-8);
        var d = S.detail;
        if (S.detailErr) body = '<div class="stq-state" role="alert"><b>Could not load the dispute</b>' + esc(S.detailErr) + '</div>';
        else if (!d) body = '<div class="stq-state" aria-live="polite">Loading…</div>';
        else {
          var st = D_STATUS[d.status] || { l: d.status, t: '' };
          body = '<div class="stq-lbl">Status</div><span class="stq-pill ' + st.t + '">' + esc(st.l) + '</span>' +
            (d.resolution ? '<div class="stq-box" style="margin-top:8px">' + esc(d.resolution) + (d.favorBuyer === true ? '\n— in the buyer\'s favour' : d.favorBuyer === false ? '\n— in the seller\'s favour' : '') + '</div>' : '') +
            '<div class="stq-lbl">Parties</div><div class="stq-kv"><span>Buyer</span><span>' + esc(d.buyerName || '—') + ' <small style="color:var(--q-mut)">' + esc(d.buyerId || '') + '</small></span>' +
            '<span>Seller</span><span>' + esc(d.sellerName || '—') + ' <small style="color:var(--q-mut)">' + esc(d.sellerId || '') + '</small></span>' +
            '<span>Order</span><span>' + esc(d.orderId || '—') + '</span><span>Amount</span><span>' + kes(d.amount) + '</span>' +
            (d.orderSnapshot ? '<span>Order state</span><span>' + esc([d.orderSnapshot.status, d.orderSnapshot.deliveryStatus].filter(Boolean).join(' · ') || '—') + '</span>' : '') + '</div>' +
            '<div class="stq-lbl">Buyer\'s complaint — ' + esc(REASONS[d.reason] || d.reason || '') + '</div><div class="stq-box">' + esc(d.description || '—') + '</div>' +
            '<div class="stq-lbl">Seller\'s response</div><div class="stq-box">' + (d.sellerResponse ? esc(d.sellerResponse) : '<span style="color:var(--q-mut)">No response yet.</span>') + '</div>' +
            '<div class="stq-lbl">Evidence (' + (d.evidence || []).length + ')</div>' +
            ((d.evidence || []).length ? '<ul class="stq-tl">' + d.evidence.map(function (e) {
              var u = safeUrl(e.fileUrl || e.url);
              return '<li>' + esc(e.type || 'evidence') + ' — ' + esc(e.description || e.label || '') + (u ? ' · <a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">open</a>' : '') +
                '<small>' + esc(e.addedByRole || '') + ' · ' + esc(when(e.addedAt)) + '</small></li>';
            }).join('') + '</ul>' : '<div class="stq-box" style="color:var(--q-mut)">None submitted.</div>') +
            '<div class="stq-lbl">Timeline</div><ul class="stq-tl">' + (d.timeline || []).map(function (t) {
              return '<li>' + esc(t.note || t.event || '') + '<small>' + esc(t.actorRole || '') + ' · ' + esc(when(t.ts)) + '</small></li>';
            }).join('') + '</ul>';
          if (d.open) {
            foot = '<div class="stq-fav" role="group" aria-label="Decide in favour of">' +
                '<button data-act="fav" data-v="buyer" class="' + (S.form.favorBuyer === true ? 'on' : '') + '">Buyer\'s favour</button>' +
                '<button data-act="fav" data-v="seller" class="' + (S.form.favorBuyer === false ? 'on' : '') + '">Seller\'s favour</button></div>' +
              '<label class="stq-lbl" for="stqNote" style="margin:4px 0 0">Resolution note (required — the parties see the timeline)</label>' +
              '<textarea id="stqNote" class="stq-ta" maxlength="1000" placeholder="What you found and what happens next">' + esc(S.form.note) + '</textarea>' +
              (S.opErr ? '<div class="stq-err" role="alert">' + esc(S.opErr) + '</div>' : '') +
              '<div class="stq-acts"><button class="stq-btn solid" data-act="resolve"' + (S.busy ? ' disabled' : '') + '>' + (S.busy ? 'Saving…' : 'Resolve') + '</button>' +
                (d.status !== 'investigating' ? '<button class="stq-btn warn" data-act="d-investigate"' + (S.busy ? ' disabled' : '') + '>Mark investigating</button>' : '') +
                '<button class="stq-btn bad" data-act="d-close"' + (S.busy ? ' disabled' : '') + '>Close without decision</button></div>';
          }
        }
      } else if (S.rKind === 'listings') {
        var c = r.context || {};
        title = 'Report · ' + (r.entityType || '');
        body = '<div class="stq-lbl">Reported</div><div class="stq-kv"><span>Type</span><span>' + esc(r.entityType || '—') + '</span>' +
          (r.entityType === 'product' ? '<span>Product</span><span><a href="product.html?id=' + encodeURIComponent(r.entityId || '') + '" target="_blank" rel="noopener">' + esc(c.productName || r.entityId || '—') + '</a></span>' +
            '<span>Seller</span><span>' + esc(c.sellerUid || '—') + '</span><span>Price</span><span>' + (c.price != null ? kes(Number(c.price)) : '—') + '</span>' +
            '<span>State</span><span>' + (c.isVisible === false || r.productHidden ? 'hidden' : 'live') + '</span>' : '<span>Id</span><span>' + esc(r.entityId || '—') + '</span>') +
          '<span>Severity</span><span>' + esc(r.severity || '—') + '</span><span>Status</span><span>' + esc(r.status || '—') + '</span></div>' +
          '<div class="stq-lbl">Reason</div><div class="stq-box">' + esc(r.reason || '—') + (r.detail ? '\n\n' + esc(r.detail) : '') + '</div>' +
          (r.resolution ? '<div class="stq-lbl">Outcome</div><div class="stq-box">' + esc(r.resolution) + '</div>' : '');
        if (r.status === 'pending' || r.status === 'escalated') {
          foot = '<label class="stq-lbl" for="stqNote" style="margin:0">Note (recorded on the report; the seller sees it on an actioned product report)</label>' +
            '<textarea id="stqNote" class="stq-ta" maxlength="500">' + esc(S.form.note) + '</textarea>' +
            (S.opErr ? '<div class="stq-err" role="alert">' + esc(S.opErr) + '</div>' : '') +
            '<div class="stq-acts"><button class="stq-btn" data-act="r-dismiss"' + (S.busy ? ' disabled' : '') + '>Dismiss</button>' +
            (r.status !== 'escalated' ? '<button class="stq-btn warn" data-act="r-escalate"' + (S.busy ? ' disabled' : '') + '>Escalate</button>' : '') +
            '<button class="stq-btn bad" data-act="r-approve"' + (S.busy ? ' disabled' : '') + '>Action</button>' +
            (r.entityType === 'product' ? '<button class="stq-btn bad" data-act="r-takedown"' + (S.busy ? ' disabled' : '') + '>Take product down</button>' : '') + '</div>';
        }
      } else {
        title = 'Conversation report';
        body = '<div class="stq-kv"><span>Conversation</span><span>' + esc(r.conversationId || '—') + '</span><span>Status</span><span>' + esc(r.status || '—') + '</span>' +
          (r.action ? '<span>Action</span><span>' + esc(r.action) + '</span>' : '') + '</div>' +
          '<div class="stq-lbl">Reason</div><div class="stq-box">' + esc(r.reason || '—') + (r.details ? '\n\n' + esc(r.details) : '') + '</div>';
        if (r.status === 'pending') {
          foot = '<label class="stq-lbl" for="stqNote" style="margin:0">Note</label><textarea id="stqNote" class="stq-ta" maxlength="500">' + esc(S.form.note) + '</textarea>' +
            (S.opErr ? '<div class="stq-err" role="alert">' + esc(S.opErr) + '</div>' : '') +
            '<div class="stq-acts"><button class="stq-btn" data-act="c-dismiss"' + (S.busy ? ' disabled' : '') + '>Dismiss</button>' +
            '<button class="stq-btn warn" data-act="c-warn"' + (S.busy ? ' disabled' : '') + '>Warn the parties</button>' +
            '<button class="stq-btn bad" data-act="c-suspend"' + (S.busy ? ' disabled' : '') + '>Suspend conversation</button></div>';
        }
      }
      return '<div class="stq-scrim" data-act="close"></div><div class="stq-drawer" role="dialog" aria-modal="true" aria-label="' + esc(title) + '">' +
        '<div class="stq-dh"><div class="t">' + esc(title) + '</div><button class="stq-x" data-act="close" aria-label="Close">×</button></div>' +
        '<div class="stq-db">' + body + '</div>' + (foot ? '<div class="stq-df">' + foot + '</div>' : '') + '</div>';
    }

    function paint() {
      var ta = el.querySelector('#stqNote'); if (ta) S.form.note = ta.value;
      el.innerHTML = topHTML() + listHTML() + drawerHTML();
    }

    function openRow(i) {
      var r = S.rows[i]; if (!r) return;
      lastFocus = doc.activeElement;
      S.open = r; S.detail = null; S.detailErr = null; S.opErr = null; S.busy = false; S.form = { favorBuyer: null, note: '', action: null };
      paint();
      var x = el.querySelector('.stq-x'); if (x) x.focus();
      if (S.view === 'disputes') {
        call('adminOsDispatch', { op: 'adminGetDisputeDetail', disputeId: r.id }).then(function (d) {
          if (S.open !== r) return; S.detail = d.dispute || null; if (!S.detail) S.detailErr = 'The dispute was not returned.'; paint();
        }).catch(function (e) { if (S.open !== r) return; S.detailErr = errMsg(e, 'The dispute could not be loaded.'); paint(); });
      }
    }
    function close() {
      if (S.busy) return;
      S.open = null; S.detail = null; paint();
      if (lastFocus && lastFocus.focus) try { lastFocus.focus(); } catch (_) {}
    }

    function run(promise, okMsg) {
      S.busy = true; S.opErr = null; paint();
      return promise.then(function () {
        S.busy = false; S.open = null; toast(okMsg, 'success'); return load();
      }).catch(function (e) { S.busy = false; S.opErr = errMsg(e, 'That did not work.'); paint(); });
    }

    function disputeAction(action) {
      var note = S.form.note.trim();
      if (action === 'resolved') {
        if (S.form.favorBuyer === null) { S.opErr = 'Choose whose favour the decision is in.'; paint(); return; }
        if (note.length < 2) { S.opErr = 'Write the resolution note first.'; paint(); return; }
      }
      if (action === 'closed' && note.length < 2) { S.opErr = 'Write why the dispute is closed.'; paint(); return; }
      var payload = { op: 'aosResolveDispute', disputeId: S.open.id, action: action, resolution: note };
      if (action === 'resolved') payload.favorBuyer = S.form.favorBuyer;
      run(call('adminOsDispatch', payload), action === 'resolved' ? 'Dispute resolved' : action === 'closed' ? 'Dispute closed' : 'Marked investigating');
    }

    el.addEventListener('input', function (ev) { if (ev.target && ev.target.id === 'stqNote') S.form.note = ev.target.value; });
    el.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && S.open) { ev.preventDefault(); close(); } });
    el.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-act]'); if (!b || !el.contains(b) || b.disabled) return;
      var act = b.getAttribute('data-act'), v = b.getAttribute('data-v');
      if (act === 'dfilter') { S.dFilter = v; load(); }
      else if (act === 'rfilter') { S.rFilter = v; load(); }
      else if (act === 'cfilter') { S.cFilter = v; load(); }
      else if (act === 'kind') { S.rKind = v; load(); }
      else if (act === 'refresh') load();
      else if (act === 'open') openRow(Number(b.getAttribute('data-i')));
      else if (act === 'close') close();
      else if (act === 'fav') { S.form.favorBuyer = v === 'buyer'; S.opErr = null; paint(); }
      else if (act === 'resolve') disputeAction('resolved');
      else if (act === 'd-investigate') disputeAction('investigating');
      else if (act === 'd-close') disputeAction('closed');
      else if (/^r-/.test(act)) {
        var a = { 'r-dismiss': 'dismiss', 'r-escalate': 'escalate', 'r-approve': 'approve', 'r-takedown': 'approve' }[act];
        run(call('tsReviewReport', { reportId: S.open.id, action: a, resolution: S.form.note.trim(), hideProduct: act === 'r-takedown' }),
          act === 'r-takedown' ? 'Report actioned — product taken down' : 'Report ' + ({ dismiss: 'dismissed', escalate: 'escalated', approve: 'actioned' })[a]);
      } else if (/^c-/.test(act)) {
        var ca = act.slice(2);
        run(call('messagesDispatch', { op: 'adminReviewReport', reportId: S.open.id, action: ca, note: S.form.note.trim() }),
          ca === 'suspend' ? 'Conversation suspended' : ca === 'warn' ? 'Parties warned' : 'Report dismissed');
      }
    });

    load();
    return { reload: load, state: function () { return S; }, destroy: function () { host.innerHTML = ''; } };
  }

  return { mount: mount, REASONS: REASONS, D_STATUS: D_STATUS };
}));
