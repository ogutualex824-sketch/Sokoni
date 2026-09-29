/**
 * SOKONI Admin Operating System Engine v1.0
 * Handles data loading, real-time listeners, charts, actions, and table helpers
 * for admin-os.html
 */

"use strict";

window.SokoniAOS = (() => {

  // ── Internal state ──────────────────────────────────────────────────────────
  let _db, _fn, _auth, _currentUser, _listeners = [];
  const _panelCache = {};

  // ── Bootstrap ───────────────────────────────────────────────────────────────
  function init() {
    _db   = firebase.firestore();
    _fn   = firebase.functions();
    _auth = firebase.auth();

    _auth.onAuthStateChanged(async (user) => {
      if (!user) { window.location.href = "login.html"; return; }
      const tok = await user.getIdTokenResult(true);
      if (!tok.claims.admin && !tok.claims.superAdmin) {
        /* Denial must not dump a user on the customer marketplace. When
           sokoni-admin-guard.js is present it already shows an explicit
           "Admin access required" panel naming the workspace they DO hold —
           leave that standing rather than navigating away over the top of it.
           Only pages without the shared guard need a destination, and it is the
           admin console's denial route, never "/". */
        if (window.SokoniAdminGuard) return;
        window.location.href = "admin-os.html?error=insufficient_privileges";
        return;
      }
      _currentUser = { uid: user.uid, email: user.email, name: user.displayName,
                       isSuper: !!tok.claims.superAdmin };
      _bootUI();
    });
  }

  function _bootUI() {
    const el = document.getElementById("aosUserName");
    if (el) el.textContent = _currentUser.name || _currentUser.email;
    if (_currentUser.isSuper) document.body.classList.add("is-super");
    /* DEEP LINK. A route in the hash opens it — `#security`, or `#financial/payouts` for a
       tab inside a section — so admin-os.html#security lands on Security rather than on
       the dashboard, which is what makes the Super Admin sidebar's links truthful rather
       than decorative. Validated by _parseRoute against a nav item and a tab button that
       actually exist, so an unknown or hostile hash falls back to the dashboard and can
       never be spliced into a selector. */
    const _r = _parseRoute(location.hash);
    _navigate(_r ? _r.section : "dashboard", _r ? _r.tab : null);
    _listenForRoutes();
    _startLiveKPIs();
  }

  // ── Navigation ───────────────────────────────────────────────────────────────
  /* Tab selectors keyed by section. A child route calls the EXISTING selector — the
     same function the in-panel tab bar calls — so a sidebar child is never a second
     implementation of a tab. A section absent here has no tab children, and a tab
     is only honoured when its button exists in that panel's tab bar. */
  const _TAB_SELECTORS = {
    estate:      (t) => _estateTab(t),
    marketplace: (t) => _marketplaceTab(t),
    financial:   (t) => _financialTab(t),
    comms:       (t) => _commsTab(t),
    content:     (t) => _contentTab(t),
    smartpos:    (t) => _posTab(t),
    analytics:   (t) => _analyticsTab(t),
  };
  let _route = { section: null, tab: null };

  /* "#section" or "#section/tab" → { section, tab } or null. Only [a-z]+ tokens ever
     reach a selector, and both must exist in the document. A valid section with an
     unknown tab opens the section on its default tab rather than failing the route. */
  function _parseRoute(hash) {
    const m = /^([a-z]+)(?:\/([a-z]+))?$/.exec(String(hash || "").replace(/^#/, "").toLowerCase());
    if (!m) return null;
    const section = m[1], tab = m[2] || null;
    if (!document.querySelector('#aosNav .nav-item[data-section="' + section + '"]:not([data-tab])')) return null;
    const tabOk = tab && document.querySelector('#panel-' + section + ' .tab-bar .tab-btn[data-tab="' + tab + '"]');
    return { section, tab: tabOk ? tab : null };
  }

  /* Sidebar + URL state for a route. Used by navigate() AND by a direct click on an
     in-panel tab button, so the sidebar, the tab bar and the hash never disagree. */
  function _setNavState(section, tab) {
    _route = { section, tab: tab || null };
    document.querySelectorAll("#aosNav .nav-item").forEach(n => { n.classList.remove("active", "parent-active"); n.removeAttribute("aria-current"); });
    const parent = document.querySelector(`#aosNav .nav-item[data-section="${section}"]:not([data-tab])`);
    const child  = tab ? document.querySelector(`#aosNav .nav-item[data-section="${section}"][data-tab="${tab}"]`) : null;
    const nav = child || parent;
    if (child && parent) parent.classList.add("parent-active");
    if (nav) {
      /* .active is the styling hook; aria-current is the state assistive tech reads.
         Both move together here and nowhere else, so they cannot disagree — and a
         child route puts them on the child, never on both. */
      nav.classList.add("active");
      nav.setAttribute("aria-current", "page");
      /* Keep the chosen item in view in the long list. The <nav> is its own
         scroller inside a fixed sidebar, so this never moves the page. */
      try { nav.scrollIntoView({ block: "nearest" }); } catch (_) {}
    }
    const bc = document.getElementById("aosBreadcrumb");
    if (bc) bc.textContent = (parent?.dataset.label || section) + (child ? " · " + (child.dataset.label || tab) : "");
    /* replaceState, not location.hash: no scroll-to-anchor, no history spam and no
       hashchange re-entry. The hashchange listener below still serves a hand-edited URL. */
    const want = "#" + section + (tab ? "/" + tab : "");
    if (location.hash !== want) { try { history.replaceState(null, "", want); } catch (_) {} }
  }

  function _navigate(section, tab) {
    const select = _TAB_SELECTORS[section];
    const requested = (tab && select) ? tab : null;
    document.querySelectorAll(".aos-panel").forEach(p => p.hidden = true);
    const panel = document.getElementById("panel-" + section);
    if (panel) panel.hidden = false;
    /* Re-opening a loaded section from its parent item shows whatever tab is already
       on screen; the sidebar and the hash say so rather than claiming the default. */
    let shown = requested;
    if (!shown && select && _panelCache[section] && panel)
      shown = (panel.querySelector(".tab-bar .tab-btn.active") || {}).dataset?.tab || null;
    _setNavState(section, shown);
    if (!_panelCache[section]) {
      _panelCache[section] = true;
      /* A requested tab REPLACES the loader on first open: every tab-bearing loader is
         exactly `_xTab(<default>)`, so running both would race two renders into one body. */
      if (requested) select(requested); else _loadPanel(section);
    } else if (requested) {
      select(requested);
    }
  }

  /* Attached from _bootUI, once the UI exists and the operator is verified — not at
     script load, where there is no routed UI to keep in step yet. */
  let _routesListening = false;
  function _listenForRoutes() {
    if (_routesListening) return;
    _routesListening = true;
    /* A hand-edited URL still routes (replaceState never fires this). */
    window.addEventListener("hashchange", () => {
      const r = _parseRoute(location.hash);
      if (r && (r.section !== _route.section || r.tab !== _route.tab)) _navigate(r.section, r.tab);
    });
    /* A direct click on an in-panel tab is secondary navigation; it reports its state to
       the sidebar and the URL rather than leaving them pointing at the parent. */
    document.addEventListener("click", (e) => {
      const b = e.target && e.target.closest && e.target.closest(".aos-panel .tab-bar .tab-btn[data-tab]");
      if (!b) return;
      const panel = b.closest(".aos-panel");
      if (panel && panel.id.indexOf("panel-") === 0) _setNavState(panel.id.slice(6), b.dataset.tab);
    });
  }

  function _loadPanel(s) {
    const loaders = {
      dashboard:     _loadDashboard,
      users:         () => _loadUsers(),
      applications:  () => _loadApplications(),
      estate:        () => _loadEstate(),
      marketplace:   () => _loadMarketplace(),
      services:      () => _loadServices(),
      delivery:      () => _loadDelivery(),
      financial:     () => _loadFinancial(),
      bookings:      () => _loadBookings(),
      payments:      () => _loadPayments(),
      support:       () => _loadSupport(),
      comms:         () => _loadComms(),
      content:       () => _loadContent(),
      ai:            () => _loadAI(),
      search:        () => _loadSearch(),
      smartpos:      () => _loadSmartPOS(),
      fraud:         () => _loadFraud(),
      analytics:     () => _loadAnalytics(),
      config:        () => _loadConfig(),
      audit:         () => _loadAudit(),
      security:      () => _loadSecurity(),
      /* Invoices. NECESSARILY SHOP-SCOPED: every invoice callable takes a shopId and runs
         _assertShop, which admits a platform admin but still answers for ONE shop. There
         is no cross-shop invoice query anywhere in functions/, so this panel asks which
         shop rather than implying a platform-wide ledger it cannot read. */
      invoices:      () => _loadInvoices(),
      hubs:          () => _loadHubs(),
      workflows:     () => _loadWorkflows(),
      /* Integrations Control Center. Self-contained in sokoni-integrations.js:
         it reads its own canonical Firestore collections and does not route
         through _call/adminOsDispatch, so it needs no new dispatch op and no
         function deploy. If the script is missing the panel says so rather
         than rendering an empty console. */
      integrations:  () => _loadIntegrations(),
      /* Reports Builder. Like the integrations console it reads its own
         canonical collection directly and routes through no dispatch op. */
      reports:       () => _loadReports(),
      revenue:       () => _loadRevenue(),
    };
    loaders[s]?.();
  }

  // Admin-OS ops whitelist — routes through adminOsDispatch to reduce Cloud Run services
  const _ADMIN_OS_OPS = new Set([
    'adminCreateSupportTicket','adminDeleteBanner','adminDeleteFaq',
    'adminGetAiStats','adminGetAnnouncements','adminGetAuditLogs','adminGetBanners',
    'adminGetBookings','adminGetCategories','adminGetDeliveryStats','adminGetDisputes',
    'adminGetExecutiveDashboard','adminGetFaqs','adminGetFeatureFlags','adminGetFinance','adminGetFraudAlerts',
    'adminGetMerchantPipeline','adminGetOrders','aosGetPendingPayouts','adminGetPlatformOverview','adminGetPlatformSettings',
    'adminGetPayments','adminGetPosDevices','adminGetProducts','adminGetProviders','adminGetRecentNotifications','adminGetReviews','adminGetServices',
    'adminGetSearchStats','adminGetSupportTickets','adminGetSystemHealth','adminGetUser',
    'aosResolveDispute','adminResolveSupportTicket','adminSaveAnnouncement','adminSaveBanner',
    'adminSearchUsers','adminScheduleUserDeletion','adminMessageUser','adminGetUserMessages','adminSendPushNotification','adminUpdateFeatureFlag','adminUpdateOrderStatus',
    'adminUpdatePlatformSettings','adminUpdateProductStatus','adminUpdateUserRole',
    'adminUpsertCategory','adminUpsertFaq',
    /* Merchant estate. _h-only handlers: no new Cloud Run service, but
       adminOsDispatch must be redeployed before they resolve. */
    'adminGetShops','adminGetSellers','adminGetShopDetail',
  ]);

  // ── CF caller ─────────────────────────────────────────────────────────────────
  async function _call(name, data = {}) {
    if (_ADMIN_OS_OPS.has(name)) {
      const r = await _fn.httpsCallable('adminOsDispatch')({ op: name, ...data });
      return r.data;
    }
    const fn = _fn.httpsCallable(name);
    const r  = await fn(data);
    return r.data;
  }

  // ── Live KPI Listeners (Dashboard only) ──────────────────────────────────────
  function _startLiveKPIs() {
    const today = new Date().toISOString().slice(0, 10);

    _listen(_db.collection("orders")
      .where("createdAt", ">=", firebase.firestore.Timestamp.fromDate(new Date(today)))
      .orderBy("createdAt", "desc").limit(500),
      snap => {
        _set("kpiOrdersToday", snap.size);
        const rev = snap.docs.reduce((s, d) => s + (d.data().total || 0), 0);
        _set("kpiRevenueToday", "KES " + _fmt(rev));
      });

    _listen(_db.collection("users").where("status", "==", "active"),
      snap => _set("kpiActiveUsers", _fmt(snap.size)));

    _listen(_db.collection("supportTickets").where("status", "==", "open"),
      snap => _set("kpiOpenTickets", snap.size));

    /* Canonical: withdrawals live in `payoutRequests` (was stale `payouts` → KPI read 0). */
    _listen(_db.collection("payoutRequests").where("status", "==", "pending"),
      snap => _set("kpiPendingPayouts", snap.size));

    _listen(_db.collection("disputes").where("status", "==", "open"),
      snap => _set("kpiDisputes", snap.size));

    _listen(_db.collection("businesses").where("status", "==", "active"),
      snap => _set("kpiActiveBusinesses", _fmt(snap.size)));

    /* Canonical service bookings = `providerBookings` (was venue `bookings`). */
    _listen(_db.collection("providerBookings").where("status", "in", ["confirmed", "pending"]),
      snap => _set("kpiActiveBookings", _fmt(snap.size)));
  }

  function _listen(query, cb) {
    const unsub = query.onSnapshot(cb, () => {});
    _listeners.push(unsub);
  }

  // ── Dashboard ────────────────────────────────────────────────────────────────
  function _kes(v) { return "KES " + _fmt(Math.round(Number(v) || 0)); }
  function _ecSkeleton() { return '<div class="ec-grid">' + Array.from({ length: 8 }).map(function () { return '<div class="ec-skel"></div>'; }).join('') + '</div>'; }
  /* Render an object as a readable key-value block (recursive) — never raw JSON to admins. */
  function _kvHtml(obj) {
    if (obj == null) return '<div class="aos-muted">No data</div>';
    if (typeof obj !== "object") return _esc(String(obj));
    var keys = Object.keys(obj);
    if (!keys.length) return '<div class="aos-muted">Empty</div>';
    return '<div class="kv">' + keys.map(function (k) {
      var v = obj[k], disp;
      if (Array.isArray(v)) disp = '<strong>' + v.length + ' item' + (v.length === 1 ? '' : 's') + '</strong>';
      else if (v && typeof v === "object") disp = _kvHtml(v);
      else disp = '<strong>' + _esc(String(v)) + '</strong>';
      return '<div class="kv-row"><span>' + _esc(_titleCase(k)) + '</span>' + disp + '</div>';
    }).join("") + '</div>';
  }
  /* P1 Command Center — 4 sections, canonical single entry (adminGetExecutiveDashboard)
     + reused Finance data (adminGetFinance.reconciliation). No recalculation here. */
  function _renderExecCommand(x, f, sysHealth, pipeline) {
    var ec = document.getElementById("execCommand"); if (!ec) return;
    function cell(l, v, attn) { return '<div class="ec-cell' + (attn ? ' attn' : '') + '"><div class="l">' + l + '</div><div class="v">' + v + '</div></div>'; }
    function money(l, v) { return '<div class="ec-cell"><div class="l">' + l + '</div><div class="v money">' + _kes(v) + '</div></div>'; }
    var kpis = [
      cell('Total Users', _fmt(x.totalUsers || 0)), cell('Active Users', _fmt(x.activeUsers || 0)),
      cell('Providers', _fmt(x.totalProviders || 0)), cell('Active Providers', _fmt(x.activeProviders || 0)),
      cell('Merchants', _fmt(x.merchants || 0)), cell('Product Orders', _fmt(x.totalOrders || 0)),
      cell('Service Bookings', _fmt(x.totalServiceBookings || 0)),
      money('GMV · 30d', f.grossRevenue), money('Net Revenue · 30d', f.netPlatformRevenue), money('Wallet Float', f.walletFloat),
      cell('Pending Payouts', _fmt(x.pendingPayouts || 0) + (x.pendingPayoutAmount ? ' · ' + _kes(x.pendingPayoutAmount) : '')),
    ].join('');
    var ops = [
      cell('Pending Verification', _fmt(x.pendingProviderVerification || 0), (x.pendingProviderVerification || 0) > 0),
      cell('Merchant Approvals', _fmt(x.pendingMerchantApprovals || 0), (x.pendingMerchantApprovals || 0) > 0),
      cell('Pending Withdrawals', _fmt(x.pendingPayouts || 0), (x.pendingPayouts || 0) > 0),
      cell('Support Tickets', _fmt(x.openTickets || 0), (x.openTickets || 0) > 0),
      cell('Open Disputes', _fmt(x.openDisputes || 0), (x.openDisputes || 0) > 0),
      cell('Reviews to Moderate', _fmt(x.reviewsAwaitingModeration || 0), (x.reviewsAwaitingModeration || 0) > 0),
    ].join('');
    var fin = [
      money('Revenue Today', x.revenueToday), money('Revenue · 30d', f.grossRevenue), money('Commissions · 30d', f.commission),
      money('Pending Withdrawals', f.pendingWithdrawals), money('Completed Withdrawals', f.completedWithdrawals), money('Wallet Float', f.walletFloat),
    ].join('');
    /* Health strip — real per-service status from adminGetSystemHealth (P2). Services
       without a server-side signal report 'unknown' (never faked green). */
    var H = (sysHealth && sysHealth.services) || {};
    function st(key) { return (H[key] && H[key].status) || 'unknown'; }
    function dt(key) { return (H[key] && H[key].detail) ? ' title="' + String(H[key].detail).replace(/"/g, '') + '"' : ''; }
    var svc = [
      ['Payments', 'payments'], ['Wallet', 'wallet'], ['Search', 'search'], ['Email', 'email'],
      ['SMS', 'sms'], ['Notifications', 'notifications'], ['Cloud Functions', 'cloudFunctions'], ['eTIMS', 'etims'],
    ];
    var strip = svc.map(function (a) { return '<div class="ec-svc"' + dt(a[1]) + '><span class="ec-dot ' + st(a[1]) + '"></span>' + a[0] + '</div>'; }).join('');
    /* Merchant pipeline funnel — Applied → … → Active. Bar width ∝ stage count. */
    var stages = (pipeline && pipeline.stages) || [];
    var mx = stages.reduce(function (a, st2) { return Math.max(a, st2.count || 0); }, 1);
    var funnel = stages.map(function (st2) {
      var w = Math.max(6, Math.round((st2.count || 0) / mx * 100));
      return '<div class="ec-stage"><div class="ec-stage-bar"><span style="width:' + w + '%"></span></div><div class="ec-stage-n">' + _fmt(st2.count || 0) + '</div><div class="ec-stage-l">' + st2.label + '</div></div>';
    }).join('');
    ec.innerHTML =
      '<div class="ec-section"><div class="ec-title">Executive KPIs</div><div class="ec-grid">' + kpis + '</div></div>' +
      '<div class="ec-section"><div class="ec-title">Operational Status</div><div class="ec-grid">' + ops + '</div></div>' +
      '<div class="ec-section"><div class="ec-title">Financial Summary · 30-day</div><div class="ec-grid">' + fin + '</div></div>' +
      (stages.length ? '<div class="ec-section"><div class="ec-title">Merchant Pipeline</div><div class="ec-funnel">' + funnel + '</div></div>' : '') +
      '<div class="ec-section"><div class="ec-title">Platform Health <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--aos-sub)">· real-time signals</span></div><div class="ec-strip">' + strip + '</div></div>';
  }

  async function _loadDashboard() {
    var _ec = document.getElementById("execCommand"); if (_ec) _ec.innerHTML = _ecSkeleton();
    try {
      const [metrics, health, daily, execRes, finRes, sysRes, pipeRes] = await Promise.allSettled([
        _call("adminGetPlatformOverview"),
        _call("getPlatformHealthScores"),
        _call("getDailyReport"),
        _call("adminGetExecutiveDashboard"),
        _call("adminGetFinance"),
        _call("adminGetSystemHealth"),
        _call("adminGetMerchantPipeline"),
      ]);

      const m = metrics.value || {};
      const h = health.value  || {};
      const d = daily.value   || {};
      /* Command center — canonical single entry + reused Finance + real health + pipeline. */
      _renderExecCommand(execRes.value || {}, (finRes.value && finRes.value.reconciliation) || {}, sysRes.value || {}, pipeRes.value || {});

      _set("kpiActiveSellers",    _fmt(m.activeSellers    || 0));
      _set("kpiActiveProviders",  _fmt(m.activeProviders  || 0));
      _set("kpiActiveRiders",     _fmt(m.activeRiders     || 0));
      _set("kpiNewRegistrations", _fmt(m.newRegistrations || d.newUsers || 0));
      _set("kpiCommission",       "KES " + _fmt(m.commissionEarned || d.commissionEarned || 0));
      _set("kpiFailedPayments",   _fmt(m.failedPayments   || 0));
      _set("kpiRefundRequests",   _fmt(m.refundRequests   || 0));
      _set("kpiActiveSubs",       _fmt(m.activeSubscriptions || 0));
      _set("kpiInventoryAlerts",  _fmt(m.inventoryAlerts || 0));
      _set("kpiMRR",              "KES " + _fmt(m.mrr || m.monthlyRevenue || 0));
      _set("kpiPlatformUptime",   (m.uptimePct !== undefined ? m.uptimePct : 99.9).toFixed(1) + "%");

      // Health scores
      if (h.scores) {
        const scores = h.scores;
        const scoreEl = document.getElementById("healthScores");
        if (scoreEl) scoreEl.innerHTML = Object.entries(scores)
          .map(([k, v]) => `<div class="health-chip" data-score="${v}">
            <span>${_titleCase(k)}</span>
            <strong>${v}<small>/100</small></strong>
            <div class="health-bar"><div style="width:${v}%"></div></div>
          </div>`).join("");
      }

      // Revenue chart from daily report
      if (d.revenueByDay) _drawLineChart("revenueChart", d.revenueByDay, "KES");

      // Recent alerts
      _loadAlerts();

    } catch (e) {
      console.error("[AOS] Dashboard load error:", e);
      var ec = document.getElementById("execCommand");
      if (ec) ec.innerHTML = '<div class="ec-section" style="text-align:center;padding:24px;color:var(--aos-sub)">Couldn’t load the command center. <button class="aos-btn-sm" onclick="SokoniAOS.reloadDashboard()">Try again</button></div>';
    }
  }

  async function _loadAlerts() {
    const snap = await _db.collection("adminAlerts").where("resolved", "==", false)
      .orderBy("createdAt", "desc").limit(5).get().catch(() => null);
    if (!snap) return;
    const el = document.getElementById("dashAlerts");
    if (!el) return;
    el.innerHTML = snap.empty
      ? "<p class='aos-muted'>No active alerts.</p>"
      : snap.docs.map(d => {
          const a = d.data();
          return `<div class="alert-chip sev-${a.severity||'info'}">
            <span class="alert-icon">${_sevIcon(a.severity)}</span>
            <span>${_esc(a.message || a.title || "Alert")}</span>
            <time>${_ago(a.createdAt)}</time>
          </div>`;
        }).join("");
  }

  // ── Users ────────────────────────────────────────────────────────────────────
  async function _loadUsers(query = "", role = "", status = "", page = 1) {
    const tbody = document.getElementById("usersBody");
    if (!tbody) return;
    tbody.innerHTML = _loadingRow(7);
    try {
      const data = await _call("adminSearchUsers", { query, role, status, page, limit: 20 });
      const users = data.users || data.results || [];

      /* USER DIRECTORY. Renders the same result set as a richer surface when
         sokoni-aos-users.js is loaded, and otherwise falls through to the table below.

         It replaces only the TABLE — the toolbar above stays, because its search and
         selects re-query the SERVER across all users, which a client-side filter over one
         loaded page cannot do. The rich view filters what is loaded; the toolbar fetches.

         It also renders `displayName`, which is what adminSearchUsers actually returns; the
         table below reads `u.name`, `u.lastLogin` and `u.photoURL`, none of which the
         callable sends — so every legacy row shows an em dash for the name. */
      if (window.SokoniAOSUsers && typeof window.SokoniAOSUsers.mount === "function") {
        try {
          const table = tbody.closest("table");
          const wrap  = table && table.parentElement;
          if (wrap) {
            let rich = document.getElementById("usersRich");
            if (!rich) {
              rich = document.createElement("div");
              rich.id = "usersRich";
              wrap.parentElement.insertBefore(rich, wrap);
            }
            const shown = window.SokoniAOSUsers.mount({
              host: rich, users,
              actions: { viewUser, banUser, changeRole, deleteUser: scheduleUserDeletion,
                         sendMessage: messageUser, loadMessages: loadUserMessages },
            });
            if (shown) {
              wrap.hidden = true;
              const total = document.getElementById("userTotal");
              if (total) total.textContent = _fmt(users.length) + " loaded";
              return;
            }
          }
        } catch (e) {
          console.warn("[AOS] user directory unavailable, using table:", e && e.message);
        }
      }

      if (!users.length) { tbody.innerHTML = _emptyRow(7, "No users found"); return; }
      tbody.innerHTML = users.map(u => `
        <tr>
          <td><img class="avatar" src="${_esc(u.photoURL||"")||"/assets/logosokoni.png"}" onerror="if(!this.dataset.f){this.dataset.f=1;this.src='/assets/logosokoni.png';}"> ${_esc(u.name || "—")}</td>
          <td class="aos-muted">${_esc(u.email||"")}</td>
          <td><span class="role-badge role-${u.role||"buyer"}">${_esc(u.role||"buyer")}</span></td>
          <td><span class="status-badge st-${u.status||"active"}">${_esc(u.status||"active")}</span></td>
          <td class="aos-muted">${_date(u.createdAt)}</td>
          <td class="aos-muted">${_date(u.lastLogin)}</td>
          <td>
            <button class="aos-btn-sm" onclick="SokoniAOS.viewUser('${u.uid||u.id}')">View</button>
            <button class="aos-btn-sm danger" onclick="SokoniAOS.banUser('${u.uid||u.id}','${u.status}')">
              ${u.status==="banned"?"Restore":"Ban"}
            </button>
            <button class="aos-btn-sm" onclick="SokoniAOS.changeRole('${u.uid||u.id}')">Role</button>
          </td>
        </tr>`).join("");
      const total = document.getElementById("userTotal");
      if (total) total.textContent = _fmt(data.total || users.length) + " users";
    } catch (e) { tbody.innerHTML = _emptyRow(7, "Error loading users: " + e.message); }
  }

  async function viewUser(uid) {
    const data = await _call("adminGetUser", { uid }).catch(() => null);
    if (!data) { _toast("Could not load user", "error"); return; }
    const u = data.user || data;
    _modal("User: " + (u.name || u.email), `
      <div class="user-detail-grid">
        <div><strong>UID</strong><span>${_esc(u.uid||uid)}</span></div>
        <div><strong>Email</strong><span>${_esc(u.email||"—")}</span></div>
        <div><strong>Phone</strong><span>${_esc(u.phone||"—")}</span></div>
        <div><strong>Role</strong><span class="role-badge role-${u.role||"buyer"}">${_esc(u.role||"buyer")}</span></div>
        <div><strong>Status</strong><span class="status-badge st-${u.status||"active"}">${_esc(u.status||"active")}</span></div>
        <div><strong>Joined</strong><span>${_date(u.createdAt)}</span></div>
        <div><strong>Last Login</strong><span>${_date(u.lastLogin)}</span></div>
        <div><strong>Orders</strong><span>${_fmt(u.orderCount||0)}</span></div>
        <div><strong>Wallet</strong><span>KES ${_fmt(u.walletBalance||0)}</span></div>
        <div><strong>Verified</strong><span>${u.emailVerified?"✅":"❌"}</span></div>
      </div>
    `);
  }

  /* SEND one message on one channel. The server owns the send AND the audit row; this
     only collects what the operator typed. It returns false on refusal so the composer
     keeps the text rather than clearing a message that never went anywhere. */
  async function messageUser(payload) {
    try {
      const r = await _call("adminMessageUser", payload);
      const what = payload.channel === 'inapp' ? 'In-app message delivered'
                 : payload.channel === 'email' ? 'Email queued for delivery'
                 : 'SMS sent';
      _toast(what + (r && r.status && r.status !== 'delivered' ? ' (' + r.status + ')' : ''), "success");
      return true;
    } catch (e) {
      const m = (e && e.message) || 'Could not send.';
      _toast(/not-found|not found|unknown op/i.test(m)
        ? 'Messaging is not available yet: the admin dispatcher has not been redeployed.'
        : m, "error");
      return false;
    }
  }

  /* The history is the ADMIN AUDIT TRAIL, read server-side. Returning [] on failure would
     claim "no messages ever sent"; the module distinguishes that from a failed read. */
  async function loadUserMessages(uid) {
    const data = await _call("adminGetUserMessages", { targetUid: uid, limit: 50 });
    return (data && data.messages) || [];
  }

  /* SCHEDULE a deletion — it does not delete. The server sets the date (30 days) and the
     already-deployed finaliseExpiredDeletions worker performs the irreversible work in the
     right order: redact, anonymise, retain what the law requires, purge Storage, and only
     then remove the Auth account.

     The confirmation is TYPED, not a yes/no: this acts on somebody else's account and
     cannot be undone once the grace period expires. It names the account, states the grace
     period, and says that the user cancels simply by signing in — which is true, because
     cancelAccountDeletion runs on sign-in. */
  async function scheduleUserDeletion(uid, name) {
    const who = name || uid;
    const reason = prompt(
      'Schedule deletion of "' + who + '"?\n\n' +
      'The account is marked for deletion in 30 days. On the day, SOKONI redacts and\n' +
      'anonymises their data, purges their files, and removes the sign-in account.\n' +
      'The user cancels it simply by signing in during those 30 days.\n\n' +
      'Reason (required, recorded in the audit log):');
    if (reason === null) return;
    if (String(reason).trim().length < 3) {
      _toast('A reason is required — nothing was scheduled.', 'error');
      return;
    }
    const typed = prompt('Type DELETE to confirm scheduling deletion of "' + who + '".');
    if (String(typed || '').trim().toUpperCase() !== 'DELETE') {
      _toast('Not confirmed — nothing was scheduled.', 'error');
      return;
    }
    try {
      const r = await _call("adminScheduleUserDeletion", { targetUid: uid, reason });
      const on = r && r.scheduledAt ? new Date(r.scheduledAt).toLocaleDateString('en-KE',
        { day: 'numeric', month: 'short', year: 'numeric' }) : 'in 30 days';
      _toast('Deletion scheduled for ' + on + ' — the user can cancel by signing in.', 'success');
    } catch (e) {
      /* Until adminOsDispatch is redeployed this op does not resolve. Say that plainly
         rather than reporting a generic failure for a button that cannot yet work. */
      const m = (e && e.message) || 'Could not schedule deletion.';
      _toast(/not-found|not found|unknown op/i.test(m)
        ? 'Deletion is not available yet: the admin dispatcher has not been redeployed.'
        : m, 'error');
      return;
    }
    _panelCache.users = false; _loadUsers();
  }

  async function banUser(uid, currentStatus) {
    const action = currentStatus === "banned" ? "restore" : "ban";
    if (!(await SK.dialog.confirm(`${_titleCase(action)} this user?`, null, null, { title: `${_titleCase(action)} user`, variant: 'danger', confirmLabel: _titleCase(action) }))) return;
    try {
      await _call("tsBanUser", { userId: uid, action });
    } catch (e) {
      _toast(e.message, "error");
      return;
    }
    _toast("User " + action + "ned successfully", "success");
    _panelCache.users = false; _loadUsers();
  }

  async function changeRole(uid) {
    const role = prompt("Enter new role:\nbuyer, seller, provider, driver, agent, doctor, lawyer, hotel, freelancer, employee, moderator, admin");
    if (!role) return;
    try {
      await _call("adminUpdateUserRole", { uid, role });
    } catch (e) {
      _toast(e.message, "error");
      return;
    }
    _toast("Role updated", "success");
    _panelCache.users = false; _loadUsers();
  }

  // ── Marketplace ──────────────────────────────────────────────────────────────
  async function _loadMarketplace() {
    _marketplaceTab("products");
  }

  async function _marketplaceTab(tab) {
    document.querySelectorAll("#panel-marketplace .tab-btn").forEach(b => {
      b.classList.toggle("active", b.dataset.tab === tab);
    });
    const body = document.getElementById("mktBody");
    if (!body) return;
    body.innerHTML = _spinner();

    if (tab === "products") {
      // 30 was a table's worth, not a contract limit; the read is capped at 200 server-side.
      // The workspace counts what it LOADS and says so, so a larger page makes its figures
      // more useful without making any of them a catalogue total.
      const data = await _call("adminGetProducts", { limit: 200 }).catch(() => ({ products: [] }));
      const prods = data.products || [];

      // Rich catalogue workspace. Additive: if the module is absent or declines, the original
      // table below renders exactly as before.
      if (window.SokoniAOSProducts && typeof window.SokoniAOSProducts.mount === "function") {
        try {
          const rich = document.createElement("div");
          rich.id = "productsRich";
          body.innerHTML = "";
          body.appendChild(rich);
          const shown = window.SokoniAOSProducts.mount({
            host: rich,
            products: prods,
            // The one write AdminOS already owns. No price, stock or delete control is
            // passed: stock is inventory authority's, and a product is tombstoned, never
            // deleted.
            actions: { updateStatus: (id) => _promptProductStatus(id) },
          });
          if (shown) return;
          body.innerHTML = "";
        } catch (e) {
          console.warn("[AOS] products workspace unavailable, using table:", e && e.message);
          body.innerHTML = "";
        }
      }

      body.innerHTML = prods.length ? `<table class="aos-table"><thead><tr>
          <th>Product</th><th>Seller</th><th>Price</th><th>Status</th><th>Actions</th>
        </tr></thead><tbody>${prods.map(p => `<tr>
          <td>${_esc(p.name||"—")}</td>
          <td class="aos-muted">${_esc(p.sellerName||p.sellerUid||"—")}</td>
          <td>KES ${_fmt(p.price||0)}</td>
          <td><span class="status-badge st-${p.status||"active"}">${_esc(p.status||"active")}</span></td>
          <td>
            <button class="aos-btn-sm" onclick="SokoniAOS.updateProduct('${p.id}','active')">Approve</button>
            <button class="aos-btn-sm danger" onclick="SokoniAOS.updateProduct('${p.id}','removed')">Remove</button>
          </td>
        </tr>`).join("")}</tbody></table>` : _emptyMsg("No products");
    } else if (tab === "orders") {
      // The read is capped at 200 server-side; 30 was a table's worth, not a limit of the
      // contract. The workspace counts what it loads and says so, so a larger page makes
      // its figures more useful without making any of them a platform total.
      const data = await _call("adminGetOrders", { limit: 200 }).catch(() => ({ orders: [] }));
      const orders = data.orders || [];

      // Rich orders workspace. Additive: if the module is absent or declines, the original
      // table below renders exactly as before.
      if (window.SokoniAOSOrders && typeof window.SokoniAOSOrders.mount === "function") {
        try {
          const rich = document.createElement("div");
          rich.id = "ordersRich";
          body.innerHTML = "";
          body.appendChild(rich);
          const shown = window.SokoniAOSOrders.mount({
            host: rich,
            orders,
            // The one write this desk offers, delegated to the action AdminOS already owns.
            // No refund control is passed, because none exists that is safe to click.
            actions: { updateStatus: (id) => updateOrder(id) },
          });
          if (shown) return;
          body.innerHTML = "";
        } catch (e) {
          console.warn("[AOS] orders workspace unavailable, using table:", e && e.message);
          body.innerHTML = "";
        }
      }

      body.innerHTML = orders.length ? `<table class="aos-table"><thead><tr>
          <th>Order ID</th><th>Buyer</th><th>Total</th><th>Status</th><th>Date</th><th>Actions</th>
        </tr></thead><tbody>${orders.map(o => `<tr>
          <td class="aos-mono">${o.id?.slice(0,8)||"—"}</td>
          <td class="aos-muted">${_esc(o.buyerName||o.buyerUid||"—")}</td>
          <td>KES ${_fmt(o.total||0)}</td>
          <td><span class="status-badge st-${o.status||"pending"}">${_esc(o.status||"pending")}</span></td>
          <td class="aos-muted">${_date(o.createdAt)}</td>
          <td><button class="aos-btn-sm" onclick="SokoniAOS.updateOrder('${o.id}')">Update</button></td>
        </tr>`).join("")}</tbody></table>` : _emptyMsg("No orders");
    } else if (tab === "categories") {
      const data = await _call("adminGetCategories").catch(() => ({ categories: [] }));
      const cats = data.categories || [];
      body.innerHTML = `<div class="cat-grid">${cats.map(c => `
        <div class="cat-card">
          <span class="cat-icon">${c.icon||"📦"}</span>
          <strong>${_esc(c.name||"—")}</strong>
          <small>${_fmt(c.productCount||0)} items</small>
          <button class="aos-btn-sm" onclick="SokoniAOS.editCategory('${c.id}','${_esc(c.name||"")}')">Edit</button>
        </div>`).join("")}
        <div class="cat-card cat-add" onclick="SokoniAOS.addCategory()">
          <span>+</span><strong>Add Category</strong>
        </div>
      </div>`;
    } else if (tab === "reviews") {
      const data = await _call("adminGetReviews", { status: "pending", limit: 30 }).catch(() => ({ reviews: [] }));
      const reviews = data.reviews || [];
      body.innerHTML = reviews.length ? `<div class="review-list">${reviews.map(r => `
        <div class="review-item">
          <div class="review-header">
            <strong>${"⭐".repeat(r.rating||0)}</strong>
            <span class="aos-muted">${_esc(r.targetId||"—")}</span>
            <time class="aos-muted">${_date(r.createdAt)}</time>
          </div>
          <p>${_esc(r.body||r.text||"—")}</p>
          <div class="review-actions">
            <button class="aos-btn-sm success" onclick="SokoniAOS.moderateReview('${r.id}','approve')">Approve</button>
            <button class="aos-btn-sm danger"  onclick="SokoniAOS.moderateReview('${r.id}','reject')">Reject</button>
          </div>
        </div>`).join("")}</div>` : _emptyMsg("No reviews pending moderation");
    }
  }

  async function updateProduct(id, status) {
    try {
      await _call("adminUpdateProductStatus", { productId: id, status });
    } catch (e) {
      _toast(e.message || "Update failed", "error");
      return;
    }
    _toast("Product status updated", "success");
    _marketplaceTab("products");
  }

  /* Status picker for the products workspace.
     Deliberately restricted to the two values AdminOS ALREADY writes from its own
     buttons. `adminUpdateProductStatus` accepts any string, so an free-text prompt
     could write a status no reader recognises — which hides a product from every
     filtered view without deleting it, and looks like data loss. If a third status
     is ever wanted here, prove a reader honours it first. */
  function _promptProductStatus(id) {
    const choice = prompt('New product status — type "active" or "removed":');
    if (!choice) return;
    const status = String(choice).trim().toLowerCase();
    if (status !== "active" && status !== "removed") {
      _toast('Not changed: only "active" or "removed" are written from here.', "error");
      return;
    }
    return updateProduct(id, status);
  }

  async function updateOrder(id) {
    const status = prompt("New status (pending/processing/completed/cancelled):");
    if (!status) return;
    try {
      await _call("adminUpdateOrderStatus", { orderId: id, status });
    } catch (e) {
      _toast(e.message || "Update failed", "error");
      return;
    }
    _toast("Order updated", "success");
    _marketplaceTab("orders");
  }

  async function moderateReview(id, action) {
    /* The success toast must never fire on a failed call. The previous form
       swallowed the error in .catch() and then toasted success unconditionally,
       so an admin saw "Review approved" even when moderation never happened —
       and the ratingsSummary recalc that makes the review visible to the shop
       never ran. */
    try {
      await _call("adminModerateReview", { reviewId: id, action });
    } catch (e) {
      _toast(e.message || "Moderation failed", "error");
      return;
    }
    _toast("Review " + (action === "approve" ? "approved" : action === "reject" ? "rejected" : "restored"), "success");
    _marketplaceTab("reviews");
  }

  async function editCategory(id, name) {
    const newName = prompt("Category name:", name);
    if (!newName) return;
    try {
      await _call("adminUpsertCategory", { id, name: newName });
    } catch (e) {
      _toast(e.message, "error");
      return;
    }
    _toast("Category updated", "success");
    _marketplaceTab("categories");
  }

  async function addCategory() {
    const name = prompt("New category name:");
    if (!name) return;
    const icon = prompt("Icon emoji:", "📦");
    try {
      await _call("adminUpsertCategory", { name, icon: icon || "📦" });
    } catch (e) {
      _toast(e.message, "error");
      return;
    }
    _toast("Category added", "success");
    _marketplaceTab("categories");
  }

  // ── Services ─────────────────────────────────────────────────────────────────
  async function _loadServices() {
    const body = document.getElementById("servicesBody");
    if (!body) return;
    body.innerHTML = _spinner();
    try {
      /* Canonical: adminGetProviders (was a direct `providers` Firestore read — a
         non-canonical-source defect). Wires the deployed, previously-unused op. */
      const data = await _call("adminGetProviders", { limit: 50 });
      const items = data.items || data.providers || [];
      const rows = items.map(p => `<tr>
          <td>${_esc(p.name||"—")}</td>
          <td class="aos-muted">${_esc(p.category||"—")}</td>
          <td>${_esc(p.location||"—")}</td>
          <td><span class="status-badge st-${_esc(p.status||"—")}">${_esc(p.status||"—")}${p.verified?" ✓":""}</span></td>
          <td>${_fmt(p.jobsCompleted||0)}</td>
          <td>${(p.rating||0).toFixed(1)} ⭐</td>
          <td><button class="aos-btn-sm" onclick="SokoniAOS.viewUser('${_esc(p.uid)}')">View</button></td>
        </tr>`);
      body.innerHTML = rows.length
        ? `<table class="aos-table"><thead><tr><th>Name</th><th>Category</th><th>Location</th><th>Status</th><th>Jobs</th><th>Rating</th><th>Actions</th></tr></thead><tbody>${rows.join("")}</tbody></table>`
        : _emptyMsg("No providers found");
    } catch (e) {
      body.innerHTML = _emptyMsg("Couldn't load providers.") + '<div style="text-align:center;margin-top:8px"><button class="aos-btn-sm" onclick="SokoniAOS.navigate(\'services\')">Try again</button></div>';
    }
  }

  // ── Bookings (canonical providerBookings via adminGetBookings) ───────────────
  async function _loadBookings(status) {
    const body = document.getElementById("bookingsBody");
    if (!body) return;
    body.innerHTML = _spinner();
    try {
      const data = await _call("adminGetBookings", status ? { status: status, limit: 60 } : { limit: 60 });
      const items = data.bookings || data.items || [];
      const q = ((document.getElementById("bookingsSearch") || {}).value || "").toLowerCase();
      const list = q ? items.filter(b => ((b.customerName || "") + " " + (b.service || "") + " " + (b.status || "") + " " + (b.id || "")).toLowerCase().indexOf(q) > -1) : items;
      const rows = list.map(b => `<tr>
          <td>${_esc(b.customerName||"—")}</td>
          <td class="aos-muted">${_esc(b.service||"—")}</td>
          <td>${_esc(((b.date||"")+" "+(b.startTime||"")).trim()||"—")}</td>
          <td><span class="status-badge st-${_esc(b.status||"")}">${_esc(b.status||"—")}</span></td>
          <td class="aos-muted">${_esc(b.paymentStatus||"—")}</td>
          <td>${b.price?("KES "+_fmt(Math.round((b.price||0)/100))):"—"}</td>
          <td><button class="aos-btn-sm" onclick="SokoniAOS.viewUser('${_esc(b.customerUid||"")}')">Customer</button></td>
        </tr>`);
      body.innerHTML = rows.length
        ? `<table class="aos-table"><thead><tr><th>Customer</th><th>Service</th><th>When</th><th>Status</th><th>Payment</th><th>Amount</th><th></th></tr></thead><tbody>${rows.join("")}</tbody></table>`
        : _emptyMsg(q ? "No matching bookings" : "No bookings found");
    } catch (e) {
      body.innerHTML = _emptyMsg("Couldn't load bookings.") + '<div style="text-align:center;margin-top:8px"><button class="aos-btn-sm" onclick="SokoniAOS.navigate(\'bookings\')">Try again</button></div>';
    }
  }

  // ── Payments — collections (canonical `payments` via adminGetPayments) ────────
  async function _loadPayments(status) {
    const body = document.getElementById("paymentsBody");
    if (!body) return;
    body.innerHTML = _spinner();
    try {
      const data = await _call("adminGetPayments", { limit: 100 });
      let items = data.payments || data.items || data.rows || [];
      if (status) items = items.filter(p => String(p.status || "").toLowerCase() === status);
      const rows = items.map(p => `<tr>
          <td class="aos-muted" style="font-family:monospace;font-size:.74rem">${_esc(String(p.id||"").slice(0,12))}</td>
          <td>KES ${_fmt(Math.round(p.amount||0))}</td>
          <td><span class="status-badge st-${_esc(String(p.status||"").toLowerCase())}">${_esc(p.status||"—")}</span></td>
          <td>${_esc(p.sellerName||"—")}</td>
          <td class="aos-muted">${_esc(p.mpesaCode||"—")}</td>
        </tr>`);
      body.innerHTML = rows.length
        ? `<table class="aos-table"><thead><tr><th>Ref</th><th>Amount</th><th>Status</th><th>Seller</th><th>M-Pesa Ref</th></tr></thead><tbody>${rows.join("")}</tbody></table>`
        : _emptyMsg("No payments found");
    } catch (e) {
      body.innerHTML = _emptyMsg("Couldn't load payments.") + '<div style="text-align:center;margin-top:8px"><button class="aos-btn-sm" onclick="SokoniAOS.navigate(\'payments\')">Try again</button></div>';
    }
  }

  // ── Delivery ─────────────────────────────────────────────────────────────────
  async function _loadDelivery() {
    const body = document.getElementById("deliveryBody");
    if (!body) return;
    body.innerHTML = _spinner();
    try {
      const [statsData, snap] = await Promise.all([
        _call("adminGetDeliveryStats").catch(() => ({})),
        _db.collection("deliveries").orderBy("createdAt","desc").limit(50).get(),
      ]);
      const s = statsData.stats || statsData;
      document.getElementById("deliveringNow").textContent  = _fmt(s.activeDeliveries || 0);
      document.getElementById("deliveredToday").textContent = _fmt(s.completedToday || 0);
      document.getElementById("avgDeliveryMin").textContent = (s.avgMinutes || 0) + "min";
      _set("deliveryFailed",  _fmt(s.failedToday || 0));
      _set("deliveryOnTime",  (s.onTimeRate || 0).toFixed(0) + "%");
      _set("deliveryRiders",  _fmt(s.activeRiders || 0));

      const orders = snap.docs.map(d => {
        const o = d.data();
        return `<tr>
          <td class="aos-mono">${d.id.slice(0,8)}</td>
          <td>${_esc(o.driverName||o.driverUid||"Unassigned")}</td>
          <td>${_esc(o.deliveryAddress||"—")}</td>
          <td><span class="status-badge st-${o.status||"pending"}">${_esc(o.status||"pending")}</span></td>
          <td class="aos-muted">${_date(o.createdAt)}</td>
        </tr>`;
      });
      body.innerHTML = `<table class="aos-table"><thead><tr><th>ID</th><th>Driver</th><th>Address</th><th>Status</th><th>Time</th></tr></thead>
        <tbody>${orders.join("") || _emptyRow(5,"No deliveries")}</tbody></table>`;
    } catch (e) { body.innerHTML = _emptyMsg("Error: " + e.message); }
  }

  // ── Financial ─────────────────────────────────────────────────────────────────
  async function _loadFinancial() { _financialTab("payments"); }

  async function _financialTab(tab) {
    document.querySelectorAll("#panel-financial .tab-btn").forEach(b =>
      b.classList.toggle("active", b.dataset.tab === tab));
    const body = document.getElementById("finBody");
    if (!body) return;
    body.innerHTML = _spinner();
    try {
      if (tab === "payments") {
        const data = await _call("getAdminRevenueReport", { days: 7 });
        const r = data.report || data;
        body.innerHTML = `<div class="fin-stats">
          <div class="fin-stat"><span>7-Day Revenue</span><strong>KES ${_fmt(r.totalRevenue||0)}</strong></div>
          <div class="fin-stat"><span>Platform Commission</span><strong>KES ${_fmt(r.totalCommission||0)}</strong></div>
          <div class="fin-stat"><span>Refunds Issued</span><strong>KES ${_fmt(r.totalRefunds||0)}</strong></div>
          <div class="fin-stat"><span>Gross Margin</span><strong>${((r.margin||0)*100).toFixed(1)}%</strong></div>
        </div>
        ${r.revenueByDay ? `<div class="chart-wrap"><canvas id="finChart" height="180"></canvas></div>` : ""}`;
        if (r.revenueByDay) _drawLineChart("finChart", r.revenueByDay, "KES");
      } else if (tab === "commissions") {
        const data = await _call("getCommissionLedger", { limit: 30 });
        const items = data.entries || [];
        body.innerHTML = items.length ? `<table class="aos-table"><thead><tr>
            <th>Seller</th><th>Order</th><th>Gross</th><th>Commission</th><th>Net</th><th>Status</th><th>Actions</th>
          </tr></thead><tbody>${items.map(c => `<tr>
            <td>${_esc(c.sellerName||c.sellerUid||"—")}</td>
            <td class="aos-mono">${(c.orderId||"—").slice(0,8)}</td>
            <td>KES ${_fmt(c.grossAmount||0)}</td>
            <td>KES ${_fmt(c.commissionAmount||0)}</td>
            <td>KES ${_fmt(c.netAmount||0)}</td>
            <td><span class="status-badge st-${c.status||"pending"}">${c.status||"pending"}</span></td>
            <td>${c.status!=="paid"?`<button class="aos-btn-sm success" onclick="SokoniAOS.markCommPaid('${c.id}')">Mark Paid</button>`:"—"}</td>
          </tr>`).join("")}</tbody></table>` : _emptyMsg("No commission entries");
      } else if (tab === "payouts") {
        const data = await _call("aosGetPendingPayouts");
        const payouts = data.payouts || [];
        body.innerHTML = payouts.length ? `<div class="payout-actions">
          <button class="aos-btn success" onclick="SokoniAOS.approveAllPayouts()">Approve All (${payouts.length})</button>
        </div>
        <table class="aos-table"><thead><tr>
            <th>Seller</th><th>Amount</th><th>Bank</th><th>Requested</th><th>Actions</th>
          </tr></thead><tbody>${payouts.map(p => `<tr>
            <td>${_esc(p.sellerName||p.uid||"—")}</td>
            <td>KES ${_fmt(p.amount||0)}</td>
            <td class="aos-muted">${_esc(p.bankName||"—")}</td>
            <td class="aos-muted">${_date(p.requestedAt)}</td>
            <td>
              <button class="aos-btn-sm success" onclick="SokoniAOS.approvePayout('${p.id}')">Approve</button>
              <button class="aos-btn-sm danger" onclick="SokoniAOS.rejectPayout('${p.id}')">Reject</button>
            </td>
          </tr>`).join("")}</tbody></table>` : _emptyMsg("No pending payouts");
      } else if (tab === "disputes") {
        const data = await _call("adminGetDisputes", { status: "open", limit: 30 });
        const disputes = data.disputes || [];
        body.innerHTML = disputes.length ? `<table class="aos-table"><thead><tr>
            <th>ID</th><th>Buyer</th><th>Seller</th><th>Amount</th><th>Reason</th><th>Date</th><th>Actions</th>
          </tr></thead><tbody>${disputes.map(d => `<tr>
            <td class="aos-mono">${d.id?.slice(0,8)||"—"}</td>
            <td>${_esc(d.buyerName||"—")}</td>
            <td>${_esc(d.sellerName||"—")}</td>
            <td>KES ${_fmt(d.amount||0)}</td>
            <td class="aos-muted">${_esc(d.reason||"—")}</td>
            <td class="aos-muted">${_date(d.createdAt)}</td>
            <td>
              <button class="aos-btn-sm success" onclick="SokoniAOS.resolveDispute('${d.id}','buyer')">Buyer Wins</button>
              <button class="aos-btn-sm warning" onclick="SokoniAOS.resolveDispute('${d.id}','seller')">Seller Wins</button>
            </td>
          </tr>`).join("")}</tbody></table>` : _emptyMsg("No open disputes");
      } else if (tab === "refunds") {
        const snap = await _db.collection("refundRequests").where("status","==","pending")
          .orderBy("createdAt","desc").limit(30).get().catch(() => null);
        const refunds = snap ? snap.docs.map(d => ({id: d.id, ...d.data()})) : [];
        body.innerHTML = refunds.length ? `<table class="aos-table"><thead><tr>
            <th>Order</th><th>Buyer</th><th>Amount</th><th>Reason</th><th>Date</th><th>Actions</th>
          </tr></thead><tbody>${refunds.map(r => `<tr>
            <td class="aos-mono">${(r.orderId||"—").slice(0,8)}</td>
            <td>${_esc(r.buyerName||r.buyerUid||"—")}</td>
            <td>KES ${_fmt(r.amount||0)}</td>
            <td class="aos-muted">${_esc(r.reason||"—")}</td>
            <td class="aos-muted">${_date(r.createdAt)}</td>
            <td>
              <button class="aos-btn-sm success" onclick="SokoniAOS.processRefund('${r.id}','approved')">Approve</button>
              <button class="aos-btn-sm danger" onclick="SokoniAOS.processRefund('${r.id}','rejected')">Reject</button>
            </td>
          </tr>`).join("")}</tbody></table>` : _emptyMsg("No pending refund requests");
      } else if (tab === "wallet") {
        const data = await _call("adminGetWalletOperations", { limit: 30 }).catch(() => ({ operations: [] }));
        const ops = data.operations || data.transactions || [];
        body.innerHTML = ops.length ? `<table class="aos-table"><thead><tr>
            <th>User</th><th>Type</th><th>Amount</th><th>Balance After</th><th>Date</th>
          </tr></thead><tbody>${ops.map(o => `<tr>
            <td>${_esc(o.userName||o.uid||"—")}</td>
            <td><span class="audit-action">${_esc(o.type||"—")}</span></td>
            <td style="color:${(o.amount||0)>0?"var(--aos-success)":"var(--aos-danger)"}">KES ${_fmt(Math.abs(o.amount||0))}</td>
            <td>KES ${_fmt(o.balanceAfter||0)}</td>
            <td class="aos-muted">${_date(o.createdAt)}</td>
          </tr>`).join("")}</tbody></table>` : _emptyMsg("No wallet operations found");
      } else if (tab === "escrow") {
        const data = await _call("finosGetEscrowAccounts", { status: "held", limit: 30 }).catch(() => ({ accounts: [] }));
        const accounts = data.accounts || data.escrows || [];
        body.innerHTML = accounts.length ? `<table class="aos-table"><thead><tr>
            <th>Order</th><th>Buyer</th><th>Seller</th><th>Amount</th><th>Status</th><th>Held Since</th><th>Actions</th>
          </tr></thead><tbody>${accounts.map(a => `<tr>
            <td class="aos-mono">${(a.orderId||"—").slice(0,8)}</td>
            <td>${_esc(a.buyerName||"—")}</td>
            <td>${_esc(a.sellerName||"—")}</td>
            <td>KES ${_fmt(a.amount||0)}</td>
            <td><span class="status-badge st-${a.status||"held"}">${a.status||"held"}</span></td>
            <td class="aos-muted">${_date(a.createdAt)}</td>
            <td><button class="aos-btn-sm success" onclick="SokoniAOS.releaseEscrow('${a.id}')">Release</button></td>
          </tr>`).join("")}</tbody></table>` : _emptyMsg("No held escrow funds");
      } else if (tab === "report") {
        /* Executive report — reconciled from adminGetFinance (canonical 30-day) +
           adminGetExecutiveDashboard (booking stats). No recomputation, no raw JSON. */
        const [finR, execR] = await Promise.all([
          _call("adminGetFinance").catch(() => ({})),
          _call("adminGetExecutiveDashboard").catch(() => ({})),
        ]);
        const rec = (finR && finR.reconciliation) || {};
        const x = execR || {};
        const row = (l, v) => `<div class="rep-row"><span>${l}</span><strong>${v}</strong></div>`;
        body.innerHTML = `
          <div style="display:flex;gap:8px;margin-bottom:16px">
            <button class="aos-btn" onclick="SokoniAOS.financialTab('report')">&#x1F504; Refresh</button>
            <button class="aos-btn" onclick="SokoniAOS.exportFinancialReport()">&#x1F4E5; Export CSV</button>
          </div>
          <div class="rep-card"><div class="rep-h">Executive Summary &middot; 30-day</div>
            ${row("GMV (gross revenue)", _kes(rec.grossRevenue))}
            ${row("Net Platform Revenue", _kes(rec.netPlatformRevenue))}
            ${row("Wallet Float (liability)", _kes(rec.walletFloat))}
            ${row("Pending Withdrawals", _kes(rec.pendingWithdrawals))}
          </div>
          <div class="rep-card"><div class="rep-h">Revenue Breakdown</div>
            ${row("Product / Merchant Revenue", _kes(rec.productRevenue))}
            ${row("Service / Provider Revenue", _kes(rec.serviceRevenue))}
            ${row("Total Commission", _kes(rec.commission))}
            ${row("&mdash; Product Commission", _kes(rec.productCommission))}
            ${row("&mdash; Service Commission", _kes(rec.serviceCommission))}
            ${row("Gateway Fees (absorbed)", _kes(rec.gatewayFees))}
            ${row("Refunds", _kes(rec.refunds))}
          </div>
          <div class="rep-card"><div class="rep-h">Withdrawals &amp; Settlement</div>
            ${row("Pending Withdrawals", _kes(rec.pendingWithdrawals))}
            ${row("Completed Withdrawals", _kes(rec.completedWithdrawals))}
          </div>
          <div class="rep-card"><div class="rep-h">Booking Statistics</div>
            ${row("Total Service Bookings", _fmt(x.totalServiceBookings || 0))}
            ${row("Active Bookings", _fmt(x.activeServiceBookings || 0))}
            ${row("Bookings Today", _fmt(x.serviceBookingsToday || 0))}
            ${row("Total Product Orders", _fmt(x.totalOrders || 0))}
          </div>
          <div style="font-size:.72rem;color:var(--aos-sub);margin-top:8px">Reconciled from adminGetFinance (canonical 30-day window) &mdash; no recomputation.</div>`;
      }
    } catch (e) { body.innerHTML = _emptyMsg("Error: " + e.message); }
  }

  async function releaseEscrow(id) {
    if (!(await SK.dialog.confirm("Funds will be transferred to the seller immediately. This is irreversible.", null, null, { title: "Release escrow?", variant: "danger", confirmLabel: "Release Funds" }))) return;
    try {
      await _call("finosReleaseEscrow", { escrowId: id });
    } catch (e) {
      _toast(e.message, "error");
      return;
    }
    _toast("Escrow released to seller", "success");
    _financialTab("escrow");
  }

  async function exportFinancialReport() {
    _toast("Preparing financial export…", "info");
    const data = await _call("getFinancialReport", { period: "monthly" }).catch(e => { _toast(e.message, "error"); return null; });
    if (!data) return;
    const json = JSON.stringify(data, null, 2);
    const a = document.createElement("a");
    a.href = "data:application/json;charset=utf-8," + encodeURIComponent(json);
    a.download = "sokoni-financial-report-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
  }

  async function markCommPaid(id) {
    try {
      await _call("markCommissionPaid", { entryId: id });
    } catch (e) {
      _toast(e.message, "error");
      return;
    }
    _toast("Marked as paid","success"); _financialTab("commissions");
  }
  /* Bulk approval ORCHESTRATES the canonical single-payout engine — one
     adminProcessPayout call per request, identical to a single approval. There is NO
     second payout path: the frozen wallet engine (wallet.js adminProcessPayout) owns
     all validation, the atomic approving-gate, idempotency, reconciliation, audit,
     notifications and the IntaSend B2C flow. Admin OS only iterates. callFn is injected
     so this is unit-testable (scripts/test-admin-bulk-payout.js). */
  async function _bulkApprovePayouts(ids, callFn) {
    var ok = 0, failed = [];
    for (var i = 0; i < ids.length; i++) {
      try { await callFn("adminProcessPayout", { requestId: ids[i], status: "approved" }); ok++; }
      catch (e) { failed.push({ id: ids[i], error: (e && e.message) || String(e) }); }
    }
    return { ok: ok, failed: failed, total: ids.length };
  }
  async function approveAllPayouts() {
    var data = await _call("aosGetPendingPayouts").catch(function () { return { payouts: [] }; });
    var ids = (data.payouts || []).map(function (p) { return p.id; }).filter(Boolean);
    if (!ids.length) { _toast("No pending payouts", "info"); return; }
    if (!(await SK.dialog.confirm("Each of the " + ids.length + " payouts is processed individually by the wallet engine.", null, null, { title: "Approve all " + ids.length + " payouts?", variant: "danger", confirmLabel: "Approve All" }))) return;
    var res = await _bulkApprovePayouts(ids, _call);
    if (res.failed.length) { console.warn("[payouts] bulk failures", res.failed); _toast(res.ok + " approved · " + res.failed.length + " failed (see console)", "error"); }
    else _toast("All " + res.ok + " payouts approved", "success");
    _financialTab("payouts");
  }
  async function approvePayout(id) {
    try {
      await _call("adminProcessPayout", { requestId: id, status: "approved" });
    } catch (e) {
      _toast(e.message, "error");
      return;
    }
    _toast("Payout approved", "success"); _financialTab("payouts");
  }
  async function rejectPayout(id) {
    const note = prompt("Rejection reason:");
    try {
      await _call("finosRequestBankPayout", { payoutId: id, action:"reject", note });
    } catch (e) {
      _toast(e.message, "error");
      return;
    }
    _toast("Payout rejected","success"); _financialTab("payouts");
  }
  async function resolveDispute(id, winnerSide) {
    const note = prompt("Resolution note:");
    try {
      await _call("aosResolveDispute", { disputeId: id, resolution: winnerSide, note });
    } catch (e) {
      _toast(e.message, "error");
      return;
    }
    _toast("Dispute resolved","success"); _financialTab("disputes");
  }
  async function processRefund(id, action) {
    const note = action === "rejected" ? prompt("Rejection reason:") : "";
    try {
      await _call("processRefund", { refundId: id, action, note });
    } catch (e) {
      _toast(e.message, "error");
      return;
    }
    _toast("Refund " + action,"success"); _financialTab("refunds");
  }

  // ── Support ───────────────────────────────────────────────────────────────────
  async function _loadSupport(status = "open", priority = "") {
    const body = document.getElementById("supportBody");
    if (!body) return;
    body.innerHTML = _spinner();
    try {
      const data = await _call("adminGetSupportTickets", { status, priority, limit: 30 });
      const tickets = data.tickets || [];
      body.innerHTML = tickets.length ? `<table class="aos-table"><thead><tr>
          <th>ID</th><th>Subject</th><th>From</th><th>Priority</th><th>Status</th><th>Date</th><th>Actions</th>
        </tr></thead><tbody>${tickets.map(t => `<tr>
          <td class="aos-mono">${(t.id||"—").slice(0,8)}</td>
          <td>${_esc(t.subject||t.title||"—")}</td>
          <td class="aos-muted">${_esc(t.userName||t.email||"—")}</td>
          <td><span class="prio-badge prio-${t.priority||"normal"}">${t.priority||"normal"}</span></td>
          <td><span class="status-badge st-${t.status||"open"}">${t.status||"open"}</span></td>
          <td class="aos-muted">${_date(t.createdAt)}</td>
          <td>
            <button class="aos-btn-sm" onclick="SokoniAOS.viewTicket('${t.id}')">View</button>
            <button class="aos-btn-sm success" onclick="SokoniAOS.resolveTicket('${t.id}')">Resolve</button>
          </td>
        </tr>`).join("")}</tbody></table>` : _emptyMsg("No tickets found");
    } catch (e) { body.innerHTML = _emptyMsg("Error: " + e.message); }
  }

  async function resolveTicket(id) {
    const note = prompt("Resolution note:");
    if (!note) return;
    try {
      await _call("adminResolveSupportTicket", { ticketId: id, resolution: note });
    } catch (e) {
      _toast(e.message, "error");
      return;
    }
    _toast("Ticket resolved","success"); _panelCache.support = false; _loadSupport();
  }

  async function viewTicket(id) {
    const snap = await _db.collection("supportTickets").doc(id).get().catch(() => null);
    if (!snap?.exists) { _toast("Ticket not found","error"); return; }
    const t = snap.data();
    _modal("Ticket: " + (t.subject || id), `
      <div class="ticket-detail">
        <p><strong>From:</strong> ${_esc(t.userName||t.email||"—")}</p>
        <p><strong>Priority:</strong> <span class="prio-badge prio-${t.priority||"normal"}">${t.priority||"normal"}</span></p>
        <p><strong>Status:</strong> <span class="status-badge st-${t.status||"open"}">${t.status||"open"}</span></p>
        <hr>
        <p>${_esc(t.message||t.body||"No message")}</p>
        <hr>
        <textarea id="ticketReply" placeholder="Reply..." rows="4" style="width:100%"></textarea>
        <button class="aos-btn success" style="margin-top:8px" onclick="SokoniAOS.replyTicket('${id}')">Send Reply</button>
      </div>
    `);
  }

  async function replyTicket(id) {
    const msg = document.getElementById("ticketReply")?.value;
    if (!msg) return;
    try {
      await _call("adminResolveSupportTicket", { ticketId: id, resolution: msg, keepOpen: true });
    } catch (e) {
      _toast(e.message, "error");
      return;
    }
    _toast("Reply sent","success"); _closeModal();
  }

  // ── Communications ────────────────────────────────────────────────────────────
  async function _loadComms() { _commsTab("push"); }

  async function _commsTab(tab) {
    document.querySelectorAll("#panel-comms .tab-btn").forEach(b =>
      b.classList.toggle("active", b.dataset.tab === tab));
    const body = document.getElementById("commsBody");
    if (!body) return;
    body.innerHTML = _spinner();

    if (tab === "push") {
      const recent = await _call("adminGetRecentNotifications", { limit: 10 }).catch(() => ({ notifications: [] }));
      const notifs = recent.notifications || [];
      body.innerHTML = `
        <div class="compose-form">
          <h3>&#x1F4E2; Send Push Notification</h3>
          <input type="text" id="notifTitle" placeholder="Title">
          <textarea id="notifBody" placeholder="Message body&#x2026;" rows="3"></textarea>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <select id="notifTarget"><option value="all">All Users</option><option value="role">By Role</option><option value="active">Active (7d)</option><option value="sellers">Sellers</option><option value="buyers">Buyers</option><option value="drivers">Drivers</option></select>
            <select id="notifRole"><option value="">Role (if By Role)</option><option>buyer</option><option>seller</option><option>driver</option><option>provider</option><option>moderator</option><option>admin</option></select>
          </div>
          <button class="aos-btn success" style="margin-top:10px" onclick="SokoniAOS.sendPushNotification()">&#x1F680; Send Push</button>
        </div>
        <div class="dash-section"><h3>Recent Notifications</h3>
          ${notifs.map(n => `<div class="notif-row">
            <span class="notif-type">${_esc(n.type||"info")}</span>
            <span>${_esc(n.title||"—")}</span>
            <span class="aos-muted">${_fmt(n.sentCount||0)} sent</span>
            <time class="aos-muted">${_date(n.sentAt||n.createdAt)}</time>
          </div>`).join("") || "<p class='aos-muted'>No recent push notifications.</p>"}
        </div>`;
    } else if (tab === "email") {
      body.innerHTML = `
        <div class="compose-form">
          <h3>&#x2709;&#xFE0F; Send Test Email</h3>
          <p style="color:var(--aos-muted);font-size:12px;margin:0 0 10px">
            Sends a real email rendered with the <strong>production template</strong> &mdash; same header, logo
            and dark-mode CSS as every live SOKONI email. Use it to verify delivery <em>and</em> branding.
          </p>
          <div style="display:grid;grid-template-columns:2fr 1fr;gap:10px">
            <input type="email" id="testEmailTo" placeholder="Recipient email" autocomplete="email">
            <select id="testEmailTemplate">
              <option value="">Delivery + branding test</option>
              <option value="welcome">welcome</option>
              <option value="email-verify">email-verify</option>
              <option value="password-reset">password-reset</option>
              <option value="order-confirmation">order-confirmation</option>
              <option value="order-shipped">order-shipped</option>
            </select>
          </div>
          <button class="aos-btn success" style="margin-top:10px" onclick="SokoniAOS.sendTestEmail()">&#x1F9EA; Send Test Email</button>
          <div id="testEmailResult" style="margin-top:10px"></div>
        </div>
        <div class="compose-form">
          <h3>&#x1F4E7; Email Blast</h3>
          <input type="text" id="emailSubject" placeholder="Subject line">
          <textarea id="emailHtml" placeholder="Email body (plain text or HTML)&#x2026;" rows="6"></textarea>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <select id="emailTarget"><option value="all">All Users</option><option value="sellers">Sellers</option><option value="buyers">Buyers</option><option value="drivers">Drivers</option><option value="providers">Providers</option></select>
            <input type="text" id="emailTag" placeholder="Template tag (optional)">
          </div>
          <p style="color:var(--aos-muted);font-size:11px;margin:8px 0">Requires SENDGRID_API_KEY configured in Secret Manager.</p>
          <button class="aos-btn success" style="margin-top:6px" onclick="SokoniAOS.sendEmailBlast()">&#x1F4E8; Send Email Blast</button>
        </div>`;
    } else if (tab === "sms") {
      body.innerHTML = `
        <div class="compose-form">
          <h3>&#x1F4F1; SMS Broadcast</h3>
          <textarea id="smsBody" placeholder="SMS message (160 chars max)&#x2026;" rows="3" maxlength="160" oninput="document.getElementById('smsCount').textContent=this.value.length+'/160'"></textarea>
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px">
            <select id="smsTarget"><option value="all">All Users</option><option value="sellers">Sellers</option><option value="buyers">Buyers</option><option value="drivers">Drivers</option></select>
            <span id="smsCount" style="color:var(--aos-muted);font-size:12px;white-space:nowrap">0/160</span>
          </div>
          <p style="color:var(--aos-muted);font-size:11px;margin:8px 0">SMS charges apply. Confirm before sending.</p>
          <button class="aos-btn success" onclick="SokoniAOS.sendSMSBlast()">&#x1F4AC; Send SMS Broadcast</button>
        </div>`;
    } else if (tab === "inbox") {
      /* Communication Engine console. Self-contained like the integrations module: it reads
         its own canonical collections and one read-only callable, so it needs no dispatch op.
         A missing module is reported as a missing module — an empty inbox and an absent
         script must never look the same. */
      if (!window.SokoniCommsConsole) {
        body.innerHTML = _emptyMsg("The communications console did not load. Check that " +
          "sokoni-comms-console.js is served on this page.");
        return;
      }
      window.SokoniCommsConsole.mount(body);
    } else if (tab === "connect") {
      /* SOKONI Connect. Self-contained like the integrations console: it reads its own
         canonical collection (connectSessions) and routes through no dispatch op, so it
         needs no Cloud Function deploy. If the script did not load the tab SAYS SO rather
         than rendering an empty console — an empty table and a missing module must never
         look the same. */
      if (!window.SokoniConnectConsole) {
        body.innerHTML = _emptyMsg("The Connect console did not load. Check that " +
          "sokoni-connect-console.js is served on this page.");
        return;
      }
      window.SokoniConnectConsole.mount(body);
    }
  }

  async function sendTestEmail() {
    const to   = document.getElementById("testEmailTo")?.value?.trim();
    const tmpl = document.getElementById("testEmailTemplate")?.value || "";
    const out  = document.getElementById("testEmailResult");
    const btn  = document.querySelector('[onclick="SokoniAOS.sendTestEmail()"]');

    if (!to || !to.includes("@")) { _toast("A valid recipient email is required", "error"); return; }

    /* Disable while in flight — a double-click must not send two emails. */
    if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }
    if (out) out.innerHTML = "";

    try {
      const r = await _call("testEmailDelivery", tmpl ? { to, template: tmpl } : { to });
      if (out) out.innerHTML =
        `<div class="notif-row" style="border-left:3px solid var(--aos-ok,#71ff00)">
           <span>&#x2705; Sent to <strong>${_esc(to)}</strong></span>
           <span class="aos-muted">template: ${_esc(r.template || "base")}</span>
           <span class="aos-muted">via ${_esc(r.provider || "?")}</span>
         </div>
         <p class="aos-muted" style="font-size:12px;margin:8px 0 0">
           Open it and confirm the logo is crisp, fully opaque and complete &mdash; in light <em>and</em> dark mode.
         </p>`;
      _toast("Test email sent to " + to, "success");
    } catch (e) {
      if (out) out.innerHTML =
        `<div class="notif-row" style="border-left:3px solid #ff4d4d"><span>&#x274C; ${_esc(e.message || "Send failed")}</span></div>`;
      _toast(e.message || "Send failed", "error");
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = "&#x1F9EA; Send Test Email"; }
    }
  }

  async function sendPushNotification() {
    const title   = document.getElementById("notifTitle")?.value;
    const body    = document.getElementById("notifBody")?.value;
    const target  = document.getElementById("notifTarget")?.value || "all";
    const role    = document.getElementById("notifRole")?.value;
    if (!title || !body) { _toast("Title and body are required","error"); return; }
    try {
      await _call("adminSendPushNotification", { title, body, target, role });
    } catch (e) {
      _toast(e.message, "error");
      return;
    }
    _toast("Notification sent to " + target,"success");
    document.getElementById("notifTitle").value = "";
    document.getElementById("notifBody").value  = "";
    _panelCache.comms = false; _commsTab("push");
  }

  async function sendEmailBlast() {
    const subject = document.getElementById("emailSubject")?.value;
    const html    = document.getElementById("emailHtml")?.value;
    const target  = document.getElementById("emailTarget")?.value || "all";
    if (!subject || !html) { _toast("Subject and body are required", "error"); return; }
    if (!(await SK.dialog.confirm(`This will queue emails to all ${target} immediately.`, null, null, { title: `Send email blast to all ${target}?`, variant: "danger", confirmLabel: "Send blast" }))) return;
    try {
      await _call("adminSendEmailBlast", { subject, html, target });
    } catch (e) {
      _toast(e.message, "error");
      return;
    }
    _toast("Email blast queued for " + target, "success");
  }

  async function sendSMSBlast() {
    const message = document.getElementById("smsBody")?.value;
    const target  = document.getElementById("smsTarget")?.value || "all";
    if (!message) { _toast("Message body is required", "error"); return; }
    if (!(await SK.dialog.confirm(`Carrier charges apply for every recipient.`, null, null, { title: `Send SMS to all ${target}?`, variant: "danger", confirmLabel: "Send SMS" }))) return;
    try {
      await _call("adminSendSMSBlast", { message, target });
    } catch (e) {
      _toast(e.message, "error");
      return;
    }
    _toast("SMS queued for " + target, "success");
  }

  // ── Content ───────────────────────────────────────────────────────────────────
  async function _loadContent() { _contentTab("banners"); }

  async function _contentTab(tab) {
    document.querySelectorAll("#panel-content .tab-btn").forEach(b =>
      b.classList.toggle("active", b.dataset.tab === tab));
    const body = document.getElementById("contentBody");
    if (!body) return;
    body.innerHTML = _spinner();
    try {
      if (tab === "banners") {
        const data = await _call("adminGetBanners");
        const banners = data.banners || [];
        body.innerHTML = `<button class="aos-btn" onclick="SokoniAOS.addBanner()" style="margin-bottom:12px">+ Add Banner</button>
          <div class="banner-grid">${banners.map(b => `
            <div class="banner-card">
              <img src="${_esc(b.imageUrl||"")}" alt="${_esc(b.title||"")}">
              <div class="banner-info">
                <strong>${_esc(b.title||"—")}</strong>
                <small>${_esc(b.position||"—")}</small>
                <div class="banner-actions">
                  <button class="aos-btn-sm" onclick="SokoniAOS.editBanner('${b.id}')">Edit</button>
                  <button class="aos-btn-sm danger" onclick="SokoniAOS.deleteBanner('${b.id}')">Delete</button>
                </div>
              </div>
            </div>`).join("") || "<p class='aos-muted'>No banners.</p>"}</div>`;
      } else if (tab === "faqs") {
        const data = await _call("adminGetFaqs");
        const faqs = data.faqs || [];
        body.innerHTML = `<button class="aos-btn" onclick="SokoniAOS.addFaq()" style="margin-bottom:12px">+ Add FAQ</button>
          <div class="faq-list">${faqs.map(f => `
            <details class="faq-item">
              <summary>${_esc(f.question||"—")}<div>
                <button class="aos-btn-sm" onclick="event.stopPropagation();SokoniAOS.editFaq('${f.id}')">Edit</button>
                <button class="aos-btn-sm danger" onclick="event.stopPropagation();SokoniAOS.deleteFaq('${f.id}')">Delete</button>
              </div></summary>
              <p>${_esc(f.answer||"—")}</p>
            </details>`).join("") || "<p class='aos-muted'>No FAQs.</p>"}</div>`;
      } else if (tab === "announcements") {
        const data = await _call("adminGetAnnouncements");
        const anns = data.announcements || [];
        body.innerHTML = `<button class="aos-btn" onclick="SokoniAOS.addAnnouncement()" style="margin-bottom:12px">+ New Announcement</button>
          <div class="ann-list">${anns.map(a => `
            <div class="ann-item ann-${a.type||'info'}">
              <strong>${_esc(a.title||"—")}</strong>
              <p>${_esc(a.body||"—")}</p>
              <div class="ann-meta">
                <span class="aos-muted">${_date(a.createdAt)}</span>
                <button class="aos-btn-sm danger" onclick="SokoniAOS.deleteAnnouncement('${a.id}')">Remove</button>
              </div>
            </div>`).join("") || "<p class='aos-muted'>No announcements.</p>"}</div>`;
      } else if (tab === "campaigns") {
        const data = await _call("adminGetCampaigns", { limit: 20 }).catch(() => ({ campaigns: [] }));
        const campaigns = data.campaigns || [];
        body.innerHTML = `<button class="aos-btn" onclick="SokoniAOS.createCampaign()" style="margin-bottom:12px">+ New Campaign</button>
          ${campaigns.length ? `<table class="aos-table"><thead><tr>
            <th>Name</th><th>Type</th><th>Target</th><th>Status</th><th>Start</th><th>End</th><th>Actions</th>
          </tr></thead><tbody>${campaigns.map(c => `<tr>
            <td>${_esc(c.name||"—")}</td>
            <td><span class="audit-action">${_esc(c.type||"—")}</span></td>
            <td class="aos-muted">${_esc(c.target||"all")}</td>
            <td><span class="status-badge st-${c.status||"draft"}">${c.status||"draft"}</span></td>
            <td class="aos-muted">${_date(c.startDate)}</td>
            <td class="aos-muted">${_date(c.endDate)}</td>
            <td style="display:flex;gap:4px">
              ${c.status==="draft"?`<button class="aos-btn-sm success" onclick="SokoniAOS.activateCampaign('${c.id}')">Activate</button>`:""}
              <button class="aos-btn-sm danger" onclick="SokoniAOS.deleteCampaign('${c.id}')">Delete</button>
            </td>
          </tr>`).join("")}</tbody></table>` : _emptyMsg("No campaigns yet — create the first one")}`;
      }
    } catch (e) { body.innerHTML = _emptyMsg("Error: " + e.message); }
  }

  async function createCampaign() {
    const name   = prompt("Campaign name:");
    const type   = prompt("Type (discount/flash-sale/referral/loyalty):", "discount");
    const target = prompt("Target audience (all/sellers/buyers):", "all");
    const start  = prompt("Start date (YYYY-MM-DD):");
    const end    = prompt("End date (YYYY-MM-DD):");
    if (!name || !type || !start || !end) return;
    try {
      await _call("adminCreateCampaign", { name, type, target, startDate: start, endDate: end });
    } catch (e) {
      _toast(e.message, "error");
      return;
    }
    _toast("Campaign created", "success");
    _panelCache.content = false;
    _contentTab("campaigns");
  }

  async function activateCampaign(id) {
    try {
      await _call("adminUpdateCampaignStatus", { campaignId: id, status: "active" });
    } catch (e) {
      _toast(e.message, "error");
      return;
    }
    _toast("Campaign activated", "success");
    _contentTab("campaigns");
  }

  async function deleteCampaign(id) {
    if (!(await SK.dialog.confirm("Permanently delete this campaign?", null, null, { title: "Delete campaign", variant: "danger", confirmLabel: "Delete" }))) return;
    try {
      await _call("adminDeleteCampaign", { campaignId: id });
    } catch (e) {
      _toast(e.message, "error");
      return;
    }
    _toast("Campaign deleted", "success");
    _panelCache.content = false;
    _contentTab("campaigns");
  }

  async function addBanner() {
    const title   = prompt("Banner title:");
    const url     = prompt("Image URL:");
    const position = prompt("Position (hero/sidebar/footer):", "hero");
    if (!title || !url) return;
    try {
      await _call("adminSaveBanner", { title, imageUrl: url, position });
    } catch (e) {
      _toast(e.message, "error");
      return;
    }
    _toast("Banner added","success"); _panelCache.content = false; _contentTab("banners");
  }
  async function editBanner(id) {
    const title    = prompt("New banner title (blank = keep current):");
    const url      = prompt("New image URL (blank = keep current):");
    const position = prompt("Position (hero/sidebar/footer, blank = keep):");
    if (!title && !url && !position) return;
    const patch = { id: id };
    if (title) patch.title = title;
    if (url) patch.imageUrl = url;
    if (position) patch.position = position;
    try {
      await _call("adminSaveBanner", patch);
    } catch (e) {
      _toast(e.message, "error");
      return;
    }
    _toast("Banner updated", "success"); _panelCache.content = false; _contentTab("banners");
  }
  async function deleteBanner(id) {
    if (!(await SK.dialog.confirm("Delete this banner?", null, null, { title: "Delete banner", variant: "danger", confirmLabel: "Delete" }))) return;
    try {
      await _call("adminDeleteBanner", { bannerId: id });
    } catch (e) {
      _toast(e.message, "error");
      return;
    }
    _toast("Banner deleted","success"); _panelCache.content = false; _contentTab("banners");
  }
  async function addFaq() {
    const q = prompt("Question:"); const a = prompt("Answer:");
    if (!q || !a) return;
    try {
      await _call("adminUpsertFaq", { question: q, answer: a });
    } catch (e) {
      _toast(e.message, "error");
      return;
    }
    _toast("FAQ added","success"); _panelCache.content = false; _contentTab("faqs");
  }
  async function deleteFaq(id) {
    if (!(await SK.dialog.confirm("Delete this FAQ?", null, null, { title: "Delete FAQ", variant: "danger", confirmLabel: "Delete" }))) return;
    try {
      await _call("adminDeleteFaq", { faqId: id });
    } catch (e) {
      _toast(e.message, "error");
      return;
    }
    _toast("FAQ deleted","success"); _panelCache.content = false; _contentTab("faqs");
  }
  async function addAnnouncement() {
    const title = prompt("Announcement title:");
    const body  = prompt("Message:");
    const type  = prompt("Type (info/warning/success):", "info");
    if (!title || !body) return;
    try {
      await _call("adminSaveAnnouncement", { title, body, type });
    } catch (e) {
      _toast(e.message, "error");
      return;
    }
    _toast("Announcement posted","success"); _panelCache.content = false; _contentTab("announcements");
  }
  async function deleteAnnouncement(id) {
    if (!(await SK.dialog.confirm("Remove this announcement?", null, null, { title: "Remove announcement", variant: "danger", confirmLabel: "Remove" }))) return;
    try {
      await _call("adminSaveAnnouncement", { id, deleted: true });
    } catch (e) {
      _toast(e.message, "error");
      return;
    }
    _toast("Removed","success"); _panelCache.content = false; _contentTab("announcements");
  }

  // ── AI ────────────────────────────────────────────────────────────────────────
  async function _loadAI() {
    const body = document.getElementById("aiBody");
    if (!body) return;
    body.innerHTML = _spinner();
    try {
      const [aiStats, aiSubs, flagsRes] = await Promise.all([
        _call("adminGetAiStats").catch(() => ({})),
        _call("getAISubscriptionStats").catch(() => ({})),
        _call("adminGetFeatureFlags").catch(() => ({})),
      ]);
      const s = aiStats.stats || aiStats;
      const sub = aiSubs.stats || aiSubs;
      /* Hydrate module toggles from REAL feature-flag state (was hard-coded checked). */
      const _rawFlags = flagsRes.flags || flagsRes.items || [];
      const _flagMap = {};
      (Array.isArray(_rawFlags) ? _rawFlags : Object.keys(_rawFlags).map(k => ({ key: k, enabled: _rawFlags[k] && _rawFlags[k].enabled !== false })))
        .forEach(fl => { _flagMap[fl.key] = fl.enabled !== false; });
      const _aiOn = m => { const k = "ai_" + m.toLowerCase().replace(/\s/g, "_"); return _flagMap[k] === undefined ? true : _flagMap[k]; };
      body.innerHTML = `
        <div class="ai-stats-grid">
          <div class="stat-card"><span>Total AI Requests</span><strong>${_fmt(s.totalRequests||0)}</strong></div>
          <div class="stat-card"><span>KASS Chats Today</span><strong>${_fmt(s.kassChatsToday||0)}</strong></div>
          <div class="stat-card"><span>Avg Response Time</span><strong>${(s.avgResponseMs||0)}ms</strong></div>
          <div class="stat-card"><span>AI Moderation Actions</span><strong>${_fmt(s.moderationActions||0)}</strong></div>
          <div class="stat-card"><span>AI Subscriptions Active</span><strong>${_fmt(sub.active||sub.totalActive||0)}</strong></div>
          <div class="stat-card"><span>AI Revenue (Month)</span><strong>KES ${_fmt(sub.monthlyRevenue||0)}</strong></div>
        </div>
        <div class="ai-module-toggles">
          <h3>Module Controls</h3>
          ${["KASS Chat","AI Recommendations","AI Moderation","AI Search","Price Prediction"].map(m => `
            <div class="toggle-row">
              <span>${m}</span>
              <label class="toggle-sw"><input type="checkbox" ${_aiOn(m)?"checked":""} onchange="SokoniAOS.toggleAIModule('${m}',this.checked)"><span></span></label>
            </div>`).join("")}
        </div>`;
    } catch (e) { body.innerHTML = _emptyMsg("Error: " + e.message); }
  }

  async function toggleAIModule(name, enabled) {
    try {
      await _call("adminUpdateFeatureFlag", { key: "ai_" + name.toLowerCase().replace(/\s/g,"_"), enabled });
    } catch (e) {
      _toast(e.message, "error");
      return;
    }
    _toast((enabled?"Enabled":"Disabled") + " " + name, "success");
  }

  // ── Search ────────────────────────────────────────────────────────────────────
  async function _loadSearch() {
    const body = document.getElementById("searchBody");
    if (!body) return;
    body.innerHTML = _spinner();
    try {
      const [searchStats, health] = await Promise.all([
        _call("searchGetStats").catch(() => ({})),
        _call("searchSystemHealth").catch(() => ({})),
      ]);
      const h = health.health || health;
      const s = searchStats.stats || searchStats;
      body.innerHTML = `
        <div class="search-health">
          <div class="health-chip" data-score="${h.algoliaScore||0}">
            <span>Algolia</span><strong>${h.algoliaStatus||"Unknown"}</strong>
          </div>
          <div class="health-chip" data-score="${h.typesenseScore||0}">
            <span>Typesense</span><strong>${h.typesenseStatus||"Unknown"}</strong>
          </div>
          <div class="health-chip">
            <span>Queue Lag</span><strong>${s.queueLag||0}s</strong>
          </div>
          <div class="health-chip">
            <span>Index Coverage</span><strong>${s.coverage||0}%</strong>
          </div>
        </div>
        <div class="search-tools" style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="aos-btn" onclick="SokoniAOS.reindex()">🔄 Full Reindex</button>
          <button class="aos-btn" onclick="SokoniAOS.repairSearch()">🔧 Repair</button>
          <button class="aos-btn" onclick="SokoniAOS.searchReport()">📊 Report</button>
        </div>
        <div style="margin-top:20px">
          <h3>Trending Searches</h3>
          <div id="trendingSearches">${_spinner()}</div>
        </div>`;
      _loadTrendingSearches();
    } catch (e) { body.innerHTML = _emptyMsg("Error: " + e.message); }
  }

  async function _loadTrendingSearches() {
    const snap = await _db.collection("searchInsights").orderBy("count","desc").limit(20).get().catch(() => null);
    const el = document.getElementById("trendingSearches");
    if (!el || !snap) return;
    el.innerHTML = snap.empty ? "<p class='aos-muted'>No data yet.</p>"
      : `<div class="trending-chips">${snap.docs.map(d => `
          <span class="trending-chip">${_esc(d.id)} <small>${d.data().count||0}</small></span>`).join("")}</div>`;
  }

  async function reindex() {
    if (!(await SK.dialog.confirm("This will reindex all data. It may take a while.", null, null, { title: "Reindex all data?", confirmLabel: "Reindex" }))) return;
    try {
      await _call("searchFullReindex");
    } catch (e) {
      _toast(e.message, "error");
      return;
    }
    _toast("Reindex started","success");
  }
  async function repairSearch() {
    try {
      await _call("searchRepairAll");
    } catch (e) {
      _toast(e.message, "error");
      return;
    }
    _toast("Search repair started","success");
  }
  async function searchReport() {
    const data = await _call("searchSystemReport").catch(e => { _toast(e.message,"error"); return null; });
    if (data) _modal("Search Report", _kvHtml(data.report || data));
  }

  // ── SmartPOS ──────────────────────────────────────────────────────────────────
  async function _loadSmartPOS() { _posTab("devices"); }

  async function _posTab(tab) {
    document.querySelectorAll("#panel-smartpos .tab-btn").forEach(b =>
      b.classList.toggle("active", b.dataset.tab === tab));
    const body = document.getElementById("posBody");
    if (!body) return;
    body.innerHTML = _spinner();
    try {
      if (tab === "devices") {
        const data = await _call("adminGetPosDevices").catch(() => ({ devices: [] }));
        const devices = data.devices || [];
        const online  = devices.filter(d => d.status === "online").length;
        body.innerHTML = `
          <div class="pos-stats">
            <div class="stat-card success"><span>Online Now</span><strong>${online}</strong></div>
            <div class="stat-card"><span>Total Registered</span><strong>${devices.length}</strong></div>
            <div class="stat-card warn"><span>Offline</span><strong>${devices.length - online}</strong></div>
          </div>
          <table class="aos-table"><thead><tr>
            <th>Device ID</th><th>Type</th><th>Merchant</th><th>Version</th><th>Status</th><th>Last Seen</th>
          </tr></thead><tbody>${devices.map(d => `<tr>
            <td class="aos-mono">${_esc(d.deviceId||d.id||"—")}</td>
            <td>${_esc(d.type||"—")}</td>
            <td>${_esc(d.merchantName||d.merchantUid||"—")}</td>
            <td>${_esc(d.version||"—")}</td>
            <td><span class="status-badge st-${d.status||"unknown"}">${d.status||"unknown"}</span></td>
            <td class="aos-muted">${_date(d.lastSeen)}</td>
          </tr>`).join("") || _emptyRow(6,"No devices registered")}</tbody></table>`;
      } else if (tab === "revenue") {
        const data = await _call("getAdminRevenueReport", { scope: "pos", days: 7 }).catch(() => ({}));
        const r = data.report || data;
        body.innerHTML = `
          <div class="pos-stats">
            <div class="stat-card success"><span>POS Revenue (7d)</span><strong>KES ${_fmt(r.totalRevenue||0)}</strong></div>
            <div class="stat-card"><span>Total Transactions</span><strong>${_fmt(r.transactionCount||0)}</strong></div>
            <div class="stat-card"><span>Avg Basket Size</span><strong>KES ${_fmt(r.avgBasket||0)}</strong></div>
            <div class="stat-card"><span>Platform Commission</span><strong>KES ${_fmt(r.totalCommission||0)}</strong></div>
          </div>
          ${r.revenueByDay ? `<div class="dash-section"><h3>Daily Revenue</h3><div class="chart-wrap"><canvas id="posRevenueChart" height="160"></canvas></div></div>` : _emptyMsg("Revenue chart data not available")}`;
        if (r.revenueByDay) _drawLineChart("posRevenueChart", r.revenueByDay, "KES");
      } else if (tab === "shifts") {
        const snap = await _db.collection("posShifts").orderBy("openedAt","desc").limit(30).get().catch(() => null);
        const shifts = snap ? snap.docs.map(d => ({id:d.id,...d.data()})) : [];
        body.innerHTML = shifts.length ? `<table class="aos-table"><thead><tr>
            <th>Shift ID</th><th>Cashier</th><th>Merchant</th><th>Opened</th><th>Closed</th><th>Total Sales</th><th>Status</th>
          </tr></thead><tbody>${shifts.map(s => `<tr>
            <td class="aos-mono">${s.id.slice(0,8)}</td>
            <td>${_esc(s.cashierName||s.cashierId||"—")}</td>
            <td>${_esc(s.merchantName||s.merchantId||"—")}</td>
            <td class="aos-muted">${_date(s.openedAt)}</td>
            <td class="aos-muted">${s.closedAt ? _date(s.closedAt) : "<span class='st-active status-badge'>Open</span>"}</td>
            <td>KES ${_fmt(s.totalSales||0)}</td>
            <td><span class="status-badge st-${s.status||"open"}">${s.status||"open"}</span></td>
          </tr>`).join("")}</tbody></table>` : _emptyMsg("No shift records found");
      }
    } catch (e) { body.innerHTML = _emptyMsg("Error: " + e.message); }
  }

  // ── Fraud & Trust ─────────────────────────────────────────────────────────────
  async function _loadFraud() {
    const body = document.getElementById("fraudBody");
    if (!body) return;
    body.innerHTML = _spinner();
    try {
      const [dash, alerts] = await Promise.all([
        _call("tsGetTrustDashboard").catch(() => ({})),
        _call("adminGetFraudAlerts").catch(() => ({ alerts: [] })),
      ]);
      const d = dash.stats || dash;
      const a = alerts.alerts || [];
      body.innerHTML = `
        <div class="fraud-stats">
          <div class="stat-card warn"><span>Pending Reports</span><strong>${_fmt(d.pendingReports||0)}</strong></div>
          <div class="stat-card danger"><span>Critical</span><strong>${_fmt(d.criticalPending||0)}</strong></div>
          <div class="stat-card"><span>Banned Users</span><strong>${_fmt(d.bannedUsers||0)}</strong></div>
          <div class="stat-card warn"><span>High Risk Entities</span><strong>${_fmt(d.highRiskCount||0)}</strong></div>
          <div class="stat-card"><span>Resolved Today</span><strong>${_fmt(d.resolvedToday||0)}</strong></div>
          <div class="stat-card success"><span>False Positives</span><strong>${_fmt(d.falsePositives||0)}</strong></div>
        </div>
        <div style="display:flex;gap:8px;margin:16px 0;flex-wrap:wrap">
          <button class="aos-btn" onclick="SokoniAOS.viewReports()">&#x1F4CB; Reports Queue</button>
          <button class="aos-btn" onclick="SokoniAOS.viewBanned()">&#x1F6AB; Banned Users</button>
          <button class="aos-btn" onclick="SokoniAOS.viewRiskScores()">&#x26A0;&#xFE0F; Risk Scores</button>
          <a class="aos-btn" href="trust-safety.html" target="_blank">&#x1F512; Full Trust Center</a>
          <button class="aos-btn danger" onclick="SokoniAOS.voidReceiptDialog()">&#x1F6AB; Void Receipt</button>
        </div>
        <h3>Live Fraud Alerts</h3>
        <div class="alert-list">${a.length ? a.map(al => `
          <div class="alert-chip sev-${al.severity||'warn'}">
            <span class="alert-icon">${_sevIcon(al.severity)}</span>
            <span><strong>${_esc(al.title||"Alert")}</strong> — ${_esc(al.description||"")}</span>
            <time>${_ago(al.createdAt)}</time>
            <button class="aos-btn-sm" onclick="SokoniAOS.investigateAlert('${al.id}')">Investigate</button>
          </div>`).join("") : "<p class='aos-muted'>No active fraud alerts.</p>"}</div>
        <h3 style="margin-top:20px;margin-bottom:10px;font-size:14px">Payment Anomaly Detection</h3>
        <div id="paymentAnomaliesSection">${_spinner()}</div>`;
      _loadPaymentAnomalies();
    } catch (e) { body.innerHTML = _emptyMsg("Error: " + e.message); }
  }

  async function _loadPaymentAnomalies() {
    const el = document.getElementById("paymentAnomaliesSection");
    if (!el) return;
    const data = await _call("detectPaymentAnomalies").catch(() => ({ anomalies: [] }));
    const anomalies = data.anomalies || [];
    el.innerHTML = anomalies.length ? `<table class="aos-table"><thead><tr>
        <th>Pattern</th><th>Severity</th><th>Amount</th><th>Count</th><th>Detected</th>
      </tr></thead><tbody>${anomalies.map(a => `<tr>
        <td><span class="audit-action">${_esc(a.pattern||"—")}</span></td>
        <td><span class="prio-badge prio-${a.severity||"medium"}">${a.severity||"medium"}</span></td>
        <td>KES ${_fmt(a.amount||0)}</td>
        <td>${_fmt(a.count||0)}</td>
        <td class="aos-muted">${_ago(a.detectedAt||a.createdAt)}</td>
      </tr>`).join("")}</tbody></table>` : "<p class='aos-muted' style='padding:8px 0'>No payment anomalies detected. &#x2705;</p>";
  }

  async function voidReceiptDialog() {
    const receiptId = prompt("Enter receipt ID to void:");
    if (!receiptId) return;
    const reason = prompt("Void reason (required for audit):");
    if (!reason) return;
    if (!(await SK.dialog.confirm(`Receipt ${receiptId} will be permanently voided. This action is irreversible and will be logged.`, null, null, { title: "Void receipt?", variant: "danger", confirmLabel: "Void receipt" }))) return;
    try {
      await _call("voidTrustReceipt", { receiptId, reason });
    } catch (e) {
      _toast(e.message, "error");
      return;
    }
    _toast("Receipt voided — audit trail recorded", "success");
  }

  async function viewReports() {
    const data = await _call("tsGetReports", { status: "pending", limit: 20 }).catch(() => ({ reports: [] }));
    const reports = data.reports || [];
    _modal("Reports Queue", `<table class="aos-table"><thead><tr>
        <th>Type</th><th>Target</th><th>Reason</th><th>Date</th><th>Actions</th>
      </tr></thead><tbody>${reports.map(r => `<tr>
        <td>${_esc(r.entityType||"—")}</td>
        <td class="aos-muted">${_esc(r.targetId||"—")}</td>
        <td>${_esc(r.reason||"—")}</td>
        <td class="aos-muted">${_date(r.createdAt)}</td>
        <td>
          <button class="aos-btn-sm success" onclick="SokoniAOS.reviewReport('${r.id}','dismiss')">Dismiss</button>
          <button class="aos-btn-sm danger"  onclick="SokoniAOS.reviewReport('${r.id}','action')">Action</button>
        </td>
      </tr>`).join("") || _emptyRow(5,"No pending reports")}</tbody></table>`);
  }

  async function reviewReport(id, action) {
    try {
      await _call("tsReviewReport", { reportId: id, action });
    } catch (e) {
      _toast(e.message, "error");
      return;
    }
    _toast("Report " + action + "ed","success"); _closeModal(); _panelCache.fraud = false; _loadFraud();
  }

  async function investigateAlert(id) {
    const data = await _call("evaluateFraudRisk", { alertId: id }).catch(() => null);
    if (data) _modal("Fraud Investigation", _kvHtml(data.result || data.report || data));
  }

  // ── Analytics ─────────────────────────────────────────────────────────────────
  async function _loadAnalytics() { _analyticsTab("overview"); }

  async function _analyticsTab(tab) {
    document.querySelectorAll("#panel-analytics .tab-btn").forEach(b =>
      b.classList.toggle("active", b.dataset.tab === tab));
    const body = document.getElementById("analyticsBody");
    if (!body) return;
    body.innerHTML = _spinner();
    try {
      if (tab === "overview") {
        const [weekly, marketplace] = await Promise.all([
          _call("getWeeklyReports").catch(() => ({})),
          _call("getMarketplaceQualityReport").catch(() => ({})),
        ]);
        const w = weekly.report || weekly;
        const m = marketplace.report || marketplace;
        body.innerHTML = `
          <div class="analytics-grid">
            <div class="dash-section" style="grid-column:span 2">
              <h3>Weekly Revenue</h3>
              <div class="chart-wrap"><canvas id="analyticsRevenueChart" height="160"></canvas></div>
            </div>
            <div class="dash-section">
              <h3>Order Status</h3>
              <div class="chart-wrap"><canvas id="analyticsOrderChart" height="160"></canvas></div>
            </div>
            <div class="dash-section">
              <h3>User Growth</h3>
              <div class="chart-wrap"><canvas id="analyticsUserChart" height="160"></canvas></div>
            </div>
          </div>
          <div style="margin-top:24px">
            <h3 style="margin-bottom:12px;font-size:14px">Marketplace Quality</h3>
            <div class="mkt-quality">
              <div class="stat-card"><span>Avg Product Rating</span><strong>${(m.avgRating||0).toFixed(2)} &#x2605;</strong></div>
              <div class="stat-card"><span>Active Listings</span><strong>${_fmt(m.activeListings||0)}</strong></div>
              <div class="stat-card"><span>Incomplete Listings</span><strong class="${(m.incompleteListings||0)>0?"warn":""}">${_fmt(m.incompleteListings||0)}</strong></div>
              <div class="stat-card warn"><span>Low Stock Alerts</span><strong>${_fmt(m.lowStockCount||0)}</strong></div>
            </div>
          </div>
          <div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap">
            <button class="aos-btn" onclick="SokoniAOS.exportAnalytics()">&#x1F4E5; Export CSV</button>
            <a class="aos-btn" href="platform-health.html" target="_blank">&#x1F4CA; Platform Health</a>
            <a class="aos-btn" href="revenue-dashboard.html" target="_blank">&#x1F4B0; Revenue Dashboard</a>
          </div>`;
        if (w.revenueByDay)    _drawLineChart("analyticsRevenueChart", w.revenueByDay, "KES");
        if (w.ordersByStatus)  _drawDonutChart("analyticsOrderChart",  w.ordersByStatus);
        if (w.userGrowthByDay) _drawLineChart("analyticsUserChart",    w.userGrowthByDay, "");
      } else if (tab === "cohort") {
        const data = await _call("adminGetCohortAnalysis").catch(() => ({ cohorts: [] }));
        const cohorts = data.cohorts || [];
        if (!cohorts.length) {
          body.innerHTML = `
            <div class="dash-section">
              <h3>User Cohorts (Monthly)</h3>
              <p class="aos-muted" style="margin:8px 0 12px;font-size:12px">Tracks retention of users signed up in each month, measured by subsequent weekly activity.</p>
              ${_emptyMsg("Cohort analysis data not yet available — ensure adminGetCohortAnalysis CF is deployed")}
            </div>`;
        } else {
          const weeks = cohorts[0]?.weeks?.length || 8;
          const headers = Array.from({length: weeks}, (_,i) => `W${i+1}`);
          body.innerHTML = `
            <div class="dash-section">
              <h3>User Cohorts (Monthly)</h3>
              <p class="aos-muted" style="margin:8px 0 12px;font-size:12px">Retention % by week after signup. Darker = higher retention.</p>
              <div style="overflow-x:auto"><table class="aos-table">
                <thead><tr><th>Cohort</th><th>Users</th>${headers.map(h=>`<th>${h}</th>`).join("")}</tr></thead>
                <tbody>${cohorts.map(c => `<tr>
                  <td>${_esc(c.month||"—")}</td>
                  <td>${_fmt(c.users||0)}</td>
                  ${(c.weeks||[]).map(pct => {
                    const v = Math.round(pct||0);
                    const bg = v>=60?"rgba(76,175,80,0.3)":v>=30?"rgba(255,152,0,0.2)":"rgba(244,67,54,0.2)";
                    return `<td style="background:${bg};text-align:center">${v}%</td>`;
                  }).join("")}
                </tr>`).join("")}</tbody>
              </table></div>
            </div>`;
        }
      } else if (tab === "funnel") {
        const data = await _call("adminGetConversionFunnel").catch(() => ({ steps: [] }));
        const steps = data.steps || [
          { label: "Visited", count: 0 },
          { label: "Registered", count: 0 },
          { label: "Browsed", count: 0 },
          { label: "Added to Cart", count: 0 },
          { label: "Checkout", count: 0 },
          { label: "Completed Order", count: 0 },
        ];
        const max = steps[0]?.count || 1;
        body.innerHTML = `
          <div class="dash-section">
            <h3>Conversion Funnel</h3>
            <div style="display:flex;flex-direction:column;gap:10px;margin-top:12px">
              ${steps.map((s, i) => {
                const pct = max ? Math.round((s.count||0) / max * 100) : 0;
                const prev = i > 0 ? steps[i-1].count || 1 : max;
                const drop = i > 0 ? (100 - Math.round((s.count||0) / prev * 100)) : 0;
                return `<div>
                  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;font-size:13px">
                    <span>${_esc(s.label)}</span>
                    <span style="color:var(--aos-muted)">${_fmt(s.count||0)} users${drop>0?` <span style="color:var(--aos-danger)">&#x2193;${drop}%</span>`:""}</span>
                  </div>
                  <div style="background:rgba(255,255,255,.06);border-radius:4px;height:28px;position:relative">
                    <div style="background:var(--aos-accent);opacity:0.7;height:100%;border-radius:4px;width:${pct}%;transition:width .3s"></div>
                    <span style="position:absolute;left:8px;top:50%;transform:translateY(-50%);font-size:12px;color:#000;font-weight:600">${pct}%</span>
                  </div>
                </div>`;
              }).join("")}
            </div>
          </div>`;
      } else if (tab === "retention") {
        const data = await _call("adminGetRetentionMetrics").catch(() => ({}));
        const r = data.retention || data;
        body.innerHTML = `
          <div class="ai-stats-grid" style="margin-bottom:20px">
            <div class="stat-card"><span>D1 Retention</span><strong>${(r.d1||0).toFixed(1)}%</strong></div>
            <div class="stat-card"><span>D7 Retention</span><strong>${(r.d7||0).toFixed(1)}%</strong></div>
            <div class="stat-card"><span>D30 Retention</span><strong>${(r.d30||0).toFixed(1)}%</strong></div>
            <div class="stat-card"><span>D90 Retention</span><strong>${(r.d90||0).toFixed(1)}%</strong></div>
            <div class="stat-card success"><span>Monthly Active Users</span><strong>${_fmt(r.mau||0)}</strong></div>
            <div class="stat-card"><span>Weekly Active Users</span><strong>${_fmt(r.wau||0)}</strong></div>
          </div>
          <div class="dash-section">
            <h3>Retention Trend (30 Days)</h3>
            <div class="chart-wrap"><canvas id="retentionChart" height="160"></canvas></div>
          </div>`;
        if (r.trend) _drawLineChart("retentionChart", r.trend, "");
      }
    } catch (e) { body.innerHTML = _emptyMsg("Error: " + e.message); }
  }

  async function exportAnalytics() {
    _toast("Preparing export…","info");
    const data = await _call("getAdminRevenueReport", { days: 30 }).catch(e => { _toast(e.message,"error"); return null; });
    if (!data) return;
    const rows = (data.report?.revenueByDay || []).map(r => `${r.date},${r.value}`);
    const csv  = "Date,Revenue\n" + rows.join("\n");
    const a    = document.createElement("a");
    a.href     = "data:text/csv;charset=utf-8," + encodeURIComponent(csv);
    a.download = "sokoni-analytics-" + new Date().toISOString().slice(0,10) + ".csv";
    a.click();
  }

  // ── Config ────────────────────────────────────────────────────────────────────
  async function _loadConfig() {
    const body = document.getElementById("configBody");
    if (!body) return;
    body.innerHTML = _spinner();
    try {
      const [settings, flags] = await Promise.all([
        _call("adminGetPlatformSettings"),
        _call("adminGetFeatureFlags"),
      ]);
      const s = settings.settings || {};
      const f = flags.flags || [];
      body.innerHTML = `
        <div class="config-grid">
          <section class="config-section">
            <h3>Platform Settings</h3>
            <form id="settingsForm">
              ${_configField("Platform Name",       "platformName",       s.platformName||"SOKONI")}
              ${_configField("Support Email",        "supportEmail",       s.supportEmail||"")}
              ${_configField("Commission Rate (%)",  "commissionRate",     s.commissionRate||"5", "number")}
              ${_configField("Referral Bonus (KES)", "referralBonus",      s.referralBonus||"100","number")}
              ${_configField("Min Payout (KES)",     "minPayoutAmount",    s.minPayoutAmount||"500","number")}
              ${_configField("Max Refund Days",      "refundWindowDays",   s.refundWindowDays||"7","number")}
              <label class="config-label toggle-row">
                <span>Maintenance Mode</span>
                <label class="toggle-sw"><input type="checkbox" id="maintenanceMode" ${s.maintenanceMode?"checked":""}><span></span></label>
              </label>
              <button type="button" class="aos-btn success" onclick="SokoniAOS.saveSettings()">Save Settings</button>
            </form>
          </section>
          <section class="config-section">
            <h3>Feature Flags</h3>
            <div class="flag-list">${f.map(flag => `
              <div class="toggle-row">
                <span>${_esc(flag.label||flag.key||"—")}</span>
                <label class="toggle-sw">
                  <input type="checkbox" ${flag.enabled?"checked":""} onchange="SokoniAOS.updateFlag('${flag.key}',this.checked)">
                  <span></span>
                </label>
              </div>`).join("") || "<p class='aos-muted'>No feature flags configured.</p>"}</div>
          </section>
        </div>
        <div class="config-grid" style="margin-top:20px">
          <section class="config-section">
            <h3>Commission Rules</h3>
            <form id="commissionForm">
              ${_configField("Marketplace Commission (%)","commMarketplace", s.commMarketplace||"5","number")}
              ${_configField("Services Commission (%)",    "commServices",    s.commServices||"8","number")}
              ${_configField("Events Commission (%)",      "commEvents",      s.commEvents||"3","number")}
              ${_configField("SmartPOS Commission (%)",    "commPOS",         s.commPOS||"1.5","number")}
              ${_configField("Delivery Commission (%)",    "commDelivery",    s.commDelivery||"0","number")}
              ${_configField("Jobs Commission (%)",        "commJobs",        s.commJobs||"5","number")}
              <button type="button" class="aos-btn success" onclick="SokoniAOS.saveCommissionRules()">Save Commission Rules</button>
            </form>
          </section>
          <section class="config-section">
            <h3>Payout Schedule</h3>
            <form id="payoutForm">
              ${_configField("Payout Frequency",           "payoutFrequency", s.payoutFrequency||"weekly")}
              ${_configField("Payout Day (0=Sun…6=Sat)",   "payoutDay",       s.payoutDay||"1","number")}
              ${_configField("Hold Period (days)",          "payoutHoldDays",  s.payoutHoldDays||"2","number")}
              ${_configField("Min Payout Threshold (KES)",  "payoutMinKES",    s.payoutMinKES||"500","number")}
              ${_configField("Auto-Payout Limit (KES)",     "payoutAutoLimit", s.payoutAutoLimit||"100000","number")}
              <label class="config-label toggle-row">
                <span>Auto-Payout Enabled</span>
                <label class="toggle-sw"><input type="checkbox" id="payoutAutoEnabled" ${s.payoutAutoEnabled?"checked":""}><span></span></label>
              </label>
              <button type="button" class="aos-btn success" onclick="SokoniAOS.savePayoutSchedule()">Save Payout Schedule</button>
            </form>
          </section>
        </div>`;
    } catch (e) { body.innerHTML = _emptyMsg("Error: " + e.message); }
  }

  async function saveSettings() {
    const form = document.getElementById("settingsForm");
    if (!form) return;
    const settings = {};
    form.querySelectorAll("[id]").forEach(el => {
      settings[el.id] = el.type === "checkbox" ? el.checked : el.value;
    });
    try {
      await _call("adminUpdatePlatformSettings", { settings });
    } catch (e) {
      _toast(e.message, "error");
      return;
    }
    _toast("Settings saved","success");
  }

  async function updateFlag(key, enabled) {
    try {
      await _call("adminUpdateFeatureFlag", { key, enabled });
    } catch (e) {
      _toast(e.message, "error");
      return;
    }
    _toast((enabled?"Enabled":"Disabled") + " " + key,"success");
  }

  async function saveCommissionRules() {
    const form = document.getElementById("commissionForm");
    if (!form) return;
    const rules = {};
    form.querySelectorAll("[id]").forEach(el => { rules[el.id] = parseFloat(el.value) || 0; });
    try {
      await _call("adminUpdatePlatformSettings", { settings: rules });
    } catch (e) {
      _toast(e.message, "error");
      return;
    }
    _toast("Commission rules saved","success");
  }

  async function savePayoutSchedule() {
    const form = document.getElementById("payoutForm");
    if (!form) return;
    const schedule = {};
    form.querySelectorAll("[id]").forEach(el => {
      schedule[el.id] = el.type === "checkbox" ? el.checked : (isNaN(Number(el.value)) ? el.value : Number(el.value));
    });
    try {
      await _call("adminUpdatePlatformSettings", { settings: schedule });
    } catch (e) {
      _toast(e.message, "error");
      return;
    }
    _toast("Payout schedule saved","success");
  }

  // ── Audit ─────────────────────────────────────────────────────────────────────
  async function _loadAudit(type = "admin") {
    const body = document.getElementById("auditBody");
    if (!body) return;
    body.innerHTML = _spinner();
    try {
      let data;
      if (type === "admin")   data = await _call("adminGetAuditLogs",   { limit: 50 });
      else if (type === "payment") data = await _call("getPaymentAuditTrail", { limit: 50 });
      else if (type === "security") data = await _call("eccGetAuditLog",  { limit: 50 });
      else if (type === "platform") data = await _call("platformGetEventLog", { limit: 50 });

      const logs = data?.logs || data?.events || data?.entries || [];

      /* ACTIVITY FEED. Renders the same logs as a day-grouped timeline with category
         filters, contributors and an activity shape — all counted from THIS page of logs,
         which is why every panel names its scope. The source returns a capped page with no
         total and no read state, so the feed shows no platform total, no unread filter and
         no day-over-day change; it marks the truncated oldest day instead.

         Additive: if the module is absent or declines, the original table below still
         renders, and the export button is wired either way. */
      let _feedShown = false;
      if (window.SokoniAOSActivity && typeof window.SokoniAOSActivity.mount === "function") {
        try {
          _feedShown = window.SokoniAOSActivity.mount({ host: body, logs, limit: 50 });
        } catch (e) {
          console.warn("[AOS] activity feed unavailable, using table:", e && e.message);
        }
      }
      if (_feedShown) {
        const xb = document.getElementById("auditExportBtn");
        if (xb) xb.onclick = () => _exportAuditLogs(logs, type);
        return;
      }

      body.innerHTML = logs.length ? `<table class="aos-table"><thead><tr>
          <th>Time</th><th>Admin</th><th>Action</th><th>Target</th><th>Details</th>
        </tr></thead><tbody>${logs.map(l => `<tr>
          <td class="aos-muted aos-mono">${_date(l.createdAt||l.timestamp)}</td>
          <td>${_esc(l.adminEmail||l.adminUid||l.uid||"system")}</td>
          <td><span class="audit-action">${_esc(l.action||l.event||l.type||"—")}</span></td>
          <td class="aos-muted">${_esc(l.targetId||l.target||"—")}</td>
          <td class="aos-muted">${_esc(typeof l.details==="object"?JSON.stringify(l.details).slice(0,80):l.details||"—")}</td>
        </tr>`).join("")}</tbody></table>` : _emptyMsg("No audit logs");

      const exportBtn = document.getElementById("auditExportBtn");
      if (exportBtn) exportBtn.onclick = () => _exportAuditLogs(logs, type);
    } catch (e) { body.innerHTML = _emptyMsg("Error: " + e.message); }
  }

  function filterAuditRows(query) {
    const q = (query || "").toLowerCase();
    document.querySelectorAll("#auditBody .aos-table tbody tr").forEach(row => {
      row.style.display = !q || row.textContent.toLowerCase().includes(q) ? "" : "none";
    });
  }

  function _exportAuditLogs(logs, type) {
    const cols = ["time","admin","action","target","details"];
    const rows = logs.map(l => [
      _date(l.createdAt||l.timestamp),
      l.adminEmail||l.adminUid||"system",
      l.action||l.event||l.type||"—",
      l.targetId||l.target||"—",
      typeof l.details==="object" ? JSON.stringify(l.details) : (l.details||"—"),
    ].map(v => `"${String(v).replace(/"/g,'""')}"`).join(","));
    const csv = cols.join(",") + "\n" + rows.join("\n");
    const a   = document.createElement("a");
    a.href    = "data:text/csv;charset=utf-8," + encodeURIComponent(csv);
    a.download = "audit-" + type + "-" + new Date().toISOString().slice(0,10) + ".csv";
    a.click();
  }

  // ── Security ──────────────────────────────────────────────────────────────────
  /* ── INVOICES ────────────────────────────────────────────────────────────────
     The finance suite's 37 callables were consolidated into ONE Cloud Run service:
     clients call financeSprintDispatch({op, ...data}). `invoiceList` is NOT exported
     individually by functions/index.js, so calling it by name would target a function
     that does not exist. This routes through the dispatcher, like finance-budget.html,
     finance-expenses.html and finance-reconcile.html already do.

     Shop-scoped by the contract, not by choice — see the section map. */
  async function _invoiceCall(op, data) {
    const r = await _fn.httpsCallable("financeSprintDispatch")({ op, ...(data || {}) });
    return r.data;
  }

  let _invShop = "";

  async function _loadInvoices() {
    const body = document.getElementById("invoicesBody");
    if (!body) return;
    const shopId = (document.getElementById("invShopId") || {}).value || _invShop;
    if (!shopId) {
      body.innerHTML = _emptyMsg(
        "Choose a shop. Invoices are issued by a shop to its clients, and every invoice " +
        "callable answers for one shop — there is no platform-wide invoice ledger to show.");
      return;
    }
    _invShop = shopId;
    body.innerHTML = `<div class="aos-spinner"><div></div></div>`;
    let invoices = [];
    try {
      const data = await _invoiceCall("invoiceList", { shopId, limit: 200 });
      invoices = (data && data.invoices) || [];
    } catch (e) {
      body.innerHTML = _emptyMsg("Could not read invoices for this shop: " + _esc(e.message));
      return;
    }

    if (window.SokoniInvoiceDesk && typeof window.SokoniInvoiceDesk.mount === "function") {
      try {
        body.innerHTML = "";
        const host = document.createElement("div");
        host.id = "invoicesRich";
        body.appendChild(host);
        const shown = window.SokoniInvoiceDesk.mount({
          host, invoices,
          // The three writes stay with the server handlers that already own them. Each
          // prompts exactly as the merchant page does, then reloads from the source.
          actions: {
            send: (id) => _invoiceAction("invoiceSend", { invoiceId: id, shopId }, "Invoice sent"),
            markPaid: (id) => {
              const ref = prompt("Payment reference (M-Pesa transaction ID, etc.):");
              if (!ref) return;
              return _invoiceAction("invoiceMarkPaid",
                { invoiceId: id, shopId, paymentRef: ref, paymentMethod: "mpesa" }, "Marked paid");
            },
            voidInvoice: (id) => {
              const reason = prompt("Void reason (required):");
              if (!reason) return;
              return _invoiceAction("invoiceVoid", { invoiceId: id, shopId, reason }, "Invoice voided");
            },
          },
        });
        if (shown) return;
      } catch (e) {
        console.warn("[AOS] invoice desk unavailable:", e && e.message);
      }
    }
    body.innerHTML = _emptyMsg("The invoice desk module did not load.");
  }

  async function _invoiceAction(op, data, okMsg) {
    try {
      await _invoiceCall(op, data);
      _toast(okMsg, "success");
      _loadInvoices();
    } catch (e) { _toast(e.message, "error"); }
  }

  async function _loadSecurity() {
    const body = document.getElementById("securityBody");
    if (!body) return;

    /* SECURITY CENTRE. Renders the dedicated surface when sokoni-aos-security.js is loaded,
       and otherwise falls through to the original panel below — so this is additive and no
       other AdminOS section is affected either way.

       It reads the same collections this panel does, plus securityAlerts / securityIncidents
       / securityAuditLog / securityRisk, and orders events by `ts` (every writer stamps
       `ts`; the query below orders by `createdAt`, which Firestore treats as "exclude
       documents lacking the field" — so it reports no events on a platform recording them). */
    if (window.SokoniAOSSecurity && typeof window.SokoniAOSSecurity.mount === "function") {
      try {
        const done = await window.SokoniAOSSecurity.mount({
          host: body, db: _db,
          actions: { revokeSession, approveRequest, rejectRequest },
        });
        if (done) return;
      } catch (e) {
        /* Fall through to the original panel rather than leaving the section blank. */
        console.warn("[AOS] security centre unavailable, using base panel:", e && e.message);
      }
    }

    body.innerHTML = _spinner();
    try {
      const snap = await _db.collection("activeSessions")
        .orderBy("lastActive","desc").limit(30).get().catch(() => null);
      const sessions = snap ? snap.docs.map(d => ({id:d.id,...d.data()})) : [];

      const pendings = await _db.collection("approvalRequests").where("status","==","pending")
        .orderBy("createdAt","desc").limit(20).get().catch(() => null);
      const approvals = pendings ? pendings.docs.map(d => ({id:d.id,...d.data()})) : [];

      body.innerHTML = `
        <div class="security-grid">
          <section>
            <h3>Active Sessions (${sessions.length})</h3>
            <table class="aos-table"><thead><tr>
                <th>User</th><th>IP</th><th>Device</th><th>Last Active</th><th>Actions</th>
              </tr></thead><tbody>${sessions.map(s => `<tr>
                <td>${_esc(s.email||s.uid||"—")}</td>
                <td class="aos-muted aos-mono">${_esc(s.ip||"—")}</td>
                <td class="aos-muted">${_esc(s.device||"—")}</td>
                <td class="aos-muted">${_ago(s.lastActive)}</td>
                <td><button class="aos-btn-sm danger" onclick="SokoniAOS.revokeSession('${s.id}')">Revoke</button></td>
              </tr>`).join("") || _emptyRow(5,"No active sessions tracked")}</tbody></table>
          </section>
          <section>
            <h3>Pending Approvals (${approvals.length})</h3>
            ${approvals.length ? `<table class="aos-table"><thead><tr>
                <th>Type</th><th>Requested By</th><th>Details</th><th>Date</th><th>Actions</th>
              </tr></thead><tbody>${approvals.map(a => `<tr>
                <td><span class="audit-action">${_esc(a.type||"—")}</span></td>
                <td>${_esc(a.requestedByEmail||a.requestedBy||"—")}</td>
                <td class="aos-muted">${_esc(a.description||"—")}</td>
                <td class="aos-muted">${_date(a.createdAt)}</td>
                <td>
                  <button class="aos-btn-sm success" onclick="SokoniAOS.approveRequest('${a.id}')">Approve</button>
                  <button class="aos-btn-sm danger" onclick="SokoniAOS.rejectRequest('${a.id}')">Reject</button>
                </td>
              </tr>`).join("")}</tbody></table>` : "<p class='aos-muted'>No pending approvals.</p>"}
          </section>
          <section style="grid-column:1/-1">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
              <h3>Security Tools</h3>
              <button class="aos-btn danger" onclick="SokoniAOS.revokeAllSessions()">&#x26A0;&#xFE0F; Revoke All Sessions</button>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px">
              <a class="aos-btn" href="security-center.html" target="_blank">&#x1F6E1;&#xFE0F; Security Center</a>
              <a class="aos-btn" href="security-zero-trust-dashboard.html" target="_blank">&#x1F510; Zero Trust Dashboard</a>
              <button class="aos-btn" onclick="SokoniAOS.loadSecurityEvents()">&#x1F50D; Load Security Events</button>
            </div>
            <h3 style="margin-bottom:10px;font-size:14px">Recent Security Events</h3>
            <div id="securityEventsBody">${_spinner()}</div>
          </section>
        </div>`;
      _loadSecurityEvents();
    } catch (e) { body.innerHTML = _emptyMsg("Error: " + e.message); }
  }

  async function _loadSecurityEvents() {
    const el = document.getElementById("securityEventsBody");
    if (!el) return;
    const snap = await _db.collection("securityEvents")
      .orderBy("createdAt","desc").limit(20).get().catch(() => null);
    if (!snap) { el.innerHTML = "<p class='aos-muted'>Security events collection not available.</p>"; return; }
    el.innerHTML = snap.empty ? "<p class='aos-muted'>No recent security events.</p>"
      : `<table class="aos-table"><thead><tr>
          <th>Event</th><th>User</th><th>IP</th><th>Time</th>
        </tr></thead><tbody>${snap.docs.map(d => {
          const e = d.data();
          return `<tr>
            <td><span class="audit-action">${_esc(e.type||e.event||"—")}</span></td>
            <td class="aos-muted">${_esc(e.email||e.uid||"system")}</td>
            <td class="aos-mono aos-muted">${_esc(e.ip||"—")}</td>
            <td class="aos-muted">${_ago(e.createdAt)}</td>
          </tr>`;
        }).join("")}</tbody></table>`;
  }

  async function revokeAllSessions() {
    if (!(await SK.dialog.confirm("Every signed-in user will be signed out immediately.", null, null, { title: "Revoke ALL active sessions?", variant: "danger", confirmLabel: "Revoke all" }))) return;
    const snap = await _db.collection("activeSessions").get().catch(() => null);
    if (!snap || snap.empty) { _toast("No active sessions to revoke", "info"); return; }
    const batch = _db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    try {
      await batch.commit();
    } catch (e) {
      _toast(e.message, "error");
      return;
    }
    _toast(`${snap.size} session(s) revoked`, "success");
    _panelCache.security = false;
    _loadSecurity();
  }

  async function revokeSession(sessionId) {
    if (!(await SK.dialog.confirm("This device will be signed out immediately.", null, null, { title: "Revoke this session?", variant: "danger", confirmLabel: "Revoke" }))) return;
    try {
      await _db.collection("activeSessions").doc(sessionId).delete();
    } catch (e) {
      _toast(e.message, "error");
      return;
    }
    _toast("Session revoked","success"); _panelCache.security = false; _loadSecurity();
  }

  async function approveRequest(id) {
    try {
      await _db.collection("approvalRequests").doc(id).update({ status:"approved", approvedBy: _currentUser.uid, approvedAt: firebase.firestore.FieldValue.serverTimestamp() });
    } catch (e) {
      _toast(e.message, "error");
      return;
    }
    _toast("Request approved","success"); _panelCache.security = false; _loadSecurity();
  }
  async function rejectRequest(id) {
    const reason = prompt("Rejection reason:");
    try {
      await _db.collection("approvalRequests").doc(id).update({ status:"rejected", rejectedBy: _currentUser.uid, rejectionReason: reason||"", rejectedAt: firebase.firestore.FieldValue.serverTimestamp() });
    } catch (e) {
      _toast(e.message, "error");
      return;
    }
    _toast("Request rejected","success"); _panelCache.security = false; _loadSecurity();
  }

  // ── Chart helpers ─────────────────────────────────────────────────────────────
  function _drawLineChart(canvasId, data, prefix) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const w = canvas.width = canvas.offsetWidth || 400;
    const h = canvas.height;
    const pts = Array.isArray(data) ? data : Object.entries(data).map(([k,v])=>({date:k,value:v}));
    if (!pts.length) return;
    const vals = pts.map(p => p.value || p.amount || p.count || 0);
    const max  = Math.max(...vals) || 1;
    const min  = 0;
    const pw   = (w - 40) / (pts.length - 1 || 1);

    ctx.clearRect(0,0,w,h);
    ctx.strokeStyle = "#00bcd4";
    ctx.lineWidth   = 2;
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = 20 + i * pw;
      const y = h - 30 - ((vals[i] - min) / (max - min)) * (h - 50);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Fill under line
    const lastX = 20 + (pts.length-1)*pw;
    const lastY = h - 30 - ((vals[vals.length-1]-min)/(max-min))*(h-50);
    ctx.lineTo(lastX, h-30); ctx.lineTo(20, h-30); ctx.closePath();
    ctx.fillStyle = "rgba(0,188,212,0.12)";
    ctx.fill();

    // X labels
    ctx.fillStyle = "#888";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    pts.forEach((p,i) => {
      if (i % Math.ceil(pts.length/5) === 0) {
        ctx.fillText(String(p.date||"").slice(5), 20 + i*pw, h-10);
      }
    });

    // Y max
    ctx.textAlign = "left";
    ctx.fillText(prefix + _fmt(max), 2, 14);
  }

  function _drawDonutChart(canvasId, data) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const w = canvas.width = canvas.offsetWidth || 200;
    const h = canvas.height;
    const cx = w/2, cy = h/2, r = Math.min(w,h)/2 - 20;
    const entries = typeof data === "object" && !Array.isArray(data) ? Object.entries(data) : data;
    const total   = entries.reduce((s,[,v]) => s + (Number(v)||0), 0) || 1;
    const colors  = ["#00bcd4","#4caf50","#ff9800","#e91e63","#9c27b0","#2196f3"];
    let angle     = -Math.PI/2;

    ctx.clearRect(0,0,w,h);
    entries.forEach(([,v], i) => {
      const slice = (Number(v)||0) / total * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx,cy);
      ctx.arc(cx,cy,r,angle,angle+slice);
      ctx.closePath();
      ctx.fillStyle = colors[i % colors.length];
      ctx.fill();
      angle += slice;
    });

    // Centre hole
    ctx.beginPath();
    ctx.arc(cx,cy,r*0.55,0,Math.PI*2);
    ctx.fillStyle = getComputedStyle(canvas).getPropertyValue("--aos-bg") || "#1a1a2e";
    ctx.fill();

    // Legend
    ctx.font = "10px sans-serif";
    ctx.textAlign = "left";
    entries.slice(0,5).forEach(([k,v],i) => {
      const ly = cy - (entries.length/2)*14 + i*14;
      ctx.fillStyle = colors[i % colors.length];
      ctx.fillRect(cx+r+8, ly-6, 8, 8);
      ctx.fillStyle = "#aaa";
      ctx.fillText(`${k}: ${v}`, cx+r+20, ly+1);
    });
  }

  // ── UI helpers ────────────────────────────────────────────────────────────────
  function _set(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  function _fmt(n) {
    if (n >= 1000000) return (n/1000000).toFixed(1) + "M";
    if (n >= 1000)    return (n/1000).toFixed(1) + "K";
    return String(Math.round(Number(n) || 0));
  }

  function _esc(s) {
    return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  function _date(ts) {
    if (!ts) return "—";
    const d = ts.toDate ? ts.toDate() : new Date(ts.seconds ? ts.seconds*1000 : ts);
    return d.toLocaleDateString("en-KE",{ day:"2-digit", month:"short", year:"numeric" });
  }

  function _ago(ts) {
    if (!ts) return "—";
    const d = ts.toDate ? ts.toDate() : new Date(ts.seconds ? ts.seconds*1000 : ts);
    const s = Math.floor((Date.now() - d)/1000);
    if (s < 60)   return s + "s ago";
    if (s < 3600) return Math.floor(s/60) + "m ago";
    if (s < 86400)return Math.floor(s/3600) + "h ago";
    return Math.floor(s/86400) + "d ago";
  }

  function _titleCase(s) {
    return s.replace(/([A-Z])/g," $1").replace(/^./, c => c.toUpperCase()).trim();
  }

  function _sevIcon(sev) {
    const m = { critical:"🔴", high:"🟠", medium:"🟡", low:"🔵", info:"ℹ️", warn:"⚠️" };
    return m[sev] || "⚠️";
  }

  function _spinner() {
    return '<div class="aos-spinner"><div></div></div>';
  }

  function _emptyMsg(msg) {
    return `<div class="empty-state"><span>📭</span><p>${_esc(msg)}</p></div>`;
  }

  function _emptyRow(cols, msg) {
    return `<tr><td colspan="${cols}" class="empty-cell">📭 ${_esc(msg)}</td></tr>`;
  }

  function _loadingRow(cols) {
    return `<tr><td colspan="${cols}" class="empty-cell">${_spinner()}</td></tr>`;
  }

  function _configField(label, id, val, type="text") {
    return `<label class="config-label"><span>${_esc(label)}</span><input type="${type}" id="${id}" value="${_esc(val)}"></label>`;
  }

  function _modal(title, bodyHtml) {
    let m = document.getElementById("aosModal");
    if (!m) {
      m = document.createElement("div");
      m.id = "aosModal";
      m.className = "aos-modal";
      m.innerHTML = `<div class="modal-box"><div class="modal-header"><h2 id="modalTitle"></h2>
        <button onclick="SokoniAOS.closeModal()">✕</button></div>
        <div class="modal-body" id="modalBody"></div></div>`;
      document.body.appendChild(m);
      m.addEventListener("click", e => { if (e.target === m) _closeModal(); });
    }
    document.getElementById("modalTitle").textContent = title;
    document.getElementById("modalBody").innerHTML    = bodyHtml;
    m.classList.add("open");
  }

  function _closeModal() {
    document.getElementById("aosModal")?.classList.remove("open");
  }

  function _toast(msg, type = "info") {
    let container = document.getElementById("aosToasts");
    if (!container) {
      container = document.createElement("div");
      container.id = "aosToasts";
      container.className = "toast-container";
      document.body.appendChild(container);
    }
    const t = document.createElement("div");
    t.className = "toast toast-" + type;
    t.textContent = msg;
    container.appendChild(t);
    setTimeout(() => t.classList.add("visible"), 10);
    setTimeout(() => { t.classList.remove("visible"); setTimeout(() => t.remove(), 300); }, 3000);
  }

  // ── Revenue Intelligence ─────────────────────────────────────────────────────
  function _loadRevenue() {
    const root = document.getElementById("revenueRoot");
    if (!root) return;
    if (!window.SokoniRevenue) {
      root.innerHTML = _emptyMsg("The revenue module did not load. Check that " +
        "sokoni-revenue-intelligence.js is served on this page.");
      return;
    }
    window.SokoniRevenue.mount(root);
  }

  // ── Reports Builder ──────────────────────────────────────────────────────────
  function _loadReports() {
    const root = document.getElementById("reportsRoot");
    if (!root) return;
    if (!window.SokoniReports) {
      root.innerHTML = _emptyMsg("The reports module did not load. Check that " +
        "sokoni-reports-builder.js is served on this page.");
      return;
    }
    window.SokoniReports.mount(root);
  }

  // ── Integrations Control Center ──────────────────────────────────────────────
  function _loadIntegrations() {
    const root = document.getElementById("integrationsRoot");
    if (!root) return;
    if (!window.SokoniIntegrations) {
      root.innerHTML = _emptyMsg("The integrations module did not load. Check that " +
        "sokoni-integrations.js is served on this page.");
      return;
    }
    window.SokoniIntegrations.mount(root);
  }

  // ── Hub Registry ─────────────────────────────────────────────────────────────
  const HUB_STATUS_BADGE = {
    live:         '<span class="status-badge st-active">live</span>',
    coming_soon:  '<span class="status-badge st-pending">soon</span>',
    maintenance:  '<span class="status-badge st-processing">maintenance</span>',
    disabled:     '<span class="status-badge st-inactive">disabled</span>',
  };
  const HEALTH_BADGE = {
    healthy:  '<span class="status-badge st-active">healthy</span>',
    warning:  '<span class="status-badge st-pending">warning</span>',
    degraded: '<span class="status-badge st-cancelled">degraded</span>',
  };

  async function _loadHubs() {
    const body = document.getElementById("hubsBody");
    if (!body) return;
    body.innerHTML = _spinner();
    try {
      const r = await _call("pcGetHubRegistry", { status: "" });
      const hubs = r.hubs || [];
      if (!hubs.length) { body.innerHTML = _emptyMsg("No hubs registered"); return; }
      body.innerHTML = `<div style="overflow-x:auto"><table class="aos-table">
        <thead><tr><th>Hub</th><th>Status</th><th>CFs</th><th>Collections</th><th>Actions</th></tr></thead>
        <tbody>${hubs.map(h => `<tr>
          <td><span style="font-size:18px">${_esc(h.icon||'📦')}</span> <strong>${_esc(h.name)}</strong><div style="color:var(--aos-muted);font-size:11px">${_esc(h.hubId)}</div></td>
          <td>${HUB_STATUS_BADGE[h.status] || h.status}</td>
          <td>${h.cfCount || '—'}</td>
          <td>${(h.collections||[]).length || '—'}</td>
          <td style="display:flex;gap:6px;flex-wrap:wrap;">
            <button class="aos-btn-sm" onclick="SokoniAOS.viewHubDetails('${_esc(h.hubId)}')">&#x1F50D; Details</button>
            ${h.status !== 'live'
              ? `<button class="aos-btn-sm success" onclick="SokoniAOS.activateHub('${_esc(h.hubId)}')">&#x25B6;&#xFE0F; Activate</button>`
              : `<button class="aos-btn-sm warning" onclick="SokoniAOS.deactivateHub('${_esc(h.hubId)}')">&#x23F8;&#xFE0F; Pause</button>`}
          </td>
        </tr>`).join('')}</tbody>
      </table></div>`;
    } catch(e) { body.innerHTML = _emptyMsg("Failed to load hubs: " + e.message); }
  }

  async function _loadHubHealth() {
    const row = document.getElementById("hubHealthRow");
    if (!row) return;
    row.innerHTML = `<div class="aos-spinner" style="width:100%;justify-content:flex-start;padding:0;"><div></div></div>`;
    try {
      const r = await _call("pcGetCrossHubHealth");
      const hubs = (r.hubs || []).filter(h => h.orders24h > 0 || h.status === 'live');
      if (!hubs.length) { row.innerHTML = '<span style="color:var(--aos-muted);font-size:12px">No hub activity in last 24h</span>'; return; }
      row.innerHTML = hubs.map(h => `
        <div class="health-chip" style="min-width:120px;cursor:default;">
          <span>${_esc(h.icon||'📦')} ${_esc(h.name)}</span>
          <strong>${h.orders24h}</strong>
          <div style="display:flex;align-items:center;justify-content:space-between;font-size:10px;margin-top:4px;">
            <span style="color:var(--aos-muted)">KES ${_fmt(h.revenue24h)}</span>
            ${HEALTH_BADGE[h.health] || ''}
          </div>
          <div class="health-bar" style="margin-top:6px;"><div style="width:${Math.min(h.errorRate*5,100)}%;background:${h.health==='healthy'?'var(--aos-accent)':h.health==='warning'?'var(--aos-warn)':'var(--aos-danger)'};"></div></div>
        </div>`).join('');
    } catch(e) { row.innerHTML = '<span style="color:var(--aos-muted);font-size:12px">Health unavailable</span>'; }
  }

  async function viewHubDetails(hubId) {
    const panel = document.getElementById("hubDetailPanel");
    const nameEl = document.getElementById("hubDetailName");
    const body   = document.getElementById("hubDetailBody");
    if (!panel || !body) return;
    panel.style.display = 'block';
    nameEl.textContent  = hubId;
    body.innerHTML = _spinner();
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    try {
      const [details, perFlags] = await Promise.all([
        _call("pcGetHubDetails", { hubId }),
        _call("pcGetPerHubFlags", { hubId }),
      ]);
      nameEl.textContent = `${details.icon || '📦'} ${details.name || hubId}`;
      const flags = perFlags.flags || {};
      body.innerHTML = `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
          <div>
            <h4 style="font-size:13px;margin-bottom:10px;color:var(--aos-muted)">HUB INFO</h4>
            <div class="user-detail-grid">
              <div><strong>Status</strong><span>${HUB_STATUS_BADGE[details.status] || details.status}</span></div>
              <div><strong>Cloud Functions</strong><span>${details.cfCount || '—'}</span></div>
              <div><strong>Lifetime Revenue</strong><span>KES ${_fmt(details.lifetimeRevenue)}</span></div>
              <div><strong>Lifetime Orders</strong><span>${_fmt(details.lifetimeOrders)}</span></div>
            </div>
            <div style="margin-top:16px;">
              <button class="aos-btn success" style="margin-right:8px;" onclick="SokoniAOS.activateHub('${_esc(hubId)}')">&#x25B6;&#xFE0F; Activate</button>
              <button class="aos-btn danger" onclick="SokoniAOS.deactivateHub('${_esc(hubId)}')">&#x23F8;&#xFE0F; Pause</button>
            </div>
          </div>
          <div>
            <h4 style="font-size:13px;margin-bottom:10px;color:var(--aos-muted)">PER-HUB FLAGS</h4>
            <div class="flag-list" id="hubFlagList-${_esc(hubId)}">
              ${Object.entries(flags).map(([k,v]) => `
                <div class="toggle-row">
                  <div><strong style="font-size:13px">${_esc(k)}</strong></div>
                  <label class="toggle-sw"><input type="checkbox" ${v?'checked':''} onchange="SokoniAOS.setHubFlag('${_esc(hubId)}','${_esc(k)}',this.checked)"><span></span></label>
                </div>`).join('')}
            </div>
          </div>
        </div>`;
    } catch(e) { body.innerHTML = _emptyMsg("Failed to load hub details: " + e.message); }
  }

  async function activateHub(hubId) {
    const reason = prompt("Activation reason (optional):");
    if (reason === null) return;
    try {
      await _call("pcActivateHub", { hubId, reason });
      _toast(`Hub '${hubId}' activated`, "success");
      _panelCache.hubs = false;
      _loadHubs();
    } catch(e) { _toast("Activate failed: " + e.message, "error"); }
  }

  async function deactivateHub(hubId) {
    const reason = prompt("Pause reason:");
    if (!reason) { _toast("Reason required to pause a live hub", "error"); return; }
    try {
      await _call("pcDeactivateHub", { hubId, reason });
      _toast(`Hub '${hubId}' paused`, "info");
      _panelCache.hubs = false;
      _loadHubs();
    } catch(e) { _toast("Deactivate failed: " + e.message, "error"); }
  }

  async function setHubFlag(hubId, flagKey, enabled) {
    try {
      await _call("pcSetPerHubFlag", { hubId, flagKey, enabled });
      _toast(`${flagKey} → ${enabled ? 'ON' : 'OFF'}`, "success");
    } catch(e) { _toast("Flag update failed: " + e.message, "error"); }
  }

  // ── Workflow Center ───────────────────────────────────────────────────────────
  async function _loadWorkflows() {
    const body   = document.getElementById("workflowsBody");
    const status = document.getElementById("wfStatusFilter")?.value || "";
    const defId  = document.getElementById("wfDefFilter")?.value.trim() || "";
    if (!body) return;
    body.innerHTML = _spinner();
    try {
      const r = await _call("wapGetInstances", { status: status || undefined, definitionId: defId || undefined, limit: 30 });
      const instances = r.instances || [];
      if (!instances.length) { body.innerHTML = _emptyMsg("No workflow instances found"); return; }
      body.innerHTML = `<div style="overflow-x:auto"><table class="aos-table">
        <thead><tr><th>Instance ID</th><th>Definition</th><th>Status</th><th>Steps</th><th>Failed</th><th>Created</th><th>Actions</th></tr></thead>
        <tbody>${instances.map(i => `<tr>
          <td><span class="aos-mono">${_esc(i.id.slice(0,10))}…</span></td>
          <td>${_esc(i.definitionId || '—')}</td>
          <td>${_wfStatusBadge(i.status)}</td>
          <td>${i.stepCount || 0}</td>
          <td><span style="color:${i.failedSteps>0?'var(--aos-danger)':'var(--aos-muted)'}">${i.failedSteps}</span></td>
          <td style="color:var(--aos-muted);font-size:11px;">${i.createdAt ? new Date(i.createdAt).toLocaleString('en-KE') : '—'}</td>
          <td>
            ${i.failedSteps > 0 ? `<button class="aos-btn-sm warning" onclick="SokoniAOS.retryWfStep('${_esc(i.id)}')">&#x21BA; Retry</button>` : ''}
          </td>
        </tr>`).join('')}</tbody>
      </table>${r.hasMore ? `<p style="color:var(--aos-muted);font-size:12px;margin-top:12px;">Showing first 30 — refine filters to narrow results.</p>` : ''}</div>`;
    } catch(e) { body.innerHTML = _emptyMsg("Failed to load workflows: " + e.message); }
  }

  function _wfStatusBadge(s) {
    const map = { running:'st-processing', completed:'st-completed', failed:'st-cancelled', pending:'st-pending', paused:'st-inactive', cancelled:'st-cancelled' };
    return `<span class="status-badge ${map[s]||'st-unknown'}">${_esc(s||'unknown')}</span>`;
  }

  async function retryWfStep(instanceId) {
    const stepId = prompt("Step ID to retry:");
    if (!stepId) return;
    try {
      await _call("wapRetryStep", { instanceId, stepId });
      _toast("Step queued for retry", "success");
      _panelCache.workflows = false;
      _loadWorkflows();
    } catch(e) { _toast("Retry failed: " + e.message, "error"); }
  }

  function _viewBanned() { window.open("trust-safety.html#banned","_blank"); }
  function _viewRiskScores() { window.open("trust-safety.html#risk","_blank"); }

  function _signOut() {
    _listeners.forEach(u => u());
    _auth.signOut().then(() => { window.location.href = "login.html"; });
  }

  // ── Public API ────────────────────────────────────────────────────────────────
  /* ══════════════════════════════════════════════════════════════════════════
     APPLICATIONS & APPROVALS

     The only route from "someone applied" to "a shop exists". Approving here
     calls the SAME server-authoritative `applicationDecide` the admin dashboard
     and super-admin portal call — which grants the role, mints the claim and
     runs projectSeller (the step that actually creates shops/{shopId},
     sellers/{uid} and users.activeShopId). Nothing about the decision is
     computed in this browser.

     `applicationList` / `applicationDecide` / `applicationReconcile` are
     standalone deployed callables, NOT adminOsDispatch ops, so they are
     deliberately absent from _ADMIN_OS_OPS and _call routes them directly.
     ═══════════════════════════════════════════════════════════════════════════ */

  /* Escape for a single-quoted JS string nested inside a double-quoted HTML
     attribute — JS layer first, then HTML. Firestore document ids are not a
     trusted alphabet, and an id is what these handlers carry. */
  function _jsAttr(s) {
    return _esc(String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/'/g, "\\'"));
  }

  let _appsCache = [];

  async function _loadApplications() {
    const body = document.getElementById("appsBody");
    if (!body) return;
    body.innerHTML = _spinner();

    const statusSel = (document.getElementById("appsStatus") || {}).value || "";
    const role = (document.getElementById("appsRole") || {}).value || "";
    const search = ((document.getElementById("appsSearch") || {}).value || "").trim().toLowerCase();

    /* "Approved, not published" is not a server status — it is approved WITHOUT
       a successful projection, which is the difference between "approved" and
       "actually selling". Ask for approved, then narrow here. */
    const unpublishedOnly = statusSel === "unpublished";
    const req = { limit: 300 };
    if (role) req.role = role;
    if (statusSel && !unpublishedOnly) req.status = statusSel;
    if (unpublishedOnly) req.status = "approved";

    let data;
    try {
      data = await _call("applicationList", req);
    } catch (e) {
      /* Say which call failed and why. A bare empty table here reads as "nobody
         has applied", which is the most misleading thing this screen can say. */
      body.innerHTML = `<div class="empty-state"><span>⚠️</span>
        <p><strong>Could not load applications.</strong></p>
        <p class="aos-muted">${_esc(e.message || String(e))}</p>
        <p class="aos-muted">This is not "no applications" — the list could not be read.</p></div>`;
      _setAppsSummary(null);
      return;
    }

    let items = data.items || [];
    if (unpublishedOnly) items = items.filter((a) => a.projectionStatus !== "applied");
    if (search) {
      items = items.filter((a) =>
        (a.name || "").toLowerCase().includes(search) ||
        (a.phone || a.phoneNumber || "").toLowerCase().includes(search) ||
        (a.email || "").toLowerCase().includes(search) ||
        (a.uid || "").toLowerCase().includes(search));
    }
    _appsCache = items;
    _setAppsSummary(data);
    _setAppsBadge((data.counts || {}).pending || 0);

    body.innerHTML = items.length
      ? `<div class="aos-cards">${items.map(_appCard).join("")}</div>`
      : _emptyMsg(statusSel === "pending"
          ? "No applications are waiting for a decision."
          : "No applications match this filter.");
  }

  function _setAppsSummary(data) {
    const el = document.getElementById("appsSummary");
    if (!el) return;
    if (!data) { el.textContent = "—"; return; }
    const c = data.counts || {};
    const bits = [];
    if (c.pending) bits.push(c.pending + " pending");
    if (c.approved) bits.push(c.approved + " approved");
    if (c.rejected) bits.push(c.rejected + " rejected");
    if (data.unpublished) bits.push("⚠ " + data.unpublished + " approved but not published");
    el.textContent = bits.length ? bits.join(" · ") : (data.total || 0) + " total";
  }

  function _setAppsBadge(n) {
    const b = document.getElementById("sidebarAppsBadge");
    if (!b) return;
    b.textContent = String(n || 0);
    b.hidden = !n;
  }

  /* What the applicant actually agreed to — shown BEFORE the reviewer decides, not
     discovered from a failure message afterwards.

     Healthcare is a different instrument from every other role: approval is gated on the
     canonical, versioned `legalAcceptances` record (Healthcare Provider Agreement +
     Medical Compliance Declaration), NOT on the Seller Agreement tick that the rest of the
     queue uses. `legalCompliance` is supplied by applicationList for health rows only, so
     a reviewer can see which instruments are signed, at which version, and what is still
     outstanding. Never claim more than the data supports: an absent block says so. */
  function _agreementLine(a) {
    if (a.role === "health") {
      const lc = a.legalCompliance;
      if (!lc) return '<span class="aos-muted">📄 Agreement: not loaded</span>';
      if (lc.error) return `<span class="aos-muted">📄 Agreement: could not be read (${_esc(lc.error)})</span>`;
      if (lc.compliant) {
        const sigs = (lc.accepted || [])
          .filter((x) => /healthcare|medical/.test(x.agreementId || ""))
          .map((x) => `${_esc(x.agreementId)} v${_esc(x.version)}`)
          .join(", ");
        return `📄 <strong>Healthcare agreements accepted</strong>${sigs ? " — " + sigs : ""} · ${lc.requiredCount} required`;
      }
      const miss = (lc.missing || []).map((m) => `${_esc(m.name || m.agreementId)} (${_esc(m.reason)})`).join(", ");
      return `<span style="color:var(--aos-warn,#e0a33e)">📄 <strong>Healthcare agreements OUTSTANDING</strong> — ${miss || "unknown"}</span>`;
    }
    if (!a.agreementAccepted) return '<span class="aos-muted">📄 Agreement: not accepted</span>';
    const v = a.agreementVerifiedVersion || a.agreementVersion;
    /* agreementVerifiedAt is the SERVER stamp taken at approval; agreementAcceptedAt is a
       browser clock on a client-written document. Prefer the former, and say which. */
    const when = a.agreementVerifiedAt ? "verified at approval"
               : (a.agreementAcceptedAt ? "self-reported at submission" : "no timestamp");
    return `📄 Agreement accepted${v ? " · v" + _esc(v) : ""} <span class="aos-muted">(${when})</span>`;
  }

  function _appCard(a) {
    const id = _jsAttr(a.id);
    const decided = a.status !== "pending";
    /* Approved with a projection that did not apply is the state that looks
       fine and is not: the merchant has a role and no shop. Say so on the card. */
    const unpublished = a.status === "approved" && a.projectionStatus !== "applied";
    const contact = [a.phone || a.phoneNumber, a.email].filter(Boolean).join(" · ") || "no contact on file";
    const place = [a.area, a.city, a.location].filter(Boolean).join(", ") || "no location on file";
    return `<div class="aos-card${unpublished ? " aos-card-warn" : ""}">
      <div class="aos-card-head">
        <strong>${_esc(a.name || "(no business name)")}</strong>
        <span class="status-badge st-${_esc(a.status)}">${_esc(a.status)}</span>
        <span class="status-badge st-inactive">${_esc(a.role || "unknown role")}</span>
      </div>
      <div class="aos-card-meta">
        <div>📞 ${_esc(contact)}</div>
        <div>📍 ${_esc(place)}</div>
        ${a.category ? `<div>🏷️ ${_esc(a.categoryLabel || a.category)}</div>` : ""}
        <div>${_agreementLine(a)}</div>
        <div class="aos-mono aos-muted">${_esc(a.uid || "—")}</div>
      </div>
      ${a.description ? `<p class="aos-muted">${_esc(String(a.description).slice(0, 240))}</p>` : ""}
      ${unpublished ? `<div class="aos-warn-row">⚠ Approved, but the projection did not apply${
        a.projectionError ? ": " + _esc(a.projectionError) : ""
      }. This merchant has no live shop — reconcile to repair it.</div>` : ""}
      <div class="aos-card-actions">
        ${decided ? "" : `<button class="aos-btn-sm success" onclick="SokoniAOS.decideApplication('${id}','approve')">Approve</button>`}
        ${decided ? "" : `<button class="aos-btn-sm" onclick="SokoniAOS.decideApplication('${id}','request_info')">Request info</button>`}
        ${decided ? "" : `<button class="aos-btn-sm danger" onclick="SokoniAOS.decideApplication('${id}','reject')">Reject</button>`}
        ${a.status === "approved" ? `<button class="aos-btn-sm danger" onclick="SokoniAOS.decideApplication('${id}','suspend')">Suspend</button>` : ""}
        <button class="aos-btn-sm" onclick="SokoniAOS.reconcileApplication('${id}')">Reconcile</button>
      </div>
    </div>`;
  }

  async function decideApplication(applicationId, decision) {
    const app = _appsCache.find((a) => a.id === applicationId) || {};
    let reason = null;
    if (decision !== "approve") {
      reason = prompt(
        decision === "request_info"
          ? "What do you need from the applicant? (they see this)"
          : "Reason for this decision (recorded in the audit trail):"
      );
      if (reason === null) return;                       /* cancelled — do nothing */
    } else if (!confirm(
      `Approve "${app.name || applicationId}"?\n\n` +
      "This grants the account its role and creates its shop. It is a real, " +
      "immediate change to a live account."
    )) return;

    let res;
    try {
      res = await _call("applicationDecide", { applicationId, decision, reason: reason || undefined });
    } catch (e) {
      const msg = e.message || String(e);
      /* The commonest refusal by far, and the one whose fix is not obvious. */
      if (/Seller Agreement|agreement/i.test(msg)) {
        _toast("Cannot approve: the applicant has not accepted the Seller Agreement. Use \"Request info\".", "error");
      } else {
        _toast("Decision failed: " + msg, "error");
      }
      return;
    }

    /* Report what the SERVER says it wrote, not what we hoped it would. An
       approval whose projection failed must not be celebrated. */
    const r = res && res.receipt;
    const writes = (r && r.writes) || [];
    const shopWrite = writes.find((w) => w && w.shopId);
    if (decision === "approve") {
      if (shopWrite) _toast(`Approved — shop ${shopWrite.shopId} ${shopWrite.action || "written"}`, "success");
      else _toast("Approved, but no shop was reported as written. Reconcile and check.", "warn");
    } else {
      _toast(`Marked ${_esc(res.status || decision)}`, "success");
    }
    _loadApplications();
  }

  async function reconcileApplication(applicationId) {
    try {
      const res = await _call("applicationReconcile", { applicationId });
      _modal("Reconcile receipt", `<p class="aos-muted">What the server actually wrote for
        <span class="aos-mono">${_esc(applicationId)}</span>:</p>${_kvHtml(res)}`);
    } catch (e) {
      _toast("Reconcile failed: " + (e.message || String(e)), "error");
      return;
    }
    _loadApplications();
  }

  /* ══════════════════════════════════════════════════════════════════════════
     SHOPS & SELLERS — the registries approval projects onto
     ═══════════════════════════════════════════════════════════════════════════ */

  let _estateTabName = "shops";

  async function _loadEstate() { _estateTab("shops"); }

  async function _estateTab(tab) {
    if (tab) _estateTabName = tab;
    const t = _estateTabName;
    document.querySelectorAll("#panel-estate .tab-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === t);
    });
    const body = document.getElementById("estateBody");
    const sum = document.getElementById("estateSummary");
    if (!body) return;
    body.innerHTML = _spinner();
    const search = ((document.getElementById("estateSearch") || {}).value || "").trim();

    const args = search ? { search, limit: 500 } : { limit: 500 };
    let data;
    try {
      /* Each branch names its op as a LITERAL, deliberately. A conditional op
         string is invisible to scripts/test-admin-os-wiring.js, which reads call
         sites statically — so an op with no backend would ship undetected and
         render as an empty registry. This exact site escaped the detector once. */
      data = t === "shops"
        ? await _call("adminGetShops", args)
        : await _call("adminGetSellers", args);
    } catch (e) {
      body.innerHTML = `<div class="empty-state"><span>⚠️</span>
        <p><strong>Could not load ${_esc(t)}.</strong></p>
        <p class="aos-muted">${_esc(e.message || String(e))}</p>
        <p class="aos-muted">This is not an empty registry — the read failed.</p></div>`;
      if (sum) sum.textContent = "—";
      return;
    }

    const items = data.items || [];
    if (t === "shops") {
      if (sum) sum.textContent = `${data.count || 0} shops · ${data.active || 0} active · ${
        data.fromApproval || 0} from approval${data.ownerless ? ` · ⚠ ${data.ownerless} ownerless` : ""}`;
      body.innerHTML = items.length ? `<table class="aos-table"><thead><tr>
          <th>Shop</th><th>Owner</th><th>Status</th><th>Origin</th><th>Created</th><th></th>
        </tr></thead><tbody>${items.map((s) => `<tr${s.ownerless ? ' class="row-warn"' : ""}>
          <td><strong>${_esc(s.name || "(unnamed)")}</strong><br><span class="aos-mono aos-muted">${_esc(s.shopId)}</span></td>
          <td class="aos-mono aos-muted">${s.ownerless ? "⚠ no owner" : _esc(s.ownerId)}</td>
          <td><span class="status-badge st-${_esc(s.status || "unknown")}">${_esc(s.status || "unknown")}</span></td>
          <td class="aos-muted">${_esc(s.source === "application_approval" ? "approval" : (s.source || "—"))}</td>
          <td class="aos-muted">${_date(s.createdAt)}</td>
          <td><button class="aos-btn-sm" onclick="SokoniAOS.openShop('${_jsAttr(s.shopId)}')">Open</button></td>
        </tr>`).join("")}</tbody></table>` : _emptyMsg("No shops match this filter.");
    } else {
      if (sum) sum.textContent = `${data.count || 0} sellers · ${data.active || 0} active${
        data.shopMissing ? ` · ⚠ ${data.shopMissing} with no shop` : ""}`;
      body.innerHTML = items.length ? `<table class="aos-table"><thead><tr>
          <th>Seller</th><th>Account</th><th>Shop</th><th>Status</th><th>Updated</th><th></th>
        </tr></thead><tbody>${items.map((s) => `<tr${s.shopMissing ? ' class="row-warn"' : ""}>
          <td><strong>${_esc(s.name || "(unnamed)")}</strong></td>
          <td class="aos-mono aos-muted">${_esc(s.uid)}</td>
          <td>${s.shopMissing
              ? '<span class="status-badge st-rejected">no shop</span>'
              : `<span class="aos-mono">${_esc(s.shopId)}</span>${
                  s.declaredShopMissing ? ' <span class="status-badge st-pending">declared id missing</span>' : ""}`}</td>
          <td><span class="status-badge st-${_esc(s.status || "unknown")}">${_esc(s.status || "unknown")}</span></td>
          <td class="aos-muted">${_date(s.updatedAt)}</td>
          <td>${s.shopMissing ? "" : `<button class="aos-btn-sm" onclick="SokoniAOS.openShop('${_jsAttr(s.shopId)}')">Open</button>`}</td>
        </tr>`).join("")}</tbody></table>` : _emptyMsg("No sellers match this filter.");
    }
  }

  /* Everything about one shop: who owns it, who works in it, what is in it. */
  async function openShop(shopId) {
    _modal("Shop " + shopId, _spinner());
    let d;
    try {
      d = await _call("adminGetShopDetail", { shopId });
    } catch (e) {
      document.getElementById("modalBody").innerHTML =
        `<div class="empty-state"><span>⚠️</span><p>${_esc(e.message || String(e))}</p></div>`;
      return;
    }

    const s = d.shop || {}, o = d.owner, c = d.counts || {};
    /* Three product counts, reported separately. `products` ownership is
       enforced on sellerUid in the rules, but sellerId and shopId are both
       queried elsewhere in this codebase — a single number here would be a
       guess about which field this shop's writers used. A disagreement between
       the three IS the finding. */
    const counts = [
      ["Products (sellerUid)", c.productsBySellerUid],
      ["Products (sellerId)", c.productsBySellerId],
      ["Products (shopId)", c.productsByShopId],
      ["Orders (sellerId)", c.ordersBySellerId],
    ].map(([k, v]) => `<div class="kv-row"><span>${_esc(k)}</span><strong>${
      v === null || v === undefined ? "—" : _fmt(v)}</strong></div>`).join("");

    const empRows = (d.employees || []).length
      ? `<table class="aos-table"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Active</th></tr></thead>
         <tbody>${d.employees.map((e) => `<tr>
           <td>${_esc(e.name || "—")}</td><td class="aos-muted">${_esc(e.email || "—")}</td>
           <td><span class="status-badge st-active">${_esc(e.role)}</span></td>
           <td>${e.active ? "yes" : "no"}</td></tr>`).join("")}</tbody></table>`
      : '<div class="aos-muted">No staff have been added to this shop.</div>';

    /* Disputed rows are SHOWN, not filtered away. firestore.rules lets any
       signed-in client create a shopEmployees document, so a row that fails
       corroboration is a forgery attempt an operator needs to see. */
    const dispRows = (d.disputed || []).length
      ? `<h3 class="aos-warn-row">⚠ ${d.disputed.length} record(s) claim access to this shop but fail corroboration</h3>
         <table class="aos-table"><thead><tr><th>Doc</th><th>Claimed uid</th><th>Claimed role</th><th>Why rejected</th></tr></thead>
         <tbody>${d.disputed.map((e) => `<tr class="row-warn">
           <td class="aos-mono">${_esc(e.id)}</td><td class="aos-mono">${_esc(e.uid || "—")}</td>
           <td>${_esc(e.role || "—")}</td><td class="aos-muted">${_esc((e.reasons || []).join("; "))}</td>
         </tr>`).join("")}</tbody></table>`
      : "";

    document.getElementById("modalBody").innerHTML = `
      <div class="kv">
        <div class="kv-row"><span>Shop id</span><strong class="aos-mono">${_esc(s.shopId)}</strong></div>
        <div class="kv-row"><span>Name</span><strong>${_esc(s.name || "(unnamed)")}</strong></div>
        <div class="kv-row"><span>Status</span><strong>${_esc(s.status || "unknown")}</strong></div>
        <div class="kv-row"><span>Origin</span><strong>${_esc(s.source || "—")}</strong></div>
        <div class="kv-row"><span>Created</span><strong>${_date(s.createdAt)}</strong></div>
        ${counts}
      </div>
      <h3>Owner</h3>
      ${o ? `<div class="kv">
        <div class="kv-row"><span>Account</span><strong class="aos-mono">${_esc(o.uid)}</strong></div>
        <div class="kv-row"><span>Name</span><strong>${_esc(o.name || "—")}</strong></div>
        <div class="kv-row"><span>Email</span><strong>${_esc(o.email || "—")}</strong></div>
        <div class="kv-row"><span>Roles</span><strong>${_esc((o.roles || []).join(", ") || "—")}</strong></div>
        <div class="kv-row"><span>Active shop</span><strong>${
          o.activeShopMatches
            ? "matches this shop"
            : `⚠ ${_esc(o.activeShopId || "not set")} — the merchant workspace will not resolve to this shop`
        }</strong></div>
        <div class="kv-row"><span>Seller registry</span><strong>${o.sellerRegistered ? "present" : "⚠ missing"}</strong></div>
      </div>` : '<div class="aos-warn-row">⚠ This shop has no owner recorded. It cannot be suspended through its seller, and no merchant can sign in to it.</div>'}
      <h3>Employees (${c.employees || 0})</h3>
      ${empRows}
      ${dispRows}`;
  }

  return {
    init,
    navigate:            _navigate,
    reloadDashboard:     _loadDashboard,
    loadBookings:        _loadBookings,
    loadPayments:        _loadPayments,
    // Users
    loadUsers:           _loadUsers,
    viewUser,
    banUser,
    changeRole,
    // Applications & approvals
    loadApplications:    _loadApplications,
    decideApplication,
    reconcileApplication,
    // Shops & sellers
    estateTab:           _estateTab,
    openShop,
    // Marketplace
    marketplaceTab:      _marketplaceTab,
    updateProduct,
    updateOrder,
    moderateReview,
    editCategory,
    addCategory,
    editFaq:             (id) => { const q = prompt("Question:"); const a = prompt("Answer:"); if(q&&a) _call("adminUpsertFaq",{id,question:q,answer:a}).then(()=>{ _toast("FAQ updated","success"); _panelCache.content=false; _contentTab("faqs"); }); },
    deleteFaq,
    // Financial
    financialTab:        _financialTab,
    markCommPaid,
    approveAllPayouts,
    approvePayout,
    rejectPayout,
    resolveDispute,
    processRefund,
    // Support
    loadSupport:         _loadSupport,
    viewTicket,
    replyTicket,
    resolveTicket,
    // Communications
    sendPushNotification,
    // Content
    contentTab:          _contentTab,
    addBanner,
    editBanner,
    deleteBanner,
    addFaq,
    addAnnouncement,
    deleteAnnouncement,
    // AI
    toggleAIModule,
    // Search
    reindex,
    repairSearch,
    searchReport,
    // Fraud
    viewReports,
    viewBanned:          _viewBanned,
    viewRiskScores:      _viewRiskScores,
    reviewReport,
    investigateAlert,
    voidReceiptDialog,
    // Analytics
    exportAnalytics,
    analyticsTab:        _analyticsTab,
    // Config
    saveSettings,
    saveCommissionRules,
    savePayoutSchedule,
    updateFlag,
    // Audit
    loadAudit:           _loadAudit,
    filterAuditRows,
    // Security
    revokeSession,
    revokeAllSessions,
    loadSecurityEvents:  _loadSecurityEvents,
    loadInvoices:        _loadInvoices,
    approveRequest,
    rejectRequest,
    // SmartPOS
    posTab:              _posTab,
    // Financial
    releaseEscrow,
    exportFinancialReport,
    // Communications
    commsTab:            _commsTab,
    sendTestEmail:       sendTestEmail,
    sendEmailBlast,
    sendSMSBlast,
    // Content
    createCampaign,
    activateCampaign,
    deleteCampaign,
    // Hubs
    loadIntegrations:    _loadIntegrations,
    loadReports:         _loadReports,
    loadRevenue:         _loadRevenue,
    refreshHubs:         () => { _panelCache.hubs = false; _loadHubs(); },
    loadHubHealth:       _loadHubHealth,
    viewHubDetails,
    activateHub,
    deactivateHub,
    setHubFlag,
    // Workflows
    loadWorkflows:       _loadWorkflows,
    retryWfStep,
    // Utility
    closeModal:          _closeModal,
    signOut:             _signOut,
  };
})();

document.addEventListener("DOMContentLoaded", () => SokoniAOS.init());
