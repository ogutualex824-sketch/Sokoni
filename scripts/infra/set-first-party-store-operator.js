#!/usr/bin/env node
/**
 * ONE-OFF — name the SOKONI Store's operator, and give the store its OWN wallet on the
 * company account. DRY RUN BY DEFAULT.
 *
 *   node scripts/infra/set-first-party-store-operator.js --operator-uid <uid> [--expect-email <email>]
 *   node scripts/infra/set-first-party-store-operator.js --operator-uid <uid> --expect-email <email> --apply
 *
 * Owner decisions 2026-10-01 (binding):
 *   · the store stays OWNED by its company account — this script never writes a shop,
 *     a business, an owner field, a claim, or a payout destination;
 *   · ONE operator — written to the server-only record firstPartyStoreOperators/{storeId};
 *   · the store's own wallet is wallets/{companyOwnerUid} — created with the EXISTING
 *     wallet-engine v2 shape (functions/wallet-engine.js _ensureWallet), balance 0.
 *
 * WHAT THE DRY RUN DOES (read-only): Firestore reads of the first-party chain, the operator
 * record, three wallet documents; one Firebase Auth getUser for the named operator. No write.
 *
 * WHAT --apply DOES, and only this:
 *   1. firstPartyStoreOperators/{storeId}.create({...})  — ONLY if absent. An existing record
 *      that already names exactly this operator is a no-op; one that differs is REFUSED
 *      (never overwritten — change of operator is a deliberate, separate act).
 *   2. wallets/{companyOwnerUid}.create({...balance:0...}) — ONLY if absent. An existing wallet
 *      is never touched. create() is the claim: a concurrent creator makes this fail with
 *      ALREADY_EXISTS, which is reported and left alone (never get()+set()).
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

/** wallet-engine.js _ensureWallet (v2) creation shape, balance 0. Kept in step by
    scripts/test-sokoni-first-party-store.js (I1), which parses the source and fails on drift. */
function walletV2Shape(uid, now) {
  return {
    uid,
    balance: 0, pendingBalance: 0, savingsBalance: 0, cashbackBalance: 0, rewardPoints: 0,
    tier: 'bronze', frozen: false, currency: 'KES',
    dailyLimit: 50000, monthlyLimit: 500000, dailySpent: 0, monthlySpent: 0,
    pinHash: null, pinLocked: false,
    lastTopUp: null, pendingTopUp: null, pendingPayout: null,
    createdAt: now, v2: true,
  };
}

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
  console.log(`SOKONI Store operator + wallet — ${APPLY ? 'APPLY' : 'DRY RUN (no writes)'} — project ${project}\n`);
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

  /* 4 — the store's own wallet on the company account. */
  const wRef = db.collection('wallets').doc(chain.ownerUid);
  const [wSnap, landSnap, bwSnap] = await Promise.all([
    wRef.get(),
    db.collection('wallets').doc(chain.businessId).get(),
    db.collection('businessWallets').doc(chain.businessId).get(),
  ]);
  console.log('\nwallets/' + chain.ownerUid + '  (the store\'s own wallet, company account)');
  show('  BEFORE', wSnap.exists ? { balance: wSnap.data().balance, v2: wSnap.data().v2, pinSet: !!wSnap.data().pinHash } : undefined);
  const wAction = wSnap.exists ? 'no-op (exists — never touched)' : 'create (v2 shape, balance 0)';
  show('  PLAN', wAction);
  console.log('\nSETTLEMENT LANDING (read-only, for the owner):');
  show('  wallets/' + chain.businessId, landSnap.exists ? { balance: landSnap.data().balance } : undefined);
  show('  businessWallets/' + chain.businessId, bwSnap.exists ? { balanceMinor: bwSnap.data().balanceMinor } : undefined);
  console.log('  NOTE: on the a545818 lineage order-settlement credits wallets/{order.sellerUid} = wallets/' +
    chain.businessId + ', NOT wallets/' + chain.ownerUid + '. See docs/SOKONI_STORE_OPERATOR_CENSUS.md.');

  if (recAction.startsWith('REFUSE')) refuse('operator record differs; resolve deliberately before re-running');

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply (after deploy, with owner authorisation) to write.');
    return;
  }

  const now = new Date();
  if (recAction === 'create') {
    try { await recRef.create(operatorRecord(chain, operatorUid, now)); console.log('WROTE operator record'); }
    catch (e) { if (e && e.code === 6) console.log('operator record appeared concurrently — left untouched'); else throw e; }
  }
  if (!wSnap.exists) {
    try { await wRef.create(walletV2Shape(chain.ownerUid, now)); console.log('CREATED company wallet'); }
    catch (e) { if (e && e.code === 6) console.log('wallet appeared concurrently — left untouched'); else throw e; }
  }
  const [a1, a2] = await Promise.all([recRef.get(), wRef.get()]);
  show('\noperator record AFTER', a1.exists ? { operatorUids: a1.data().operatorUids } : undefined);
  show('company wallet AFTER', a2.exists ? { balance: a2.data().balance, v2: a2.data().v2 } : undefined);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => { console.error('ERROR', e && (e.stack || e.message)); process.exit(1); });
}
module.exports = { walletV2Shape, operatorRecord };
