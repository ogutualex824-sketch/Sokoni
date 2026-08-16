#!/usr/bin/env node
/* 2C — one seller_free trial authority, two callers.
 *
 *   node scripts/test-seller-trial.js
 *
 *   business-bootstrap._createBusiness  ─┐
 *                                        ├─→ buildSellerFreeTrial → subscriptions/{shopId}
 *   application approval (projectSeller) ─┘
 *
 * Proves the POS path is behaviourally unchanged by the extraction, and that
 * approval starts exactly one 14-day trial scoped to the canonical
 * sellerUid + shopId. Fixture: SELLER_A ≠ SHOP_B. KASS is a control.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const FUNCTIONS_DIR = path.join(ROOT, 'functions');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 150) + ']' : ''));
  ok ? pass++ : fail++;
};

const SELLER_A = 'SELLER_A_uid_7f3';
const SHOP_B = 'SHOP_B_shop_91c';
const KASS = 'D5Ql2EYr95bt79IpcGTmOMTK0P83';
const ADMIN = 'ADMIN_1';
const NOW_MS = 1786800000000;

/* ── stubs ───────────────────────────────────────────────────────────────── */
const TS = (ms) => ({ __ts: ms, toMillis: () => ms });
const FieldValue = {
  serverTimestamp: () => ({ __s: 'ts' }),
  arrayUnion: (...v) => ({ __s: 'arrayUnion', values: v }),
  arrayRemove: (...v) => ({ __s: 'arrayRemove', values: v }),
  increment: (by) => ({ __s: 'inc', by }),
  delete: () => ({ __s: 'del' }),
};
const Timestamp = { fromMillis: (ms) => TS(ms) };

let ENV;
function makeEnv({ docs = {}, accounts = {} } = {}) {
  const data = { ...docs };
  const log = [];
  const apply = (p, doc, merge) => { data[p] = merge ? { ...(data[p] || {}), ...doc } : { ...doc }; };
  const mkDoc = (coll, id) => ({
    __path: `${coll}/${id}`,
    async get() { const p = `${coll}/${id}`; return { exists: !!data[p], id, data: () => data[p] }; },
    async set(doc, opts) { log.push({ op: 'set', coll, id, doc }); apply(`${coll}/${id}`, doc, opts && opts.merge); },
    async update(doc) { log.push({ op: 'update', coll, id, doc }); apply(`${coll}/${id}`, doc, true); },
    async delete() { delete data[`${coll}/${id}`]; },
  });
  return {
    data, log,
    db: {
      collection: (coll) => ({
        doc: (id) => mkDoc(coll, id),
        async add(doc) { log.push({ op: 'add', coll, doc }); return { id: 'gen' }; },
        where() { return this; }, limit() { return this; }, orderBy() { return this; },
        async get() { return { docs: [], empty: true, forEach() {} }; },
      }),
      batch() {
        const ops = [];
        return {
          set(ref, doc, opts) { ops.push([ref, doc, opts]); },
          update(ref, doc) { ops.push([ref, doc, { merge: true }]); },
          async commit() { ops.forEach(([r, doc, o]) => { log.push({ op: 'batch.set', path: r.__path, doc }); apply(r.__path, doc, o && o.merge); }); },
        };
      },
    },
    auth: {
      async getUser(uid) { if (!accounts[uid]) throw new Error('no user'); return { uid, customClaims: accounts[uid] }; },
      async setCustomUserClaims(uid, claims) { log.push({ op: 'MINT_CLAIM', uid, claims }); accounts[uid] = claims; },
    },
  };
}

function withStubs(fn) {
  const orig = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === 'firebase-admin/firestore') return { getFirestore: () => ENV.db, FieldValue, Timestamp };
    if (id === 'firebase-admin/auth') return { getAuth: () => ENV.auth };
    if (id === 'firebase-functions/logger') return { info() {}, warn() {}, debug() {}, error() {} };
    if (id === 'firebase-functions/v2/firestore') return { onDocumentWritten: (_o, h) => { Module._captured = h; return h; } };
    if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => h, HttpsError: class extends Error { constructor(c, m) { super(m); this.code = c; } } };
    if (id === './notify') return { notify: async () => {} };
    if (id === './search-terms') return { buildSearchTerms: () => [], searchTerms: () => [] };
    return orig.apply(this, arguments);
  };
  try { return fn(); } finally { Module.prototype.require = orig; }
}

