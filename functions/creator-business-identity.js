'use strict';

/**
 * SOKONI CREATOR BUSINESS IDENTITY
 * ────────────────────────────────────────────────────────────────────────────
 * A creator is a person. A creator business is a trader. They are not the same thing, and
 * the money they hold is not the same money.
 *
 * When somebody buys a film, the price is a trading receipt: the platform takes a
 * commission and the rest is the creator's TAKINGS. Takings belong in
 * `businessWallets/{businessId}` with every other trader's, and reach the creator's own
 * pocket the same way a shopkeeper's do — `businessWalletDraw` into the personal wallet,
 * where the frozen B2C payout rail withdraws them. That last hop is untouched here.
 *
 * The same person may also BUY things. That money is theirs personally, sits in
 * `wallets/{uid}`, and has nothing to do with their content business. Letting the two meet
 * is how a platform ends up unable to say whether a balance is a refund it owes a customer
 * or a payout it owes a trader.
 *
 * ── NOTHING NEW IS INVENTED HERE ─────────────────────────────────────────────
 * There is exactly one business-identity architecture on this platform, and this module
 * consumes it rather than adding a second:
 *
 *   provisioning  business-bootstrap._ensureBusinessForOwner   (idempotent, claim-guarded)
 *   resolution    tenant-identity.resolveMerchantIdForOwner    (ownerId, refuses ambiguity)
 *   money         business-wallet.credit / assertNotUidShaped  (minor units, deterministic)
 *
 * A creator-specific copy of any of those would be a second answer to "who is this trader",
 * and two answers is the failure. What is creator-specific is only the AUTHORIZATION —
 * who may bring a creator business into existence — and that lives here.
 *
 * ── ONE BUSINESS PER PERSON, DELIBERATELY ────────────────────────────────────
 * `_ensureBusinessForOwner` short-circuits on `ownerId == uid`, so a shopkeeper who also
 * publishes a documentary does not get a second business: their PPV takings land in the
 * business they already trade through. That is the correct answer, not a limitation.
 * The separation this module exists to enforce is person-vs-business, not
 * content-vs-groceries, and splitting one trader into two ledgers would make their
 * commission ladder, their payouts and their tax position unreconcilable.
 */

const admin = require('firebase-admin');
const BW = require('./business-wallet');

const REASON = Object.freeze({
  NO_CREATOR:        'NO_CREATOR',
  NO_ACTOR:          'NO_ACTOR',
  NOT_SELF:          'NOT_SELF',
  ROLE_TOO_LOW:      'ROLE_TOO_LOW',
  NO_CREATOR_BUSINESS: 'NO_CREATOR_BUSINESS',
  UID_SHAPED_BUSINESS: 'UID_SHAPED_BUSINESS',
  CLIENT_SUPPLIED:   'CLIENT_SUPPLIED',
});

/** The claim tier that may publish content, and therefore may trade as a creator. */
const CREATOR_MIN_ROLE = 2;
/** The tier that may act on somebody else's behalf. */
const ADMIN_MIN_ROLE = 4;

function refuse(reason, detail) {
  return { ok: false, reason, detail: detail == null ? null : detail };
}

/* ── WHAT A BROWSER MAY NEVER NAME ────────────────────────────────────────────
 * A destination the caller chose is a destination the caller can point at somebody else.
 * Every one of these is resolved server-side from the creator's uid, and a request that
 * carries one is refused rather than cleaned — silently dropping a field teaches the
 * caller that sending it is harmless.
 *
 * Kept as data so the guard below and the certification suite read the SAME list; a
 * hand-maintained second copy is how a name gets protected in one place only. */
const CLIENT_MAY_NOT_NAME = Object.freeze([
  'businessId', 'merchantId', 'walletId', 'destinationWallet',
  'creatorWallet', 'payoutTo', 'sellerId', 'ownerId',
]);

/**
 * Refuse a request that tried to choose where creator money goes.
 * Returns null when clean, a refusal when not.
 */
function rejectClientDestination(payload) {
  const p = payload || {};
  for (let i = 0; i < CLIENT_MAY_NOT_NAME.length; i++) {
    const k = CLIENT_MAY_NOT_NAME[i];
    if (Object.prototype.hasOwnProperty.call(p, k) && p[k] != null && p[k] !== '') {
      return refuse(REASON.CLIENT_SUPPLIED, k);
    }
  }
  return null;
}

