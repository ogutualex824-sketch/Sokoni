'use strict';
/**
 * Marketing authority — a THIN ADAPTER over THE approval authority (5b P0-C, shared/approval-authority.js
 * isAuthoritativelyApproved). Owner rule (2026-10-03): Marketing consumes ONLY that predicate — no Marketing-local
 * interpretation of approval, no record re-read, no fallback.
 *
 *   approval    isAuthoritativelyApproved(db, 'marketing_' + uid, { getUser })  — decision record, application, admin
 *               decider, not self-decided, not revoked, provider active, account not frozen (all decided THERE)
 *   categories  provider.marketingCategories ∩ approval.approvedCategories   (the predicate's set; never more)
 *   listed      providers.marketingStatus === 'active' && marketingListed === true — LISTING state, not approval
 *
 * FAIL CLOSED: any refusal reason, or an approval without approvedCategories, ⇒ not a marketer.
 * Every marketing check (service editor, booking gate, Work engine, workspace answer, directory) calls THIS.
 */
const AUTH = require('./approval-authority');
const APP_ID = (uid) => 'marketing_' + uid;

function _getUser(uid) { return require('firebase-admin/auth').getAuth().getUser(uid); }

/** Combine the predicate's verdict with the provider listing. Pure. */
function combine(provider, verdict) {
  const p = provider || {}, v = verdict || {};
  if (!v.approved) return { active: false, categories: [], type: null, why: v.reason || 'NOT_APPROVED' };
  if (!Array.isArray(v.approvedCategories) || !v.approvedCategories.length) return { active: false, categories: [], type: null, why: 'NO_APPROVED_CATEGORIES' };
  const mine = Array.isArray(p.marketingCategories) ? p.marketingCategories : [];
  const categories = mine.filter((c) => v.approvedCategories.indexOf(c) >= 0);
  const live = p.marketingStatus === 'active' && p.marketingListed === true;
  return { active: live && categories.length > 0, categories: live ? categories : [], type: p.marketingType || null, why: live ? (categories.length ? 'APPROVED' : 'NO_APPROVED_CATEGORY') : 'LISTING_NOT_ACTIVE' };
}

/** Reads providers/{uid} (unless given) and asks THE predicate; returns the derived Marketing authority. */
async function marketingAuthority(db, uid, providerData, opts) {
  const [p, v] = await Promise.all([
    providerData !== undefined ? Promise.resolve(providerData) : db.collection('providers').doc(String(uid)).get().then((s) => (s.exists ? s.data() : null)),
    AUTH.isAuthoritativelyApproved(db, APP_ID(String(uid)), { getUser: (opts && opts.getUser) || _getUser }),
  ]);
  return combine(p, v);
}

/** A provider view whose marketing fields are REPLACED by the derived authority — for pure checks that take a provider. */
function effectiveProvider(provider, auth) {
  return Object.assign({}, provider || {}, {
    marketingStatus: auth.active ? 'active' : 'inactive',
    marketingListed: auth.active,
    marketingCategories: auth.categories,
  });
}

module.exports = { APP_ID, combine, marketingAuthority, effectiveProvider };
