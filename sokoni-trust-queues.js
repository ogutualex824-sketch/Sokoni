/* ════════════════════════════════════════════════════════════════════════════
   SOKONI Moderation — the ONE moderation workspace for AdminOS AND Super Admin
   (community C2 report queue → community C3 moderation queue, 2026-10-01)

   Mounted by both consoles — same module, same canonical state, two authorised views:
     admin-os.html    › Moderation   (#moderation — sokoni-aos.js _loadModeration)
     super-admin.html › Moderation   (SA.loadTrustQueue, section "trust")
   Every read and write is the ONE report authority (functions/trust-safety.js):
     queue   tsGetReports    { state | queueStatus, reason, seller, shop, product, assignee, from, to, sort,
                               groupBy:'listing', facts:true, limit, after }
     case    tsGetReportCase { reportId } → report, listing, every report on the listing, history, ALLOWED ACTIONS
     act     tsReviewReport  { reportId, action, resolution, internalNote, hideProduct, applyToListing,
                               restoreListing, requestId, expectedRevision }
     reasons tsGetReportReasons { entityType:'product' } (the reason filter — the server's list, no client copy)
   This file holds NO business state, NO reason list, NO transition table and NO status vocabulary of its own:
   the server derives queueStatus and the allowed actions; a status it does not recognise is shown as unknown and
   offers nothing. A decision is shown only after the server returns. A failed read says so — never an empty
   list, never 0 (an unknown count renders "—").

   mount(host, { console?: 'adminos'|'superadmin', call?: (fnName, payload) => Promise,
                 callable?: (fnName) => (payload) => Promise, onToast? }) → { reload, state, destroy }
   ════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SokoniTrustQueues = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* labels for the server's DERIVED queue status — display only */
  var QSTATUS = {
    open:              { l: 'Open',              t: 'act' },
    under_review:      { l: 'Under review',      t: 'wait' },
    escalated:         { l: 'Escalated',         t: 'act' },
    needs_information: { l: 'Needs information', t: 'wait' },
    upheld:            { l: 'Upheld',            t: 'bad' },
    dismissed:         { l: 'Dismissed',         t: '' },
    archived:          { l: 'Archived',          t: '' },
    removed:           { l: 'Removed',           t: '' },
  };
  /* C2 shared moderation states (kept for any caller that reads them) */
  var STATE = {
    pending:           { l: 'Pending review',    t: 'act' },
    approved:          { l: 'Upheld',            t: 'bad' },
    rejected:          { l: 'Dismissed',         t: '' },
    changes_requested: { l: 'Changes requested', t: 'wait' },
    archived:          { l: 'Archived',          t: '' },
    removed:           { l: 'Removed',           t: '' },
  };
  /* views: [key, label, payload] — "pending" is the C2 shared state (open + under review + escalated) */
  var VIEWS = [
    ['pending', 'Pending review', { state: 'pending' }],
    ['open', 'Open', { queueStatus: 'open' }],
    ['under_review', 'Under review', { queueStatus: 'under_review' }],
    ['escalated', 'Escalated', { queueStatus: 'escalated' }],
    ['needs_information', 'Needs information', { queueStatus: 'needs_information' }],
    ['upheld', 'Upheld', { queueStatus: 'upheld' }],
    ['dismissed', 'Dismissed', { queueStatus: 'dismissed' }],
    ['archived', 'Archived', { queueStatus: 'archived' }],
    ['removed', 'Removed', { queueStatus: 'removed' }],
  ];
  var SORTS = [['newest', 'Newest first'], ['oldest', 'Oldest first'], ['severity', 'Severity, then most reported'], ['reports', 'Most reported listing']];

  /* decisions — keys are the SERVER's action names (plus 'takedown' = approve + hideProduct). OFFERED only when the
     server lists the action for this report and this moderator (tsGetReportCase.actions). */
  var ACTION = {
    approve:         { l: 'Uphold',                        c: 'bad',  done: 'Report upheld' },
    takedown:        { l: 'Uphold + take listing down',    c: 'bad',  done: 'Report upheld — product taken down' },
    request_changes: { l: 'Request information',           c: 'warn', done: 'Information requested from the seller', note: 'seller' },
    dismiss:         { l: 'Dismiss',                       c: '',     done: 'Report dismissed' },
    escalate:        { l: 'Escalate',                      c: 'warn', done: 'Report escalated' },
    archive:         { l: 'Archive',                       c: '',     done: 'Report archived' },
    remove:          { l: 'Remove report',                 c: '',     done: 'Report removed', note: 'any' },
    reopen:          { l: 'Reopen',                        c: 'warn', done: 'Report reopened', note: 'internal10' },
  };
  /* review assignment — not a decision; never changes the report status */
  var ASSIGN = {
    claim:    { l: 'Take under review', done: 'You have this report under review' },
    takeover: { l: 'Take over review',  done: 'You have taken over this review' },
    unclaim:  { l: 'Release',           done: 'Report released back to the queue' },
  };
  /* kept for C2 callers: which decisions a C2 shared state could offer (the console now uses the SERVER list) */
  var OFFER = {
    pending: ['approve', 'takedown', 'request_changes', 'dismiss', 'escalate', 'archive', 'remove'],
    changes_requested: ['approve', 'takedown', 'dismiss', 'archive', 'remove'],
    approved: ['archive', 'remove', 'reopen'], rejected: ['archive', 'remove', 'reopen'], archived: ['remove', 'reopen'], removed: [],
  };
  var NETWORKY = /unavailable|deadline|network|internal|timeout|failed to fetch/i;

  var CSS = [
    '.stq{--q-bg:#0b0b0d;--q-card:#141418;--q-line:rgba(255,255,255,.09);--q-txt:#ececec;--q-sub:#9a9aa2;--q-mut:#6d6d75;',
    '--q-acc:#71ff00;--q-warn:#ffb020;--q-bad:#ff5a5f;--q-blue:#64b4ff;color:var(--q-txt);font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;position:relative}',
    '.stq *{box-sizing:border-box}',
    '.stq-top{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:10px}',
    '.stq-chips{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;flex:1;min-width:0}',
    '.stq-chips::-webkit-scrollbar{display:none}',
    '.stq-chip{flex:0 0 auto;min-height:44px;padding:0 14px;border-radius:999px;border:1px solid var(--q-line);background:transparent;',
    'color:var(--q-sub);font:inherit;font-size:12.5px;font-weight:700;cursor:pointer}',
    '.stq-chip.on{border-color:rgba(113,255,0,.45);background:rgba(113,255,0,.12);color:var(--q-acc)}',
    '.stq-chip:focus-visible,.stq-btn:focus-visible,.stq-row:focus-visible,.stq-x:focus-visible,.stq-in:focus-visible{outline:2px solid var(--q-acc);outline-offset:2px}',
    '.stq-filters{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-bottom:12px;padding:10px;border:1px solid var(--q-line);border-radius:14px}',
    '.stq-filters label{display:grid;gap:4px;font-size:11px;font-weight:800;color:var(--q-mut);text-transform:uppercase;letter-spacing:.04em}',
    '.stq-in{min-height:44px;width:100%;padding:0 10px;border-radius:10px;border:1px solid var(--q-line);background:rgba(255,255,255,.05);color:var(--q-txt);font:inherit;font-size:16px}',
    '.stq-chk{display:flex!important;align-items:center;gap:8px;text-transform:none!important;font-size:13px!important;color:var(--q-txt)!important;min-height:44px}',
    '.stq-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:44px;padding:0 14px;border-radius:11px;',
    'border:1px solid var(--q-line);background:rgba(255,255,255,.05);color:var(--q-txt);font:inherit;font-size:12.5px;font-weight:800;cursor:pointer;text-decoration:none}',
    '.stq-btn.bad{border-color:rgba(255,90,95,.4);color:#ff8a8d;background:rgba(255,90,95,.08)}',
    '.stq-btn.warn{border-color:rgba(255,176,32,.4);color:#ffc45e;background:rgba(255,176,32,.08)}',
    '.stq-btn.acc{border-color:rgba(113,255,0,.4);color:var(--q-acc);background:rgba(113,255,0,.08)}',
    '.stq-btn[disabled]{opacity:.5;cursor:default}',
    '.stq-list{display:grid;gap:8px}',
    '.stq-group{border:1px solid var(--q-line);border-radius:16px;padding:10px;display:grid;gap:8px}',
    '.stq-gh{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;font-weight:900;font-size:13.5px}',
    '.stq-row{display:grid;grid-template-columns:1fr auto;gap:6px 12px;padding:13px 14px;border-radius:14px;background:var(--q-card);',
    'border:1px solid var(--q-line);cursor:pointer;text-align:left;color:inherit;font:inherit;width:100%;min-height:44px}',
    '.stq-row:hover{border-color:rgba(255,255,255,.18)}',
    '.stq-row .t{font-weight:800;font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
    '.stq-row .s{grid-column:1/-1;font-size:12px;color:var(--q-sub);overflow:hidden;text-overflow:ellipsis}',
    '.stq-row .a{font-weight:900;color:var(--q-txt)}',
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
    '.stq-more{display:flex;justify-content:center;margin-top:12px;gap:10px;align-items:center;color:var(--q-sub);font-size:12px;flex-wrap:wrap}',
    '.stq-scrim{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:10050}',
    '.stq-drawer{position:fixed;top:0;right:0;bottom:0;width:min(640px,100%);z-index:10051;background:var(--q-bg);border-left:1px solid var(--q-line);',
    'display:flex;flex-direction:column;box-shadow:-20px 0 60px rgba(0,0,0,.5);animation:stqIn .18s ease both}',
    '@keyframes stqIn{from{transform:translateX(24px);opacity:0}to{transform:none;opacity:1}}',
    '@media (prefers-reduced-motion:reduce){.stq-drawer{animation:none}}',
    '.stq-dh{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--q-line)}',
    '.stq-dh .t{flex:1;min-width:0;font-weight:900;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.stq-x{width:44px;height:44px;border-radius:12px;border:1px solid var(--q-line);background:transparent;color:var(--q-txt);font-size:20px;cursor:pointer}',
    '.stq-db{flex:1;min-height:0;overflow-y:auto;padding:14px 16px}',
    '.stq-df{padding:12px 16px 16px;border-top:1px solid var(--q-line);display:grid;gap:8px;max-height:52vh;overflow-y:auto}',
    '.stq-lbl{display:block;font-size:10.5px;font-weight:900;letter-spacing:.06em;text-transform:uppercase;color:var(--q-mut);margin:16px 0 6px}',
    '.stq-lbl:first-child{margin-top:0}',
    '.stq-box{padding:11px 12px;border-radius:12px;background:var(--q-card);border:1px solid var(--q-line);font-size:13px;white-space:pre-wrap;word-break:break-word}',
    '.stq-kv{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12.5px;word-break:break-word}.stq-kv span:nth-child(odd){color:var(--q-mut)}',
    '.stq-imgs{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.stq-imgs img{width:84px;height:84px;object-fit:cover;border-radius:10px;border:1px solid var(--q-line);background:#222}',
    '.stq-tl{list-style:none;margin:0;padding:0;display:grid;gap:6px}.stq-tl li{padding:9px 11px;border-radius:11px;background:var(--q-card);border:1px solid var(--q-line);font-size:12.5px}',
    '.stq-tl .w{color:var(--q-mut);font-size:11.5px}',
    '.stq-ta{width:100%;min-height:72px;padding:11px 12px;border-radius:12px;border:1px solid var(--q-line);background:rgba(255,255,255,.05);',
    'color:var(--q-txt);font:inherit;font-size:16px;resize:vertical}',
    '.stq-ta:focus{outline:none;border-color:rgba(113,255,0,.45)}',
    '.stq-acts{display:flex;flex-wrap:wrap;gap:8px}',
    '.stq a{color:var(--q-acc)}',
  ].join('');

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function kes(n) { return typeof n === 'number' && isFinite(n) ? 'KES ' + n.toLocaleString('en-KE') : '—'; }
  function num(n) { return typeof n === 'number' && isFinite(n) ? String(n) : '—'; }   /* unknown is "—", never 0 */
  function msOf(r, isoKey, tsKey) {
    if (r && typeof r[isoKey] === 'string') { var p = Date.parse(r[isoKey]); if (p) return p; }
    var t = r && r[tsKey];
    return t && t.seconds ? t.seconds * 1000 : (t && t._seconds ? t._seconds * 1000 : 0);
  }
  function when(ms) {
    if (!ms) return '—';
    var d = (Date.now() - ms) / 1000;
    if (d < 3600) return Math.max(1, Math.round(d / 60)) + ' min ago';
    if (d < 86400) return Math.round(d / 3600) + ' h ago';
    if (d < 86400 * 30) return Math.round(d / 86400) + ' d ago';
    return new Date(ms).toISOString().slice(0, 10);
  }
  function whenIso(iso) { return when(Date.parse(iso) || 0); }
  function unwrap(r) { return r && typeof r === 'object' && 'data' in r && r.data && typeof r.data === 'object' ? r.data : r; }
  function errMsg(e, fallback) {
    var m = e && (e.message || e.code);
    return m && !/^internal$/i.test(m) ? String(m).replace(/^FirebaseError:\s*/, '') : fallback;
  }
  function https(u) { return typeof u === 'string' && /^https:\/\//.test(u) ? u : null; }
  function newRequestId() {
    var b = '';
    try { var a = new Uint8Array(12); (globalThis.crypto || window.crypto).getRandomValues(a); for (var i = 0; i < a.length; i++) b += ('0' + a[i].toString(16)).slice(-2); }
    catch (_) { b = (Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)).slice(0, 24); }
    return 'mq_' + b;
  }
  function qOf(r) { return (r && typeof r.queueStatus === 'string' && QSTATUS[r.queueStatus]) ? r.queueStatus : null; }   /* unknown stays unknown */
  function short(uid) { return uid ? String(uid).slice(0, 10) + (String(uid).length > 10 ? '…' : '') : '—'; }

  function mount(host, ctx) {
    if (!host) throw new Error('moderation: host is required');
    ctx = ctx || {};
    var raw = typeof ctx.call === 'function' ? function (fn, p) { return ctx.call(fn, p); }
      : (typeof ctx.callable === 'function' ? function (fn, p) { return ctx.callable(fn)(p); } : null);
    if (!raw) throw new Error('moderation: call (or callable) is required');
    var consoleName = ctx.console === 'superadmin' ? 'superadmin' : 'adminos';
    var doc = host.ownerDocument || document;
    if (!doc.getElementById('stq-css')) { var st = doc.createElement('style'); st.id = 'stq-css'; st.textContent = CSS; doc.head.appendChild(st); }
    var call = function (fn, payload) { return Promise.resolve(raw(fn, payload || {})).then(unwrap); };
    var toast = function (m, k) { try { if (ctx.onToast) ctx.onToast(m, k); } catch (_) {} };

    var S = {
      view: 'pending', filters: { reason: '', seller: '', shop: '', product: '', assignee: '', from: '', to: '' }, sort: 'newest', group: false,
      phase: 'loading', rows: [], groups: null, page: null, error: null, more: false,
      reasons: null, reasonsErr: false,
      open: null, kase: null, casePhase: 'idle', caseErr: null,
      busy: false, opErr: null, note: '', inote: '', applyAll: false, restore: false, intent: null,
    };
    var el = doc.createElement('div'); el.className = 'stq'; el.setAttribute('data-console', consoleName);
    host.innerHTML = ''; host.appendChild(el);
    var lastFocus = null;

    function query(after) {
      var v = VIEWS.filter(function (x) { return x[0] === S.view; })[0] || VIEWS[0];
      var p = Object.assign({}, v[2], { limit: 50, facts: true, sort: S.sort });
      var f = S.filters;
      ['reason', 'seller', 'shop', 'product', 'from', 'to'].forEach(function (k) { if (f[k] && String(f[k]).trim()) p[k] = String(f[k]).trim(); });
      if (f.assignee === 'me') p.assignee = 'me';
      if (S.group) p.groupBy = 'listing';
      if (after) p.after = after;
      return p;
    }
    function load(after) {
      if (!after) { S.phase = 'loading'; S.error = null; paint(); } else { S.more = true; paint(); }
      return call('tsGetReports', query(after)).then(function (d) {
        if (!d || !Array.isArray(d.reports)) throw new Error('The server returned no report list.');
        S.rows = after ? S.rows.concat(d.reports) : d.reports;
        S.groups = S.group ? regroup(S.rows) : null;
        S.page = d.page || null; S.phase = 'ready'; S.more = false; paint();
        if (!S.reasons && !S.reasonsErr) loadReasons();
      }).catch(function (e) {
        S.more = false;
        if (after) { S.opErr = errMsg(e, 'More reports could not be loaded.'); paint(); return; }
        S.phase = 'error'; S.error = errMsg(e, 'The queue could not be loaded.'); paint();
      });
    }
    function loadReasons() {
      return call('tsGetReportReasons', { entityType: 'product' }).then(function (d) {
        S.reasons = d && Array.isArray(d.reasons) ? d.reasons : []; paint();
      }).catch(function () { S.reasonsErr = true; paint(); });
    }
    /* group the CURRENT rows by listing (the server's groupBy covers one page; "load more" re-groups the union) */
    function regroup(rows) {
      var m = {}, order = [];
      rows.forEach(function (r) {
        var k = (r.entityType || '') + ':' + (r.entityId || '');
        if (!m[k]) { m[k] = { key: k, entityType: r.entityType, entityId: r.entityId, title: title(r), rows: [], facts: r.facts || null }; order.push(k); }
        m[k].rows.push(r);
      });
      return order.map(function (k) { return m[k]; });
    }

    function title(r) {
      var c = r.context || {};
      return r.entityType === 'product' ? (c.productName || r.entityId || 'Product') : (r.entityType || 'report') + ' · ' + (r.entityId || '');
    }
    function hidden(r) { var f = r.facts || {}; return f.listingVisible === false || r.productHidden === true; }

    function topHTML() {
      var chips = '<div class="stq-top"><div class="stq-chips" role="group" aria-label="Moderation queue views">' + VIEWS.map(function (f) {
        return '<button type="button" class="stq-chip' + (f[0] === S.view ? ' on' : '') + '" aria-pressed="' + (f[0] === S.view) + '" data-act="filter" data-v="' + f[0] + '">' + esc(f[1]) + '</button>';
      }).join('') + '</div><button type="button" class="stq-btn" data-act="refresh" aria-label="Refresh the moderation queue">↻ Refresh</button></div>';
      var reasonOpts = '<option value="">Any reason</option>' + (S.reasons || []).map(function (x) {
        return '<option value="' + esc(x.code) + '"' + (S.filters.reason === x.code ? ' selected' : '') + '>' + esc(x.label) + '</option>';
      }).join('');
      var fv = function (k) { return esc(S.filters[k] || ''); };
      var filters = '<form class="stq-filters" data-act="noop" aria-label="Filter the moderation queue" onsubmit="return false">' +
        '<label>Reason<select class="stq-in" data-f="reason">' + reasonOpts + '</select></label>' +
        '<label>Seller (uid)<input class="stq-in" data-f="seller" value="' + fv('seller') + '" autocomplete="off" maxlength="128"></label>' +
        '<label>Shop id<input class="stq-in" data-f="shop" value="' + fv('shop') + '" autocomplete="off" maxlength="128"></label>' +
        '<label>Product id<input class="stq-in" data-f="product" value="' + fv('product') + '" autocomplete="off" maxlength="128"></label>' +
        '<label>Reviewer<select class="stq-in" data-f="assignee"><option value="">Anyone</option><option value="me"' + (S.filters.assignee === 'me' ? ' selected' : '') + '>Assigned to me</option></select></label>' +
        '<label>From<input class="stq-in" type="date" data-f="from" value="' + fv('from') + '"></label>' +
        '<label>To<input class="stq-in" type="date" data-f="to" value="' + fv('to') + '"></label>' +
        '<label>Sort<select class="stq-in" data-f="sort">' + SORTS.map(function (s) { return '<option value="' + s[0] + '"' + (S.sort === s[0] ? ' selected' : '') + '>' + esc(s[1]) + '</option>'; }).join('') + '</select></label>' +
        '<label class="stq-chk"><input type="checkbox" data-f="group"' + (S.group ? ' checked' : '') + '> Group by listing</label>' +
        '<div style="display:flex;gap:8px;align-items:end"><button type="button" class="stq-btn acc" data-act="apply">Apply filters</button>' +
        '<button type="button" class="stq-btn" data-act="clear">Clear</button></div>' +
        (S.reasonsErr ? '<div class="stq-err" role="status">The reason list could not be loaded — filtering by reason is unavailable.</div>' : '') +
        '</form>';
      return chips + filters;
    }

    function rowHTML(r, i) {
      var q = qOf(r), s = QSTATUS[q] || { l: 'Unknown state', t: '' }, f = r.facts || {}, c = r.context || {};
      return '<button type="button" class="stq-row" data-act="open" data-i="' + i + '" aria-label="' + esc('Open report ' + (r.ref || '') + ' — ' + title(r)) + '">' +
        '<span class="t">' + esc(title(r)) + '</span>' +
        '<span class="a">' + esc(r.severity || '—') + '</span>' +
        '<span class="s">' + esc(r.reason || '—') + ' · ref ' + esc(r.ref || '—') + ' · listing ' + esc(r.entityId || '—') +
          ' · seller ' + esc(short(c.sellerUid)) + (c.shopId ? ' · shop ' + esc(c.shopId) : '') + '</span>' +
        '<span class="m"><span class="stq-pill ' + s.t + '">' + esc(s.l) + '</span>' +
          '<span class="stq-pill">' + esc(r.entityType || '—') + '</span>' +
          (r.entityType === 'product' ? '<span class="stq-pill ' + (f.listingVisible === null || f.listingVisible === undefined ? '' : (hidden(r) ? 'bad' : 'ok')) + '">' +
            (f.listingVisible === null || f.listingVisible === undefined ? (r.productHidden ? 'listing hidden' : 'listing —') : (hidden(r) ? 'listing hidden' : 'listing live')) + '</span>' : '') +
          '<span class="stq-pill" title="Reports on this listing (all states)">' + num(f.reportsOnListing) + ' on listing</span>' +
          (typeof f.upheldOnListing === 'number' && f.upheldOnListing > 0 ? '<span class="stq-pill bad">previously upheld ×' + f.upheldOnListing + '</span>' : '') +
          (typeof f.sellerUpheld === 'number' && f.sellerUpheld > 0 ? '<span class="stq-pill act">seller upheld ×' + f.sellerUpheld + '</span>' : '') +
          '<span class="stq-pill">' + (r.assignedTo ? 'reviewer ' + esc(short(r.assignedTo)) : 'unassigned') + '</span>' +
          '<span class="stq-pill">filed ' + esc(when(msOf(r, 'createdAtIso', 'createdAt'))) + '</span>' +
          (r.lastActionAtIso ? '<span class="stq-pill">last action ' + esc(whenIso(r.lastActionAtIso)) + '</span>' : '') +
        '</span></button>';
    }

    function listHTML() {
      if (S.phase === 'loading') return '<div class="stq-state" role="status">Loading…</div>';
      if (S.phase === 'error') return '<div class="stq-state" role="alert"><b>Could not load the report queue</b>' + esc(S.error) +
        '<div style="margin-top:12px"><button type="button" class="stq-btn" data-act="refresh">Try again</button></div></div>';
      if (!S.rows.length) {
        return '<div class="stq-state" role="status"><b>No reports here</b>Nothing in this view' +
          (S.page && S.page.hasMore ? ' on this page — the server scanned ' + num(S.page.scanned) + ' and has more.' : '.') + '</div>' + moreHTML();
      }
      var body;
      if (S.groups) {
        body = S.groups.map(function (g) {
          var f = g.facts || {};
          return '<section class="stq-group" aria-label="' + esc('Listing ' + g.title) + '"><div class="stq-gh">' + esc(g.title) +
            ' <span class="stq-pill">' + g.rows.length + ' in view</span><span class="stq-pill">' + num(f.reportsOnListing) + ' total · ' + num(f.openOnListing) + ' open</span></div>' +
            g.rows.map(function (r) { return rowHTML(r, S.rows.indexOf(r)); }).join('') + '</section>';
        }).join('');
      } else {
        body = S.rows.map(rowHTML).join('');
      }
      return '<div class="stq-list">' + body + '</div>' + moreHTML();
    }
    function moreHTML() {
      if (!S.page) return '';
      return '<div class="stq-more"><span>' + S.rows.length + ' shown · ' + num(S.page.scanned) + ' scanned on the last page</span>' +
        (S.page.hasMore ? '<button type="button" class="stq-btn" data-act="more"' + (S.more ? ' disabled' : '') + '>' + (S.more ? 'Loading…' : 'Load more') + '</button>' : '<span>End of the queue</span>') + '</div>';
    }

    function historyHTML(h) {
      if (!h || !h.length) return '<div class="stq-box">No history recorded.</div>';
      return '<ol class="stq-tl">' + h.map(function (x) {
        var what = x.action === 'report_filed' ? 'Report filed'
          : x.action === 'report_claimed' ? 'Taken under review' : x.action === 'report_unclaimed' ? 'Released'
          : x.action === 'report_reopened' ? 'Reopened' : 'Decision: ' + (x.decision || '—');
        return '<li><b>' + esc(what) + '</b>' + (x.from && x.result && x.from !== x.result ? ' · ' + esc(x.from) + ' → ' + esc(x.result) : '') +
          (x.enforcement && x.enforcement !== 'none' ? ' · <span class="stq-pill bad">' + esc(x.enforcement.replace(/_/g, ' ')) + '</span>' : '') +
          (x.groupSize > 1 ? ' · <span class="stq-pill">with ' + (x.groupSize - 1) + ' other report(s)</span>' : '') +
          '<div class="w">' + esc(x.at ? whenIso(x.at) : '—') + (x.performedBy ? ' · by ' + esc(short(x.performedBy)) + ' (' + esc(x.actorRole || 'admin') + ')' : '') + '</div>' +
          (x.resolution ? '<div>Outcome note: ' + esc(x.resolution) + '</div>' : '') +
          (x.internalNote ? '<div>Internal: ' + esc(x.internalNote) + '</div>' : '') + '</li>';
      }).join('') + '</ol>';
    }

    function notifHTML(n) {
      if (!n || (!n.seller && !n.reporter)) return '<div class="stq-box">No notification recorded for this report.</div>';
      var row = function (who, x) {
        if (!x) return '';
        var word = x.status === 'recorded' ? 'in-app recorded' + (x.delivery === 'background' ? ' (push/email delivery runs in the background)' : '')
          : x.status === 'deduped' ? 'already sent earlier (deduplicated)' : 'FAILED' + (x.reason ? ' — ' + x.reason : '');
        return '<span>' + esc(who) + '</span><span>' + esc(word) + '</span>';
      };
      return '<div class="stq-kv">' + row('Seller', n.seller) + row('Reporter', n.reporter) + '</div>';
    }

    function drawerHTML() {
      if (!S.open) return '';
      var r0 = S.open;
      var head = '<div class="stq-dh"><div class="t">' + esc('Report ' + (r0.ref || '') + ' · ' + title(r0)) + '</div><button type="button" class="stq-x" data-act="close" aria-label="Close">×</button></div>';
      if (S.casePhase === 'loading') return shell(head, '<div class="stq-state" role="status">Loading the case…</div>', '');
      if (S.casePhase === 'error') return shell(head, '<div class="stq-state" role="alert"><b>Could not load this report</b>' + esc(S.caseErr) +
        '<div style="margin-top:12px"><button type="button" class="stq-btn" data-act="reopen-case">Try again</button></div></div>', '');
      var K = S.kase || {}, r = K.report || r0, c = r.context || {}, p = K.product, q = qOf(r), s = QSTATUS[q] || { l: 'Unknown state', t: '' };
      var acts = Array.isArray(K.actions) ? K.actions : [];
      var body =
        '<div class="stq-lbl">Report</div><div class="stq-kv">' +
          '<span>Reference</span><span>' + esc(r.ref || '—') + '</span>' +
          '<span>Status</span><span><span class="stq-pill ' + s.t + '">' + esc(s.l) + '</span></span>' +
          '<span>Reason</span><span>' + esc(r.reason || '—') + (r.reasonCode ? ' (' + esc(r.reasonCode) + ')' : '') + '</span>' +
          '<span>Severity</span><span>' + esc(r.severity || '—') + '</span>' +
          '<span>Filed</span><span>' + esc(r.createdAtIso ? whenIso(r.createdAtIso) : when(msOf(r, 'createdAtIso', 'createdAt'))) + '</span>' +
          '<span>Reporter</span><span>' + esc(r.reportedBy || '—') + ' <span class="stq-pill">admins only — never shown to the seller</span></span>' +
          '<span>Reviewer</span><span>' + esc(r.assignedTo || 'unassigned') + '</span>' +
          '<span>Target</span><span>' + esc((K.target && K.target.type) || r.entityType || '—') + ' · ' + esc(r.entityId || '—') +
            (K.target && K.target.supported === false ? ' <span class="stq-pill bad">unsupported type — no action possible</span>' : '') + '</span>' +
        '</div>' +
        '<div class="stq-lbl">What the reporter wrote</div><div class="stq-box">' + esc(r.detail || '(no details)') + '</div>' +
        ((r.evidenceUrls || []).filter(https).length ? '<div class="stq-acts" style="margin-top:6px">' + r.evidenceUrls.filter(https).map(function (u, i) {
          return '<a class="stq-btn" href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">Evidence ' + (i + 1) + '</a>';
        }).join('') + '</div>' : '');
      if (r.entityType === 'product') {
        body += '<div class="stq-lbl">Listing</div>';
        if (!p) body += '<div class="stq-box">—</div>';
        else if (p.exists === false) body += '<div class="stq-box">This product no longer exists (' + esc(p.id) + ').</div>';
        else {
          body += '<div class="stq-kv">' +
            '<span>Title</span><span>' + esc(p.name || '—') + '</span>' +
            '<span>Category</span><span>' + esc(p.category || '—') + '</span>' +
            '<span>Price</span><span>' + kes(p.price) + '</span>' +
            '<span>Visibility</span><span>' + (p.isVisible ? '<span class="stq-pill ok">live</span>' : '<span class="stq-pill bad">hidden</span>') +
              (p.moderationHold ? ' held by moderation' + (p.moderationHold.reportId === r.id ? ' (this report)' : '') + ' · ' + esc(p.moderationHold.at ? whenIso(p.moderationHold.at) : '—') : '') + '</span>' +
            '<span>Listing state</span><span>' + esc(p.status || '—') + '</span>' +
            '<span>Seller</span><span>' + esc(p.sellerUid || c.sellerUid || '—') + '</span>' +
            '<span>Shop</span><span>' + esc((K.shop && K.shop.name) || p.shopId || '—') + '</span>' +
          '</div>' +
          (p.images && p.images.length ? '<div class="stq-imgs">' + p.images.filter(https).map(function (u) {
            return '<img src="' + esc(u) + '" alt="' + esc('Listing image — ' + (p.name || '')) + '" loading="lazy" referrerpolicy="no-referrer">';
          }).join('') + '</div>' : '') +
          '<div class="stq-acts" style="margin-top:8px"><a class="stq-btn" href="product.html?id=' + encodeURIComponent(p.id) + '" target="_blank" rel="noopener">View product</a>' +
          (p.sellerUid ? '<a class="stq-btn" href="seller-public.html?id=' + encodeURIComponent(p.sellerUid) + '" target="_blank" rel="noopener">View seller</a>' : '') +
          '<button type="button" class="stq-btn" data-act="history">View history</button></div>';
        }
      }
      var others = (K.reports || []).filter(function (x) { return !x.self; });
      body += '<div class="stq-lbl">All reports on this ' + (r.entityType === 'product' ? 'listing' : 'target') + ' (' + ((K.reports || []).length || 1) + ')</div>' +
        (others.length ? '<ol class="stq-tl">' + others.map(function (x) {
          var xs = QSTATUS[x.queueStatus] || { l: 'Unknown state', t: '' };
          return '<li><b>' + esc(x.reason || '—') + '</b> <span class="stq-pill ' + xs.t + '">' + esc(xs.l) + '</span><div class="w">' +
            esc(x.createdAtIso ? whenIso(x.createdAtIso) : '—') + ' · reporter ' + esc(short(x.reportedBy)) + ' · ref ' + esc(x.ref || '—') + '</div>' +
            (x.detail ? '<div>' + esc(x.detail) + '</div>' : '') + '</li>';
        }).join('') + '</ol>' : '<div class="stq-box">This is the only report on it.</div>');
      body += '<div class="stq-lbl">Decision</div><div class="stq-kv">' +
        '<span>Current</span><span>' + esc(s.l) + '</span>' +
        '<span>By</span><span>' + esc(r.reviewedBy || '—') + '</span>' +
        '<span>When</span><span>' + esc(r.reviewedAtIso ? whenIso(r.reviewedAtIso) : '—') + '</span>' +
        '<span>Outcome note</span><span>' + esc(r.resolution || '—') + '</span>' +
        '<span>Internal note</span><span>' + esc(r.internalNote || '—') + '</span>' +
        '<span>Listing</span><span>' + (r.productHidden ? 'taken down by moderation' : '—') + '</span>' +
        (r.escalation ? '<span>Escalated</span><span>by ' + esc(short(r.escalation.by)) + (r.escalation.note ? ' — ' + esc(r.escalation.note) : '') + ' · next: senior review</span>' : '') +
        '</div>' +
        '<div class="stq-lbl">Notifications</div>' + notifHTML(r.notifications) +
        '<div class="stq-lbl" id="stqHistory">History</div>' + historyHTML(K.history) +
        (K.listingHistory && K.listingHistory.length ? '<div class="stq-lbl">Moderation history of this listing</div>' + historyHTML(K.listingHistory) : '') +
        '<div class="stq-lbl">Seller response</div><div class="stq-box">' + (K.sellerResponse && K.sellerResponse.supported === false
          ? 'There is no in-app appeal on reports. The seller is told the outcome and pointed to SOKONI Support to dispute it.' : '—') + '</div>';

      var foot = '';
      if (acts.length) {
        var assign = acts.filter(function (a) { return ASSIGN[a]; });
        var dec = acts.filter(function (a) { return ACTION[a]; });
        var openN = typeof K.openOnListing === 'number' ? K.openOnListing : 0;
        foot = (assign.length ? '<div class="stq-acts">' + assign.map(function (a) {
            return '<button type="button" class="stq-btn acc" data-act="assign" data-v="' + a + '"' + (S.busy ? ' disabled' : '') + '>' + esc(ASSIGN[a].l) + '</button>';
          }).join('') + '</div>' : '') +
          (dec.length ? '<label class="stq-lbl" for="stqNote" style="margin:0">Message to the seller (shown on their listing once decided; required to request information)</label>' +
            '<textarea id="stqNote" class="stq-ta" data-f="note" maxlength="500">' + esc(S.note) + '</textarea>' +
            '<label class="stq-lbl" for="stqINote" style="margin:0">Internal note (moderators only — never sent to the seller)</label>' +
            '<textarea id="stqINote" class="stq-ta" data-f="inote" maxlength="1000">' + esc(S.inote) + '</textarea>' +
            (openN > 1 && (dec.indexOf('approve') >= 0 || dec.indexOf('dismiss') >= 0)
              ? '<label class="stq-chk"><input type="checkbox" data-f="applyAll"' + (S.applyAll ? ' checked' : '') + '> Apply an uphold / dismiss to all ' + openN + ' open reports on this listing (each keeps its own record)</label>' : '') +
            (K.listingHeldByThisReport && dec.indexOf('dismiss') >= 0
              ? '<label class="stq-chk"><input type="checkbox" data-f="restore"' + (S.restore ? ' checked' : '') + '> On dismiss, restore the listing this report took down</label>' : '') +
            '<div class="stq-acts">' + dec.map(function (a) {
              var A = ACTION[a];
              return '<button type="button" class="stq-btn ' + A.c + '" data-act="decide" data-v="' + a + '"' + (S.busy ? ' disabled' : '') + '>' + esc(A.l) + '</button>';
            }).join('') + '</div>' : '') +
          (S.opErr ? '<div class="stq-err" role="alert">' + esc(S.opErr) + '</div>' : '') +
          (S.busy ? '<div role="status" class="stq-err" style="color:var(--q-sub)">Saving…</div>' : '');
      } else if (!q) {
        foot = '<div class="stq-err" role="alert">This report is in a state this console does not recognise — no action is offered.</div>';
      } else {
        foot = '<div class="stq-err" role="status" style="color:var(--q-sub)">No action is available to you on this report' +
          (r.assignedTo ? ' — another moderator has it under review.' : '.') + '</div>' + (S.opErr ? '<div class="stq-err" role="alert">' + esc(S.opErr) + '</div>' : '');
      }
      return shell(head, body, foot);
    }
    function shell(head, body, foot) {
      return '<div class="stq-scrim" data-act="close"></div><div class="stq-drawer" role="dialog" aria-modal="true" aria-label="' + esc('Report ' + ((S.open && S.open.ref) || '')) + '">' +
        head + '<div class="stq-db">' + body + '</div>' + (foot ? '<div class="stq-df">' + foot + '</div>' : '') + '</div>';
    }

    function paint() {
      el.innerHTML = topHTML() + listHTML() + drawerHTML();
    }

    function openRow(i) {
      var r = S.rows[i]; if (!r) return;
      lastFocus = doc.activeElement;
      S.open = r; S.kase = null; S.opErr = null; S.busy = false; S.note = ''; S.inote = ''; S.applyAll = false; S.restore = false; S.intent = null;
      loadCase();
      var x = el.querySelector('.stq-x'); if (x) x.focus();
    }
    function loadCase() {
      if (!S.open) return Promise.resolve();
      S.casePhase = 'loading'; S.caseErr = null; paint();
      var id = S.open.id;
      return call('tsGetReportCase', { reportId: id }).then(function (k) {
        if (!S.open || S.open.id !== id) return;
        if (!k || !k.report) throw new Error('The server returned no case.');
        S.kase = k; S.casePhase = 'ready'; paint();
      }).catch(function (e) { if (!S.open || S.open.id !== id) return; S.casePhase = 'error'; S.caseErr = errMsg(e, 'The report could not be loaded.'); paint(); });
    }
    function close() {
      if (S.busy) return;
      S.open = null; S.kase = null; S.casePhase = 'idle'; paint();
      if (lastFocus && lastFocus.focus) try { lastFocus.focus(); } catch (_) {}
    }

    /* one requestId per intent: a retry after a network failure re-sends the SAME id, so the server replays the
       recorded outcome instead of deciding twice; a refusal or a success ends the intent */
    function intentFor(key) {
      if (!S.intent || S.intent.key !== key) S.intent = { key: key, id: newRequestId() };
      return S.intent.id;
    }
    function send(payload, done) {
      S.busy = true; S.opErr = null; paint();
      return call('tsReviewReport', payload).then(function (res) {
        S.busy = false; S.intent = null;
        var extra = res && res.resolvedReports > 1 ? ' (' + res.resolvedReports + ' reports on this listing)' : '';
        var enf = res && res.enforcement === 'listing_restored' ? ' — listing restored' : '';
        /* an uphold WITHOUT take-down can still report a hidden listing (already held by an earlier report) */
        var held = !payload.hideProduct && payload.action === 'approve' && res && res.productHidden ? ' — product taken down' : '';
        toast(done + extra + enf + held, 'success');
        var assignOnly = payload.action === 'claim' || payload.action === 'unclaim';
        if (assignOnly) { loadCase(); return load(); }
        S.open = null; S.kase = null; S.casePhase = 'idle';
        return load();
      }).catch(function (e) {
        S.busy = false;
        var m = errMsg(e, 'That did not work.');
        if (!NETWORKY.test(String((e && (e.code || e.message)) || ''))) S.intent = null;   /* a refusal ends the intent */
        S.opErr = m; paint();
      });
    }
    function assign(a) {
      if (!S.open || !ASSIGN[a] || S.busy) return;
      var action = a === 'takeover' ? 'claim' : a;
      var payload = { reportId: S.open.id, action: action, requestId: intentFor(S.open.id + ':' + a) };
      if (a === 'takeover') payload.takeover = true;
      return send(payload, ASSIGN[a].done);
    }
    function decide(a) {
      var A = ACTION[a]; if (!A || !S.open || S.busy) return;
      var note = S.note.trim(), inote = S.inote.trim();
      if (A.note === 'seller' && note.length < 2) { S.opErr = 'Write a note first — "' + A.l + '" needs a reason on record (the message to the seller).'; paint(); return; }
      if (A.note === 'any' && note.length < 2 && inote.length < 2) { S.opErr = 'Write a note first — "' + A.l + '" needs a reason on record.'; paint(); return; }
      if (A.note === 'internal10' && inote.length < 10) { S.opErr = 'Write an internal note (at least 10 characters) — "' + A.l + '" needs a reason on record.'; paint(); return; }
      var server = a === 'takedown' ? 'approve' : a;
      var K = S.kase || {};
      var payload = { reportId: S.open.id, action: server, resolution: note, internalNote: inote, hideProduct: a === 'takedown',
        requestId: intentFor(S.open.id + ':' + a) };
      if (K.report && typeof K.report.revision === 'number') payload.expectedRevision = K.report.revision;
      if (S.applyAll && (server === 'approve' || server === 'dismiss')) payload.applyToListing = true;
      if (S.restore && server === 'dismiss') payload.restoreListing = true;
      return send(payload, A.done);
    }

    function readField(t) {
      var k = t && t.getAttribute && t.getAttribute('data-f'); if (!k) return false;
      if (k === 'note') S.note = t.value || '';
      else if (k === 'inote') S.inote = t.value || '';
      else if (k === 'applyAll') S.applyAll = !!t.checked;
      else if (k === 'restore') S.restore = !!t.checked;
      else if (k === 'group') S.group = !!t.checked;
      else if (k === 'sort') S.sort = t.value || 'newest';
      else if (k in S.filters) S.filters[k] = t.value || '';
      return true;
    }
    el.addEventListener('input', function (ev) { readField(ev.target); });
    el.addEventListener('change', function (ev) { readField(ev.target); });
    el.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && S.open) { ev.preventDefault(); close(); } });
    el.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-act]'); if (!b || !el.contains(b) || b.disabled) return;
      var act = b.getAttribute('data-act'), v = b.getAttribute('data-v');
      if (act === 'filter') { S.view = v; load(); }
      else if (act === 'refresh' || act === 'apply') load();
      else if (act === 'clear') { S.filters = { reason: '', seller: '', shop: '', product: '', assignee: '', from: '', to: '' }; S.sort = 'newest'; S.group = false; load(); }
      else if (act === 'more') { if (S.page && S.page.nextCursor) load(S.page.nextCursor); }
      else if (act === 'open') openRow(Number(b.getAttribute('data-i')));
      else if (act === 'close') close();
      else if (act === 'reopen-case') loadCase();
      else if (act === 'history') { var h = el.querySelector('#stqHistory'); if (h && h.scrollIntoView) h.scrollIntoView({ block: 'start' }); }
      else if (act === 'assign') assign(v);
      else if (act === 'decide') decide(v);
    });

    load();
    return { reload: load, state: function () { return S; }, destroy: function () { host.innerHTML = ''; } };
  }

  return { mount: mount, STATE: STATE, QSTATUS: QSTATUS, VIEWS: VIEWS, OFFER: OFFER, ACTION: ACTION, ASSIGN: ASSIGN };
}));
