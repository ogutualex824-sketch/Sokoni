#!/usr/bin/env node
/* 2B — admin approval is the only transition to a LIVE seller.
 *
 *   node scripts/test-approval-activates-shop.js
 *
 * Drives the REAL applicationLifecycle trigger against stubbed SDKs, so the
 * assertions are on documents actually written and claims actually minted.
 *
 * THE STATE THIS REMOVES
 * `seller` used to be in DELEGATED_ROLES: approval granted the role and the
 * claim and projected NOTHING, on the assumption sellers had their own
 * onboarding pipeline. They did not — so an approved merchant was authorised to
 * sell with no shop to sell from, and merchant.html had no canonical shop to
 * resolve.
 *
 * FIXTURE — non-degenerate: the application NAMES shop SHOP_B while the account
 * is SELLER_A, so an implementation that quietly uses the uid as the shop id
 * fails here. KASS is a control.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
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

const FieldValue = {
  serverTimestamp: () => ({ __s: 'ts' }),
  arrayUnion: (...v) => ({ __s: 'arrayUnion', values: v }),
  arrayRemove: (...v) => ({ __s: 'arrayRemove', values: v }),
  increment: (by) => ({ __s: 'inc', by }),
  delete: () => ({ __s: 'del' }),
};

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
    /* role-authority retires the reconcile record after a successful mint. A
       stub without `delete` throws inside syncRoleClaim's try, which is caught
       and reported as a CLAIM FAILURE — the projection then records
       `applied_claim_pending` and the suite blames the code for a hole in its
       own harness. */
    async delete() { log.push({ op: 'delete', coll, id }); delete data[`${coll}/${id}`]; },
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
          async commit() { ops.forEach(([ref, doc, opts]) => { log.push({ op: 'batch.set', path: ref.__path, doc }); apply(ref.__path, doc, opts && opts.merge); }); },
        };
      },
    },
    auth: {
      async getUser(uid) { if (!accounts[uid]) throw new Error('no user record'); return { uid, customClaims: accounts[uid] }; },
      async setCustomUserClaims(uid, claims) { log.push({ op: 'MINT_CLAIM', uid, claims }); accounts[uid] = claims; },
    },
  };
}

function loadTrigger(sourceOverride) {
  let captured = null;
  const orig = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === 'firebase-admin/firestore') return { getFirestore: () => ENV.db, FieldValue };
    if (id === 'firebase-admin/auth') return { getAuth: () => ENV.auth };
    if (id === 'firebase-functions/logger') return { info() {}, warn() {}, debug() {}, error() {} };
    if (id === 'firebase-functions/v2/firestore') return { onDocumentWritten: (_o, h) => { captured = h; return h; } };
    if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => h, HttpsError: class extends Error { constructor(c, m) { super(m); this.code = c; } } };
    if (id === './notify') return { notify: async () => {} };
    if (id === './search-terms') return { buildSearchTerms: () => [], searchTerms: () => [] };
    if (id === './role-authority') return orig.call(this, path.join(FUNCTIONS_DIR, 'role-authority.js'));
    return orig.apply(this, arguments);
  };
  let file = path.join(FUNCTIONS_DIR, 'application-lifecycle.js');
  if (sourceOverride) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-'));
    file = path.join(dir, 'application-lifecycle.js');
    fs.writeFileSync(file, sourceOverride);
    fs.writeFileSync(path.join(dir, 'role-authority.js'),
      `module.exports = require(${JSON.stringify(path.join(FUNCTIONS_DIR, 'role-authority.js'))});`);
  }
  delete require.cache[require.resolve(file)];
  try { require(file); } finally { Module.prototype.require = orig; }
  if (!captured) throw new Error('trigger not registered');
  return captured;
}

const APP = (over = {}) => ({
  applicationId: `${SELLER_A}--merchant`,
  uid: SELLER_A, sellerUid: SELLER_A, shopId: SHOP_B,
  type: 'seller', role: 'seller', name: 'Shop B Traders',
  phone: '0726043059', phoneNumber: '+254726043059', location: 'Nairobi',
  intakeVersion: 1, roleResolvedBy: 'keyword',
  status: 'pending_review',
  ...over,
});

