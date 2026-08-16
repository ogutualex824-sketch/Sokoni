/* ════════════════════════════════════════════════════════════════════════════
   SOKONI Merchant Customers — the native surface (2D-2 step 6)

       merchant.html → this surface → crmCustomerProfiles (rules-gated READ)
                                    → getCustomerProfile / getCRMDashboard

   ── What it will not do ─────────────────────────────────────────────────────
   No `posLookupCustomer` (an unscoped platform-wide customer search), no
   `posGetCustomerInsights` (client-supplied merchantId, unverified), no
   `getCustomerGrowthMetrics` (gated on a claim nothing mints). They are not
   bound — not fetched and hidden.

   Search runs over the rows the RULES already restricted to this merchant. That
   is not a compromise: it is the only honest option while the one server search
   is unscoped, and it cannot reach another merchant's customers by construction.

   ── The refusal this screen has to state well ───────────────────────────────
   `getCustomerProfile` and `getCRMDashboard` assert ownership by reading
   `merchants/{merchantId}` — a POS-only document. A merchant who came through
   the marketplace application path has none, so both refuse with `not-found`.

   That is not the merchant's fault and not a bug in their account, so the screen
   says what is actually true: the list works, the deeper profile needs a POS
   merchant record. It does NOT invent one, and it does not degrade the list to
   match. Marketplace onboarding already creates `shops/{shopId}` and a
   subscription; resurrecting the POS `merchants/{merchantId}` identity to
   satisfy a legacy CRM callable would undo the identity work this track has been
   protecting.
   ════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SokoniMerchantCustomersUI = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CSS_ID = 'sokoni-merchant-customers-css';

  var CSS = [
    '#native-customers{padding:0!important;overflow:hidden!important;display:flex;flex-direction:column}',
    '.mcu{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;position:relative;',
      'font-variant-numeric:tabular-nums}',

    '.mcu-top{flex:0 0 auto;padding:12px 14px;border-bottom:1px solid var(--line);background:var(--panel)}',
    '.mcu-find{display:flex;align-items:center;gap:8px;background:rgba(255,255,255,.06);',
      'border:1px solid var(--line);border-radius:13px;padding:0 12px;height:48px}',
    '.mcu-find input{flex:1;min-width:0;height:100%;background:none;border:none;outline:none;color:var(--txt);',
      'font-size:16px;font-weight:600;font-family:inherit}',
    '.mcu-find input::placeholder{color:var(--txt3);font-weight:500}',
    '.mcu-count{font-size:11px;color:var(--txt3);margin-top:9px;font-weight:700}',

    '.mcu-body{flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:10px 14px 18px}',

    '.mcu-row{display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--line);',
      'width:100%;text-align:left;background:none;border-left:none;border-right:none;border-top:none;',
      'color:var(--txt);font-family:inherit;cursor:pointer;min-height:68px}',
    '.mcu-row:last-child{border-bottom:none}',
    '.mcu-av{flex:0 0 auto;width:42px;height:42px;border-radius:14px;display:flex;align-items:center;',
      'justify-content:center;font-weight:900;font-size:14px;background:rgba(255,255,255,.06);',
      'border:1px solid var(--line);color:var(--txt2)}',
    '.mcu-av.gold{background:rgba(251,191,36,.14);border-color:rgba(251,191,36,.32);color:#fbbf24}',
    '.mcu-av.good{background:rgba(113,255,0,.12);border-color:rgba(113,255,0,.3);color:var(--acc)}',
    '.mcu-av.new{background:rgba(100,180,255,.14);border-color:rgba(100,180,255,.3);color:#64b4ff}',
    '.mcu-info{flex:1;min-width:0}',
    '.mcu-nm{font-size:14px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.mcu-sub{font-size:11.5px;color:var(--txt3);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.mcu-val{flex:0 0 auto;text-align:right}',
    '.mcu-val .v{font-size:14px;font-weight:900;color:var(--acc)}',
    '.mcu-val .k{font-size:10px;color:var(--txt3);text-transform:uppercase;letter-spacing:.04em;margin-top:2px}',

    '.mcu-chip{display:inline-block;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;',
      'padding:4px 8px;border-radius:7px;border:1px solid var(--line);background:rgba(255,255,255,.05);color:var(--txt2)}',
    '.mcu-chip.gold{color:#fbbf24;border-color:rgba(251,191,36,.32);background:rgba(251,191,36,.10)}',
    '.mcu-chip.good{color:var(--acc);border-color:rgba(113,255,0,.3);background:rgba(113,255,0,.10)}',
    '.mcu-chip.new{color:#64b4ff;border-color:rgba(100,180,255,.3);background:rgba(100,180,255,.10)}',
    '.mcu-chip.bad{color:#ff9a9a;border-color:rgba(255,90,90,.32);background:rgba(255,90,90,.10)}',
    '.mcu-chip.warn{color:#ffc45e;border-color:rgba(255,176,32,.32);background:rgba(255,176,32,.10)}',

    '.mcu-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(104px,100%),1fr));gap:9px;margin-bottom:12px}',
    '.mcu-kpi{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:11px 12px}',
    '.mcu-kpi .v{font-size:19px;font-weight:900;color:var(--acc);line-height:1.1}',
    '.mcu-kpi .k{font-size:10px;color:var(--txt3);text-transform:uppercase;letter-spacing:.04em;margin-top:3px}',

    '.mcu-state{padding:40px 24px;text-align:center;color:var(--txt2);font-size:13.5px;line-height:1.6}',
    '.mcu-state .ic{font-size:36px;margin-bottom:12px}',
    '.mcu-state .hd{font-weight:800;font-size:15px;color:var(--txt);margin-bottom:8px}',
    '.mcu-btn{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:0 20px;',
      'border-radius:13px;font-weight:800;font-size:14px;cursor:pointer;font-family:inherit;',
      'border:1px solid rgba(113,255,0,.32);background:rgba(113,255,0,.13);color:var(--acc)}',
    '.mcu-btn.ghost{background:rgba(255,255,255,.05);border-color:var(--line);color:var(--txt2)}',
    '.mcu-btn.wide{width:100%}',
    '.mcu-banner{padding:11px 13px;border-radius:12px;background:rgba(255,255,255,.04);border:1px solid var(--line);',
      'font-size:11.5px;color:var(--txt2);line-height:1.55;margin-bottom:12px}',
    '.mcu-banner b{color:var(--txt)}',
    '.mcu-notice{padding:12px 14px;border-radius:13px;background:rgba(100,180,255,.08);',
      'border:1px solid rgba(100,180,255,.28);color:#9ccdff;font-size:12px;line-height:1.55;margin-bottom:12px}',
    '.mcu-notice b{color:#cfe6ff}',

    '.mcu-scrim{position:absolute;inset:0;background:rgba(0,0,0,.62);z-index:60;animation:mcuFade .16s ease both}',
    '@keyframes mcuFade{from{opacity:0}to{opacity:1}}',
    '.mcu-sheet{position:absolute;left:0;right:0;bottom:0;z-index:61;background:var(--panel);',
      'border-top:1px solid var(--line);border-radius:20px 20px 0 0;max-height:92%;display:flex;',
      'flex-direction:column;animation:mcuUp .2s cubic-bezier(.2,.7,.3,1) both;',
      'padding-bottom:env(safe-area-inset-bottom,0px)}',
    '@keyframes mcuUp{from{transform:translateY(14px);opacity:.4}to{transform:none;opacity:1}}',
    '@media (prefers-reduced-motion:reduce){.mcu-sheet,.mcu-scrim{animation:none}}',
    '.mcu-sh-h{flex:0 0 auto;display:flex;align-items:center;gap:12px;padding:15px 16px 11px;border-bottom:1px solid var(--line)}',
    '.mcu-sh-h .t{flex:1;min-width:0;font-size:15px;font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.mcu-sh-x{width:44px;height:44px;flex:0 0 auto;border-radius:12px;border:1px solid var(--line);',
      'background:rgba(255,255,255,.05);color:var(--txt2);font-size:17px;cursor:pointer;font-family:inherit}',
    '.mcu-sh-b{flex:1;min-height:0;overflow-y:auto;padding:14px 16px}',
    '.mcu-sh-f{flex:0 0 auto;padding:12px 16px 16px;border-top:1px solid var(--line)}',

    '.mcu-p-hd{display:flex;align-items:center;gap:13px;margin-bottom:14px}',
    '.mcu-p-hd .mcu-av{width:52px;height:52px;border-radius:16px;font-size:16px}',
    '.mcu-p-hd .n{font-size:16px;font-weight:800;overflow-wrap:anywhere}',
    '.mcu-p-hd .c{font-size:12px;color:var(--txt3);margin-top:3px;overflow-wrap:anywhere}',
    '.mcu-fact{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid var(--line);font-size:13px}',
    '.mcu-fact:last-child{border-bottom:none}',
    '.mcu-fact span:first-child{color:var(--txt2)}',
    '.mcu-fact span:last-child{font-weight:800;flex:0 0 auto;overflow-wrap:anywhere;text-align:right}',
    '.mcu-lbl{font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--txt3);margin:16px 0 8px}',
    '.mcu-prog{display:flex;align-items:center;gap:11px;padding:13px 14px;border-radius:13px;',
      'background:rgba(255,255,255,.05);border:1px solid var(--line);font-size:13px;font-weight:700;color:var(--txt2)}',
    '.mcu-spin{width:17px;height:17px;flex:0 0 auto;border-radius:50%;border:2px solid rgba(255,255,255,.18);',
      'border-top-color:var(--acc);animation:mcuSpin .7s linear infinite}',
    '@keyframes mcuSpin{to{transform:rotate(360deg)}}',
    '@media (min-width:821px){.mcu-sheet{left:50%;transform:translateX(-50%);width:min(560px,100%)}}',
  ].join('');

  function injectCSS(doc) {
    if (!doc || doc.getElementById(CSS_ID)) return;
    var s = doc.createElement('style');
    s.id = CSS_ID; s.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(s);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function mount(host, ctx) {
    if (!host) return null;
    var doc = host.ownerDocument || document;
    injectCSS(doc);
    ctx = ctx || {};

    var MC = (typeof globalThis !== 'undefined' && globalThis.SokoniMerchantCustomers) || null;
    if (!MC) {
      host.innerHTML = '<div class="mcu"><div class="mcu-state"><div class="ic">⚠️</div>' +
        '<div class="hd">Customers are unavailable</div>The customers module did not load. ' +
        'Reopen SOKONI Merchant.</div></div>';
      return null;
    }

    var S = {
      phase: 'loading',        /* loading | not_signed_in | error | ready */
      error: null,
      customers: [],
      query: '',
      dashboard: null,
      dashReason: null,        /* 'no_pos_merchant_record' | 'refused' | null */
      sheet: null,
      current: null,
      profile: null,
      profilePhase: 'idle',    /* idle | loading | error | unavailable */
      profileError: null,
    };

    function load() {
      if (!ctx.scope || !ctx.scope.sellerUid) { S.phase = 'not_signed_in'; paint(); return Promise.resolve(); }
      S.phase = 'loading'; paint();
      return MC.listCustomers({ scope: ctx.scope, db: ctx.db }).then(function (r) {
        if (!r.ok) { S.phase = 'error'; S.error = r.error; paint(); return; }
        S.customers = r.customers || [];
        S.phase = 'ready'; paint();
        return loadDashboard();
      }).catch(function (e) {
        S.phase = 'error'; S.error = (e && e.message) || 'Your customers could not be loaded.'; paint();
      });
    }

    /* The dashboard is a bonus, not the screen. If it refuses — which it does for
       any merchant without a POS record — the list still works and the reason is
       stated once, at the top. */
    function loadDashboard() {
      if (typeof ctx.callDashboard !== 'function') return Promise.resolve();
      return MC.getDashboard({ scope: ctx.scope, callDashboard: ctx.callDashboard }).then(function (r) {
        if (r.ok) { S.dashboard = r.dashboard; S.dashReason = null; }
        else { S.dashboard = null; S.dashReason = r.reason; }
        if (S.phase === 'ready') paint();
      }).catch(function () {});
    }

    function visible() { return MC.searchCustomers(S.customers, S.query); }

    /* ── Render ───────────────────────────────────────────────────────────── */
    function paint() {
      host.innerHTML = '<div class="mcu">' + topHTML() + bodyHTML() + '</div>' + sheetHTML();
    }

    function topHTML() {
      var n = visible().length;
      return '<div class="mcu-top"><label class="mcu-find"><span aria-hidden="true">🔎</span>' +
        '<input id="mcu-q" type="search" inputmode="search" autocomplete="off" ' +
        'placeholder="Search by name, phone or email" value="' + esc(S.query) + '" aria-label="Search customers"></label>' +
        (S.phase === 'ready'
          ? '<div class="mcu-count">' + (S.query
              ? n + ' of ' + S.customers.length + ' customers'
              : S.customers.length + ' customer' + (S.customers.length === 1 ? '' : 's')) + '</div>'
          : '') +
      '</div>';
    }

    function bodyHTML() {
      if (S.phase === 'loading') {
        return '<div class="mcu-body"><div class="sk-line" style="width:70%"></div>' +
          '<div class="sk-line" style="width:52%"></div><div class="sk-line" style="width:62%"></div></div>';
      }
      if (S.phase === 'not_signed_in') {
        return '<div class="mcu-body"><div class="mcu-state"><div class="ic">🔒</div>' +
          '<div class="hd">Sign in to see your customers</div>Customer profiles belong to your account.</div></div>';
      }
      if (S.phase === 'error') {
        return '<div class="mcu-body"><div class="mcu-state"><div class="ic">⚠️</div>' +
          '<div class="hd">Your customers could not be loaded</div>' + esc(S.error || '') +
          '<div style="margin-top:18px"><button class="mcu-btn" data-act="reload">Try again</button></div></div></div>';
      }

      var sc = MC.scopeNote();
      var head = '<div class="mcu-banner"><b>' + esc(sc.label) + '.</b> ' + esc(sc.note) + '</div>' +
        dashboardHTML();

      var rows = visible();
      if (!rows.length) {
        return '<div class="mcu-body">' + head + '<div class="mcu-state"><div class="ic">' +
          (S.query ? '🔍' : '🧑‍🤝‍🧑') + '</div>' +
          '<div class="hd">' + (S.query ? 'Nobody matches “' + esc(S.query) + '”' : 'No customer profiles yet') + '</div>' +
          (S.query ? 'Try part of a name, a phone number or an email address.'
                   : 'A profile is built the first time someone orders from you, and appears here ' +
                     'with what they have bought.') +
          '</div></div>';
      }

      return '<div class="mcu-body">' + head + rows.map(function (c, i) {
        var seg = MC.segmentInfo(c.segment);
        return '<button class="mcu-row" data-act="open" data-i="' + i + '">' +
          '<div class="mcu-av ' + esc(seg.tone) + '">' + esc(MC.initials(c.name, c.email)) + '</div>' +
          '<div class="mcu-info">' +
            '<div class="mcu-nm">' + esc(c.name || c.email || c.phone || 'Customer') + '</div>' +
            '<div class="mcu-sub">' + esc(c.phone || c.email || '') +
              (c.orderCount != null ? ' · ' + MC.formatCount(c.orderCount) + ' order' + (c.orderCount === 1 ? '' : 's') : '') +
            '</div>' +
          '</div>' +
          '<div class="mcu-val"><div class="v">' + esc(MC.formatKES(c.totalSpend)) + '</div>' +
            '<div class="k">spent</div></div>' +
        '</button>';
      }).join('') + '</div>';
    }

    /* Only figures getCRMDashboard actually returned. Nothing is derived from the
       list, because a total computed over a 500-row page is not a total. */
    function dashboardHTML() {
      if (S.dashReason === 'no_pos_merchant_record') {
        return '<div class="mcu-notice"><b>Customer totals need a POS merchant record.</b> ' +
          'Your shop and subscription are set up, but the customer analytics engine still keys on the ' +
          'older SmartPOS merchant record, which this account does not have. The list below is ' +
          'complete and correct — only the summary figures and the deeper profile are affected.</div>';
      }
      if (!S.dashboard) return '';
      var d = S.dashboard;
      var tiles = [];
      if (typeof d.totalCustomers === 'number') tiles.push(['totalCustomers', d.totalCustomers, 'Customers']);
      if (typeof d.highChurnRisk === 'number') tiles.push(['churn', d.highChurnRisk, 'At risk']);
      if (typeof d.openTickets === 'number') tiles.push(['tickets', d.openTickets, 'Open tickets']);
      if (typeof d.newLeads30d === 'number') tiles.push(['leads', d.newLeads30d, 'New leads 30d']);
      if (!tiles.length) return '';
      return '<div class="mcu-kpis">' + tiles.map(function (t) {
        return '<div class="mcu-kpi"><div class="v">' + esc(MC.formatCount(t[1])) + '</div>' +
          '<div class="k">' + esc(t[2]) + '</div></div>';
      }).join('') + '</div>';
    }

    /* ── Profile sheet ────────────────────────────────────────────────────── */
    function sheetHTML() {
      if (!S.sheet || !S.current) return '';
      return '<div class="mcu-scrim" data-act="close"></div>' +
        '<div class="mcu-sheet" role="dialog" aria-modal="true">' + profileSheet() + '</div>';
    }

    function fact(k, v) { return '<div class="mcu-fact"><span>' + k + '</span><span>' + v + '</span></div>'; }

    function profileSheet() {
      /* The row itself is a real, rules-scoped record — so it is shown
         immediately, and the callable's richer profile replaces it if it
         arrives. A refusal degrades the depth, never the truth of the row. */
      var c = S.profile || S.current;
      var seg = MC.segmentInfo(c.segment);
      var churn = MC.churnInfo(c.churnRiskLevel);

      return '<div class="mcu-sh-h"><div class="t">' + esc(c.name || 'Customer') + '</div>' +
          '<button class="mcu-sh-x" data-act="close" aria-label="Close">×</button></div>' +
        '<div class="mcu-sh-b">' +
          '<div class="mcu-p-hd"><div class="mcu-av ' + esc(seg.tone) + '">' +
            esc(MC.initials(c.name, c.email)) + '</div>' +
            '<div style="min-width:0"><div class="n">' + esc(c.name || 'Customer') + '</div>' +
            '<div class="c">' + esc(c.phone || '') + (c.phone && c.email ? ' · ' : '') + esc(c.email || '') + '</div></div>' +
          '</div>' +
          '<div style="display:flex;gap:7px;flex-wrap:wrap;margin-bottom:6px">' +
            '<span class="mcu-chip ' + esc(seg.tone) + '">' + esc(seg.label) + '</span>' +
            (churn ? '<span class="mcu-chip ' + esc(churn.tone) + '">' + esc(churn.label) + '</span>' : '') +
            (c.loyaltyTier ? '<span class="mcu-chip">' + esc(c.loyaltyTier) + '</span>' : '') +
          '</div>' +

          '<div class="mcu-lbl">What they have bought</div>' +
          fact('Total spent', esc(MC.formatKES(c.totalSpend))) +
          fact('Orders', esc(MC.formatCount(c.orderCount))) +
          fact('Average order', esc(MC.formatKES(c.avgOrderValue))) +
          fact('Lifetime value', esc(MC.formatKES(c.clv))) +
          fact('First order', esc(MC.dateLabel(c.firstOrderAt))) +
          fact('Last order', esc(MC.dateLabel(c.lastOrderAt))) +
          (c.loyaltyPoints != null ? fact('Loyalty points', esc(MC.formatCount(c.loyaltyPoints))) : '') +

          (c.preferredCategories && c.preferredCategories.length
            ? '<div class="mcu-lbl">They usually buy</div>' +
              '<div style="display:flex;gap:7px;flex-wrap:wrap">' + c.preferredCategories.slice(0, 6).map(function (p) {
                return '<span class="mcu-chip">' + esc(p) + '</span>'; }).join('') + '</div>'
            : '') +

          (S.profilePhase === 'loading'
            ? '<div class="mcu-prog" style="margin-top:14px"><span class="mcu-spin"></span>Refreshing from the server…</div>' : '') +

          (S.profilePhase === 'unavailable'
            ? '<div class="mcu-notice" style="margin-top:14px"><b>This is the stored profile.</b> ' +
              'A live recalculation needs the older SmartPOS merchant record, which this account does ' +
              'not have — your shop and subscription are set up on the newer model. Everything shown ' +
              'above comes from the profile SOKONI already built for you.</div>' : '') +

          (S.profilePhase === 'error'
            ? '<div class="mcu-notice" style="margin-top:14px">The live profile could not be refreshed: ' +
              esc(S.profileError || '') + ' The stored figures above are unchanged.</div>' : '') +
        '</div>' +
        '<div class="mcu-sh-f"><button class="mcu-btn ghost wide" data-act="close">Close</button></div>';
    }

    function openCustomer(i) {
      var rows = visible();
      var c = rows[i]; if (!c) return;
      S.current = c; S.profile = null; S.sheet = 'profile';
      S.profilePhase = (typeof ctx.callProfile === 'function' && c.uid) ? 'loading' : 'idle';
      S.profileError = null;
      paint();
      if (S.profilePhase !== 'loading') return;
      MC.getProfile({ scope: ctx.scope, uid: c.uid, callProfile: ctx.callProfile }).then(function (r) {
        if (!S.current || S.current.uid !== c.uid) return;
        if (r.ok) { S.profile = r.profile; S.profilePhase = 'idle'; }
        else if (r.reason === 'no_pos_merchant_record') { S.profilePhase = 'unavailable'; }
        else { S.profilePhase = 'error'; S.profileError = r.error; }
        paint();
      }).catch(function (e) {
        if (!S.current || S.current.uid !== c.uid) return;
        S.profilePhase = 'error'; S.profileError = (e && e.message) || ''; paint();
      });
    }

    function onClick(ev) {
      var el = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
      if (!el || !host.contains(el)) return;
      var act = el.getAttribute('data-act');
      if (act === 'open')   { openCustomer(parseInt(el.getAttribute('data-i'), 10)); return; }
      if (act === 'close')  { S.sheet = null; S.current = null; S.profile = null; paint(); return; }
      if (act === 'reload') { load(); return; }
    }

    function onInput(ev) {
      var el = ev.target;
      if (!el || el.id !== 'mcu-q') return;
      S.query = el.value || '';
      /* Repaint the list and the count only, so the field keeps focus. */
      var body = host.querySelector('.mcu-body');
      if (body) body.outerHTML = bodyHTML();
      var count = host.querySelector('.mcu-count');
      if (count) {
        var n = visible().length;
        count.textContent = S.query ? (n + ' of ' + S.customers.length + ' customers')
          : (S.customers.length + ' customer' + (S.customers.length === 1 ? '' : 's'));
      }
    }

    host.addEventListener('click', onClick);
    host.addEventListener('input', onInput);

    load();

    return {
      refresh: load,
      state: function () { return S; },
      destroy: function () {
        host.removeEventListener('click', onClick);
        host.removeEventListener('input', onInput);
      },
    };
  }

  return { mount: mount, CSS_ID: CSS_ID };
}));
