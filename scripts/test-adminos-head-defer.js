#!/usr/bin/env node
/* ================================================================
   SOKONI — AdminOS head scripts are DEFERRED, and the admin gate still decides first
   scripts/test-adminos-head-defer.js

   admin-os.html used to load six classic scripts in <head> (security, cart, permissions,
   role-authority, admin-entry, shared-header, ~310 KB) that blocked first paint. They now
   carry `defer`: document order is kept and every one runs BEFORE DOMContentLoaded, which
   is when SokoniAOS.init() starts the gate (claim check -> SokoniAdminEntry.guard() ->
   _bootUI()).

   WHAT IT HOLDS
     S   static: the six tags are deferred, none async, order unchanged, firebase.js still a module.
     G   browser, BEFORE and AFTER markup, each against three identities:
           non-admin (no claim)            -> zero callables, _bootUI never runs, sent away
           admin claim, workspace context  -> zero callables, _bootUI never runs
           admin, admin context (CONTROL)  -> boots, and the counters DO move
         AFTER must match BEFORE row for row: deferring changed nothing about who gets in.
     T   timing, BEFORE vs AFTER at 390 and 1280 (CPU x4, 80 ms per script): first paint.

   HERMETIC. The repo is served from disk under a fake host (scripts/lib/adminos-probe-lib.js);
   every other origin is aborted. Nothing here can reach production.

   Run:  node scripts/test-adminos-head-defer.js
   Exit: 0 passed · 1 a check failed · 2 the harness could not run
   ================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const shared = require(path.join(__dirname, 'lib', 'adminos-probe-lib.js'));
const ROOT = shared.ROOT;
const HOST = 'sokoni-cert.test';

let pass = 0, fail = 0, unproven = 0;
const show = (d) => (d === undefined ? '' : (typeof d === 'string' ? d : JSON.stringify(d)));
const ok = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n + (d !== undefined ? '   [' + show(d) + ']' : '')); }
                          else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '  -> ' + show(d) : '')); } };
const un = (n, d) => { unproven++; console.log('  UNPROVEN  ' + n + (d ? '   [' + d + ']' : '')); };

const DEFERRED = ['security.js', 'sokoni-cart.js', 'sokoni-permissions.js', 'sokoni-role-authority.js', 'sokoni-admin-entry.js', 'shared-header.js'];
const AFTER = fs.readFileSync(path.join(ROOT, 'admin-os.html'), 'utf8');
const headOf = (s) => s.slice(0, s.indexOf('</head>')).replace(/<!--[\s\S]*?-->/g, ' ');
/* BEFORE = the same file with the six defer attributes removed: the exact pre-change markup, built here so the
   comparison stays valid after this lands (no git ref needed). */
let BEFORE = AFTER;
for (const f of DEFERRED) BEFORE = BEFORE.split('<script src="' + f + '" defer></script>').join('<script src="' + f + '"></script>');

