#!/usr/bin/env node
/**
 * CASHIER → MANAGER APPROVAL LOOP — request only. Approval is NOT execution.
 *
 *   node scripts/test-pos-cashier-approval-request.js
 *
 * The loop this certifies:
 *
 *   cashier raises a BOUND request → manager sees the exact operation in the Sales
 *   Control Centre → manager decides → cashier reads the SERVER's decision
 *
 * and the invariant that makes it safe to ship half-built:
 *
 *   `_consumeApproval` has ZERO mutation call sites. Approving a refund refunds
 *   nothing. The words on screen must say so — "Approved by manager", never
 *   "Refund completed".
 *
 * WHAT IS EXECUTED vs ASSERTED FROM SOURCE, stated plainly because the difference
 * matters: the server primitive (binding, self-approval, cross-shop, malformed input)
 * and every rendering function are RUN. The wiring of the four cashier entry points —
 * which button calls which method — is a SOURCE assertion, because clicking a button
 * in pos.js needs a browser and this is a static harness.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');
const ROOT = path.resolve(__dirname, '..');
const NL = String.fromCharCode(10);

const PAR_SRC = fs.readFileSync(path.join(ROOT, 'sokoni-pos-approval-request.js'), 'utf8');
const POSJS = fs.readFileSync(path.join(ROOT, 'pos.js'), 'utf8');
const POSHTML = fs.readFileSync(path.join(ROOT, 'pos.html'), 'utf8');
const SALES_SRC = fs.readFileSync(path.join(ROOT, 'sokoni-pos-sales.js'), 'utf8');

let pass = 0, fail = 0, unproven = 0, n = 0;
const ck = (l, ok, d) => {
  n++;
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + String(n).padStart(2) + '. ' + l +
    (d !== undefined ? '   [' + String(d).slice(0, 88) + ']' : ''));
  ok ? pass++ : fail++;
};
const un = (l, why) => { console.log('  UNPROVEN  ' + l + '   [' + why + ']'); unproven++; };
const head = (t) => console.log(NL + t);

const strip = (src) => {
  let out = '', i = 0, inB = false;
  while (i < src.length) {
    if (!inB && src[i] === '/' && src[i + 1] === '*') { inB = true; i += 2; continue; }
    if (inB && src[i] === '*' && src[i + 1] === '/') { inB = false; i += 2; continue; }
    if (!inB) out += src[i];
    i++;
  }
  return out;
};
const PAR_CODE = strip(PAR_SRC);
const POSJS_CODE = strip(POSJS);

/* ── the cashier module, executed ─────────────────────────────────────────── */
const win = {};
const PAR = new Function('window', 'document', 'module',
  PAR_SRC + NL + 'return window.PosApprovalRequest;')(win,
  { getElementById: () => null, createElement: () => ({ style: {} }), head: { appendChild() {} },
    body: { appendChild() {} } }, { exports: {} });
const P = PAR._internal;

/* ── the server primitive, executed against an in-memory Firestore ────────── */
const STORE = {};
class HttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; this.httpErrorCode = true; }
}
const MEMBERSHIPS = new Set();
const docRef = (c, id) => ({ id,
  get: async () => ({ exists: Object.prototype.hasOwnProperty.call(STORE, c + '/' + id),
                      data: () => STORE[c + '/' + id], id }),
  set: async (v) => { STORE[c + '/' + id] = JSON.parse(JSON.stringify(v)); },
  update: async (v) => { Object.assign(STORE[c + '/' + id], v); } });
let AUTO = 0;
const collRef = (c) => { const q = {};
  q.where = () => q; q.orderBy = () => q; q.limit = () => q;
  q.get = async () => ({ empty: true, docs: [], forEach() {} });
  q.doc = (id) => docRef(c, id || ('a' + (++AUTO))); return q; };
const fakeDb = { collection: collRef,
  runTransaction: async (fn) => fn({ get: async (r) => r.get(),
    update: (r, v) => { const k = Object.keys(STORE).find((x) => x.endsWith('/' + r.id));
                        if (k) Object.assign(STORE[k], v); } }) };
