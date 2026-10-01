#!/usr/bin/env node
/**
 * ONE-OFF — name the SOKONI Store's operator. DRY RUN BY DEFAULT.
 *
 *   node scripts/infra/set-first-party-store-operator.js --operator-uid <uid> [--expect-email <email>]
 *   node scripts/infra/set-first-party-store-operator.js --operator-uid <uid> --expect-email <email> --apply
 *
 * Owner decisions 2026-10-01 (binding):
 *   · the store stays OWNED by its company account — this script never writes a shop, a
 *     business, an owner field, a claim, a wallet, or a payout destination;
 *   · ONE operator — written to the server-only record firstPartyStoreOperators/{storeId};
 *   · the store wallet is wallets/{businessId} (= wallets/SOK-XX2338), where the LIVE settlement
 *     path credits store sales. It is created by the FIRST SETTLED SALE, never by this script.
 *     (The earlier plan to create wallets/{companyOwnerUid} was withdrawn: no path credits it.)
 *
 * WHAT THE DRY RUN DOES (read-only): Firestore reads of the first-party chain, the operator
 * record and wallets/{businessId}; one Firebase Auth getUser for the named operator. No write.
 *
 * WHAT --apply DOES, and only this:
 *   firstPartyStoreOperators/{storeId}.create({...}) — ONLY if absent. An existing record that
 *   already names exactly this operator is a no-op; one that differs is REFUSED (never
 *   overwritten). create() is the claim: a concurrent creator makes it fail with ALREADY_EXISTS,
 *   which is reported and left alone (never get()+set()).
 *
 * REFUSES (exit 2) unless: exactly one shop carries firstParty:true, it has an ownerId and no
 * sellerUid, the owner has exactly one active business whose businessType is
 * SOKONI_FIRST_PARTY_STORE (first-party-store-operator.resolveStoreChain), the operator
 * account exists, is not disabled, and (when given) its email matches --expect-email.
 */
'use strict';
const path = require('path');

const FN = path.join(__dirname, '..', '..', 'functions');
const admin = require(path.join(FN, 'node_modules', 'firebase-admin'));
let db = null;   /* initialised in main() only, so requiring this file for its shapes never opens an app */
const OP = require(path.join(FN, 'first-party-store-operator'));

function _arg(flag) {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : null;
}
const APPLY = process.argv.includes('--apply');
const operatorUid = _arg('--operator-uid');
const expectEmail = _arg('--expect-email');
const SET_BY = 'scripts/infra/set-first-party-store-operator.js';

/** The record the gate reads. No payoutDestination — the operator sets that through
    sokoniStoreSetPayoutDestination (operator + PIN + verified phone), never this script. */
function operatorRecord(chain, uid, now) {
  return {
    storeId: chain.storeId,
    businessId: chain.businessId,
    ownerUid: chain.ownerUid,
    operatorUids: [uid],
    decision: 'owner 2026-10-01: company-owned, owner-operated; admin claims grant nothing',
    setBy: SET_BY,
    createdAt: now,
  };
}

const refuse = (msg) => { console.error('REFUSED: ' + msg); process.exit(2); };
const show = (label, v) => console.log(label.padEnd(34) + (v === undefined ? '(absent)' : JSON.stringify(v)));

async function main() {
  if (!admin.apps.length) admin.initializeApp();
  db = admin.firestore();
  const project = admin.app().options.projectId || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || '(ADC default)';
  console.log(`SOKONI Store operator — ${APPLY ? 'APPLY' : 'DRY RUN (no writes)'} — project ${project}\n`);
  if (!operatorUid) refuse('--operator-uid is required (no default: the operator is named, never assumed)');

  /* 1 — the chain, from data. */
  const chain = await OP.resolveStoreChain(db);
  if (!chain.ok) refuse(`first-party chain does not resolve: ${chain.reason}${chain.detail ? ' ' + JSON.stringify(chain.detail) : ''}`);
  show('store (shops/)', chain.storeId);
  show('  firstParty', chain.shop.firstParty);
  show('  ownerId', chain.ownerUid);
  show('  sellerUid', chain.shop.sellerUid);
  show('  operatorEmail (audit-only label)', chain.shop.operatorEmail);
  show('business (businesses/)', chain.businessId);
  show('  businessType', chain.business.businessType);
  if (operatorUid === chain.ownerUid) console.log('NOTE: the operator named is the company owner account itself.');

  /* 2 — the operator account (read-only Auth lookup). */
  let user;
  try { user = await admin.auth().getUser(operatorUid); }
  catch (e) { refuse(`operator uid not found in Firebase Auth (${e && e.code})`); }
  show('operator uid', user.uid);
  show('  email', user.email);
  show('  emailVerified', user.emailVerified);
  show('  disabled', user.disabled);
  show('  verified phone (last 3)', user.phoneNumber ? String(user.phoneNumber).slice(-3) : undefined);
  if (user.disabled) refuse('operator account is disabled');
  if (expectEmail && String(user.email || '').toLowerCase() !== expectEmail.toLowerCase()) {
    refuse(`operator email ${user.email} does not match --expect-email ${expectEmail}`);
  }
  if (!expectEmail) console.log('WARNING: --expect-email not given; the email above was NOT cross-checked.');

  /* 3 — operator record: before / planned. */
  const recRef = db.collection(OP.OPERATORS).doc(chain.storeId);
  const recSnap = await recRef.get();
  const before = recSnap.exists ? recSnap.data() : null;
  console.log('\nfirstPartyStoreOperators/' + chain.storeId);
  show('  BEFORE', before ? { operatorUids: before.operatorUids, storeId: before.storeId, businessId: before.businessId, ownerUid: before.ownerUid } : undefined);
  let recAction;
  if (!before) recAction = 'create';
  else if (OP.recordAuthorises(before, chain, operatorUid) && before.operatorUids.length === 1) recAction = 'no-op (already exactly this operator)';
  else recAction = 'REFUSE (record exists and differs — not overwritten)';
  show('  PLAN', recAction);

  /* 4 — the store wallet, reported only. */
  const wSnap = await db.collection('wallets').doc(chain.businessId).get();
  console.log('\nwallets/' + chain.businessId + '  (the store wallet — created by the first settled sale, never here)');
  show('  STATE', wSnap.exists ? { balance: wSnap.data().balance, pendingPayout: wSnap.data().pendingPayout } : undefined);

  if (recAction.startsWith('REFUSE')) refuse('operator record differs; resolve deliberately before re-running');

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply (after deploy, with owner authorisation) to write.');
    return;
  }

  if (recAction === 'create') {
    try { await recRef.create(operatorRecord(chain, operatorUid, new Date())); console.log('WROTE operator record'); }
    catch (e) { if (e && e.code === 6) console.log('operator record appeared concurrently — left untouched'); else throw e; }
  }
  const after = await recRef.get();
  show('\noperator record AFTER', after.exists ? { operatorUids: after.data().operatorUids } : undefined);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => { console.error('ERROR', e && (e.stack || e.message)); process.exit(1); });
}
module.exports = { operatorRecord };
