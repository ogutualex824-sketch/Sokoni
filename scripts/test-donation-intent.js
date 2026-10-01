'use strict';
/* createPaymentIntent purpose 'donation' (owner 2026-10-01, SOKONI Foundation): a pledge becomes ITS OWN intent.
   The amount is the PLEDGE's (never the browser's); only its owner, only while 'pledged'; KES 10–100,000 whole; one
   intent identity per pledge (DON_<pledgeId>). Runs the REAL pricer (functions/payment-purposes.js) on an in-memory
   Firestore (firebase-admin/firestore stubbed).
     node scripts/test-donation-intent.js            BASE=c6a2c49 node scripts/test-donation-intent.js (must FAIL) */
const path = require('path'), fs = require('fs'), os = require('os'), Module = require('module'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const NM = process.env.SOKONI_NODE_MODULES || 'C:/Users/USER1/OneDrive/Desktop/SOKONI/functions/node_modules';
process.env.NODE_PATH = NM; Module._initPaths();
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 200) + ']')); ok ? pass++ : fail++; };
const DOCS = new Map();
const fakeDb = { collection: (c) => ({ doc: (id) => ({ get: async () => ({ exists: DOCS.has(c + '/' + id), data: () => DOCS.get(c + '/' + id) }) }) }) };
const fsPath = require.resolve('firebase-admin/firestore', { paths: [NM] });
require.cache[fsPath] = { id: fsPath, filename: fsPath, loaded: true, exports: { getFirestore: () => fakeDb, FieldPath: { documentId: () => '__id__' } } };
let file = path.join(ROOT, 'functions', 'payment-purposes.js');
if (process.env.BASE) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-')); file = path.join(d, 'payment-purposes.js');
  fs.writeFileSync(file, execSync('git show ' + process.env.BASE + ':functions/payment-purposes.js', { cwd: ROOT, encoding: 'utf8' })); }
const PP = require(file);
const price = async (uid, data) => { try { return { ok: true, q: await PP.priceFor('donation', uid, data) }; } catch (e) { return { ok: false, code: e.code, msg: e.message }; } };
const pledge = (id, o) => DOCS.set('foundationDonations/' + id, Object.assign({ uid: 'donor', amount: 500, status: 'pledged', currency: 'KES', programmeId: null }, o));

(async () => {
  console.log('\nDonation intent   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
  pledge('PLG_donor_req1', { programmeId: 'prog_water' });
  let r = await price('donor', { pledgeId: 'PLG_donor_req1', amount: 1, amountCents: 100 });
  ck('D-1', r.ok && r.q.amount === 500 && r.q.amountCents === 50000 && r.q.purpose === 'donation', 'the amount is the PLEDGE\'s (KES 500) — the browser\'s amount is ignored', r.ok ? r.q : r);
  ck('D-2', r.ok && r.q.preferredRef === 'DON_PLG_donor_req1' && r.q.resourceType === 'foundationDonation' && r.q.resourceId === 'PLG_donor_req1',
    'ONE intent identity per pledge (DON_<pledgeId>) — a retry replays it, never a second payment', r.ok ? r.q.preferredRef : r);
  ck('D-3', r.ok && r.q.metadata.type === 'donation' && r.q.metadata.pledgeId === 'PLG_donor_req1' && r.q.metadata.programmeId === 'prog_water' && !('sellerUid' in r.q.metadata),
    'metadata: type donation + pledge + programme — no seller (no wallet, no commission)', r.ok ? r.q.metadata : r);
  r = await price('someone_else', { pledgeId: 'PLG_donor_req1' });
  ck('D-4', !r.ok && r.code === 'permission-denied', 'only the pledge\'s OWNER can pay it', r);
  pledge('PLG_donor_done', { status: 'completed' });
  r = await price('donor', { pledgeId: 'PLG_donor_done' });
  ck('D-5', !r.ok && r.code === 'already-exists', 'a completed (or failed/review) pledge cannot be paid again', r);
  for (const [id, amt, why] of [['PLG_donor_low', 9, 'below KES 10'], ['PLG_donor_high', 100001, 'above KES 100,000'], ['PLG_donor_frac', 50.5, 'fractional'], ['PLG_donor_str', '500', 'a string']]) {
    pledge(id, { amount: amt }); r = await price('donor', { pledgeId: id });
    ck('D-6:' + why, !r.ok && r.code === 'failed-precondition', 'a pledge ' + why + ' is refused', r);
  }
  pledge('PLG_donor_usd', { currency: 'USD' }); r = await price('donor', { pledgeId: 'PLG_donor_usd' });
  ck('D-7', !r.ok && r.code === 'failed-precondition', 'non-KES is refused', r);
  DOCS.set('foundationDonations/CHK_ord42', { uid: 'donor', amount: 100, status: 'pledged', orderId: 'ord42' });   /* checkout pledge: no currency field */
  r = await price('donor', { pledgeId: 'CHK_ord42' });
  ck('D-8', r.ok && r.q.amount === 100 && r.q.preferredRef === 'DON_CHK_ord42', 'a CHECKOUT pledge (CHK_, no currency field = KES) gets its OWN intent', r.ok ? r.q : r);
  for (const bad of ['', 'XYZ_1', 'PLG_../x', 'orders/abc']) { r = await price('donor', { pledgeId: bad });
    ck('D-9:' + (bad || 'empty'), !r.ok && r.code === 'invalid-argument', 'a malformed pledge id is refused before any read', r); }
  r = await price('donor', { pledgeId: 'PLG_nope' });
  ck('D-10', !r.ok && r.code === 'not-found', 'an unknown pledge is not-found', r);
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
