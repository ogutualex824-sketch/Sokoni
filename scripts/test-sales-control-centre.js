#!/usr/bin/env node
/**
 * SALES CONTROL CENTRE — the manager's screen, and what it must never claim.
 *
 *   node scripts/test-sales-control-centre.js
 *
 * The Sales page is now where a manager answers: who is working, what sold, what was
 * reversed, and what is waiting on me. That makes its failure modes specific:
 *
 *   · a number with no authority behind it            → must render "Not available"
 *   · an approval shown as "discount requested"       → must show the BOUND operation
 *   · a decision painted locally as approved          → must be re-read from the server
 *   · a filter mistaken for an authorisation boundary → must narrow display only
 *   · a sale with no server-resolved seller           → must stay "Not recorded"
 *
 * AND THE BIG ONE: approving here records a decision, it does NOT gate the operation.
 * `_consumeApproval` has zero mutation call sites, so the screen must say so rather than
 * implying a refund or void is now safely authorised.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const NL = String.fromCharCode(10);
const SRC = fs.readFileSync(path.join(ROOT, 'sokoni-pos-sales.js'), 'utf8');
const POS = fs.readFileSync(path.join(ROOT, 'pos.html'), 'utf8');

let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 92) + ']' : ''));
  ok ? pass++ : fail++;
};
const un = (l, why) => { console.log('  UNPROVEN  ' + l + '   [' + why + ']'); unproven++; };
const head = (t) => console.log(NL + t);

/* Comment-stripped source. Six assertions in this codebase have matched a module's own
   prose instead of its behaviour; the stripped copy is the default here. */
const CODE = (function () {
  let out = '', i = 0, inBlock = false;
  while (i < SRC.length) {
    if (!inBlock && SRC[i] === '/' && SRC[i + 1] === '*') { inBlock = true; i += 2; continue; }
    if (inBlock && SRC[i] === '*' && SRC[i + 1] === '/') { inBlock = false; i += 2; continue; }
    if (!inBlock) out += SRC[i];
    i++;
  }
  return out.split(NL).filter((l) => l.trim().indexOf('//') !== 0).join(NL);
})();

/* Load against a bare global. */
const win = {};
const V = new Function('window', 'document', 'module',
  SRC + NL + 'return window.PosSalesView;')(win,
  { getElementById: () => null, createElement: () => ({ style: {} }), head: { appendChild() {} } },
  { exports: {} });
const I = V._internal;

const now = Date.now();
const sale = (o) => Object.assign({
  id: 'S1', grandTotal: 5000, status: 'completed', createdAt: now, saleDateMs: now,
  items: [{ name: 'Rice', qty: 2, lineTotal: 2000 }],
  payments: [{ method: 'cash', amount: 5000 }],
  servedBy: { uid: 'U1', name: 'Jane', role: 'cashier' },
}, o);
const APPROVAL = { id: 'A1', type: 'refund', requestedBy: 'U1', requestedByName: 'Jane',
                   binding: { saleId: 'S1', amount: 500 }, requestData: { reason: 'Damaged item' },
                   createdAt: now, status: 'pending', sellerId: 'SHOP_A' };

const seedSales = (rows) => I._set('sales', { ok: true, rows });
const seedApprovals = (list) => I._set('approvals', { ok: true, list });

console.log(NL + 'SALES CONTROL CENTRE' + NL + '='.repeat(62));

/* ── 0 · controls ─────────────────────────────────────────────────────────── */
head('0 · CONTROLS');
ck('the module loaded', !!I && typeof I.overviewView === 'function');
ck('CONTROL the comment stripper works',
   CODE.indexOf('cashierUid == request.auth.uid') === -1 && CODE.length > 9000,
   'if this fails the source assertions below prove nothing');

/* ── 1 · a metric with no authority is not invented ───────────────────────── */
head('1 · unsupported metrics say so');
seedSales([sale({})]); seedApprovals([]);
const ov = I.overviewView();
ck('active shifts renders "Not available"', ov.indexOf('Not available') > -1,
   'getCurrentShift is caller-scoped; there is no readable shop-wide count');
ck('CONTROL the Active shifts card specifically is NOT a number',
   ov.indexOf('Active shifts</div><div class="pss-card-v">Not available<') > -1,
   'scoped to that card — an unknown rendered as 0 is the defect this rule exists for');
ck('a supported metric IS shown', ov.indexOf('5,000') > -1, 'today\'s sales come from posRetailSales');
I._set('sales', { ok: false, reason: 'permission-denied' });
const ovBlocked = I.overviewView();
ck('NEGATIVE when sales are unreadable every money card says Not available',
   (ovBlocked.match(/Not available/g) || []).length >= 6);
