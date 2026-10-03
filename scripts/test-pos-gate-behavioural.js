#!/usr/bin/env node
/* The POS commission gate — PROVEN BY EXECUTION, against the REAL identity authority.
 *
 *   node scripts/test-pos-gate-behavioural.js
 *
 * WHY THIS EXISTS, AND IT IS NOT A DUPLICATE
 * `test-pos-gate-enforcement.js` checks the same properties with regexes over the source.
 * Two sabotages walked straight through it:
 *
 *   S1  `if (!_merchantProven)` -> `if (false)`     38/38 PASSED
 *   S6  delete the unreadable-ledger refusal        38/38 PASSED
 *
 * S1 survived because `_merchantProven` and the refusal message both still EXIST in the
 * file — they are simply unreachable. A regex cannot tell live code from dead code.
 *
 * S6 survived for a worse reason: the assertion
 *   /could not be checked, so this sale was not completed/
 * also matches line 446, the resolveActor catch — a DIFFERENT guard entirely. The test was
 * satisfied by code it was not testing.
 *
 * So this suite CALLS posCompleteCheckout and asserts what actually happens.
 *
 * NO STUB FOR THE IDENTITY AUTHORITY. `functions/merchant-identity.js` was restored on
 * 2026-09-07 from the deployed canonical blob (ccc43cf, 20,818 bytes, verified by hash), so
 * `resolveActor` here is the production authority. The actor branches are driven by SEEDING
 * the documents it actually reads — shops/{shopId}, users/{uid}, shopEmployees/{uid} — which
 * has the useful side effect of proving those ARE the documents it reads. A stub would have
 * asserted my belief about the authority; this asserts the authority.
 */
'use strict';

const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label +
    (detail !== undefined && detail !== '' ? '   [' + String(detail).slice(0, 150) + ']' : ''));
  ok ? pass++ : fail++;
};

class HttpsError extends Error {
  constructor(code, message, details) { super(message); this.code = code; this.details = details; }
}

const CTL = {
  membershipOk: false,     /* workspaceMemberships grants the `sales` capability */
  liabilities: [],         /* rows the commission ledger holds                   */
  ledgerUnreadable: false, /* the commission ledger read fails                   */
  shopsUnreadable: false,  /* the IDENTITY authority itself is unavailable       */
  ledgerQueries: 0,        /* P0: how many times the commission ledger was queried */
};

const DOCS = new Map();
const FieldValue = { serverTimestamp: () => 'TS', increment: (n) => ({ __inc: n }), arrayUnion: (...a) => ({ __union: a }) };
/* arrayUnion is resolved on write (gift-card redemptions); every other value, __inc included, is stored as before. */
const _resolveUnion = (prev, v) => { const o = Object.assign({}, prev || {}); for (const [k, x] of Object.entries(v || {})) o[k] = (x && x.__union) ? [...(o[k] || []), ...x.__union] : x; return o; };

function makeDb() {
  const mk = (name, filters) => ({
    doc(id) {
      const key = name + '/' + id;
      return {
        _key: key, id,
        async get() {
          /* The identity authority being DOWN is a different event from the caller not being
             employed, and posCompleteCheckout must not collapse the two. */
          if (name === 'shops' && CTL.shopsUnreadable) throw new Error('identity store unavailable');
          const d = DOCS.get(key);
          return { exists: !!d, id, data: () => (d ? Object.assign({}, d) : undefined) };
        },
        async set(v) { DOCS.set(key, Object.assign({}, DOCS.get(key) || {}, v)); },
        async create(v) {
          if (DOCS.has(key)) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; }
          DOCS.set(key, Object.assign({}, v));
        },
        async update(v) { DOCS.set(key, Object.assign({}, DOCS.get(key) || {}, v)); },
      };
    },
    where(f, _op, v) { return mk(name, filters.concat([[f, v]])); },
    orderBy() { return this; },
    limit() { return this; },
    async get() {
      if (name === 'posCommissionLiabilities') CTL.ledgerQueries++;
      if (name === 'posCommissionLiabilities' && CTL.ledgerUnreadable) {
        throw new Error('simulated Firestore outage');
      }
      /* L-9A: workspaceMemberships rows come from DOCS, so the membership the _assertBusinessPermission stub
         stands for is also readable by a transactional re-read of it (posCompleteCheckout's membership path). */
      const rows = name === 'posCommissionLiabilities' ? CTL.liabilities
        : name === 'workspaceMemberships'
          ? [...DOCS.entries()].filter(([k]) => k.startsWith('workspaceMemberships/')).map(([, v]) => v)
          : [];
      const kept = rows.filter((r) => filters.every(([f, v]) => r[f] === v));
      return { docs: kept.map((r, i) => ({ id: 'L' + i, data: () => r })), empty: kept.length === 0,
               forEach(cb) { kept.forEach((r, i) => cb({ id: 'L' + i, data: () => r })); } };
    },
  });
  return {
    collection: (n) => mk(n, []),
    async runTransaction(fn) {
      const w = [];
      const t = { async get(r) { return r.get(); }, set(r, v) { w.push([r._key, v]); },
                  update(r, v) { w.push([r._key, v]); }, create(r, v) { w.push([r._key, v]); } };
      const out = await fn(t);
      for (const [k, v] of w) DOCS.set(k, _resolveUnion(DOCS.get(k), v));
      return out;
    },
  };
}
const DB = makeDb();