const realLoad = Module._load;
Module._load = function (request) {
  if (request === 'firebase-admin') return { apps: [1], initializeApp() {},
    firestore: Object.assign(() => fakeDb, { FieldValue: { serverTimestamp: () => 'TS', increment: (x) => x } }) };
  if (request === 'firebase-functions/v2/https') return { onCall: (_o, h) => h, HttpsError };
  if (request === 'firebase-functions/v2/scheduler') return { onSchedule: (_o, h) => h };
  if (request.endsWith('workforce-identity')) return {
    _assertBusinessPermission: async (uid, biz) => {
      if (!MEMBERSHIPS.has(uid + '@' + biz)) throw new HttpsError('permission-denied', 'no');
    } };
  return realLoad.apply(this, arguments);
};
const OPS = require(path.join(ROOT, 'functions/pos-staff-ops.js'));
Module._load = realLoad;

const req = (uid, role, data) => ({ auth: { uid, token: { posRole: role, name: 'X' } }, data });
const caught = async (fn) => { try { await fn(); return null; } catch (e) { return e.code || 'threw'; } };
const created = (id) => STORE['posApprovals/' + id];

console.log(NL + 'CASHIER → MANAGER APPROVAL LOOP' + NL + '='.repeat(64));

(async function main () {

/* ── A · DISCOUNT ─────────────────────────────────────────────────────────── */
head('A · discount');
ck('cashier sees Request Manager Approval at the discount point',
   POSHTML.indexOf('SPos.cart.requestDiscountApproval()') > -1 &&
   POSHTML.indexOf('Request manager approval') > -1);
ck('the exact discount VALUE is captured, resolved to money',
   POSJS_CODE.indexOf("PosApprovalRequest.request('discount', { amount: amount }") > -1 &&
   POSJS_CODE.indexOf('isPct ? Math.round(sub * (val / 100)') > -1,
   'a percentage must never be approved and later read as that many shillings');
ck('the exact TARGET is captured for a price override',
   POSJS_CODE.indexOf("request('price_override',") > -1 &&
   POSJS_CODE.indexOf('{ productId: String(id), amount: next }') > -1);
ck('a REASON is captured', POSJS_CODE.indexOf('reason: isPct') > -1);
MEMBERSHIPS.add('CASHIER_1@SHOP_A');
const rDisc = await OPS.createApprovalRequest(req('CASHIER_1', 'cashier',
  { sellerId: 'SHOP_A', type: 'discount', requestData: { amount: 500, reason: 'promo' } }));
ck('the requester is AUTHORITATIVE (auth.uid, not payload)',
   created(rDisc.approvalId).requestedBy === 'CASHIER_1');
ck('the shop is AUTHORITATIVE', created(rDisc.approvalId).sellerId === 'SHOP_A');
ck('a pending request is created', created(rDisc.approvalId).status === 'pending' &&
   created(rDisc.approvalId).binding.amount === 500);
P.reset();
ck('duplicate protection keys on the exact operation',
   PAR_CODE.indexOf("var key = type + '|' + JSON.stringify(binding || {});") > -1 &&
   PAR_CODE.indexOf('Approval already pending') > -1 &&
   PAR_CODE.indexOf("_call('checkApproval', { approvalId: _pending[key] })") > -1,
   're-checked against the server, never trusted from memory alone');

/* ── B · REFUND ───────────────────────────────────────────────────────────── */
head('B · refund');
ck('Request Manager Approval exists in the refund dialog',
   POSJS.indexOf("SPos.sales.requestRefundApproval(") > -1);
ck('the exact refund AMOUNT is bound, from the selected lines',
   POSJS_CODE.indexOf('if (el.checked) amount +=') > -1 &&
   POSJS_CODE.indexOf("request('refund',") > -1);
ck('the exact SALE is bound', POSJS_CODE.indexOf('{ saleId: String(txnId), amount:') > -1);
const rRef = await OPS.createApprovalRequest(req('CASHIER_1', 'cashier',
  { sellerId: 'SHOP_A', type: 'refund', requestData: { saleId: 'SALE_9', amount: 2500 } }));
ck('requester is authoritative on a refund request',
   created(rRef.approvalId).requestedBy === 'CASHIER_1');
ck('shop is authoritative on a refund request', created(rRef.approvalId).sellerId === 'SHOP_A');
ck('creating the request does NOT refund',
   POSJS_CODE.indexOf('async requestRefundApproval') > -1 &&
   POSJS_CODE.slice(POSJS_CODE.indexOf('async requestRefundApproval'),
                    POSJS_CODE.indexOf('async requestVoidApproval')).indexOf('_processRefund') === -1,
   'the execute path is a different method and is untouched');

/* ── C · VOID ─────────────────────────────────────────────────────────────── */
head('C · void');
ck('Request Manager Approval exists in the void dialog',
   POSJS.indexOf('SPos.sales.requestVoidApproval(') > -1);
const rVoid = await OPS.createApprovalRequest(req('CASHIER_1', 'cashier',
  { sellerId: 'SHOP_A', type: 'void', requestData: { saleId: 'SALE_7' } }));
ck('the exact saleId is bound', created(rVoid.approvalId).binding.saleId === 'SALE_7');
ck('creating the request does NOT void',
   POSJS_CODE.slice(POSJS_CODE.indexOf('async requestVoidApproval'),
                    POSJS_CODE.indexOf('async requestVoidApproval') + 700).indexOf('_processVoid') === -1);
/* The P7 guard now compares against the sellerId that authorization was granted FOR,
   rather than auth.uid directly — Priority 17 converged void onto workspaceMemberships,
   so an employee is authorized for their merchant's shop and the transaction pins the
   sale to it. For the owner path authorizedSellerId IS auth.uid, so the boundary is
   unchanged there. Reviewed before this assertion was updated. */
const RE_SRC_P7 = fs.readFileSync(path.join(ROOT, 'functions/pos-retail-engine.js'), 'utf8');
ck('the Priority 7 tenant boundary is still intact',
   RE_SRC_P7.indexOf('if (!isAdmin && sale.sellerId !== authorizedSellerId) {') > -1 &&
   RE_SRC_P7.indexOf('const authorizedSellerId = (preSnap.data() || {}).sellerId || null;') > -1,
   'the sale is still pinned to the shop authority was granted for');
ck('...and authority is still server-derived, never from the payload',
   RE_SRC_P7.indexOf('resolveMerchantIdForOwner(authorizedSellerId)') > -1,
   'the merchant comes from the SALE, not the request');

/* ── D · MANAGER ──────────────────────────────────────────────────────────── */
head('D · the manager side');
const SALES = new Function('window', 'document', 'module',
  SALES_SRC + NL + 'return window.PosSalesView;')({},
  { getElementById: () => null, createElement: () => ({ style: {} }), head: { appendChild() {} } },
  { exports: {} });
const S = SALES._internal;
const pend = { id: rRef.approvalId, type: 'refund', requestedBy: 'CASHIER_1', requestedByName: 'Jane',
               binding: { saleId: 'SALE_9', amount: 2500 }, requestData: { reason: 'Customer returned item' },
               createdAt: Date.now(), status: 'pending', sellerId: 'SHOP_A' };
S._set('sales', { ok: true, rows: [] });
S._set('approvals', { ok: true, list: [pend] });
ck('the pending request is read through getPendingApprovals',
   strip(SALES_SRC).indexOf("_call('getPendingApprovals'") > -1);
ck('the Sales Control Centre displays it', S.approvalsView().indexOf(rRef.approvalId) > -1);
ck('Overview routes to Approvals',
   S.overviewView().indexOf('data-pss="tab" data-to="approvals"') > -1 &&
   S.overviewView().indexOf('1 approval request') > -1);
const det = S.approvalDetailView(rRef.approvalId);
ck('the EXACT binding is displayed, not a category',
   det.indexOf('2,500') > -1 && det.indexOf('SALE_9') > -1 && det.indexOf('Jane') > -1 &&
   det.indexOf('Customer returned item') > -1);
ck('approve invokes reviewApproval',
   strip(SALES_SRC).indexOf("_call('reviewApproval', { approvalId: id, decision: decision })") > -1);
ck('the UI re-reads server state after approving',
   strip(SALES_SRC).indexOf('_approvals = await _loadApprovals(uid);') > -1);
ck('reject uses the same server call and the same re-read',
   strip(SALES_SRC).indexOf("_decide(uid, b.dataset.id, 'rejected')") > -1 &&
   strip(SALES_SRC).indexOf("_decide(uid, b.dataset.id, 'approved')") > -1);
ck('NEGATIVE no local status painting anywhere',
   strip(SALES_SRC).indexOf("status = 'approved'") === -1 &&
   PAR_CODE.indexOf("status = 'approved'") === -1);

/* ── E · SECURITY ─────────────────────────────────────────────────────────── */
head('E · the security properties are unchanged');
STORE['posApprovals/self'] = { sellerId: 'SHOP_A', type: 'refund', requestedBy: 'CASHIER_1',
  binding: { saleId: 'S', amount: 1 }, status: 'pending', expiresAt: new Date(Date.now() + 60000) };
ck('self approval remains blocked',
   (await caught(() => OPS.reviewApproval(req('CASHIER_1', 'supervisor',
     { approvalId: 'self', decision: 'approved' })))) === 'permission-denied');
STORE['posApprovals/other'] = { sellerId: 'SHOP_B', type: 'void', requestedBy: 'X',
  binding: { saleId: 'S' }, status: 'pending', expiresAt: new Date(Date.now() + 60000) };
ck('cross-shop approval remains blocked',
   (await caught(() => OPS.reviewApproval(req('CASHIER_1', 'supervisor',
     { approvalId: 'other', decision: 'approved' })))) === 'permission-denied');
const rForge = await OPS.createApprovalRequest(req('CASHIER_1', 'cashier',
  { sellerId: 'SHOP_A', type: 'void', requestData: { saleId: 'S1' },
    requestedBy: 'SOMEONE_ELSE', uid: 'SOMEONE_ELSE' }));
ck('requester cannot be replaced by the payload',
   created(rForge.approvalId).requestedBy === 'CASHIER_1');
ck('shop cannot be replaced by the payload',
   (await caught(() => OPS.createApprovalRequest(req('CASHIER_1', 'cashier',
     { sellerId: 'SHOP_B', type: 'void', requestData: { saleId: 'S1' } })))) === 'permission-denied',
   'sellerId goes through the same membership check as every other handler');
ck('binding cannot be modified after creation',
   PAR_CODE.indexOf('binding') > -1 &&
   strip(fs.readFileSync(path.join(ROOT, 'functions/pos-staff-ops.js'), 'utf8'))
     .indexOf('const binding = _buildBinding(data.type, data.requestData || {});') > -1 &&
   !/binding:\s*data\./.test(strip(fs.readFileSync(path.join(ROOT, 'functions/pos-staff-ops.js'), 'utf8'))),
   'it is derived server-side at creation and never taken from the request');
ck('malformed requestData is rejected',
   (await caught(() => OPS.createApprovalRequest(req('CASHIER_1', 'cashier',
     { sellerId: 'SHOP_A', type: 'refund', requestData: { amount: 50 } })))) === 'invalid-argument',
   'a refund with no saleId is unbound, so it is refused');

/* ── F · SEPARATION ───────────────────────────────────────────────────────── */
head('F · approval is not execution');
ck('approval creation executes no mutation',
   PAR_CODE.indexOf('posProcessRefund') === -1 && PAR_CODE.indexOf('voidPOSSale') === -1 &&
   PAR_CODE.indexOf('_processRefund') === -1 && PAR_CODE.indexOf('_processVoid') === -1);
ck('approval review executes no mutation',
   strip(SALES_SRC).indexOf('posProcessRefund') === -1 &&
   strip(SALES_SRC).indexOf('voidPOSSale') === -1);
/* `_consumeApproval` is module-private. The ONLY way another file can reach it is the
   exported alias `_approvals.consume(...)`, so an assertion that greps only for the
   private name is looking for a spelling that cannot occur — it passed while a
   sabotage wired real consumption into posProcessRefund. Both spellings, plus the
   require that would be needed to get there, are checked now. */
const CONSUMERS = fs.readdirSync(path.join(ROOT, 'functions'))
  .filter((f) => f.slice(-3) === '.js' && f !== 'pos-staff-ops.js')
  .filter((f) => {
    const src = fs.readFileSync(path.join(ROOT, 'functions', f), 'utf8');
    return src.indexOf('_consumeApproval(') > -1 ||
           src.indexOf('_approvals.consume') > -1 ||
           /\.consume\(\s*[A-Za-z_$]/.test(src);
  });
ck('approval consumption call sites remain ZERO', CONSUMERS.length === 0,
   CONSUMERS.length ? CONSUMERS.join(', ') : 'none — checked both the private name and the exported alias');
ck('the words never claim execution',
   P.COPY.approved[1] === 'Approved by manager' &&
   PAR_CODE.indexOf('Refund completed') === -1 &&
   PAR_CODE.indexOf('Sale voided') === -1 &&
   PAR_CODE.indexOf('Discount applied') === -1,
   'approving records a decision; saying otherwise would be the whole defect');
ck('CONTROL an approved request still says it was NOT carried out',
   P.statusHtml('refund', { saleId: 'S', amount: 10 }, 'approved').indexOf('has <b>not</b> been') > -1);
ck('CONTROL the pending copy points at the manager screen',
   P.statusHtml('refund', { saleId: 'S', amount: 10 }, 'pending').indexOf('Needs your attention') > -1);
ck('CONTROL the description carries the exact figure, never a bare category',
   P.describe('refund', { saleId: 'SALE_9', amount: 2500 }).indexOf('2,500') > -1 &&
   P.describe('refund', { saleId: 'SALE_9', amount: 2500 }).indexOf('SALE_9'.slice(-8)) > -1);
ck('NEGATIVE no browser-side approval becomes authorization',
   PAR_CODE.indexOf('localStorage') === -1 && PAR_CODE.indexOf('sessionStorage') === -1 &&
   PAR_CODE.indexOf("status: 'approved'") === -1);

/* ── G · ARCHITECTURE ─────────────────────────────────────────────────────── */
head('G · nothing new was created');
ck('no new employee store',
   PAR_CODE.indexOf('shopStaff') === -1 && PAR_CODE.indexOf('workspaceMemberships') === -1 &&
   PAR_CODE.indexOf('posStaff') === -1 && PAR_CODE.indexOf('employeeRecords') === -1);
ck('no new approval store',
   PAR_CODE.indexOf('collection(') === -1 &&
   PAR_CODE.indexOf('createApprovalRequest') > -1 && PAR_CODE.indexOf('checkApproval') > -1,
   'it only calls the existing callables');
ck('no new notification store',
   PAR_CODE.indexOf('notifications') === -1 && PAR_CODE.indexOf('Notification(') === -1 &&
   PAR_CODE.indexOf('pushManager') === -1,
   'the manager path is Sales → Needs your attention, not an invented channel');
ck('the PIN is unchanged',
   fs.existsSync(path.join(ROOT, 'pos-manager-auth.js')) &&
   POSJS.indexOf("ManagerAuth.request('void'") > -1 &&
   POSJS.indexOf("ManagerAuth.request('refund'") > -1 &&
   POSJS.indexOf("ManagerAuth.request('large_discount'") > -1,
   'the execute paths still go through it');
ck('the Sales Control Centre stays lazy',
   POSHTML.indexOf('src="sokoni-pos-sales.js"') === -1 &&
   POSHTML.indexOf('lazyGlobal("PosSalesView"') > -1);
ck('the request module is lazy too',
   POSHTML.indexOf('src="sokoni-pos-approval-request.js"') === -1 &&
   POSHTML.indexOf('lazyGlobal("PosApprovalRequest"') > -1);

/* ── boundary ─────────────────────────────────────────────────────────────── */
head('what this does NOT prove');
un('a real cashier raises a real request', 'needs the deployed callables and a signed-in till');
un('a manager actually approves one end to end', 'same — the loop is proven by parts, not in production');
un('the four buttons behave on a handset', 'source-asserted wiring; clicking needs a browser');
un('approval gates any operation', 'ZERO consume call sites, by design in this slice');
un('duplicate protection across a reload', 'the map is in memory only; the server stays the record');

console.log(NL + '  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
console.log('  NOTE: approval is NOT execution. Nothing here authorises a mutation.');
})().then(() => process.exit(fail ? 1 : 0))
   .catch((e) => { console.error(NL + '  HARNESS ERROR: ' + (e && e.stack || e)); process.exit(2); });
