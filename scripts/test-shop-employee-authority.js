#!/usr/bin/env node
/* The shopEmployees writer/reader contract (2D-2 step 1).
 *
 *   node scripts/test-shop-employee-authority.js
 *
 * WHAT WAS WRONG
 * `shopEmployees` had two incompatible document keys, and the only WRITER used
 * the one no reader looks up:
 *
 *     WRITER   acceptShopInvite      shopEmployees/{uid}
 *     reader   analytics-engine      shopEmployees/{shopId}_{uid}
 *     reader   merchantAdjustStock   shopEmployees/{shopId}_{uid}
 *
 * So no employee who ever accepted an invite was visible to any reader. And
 * underneath that, both readers granted access on `empSnap.exists` ALONE while
 * firestore.rules lets any signed-in client create a shopEmployees document at an
 * arbitrary id naming itself owner — a cross-tenant escalation the key divergence
 * hid rather than prevented.
 *
 * FIXTURE — non-degenerate by construction:
 *     SELLER_A   the account that owns SHOP_B
 *     SHOP_B     the shop
 *     SHOP_C     a shop owned by somebody else
 *     EMP_1      an accepted employee of SHOP_B
 *     ATTACKER   a signed-in account with no legitimate relationship to either
 * SELLER_A !== SHOP_B throughout, so any code substituting the account for the
 * shop fails here rather than in a merchant's till.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const FUNCTIONS_DIR = path.join(ROOT, 'functions');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 130) + ']' : ''));
  ok ? pass++ : fail++;
};

const SELLER_A = 'SELLER_A_uid_7f3';
const SHOP_B   = 'SHOP_B_shop_91c';
const SHOP_C   = 'SHOP_C_shop_42x';
const OTHER    = 'OTHER_OWNER_uid';
const EMP_1    = 'EMP_1_uid';
const ATTACKER = 'ATTACKER_uid';

const FieldValue = {
  serverTimestamp: () => ({ __s: 'ts' }),
};

/* Firestore stub: doc get/set/update plus the where().limit().get() the list and
   shop-resolution paths use. Queries honour the filter, so a wrong scope returns
   the wrong rows instead of silently returning everything. */
function makeEnv(docs = {}, accounts = {}) {
  const data = { ...docs };
  const writes = [];
  const snap = (p) => ({ exists: !!data[p], id: p.split('/').slice(1).join('/'), data: () => data[p] });

  const query = (coll, filters = [], lim = 1000) => ({
    where(f, _op, v) { return query(coll, filters.concat([[f, v]]), lim); },
    limit(n) { return query(coll, filters, n); },
    async get() {
      const rows = Object.keys(data)
        .filter((p) => p.startsWith(coll + '/'))
        .filter((p) => filters.every(([f, v]) => String((data[p] || {})[f]) === String(v)))
        .slice(0, lim)
        .map((p) => snap(p));
      return {
        empty: rows.length === 0, size: rows.length, docs: rows,
        forEach: (fn) => rows.forEach(fn),
      };
    },
  });

  return {
    data, writes,
    db: {
      collection: (coll) => Object.assign(query(coll), {
        doc: (id) => ({
          async get() { return snap(`${coll}/${id}`); },
          async set(doc) { writes.push({ op: 'set', path: `${coll}/${id}`, doc }); data[`${coll}/${id}`] = { ...doc }; },
          async update(patch) {
            writes.push({ op: 'update', path: `${coll}/${id}`, patch });
            data[`${coll}/${id}`] = { ...(data[`${coll}/${id}`] || {}), ...patch };
          },
        }),
      }),
    },
    auth: {
      async getUser(uid) {
        if (!accounts[uid]) throw new Error('no user record');
        return { uid, customClaims: accounts[uid] };
      },
    },
  };
}

let ENV = makeEnv();