const ST = withStubs(() => { delete require.cache[require.resolve(path.join(FUNCTIONS_DIR, 'seller-trial.js'))]; return require(path.join(FUNCTIONS_DIR, 'seller-trial.js')); });

function loadTrigger() {
  Module._captured = null;
  const file = path.join(FUNCTIONS_DIR, 'application-lifecycle.js');
  withStubs(() => { delete require.cache[require.resolve(file)]; delete require.cache[require.resolve(path.join(FUNCTIONS_DIR, 'seller-trial.js'))]; require(file); });
  if (!Module._captured) throw new Error('trigger not registered');
  return Module._captured;
}

const APP = (over = {}) => ({
  applicationId: `${SELLER_A}--merchant`, uid: SELLER_A, sellerUid: SELLER_A, shopId: SHOP_B,
  type: 'seller', role: 'seller', name: 'Shop B Traders', phoneNumber: '+254726043059',
  intakeVersion: 1, roleResolvedBy: 'keyword', status: 'pending_review', ...over,
});
async function fire(trigger, app, appId = `${SELLER_A}--merchant`) {
  const ref = { async set(p) { ENV.data[`applications/${appId}`] = { ...(ENV.data[`applications/${appId}`] || {}), ...p }; } };
  await trigger({ params: { appId }, data: { after: { exists: true, ref, data: () => app } } });
}
const subs = () => Object.keys(ENV.data).filter(k => k.startsWith('subscriptions/'));

