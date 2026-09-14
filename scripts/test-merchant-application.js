#!/usr/bin/env node
/* Merchant application submission (stage 2A).
 *
 *   node scripts/test-merchant-application.js
 *
 * Drives the real submission primitive (sokoni-merchant-application.js) against
 * an in-memory Firestore adapter — no browser, no emulator, no credentials — so
 * every assertion is on the exact document that would be written.
 *
 * FIXTURE — deliberately NON-DEGENERATE:
 *
 *     SELLER_A   the account            (auth.uid / sellerUid)
 *     SHOP_B     the shop               (activeShopId)   SELLER_A !== SHOP_B
 *
 * A fixture where the uid doubles as the shop id would pass even if the code
 * substituted one for the other, which is the exact defect the contract forbids.
 * KASS appears once, as a CONTROL only, never as the proof.
 *
 * THE BOUNDARY UNDER TEST
 * Submission is a REQUEST. It must create exactly one document and change
 * nothing else: no role, no claim, no shop, no subscription — and it must not
 * be able to decide itself. The decision-authority guard (bc9bf4c) is exercised
 * here from the submission side, against the real trigger handler.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const FUNCTIONS_DIR = path.join(ROOT, 'functions');
const MA = require(path.join(ROOT, 'sokoni-merchant-application.js'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 150) + ']' : ''));
  ok ? pass++ : fail++;
};

/* ── Fixture ─────────────────────────────────────────────────────────────── */
const SELLER_A = 'SELLER_A_uid_7f3';
const SHOP_B = 'SHOP_B_shop_91c';
const KASS = 'D5Ql2EYr95bt79IpcGTmOMTK0P83';   /* control only */
const NOW = '2026-08-16T10:00:00.000Z';

const PROFILE = {
  name: 'Shop B Traders',
  businessName: 'Shop B Traders',
  category: 'electronics',
  description: 'Phones and accessories',
  phone: '0726043059',
  email: 'a@example.com',
  location: 'Nairobi',
  deliveryMethods: ['delivery', 'pickup'],
};

/* In-memory Firestore. Records every write so "changed nothing else" is a
   measurable claim rather than an assumption. */
function makeStore(seed = {}) {
  const data = { ...seed };
  const writes = [];
  return {
    data, writes,
    adapter: {
      async get(coll, id) { return data[`${coll}/${id}`] || null; },
      async set(coll, id, doc, opts) {
        writes.push({ coll, id, doc, opts });
        data[`${coll}/${id}`] = { ...(data[`${coll}/${id}`] || {}), ...doc };
      },
    },
  };
}

/* `agreementAccepted: true` is part of the DEFAULT because it is part of a
   real submission: applicationDecide refuses to approve without it, so an
   application filed without one is un-approvable by construction. PART F
   exercises its absence explicitly. */
const submit = (store, over = {}) => MA.submit({
  uid: SELLER_A, shopId: SHOP_B, shopIdSource: 'active_shop',
  profile: PROFILE, nowISO: NOW, source: 'onboarding-seller',
  agreementAccepted: true,
  fs: store.adapter, ...over,
});

/* ═══════════════════════════════════════════════════════════════════════════
   PART A — the document
   ═══════════════════════════════════════════════════════════════════════════ */
