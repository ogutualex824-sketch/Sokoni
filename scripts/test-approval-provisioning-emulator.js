#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════
   APPROVAL PROVISIONING — against the REAL Firestore
   ══════════════════════════════════════════════════════════════════════════
   The 28/0 unit suite substitutes firebase-admin, so it proves the guard's
   LOGIC against a database model this repo wrote. It cannot prove Firestore's
   own transaction semantics — and the whole point of the claim at
   posProvisioning/{uid} is to survive a race that only a real database can
   arbitrate. This runs the same code against the emulator.

   Launch:
     firebase emulators:exec --only firestore --project sokoni-prov-test \
       "node scripts/test-approval-provisioning-emulator.js"
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-prov-test';

const path = require('path');
const fs = require('fs');
const Module = require('module');
const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');
/* This worktree is fresh, so it has no node_modules of its own (they are not
   tracked). Resolve firebase-admin from the first tree that HAS one — the code
   under test is still this worktree's; only the SDK is borrowed. */
const ADMIN_PATHS = [FN, path.join(ROOT, 'node_modules'),
  'C:/Users/USER1/OneDrive/Desktop/SOKONI/functions',
  'C:/temp/sok-otp-rc/functions'];
let _adminPath = null;
for (const p of ADMIN_PATHS) {
  try { _adminPath = require.resolve('firebase-admin', { paths: [p] }); break; } catch (_) {}
}
if (!_adminPath) { console.error('firebase-admin not found in: ' + ADMIN_PATHS.join(', ')); process.exit(1); }
/* The module under test resolves its OWN requires, so give it the same path. */
module.paths.push(path.dirname(path.dirname(_adminPath)));
require('module').Module._initPaths && null;
process.env.NODE_PATH = path.dirname(path.dirname(_adminPath));
require('module')._initPaths();
const admin = require(_adminPath);
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  if (ok) { pass++; console.log('  \x1b[32mPASS\x1b[0m  ' + l); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m  ' + l + (d ? '   [' + d + ']' : '')); }
};
const head = (t) => console.log('\n' + t + '\n' + '-'.repeat(74));

/* Only firebase-functions is stubbed — the DATABASE is real. */
function loadBootstrap() {
  const realLoad = Module._load;
  Module._load = function (request) {
    /* The module under test resolves its own requires from ITS directory, which
       has no node_modules. Hand it the admin instance already initialised
       against the emulator, so it shares one app and one connection. The
       DATABASE is still real — only the SDK lookup is redirected. */
    if (request === 'firebase-admin') return admin;
    if (request === 'firebase-functions/v2/https') {
      return { onCall: (o, h) => (h || o),
               HttpsError: class extends Error { constructor(c, m) { super(m); this.code = c; } } };
    }
    if (request === 'firebase-functions/logger') return { info() {}, warn() {}, error() {}, log() {} };
    if (request === 'firebase-functions') return { logger: { info() {}, warn() {}, error() {} } };
    return realLoad.apply(this, arguments);
  };
  let mod;
  try {
    delete require.cache[require.resolve(path.join(FN, 'business-bootstrap.js'))];
    mod = require(path.join(FN, 'business-bootstrap.js'));
  } finally { Module._load = realLoad; }
  return mod;
}

