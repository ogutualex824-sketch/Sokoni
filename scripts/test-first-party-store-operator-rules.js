/* SOKONI Store operator record — Firestore RULES, emulator-backed.   WRITTEN, NOT YET RUN.

   Run:  firebase emulators:exec --only firestore "node scripts/test-first-party-store-operator-rules.js"
         (RULES_FILE defaults to firestore.rules.build when present — what firebase.json deploys —
          else firestore.rules. Memory: emulators:exec loads NO rules by itself; this suite loads
          them explicitly through initializeTestEnvironment.)

   What only the rules engine can prove:
     * firstPartyStoreOperators/*, firstPartyStoreAudit/* and firstPartyStoreConfig/* (the payouts
       flag) are DEFAULT-DENIED to every client
       — admin, superAdmin, the operator, the company owner — for read AND write. The operator
       grant must be reachable only through the Admin SDK.
     * KNOWN GAPS (reported, not asserted as pass): today's rules let ANY admin client update
       shops/{storeId} (`allow update: if isAdmin()`) and read wallets/{ownerUid}. The owner
       decision "admins can do NOTHING on the store" is therefore enforced by the callables and
       resolveShopAccess, but NOT by the rules. The rules change is listed in
       docs/SOKONI_STORE_OPERATOR_CENSUS.md; this suite flips those lines to PASS once made.
*/
'use strict';
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RULES_FILE = process.env.RULES_FILE ||
  (fs.existsSync(path.join(ROOT, 'firestore.rules.build')) ? 'firestore.rules.build' : 'firestore.rules');

let pass = 0, fail = 0, gaps = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 90) + ']' : '')); ok ? pass++ : fail++; };
const check = async (label, p) => { try { await p; ck(label, true); } catch (e) { ck(label, false, e.message); } };
const gap = async (label, p) => {
  try { await p; gaps++; console.log('  KNOWN-GAP  ' + label + '   [still ALLOWED by rules]'); }
  catch (_) { ck(label + ' — now DENIED (gap closed)', true); }
};

const STORE = 'STR_147f5ce11b424ec4bb892519', OWNER = 'vbaSOKL4h8WWGqa6Xfi1eLaEPnS2', OPERATOR = 'D5Ql2EYr95bt79IpcGTmOMTK0P83';

(async () => {
  console.log('SOKONI Store operator record — rules (' + RULES_FILE + ')\n');
  const env = await initializeTestEnvironment({
    projectId: 'sokoni-store-operator-rules',
    firestore: { rules: fs.readFileSync(path.join(ROOT, RULES_FILE), 'utf8') },
  });
  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore();
    await db.doc('shops/' + STORE).set({ name: 'SOKONI Store', firstParty: true, ownerId: OWNER });
    await db.doc('firstPartyStoreOperators/' + STORE).set({ storeId: STORE, operatorUids: [OPERATOR] });
    await db.doc('firstPartyStoreAudit/a1').set({ action: 'x' });
    await db.doc('wallets/' + OWNER).set({ uid: OWNER, balance: 0 });
  });

  const as = {
    admin: env.authenticatedContext('adminUid', { admin: true }).firestore(),
    superAdmin: env.authenticatedContext('superUid', { admin: true, superAdmin: true }).firestore(),
    operator: env.authenticatedContext(OPERATOR, { admin: true, superAdmin: true }).firestore(),
    owner: env.authenticatedContext(OWNER, {}).firestore(),
    anon: env.unauthenticatedContext().firestore(),
  };
  for (const [who, db] of Object.entries(as)) {
    await check(`${who}: cannot READ firstPartyStoreOperators`, assertFails(db.doc('firstPartyStoreOperators/' + STORE).get()));
    await check(`${who}: cannot CREATE/overwrite firstPartyStoreOperators`, assertFails(db.doc('firstPartyStoreOperators/' + STORE).set({ operatorUids: [who] })));
    await check(`${who}: cannot UPDATE firstPartyStoreOperators`, assertFails(db.doc('firstPartyStoreOperators/' + STORE).update({ operatorUids: [who] })));
    await check(`${who}: cannot READ firstPartyStoreAudit`, assertFails(db.doc('firstPartyStoreAudit/a1').get()));
    await check(`${who}: cannot WRITE the payouts flag firstPartyStoreConfig/payouts`, assertFails(db.doc('firstPartyStoreConfig/payouts').set({ enabled: true })));
    await check(`${who}: cannot READ the payouts flag`, assertFails(db.doc('firstPartyStoreConfig/payouts').get()));
  }
  await check('anyone may still READ the public store document (storefront)', assertSucceeds(as.anon.doc('shops/' + STORE).get()));
  await gap('admin client can UPDATE shops/{store} (phone)', assertSucceeds(as.admin.doc('shops/' + STORE).update({ phone: '+254700000000' })));
  await gap('admin client can READ wallets/{companyOwner}', assertSucceeds(as.admin.doc('wallets/' + OWNER).get()));

  await env.cleanup();
  console.log(`\n${pass} PASS / ${fail} FAIL / ${gaps} KNOWN-GAP`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH (not a pass):', e && (e.stack || e)); process.exit(2); });