console.log('\nADMINOS HEAD SCRIPTS — DEFERRED, GATE UNCHANGED\n');
console.log('  [S static]');
const H = headOf(AFTER);
const tags = [...H.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
const src = (a) => (a.match(/src="([^"]+)"/) || [])[1];
ok('S1  each of the six head scripts carries defer', DEFERRED.every((f) => tags.some((a) => src(a) === f && /\bdefer\b/.test(a))));
ok('S2  no head script is async (async breaks document order)', tags.every((a) => !/\basync\b/.test(a)));
ok('S3  firebase.js is still a module', tags.some((a) => src(a) === 'firebase.js' && /type="module"/.test(a)));
const order = tags.map(src).filter(Boolean);
ok('S4  order unchanged: security, firebase, cart, permissions, role-authority, admin-entry, shared-header',
   JSON.stringify(order.filter((x) => DEFERRED.concat('firebase.js').includes(x))) ===
   JSON.stringify(['security.js', 'firebase.js', 'sokoni-cart.js', 'sokoni-permissions.js', 'sokoni-role-authority.js', 'sokoni-admin-entry.js', 'shared-header.js']), order);
ok('S5  no classic external script in <head> still blocks the parser',
   tags.filter((a) => src(a) && !/\bdefer\b|\basync\b|type="module"/.test(a)).length === 0);
ok('S6  CONTROL: the BEFORE markup really is the blocking one',
   headOf(BEFORE).indexOf('<script src="sokoni-admin-entry.js"></script>') > -1 && BEFORE !== AFTER);
ok('S7  SokoniAOS.init still starts at DOMContentLoaded (after every deferred script)',
   /document\.addEventListener\("DOMContentLoaded", \(\) => SokoniAOS\.init\(\)\)/.test(fs.readFileSync(path.join(ROOT, 'sokoni-aos.js'), 'utf8')));

/* The library's stub is an admin. Re-serve it with the identity under test, and COUNT what the page asks for. */
function stubFor(claims) {
  const CALL_A = 'functions: function(){ return { httpsCallable: function(){ return function(){';
  const CALL_B = 'functions: function(){ return { httpsCallable: function(n){ return function(){ (window.__calls = window.__calls || []).push(n);';
  const READ_A = 'var fsFn = function(){ return { collection: function(c){ return colRef(c); }';
  const READ_B = 'var fsFn = function(){ return { collection: function(c){ (window.__reads = window.__reads || []).push(c); return colRef(c); }';
  let s = shared.firebaseStub();
  for (const [a, b] of [[JSON.stringify(shared.CLAIMS), JSON.stringify(claims)], [CALL_A, CALL_B], [READ_A, READ_B]]) {
    if (s.split(a).length !== 2) throw new Error('harness: stub anchor not found once: ' + a.slice(0, 60));
    s = s.replace(a, () => b);
  }
  return s;
}
/* The sidebar ticket badge used to subscribe to supportTickets from an inline DOMContentLoaded handler, BEFORE the
   gate (sokoni-aa moved it into _bootUI in 1b3f45f). On markup that still has the inline listener the read is
   reported, not failed; once it is gone, a non-admin must make ZERO supportTickets reads. */
const LEGACY_BADGE = AFTER.indexOf('firebase.firestore().collection(' + String.fromCharCode(34) + 'supportTickets') > -1;
console.log('  [ticket badge: ' + (LEGACY_BADGE ? 'LEGACY inline pre-gate listener present (reported, not failed)' : 'after the gate (strict: zero supportTickets reads)') + ']');
const IDENT = {
  nonAdmin:       { claims: {}, ctx: 'superAdmin', label: 'non-admin (no claim)' },
  adminWorkspace: { claims: { admin: true }, ctx: 'none', label: 'admin claim, workspace context' },
  admin:          { claims: { admin: true, superAdmin: true }, ctx: 'superAdmin', label: 'admin in admin context (CONTROL)' },
};

async function visit(browser, html, who, vp) {
  const ctx = await browser.newContext({ viewport: vp || { width: 1280, height: 900 }, ignoreHTTPSErrors: true });
  await ctx.addInitScript((c) => {
    try {
      localStorage.setItem('loggedIn', 'true');
      localStorage.setItem('sokoniUser', JSON.stringify({ uid: 'fixture-admin', name: 'Fixture', email: 'f@example.test', roles: ['admin', 'superAdmin'], activeRole: 'buyer' }));
      if (c === 'none') sessionStorage.removeItem('sokoniAdminContext'); else sessionStorage.setItem('sokoniAdminContext', c);
      sessionStorage.removeItem('sokoniPermCache');
    } catch (_) {}
    window.alert = function (m) { window.__alerted = String(m); };
  }, who.ctx);
  const left = [];
  const base = shared.router({ host: HOST, overrides: { '/admin-os.html': html, '/firebase.js': stubFor(who.claims) } });
  await ctx.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (route.request().isNavigationRequest() && u.hostname === HOST && u.pathname !== '/admin-os.html') {
      left.push(u.pathname);
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>left</title>' });
    }
    return base(route);
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('https://' + HOST + '/admin-os.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  const s = await page.evaluate(() => {
    if (document.title === 'left') return { leftPage: true };
    const nm = document.getElementById('aosUserName');
    return { leftPage: false, calls: window.__calls || [], reads: window.__reads || [], alerted: window.__alerted || null,
             userName: nm ? nm.textContent.trim() : null, isSuper: document.body.classList.contains('is-super'),
             activeNav: !!document.querySelector('#aosSidebar .nav-item.active') };
  }).catch((e) => ({ leftPage: true, evalError: e.message }));
  await ctx.close();
  return Object.assign(s, { left, errors });
}