(async () => {
/* ═══ A — POS equivalence ═══ */
console.log('\nPART A — the POS path is behaviourally unchanged\n');
{
  ENV = makeEnv();
  /* The field set the POS path wrote BEFORE the extraction, verbatim. */
  const ORIGINAL = {
    merchantId: 'M_POS_1', uid: SELLER_A, hubType: 'seller', planId: 'seller_free',
    planName: 'SmartPOS', plan: 'trial', status: 'trialing', trial: true, trialDays: 14,
    trialStartsAt: { __s: 'ts' }, currentPeriodStart: { __s: 'ts' },
    trialEndsAt: TS(NOW_MS + 14 * 86400000), currentPeriodEnd: TS(NOW_MS + 14 * 86400000),
    graceEnd: TS(NOW_MS + 17 * 86400000), autoActivated: true,
    startedAt: { __s: 'ts' }, createdAt: { __s: 'ts' },
  };
  const built = ST.buildSellerFreeTrial({
    uid: SELLER_A, shopId: 'M_POS_1', planName: 'SmartPOS',
    now: { __s: 'ts' }, nowMs: NOW_MS, source: 'pos_create_business',
  });

  const mismatched = Object.keys(ORIGINAL).filter(k => JSON.stringify(built[k]) !== JSON.stringify(ORIGINAL[k]));
  ck('A1  every field the POS path wrote is unchanged', mismatched.length === 0, mismatched.join(','));
  ck('A2  the document id is still the merchantId', built.merchantId === 'M_POS_1');
  ck('A3  the POS label is preserved', built.planName === 'SmartPOS');
  ck('A4  trial window is 14 days', (built.trialEndsAt.toMillis() - NOW_MS) / 86400000 === 14);
  ck('A5  grace is 3 days beyond the trial',
    (built.graceEnd.toMillis() - built.trialEndsAt.toMillis()) / 86400000 === 3);

  const added = Object.keys(built).filter(k => !(k in ORIGINAL));
  ck('A6  only ADDITIVE fields were introduced (superset, not a change)',
    added.every(k => ['shopId', 'sellerUid', 'source'].includes(k)), added.join(','));

  const bb = fs.readFileSync(path.join(FUNCTIONS_DIR, 'business-bootstrap.js'), 'utf8');
  ck('A7  _createBusiness now calls the shared authority',
    /buildSellerFreeTrial\(\{/.test(bb) && /require\('\.\/seller-trial'\)/.test(bb));
  ck('A8  ...and no longer holds its own copy of the trial fields',
    !/planId:\s*'seller_free'/.test(bb), 'a duplicate literal remains');
  ck('A9  ...still writing subscriptions/{merchantId} in the same batch',
    /batch\.set\(db\.collection\('subscriptions'\)\.doc\(merchantId\), buildSellerFreeTrial/.test(bb));
}

/* ═══ B — the lifecycle ═══ */
console.log('\nPART B — a trial starts on approval, and only then\n');
{
  const trigger = loadTrigger();

  ENV = makeEnv({ accounts: { [SELLER_A]: {} } });
  await fire(trigger, APP());
  ck('B1  pending → NO subscription', subs().length === 0, subs().join(','));

  ENV = makeEnv({ accounts: { [SELLER_A]: {}, [ADMIN]: { admin: true } } });
  await fire(trigger, APP({ status: 'rejected', decidedBy: ADMIN }));
  ck('B2  rejected → NO subscription', subs().length === 0, subs().join(','));

  ENV = makeEnv({ accounts: { [SELLER_A]: {} } });
  await fire(trigger, APP({ status: 'approved' }));   /* self-approval, no admin */
  ck('B3  an unauthorised approval → NO subscription', subs().length === 0);

  ENV = makeEnv({ accounts: { [SELLER_A]: { rider: true }, [ADMIN]: { admin: true } } });
  await fire(trigger, APP({ status: 'approved', decidedBy: ADMIN }));
  const ids = subs();
  ck('B4  approved → exactly ONE subscription', ids.length === 1, ids.join(','));
  const sub = ENV.data[ids[0]];
  ck('B5  ...keyed by the SHOP, not the account',
    ids[0] === `subscriptions/${SHOP_B}` && sub.shopId === SHOP_B, ids[0]);
  ck('B6  ...recording the seller uid (the expiry notifier reads users/{uid})',
    sub.uid === SELLER_A && sub.sellerUid === SELLER_A);
  ck('B7  ...and the two identities are different', sub.uid !== sub.shopId);
  ck('B8  plan is seller_free, status trialing, trial true',
    sub.planId === 'seller_free' && sub.status === 'trialing' && sub.trial === true);
  ck('B9  trialDays is 14', sub.trialDays === 14);
  ck('B10 the expiry fields the sweeps read are present',
    !!sub.currentPeriodEnd && !!sub.trialEndsAt && !!sub.graceEnd);
  ck('B11 the source is recorded', sub.source === 'application_approval');
  ck('B12 the existing rider claim survived', ENV.log.some(e => e.op === 'MINT_CLAIM' && e.claims.rider === true));

  /* No POS-only records for a marketplace approval. */
  ck('B13 no POS merchants/ or branches/ records were created',
    !Object.keys(ENV.data).some(k => /^(merchants|branches|posDevices)\//.test(k)),
    Object.keys(ENV.data).filter(k => /^(merchants|branches)\//.test(k)).join(','));
}

/* ═══ C — idempotency ═══ */
console.log('\nPART C — approving twice does not start a second trial\n');
{
  const trigger = loadTrigger();
  ENV = makeEnv({ accounts: { [SELLER_A]: {}, [ADMIN]: { admin: true } } });
  await fire(trigger, APP({ status: 'approved', decidedBy: ADMIN }));
  const first = { ...ENV.data[`subscriptions/${SHOP_B}`] };
  await fire(trigger, APP({ status: 'approved', decidedBy: ADMIN }));
  ck('C1  still exactly one subscription', subs().length === 1, subs().join(','));
  ck('C2  its dates were not restarted',
    JSON.stringify(ENV.data[`subscriptions/${SHOP_B}`].trialEndsAt) === JSON.stringify(first.trialEndsAt));

  /* A paid plan must never be overwritten by a free trial. */
  ENV = makeEnv({
    accounts: { [SELLER_A]: {}, [ADMIN]: { admin: true } },
    docs: { [`subscriptions/${SHOP_B}`]: { planId: 'seller_pro', status: 'active', trial: false } },
  });
  await fire(trigger, APP({ status: 'approved', decidedBy: ADMIN }));
  ck('C3  an existing PAID plan is left alone',
    ENV.data[`subscriptions/${SHOP_B}`].planId === 'seller_pro' &&
    ENV.data[`subscriptions/${SHOP_B}`].status === 'active');

  const r = await ST.startSellerFreeTrial({ db: ENV.db, uid: SELLER_A, shopId: SHOP_B });
  ck('C4  the primitive reports why it did nothing', r.created === false && r.reason === 'already_subscribed');
}

/* ═══ D — control + the workspace can read it ═══ */
console.log('\nPART D — control, and the merchant UI can read the trial\n');
{
  const trigger = loadTrigger();
  ENV = makeEnv({ accounts: { [KASS]: {}, [ADMIN]: { admin: true } } });
  await fire(trigger, { ...APP({ status: 'approved', decidedBy: ADMIN }), uid: KASS, sellerUid: KASS, shopId: null, name: 'kassshop' }, `${KASS}--merchant`);
  ck('D1  control: KASS gets one trial on its own shop',
    !!ENV.data[`subscriptions/${KASS}`] && ENV.data[`subscriptions/${KASS}`].planId === 'seller_free');

  /* The workspace resolves the shop, then reads the subscription by that id. */
  const MD = require(path.join(ROOT, 'sokoni-merchant-data.js'));
  const db = { getDoc: async (c, id) => ENV.data[`${c}/${id}`] || null };
  const res = await MD.resolveShopId({ uid: KASS, db });
  const trialDoc = await db.getDoc('subscriptions', res.shopId);
  ck('D2  merchant.html can read the trial for the shop it resolved',
    !!trialDoc && trialDoc.status === 'trialing' && trialDoc.trialDays === 14, JSON.stringify(res.shopId));
  ck('D3  ...and it carries a real end date to count down from',
    !!trialDoc.trialEndsAt && typeof trialDoc.trialEndsAt.toMillis === 'function');
}

/* ═══ E — mutation control ═══ */
console.log('\nPART E — mutation control\n');
{
  const src = fs.readFileSync(path.join(FUNCTIONS_DIR, 'seller-trial.js'), 'utf8');
  const alSrc = fs.readFileSync(path.join(FUNCTIONS_DIR, 'application-lifecycle.js'), 'utf8');
  const os = require('os');

  const loadMutantTrial = (s) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
    const f = path.join(dir, 'seller-trial.js');
    fs.writeFileSync(f, s);
    return withStubs(() => { delete require.cache[require.resolve(f)]; return require(f); });
  };

  const m1 = loadMutantTrial(src.replace('const TRIAL_DAYS = 14;', 'const TRIAL_DAYS = 30;'));
  ck('M1  the trial length drifts from 14 days → detected',
    m1.buildSellerFreeTrial({ uid: SELLER_A, shopId: SHOP_B, nowMs: NOW_MS, now: {} }).trialDays !== 14);

  const m2 = loadMutantTrial(src.replace(/    if \(snap\.exists\) \{[\s\S]*?\n    \}/, ''));
  ENV = makeEnv({ docs: { [`subscriptions/${SHOP_B}`]: { planId: 'seller_pro', status: 'active' } } });
  const r2 = await m2.startSellerFreeTrial({ db: ENV.db, uid: SELLER_A, shopId: SHOP_B });
  ck('M2  idempotency removed (a paid plan overwritten) → detected',
    r2.created === true && ENV.data[`subscriptions/${SHOP_B}`].planId === 'seller_free');

  const m3 = loadMutantTrial(src.replace("uid: String(o.uid),\n    sellerUid: String(o.uid),", "uid: String(o.shopId),\n    sellerUid: String(o.shopId),"));
  ck('M3  the trial is scoped to the shop instead of the seller → detected',
    m3.buildSellerFreeTrial({ uid: SELLER_A, shopId: SHOP_B, nowMs: NOW_MS, now: {} }).uid === SHOP_B);

  ck('M4  approval starts the trial only for an approved seller',
    /if \(approved && role === 'seller'\)/.test(alSrc));
  ck('M5  approval does not build its own trial payload',
    !/planId:\s*'seller_free'/.test(alSrc));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('\nsuite crashed:', e.stack, '\n'); process.exit(1); });
