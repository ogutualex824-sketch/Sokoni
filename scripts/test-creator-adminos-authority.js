/* test-creator-adminos-authority.js — AdminOS is the Creator Hub control plane.
 *
 * EXECUTED against the real functions/creator-hub.js _adminH handlers (the ones
 * adminOsDispatch merges) and functions/wallet.js, called DIRECTLY — no UI in the
 * path — so a legacy page, a script or a forged client gets exactly what these
 * calls get. Plus static checks on the client surfaces.
 *
 *   authority    every creatorAdmin* op refuses an anonymous caller and an ordinary
 *                user; Super-Admin-only writes refuse a plain admin
 *   registry     the AdminOS client op list == the server handler set; every op is
 *                reachable through adminOsDispatch's merged registry
 *   surfaces     admin-os.html hosts the Creator section; admin.html and
 *                super-admin.html carry NO Creator control (legacy pages cannot
 *                gain one without this suite going red)
 *
 *   node scripts/test-creator-adminos-authority.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-creator-adminos';
process.env.INTASEND_PRIVATE_KEY = 'harness';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
const Path = require('path');
const fs = require('fs');
const ROOT = Path.resolve(__dirname, '..');
const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() });
const db = F.db;
const quiet = console.log; console.info = console.warn = console.error = console.debug = () => {};
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : require.resolve(m, { paths: [FN] }); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin/storage', { getStorage: () => ({ bucket: () => ({ file: () => ({}) }) }) });
stub('firebase-admin/auth', { getAuth: () => ({ getUser: async (u) => ({ uid: u, providerData: [{ providerId: 'password' }] }) }) });
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp }),
  auth: () => ({ getUser: async (u) => ({ uid: u, providerData: [{}] }) }), storage: () => ({ bucket: () => ({}) }) });
stub('./redis-rate-limiter', { checkRateLimit: async () => true });
stub('./finos-utils', { intasendB2C: async () => { throw new Error('no'); } });
stub('./payment-adapters', { getAdapter: () => ({ sendMoneyB2C: async () => { throw new Error('provider must not be called'); } }) });

const H = require(Path.join(FN, 'creator-hub.js'));
const W = require(Path.join(FN, 'wallet.js'));
const who = (uid, token = {}) => ({ auth: uid ? { uid, token } : null, rawRequest: { headers: {} } });
async function code(p) { try { await p; return null; } catch (e) { return e.code || e.message; } }

let pass = 0, fail = 0;
const ck = (l, ok, d) => { quiet('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 160) + ']' : '')); ok ? pass++ : fail++; };

(async () => {
  const ops = Object.keys(H._adminH).filter((k) => /^creatorAdmin/.test(k)).sort();

  quiet('\n── authority: direct server invocation (no UI in the path) ──');
  const anon = [], user = [];
  for (const op of ops) {
    const a = await code(H._adminH[op]({ ...who(null), data: {} }));
    const u = await code(H._adminH[op]({ ...who('someone'), data: {} }));
    if (a !== 'unauthenticated') anon.push(op + '=' + a);
    if (u !== 'permission-denied') user.push(op + '=' + u);
  }
  ck(`all ${ops.length} creatorAdmin* ops refuse an anonymous caller`, anon.length === 0, anon);
  ck(`all ${ops.length} creatorAdmin* ops refuse an ordinary signed-in user`, user.length === 0, user);
  const ADMIN = { admin: true }, SUPER = { superAdmin: true };
  const superOnly = [
    ['creatorAdminConfig (write)',            'creatorAdminConfig', { set: { purchasesEnabled: true } }],
    ['creatorAdminPaymentCapability (write)', 'creatorAdminPaymentCapability', { set: { method: 'CARD-PAYMENT', status: 'BLOCKED', note: 'harness: admin must not write this' } }],
    ['creatorAdminAttestFee',                 'creatorAdminAttestFee', { paymentRef: 'SKNX1', feeKes: 15, evidence: 'INV-1' }],
  ];
  for (const [label, op, data] of superOnly) {
    ck(`${label}: plain admin refused`, (await code(H._adminH[op]({ ...who('adm1', ADMIN), data }))) === 'permission-denied');
  }
  ck('creatorAdminPaymentCapability (read): plain admin allowed', (await code(H._adminH.creatorAdminPaymentCapability({ ...who('adm1', ADMIN), data: {} }))) === null);
  ck('creatorAdminPaymentCapability (write): super admin allowed', (await code(H._adminH.creatorAdminPaymentCapability({ ...who('sa1', SUPER), data: { set: { method: 'CARD-PAYMENT', status: 'BLOCKED', note: 'harness: super admin records a block' } } }))) === null);
  ck('a forged claim value ("true" string) is not Super Admin', (await code(H._adminH.creatorAdminPaymentCapability({ ...who('x', { superAdmin: 'true' }), data: { set: { method: 'CARD-PAYMENT', status: 'BLOCKED', note: 'harness: forged claim must be refused' } } }))) === 'permission-denied');
  /* outcome_unknown resolution (wallet.js, reached from AdminOS Payouts) */
  ck('payout outcome resolution: plain admin refused (Super Admin only)', (await code(W.adminResolvePayoutOutcome.run({ ...who('adm1', ADMIN), data: { requestId: 'pout_X', decision: 'not_paid', evidence: {} } }))) === 'permission-denied');
  ck('payout outcome resolution: ordinary user refused', (await code(W.adminResolvePayoutOutcome.run({ ...who('someone'), data: {} }))) === 'permission-denied');

  quiet('\n── registry ──');
  global.window = {};
  require(Path.join(ROOT, 'sokoni-aos-creator.js'));
  const clientOps = [...window.SokoniAOSCreator.OPS].sort();
  ck('AdminOS client op list == server creatorAdmin* handlers', JSON.stringify(clientOps) === JSON.stringify(ops), { onlyClient: clientOps.filter((x) => !ops.includes(x)), onlyServer: ops.filter((x) => !clientOps.includes(x)) });
  const dispatchSrc = fs.readFileSync(Path.join(FN, 'admin-os-dispatch.js'), 'utf8');
  ck('adminOsDispatch merges creator-hub _adminH (one admin registry)', /require\('\.\/creator-hub'\)/.test(dispatchSrc) && /creator\._adminH/.test(dispatchSrc));
  const aosSrc = fs.readFileSync(Path.join(ROOT, 'sokoni-aos.js'), 'utf8');
  ck('sokoni-aos.js whitelists the Creator ops for adminOsDispatch', /SokoniAOSCreator\.OPS/.test(aosSrc));

  quiet('\n── surfaces ──');
  const aosHtml = fs.readFileSync(Path.join(ROOT, 'admin-os.html'), 'utf8');
  ck('admin-os.html hosts the Creator Hub section and loads its module', /data-section="creator"/.test(aosHtml) && /sokoni-aos-creator\.js/.test(aosHtml));
  const CREATOR_ADMIN = /creatorAdmin|creatorDispatch|creatorVerifications|royaltyLedger|royaltyAccruals|royaltyPeriods|contentEntitlements|creatorExceptions|intasendCapability|film_access|adminResolvePayoutOutcome/;
  /* POSITIVE CONTROL: the detector must see Creator controls where they DO live,
     or "no hits" on the legacy pages would prove nothing. */
  const controlHits = fs.readFileSync(Path.join(ROOT, 'sokoni-aos-creator.js'), 'utf8').split('\n').filter((l) => CREATOR_ADMIN.test(l)).length;
  ck('positive control: the detector finds Creator controls in the AdminOS module', controlHits >= 10, controlHits);
  for (const page of ['admin.html', 'super-admin.html', 'superadmin.html']) {
    const p = Path.join(ROOT, page);
    if (!fs.existsSync(p)) { ck(`${page}: absent`, true); continue; }
    const src = fs.readFileSync(p, 'utf8');
    const hits = src.split('\n').map((l, i) => (CREATOR_ADMIN.test(l) ? (i + 1) + ':' + l.trim().slice(0, 60) : null)).filter(Boolean);
    ck(`${page}: no Creator control (legacy page gains nothing)`, hits.length === 0, hits);
  }
  const aosPay = aosSrc.includes('adminResolvePayoutOutcome');
  ck('outcome_unknown resolution UI lives in AdminOS (sokoni-aos.js)', aosPay);

  quiet('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { quiet('HARNESS CRASHED', e && e.stack); process.exit(2); });
