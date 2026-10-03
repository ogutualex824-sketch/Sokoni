'use strict';
/**
 * THE Marketing authority — who may sell which marketing service, RIGHT NOW (security, 2026-10-03).
 *
 * providers/{uid}.marketing* and applications/{id}.marketingApprovedCategories are written by the server projection, but
 * the SERVED rules let their owner write them too (the same class as the P0 forged approval). So neither is trusted
 * alone. Truth = the server-only decision record applicationDecisions/marketing_{uid} (written by applicationDecide; no
 * client rule), which carries the approved subset:
 *
 *   active      record.status === 'approved' AND provider.marketingStatus === 'active' AND marketingListed === true
 *   categories  provider.marketingCategories ∩ record.approvedCategories      (never more than the admin approved)
 *
 * FAIL CLOSED: no record, a non-approved record, or a record without approvedCategories ⇒ not a marketer.
 * Every marketing check (service editor, booking gate, Work engine, workspace answer, directory) calls THIS.
 */
const APP_ID = (uid) => 'marketing_' + uid;

function decide(provider, record) {
  const p = provider || {}, r = record || null;
  if (!r) return { active: false, categories: [], type: null, why: 'no_decision_record' };
  if (r.status !== 'approved') return { active: false, categories: [], type: null, why: 'decision_not_approved' };
  if (!Array.isArray(r.approvedCategories) || !r.approvedCategories.length) return { active: false, categories: [], type: null, why: 'record_without_categories' };
  const mine = Array.isArray(p.marketingCategories) ? p.marketingCategories : [];
  const categories = mine.filter((c) => r.approvedCategories.indexOf(c) >= 0);
  const live = p.marketingStatus === 'active' && p.marketingListed === true;
  return { active: live && categories.length > 0, categories: live ? categories : [], type: p.marketingType || null, why: live ? (categories.length ? 'ok' : 'no_approved_category') : 'listing_not_active' };
}

/** Reads providers/{uid} (unless given) + the decision record; returns the derived authority. */
async function marketingAuthority(db, uid, providerData) {
  const [p, rec] = await Promise.all([
    providerData !== undefined ? Promise.resolve(providerData) : db.collection('providers').doc(String(uid)).get().then((s) => (s.exists ? s.data() : null)),
    db.collection('applicationDecisions').doc(APP_ID(String(uid))).get().then((s) => (s.exists ? s.data() : null)),
  ]);
  return decide(p, rec);
}

/** A provider view whose marketing fields are REPLACED by the derived authority — for pure checks that take a provider. */
function effectiveProvider(provider, auth) {
  return Object.assign({}, provider || {}, {
    marketingStatus: auth.active ? 'active' : 'inactive',
    marketingListed: auth.active,
    marketingCategories: auth.categories,
  });
}

module.exports = { APP_ID, decide, marketingAuthority, effectiveProvider };