async function fire(trigger, app, appId = `${SELLER_A}--merchant`) {
  const ref = { async set(patch, opts) { ENV.log.push({ op: 'set', coll: 'applications', id: appId, doc: patch, opts }); ENV.data[`applications/${appId}`] = { ...(ENV.data[`applications/${appId}`] || {}), ...patch }; } };
  await trigger({ params: { appId }, data: { after: { exists: true, ref, data: () => app } } });
}

const minted = () => ENV.log.filter(e => e.op === 'MINT_CLAIM');

(async () => {
const trigger = loadTrigger();

/* ═══ A — pending grants nothing ═══ */
console.log('\nPART A — pending is not live\n');
{
  ENV = makeEnv({ accounts: { [SELLER_A]: {} } });
  await fire(trigger, APP());
  ck('A1  a pending application mints no claim', minted().length === 0);
  ck('A2  ...creates no shop', !ENV.data[`shops/${SHOP_B}`] && !ENV.data[`shops/${SELLER_A}`]);
  ck('A3  ...creates no seller registry row', !ENV.data[`sellers/${SELLER_A}`]);
  ck('A4  ...and sets no activeShopId', !(ENV.data[`users/${SELLER_A}`] || {}).activeShopId);

  /* The applicant flipping their own status is still refused (bc9bf4c). */
  ENV = makeEnv({ accounts: { [SELLER_A]: {} } });
  await fire(trigger, APP({ status: 'approved' }));
  ck('A5  self-approval still activates nothing',
    minted().length === 0 && !ENV.data[`shops/${SHOP_B}`]);
}

/* ═══ B — admin approval goes live ═══ */
console.log('\nPART B — approval creates the shop, THEN the role\n');
{
  ENV = makeEnv({ accounts: { [SELLER_A]: { rider: true }, [ADMIN]: { admin: true } } });
  await fire(trigger, APP({ status: 'approved', decidedBy: ADMIN }));

  const shop = ENV.data[`shops/${SHOP_B}`];
  const seller = ENV.data[`sellers/${SELLER_A}`];
  const user = ENV.data[`users/${SELLER_A}`];

  ck('B1  the canonical shop exists and is active', !!shop && shop.status === 'active');
  ck('B2  ...at SHOP_B, the shop the application named — not the uid',
    !!shop && shop.shopId === SHOP_B && !ENV.data[`shops/${SELLER_A}`], SHOP_B);
  ck('B3  ...owned by SELLER_A (what every ownership check reads)',
    shop.ownerId === SELLER_A && shop.sellerUid === SELLER_A);
  ck('B4  the seller registry row is projected, with updatedAt',
    !!seller && seller.status === 'active' && !!seller.updatedAt && seller.shopId === SHOP_B);
  ck('B5  users.activeShopId points at the shop', user && user.activeShopId === SHOP_B);
  ck('B6  users.roles gains seller', !!user && !!user.roles, JSON.stringify(user && user.roles));

  const mint = minted()[0];
  ck('B7  the seller claim is minted', !!mint && mint.claims.seller === true);
  ck('B8  ...preserving existing claims (rider survives)', !!mint && mint.claims.rider === true);

  /* Order matters: the shop must exist before the role is handed out. */
  const shopIdx = ENV.log.findIndex(e => e.op === 'batch.set' && e.path === `shops/${SHOP_B}`);
  const mintIdx = ENV.log.findIndex(e => e.op === 'MINT_CLAIM');
  ck('B9  the shop is created BEFORE the claim is minted', shopIdx >= 0 && mintIdx > shopIdx,
    `shop@${shopIdx} claim@${mintIdx}`);

  const applied = ENV.log.find(e => e.coll === 'applications' && e.doc && e.doc.projectionStatus === 'applied');
  ck('B10 the application records the projection as applied', !!applied);
}

/* ═══ C — idempotency ═══ */
console.log('\nPART C — approving twice does not fork a second shop\n');
{
  ENV = makeEnv({ accounts: { [SELLER_A]: {}, [ADMIN]: { admin: true } } });
  await fire(trigger, APP({ status: 'approved', decidedBy: ADMIN }));
  const created = ENV.data[`shops/${SHOP_B}`].createdAt;

  /* A repair run: the same decision applied again. */
  await fire(trigger, APP({ status: 'approved', decidedBy: ADMIN }));
  const shopIds = Object.keys(ENV.data).filter(k => k.startsWith('shops/'));
  ck('C1  exactly ONE shop document exists', shopIds.length === 1, shopIds.join(','));
  ck('C2  createdAt is not rewritten on re-approval',
    ENV.data[`shops/${SHOP_B}`].createdAt === created);
  ck('C3  the shop is still active and still SHOP_B',
    ENV.data[`shops/${SHOP_B}`].status === 'active' && ENV.data[`shops/${SHOP_B}`].shopId === SHOP_B);
  ck('C4  activeShopId is still the same shop', ENV.data[`users/${SELLER_A}`].activeShopId === SHOP_B);
}

/* ═══ D — suspension retracts, rejection has nothing to retract ═══ */
console.log('\nPART D — the reverse transitions\n');
{
  ENV = makeEnv({ accounts: { [SELLER_A]: {}, [ADMIN]: { admin: true } } });
  await fire(trigger, APP({ status: 'approved', decidedBy: ADMIN }));
  await fire(trigger, APP({ status: 'suspended', decidedBy: ADMIN }));
  ck('D1  suspension deactivates the shop rather than deleting it',
    ENV.data[`shops/${SHOP_B}`].status === 'suspended' && !!ENV.data[`shops/${SHOP_B}`].shopId);
  ck('D2  ...and the registry row is deactivated too',
    ENV.data[`sellers/${SELLER_A}`].active === false);

  ENV = makeEnv({ accounts: { [SELLER_A]: {}, [ADMIN]: { admin: true } } });
  await fire(trigger, APP({ status: 'rejected', decidedBy: ADMIN }));
  ck('D3  a rejection creates no shop', !ENV.data[`shops/${SHOP_B}`]);
  ck('D4  ...and does not mint a seller claim',
    !minted().some(m => m.claims.seller === true), JSON.stringify(minted()[0] && minted()[0].claims));
}

/* ═══ E — placeholder and default shop id ═══ */
console.log('\nPART E — a shop is never called "main"\n');
{
  ENV = makeEnv({ accounts: { [SELLER_A]: {}, [ADMIN]: { admin: true } } });
  await fire(trigger, APP({ status: 'approved', decidedBy: ADMIN, shopId: 'main' }));
  ck('E1  an application naming "main" does not create shops/main', !ENV.data['shops/main']);
  ck('E2  ...it falls back to the account\'s own marketplace shop',
    !!ENV.data[`shops/${SELLER_A}`] && ENV.data[`shops/${SELLER_A}`].shopId === SELLER_A);
  ck('E3  ...and activeShopId points there', ENV.data[`users/${SELLER_A}`].activeShopId === SELLER_A);

  /* Control: KASS, whose shop id legitimately equals its uid. */
  ENV = makeEnv({ accounts: { [KASS]: {}, [ADMIN]: { admin: true } } });
  await fire(trigger, { ...APP({ status: 'approved', decidedBy: ADMIN }), uid: KASS, sellerUid: KASS, shopId: null, name: 'kassshop' },
    `${KASS}--merchant`);
  ck('E4  control: KASS activates shops/{uid} and gets activeShopId',
    !!ENV.data[`shops/${KASS}`] && ENV.data[`users/${KASS}`].activeShopId === KASS);
}

/* ═══ F — the merchant workspace can now resolve it ═══ */
console.log('\nPART F — the workspace resolves what approval created\n');
{
  ENV = makeEnv({ accounts: { [SELLER_A]: {}, [ADMIN]: { admin: true } } });
  await fire(trigger, APP({ status: 'approved', decidedBy: ADMIN }));

  const MD = require(path.join(ROOT, 'sokoni-merchant-data.js'));
  const db = { getDoc: async (coll, id) => ENV.data[`${coll}/${id}`] || null };
  const res = await MD.resolveShopId({ uid: SELLER_A, db });
  ck('F1  merchant.html resolves the shop approval created',
    res.shopId === SHOP_B && res.source === 'users.activeShopId', JSON.stringify(res));

  const scope = MD.resolveScope({ uid: SELLER_A, activeShopId: res.shopId });
  ck('F2  ...into a usable scope with both identities',
    scope.ok && scope.sellerUid === SELLER_A && scope.shopId === SHOP_B && scope.sellerUid !== scope.shopId);
  ck('F3  ...and products are queried against SHOP_B',
    MD.productQuery(scope).where[0][2] === SHOP_B);
}

/* ═══ G — mutation control ═══ */
console.log('\nPART G — mutation control\n');
{
  const src = fs.readFileSync(path.join(FUNCTIONS_DIR, 'application-lifecycle.js'), 'utf8');
  const mutants = [
    { label: 'M1  seller goes back to being delegated (no shop)',
      src: src.replace(/    \} else if \(role === 'seller'\) \{[\s\S]*?\n    \} else if \(DELEGATED_ROLES\[role\]\) \{/,
        "    } else if (DELEGATED_ROLES[role] || role === 'seller') {"),
      check: async (t) => { ENV = makeEnv({ accounts: { [SELLER_A]: {}, [ADMIN]: { admin: true } } }); await fire(t, APP({ status: 'approved', decidedBy: ADMIN })); return !ENV.data[`shops/${SHOP_B}`]; } },
    { label: 'M2  activeShopId is no longer written to the user',
      src: src.replace("  batch.set(userRef, { activeShopId: shopId, updatedAt: _ts() }, { merge: true });", ''),
      check: async (t) => { ENV = makeEnv({ accounts: { [SELLER_A]: {}, [ADMIN]: { admin: true } } }); await fire(t, APP({ status: 'approved', decidedBy: ADMIN })); return !(ENV.data[`users/${SELLER_A}`] || {}).activeShopId; } },
    { label: 'M3  the shop id falls back to the uid even when one was named',
      src: src.replace('const shopId = declared || String(uid);', 'const shopId = String(uid);'),
      check: async (t) => { ENV = makeEnv({ accounts: { [SELLER_A]: {}, [ADMIN]: { admin: true } } }); await fire(t, APP({ status: 'approved', decidedBy: ADMIN })); return !!ENV.data[`shops/${SELLER_A}`] && !ENV.data[`shops/${SHOP_B}`]; } },
    { label: 'M4  a placeholder shop id is accepted',
      src: src.replace("const declared = app.shopId && !isPlaceholderShopId(app.shopId) ? String(app.shopId) : null;",
        'const declared = app.shopId ? String(app.shopId) : null;'),
      check: async (t) => { ENV = makeEnv({ accounts: { [SELLER_A]: {}, [ADMIN]: { admin: true } } }); await fire(t, APP({ status: 'approved', decidedBy: ADMIN, shopId: 'main' })); return !!ENV.data['shops/main']; } },
    { label: 'M5  the registry row loses updatedAt (invisible to discovery)',
      src: src.replace(/    updatedAt: _ts\(\),\n    \.\.\.\(existing\.exists \? \{\} : \{ createdAt: _ts\(\) \}\),\n  \}, \{ merge: true \}\);\n\n  \/\* The account's active shop/,
        "    ...(existing.exists ? {} : { createdAt: _ts() }),\n  }, { merge: true });\n\n  /* The account's active shop"),
      check: async (t) => { ENV = makeEnv({ accounts: { [SELLER_A]: {}, [ADMIN]: { admin: true } } }); await fire(t, APP({ status: 'approved', decidedBy: ADMIN })); return !(ENV.data[`sellers/${SELLER_A}`] || {}).updatedAt; } },
  ];

  for (const mu of mutants) {
    if (mu.src === src) { ck(mu.label + ' → mutation applied', false, 'no-op replace — anchor moved'); continue; }
    let caught = false, detail = '';
    try { caught = await mu.check(loadTrigger(mu.src)); }
    catch (e) { caught = true; detail = 'mutant threw: ' + e.message; }
    ck(mu.label + ' → detected', caught, detail);
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('\nsuite crashed:', e.stack, '\n'); process.exit(1); });
