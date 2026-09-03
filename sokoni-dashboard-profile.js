/* ================================================================
   SOKONI — shared dashboard identity widget (Part 5-7)

   window.SokoniDashboardProfile.mount(host, config) -> { refresh, destroy }

   ONE component for Merchant V2 AND Provider Dashboard — not two
   independent implementations. Each host page supplies its own data
   through `config`; this file owns only the markup, the popups, and the
   two supported ACTIONS (switch workspace, switch role) — it invents no
   authorization of its own. Every workspace this widget can ever show
   came from a SERVER-DERIVED list (getMyShopWorkspaces, Part 4, or
   whatever equivalent a future host supplies) — this file never accepts
   a workspace id typed anywhere; it only ever renders what config handed
   it and reports back exactly the id the caller selects from that list.

   config = {
     displayName, avatarUrl, currentRoleLabel,       // 'Alex Ogutu', url|null, 'Merchant'
     profileHref, accountSettingsHref, myShopHref,    // plain links
     signOut: () => Promise,                          // MUST be the canonical sign-out

     // Workspace/shop switcher — omit (or pass no getWorkspaces) on a host
     // with no workspace concept (e.g. Provider Dashboard today); the
     // trigger simply does not render, never a second identity system.
     activeWorkspaceName: string|null,
     getWorkspaces: async () => [{id, name, isActive, roleLabel}] | null,
     onSwitchWorkspace: async (id) => void,

     // Role switcher — reuses the EXISTING role authority's own vocabulary;
     // this widget only renders `availableRoles` and reports which key was
     // tapped. It is NOT the security boundary — matches this codebase's
     // own established profile.html convention (a display/routing
     // preference, not a claim grant; the actual authority is server-side
     // custom claims, unchanged by this file).
     availableRoles: [{key, label, emoji}],
     currentRoleKey: string|null,
     onSwitchRole: (key) => void,
   }
================================================================ */
(function (root) {
  'use strict';

  var CSS_ID = 'sk-dash-profile-css';
  var CSS = [
    '.sk-dash-identity{display:flex;flex-direction:column;align-items:flex-end;gap:2px;position:relative}',
    '.sk-dash-shop-trigger{background:transparent;border:none;color:inherit;font-weight:800;font-size:13px;',
      'cursor:pointer;display:flex;align-items:center;gap:4px;padding:2px 4px}',
    '.sk-dash-shop-trigger .car{font-size:10px;opacity:.7}',
    '.sk-dash-profile-trigger{background:transparent;border:none;color:inherit;cursor:pointer;',
      'display:flex;flex-direction:column;align-items:flex-end;padding:2px 4px;line-height:1.3}',
    '.sk-dash-name{font-size:12px;font-weight:700}',
    '.sk-dash-role{font-size:10.5px;opacity:.6}',
    '.sk-dash-popup{position:absolute;top:100%;right:0;margin-top:6px;min-width:220px;',
      'background:var(--card,#141414);border:1px solid var(--line,rgba(255,255,255,.09));',
      'border-radius:14px;padding:10px;z-index:200;box-shadow:0 12px 32px rgba(0,0,0,.5)}',
    '.sk-dash-popup[hidden]{display:none!important}',
    '.sk-dash-popup-title{font-size:11px;text-transform:uppercase;letter-spacing:.05em;',
      'color:var(--txt3,#6d6d6d);padding:4px 8px 8px}',
    '.sk-dash-shop-item{display:flex;align-items:center;justify-content:space-between;',
      'width:100%;background:transparent;border:none;color:var(--txt,#f4f4f4);text-align:left;',
      'padding:9px 8px;border-radius:9px;font-size:13px;cursor:pointer}',
    '.sk-dash-shop-item:hover{background:rgba(255,255,255,.06)}',
    '.sk-dash-shop-item.active{color:var(--acc,#71ff00);font-weight:700}',
    '.sk-dash-shop-item .badge{font-size:10px;opacity:.65;font-weight:400}',
    '.sk-dash-shop-item[disabled]{opacity:.45;cursor:not-allowed}',
    '.sk-dash-popup-header{font-size:14px;font-weight:800;padding:4px 8px 10px;',
      'border-bottom:1px solid var(--line,rgba(255,255,255,.09));margin-bottom:6px}',
    '.sk-dash-link{display:block;padding:9px 8px;border-radius:9px;font-size:13px;',
      'color:var(--txt,#f4f4f4);text-decoration:none;cursor:pointer;background:transparent;',
      'border:none;text-align:left;width:100%}',
    '.sk-dash-link:hover{background:rgba(255,255,255,.06)}',
    '.sk-dash-role-section{border-top:1px solid var(--line,rgba(255,255,255,.09));',
      'border-bottom:1px solid var(--line,rgba(255,255,255,.09));margin:6px 0;padding:6px 0}',
    '.sk-dash-role-pill{display:inline-flex;align-items:center;gap:4px;padding:6px 10px;',
      'border-radius:20px;border:1px solid var(--line,rgba(255,255,255,.09));background:transparent;',
      'color:var(--txt2,#a8a8a8);font-size:12px;cursor:pointer;margin:2px}',
    '.sk-dash-role-pill.active{border-color:var(--acc,#71ff00);color:var(--acc,#71ff00)}',
    '.sk-dash-signout{color:#ff5252;font-weight:700}',
  ].join('');

  function injectCSS(doc) {
    if (!doc || doc.getElementById(CSS_ID)) return;
    var s = doc.createElement('style');
    s.id = CSS_ID; s.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(s);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function mount(host, config) {
    config = config || {};
    var doc = host.ownerDocument;
    injectCSS(doc);

    var destroyed = false;
    host.innerHTML =
      '<div class="sk-dash-identity">' +
        (config.getWorkspaces ?
          '<button type="button" class="sk-dash-shop-trigger" data-act="open-shop">' +
            '<span data-el="active-shop">' + esc(config.activeWorkspaceName || 'Select shop') + '</span>' +
            '<span class="car">▾</span></button>' : '') +
        '<button type="button" class="sk-dash-profile-trigger" data-act="open-profile">' +
          '<span class="sk-dash-name">' + esc(config.displayName || 'Account') + '</span>' +
          '<span class="sk-dash-role">' + esc(config.currentRoleLabel || '') + '</span>' +
        '</button>' +
        (config.getWorkspaces ? '<div class="sk-dash-popup" data-popup="shop" hidden></div>' : '') +
        '<div class="sk-dash-popup" data-popup="profile" hidden></div>' +
      '</div>';

    var root = host.querySelector('.sk-dash-identity');
    var shopPopup = root.querySelector('[data-popup="shop"]');
    var profilePopup = root.querySelector('[data-popup="profile"]');

    function closeAll() {
      if (shopPopup) shopPopup.hidden = true;
      if (profilePopup) profilePopup.hidden = true;
    }

    function onOutsideClick(e) {
      if (!root.contains(e.target)) closeAll();
    }
    doc.addEventListener('click', onOutsideClick, true);

    function renderProfilePopup() {
      var roles = Array.isArray(config.availableRoles) ? config.availableRoles : [];
      profilePopup.innerHTML =
        '<div class="sk-dash-popup-header">' + esc(config.displayName || 'Account') + '</div>' +
        (config.profileHref ? '<a class="sk-dash-link" href="' + esc(config.profileHref) + '">Profile</a>' : '') +
        (config.myShopHref ? '<a class="sk-dash-link" href="' + esc(config.myShopHref) + '">My Shop</a>' : '') +
        (roles.length > 1 ?
          '<div class="sk-dash-role-section">' +
            roles.map(function (r) {
              var active = r.key === config.currentRoleKey ? ' active' : '';
              return '<button type="button" class="sk-dash-role-pill' + active + '" data-role="' +
                esc(r.key) + '">' + esc(r.emoji || '') + ' ' + esc(r.label) + '</button>';
            }).join('') +
          '</div>' : '') +
        (config.accountSettingsHref ? '<a class="sk-dash-link" href="' + esc(config.accountSettingsHref) + '">Account Settings</a>' : '') +
        '<button type="button" class="sk-dash-link sk-dash-signout" data-act="sign-out">Sign Out</button>';

      var roleBtns = profilePopup.querySelectorAll('[data-role]');
      for (var i = 0; i < roleBtns.length; i++) {
        roleBtns[i].addEventListener('click', function (e) {
          var key = e.currentTarget.getAttribute('data-role');
          closeAll();
          if (config.onSwitchRole) { try { config.onSwitchRole(key); } catch (_) {} }
        });
      }
      var signOutBtn = profilePopup.querySelector('[data-act="sign-out"]');
      if (signOutBtn) signOutBtn.addEventListener('click', function () {
        closeAll();
        if (config.signOut) { try { config.signOut(); } catch (_) {} }
      });
    }

    var workspacesLoaded = false;
    function renderShopPopup(workspaces) {
      if (!shopPopup) return;
      shopPopup.innerHTML = '<div class="sk-dash-popup-title">Your Shops</div>';
      if (!workspaces || !workspaces.length) {
        shopPopup.innerHTML += '<div class="sk-dash-popup-title">No shops found.</div>';
        return;
      }
      var Core = (doc.defaultView || window).SokoniDashboardProfileCore;
      workspaces.forEach(function (w) {
        var state = Core.workspaceItemState(w);
        var btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'sk-dash-shop-item' + (w.current ? ' active' : '');
        if (state.disabled && !w.current) btn.disabled = true;
        btn.innerHTML = '🏪 ' + esc(w.name) + (state.badge ? ' <span class="badge">' + esc(state.badge) + '</span>' : '');
        btn.addEventListener('click', function () {
          closeAll();
          if (Core.shouldSwitchWorkspace(w) && config.onSwitchWorkspace) {
            try { config.onSwitchWorkspace(w.id); } catch (_) {}
          }
        });
        shopPopup.appendChild(btn);
      });
    }

    function openShopPopup() {
      var wasHidden = shopPopup.hidden;
      closeAll();
      if (!wasHidden) return;
      shopPopup.hidden = false;
      if (workspacesLoaded) return;
      shopPopup.innerHTML = '<div class="sk-dash-popup-title">Loading…</div>';
      Promise.resolve(config.getWorkspaces ? config.getWorkspaces() : null)
        .then(function (list) {
          workspacesLoaded = true;
          var Core = (doc.defaultView || window).SokoniDashboardProfileCore;
          var marked = Core ? Core.markCurrent(list, config.activeWorkspaceId) : list;
          if (!destroyed) renderShopPopup(marked);
        })
        .catch(function () {
          if (!destroyed) shopPopup.innerHTML = '<div class="sk-dash-popup-title">Could not load your shops.</div>';
        });
    }

    function openProfilePopup() {
      var wasHidden = profilePopup.hidden;
      closeAll();
      if (!wasHidden) return;
      renderProfilePopup();
      profilePopup.hidden = false;
    }

    var shopTrigger = root.querySelector('[data-act="open-shop"]');
    if (shopTrigger) shopTrigger.addEventListener('click', function (e) { e.stopPropagation(); openShopPopup(); });
    var profileTrigger = root.querySelector('[data-act="open-profile"]');
    profileTrigger.addEventListener('click', function (e) { e.stopPropagation(); openProfilePopup(); });

    return {
      refresh: function () {
        if (destroyed) return;
        workspacesLoaded = false;
        var shopLabel = root.querySelector('[data-el="active-shop"]');
        if (shopLabel) shopLabel.textContent = config.activeWorkspaceName || 'Select shop';
        var nameEl = root.querySelector('.sk-dash-name');
        if (nameEl) nameEl.textContent = config.displayName || 'Account';
        var roleEl = root.querySelector('.sk-dash-role');
        if (roleEl) roleEl.textContent = config.currentRoleLabel || '';
      },
      destroy: function () {
        destroyed = true;
        doc.removeEventListener('click', onOutsideClick, true);
      },
    };
  }

  root.SokoniDashboardProfile = { mount: mount };
})(typeof window !== 'undefined' ? window : globalThis);