ck('...and no figure is fabricated', ovBlocked.indexOf('5,000') === -1);
seedSales([sale({})]);

/* ── 2 · attribution ──────────────────────────────────────────────────────── */
head('2 · an unprovable seller is still never named');
seedSales([sale({}), sale({ id: 'S2', servedBy: null })]);
ck('a proven seller is named', I.txnView([sale({})]).indexOf('Jane') > -1);
ck('NEGATIVE an unattributed sale reads "Not recorded"',
   I.saleDetailView('S2').indexOf('Not recorded') > -1);
ck('NEGATIVE it is not filled from cashierId or the shift',
   (function () {
     seedSales([sale({ id: 'S2', servedBy: null, cashierId: 'U9', shiftId: 'SH1' })]);
     const d = I.saleDetailView('S2');
     const good = d.indexOf('U9') === -1 && d.indexOf('Not recorded') > -1;
     seedSales([sale({}), sale({ id: 'S2', servedBy: null })]);
     return good;
   })(),
   'the session, the till and the shift are all tempting and all wrong');
ck('CONTROL the module still contains no inference fallback',
   CODE.indexOf('currentCashier') === -1 && CODE.indexOf('|| cashierId') === -1);
ck('unattributed sales stay OUT of employee totals',
   /could not be attributed/.test(I.byEmployeeView([sale({}), sale({ id: 'S2', servedBy: null })])));

/* ── 3 · the approval is shown exactly ────────────────────────────────────── */
head('3 · the manager sees the bound operation, not a category');
seedApprovals([APPROVAL]);
const det = I.approvalDetailView('A1');
ck('the request type is shown', det.indexOf('refund') > -1);
ck('the BOUND amount is shown', det.indexOf('500') > -1,
   'a vague "discount requested" is exactly what the binding exists to prevent');
ck('the BOUND sale is shown', det.indexOf('S1') > -1);
ck('the requester is shown', det.indexOf('Jane') > -1);
ck('the reason is shown', det.indexOf('Damaged item') > -1);
ck('NEGATIVE an approval with no binding says so rather than implying one',
   I.bindingRows({ binding: {} }).indexOf('No bound detail recorded') > -1);
ck('the pending request appears in the list', I.approvalsView().indexOf('A1') > -1);
ck('...summarised with its amount', I.approvalsView().indexOf('500') > -1);

/* ── 4 · the screen never claims enforcement ──────────────────────────────── */
head('4 · approving records a decision; it does not gate the operation');
ck('the list carries the not-enforced notice',
   I.approvalsView().indexOf('does not yet') > -1);
ck('the detail carries it too', det.indexOf('does not yet') > -1);
ck('...and names what actually controls the operation',
   I.notEnforcedNote().indexOf('PIN') > -1);
/* Both spellings. `_consumeApproval` is module-private, so the only reachable name from
   another file is the exported alias `_approvals.consume(...)`. Grepping the private
   name alone is a check for something that cannot occur — it passed against a real
   wired consumption before this was corrected. */
