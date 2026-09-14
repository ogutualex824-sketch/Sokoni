#!/usr/bin/env node
/* OB-4 — the AdminOS verification counters must count the field the writer writes.
 *
 *   node scripts/test-admin-verification-counters.js
 *   COUNTERPROOF=1 node scripts/test-admin-verification-counters.js   # against the PRE-FIX source
 *
 * SDKs are stubbed and the REAL handlers are invoked (adminGetExecutiveDashboard,
 * adminGetMerchantPipeline), so the assertions are on numbers those endpoints actually return.
 *
 * THE STATE THIS REMOVES
 * Both counters queried `providerVerification.where('verificationStatus', …)`.
 * `verificationStatus` is the field the MIRROR on providerProfiles/{uid} carries. The writers
 * of providerVerification — providerSubmitVerification and, since OB-3,
 * adminDecideProviderVerification — both write `status`. So the queries matched nothing and
 * the queue reported 0 however much work was waiting.
 *
 * The pipeline counter was wrong on a second axis as well: it asked for
 * `['verified','approved']`, neither of which any writer produces. OB-3's states are
 * pending_review / verified_on_file / rejected.
 *
 * This was latent while nothing could ever be decided. OB-3 made the queue real, which is
 * what turns a cosmetic mismatch into an operator looking at "0 pending" and looking away.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const FUNCTIONS_DIR = path.join(ROOT, 'functions');
const COUNTERPROOF = !!process.env.COUNTERPROOF;

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 140) + ']' : ''));
  ok ? pass++ : fail++;
};

const ADMIN = 'ADMIN_1';
const RANDO = 'RANDO_1';

const FieldValue = {
  serverTimestamp: () => ({ __s: 'ts' }),
  arrayUnion: (...v) => ({ __s: 'au', values: v }),
  increment: (by) => ({ __s: 'inc', by }),
  delete: () => ({ __s: 'del' }),
};

let ENV;
function makeEnv({ docs = {} } = {}) {
  const data = { ...docs };
  const log = [];
  const mkDoc = (coll, id) => ({
    __path: `${coll}/${id}`,
    async get() { const p = `${coll}/${id}`; return { exists: !!data[p], id, data: () => data[p] }; },
    async set(doc, opts) { log.push({ op: 'set', coll, id, doc }); data[`${coll}/${id}`] = opts && opts.merge ? { ...(data[`${coll}/${id}`] || {}), ...doc } : { ...doc }; return this; },
    async update(doc) { log.push({ op: 'update', coll, id, doc }); Object.assign(data[`${coll}/${id}`] || (data[`${coll}/${id}`] = {}), doc); return this; },
    async delete() { log.push({ op: 'delete', coll, id }); delete data[`${coll}/${id}`]; },
  });
  const mkColl = (coll, preds = []) => {
    const self = {
      doc: (id) => mkDoc(coll, id),
      async add(doc) { log.push({ op: 'add', coll, doc }); return { id: 'gen' }; },
      where(f, o, v) { return mkColl(coll, preds.concat([[f, o, v]])); },
      limit() { return self; }, orderBy() { return self; },
      /* count() returns ONLY a number — no document bodies ever leave this call.
         That is what keeps a public-ish admin overview from becoming a way to read
         restricted verification evidence (id/licence/KRA upload URLs). */
      count() { return { get: async () => { const s = await self.get(); log.push({ op: 'COUNT', coll, preds }); return { data: () => ({ count: s.size }) }; } }; },
      async get() {
        log.push({ op: 'QUERY', coll, preds });
        const match = (d) => preds.every(([f, o, v]) => {
          const a = d ? d[f] : undefined;
          if (o === '==') return a === v;
          if (o === 'in') return Array.isArray(v) && v.includes(a);
          if (o === '>=') return a !== undefined && a >= v;
          return true;
        });
        const docs = Object.keys(data)
          .filter((p) => p.startsWith(coll + '/') && p.slice(coll.length + 1).indexOf('/') === -1)
          .filter((p) => match(data[p]))
          .map((p) => ({ id: p.slice(coll.length + 1), data: () => data[p], ref: mkDoc(coll, p.slice(coll.length + 1)) }));
        return { docs, size: docs.length, empty: !docs.length, forEach: (f) => docs.forEach(f) };
      },
    };
    return self;
  };
  return { data, log, db: { collection: mkColl }, auth: { async getUser(u) { return { uid: u, customClaims: {} }; }, async setCustomUserClaims() {} } };
}

