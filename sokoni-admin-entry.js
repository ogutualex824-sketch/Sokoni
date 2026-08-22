/* SOKONI — administrative surface entry (F4)
   ============================================================================
   ONE decision for "may this page open", and one control bar for the surfaces
   that do not carry the shared header.

   THE CONTRACT
       Firebase Auth
            │
          claims                      what the account MAY do
            │
       SokoniPermissions              the administrative authority
            │
       adminContext                   which admin surface it HAS ENTERED
            │
       ┌────┴────┬──────────┐
       ↓         ↓          ↓
     gate     controls   destination

   Before this, admin.html, super-admin.html and admin-os.html each gated on the
   claim ALONE. An administrator who switched to Buyer kept full admin access: the
   workspace they were acting in and the surface they could open disagreed. The
   claim answers "may you", never "are you".

   WHY NOT activeRole. SokoniRoleAuthority deliberately excludes `admin` and
   `superAdmin` from CANONICAL_ROLES — administrative access already has an owner,
   and a second path to it is how this repository once had three answers for one
   role. setActiveRole('admin') returns {ok:false, reason:'unknown-role'} by design.
   So the administrative context is its own state, owned by sokoni-permissions.js,
   and selecting any workspace role clears it.

   WHAT THIS IS NOT. It is not the security boundary. Firestore rules and the admin
   callables are, and they are unchanged. A client-side gate decides what to RENDER;
   it never decides what may be READ. Nothing here is authorization for data.
   ==========================================================================*/