/* Load shop-employees.js against the stub, capturing its callables BY NAME. */
function loadModule() {
  const captured = {};
  const orig = Module.prototype.require;
  let pending = null;
  Module.prototype.require = function (id) {
    if (id === 'firebase-admin/firestore') return { getFirestore: () => ENV.db, FieldValue };
    if (id === 'firebase-admin/auth') return { getAuth: () => ENV.auth };
    if (id === 'firebase-functions/logger') return { info() {}, warn() {}, error() {} };
    if (id === 'firebase-functions/v2/https') {
      return {
        onCall: (_o, h) => { if (pending) { captured[pending] = h; pending = null; } return h; },
        HttpsError: class HttpsError extends Error {
          constructor(code, message) { super(message); this.code = code; }
        },
      };
    }
    return orig.apply(this, arguments);
  };
  const file = path.join(FUNCTIONS_DIR, 'shop-employees.js');
  delete require.cache[require.resolve(file)];
  /* The module assigns each callable to a named export in source order; read the
     order from source so the capture is by NAME rather than by position. */
  const src = fs.readFileSync(file, 'utf8');
  const names = [...src.matchAll(/^exports\.([A-Za-z0-9_]+) = onCall\(/gm)].map((m) => m[1]);
  let i = 0;
  const origOnCall = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === 'firebase-functions/v2/https') {
      const real = origOnCall.apply(this, arguments);
      return Object.assign({}, real, { onCall: (_o, h) => { captured[names[i++]] = h; return h; } });
    }
    return origOnCall.apply(this, arguments);
  };
  let mod;
  try { mod = require(file); } finally { Module.prototype.require = orig; }
  return { mod, captured };
}

const { mod: SE, captured: FN } = loadModule();

/* Load a MUTATED copy of the module, so a control can prove a defect behaviourally
   rather than by asserting a line still exists in the source. */
function loadMutant(source) {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-'));
  const file = path.join(dir, 'shop-employees.js');
  fs.writeFileSync(file, source);
  const orig = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === 'firebase-admin/firestore') return { getFirestore: () => ENV.db, FieldValue };
    if (id === 'firebase-admin/auth') return { getAuth: () => ENV.auth };
    if (id === 'firebase-functions/logger') return { info() {}, warn() {}, error() {} };
    if (id === 'firebase-functions/v2/https') {
      return {
        onCall: (_o, h) => h,
        HttpsError: class HttpsError extends Error {
          constructor(code, message) { super(message); this.code = code; }
        },
      };
    }
    return orig.apply(this, arguments);
  };
  try { return require(file); } finally { Module.prototype.require = orig; }
}

const call = (fn, data, uid) => fn({ auth: uid ? { uid } : null, data });
const err = async (p) => { try { await p; return null; } catch (e) { return e; } };

/* Canonical fixtures. */
const SHOPS = () => ({
  [`shops/${SHOP_B}`]: { ownerId: SELLER_A, status: 'active' },
  [`shops/${SHOP_C}`]: { ownerId: OTHER, status: 'active' },
});
/* Exactly the record acceptShopInvite now writes. */
const ACCEPTED_EMP = {
  uid: EMP_1, email: 'emp@example.com', name: 'Emp One',
  role: 'manager', shopId: SHOP_B, shopOwnerId: SELLER_A, shopName: 'B Shop', active: true,
};

