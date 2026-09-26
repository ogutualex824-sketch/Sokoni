/* ═══════════════════════════════════════════════════════════════════════════
   SOKONI — MERCHANT WORKSPACE NAVIGATION (pure)
   sokoni-merchant-nav.js

   Decides what a merchant sees in Merchant V2: which workspaces exist, which
   are usable, and why anything is restricted.

   ── THE BOUNDARY THIS FILE EXISTS TO HOLD ──────────────────────────────────

   Two different questions, two different answers, and conflating them is the
   defect:

       IDENTITY      may this account trade products / services?
                     → business-scope.js, from the registries an ADMIN
                       APPROVAL wrote. Not purchasable.

       ENTITLEMENT   which features may this approved business use today?
                     → the subscription for THAT side.

   `capability-authority.js` states the rule in its own header: a capability
   says what a PLAN permits, never who someone is. So:

     • A SUBSCRIPTION NEVER CREATES A WORKSPACE. Paying for a seller plan
       while holding no seller approval shows nothing. Selling is an approval,
       not a purchase, and a nav that rendered a Products workspace off a
       payment would be the first step to a system where it can be bought.

     • AN APPROVAL WITHOUT A SUBSCRIPTION STILL SHOWS ITS WORKSPACE, in a
       restricted state. The merchant is approved and the data is theirs; a
       lapsed card is not a reason to make their catalogue vanish. They get a
       reason and a way to fix it.

   ── THE TWO SIDES ARE INDEPENDENT ──────────────────────────────────────────

   `merchantSubscriptions/{uid}` and `providerSubscriptions/{uid}` are separate
   documents under one account (subscription-core.js:107,130), resolved by
   `resolveSubscription(uid, { role })`. A dual business therefore needs no
   "dual plan": it has two subscriptions it manages separately.

   Cancelling the seller subscription must not touch the provider side, and
   vice versa. Every restriction computed here is per-side, and a test asserts
   the cross-effect is nil.

   ── PURE ───────────────────────────────────────────────────────────────────

   No DOM, no Firestore, no network, no clock. The caller resolves scope and
   both subscriptions and passes them in. The SERVER re-decides every write
   and every sale regardless of what this returns — a hidden nav item is a
   courtesy, never a control.
═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SokoniMerchantNav = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SIDE = Object.freeze({ PRODUCTS: 'products', SERVICES: 'services' });

  /* A subscription counts as live in these states only. `computeStatus` in
     subscription-core already collapses expired / cancelled / past_due to a
     non-active value, so this is a whitelist and not a blacklist: a status
     this module has never heard of is NOT live. Same rule as business-scope —
     unknown is when to refuse, not when to assume goodwill. */
  const LIVE_SUB = Object.freeze(['active', 'trialing', 'trial', 'grace']);

  function subLive(sub) {
    if (!sub || sub.found !== true) return false;
    const s = String(sub.status == null ? '' : sub.status).trim().toLowerCase();
    return LIVE_SUB.indexOf(s) !== -1;
  }

  /* ── Sections, and which side owns each ─────────────────────────────────
     Sections with no `side` are ACCOUNT-LEVEL: they belong to the business
     itself, not to either commercial side, so they survive any subscription
     lapse. Billing especially — locking a merchant out of the page where they
     would fix a lapsed subscription is a trap. */
  const SECTIONS = Object.freeze([
    { id: 'overview',    label: 'Overview',        side: null },

    { id: 'products',    label: 'Products',        side: SIDE.PRODUCTS },
    { id: 'inventory',   label: 'Inventory',       side: SIDE.PRODUCTS },
    { id: 'orders',      label: 'Orders',          side: SIDE.PRODUCTS },

    { id: 'services',    label: 'Service catalogue', side: SIDE.SERVICES },
    { id: 'bookings',    label: 'Bookings',        side: SIDE.SERVICES },
    { id: 'appointments',label: 'Appointments',    side: SIDE.SERVICES },

    /* The till serves BOTH sides and is shown when EITHER is usable — a cyber
       café whose provider plan lapsed must still be able to sell a flash
       disk. `sides` (plural) marks that. */
    { id: 'till',        label: 'Till',            sides: [SIDE.PRODUCTS, SIDE.SERVICES] },

    { id: 'customers',   label: 'Customers',       side: null },
    { id: 'payments',    label: 'Payments',        side: null },
    { id: 'reports',     label: 'Reports',         side: null },
    { id: 'tax',         label: 'Tax & compliance', side: null },
    { id: 'staff',       label: 'Staff',           side: null },
    { id: 'branches',    label: 'Branches',        side: null },
    { id: 'payouts',     label: 'Payouts',         side: null },
    { id: 'profile',     label: 'Business profile', side: null },
    { id: 'billing',     label: 'Subscriptions',   side: null },
    { id: 'applications',label: 'Business status', side: null },
  ]);

  /* ── Per-side state ─────────────────────────────────────────────────────
       absent      not approved — the workspace does not exist
       restricted  approved, but no live subscription for this side
       active      approved AND subscribed
     Note there is no state for "subscribed but not approved": that is
     `absent`, deliberately. */
  function sideState(approved, sub) {
    if (!approved) return 'absent';
    return subLive(sub) ? 'active' : 'restricted';
  }

  function sideReason(state, sideId, scopeReason, sub) {
    if (state === 'active') return null;
    if (state === 'absent') {
      const r = scopeReason || 'not_applied';
      const what = sideId === SIDE.SERVICES ? 'provide services' : 'sell products';
      if (r === 'pending_review') return `Your application to ${what} is still in review.`;
      if (r === 'suspended')      return `Your approval to ${what} is suspended.`;
      if (r === 'rejected')       return `Your application to ${what} was not approved.`;
      return `Apply to ${what} to unlock this workspace.`;
    }
    /* restricted — approved, subscription is not live */
    const what = sideId === SIDE.SERVICES ? 'service' : 'seller';
    const st = sub && sub.found ? String(sub.status || '').toLowerCase() : null;
    if (st === 'past_due')  return `Your ${what} subscription payment is overdue. Your data is safe — renew to continue.`;
    if (st === 'cancelled' || st === 'canceled') return `Your ${what} subscription was cancelled. Your data is safe — resubscribe to continue.`;
    if (st === 'expired')   return `Your ${what} subscription has expired. Your data is safe — renew to continue.`;
    return `Start a ${what} subscription to use this workspace.`;
  }

  /**
   * Resolve the whole navigation.
   *
   * @param {object} o
   * @param {object} o.scope  from business-scope.js
   * @param {object} o.sellerSub    resolveSubscription(uid,{role:'merchant'})
   * @param {object} o.providerSub  resolveSubscription(uid,{role:'provider'})
   */
  function resolveNav({ scope, sellerSub, providerSub } = {}) {
    const sc = scope || {};
    const reasons = sc.reasons || {};

    const products = {
      id: SIDE.PRODUCTS,
      approved: !!sc.sellsProducts,
      state: sideState(!!sc.sellsProducts, sellerSub),
      tier: (sellerSub && sellerSub.found) ? (sellerSub.tier || null) : null,
      status: (sellerSub && sellerSub.found) ? (sellerSub.status || null) : 'none',
    };
    products.usable = products.state === 'active';
    products.reason = sideReason(products.state, SIDE.PRODUCTS, reasons.products, sellerSub);

    const services = {
      id: SIDE.SERVICES,
      approved: !!sc.providesServices,
      state: sideState(!!sc.providesServices, providerSub),
      tier: (providerSub && providerSub.found) ? (providerSub.tier || null) : null,
      status: (providerSub && providerSub.found) ? (providerSub.status || null) : 'none',
    };
    services.usable = services.state === 'active';
    services.reason = sideReason(services.state, SIDE.SERVICES, reasons.services, providerSub);

    const bySide = { products, services };

    const sections = SECTIONS.map((s) => {
      /* Account-level: always present and usable. Billing must never lock. */
      if (!s.side && !s.sides) {
        return { id: s.id, label: s.label, visible: true, usable: true, reason: null, side: null };
      }
      const sides = s.sides || [s.side];
      const owners = sides.map((x) => bySide[x]);
      const visible = owners.some((o) => o.approved);
      const usable  = owners.some((o) => o.usable);
      let reason = null;
      if (!usable) {
        /* Report the reason from a side that is APPROVED where possible — a
           merchant with one approved side wants to know about that one, not
           about the side they never applied for. */
        const rel = owners.find((o) => o.approved) || owners[0];
        reason = rel ? rel.reason : null;
      }
      return {
        id: s.id, label: s.label, visible, usable, reason,
        side: s.sides ? 'both' : s.side,
      };
    });

    return {
      products, services,
      isDual: products.approved && services.approved,
      /* Fully operational on both sides — the state the cyber café wants. */
      isDualActive: products.usable && services.usable,
      /* Can this account do ANYTHING commercial right now? */
      anyUsable: products.usable || services.usable,
      sections,
      visibleSections: sections.filter((s) => s.visible),
    };
  }

  /** Convenience: may this workspace be opened? */
  function canOpen(nav, sectionId) {
    const s = (nav && nav.sections || []).find((x) => x.id === sectionId);
    return !!(s && s.visible && s.usable);
  }

  /** Why not — for the UI to show instead of a dead link. */
  function whyBlocked(nav, sectionId) {
    const s = (nav && nav.sections || []).find((x) => x.id === sectionId);
    if (!s) return 'Unknown section.';
    if (!s.visible) return s.reason || 'This workspace is not part of your business.';
    if (!s.usable)  return s.reason || 'This workspace is not available right now.';
    return null;
  }

  /**
   * Which catalogue kinds may be CREATED right now.
   *
   * Scope AND entitlement, per the hierarchy: approval first, subscription
   * second. Deliberately stricter than catalogue-model's `creatableKinds`,
   * which knows only about scope — this is the combined answer, and the
   * SERVER remains the authority for both halves.
   */
  function creatableKinds(nav) {
    const out = [];
    if (nav && nav.products && nav.products.usable) out.push('product');
    if (nav && nav.services && nav.services.usable) out.push('service');
    return out;
  }

  /** Subscription cards for the billing panel — one per approved side. */
  function subscriptionCards(nav) {
    const cards = [];
    if (nav && nav.products && nav.products.approved) {
      cards.push({ side: 'products', label: 'Seller', tier: nav.products.tier,
        status: nav.products.status, live: nav.products.usable });
    }
    if (nav && nav.services && nav.services.approved) {
      cards.push({ side: 'services', label: 'Service provider', tier: nav.services.tier,
        status: nav.services.status, live: nav.services.usable });
    }
    return cards;
  }

  /* ── Merchant V2 route contract integration ────────────────────────────
     `sokoni-merchant-routes.js` is the sidebar's single source of truth — the
     shell renders a PROJECTION of it and lists nothing by hand. Integration is
     therefore a FILTER over that projection, not new markup: a route the
     contract does not declare can never appear, and a route it does declare is
     shown or restricted according to the rules above.

     The mapping lives here, in the decision layer, so merchant-v2.html holds
     no entitlement logic of its own. */

  /* Routes that belong to the SELLER side. Derived from the contract's own
     `role` where it is unambiguous, and named explicitly where it is not —
     `role:['seller','merchant']` is carried by account-level routes too
     (Settings, Messages), so role alone would hide a merchant's settings when
     their seller plan lapsed. Explicit beats inferred for anything that could
     lock someone out. */
  const PRODUCT_ROUTE_IDS = Object.freeze([
    'products', 'inventory', 'orders', 'offers', 'sell', 'flash-sale',
    'minishop', 'availability', 'fulfilment', 'returns', 'deliveries', 'stories',
  ]);
  const SERVICE_ROUTE_IDS = Object.freeze([
    'services', 'bookings', 'appointments', 'provider-profile',
  ]);
  /* Serves BOTH sides: visible while EITHER is usable. */
  const SHARED_ROUTE_IDS = Object.freeze(['pos', 'till']);

  /**
   * Which side a contract route belongs to.
   * Returns 'products' | 'services' | 'both' | null (account-level).
   */
  function sideOfRoute(route) {
    const id = String((route && route.id) || '');
    if (SHARED_ROUTE_IDS.indexOf(id) !== -1)  return 'both';
    if (PRODUCT_ROUTE_IDS.indexOf(id) !== -1) return SIDE.PRODUCTS;
    if (SERVICE_ROUTE_IDS.indexOf(id) !== -1) return SIDE.SERVICES;
    /* A route the contract declares but this map does not know is
       ACCOUNT-LEVEL — it stays visible. Defaulting an unknown route to a
       commercial side would make a new route disappear for merchants the day
       it was added, which is the opposite of what the projection is for. */
    return null;
  }

  /**
   * Decide one contract route against a resolved nav.
   * @returns {{ visible:boolean, usable:boolean, reason:string|null, side:string|null }}
   */
  function decideRoute(route, nav) {
    const side = sideOfRoute(route);
    if (!side) return { visible: true, usable: true, reason: null, side: null };

    const owners = side === 'both'
      ? [nav && nav.products, nav && nav.services]
      : [nav && nav[side]];
    const known = owners.filter(Boolean);
    if (!known.length) return { visible: false, usable: false, reason: null, side };

    const visible = known.some((o) => o.approved);
    const usable  = known.some((o) => o.usable);
    let reason = null;
    if (!usable) {
      const rel = known.find((o) => o.approved) || known[0];
      reason = rel ? rel.reason : null;
    }
    return { visible, usable, reason, side };
  }

  /**
   * Filter a list of contract routes. Returns the routes to render, each
   * annotated — the shell decides how to PAINT a restricted route, never
   * whether it is restricted.
   */
  function filterContractRoutes(routes, nav) {
    return (routes || [])
      .map((r) => Object.assign({ route: r }, decideRoute(r, nav)))
      .filter((x) => x.visible);
  }

  return {
    SIDE, SECTIONS, LIVE_SUB,
    PRODUCT_ROUTE_IDS, SERVICE_ROUTE_IDS, SHARED_ROUTE_IDS,
    subLive, sideState, resolveNav, canOpen, whyBlocked,
    creatableKinds, subscriptionCards,
    sideOfRoute, decideRoute, filterContractRoutes,
  };
}));
