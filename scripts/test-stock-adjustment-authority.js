#!/usr/bin/env node
/* PRIORITY 20 — STOCK ADJUSTMENT AUTHORITY: battery against the UNFIXED code.
 *
 * WHAT THIS PROVES, AND WHAT IT DELIBERATELY DOES NOT
 * It executes the real merchantAdjustStock handler against a fake Firestore, so ownership,
 * validation, transaction ordering, the zero floor and idempotency are OBSERVED rather than
 * read out of the source. Employees are currently BLOCKED from adjusting stock; this suite
 * asserts that block as the present truth. It is evidence of a gap, NOT a licence to grant
 * employees authority so a test can go green.
 *
 * TEST METHODOLOGY RULES IN FORCE (learned the hard way, earlier in this programme)
 *  - Scope every assertion to its semantic block. A token that can legitimately occur in
 *    several blocks must never be counted across the whole file.
 *  - Carry a CONTROL that fails loudly if the probe itself is broken. A null result from a
 *    silently-broken probe reads exactly like a real absence.
 *  - Never assert on prose. Comment text is stripped before any source assertion.
 *
 * RULES EVIDENCE
 * The inventory findings were verified against the SERVED ruleset on 2026-09-01:
 *   ruleset 59af870d-72eb-4791-a3b6-2f4de7eb8ff7, file firestore.rules.release-minimal.
 * That id is pinned below so a later reader can tell whether this evidence has gone stale.
 * The in-tree assertions re-check the same facts against the repo file, which is what a
 * deploy would promote — so this suite stays meaningful without network access.
 */
'use strict';
const path   = require('path');
const fs     = require('fs');
const Module = require('module');
const ROOT   = path.resolve(__dirname, '..');

const SERVED_RULESET_VERIFIED = '59af870d-72eb-4791-a3b6-2f4de7eb8ff7';

let pass = 0, fail = 0, unproven = 0;
function head (t) { console.log('\n' + t); }
function ck (label, cond, note) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (note ? '   [' + note + ']' : '')); }
}
function unk (label, why) { unproven++; console.log('  UNPROVEN  ' + label + '   [' + why + ']'); }

/* Always returns an object. An unguarded .value.x once crashed a harness instead of
   reporting a failure, which loses every assertion after it. */
async function caught (fn) {
  try { const value = await fn(); return { ok: true, value: value || {}, err: null }; }
  catch (err) { return { ok: false, value: {}, err: err || new Error('unknown') }; }
}

/* Load the real handler with the firebase surface stubbed. */
function loadHandler (adminUids) {
  const real = Module._load;
  let captured = null;
  class HttpsError extends Error {
    constructor (code, message) { super(message); this.code = code; }
  }
  const state = { db: null };
  Module._load = function (request) {
    if (request === 'firebase-functions/v2/https') {
      return { onCall: (cfg, fn) => { captured = { cfg, fn }; return captured; }, HttpsError };
    }
    if (request === 'firebase-admin/firestore') {
      return { getFirestore: () => state.db, FieldValue: { serverTimestamp: () => '__TS__' } };
    }
    if (request === 'firebase-admin') {
      return { auth: () => ({ getUser: async (uid) => ({
        customClaims: (adminUids || []).indexOf(uid) > -1 ? { role: 'admin' } : {},
      }) }) };
    }
    if (request === 'firebase-functions/logger') {
      return { info () {}, error () {}, warn () {}, debug () {} };
    }
    return real.apply(this, arguments);
  };
  try {
    const p = path.join(ROOT, 'functions/merchant-inventory.js');
    delete require.cache[require.resolve(p)];
    const mod = require(p);
    return { mod, handler: captured, HttpsError, state };
  } finally { Module._load = real; }
}

/* A Firestore fake that RECORDS ORDER, so "all reads before any write" is observed. */
function makeDb (docs) {
  const log = [];
  const ref = (col, id) => ({ __path: col + '/' + id });
  return {
    __log: log,
    collection: (c) => ({ doc: (id) => ref(c, id) }),
    runTransaction: async (fn) => fn({
      get: async (r) => {
        log.push({ op: 'get', path: r.__path });
        const d = docs[r.__path];
        return { exists: !!d, data: () => d, ref: r };
      },
      update: (r, data) => log.push({ op: 'update', path: r.__path, data }),
      set:    (r, data) => log.push({ op: 'set',    path: r.__path, data }),
    }),
  };
}

