#!/usr/bin/env node
/* Admin OS wiring — structural integrity of admin-os.html + sokoni-aos.js.
 *
 *   node scripts/test-admin-os-wiring.js
 *
 * WHY THIS EXISTS
 * Admin OS is assembled from four pieces that are edited independently and fail
 * silently when they drift apart:
 *
 *   admin-os.html   nav item  →  data-section="x"
 *   admin-os.html   pane      →  id="panel-x"
 *   sokoni-aos.js   loader    →  x: () => _loadX()
 *   functions/      handler   →  adminOsDispatch op, or a standalone callable
 *
 * A nav item with no pane navigates to a blank screen. A pane with no loader
 * shows its spinner forever. An op that is neither in the dispatch whitelist nor
 * deployed as its own callable throws at runtime — and because every _call site
 * in this file has a `.catch(() => ({}))`, it throws into an empty list that
 * renders as "No products", which is indistinguishable from a real empty
 * marketplace. That is the failure mode this suite exists to make impossible to
 * ship: an empty screen that means "the read failed", not "there is nothing".
 *
 * A grep for the CALLABLE NAME is not a valid check for the last one. 45 of the
 * ops this file calls are not deployed under their own names at all — they ride
 * adminOsDispatch and are addressed by an op STRING. Checking names alone
 * reports 45 false alarms; checking the whitelist alone misses the ops that must
 * be standalone. Both halves are required, and this suite asserts both.
 *
 * Static only: no credentials, no network, no emulator.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'admin-os.html'), 'utf8');
const AOS = fs.readFileSync(path.join(ROOT, 'sokoni-aos.js'), 'utf8');
const ADMIN_OS_FN = fs.readFileSync(path.join(ROOT, 'functions', 'admin-os.js'), 'utf8');
const INDEX_FN = fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8');

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail !== undefined && detail !== '' ? '   [' + String(detail).slice(0, 160) + ']' : ''));
  ok ? pass++ : fail++;
};

/* ── Extract the four sides ──────────────────────────────────────────────── */

const navSections = [...new Set([...HTML.matchAll(/data-section="([a-zA-Z0-9_-]+)"/g)].map((m) => m[1]))];
const panes = [...new Set([...HTML.matchAll(/id="panel-([a-zA-Z0-9_-]+)"/g)].map((m) => m[1]))];

/* Loader keys from the `loaders` map inside _loadPanel. Read the object body by
   brace matching so a key added on a shared line is still seen. */