ck('CONTROL no mutation consumes an approval yet',
   (function () {
     const dir = path.join(ROOT, 'functions');
     return fs.readdirSync(dir)
       .filter((f) => f.slice(-3) === '.js' && f !== 'pos-staff-ops.js')
       .filter((f) => {
         const src = fs.readFileSync(path.join(dir, f), 'utf8');
         return src.indexOf('_consumeApproval(') > -1 ||
                src.indexOf('_approvals.consume') > -1 ||
                /\.consume\(\s*[A-Za-z_$]/.test(src);
       }).length === 0;
   })(),
   'if this ever fails, the on-screen notice must be revisited — not left stale');
ck('NEGATIVE the client never paints a decision locally',
   CODE.indexOf("status = 'approved'") === -1 && CODE.indexOf('a.status = ') === -1,
   'the outcome is re-read from the server');
ck('CONTROL a decision re-reads from the server',
   CODE.indexOf("_call('reviewApproval'") > -1 &&
   CODE.indexOf('_approvals = await _loadApprovals(uid);') > -1);

/* ── 5 · filters are presentation ─────────────────────────────────────────── */
head('5 · a filter is not an authorisation boundary');
const two = [sale({}), sale({ id: 'S2', servedBy: { uid: 'U2', name: 'Peter', role: 'cashier' } })];
I._set('filters', { emp: 'Jane', status: '', pay: '', q: '' });
ck('filtering by employee narrows the DISPLAY', I.applyFilters(two).length === 1);
I._set('filters', { emp: '', status: '', pay: '', q: '' });
ck('...and clearing it restores every row', I.applyFilters(two).length === 2);
ck('CONTROL the authoritative query is unchanged and still by sellerId',
   CODE.indexOf("m.where('sellerId', '==', uid)") > -1,
   'the served rule plus this query are the boundary — never the dropdown');
ck('CONTROL filtering never touches the query',
   CODE.indexOf('_applyFilters') > -1 &&
   CODE.indexOf('_loadSales') > -1 &&
   !/_loadSales\([^)]*_filters/.test(CODE) &&
   !/where\([^)]*_filters/.test(CODE),
   'no filter value reaches Firestore; it narrows rows already fetched');

/* ── 6 · one authority each, still ────────────────────────────────────────── */
head('6 · no new store, no fifth formula');
ck('employees come from the existing callable', CODE.indexOf("_call('listShopEmployees')") > -1);
ck('shifts use the existing operations',
   CODE.indexOf("_call('openShift'") > -1 && CODE.indexOf("_call('closeShift'") > -1 &&
   CODE.indexOf("_call('getCurrentShift'") > -1);
ck('approvals use the existing callables',
   CODE.indexOf("_call('getPendingApprovals'") > -1 && CODE.indexOf("_call('reviewApproval'") > -1);
ck('sales read the authoritative collection', CODE.indexOf("'posRetailSales'") > -1);
ck('NEGATIVE no new employee store is introduced',
   CODE.indexOf('shopStaff') === -1 && CODE.indexOf('employeeRecords') === -1 &&
   CODE.indexOf('staffMembers') === -1 && CODE.indexOf('workspaceMemberships') === -1 &&
   CODE.indexOf('posStaff') === -1);
ck('NEGATIVE the module still writes nothing',
   CODE.indexOf('setDoc') === -1 && CODE.indexOf('addDoc') === -1 && CODE.indexOf('updateDoc') === -1);
ck('NEGATIVE no variance is computed here',
   !/variance\s*=/.test(CODE), 'five implementations already; a sixth in the UI would be worse');
ck('the shift card still states the id is not server-verified',
   SRC.indexOf('recorded by the till, not verified by the server') > -1);

/* ── 7 · navigation and mobile ────────────────────────────────────────────── */
head('7 · reachable, and usable with one hand');
ck('the control centre is the default tab', CODE.indexOf("_tab = 'overview'") > -1);
ck('every section is reachable as a tab',
   ['overview', 'txn', 'employee', 'staff', 'shift', 'approvals', 'activity']
     .every((t) => CODE.indexOf("['" + t + "'") > -1));
ck('the attention badge is driven by real counts',
   CODE.indexOf('_attention().total') > -1 && CODE.indexOf('badge.hidden = !nAtt') > -1);
ck('...and shows nothing when nothing waits',
   (function () { seedApprovals([]); seedSales([sale({})]); return I.attention().total === 0; })());
ck('...and counts approvals when they exist',
   (function () { seedApprovals([APPROVAL]); return I.attention().approvals === 1; })());
ck('a transaction row opens its detail', CODE.indexOf('data-sale=') > -1 &&
   CODE.indexOf("closest('[data-sale]')") > -1);
ck('tap targets are at least 44px', SRC.indexOf('min-height:44px') > -1 && SRC.indexOf('min-height:48px') > -1);
ck('a narrow screen drops a column rather than scrolling sideways',
   SRC.indexOf('@media(max-width:640px)') > -1);

/* ── 8 · lazy ─────────────────────────────────────────────────────────────── */
head('8 · it still costs nothing to open a till');
ck('pos.html does not load it eagerly', POS.indexOf('src="sokoni-pos-sales.js"') === -1);
ck('it is behind the lazy shim', POS.indexOf('lazyGlobal("PosSalesView"') > -1);
ck('CONTROL the control centre grew, and none of it is in the boot payload',
   SRC.length > 30000 && POS.indexOf('sokoni-pos-sales') === POS.indexOf('lazyGlobal("PosSalesView"') - 12 ||
   POS.indexOf('src="sokoni-pos-sales.js"') === -1,
   SRC.length + ' bytes, loaded on open');

/* ── 8b · the entry point ─────────────────────────────────────────────────────
   THE GAP THIS SUITE COULD NOT SEE. Every assertion above drives the module directly
   through `new Function(...)`, so all of them passed while `PosSalesView.open()` was
   called by NOTHING — not by pos.html, not by merchant-v2, not by anything. 40 KB of
   built control centre, two green suites, and no way for a merchant to open it.

   A harness that instantiates the thing it is testing can never notice that the product
   does not. So this section asserts REACHABILITY, from the shipped launcher, and drives
   the real dispatcher rather than reading it. */
head('8b · it is reachable from the POS launcher');
{
  const POSJS = fs.readFileSync(path.join(ROOT, 'pos.js'), 'utf8');

  ck('the More launcher declares a Sales Control entry',
     /\['[^']*', *'Sales Control', *'action', *'salescontrol'\]/.test(POSJS));
  ck('…as kind ACTION — an in-POS overlay, like the printer menu',
     /'Sales Control', *'action'/.test(POSJS));
  ck('…and the dispatcher handles that target',
     /target === 'salescontrol'/.test(POSJS));
  ck('…by opening the EXISTING module, not a second one',
     /window\.PosSalesView && window\.PosSalesView\.open\(\)/.test(POSJS));
  ck('…guarded, so a module that fails to load cannot throw out of a tap',
     /try \{ window\.PosSalesView && window\.PosSalesView\.open\(\); \} catch \(_\) \{\}/.test(POSJS));

  /* DRIVEN. The real `go` branch, extracted and executed against a spy — a regex proves
     the line exists, not that tapping the card reaches the module. */
  /* BRACE-MATCHED, not sliced on a string search. The first draft cut on the next
     occurrence of '  };' and produced unbalanced source that would not compile — a
     harness that cannot build the thing it drives proves nothing about it. */
  function _body(hay, sig) {
    const at = hay.indexOf(sig);
    if (at < 0) return '';
    let i = hay.indexOf('{', at), depth = 0;
    for (let j = i; j < hay.length; j++) {
      if (hay[j] === '{') depth++;
      else if (hay[j] === '}') { depth--; if (depth === 0) return hay.slice(i + 1, j); }
    }
    return '';
  }
  const goBody = _body(POSJS, '    go(kind, target) {');
  ck('the dispatcher body was located and is balanced',
     goBody.length > 200 && goBody.split('{').length === goBody.split('}').length,
     goBody.length + ' chars');

  let opened = 0, navigated = null, switched = null;
  const win = {
    PosSalesView: { open: () => { opened++; } },
    posToggleFullscreen: () => {},
    openPrinterMenu: () => {},
    location: { set href (v) { navigated = v; }, get href () { return navigated; } },
  };
  const ui = { switchTab: (t) => { switched = t; } };
  const SPos = { deviceHub: { showPanel: () => {} } };
  const go = new Function('window', 'ui', 'SPos',
    'return function (kind, target) {' + goBody + '};')(win, ui, SPos);

  go('action', 'salescontrol');
  ck('tapping the card OPENS the control centre', opened === 1, opened + ' open() calls');
  ck('…and navigates nowhere — it is an overlay, not a page', navigated === null);
  ck('…and switches no tab', switched === null);

  /* COUNTERPROOF: the dispatcher is not simply opening it for everything. */
  go('action', 'printer');
  ck('a DIFFERENT action does not open it', opened === 1, opened + ' after printer');
  go('tab', 'orders');
  ck('…nor does a tab', opened === 1 && switched === 'orders');

  /* The POS surface is otherwise untouched: no twelfth top-level tab was added. */
  ck('no new top-level POS tab was introduced',
     !/data-tab="salescontrol"/.test(POS) &&
     /KNOWN: \['pos', 'orders', 'more', 'inventory', 'reports', 'customers', 'bos', 'finance', 'repair', 'audit', 'settings'\]/.test(POSJS),
     'POS sub-surfaces stay inside the POS app, as the route note requires');
}

/* ── 9 · boundary ─────────────────────────────────────────────────────────── */
head('9 · what this screen does not prove');
un('a manager actually sees a real pending approval', 'needs the deployed callables and a real request');
un('approval gates a refund/void/discount', 'zero mutation call sites — the notice says so on screen');
un('the cashier request path', 'createApprovalRequest is hardened; the till-side UI is a separate slice');
un('shop-wide active shifts', 'no server operation exposes them; rendered Not available');
un('rendering on a real handset', 'browser suite territory, not this static harness');
un('a merchant has actually opened it in production', 'nothing is deployed; 8b proves the WIRING, not a visit');

console.log(NL + '  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
console.log('  NOTE: view logic only. No live read, and no claim of enforcement.');
process.exit(fail ? 1 : 0);
