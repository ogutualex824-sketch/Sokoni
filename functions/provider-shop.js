'use strict';
/**
 * SOKONI — a Healthcare provider REQUESTS a merchant Shop.
 * ============================================================================================
 * A clinic that wants to sell products over the counter needs the merchant stack: a shop, a
 * Till, inventory, orders, receipts. SOKONI already has all of it. This module does not build
 * a healthcare variant of any of it — it provisions the SAME `shops/{shopId}` +
 * `sellers/{uid}` + `businesses/{uid}` projection that merchant approval provisions, through
 * the same function, so a healthcare shop and a marketplace shop are the same object.
 *
 * ── WHY ON REQUEST, AND NOT AUTOMATICALLY ──────────────────────────────────────────────────
 * `projectSeller` writes into DISCOVERY collections: `sellers` and `businesses` are what the
 * marketplace directory and store.html read. Provisioning one for every approved healthcare
 * provider would put every solo GP into the seller directory as an empty storefront. A shop
 * should exist because somebody wants to sell, not because they were approved to practise.
 *
 * ── WHY NOT PRICED BY TIER ─────────────────────────────────────────────────────────────────
 * A shop is an IDENTITY, not a capability. Tying its creation to a tier would mean a downgrade
 * has to revoke a merchant identity and orphan its Till, inventory, orders and transaction
 * history. Identity that lapses on a billing event is the wrong shape, so `shopRequestable` is
 * true on ALL THREE healthcare tiers — it gates the request, never the survival of what the
 * request created. Nothing in this module deletes a shop, and nothing anywhere reacts to a
 * downgrade by touching one.
 *
 * ── THE AUTHORITY THIS DOES AND DOES NOT MOVE ──────────────────────────────────────────────
 * OB-1 closed a self-service bypass where completing a wizard published a provider. This is
 * deliberately not that: the request is honoured ONLY for a provider whose canonical registry
 * record is already ACTIVE — i.e. an admin has already decided their application. The admin
 * decision is the authority; this is the provider opting into a surface that decision already
 * covers. A provider who is pending, suspended or absent is refused.
 *
 * It does grant the seller role, because a shop nobody may operate is not a shop — and it does
 * so through the canonical `grantAccountRole`, never a bespoke claim write. That is an
 * authority extension and is called out here rather than buried: if merchant capability for
 * healthcare providers should instead require a separate admin decision, this is the single
 * line to change.
 */

const { HttpsError } = require('firebase-functions/v2/https');
const { getFirestore } = require('firebase-admin/firestore');
const logger = require('firebase-functions/logger');

const _db = () => getFirestore();

const _san = (v, n = 200) => String(v == null ? '' : v).slice(0, n).replace(/[<>]/g, '');

function _uid(req) {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required.');
  return uid;
}

/* Provider states that mean "an admin has approved this account". Mirrors
   booking-service's ACTIVE_PROVIDER_STATES so bookability and merchant eligibility cannot
   drift apart. Fail-closed: a missing registry document is NOT eligible. */
const ACTIVE_PROVIDER_STATES = ['active', 'approved'];

/**
 * providerRequestShop — provision the merchant identity for an approved healthcare provider.
 *
 * Idempotent by construction: `projectSeller` uses deterministic ids and merge, so a second
 * request converges on the same shop instead of forking a second one.
 */
