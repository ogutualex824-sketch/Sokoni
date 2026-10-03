#!/usr/bin/env node
/* FOOD HUB S1 — food businesses enter through the SERVER's workspace answer, never the old Restaurant Portal (owner
 * 2026-10-03). The REAL sokoni-food-entry.js is EXECUTED in a vm against every answer providerDispatch {op:
 * 'businessWorkspace'} can give; the pages are checked by source.
 *   node scripts/test-food-s1-entry.js           BASE=2e5e33b node scripts/test-food-s1-entry.js (must FAIL) */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const read = (f) => { try { return process.env.BASE ? execSync('git show ' + process.env.BASE + ':' + f, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['pipe', 'pipe', 'ignore'] }) : fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { return ''; } };
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 180) + ']')); ok ? pass++ : fail++; };
console.log('\nFood Hub S1 entry   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');

const SRC = read('sokoni-food-entry.js');
function env(opts) {
  const nav = []; const notices = []; const calls = []; const reg = [];
  const body = { appendChild(el) { notices.push(el.innerHTML || ''); }, };
  const doc = { readyState: 'complete', body, addEventListener() {}, getElementById: () => null,
    createElement: () => ({ style: {}, setAttribute() {}, addEventListener() {}, querySelector: () => null, innerHTML: '' }) };
  const ctx = { console: { log() {}, warn() {} }, Promise, String, Object, encodeURIComponent, setTimeout: () => 0, document: doc,
    window: null, location: null };
  ctx.window = ctx;
  ctx.location = { hash: opts.hash || '', pathname: '/services.html', assign: (u) => nav.push(u), replace: (u) => nav.push(u) };
  ctx.firebaseAuth = opts.user === null ? { currentUser: null, onAuthStateChanged: (cb) => { cb(null); return () => {}; } } : { currentUser: { uid: 'u1' } };
  if (!opts.noCallable) ctx.sokoniCallable = (name) => async (data) => { calls.push([name, data]); if (opts.throws) throw new Error('unavailable'); return { data: opts.answer }; };
  ctx.HubRegister = { open: (o) => reg.push(o) };
  vm.createContext(ctx);
  try { vm.runInContext(SRC, ctx); } catch (e) { return { err: e.message, nav, notices, calls, reg }; }
  return { ctx, nav, notices, calls, reg };
}
async function run(opts) { const e = env(opts); if (e.err || !e.ctx.SokoniFoodEntry) return Object.assign(e, { action: 'NO_MODULE' }); const action = await e.ctx.SokoniFoodEntry.open(); return Object.assign(e, { action }); }

(async () => {
  let r = await run({ user: null });
  ck('E-1', r.action === 'signin' && /^\/login\?next=/.test(r.nav[0] || '') && r.calls.length === 0, 'signed out → sign in first (no server call, no workspace)', { a: r.action, nav: r.nav });
  r = await run({ answer: { found: true, route: 'merchant-v2.html', state: 'AVAILABLE', category: 'restaurant', serviceCapabilities: ['FOOD_MENU'] } });
  ck('E-2', r.action === 'merchant' && r.nav[0] === '/merchant-v2' && r.calls[0] && r.calls[0][0] === 'providerDispatch' && r.calls[0][1].op === 'businessWorkspace',
    'an APPROVED food business (server route merchant-v2, AVAILABLE) → /merchant-v2, decided by providerDispatch businessWorkspace', { a: r.action, nav: r.nav, calls: r.calls });
  r = await run({ answer: { found: true, route: null, state: 'PENDING_APPROVAL', reason: 'NOT_APPROVED', message: 'Your application is with SOKONI for review.' } });
  ck('E-3', r.action === 'held' && r.nav.length === 0 && /with SOKONI for review/.test(r.notices.join()), 'an APPLICANT (pending) gets the application status — no workspace', { a: r.action, nav: r.nav });
  r = await run({ answer: { found: true, route: 'complete-application.html', state: 'REAPPLICATION_REQUIRED' } });
  ck('E-4', r.action === 'reapply' && r.nav[0] === '/complete-application.html', 'a record needing re-application → the page the SERVER names');
  r = await run({ answer: { found: false, route: null, state: 'PENDING_APPROVAL', reason: 'NO_APPROVED_BUSINESS' } });
  ck('E-5', r.action === 'apply' && r.reg[0] && r.reg[0].hub === 'food' && r.nav.length === 0, 'no business on SOKONI → the food business application (no workspace)', { a: r.action, reg: r.reg });
  r = await run({ answer: { found: true, route: 'provider-dashboard.html', state: 'AVAILABLE', label: 'Trades & repairs' } });
  ck('E-6', r.action === 'other-workspace' && r.nav.length === 0 && /provider-dashboard\.html/.test(r.notices.join()), 'another kind of approved business is told where ITS workspace is — never sent into a food workspace');
  r = await run({ answer: { found: true, route: null, state: 'CAPABILITY_CONFLICT', reason: 'CATEGORY_CAPABILITY_DISAGREEMENT' } });
  ck('E-7', r.action === 'held' && r.nav.length === 0, 'conflict / unclassified / suspended → the server\'s explanation, no route');
  r = await run({ throws: true });
  ck('E-8', r.action === 'error' && r.nav.length === 0 && /Could not reach SOKONI/.test(r.notices.join()), 'the call fails → "could not reach SOKONI"; nothing invented, no route guessed');
  r = await run({ answer: { route: 'merchant-v2.html', state: 'PENDING_APPROVAL' } });
  ck('E-9', r.action !== 'merchant' && r.nav.length === 0, 'merchant-v2 named but NOT AVAILABLE → not routed (approval first)', { a: r.action, nav: r.nav });
  ck('E-10', !/localStorage|sessionStorage|URLSearchParams|[?&]cat=|category\s*=\s*(new URL|location)/.test(SRC.replace(/\/\*[\s\S]*?\*\//g, '')),
    'the router reads no browser-chosen category (no storage, no URL category) — only the server answer routes');

  /* ── the pages ── */
  const SV = read('services.html'), IX = read('index.html'), FD = read('food.html'), DB = read('food-dashboard.html');
  ck('P-1', !/href="food-dashboard\.html"/.test(SV + FD) && !/location\.href='food-dashboard\.html'/.test(IX), 'no Services / home / Food Hub link opens the old Restaurant Portal');
  ck('P-2', /data-food-entry/.test(SV) && /data-food-entry/.test(IX) && /data-food-entry/.test(FD) && [SV, IX, FD].every((p) => /<script defer src="sokoni-food-entry\.js"><\/script>/.test(p)),
    'Services, home and the Food Hub page enter through the server-routed food entry');
  ck('P-3', /location\.replace\('\/food\.html#food-business'\)/.test(DB), 'the old portal URL, still addressable, hands off to the server-routed entry (no second dashboard)');
  /* Rider links are NOT asserted here: they belong to sokoni-f3, whose owner decision removes the Services Rider Portal. */
  ck('P-4', /HubRegister\.open\(\{hub:'food'/.test(FD), 'CONTROL: the food business application stays reachable');
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