(function (window) {
  'use strict';

  var P = function () { return window.SokoniPermissions; };

  /* ── Waiting for something real to be true ────────────────────────────────
     Not a fixed delay: a slow verification and a missing one look identical from a
     timer, and answering from a timer is how a page decides it is signed out while
     the token is still in flight. Resolve on the authority actually being ready. */
  /* Wait for Firebase to actually decide, then make sure the authority has SEEN
     that decision. Not a fixed delay: a slow token and an absent session look
     identical to a timer. */
  function _awaitUser() {
    return new Promise(function (resolve) {
      var n = 0, wired = false;
      (function tick() {
        var a = window.firebaseAuth;
        if (a && a.currentUser) return resolve(a.currentUser);
        if (a && typeof a.onAuthStateChanged === 'function' && !wired) {
          wired = true;
          try { a.onAuthStateChanged(function (u) { if (u) resolve(u); }); } catch (_) {}
        }
        if (++n > 250) return resolve(null);        /* ~7.5s */
        setTimeout(tick, 30);
      }());
    });
  }

  function _ready() {
    var perms = P();
    if (!perms || typeof perms.init !== 'function') return Promise.resolve(false);
    return perms.init().then(function () {
      /* init() runs at DOMContentLoaded, BEFORE Firebase resolves currentUser, and
         caches that unverified outcome for the page load. Consulting isVerified()
         at this point locked every administrator out of every administrative
         surface with "Could not verify your access". Wait for a real user, then ask
         the authority to re-read the token before deciding. */
      /* ALWAYS reverify. This used to short-circuit on isVerified(), which returns
         _claimsVerified — a flag the five-minute sessionStorage cache sets true on
         its own. A returning administrator therefore passed this gate without any
         token being read this load, and requireAdminContext (which now insists on a
         real token, as hasRole() always did) would have refused them.

         reverify() returns immediately when the token has already been read this
         load, so the unconditional call costs nothing on the warm path and is the
         only thing that makes the cold one correct. */
      return _awaitUser().then(function (user) {
        if (!user) return false;                    /* genuinely signed out */
        if (typeof perms.reverify !== 'function') {
          return !!(perms.isVerified && perms.isVerified());
        }
        return perms.reverify();
      });
    }, function () { return false; });
  }

  function _hesc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  var LABEL = { admin: 'Admin', superAdmin: 'Super Admin' };

  /* ── The denial surface ───────────────────────────────────────────────────
     Shows WHY, and offers only what the account is genuinely entitled to.

     `context-not-entered` and `wrong-context` are offered an Enter button because
     the claim is already held — pressing it changes context, and cannot grant a
     claim. `no-claim` is offered nothing but the way out. A dead button that looks
     like a way in is worse than no button. */
  function _denyScreen(res, need) {
    var existing = document.getElementById('sk-admin-deny');
    if (existing) existing.remove();

    var label = LABEL[need] || 'Admin';
    var acting = '';
    try {
      var RA = window.SokoniRoleAuthority;
      if (RA && RA.getActiveRole) acting = RA.getActiveRole() || '';
    } catch (_) {}

    var title, body, canEnter = !!res.canEnter;
    if (res.reason === 'signed-out') {
      /* Distinct from not-verified on purpose. Telling someone whose session simply
         expired to "check your connection" sends them to refresh a page that cannot
         work until they sign in. */
      title = 'Sign in to continue';
      body = 'Your session has ended. Sign in with your administrator account.';
      canEnter = false;
    } else if (res.reason === 'no-claim') {
      title = 'Access denied';
      body = 'This account does not carry the ' + label + ' role.';
    } else if (res.reason === 'not-verified') {
      title = 'Could not verify your access';
      body = 'Your roles could not be confirmed. Check your connection and try again.';
      canEnter = false;
    } else if (res.reason === 'wrong-context') {
      title = label + ' is not your active surface';
      body = 'You are currently in the ' + _hesc(LABEL[res.context] || res.context)
           + ' surface. Enter ' + label + ' to continue.';
    } else {
      title = 'Enter ' + label;
      body = acting
        ? 'You are acting as ' + _hesc(acting.charAt(0).toUpperCase() + acting.slice(1))
          + '. Administrative surfaces are entered deliberately, not by opening a link.'
        : 'Administrative surfaces are entered deliberately, not by opening a link.';
    }

    var el = document.createElement('div');
    el.id = 'sk-admin-deny';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:#050505;'
      + 'display:flex;align-items:center;justify-content:center;padding:24px;'
      + 'font-family:"Segoe UI",system-ui,sans-serif;color:#e8e8e8;';
    el.innerHTML =
      '<div style="max-width:420px;width:100%;text-align:center;">'
      + '<div style="font-size:40px;margin-bottom:14px;">🛡️</div>'
      + '<h1 style="font-size:20px;font-weight:800;margin:0 0 10px;">' + _hesc(title) + '</h1>'
      + '<p style="font-size:14px;line-height:1.6;color:rgba(255,255,255,.6);margin:0 0 22px;">'
      + _hesc(body) + '</p>'
      + (canEnter
        ? '<button id="sk-admin-enter" style="display:block;width:100%;padding:13px;margin-bottom:10px;'
          + 'background:#71ff00;color:#050505;border:0;border-radius:12px;font-size:14px;'
          + 'font-weight:800;cursor:pointer;font-family:inherit;">Enter ' + _hesc(label) + '</button>'
        : '')
      /* A signed-out visitor needs the way IN, not the way home. */
      + (res.reason === 'signed-out'
        ? '<a href="login.html" style="display:block;padding:13px;margin-bottom:10px;'
          + 'background:#71ff00;color:#050505;border-radius:12px;font-size:14px;'
          + 'font-weight:800;text-decoration:none;">Sign in</a>'
        : '')
      + '<a href="/" style="display:block;padding:13px;background:rgba(255,255,255,.06);'
      + 'color:#e8e8e8;border-radius:12px;font-size:14px;font-weight:600;text-decoration:none;">'
      + 'Go to SOKONI Home</a>'
      + '</div>';
    document.body.appendChild(el);

    var btn = document.getElementById('sk-admin-enter');
    if (btn) {
      btn.addEventListener('click', function () {
        var r = P().enterAdminContext(need);
        if (r && r.ok) { el.remove(); location.reload(); return; }
        btn.textContent = r && r.reason === 'no-claim'
          ? 'Not available on this account' : 'Could not enter — try again';
        btn.disabled = true;
        btn.style.opacity = '.5';
        btn.style.cursor = 'default';
      });
    }
    return el;
  }

  /* ── guard ────────────────────────────────────────────────────────────────
     `need` is 'admin' or 'superAdmin'. Resolves {ok:true} or renders the denial and
     resolves {ok:false, reason}. Never throws: a guard that throws is a guard that
     silently stops guarding. */
  async function guard(need) {
    var ok = await _ready();
    var perms = P();
    if (!ok || !perms || typeof perms.requireAdminContext !== 'function') {
      /* Fail CLOSED — an unknown answer on an administrative surface is a denial.
         But SAY WHICH unknown: "could not verify your access" shown to someone who
         is simply signed out sends them to refresh a page that will never work.
         Signed out is actionable; unverifiable claims are not the same problem. */
      var signedOut = !(window.firebaseAuth && window.firebaseAuth.currentUser);
      _denyScreen({ reason: signedOut ? 'signed-out' : 'not-verified' }, need);
      return { ok: false, reason: signedOut ? 'signed-out' : 'authority-unavailable' };
    }
    var res = perms.requireAdminContext(need);
    if (!res.ok) { _denyScreen(res, need); return res; }
    return res;
  }

  /* ── Switching to a workspace role ────────────────────────────────────────
     All three administrative surfaces set data-no-header="true", which returns from
     shared-header's top-level IIFE before _skSwitchRole is ever defined — so on an
     administrative page the local path below is the one that actually runs.

     This does NOT implement switching. It calls _skSwitchRole when
     the header defined it, and otherwise SokoniRoleAuthority.setActiveRole directly —
     the same primitive _skSwitchRole itself wraps. Two callers of one authority, not
     two authorities. */
  function _switchTo(role) {
    if (typeof window._skSwitchRole === 'function') return window._skSwitchRole(role);
    var RA = window.SokoniRoleAuthority;
    if (!RA || typeof RA.setActiveRole !== 'function') return;
    return RA.setActiveRole(role).then(function (res) {
      if (!res || res.ok !== true) {
        var why = (res && res.reason) || 'unavailable';
        var msg = why === 'not-approved' ? 'That role is not available on this account.'
                : why === 'not-verified' ? 'Could not verify your roles. Check your connection.'
                : why === 'signed-out'   ? 'Sign in to switch role.'
                : 'Could not switch role right now.';
        try {
          if (window.showNotif) window.showNotif(msg, 'error');
          else console.warn('[admin-entry] ' + why + ': ' + msg);
        } catch (_) {}
        return;
      }
      /* Leaving the administrative surface — sokoni-permissions clears the context on
         sokoniActiveRoleChanged, which setActiveRole has already dispatched. */
      var hub = (typeof RA.hubFor === 'function') ? RA.hubFor(role) : null;
      location.href = hub || '/';
    });
  }
  /* ── Entering an administrative surface ───────────────────────────────────
     Same primitive as the header's _skEnterAdmin, and it DELEGATES to that when
     the header defined it. Administrative pages set data-no-header, so the local
     path below is the one that actually runs there — but they are two callers of
     enterAdminContext(), never two definitions of what entering means. */
  var DEST = { admin: 'admin.html', superAdmin: 'super-admin.html' };

  function _enterAdmin(role) {
    if (typeof window._skEnterAdmin === 'function') return window._skEnterAdmin(role);
    var perms = P();
    var res = null;
    try { res = (perms && perms.enterAdminContext) ? perms.enterAdminContext(role) : null; }
    catch (_) { res = null; }
    if (!res || res.ok !== true) {
      var why = (res && res.reason) || 'unavailable';
      var msg = why === 'no-claim'     ? 'That role is not available on this account.'
              : why === 'not-verified' ? 'Could not verify your roles. Check your connection and try again.'
              : why === 'signed-out'   ? 'Sign in to continue.'
              : 'Could not open that surface right now.';
      try {
        if (window.showNotif) window.showNotif(msg, 'error');
        else console.warn('[admin-entry] ' + why + ': ' + msg);
      } catch (_) {}
      return;                            /* refuse VISIBLY, and change nothing */
    }
    location.href = DEST[role] || DEST.admin;
  }

  function _signOut() {
    try { if (P() && P().clearAdminContext) P().clearAdminContext(); } catch (_) {}
    if (typeof window.sokoniSignOut === 'function') {
      window.sokoniSignOut().finally(function () { location.href = 'login.html'; });
      return;
    }
    try { window.firebase.auth().signOut().then(function () { location.href = 'login.html'; }); }
    catch (_) { location.href = 'login.html'; }
  }

  /* ── The administrative profile menu ──────────────────────────────────────
     THE MODEL. Administrative surfaces carry no shared marketplace header — they
     have their own chrome, and stacking a second complete navigation on top of it
     gave admin.html two headers, two role controls and no owner for either. So the
     top-right profile button is the single entry point here, and it replaces the
     standalone Sign Out the page already had.

     TWO STRIPS, TWO AUTHORITIES, on purpose:

       Workspace        SokoniRoleAuthority.setActiveRole   buyer/seller/rider/...
       Administration   SokoniPermissions.enterAdminContext  admin/superAdmin

     They are not interchangeable. `admin` is deliberately absent from
     CANONICAL_ROLES, so setActiveRole('admin') returns {ok:false} by design; and
     choosing a workspace role CLEARS the administrative context rather than merely
     relabelling the page. Neither strip reads localStorage: a forged role mirror
     produces no entry, because hasRole() refuses an elevated role asserted only by
     cache and getApprovedRoles() answers from the verified token.

     Adopting the page's own Sign Out is de-duplication of a CONTROL, not a security
     decision — signing out is not a privilege. Hidden rather than removed, so the
     page's own handlers keep the node they were written against. */

  var LABELS = {
    buyer: 'Buyer', seller: 'Seller', provider: 'Service Provider',
    mechanic: 'Mechanic', rider: 'Rider', health: 'Healthcare',
    legal: 'Legal', landlord: 'Landlord', tenant: 'Tenant',
  };
  var ICONS = {
    buyer: '🛍️', seller: '🏪', provider: '🧰', mechanic: '🔧', rider: '🛵',
    health: '🩺', legal: '⚖️', landlord: '🏠', tenant: '🔑',
    admin: '🛡️', superAdmin: '👑',
  };

  function _label(r) {
    return LABELS[r] || LABEL[r] || (String(r).charAt(0).toUpperCase() + String(r).slice(1));
  }

  function _initials(name, email) {
    var s = String(name || email || 'A').trim();
    var parts = s.split(/[\s@._-]+/).filter(Boolean);
    if (!parts.length) return 'A';
    return (parts[0].charAt(0) + (parts[1] ? parts[1].charAt(0) : '')).toUpperCase();
  }

  function _localUser() {
    try { return JSON.parse(localStorage.getItem('sokoniUser') || '{}') || {}; }
    catch (_) { return {}; }
  }

  var STYLE_ID = 'sk-admin-profile-css';
  function _injectCss() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    /* Concatenated rather than a template literal: this file is loaded as a classic
       script on pages whose CSS lives inside template literals, and a stray backtick
       in a CSS comment has terminated one of those before. */
    st.textContent = [
      '#sk-admin-profile-wrap{position:relative;display:inline-flex;align-items:center;',
      'margin-left:auto;font-family:"Segoe UI",system-ui,sans-serif;z-index:2147482000;}',
      '#sk-admin-profile{display:inline-flex;align-items:center;gap:8px;padding:5px 10px 5px 5px;',
      'background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.10);border-radius:999px;',
      'color:#e8e8e8;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;line-height:1;}',
      '#sk-admin-profile:hover{background:rgba(255,255,255,.12);}',
      '#sk-admin-profile:focus-visible{outline:2px solid #71ff00;outline-offset:2px;}',
      '#sk-admin-profile .sk-ap-av{width:26px;height:26px;border-radius:50%;display:flex;',
      'align-items:center;justify-content:center;background:#71ff00;color:#050505;',
      'font-size:11px;font-weight:800;flex:0 0 auto;}',
      '#sk-admin-profile .sk-ap-caret{font-size:9px;opacity:.65;}',
      '#sk-admin-profile-menu{position:fixed;min-width:250px;max-width:calc(100vw - 16px);',
      'background:#0b0b0b;border:1px solid rgba(255,255,255,.10);border-radius:14px;',
      'box-shadow:0 18px 44px rgba(0,0,0,.6);padding:8px;color:#e8e8e8;font-size:13px;',
      /* the scroll contract: capped, scrolls INSIDE itself, does not chain to the page */
      'max-height:min(70vh,460px);overflow-y:auto;overscroll-behavior:contain;',
      '-webkit-overflow-scrolling:touch;touch-action:pan-y;}',
      '#sk-admin-profile-menu[hidden]{display:none;}',
      '.sk-ap-head{padding:8px 10px 10px;border-bottom:1px solid rgba(255,255,255,.07);}',
      '.sk-ap-name{font-weight:800;font-size:13.5px;}',
      '.sk-ap-email{font-size:11.5px;color:rgba(255,255,255,.5);margin-top:2px;',
      'overflow:hidden;text-overflow:ellipsis;}',
      '.sk-ap-ctx{margin-top:7px;display:inline-block;padding:3px 8px;border-radius:999px;',
      'font-size:10.5px;font-weight:800;background:rgba(113,255,0,.14);color:#71ff00;}',
      '.sk-ap-sect{padding:9px 10px 3px;font-size:10px;font-weight:800;letter-spacing:.08em;',
      'text-transform:uppercase;color:rgba(255,255,255,.38);}',
      '.sk-ap-item{display:flex;align-items:center;gap:9px;width:100%;padding:9px 10px;',
      'background:transparent;border:0;border-radius:9px;color:#e8e8e8;font:inherit;',
      'font-size:12.5px;text-align:left;cursor:pointer;text-decoration:none;}',
      '.sk-ap-item:hover{background:rgba(255,255,255,.07);}',
      '.sk-ap-item:focus-visible{outline:2px solid #71ff00;outline-offset:-2px;}',
      '.sk-ap-item.is-current{color:#71ff00;font-weight:800;cursor:default;}',
      '.sk-ap-item.is-current:hover{background:transparent;}',
      '.sk-ap-item.sk-ap-danger{color:#ff6b6b;}',
      '.sk-ap-sep{height:1px;margin:6px 4px;background:rgba(255,255,255,.07);}',
    ].join('');
    (document.head || document.documentElement).appendChild(st);
  }

  /* Where the button belongs on each surface. Falls back to a fixed corner so a
     page with no top bar of its own still gets exactly one entry point. */
  function _host() {
    var sel = ['[data-sk-admin-profile-host]', '.sa-topbar', '.aos-header', '.adm-nav-right'];
    for (var i = 0; i < sel.length; i++) {
      var el = document.querySelector(sel[i]);
      if (el) return { el: el, fixed: false };
    }
    var box = document.getElementById('sk-admin-profile-fixed');
    if (!box) {
      box = document.createElement('div');
      box.id = 'sk-admin-profile-fixed';
      box.style.cssText = 'position:fixed;top:10px;right:12px;z-index:2147482000;';
      (document.body || document.documentElement).appendChild(box);
    }
    return { el: box, fixed: true };
  }

  /* Exactly one Sign Out on the surface. Ours. */
  function _adoptSignOuts() {
    var menu = document.getElementById('sk-admin-profile-menu');
    var all = document.querySelectorAll('button, a');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (menu && menu.contains(el)) continue;
      if (el.hasAttribute('data-sk-adopted-signout')) continue;
      /* Leading/trailing non-letters stripped, so a page that labels its control
         "🚪 Sign Out" is adopted too. Still anchored: this must not match prose such
         as "Sign out and back in to activate admin access", which is a sentence on
         this very page, not a control. */
      var t = (el.textContent || '').replace(/\s+/g, ' ').trim()
        .replace(/^[^\p{L}]+/u, '').replace(/[^\p{L}]+$/u, '');
      if (!/^sign\s*out$/i.test(t)) continue;
      el.setAttribute('data-sk-adopted-signout', '1');
      el.setAttribute('aria-hidden', 'true');
      el.style.display = 'none';
    }
  }

  function _strips() {
    var perms = P();
    var roles = [];
    try {
      var RA = window.SokoniRoleAuthority;
      if (RA && RA.getApprovedRoles) roles = RA.getApprovedRoles() || [];
    } catch (_) {}

    var ctx = null;
    try { ctx = (perms && perms.getAdminContext) ? perms.getAdminContext() : null; } catch (_) {}

    var admins = ['admin', 'superAdmin'].filter(function (r) {
      try { return !!(perms && perms.hasRole && perms.hasRole(r)); } catch (_) { return false; }
    });
    return { roles: roles, admins: admins, ctx: ctx };
  }

  function _renderMenu(menu) {
    var s = _strips();
    var u = _localUser();
    var html = '<div class="sk-ap-head">'
      + '<div class="sk-ap-name">' + _hesc(u.name || u.displayName || 'Account') + '</div>'
      + '<div class="sk-ap-email">' + _hesc(u.email || '') + '</div>'
      + (s.ctx ? '<div class="sk-ap-ctx">' + _hesc(ICONS[s.ctx] || '') + ' '
                 + _hesc(LABEL[s.ctx] || s.ctx) + '</div>' : '')
      + '</div>';

    if (s.admins.length) {
      html += '<div class="sk-ap-sect">Admin tools</div>';
      s.admins.forEach(function (r) {
        var cur = r === s.ctx;
        html += '<button type="button" class="sk-ap-item' + (cur ? ' is-current' : '') + '"'
          + ' data-sk-admin="' + _hesc(r) + '"' + (cur ? ' aria-current="true"' : '') + '>'
          + (ICONS[r] || '🛡️') + ' ' + _hesc(LABEL[r] || r)
          + (cur ? ' <span style="margin-left:auto;font-size:10px;">current</span>' : '')
          + '</button>';
      });
    }

    if (s.roles.length) {
      html += '<div class="sk-ap-sect">Switch workspace</div>';
      s.roles.forEach(function (r) {
        html += '<button type="button" class="sk-ap-item" data-sk-workspace="' + _hesc(r) + '">'
          + (ICONS[r] || '👤') + ' ' + _hesc(_label(r)) + '</button>';
      });
    }

    html += '<div class="sk-ap-sep"></div>'
      + '<a class="sk-ap-item" href="/">🏠 SOKONI Home</a>'
      + '<button type="button" class="sk-ap-item sk-ap-danger" data-sk-signout="1">'
      + '↩ Sign out</button>';

    menu.innerHTML = html;
  }

  /* Anchored to the button and kept fully on screen. position:fixed, because an
     absolutely-positioned menu inside a sidebar or a header with overflow is
     clipped by that ancestor — which is how a "missing" menu is usually just an
     invisible one. */
  function _place(btn, menu) {
    menu.style.left = '0px'; menu.style.top = '0px';
    var b = btn.getBoundingClientRect();
    var m = menu.getBoundingClientRect();
    var pad = 8;
    var left = Math.min(Math.max(pad, b.right - m.width), window.innerWidth - m.width - pad);
    if (left < pad) left = pad;
    var top = b.bottom + 6;
    if (top + m.height > window.innerHeight - pad) {
      top = Math.max(pad, Math.min(b.top - m.height - 6, window.innerHeight - m.height - pad));
    }
    menu.style.left = Math.round(left) + 'px';
    menu.style.top = Math.round(top) + 'px';
  }

  function mountControls(opts) {
    opts = opts || {};
    if (document.getElementById('sk-admin-profile')) { _repaint(); return; }
    _injectCss();

    var host = _host();
    var wrap = document.createElement('div');
    wrap.id = 'sk-admin-profile-wrap';

    var u = _localUser();
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'sk-admin-profile';
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', 'Account and role menu');
    btn.innerHTML = '<span class="sk-ap-av">' + _hesc(_initials(u.name, u.email)) + '</span>'
      + '<span class="sk-ap-caret">▼</span>';

    var menu = document.createElement('div');
    menu.id = 'sk-admin-profile-menu';
    menu.setAttribute('role', 'menu');
    menu.hidden = true;

    wrap.appendChild(btn);
    host.el.appendChild(wrap);
    /* The menu lives on <body>, not inside the host: .sa-topbar and .aos-header are
       flex bars with their own stacking and overflow, and a child menu is clipped by
       them. Fixed positioning plus a body parent is the only combination that is not
       at the mercy of whatever the surrounding page happens to set. */
    (document.body || document.documentElement).appendChild(menu);

    function close() {
      menu.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    }
    function open() {
      _renderMenu(menu);
      menu.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      _place(btn, menu);
    }
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (menu.hidden) open(); else close();
    });
    menu.addEventListener('click', function (e) {
      var el = e.target.closest ? e.target.closest('[data-sk-workspace],[data-sk-admin],[data-sk-signout]')
                                : null;
      if (!el) return;
      if (el.hasAttribute('data-sk-signout')) { close(); _signOut(); return; }
      if (el.hasAttribute('data-sk-workspace')) {
        close(); _switchTo(el.getAttribute('data-sk-workspace')); return;
      }
      var r = el.getAttribute('data-sk-admin');
      if (el.classList.contains('is-current')) { close(); return; }
      close(); _enterAdmin(r);
    });
    document.addEventListener('click', function (e) {
      if (menu.hidden) return;
      if (menu.contains(e.target) || wrap.contains(e.target)) return;
      close();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !menu.hidden) { close(); btn.focus(); }
    });
    window.addEventListener('resize', function () { if (!menu.hidden) _place(btn, menu); });

    _adoptSignOuts();
    /* The page's own Sign Out can be rendered AFTER this runs — sokoni-aos.js and SA
       both build their chrome asynchronously. A one-shot adoption would then leave a
       second control on screen, which is the exact duplication this replaces. */
    var mo = new MutationObserver(function () {
      clearTimeout(mo._t);
      mo._t = setTimeout(_adoptSignOuts, 250);
    });
    try { mo.observe(document.body, { childList: true, subtree: true }); } catch (_) {}

    _repaint._menu = menu;
    _repaint._btn = btn;
    ['sokoniRolesReady', 'sokoniActiveRoleChanged', 'sokoniAdminContextChanged',
     'sokoniRoleAuthorityReady', 'sokoniRoleChanged'].forEach(function (ev) {
      document.addEventListener(ev, _repaint);
    });
  }

  /* Repaint UNCONDITIONALLY on every authority event. The header once guarded its
     repaint behind a legacy-mirror equality check, so an authority-only change —
     exactly the changes that matter — repainted nothing. */
  function _repaint() {
    var menu = _repaint._menu, btn = _repaint._btn;
    if (!menu || !btn) return;
    if (!menu.hidden) { _renderMenu(menu); _place(btn, menu); }
    var u = _localUser();
    var av = btn.querySelector('.sk-ap-av');
    if (av) av.textContent = _initials(u.name, u.email);
    _adoptSignOuts();
  }

  window.SokoniAdminEntry = {
    guard: guard,
    mountControls: mountControls,
    /* named for what it is; mountControls stays the name the three surfaces call */
    mountProfileMenu: mountControls,
  };
}(window));