async function providerRequestShop(req) {
  const uid = _uid(req);
  const db = _db();

  /* 1 ── The admin decision is the authority. */
  const provSnap = await db.collection('providers').doc(uid).get();
  const prov = provSnap.exists ? provSnap.data() : null;
  if (!prov || !ACTIVE_PROVIDER_STATES.includes(String(prov.status || ''))) {
    throw new HttpsError('failed-precondition',
      'A Shop can only be created for an approved provider account.');
  }

  /* 2 ── The subscription decides whether the request may be made, never whether what it
     creates survives. True on every healthcare tier — this is not an Enterprise gate. */
  const { capabilitiesFor } = require('./capability-authority');
  const cap = await capabilitiesFor(uid, { hub: 'healthcare' });
  if (cap.capabilities.shopRequestable !== true) {
    throw new HttpsError('failed-precondition',
      'An active Healthcare subscription is required to open a Shop.');
  }

  /* 3 ── Already provisioned? Converge, do not fork. */
  /* Note what already exists, but do NOT return early.
     An earlier attempt can have produced a shop whose Till or wallet provisioning failed —
     both are reported-and-continue by design — leaving a storefront that cannot trade. If a
     repeat request short-circuited on "the shop exists", that account could never be repaired
     by asking again, which is the only remedy a provider has.
     Every step below is idempotent (deterministic ids + merge, `onExisting:'return'`,
     ensureBusinessWallet's own existence check), so re-running converges instead of forking. */
  const existingShopId = prov.shopId || uid;
  const existing = await db.collection('shops').doc(String(existingShopId)).get();
  const alreadyExisted = existing.exists && String(existing.data().status || '') === 'active';

  /* 4 ── The SAME projection merchant approval uses. The synthesised application carries only
     what projectSeller reads; it is not written anywhere and does not become an application. */
  const { projectSeller } = require('./application-lifecycle')._internal;
  const app = {
    applicationId: null,
    name:        _san(prov.name || prov.businessName, 160),
    category:    _san(prov.category, 80),
    phoneNumber: _san(prov.phone || prov.phoneNumber, 40),
    location:    _san(prov.location || prov.city, 160),
    description: _san(prov.bio || prov.description, 1000),
  };

  const write = await projectSeller(db, app, uid, true);

  /* 5 ── Canonical role grant. Never a bespoke claim write — two claim writers is a divergence
     this platform has already paid for once. */
  let claim = null;
  try {
    const { grantAccountRole } = require('./role-authority');
    const grant = await grantAccountRole(db, uid, 'seller', true,
      { source: 'providerRequestShop', entityId: uid });
    claim = grant.ok ? 'granted' : 'pending';
  } catch (e) {
    /* The shop exists and is the durable half. A claim that failed to mint is reconcilable;
       undoing a correct projection is not. Reported, never a reason to roll back. */
    logger.error('[providerShop] role grant failed (recoverable)', { uid, error: e.message });
    claim = 'error';
  }

  /* 6 ── THE MERCHANT PREREQUISITES, or the Shop is a storefront that cannot trade.
     A shop alone is not a merchant. POS resolves a Till, and POS/Till commission settles from
     the SHOP's business wallet — never the owner's personal `wallets/{uid}`, which is a
     different collection precisely so the two can never be confused. Provisioning only the
     projection was the pre-deployment blocker: a clinic received a storefront and a seller
     claim, then found POS non-functional.

     These are the SAME two calls `applyDecision` makes after `projectSeller` for a merchant
     approval — `mintSokoniTillCore` and `ensureBusinessWallet`, both canonical, neither
     healthcare-specific. `onExisting: 'return'` is what makes a repeat request converge on the
     same Till instead of minting a second one for the same branch.

     Both are entitlements, not gates. A failure here leaves a real shop and a real seller
     claim in place and is reported for retry; undoing a correct projection because a
     downstream provisioning step failed would be the worse outcome, and it is the same stance
     application-lifecycle takes for the identical calls. */
  let till = null, wallet = null;
  try {
    const { mintSokoniTillCore } = require('./sokoni-till')._internal;
    const t = await mintSokoniTillCore({
      shopId: write.id,
      branchId: `${write.id}-main`,
      actorUid: uid,
      onExisting: 'return',
      source: 'provider_shop_request',
    });
    till = { sokoniTillId: t.sokoniTillId, created: !!t.created };
  } catch (e) {
    logger.error('[providerShop] Till provisioning failed (recoverable)', { uid, shopId: write.id, error: e.message });
    till = { error: String(e.message || e).slice(0, 300) };
  }

  try {
    const { ensureBusinessWallet } = require('./business-wallet');
    const bw = await ensureBusinessWallet(db, { shopId: write.id, ownerUid: uid, currency: 'KES' });
    wallet = { shopId: write.id, action: bw.action };
  } catch (e) {
    logger.error('[providerShop] business wallet provisioning failed (recoverable)', { uid, shopId: write.id, error: e.message });
    wallet = { error: String(e.message || e).slice(0, 300) };
  }

  /* Record the link on the provider record so the two identities can find each other. */
  await db.collection('providers').doc(uid)
    .set({ shopId: write.id, shopRequestedAt: new Date().toISOString() }, { merge: true })
    .catch(() => {});

  return { success: true, shopId: write.id, created: !alreadyExisted, alreadyExisted, claim, till, wallet };
}

module.exports = { providerRequestShop, ACTIVE_PROVIDER_STATES };