const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin/firestore') {
    return { getFirestore: () => DB, FieldValue,
             Timestamp: { now: () => ({ toMillis: () => Date.now() }) } };
  }
  if (id === 'firebase-admin') {
    return { apps: [1], initializeApp: () => {}, auth: () => ({}),
             firestore: Object.assign(() => DB, { FieldValue,
               Timestamp: { now: () => ({ toMillis: () => Date.now() }) } }) };
  }
  if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => h, HttpsError };
  if (id === 'firebase-functions/v2/scheduler') return { onSchedule: (_o, h) => h };
  if (id === 'firebase-functions/v2/firestore') {
    return { onDocumentWritten: (_o, h) => h, onDocumentCreated: (_o, h) => h,
             onDocumentUpdated: (_o, h) => h };
  }
  if (id === 'firebase-functions/logger') return { info() {}, warn() {}, error() {}, debug() {} };
  if (id === 'firebase-functions/params') return { defineSecret: (n) => ({ name: n, value: () => '0' }) };
  if (id === './pos-audit') return { writeAudit: () => {} };
  /* NOT stubbed: ./merchant-identity is the real, restored, deployed-canonical module. */
  if (id === './workforce-identity') {
    return { _assertBusinessPermission: async () => {
      if (!CTL.membershipOk) throw new HttpsError('permission-denied', 'no membership');
      return true;
    } };
  }
  if (id === './tenant-identity') return { resolveMerchantIdForOwner: async () => ({ ok: false }) };
  return orig.apply(this, arguments);
};

let ZF, loadErr = null;
try { ZF = require(path.join(FN, 'pos-zero-friction.js')); } catch (e) { loadErr = e; }
Module.prototype.require = orig;

/* `merchantId` IS the shopId — the till sends `merchantId: scope.shopId`. The OWNER's uid
   equals the shop id (ownership is the document id); the CASHIER is a different uid, which is
   what makes the fixture non-degenerate. */
const MERCHANT = 'SHOP_KASS_001';
const CASHIER  = 'CSH_uid_442';
const STRANGER = 'STR_uid_909';
const eat = (iso) => Date.parse(iso + '+03:00');

let keySeq = 0;

/* Seed the REAL resolveActor's inputs and return the uid to call as. */
function seedActor(kind) {
  DOCS.set('shops/' + MERCHANT, { name: 'KASS Shop' });
  DOCS.set('users/' + MERCHANT, { displayName: 'Owner Ann' });
  if (kind === 'owner') return MERCHANT;
  if (kind === 'employee') {
    DOCS.set('users/' + CASHIER, { displayName: 'Cashier Zed' });
    /* THE CANONICAL COMPOSITE KEY — `${shopId}_${uid}`, exactly what
       shop-employees.js `employeeDocId()` produces. An earlier version of this fixture
       wrote `shopEmployees/{uid}`, which is the LEGACY single-uid key. That fixture
       passed against the deployed merchant-identity (ccc43cf, which still reads the
       legacy key) and failed against the newer one — so the test was asserting the old
       key, and would have quietly certified a module that disagrees with the writer.
       Keyed here through the real employeeDocId so the fixture cannot drift from it. */
    const EMP = require(path.join(FN, 'shop-employees.js'));
    DOCS.set('shopEmployees/' + EMP.employeeDocId(MERCHANT, CASHIER), {
      shopId: MERCHANT, uid: CASHIER, shopOwnerId: MERCHANT,
      role: 'cashier', name: 'Cashier Zed', active: true, status: 'active',
    });
    return CASHIER;
  }
  return STRANGER;                    /* shop exists; caller is a stranger to it */
}

function reset() {
  DOCS.clear();
  CTL.membershipOk = false; CTL.liabilities = [];
  CTL.ledgerUnreadable = false; CTL.shopsUnreadable = false; CTL.ledgerQueries = 0;
  DOCS.set('businesses/' + MERCHANT, { ownerId: 'SOMEONE_ELSE' });
  /* 0b R4: a till sells only products that belong to the proven merchant, and a product with no
     owner is refused. The fixture product therefore names its owner — the merchant under test —
     exactly as every production product does (measured 2026-09-27: 102/102 owned). The gate
     assertions below are unchanged. */
  DOCS.set('products/P1', { name: 'Rice', price: 100, stock: 50, trackInventory: true,
    sellerUid: MERCHANT, shopId: MERCHANT });
}

