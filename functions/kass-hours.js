'use strict';
/**
 * KASS › "Is it open?" — the ONE shop availability authority, never inference (2026-09-29, availability A2).
 *
 * KASS answers opening hours ONLY from the evaluator the storefront uses (functions/shared/shop-hours.js via
 * kasshop.verdictFor) and in its words (headline). Never from free text, search snippets, cached text or its own
 * reasoning. Two refusals keep it honest:
 *   · a business the public may not see (shop discovery gate / provider directory gate) → no hours at all;
 *   · a business that has not published hours on SOKONI → "hasn't published hours", never a guessed "open".
 */
const HOURS = require('./shared/shop-hours');

async function businessHours(db, businessId, atMs) {
  const id = String(businessId == null ? '' : businessId).trim();
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(id)) return { known: false, message: 'I need a business from the search results to check its hours.' };
  const [shopSnap, provSnap, avSnap] = await Promise.all([
    db.collection('shops').doc(id).get(),
    db.collection('providers').doc(id).get(),
    db.collection('providerAvailability').doc(id).get(),
  ]);
  const BC = require('./business-category');
  const shop = shopSnap.exists ? (shopSnap.data() || {}) : null;
  const prov = provSnap.exists ? (provSnap.data() || {}) : null;
  const visible = (shop && BC.shopEligibility(shop).eligible) || (prov && BC.publicEligibility(prov).eligible);
  if (!visible) return { known: false, message: "That business isn't publicly listed on SOKONI, so I can't share its hours." };
  const av = avSnap.exists ? (avSnap.data() || {}) : null;
  const v = require('./kasshop').verdictFor(shop || {}, av, typeof atMs === 'number' ? atMs : Date.now());
  if (v.reason === 'no_schedule' && !(shop && (shop.temporaryClosure || shop.availabilityMode === 'appointment'))) {
    return { known: false, message: "This business hasn't published opening hours on SOKONI yet — message them to check." };
  }
  const hl = HOURS.headline(v);
  return {
    known: true, status: v.status, headline: hl.title, detail: hl.detail || null,
    today: HOURS.periodsText(v.today), timezone: v.timezone,
    delivery: HOURS.channelText(v, 'delivery'), pickup: HOURS.channelText(v, 'pickup'),
    source: 'SOKONI availability (the same answer the shop page shows)',
  };
}

module.exports = { businessHours };
