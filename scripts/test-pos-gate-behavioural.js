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
const FieldValue = { serverTimestamp: () => 'TS', increment: (n) => ({ __inc: n }) };

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
      for (const [k, v] of w) DOCS.set(k, Object.assign({}, DOCS.get(k) || {}, v));
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
  } catch (e) { return { ok: false, code: e && e.code, message: e && e.message }; }
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

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\nsuite crashed:', e.stack, '\n'); process.exit(1); });
