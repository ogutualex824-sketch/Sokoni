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
   returns the wrong row rather than nothing, and the test can tell. */
function makeDb(docs) {
  const reads = [];
  const q = (coll, filters = [], lim = 1000) => ({
    where(f, _op, v) { return q(coll, filters.concat([[f, v]]), lim); },
    limit(n) { return q(coll, filters, n); },
    async get() {
      reads.push({ coll, filters: filters.slice() });
      const rows = Object.keys(docs)
        .filter((id) => filters.every(([f, v]) => String((docs[id] || {})[f]) === String(v)))
        .slice(0, lim)
        .map((id) => ({ id, exists: true, ref: { id }, data: () => docs[id] }));
      return { empty: rows.length === 0, size: rows.length, docs: rows, forEach: (fn) => rows.forEach(fn) };
    },
  });
  return {
    reads,
    collection: (coll) => Object.assign(q(coll), {
      doc: (id) => ({
        id,
        async get() { reads.push({ coll, docId: id }); return { id, exists: !!docs[id], ref: { id }, data: () => docs[id] }; },
        async set(d) { docs[id] = Object.assign({}, d); },
        async update(d) { docs[id] = Object.assign({}, docs[id] || {}, d); },
      }),
    }),
  };
}

const err = async (p) => { try { await p; return null; } catch (e) { return e; } };

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
{
  const docs = makeDocs();
  const db = makeDb(docs);
  let captured = null;

  const orig = Module.prototype.require;
  Module.prototype.require = function (id) {
    /* pos-zero-friction imports the MODULAR specifier, not 'firebase-admin'.
       Missing it meant the real SDK loaded, threw "default Firebase app does not
       exist", and PART D — the decisive part — silently skipped while the run
       still looked green. */
    if (id === 'firebase-admin/firestore') {
      return { getFirestore: () => db,
        FieldValue: { serverTimestamp: () => ({ __s: 'ts' }), increment: (n) => ({ __s: 'inc', n }),
          arrayUnion: () => ({ __s: 'arr' }), delete: () => ({ __s: 'del' }) },
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
    if (id === 'firebase-functions/v2/https') {
      return { onCall: (_o, h) => { if (!captured) captured = h; return h; },
        onRequest: (_o, h) => (h || _o),
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

  /* Capture posLookupCustomer specifically, by re-registering onCall per export. */
  let lookup = null;
  Module.prototype.require = (function (base) {
    return function (id) {
      if (id === 'firebase-functions/v2/https') {
        const real = base.apply(this, arguments);
        return Object.assign({}, real, { onCall: (_o, h) => h });
      }
      return base.apply(this, arguments);
    };
  })(Module.prototype.require);

  let loaded = true, mod = null;
  try {
    const f = path.join(FUNCTIONS_DIR, 'pos-zero-friction.js');
    delete require.cache[require.resolve(f)];
    mod = require(f);
    lookup = mod.posLookupCustomer;
  } catch (e) {
    loaded = false;
    console.log('  NOTE  pos-zero-friction.js could not be loaded (' + String(e.message).slice(0, 80) + ')');
  } finally { Module.prototype.require = orig; }

  if (loaded && typeof lookup === 'function') {
    const call = (uid, data, token) => lookup({ auth: uid ? { uid, token: token || {} } : null, data });

    /* ── The five acceptance cases ── */
    const own = await call(SELLER_A, { query: PHONE_B, method: 'phone' });
    ck('D1  SELLER_A finds their OWN customer', own && own.found === true && own.name === 'Ann Ali');

    const cross = await call(SELLER_A, { query: PHONE_C, method: 'phone' });
    ck('D2  SELLER_A finds NOTHING for another merchant\'s customer', cross && cross.found === false);

    const stranger = await call(STRANGER, { query: PHONE_B, method: 'phone' });
    ck('D3  an unrelated account finds nothing', stranger && stranger.found === false);

    const anon = await err(call(null, { query: PHONE_B, method: 'phone' }));
    ck('D4  an unauthenticated caller is DENIED', anon !== null, anon && anon.code);

    const legit = await call(SELLER_C, { query: PHONE_C, method: 'phone' });
    ck('D5  the legitimate POS caller for THAT customer still works',
      legit && legit.found === true && legit.name === 'Carol Chege');

    /* ── ZERO disclosure on a miss ── */
    const missBody = JSON.stringify(cross);
    ck('D6  a denied lookup discloses NO name, phone, email or card code',
      !SECRETS_C.some((s) => missBody.indexOf(s) !== -1), missBody);
    ck('D7  ...no loyalty or spend data', !/loyalty|totalSpent|purchaseCount|tier/i.test(missBody));
    ck('D8  ...and it is byte-identical to a customer that does not exist',
      missBody === JSON.stringify(await call(SELLER_A, { query: '254700009999', method: 'phone' })),
      missBody);

    /* Every alternative method must be scoped too — a fix that closes phone and
       leaves email open is not a fix. */
    const byEmail = await call(SELLER_A, { query: 'carol@othershop.com', method: 'email' });
    ck('D9  the EMAIL method is scoped too', byEmail && byEmail.found === false);
    const byCard = await call(SELLER_A, { query: 'CARDC2', method: 'memberCard' });
    ck('D10 the MEMBER-CARD method is scoped too', byCard && byCard.found === false);
    const byId = await call(SELLER_A, { query: 'CUST_C', method: 'id' });
    ck('D11 the DOCUMENT-ID method is scoped too', byId && byId.found === false);
    const byAuto = await call(SELLER_A, { query: 'carol@othershop.com' });
    ck('D12 ...and so is the default auto method', byAuto && byAuto.found === false);

    /* A legacy record belongs to nobody and is returned to nobody. */
    const legacy = await call(SELLER_A, { query: '254700000009', method: 'phone' });
    ck('D13 a legacy unowned record is returned to NOBODY', legacy && legacy.found === false);

    /* The caller cannot name another seller to widen the search. */
    const forged = await call(SELLER_A, { query: PHONE_C, method: 'phone', sellerId: SELLER_C });
    ck('D14 naming another sellerId in the REQUEST does not widen the search',
      forged && forged.found === false);
  } else {
    console.log('  SKIP  the callable could not be captured — PART D is UNVERIFIED.');
    console.log('        Do not read a skip as a pass.');
    fail++;
  }
}

/* ═══ E — the shipped source ═══ */
console.log('\nPART E — the unscoped queries are gone\n');
{
  const zf = fs.readFileSync(path.join(FUNCTIONS_DIR, 'pos-zero-friction.js'), 'utf8');
  const re = fs.readFileSync(path.join(FUNCTIONS_DIR, 'pos-retail-engine.js'), 'utf8');
  const lookupBody = zf.slice(zf.indexOf('exports.posLookupCustomer'), zf.indexOf('exports.posLookupCustomer') + 2400);

  ck('E1  posLookupCustomer no longer queries posCustomers directly',
    !/coll\.where\('phone'/.test(lookupBody) && !/db\.collection\('posCustomers'\)\s*\.where/.test(lookupBody));
  ck('E2  ...it resolves an owner from auth', /_custScope\.resolveOwner\(auth/.test(lookupBody));
  ck('E3  ...and every branch goes through the scoped helpers',
    (lookupBody.match(/_custScope\.(findOwned|getOwned)/g) || []).length >= 4,
    (lookupBody.match(/_custScope\.(findOwned|getOwned)/g) || []).join(','));

  const getBody = re.slice(re.indexOf('exports.getPOSCustomer'), re.indexOf('exports.upsertPOSCustomer'));
  ck('E4  getPOSCustomer is scoped', /_custScope\.(findOwned|getOwned)/.test(getBody) &&
    !/collection\('posCustomers'\)\s*\n?\s*\.where\('phone'/.test(getBody));

  const upBody = re.slice(re.indexOf('exports.upsertPOSCustomer'), re.indexOf('exports.upsertPOSCustomer') + 2600);
  ck('E5  upsertPOSCustomer scopes its existing-customer lookup',
    /_custScope\.findOwned\(fdb, owner, 'phone'/.test(upBody));
  ck('E6  ...and STAMPS the owner on create, so the record can be filtered ever after',
    /_custScope\.ownerStamp\(owner\)/.test(upBody));

  ck('E7  the owner is never read from the request body in the scope module',
    !/req\.data\.sellerId|data\.sellerId/.test(fs.readFileSync(path.join(FUNCTIONS_DIR, 'pos-customer-scope.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')));

  /* Mutation control: the scoping must be removable, or E1–E6 prove nothing. */
  const mutated = lookupBody.replace(/_custScope\.findOwned\(db, owner, 'phone', phone\)/, 'null');
  ck('E8  the scoped call is a real line that can be removed (control)', mutated !== lookupBody);
}

console.log('\n' + '='.repeat(70));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error(e); process.exit(1); });
