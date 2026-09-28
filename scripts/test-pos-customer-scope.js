#!/usr/bin/env node
/* posLookupCustomer — the cross-tenant PII disclosure fix (2D-2 security stage).
 *
 *   node scripts/test-pos-customer-scope.js
 *
 * THE DEFECT
 * posLookupCustomer searched `posCustomers` by phone, document id, email or
 * member-card code with NO merchant filter, and returned the customer's name,
 * email, phone, loyalty points, tier, total spent and purchase count. Any signed
 * in account could look up any customer on the platform by phone number, and a
 * phone number is guessable — enumerable cross-tenant PII disclosure.
 *
 * getPOSCustomer was a second unscoped read of the same collection, and
 * upsertPOSCustomer was the write-side twin: its "existing customer" lookup was
 * collection-wide, so a second merchant upserting a phone already on file
 * UPDATED THE FIRST MERCHANT'S record.
 *
 * WHY IT WAS A DATA-MODEL FIX
 * The writers recorded no owner at all, so there was no field to filter on.
 * Traced end to end before choosing: the client writer (pos-customers.js) writes
 * no sellerId — and firestore.rules requires one on create, so those writes were
 * silently rejected; upsertPOSCustomer wrote none either; pos-crm-pro encodes the
 * owner only in the document id. Meanwhile pos-bi filters on `sellerId` and
 * posGetCustomerInsights on `merchantId` — two filters over documents carrying
 * neither.
 *
 * FIXTURE — non-degenerate by construction:
 *     SELLER_A owns CUST_B      (a customer of SHOP_B's merchant)
 *     SELLER_C owns CUST_C      (a customer of another merchant)
 *     LEGACY                    a pre-fix record with NO owner at all
 * Both customers share a guessable phone shape, so an unscoped query would find
 * the wrong one rather than nothing.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const FUNCTIONS_DIR = path.join(ROOT, 'functions');
const SCOPE = require(path.join(FUNCTIONS_DIR, 'pos-customer-scope.js'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 140) + ']' : ''));
  ok ? pass++ : fail++;
};

const SELLER_A = 'SELLER_A_uid_7f3';
const SELLER_C = 'SELLER_C_uid_42x';
const STRANGER = 'STRANGER_uid_99';

const PHONE_B = '254700000001';
const PHONE_C = '254700000002';

/* The PII a denied lookup must never leak. */
const SECRETS_B = ['Ann Ali', 'ann@example.com', PHONE_B, 'GOLDCARD1'];
const SECRETS_C = ['Carol Chege', 'carol@othershop.com', PHONE_C, 'CARDC2'];

function makeDocs() {
  return {
    CUST_B: { sellerId: SELLER_A, name: 'Ann Ali', phone: PHONE_B, email: 'ann@example.com',
      memberCardCode: 'GOLDCARD1', loyaltyPoints: 340, tier: 'gold', totalSpent: 61000, purchaseCount: 14 },
    CUST_C: { sellerId: SELLER_C, name: 'Carol Chege', phone: PHONE_C, email: 'carol@othershop.com',
      memberCardCode: 'CARDC2', loyaltyPoints: 90, tier: 'bronze', totalSpent: 4000, purchaseCount: 3 },
    /* Created before the owner field existed. Belongs to nobody. */
    LEGACY: { name: 'Legacy Person', phone: '254700000009', email: 'legacy@example.com',
      loyaltyPoints: 12, totalSpent: 500 },
  };
}

/* Firestore stub whose queries HONOUR every where() — so an unscoped query
   returns the wrong row rather than nothing, and the test can tell.
   `docs` is the posCustomers collection; `others` maps 'collection/id' to the
   documents the proven-merchant path reads (shops, users, businesses,
   workspaceMemberships). Filters record as [field, value, op]; `in` and the
   document-id sentinel are honoured, every other operator is equality. */
