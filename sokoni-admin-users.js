/* ============================================================================
   SOKONI — Admin Users workspace (shared by admin-os.html and super-admin.html)
   ----------------------------------------------------------------------------
   ONE users screen for both admin surfaces, mounted INSIDE each page's existing
   Users panel (the page keeps its own sidebar). Layout: header actions · four
   KPI cards · filter bar · bulk actions · table · right-hand detail drawer.

   DATA INTEGRITY (CLAUDE.md "UI Data Integrity"): every figure, page, filter, sort
   and export comes from the server; the browser never filters, sorts or counts a
   partial list:
     list      adminSearchUsers   server pagination (cursor) · role/status/sort/search
     detail    adminGetUser       profile + Auth facts + suspension / role history
     KPIs      adminUserStats     count() aggregates, each with its own availability
     export    adminExportUsers   super admin only · same server filters · audited
   A value the server marks unavailable renders "—", never 0 and never a guess.
   No percentage "access bars", no fabricated teams: access derives from the role.

   SUSPENSION has ONE contract (owner 2026-10-04): both surfaces call suspendUser
   (Auth account disabled + sessions revoked + status + history + audit; super-admin
   only, enforced on the server). Role changes keep each surface's existing callable.
   Invite → inviteUser (the server owns invited state, expiry, resend, acceptance).
   ============================================================================ */