const call = async (uid, over = {}) => {
  try {
    const r = await ZF.posCompleteCheckout({
      data: Object.assign({
        idempotencyKey: 'IK_' + (++keySeq),
        merchantId: MERCHANT,
        items: [{ productId: 'P1', qty: 1, unitPrice: 100 }],
        subtotal: 100, grandTotal: 100, discountTotal: 0, taxTotal: 0,
        payments: [{ method: 'cash', amount: 100 }],
      }, over),
      auth: { uid, token: { posRole: 'cashier' } },
    });
    return { ok: true, result: r };
  } catch (e) { return { ok: false, code: e && e.code, message: e && e.message, reason: e && e.details && e.details.reason }; }
};

const overdue = () => ([{ merchantUid: MERCHANT, settlementDay: '2026-09-05',
                          liabilityMinor: 5000, status: 'OUTSTANDING' }]);
const noSale = () => ![...DOCS.keys()].some((k) => k.indexOf('posRetailSales/') === 0);

(async () => {

ck('S0  pos-zero-friction loads', !loadErr, loadErr && loadErr.message);
if (loadErr) { console.log('\nCANNOT PROCEED — refusing to report vacuous results.\n'); process.exit(1); }
ck('S1  posCompleteCheckout is callable', typeof ZF.posCompleteCheckout === 'function');
ck('S2  merchant-identity is PRESENT — the real authority, not a stub',
  require('fs').existsSync(path.join(FN, 'merchant-identity.js')),
  'restored from deployed canonical ccc43cf');

console.log('\nPART A — the merchant is PROVEN, against the real identity authority\n');
{
  /* A stranger to this shop, with no workspace membership either. */
  reset(); const uid = seedActor('stranger');
  const r = await call(uid);
  ck('A1  a stranger to the shop is REFUSED', r.ok === false, r.code || 'no refusal');
  ck('A2  ...with permission-denied', r.code === 'permission-denied', r.code);
  ck('A3  ...saying they are not authorised for this shop',
    /not authorised to record a sale for this shop/i.test(r.message || ''), r.message);
  ck('A4  ...and NO sale document was written', noSale());
}
{
  /* Authority 1 — the OWNER, proven by shops/{uid} being keyed on their own uid. */
  reset(); const uid = seedActor('owner');
  const r = await call(uid);
  ck('A5  the shop OWNER is admitted by the real resolveActor',
    !(r.code === 'permission-denied' && /not authorised to record a sale/i.test(r.message || '')),
    r.code || 'completed');
}
{
  /* Authority 1b — a real shopEmployees record whose shopOwnerId matches this shop. */
  reset(); const uid = seedActor('employee');
  const r = await call(uid);
  ck('A6  a real shop EMPLOYEE is admitted',
    !(r.code === 'permission-denied' && /not authorised to record a sale/i.test(r.message || '')),
    r.code || 'completed');
}
{
  /* An employee record pointing at ANOTHER shop must not admit them here — the exact
     forgery resolveActor exists to stop. */
  reset(); seedActor('stranger');
  DOCS.set('users/' + CASHIER, { displayName: 'Cashier Zed' });
  DOCS.set('shopEmployees/' + CASHIER, {
    shopOwnerId: 'SOME_OTHER_SHOP', role: 'cashier', name: 'Zed', active: true, status: 'active',
  });
  const r = await call(CASHIER);
  ck('A7  an employee of ANOTHER shop is refused here',
    r.code === 'permission-denied', r.code);
  ck('A8  ...and no sale was written', noSale());
}
{
  /* Authority 2 — canonical workspace membership, for staff who exist only there. Requiring
     the actor ALONE would refuse every one of them: a till outage dressed as a security fix. */
  reset(); const uid = seedActor('stranger'); CTL.membershipOk = true;
  /* L-9A: the membership the stub grants exists as a record — the same shape _assertBusinessPermission queries
     (uid · businessId · status active · permissions incl. `sales`), so the stock transaction's re-read finds it. */
  DOCS.set('workspaceMemberships/' + uid + '_' + MERCHANT, { uid, businessId: MERCHANT, status: 'active', permissions: ['sales'] });
  const r = await call(uid);
  ck('A9  canonical workspace membership ALSO admits the sale',
    !(r.code === 'permission-denied' && /not authorised to record a sale/i.test(r.message || '')),
    r.code || 'completed');
}
{
  /* The identity authority being DOWN is not the same as "not employed". */
  reset(); seedActor('owner'); CTL.shopsUnreadable = true;
  const r = await call(MERCHANT);
  ck('A10 an unavailable identity authority refuses the sale', r.ok === false, r.code);
  ck('A11 ...as a staff-permissions failure, not as "not employed"',
    /Staff permissions could not be checked/i.test(r.message || ''), r.message);
  ck('A12 ...and no sale was written', noSale());
}

/* P0 TILL SAFETY (owner ruling 2026-09-27). The gate is switched OFF (pos-commission-rail
   GATE_ENFORCED) until a certified settlement path exists: nothing deployed can pay a liability,
   so an enforced gate would lock a till with no way to unlock it. PARTS B and C therefore assert
   the P0 invariant — overdue debt and an unreadable ledger are NOT refusals, and the ledger is not
   even read. This fake database cannot complete a sale (it stops later, as `internal`), so the
   assertions are "not refused by the gate", never "refused"; completion itself, and that the
   liability is still recorded, are proved against the emulator by test-p0-till-gate-off.js. The
   gate's own closing behaviour stays proved in test-pos-gate-enforcement.js PART E. */
console.log('\nPART B — P0: unpaid commission does NOT close the till while the gate is off\n');
{
  reset(); const uid = seedActor('owner'); CTL.liabilities = overdue();
  const r = await call(uid);
  ck('B1  a merchant with overdue commission is NOT refused as a closed till',
    r.code !== 'failed-precondition' && !/Settle|commission/i.test(r.message || ''), r.code || 'completed');
  ck('B2  ...and the commission ledger was not read at all', CTL.ledgerQueries === 0, 'queries=' + CTL.ledgerQueries);
  let RAIL_ENFORCED = null;
  try { RAIL_ENFORCED = require(path.join(FN, 'pos-commission-rail.js')).GATE_ENFORCED; } catch (e) { RAIL_ENFORCED = 'unloadable'; }
  ck('B3  ...because the one gate switch is OFF', RAIL_ENFORCED === false, 'GATE_ENFORCED=' + RAIL_ENFORCED);
}
{
  reset(); const uid = seedActor('owner');
  const today = new Date().toISOString().slice(0, 10);
  CTL.liabilities = [{ merchantUid: MERCHANT, settlementDay: today,
                       liabilityMinor: 5000, status: 'OUTSTANDING' }];
  const r = await call(uid);
  ck('B5  today\'s accrual does NOT close the till', r.code !== 'failed-precondition',
    r.code || 'completed');
}
{
  reset(); const uid = seedActor('owner');
  const r = await call(uid);
  ck('B6  a merchant who owes nothing is not gated', r.code !== 'failed-precondition',
    r.code || 'completed');
}
{
  reset(); const uid = seedActor('owner');
  CTL.liabilities = [{ merchantUid: 'SOMEONE_ELSE', settlementDay: '2026-09-05',
                       liabilityMinor: 5000, status: 'OUTSTANDING' }];
  const r = await call(uid);
  ck('B7  another merchant\'s debt does not gate this one',
    r.code !== 'failed-precondition', r.code || 'completed');
}

console.log('\nPART C — P0: an UNREADABLE ledger no longer stops a sale while the gate is off\n');
{
  reset(); const uid = seedActor('owner'); CTL.ledgerUnreadable = true;
  const r = await call(uid);
  /* THE SUBSTRING TRAP THAT LET S6 THROUGH still applies: assert the COMMISSION half of the
     message is absent, not merely "could not be checked". */
  ck('C1  an unreadable commission ledger does NOT refuse the sale on commission grounds',
    !(r.code === 'unavailable' && /commission balance could not be checked/i.test(r.message || '')), r.code || 'completed');
  ck('C2  ...because the ledger is never read (an outage cannot stop a sale)', CTL.ledgerQueries === 0, 'queries=' + CTL.ledgerQueries);
  ck('C4  ...and explicitly NOT the staff-permissions message',
    !/Staff permissions could not be checked/i.test(r.message || ''), r.message);
}

console.log('\nPART D — adversarial controls\n');
{
  /* If the harness could never reach the gate, every refusal above would be for the wrong
     reason. Prove a clean owner gets PAST both guards. */
  reset(); const uid = seedActor('owner');
  const r = await call(uid);
  const blocked = r.code === 'permission-denied' || r.code === 'failed-precondition'
    || (r.code === 'unavailable' && /could not be checked/i.test(r.message || ''));
  ck('D1  a proven merchant with a clear gate is NOT blocked by either guard',
    !blocked, r.code || 'completed');

  reset(); const s = seedActor('stranger');
  const denied = await call(s);
  reset(); const o1 = seedActor('owner'); CTL.liabilities = overdue();
  const gated = await call(o1);
  reset(); const o2 = seedActor('owner'); CTL.ledgerUnreadable = true;
  const unread = await call(o2);
  /* P0: of the three former refusals only the identity one remains; debt and an outage are not
     refusals while the gate switch is off. */
  ck('D2  the identity guard still refuses (permission-denied); debt and an outage do not refuse on commission',
    denied.code === 'permission-denied' && gated.code !== 'failed-precondition'
      && !(unread.code === 'unavailable' && /commission balance/i.test(unread.message || '')),
    denied.code + ' / ' + gated.code + ' / ' + unread.code);

  /* An unproven caller with an overdue ledger must be refused as UNAUTHORISED — proving the
     proof runs first, and incidentally not leaking that some other shop owes money. */
  reset(); const s2 = seedActor('stranger'); CTL.liabilities = overdue();
  const both = await call(s2);
  ck('D3  unproven + overdue is refused as UNAUTHORISED, proving proof runs first',
    both.code === 'permission-denied', both.code);

  /* And the seeding must genuinely change the answer, or PART A proves nothing. */
  reset(); const a = seedActor('stranger'); const rA = await call(a);
  reset(); const b = seedActor('owner');    const rB = await call(b);
  ck('D4  the actor fixture genuinely moves the outcome', rA.code !== rB.code,
    rA.code + ' vs ' + rB.code);
}

/* PART K — MODERATION TAKEDOWN at the till (owner 2026-10-03; ported from 8b60947 onto this line). */
console.log('\nPART K — a SOKONI takedown blocks the till; a seller switch-off does not\n');
{
  const H = { name: 'Taken down', price: 100, stock: 50, trackInventory: true, sellerUid: MERCHANT, shopId: MERCHANT, isVisible: false,
    moderationHold: { active: true, ref: 'abcd1234abcd1234', at: 'TS' } };
  reset(); let u = seedActor('owner'); DOCS.set('products/P1', Object.assign({}, H));
  let r = await call(u);
  ck('K-1 a product under a SOKONI takedown (moderationHold) cannot be sold at the till', !r.ok && r.code === 'failed-precondition' && noSale(), r.code + ' ' + (r.message || ''));
  ck('K-2 ...and its stock is untouched', DOCS.get('products/P1').stock === 50);
  reset(); u = seedActor('owner'); DOCS.set('products/P1', Object.assign({}, H, { moderationHold: undefined }));
  delete DOCS.get('products/P1').moderationHold;
  r = await call(u);
  ck('K-3 CONTROL: a seller\'s own switch-off (isVisible:false, no hold) still sells in store', r.ok, r.code + ' ' + (r.message || ''));
  reset(); u = seedActor('owner'); DOCS.set('products/P1', Object.assign({}, H));
  try { r = await ZF.posCompleteCheckout({ data: { dryRun: true, idempotencyKey: 'IK_K_DRY', merchantId: MERCHANT, items: [{ productId: 'P1', qty: 1, unitPrice: 100 }], subtotal: 100, grandTotal: 100 }, auth: { uid: u, token: { posRole: 'cashier' } } }); } catch (e) { r = { err: e.message }; }
  ck('K-4 the dry run reports the takedown as a difference (moderation)', r && (r.differences || []).some((x) => x.field === 'moderation' && x.error === 'PRODUCT_UNDER_MODERATION'), JSON.stringify(r).slice(0, 160));
}

/* PART GC — TILL GIFT CARD (owner P0 brief 2026-10-03, GC-01..GC-20). Each row EXECUTES posCompleteCheckout and
   records TEST · EXPECTED · OBSERVED · DATABASE EFFECT · MONEY EFFECT · SALE EFFECT · PASS/FAIL. */
console.log('\nPART GC — the browser may only REQUEST a gift-card payment; the server authorises and completes it\n');
{
  const FUT = { toMillis: () => Date.now() + 864e5 }, PAST = { toMillis: () => Date.now() - 864e5 };
  const card = (code, o) => DOCS.set('giftCards/' + code, Object.assign({ code, shopId: MERCHANT, balance: 500, initialBalance: 500, status: 'active', expiryDate: FUT, redemptions: [] }, o || {}));
  const sales = () => [...DOCS.keys()].filter((k) => k.indexOf('posRetailSales/') === 0);
  const recs = () => [...DOCS.keys()].filter((k) => k.indexOf('posGiftCardRedemptions/') === 0);
  const bal = (code) => (DOCS.get('giftCards/' + code) || {}).balance;
  const ROWS = [];
  const row = (id, test, expected, ok, observed, db, money, sale) => { ROWS.push([id, test, expected, observed, db, money, sale, ok ? 'PASS' : 'FAIL']); ck(id + ' ' + test, ok, observed); };
  const gc = async (uid, payments, over) => call(uid, Object.assign({ payments }, over || {}));
  const fresh = () => { reset(); return seedActor('owner'); };
  const refused = (code, reason) => (r) => !r.ok && r.reason === reason && sales().length === 0 && recs().length === 0 && (code ? bal(code) === (DOCS.get('giftCards/' + code) || {}).initialBalance : true);
  let u, r;

  u = fresh(); card('GOOD-0001'); r = await gc(u, [{ method: 'gift_card', code: 'good0001', amount: 100 }]);
  { const rec = DOCS.get(recs()[0]) || {}; const sid = r.ok && r.result && r.result.saleId;
    row('GC-01', 'valid card + sufficient balance', 'PASS', r.ok && bal('GOOD-0001') === 400 && sales().length === 1 && rec.saleId === sid && rec.merchantId === MERCHANT && rec.amount === 100 && rec.currency === 'KES' && rec.saleTotal === 100,
      r.ok ? 'completed' : (r.message || r.code), 'payment record bound to sale/merchant/amount/KES', 'card 500 → 400', 'one sale'); }
  { const sale = DOCS.get(sales()[0]) || {}; const pj = JSON.stringify(sale.payments || []) + JSON.stringify((r.result && r.result.receipt && r.result.receipt.payments) || []);
    row('GC-01c', 'the sale and receipt carry no card code or PIN (last 4 + redemption id only)', 'no credential', !/good-?0001/i.test(pj.replace(/"codeLast4":"0001"/g, '')) && /"codeLast4":"0001"/.test(pj) && !/"pin"/.test(pj),
      pj.slice(0, 120), 'sale.payments sanitised', '—', '—'); }
  u = fresh(); card('LOW0-0002', { balance: 50, initialBalance: 50 }); r = await gc(u, [{ method: 'gift_card', code: 'LOW0-0002', amount: 100 }]);
  row('GC-02', 'insufficient balance', 'REFUSE', refused('LOW0-0002', 'GIFT_CARD_BALANCE')(r), r.message || 'completed', 'none', 'card unchanged', 'no sale');
  u = fresh(); card('INAC-0003', { status: 'inactive' }); r = await gc(u, [{ method: 'gift_card', code: 'INAC-0003', amount: 100 }]);
  row('GC-03', 'inactive card', 'REFUSE', refused('INAC-0003', 'GIFT_CARD_NOT_ACTIVE')(r), r.message || 'completed', 'none', 'card unchanged', 'no sale');
  u = fresh(); card('EXPD-0004', { expiryDate: PAST }); r = await gc(u, [{ method: 'gift_card', code: 'EXPD-0004', amount: 100 }]);
  row('GC-04', 'expired card', 'REFUSE', refused('EXPD-0004', 'GIFT_CARD_EXPIRED')(r), r.message || 'completed', 'none', 'card unchanged', 'no sale');
  u = fresh(); card('VOID-0005', { status: 'void' }); r = await gc(u, [{ method: 'gift_card', code: 'VOID-0005', amount: 100 }]);
  row('GC-05', 'revoked card', 'REFUSE', refused('VOID-0005', 'GIFT_CARD_NOT_ACTIVE')(r), r.message || 'completed', 'none', 'card unchanged', 'no sale');
  u = fresh(); r = await gc(u, [{ method: 'gift_card', code: 'NONE-0006', amount: 100 }]);
  row('GC-06', 'nonexistent card', 'REFUSE', refused(null, 'GIFT_CARD_NOT_FOUND')(r), r.message || 'completed', 'none', 'none', 'no sale');
  u = fresh(); card('OTHR-0007', { shopId: 'SHOP_B' }); r = await gc(u, [{ method: 'gift_card', code: 'OTHR-0007', amount: 100 }]);
  row('GC-07', 'wrong merchant / context', 'REFUSE', refused('OTHR-0007', 'GIFT_CARD_OTHER_SHOP')(r), r.message || 'completed', 'none', 'card unchanged', 'no sale');
  u = fresh(); card('WSAL-0008', { balance: 0, initialBalance: 0 });
  DOCS.set('posGiftCardRedemptions/OTHER_SALE_WSAL-0008', { code: 'WSAL-0008', saleId: 'OTHER_SALE', merchantId: MERCHANT, amount: 100, currency: 'KES', status: 'captured' });
  r = await gc(u, [{ method: 'gift_card', code: 'WSAL-0008', amount: 100, redemptionId: 'OTHER_SALE_WSAL-0008', ref: 'OTHER_SALE_WSAL-0008' }]);
  row('GC-08', 'another sale\'s gift-card payment presented for this sale', 'REFUSE', !r.ok && r.reason === 'GIFT_CARD_BALANCE' && sales().length === 0 && bal('WSAL-0008') === 0, r.message || 'completed', 'no new record', 'none', 'no sale');
  u = fresh(); card('AMNT-0009'); const r9a = await gc(u, [{ method: 'gift_card', code: 'AMNT-0009', amount: 99.5 }]); const r9b = await gc(u, [{ method: 'gift_card', code: 'AMNT-0009', amount: 110 }]);
  row('GC-09', 'wrong amount (under by 0.50; over by 10)', 'REFUSE', !r9a.ok && r9a.reason === 'GIFT_CARD_AMOUNT' && !r9b.ok && /Only a cash payment can produce change/.test(r9b.message || '') && sales().length === 0 && bal('AMNT-0009') === 500, (r9a.message || 'ok') + ' | ' + (r9b.message || 'ok'), 'none', 'card unchanged', 'no sale');
  u = fresh(); card('CURR-0010'); card('CURU-0011', { currency: 'USD' });
  const r10a = await gc(u, [{ method: 'gift_card', code: 'CURR-0010', amount: 100, currency: 'USD' }]); const r10b = await gc(u, [{ method: 'gift_card', code: 'CURU-0011', amount: 100 }]);
  row('GC-10', 'wrong currency (payment line USD; card USD)', 'REFUSE', !r10a.ok && r10a.reason === 'WRONG_CURRENCY' && !r10b.ok && r10b.reason === 'GIFT_CARD_CURRENCY' && sales().length === 0 && bal('CURR-0010') === 500 && bal('CURU-0011') === 500, (r10a.message || 'ok') + ' | ' + (r10b.message || 'ok'), 'none', 'cards unchanged', 'no sale');
  u = fresh(); r = await gc(u, [{ method: 'gift_card', code: 'PAID-0012', amount: 100, paid: true, status: 'success', paymentVerified: true }]);
  row('GC-11', 'browser says paid, server payment absent', 'REFUSE', refused(null, 'GIFT_CARD_NOT_FOUND')(r), r.message || 'completed', 'none', 'none', 'no sale');
  u = fresh(); card('FBAL-0013', { balance: 50, initialBalance: 50 }); r = await gc(u, [{ method: 'gift_card', code: 'FBAL-0013', amount: 100, balance: 99999 }]);
  row('GC-12', 'browser supplies a fake balance', 'REFUSE', refused('FBAL-0013', 'GIFT_CARD_BALANCE')(r), r.message || 'completed', 'none', 'card unchanged', 'no sale');
  u = fresh(); r = await gc(u, [{ method: 'gift_card', amount: 100, ref: 'GCR_SUCCESS_123', redemptionId: 'GCR_SUCCESS_123', paid: true }]);
  row('GC-13', 'browser supplies a fake successful reference (no card)', 'REFUSE', refused(null, 'GIFT_CARD_CODE_REQUIRED')(r), r.message || 'completed', 'none', 'none', 'no sale');
  u = fresh(); card('DUPL-0014'); { const d = { idempotencyKey: 'IK_GC_DUP', payments: [{ method: 'gift_card', code: 'DUPL-0014', amount: 100 }] };
    const a1 = await call(u, d); const a2 = await call(u, d);
    row('GC-14', 'duplicate request (same key twice)', 'one payment only', a1.ok && bal('DUPL-0014') === 400 && recs().length === 1 && sales().length === 1 && (DOCS.get('giftCards/DUPL-0014').redemptions || []).length === 1,
      'first ' + (a1.ok ? 'ok' : a1.message) + ', second ' + (a2.ok ? 'ok(replay)' : a2.message), 'one record', 'card debited once (400)', 'one sale'); }
  u = fresh(); card('REPL-0015'); { const d = { idempotencyKey: 'IK_GC_REPLAY', payments: [{ method: 'gift_card', code: 'REPL-0015', amount: 100 }] };
    const a1 = await call(u, d); const sk = sales()[0]; DOCS.delete(sk);                     /* the sale write is lost after the debit committed */
    const a2 = await call(u, d);
    row('GC-15', 'replay after the sale record was lost', 'no second deduction', a1.ok && bal('REPL-0015') === 400 && (DOCS.get('giftCards/REPL-0015').redemptions || []).length === 1 && recs().length === 1,
      'replay ' + (a2.ok ? 'ok' : a2.message), 'record reused', 'card debited once (400)', a2.ok ? 'sale re-written' : 'sale not re-written'); }
  /* GC-15b / GC-08b — the in-transaction redemption record, exercised directly. On this line the debit, the record and the
     sale commit together, so "sale lost after the debit" cannot arise through the API; the record check is defence in
     depth and is proven by seeding its precondition: a record at THIS sale's id, with no sale and no idempotency row. */
  { const gk = (c) => require('crypto').createHash('sha256').update(String(c)).digest('hex').slice(0, 16);
    u = fresh(); card('PRIO-0021'); const sid = ZF._saleIdFor(MERCHANT, 'IK_GC_PRIOR');
    DOCS.set('posGiftCardRedemptions/' + sid + '_' + gk('PRIO-0021'), { code: 'PRIO-0021', saleId: sid, merchantId: MERCHANT, amount: 100, currency: 'KES', status: 'captured' });
    r = await call(u, { idempotencyKey: 'IK_GC_PRIOR', payments: [{ method: 'gift_card', code: 'PRIO-0021', amount: 100 }] });
    row('GC-15b', 'a redemption already recorded for this sale is not debited again', 'no second deduction', bal('PRIO-0021') === 500 && (DOCS.get('giftCards/PRIO-0021').redemptions || []).length === 0,
      r.ok ? 'sale completed on the existing record' : (r.message || r.code), 'record reused', 'card unchanged (500)', r.ok ? 'one sale' : 'no sale');
    u = fresh(); card('WREC-0022'); const sid2 = ZF._saleIdFor(MERCHANT, 'IK_GC_WREC');
    DOCS.set('posGiftCardRedemptions/' + sid2 + '_' + gk('WREC-0022'), { code: 'WREC-0022', saleId: 'SOME_OTHER_SALE', merchantId: MERCHANT, amount: 100, currency: 'KES' });
    r = await call(u, { idempotencyKey: 'IK_GC_WREC', payments: [{ method: 'gift_card', code: 'WREC-0022', amount: 100 }] });
    row('GC-08b', 'a redemption record naming ANOTHER sale cannot pay this one', 'REFUSE', !r.ok && r.reason === 'GIFT_CARD_WRONG_SALE' && sales().length === 0 && bal('WREC-0022') === 500,
      r.message || 'completed', 'none', 'card unchanged', 'no sale'); }
  /* GC-16 is NOT counted: the in-memory stub has no transaction contention, so a pass here would be vacuous. */
  ROWS.push(['GC-16', 'simultaneous redemption by two tills', 'cannot overspend', 'not run — needs Firestore transaction contention (emulator)', '—', '—', '—', 'UNPROVEN']);
  console.log('  UNPROVEN GC-16 simultaneous redemption by two tills   [emulator only]');
  u = fresh(); card('DONE-0017'); { const d = { idempotencyKey: 'IK_GC_DONE', payments: [{ method: 'gift_card', code: 'DONE-0017', amount: 100 }] };
    await call(u, d); const before = JSON.stringify(DOCS.get(sales()[0])); const a2 = await call(u, d);
    row('GC-17', 'sale already completed', 'no second completion', sales().length === 1 && JSON.stringify(DOCS.get(sales()[0])) === before && bal('DONE-0017') === 400,
      a2.ok ? 'returned the existing sale' : a2.message, 'unchanged', 'card debited once', 'one sale, unchanged'); }
  u = fresh(); card('EXCT-0018', { balance: 100, initialBalance: 100 }); r = await gc(u, [{ method: 'gift_card', code: 'EXCT-0018', amount: 100 }]);
  row('GC-18', 'card balance exactly equals the sale', 'PASS', r.ok && bal('EXCT-0018') === 0 && DOCS.get('giftCards/EXCT-0018').status === 'redeemed' && sales().length === 1, r.ok ? 'completed' : r.message, 'record written', 'card 100 → 0 (redeemed)', 'one sale');
  u = fresh(); card('UNDR-0019', { balance: 99.99, initialBalance: 99.99 }); r = await gc(u, [{ method: 'gift_card', code: 'UNDR-0019', amount: 100 }]);
  row('GC-19', 'card balance one cent below the sale', 'REFUSE', refused('UNDR-0019', 'GIFT_CARD_BALANCE')(r), r.message || 'completed', 'none', 'card unchanged', 'no sale');
  u = fresh(); card('FAIL-0020'); DOCS.set('products/P1', Object.assign({}, DOCS.get('products/P1'), { stock: 0 }));
  r = await gc(u, [{ method: 'gift_card', code: 'FAIL-0020', amount: 100 }]);
  row('GC-20', 'the sale fails after the card was checked (no stock)', 'nothing debited', !r.ok && /stock/i.test(r.message || '') && bal('FAIL-0020') === 500 && recs().length === 0 && sales().length === 0, r.message || 'completed', 'no record (one transaction)', 'card unchanged', 'no sale');
  u = fresh(); r = await gc(u, [{ method: 'mpesa_till_manual', amount: 100, mpesaRef: 'QX12AB34CD' }]);
  row('GC-X1', 'CONTROL: manual till code still refused (owner ruling)', 'REFUSE', !r.ok && sales().length === 0, r.message || 'completed', 'none', 'none', 'no sale');
  u = fresh(); r = await gc(u, [{ method: 'cash', amount: 100 }]);
  row('GC-X2', 'CONTROL: cash semantics unchanged', 'PASS', r.ok && sales().length === 1, r.ok ? 'completed' : r.message, 'sale', 'drawer', 'one sale');

  console.log('\n  TEST  | EXPECTED | OBSERVED | DATABASE EFFECT | MONEY EFFECT | SALE EFFECT | RESULT');
  for (const x of ROWS) console.log('  ' + [x[0] + ' ' + x[1], x[2], String(x[3]).slice(0, 70), x[4], x[5], x[6], x[7]].join(' | '));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\nsuite crashed:', e.stack, '\n'); process.exit(1); });