const DOC_ID = '__document_id__';
function makeDb(docs, others) {
  const store = { posCustomers: docs };
  for (const [p, d] of Object.entries(others || {})) {
    const i = p.indexOf('/'); const c = p.slice(0, i); (store[c] = store[c] || {})[p.slice(i + 1)] = d;
  }
  const reads = [];
  const matches = (id, data, [f, v, op]) => {
    if (f === DOC_ID) return id === (v && typeof v === 'object' ? v.id : v);
    const val = (data || {})[f];
    if (op === 'in') return val !== undefined && Array.isArray(v) && v.some((x) => String(x) === String(val));
    return String(val) === String(v);
  };
  const q = (coll, filters = [], lim = 1000) => ({
    where(f, op, v) { return q(coll, filters.concat([[f, v, op]]), lim); },
    limit(n) { return q(coll, filters, n); },
    async get() {
      reads.push({ coll, filters: filters.slice() });
      const c = store[coll] || {};
      const rows = Object.keys(c)
        .filter((id) => filters.every((flt) => matches(id, c[id], flt)))
        .slice(0, lim)
        .map((id) => ({ id, exists: true, ref: { id }, data: () => c[id] }));
      return { empty: rows.length === 0, size: rows.length, docs: rows, forEach: (fn) => rows.forEach(fn) };
    },
  });
  return {
    reads,
    collection: (coll) => Object.assign(q(coll), {
      doc: (id) => ({
        id,
        async get() { reads.push({ coll, docId: id }); const c = store[coll] || {}; return { id, exists: !!c[id], ref: { id }, data: () => c[id] }; },
        async set(d) { (store[coll] = store[coll] || {})[id] = Object.assign({}, d); },
        async update(d) { (store[coll] = store[coll] || {})[id] = Object.assign({}, (store[coll] || {})[id] || {}, d); },
      }),
    }),
  };
}

const err = async (p) => { try { await p; return null; } catch (e) { return e; } };

/* Load pos-zero-friction.js against a stub database — from disk, or from a given
   SOURCE (Part E's in-memory mutants) compiled at the real path so its sibling
   requires resolve exactly as shipped. Every functions/ module is evicted first,
   so no sibling keeps a database stub from an earlier load. Returns
   { mod, error }; the caller decides what a load failure means. */
function loadZeroFriction(db, source) {
  const orig = Module.prototype.require;
  const ZF = path.join(FUNCTIONS_DIR, 'pos-zero-friction.js');
  for (const k of Object.keys(require.cache)) if (k.startsWith(FUNCTIONS_DIR)) delete require.cache[k];
  Module.prototype.require = function (id) {
    /* pos-zero-friction imports the MODULAR specifier, not 'firebase-admin'.
       Missing it meant the real SDK loaded, threw "default Firebase app does not
       exist", and PART D — the decisive part — silently skipped while the run
       still looked green. */
    if (id === 'firebase-admin/firestore') {
      return { getFirestore: () => db,
        FieldValue: { serverTimestamp: () => ({ __s: 'ts' }), increment: (n) => ({ __s: 'inc', n }),
          arrayUnion: () => ({ __s: 'arr' }), delete: () => ({ __s: 'del' }) },
        FieldPath: { documentId: () => DOC_ID },
        Timestamp: { now: () => ({ __s: 'now' }), fromDate: (d) => ({ __s: 'ts', d }),
          fromMillis: (m) => ({ __s: 'ts', m }) } };
    }
    if (id === 'firebase-admin/auth') return { getAuth: () => ({ getUser: async () => ({ customClaims: {} }) }) };
    if (id === 'firebase-admin') {
      return { firestore: Object.assign(() => db, {
        FieldValue: { serverTimestamp: () => ({ __s: 'ts' }), increment: (n) => ({ __s: 'inc', n }),
          arrayUnion: () => ({ __s: 'arr' }), delete: () => ({ __s: 'del' }) },
        Timestamp: { now: () => ({ __s: 'now' }), fromDate: (d) => ({ __s: 'ts', d }) },
      }), apps: [{}], initializeApp() {}, auth: () => ({ getUser: async () => ({ customClaims: {} }) }) };
    }
    /* onCall returns the bare handler, so every export IS its handler. */
    if (id === 'firebase-functions/v2/https') {
      return { onCall: (_o, h) => h, onRequest: (_o, h) => (h || _o),
        HttpsError: class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } } };
    }
    if (id === 'firebase-functions/v2/scheduler') return { onSchedule: (_o, h) => (h || _o) };
    if (id === 'firebase-functions/params') {
      const p = (n, o) => ({ name: n, value: () => (o && o.default) || '' });
      return { defineSecret: p, defineString: p, defineInt: p, defineBoolean: p };
    }
    if (id === 'firebase-functions/logger') return { info() {}, warn() {}, error() {}, debug() {} };
    return orig.apply(this, arguments);
  };
  try {
    if (source === undefined) return { mod: require(ZF) };
    const m = new Module(ZF, null);
    m.filename = ZF;
    m.paths = Module._nodeModulePaths(path.dirname(ZF));
    m._compile(source, ZF);
    return { mod: m.exports };
  } catch (e) {
    return { error: e };
  } finally { Module.prototype.require = orig; }
}