/** PRE-FIX: the counters back on the mirror's field (and the pipeline's stale values). */
function prefixSource() {
  let s = fs.readFileSync(path.join(FUNCTIONS_DIR, 'admin-os.js'), 'utf8');
  const n1 = "db.collection('providerVerification').where('status', '==', 'pending_review').count()";
  const o1 = "db.collection('providerVerification').where('verificationStatus', '==', 'pending_review').count()";
  const n2 = "db.collection('providerVerification').where('status', '==', 'verified_on_file').count()";
  const o2 = "db.collection('providerVerification').where('verificationStatus', 'in', ['verified', 'approved']).count()";
  if (!s.includes(n1) || !s.includes(n2)) throw new Error('counter anchors not found — refusing to guess');
  return s.replace(n1, o1).replace(n2, o2);
}

let OPS = null;
function load() {
  const orig = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === 'firebase-admin/firestore') return { getFirestore: () => ENV.db, FieldValue, Timestamp: { fromDate: (d) => +d } };
    if (id === 'firebase-admin/auth') return { getAuth: () => ENV.auth };
    if (id === 'firebase-functions/logger') return { info() {}, warn() {}, debug() {}, error() {} };
    if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => h, HttpsError: class extends Error { constructor(c, m) { super(m); this.code = c; } } };
    if (id === 'firebase-functions/v2/firestore') return { onDocumentWritten: (_o, h) => h };
    if (id === 'firebase-functions/params') return { defineSecret: (n) => ({ name: n, value: () => 's' }) };
    return orig.apply(this, arguments);
  };
  let file = path.join(FUNCTIONS_DIR, 'admin-os.js');
  if (COUNTERPROOF) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob4-'));
    file = path.join(dir, 'admin-os.js');
    fs.writeFileSync(file, prefixSource());
    /* Sibling shims derived FROM THE SOURCE, never hand-listed: a hand-kept list rots the
       moment the module gains a dependency, and the mutant then fails to LOAD while the run
       reports "nothing detected". */
    const src = fs.readFileSync(path.join(FUNCTIONS_DIR, 'admin-os.js'), 'utf8');
    const sibs = new Set();
    for (const m of src.matchAll(/require\('\.\/([A-Za-z0-9_-]+)'\)/g)) sibs.add(m[1]);
    for (const sib of sibs) {
      fs.writeFileSync(path.join(dir, sib + '.js'),
        `module.exports = require(${JSON.stringify(path.join(FUNCTIONS_DIR, sib + '.js'))});`);
    }
  }
  delete require.cache[require.resolve(file)];
  OPS = require(file)._h;
}

/* A realistic queue: 3 awaiting review, 2 document-verified, 1 rejected, 1 with NO status.
   The no-status row is the control for "unknown must not inflate a meaningful count". */
const V = (id, status, extra) => ({ [`providerVerification/${id}`]: Object.assign({ uid: id,
  nationalIdUrl: 'https://x/' + id + '-id.jpg', licenceUrl: 'https://x/' + id + '-lic.jpg' },
  status ? { status } : {}, extra || {}) });
const QUEUE = Object.assign({},
  V('p1', 'pending_review'), V('p2', 'pending_review'), V('p3', 'pending_review'),
  V('v1', 'verified_on_file'), V('v2', 'verified_on_file'),
  V('r1', 'rejected'),
  V('x1', null),                                   /* no status at all */
  /* The MIRROR field lives on providerProfiles and must not be what the counters read. */
  { 'providerProfiles/p1': { uid: 'p1', verificationStatus: 'pending_review' } },
);