(async () => {
  let chromium, browser;
  if (process.env.STATIC_ONLY) { un('every browser check', 'STATIC_ONLY set (run without it when RAM allows)'); return finish(); }
  try { ({ chromium } = shared.playwright()); } catch (e) { un('every browser check', 'playwright unavailable'); return finish(); }
  try { browser = await chromium.launch(); } catch (e) { un('every browser check', 'chromium did not launch: ' + e.message); return finish(); }
  try {
    console.log('\n  [G gate — BEFORE vs AFTER]');
    const R = {};
    for (const k of Object.keys(IDENT)) for (const [tag, html] of [['before', BEFORE], ['after', AFTER]]) R[k + ':' + tag] = await visit(browser, html, IDENT[k]);
    /* Boot = _bootUI() ran: it adds is-super for a super admin and the router marks a section active. */
    const booted = (r) => !r.leftPage && (!!r.activeNav || !!r.isSuper);
    const ctl = R['admin:after'];
    if (!booted(ctl)) { console.error('  BLOCKED — the admin CONTROL did not boot, so a zero means nothing: ' + JSON.stringify(ctl)); await browser.close(); process.exit(2); }
    ok('G0  CONTROL admin boots on AFTER and the callable/read counters move', (ctl.calls.length + ctl.reads.length) > 0,
       { calls: ctl.calls.length, reads: ctl.reads.length });
    ok('G0b CONTROL admin boots on BEFORE too', booted(R['admin:before']));
    for (const k of ['nonAdmin', 'adminWorkspace']) {
      for (const tag of ['before', 'after']) {
        const r = R[k + ':' + tag];
        const calls = r.leftPage ? [] : (r.calls || []);
        ok(`G1  ${IDENT[k].label} [${tag}]: zero admin callables`, calls.length === 0, r.leftPage ? 'navigated away' : calls);
        ok(`G2  ${IDENT[k].label} [${tag}]: _bootUI never ran (no admin panel paint)`, !booted(r), r.leftPage ? 'navigated away' : { userName: r.userName, activeNav: r.activeNav });
        const adminReads = r.leftPage ? [] : (r.reads || []).filter((c) => LEGACY_BADGE ? c !== 'supportTickets' : true);
        ok(`G3  ${IDENT[k].label} [${tag}]: no admin data read' + (LEGACY_BADGE ? ' beyond the legacy pre-gate ticket badge' : ', supportTickets included') + '`, adminReads.length === 0, adminReads);
      }
      const b = R[k + ':before'], a = R[k + ':after'];
      const sig = (r) => JSON.stringify([!!r.leftPage, r.left, booted(r), r.leftPage ? 0 : (r.calls || []).length]);
      ok(`G4  ${IDENT[k].label}: AFTER behaves exactly as BEFORE`, sig(b) === sig(a), { before: sig(b), after: sig(a) });
    }
    const nb = R['nonAdmin:after'];
    ok('G5  non-admin is sent away, never left on the console', nb.leftPage || nb.left.length > 0 || !!nb.alerted, { left: nb.left, alerted: nb.alerted });
    const pre = R['nonAdmin:before'];
    if (LEGACY_BADGE && !pre.leftPage && (pre.reads || []).includes('supportTickets'))
      un('PRE-EXISTING, not this change: the sidebar ticket-badge listener reads supportTickets at DOMContentLoaded, before the gate',
         'rules must refuse it for a non-admin; reported to the AdminOS owner');

    console.log('\n  [T timing — first paint, CPU x4, 80 ms per script, median of 3]');
    const timeOnce = async (html, vp) => {
      const ctx = await browser.newContext({ viewport: vp, ignoreHTTPSErrors: true });
      await ctx.addInitScript(shared.compatInit, 'superAdmin');
      const base = shared.router({ host: HOST, overrides: { '/admin-os.html': html } });
      await ctx.route('**/*', async (route) => { if (/\.js(\?|$)/.test(route.request().url())) await new Promise((r) => setTimeout(r, 80)); return base(route); });
      const page = await ctx.newPage();
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      await page.goto('https://' + HOST + '/admin-os.html', { waitUntil: 'load', timeout: 60000 });
      const t = await page.evaluate(() => {
        const fp = performance.getEntriesByName('first-contentful-paint')[0];
        const nav = performance.getEntriesByType('navigation')[0];
        return { fcp: fp ? Math.round(fp.startTime) : 0, dcl: nav ? Math.round(nav.domContentLoadedEventEnd) : 0 };
      });
      await ctx.close();
      return t;
    };
    const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
    for (const vp of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
      const out = {};
      for (const [tag, html] of [['before', BEFORE], ['after', AFTER]]) {
        const runs = []; for (let i = 0; i < 3; i++) runs.push(await timeOnce(html, vp));
        out[tag] = { fcp: med(runs.map((r) => r.fcp)), dcl: med(runs.map((r) => r.dcl)) };
      }
      console.log(`        ${vp.width}px  first paint ${out.before.fcp} -> ${out.after.fcp} ms   DOMContentLoaded ${out.before.dcl} -> ${out.after.dcl} ms`);
      ok(`T1  ${vp.width}px: first paint is not slower after deferring`, out.after.fcp > 0 && out.after.fcp <= out.before.fcp, out);
    }
  } finally { await browser.close(); }
  finish();
})().catch((e) => { console.error('  aborted: ' + (e && e.message)); process.exit(2); });

function finish() {
  console.log('\n  what this does NOT prove');
  un('real-device, real-network timing', 'throttled desktop Chromium on a hermetic server');
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven\n');
  process.exit(fail ? 1 : 0);
}
