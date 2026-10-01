/* ═══════════════════════════════════════════════════════════════════════════
   SOKONI PROFILE MENU — the ONE account dropdown + role switcher
   ═══════════════════════════════════════════════════════════════════════════
   Factored out of shared-header.js (2026-09-30) so a page that does NOT load the
   marketplace header — the merchant shell, merchant-v2.html — can carry the SAME
   profile icon, account dropdown and role switcher instead of a second one.

   ONE implementation. shared-header.js injects this file and keeps only the avatar
   slot in its nav; every onclick in the header markup (window._skToggleAcct,
   _skSwitchRole, _skEnterAdmin, _skSignOutFromAcct, _skSwitchWorkspace,
   _skCloseAcct) is defined HERE and nowhere else. The popup markup below is the
   markup shared-header.js used to build, moved verbatim — a DOM comparison in
   scripts/test-merchant-profile-menu.js holds it byte-identical.

   AUTHORITY. Roles come from SokoniRoleAuthority (approved set + acting role) and
   administration from SokoniPermissions.hasRole(); localStorage's sokoniUser is a
   MIRROR consulted only while the authority is unverified. This file never
   invents a role and never carries a role -> page map: the switch routes through
   RA.hubFor(). The legacy floating sokoni-profile-switcher.js is NOT this and must
   not be revived — its DASH map disagrees with the authority.

   Repaints on: sokoniActiveRoleChanged · sokoniRoleChanged · sokoniRolesReady ·
   sokoniRoleAuthorityReady · sokoniAdminContextChanged · sokoniWorkspaceChanged ·
   sokoniAuthReady.

   API
     SokoniProfileMenu.mount(hostEl, opts) -> { el, button, refresh(), destroy() }
        Renders the avatar button (id sk-nav-avatar, inside .sk-acct-wrap#sk-acct-wrap)
        into hostEl. Idempotent per host. opts.size = hit target in px (default 32;
        the merchant shell asks for 44). A host that already contains #sk-acct-wrap
        (the shared header, index.html's static nav) is adopted, not rebuilt.
     SokoniProfileMenu.open() / close() / toggle(event) / isOpen()

   Keyboard: the avatar is a <button>; Escape closes the open menu and returns
   focus to it; an outside click closes it; aria-expanded mirrors the state.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.SokoniProfileMenu) return;   /* idempotent: injected by shared-header AND loadable by tag */

  /* ── Stylesheet — owned here, inserted FIRST in <head> so a page's own CSS still wins ── */
  var CSS = `
    /* ── Account dropdown ── */
    .sk-acct-wrap { position: relative; flex-shrink: 0; }
    /* The MENU owns its scrolling, not the page.

       This was overflow:hidden with no height cap. It now carries the workspace
       roles, the Administration entries and every account link, so on a phone the
       lower items fell off with no way to reach them. Capping the height and
       scrolling inside keeps every entry reachable at any list length, and
       overscroll-behavior stops the gesture escaping to the document once the menu
       hits its end — otherwise the page scrolls away underneath an open menu. */
    #sk-acct-popup {
      position: absolute; top: calc(100% + 10px); right: 0;
      min-width: 220px; background: #141414;
      border: 1px solid rgba(113,255,0,0.15); border-radius: 14px;
      box-shadow: 0 16px 40px rgba(0,0,0,.6);
      z-index: 99999;
      width: max-content; max-width: min(92vw, 340px);
      max-height: min(78vh, 520px);
      overflow-y: auto; overflow-x: hidden;
      -webkit-overflow-scrolling: touch;
      overscroll-behavior: contain; touch-action: pan-y;
      animation: skAcctIn .18s cubic-bezier(.19,1.32,.34,1);
    }
    /* The administrative entries read as a different KIND of choice, because they
       are: they enter a context rather than change the acting workspace. */
    .sk-acct-admin-pill { border-color: rgba(192,132,252,.35) !important; }
    .sk-acct-admin-pill.active { background: rgba(192,132,252,.12) !important; color: #c084fc !important; }
    @keyframes skAcctIn {
      from { opacity: 0; transform: translateY(-8px) scale(.97); }
      to   { opacity: 1; transform: none; }
    }
    .sk-acct-head {
      padding: 14px 16px 10px;
      border-bottom: 1px solid rgba(255,255,255,.07);
    }
    .sk-acct-name { font-size: 13.5px; font-weight: 700; color: #fff; }
    .sk-acct-email { font-size: 11.5px; color: rgba(255,255,255,.45); margin-top: 2px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sk-acct-links { padding: 6px 0; }
    .sk-acct-link {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 16px; font-size: 13px; font-weight: 600;
      color: rgba(255,255,255,.8); text-decoration: none;
      transition: background .12s, color .12s; cursor: pointer;
      border: none; background: none; width: 100%; text-align: left;
    }
    .sk-acct-link:hover { background: rgba(113,255,0,.07); color: #71ff00; }
    .sk-acct-link i { width: 16px; text-align: center; font-size: 13px; color: rgba(255,255,255,.35); }
    .sk-acct-link:hover i { color: rgba(113,255,0,.7); }
    .sk-acct-separator { height: 1px; background: rgba(255,255,255,.06); margin: 4px 0; }
    .sk-acct-link-danger { color: rgba(255,77,77,.8) !important; }
    .sk-acct-link-danger:hover { background: rgba(255,77,77,.07) !important; color: #ff4d4d !important; }
    .sk-acct-link-danger i { color: rgba(255,77,77,.4) !important; }
    .sk-acct-role-strip { padding: 6px 16px 8px; }
    .sk-acct-role-label { font-size: 10px; font-weight: 700; letter-spacing: .08em;
      text-transform: uppercase; color: rgba(255,255,255,.25); margin-bottom: 6px; }
    .sk-acct-role-pills { display: flex; flex-wrap: wrap; gap: 5px; }
    .sk-acct-role-pill {
      padding: 4px 10px; border-radius: 20px; font-size: 11.5px; font-weight: 700;
      background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.1);
      color: rgba(255,255,255,.6); cursor: pointer; transition: all .12s;
    }
    .sk-acct-role-pill.active { background: rgba(113,255,0,.1); border-color: rgba(113,255,0,.28); color: #71ff00; }
    .sk-acct-role-pill:hover { background: rgba(113,255,0,.07); color: #71ff00; }

    /* ── Workspace switcher entries ── */
    .sk-acct-ws-section { padding: 4px 0 6px; }
    .sk-acct-ws-label {
      font-size: 10px; font-weight: 700; letter-spacing: .09em;
      text-transform: uppercase; color: rgba(255,255,255,.22);
      padding: 4px 16px 6px;
    }
    .sk-acct-ws-item {
      display: flex; align-items: center; gap: 10px;
      padding: 9px 16px; cursor: pointer; transition: background .12s;
      border: none; background: none; width: 100%; text-align: left;
    }
    .sk-acct-ws-item:hover { background: rgba(255,255,255,.04); }
    .sk-acct-ws-item.ws-active { background: rgba(113,255,0,.06); }
    .sk-acct-ws-icon {
      width: 30px; height: 30px; border-radius: 8px;
      background: rgba(113,255,0,.08); border: 1px solid rgba(113,255,0,.12);
      display: flex; align-items: center; justify-content: center;
      font-size: 14px; flex-shrink: 0;
    }
    .sk-acct-ws-info { flex: 1; min-width: 0; }
    .sk-acct-ws-name {
      font-size: 13px; font-weight: 700; color: rgba(255,255,255,.9);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .sk-acct-ws-role { font-size: 11px; color: rgba(255,255,255,.4); margin-top: 1px; }
    .sk-acct-ws-dot {
      width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
      background: rgba(255,255,255,.2);
    }
    .sk-acct-ws-dot.active { background: #71ff00; }
    .sk-acct-role-row { text-align: left; }
    .sk-acct-active-badge { flex-shrink: 0; font-size: 10px; font-weight: 800; letter-spacing: .04em;
      color: #71ff00; background: rgba(113,255,0,.1); border: 1px solid rgba(113,255,0,.28);
      border-radius: 999px; padding: 2px 8px; }
    .sk-acct-personal-item {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 16px; cursor: pointer; transition: background .12s;
      border: none; background: none; width: 100%; text-align: left;
    }
    .sk-acct-personal-item:hover { background: rgba(255,255,255,.04); }
    .sk-acct-personal-item.ws-active { background: rgba(113,255,0,.06); }
    .sk-acct-personal-icon {
      width: 30px; height: 30px; border-radius: 50%;
      background: rgba(113,255,0,.1); border: 1px solid rgba(113,255,0,.2);
      display: flex; align-items: center; justify-content: center;
      font-size: 13px; font-weight: 900; color: #71ff00; flex-shrink: 0;
    }
    /* The avatar this module renders itself (a host without a shared header). The
       shared header styles its own #sk-nav-avatar in its stylesheet; this class is
       only on the button mount() creates, so the two rules never stack. */
    .sk-pm-avatar {
      width: 32px; height: 32px; border-radius: 50%;
      background: rgba(113,255,0,0.1); border: 1px solid rgba(113,255,0,0.24);
      display: flex; align-items: center; justify-content: center;
      font-size: 13px; font-weight: 900; color: #71ff00; padding: 0;
      text-decoration: none; flex-shrink: 0; transition: background .15s, border-color .15s;
      cursor: pointer; font-family: inherit;
    }
    .sk-pm-avatar:hover,
    .sk-pm-avatar[aria-expanded="true"] { background: rgba(113,255,0,0.18); border-color: rgba(113,255,0,0.4); }
    .sk-pm-avatar:focus-visible { outline: 2px solid #71ff00; outline-offset: 2px; }
`;
  function _ensureStyle() {
    if (document.getElementById('sk-profile-menu-style')) return;
    var s = document.createElement('style');
    s.id = 'sk-profile-menu-style';
    s.textContent = CSS;
    var head = document.head || document.documentElement;
    head.insertBefore(s, head.firstChild);
  }
  _ensureStyle();

  /* The signed-in user as the UI mirror knows it. Identity is NOT decided here —
     firebase.js writes this and the authority verifies roles from the token. */
  function _readUser() {
    try { return JSON.parse(localStorage.getItem('sokoniUser') || 'null'); } catch (_) { return null; }
  }

  /* ── Account dropdown ──────────────────────────────────────────── */
  function _buildAcctPopup(user) {
    const existing = document.getElementById('sk-acct-popup');
    if (existing) { existing.remove(); return; }

    /* ── Read workspace memberships from localStorage ── */
    var workspaces = [];
    try { workspaces = JSON.parse(localStorage.getItem('sokoniWorkspaces') || '[]'); } catch (_) {}
    var activeWsId = localStorage.getItem('sokoniActiveWorkspace') || null;

    /* ── Personal roles (non-workspace) ── */
    const roles   = Array.isArray(user.roles) ? user.roles : (user.role ? [user.role] : ['buyer']);
    /* The ACTING role, from the authority. This was roles[0] — the localStorage mirror —
       so the pill highlight and the "Personal Account" sub-label could contradict the
       "acting as" line directly above them, which already preferred the authority. One
       resolver now feeds all three, so they cannot disagree. */
    const active  = _skActingRole(roles[0] || 'buyer');
    const roleMap = { buyer:'Buyer', seller:'Seller', provider:'Provider', driver:'Driver',
                      rider:'Rider', admin:'Admin', superAdmin:'Super Admin', employer:'Employer' };
    const rName   = r => roleMap[r] || (r.charAt(0).toUpperCase() + r.slice(1));
    const wsRoleName = r => {
      const M = { owner:'Owner', manager:'Manager', supervisor:'Supervisor', cashier:'Cashier',
        inventory_officer:'Inventory Officer', accountant:'Accountant', driver:'Driver',
        receptionist:'Receptionist', waiter:'Waiter', security:'Security', cleaner:'Cleaner' };
      return M[r] || (r ? r.charAt(0).toUpperCase() + r.slice(1).replace(/_/g,' ') : 'Staff');
    };

    const bizEmoji = type => ({ marketplace:'🛍️', food:'🍽️', services:'🔧', healthcare:'🏥',
      events:'🎪', property:'🏠', vehicle:'🚗', hotel:'🏨' }[type] || '🏢');

    /* ── Owner 2026-10-01: ROLES and WORKSPACES are shown DIFFERENTLY, never mixed ──
       My roles            — what this account is approved to act as (from the authority),
                             each with the workspace it opens. Personal by nature.
       Business workspaces — businesses where the account is owner/staff (sokoniWorkspaces),
                             each with the job held there. A business, not a role.
       The old "Workspaces" list put a "Personal Account" row (labelled with the acting
       role) beside staff workspaces, and showed roles only as pills, only sometimes. */
    const isPersonalActive = !activeWsId;

    const wsEntries = workspaces.map(function (ws) {
      const isActive = ws.businessId === activeWsId;
      const clockedLabel = ws.clockedIn ? ' · Clocked In' : '';
      return '<button class="sk-acct-ws-item ' + (isActive ? 'ws-active' : '') + '" ' +
        'onclick="window._skSwitchWorkspace(\'' + _hesc(ws.businessId) + '\')">' +
        '<div class="sk-acct-ws-icon">' + bizEmoji(ws.businessType) + '</div>' +
        '<div class="sk-acct-ws-info">' +
          '<div class="sk-acct-ws-name">' + _hesc(ws.businessName || 'Business') + '</div>' +
          '<div class="sk-acct-ws-role">' + wsRoleName(ws.role) + (ws.roleTitle && ws.roleTitle !== wsRoleName(ws.role) ? ' · ' + _hesc(ws.roleTitle) : '') + clockedLabel + '</div>' +
        '</div>' +
        '<div class="sk-acct-ws-dot ' + (isActive ? 'active' : '') + '"></div>' +
      '</button>';
    }).join('');

    /* Business workspaces — only when the account belongs to at least one business. When one is
       active, a "Back to my personal account" row returns to the roles above. */
    const wsSection = workspaces.length
      ? '<div class="sk-acct-ws-section" data-sk-section="workspaces">' +
          '<div class="sk-acct-ws-label">Business workspaces</div>' +
          wsEntries +
          (isPersonalActive ? '' :
            '<button class="sk-acct-ws-item" data-sk-personal onclick="window._skSwitchWorkspace(\'personal\')">' +
              '<div class="sk-acct-ws-icon">↩</div>' +
              '<div class="sk-acct-ws-info"><div class="sk-acct-ws-name">Back to my personal account</div>' +
              '<div class="sk-acct-ws-role">Use your own roles</div></div></button>') +
        '</div>' +
        '<div class="sk-acct-separator"></div>'
      : '';

    /* ── Role menu — ONE entry point, inside the profile dropdown ────────────────
       This listed `roles` straight from user.roles, the localStorage mirror, and had
       no administrative entries at all. Two problems: the mirror is not the
       authority, and a separate standalone switcher button duplicated the same idea
       elsewhere in the header.

       Now the workspace list comes from _skSwitcherState(), which asks
       SokoniRoleAuthority and only falls back to the mirror while the authority is
       still unverified. Administration comes from SokoniPermissions.hasRole(), which
       refuses an elevated role asserted only by cache — so a forged
       roles:['buyer','admin','superAdmin'] in localStorage cannot conjure an entry.

       The two halves call DIFFERENT authorities on purpose:
         workspace  -> _skSwitchRole()      -> setActiveRole()
         admin      -> enterAdminContext()  -> the administrative surface
       `admin` and `superAdmin` are outside CANONICAL_ROLES, so setActiveRole would
       refuse them by design. One menu, two authorities. */
    const _st = _skSwitcherState(_skLastAuthDetail);
    const _wsRoles = _st.roles || [];
    const _acting = _st.current || active;

    /* My roles — EVERY approved role, always (one role still shows which one you are acting as),
       each a row: icon · name · the workspace it opens · "Active". data-sk-workspace is kept (the
       administrative menu's convention, used by proofs to address the control). Switching goes
       through _skSwitchRole → SokoniRoleAuthority.setActiveRole → RA.hubFor() — unchanged. */
    const ROLE_UI = {
      buyer:    { i: '🛍️', l: 'Buyer',            w: 'My profile' },
      seller:   { i: '🏪', l: 'Seller',           w: 'Merchant dashboard' },
      provider: { i: '🛠️', l: 'Service provider', w: 'Provider dashboard' },
      rider:    { i: '🛵', l: 'Rider',            w: 'Rider dashboard' },
      driver:   { i: '🛵', l: 'Rider',            w: 'Rider dashboard' },
      mechanic: { i: '🔧', l: 'Mechanic',         w: 'Car Hub workspace' },
      health:   { i: '🩺', l: 'Healthcare',       w: 'Healthcare workspace' },
      legal:    { i: '⚖️', l: 'Legal',            w: 'Legal workspace' },
      landlord: { i: '🏠', l: 'Landlord',         w: 'Landlord dashboard' },
      tenant:   { i: '🔑', l: 'Tenant',           w: 'My rental' },
      employer: { i: '💼', l: 'Employer',         w: 'Hiring' },
    };
    const roleUI = r => (Object.prototype.hasOwnProperty.call(ROLE_UI, r) ? ROLE_UI[r] : { i: '👤', l: rName(r), w: '' });
    /* Rows come ONLY from the authority (_skSwitcherState → SokoniRoleAuthority). No fallback to
       the acting role or the localStorage mirror: a forged mirror role must never produce a row,
       and an account with zero confirmed roles shows no role section (the "Acting as" line in the
       head still states the current role). */
    const _myRoles = _wsRoles;
    const workspaceStrip = !_myRoles.length ? '' :
      '<div class="sk-acct-ws-section" data-sk-section="roles">' +
        '<div class="sk-acct-ws-label">My roles</div>' +
        _myRoles.map(function (r) {
          var u = roleUI(r), on = isPersonalActive && r === _acting;
          return '<button class="sk-acct-ws-item sk-acct-role-row ' + (on ? 'ws-active' : '') + '" ' +
            'data-sk-workspace="' + _hesc(r) + '" ' + (on ? 'aria-current="true" ' : '') +
            'onclick="window._skSwitchRole(\'' + _hesc(r) + '\')">' +
            '<div class="sk-acct-ws-icon">' + u.i + '</div>' +
            '<div class="sk-acct-ws-info"><div class="sk-acct-ws-name">' + _hesc(u.l) + '</div>' +
            (u.w ? '<div class="sk-acct-ws-role">Opens ' + _hesc(u.w) + '</div>' : '') + '</div>' +
            (on ? '<span class="sk-acct-active-badge">Active</span>' : '') +
          '</button>';
        }).join('') +
      '</div>' +
      '<div class="sk-acct-separator"></div>';

    /* Administration — rendered only for a claim the authority confirms. */
    var _adminEntries = [];
    try {
      var _P = window.SokoniPermissions;
      if (_P && typeof _P.hasRole === 'function') {
        if (_P.hasRole('superAdmin')) _adminEntries.push({ r: 'superAdmin', l: 'Super Admin', i: '👑' });
        if (_P.hasRole('admin'))      _adminEntries.push({ r: 'admin',      l: 'Admin',       i: '🛡️' });
      }
    } catch (_) {}
    var _ctx = null;
    try { _ctx = window.SokoniPermissions && window.SokoniPermissions.getAdminContext(); } catch (_) {}

    const adminStrip = _adminEntries.length
      ? '<div class="sk-acct-role-strip">' +
          '<div class="sk-acct-role-label">Administration</div>' +
          '<div class="sk-acct-role-pills">' +
            _adminEntries.map(a =>
              '<button class="sk-acct-role-pill sk-acct-admin-pill ' + (_ctx === a.r ? 'active' : '') + '" ' +
                'data-sk-admin="' + _hesc(a.r) + '" ' +
                'onclick="window._skEnterAdmin(\'' + _hesc(a.r) + '\')">' + a.i + ' ' + _hesc(a.l) + '</button>'
            ).join('') +
          '</div>' +
        '</div>'
      : '';

    const rolePills = adminStrip ? adminStrip + '<div class="sk-acct-separator"></div>' : '';

    const popup = document.createElement('div');
    popup.id = 'sk-acct-popup';
    popup.setAttribute('role', 'menu');
    popup.innerHTML =
      '<div class="sk-acct-head">' +
        '<div class="sk-acct-name">' + _hesc(user.name || user.displayName || 'User') + '</div>' +
        '<div class="sk-acct-email">' + _hesc(user.email || '') + '</div>' +
        _skActiveRoleLine(active) +
        _skDeliveryLine() +
      '</div>' +
      workspaceStrip +
      wsSection +
      rolePills +
      '<div class="sk-acct-links">' +
        /* ONE ROUTE VOCABULARY. The five destinations are read from
           SokoniBottomNav.TABS — the same array the bar renders — rather than
           restated here. Restating them is how a dropdown ends up pointing at a
           route the bar no longer has, and this menu previously used Font Awesome
           glyphs while the bar used emoji, so the two did not even look related.
           If the tabs are unavailable (header ordering, a page that skips the
           injector) this section is simply omitted: a menu with no shortcuts is
           better than one with dead ones. */
        (function () {
          try {
            var tabs = (window.SokoniBottomNav && window.SokoniBottomNav.TABS) || [];
            if (!tabs.length) return '';
            return tabs.map(function (t) {
              return '<a class="sk-acct-link" href="' + t.href + '" onclick="window._skCloseAcct()">' +
                     t.emoji + ' ' + _hesc(t.label) + '</a>';
            }).join('') + '<div class="sk-acct-separator"></div>';
          } catch (_) { return ''; }
        })() +
        '<a class="sk-acct-link" href="profile.html" onclick="window._skCloseAcct()">👤 My Profile</a>' +
        /* Orders left the BAR, not the product — this and the header drawer are now
           its entry points, because profile.html carried no link to it at all. */
        '<a class="sk-acct-link" href="my-orders.html" onclick="window._skCloseAcct()">📦 My Orders</a>' +
        '<a class="sk-acct-link" href="notifications.html" onclick="window._skCloseAcct()">🔔 Notifications</a>' +
        '<a class="sk-acct-link" href="account-centre.html" onclick="window._skCloseAcct()">⚙️ Settings</a>' +
        '<a class="sk-acct-link" href="account-centre.html#security" onclick="window._skCloseAcct()">🛡️ Account &amp; Security</a>' +
        /* Role-aware entries kept exactly as they were: the emoji are presentation,
           and role/capability authority is unchanged by this slice. */
        '<a class="sk-acct-link" href="account-centre.html#employment" onclick="window._skCloseAcct()">💼 My Workspaces</a>' +
        /* ALWAYS present, for every signed-in role — including an account that already
           owns a business (a new branch or a second business is a new application). It is
           the ONE entry: /offer.html ("What are you offering?"), whose every card opens the
           single Register My Business intake (hub-register.js → applications → AdminOS). */
        '<a class="sk-acct-link" href="/offer.html" data-sk-register-business onclick="window._skCloseAcct()">🏪 Register a business</a>' +
        '<a class="sk-acct-link" href="wallet.html" onclick="window._skCloseAcct()">👛 Wallet</a>' +
        '<a class="sk-acct-link" href="wishlist.html" onclick="window._skCloseAcct()">❤️ Wishlist</a>' +
        '<a class="sk-acct-link" href="help.html" onclick="window._skCloseAcct()">❓ Help &amp; Support</a>' +
        /* Sign Out stays visually separated — it is an account ACTION, not a
           destination, and a mis-tap costs the merchant their session. */
        '<div class="sk-acct-separator"></div>' +
        '<button class="sk-acct-link sk-acct-link-danger" onclick="window._skSignOutFromAcct()">🚪 Sign Out</button>' +
      '</div>';

    const wrap = document.getElementById('sk-acct-wrap');
    if (wrap) wrap.appendChild(popup);

    /* Keep the open menu inside the viewport. It is anchored right:0 to the avatar,
       and on a narrow screen a 340px menu hangs off the left edge — the overflow
       comes from the ANCHOR OFFSET, not the width, so max-width alone cannot fix it.
       Measured after paint, because the avatar's position depends on which action
       icons the page happens to render. */
    (function _clampAcct() {
      try {
        popup.style.right = '0px';
        var r = popup.getBoundingClientRect();
        var vw = window.innerWidth || document.documentElement.clientWidth;
        if (r.left < 8) popup.style.right = Math.round(r.left - 8) + 'px';
        else if (r.right > vw - 8) popup.style.right = Math.round((vw - 8) - r.right) * -1 + 'px';
      } catch (_) {}
    }());

    const avatar = document.getElementById('sk-nav-avatar');
    if (avatar) avatar.setAttribute('aria-expanded', 'true');

    /* Close on outside click */
    setTimeout(function () {
      document.addEventListener('click', _skOutsideClose, { once: true });
    }, 0);
  }

  function _hesc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  /* The role the account is ACTING as, shown under the email so the menu answers
     "who am I right now" before it offers to change it. Prefers the authority over
     the local mirror: if the two ever disagree, the authority is the true answer
     and showing the mirror would explain the wrong state confidently. */
  /* THE acting-role resolver for the header. Authority first; the caller's mirror value
     only while the authority is genuinely uninitialised or unverified — "unverified" means
     UNKNOWN, and answering from the mirror is a first-paint stopgap, never a decision. */
  /* ONE mirror answer, for the window before the authority has verified.

     The header and the switcher both prefer the authority — but while it is still
     unverified they each fell back to a DIFFERENT value: the header to whatever its
     caller passed, the switcher to detail.role. Two fallbacks, one screen, and the
     header said Driver while the menu marked Buyer.

     A mirror is not an authority, but it must at least be a SINGLE mirror. Reading
     activeRole first matters: that is the field a switch actually writes, while
     `role` is never rewritten when the acting role changes and is stale by
     construction. */
  function _skMirrorRole() {
    try {
      var u = JSON.parse(localStorage.getItem('sokoniUser') || '{}');
      return u.activeRole || u.role || (Array.isArray(u.roles) ? u.roles[0] : '') || '';
    } catch (_) { return ''; }
  }

  function _skActingRole(fallback) {
    try {
      var RA = window.SokoniRoleAuthority;
      if (RA && RA.isVerified && RA.isVerified() && RA.getActiveRole) {
        var r = RA.getActiveRole();
        if (r) return r;
      }
    } catch (_) {}
    /* The shared mirror wins over the caller's own guess, so every consumer that
       reaches this line gets the same answer. */
    return _skMirrorRole() || fallback || '';
  }

  function _skActiveRoleLine(active) {
    var role = _skActingRole(active);
    if (!role) return '';
    var label = String(role).charAt(0).toUpperCase() + String(role).slice(1);
    return '<div class="sk-acct-role-now">' + _hesc(label) + '</div>';
  }

  /* Default delivery address, e.g. "📍 Home: Lang'ata".

     Renders ONLY from a confirmed saved address. There is no such store yet — the
     buyer-addresses capability is still to be built — so today this returns an empty
     string on every path and the menu simply omits the line.

     It is deliberately NOT filled from device GPS, a reverse-geocode guess, or the
     last delivery on an order. A menu that announces "Home: Lang'ata" because the
     browser happened to report a coordinate is inventing a saved address the buyer
     never confirmed, and they would reasonably trust it at checkout. An absent line
     is honest; a guessed one is a defect. When sokoni-buyer-addresses.js lands, it
     becomes the single source read here. */
  function _skDeliveryLine() {
    try {
      var A = window.SokoniBuyerAddresses;
      if (!A || typeof A.getDefaultConfirmed !== 'function') return '';
      var a = A.getDefaultConfirmed();
      if (!a || a.confirmed !== true) return '';
      var where = a.area || a.city || '';
      if (!where) return '';
      var label = a.label ? (String(a.label).charAt(0).toUpperCase() + String(a.label).slice(1)) : 'Delivery';
      return '<div class="sk-acct-delivery">📍 ' + _hesc(label) + ': ' + _hesc(where) + '</div>';
    } catch (_) { return ''; }
  }

  window._skToggleAcct = function (e) {
    e.stopPropagation();
    var user = _readUser();
    if (!user) { location.href = 'login.html'; return; }
    _buildAcctPopup(user);
  };

  window._skCloseAcct = function () {
    const p = document.getElementById('sk-acct-popup');
    if (p) p.remove();
    const avatar = document.getElementById('sk-nav-avatar');
    if (avatar) avatar.setAttribute('aria-expanded', 'false');
  };

  function _skOutsideClose(e) {
    const wrap = document.getElementById('sk-acct-wrap');
    if (wrap && wrap.contains(e.target)) return;
    window._skCloseAcct();
  }

  /* Switching role goes through SokoniRoleAuthority FIRST, and only mirrors locally
     once the authority has agreed.

     Before this, the switch wrote localStorage and fired sokoniRoleChanged and that
     was all. RA never learned, so the two systems disagreed in both directions:
     the header believed you were a buyer while RA still approved `seller`, so
     profile.html — which asks RA — kept rendering the Business Hub after you had
     switched away. Nothing anywhere listened to RA's own sokoniActiveRoleChanged
     either, so a change made through the authority updated no UI at all. Even the
     mirrors disagreed: RA writes sokoniUser.activeRole, this wrote sokoniUser.role.

     RA.setActiveRole refuses a role the account does not hold, persists
     users/{uid}.activeRole so the choice survives reload and browser reopen, and
     declines to switch locally when the server rejects the write. Deferring to it
     is what makes a switch an actual change of role rather than a repaint.

     If RA is absent (a page that does not load it), the legacy local path still
     runs — otherwise role switching would break outright on those pages. That is a
     deliberate fallback, not an oversight: it is strictly the old behaviour, and it
     is the reason this cannot yet be called finished everywhere. */
  window._skSwitchRole = async function (role) {
    var RA = window.SokoniRoleAuthority;
    if (RA && typeof RA.setActiveRole === 'function') {
      var res = null;
      try { res = await RA.setActiveRole(role); } catch (_) { res = null; }
      if (!res || res.ok !== true) {
        var why = (res && res.reason) || 'unavailable';
        /* Say why, and do NOT switch. A silent no-op reads as a broken button, and
           switching anyway would claim a role the authority just declined. */
        var msg = why === 'not-approved' ? 'That role is not available on this account.'
                : why === 'not-verified' ? 'Could not verify your roles. Check your connection and try again.'
                : why === 'signed-out'   ? 'Sign in to switch role.'
                : 'Could not switch role right now. Please try again.';
        try {
          if (window.showNotif) window.showNotif(msg, 'error');
          else if (window.SokoniToast && window.SokoniToast.show) window.SokoniToast.show(msg, 'error');
          else console.warn('[role-switch] ' + why + ': ' + msg);
        } catch (_) {}
        return;
      }
    }
    _skMirrorRoleLocally(role);
    window._skCloseAcct();
    try {
      var u2 = JSON.parse(localStorage.getItem('sokoniUser') || 'null');
      if (u2) _buildAcctPopup(u2);
    } catch (_) {}

    /* Route to the role's workspace. A switch that changes no UI and goes nowhere reads as
       a broken button, which is what Home showed.

       hubFor() returns null unless the authority approves the role, so this cannot become a
       way INTO a workspace — the switch above already had to succeed, and the destination
       page runs its own guardWorkspace regardless. Staying put when the destination is the
       current page avoids a pointless reload (Buyer selected from Home). */
    try {
      var RA2 = window.SokoniRoleAuthority;
      /* Owner 2026-10-01: in the role dropdown, BUYER opens the buyer's PROFILE; every other role
         opens its workspace (hubFor). Only this menu's destination changes — RA.hubFor('buyer')
         stays 'index.html' because the header logo reads it. */
      var hub = (RA2 && typeof RA2.hubFor === 'function') ? RA2.hubFor(role) : null;
      if (hub && role === 'buyer') hub = 'profile.html';
      if (hub) {
        var here = (location.pathname.split('/').pop() || 'index.html');
        if (here.indexOf('.') < 0) here += '.html';      /* cleanUrls serves /merchant */
        if (here.toLowerCase() !== hub.toLowerCase()) location.href = hub;
      }
    } catch (_) {}
  };

  /* ── Entering an administrative surface from the profile menu ────────────────
     Deliberately NOT _skSwitchRole: `admin` and `superAdmin` are outside
     CANONICAL_ROLES, so setActiveRole refuses them by design. This asks
     SokoniPermissions, which checks the claim through hasRole() — an elevated role
     asserted only by cache is refused, so a forged localStorage entry gets nothing.

     On refusal it says why and changes NOTHING visible. A menu must not behave as
     though a surface opened when the authority just declined it. */
  window._skEnterAdmin = function (role) {
    var P = window.SokoniPermissions;
    var dest = role === 'superAdmin' ? 'super-admin.html' : 'admin-os.html';  /* canonical admin console */
    var res = null;
    try { res = (P && P.enterAdminContext) ? P.enterAdminContext(role) : null; } catch (_) { res = null; }
    if (!res || res.ok !== true) {
      var why = (res && res.reason) || 'unavailable';
      var msg = why === 'no-claim'     ? 'That role is not available on this account.'
              : why === 'not-verified' ? 'Could not verify your roles. Check your connection and try again.'
              : why === 'signed-out'   ? 'Sign in to continue.'
              : 'Could not open that surface right now.';
      try {
        if (window.showNotif) window.showNotif(msg, 'error');
        else console.warn('[role-menu] ' + why + ': ' + msg);
      } catch (_) {}
      return;
    }
    try { window._skCloseAcct(); } catch (_) {}
    location.href = dest;
  };

  /* The local mirror of an already-authorised decision. Kept separate so the
     authority path above and the bridge below cannot drift apart. */
  function _skMirrorRoleLocally(role) {
    try {
      var u = JSON.parse(localStorage.getItem('sokoniUser') || '{}');
      var roles = Array.isArray(u.roles) ? [...u.roles] : [role];
      var idx = roles.indexOf(role);
      if (idx > 0) { roles.splice(idx, 1); roles.unshift(role); }
      /* Write BOTH fields: RA mirrors activeRole, the existing UI reads role. */
      u.roles = roles; u.role = role; u.activeRole = role;
      localStorage.setItem('sokoniUser', JSON.stringify(u));
    } catch (_) {}
    if (window.SokoniSessionState) window.SokoniSessionState.setRole(role);
    document.dispatchEvent(new CustomEvent('sokoniRoleChanged', { detail: { role: role } }));
  }

  /* Bridge: a role change made through the authority must reach the UI.

     RA demotes to baseline on its own when a role is revoked or a token turns out
     not to carry it. Without this the header would keep showing the revoked role
     until the next full page load. _skBridging stops the two events echoing. */
  var _skBridging = false;
  document.addEventListener('sokoniActiveRoleChanged', function (e) {
    var role = e && e.detail && e.detail.role;

    /* The WRITE stays conditional — re-mirroring a value the mirror already holds
       is pointless work and risks an event echo. */
    if (!_skBridging && role) {
      var current = '';
      try { current = String((JSON.parse(localStorage.getItem('sokoniUser') || '{}').role) || '').toLowerCase(); } catch (_) {}
      if (current !== String(role).toLowerCase()) {
        _skBridging = true;
        try { _skMirrorRoleLocally(role); } finally { _skBridging = false; }
      }
    }

    /* The REPAINT is not. It used to sit behind that same equality check, so
       whenever u.role already matched the new role the handler returned early and
       the account popup kept whatever it last rendered — a stale "Driver" surviving
       a switch.

       u.role is the LEGACY field and setActiveRole never writes it; the acting role
       lives in u.activeRole. So the guard was comparing the new role against a field
       that has nothing to do with what is on screen. The mirror already holding a
       value does not mean the DOM shows it. Repaint unconditionally. */
    try {
      var u = JSON.parse(localStorage.getItem('sokoniUser') || 'null');
      if (u && document.getElementById('sk-acct-popup')) _buildAcctPopup(u);
    } catch (_) {}
  });

  /* Mirror of firebase.js's _SOKONI_LS_KEEP. firebase.js is CANONICAL; this copy exists
     only because the fallback below runs on pages where firebase.js is not loaded, so it
     cannot be read from there. If one changes, change both — a key kept here but wiped
     there (or the reverse) is a data-leak-shaped bug between two accounts on one device. */
  var _SK_LS_KEEP = /theme|darkmode|consent|cookie|appcheck|debug|install|onboard|dismiss|locale|printer|hardware|sokoniadmin(pin|pattern|pw)hash/i;

  /* Best-effort teardown for pages without firebase.js.

     The old else-branch navigated to login and cleared NOTHING. 181 pages load
     shared-header.js without firebase.js, so on all of them Sign Out was a redirect:
     the Firebase session survived in IndexedDB and every mirror survived in
     localStorage. Going back, or opening any other page, restored the previous
     session — and sokoniUser still carried the old role, so the header rebuilt itself
     as the signed-in user. "Signed out" was a page you were looking at, not a state.

     This clears what it can reach and always lands on login. It is deliberately
     idempotent: with no current user it still wipes and still navigates, so a second
     press, or a press after the session already died, reaches the signed-out state
     instead of leaving an authenticated-looking menu. */
  function _skLocalSignOutFallback() {
    try {
      var a = window.firebaseAuth || (window.firebase && window.firebase.auth && window.firebase.auth());
      if (a && typeof a.signOut === 'function') { try { a.signOut(); } catch (_) {} }
    } catch (_) {}
    [localStorage, sessionStorage].forEach(function (store) {
      try {
        Object.keys(store).forEach(function (k) {
          if (!_SK_LS_KEEP.test(k)) { try { store.removeItem(k); } catch (_) {} }
        });
      } catch (_) {}
    });
  }

  window._skSignOutFromAcct = function () {
    window._skCloseAcct();
    /* sokoniSignOut clears the session but does NOT navigate — without this redirect
       the page stayed put and Sign Out looked broken ("not working"). Always land on
       login (even if the network sign-out throws, local state is cleared). */
    if (window.sokoniSignOut) {
      window.sokoniSignOut().finally(function () { location.replace('login.html'); });
    } else {
      _skLocalSignOutFallback();
      /* replace(), not href: href leaves the authenticated page in history, so Back
         re-renders it. The session is gone, but a merchant surface painted from a
         bfcache snapshot still looks signed in. */
      location.replace('login.html');
    }
  };

  window._skSwitchWorkspace = function (businessId) {
    window._skCloseAcct();
    var targetId = (!businessId || businessId === 'personal') ? null : businessId;

    if (window.SokoniWorkspace) {
      window.SokoniWorkspace.switchTo(targetId);
    } else {
      /* Fallback: set localStorage directly if SDK not yet loaded */
      try {
        if (!targetId) localStorage.removeItem('sokoniActiveWorkspace');
        else           localStorage.setItem('sokoniActiveWorkspace', targetId);
      } catch (_) {}
      /* Fire the event manually so _updateWsBar picks it up */
      try {
        var wsList = JSON.parse(localStorage.getItem('sokoniWorkspaces') || '[]');
        var ws = targetId ? (wsList.find(function (w) { return w.businessId === targetId; }) || null) : null;
        document.dispatchEvent(new CustomEvent('sokoniWorkspaceChanged', { bubbles: true, detail: ws }));
      } catch (_) {}
    }
    /* No reload — the event listener below handles all UI updates */
  };


  /* ── Listen to workspace changes: rebuild the popup if it is open ── */
  document.addEventListener('sokoniWorkspaceChanged', function () {
    var popup = document.getElementById('sk-acct-popup');
    if (popup) {
      try {
        var u = JSON.parse(localStorage.getItem('sokoniUser') || 'null');
        if (u) {
          popup.remove();
          _buildAcctPopup(u);
        }
      } catch (_) {}
    }
  });

  /* ── The standalone role switcher and its private route map: BOTH REMOVED ──
     The profile dropdown is the single role/account control (7278782), so this
     builder had already been reduced to a no-op. Its ROLE_ROUTES map stayed, and
     that map was a SECOND role -> workspace registry which disagreed with the real
     one, SokoniRoleAuthority.WORKSPACE_HUBS, on every entry they shared:

         role      ROLE_ROUTES (here)   WORKSPACE_HUBS (the authority)
         buyer     profile.html         index.html
         seller    seller.html          merchant.html
         driver    rider-nav.html       driver.html   (canonical role: rider)
         admin     admin-os.html        absent by design

     It also listed admin and moderator as though they were workspaces, which is
     exactly the conflation SokoniRoleAuthority exists to prevent: administrative
     access is SokoniPermissions + adminContext, never an acting role.

     Dead code that contradicts the live registry is not harmless — it is the next
     person s reasonable-looking reference. There is now ONE map, in the authority
     that owns routing, and _skSwitchRole routes through hubFor(). */

  /* ── The switcher's state comes from the AUTHORITY ──────────────────────────
     F1. The switcher used to be handed detail.role, falling back to sokoniUser.role
     and then roles[0]. All three are mirrors. users/{uid}.role is never updated when
     the acting role changes — only users/{uid}.activeRole is — so the mirror is stale
     by construction and roles[0] is 'buyer' for practically every account. That is
     how the header could say Driver (it asks the authority, via _skActingRole) while
     the dropdown marked Buyer.

     localStorage stays a cache. It does not get to be the authority.

     The approved list is taken from the authority too, not just the current value:
     marking a role the list does not contain would leave nothing marked at all. */
  function _skSwitcherState(detail) {
    var roles = (detail && detail.roles) || [];
    var current = (detail && detail.role) || '';
    if (!roles.length) {
      try {
        var u = JSON.parse(localStorage.getItem('sokoniUser') || 'null');
        if (u) {
          roles = u.roles || (u.role ? [u.role] : []);
          current = current || u.role || (roles[0] || '');
        }
      } catch (_) {}
    }
    var RA = window.SokoniRoleAuthority;
    if (RA && RA.isVerified && RA.isVerified()) {
      try {
        var approved = RA.getApprovedRoles && RA.getApprovedRoles();
        if (approved && approved.length) roles = approved.slice();
      } catch (_) {}
    }
    /* Authority first; the mirror only while the authority is genuinely
       uninitialised — "unverified" means UNKNOWN, not "assume the mirror". */
    current = _skActingRole(current) || current;
    if (current && roles.indexOf(current) < 0) roles = roles.concat([current]);
    return { roles: roles, current: current };
  }

  /* ── Re-render on every role change ─────────────────────────────────────────
     These listeners now repaint the ACCOUNT POPUP, which is the single control that
     names the acting role. They previously rebuilt the standalone switcher; that
     control and its builder are gone (see above), so calling it would be a
     reference to nothing.

     The events stay exactly as they were — a workspace switch, a legacy role change
     and an administrative context change all have to repaint, for the same reason:
     the menu marks the current role, and a control that shows a stale one is worse
     than a control that shows none. Repaint is UNCONDITIONAL; guarding it behind a
     mirror-equality check is how authority-only changes once repainted nothing.

     Rebuilding only when the popup exists keeps this cheap: the popup is created on
     first open, and there is nothing to repaint before that. */
  var _skLastAuthDetail = null;
  function _skRenderRoleSwitcher(detail) {
    if (detail) _skLastAuthDetail = detail;
    /* Retire any switcher node left in a page that was open across the change. */
    var old = document.getElementById('sk-role-switcher');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    if (!document.getElementById('sk-acct-popup')) return;
    try {
      var u = JSON.parse(localStorage.getItem('sokoniUser') || 'null');
      if (u) _buildAcctPopup(u);
    } catch (_) {}
  }
  document.addEventListener('sokoniActiveRoleChanged', function () { _skRenderRoleSwitcher(null); });
  document.addEventListener('sokoniRoleChanged',      function () { _skRenderRoleSwitcher(null); });
  /* The administrative context is the other half of the current-role answer, and
     the menu marks it. Entering or leaving it must repaint for the same reason a
     workspace switch does. */
  document.addEventListener('sokoniAdminContextChanged', function () { _skRenderRoleSwitcher(null); });
  /* The authority finishing verification CHANGES THE ANSWER: before it, the
     approved list is unknown and the menu is drawn from a mirror. Repaint once it
     is real, or the first paint's guess stands for the whole session — which is
     how an administrator ends up looking at a Buyer-only menu. */
  document.addEventListener('sokoniRoleAuthorityReady', function () { _skRenderRoleSwitcher(null); });
  document.addEventListener('sokoniRolesReady',         function () { _skRenderRoleSwitcher(null); });


  /* The auth detail the header used to hand the switcher from its own
     sokoniAuthReady listener. This file may load AFTER that event (it is injected
     by the header), so read the flag firebase.js records as well as listening. */
  try { if (window.__sokoniAuthReadyDetail) _skLastAuthDetail = window.__sokoniAuthReadyDetail; } catch (_) {}
  document.addEventListener('sokoniAuthReady', function (e) {
    /* Role list and current selection both resolved by _skSwitcherState, which
       asks SokoniRoleAuthority first and treats localStorage as a cache. */
    _skRenderRoleSwitcher((e && e.detail) || null);
  });

  /* ── Escape closes the menu and hands focus back to the avatar ── */
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' && e.key !== 'Esc') return;
    if (!document.getElementById('sk-acct-popup')) return;
    window._skCloseAcct();
    try { var b = document.getElementById('sk-nav-avatar'); if (b) b.focus(); } catch (_) {}
  });

  /* ── mount(): the avatar slot for a page with no shared header ─────────────── */
  function _initialOf(user) {
    return user ? ((user.name || user.email || '').charAt(0).toUpperCase() || '👤') : '👤';
  }
  function mount(host, opts) {
    opts = opts || {};
    if (!host || !host.appendChild) return null;
    var wrap = host.querySelector('#sk-acct-wrap');
    var btn;
    if (wrap) {
      /* the shared header (or index.html's static nav) already rendered the control */
      btn = wrap.querySelector('#sk-nav-avatar');
    } else {
      if (document.getElementById('sk-acct-wrap')) {
        /* the control is a per-page singleton: a second host cannot own it */
        return null;
      }
      wrap = document.createElement('div');
      wrap.className = 'sk-acct-wrap';
      wrap.id = 'sk-acct-wrap';
      btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'sk-nav-avatar';
      btn.className = 'sk-pm-avatar';
      btn.setAttribute('aria-label', opts.ariaLabel || 'Account menu');
      btn.setAttribute('aria-haspopup', 'menu');
      btn.setAttribute('aria-expanded', 'false');
      if (opts.size) { btn.style.width = opts.size + 'px'; btn.style.height = opts.size + 'px'; }
      btn.addEventListener('click', function (e) { window._skToggleAcct(e); });
      wrap.appendChild(btn);
      host.appendChild(wrap);
    }
    function refresh() {
      if (btn) btn.textContent = _initialOf(_readUser());
    }
    refresh();
    /* the identity mirror is written by firebase.js on sign-in; repaint the initial then */
    ['sokoniAuthReady', 'sokoniRoleChanged', 'sokoniActiveRoleChanged'].forEach(function (ev) {
      document.addEventListener(ev, refresh);
    });
    return {
      el: wrap, button: btn, refresh: refresh,
      destroy: function () {
        window._skCloseAcct();
        ['sokoniAuthReady', 'sokoniRoleChanged', 'sokoniActiveRoleChanged'].forEach(function (ev) {
          document.removeEventListener(ev, refresh);
        });
        if (wrap && wrap.parentNode === host && btn && btn.classList.contains('sk-pm-avatar')) host.removeChild(wrap);
      }
    };
  }

  /* ── OWN-CHROME DASHBOARDS (owner 2026-10-01: "all 100+ business / professional dashboards") ──
     Dashboards that draw their own header opt out of shared-header.js (data-no-header / EXCLUDED),
     so they never received this control. shared-header.js sets window.__skOwnChromeAccount on
     those pages (except non-dashboards) and loads this file; here the control mounts into the
     page's OWN top bar as an ordinary flex child — the same host-then-fixed-fallback approach
     sokoni-admin-entry.js uses — never a second header.
     Skipped: inside a shell or any frame (the parent already carries the menu — one menu per
     screen; SokoniInShell.inShell is the existing detector), signed out, or when a control is
     already mounted (#sk-acct-wrap, or the admin consoles' #sk-admin-profile-wrap). */
  var HOST_SELECTORS = ['[data-sk-account-slot]', '.aos-header', '.sa-topbar', '.app-header', '.dash-header',
    '.topbar', '.top-bar', '.hdr', 'header', '.navbar', '[role="banner"]'];
  function _ownChromeHost() {
    var vw = window.innerWidth || document.documentElement.clientWidth || 0;
    for (var i = 0; i < HOST_SELECTORS.length; i++) {
      var list = document.querySelectorAll(HOST_SELECTORS[i]);
      for (var j = 0; j < list.length; j++) {
        var el = list[j], r = el.getBoundingClientRect(), cs = window.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        if (r.top > 100 || r.height < 24 || r.width < vw * 0.5) continue;      /* a TOP bar, not a card header */
        if (!/flex/.test(cs.display)) continue;                                /* only a flex bar takes a flex child */
        return { el: el, fixed: false };
      }
    }
    var box = document.getElementById('sk-acct-fixed');
    if (!box) {
      box = document.createElement('div');
      box.id = 'sk-acct-fixed';
      box.style.cssText = 'position:fixed;top:calc(10px + env(safe-area-inset-top,0px));right:calc(12px + env(safe-area-inset-right,0px));z-index:2147482000;';
      (document.body || document.documentElement).appendChild(box);
    }
    return { el: box, fixed: true };
  }
  function autoMountOwnChrome() {
    try {
      if (window.self !== window.top) return null;                                       /* framed: parent owns the menu */
      if (window.SokoniInShell && window.SokoniInShell.inShell) return null;
      if (document.getElementById('sk-acct-wrap') || document.getElementById('sk-admin-profile-wrap')) return null;
      if (!_readUser()) return null;                                                     /* signed out: nothing to show */
      var host = _ownChromeHost();
      var m = mount(host.el, { size: 40 });
      if (m && m.el && !host.fixed) m.el.style.marginLeft = 'auto';                      /* push to the right end of the bar */
      return m;
    } catch (_) { return null; }                                                         /* the dashboard must render regardless */
  }

  window.SokoniProfileMenu = {
    mount: mount,
    autoMountOwnChrome: autoMountOwnChrome,
    open:  function () { if (!document.getElementById('sk-acct-popup')) { var u = _readUser(); if (u) _buildAcctPopup(u); } },
    close: function () { window._skCloseAcct(); },
    toggle: function (e) { window._skToggleAcct(e || { stopPropagation: function () {} }); },
    isOpen: function () { return !!document.getElementById('sk-acct-popup'); },
  };

  /* Own-chrome dashboards (flag set by shared-header.js): mount after the page's own
     DOMContentLoaded work, so a page that mounts the control itself still wins (mount is a
     per-page singleton). Admin consoles carry their own control (sokoni-admin-entry.js), which
     some mount after DOMContentLoaded — never race it. */
  if (window.__skOwnChromeAccount) {
    var _auto = function () {
      setTimeout(function () {
        if (document.querySelector('script[src*="sokoni-admin-entry"]')) return;
        autoMountOwnChrome();
      }, 0);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _auto, { once: true });
    else _auto();
  }
})();