/* The pending-verification counter lives in adminGetExecutiveDashboard (admin-os.js:427),
   NOT adminGetPlatformOverview (:21). Resolving the ENCLOSING FUNCTION rather than trusting the
   line number is the difference between testing the counter and testing a neighbour. */
const overview = async (actor, claims) => {
  try { return { ok: true, res: await OPS.adminGetExecutiveDashboard({ auth: actor ? { uid: actor, token: claims || {} } : null, data: {} }) }; }
  catch (e) { return { ok: false, message: e.message }; }
};
const pipeline = async (actor, claims) => {
  try { return { ok: true, res: await OPS.adminGetMerchantPipeline({ auth: actor ? { uid: actor, token: claims || {} } : null, data: {} }) }; }
  catch (e) { return { ok: false, message: e.message }; }
};
const stage = (res, key) => ((res.stages || []).find((s) => s.key === key) || {}).count;
/* The overview returns many counts; find the one that is the verification queue by
   locating whichever key carries the pending-verification number. Asserting on the number
   the endpoint actually returns, not on a field name we hope it uses. */
const pendingVerif = (res) => (res || {}).pendingProviderVerification;

(async () => {
  console.log('\nSOURCE: ' + (COUNTERPROOF ? 'PRE-FIX (counters on verificationStatus)' : 'current'));
  console.log('='.repeat(70));
  load();

  /* ═══ A — the pipeline stage ═══ */
  console.log('\nA. merchant pipeline — the Verified stage');
  ENV = makeEnv({ docs: QUEUE });
  let r = await pipeline(ADMIN, { admin: true });
  ck('A1  the endpoint answers for an admin', r.ok, r.ok ? 'ok' : r.message);
  ck('A2  verified_on_file records are counted  <- the mismatch', stage(r.res, 'verified') === 2, stage(r.res, 'verified'));
  ck('A3  the stage label no longer overstates what it counts',
    ((r.res.stages || []).find((s) => s.key === 'verified') || {}).label === 'Docs Verified',
    ((r.res.stages || []).find((s) => s.key === 'verified') || {}).label);

  /* ═══ B — the overview counter ═══ */
  console.log('\nB. platform overview — pending verifications');
  ENV = makeEnv({ docs: QUEUE });
  r = await overview(ADMIN, { admin: true });
  ck('B1  the endpoint answers for an admin', r.ok, r.ok ? 'ok' : r.message);
  ck('B2  pending_review records are counted  <- the mismatch', pendingVerif(r.res) === 3, pendingVerif(r.res));

  /* ═══ C — what must NOT be counted ═══ */
  console.log('\nC. exclusions');
  ENV = makeEnv({ docs: QUEUE });
  const pr = await pipeline(ADMIN, { admin: true });
  const ov = await overview(ADMIN, { admin: true });
  ck('C1  a record with NO status is not counted as pending', pendingVerif(ov.res) === 3, pendingVerif(ov.res));
  ck('C2  ...nor as verified — unknown inflates nothing', stage(pr.res, 'verified') === 2, stage(pr.res, 'verified'));
  ck('C3  rejected records are not counted as pending or verified',
    pendingVerif(ov.res) === 3 && stage(pr.res, 'verified') === 2);
  ck('C4  the counters read providerVerification.status, NOT the providerProfiles mirror',
    ENV.log.filter((e) => e.op === 'COUNT' && e.coll === 'providerVerification')
      .every((e) => e.preds.every(([f]) => f === 'status')),
    JSON.stringify(ENV.log.filter((e) => e.op === 'COUNT' && e.coll === 'providerVerification').map((e) => e.preds)));

  /* ═══ D — empty ═══ */
  console.log('\nD. an empty collection');
  ENV = makeEnv({ docs: { 'providerProfiles/p1': { uid: 'p1', verificationStatus: 'pending_review' } } });
  const ov2 = await overview(ADMIN, { admin: true });
  const pr2 = await pipeline(ADMIN, { admin: true });
  ck('D1  no verification records ⇒ 0 pending', pendingVerif(ov2.res) === 0, pendingVerif(ov2.res));
  ck('D2  ...and 0 verified', stage(pr2.res, 'verified') === 0, stage(pr2.res, 'verified'));
  ck('D3  ...even though a providerProfiles mirror exists (proves the mirror is not the source)',
    pendingVerif(ov2.res) === 0);

  /* ═══ E — read-only, and no evidence leaks ═══ */
  console.log('\nE. the counters are reads, and return numbers only');
  ENV = makeEnv({ docs: QUEUE });
  const before = JSON.stringify(ENV.data);
  await overview(ADMIN, { admin: true });
  await pipeline(ADMIN, { admin: true });
  ck('E1  no verification record was mutated', JSON.stringify(ENV.data) === before);
  ck('E2  no write of any kind was issued',
    !ENV.log.some((e) => ['set', 'update', 'delete', 'add'].includes(e.op)),
    ENV.log.filter((e) => ['set', 'update', 'delete', 'add'].includes(e.op)).length);
  const blob = JSON.stringify((await pipeline(ADMIN, { admin: true })).res) +
               JSON.stringify((await overview(ADMIN, { admin: true })).res);
  ck('E3  no restricted evidence is exposed (no document URLs in either response)',
    !/nationalIdUrl|licenceUrl|kraPinUrl|selfieUrl|https:\/\/x\//.test(blob));

  /* ═══ F — authorization unchanged ═══ */
  console.log('\nF. authorization is untouched by this gate');
  ENV = makeEnv({ docs: QUEUE });
  ck('F1  unauthenticated REFUSED', !(await overview(null, null)).ok);
  ck('F2  ordinary user REFUSED', !(await overview(RANDO, {})).ok);
  ck('F3  ...on the pipeline too', !(await pipeline(RANDO, {})).ok);
  ck('F4  superAdmin still allowed', (await overview('S1', { superAdmin: true })).ok);

  /* ═══ G — neighbouring counters unchanged ═══ */
  console.log('\nG. the other counters in the same endpoints still work');
  ENV = makeEnv({ docs: Object.assign({}, QUEUE, {
    'applications/a1': { status: 'pending' }, 'applications/a2': { status: 'approved' },
    'providers/pr1': { status: 'active' }, 'providers/pr2': { status: 'pending_approval' },
    'providerSubscriptions/s1': { status: 'active' },
  }) });
  const pr3 = await pipeline(ADMIN, { admin: true });
  ck('G1  applied counts all applications', stage(pr3.res, 'applied') === 2, stage(pr3.res, 'applied'));
  ck('G2  pendingReview counts pending applications', stage(pr3.res, 'pendingReview') === 1, stage(pr3.res, 'pendingReview'));
  ck('G3  published counts active/approved providers', stage(pr3.res, 'published') === 1, stage(pr3.res, 'published'));
  ck('G4  subscribed counts active subscriptions', stage(pr3.res, 'subscribed') === 1, stage(pr3.res, 'subscribed'));
  ck('G5  active counts active providers', stage(pr3.res, 'active') === 1, stage(pr3.res, 'active'));

  /* ═══ H — the stale field is gone ═══ */
  console.log('\nH. no query on this collection uses the stale field');
  const src = fs.readFileSync(path.join(FUNCTIONS_DIR, 'admin-os.js'), 'utf8');
  const stale = (src.match(/collection\('providerVerification'\)[^\r\n]*verificationStatus/g) || []);
  ck('H1  zero providerVerification queries reference verificationStatus', stale.length === 0, stale.length);
  ck('H2  ...and the mirror field is still written on providerProfiles (not removed)',
    /providerProfiles[\s\S]{0,200}verificationStatus/.test(src));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (COUNTERPROOF) console.log('(counter-proof: failures here ARE the defect this gate removes)');
  console.log('');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
