/* ════════════════════════════════════════════════════════════════════════════
   SOKONI Trust Queues — the content-report queue for AdminOS AND Super Admin
   (ported from ec40b9b, REPORTS ONLY — community C2, 2026-10-01)

   ONE admin surface, mounted by both hosts:
     admin-os.html    › Fraud & Trust › Reports Queue   (sokoni-aos.js viewReports)
     super-admin.html › Trust reports                    (SA.loadTrustQueue)
   Every read and write is the ONE report authority (functions/trust-safety.js):
     list    tsGetReports  { state }                     — admin only
     decide  tsReviewReport { reportId, action, resolution, hideProduct }
   This file holds no business state, no reason list and no transition table: the server decides what is allowed and
   its refusal is shown as it is. A state change is shown only after the server returns. A failed read says so —
   never an empty list, never 0.

   SHARED MODERATION STATES (the server maps its stored statuses in ONE place — REPORT_STATE in trust-safety.js):
     pending (incl. escalated) → approved (= upheld) | rejected (= dismissed) | changes_requested | archived | removed

   NOT ported from ec40b9b (listed in CHANGELOG): the disputes view (it needs ec40b9b's adminOsDispatch dispute ops,
   which are not deployed) and the conversation-report segment (messagesDispatch / moderationQueue — a separate store).

   mount(host, { callable: (fnName) => (payload) => Promise, onToast? }) → { reload, state, destroy }
   ════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SokoniTrustQueues = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* labels for the server's shared states — display only */
  var STATE = {
    pending:           { l: 'Pending review',    t: 'act' },
    approved:          { l: 'Upheld',            t: 'bad' },
    rejected:          { l: 'Dismissed',         t: '' },
    changes_requested: { l: 'Changes requested', t: 'wait' },
    archived:          { l: 'Archived',          t: '' },
    removed:           { l: 'Removed',           t: '' },
  };
  var FILTERS = [['pending', 'Pending'], ['changes_requested', 'Changes requested'], ['approved', 'Upheld'],
    ['rejected', 'Dismissed'], ['archived', 'Archived'], ['removed', 'Removed']];

  /* which decision buttons to OFFER per state. The server is the authority (REPORT_TRANSITIONS); this only avoids
     offering a button that is certain to be refused. */
  var OFFER = {
    pending:           ['approve', 'takedown', 'request_changes', 'dismiss', 'escalate', 'archive', 'remove'],
    changes_requested: ['approve', 'takedown', 'dismiss', 'archive', 'remove'],
    approved:          ['archive', 'remove'],
    rejected:          ['archive', 'remove'],
    archived:          ['remove'],
    removed:           [],
  };
  var ACTION = {
    approve:         { l: 'Uphold',                    c: 'bad',   done: 'Report upheld' },
    takedown:        { l: 'Uphold + take product down', c: 'bad',  done: 'Report upheld — product taken down' },
    request_changes: { l: 'Request changes',           c: 'warn',  done: 'Changes requested', note: true },
    dismiss:         { l: 'Dismiss',                   c: '',      done: 'Report dismissed' },
    escalate:        { l: 'Escalate',                  c: 'warn',  done: 'Report escalated' },
    archive:         { l: 'Archive',                   c: '',      done: 'Report archived' },
    remove:          { l: 'Remove report',             c: '',      done: 'Report removed', note: true },
  };

  var CSS = [
    '.stq{--q-bg:#0b0b0d;--q-card:#141418;--q-line:rgba(255,255,255,.09);--q-txt:#ececec;--q-sub:#9a9aa2;--q-mut:#6d6d75;',
    '--q-acc:#71ff00;--q-warn:#ffb020;--q-bad:#ff5a5f;--q-blue:#64b4ff;color:var(--q-txt);font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;position:relative}',
    '.stq *{box-sizing:border-box}',
    '.stq-top{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:12px}',
    '.stq-chips{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;flex:1;min-width:0}',
    '.stq-chips::-webkit-scrollbar{display:none}',
    '.stq-chip{flex:0 0 auto;min-height:44px;padding:0 14px;border-radius:999px;border:1px solid var(--q-line);background:transparent;',
    'color:var(--q-sub);font:inherit;font-size:12.5px;font-weight:700;cursor:pointer}',
    '.stq-chip.on{border-color:rgba(113,255,0,.45);background:rgba(113,255,0,.12);color:var(--q-acc)}',
    '.stq-chip:focus-visible,.stq-btn:focus-visible,.stq-row:focus-visible,.stq-x:focus-visible{outline:2px solid var(--q-acc);outline-offset:2px}',
    '.stq-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:44px;padding:0 14px;border-radius:11px;',
    'border:1px solid var(--q-line);background:rgba(255,255,255,.05);color:var(--q-txt);font:inherit;font-size:12.5px;font-weight:800;cursor:pointer}',
    '.stq-btn.bad{border-color:rgba(255,90,95,.4);color:#ff8a8d;background:rgba(255,90,95,.08)}',
    '.stq-btn.warn{border-color:rgba(255,176,32,.4);color:#ffc45e;background:rgba(255,176,32,.08)}',
    '.stq-btn[disabled]{opacity:.5;cursor:default}',
    '.stq-list{display:grid;gap:8px}',
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
    '.stq-lbl{display:block;font-size:10.5px;font-weight:900;letter-spacing:.06em;text-transform:uppercase;color:var(--q-mut);margin:16px 0 6px}',
    '.stq-lbl:first-child{margin-top:0}',
    '.stq-box{padding:11px 12px;border-radius:12px;background:var(--q-card);border:1px solid var(--q-line);font-size:13px;white-space:pre-wrap;word-break:break-word}',
    '.stq-kv{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12.5px;word-break:break-word}.stq-kv span:nth-child(odd){color:var(--q-mut)}',
    '.stq-ta{width:100%;min-height:84px;padding:11px 12px;border-radius:12px;border:1px solid var(--q-line);background:rgba(255,255,255,.05);',
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
  function unwrap(r) { return r && typeof r === 'object' && 'data' in r && r.data && typeof r.data === 'object' ? r.data : r; }
  function errMsg(e, fallback) {
    var m = e && (e.message || e.code);
    return m && !/^internal$/i.test(m) ? String(m).replace(/^FirebaseError:\s*/, '') : fallback;
  }
  function stateOf(r) { return (r && typeof r.moderationState === 'string') ? r.moderationState : null; }   /* unknown stays unknown */

  function mount(host, ctx) {
    if (!host) throw new Error('trust queues: host is required');
    ctx = ctx || {};
    if (typeof ctx.callable !== 'function') throw new Error('trust queues: callable is required');
    var doc = host.ownerDocument || document;
    if (!doc.getElementById('stq-css')) { var st = doc.createElement('style'); st.id = 'stq-css'; st.textContent = CSS; doc.head.appendChild(st); }
    var call = function (fn, payload) { return Promise.resolve(ctx.callable(fn)(payload || {})).then(unwrap); };
    var toast = function (m, k) { try { if (ctx.onToast) ctx.onToast(m, k); } catch (_) {} };

    var S = { filter: 'pending', phase: 'loading', rows: [], error: null, open: null, busy: false, opErr: null, note: '' };
    var el = doc.createElement('div'); el.className = 'stq'; host.innerHTML = ''; host.appendChild(el);
    var lastFocus = null;

    function load() {
      S.phase = 'loading'; S.error = null; paint();
      return call('tsGetReports', { state: S.filter, limit: 100 }).then(function (d) {
        if (!d || !Array.isArray(d.reports)) throw new Error('The server returned no report list.');
        S.rows = d.reports; S.phase = 'ready'; paint();
      }).catch(function (e) { S.phase = 'error'; S.error = errMsg(e, 'The queue could not be loaded.'); paint(); });
    }

    function topHTML() {
      return '<div class="stq-top"><div class="stq-chips" role="group" aria-label="Filter reports by state">' + FILTERS.map(function (f) {
        return '<button type="button" class="stq-chip' + (f[0] === S.filter ? ' on' : '') + '" aria-pressed="' + (f[0] === S.filter) + '" data-act="filter" data-v="' + f[0] + '">' + esc(f[1]) + '</button>';
      }).join('') + '</div><button type="button" class="stq-btn" data-act="refresh" aria-label="Refresh the report queue">↻ Refresh</button></div>';
    }

    function title(r) {
      var c = r.context || {};
      return r.entityType === 'product' ? (c.productName || r.entityId || 'Product') : (r.entityType || 'report') + ' · ' + (r.entityId || '');
    }
    function hidden(r) { var c = r.context || {}; return c.isVisible === false || r.productHidden === true; }

    function listHTML() {
      if (S.phase === 'loading') return '<div class="stq-state" role="status">Loading…</div>';
      if (S.phase === 'error') return '<div class="stq-state" role="alert"><b>Could not load the report queue</b>' + esc(S.error) +
        '<div style="margin-top:12px"><button type="button" class="stq-btn" data-act="refresh">Try again</button></div></div>';
      if (!S.rows.length) return '<div class="stq-state" role="status"><b>No reports here</b>Nothing is in this state.</div>';
      return '<div class="stq-list">' + S.rows.map(function (r, i) {
        var s = STATE[stateOf(r)] || { l: 'Unknown state', t: '' };
        return '<button type="button" class="stq-row" data-act="open" data-i="' + i + '">' +
          '<span class="t">' + esc(title(r)) + '</span>' +
          '<span class="a">' + esc(r.severity || '—') + '</span>' +
          '<span class="s">' + esc(r.reason || '—') + (r.detail ? ' — ' + esc(r.detail) : '') + '</span>' +
          '<span class="m"><span class="stq-pill ' + s.t + '">' + esc(s.l) + '</span>' +
            (r.status === 'escalated' ? '<span class="stq-pill act">Escalated</span>' : '') +
            '<span class="stq-pill">' + esc(r.entityType || '—') + '</span>' +
            (r.entityType === 'product' ? '<span class="stq-pill ' + (hidden(r) ? 'bad' : 'ok') + '">' + (hidden(r) ? 'listing hidden' : 'listing live') + '</span>' : '') +
            '<span class="stq-pill">' + esc(when(msOf(r, 'createdAtIso', 'createdAt'))) + '</span></span></button>';
      }).join('') + '</div>';
    }

    function drawerHTML() {
      if (!S.open) return '';
      var r = S.open, c = r.context || {};
      var stKey = stateOf(r), s = STATE[stKey] || { l: 'Unknown state', t: '' };
      var body = '<div class="stq-lbl">Reported</div><div class="stq-kv"><span>Type</span><span>' + esc(r.entityType || '—') + '</span>' +
        (r.entityType === 'product'
          ? '<span>Product</span><span><a href="product.html?id=' + encodeURIComponent(r.entityId || '') + '">' + esc(c.productName || r.entityId || '—') + '</a></span>' +
            '<span>Seller</span><span>' + esc(c.sellerUid || '—') + '</span>' +
            '<span>Shop</span><span>' + esc(c.shopId || '—') + '</span>' +
            '<span>Price then</span><span>' + (typeof c.price === 'number' ? kes(c.price) : '—') + '</span>' +
            '<span>Listing</span><span>' + (hidden(r) ? 'hidden' : 'live') + '</span>'
          : '<span>Id</span><span>' + esc(r.entityId || '—') + '</span>') +
        '<span>Reporter</span><span>' + esc(r.reportedBy || '—') + '</span>' +
        '<span>Severity</span><span>' + esc(r.severity || '—') + '</span>' +
        '<span>State</span><span><span class="stq-pill ' + s.t + '">' + esc(s.l) + '</span>' + (r.status === 'escalated' ? ' <span class="stq-pill act">Escalated</span>' : '') + '</span>' +
        '<span>Filed</span><span>' + esc(when(msOf(r, 'createdAtIso', 'createdAt'))) + '</span></div>' +
        '<div class="stq-lbl">Reason</div><div class="stq-box">' + esc(r.reason || '—') + (r.detail ? '\n\n' + esc(r.detail) : '') + '</div>' +
        (r.resolution ? '<div class="stq-lbl">Outcome note</div><div class="stq-box">' + esc(r.resolution) + '</div>' : '');
      var offer = (OFFER[stKey] || []).filter(function (a) { return a !== 'takedown' || r.entityType === 'product'; })
        .filter(function (a) { return a !== 'escalate' || r.status !== 'escalated'; });
      var foot = '';
      if (offer.length) {
        foot = '<label class="stq-lbl" for="stqNote" style="margin:0">Note (recorded on the report and in the audit; the seller sees it once decided)</label>' +
          '<textarea id="stqNote" class="stq-ta" maxlength="500">' + esc(S.note) + '</textarea>' +
          (S.opErr ? '<div class="stq-err" role="alert">' + esc(S.opErr) + '</div>' : '') +
          '<div class="stq-acts">' + offer.map(function (a) {
            var A = ACTION[a];
            return '<button type="button" class="stq-btn ' + A.c + '" data-act="decide" data-v="' + a + '"' + (S.busy ? ' disabled' : '') + '>' + esc(A.l) + '</button>';
          }).join('') + '</div>' + (S.busy ? '<div role="status" class="stq-err" style="color:var(--q-sub)">Saving…</div>' : '');
      } else if (!stKey) {
        foot = '<div class="stq-err" role="alert">This report is in a state this console does not recognise — no action is offered.</div>';
      }
      return '<div class="stq-scrim" data-act="close"></div><div class="stq-drawer" role="dialog" aria-modal="true" aria-label="' + esc('Report · ' + title(r)) + '">' +
        '<div class="stq-dh"><div class="t">' + esc('Report · ' + title(r)) + '</div><button type="button" class="stq-x" data-act="close" aria-label="Close">×</button></div>' +
        '<div class="stq-db">' + body + '</div>' + (foot ? '<div class="stq-df">' + foot + '</div>' : '') + '</div>';
    }

    function paint() {
      var ta = el.querySelector('#stqNote'); if (ta) S.note = ta.value;
      el.innerHTML = topHTML() + listHTML() + drawerHTML();
    }

    function openRow(i) {
      var r = S.rows[i]; if (!r) return;
      lastFocus = doc.activeElement;
      S.open = r; S.opErr = null; S.busy = false; S.note = '';
      paint();
      var x = el.querySelector('.stq-x'); if (x) x.focus();
    }
    function close() {
      if (S.busy) return;
      S.open = null; paint();
      if (lastFocus && lastFocus.focus) try { lastFocus.focus(); } catch (_) {}
    }

    function decide(a) {
      var A = ACTION[a]; if (!A || !S.open) return;
      var note = S.note.trim();
      if (A.note && note.length < 2) { S.opErr = 'Write a note first — "' + A.l + '" needs a reason on record.'; paint(); return; }
      S.busy = true; S.opErr = null; paint();
      var payload = { reportId: S.open.id, action: a === 'takedown' ? 'approve' : a, resolution: note, hideProduct: a === 'takedown' };
      call('tsReviewReport', payload).then(function (res) {
        S.busy = false; S.open = null;
        toast(A.done + (a !== 'takedown' && res && res.productHidden ? ' — product taken down' : ''), 'success');
        return load();
      }).catch(function (e) { S.busy = false; S.opErr = errMsg(e, 'That did not work.'); paint(); });
    }

    el.addEventListener('input', function (ev) { if (ev.target && ev.target.id === 'stqNote') S.note = ev.target.value; });
    el.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && S.open) { ev.preventDefault(); close(); } });
    el.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-act]'); if (!b || !el.contains(b) || b.disabled) return;
      var act = b.getAttribute('data-act'), v = b.getAttribute('data-v');
      if (act === 'filter') { S.filter = v; load(); }
      else if (act === 'refresh') load();
      else if (act === 'open') openRow(Number(b.getAttribute('data-i')));
      else if (act === 'close') close();
      else if (act === 'decide') decide(v);
    });

    load();
    return { reload: load, state: function () { return S; }, destroy: function () { host.innerHTML = ''; } };
  }

  return { mount: mount, STATE: STATE, OFFER: OFFER, ACTION: ACTION };
}));