/**
 * MAY THIS ACTOR BRING THIS CREATOR'S BUSINESS INTO EXISTENCE?
 *
 * Two answers only:
 *   a creator, for themselves, holding the publishing role;
 *   an admin, for a named creator.
 *
 * One creator provisioning another is refused even between two legitimate creators —
 * creating a trading identity for somebody is an act performed in their name, and a
 * platform that allows it cannot later say who agreed to what.
 */
function assertMayProvision(o) {
  const i = o || {};
  const actorUid = String(i.actorUid || '').trim();
  const creatorUid = String(i.creatorUid || '').trim();
  const role = Number(i.actorRole || 0);

  if (!creatorUid) return refuse(REASON.NO_CREATOR);
  if (!actorUid) return refuse(REASON.NO_ACTOR);

  if (role >= ADMIN_MIN_ROLE) return { ok: true, by: 'admin' };

  if (actorUid !== creatorUid) return refuse(REASON.NOT_SELF, actorUid);
  if (role < CREATOR_MIN_ROLE) return refuse(REASON.ROLE_TOO_LOW, String(role));

  return { ok: true, by: 'self' };
}

/**
 * THE CREATOR'S BUSINESS, RESOLVED FROM THEIR UID — never from anything a caller sent.
 *
 * This is the only question any creator-money rail may ask, and the only way it may ask it.
 */
async function resolveCreatorBusiness(creatorUid, db) {
  const uid = String(creatorUid || '').trim();
  if (!uid) return refuse(REASON.NO_CREATOR);

  let merchantId = null;
  try {
    const { resolveMerchantIdForOwner } = require('./tenant-identity');
    const r = await resolveMerchantIdForOwner(uid, db || admin.firestore());
    merchantId = r && r.ok ? r.merchantId : null;
    if (!merchantId) return refuse(REASON.NO_CREATOR_BUSINESS, (r && r.reason) || 'no-business-for-owner');
  } catch (e) {
    return refuse(REASON.NO_CREATOR_BUSINESS, (e && e.message) || 'resolution failed');
  }

  /* THE LAST LINE OF DEFENCE. A `businesses` document id can never equal an auth uid —
     every tenant authority on this platform depends on that to tell a person from a
     trader. A resolution that returned one would put takings in the personal keyspace and
     quietly undo the separation this module is for. */
  try {
    BW.assertNotUidShaped(merchantId, uid);
  } catch (_) {
    return refuse(REASON.UID_SHAPED_BUSINESS, String(merchantId));
  }

  return { ok: true, businessId: merchantId };
}

/**
 * Provision the creator's business, if authorized, through the ONE provisioning primitive.
 *
 * Idempotent because `_ensureBusinessForOwner` is: an owner who already has a business
 * gets `already-provisioned` and their existing id, and no existing record is ever
 * repaired, renamed or re-pointed by this call.
 */
async function ensureCreatorBusiness(o) {
  const i = o || {};

  const dirty = rejectClientDestination(i);
  if (dirty) return dirty;

  const may = assertMayProvision(i);
  if (!may.ok) return may;

  const creatorUid = String(i.creatorUid).trim();

  const bb = require('./business-bootstrap');
  const res = await bb._ensureBusinessForOwner({
    uid: creatorUid,
    businessName: String(i.businessName || '').trim() || 'Creator Studio',
    category: 'Entertainment',
    phone: i.phone || '',
    county: i.county || '',
    city: i.city || '',
  });

  if (!res || !res.merchantId) {
    return refuse(REASON.NO_CREATOR_BUSINESS, (res && res.reason) || 'provisioning-failed');
  }

  /* The same guard the resolver applies, applied to what provisioning just handed back.
     A primitive that returned a uid-shaped id would otherwise be trusted here purely
     because it is ours. */
  try {
    BW.assertNotUidShaped(res.merchantId, creatorUid);
  } catch (_) {
    return refuse(REASON.UID_SHAPED_BUSINESS, String(res.merchantId));
  }

  return {
    ok: true,
    businessId: res.merchantId,
    created: res.created === true,
    reason: res.reason || null,
    authorizedBy: may.by,
  };
}

module.exports = {
  REASON,
  CREATOR_MIN_ROLE,
  ADMIN_MIN_ROLE,
  CLIENT_MAY_NOT_NAME,
  rejectClientDestination,
  assertMayProvision,
  resolveCreatorBusiness,
  ensureCreatorBusiness,
};