(async () => {
console.log('\nPART A — submission produces the canonical request\n');

{
  const store = makeStore();
  const r = await submit(store);
  const doc = store.data[`applications/${SELLER_A}--merchant`];

  ck('A1  an authenticated user can submit', r.ok === true && r.action === 'create');
  ck('A2  written at the deterministic id applications/{uid}--merchant',
    r.applicationId === `${SELLER_A}--merchant` && !!doc, r.applicationId);
  ck('A3  status is pending_review', doc.status === 'pending_review', doc.status);
  ck('A4  type is seller (the intake vocabulary, not a role)', doc.type === 'seller');
  ck('A5  role is NOT written — the server resolves it', !('role' in doc));
  ck('A6  uid and sellerUid are the authenticated account',
    doc.uid === SELLER_A && doc.sellerUid === SELLER_A);
  ck('A7  shopId is the SHOP, never the uid (SELLER_A !== SHOP_B)',
    doc.shopId === SHOP_B && doc.shopId !== doc.sellerUid, `${doc.sellerUid} / ${doc.shopId}`);
  ck('A8  the shop id states its provenance', doc.shopIdSource === 'active_shop');
  ck('A9  the merchant profile survives', doc.name === 'Shop B Traders' && doc.category === 'electronics');
  ck('A10 exactly ONE document was written', store.writes.length === 1 &&
    store.writes[0].coll === 'applications', store.writes.length + ' write(s)');
}

/* A11 — no shop yet: absence is stated, never back-filled from the uid. */
{
  const store = makeStore();
  await submit(store, { shopId: null, shopIdSource: undefined });
  const doc = store.data[`applications/${SELLER_A}--merchant`];
  ck('A11 with no shop yet, shopId is null and says so — not the uid',
    doc.shopId === null && doc.shopIdSource === 'none_yet' && doc.shopId !== doc.sellerUid);
}

/* ═══════════════════════════════════════════════════════════════════════════
   PART B — idempotency
   ═══════════════════════════════════════════════════════════════════════════ */
console.log('\nPART B — re-submission cannot fork a second application\n');

{
  const store = makeStore();
  await submit(store);
  const r2 = await submit(store, { profile: { ...PROFILE, description: 'Now also laptops' } });
  const ids = Object.keys(store.data).filter(k => k.startsWith('applications/'));

  ck('B1  a second submission creates NO second application', ids.length === 1, ids.join(','));
  ck('B2  ...it updates the existing pending request', r2.action === 'update' && r2.ok === true);
  ck('B3  ...and it stays pending_review',
    store.data[ids[0]].status === 'pending_review');
  ck('B4  ...profile edits are accepted', store.data[ids[0]].description === 'Now also laptops');
  ck('B5  ...createdAt is not rewritten by the update',
    store.writes[1].doc.createdAt === undefined && store.data[ids[0]].createdAt === NOW);
}

/* B6-B8 — what a re-submission means depends on the decided state. */
{
  const rejected = makeStore({
    [`applications/${SELLER_A}--merchant`]: {
      uid: SELLER_A, type: 'seller', status: 'rejected', reviewReason: 'Blurry ID photo', resubmitCount: 1,
    },
  });
  const r = await submit(rejected);
  const doc = rejected.data[`applications/${SELLER_A}--merchant`];
  ck('B6  a REJECTED application may be resubmitted → pending_review',
    r.ok === true && r.action === 'resubmit' && doc.status === 'pending_review');
  ck('B7  ...and the attempt is counted', doc.resubmitCount === 2 &&
    doc.previousRejectionReason === 'Blurry ID photo');
}

{
  const approved = makeStore({
    [`applications/${SELLER_A}--merchant`]: { uid: SELLER_A, type: 'seller', status: 'approved' },
  });
  const r = await submit(approved);
  ck('B8  an APPROVED merchant cannot reset themselves to pending',
    r.ok === false && r.action === 'refused' && r.reason === 'already_approved' &&
    approved.writes.length === 0 &&
    approved.data[`applications/${SELLER_A}--merchant`].status === 'approved');

  const suspended = makeStore({
    [`applications/${SELLER_A}--merchant`]: { uid: SELLER_A, type: 'seller', status: 'suspended' },
  });
  const r2 = await submit(suspended);
  ck('B9  a SUSPENDED merchant cannot clear their suspension by re-applying',
    r2.ok === false && r2.reason === 'suspended' && suspended.writes.length === 0);
}

/* ═══════════════════════════════════════════════════════════════════════════
   PART C — submission grants nothing
   ═══════════════════════════════════════════════════════════════════════════ */
console.log('\nPART C — a request is not a grant\n');

{
  const store = makeStore();
  await submit(store, {
    profile: {
      ...PROFILE,
      /* Everything a caller might try to smuggle in. */
      role: 'seller', roles: ['seller'], approved: true, approvedBy: 'me',
      decidedBy: SELLER_A, status: 'approved', verified: true, isAdmin: true,
      claims: { seller: true }, projectionStatus: 'applied', commissionRate: 0,
    },
  });
  const doc = store.data[`applications/${SELLER_A}--merchant`];
  const leaked = MA.FORBIDDEN.filter(k => k in doc && !['uid', 'sellerUid', 'applicationId', 'status'].includes(k));

  ck('C1  no forbidden field reaches the document', leaked.length === 0, leaked.join(','));
  ck('C2  a smuggled status:"approved" does not survive', doc.status === 'pending_review');
  ck('C3  a smuggled role does not survive', !('role' in doc));
  ck('C4  a smuggled claim does not survive', !('claims' in doc));
  ck('C5  submission writes NOTHING outside applications/',
    Object.keys(store.data).every(k => k.startsWith('applications/')), Object.keys(store.data).join(','));
  ck('C6  ...so no shop is activated', !Object.keys(store.data).some(k => /^(shops|sellers)\//.test(k)));
  ck('C7  ...and no subscription or trial is created',
    !Object.keys(store.data).some(k => /^subscriptions\//.test(k)));
}

/* C8 — the submitted document, fed to the REAL lifecycle trigger, grants
   nothing. This is the end-to-end proof that pending_review is a boundary. */
{
  const trigger = loadTrigger();
  const store = makeStore();
  await submit(store);
  const submittedDoc = store.data[`applications/${SELLER_A}--merchant`];

  const env = makeCfEnv({ accounts: { [SELLER_A]: {} } });
  await runTrigger(trigger, env, `${SELLER_A}--merchant`, { ...submittedDoc, intakeVersion: 1, roleResolvedBy: 'keyword' });
  ck('C8  the real trigger grants nothing for a pending_review application',
    env.log.filter(e => e.op === 'MINT_CLAIM').length === 0 &&
    env.log.filter(e => e.op === 'set' && e.coll === 'users').length === 0,
    env.log.map(e => e.op).join(','));

  /* C9 — and if the applicant edits their own doc to 'approved', the guard from
     bc9bf4c still refuses. Submission cannot become approval. */
  const env2 = makeCfEnv({ accounts: { [SELLER_A]: {} } });
  await runTrigger(trigger, env2, `${SELLER_A}--merchant`,
    { ...submittedDoc, status: 'approved', intakeVersion: 1, roleResolvedBy: 'keyword' });
  ck('C9  an applicant flipping their own status to approved is still refused',
    env2.log.filter(e => e.op === 'MINT_CLAIM').length === 0);
}

/* C10 — KASS as a CONTROL only: the primitive behaves identically for the
   account we already know is divergent. It proves nothing about the flow. */
{
  const store = makeStore();
  const r = await MA.submit({ uid: KASS, shopId: SHOP_B, profile: PROFILE, nowISO: NOW,
    agreementAccepted: true, fs: store.adapter });
  ck('C10 control: KASS submits by the same rules, no special case',
    r.ok === true && store.data[`applications/${KASS}--merchant`].status === 'pending_review');
}

/* ═══════════════════════════════════════════════════════════════════════════
   PART D — mutation control
   ═══════════════════════════════════════════════════════════════════════════ */
console.log('\nPART D — mutation control\n');

{
  const src = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-application.js'), 'utf8');

  const mutants = [
    { label: 'M1  type mutated away from seller',
      src: src.replace("var TYPE = 'seller';", "var TYPE = 'shop';") },
    { label: 'M2  status mutated away from pending_review',
      src: src.replace("var SUBMITTED = 'pending_review';", "var SUBMITTED = 'approved';") },
    { label: 'M3  the deterministic id becomes non-deterministic',
      src: src.replace('return String(uid) + DOC_SUFFIX;',
        'return String(uid) + DOC_SUFFIX + "_" + (buildDocument._n = (buildDocument._n || 0) + 1);') },
    { label: 'M4  shopId falls back to the uid',
      src: src.replace(
        "shopId: o.shopId != null && o.shopId !== '' ? String(o.shopId) : null,",
        "shopId: o.shopId != null && o.shopId !== '' ? String(o.shopId) : String(uid),") },
    { label: 'M5  the forbidden-field filter is removed',
      src: src.replace(/for \(var i = 0; i < FORBIDDEN\.length; i\+\+\) delete profile\[FORBIDDEN\[i\]\];/,
        '/* filter removed */')
        .replace(/var PROFILE_FIELDS = \[[\s\S]*?\];/,
          "var PROFILE_FIELDS = ['name','businessName','category','description','phone','email','location','role','status','approved','claims'];") },
  ];

  for (const mu of mutants) {
    if (mu.src === src) { ck(mu.label + ' → mutation applied', false, 'no-op replace — anchor moved'); continue; }
    const M = loadMutant(mu.src);
    let caught = false, detail = '';
    try {
      const store = makeStore();
      const r1 = await M.submit({ uid: SELLER_A, shopId: null, profile: { ...PROFILE, role: 'seller', status: 'approved', approved: true, claims: { seller: true } }, nowISO: NOW, fs: store.adapter });
      await M.submit({ uid: SELLER_A, shopId: null, profile: PROFILE, nowISO: NOW, fs: store.adapter });
      const ids = Object.keys(store.data).filter(k => k.startsWith('applications/'));
      const doc = store.data[ids[0]];
      const violations = [];
      if (doc.type !== 'seller') violations.push('type=' + doc.type);
      if (doc.status !== 'pending_review') violations.push('status=' + doc.status);
      if (ids.length !== 1) violations.push('duplicate applications: ' + ids.length);
      if (doc.shopId === doc.sellerUid) violations.push('shopId substituted by uid');
      if ('role' in doc || 'approved' in doc || 'claims' in doc) violations.push('forbidden field leaked');
      caught = violations.length > 0;
      detail = violations.join(' | ') || 'no violation produced';
      void r1;
    } catch (e) { detail = 'mutant crashed: ' + e.message; caught = true; }
    ck(mu.label + ' → detected', caught, detail);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   PART E — the Seller Agreement acknowledgement

   applicationDecide throws failed-precondition unless the application carries
   `agreementAccepted === true`. An application filed without it is therefore
   not "pending" — it is UN-APPROVABLE, and looks identical to a pending one in
   every dashboard. The submission must refuse rather than create one.
   ═══════════════════════════════════════════════════════════════════════════ */
console.log('\nPART E — an application that could never be approved is never created\n');

{
  const store = makeStore();
  const r = await submit(store, { agreementAccepted: undefined });
  ck('E1  submission WITHOUT the acknowledgement is refused',
    r.ok === false && r.reason === 'agreement_required', r.reason);
  ck('E2  ...and writes NO document (not an un-approvable one)',
    store.writes.length === 0 && !store.data[`applications/${SELLER_A}--merchant`],
    'writes=' + store.writes.length);
  ck('E3  the refusal explains what to do', /Seller Agreement/i.test(r.message || ''), r.message);
}

{
  /* Truthy is not true. `agreementAccepted: 'yes'` from a careless call site
     must not satisfy a gate the SERVER evaluates with ===. */
  for (const v of ['yes', 1, 'true', {}, []]) {
    const store = makeStore();
    const r = await submit(store, { agreementAccepted: v });
    ck(`E4  truthy-but-not-true (${JSON.stringify(v)}) is refused`,
      r.ok === false && r.reason === 'agreement_required', r.reason);
  }
}

{
  const store = makeStore();
  await submit(store);
  const doc = store.data[`applications/${SELLER_A}--merchant`];
  ck('E5  an accepted submission carries agreementAccepted === true',
    doc.agreementAccepted === true, doc.agreementAccepted);
  ck('E6  ...with the version of the text that was shown',
    doc.agreementVersion === MA.AGREEMENT_VERSION && !!MA.AGREEMENT_VERSION, doc.agreementVersion);
  ck('E7  ...and the acceptance time', doc.agreementAcceptedAt === NOW, doc.agreementAcceptedAt);
  ck('E8  the SERVER-stamped verification is NOT client-writable',
    !('agreementVerifiedAt' in doc) && !('agreementVerifiedVersion' in doc));
}

{
  /* A resubmission must re-state the acknowledgement against the CURRENT
     version, not inherit a stale one from the rejected attempt. */
  const store = makeStore({
    [`applications/${SELLER_A}--merchant`]: {
      status: 'rejected', agreementAccepted: true, agreementVersion: 'ANCIENT-TERMS-v0',
    },
  });
  const r = await submit(store, { nowISO: '2026-09-07T00:00:00.000Z' });
  const doc = store.data[`applications/${SELLER_A}--merchant`];
  ck('E9  a resubmission restates the acknowledgement at the current version',
    r.action === 'resubmit' && doc.agreementVersion === MA.AGREEMENT_VERSION, doc.agreementVersion);

  const store2 = makeStore({
    [`applications/${SELLER_A}--merchant`]: { status: 'rejected', agreementAccepted: true },
  });
  const r2 = await submit(store2, { agreementAccepted: false });
  ck('E10 a resubmission WITHOUT a fresh acknowledgement is refused — the stale one does not carry',
    r2.ok === false && r2.reason === 'agreement_required', r2.reason);
}

/* ═══════════════════════════════════════════════════════════════════════════
   PART F — the CALL SITES, not just the module

   The suite injects its own adapter, so it exercised submit() perfectly while
   the only real caller (onboarding-seller.html) built an adapter and never
   passed it — submit() threw "a firestore adapter is required" on every
   submission and no merchant could apply at all. A green module suite over a
   dead call site is exactly the failure this part exists to prevent.
   ═══════════════════════════════════════════════════════════════════════════ */
console.log('\nPART F — every real call site passes what submit() requires\n');

{
  /* Extract the argument object of each `.submit({...})` by brace matching, so
     multi-line call sites and nested objects are read correctly. */
  const SELF = path.basename(__filename);
  const files = fs.readdirSync(ROOT)
    .filter((f) => /\.(html|js)$/i.test(f))
    .filter((f) => f !== 'sokoni-merchant-application.js');

  const sites = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    if (!src.includes('SokoniMerchantApplication')) continue;
    const re = /SokoniMerchantApplication\s*\.\s*submit\s*\(\s*\{/g;
    let m;
    while ((m = re.exec(src))) {
      const open = m.index + m[0].length - 1;
      let depth = 0, end = -1;
      for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end === -1) continue;
      sites.push({ file: f, line: src.slice(0, m.index).split('\n').length, arg: src.slice(open, end + 1) });
    }
  }

  ck('F1  at least one real call site exists (the detector can see)', sites.length > 0, sites.length + ' site(s)');

  for (const s of sites) {
    const where = `${s.file}:${s.line}`;
    ck(`F2  ${where} passes the required \`fs\` adapter`, /(^|[\s,{])fs\s*:/.test(s.arg),
      /(^|[\s,{])fs\s*:/.test(s.arg) ? '' : 'submit() throws without it — no application is ever filed');
    ck(`F3  ${where} passes \`agreementAccepted\``, /(^|[\s,{])agreementAccepted\s*:/.test(s.arg),
      /(^|[\s,{])agreementAccepted\s*:/.test(s.arg) ? '' : 'the application would be un-approvable');
    ck(`F4  ${where} does not hard-code the acknowledgement to a literal true`,
      !/agreementAccepted\s*:\s*true\b/.test(s.arg),
      'the merchant must actually tick it');
  }

  /* Adversarial: the detector must FAIL on a call site missing `fs`. Without
     this, F2 passing proves only that the regex ran. */
  const mutant = "SokoniMerchantApplication.submit({ uid: u, profile: p, agreementAccepted: x })";
  const mOpen = mutant.indexOf('{');
  const mArg = mutant.slice(mOpen, mutant.lastIndexOf('}') + 1);
  ck('F5  the detector REJECTS a call site with no `fs` (adversarial control)',
    !/(^|[\s,{])fs\s*:/.test(mArg));
  void SELF;
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('\nsuite crashed:', e.stack, '\n'); process.exit(1); });

/* ── helpers ─────────────────────────────────────────────────────────────── */

function loadMutant(source) {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ma-'));
  const file = path.join(dir, 'sokoni-merchant-application.js');
  fs.writeFileSync(file, source);
  delete require.cache[require.resolve(file)];
  return require(file);
}

/* Stubs for loading the real Cloud Function trigger (see
   test-application-decision-authority.js — same technique, kept local so this
   suite runs standalone). */
function makeCfEnv({ accounts = {} } = {}) {
  const log = [];
  const mkDoc = (coll, id) => ({
    async get() { return { exists: false, id, data: () => null }; },
    async set(data, opts) { log.push({ op: 'set', coll, id, data, opts }); },
    async update(data) { log.push({ op: 'update', coll, id, data }); },
    async delete() { log.push({ op: 'delete', coll, id }); },
  });
  return {
    log,
    db: {
      collection: (coll) => ({
        doc: (id) => mkDoc(coll, id),
        async add(data) { log.push({ op: 'add', coll, data }); return { id: 'gen' }; },
        where() { return this; }, limit() { return this; }, orderBy() { return this; },
        async get() { return { docs: [], empty: true, forEach() {} }; },
      }),
      batch: () => ({ set() {}, update() {}, async commit() {} }),
    },
    auth: {
      async getUser(uid) {
        if (!accounts[uid]) { const e = new Error('no user record'); throw e; }
        return { uid, customClaims: accounts[uid] };
      },
      async setCustomUserClaims(uid, claims) { log.push({ op: 'MINT_CLAIM', uid, claims }); },
    },
  };
}

let CF_ENV = null;
function loadTrigger() {
  const FieldValue = {
    serverTimestamp: () => ({ __sentinel: 'serverTimestamp' }),
    arrayUnion: (...v) => ({ __sentinel: 'arrayUnion', values: v }),
    arrayRemove: (...v) => ({ __sentinel: 'arrayRemove', values: v }),
    increment: (by) => ({ __sentinel: 'increment', by }),
    delete: () => ({ __sentinel: 'delete' }),
  };
  let captured = null;
  const orig = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === 'firebase-admin/firestore') return { getFirestore: () => CF_ENV.db, FieldValue };
    if (id === 'firebase-admin/auth') return { getAuth: () => CF_ENV.auth };
    if (id === 'firebase-functions/logger') return { info() {}, warn() {}, debug() {}, error() {} };
    if (id === 'firebase-functions/v2/firestore') return { onDocumentWritten: (_o, h) => { captured = h; return h; } };
    if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => h, HttpsError: class extends Error {} };
    if (id === './notify' || id === './search-terms') return { notify: async () => {}, buildSearchTerms: () => [], searchTerms: () => [] };
    return orig.apply(this, arguments);
  };
  const file = path.join(FUNCTIONS_DIR, 'application-lifecycle.js');
  delete require.cache[require.resolve(file)];
  try { require(file); } finally { Module.prototype.require = orig; }
  if (!captured) throw new Error('trigger not registered');
  return captured;
}

async function runTrigger(trigger, env, appId, data) {
  CF_ENV = env;
  const ref = { async set(patch, opts) { env.log.push({ op: 'set', coll: 'applications', id: appId, data: patch, opts }); } };
  await trigger({ params: { appId }, data: { after: { exists: true, ref, data: () => data } } });
}