function loaderKeys() {
  const anchor = AOS.indexOf('const loaders = {');
  if (anchor === -1) return null;
  const open = AOS.indexOf('{', anchor);
  let depth = 0, end = -1;
  for (let i = open; i < AOS.length; i++) {
    if (AOS[i] === '{') depth++;
    else if (AOS[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return null;
  const body = AOS.slice(open, end + 1);
  return [...new Set([...body.matchAll(/(?:^|[{,\s])([a-zA-Z0-9_]+)\s*:/g)].map((m) => m[1]))];
}

/* The ops whitelist that routes through adminOsDispatch. */
function dispatchOps() {
  const m = AOS.match(/_ADMIN_OS_OPS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
  if (!m) return null;
  return [...new Set((m[1].match(/'[A-Za-z0-9_]+'/g) || []).map((s) => s.replace(/'/g, '')))];
}

/* Every op this client actually calls. */
const calledOps = [...new Set([...AOS.matchAll(/_call\(\s*"([A-Za-z0-9_]+)"/g)].map((m) => m[1]))].sort();

/* Server-side handler registry consumed by admin-os-dispatch.js. */
const handlers = new Set([...ADMIN_OS_FN.matchAll(/exports\._h\.([A-Za-z0-9_]+)\s*=/g)].map((m) => m[1]));

/* Standalone callables, i.e. anything index.js exports under its own name. */
const standalone = new Set([...INDEX_FN.matchAll(/^exports\.([A-Za-z0-9_]+)\s*=/gm)].map((m) => m[1]));

/* The AOS public API — the object literal returned by the IIFE. */
function publicApi() {
  const anchor = AOS.lastIndexOf('\n  return {');
  if (anchor === -1) return null;
  const open = AOS.indexOf('{', anchor);
  let depth = 0, end = -1;
  for (let i = open; i < AOS.length; i++) {
    if (AOS[i] === '{') depth++;
    else if (AOS[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return null;
  /* Strip string literals before looking for keys: an inline arrow value such as
     `prompt("Question:")` contains a colon that would otherwise read as a key
     and make this set over-permissive — which would let a genuinely missing
     export slip through PART F. */
  const body = AOS.slice(open, end + 1)
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
  const named = [...body.matchAll(/(?:^|[{,\s])([a-zA-Z0-9_]+)\s*:/g)].map((m) => m[1]);
  const shorthand = [...body.matchAll(/(?:^|[{,])\s*([a-zA-Z0-9_]+)\s*(?=[,}])/g)].map((m) => m[1]);
  return new Set([...named, ...shorthand]);
}

const LOADERS = loaderKeys();
const OPS = dispatchOps();
const API = publicApi();

console.log('\nPART A — the extractors can see (a detector that reads nothing passes everything)\n');
ck('A1  nav sections found', navSections.length > 5, navSections.length);
ck('A2  panes found', panes.length > 5, panes.length);
ck('A3  loader map parsed', !!LOADERS && LOADERS.length > 5, LOADERS ? LOADERS.length : 'PARSE FAILED');
ck('A4  dispatch whitelist parsed', !!OPS && OPS.length > 5, OPS ? OPS.length : 'PARSE FAILED');
ck('A5  called ops found', calledOps.length > 5, calledOps.length);
ck('A6  server _h registry found', handlers.size > 5, handlers.size);
ck('A7  standalone callables found', standalone.size > 100, standalone.size);
ck('A8  AOS public API parsed', !!API && API.size > 5, API ? API.size : 'PARSE FAILED');

/* Nothing below is meaningful if an extractor returned nothing. */
if (!LOADERS || !OPS || !API) {
  console.log('\nEXTRACTOR FAILED — refusing to report structural results that would be vacuous.\n');
  process.exit(1);
}

console.log('\nPART B — every nav item reaches a pane, and every pane is reachable\n');

for (const s of navSections) {
  ck(`B1  nav "${s}" has a pane #panel-${s}`, panes.includes(s), panes.includes(s) ? '' : 'navigates to a blank screen');
}
for (const p of panes) {
  ck(`B2  pane #panel-${p} has a nav item`, navSections.includes(p), navSections.includes(p) ? '' : 'unreachable pane');
}

console.log('\nPART C — every pane loads its own data\n');

for (const s of navSections) {
  ck(`C1  section "${s}" has a loader`, LOADERS.includes(s),
    LOADERS.includes(s) ? '' : 'the pane will sit on its spinner forever');
}

console.log('\nPART D — every op the client calls can actually resolve\n');

{
  /* THE COVERAGE CHECK. Everything else in PART D reads op names statically, so
     a call site that computes its op — `_call(x ? "a" : "b", …)` — is invisible
     and its ops are silently never checked. A dynamic site does not fail any
     assertion; it removes assertions, which is worse. So the rule is: the op is
     always a literal. (Caught here for real on 2026-09-07: a conditional op in
     _estateTab meant adminGetShops/adminGetSellers were never checked at all,
     and deleting one from the whitelist still passed the suite.) */
  const sites = [...AOS.matchAll(/_call\(/g)].map((m) => m.index);
  const dynamic = sites.filter((i) => {
    const head = AOS.slice(i, i + 40);
    if (/^_call\(name\b/.test(head)) return false;             /* the definition itself */
    return !/^_call\(\s*"/.test(head);
  }).map((i) => AOS.slice(0, i).split('\n').length);
  ck('D0  every _call site names its op as a string literal (so this suite can see it)',
    dynamic.length === 0,
    dynamic.length ? 'dynamic op at line(s) ' + dynamic.join(', ') + ' — those ops are UNCHECKED' : sites.length + ' sites');
}

/* ── The unreachable baseline ───────────────────────────────────────────────
   These ops are called by sokoni-aos.js and have NO backend at all: not in the
   dispatch whitelist, not exported by functions/index.js. Every one of them
   throws, is swallowed by the call site's `.catch(() => ({}))`, and renders as
   an empty state — so the Marketing, Cohort/Funnel/Retention, Wallet Ops and
   Escrow views tell an operator "there is nothing here" when the truth is "this
   was never built". Discovered 2026-09-07 while wiring the merchant chain; NOT
   introduced by it.

   This is a FIXED baseline, not a diff against HEAD. The suite fails if an op
   joins it (a new dead call site) and fails if an op is fixed and left in it
   (so the list can only shrink). Fixing one means implementing the handler or
   deleting the dead pane — never adding a line here. */
const KNOWN_UNREACHABLE = [
  'adminCreateCampaign', 'adminDeleteCampaign', 'adminGetCampaigns', 'adminUpdateCampaignStatus',
  'adminSendEmailBlast', 'adminSendSMSBlast',
  'adminGetCohortAnalysis', 'adminGetConversionFunnel', 'adminGetRetentionMetrics',
  'adminGetWalletOperations', 'finosGetEscrowAccounts',
];

const unreachable = [];
for (const op of calledOps) {
  const viaDispatch = OPS.includes(op);
  const viaOwnCallable = standalone.has(op);
  const ok = viaDispatch || viaOwnCallable;
  if (!ok) unreachable.push(op);
  if (ok || !KNOWN_UNREACHABLE.includes(op)) {
    ck(`D1  ${op} is reachable`, ok,
      ok ? (viaDispatch ? 'adminOsDispatch' : 'own callable')
        : 'NEITHER whitelisted for adminOsDispatch NOR exported by functions/index.js — throws at runtime');
  }
  if (viaDispatch) {
    ck(`D2  ${op} has a server handler in _h`, handlers.has(op),
      handlers.has(op) ? '' : 'adminOsDispatch answers not-found');
  }
}

{
  const newlyBroken = unreachable.filter((o) => !KNOWN_UNREACHABLE.includes(o));
  const fixed = KNOWN_UNREACHABLE.filter((o) => !unreachable.includes(o));
  ck('D3  no NEW unreachable op has been introduced', newlyBroken.length === 0, newlyBroken.join(', '));
  ck('D4  every op still in the baseline is still genuinely unreachable', fixed.length === 0,
    fixed.length ? 'now reachable — remove from KNOWN_UNREACHABLE: ' + fixed.join(', ') : '');
  console.log(`  NOTE  ${unreachable.length} op(s) have no backend and render as empty states (tracked baseline): ${unreachable.join(', ')}`);
}

console.log('\nPART E — the whitelist has no dead entries\n');

for (const op of OPS) {
  ck(`E1  whitelisted ${op} has a handler`, handlers.has(op),
    handlers.has(op) ? '' : 'whitelisted but not implemented');
}

console.log('\nPART F — every inline handler in the page exists on the public API\n');

/* 2026-09-29: AdminOS's disputes tab and reports queue are the SHARED trust queue (sokoni-trust-queues.js, also
   mounted by super admin). Its calls leave sokoni-aos.js, so the D1/D2 scan above no longer sees them — the same
   reachability is asserted here for the module: every adminOsDispatch op it names has an _h handler, and every
   callable it names directly is exported by index.js. */
{
  const TQ = fs.readFileSync(path.join(ROOT, 'sokoni-trust-queues.js'), 'utf8');
  /* every op the module names, minus the ones it sends to messagesDispatch (conversation reports) */
  const msgOps = new Set([...TQ.matchAll(/call\('messagesDispatch', \{ op: '([A-Za-z0-9_]+)'/g)].map((m) => m[1]));
  const tqOps = [...new Set([...TQ.matchAll(/op: '([A-Za-z0-9_]+)'/g)].map((m) => m[1]))].filter((o) => !msgOps.has(o)).sort();
  const tqDirect = [...new Set([...TQ.matchAll(/call\('([A-Za-z0-9_]+)'/g)].map((m) => m[1]))].filter((n) => !/Dispatch$/.test(n)).sort();
  ck('TQ0 control — the trust queue names its dispute ops and report callables', tqOps.length >= 3 && tqDirect.length >= 2, { tqOps, tqDirect });
  for (const op of tqOps) ck(`TQ1 ${op} (trust queue) has a server handler in _h`, handlers.has(op), handlers.has(op) ? '' : 'adminOsDispatch answers not-found');
  for (const fn of tqDirect) ck(`TQ2 ${fn} (trust queue) is exported by functions/index.js`, standalone.has(fn));
  ck('TQ3 admin-os.html loads the trust queue', /<script src="sokoni-trust-queues\.js"><\/script>/.test(HTML));
}

const invoked = [...new Set([...HTML.matchAll(/SokoniAOS\.([a-zA-Z0-9_]+)\s*\(/g)].map((m) => m[1]))].sort();
ck('F0  inline SokoniAOS.* calls found', invoked.length > 5, invoked.length);
for (const fnName of invoked) {
  ck(`F1  SokoniAOS.${fnName} is exported`, API.has(fnName),
    API.has(fnName) ? '' : 'the button throws TypeError on click');
}

console.log('\nPART G — adversarial controls: each detector must REJECT a broken input\n');

{
  /* If these pass trivially, every check above proves only that a regex ran. */
  const fakeNav = ['dashboard', 'ghostpane'];
  ck('G1  pane detector rejects a nav item with no pane', !panes.includes(fakeNav[1]));

  const fakeLoaders = LOADERS.filter((k) => k !== 'dashboard');
  ck('G2  loader detector rejects a section with no loader', !fakeLoaders.includes('dashboard'));

  const fakeOp = 'adminGetThisDoesNotExist';
  ck('G3  op detector rejects an op that is neither dispatched nor deployed',
    !OPS.includes(fakeOp) && !standalone.has(fakeOp));

  ck('G4  handler detector rejects a whitelisted op with no _h entry',
    !handlers.has('adminHandlerThatWasNeverWritten'));

  ck('G5  API detector rejects a button calling a method that is not exported',
    !API.has('methodThatWasNeverExported'));

  /* The specific false-alarm this suite was built to avoid: an op that IS
     dispatched must NOT be reported missing merely because no function is
     deployed under its own name. */
  const dispatched = OPS.find((o) => !standalone.has(o));
  ck('G6  a dispatched-only op is NOT reported as unreachable',
    dispatched ? (OPS.includes(dispatched) && !standalone.has(dispatched)) : true,
    dispatched ? dispatched + ' rides adminOsDispatch' : 'no dispatch-only op to test');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
