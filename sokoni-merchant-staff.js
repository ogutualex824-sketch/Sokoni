/* ════════════════════════════════════════════════════════════════════════════
   SOKONI Merchant Staff — the client layer over the shopEmployees contract

   Team/Staff reads and writes through the SERVER AUTHORITIES established in
   2D-2 step 1, and through nothing else:

       listShopEmployees    the staff of one shop, corroborated
       listShopInvites      the invites still outstanding for that shop
       inviteShopEmployee   create an invite (records shopId, verifies ownership)
       revokeShopInvite     withdraw an outstanding invite
       removeShopEmployee   DEACTIVATE a member — never a delete

   ── What this module deliberately cannot do ─────────────────────────────────
   It contains no Firestore access of any kind. That is the point, not an
   incidental property: seller.js's `removeEmployee()` called `deleteDoc` on
   `shopEmployees/{id}` AND on `users/{id}` straight from the browser —
   destroying the employment record, the audit trail, and the person's user
   document, with the client deciding who was allowed to. The whole reason
   `removeShopEmployee` exists is to take that decision away from the client.

   So: no `deleteDoc`, no `setDoc`, no collection reference, no localStorage
   business state. If the server refuses, the screen reports the refusal.

   ── Identity ────────────────────────────────────────────────────────────────
   `shopId` is the SHOP. Every call carries it explicitly rather than letting the
   server guess, so a merchant with two shops manages two teams. It is never
   defaulted to the signed-in uid.
   ════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SokoniMerchantStaff = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CALLABLES = {
    list: 'listShopEmployees',
    invites: 'listShopInvites',
    invite: 'inviteShopEmployee',
    revoke: 'revokeShopInvite',
    remove: 'removeShopEmployee',
  };

  /* Mirrors functions/shop-employees.js SHOP_ROLES. The server validates against
     its own copy and refuses anything else, so drift here surfaces as an honest
     invalid-argument rather than a silently mis-scoped employee. */
  var ROLES = [
    { id: 'manager',   label: 'Manager',         hint: 'Full shop access, can run the till and see reports' },
    { id: 'cashier',   label: 'Cashier',         hint: 'Sell and take payment' },
    { id: 'inventory', label: 'Inventory clerk', hint: 'Count and correct stock' },
    { id: 'support',   label: 'Support agent',   hint: 'Answer customers' },
  ];
  var ROLE_IDS = ROLES.map(function (r) { return r.id; });
  /* Managers first, then the rest — an owner scanning a list wants the people
     who can do the most at the top. */
  var ROLE_ORDER = ['manager', 'cashier', 'inventory', 'support'];

  function roleLabel(id) {
    for (var i = 0; i < ROLES.length; i++) if (ROLES[i].id === id) return ROLES[i].label;
    return id || '—';
  }

  function requireScope(scope) {
    if (!scope || !scope.ok) throw new Error('merchant staff: a resolved shop scope is required');
    return scope;
  }

  /* ── Payload builders (PURE) ──────────────────────────────────────────────
     Asserting on these is asserting on what the server would be asked to do. */

  function buildInvite(o) {
    var scope = requireScope(o.scope);
    var email = String(o.email == null ? '' : o.email).trim().toLowerCase();
    if (!email || email.indexOf('@') < 1 || email.indexOf('.') < 0) {
      throw new Error('Enter the email address the invite should go to.');
    }
    if (ROLE_IDS.indexOf(String(o.role)) === -1) {
      throw new Error('Choose what this person will be allowed to do.');
    }
    return {
      shopId: scope.shopId,
      email: email,
      role: String(o.role),
      shopName: o.shopName ? String(o.shopName).slice(0, 80) : 'My Shop',
    };
  }

  function buildRemoval(o) {
    var scope = requireScope(o.scope);
    if (!o.uid) throw new Error('merchant staff: uid is required');
    return { shopId: scope.shopId, uid: String(o.uid) };
  }

  /* The link an owner shares. Built from the token the SERVER minted — the
     client never invents one. */
  function inviteLink(token, origin) {
    if (!token) return null;
    var base = origin || (typeof location !== 'undefined' ? location.origin : '');
    return base + '/join?t=' + encodeURIComponent(token) + '&type=shop';
  }

  /* ── Calls ────────────────────────────────────────────────────────────────
     Every one returns { ok, ... } or { ok:false, error } — never a success shape
     over a failed call, and never a local edit as a "fallback". */

  function _unwrap(res) { return (res && res.data) ? res.data : res; }

  async function _call(fn, payload, failMessage) {
    if (typeof fn !== 'function') throw new Error('merchant staff: callable is required');
    try {
      var d = _unwrap(await fn(payload));
      if (!d || d.ok === false) return { ok: false, error: (d && d.error) || failMessage };
      return Object.assign({ ok: true }, d);
    } catch (e) {
      /* Surface the server's own wording — it is written for the person holding
         the problem, and it is the only account of what actually happened. */
      return { ok: false, error: (e && e.message) || failMessage, code: (e && e.code) || null };
    }
  }

  async function listStaff(o) {
    var scope = requireScope(o.scope);
    var r = await _call(o.callList, { shopId: scope.shopId }, 'Your team could not be loaded.');
    if (!r.ok) return r;
    var rows = (r.employees || []).slice();
    rows.sort(function (a, b) {
      var ra = ROLE_ORDER.indexOf(a.role), rb = ROLE_ORDER.indexOf(b.role);
      if (ra !== rb) return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb);
      return String(a.name || a.email || '').localeCompare(String(b.name || b.email || ''));
    });
    return { ok: true, shopId: r.shopId, employees: rows, count: rows.length };
  }

  async function listInvites(o) {
    var scope = requireScope(o.scope);
    return _call(o.callInvites, { shopId: scope.shopId }, 'Outstanding invites could not be loaded.');
  }

  async function invite(o) {
    var payload = buildInvite(o);
    return _call(o.callInvite, payload, 'The invite could not be created.');
  }

  async function revokeInvite(o) {
    if (!o.token) throw new Error('merchant staff: token is required');
    /* revokeShopInvite authorises on the invite's own shopOwnerId, so the token
       is the whole payload — there is nothing else for a client to influence. */
    return _call(o.callRevoke, { token: String(o.token) }, 'The invite could not be withdrawn.');
  }

  async function removeMember(o) {
    var payload = buildRemoval(o);
    return _call(o.callRemove, payload, 'That person could not be removed.');
  }

  /* Display helper — initials for an avatar, never a fabricated name. */
  function initials(name, email) {
    var s = String(name || '').trim();
    if (!s) s = String(email || '').split('@')[0] || '';
    if (!s) return '?';
    var parts = s.split(/[\s._-]+/).filter(Boolean);
    var out = (parts[0] || '').charAt(0) + (parts.length > 1 ? (parts[parts.length - 1] || '').charAt(0) : '');
    return out.toUpperCase() || '?';
  }

  return {
    CALLABLES: CALLABLES,
    ROLES: ROLES,
    ROLE_IDS: ROLE_IDS,
    ROLE_ORDER: ROLE_ORDER,
    roleLabel: roleLabel,
    buildInvite: buildInvite,
    buildRemoval: buildRemoval,
    inviteLink: inviteLink,
    listStaff: listStaff,
    listInvites: listInvites,
    invite: invite,
    revokeInvite: revokeInvite,
    removeMember: removeMember,
    initials: initials,
  };
}));
