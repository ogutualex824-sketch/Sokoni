/* ════════════════════════════════════════════════════════════════════════════
   SOKONI Merchant Campaigns — the client layer under Marketing (2D-2 step 3)

   Reaches only the authorities the Marketing census classified SAFE:

       createMinishopCampaign   shop-scoped   create a trackable campaign link
       getMinishopCampaigns     shop-scoped   list this shop's campaigns
       pauseMinishopCampaign    shop-scoped   pause / resume        (hardened)
       deleteMinishopCampaign   shop-scoped   destroy               (hardened)
       miniShopCreatePromotion  shop-scoped   create a promotion
       miniShopGetPromotions    public read   ACTIVE promotions only
       miniShopUpdatePromotion  shop-scoped   pause / activate / delete
       createAdCampaign         ACCOUNT-scoped — see below

   No Firestore access of any kind. No localStorage business state.

   ── Two honesty rules this layer enforces, not the surface ──────────────────

   1. ORDERS AND ROI ARE NOT BUSINESS METRICS HERE. `getMinishopCampaigns`
      returns `orders`, `revenue` and a derived `roi`, and they are stripped out
      by `listCampaigns()` before the surface ever sees them. The counters are
      incremented by `trackCampaignClick`, an unauthenticated onRequest endpoint
      that accepts `campaignId` and `event` from any caller (rate-limited to 10
      per IP per hour). Clicks and views survive as TRAFFIC, which is what they
      honestly are; orders and return-on-investment do not, because presenting a
      figure an anonymous caller can inflate as a business result is exactly the
      fabricated metric the platform rule forbids.

      Dropping them here rather than in the surface means no future screen can
      pick them up by accident.

   2. ADS ARE ACCOUNT-SCOPED, AND SAY SO. `createAdCampaign` writes `sokoAds`
      with `sellerUid` and no `shopId`, and BOTH readers query by status alone —
      there is no shop scoping anywhere in the path. Attaching a `shopId` here
      would manufacture the appearance of shop scoping with none of the
      behaviour. `adScope()` returns the honest answer so the surface can label
      it, and the payload carries no shop.
   ════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SokoniMerchantCampaigns = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CALLABLES = {
    createCampaign: 'createMinishopCampaign',
    listCampaigns: 'getMinishopCampaigns',
    pauseCampaign: 'pauseMinishopCampaign',
    deleteCampaign: 'deleteMinishopCampaign',
    createPromotion: 'miniShopCreatePromotion',
    listPromotions: 'miniShopGetPromotions',
    updatePromotion: 'miniShopUpdatePromotion',
    createAd: 'createAdCampaign',
  };

  /* Mirrors CAMPAIGN_TYPES in functions/minishop-campaigns.js. */
  var CAMPAIGN_TYPES = [
    { id: 'weekend-sale',   label: 'Weekend sale' },
    { id: 'flash-sale',     label: 'Flash sale' },
    { id: 'holiday',        label: 'Holiday' },
    { id: 'new-arrivals',   label: 'New arrivals' },
    { id: 'back-to-school', label: 'Back to school' },
    { id: 'black-friday',   label: 'Black Friday' },
    { id: 'referral',       label: 'Referral' },
    { id: 'custom',         label: 'Something else' },
  ];
  /* Mirrors minishop-v3.js promotion types. */
  var PROMO_TYPES = [
    { id: 'flash_sale', label: 'Flash sale',  hint: 'A short, sharp discount' },
    { id: 'bundle',     label: 'Bundle',      hint: 'Buy together, pay less' },
    { id: 'coupon',     label: 'Coupon code', hint: 'A code shoppers type at checkout' },
    { id: 'seasonal',   label: 'Seasonal',    hint: 'Tied to a time of year' },
  ];

  /* Capabilities the backend cannot honestly support yet. The surface renders
     these as "not available yet" rather than as a button that fails. */
  var UNAVAILABLE = [
    { id: 'bundles',   label: 'Bundle deals',
      why: 'The bundle authority exists but is not deployed, and it trusts a merchant id supplied by the caller.' },
    { id: 'abtests',   label: 'A/B tests',
      why: 'Same engine, same two problems.' },
    { id: 'coupons_engine', label: 'Platform coupon codes',
      why: 'The engine coupon path is not deployed. Shop promotions with a code work and are above.' },
    { id: 'conversions', label: 'Orders & ROI per campaign',
      why: 'Campaign conversions are counted by an endpoint that needs no sign-in, so the figures cannot be trusted as business results yet.' },
  ];

  function requireScope(scope) {
    if (!scope || !scope.ok) throw new Error('merchant campaigns: a resolved shop scope is required');
    return scope;
  }

  function _unwrap(res) { return (res && res.data) ? res.data : res; }

  async function _call(fn, payload, failMessage) {
    if (typeof fn !== 'function') throw new Error('merchant campaigns: callable is required');
    try {
      var d = _unwrap(await fn(payload));
      if (d && d.ok === false) return { ok: false, error: d.error || failMessage };
      return Object.assign({ ok: true }, d || {});
    } catch (e) {
      return { ok: false, error: (e && e.message) || failMessage, code: (e && e.code) || null };
    }
  }

  /* ── Campaigns ────────────────────────────────────────────────────────────
     TRAFFIC ONLY. `orders`, `revenue` and `roi` are dropped here and never
     reach a caller — see rule 1 in the header. */
  function projectCampaign(c) {
    return {
      campaignId: c.campaignId,
      name: c.name || '',
      type: c.type || 'custom',
      status: c.status || 'active',
      campaignUrl: c.campaignUrl || null,
      clicks: (typeof c.clicks === 'number') ? c.clicks : null,
      views: (typeof c.views === 'number') ? c.views : null,
      createdAt: c.createdAt || null,
      endsAt: c.endsAt || null,
    };
  }

  async function listCampaigns(o) {
    var scope = requireScope(o.scope);
    var r = await _call(o.callList, { shopId: scope.shopId }, 'Your campaigns could not be loaded.');
    if (!r.ok) return r;
    var rows = (r.campaigns || []).map(projectCampaign);
    /* Newest first — the server already sorts, but a client that depends on the
       server's ordering silently reorders the day the server stops. */
    rows.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    return { ok: true, campaigns: rows, count: rows.length };
  }

  function buildCampaign(o) {
    var scope = requireScope(o.scope);
    var name = String(o.name == null ? '' : o.name).trim();
    if (name.length < 2) throw new Error('Give the campaign a name (at least 2 characters).');
    var type = String(o.type || 'custom');
    if (!CAMPAIGN_TYPES.some(function (t) { return t.id === type; })) throw new Error('Choose a campaign type.');
    var p = { shopId: scope.shopId, name: name, type: type };
    if (o.description) p.description = String(o.description).slice(0, 500);
    if (o.endsAt) p.endsAt = Number(o.endsAt);
    return p;
  }

  async function createCampaign(o) {
    return _call(o.callCreate, buildCampaign(o), 'The campaign could not be created.');
  }

  async function setCampaignPaused(o) {
    if (!o.campaignId) throw new Error('merchant campaigns: campaignId is required');
    return _call(o.callPause, { campaignId: String(o.campaignId), pause: o.pause !== false },
      'The campaign could not be updated.');
  }

  async function deleteCampaign(o) {
    if (!o.campaignId) throw new Error('merchant campaigns: campaignId is required');
    return _call(o.callDelete, { campaignId: String(o.campaignId) }, 'The campaign could not be deleted.');
  }

  /* ── Promotions ───────────────────────────────────────────────────────────
     `miniShopGetPromotions` is the PUBLIC storefront read: it returns active,
     unexpired promotions only. A merchant therefore cannot see paused or expired
     ones through it. `listPromotions` reports that limit rather than letting a
     screen imply the list is complete. */
  async function listPromotions(o) {
    var scope = requireScope(o.scope);
    var r = await _call(o.callPromos, { shopId: scope.shopId }, 'Your promotions could not be loaded.');
    if (!r.ok) return r;
    return {
      ok: true,
      promotions: r.promotions || [],
      count: (r.promotions || []).length,
      /* The caller must be able to say so on screen. */
      activeOnly: true,
    };
  }

  function buildPromotion(o) {
    var scope = requireScope(o.scope);
    var title = String(o.title == null ? '' : o.title).trim();
    if (title.length < 2) throw new Error('Give the promotion a title (at least 2 characters).');
    var type = String(o.type || '');
    if (!PROMO_TYPES.some(function (t) { return t.id === type; })) throw new Error('Choose a promotion type.');
    var discountType = (o.discountType === 'fixed') ? 'fixed' : 'percent';
    var value = Number(o.discountValue);
    if (!isFinite(value) || value <= 0) throw new Error('Enter a discount greater than zero.');
    if (discountType === 'percent' && value > 100) throw new Error('A percentage discount cannot exceed 100%.');
    if (!o.validUntil) throw new Error('Choose when the promotion ends.');
    var p = {
      shopId: scope.shopId, type: type, title: title,
      discountType: discountType, discountValue: value,
      validUntil: new Date(o.validUntil).toISOString(),
    };
    if (o.description) p.description = String(o.description).slice(0, 500);
    if (o.code) p.code = String(o.code).toUpperCase().slice(0, 20);
    return p;
  }

  async function createPromotion(o) {
    return _call(o.callCreatePromo, buildPromotion(o), 'The promotion could not be created.');
  }

  async function updatePromotion(o) {
    if (!o.promoId) throw new Error('merchant campaigns: promoId is required');
    var action = String(o.action || '');
    if (['pause', 'activate', 'delete'].indexOf(action) === -1) {
      throw new Error('merchant campaigns: action must be pause, activate or delete');
    }
    return _call(o.callUpdatePromo, { promoId: String(o.promoId), action: action },
      'The promotion could not be updated.');
  }

  /* ── Ads — ACCOUNT scope, stated ──────────────────────────────────────────
     No shopId in the payload, because nothing in the sokoAds path reads one. */
  function adScope() {
    return {
      level: 'account',
      label: 'SOKONI Ads — Account campaigns',
      note: 'Ads belong to your SOKONI account, not to one shop. They run across the ' +
            'marketplace and are reviewed before they go live.',
    };
  }

  function buildAd(o) {
    var title = String(o.title == null ? '' : o.title).trim();
    if (title.length < 2) throw new Error('Give the ad a title.');
    var budget = Number(o.budgetKES);
    /* The server accepts any truthy budget, including a negative. Refusing an
       impossible one here is a courtesy, not the authority — a caller that
       bypasses this screen is still the server's problem, and this comment
       exists so nobody mistakes the check for enforcement. */
    if (!isFinite(budget) || budget <= 0) throw new Error('Enter a budget greater than zero.');
    var p = { adType: String(o.adType || 'product'), title: title, budgetKES: budget };
    if (o.description) p.description = String(o.description).slice(0, 500);
    if (o.ctaUrl) p.ctaUrl = String(o.ctaUrl);
    if (o.imageUrl) p.imageUrl = String(o.imageUrl);
    if (o.targetHub) p.targetHub = String(o.targetHub);
    return p;
  }

  async function createAd(o) {
    return _call(o.callCreateAd, buildAd(o), 'The ad could not be created.');
  }

  /* ── Display ──────────────────────────────────────────────────────────────
     A count that is genuinely unknown renders as an em dash, never as 0. */
  function formatCount(n) {
    if (n == null || (typeof n === 'number' && !isFinite(n))) return '—';
    return Number(n).toLocaleString('en-KE');
  }

  function typeLabel(id) {
    for (var i = 0; i < CAMPAIGN_TYPES.length; i++) if (CAMPAIGN_TYPES[i].id === id) return CAMPAIGN_TYPES[i].label;
    return id || '—';
  }

  return {
    CALLABLES: CALLABLES,
    CAMPAIGN_TYPES: CAMPAIGN_TYPES,
    PROMO_TYPES: PROMO_TYPES,
    UNAVAILABLE: UNAVAILABLE,
    projectCampaign: projectCampaign,
    listCampaigns: listCampaigns,
    buildCampaign: buildCampaign,
    createCampaign: createCampaign,
    setCampaignPaused: setCampaignPaused,
    deleteCampaign: deleteCampaign,
    listPromotions: listPromotions,
    buildPromotion: buildPromotion,
    createPromotion: createPromotion,
    updatePromotion: updatePromotion,
    adScope: adScope,
    buildAd: buildAd,
    createAd: createAd,
    formatCount: formatCount,
    typeLabel: typeLabel,
  };
}));
