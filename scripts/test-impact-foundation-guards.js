#!/usr/bin/env node
'use strict';
/* ============================================================================
   impact.js Foundation money guards (2026-10-01) — real handlers on the in-memory Firestore fake
     A  pledge tags: active programme accepted (title becomes destination); inactive / unknown purpose refused;
        restricted:false recorded (a purpose is a preference, not a legal restriction)
     B  impactGetMyPledge: the donor reads their own status; anyone else → not-found; no ledger read/write
     C  impactUpdateCampaign: "raised" can no longer be typed in; bad status refused
     D  impactRecordMarketplaceContribution: refused, writes NOTHING (no ledger credit without money)
     E  counterproof on 3a38f35: the old code let an admin set raised and mint a ledger credit
   node scripts/test-impact-foundation-guards.js
   ============================================================================ */
const path = require('path'), fs = require('fs'), Module = require('module');
const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 300) : '')); } };
function setup() {
  const F = makeFakeFirestore();
  const ff = () => F.db; ff.FieldValue = F.FieldValue; ff.Timestamp = F.Timestamp;
  const fa = Module._resolveFilename('firebase-admin', { id: path.join(FN, 'x.js'), filename: path.join(FN, 'x.js'), paths: Module._nodeModulePaths(FN) });
  require.cache[fa] = { id: fa, filename: fa, loaded: true, exports: { apps: [1], initializeApp() {}, firestore: ff } };
  return F;
}
function load(file) { const f = require.resolve(file); delete require.cache[f]; return require(f); }
const keys = (F, pre) => [...F.db._store.keys()].filter((k) => k.startsWith(pre));
const run = async (M, fn, uid, data, token = {}) => { try { return { ok: true, v: await M[fn].run({ auth: uid ? { uid, token } : null, data }) }; } catch (e) { return { ok: false, code: e.code, msg: e.message }; } };
const ADM = { admin: true };
const rid = (n) => '1a2b3c4d-0000-4000-8000-' + String(n).padStart(12, '0');

(async () => {
  console.log('impact.js — Foundation money guards\n');
  let F = setup();
  let M = load(path.join(FN, 'impact.js'));
  await F.db.collection('impactCampaigns').doc('edu1').set({ title: 'School fees 2026', status: 'active', raised: 0 });
  await F.db.collection('impactCampaigns').doc('done').set({ title: 'Closed drive', status: 'completed', raised: 0 });

  /* A */
  const a1 = await run(M, 'impactPledgeDonation', 'd1', { amount: 750, requestId: rid(1), programmeId: 'edu1', purpose: 'EDUCATION' });
  const p1 = (await F.db.collection('foundationDonations').doc('PLG_d1_' + rid(1)).get()).data();
  ck('A1 active programme: pledge tagged, destination = programme title, restricted:false, still only pledged',
    a1.ok && p1.programmeId === 'edu1' && p1.purpose === 'EDUCATION' && p1.destination === 'School fees 2026' && p1.restricted === false && p1.status === 'pledged', p1);
  const a2 = await run(M, 'impactPledgeDonation', 'd1', { amount: 750, requestId: rid(2), programmeId: 'done' });
  const a3 = await run(M, 'impactPledgeDonation', 'd1', { amount: 750, requestId: rid(3), purpose: 'TAX_FREE_GIFT' });
  const a4 = await run(M, 'impactPledgeDonation', 'd1', { amount: 750, requestId: rid(4), programmeId: '../x' });
  ck('A2 inactive programme / unlisted purpose / malformed programme id → refused', !a2.ok && !a3.ok && !a4.ok && a3.code === 'invalid-argument', { a2, a3, a4 });
  ck('A3 still no ledger, balance or stats from pledges', keys(F, 'impactLedger/').length === 0 && keys(F, 'impactBalance/').length === 0 && keys(F, 'foundationStats/').length === 0);

  /* B */
  const b1 = await run(M, 'impactGetMyPledge', 'd1', { pledgeId: 'PLG_d1_' + rid(1) });
  const b2 = await run(M, 'impactGetMyPledge', 'other', { pledgeId: 'PLG_d1_' + rid(1) });
  const b3 = await run(M, 'impactGetMyPledge', 'd1', { pledgeId: 'nope' });
  const b4 = await run(M, 'impactGetMyPledge', null, { pledgeId: 'PLG_d1_' + rid(1) });
  ck('B1 donor reads own pledge (status pledged, no receipt yet); another user → not-found; bad id / signed out refused',
    b1.ok && b1.v.status === 'pledged' && b1.v.receiptId === null && !b2.ok && b2.code === 'not-found' && b3.code === 'invalid-argument' && b4.code === 'unauthenticated', { b1, b2, b3, b4 });
  ck('B2 status read exposes no uid / donor identity', b1.ok && !('uid' in b1.v) && !('donorName' in b1.v));

  /* C */
  const c1 = await run(M, 'impactUpdateCampaign', 'adm', { campaignId: 'edu1', raised: 999999 }, ADM);
  const c2 = await run(M, 'impactUpdateCampaign', 'adm', { campaignId: 'edu1', status: 'hacked' }, ADM);
  const c3 = await run(M, 'impactUpdateCampaign', 'adm', { campaignId: 'edu1', status: 'paused', daysLeft: 10 }, ADM);
  const camp = (await F.db.collection('impactCampaigns').doc('edu1').get()).data();
  ck('C1 "raised" cannot be set (refused, unchanged); bad status refused; a normal update works', !c1.ok && c1.code === 'invalid-argument' && camp.raised === 0 && !c2.ok && c3.ok && camp.status === 'paused', { c1, c2, camp });

  /* D */
  const d1 = await run(M, 'impactRecordMarketplaceContribution', 'adm', { orderId: 'o1', orderTotal: 100000 }, ADM);
  ck('D1 marketplace "contribution" refused and wrote nothing', !d1.ok && d1.code === 'failed-precondition' && keys(F, 'impactLedger/').length === 0 && keys(F, 'impactBalance/').length === 0, d1);

  /* E — counterproof */
  const orig = path.join(FN, '.orig-impact-guards.js');
  fs.writeFileSync(orig, require('child_process').execSync('git show 3a38f35:functions/impact.js', { cwd: ROOT }).toString());
  try {
    F = setup();
    const O = load(orig);
    await F.db.collection('impactCampaigns').doc('edu1').set({ title: 'x', status: 'active', raised: 0 });
    const e1 = await run(O, 'impactUpdateCampaign', 'adm', { campaignId: 'edu1', raised: 999999 }, ADM);
    const e2 = await run(O, 'impactRecordMarketplaceContribution', 'adm', { orderId: 'o1', orderTotal: 100000 }, ADM);
    ck('E1 counterproof: the original lets an admin type raised=999,999 and mint a KES 1,000 ledger credit',
      e1.ok && (await F.db.collection('impactCampaigns').doc('edu1').get()).data().raised === 999999 && e2.ok && keys(F, 'impactLedger/').length === 1, { e1, e2 });
  } finally { fs.unlinkSync(orig); }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('  CRASH', e); process.exit(2); });