const OWNER = 'uid_owner_1', OTHER = 'uid_other_2', EMPLOYEE = 'uid_employee_3', ADMIN = 'uid_admin_4';
const PROD = 'prod_abc';
function baseDocs (over) {
  return Object.assign({
    ['products/' + PROD]: { sellerUid: OWNER, shopId: 'shop_1', stock: 10, inventoryVersion: 4, name: 'Sugar 1kg' },
  }, over || {});
}
function callWith (uid, data, docs, adminUids) {
  const L = loadHandler(adminUids);
  L.state.db = makeDb(docs || baseDocs());
  return { L, run: () => L.handler.fn({ auth: { uid }, data }) };
}
const GOOD = { productId: PROD, shopId: 'shop_1', adjustmentId: 'adj_1', reason: 'count_correction', delta: -3 };

(async () => {

/* ── 1 · CONTROL ─────────────────────────────────────────────────────────────── */
head('1 · CONTROL — the rig must execute the real handler');
{
  const L = loadHandler([]);
  ck('the callable handler was captured from onCall', !!(L.handler && typeof L.handler.fn === 'function'),
     'if this fails every execution assertion below is vacuous');
  ck('App Check is enforced on the callable', !!(L.handler && L.handler.cfg && L.handler.cfg.enforceAppCheck === true));
  const c = await caught(() => callWith(OWNER, GOOD).run());
  ck('CONTROL a valid owner adjustment SUCCEEDS', c.ok && c.value.ok === true,
     c.err ? String(c.err.message) : 'no error');
}

/* ── 2 · VALIDATION SURFACE, executed ────────────────────────────────────────── */
head('2 · validation surface — every rejection observed, not assumed');
{
  const mod = loadHandler([]).mod;
  ck('MAX_DELTA is a plausible fat-finger ceiling', mod._MAX_DELTA === 1000000);
  ck('the reason vocabulary is frozen', Object.isFrozen(mod._REASONS) && mod._REASONS.length === 8);
  ck('_san strips angle brackets and quotes', mod._san('<b>"x"</b>') === 'bx/b');

  const cases = [
    ['unauthenticated caller is refused',        null,  GOOD, 'unauthenticated'],
    ['missing productId is refused',             OWNER, Object.assign({}, GOOD, { productId: '' }), 'invalid-argument'],
    ['missing shopId is refused',                OWNER, Object.assign({}, GOOD, { shopId: '' }), 'invalid-argument'],
    ['missing adjustmentId is refused',          OWNER, Object.assign({}, GOOD, { adjustmentId: '' }), 'invalid-argument'],
    ['a zero delta is refused',                  OWNER, Object.assign({}, GOOD, { delta: 0 }), 'invalid-argument'],
    ['a fractional delta is refused',            OWNER, Object.assign({}, GOOD, { delta: 1.5 }), 'invalid-argument'],
    ['an implausibly large delta is refused',    OWNER, Object.assign({}, GOOD, { delta: 2000000 }), 'invalid-argument'],
    ['an unknown reason is refused',             OWNER, Object.assign({}, GOOD, { reason: 'shrinkage' }), 'invalid-argument'],
  ];
  for (const [label, uid, data, code] of cases) {
    const L = loadHandler([]);
    L.state.db = makeDb(baseDocs());
    const r = await caught(() => L.handler.fn({ auth: uid ? { uid } : null, data }));
    ck(label, !r.ok && r.err && r.err.code === code, r.ok ? 'it SUCCEEDED' : 'code=' + (r.err && r.err.code));
  }
}

/* ── 3 · OWNERSHIP BINDING, executed ─────────────────────────────────────────── */
head('3 · ownership — bound to products.sellerUid, the field the rules gate on');
{
  const owner = await caught(() => callWith(OWNER, GOOD).run());
  ck('the product OWNER may adjust', owner.ok && owner.value.ok === true);

  const other = await caught(() => callWith(OTHER, GOOD).run());
  ck('NEGATIVE another seller may NOT adjust', !other.ok && other.err.code === 'permission-denied',
     other.ok ? 'it SUCCEEDED — cross-seller write' : String(other.err.code));

  const adm = await caught(() => callWith(ADMIN, GOOD, baseDocs(), [ADMIN]).run());
  ck('a platform admin may adjust', adm.ok && adm.value.ok === true);

  /* Naming your own shop does not buy you someone else's product. */
  const spoof = await caught(() => callWith(OTHER, Object.assign({}, GOOD, { shopId: 'shop_of_other' })).run());
  ck('NEGATIVE a caller cannot claim a product by naming their own shopId',
     !spoof.ok && spoof.err.code === 'permission-denied');

  /* A correct owner filing under the wrong shop is refused. */
  const wrongShop = await caught(() => callWith(OWNER, Object.assign({}, GOOD, { shopId: 'shop_999' })).run());
  ck('NEGATIVE the owner cannot file a movement under a foreign shopId',
     !wrongShop.ok && wrongShop.err.code === 'permission-denied');

  const noProd = await caught(() => callWith(OWNER, GOOD, {}).run());
  ck('a missing product is not-found, not a silent success', !noProd.ok && noProd.err.code === 'not-found');
}

/* ── 4 · TRANSACTION SHAPE, observed from the recorded op order ──────────────── */
head('4 · transaction — ordering, floor, version and audit observed');
{
  const L = loadHandler([]);
  const db = makeDb(baseDocs());
  L.state.db = db;
  const r = await caught(() => L.handler.fn({ auth: { uid: OWNER }, data: GOOD }));
  ck('CONTROL the adjustment ran', r.ok, r.err ? String(r.err.message) : '');

  const ops = db.__log;
  const firstWrite = ops.findIndex((o) => o.op !== 'get');
  const lastRead   = ops.map((o) => o.op).lastIndexOf('get');
  ck('ALL reads happen before ANY write', lastRead < firstWrite,
     'lastRead=' + lastRead + ' firstWrite=' + firstWrite);
  ck('the idempotency record is read FIRST, before the product',
     ops[0] && ops[0].path.indexOf('stockMovements/') === 0);

  const upd = ops.find((o) => o.op === 'update' && o.path === 'products/' + PROD);
  ck('the product update exists', !!upd);
  ck('stock is written as a SERVER-COMPUTED absolute, not a client value',
     !!upd && upd.data.stock === 7, upd ? 'stock=' + upd.data.stock : '');
  ck('inventoryVersion is bumped in the SAME write as stock',
     !!upd && upd.data.inventoryVersion === 5 && 'stock' in upd.data);
  ck('updatedAt moves with them', !!upd && upd.data.updatedAt === '__TS__');
  ck('NEGATIVE a correction does NOT touch `sold`', !!upd && !('sold' in upd.data));

  const mv = ops.find((o) => o.op === 'set' && o.path.indexOf('stockMovements/') === 0);
  ck('an audit movement is written', !!mv);
  ck('the audit records before/after and the actor',
     !!mv && mv.data.before === 10 && mv.data.after === 7 && mv.data.actorUid === OWNER);
  ck('the audit names its source', !!mv && mv.data.source === 'merchantAdjustStock');
}

/* ── 5 · ZERO FLOOR and IDEMPOTENCY, executed ────────────────────────────────── */
head('5 · floor and idempotency');
{
  const under = await caught(() => callWith(OWNER, Object.assign({}, GOOD, { delta: -50 })).run());
  ck('NEGATIVE stock cannot be driven below zero',
     !under.ok && under.err.code === 'failed-precondition',
     under.ok ? 'it SUCCEEDED and would have gone negative' : String(under.err.code));

  /* A replay returns the original outcome and mutates nothing. */
  const L = loadHandler([]);
  const docs = baseDocs({ 'stockMovements/adj_1': { before: 10, after: 7, inventoryVersion: 5 } });
  const db = makeDb(docs); L.state.db = db;
  const replay = await caught(() => L.handler.fn({ auth: { uid: OWNER }, data: GOOD }));
  ck('a replay reports itself idempotent', replay.ok && replay.value.idempotent === true);
  ck('a replay returns the ORIGINAL outcome', replay.ok && replay.value.after === 7);
  ck('NEGATIVE a replay performs NO second mutation',
     db.__log.every((o) => o.op === 'get'),
     'writes on replay: ' + db.__log.filter((o) => o.op !== 'get').length);
}

/* ── 6 · EMPLOYEE AUTHORITY — the present truth, recorded not granted ────────── */
head('6 · employee authority — currently BLOCKED by every path (a gap, not a grant)');
{
  const emp = await caught(() => callWith(EMPLOYEE, GOOD).run());
  ck('an employee of the shop is REFUSED by the callable',
     !emp.ok && emp.err.code === 'permission-denied',
     'this asserts the CURRENT state; it must not be "fixed" by granting authority here');

  const SRC = fs.readFileSync(path.join(ROOT, 'functions/merchant-inventory.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');   /* never assert on prose */
  ck('NEGATIVE the callable reads NO employment store at all',
     SRC.indexOf('shopEmployees') === -1 && SRC.indexOf('workspaceMemberships') === -1 &&
     SRC.indexOf('posStaff') === -1,
     'comment-stripped source');

  /* The reason the block exists is checkable in the rules a deploy would promote. */
  const RULES = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
  const seAt  = RULES.indexOf('match /shopEmployees/{');
  const SE    = RULES.slice(seAt, seAt + 600);
  ck('CONTROL the shopEmployees block was isolated', seAt > -1 && SE.indexOf('allow create') > -1);
  ck('a client may create a shopEmployees row naming ITSELF as the shop owner',
     SE.indexOf('request.resource.data.shopOwnerId == request.auth.uid') > -1,
     'this is why reading that collection would be self-minted authority');
}

/* ── 7 · THE TWO INVENTORY MODELS — boundary recorded, not reconciled ────────── */
head('7 · inventory model boundary — canonical products.stock vs branch-scoped POS');
{
  const SRC  = fs.readFileSync(path.join(ROOT, 'functions/merchant-inventory.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const SYNC = fs.readFileSync(path.join(ROOT, 'pos-sync.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');   /* never assert on prose */

  ck('the canonical path writes products.stock', SRC.indexOf("collection('products')") > -1);
  ck('NEGATIVE the canonical path has NO branch concept', SRC.indexOf('branchId') === -1,
     'comment-stripped source');

  const WSM = SYNC.slice(SYNC.indexOf('const writeStockMovement'), SYNC.indexOf('const writeProductUpdate'));
  ck('CONTROL the stock-movement route was isolated', WSM.length > 200 && WSM.length < 2000, WSM.length + ' chars');
  ck('the POS path IS branch-scoped', WSM.indexOf('data.branchId') > -1);
  ck('the POS path writes a DIFFERENT collection than the canonical one',
     WSM.indexOf("'inventory'") > -1 && WSM.indexOf("'products'") === -1);
}

/* ── 8 · THE DENIAL AND THE DIVERGENCE ───────────────────────────────────────── */
head('8 · inventory/{id} denial and the quantity/audit divergence');
{
  const SYNC  = fs.readFileSync(path.join(ROOT, 'pos-sync.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');   /* never assert on prose */
  const RULES = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');

  /* CONTROL first: a probe that finds nothing is indistinguishable from a broken probe. */
  const known = ['products', 'posTransactions', 'posProducts', 'posStockMovements'];
  ck('CONTROL the rules probe finds blocks known to exist',
     known.every((c) => RULES.indexOf('match /' + c + '/{') > -1),
     'a broken probe would report every collection as absent');

  ck('there is NO rule for the bare inventory collection',
     RULES.indexOf('match /inventory/{') === -1);
  ck('and there is no catch-all to cover it',
     RULES.indexOf('match /{document=**}') === -1,
     'denied by default in the repo AND in served ruleset ' + SERVED_RULESET_VERIFIED);

  const WSM = SYNC.slice(SYNC.indexOf('const writeStockMovement'), SYNC.indexOf('const writeProductUpdate'));
  ck('the quantity increment targets that unruled collection', WSM.indexOf("'inventory'") > -1);
  /* P20B changed this from a bare swallow to a classified report. The DIVERGENCE itself is
     unchanged and still asserted below — only its visibility moved. */
  ck('NEGATIVE the denial is no longer discarded by a bare swallow',
     WSM.indexOf('.catch(() => {})') === -1,
     'comment-stripped: this assertion once passed on comment prose');
  ck('a denial is classified and reported (P20B)', WSM.indexOf('permission-denied') > -1);
  ck('the movement record is written OUTSIDE that catch, so it succeeds independently',
     WSM.indexOf('await _fsSetDoc(docRef, enriched);') > -1 &&
     WSM.indexOf('await _fsSetDoc(docRef, enriched);') < WSM.indexOf("'inventory'"),
     'audit succeeds + quantity denied = permanent silent divergence');
  ck('and the movement record itself IS permitted by the rules',
     RULES.indexOf('match /posStockMovements/{') > -1);
}

head('RESULT');
console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
process.exit(fail > 0 ? 1 : 0);

})().catch((e) => { console.error('HARNESS CRASH', e); process.exit(2); });
