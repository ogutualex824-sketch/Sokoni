#!/usr/bin/env node
'use strict';
/* Finance Center (owner 2026-10-04): every financial record view in AdminOS + Super Admin in one layout — KPI tiles,
   status tabs, aging, records table with status pills, detail drawer. Executes the REAL module in a vm with a minimal DOM,
   and checks both pages statically against live 72dca56 (same callables, same actions, no invented figures).
   The rendered browser check is OWED (>= 512 MB free). */
const fs = require('fs'), path = require('path'), vm = require('vm'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + String(got).slice(0, 200) + ']')); ok ? pass++ : fail++; };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const live = (f) => execSync('git show 72dca56:' + f, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });

/* ── the module, executed ── */
const listeners = {};
const doc = { addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); }, querySelectorAll: () => [], querySelector: () => null,
  createElement: () => ({ classList: { add() {}, remove() {}, contains: () => false }, setAttribute() {}, addEventListener() {}, querySelector: () => null, innerHTML: '' }), body: { appendChild() {} } };
const ctx = { window: {}, document: doc, console };
vm.createContext(ctx); vm.runInContext(read('sokoni-finance-center.js'), ctx);
const F = ctx.window.SokoniFinanceCenter;
ck('M-1', !!F && ['kpis', 'table', 'tabs', 'aging', 'header', 'open', 'kes', 'pill', 'ageBuckets'].every((k) => typeof F[k] === 'function'), 'the module exposes its building blocks');
ck('M-2', F.kes(undefined) === '—' && F.kes(null) === '—' && F.kes(NaN) === '—' && F.kes(0) === 'KES 0' && F.kes(1250.4) === 'KES 1,250', 'UNKNOWN money renders "—", never 0; a real 0 stays 0', [F.kes(undefined), F.kes(0)]);
const k = F.kpis([{ label: 'Revenue', value: F.kes(undefined) }, { label: 'Fees', value: F.kes(500) }]);
ck('M-3', /sfc-kpi-v unknown">—</.test(k) && /KES 500/.test(k) && !/>0</.test(k), 'a KPI the server did not return shows — (dimmed), not 0', k);
const t = F.table({ title: 'x', rows: [{ a: '<img src=x onerror=alert(1)>', amount: 100 }, { a: 'b', amount: 200 }], columns: [{ label: 'A', render: (r) => F.esc(r.a) }, { label: 'Amt', align: 'r', render: (r) => F.kes(r.amount) }] });
ck('M-4', !/<img/.test(t) && /&lt;img/.test(t), 'record text is escaped (no script injection from a record field)');
ck('M-5', /2 in this list/.test(t) && !/KES 300/.test(t), 'the table states ROW COUNT only — it never sums rows into an invented total', t.slice(0, 120));
ck('M-6', !/onclick=/.test(read('sokoni-finance-center.js').replace(/\/\*[\s\S]*?\*\//g, '')), 'no inline onclick built from record data — actions are real functions via one delegated handler');
const ag = F.ageBuckets([{ d: Date.now() - 2 * 864e5 }, { d: Date.now() - 20 * 864e5 }, { d: null }], (r) => r.d);
ck('M-7', ag.known === 2 && ag.buckets[0].value === '1 request' && ag.buckets[1].value === '1 request' && !/KES/.test(JSON.stringify(ag)), 'aging counts dated requests only (no money totals over a partial list)', JSON.stringify(ag));
ck('M-8', F.pill('complete').indexOf('green') > 0 && F.pill('failed').indexOf('red') > 0 && F.pill('<b>').indexOf('<b>') < 0, 'status pills are toned and escaped');

/* ── AdminOS ── */
const AOS = read('sokoni-aos.js'), AOS0 = live('sokoni-aos.js'), HTML = read('admin-os.html');
const CALLS = ['getAdminRevenueReport', 'getCommissionLedger', 'aosGetPendingPayouts', 'adminGetDisputes', 'adminGetWalletOperations', 'finosGetEscrowAccounts', 'adminGetFinance', 'adminGetExecutiveDashboard', 'adminGetPayments'];
ck('A-1', CALLS.every((c) => AOS0.includes('"' + c + '"') && AOS.includes('"' + c + '"')), 'AdminOS uses the SAME server calls as live (no new data source)', CALLS.filter((c) => !AOS.includes('"' + c + '"')).join(','));
const ACTS = ['markCommPaid', 'approvePayout', 'rejectPayout', 'approveAllPayouts', 'resolveDispute', 'processRefund', 'releaseEscrow', 'exportFinancialReport'];
ck('A-2', ACTS.every((a) => new RegExp('A\\.' + a + '\\(').test(AOS)), 'every existing financial action is still offered (wired from the drawer to the same SokoniAOS function)', ACTS.filter((a) => !new RegExp('A\\.' + a + '\\(').test(AOS)).join(','));
const finBlock = AOS.slice(AOS.indexOf('async function _financialTab('), AOS.indexOf('async function releaseEscrow('));
ck('A-3', !/_fmt\([^)]*\|\|\s*0\)/.test(finBlock) && !/_fmt\([^)]*\|\|\s*0\)/.test(AOS.slice(AOS.indexOf('async function _loadPayments('), AOS.indexOf('// ── Delivery'))),
  'the financial views no longer render an unknown as 0 (the old _fmt(x||0) is gone from them)');
ck('A-4', /refundRequests/.test(finBlock) && !/finosRequestBankPayout|requestSellerPayout|creditWallet/.test(finBlock), 'no NEW money-moving call was added to the financial views');
ck('A-5', /id="finBody" class="sfc"/.test(HTML) && /id="paymentsBody" class="sfc"/.test(HTML) && HTML.indexOf('sokoni-finance-center.js') > 0 && HTML.indexOf('sokoni-finance-center.js') < HTML.indexOf('sokoni-aos.js"'),
  'admin-os.html mounts the Finance Center in Financial + Payments and loads the module before sokoni-aos.js');
ck('A-6', /Receipts/.test(finBlock) && /no administrator listing endpoint/.test(finBlock), 'Receipts: no admin listing endpoint exists — stated honestly, nothing invented');
const nav = (h) => h.slice(h.indexOf('<aside class="aos-sidebar"'), h.indexOf('</aside>'));
const B2_NAV = /\n[ ]*<button class="nav-item" data-section="(integrations|revenue)"[^>]*>(?:(?!<\/button>)[\s\S])*<\/button>/g;   /* b2 2026-10-04: Integrations + Revenue Intelligence entries */
ck('A-7', nav(HTML).replace(/\r/g, '').replace(B2_NAV, '') === nav(live('admin-os.html')).replace(/\r/g, '') && (nav(HTML).match(B2_NAV) || []).length === 2, 'the AdminOS sidebar markup is live + exactly the two b2 entries (Integrations, Revenue Intelligence)');

/* ── Super Admin ── */
const SA = read('super-admin.html'), SA0 = live('super-admin.html');
ck('S-1', !/\[12,18,22,15,28,35,30,42,38,50,45,60,55,70\]/.test(SA) && /\[12,18,22,15,28,35,30,42,38,50,45,60,55,70\]/.test(SA0) && /No daily revenue data yet/.test(SA),
  'THE FAKE CHART IS GONE: live drew a hard-coded revenue pattern when data was missing; now an honest empty state');
ck('S-2', ['getMerchantFinancials', 'adminGetPendingPayouts', 'adminPayoutOps'].every((c) => SA.includes("'" + c + "'")), 'Super Admin uses the same server calls as live');
ck('S-3', (SA.match(/SA\.processPayout\(/g) || []).length >= 5 && /'approve'/.test(SA) && /'paid'/.test(SA) && /'reject'/.test(SA), 'the existing payout actions (approve / mark paid / reject) are still offered');
ck('S-4', ['saFinancialKpis', 'saRevenueChartBars', 'saPayoutOps', 'saPayoutsList', 'saCommissionRates'].every((id) => SA.includes('id="' + id + '"')), 'every element id other code relies on still exists');
ck('S-5', SA.indexOf('sokoni-finance-center.css') > 0 && SA.indexOf('sokoni-finance-center.js') > 0, 'super-admin.html loads the Finance Center');
const navS = (h) => h.slice(h.indexOf('<aside class="sa-sidebar"'), h.indexOf('</aside>'));
ck('S-6', navS(SA).replace(/\r/g, '').replace(B2_NAV, '') === navS(SA0).replace(/\r/g, '') && (navS(SA).match(B2_NAV) || []).length === 2, 'the Super Admin sidebar markup is live + exactly the two b2 entries');
ck('S-7', (() => { const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g; let m; while ((m = re.exec(SA))) { try { new Function(m[1]); } catch (e) { return false; } } return true; })(), 'super-admin.html inline script compiles');
/* S-8 EXECUTED: the real _renderRevenueChart with missing / short data draws NO bars */
{
  const a = SA.indexOf('  _renderRevenueChart(data){'); const b = SA.indexOf('\n  },', a);
  const fnSrc = SA.slice(a + '  _renderRevenueChart'.length, b + 4);   /* "(data){ … }" — b points at "
  }," */
  const els = { saRevenueChartBars: { innerHTML: '' }, saRevenueChartNote: { textContent: '' } };
  const sandbox = { document: { getElementById: (id) => els[id] || null }, _esc: (s) => String(s), _fmtMoney: (n) => 'KES ' + n, Date };
  vm.createContext(sandbox);
  let ok = a > 0;
  try {
    const m = vm.runInContext('({ _renderRevenueChart' + fnSrc + ' })', sandbox);
    for (const data of [null, [], [100, 200], Array(14).fill(null)]) { els.saRevenueChartBars.innerHTML = ''; m._renderRevenueChart(data); if (/bar-chart-bar/.test(els.saRevenueChartBars.innerHTML) || !/No daily revenue data yet/.test(els.saRevenueChartBars.innerHTML)) ok = false; }
    els.saRevenueChartBars.innerHTML = ''; m._renderRevenueChart(Array.from({ length: 14 }, (_, i) => (i + 1) * 1000));
    if (!/bar-chart-bar/.test(els.saRevenueChartBars.innerHTML)) ok = false;   /* control: real data still draws */
  } catch (e) { ok = false; }
  ck('S-8', ok, 'EXECUTED: with missing or short data the chart draws NO bars (empty state); with 14 real values it draws them');
}
console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed  (rendered check OWED: browser at >= 512 MB)');
process.exit(fail ? 1 : 0);