/* The Part D world, built fresh on demand (Part E's mutants each get their own). */
function partDWorld() {
  const docs = makeDocs();
  docs.CUST_M = { sellerId: 'BIZ_M_OWNER', name: 'Mo Member-Shop', phone: '254700000003', email: 'mo@biz.test',
    memberCardCode: 'CARDM3', loyaltyPoints: 5 };
  const db = makeDb(docs, {
    [`shops/${SELLER_A}`]: { ownerId: SELLER_A, storeName: 'Shop A' },
    [`users/${SELLER_A}`]: { name: 'Seller A' },
    [`shops/${SELLER_C}`]: { ownerId: SELLER_C, storeName: 'Shop C' },
    [`users/${SELLER_C}`]: { name: 'Seller C' },
    'businesses/BIZ_M': { ownerId: 'BIZ_M_OWNER', name: 'Member Biz' },
    'workspaceMemberships/MEMBER_CUST_BIZ_M': { uid: 'MEMBER_CUST', businessId: 'BIZ_M', status: 'active', permissions: ['pos', 'customers'] },
    'workspaceMemberships/MEMBER_POS_BIZ_M': { uid: 'MEMBER_POS', businessId: 'BIZ_M', status: 'active', permissions: ['pos'] },
  });
  return { docs, db };
}

