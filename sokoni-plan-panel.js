/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — THE PLAN PANEL
   ══════════════════════════════════════════════════════════════════════════════
   What a merchant sees about their subscription, and nothing they should not.

   A merchant must never have to understand `subscriptions` vs `aiSubscriptions`,
   productCounters, plan aliases or entitlement resolution. Those are internal
   mechanics that exist because the system grew; they are not the merchant's
   problem. This renders ONE resolved entitlement into plain language.

   ── IT COMPUTES NOTHING ─────────────────────────────────────────────────────
   Every figure comes from getMerchantEntitlement(). There is no plan table here,
   no limit constant, and no arithmetic beyond formatting — a client-side plan
   table can never be authoritative, because the device holding it is the party
   the limit applies to. Ten such tables already existed and disagreed.

   ── IT NEVER SHOWS A NUMBER IT DOES NOT HAVE ────────────────────────────────
   When the product count cannot be read, the panel shows `—`, never `0`. A `0`
   would tell a merchant with 23 products that they have none, and would make a
   full shop look empty. An unknown is displayed as unknown.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var STATE = {
    FREE: 'free', TRIAL: 'trial', ACTIVE: 'active',
    GRACE: 'grace', ENDED: 'ended', UNKNOWN: 'unknown',
  };

  function _num (v) { return (typeof v === 'number' && isFinite(v)) ? v : null; }

  /* Which of the six states the merchant is in. Derived from the resolved
     entitlement alone — the panel does not second-guess the server. */
  function stateOf (ent) {
    if (!ent || !ent.plan) return STATE.UNKNOWN;
    var status = String(ent.status || '').toUpperCase();
    var trial = ent.trial || {};
    if (trial.active) return STATE.TRIAL;
    if (status === 'GRACE') return STATE.GRACE;
    if (status === 'ACTIVE') return ent.plan === 'FREE' ? STATE.FREE : STATE.ACTIVE;
    if (status === 'INACTIVE' || status === 'NONE') {
      /* A merchant who once had a trial and no longer does has ENDED, which is a
         different sentence from never having had one. */
      return trial.used ? STATE.ENDED : STATE.FREE;
    }
    return STATE.FREE;
  }

  /* The products line. Returns nulls rather than zeros when the count is
     unknown, so a caller cannot accidentally render a confident 0. */
  function products (ent) {
    var limits = (ent && ent.limits) || {};
    var limit = _num(limits.products);
    var used = _num(limits.productsUsed);
    var unlimited = limit === -1;
    return {
      used: used,
      limit: unlimited ? null : limit,
      unlimited: unlimited,
      /* "23 / 100", "23 / unlimited", or "— / 100" when the count is unreadable. */
      text: (used === null ? '—' : String(used)) + ' / ' + (unlimited ? 'unlimited' : (limit === null ? '—' : String(limit))),
      atLimit: (!unlimited && used !== null && limit !== null && used >= limit),
      remaining: unlimited ? null : (used === null || limit === null ? null : Math.max(0, limit - used)),
      known: used !== null && (unlimited || limit !== null),
    };
  }

  /* ── THE COUNTDOWN ─────────────────────────────────────────────────────────
     Derived from the SERVER's trialEndsAt, never the phone clock — a device
     whose date is wrong must not change how much trial a merchant appears to
     have. And it never says "1 days remaining": a plural where a singular
     belongs is the kind of detail that makes a product feel unfinished. */
  function trialCountdown (trial) {
    var t = trial || {};
    if (!t.active) return t.used ? 'Trial ended' : 'Free plan';
    var n = _num(t.daysRemaining);
    if (n === null) return 'Trial active';
    if (n <= 0) return 'Expires today';
    if (n === 1) return '1 day remaining';
    return n + ' days remaining';
  }

  /* The panel, as a structure. The shell renders it; this decides WHAT it says.
     Every string here is written for a merchant, not for an engineer. */
  function render (ent) {
    var st = stateOf(ent);
    var p = products(ent);
    var label = (ent && ent.label) || 'Free';
    var trial = (ent && ent.trial) || {};

    var head = { FREE: label, TRIAL: label + ' Trial', ACTIVE: label,
                 GRACE: label, ENDED: label, UNKNOWN: 'Your plan' }[st.toUpperCase()] || label;

    var sub = {
      free: 'Free plan',
      trial: trialCountdown(trial),
      active: 'Active',
      grace: 'Payment overdue — your plan is still active',
      ended: 'Trial ended',
      unknown: 'We could not load your plan just now',
    }[st];

    var actions = {
      free: [{ id: 'upgrade', label: 'Upgrade' }],
      trial: [{ id: 'continue', label: 'Continue selling' }, { id: 'upgrade', label: 'Choose a plan' }],
      active: [{ id: 'manage', label: 'Manage subscription' }],
      grace: [{ id: 'pay', label: 'Update payment' }],
      ended: [{ id: 'upgrade', label: 'Choose a plan' }],
      unknown: [{ id: 'retry', label: 'Try again' }],
    }[st];

    /* AT THE LIMIT — the one place the panel changes what a merchant can do, so
       it says the limit AND the way out. "Contact support" is not a way out. */
    var notice = null;
    if (p.atLimit) {
      notice = {
        tone: 'limit',
        text: "You've reached your " + label + ' limit.',
        actions: [{ id: 'manage-products', label: 'Manage products' },
                  { id: 'upgrade', label: 'Upgrade plan' }],
      };
    } else if (!p.known) {
      /* Never a silent zero. */
      notice = { tone: 'unknown', text: 'Your product count could not be loaded.', actions: [] };
    }

    /* Capabilities, in the merchant's words. Absent when the entitlement did not
       say — an unknown capability is omitted, not shown as unavailable. */
    var f = (ent && ent.features) || {};
    var caps = [
      { id: 'online', label: 'Online selling', on: true },
      { id: 'pos', label: 'POS selling', on: true },
      { id: 'inventory', label: 'Inventory', on: true },
      { id: 'messages', label: 'Messages', on: true },
      { id: 'delivery', label: 'Delivery', on: true },
      { id: 'analytics', label: 'Premium analytics', on: !!f.premiumAnalytics },
      { id: 'branches', label: 'Multiple branches', on: !!f.multiBranch },
    ];

    return {
      state: st,
      heading: head,
      subheading: sub,
      products: p,
      notice: notice,
      actions: actions,
      capabilities: caps,
      /* Shown only where it helps the merchant — a plan they bought at a price
         the tier does not list is worth surfacing to THEM, not hiding. */
      purchase: (ent && ent.purchase) || null,
      canAddProduct: !p.atLimit && p.known,
    };
  }

  /* One-line summary for a dashboard tile. */
  function summary (ent) {
    var v = render(ent);
    return v.heading + ' · ' + v.subheading + ' · ' + v.products.text + ' products';
  }

  global.SokoniPlanPanel = { STATE: STATE, stateOf: stateOf, products: products,
                             trialCountdown: trialCountdown,
                             render: render, summary: summary };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).SokoniPlanPanel;
}
