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
  function _ready() {
    var perms = P();
    if (!perms || typeof perms.init !== 'function') return Promise.resolve(false);
    return perms.init().then(function () { return true; }, function () { return false; });
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
    if (res.reason === 'no-claim') {
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
      /* Fail CLOSED. An unavailable authority is an unknown answer, and an unknown
         answer on an administrative surface is a denial, never an admission. */
      _denyScreen({ reason: 'not-verified' }, need);
      return { ok: false, reason: 'authority-unavailable' };
    }
    var res = perms.requireAdminContext(need);
    if (!res.ok) { _denyScreen(res, need); return res; }
    return res;
  }

  /* ── The control bar ──────────────────────────────────────────────────────
     admin.html receives the shared header (it is not in EXCLUDED and sets no
     data-no-header), so it already carries the fixed role switcher. super-admin.html
     and admin-os.html set data-no-header="true", which returns from shared-header's
     top-level IIFE before _skSwitchRole is ever defined — so those surfaces get this
     instead, offering the same three things.

     The role switcher here does NOT implement switching. It calls _skSwitchRole when
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

  function mountControls(opts) {
    opts = opts || {};
    var need = opts.role === 'superAdmin' ? 'superAdmin' : 'admin';
    if (document.getElementById('sk-admin-controls')) return;

    var roles = [];
    try {
      var RA = window.SokoniRoleAuthority;
      if (RA && RA.getApprovedRoles) roles = RA.getApprovedRoles() || [];
    } catch (_) {}

    var bar = document.createElement('div');
    bar.id = 'sk-admin-controls';
    bar.style.cssText = 'position:fixed;top:0;right:0;z-index:2147483000;display:flex;'
      + 'align-items:center;gap:6px;padding:8px 12px;font-family:"Segoe UI",system-ui,sans-serif;';

    var sel = document.createElement('select');
    sel.id = 'sk-admin-role';
    sel.setAttribute('aria-label', 'Switch workspace');
    sel.style.cssText = 'background:#0d0d0d;color:#e8e8e8;border:1px solid #1a1a1a;'
      + 'border-radius:10px;padding:7px 10px;font-size:12px;font-family:inherit;cursor:pointer;';
    /* The administrative surface is the current selection and is NOT a workspace
       role, so it is shown as the marked option and never written to activeRole. */
    sel.innerHTML = '<option value="" selected>' + _hesc(LABEL[need]) + ' (current)</option>'
      + roles.map(function (r) {
        return '<option value="' + _hesc(r) + '">Switch to '
          + _hesc(r.charAt(0).toUpperCase() + r.slice(1)) + '</option>';
      }).join('');
    sel.addEventListener('change', function () {
      if (!sel.value) return;
      _switchTo(sel.value);
    });

    var home = document.createElement('a');
    home.href = '/';
    home.textContent = 'Home';
    home.style.cssText = 'padding:7px 12px;background:rgba(255,255,255,.06);color:#e8e8e8;'
      + 'border-radius:10px;font-size:12px;font-weight:600;text-decoration:none;';

    var out = document.createElement('button');
    out.type = 'button';
    out.textContent = 'Sign out';
    out.style.cssText = 'padding:7px 12px;background:rgba(255,60,60,.12);color:#ff6b6b;'
      + 'border:1px solid rgba(255,60,60,.3);border-radius:10px;font-size:12px;'
      + 'font-weight:700;cursor:pointer;font-family:inherit;';
    out.addEventListener('click', function () {
      try { if (P() && P().clearAdminContext) P().clearAdminContext(); } catch (_) {}
      if (typeof window.sokoniSignOut === 'function') {
        window.sokoniSignOut().finally(function () { location.href = 'login.html'; });
        return;
      }
      try { window.firebase.auth().signOut().then(function () { location.href = 'login.html'; }); }
      catch (_) { location.href = 'login.html'; }
    });

    bar.appendChild(sel); bar.appendChild(home); bar.appendChild(out);
    (document.body || document.documentElement).appendChild(bar);
  }

  window.SokoniAdminEntry = { guard: guard, mountControls: mountControls };
}(window));