(async () => {

/* ═══ A — the owner comes from AUTH, never the request ═══ */
console.log('\nPART A — the caller does not get to say who they are\n');
{
  ck('A1  the owner is the authenticated uid',
    SCOPE.resolveOwner({ uid: SELLER_A, token: {} }) === SELLER_A);
  ck('A2  a request-supplied sellerId is IGNORED for a normal caller',
    SCOPE.resolveOwner({ uid: SELLER_A, token: {} }, SELLER_C) === SELLER_A);
  ck('A3  ...even when it names a real other merchant',
    SCOPE.resolveOwner({ uid: STRANGER, token: {} }, SELLER_A) === STRANGER);
  ck('A4  an ADMIN may act for a named seller, because the claim already says they may',
    SCOPE.resolveOwner({ uid: 'ADMIN', token: { admin: true } }, SELLER_A) === SELLER_A);
  ck('A5  ...and an admin with no seller named acts as themselves',
    SCOPE.resolveOwner({ uid: 'ADMIN', token: { admin: true } }) === 'ADMIN');
  const anon = await err(Promise.resolve().then(() => SCOPE.resolveOwner(null)));
  ck('A6  no auth is unauthenticated', anon && anon.code === 'unauthenticated');
}

/* ═══ B — ownership, including the legacy shape ═══ */
console.log('\nPART B — who a record belongs to\n');
{
  const d = makeDocs();
  ck('B1  a record with the owner field belongs to that owner',
    SCOPE.ownsCustomer('CUST_B', d.CUST_B, SELLER_A) === true);
  ck('B2  ...and to nobody else', SCOPE.ownsCustomer('CUST_B', d.CUST_B, SELLER_C) === false);
  ck('B3  a composite-id record belongs to the uid in its id',
    SCOPE.ownsCustomer(SELLER_A + '_254700000005', {}, SELLER_A) === true);
  ck('B4  ...matched from the LEFT, so a crafted phone segment cannot spoof it',
    SCOPE.ownsCustomer('EVIL_' + SELLER_A + '_2547', {}, SELLER_A) === false);
  ck('B5  a LEGACY record with no owner belongs to NOBODY',
    SCOPE.ownsCustomer('LEGACY', d.LEGACY, SELLER_A) === false &&
    SCOPE.ownsCustomer('LEGACY', d.LEGACY, SELLER_C) === false);
  ck('B6  ...and is not silently migrated by being read', d.LEGACY.sellerId === undefined);
  ck('B7  every create carries a stamp', SCOPE.ownerStamp(SELLER_A).sellerId === SELLER_A);
}

/* ═══ C — the query is scoped, not post-filtered ═══ */
console.log('\nPART C — another merchant\'s row is never read into memory\n');
{
  const docs = makeDocs();
  const db = makeDb(docs);

  const hit = await SCOPE.findOwned(db, SELLER_A, 'phone', PHONE_B);
  ck('C1  the owner finds their own customer', !!hit && hit.id === 'CUST_B');

  const miss = await SCOPE.findOwned(db, SELLER_A, 'phone', PHONE_C);
  ck('C2  ...and finds NOTHING for another merchant\'s customer', miss === null);

  /* The decisive property: the owner filter is IN the query. A post-filter would
     still have fetched the other merchant's document first. */
  const lastRead = db.reads[db.reads.length - 1];
  ck('C3  the owner is part of the query, not applied afterwards',
    lastRead.filters.some((f) => f[0] === 'sellerId' && f[1] === SELLER_A),
    JSON.stringify(lastRead.filters));

  ck('C4  a legacy record is invisible even to a scoped query',
    (await SCOPE.findOwned(db, SELLER_A, 'phone', '254700000009')) === null);

  ck('C5  getOwned returns another merchant\'s doc as null, not as a refusal',
    (await SCOPE.getOwned(db, SELLER_A, 'CUST_C')) === null);
  ck('C6  ...and the caller\'s own doc normally',
    (await SCOPE.getOwned(db, SELLER_A, 'CUST_B')).id === 'CUST_B');
}

/* ═══ D — the real callable, and ZERO disclosure on a miss ═══ */
console.log('\nPART D — the shipped callable, and what a denial reveals\n');
/* Q0b-1 superseded 9360cbd's rule (owner = the caller's auth.uid). The till's
   lookup now takes the shop as a CLAIM (merchantId) and PROVES it — the shop
   owner or its staff (resolveActor), or a business member holding `customers`
   — and returns only that proven merchant's customers. The cases below keep
   every cross-merchant and zero-disclosure check, against that authority. */
{
  const { db } = partDWorld();
  let loaded = true, lookup = null;
  const L = loadZeroFriction(db);
  if (L.error) {
    loaded = false;
    console.log('  NOTE  pos-zero-friction.js could not be loaded (' + String(L.error.message).slice(0, 80) + ')');
  } else lookup = L.mod.posLookupCustomer;

  if (loaded && typeof lookup === 'function') {
    /* `merchantId` is the shop the till CLAIMS; the server proves it. */
    const call = (uid, data, token) => lookup({ auth: uid ? { uid, token: token || {} } : null, data });
    const A = (data) => Object.assign({ merchantId: SELLER_A }, data);
    const refusal = (e) => !!e && e.code === 'permission-denied' && /not authorised to look up/.test(String(e.message));
    const leaks = (e) => SECRETS_B.concat(SECRETS_C).some((x) => String(e && e.message).indexOf(x) !== -1);

    /* ── The acceptance cases ── */
    const own = await call(SELLER_A, A({ query: PHONE_B, method: 'phone' }));
    ck('D1  the proven shop owner finds their OWN customer', own && own.found === true && own.name === 'Ann Ali');

    const cross = await call(SELLER_A, A({ query: PHONE_C, method: 'phone' }));
    ck('D2  ...and finds NOTHING for another merchant\'s customer', cross && cross.found === false);

    const stranger = await err(call(STRANGER, A({ query: PHONE_B, method: 'phone' })));
    ck('D3  an unrelated account claiming that shop is REFUSED — it proves nothing', refusal(stranger) && !leaks(stranger),
      stranger && stranger.code);

    const anon = await err(call(null, A({ query: PHONE_B, method: 'phone' })));
    ck('D4  an unauthenticated caller is DENIED', anon !== null, anon && anon.code);

    const legit = await call(SELLER_C, { merchantId: SELLER_C, query: PHONE_C, method: 'phone' });
    ck('D5  the legitimate POS caller for THAT customer still works',
      legit && legit.found === true && legit.name === 'Carol Chege');

    /* ── ZERO disclosure on a miss ── */
    const missBody = JSON.stringify(cross);
    ck('D6  a denied lookup discloses NO name, phone, email or card code',
      !SECRETS_C.some((x) => missBody.indexOf(x) !== -1), missBody);
    ck('D7  ...no loyalty or spend data', !/loyalty|totalSpent|purchaseCount|tier/i.test(missBody));
    ck('D8  ...and it is byte-identical to a customer that does not exist',
      missBody === JSON.stringify(await call(SELLER_A, A({ query: '254700009999', method: 'phone' }))),
      missBody);

    /* Every alternative method must be scoped too — a fix that closes phone and
       leaves email open is not a fix. */
    const byEmail = await call(SELLER_A, A({ query: 'carol@othershop.com', method: 'email' }));
    ck('D9  the EMAIL method is scoped too', byEmail && byEmail.found === false);
    const byCard = await call(SELLER_A, A({ query: 'CARDC2', method: 'memberCard' }));
    ck('D10 the MEMBER-CARD method is scoped too', byCard && byCard.found === false);
    const byId = await call(SELLER_A, A({ query: 'CUST_C', method: 'id' }));
    ck('D11 the DOCUMENT-ID method is scoped too', byId && byId.found === false);
    const byAuto = await call(SELLER_A, A({ query: 'carol@othershop.com' }));
    ck('D12 ...and so is the default auto method', byAuto && byAuto.found === false);

    /* A legacy record belongs to nobody and is returned to nobody. */
    const legacy = await call(SELLER_A, A({ query: '254700000009', method: 'phone' }));
    ck('D13 a legacy unowned record is returned to NOBODY', legacy && legacy.found === false);

    /* The caller cannot name someone else to widen the search — not as a
       sellerId (ignored), and not as the claimed merchant (refused). */
    const forged = await call(SELLER_A, A({ query: PHONE_C, method: 'phone', sellerId: SELLER_C }));
    ck('D14 naming another sellerId in the REQUEST does not widen the search',
      forged && forged.found === false);
    const forgedShop = await err(call(SELLER_A, { merchantId: SELLER_C, query: PHONE_C, method: 'phone' }));
    ck('D15 claiming ANOTHER merchant\'s shop is REFUSED, with no disclosure', refusal(forgedShop) && !leaks(forgedShop),
      forgedShop && forgedShop.code);

    /* The membership path: the capability is `customers`. */
    const member = await call('MEMBER_CUST', { merchantId: 'BIZ_M', query: '254700000003', method: 'phone' });
    ck('D16 a business member WITH `customers` finds the business\'s customer',
      member && member.found === true && member.name === 'Mo Member-Shop');
    const memberCross = await call('MEMBER_CUST', { merchantId: 'BIZ_M', query: PHONE_B, method: 'phone' });
    ck('D17 ...and nothing of any other merchant', memberCross && memberCross.found === false);
    const noCap = await err(call('MEMBER_POS', { merchantId: 'BIZ_M', query: '254700000003', method: 'phone' }));
    ck('D18 a member WITHOUT `customers` is REFUSED', refusal(noCap) && !leaks(noCap), noCap && noCap.code);

    /* No claim is a deliberate refusal, not a crash and not a platform-wide search. */
    const noClaim = await err(call(SELLER_A, { query: PHONE_B, method: 'phone' }));
    ck('D19 a lookup with NO merchant claim is refused as a bad request', !!noClaim && noClaim.code === 'invalid-argument',
      noClaim && noClaim.code);
  } else {
    console.log('  SKIP  the callable could not be captured — PART D is UNVERIFIED.');
    console.log('        Do not read a skip as a pass.');
    fail++;
  }
}

/* ═══ E — the shipped source: the Q0b-1 authority, structurally ═══
   Checked on a PARSED AST, so a comment or a string that merely mentions a helper
   cannot satisfy anything. E1–E7 assert the shape of the authority; E8 proves each
   scoped call is LOAD-BEARING by swapping it for its unscoped equivalent in memory
   and requiring the lookup to leak — dead code or a textual occurrence cannot pass
   that. (This part used to pin 9360cbd's names: resolveOwner(auth),
   findOwned(db, owner, …). Q0b-1 replaced that authority; see
   docs/repairs/POS-Q0b1-customer-scope.md.) */
console.log('\nPART E — the unscoped queries are gone, and the scoped ones carry the load\n');
await (async () => {
  let parser = null;
  for (const at of ['@babel/parser', path.join(FUNCTIONS_DIR, 'node_modules', '@babel/parser')]) {
    try { parser = require(at); break; } catch (_) { /* try the next */ }
  }
  if (!parser) {
    console.log('  FAIL  E0  @babel/parser is unavailable — PART E is UNVERIFIED (a skip is not a pass)');
    fail++;
    return;
  }
  const ZF_PATH = path.join(FUNCTIONS_DIR, 'pos-zero-friction.js');
  const zf = fs.readFileSync(ZF_PATH, 'utf8');
  const re = fs.readFileSync(path.join(FUNCTIONS_DIR, 'pos-retail-engine.js'), 'utf8');
  const parse = (src) => parser.parse(src, { sourceType: 'script', errorRecovery: false });

  /* minimal walker: every node below `node` */
  const walk = (node, fn) => {
    if (!node || typeof node.type !== 'string') return;
    fn(node);
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'start' || k === 'end' || k === 'leadingComments' || k === 'trailingComments' || k === 'innerComments') continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach((c) => walk(c, fn));
      else if (v && typeof v.type === 'string') walk(v, fn);
    }
  };
  const isMember = (n, obj, prop) => n && n.type === 'MemberExpression' && !n.computed &&
    (obj === null || (n.object.type === 'Identifier' && n.object.name === obj)) && n.property.name === prop;
  const calls = (fnNode) => { const out = []; walk(fnNode, (n) => { if (n.type === 'CallExpression') out.push(n); }); return out; };
  /* `exports.NAME = onCall(cfg, handler)`  or  `exports._h.NAME = handler` */
  const handlerOf = (ast, name) => {
    let found = null;
    walk(ast.program, (n) => {
      if (found || n.type !== 'AssignmentExpression' || n.left.type !== 'MemberExpression') return;
      const L = n.left;
      const direct = L.property && L.property.name === name && L.object.type === 'Identifier' && L.object.name === 'exports';
      const viaH = L.property && L.property.name === name && L.object.type === 'MemberExpression' &&
        L.object.object.name === 'exports' && L.object.property.name === '_h';
      if (viaH && /Function/.test(n.right.type)) found = n.right;
      else if (direct && n.right.type === 'CallExpression') {
        const h = n.right.arguments.find((x) => /Function/.test(x.type));
        if (h) found = h;
      }
    });
    return found;
  };
  const scopedCalls = (fnNode, ns) => calls(fnNode).filter((c) => c.callee.type === 'MemberExpression' &&
    c.callee.object.type === 'Identifier' && c.callee.object.name === ns &&
    ['findOwnedIn', 'getOwnedIn', 'findOwnedByPhone'].includes(c.callee.property.name));
  const collectionCalls = (fnNode, coll) => calls(fnNode).filter((c) => isMember(c.callee, null, 'collection') &&
    c.arguments[0] && c.arguments[0].type === 'StringLiteral' && c.arguments[0].value === coll);

  const zAst = parse(zf), rAst = parse(re);
  const lookupFn = handlerOf(zAst, 'posLookupCustomer');
  const getFn = handlerOf(rAst, 'getPOSCustomer');
  const upFn = handlerOf(rAst, 'upsertPOSCustomer');
  ck('E0  the three handlers are found in the parsed source', !!(lookupFn && getFn && upFn));
  if (!(lookupFn && getFn && upFn)) return;

  /* E1 — posLookupCustomer never reads posCustomers itself */
  ck('E1  posLookupCustomer never queries posCustomers directly', collectionCalls(lookupFn, 'posCustomers').length === 0,
    collectionCalls(lookupFn, 'posCustomers').length + ' direct reads');

  /* E2 — the authority: a PROVEN merchant, never the caller's uid */
  const lc = calls(lookupFn);
  const resolveOwnerUsed = lc.some((c) => (c.callee.type === 'Identifier' && c.callee.name === 'resolveOwner') ||
    (c.callee.type === 'MemberExpression' && c.callee.property.name === 'resolveOwner'));
  const prove = lc.find((c) => c.callee.type === 'Identifier' && c.callee.name === '_proveCustomerMerchant');
  const ownerSet = lc.find((c) => c.callee.type === 'Identifier' && c.callee.name === '_merchantOwnerSet');
  let ownersFromSet = false;
  walk(lookupFn, (n) => {
    if (n.type === 'VariableDeclarator' && n.id.name === 'owners' && n.init && n.init.type === 'AwaitExpression' &&
        n.init.argument === ownerSet) ownersFromSet = true;
  });
  const merchantArg = (c) => c && c.arguments[1] && c.arguments[1].type === 'Identifier' && c.arguments[1].name === 'merchantId';
  ck('E2  the lookup takes no owner from auth.uid (no resolveOwner) and PROVES the claimed merchant',
    !resolveOwnerUsed && !!prove && merchantArg(prove) && !!ownerSet && ownersFromSet,
    'resolveOwner=' + resolveOwnerUsed + ' prove=' + !!prove + ' ownersFromOwnerSet=' + ownersFromSet);

  /* E3 — every lookup branch goes through a scoped helper, over THOSE proven owners */
  const zs = scopedCalls(lookupFn, '_CUSTOMER_SCOPE');
  const byName = (n) => zs.filter((c) => c.callee.property.name === n);
  const overOwners = zs.every((c) => c.arguments[1] && c.arguments[1].type === 'Identifier' && c.arguments[1].name === 'owners');
  const fieldOf = (c) => c.arguments[2] && c.arguments[2].type === 'StringLiteral' ? c.arguments[2].value : null;
  ck('E3  phone, id, email and member-card each go through a scoped helper over the proven owners',
    byName('findOwnedByPhone').length === 1 && byName('getOwnedIn').length === 1 &&
    byName('findOwnedIn').map(fieldOf).sort().join(',') === 'email,memberCardCode' && overOwners,
    zs.map((c) => c.callee.property.name + (fieldOf(c) ? ':' + fieldOf(c) : '')).join(','));

  /* E4 — getPOSCustomer: scoped, bound, and no direct query */
  const gs = scopedCalls(getFn, '_custScope');
  const boundOwners = calls(getFn).some((c) => c.callee.type === 'Identifier' && c.callee.name === '_boundSellerId');
  ck('E4  getPOSCustomer reads only through scoped helpers over a _boundSellerId owner',
    gs.length >= 2 && boundOwners && collectionCalls(getFn, 'posCustomers').length === 0,
    gs.map((c) => c.callee.property.name).join(',') + ' bound=' + boundOwners);

  /* E5 — upsert: the existing-customer lookup is owner-scoped before anything is written */
  const uc = calls(upFn);
  const whereCalls = uc.filter((c) => isMember(c.callee, null, 'where'));
  const phoneWheres = whereCalls.filter((c) => c.arguments[0] && c.arguments[0].type === 'StringLiteral' && c.arguments[0].value === 'phone');
  const chainedOnOwner = (w) => {
    const inner = w.callee.object;                              /* the call this .where() is chained on */
    if (!inner || inner.type !== 'CallExpression' || !isMember(inner.callee, null, 'where')) return false;
    const f0 = inner.arguments[0], v0 = inner.arguments[2];
    const isOwnerField = f0 && ((f0.type === 'StringLiteral' && f0.value === 'sellerId') ||
      (f0.type === 'MemberExpression' && f0.property.name === 'OWNER_FIELD'));
    return isOwnerField && v0 && v0.type === 'Identifier' && v0.name === 'owner';
  };
  const firstWrite = Math.min(...uc.filter((c) => c.callee.type === 'MemberExpression' &&
    ['update', 'create', 'set'].includes(c.callee.property.name)).map((c) => c.start));
  ck('E5  upsert finds an existing customer only through an owner-scoped query, read before any write',
    phoneWheres.length >= 1 && phoneWheres.every(chainedOnOwner) && phoneWheres.every((w) => w.start < firstWrite),
    phoneWheres.length + ' phone quer' + (phoneWheres.length === 1 ? 'y' : 'ies') + ', all on owner=' + phoneWheres.every(chainedOnOwner));

  /* E6 — every create carries the owner stamp, and nothing is blind-set */
  const creates = uc.filter((c) => c.callee.type === 'MemberExpression' && c.callee.property.name === 'create');
  const sets = uc.filter((c) => c.callee.type === 'MemberExpression' && c.callee.property.name === 'set');
  const stamped = (c) => c.arguments.some((arg) => arg.type === 'ObjectExpression' && arg.properties.some((p) =>
    p.type === 'SpreadElement' && p.argument.type === 'CallExpression' && isMember(p.argument.callee, '_custScope', 'ownerStamp') &&
    p.argument.arguments[0] && p.argument.arguments[0].type === 'Identifier' && p.argument.arguments[0].name === 'owner'));
  ck('E6  every create STAMPS the proven owner, and upsert never set()s a document',
    creates.length >= 1 && creates.every(stamped) && sets.length === 0,
    creates.length + ' create(s), stamped=' + creates.every(stamped) + ', set()=' + sets.length);

  /* E7 — kept: the scope module never reads the owner from a request body */
  ck('E7  the owner is never read from the request body in the scope module',
    !/req\.data\.sellerId|data\.sellerId/.test(fs.readFileSync(path.join(FUNCTIONS_DIR, 'pos-customer-scope.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')));

  /* E8 — REMOVAL CONTROLS, behavioural. Each scoped call in the SHIPPED source is
     replaced by its unscoped equivalent (the pre-Q0b query); the mutant is compiled
     and run in the Part D world. Each must now return another merchant's customer —
     proving the scoped line, not a comment or dead text, is what stops the leak —
     and E3 must reject the mutant's AST. A missing call fails the control. */
  const CUT = [
    ['E8a phone', 'findOwnedByPhone', PHONE_C, 'phone',
      "(await db.collection('posCustomers').where('phone', '==', q).limit(1).get()).docs[0] || null"],
    ['E8b id', 'getOwnedIn', 'CUST_C', 'id',
      "((sn) => (sn.exists ? sn : null))(await db.collection('posCustomers').doc(q).get())"],
    ['E8c email', 'findOwnedIn:email', 'carol@othershop.com', 'email',
      "(await db.collection('posCustomers').where('email', '==', q.toLowerCase()).limit(1).get()).docs[0] || null"],
    ['E8d member card', 'findOwnedIn:memberCardCode', 'CARDC2', 'memberCard',
      "(await db.collection('posCustomers').where('memberCardCode', '==', q.toUpperCase()).limit(1).get()).docs[0] || null"],
  ];
  for (const [label, which, query, method, unscoped] of CUT) {
    const [name, field] = which.split(':');
    const target = zs.find((c) => c.callee.property.name === name && (!field || fieldOf(c) === field));
    if (!target) { ck(label + ': the scoped call exists to be removed', false, 'not found'); continue; }
    const mutated = zf.slice(0, target.start) + unscoped + zf.slice(target.end);
    const mAst = (() => { try { return parse(mutated); } catch (e) { return null; } })();
    const mz = mAst ? scopedCalls(handlerOf(mAst, 'posLookupCustomer'), '_CUSTOMER_SCOPE') : [];
    const e3Rejects = mz.length === zs.length - 1;
    const { db } = partDWorld();
    const L = loadZeroFriction(db, mutated);
    let leaked = false, why = '';
    if (L.error) why = 'mutant failed to load: ' + String(L.error.message).slice(0, 60);
    else {
      try {
        const r = await L.mod.posLookupCustomer({ auth: { uid: SELLER_A, token: {} }, data: { merchantId: SELLER_A, query, method } });
        leaked = !!(r && r.found === true && r.name === 'Carol Chege');
        why = JSON.stringify(r).slice(0, 60);
      } catch (e) { why = 'threw ' + (e.code || '') + ' ' + String(e.message).slice(0, 50); }
    }
    ck(label + ': removing the scoped call LEAKS the other merchant\'s customer, and E3 rejects it',
      leaked && e3Rejects, (leaked ? 'leaked' : 'NO leak') + ', E3 ' + (e3Rejects ? 'rejects' : 'ACCEPTS') + ' — ' + why);
  }
  /* ...and the shipped source, loaded the same way, does NOT leak (the control's control). */
  {
    const { db } = partDWorld();
    const L = loadZeroFriction(db, zf);
    const r = L.error ? null : await L.mod.posLookupCustomer({ auth: { uid: SELLER_A, token: {} }, data: { merchantId: SELLER_A, query: PHONE_C, method: 'phone' } });
    ck('E8e the UNMUTATED source, compiled the same way, does not leak', !!r && r.found === false, L.error ? String(L.error.message).slice(0, 60) : JSON.stringify(r));
  }
})();

console.log('\n' + '='.repeat(70));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error(e); process.exit(1); });