(async () => {

/* ═══ A — the canonical key ═══ */
console.log('\nPART A — one key shape, everywhere\n');
{
  ck('A1  the canonical id is {shopId}_{uid}', SE.employeeDocId(SHOP_B, EMP_1) === `${SHOP_B}_${EMP_1}`);
  ck('A2  ...and it is never the bare uid', SE.employeeDocId(SHOP_B, EMP_1) !== EMP_1);
  ck('A3  the same person at two shops is two different records',
    SE.employeeDocId(SHOP_B, EMP_1) !== SE.employeeDocId(SHOP_C, EMP_1));
  let threw = false;
  try { SE.employeeDocId(null, EMP_1); } catch (_) { threw = true; }
  ck('A4  a missing shopId cannot produce a key', threw);

  /* The writer and the readers must agree. Asserted against the SHIPPED source of
     both readers, not against a copy of the rule kept in this file. */
  const ae = fs.readFileSync(path.join(FUNCTIONS_DIR, 'analytics-engine.js'), 'utf8');
  const mi = fs.readFileSync(path.join(FUNCTIONS_DIR, 'merchant-inventory.js'), 'utf8');
  const ix = fs.readFileSync(path.join(FUNCTIONS_DIR, 'index.js'), 'utf8');
  ck('A5  analytics-engine delegates to the one contract', /require\('\.\/shop-employees'\)/.test(ae));
  ck('A6  merchantAdjustStock delegates to the one contract', /require\('\.\/shop-employees'\)/.test(mi));
  ck('A7  neither reader keeps a private copy of the employee lookup',
    !/collection\('shopEmployees'\)/.test(ae) && !/collection\('shopEmployees'\)/.test(mi));

  /* The WRITER. acceptShopInvite lives inside functions/index.js, which cannot be
     loaded in isolation, so its contract is asserted at source level — and that is
     stated rather than dressed up as a behavioural proof. */
  const accept = ix.slice(ix.indexOf('exports.acceptShopInvite'), ix.indexOf('exports.revokeShopInvite'));
  ck('A8  acceptShopInvite writes on the canonical key (source-level)',
    /_shopEmployees\.employeeDocId\(data\.shopId, request\.auth\.uid\)/.test(accept));
  ck('A9  ...and stores every field corroboration needs (source-level)',
    /shopId: data\.shopId/.test(accept) && /shopOwnerId: data\.shopOwnerId/.test(accept) &&
    /active: true/.test(accept) && /role: data\.role/.test(accept));
  ck('A10 ...and refuses a pre-convergence invite that names no shop (source-level)',
    /if \(!data\.shopId\)/.test(accept) && /failed-precondition/.test(accept));

  const invite = ix.slice(ix.indexOf('exports.inviteShopEmployee'), ix.indexOf('exports.acceptShopInvite'));
  ck('A11 inviteShopEmployee records the shop on the invite (source-level)',
    /shopId,/.test(invite));
  ck('A12 ...and verifies the caller owns that shop (source-level)',
    /_shopEmployees\.assertShopOwner\(request\.auth\.uid, shopId\)/.test(invite));
  ck('A13 ...and resolves an unnamed shop by LOOKUP, never uid-as-shop (source-level)',
    /_shopEmployees\.resolveOwnedShopId\(request\.auth\.uid\)/.test(invite) &&
    !/shopId = request\.auth\.uid/.test(invite));
}

/* ═══ B — who gets access ═══ */
console.log('\nPART B — the shop document decides\n');
{
  ENV = makeEnv(SHOPS());
  ck('B1  the owner is the owner', (await SE.resolveShopAccess(SELLER_A, SHOP_B)).via === 'owner');

  ENV = makeEnv({ ...SHOPS(), [`shopEmployees/${SHOP_B}_${EMP_1}`]: { ...ACCEPTED_EMP } });
  const emp = await SE.resolveShopAccess(EMP_1, SHOP_B);
  ck('B2  an accepted employee is recognised', emp.via === 'employee' && emp.role === 'manager');

  ENV = makeEnv(SHOPS());
  const e1 = await err(SE.resolveShopAccess(ATTACKER, SHOP_B));
  ck('B3  a stranger is refused', e1 && e1.code === 'permission-denied');

  const e2 = await err(SE.resolveShopAccess(SELLER_A, 'shops_that_do_not_exist'));
  ck('B4  an unknown shop is not-found, not access', e2 && e2.code === 'not-found');

  /* Ownership is read as the union of the field names actually in production. */
  ENV = makeEnv({ [`shops/${SHOP_B}`]: { sellerUid: SELLER_A } });
  ck('B5  a shop owned via sellerUid still resolves its owner',
    (await SE.resolveShopAccess(SELLER_A, SHOP_B)).via === 'owner');
  ENV = makeEnv({ [`shops/${SHOP_B}`]: { ownerUid: SELLER_A } });
  ck('B6  ...and via ownerUid', (await SE.resolveShopAccess(SELLER_A, SHOP_B)).via === 'owner');

  ENV = makeEnv(SHOPS(), { [ATTACKER]: { admin: true } });
  ck('B7  a platform admin resolves as admin', (await SE.resolveShopAccess(ATTACKER, SHOP_B)).via === 'admin');
}

/* ═══ C — the escalation this closes ═══ */
console.log('\nPART C — a forged employee record buys nothing\n');
{
  /* Exactly what firestore.rules permits a client to write:
     allow create: if isAuthed() && request.resource.data.shopOwnerId == request.auth.uid */
  ENV = makeEnv({ ...SHOPS(),
    [`shopEmployees/${SHOP_B}_${ATTACKER}`]: {
      uid: ATTACKER, role: 'manager', shopId: SHOP_B, shopOwnerId: ATTACKER, active: true } });
  const forged = await err(SE.resolveShopAccess(ATTACKER, SHOP_B));
  ck('C1  a record naming ITSELF owner is refused', forged && forged.code === 'permission-denied');

  ENV = makeEnv({ ...SHOPS(),
    [`shopEmployees/${SHOP_B}_${ATTACKER}`]: {
      uid: ATTACKER, role: 'manager', shopId: SHOP_C, shopOwnerId: SELLER_A, active: true } });
  const wrongShop = await err(SE.resolveShopAccess(ATTACKER, SHOP_B));
  ck('C2  a record filed under one shop but naming another is refused', wrongShop && wrongShop.code === 'permission-denied');

  ENV = makeEnv({ ...SHOPS(),
    [`shopEmployees/${SHOP_B}_${EMP_1}`]: { ...ACCEPTED_EMP, role: 'superAdmin' } });
  const badRole = await err(SE.resolveShopAccess(EMP_1, SHOP_B));
  ck('C3  a role outside the shop vocabulary is refused', badRole && badRole.code === 'permission-denied');

  ENV = makeEnv({ ...SHOPS(),
    [`shopEmployees/${SHOP_B}_${EMP_1}`]: { ...ACCEPTED_EMP, active: false } });
  const inactive = await err(SE.resolveShopAccess(EMP_1, SHOP_B));
  ck('C4  a removed employee is refused', inactive && inactive.code === 'permission-denied');

  /* The refusal must not tell a prober WHICH check failed. */
  ck('C5  the refusal message does not disclose the failed check',
    forged && !/shopOwnerId|corrobor|mismatch/i.test(forged.message), forged && forged.message);
}

/* ═══ D — legacy records ═══ */
console.log('\nPART D — the old key is not silently valid\n');
{
  ENV = makeEnv({ ...SHOPS(), [`shopEmployees/${EMP_1}`]: { ...ACCEPTED_EMP } });
  const legacy = await err(SE.resolveShopAccess(EMP_1, SHOP_B));
  ck('D1  a legacy shopEmployees/{uid} record grants nothing', legacy && legacy.code === 'permission-denied');
  ck('D2  ...and is not migrated as a side effect of being read',
    ENV.writes.length === 0 && !!ENV.data[`shopEmployees/${EMP_1}`]);
  ck('D3  ...and no canonical record was conjured from it',
    !ENV.data[`shopEmployees/${SHOP_B}_${EMP_1}`]);
}

/* ═══ E — no identity fallback ═══ */
console.log('\nPART E — the account is never the shop\n');
{
  /* A shop whose id happens to equal the caller's uid must still be resolved from
     the DOCUMENT, not assumed. */
  ENV = makeEnv({ [`shops/${SELLER_A}`]: { ownerId: SELLER_A } });
  ck('E1  a uid-named shop resolves only because its document says so',
    (await SE.resolveShopAccess(SELLER_A, SELLER_A)).via === 'owner');

  ENV = makeEnv({ [`shops/${SELLER_A}`]: { ownerId: OTHER } });
  const notMine = await err(SE.resolveShopAccess(SELLER_A, SELLER_A));
  ck('E2  ...and a uid-named shop owned by someone ELSE is refused',
    notMine && notMine.code === 'permission-denied');

  ENV = makeEnv({});
  ck('E3  an account owning no shop resolves to null, never to its own uid',
    (await SE.resolveOwnedShopId(SELLER_A)) === null);

  ENV = makeEnv(SHOPS());
  ck('E4  an owned shop resolves to the SHOP document id',
    (await SE.resolveOwnedShopId(SELLER_A)) === SHOP_B);

  ENV = makeEnv({ [`shops/s1`]: { ownerId: SELLER_A }, [`shops/s2`]: { ownerId: SELLER_A } });
  const many = await err(SE.resolveOwnedShopId(SELLER_A));
  ck('E5  two shops force an explicit choice rather than a guess',
    many && many.code === 'failed-precondition', many && many.code);
}

/* ═══ F — staff management ═══ */
console.log('\nPART F — the owner manages the team\n');
{
  const base = () => ({ ...SHOPS(), [`shopEmployees/${SHOP_B}_${EMP_1}`]: { ...ACCEPTED_EMP } });

  ENV = makeEnv(base());
  const list = await call(FN.listShopEmployees, { shopId: SHOP_B }, SELLER_A);
  ck('F1  the owner can list their team', list.ok === true && list.count === 1 && list.employees[0].uid === EMP_1);

  ENV = makeEnv(base());
  const eList = await err(call(FN.listShopEmployees, { shopId: SHOP_C }, SELLER_A));
  ck('F2  SELLER_A cannot list SHOP_C\'s team', eList && eList.code === 'permission-denied');

  ENV = makeEnv(base());
  const eEmpList = await err(call(FN.listShopEmployees, { shopId: SHOP_B }, EMP_1));
  ck('F3  an employee cannot list the team (owner-only)', eEmpList && eEmpList.code === 'permission-denied');

  /* A forged row must not be rendered as staff either. */
  ENV = makeEnv({ ...base(),
    [`shopEmployees/${SHOP_B}_${ATTACKER}`]: { uid: ATTACKER, role: 'manager', shopId: SHOP_B, shopOwnerId: ATTACKER, active: true } });
  const list2 = await call(FN.listShopEmployees, { shopId: SHOP_B }, SELLER_A);
  ck('F4  a forged row is not listed as staff', list2.count === 1 && !list2.employees.some((e) => e.uid === ATTACKER));

  ENV = makeEnv(base());
  const rm = await call(FN.removeShopEmployee, { shopId: SHOP_B, uid: EMP_1 }, SELLER_A);
  ck('F5  the owner can remove an employee', rm.ok === true && rm.active === false);
  ck('F6  ...by DEACTIVATING, so the record survives as evidence',
    ENV.data[`shopEmployees/${SHOP_B}_${EMP_1}`].active === false &&
    !!ENV.data[`shopEmployees/${SHOP_B}_${EMP_1}`].removedBy);
  ck('F7  ...and the deactivated employee immediately loses access',
    (await err(SE.resolveShopAccess(EMP_1, SHOP_B)))?.code === 'permission-denied');

  ENV = makeEnv(base());
  const eRm = await err(call(FN.removeShopEmployee, { shopId: SHOP_B, uid: EMP_1 }, EMP_1));
  ck('F8  an employee cannot remove anyone', eRm && eRm.code === 'permission-denied');

  ENV = makeEnv(base());
  const eSelf = await err(call(FN.removeShopEmployee, { shopId: SHOP_B, uid: SELLER_A }, SELLER_A));
  ck('F9  an owner cannot remove themselves (self-lockout)', eSelf && eSelf.code === 'failed-precondition');

  ENV = makeEnv(base());
  const eAnon = await err(call(FN.listShopEmployees, { shopId: SHOP_B }, null));
  ck('F10 an unauthenticated caller is rejected', eAnon && eAnon.code === 'unauthenticated');
}

/* ═══ G — cross-tenant ═══ */
console.log('\nPART G — SHOP_B and SHOP_C never meet\n');
{
  ENV = makeEnv({ ...SHOPS(),
    [`shopEmployees/${SHOP_B}_${EMP_1}`]: { ...ACCEPTED_EMP },
    [`shopEmployees/${SHOP_C}_OTHER_EMP`]: { uid: 'OTHER_EMP', role: 'cashier', shopId: SHOP_C, shopOwnerId: OTHER, active: true } });

  ck('G1  a SHOP_B employee has no access to SHOP_C',
    (await err(SE.resolveShopAccess(EMP_1, SHOP_C)))?.code === 'permission-denied');
  ck('G2  a SHOP_C employee has no access to SHOP_B',
    (await err(SE.resolveShopAccess('OTHER_EMP', SHOP_B)))?.code === 'permission-denied');
  ck('G3  SELLER_A has no access to SHOP_C',
    (await err(SE.resolveShopAccess(SELLER_A, SHOP_C)))?.code === 'permission-denied');

  const list = await call(FN.listShopEmployees, { shopId: SHOP_B }, SELLER_A);
  ck('G4  the owner\'s team list contains only their own shop',
    list.count === 1 && list.employees.every((e) => e.uid === EMP_1));
}

/* ═══ H — mutation control ═══ */
console.log('\nPART H — mutation control (each defect must be CAUGHT)\n');
{
  const src = fs.readFileSync(path.join(FUNCTIONS_DIR, 'shop-employees.js'), 'utf8');

  /* A behavioural mutation, not a source-presence check: strip the corroboration
     and prove the FORGED record is then accepted. If the mutant still refuses it,
     something else is doing the work and this suite is not testing what it claims. */
  const mutated = src.replace(
    /if \(!ownerUid \|\| String\(e\.shopOwnerId \|\| ''\) !== String\(ownerUid\)\) reasons\.push\([^\n]*\n/,
    '\n');
  ck('H1  the corroboration line exists and can be removed (control)', mutated !== src);

  const forgedDocs = { ...SHOPS(),
    [`shopEmployees/${SHOP_B}_${ATTACKER}`]: {
      uid: ATTACKER, role: 'manager', shopId: SHOP_B, shopOwnerId: ATTACKER, active: true } };

  ENV = makeEnv(forgedDocs);
  ck('H2  shipped code REFUSES the forgery',
    (await err(SE.resolveShopAccess(ATTACKER, SHOP_B)))?.code === 'permission-denied');

  const mutant = loadMutant(mutated);
  ENV = makeEnv(forgedDocs);
  const mutantResult = await err(mutant.resolveShopAccess(ATTACKER, SHOP_B));
  ck('H3  without corroboration the SAME forgery is ACCEPTED → the check is what stops it',
    mutantResult === null, mutantResult ? 'mutant still refused: ' + mutantResult.code : 'mutant granted access');

  ck('H4  the legacy key is never constructed for a lookup',
    !/collection\(EMPLOYEES\)\.doc\(String\(uid\)\)/.test(src) &&
    !/collection\(EMPLOYEES\)\.doc\(uid\)/.test(src));

  ck('H5  the shop id is never defaulted from the uid',
    !/shopId\s*=\s*uid|shopId\s*\|\|\s*uid/.test(src));

  ck('H6  active:false is treated as removed, not ignored', /e\.active === false/.test(src));
}

console.log('\n' + '='.repeat(70));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error(e); process.exit(1); });