async function wipe() {
  for (const c of ['businesses', 'posProvisioning', 'branches', 'posSettings',
                   'categories', 'staff', 'merchantCounters', 'subscriptions']) {
    const snap = await db.collection(c).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}
const bizCount = async (uid) =>
  (await db.collection('businesses').where('ownerId', '==', uid).get()).size;

(async function main() {
  const bb = loadBootstrap();
  ck('E0 business-bootstrap loads against the EMULATOR',
     typeof bb._ensureBusinessForOwner === 'function');

  /* ── 1. first approval ───────────────────────────────────────────────── */
  head('1 — first approval provisions exactly one business');
  await wipe();
  const r1 = await bb._ensureBusinessForOwner({
    uid: 'UID-EMU-A', businessName: 'Bravilex Duka', category: 'Retail' });
  ck('E1 it created a business', r1 && r1.created === true, JSON.stringify(r1));
  ck('E2 exactly one, found the way the TILL looks for it', (await bizCount('UID-EMU-A')) === 1,
     String(await bizCount('UID-EMU-A')));
  const doc1 = (await db.collection('businesses').where('ownerId', '==', 'UID-EMU-A').get()).docs[0];
  ck('E3 provisionedBy is "approval"', doc1.data().provisionedBy === 'approval',
     String(doc1.data().provisionedBy));
  ck('E4 status active, canonical ownerId, default branch',
     doc1.data().status === 'active' && doc1.data().ownerId === 'UID-EMU-A' &&
     !!doc1.data().defaultBranchId);

  /* ── 2. retry ────────────────────────────────────────────────────────── */
  head('2 — a retried approval is a no-op');
  const r2 = await bb._ensureBusinessForOwner({
    uid: 'UID-EMU-A', businessName: 'Bravilex Duka', category: 'Retail' });
  ck('E5 does not create', r2.created === false, JSON.stringify(r2));
  ck('E6 same merchantId', r2.merchantId === r1.merchantId, r1.merchantId + ' vs ' + r2.merchantId);
  ck('E7 still exactly one business', (await bizCount('UID-EMU-A')) === 1);

  /* ── 3. THE RACE — the reason this file exists ───────────────────────── */
  head('3 — concurrent approvals against a REAL transaction');
  await wipe();
  const N = 5;
  const results = await Promise.all(Array.from({ length: N }, () =>
    bb._ensureBusinessForOwner({ uid: 'UID-EMU-B', businessName: 'Shop B', category: 'Retail' })
      .then((r) => ({ ok: true, r }), (e) => ({ ok: false, e: String(e && e.message || e) }))));
  const createdN = results.filter((x) => x.ok && x.r.created === true).length;
  const failedN = results.filter((x) => !x.ok).length;
  ck('E8 ' + N + ' simultaneous approvals created EXACTLY ONE business',
     createdN === 1, 'created=' + createdN + ' failed=' + failedN);
  ck('E9 ...and the database agrees — one document', (await bizCount('UID-EMU-B')) === 1,
     String(await bizCount('UID-EMU-B')));
  ck('E10 ...and no approval crashed', failedN === 0,
     results.filter((x) => !x.ok).map((x) => x.e).join(' | '));
  ck('E11 the claim is keyed on the canonical uid',
     (await db.collection('posProvisioning').doc('UID-EMU-B').get()).exists);
  const branches = await db.collection('branches').where('merchantId', '==',
    (await db.collection('businesses').where('ownerId', '==', 'UID-EMU-B').get()).docs[0].id).get();
  ck('E12 ...and exactly one default branch, not five', branches.size === 1, String(branches.size));

  /* ── 4. failure releases the claim ───────────────────────────────────── */
  head('4 — a failed run must not strand the merchant');
  await wipe();
  const bb2 = loadBootstrap();
  /* Force the commit to fail AFTER the claim is taken. */
  const realBatch = db.batch.bind(db);
  db.batch = () => ({ set() {}, update() {}, commit: async () => { throw new Error('simulated commit failure'); } });
  let threw = false;
  try { await bb2._ensureBusinessForOwner({ uid: 'UID-EMU-C', businessName: 'Shop C', category: 'Retail' }); }
  catch (_) { threw = true; }
  db.batch = realBatch;
  ck('E13 the failure surfaced', threw);
  ck('E14 the claim was RELEASED in the real database',
     (await db.collection('posProvisioning').doc('UID-EMU-C').get()).exists === false);
  const r3 = await bb2._ensureBusinessForOwner({ uid: 'UID-EMU-C', businessName: 'Shop C', category: 'Retail' });
  ck('E15 ...so a retry provisions', r3.created === true, JSON.stringify(r3));
  ck('E16 ...exactly once', (await bizCount('UID-EMU-C')) === 1);

  /* ── 5. who does NOT get provisioned ─────────────────────────────────── */
  head('5 — only approved merchant roles reach this at all');
  const life = fs.readFileSync(path.join(FN, 'application-lifecycle.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  ck('E17 the call is gated on approved AND a merchant role',
     /status === 'approved' && \(role === 'seller' \|\| role === 'merchant'\)/.test(life));
  ck('E18 NC a rejected application cannot reach it — no unguarded call site',
     (life.match(/_ensureBusinessForOwner\(/g) || []).length === 1,
     String((life.match(/_ensureBusinessForOwner\(/g) || []).length) + ' call sites');
  ck('E19 NC and no client fallback exists in the approval path',
     !/localStorage/.test(life) && !/\?shopId=/.test(life));

  /* ── 6. provenance ───────────────────────────────────────────────────── */
  head('6 — provenance stays allow-listed against a hostile caller');
  await wipe();
  const bb3 = loadBootstrap();
  await bb3._h.createBusiness({ auth: { uid: 'UID-EMU-D' },
    data: { businessName: 'Hostile', category: 'Retail', __provisionedBy: 'super-admin-override' } });
  const hostile = (await db.collection('businesses').where('ownerId', '==', 'UID-EMU-D').get()).docs[0];
  ck('E20 an arbitrary provisionedBy is REFUSED and falls back to onboarding-v2',
     hostile.data().provisionedBy === 'onboarding-v2', String(hostile.data().provisionedBy));

  await wipe();
  console.log('\n' + '='.repeat(74));
  console.log('  ' + pass + ' passed, ' + fail + ' failed   (REAL Firestore)');
  console.log('='.repeat(74) + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR: ' + (e && e.stack || e)); process.exit(1); });
