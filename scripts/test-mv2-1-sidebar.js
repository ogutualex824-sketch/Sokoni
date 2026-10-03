#!/usr/bin/env node
/* test-mv2-1-sidebar.js — MV2-1: sidebar exposure + shell cleanup (no new authority).
 *   R  registry: 'sales-control' is a validated pos route (tab 'pos' + action 'salescontrol'),
 *      sits in the Sales group, the more-tier partition still holds, validate() is clean
 *   S  shell composes pos.html#salescontrol for it and re-targets the cached POS frame by hash
 *   P  pos.js opens the Sales Control overlay from #salescontrol on boot and on hashchange —
 *      EXECUTED: the boot/hash block runs in a VM with a stub PosSalesView
 *   V  returns.html carries no SOKONI logo block; KRA setup states "Ready — credentials required"
 *      and never fabricates a state
 *   N  negative control: removing the action from the registry makes S fail
 *   node scripts/test-mv2-1-sidebar.js
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ck = (l, ok, got) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok ? '' : '   [got ' + JSON.stringify(got) + ']')); ok ? pass++ : fail++; };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/* ── R: the registry, executed ── */
const w = { window: null, document: { readyState: 'complete', addEventListener() {} }, location: { search: '', hash: '', pathname: '/merchant' }, console };
w.window = w;
const ctx = vm.createContext(w);
vm.runInContext(read('sokoni-merchant-routes.js'), ctx, { filename: 'sokoni-merchant-routes.js' });
const C = ctx.SokoniMerchantRoutes || ctx.window.SokoniMerchantRoutes || ctx.MerchantRoutes;
ck('R0  registry loads', !!C && Array.isArray(C.ROUTES), Object.keys(ctx).filter((k) => /Route/i.test(k)));
const r = C.ROUTES.find((x) => x.id === 'sales-control');
ck('R1  sales-control route: kind pos, tab pos (a REAL tab), action salescontrol, tier more', !!r && r.kind === 'pos' && r.tab === 'pos' && r.action === 'salescontrol' && r.tier === 'more', r);
const errs = typeof C.validate === 'function' ? C.validate() : ['no validate'];
ck('R2  validate() is clean with the new route (partition + kinds + tab + action)', Array.isArray(errs) && errs.length === 0, errs);
const groups = C.MORE_GROUPS || [];
const sales = groups.find((g) => g.key === 'sales');
ck('R3  Sales group exists and holds sales-control; headings are Sales / Operations / Commerce / Growth / Back office / Construction (Commerce added by MV2-2a, Construction appended last 2026-10-03)', !!sales && sales.ids.includes('sales-control') && groups.map((g) => g.label).join('|') === 'Sales|Operations|Commerce|Growth|Back office|Construction', groups.map((g) => g.label));
const more = C.ROUTES.filter((x) => x.tier === 'more').map((x) => x.id).sort();
const grouped = groups.flatMap((g) => g.ids).sort();
ck('R4  every more-tier route is in exactly one group and vice versa', JSON.stringify(more) === JSON.stringify(grouped), { more, grouped });