;(function () {
  'use strict';
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const DASH = '—';
  const ms = (v) => { if (v == null) return null; if (typeof v === 'number') return v; if (v._seconds != null) return v._seconds * 1000; if (v.seconds != null) return v.seconds * 1000; if (typeof v.toMillis === 'function') return v.toMillis(); const t = Date.parse(v); return Number.isFinite(t) ? t : null; };
  const ago = (t) => { if (!t) return DASH; const d = Date.now() - t; if (d < 0) return 'just now'; const m = Math.floor(d / 60000); if (m < 1) return 'just now'; if (m < 60) return m + 'm ago'; const h = Math.floor(m / 60); if (h < 24) return h + 'h ago'; const dd = Math.floor(h / 24); if (dd < 30) return dd + 'd ago'; return new Date(t).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' }); };
  const fmtDate = (t) => (t ? new Date(t).toLocaleString('en-KE', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : DASH);
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v).toLocaleString('en-KE') : DASH);
  const initials = (n, e) => { const s = String(n || e || '?').trim(); const p = s.split(/[\s@._-]+/).filter(Boolean); return ((p[0] || '?')[0] + ((p[1] || '')[0] || '')).toUpperCase(); };

  /* Access is DERIVED from the role (an authority the server granted) — a label, not a metric. */
  const ACCESS = {
    superAdmin: { label: 'Full Access', tone: 'green', caps: ['Platform administration', 'Admin roles', 'Finance & payouts', 'Users & moderation', 'Marketplace'] },
    admin: { label: 'Admin Access', tone: 'green', caps: ['Users & moderation', 'Marketplace', 'Reports'] },
    moderator: { label: 'Moderation', tone: 'blue', caps: ['Content moderation', 'Reports'] },
    seller: { label: 'Seller Workspace', tone: 'blue', caps: ['Own shop & products', 'Own orders'] },
    provider: { label: 'Provider Workspace', tone: 'blue', caps: ['Own services & bookings'] },
    driver: { label: 'Delivery', tone: 'blue', caps: ['Assigned deliveries'] },
    buyer: { label: 'Customer', tone: 'muted', caps: ['Own account & orders'] },
  };
  const accessOf = (role) => ACCESS[role] || { label: role ? String(role) : DASH, tone: 'muted', caps: [] };
  const statusOf = (u) => { const s = String(u.status || '').toLowerCase(); if (u.suspended === true || s === 'suspended') return 'suspended'; if (s === 'banned') return 'banned'; if (s === 'pending' || s === 'invited') return 'pending'; if (s === 'inactive' || s === 'deactivated') return 'inactive'; return s || 'active'; };

  const CSS = `
.aus{--aus-bg:#0b0d14;--aus-card:#121522;--aus-card2:#171a2a;--aus-bor:#23273a;--aus-txt:#e7e9f4;--aus-sub:#8b90ad;--aus-acc:#5b5bf7;--aus-acc2:#7c6cff;--aus-green:#22c55e;--aus-amber:#f59e0b;--aus-red:#ef4444;--aus-blue:#3b82f6;color:var(--aus-txt);font-family:inherit;position:relative}
.aus *{box-sizing:border-box}
.aus-head{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start;justify-content:space-between;margin-bottom:18px}
.aus-title{display:flex;align-items:center;gap:8px;font-size:22px;font-weight:700;margin:0}
.aus-badge{background:var(--aus-acc);color:#fff;border-radius:999px;font-size:11px;padding:2px 8px;font-weight:600}
.aus-subtitle{color:var(--aus-sub);font-size:13px;margin-top:4px}
.aus-actions{display:flex;gap:8px;flex-wrap:wrap}
.aus-btn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--aus-bor);background:var(--aus-card);color:var(--aus-txt);border-radius:10px;padding:9px 14px;font-size:13px;font-weight:500;cursor:pointer;min-height:40px}
.aus-btn:hover{border-color:#3a3f5c}.aus-btn:focus-visible{outline:2px solid var(--aus-acc2);outline-offset:2px}
.aus-btn.primary{background:linear-gradient(135deg,var(--aus-acc),var(--aus-acc2));border-color:transparent;color:#fff}
.aus-btn.danger{color:#fca5a5;border-color:#4a2228;background:#1c1014}
.aus-btn[disabled]{opacity:.45;cursor:not-allowed}
.aus-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-bottom:16px}
.aus-kpi{background:var(--aus-card);border:1px solid var(--aus-bor);border-radius:14px;padding:16px;display:flex;gap:14px;align-items:center;min-width:0}
.aus-kpi-ico{width:44px;height:44px;border-radius:12px;display:grid;place-items:center;font-size:20px;flex-shrink:0}
.aus-kpi-ico.v{background:rgba(124,108,255,.18)}.aus-kpi-ico.b{background:rgba(59,130,246,.18)}.aus-kpi-ico.g{background:rgba(34,197,94,.18)}.aus-kpi-ico.r{background:rgba(239,68,68,.18)}
.aus-kpi-lbl{color:var(--aus-sub);font-size:12.5px}.aus-kpi-val{font-size:24px;font-weight:700;line-height:1.2}
.aus-kpi-sub{font-size:11.5px;color:var(--aus-sub);margin-top:2px}.aus-up{color:var(--aus-green)}.aus-warn{color:var(--aus-amber)}
.aus-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;background:var(--aus-card);border:1px solid var(--aus-bor);border-radius:14px;padding:10px;margin-bottom:12px}
.aus-search{flex:1 1 240px;display:flex;align-items:center;gap:8px;background:var(--aus-bg);border:1px solid var(--aus-bor);border-radius:10px;padding:0 10px;min-height:40px}
.aus-search input{flex:1;background:transparent;border:0;color:var(--aus-txt);font-size:13px;outline:none;min-width:0}
.aus-sel{background:var(--aus-bg);border:1px solid var(--aus-bor);color:var(--aus-txt);border-radius:10px;padding:0 10px;font-size:13px;min-height:40px}
.aus-view{display:flex;gap:4px;margin-left:auto}.aus-view button{width:40px;height:40px;border-radius:10px;border:1px solid var(--aus-bor);background:var(--aus-bg);color:var(--aus-sub);cursor:pointer}
.aus-view button[aria-pressed="true"]{color:#fff;background:rgba(91,91,247,.25);border-color:var(--aus-acc)}
.aus-bulk{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:8px 12px;margin-bottom:10px;border:1px solid var(--aus-bor);border-radius:12px;background:var(--aus-card2);font-size:13px}
.aus-bulk[hidden]{display:none}
.aus-tablewrap{background:var(--aus-card);border:1px solid var(--aus-bor);border-radius:14px;overflow-x:auto}
.aus-table{width:100%;border-collapse:collapse;font-size:13px;min-width:860px}
.aus-table th{text-align:left;color:var(--aus-sub);font-weight:500;padding:12px 14px;border-bottom:1px solid var(--aus-bor);white-space:nowrap}
.aus-table td{padding:12px 14px;border-bottom:1px solid rgba(35,39,58,.6);vertical-align:middle}
.aus-table tbody tr{cursor:pointer}.aus-table tbody tr:hover{background:rgba(255,255,255,.02)}
.aus-table tbody tr.sel{background:rgba(91,91,247,.08)}
.aus-user{display:flex;gap:10px;align-items:center;min-width:0}
.aus-av{width:36px;height:36px;border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:700;color:#fff;background:linear-gradient(135deg,#4338ca,#7c3aed);flex-shrink:0;overflow:hidden}
.aus-av img{width:100%;height:100%;object-fit:cover}
.aus-name{font-weight:600}.aus-mail{color:var(--aus-sub);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:240px}
.aus-pill{display:inline-block;border-radius:6px;padding:3px 8px;font-size:11.5px;font-weight:500;white-space:nowrap}
.aus-pill.violet{background:rgba(124,108,255,.16);color:#b4a9ff}.aus-pill.blue{background:rgba(59,130,246,.16);color:#93c5fd}
.aus-pill.green{background:rgba(34,197,94,.14);color:#86efac}.aus-pill.amber{background:rgba(245,158,11,.14);color:#fcd34d}
.aus-pill.red{background:rgba(239,68,68,.14);color:#fca5a5}.aus-pill.muted{background:rgba(139,144,173,.14);color:#c4c7dc}
.aus-chk{width:18px;height:18px;accent-color:var(--aus-acc);cursor:pointer}
.aus-more{background:transparent;border:0;color:var(--aus-sub);font-size:18px;cursor:pointer;padding:4px 8px;border-radius:8px;min-width:36px;min-height:36px}
.aus-foot{display:flex;flex-wrap:wrap;gap:10px;justify-content:space-between;align-items:center;padding:12px 14px;color:var(--aus-sub);font-size:12.5px}
.aus-pages{display:flex;gap:4px}.aus-pages button{min-width:34px;height:34px;border-radius:8px;border:1px solid var(--aus-bor);background:var(--aus-bg);color:var(--aus-txt);cursor:pointer}
.aus-pages button[aria-current="page"]{background:var(--aus-acc);border-color:var(--aus-acc);color:#fff}
.aus-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px;padding:12px}
.aus-card{background:var(--aus-card2);border:1px solid var(--aus-bor);border-radius:12px;padding:14px;cursor:pointer}
.aus-empty{padding:40px 16px;text-align:center;color:var(--aus-sub)}
.aus-drawer-bg{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:900}
.aus-drawer{position:fixed;top:0;right:0;height:100%;width:min(420px,100%);background:var(--aus-card);border-left:1px solid var(--aus-bor);z-index:901;overflow-y:auto;padding:22px;box-shadow:-12px 0 40px rgba(0,0,0,.45)}
.aus-drawer h3{font-size:13px;margin:20px 0 10px;font-weight:600}
.aus-x{position:absolute;top:14px;right:14px;background:transparent;border:0;color:var(--aus-sub);font-size:22px;cursor:pointer;min-width:40px;min-height:40px}
.aus-dhead{display:flex;gap:14px;align-items:center}.aus-dhead .aus-av{width:60px;height:60px;font-size:18px}
.aus-dname{font-size:20px;font-weight:700}.aus-chips{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:12px}
.aus-tabs{display:flex;gap:18px;border-bottom:1px solid var(--aus-bor);margin-top:18px}
.aus-tabs button{background:transparent;border:0;color:var(--aus-sub);padding:10px 0;font-size:13px;cursor:pointer;border-bottom:2px solid transparent;min-height:40px}
.aus-tabs button[aria-selected="true"]{color:var(--aus-txt);border-bottom-color:var(--aus-acc)}
.aus-kv{display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid rgba(35,39,58,.6);font-size:13px}
.aus-kv span:first-child{color:var(--aus-sub)}
.aus-caps li{list-style:none;padding:6px 0;font-size:13px;display:flex;gap:8px}.aus-caps{padding:0;margin:0}
.aus-modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:950;display:grid;place-items:center;padding:16px}
.aus-modal{background:var(--aus-card);border:1px solid var(--aus-bor);border-radius:14px;padding:20px;width:min(440px,100%)}
.aus-modal label{display:block;font-size:12.5px;color:var(--aus-sub);margin:12px 0 6px}
.aus-modal input,.aus-modal select,.aus-modal textarea{width:100%;background:var(--aus-bg);border:1px solid var(--aus-bor);color:var(--aus-txt);border-radius:10px;padding:10px;font-size:13px}
.aus-modal .row{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
.aus-msg{font-size:12.5px;margin-top:10px}
@media (max-width:1100px){.aus-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:560px){.aus-kpis{grid-template-columns:1fr}.aus-view{margin-left:0}.aus-title{font-size:19px}}
`;

  function mount(root, config) {
    if (!root || !config || typeof config.call !== 'function') throw new Error('SokoniAdminUsers.mount(root, {call, actions})');
    const cfg = Object.assign({ pageSize: 10, roles: ['buyer', 'seller', 'provider', 'driver', 'moderator', 'admin'], canChangeRole: true, canSuspend: true }, config);
    if (!document.getElementById('aus-style')) { const st = document.createElement('style'); st.id = 'aus-style'; st.textContent = CSS; document.head.appendChild(st); }
    const S = { users: [], total: null, cursors: [null], page: 1, nextCursor: null, hasMore: false, mode: 'list', filter: { q: '', role: '', status: '' }, sort: 'joined', view: 'list', sel: new Set(), stats: null, loading: false, error: null };

    root.innerHTML = `
<div class="aus" data-surface="${esc(cfg.surface || '')}">
  <div class="aus-head">
    <div><h2 class="aus-title">Users <span class="aus-badge" data-k="count">${DASH}</span></h2>
      <div class="aus-subtitle">Manage members, roles, and access across SOKONI.</div></div>
    <div class="aus-actions">
      <button class="aus-btn" data-act="export" type="button" ${cfg.canExport ? '' : 'disabled title="Export is restricted to super admins"'}>&#x2B73; Export</button>
      <button class="aus-btn primary" data-act="invite" type="button">&#xFF0B; Invite User</button>
    </div>
  </div>
  <div class="aus-kpis">
    <div class="aus-kpi"><div class="aus-kpi-ico v">&#x1F465;</div><div><div class="aus-kpi-lbl">Total Users</div><div class="aus-kpi-val" data-k="total">${DASH}</div><div class="aus-kpi-sub" data-k="totalSub">&nbsp;</div></div></div>
    <div class="aus-kpi"><div class="aus-kpi-ico b">&#x1F4BC;</div><div><div class="aus-kpi-lbl">Active Users</div><div class="aus-kpi-val" data-k="active">${DASH}</div><div class="aus-kpi-sub" data-k="activeSub">&nbsp;</div></div></div>
    <div class="aus-kpi"><div class="aus-kpi-ico g">&#x1F6E1;</div><div><div class="aus-kpi-lbl">Pending Invites</div><div class="aus-kpi-val" data-k="invites">${DASH}</div><div class="aus-kpi-sub" data-k="invitesSub">&nbsp;</div></div></div>
    <div class="aus-kpi"><div class="aus-kpi-ico r">&#x26D4;</div><div><div class="aus-kpi-lbl">Suspended</div><div class="aus-kpi-val" data-k="suspended">${DASH}</div><div class="aus-kpi-sub" data-k="suspendedSub">&nbsp;</div></div></div>
  </div>
  <div class="aus-bar" role="search">
    <label class="aus-search"><span aria-hidden="true">&#x1F50D;</span><input type="search" data-f="q" placeholder="Search by name, email, phone or UID" aria-label="Search users"></label>
    <select class="aus-sel" data-f="role" aria-label="Filter by role"><option value="">Role: All</option>${cfg.roles.concat(['superAdmin']).map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join('')}</select>
    <select class="aus-sel" data-f="status" aria-label="Filter by status"><option value="">Status: All</option><option value="active">Active</option><option value="suspended">Suspended</option><option value="inactive">Inactive</option><option value="pending">Pending</option></select>
    <select class="aus-sel" data-f="sort" aria-label="Sort"><option value="joined">Sort by: Newest joined</option><option value="name">Sort by: Name</option></select>
    <div class="aus-view"><button type="button" data-view="list" aria-pressed="true" aria-label="List view">&#x2630;</button><button type="button" data-view="grid" aria-pressed="false" aria-label="Grid view">&#x25A6;</button></div>
  </div>
  <div class="aus-bulk" data-k="bulk" hidden>
    <strong data-k="selCount">0 selected</strong>
    <button class="aus-btn" data-act="bulkRole" type="button" ${cfg.canChangeRole ? '' : 'disabled'}>Change Role</button>
    <button class="aus-btn danger" data-act="bulkSuspend" type="button" ${cfg.canSuspend ? '' : 'disabled'}>Suspend</button>
    <button class="aus-btn" data-act="clearSel" type="button">Clear</button>
  </div>
  <div class="aus-tablewrap" data-k="body"></div>
</div>`;
    const $ = (sel) => root.querySelector(sel);
    const setK = (k, html) => { const el = root.querySelector(`[data-k="${k}"]`); if (el) el.innerHTML = html; };

    /* ── data ── */
    async function loadStats() {
      try { S.stats = await cfg.call('adminUserStats', {}); } catch (_) { S.stats = null; }
      renderKpis();
    }
    /* SERVER pagination: the cursor stack lets the user page back without re-reading everything. reset=true on a filter change. */
    async function loadUsers(reset) {
      if (reset !== false) { S.cursors = [null]; S.page = 1; }
      S.loading = true; S.error = null; renderBody();
      try {
        const r = await cfg.call('adminSearchUsers', { query: S.filter.q, role: S.filter.role, status: S.filter.status, sort: S.sort, pageSize: cfg.pageSize, cursor: S.cursors[S.page - 1] });
        S.users = (r && Array.isArray(r.users)) ? r.users : [];
        S.total = r && r.totalAvailable && Number.isFinite(Number(r.total)) ? Number(r.total) : null;
        S.nextCursor = r ? r.nextCursor || null : null; S.hasMore = !!(r && r.hasMore); S.mode = r && r.mode || 'list';
      } catch (e) { S.users = []; S.error = (e && e.message) || 'Could not load users.'; }
      S.loading = false; S.sel.clear(); renderBody(); renderBulk();
    }

    /* ── KPIs: server aggregates only ── */
    function renderKpis() {
      const st = S.stats, av = (k) => !!(st && st.available && st.available[k]);
      setK('total', av('totalUsers') ? num(st.totalUsers) : DASH);
      setK('count', av('totalUsers') ? num(st.totalUsers) : DASH);
      setK('totalSub', av('joinedLast30') ? `<span class="aus-up">&#x2191; ${num(st.joinedLast30)}</span> joined in the last 30 days` : '&nbsp;');
      setK('active', av('activeUsers') ? num(st.activeUsers) : DASH);
      setK('activeSub', av('activeUsers') && av('totalUsers') && Number(st.totalUsers) > 0 ? `${Math.round(Number(st.activeUsers) / Number(st.totalUsers) * 100)}% of all users` : '&nbsp;');
      setK('suspended', av('suspendedUsers') ? num(st.suspendedUsers) + (st.suspendedExact === false ? '+' : '') : DASH);
      setK('suspendedSub', av('suspendedUsers') ? 'sign-in disabled' : '&nbsp;');
      setK('invites', av('pendingInvites') ? num(st.pendingInvites) : DASH);
      setK('invitesSub', av('expiringSoon') ? (Number(st.expiringSoon) > 0 ? `<span class="aus-warn">&#x25CF; ${num(st.expiringSoon)} expiring within 72h</span>` : 'none expiring soon') : '&nbsp;');
    }

    /* ── table / grid ── */
    function visible() { return S.users.slice(); }   /* the server filtered, sorted and paged this list */
    const statusPill = (s) => `<span class="aus-pill ${s === 'active' ? 'green' : s === 'pending' ? 'amber' : s === 'inactive' ? 'muted' : 'red'}">${esc(s.charAt(0).toUpperCase() + s.slice(1))}</span>`;
    const rolePill = (r) => `<span class="aus-pill ${r === 'superAdmin' || r === 'admin' ? 'violet' : r === 'moderator' ? 'amber' : 'blue'}">${esc(r || DASH)}</span>`;
    const av = (u) => `<span class="aus-av">${u.photoURL && /^https:\/\//.test(u.photoURL) ? `<img src="${esc(u.photoURL)}" alt="" loading="lazy">` : esc(initials(u.displayName, u.email))}</span>`;

    function renderBody() {
      const body = $('[data-k="body"]');
      if (S.loading) { body.innerHTML = '<div class="aus-empty">Loading users&#x2026;</div>'; return; }
      if (S.error) { body.innerHTML = `<div class="aus-empty">Couldn't load users &mdash; ${esc(S.error)} <br><button class="aus-btn" data-act="retry" type="button" style="margin-top:10px">Try again</button></div>`; return; }
      const list = visible();
      if (!list.length) { body.innerHTML = '<div class="aus-empty">No users match these filters.</div>'; return; }
      const slice = list;
      const from = S.mode === 'search' ? 1 : (S.page - 1) * cfg.pageSize + 1;
      const foot = `<div class="aus-foot"><span>${S.mode === 'search' ? `${num(list.length)} match${list.length === 1 ? '' : 'es'}` : `Showing ${from}&ndash;${from + slice.length - 1} of ${S.total == null ? DASH : num(S.total)}`}</span>
        <span class="aus-pages"><button type="button" data-page="prev" ${S.page > 1 ? '' : 'disabled'} aria-label="Previous page">&lsaquo;</button><button type="button" aria-current="page">${S.page}</button><button type="button" data-page="next" ${S.hasMore ? '' : 'disabled'} aria-label="Next page">&rsaquo;</button></span></div>`;
      if (S.view === 'grid') {
        body.innerHTML = `<div class="aus-grid">${slice.map((u) => { const s = statusOf(u), a = accessOf(u.role); return `<div class="aus-card" data-uid="${esc(u.id)}" tabindex="0" role="button" aria-label="Open ${esc(u.displayName || u.email || u.id)}">
          <div class="aus-user">${av(u)}<div style="min-width:0"><div class="aus-name">${esc(u.displayName || DASH)}</div><div class="aus-mail">${esc(u.email || u.phone || DASH)}</div></div></div>
          <div class="aus-chips">${rolePill(u.role)} ${statusPill(s)} <span class="aus-pill ${a.tone}">${esc(a.label)}</span></div>
          <div class="aus-kpi-sub" style="margin-top:8px">Last sign-in: ${esc(ago(ms(u.lastSignIn)))}</div></div>`; }).join('')}</div>${foot}`;
        return;
      }
      const allOn = slice.length > 0 && slice.every((u) => S.sel.has(u.id));
      body.innerHTML = `<table class="aus-table"><thead><tr>
        <th><input type="checkbox" class="aus-chk" data-act="selAll" aria-label="Select all on this page" ${allOn ? 'checked' : ''}></th>
        <th>User</th><th>Role</th><th>Team</th><th>Status</th><th>Last sign-in</th><th>Access</th><th><span class="sr-only" style="position:absolute;left:-9999px">Actions</span></th></tr></thead><tbody>
        ${slice.map((u) => { const s = statusOf(u), a = accessOf(u.role), on = S.sel.has(u.id); return `<tr data-uid="${esc(u.id)}" class="${on ? 'sel' : ''}">
          <td><input type="checkbox" class="aus-chk" data-sel="${esc(u.id)}" aria-label="Select ${esc(u.displayName || u.email || u.id)}" ${on ? 'checked' : ''}></td>
          <td><div class="aus-user">${av(u)}<div style="min-width:0"><div class="aus-name">${esc(u.displayName || DASH)}</div><div class="aus-mail">${esc(u.email || u.phone || DASH)}</div></div></div></td>
          <td>${rolePill(u.role)}</td><td>${esc(u.team || u.department || DASH)}</td><td>${statusPill(s)}</td>
          <td>${esc(ago(ms(u.lastSignIn)))}</td><td><span class="aus-pill ${a.tone}">${esc(a.label)}</span></td>
          <td><button class="aus-more" type="button" data-open="${esc(u.id)}" aria-label="Open details">&#x22EF;</button></td></tr>`; }).join('')}
        </tbody></table>${foot}`;
    }
    function renderBulk() { const n = S.sel.size; $('[data-k="bulk"]').hidden = n === 0; setK('selCount', `${n} selected`); }

    /* ── drawer ── */
    async function openDrawer(uid) {
      closeDrawer();
      const u = S.users.find((x) => x.id === uid) || { id: uid };
      const bg = document.createElement('div'); bg.className = 'aus-drawer-bg'; bg.dataset.ausDrawer = '1';
      const dr = document.createElement('aside'); dr.className = 'aus aus-drawer'; dr.dataset.ausDrawer = '1'; dr.setAttribute('role', 'dialog'); dr.setAttribute('aria-modal', 'true'); dr.setAttribute('aria-label', 'User details');
      dr.innerHTML = '<button class="aus-x" type="button" aria-label="Close">&times;</button><div class="aus-empty">Loading&#x2026;</div>';
      document.body.appendChild(bg); document.body.appendChild(dr);
      const close = () => closeDrawer();
      bg.addEventListener('click', close); dr.querySelector('.aus-x').addEventListener('click', close);
      document.addEventListener('keydown', escClose);
      let d = null; try { d = await cfg.call('adminGetUser', { uid }); } catch (e) { d = { error: (e && e.message) || 'unavailable' }; }
      if (!dr.isConnected) return;
      const p = (d && d.profile) || u, ar = d && d.authRecord, s = (d && d.security && d.security.accountStatus) || statusOf(p), a = accessOf(p.role);
      const claims = (p.customClaims && typeof p.customClaims === 'object') ? Object.keys(p.customClaims).filter((k) => p.customClaims[k] === true) : [];
      const providers = ar && Array.isArray(ar.providerData) ? ar.providerData : null;
      const sso = providers ? providers.filter((x) => x !== 'password' && x !== 'phone') : null;
      const sec = (d && d.security) || null;
      const mfa = sec ? (sec.twoFactor === 'enabled' ? 1 : sec.twoFactor === 'not_enabled' ? 0 : null) : null;
      const hist = (list, f) => (Array.isArray(list) ? (list.length ? list.slice(0, 8).map(f).join('') : '<div class="aus-kpi-sub">None recorded.</div>') : `<div class="aus-kpi-sub">${DASH}</div>`);
      const tab = (id, html) => `<section data-tab="${id}" ${id === 'overview' ? '' : 'hidden'}>${html}</section>`;
      dr.innerHTML = `<button class="aus-x" type="button" aria-label="Close">&times;</button>
        <div class="aus-dhead">${av(p)}<div style="min-width:0"><div class="aus-dname">${esc(p.displayName || DASH)}</div><div class="aus-mail">${esc(p.email || p.phone || DASH)}</div></div></div>
        <div class="aus-chips">${statusPill(s)} ${rolePill(p.role)} <span class="aus-kpi-sub">Joined ${esc(fmtDate(ms(p.createdAt) || (ar && ms(ar.creationTime))))}</span></div>
        ${d && d.error ? `<div class="aus-msg aus-warn">Details unavailable: ${esc(d.error)}</div>` : ''}
        <div class="aus-tabs" role="tablist"><button role="tab" aria-selected="true" data-t="overview">Overview</button><button role="tab" aria-selected="false" data-t="activity">Activity</button><button role="tab" aria-selected="false" data-t="security">Security</button></div>
        ${tab('overview', `<h3>Access summary</h3><div class="aus-kpi-sub" style="margin-bottom:6px">${esc(a.label)} &mdash; derived from the role the server granted.</div>
          <ul class="aus-caps">${a.caps.length ? a.caps.map((c) => `<li><span class="aus-up">&#x2713;</span>${esc(c)}</li>`).join('') : `<li>${DASH}</li>`}</ul>
          <h3>Roles</h3><div class="aus-chips" style="margin-top:0">${rolePill(p.role)} ${claims.filter((c) => c !== p.role).map((c) => `<span class="aus-pill muted">${esc(c)}</span>`).join(' ')}</div>
          <h3>Team</h3><div class="aus-kv"><span>Department / team</span><span>${esc((p.customClaims && (p.customClaims.department || p.customClaims.teamId)) || DASH)}</span></div>`)}
        ${tab('activity', `<h3>Activity</h3>
          <div class="aus-kv"><span>Last sign-in</span><span>${esc(ar ? fmtDate(ms(ar.lastSignIn)) : DASH)}</span></div>
          <div class="aus-kv"><span>Orders (latest 10 checked)</span><span>${d && Number.isFinite(Number(d.orderCount)) ? esc(d.orderCount) : DASH}</span></div>
          <div class="aus-kv"><span>Reports against user (latest 10)</span><span>${d && Number.isFinite(Number(d.reportCount)) ? esc(d.reportCount) : DASH}</span></div>
          <div class="aus-kv"><span>Active subscriptions</span><span>${d && Array.isArray(d.activeSubscriptions) ? esc(d.activeSubscriptions.length) : DASH}</span></div>`)}
        ${tab('security', `<h3>Security &amp; access</h3>
          <div class="aus-kv"><span>Two-factor authentication</span><span>${mfa == null ? DASH : mfa > 0 ? '<span class="aus-up">Enabled</span>' : 'Not enabled'}</span></div>
          <div class="aus-kv"><span>SSO sign-in</span><span>${sso == null ? DASH : sso.length ? esc(sso.join(', ')) : 'None'}</span></div>
          <div class="aus-kv"><span>Email verified</span><span>${ar ? (ar.emailVerified ? '<span class="aus-up">Yes</span>' : 'No') : DASH}</span></div>
          <div class="aus-kv"><span>Account status</span><span>${sec ? statusPill(sec.accountStatus || 'active') : DASH}</span></div>
          <div class="aus-kv"><span>Sign-in</span><span>${sec && sec.signInEnabled != null ? (sec.signInEnabled ? 'Enabled' : '<span class="aus-warn">Disabled</span>') : DASH}</span></div>
          <div class="aus-kv"><span>Sessions revoked at</span><span>${esc(ar && ar.tokensValidAfter ? fmtDate(ms(ar.tokensValidAfter)) : DASH)}</span></div>
          <h3>Suspension history</h3>${hist(sec && sec.suspensionHistory, (h) => `<div class="aus-kv"><span>${esc(h.action)} ${h.reason ? '&mdash; ' + esc(h.reason) : ''}</span><span>${esc(fmtDate(h.at))}</span></div>`)}
          <h3>Role changes</h3>${hist(sec && sec.roleChanges, (h) => `<div class="aus-kv"><span>${esc(h.newRole || h.action)}</span><span>${esc(fmtDate(h.at))}</span></div>`)}
          <h3>Security events</h3>${hist(sec && sec.events, (h) => `<div class="aus-kv"><span>${esc(h.action)}</span><span>${esc(fmtDate(h.at))}</span></div>`)}`)}
        <div class="aus-chips" style="margin-top:22px">
          <button class="aus-btn" type="button" data-d="role" ${cfg.canChangeRole ? '' : 'disabled'}>&#x270E; Change role</button>
          ${s === 'suspended' || s === 'banned'
            ? `<button class="aus-btn" type="button" data-d="restore" ${cfg.canSuspend && cfg.actions && cfg.actions.restore ? '' : 'disabled'}>Restore</button>`
            : `<button class="aus-btn danger" type="button" data-d="suspend" ${cfg.canSuspend ? '' : 'disabled'}>Suspend</button>`}
        </div>`;
      dr.querySelector('.aus-x').addEventListener('click', close);
      dr.querySelectorAll('[data-t]').forEach((b) => b.addEventListener('click', () => {
        dr.querySelectorAll('[data-t]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
        dr.querySelectorAll('section[data-tab]').forEach((sec) => { sec.hidden = sec.dataset.tab !== b.dataset.t; });
      }));
      const r = dr.querySelector('[data-d="role"]'); if (r) r.addEventListener('click', () => roleDialog([uid]));
      const su = dr.querySelector('[data-d="suspend"]'); if (su) su.addEventListener('click', () => suspendDialog([uid]));
      const re = dr.querySelector('[data-d="restore"]'); if (re) re.addEventListener('click', () => runAction('restore', [uid], {}));
      dr.querySelector('.aus-x').focus();
    }
    function escClose(e) { if (e.key === 'Escape') closeDrawer(); }
    function closeDrawer() { document.querySelectorAll('[data-aus-drawer]').forEach((n) => n.remove()); document.removeEventListener('keydown', escClose); }

    /* ── dialogs + server actions (each surface's existing authority) ── */
    function modal(title, inner, onOk, okLabel, danger) {
      const bg = document.createElement('div'); bg.className = 'aus aus-modal-bg';
      bg.innerHTML = `<div class="aus-modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"><h3 style="margin:0">${esc(title)}</h3>${inner}<div class="aus-msg" data-m></div>
        <div class="row"><button class="aus-btn" type="button" data-c>Cancel</button><button class="aus-btn ${danger ? 'danger' : 'primary'}" type="button" data-ok>${esc(okLabel)}</button></div></div>`;
      document.body.appendChild(bg);
      const done = () => bg.remove();
      bg.querySelector('[data-c]').addEventListener('click', done);
      bg.addEventListener('click', (e) => { if (e.target === bg) done(); });
      bg.querySelector('[data-ok]').addEventListener('click', async () => {
        const btn = bg.querySelector('[data-ok]'); btn.disabled = true; const m = bg.querySelector('[data-m]'); m.textContent = 'Working…';
        try { const msg = await onOk(bg); m.innerHTML = `<span class="aus-up">${esc(msg || 'Done.')}</span>`; setTimeout(done, 900); }
        catch (e) { m.innerHTML = `<span style="color:#fca5a5">${esc((e && e.message) || 'Failed.')}</span>`; btn.disabled = false; }
      });
      const f = bg.querySelector('input,select,textarea'); if (f) f.focus();
    }
    async function runAction(kind, uids, extra) {
      const act = cfg.actions && cfg.actions[kind];
      if (!act) throw new Error('This action is not available on this page.');
      let ok = 0; const fails = [];
      for (const uid of uids) { try { await cfg.call(act.fn, act.payload(uid, extra)); ok++; } catch (e) { fails.push((e && e.message) || 'failed'); } }
      await loadUsers(); loadStats(); closeDrawer();
      if (fails.length) throw new Error(`${ok} done, ${fails.length} failed: ${fails[0]}`);
      return `${ok} user${ok === 1 ? '' : 's'} updated.`;
    }
    function roleDialog(uids) {
      modal(`Change role (${uids.length})`, `<label>New role</label><select data-role>${cfg.roles.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join('')}</select>
        <div class="aus-kpi-sub" style="margin-top:8px">Applied by the server (${esc(cfg.actions && cfg.actions.role ? cfg.actions.role.fn : DASH)}); audited.</div>`,
      (bg) => runAction('role', uids, { role: bg.querySelector('[data-role]').value }), 'Change role');
    }
    function suspendDialog(uids) {
      modal(`Suspend ${uids.length} user${uids.length === 1 ? '' : 's'}`, `<label>Reason (required)</label><textarea data-reason rows="3" maxlength="300" placeholder="Why is this account being suspended?"></textarea>
        <div class="aus-kpi-sub" style="margin-top:8px">Applied by the server (${esc(cfg.actions && cfg.actions.suspend ? cfg.actions.suspend.fn : DASH)}); audited.</div>`,
      (bg) => { const reason = bg.querySelector('[data-reason]').value.trim(); if (reason.length < 3) throw new Error('A reason is required.'); return runAction('suspend', uids, { reason }); }, 'Suspend', true);
    }
    function inviteDialog() {
      modal('Invite user', `<label>Email</label><input type="email" data-email autocomplete="off" placeholder="name@example.com"><label>Name (optional)</label><input data-name maxlength="120">
        <label>Role</label><select data-irole>${['customer', 'seller', 'provider'].concat(cfg.inviteRoles || []).map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join('')}</select>
        <div class="aus-kpi-sub" style="margin-top:8px">The server creates the account and emails a sign-in link (inviteUser).</div>`,
      async (bg) => { const email = bg.querySelector('[data-email]').value.trim(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email.');
        const r = await cfg.call('inviteUser', { email, name: bg.querySelector('[data-name]').value.trim(), role: bg.querySelector('[data-irole]').value });
        loadStats(); return r && r.status === 'queued' ? 'Invitation sent.' : 'Invitation recorded.'; }, 'Send invite');
    }
    /* EXPORT — server-side only (adminExportUsers: super admin, same filters, displayed columns, capped, AUDITED). */
    async function exportCsv() {
      if (!cfg.canExport) return;
      const btn = root.querySelector('[data-act="export"]'); if (btn) { btn.disabled = true; btn.textContent = 'Exporting…'; }
      try {
        const r = await cfg.call('adminExportUsers', { role: S.filter.role, status: S.filter.status, sort: S.sort });
        const cols = (r && r.columns) || [];
        const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
        const iso = (t) => (t ? new Date(t).toISOString() : '');
        const lines = [cols.join(',')].concat(((r && r.rows) || []).map((x) => cols.map((c) => q(c === 'joined' || c === 'lastSignIn' ? iso(x[c]) : x[c])).join(',')));
        const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `sokoni-users-${new Date().toISOString().slice(0, 10)}.csv`; document.body.appendChild(a); a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
        if (r && r.truncated) alert('Export capped at ' + num(r.rowCount) + ' rows — narrow the filters for the rest.');
      } catch (e) { alert('Export refused: ' + ((e && e.message) || 'failed')); }
      if (btn) { btn.disabled = false; btn.innerHTML = '&#x2B73; Export'; }
    }

    /* ── events ── */
    let qTimer = null;
    root.addEventListener('input', (e) => { if (e.target.matches('[data-f="q"]')) { clearTimeout(qTimer); qTimer = setTimeout(() => { S.filter.q = e.target.value.trim(); loadUsers(); }, 350); } });
    root.addEventListener('change', (e) => {
      const f = e.target.dataset.f;
      if (f === 'role') { S.filter.role = e.target.value; loadUsers(); }
      else if (f === 'status') { S.filter.status = e.target.value; loadUsers(); }
      else if (f === 'sort') { S.sort = e.target.value; loadUsers(); }
      else if (e.target.dataset.sel) { e.target.checked ? S.sel.add(e.target.dataset.sel) : S.sel.delete(e.target.dataset.sel); renderBody(); renderBulk(); }
      else if (e.target.dataset.act === 'selAll') { visible().forEach((u) => (e.target.checked ? S.sel.add(u.id) : S.sel.delete(u.id))); renderBody(); renderBulk(); }
    });
    root.addEventListener('click', (e) => {
      const t = e.target.closest('button,[data-uid]'); if (!t) return;
      if (t.matches('input')) return;
      if (t.dataset.act === 'export') exportCsv();
      else if (t.dataset.act === 'invite') inviteDialog();
      else if (t.dataset.act === 'retry') loadUsers();
      else if (t.dataset.act === 'bulkRole') roleDialog([...S.sel]);
      else if (t.dataset.act === 'bulkSuspend') suspendDialog([...S.sel]);
      else if (t.dataset.act === 'clearSel') { S.sel.clear(); renderBody(); renderBulk(); }
      else if (t.dataset.view) { S.view = t.dataset.view; root.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b === t))); renderBody(); }
      else if (t.dataset.page === 'next' && S.hasMore && S.nextCursor) { S.cursors[S.page] = S.nextCursor; S.page += 1; loadUsers(false); }
      else if (t.dataset.page === 'prev' && S.page > 1) { S.page -= 1; loadUsers(false); }
      else if (t.dataset.open) openDrawer(t.dataset.open);
      else if (t.dataset.uid && !e.target.closest('input,.aus-more')) openDrawer(t.dataset.uid);
    });
    root.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.aus-card[data-uid]')) { e.preventDefault(); openDrawer(e.target.dataset.uid); } });

    const api = {
      refresh() { loadUsers(); loadStats(); },
      search(q) { S.filter.q = String(q || ''); const i = root.querySelector('[data-f="q"]'); if (i) i.value = S.filter.q; loadUsers(); },
      _cfg: cfg,
      _state: S, _visible: visible, _statusOf: statusOf, _accessOf: accessOf,
    };
    api.refresh();
    return api;
  }

  window.SokoniAdminUsers = { mount, _internal: { statusOf, accessOf, esc, ago, ms } };
})();
