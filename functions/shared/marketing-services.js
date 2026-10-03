'use strict';
/**
 * Marketing services on the ONE provider-services authority (Marketing Hub MK4, owner brief 2026-10-03).
 *
 * There is no Marketing service collection. A marketing service IS a providerServices document written by the canonical
 * providerAddService / providerUpdateService ops; this module only decides whether a marketing category is allowed and
 * shapes the marketing-specific fields. PURE (no Firestore): the caller passes the provider's registry record.
 *
 *   category      a taxonomy id (functions/shared/marketing-taxonomy.js) that is IN providers/{uid}.marketingCategories —
 *                 the admin-approved subset — while marketingStatus === 'active' and marketingListed === true.
 *                 Anything else is refused (MKT_SERVICE_NOT_APPROVED). The browser cannot widen it.
 *   hub           'marketing' — written by the SERVER from the category, never from the request. Booking snapshots it
 *                 (serviceHub / serviceCategory) so commission follows the BOOKED SERVICE, never the provider.
 *   marketing     { pricingModel, deliverables, minPriceCents, leadTimeDays, serviceArea, remote, capabilities }
 *                 capabilities.booking  — direct booking allowed (fixed / hourly pricing only)
 *                 capabilities.quote    — request-a-quote allowed (always, unless the provider switches it off)
 *                 capabilities.campaign / project — the service can be part of a campaign / project (no fee: unpriced)
 */
const MKT = require('./marketing-taxonomy');

const PRICING_MODELS = Object.freeze(['fixed', 'hourly', 'project', 'quote']);
const DEFAULT_MODEL = { booking: 'fixed', quote: 'quote', project: 'project' };

class MarketingServiceError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const _s = (v, max) => (v == null ? '' : String(v).replace(/[<>]/g, '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max));
const _cents = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n > 0 ? Math.min(n, 1e11) : 0; };

/** Is THIS provider approved to sell THIS marketing category right now? */
function approvedFor(provider, category) {
  return !!(provider && provider.marketingStatus === 'active' && provider.marketingListed === true
    && Array.isArray(provider.marketingCategories) && provider.marketingCategories.indexOf(category) >= 0);
}

/** True when a create/update concerns the Marketing hub (a taxonomy category, or an existing marketing service). */
function isMarketing(input, existing) {
  const cat = input && input.category !== undefined ? String(input.category || '').trim().toLowerCase() : null;
  return (cat !== null && MKT.isArea(cat)) || !!(existing && existing.hub === 'marketing');
}

/**
 * Shape the marketing fields for a create (existing = null) or an update (existing = the current service doc).
 * Throws MarketingServiceError; returns { hub, category, serviceGroup, marketing }.
 */
function shape(input, provider, existing) {
  const d = input || {};
  const prev = (existing && existing.marketing) || {};
  const category = d.category !== undefined ? String(d.category || '').trim().toLowerCase() : String((existing && existing.category) || '');
  if (existing && existing.hub === 'marketing' && !MKT.isArea(category)) {
    throw new MarketingServiceError('MKT_HUB_LOCKED', 'A marketing service stays in a marketing category. Create a separate service for other work.');
  }
  if (!MKT.isArea(category)) throw new MarketingServiceError('MKT_UNKNOWN_CATEGORY', 'Choose one of the SOKONI marketing services.');
  if (!approvedFor(provider, category)) {
    throw new MarketingServiceError('MKT_SERVICE_NOT_APPROVED', 'You are not approved for "' + MKT.AREA[category].label + '". Ask SOKONI to review it before listing it.');
  }
  const pick = (k, fb) => (d[k] !== undefined ? d[k] : (prev[k] !== undefined ? prev[k] : fb));
  const modelIn = String(pick('pricingModel', DEFAULT_MODEL[MKT.AREA[category].model] || 'quote'));
  if (PRICING_MODELS.indexOf(modelIn) < 0) throw new MarketingServiceError('MKT_PRICING_MODEL', 'Pricing must be fixed, hourly, project or quote.');
  const capsIn = Object.assign({}, prev.capabilities || {}, (d.capabilities && typeof d.capabilities === 'object') ? d.capabilities : {});
  const deliverables = (Array.isArray(pick('deliverables', [])) ? pick('deliverables', []) : []).map((x) => _s(x, 200)).filter(Boolean).slice(0, 12);
  const leadTime = Math.round(Number(pick('leadTimeDays', 0)));
  const capabilities = {
    /* a direct booking needs a server price: only fixed / hourly services can be booked without a quote */
    booking: (modelIn === 'fixed' || modelIn === 'hourly') && capsIn.booking !== false,
    quote: capsIn.quote !== false || !(modelIn === 'fixed' || modelIn === 'hourly'),
    campaign: capsIn.campaign === true,
    project: capsIn.project === true || modelIn === 'project',
  };
  return {
    hub: 'marketing',
    category,
    serviceGroup: MKT.groupOf(category),
    marketing: {
      pricingModel: modelIn,
      deliverables,
      minPriceCents: _cents(pick('minPriceCents', 0)),
      leadTimeDays: Number.isFinite(leadTime) ? Math.max(0, Math.min(leadTime, 365)) : 0,
      serviceArea: _s(pick('serviceArea', ''), 120),
      remote: pick('remote', false) === true,
      capabilities,
    },
  };
}

/** The immutable service snapshot a booking/quote carries (commission + history read THIS, never the live service). */
function bookingSnapshot(svc) {
  const m = (svc && svc.marketing) || {};
  return {
    serviceHub: svc && svc.hub === 'marketing' ? 'marketing' : (svc && svc.hub ? String(svc.hub).slice(0, 40) : null),
    serviceCategory: svc && svc.category ? String(svc.category).slice(0, 120) : null,
    serviceSnapshot: {
      name: svc && svc.name ? String(svc.name).slice(0, 200) : '',
      category: svc && svc.category ? String(svc.category).slice(0, 120) : null,
      serviceGroup: svc && svc.serviceGroup ? String(svc.serviceGroup).slice(0, 40) : null,
      hub: svc && svc.hub ? String(svc.hub).slice(0, 40) : null,
      pricingModel: m.pricingModel || null,
      deliverables: Array.isArray(m.deliverables) ? m.deliverables.slice(0, 12) : [],
    },
  };
}

module.exports = { PRICING_MODELS, MarketingServiceError, approvedFor, isMarketing, shape, bookingSnapshot };