/* ── S: the shell composes the hash ── */
const shell = read('merchant-v2.html');
ck('S1  shell: pos-kind route lands at its action (#salescontrol) or its tab, on the ONE cached POS frame', /var _posView = m\.action \|\| \(m\.tab && m\.tab !== 'pos' \? m\.tab : ''\);/.test(shell) && /framePanel\('pos', 'pos\.html' \+ \(_posView \? '#' \+ _posView : ''\), m\.name\)/.test(shell) && /_pf\.contentWindow\.location\.hash = _want/.test(shell), null);
ck('S2  shell: no second POS iframe is created for the entry (same panel key "pos")', (shell.match(/framePanel\('pos',/g) || []).length === 1, (shell.match(/framePanel\('pos',/g) || []).length);

/* ── P: pos.js boot + hash handling, executed in a VM ── */
const pos = read('pos.js');
const b0 = pos.indexOf("const consumeSalesControlHash = () =>"), b1 = pos.indexOf("else if (boot && nav.KNOWN.includes(boot) && boot !== 'pos') ui.switchTab(boot, { fromHistory: true });");
ck('P0  pos.js carries the salescontrol deep-link block', b0 > 0 && b1 > b0, { b0, b1 });
const block = pos.slice(b0, b1 + "else if (boot && nav.KNOWN.includes(boot) && boot !== 'pos') ui.switchTab(boot, { fromHistory: true });".length);
function runBoot(hash) {
  const calls = { opened: 0, switched: [], listeners: {} };
  const env = { window: { PosSalesView: { open() { calls.opened++; } }, addEventListener(t, fn) { calls.listeners[t] = fn; } }, location: { hash }, nav: { KNOWN: ['pos', 'orders', 'more'] }, ui: { switchTab(t) { calls.switched.push(t); } }, setTimeout(fn) { fn(); }, console };
  vm.runInContext('(function(){ const window = this.window, location = this.location, nav = this.nav, ui = this.ui, setTimeout = this.setTimeout;\n' + block + '\n this.__l = window; }).call(this)', vm.createContext(env));
  return calls;
}
let c = runBoot('#salescontrol');
ck('P1  boot with #salescontrol opens the Sales Control overlay (PosSalesView.open) and switches no tab', c.opened === 1 && c.switched.length === 0, c);
c = runBoot('#orders');
ck('P2  boot with a real tab still switches the tab and opens no overlay', c.opened === 0 && c.switched[0] === 'orders', c);
const cc = { opened: 0 };
const env2 = { window: { PosSalesView: { open() { cc.opened++; } }, addEventListener(t, fn) { if (t === 'hashchange') env2.__h = fn; if (t === 'popstate') env2.__p = fn; } }, location: { hash: '' }, nav: { KNOWN: ['pos'] }, ui: { switchTab() {} }, setTimeout(fn) { fn(); }, console };
vm.runInContext('(function(){ const window = this.window, location = this.location, nav = this.nav, ui = this.ui, setTimeout = this.setTimeout;\n' + block + '\n }).call(this)', vm.createContext(env2));
/* 2026-10-01: P3 used to require that a POPSTATE onto #salescontrol opens the overlay too.
   That was the defect the owner hit ("minus / Remove sends me to Sales Control"): a back
   step inside the POS reopened it. Contract now: the shell's re-target (hashchange) opens it
   once; a back/forward step never does. Full sequence: scripts/test-salescontrol-hash-once.js. */
env2.location.hash = '#salescontrol'; env2.__h && env2.__h();
const afterHashchange = cc.opened;
env2.location.hash = '#salescontrol'; env2.__p && env2.__p();
ck('P3  the shell\'s hash change to #salescontrol opens the overlay once; a popstate onto #salescontrol does NOT reopen it', afterHashchange === 1 && cc.opened === 1, { afterHashchange, total: cc.opened });

/* ── V: cleanup + KRA copy ── */
const ret = read('returns.html');
ck('V1  returns.html: no SOKONI logo image in its top bar (the orphan CSS rule is inert)', !/<img class="tb-logo"/.test(ret) && !/sokoni-logo-dark\.png/.test(ret) && /<div class="tb-title">Returns &amp; Refunds<\/div>/.test(ret), null);
const tax = read('sokoni-merchant-tax-ui.js');
ck('V2  KRA setup states "Ready — credentials required" as the server\'s precondition; no fabricated PIN/token/receipt strings', /KRA status: Ready — credentials required/.test(tax) && /is submitted or simulated/.test(tax) && !/OSCU token|simulated receipt|demo PIN/i.test(tax), null);

/* ── N: negative control ── */
const sab = read('sokoni-merchant-routes.js').replace("kind:'pos', tab:'pos', action:'salescontrol',", "kind:'pos', tab:'pos',");
const ctx2 = vm.createContext({ window: null, document: { readyState: 'complete', addEventListener() {} }, location: { search: '', hash: '', pathname: '/merchant' }, console });
ctx2.window = ctx2;
vm.runInContext(sab, ctx2, { filename: 'sab.js' });
const C2 = ctx2.SokoniMerchantRoutes || ctx2.window.SokoniMerchantRoutes;
const r2 = C2 && C2.ROUTES.find((x) => x.id === 'sales-control');
ck('N1  negative control: without the action the entry would land on plain #pos (R1 turns red)', !!r2 && !r2.action, r2 && r2.action);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
