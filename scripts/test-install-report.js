#!/usr/bin/env node
/* ============================================================================
   Install reporter — consent gate + payload + once-a-day (node, no browser)
   scripts/test-install-report.js

   Runs sokoni-install-report.js in a vm with a stub window: SokoniConsent,
   localStorage, a controlling service worker that answers GET_VERSION, and a
   compat firebase.functions() that records every appInstallReport call.

   CONSENT (spec from the privacy programme, sokoni-4d):
     C1 SokoniConsent absent            -> nothing is ever sent (fail closed)
     C2 onChange delivers false         -> nothing sent
     C3 grant -> deny before the send   -> nothing sent (the deny wins)
     C4 grant -> sends ONE check-in; same day again -> none; next day -> one
     C5 after a grant->deny change, appinstalled sends nothing
   PAYLOAD / ROBUSTNESS:
     P1 exactly {installId,event,cacheVersion,standalone,platform}; UUID v4;
        platform an enum; the user-agent string never sent
     P2 appinstalled with consent -> event 'install'
     P3 no callable / offline / no SW controller / callable rejects -> no send,
        no throw
   STATIC:
     S1 sw-register.js injects it once, through the existing _mods list, and
        its other lines are untouched (no SW caching change)
     S2 the reporter never reads the consent storage keys itself

   Run:  node scripts/test-install-report.js     Exit: 0 pass · 1 fail
   ========================================================================= */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'sokoni-install-report.js'), 'utf8');
const CV = 'sokoni-20261001120000-v648';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
};
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

function consentStub(initial) {
  const subs = [];
  let g = initial;
  return {
    api: { onChange(fn) { subs.push(fn); try { fn(g); } catch (_) {} }, onGrant() { throw new Error('onGrant must not be used'); }, granted: () => g },
    set(v) { g = v; subs.forEach((f) => f(v)); },
  };
}

/* One "page load". storage persists across loads when passed in. */
function load(opts) {
  const o = Object.assign({ consent: null, storage: new Map(), callable: true, online: true, controller: true, reject: false, now: Date.parse('2026-10-01T08:00:00Z'), ua: 'Mozilla/5.0 (Linux; Android 14) Chrome/128', standalone: false }, opts);
  const calls = [];
  const listeners = {};
  class MC { constructor() { this.port1 = { onmessage: null }; this.port2 = { _p1: this.port1 }; } }
  const RealDate = Date;
  class FakeDate extends RealDate { constructor(...a) { super(...(a.length ? a : [o.now])); } static now() { return o.now; } }
  const win = {
    Date: FakeDate, Math, JSON, String, Array, Object, Promise, Uint8Array, RegExp, Number, Error,
    setTimeout: (f, ms) => setTimeout(f, Math.min(ms || 0, 5)), clearTimeout,
    MessageChannel: MC,
    crypto: require('crypto').webcrypto,
    localStorage: { getItem: (k) => (o.storage.has(k) ? o.storage.get(k) : null), setItem: (k, v) => o.storage.set(k, String(v)), removeItem: (k) => o.storage.delete(k) },
    navigator: {
      userAgent: o.ua, onLine: o.online, maxTouchPoints: 0,
      serviceWorker: o.controller ? { controller: { postMessage: (msg, ports) => { if (msg && msg.type === 'GET_VERSION') setTimeout(() => ports[0]._p1.onmessage({ data: { version: CV } }), 1); } } } : {},
    },
    matchMedia: () => ({ matches: o.standalone }),
    document: { readyState: 'complete' },
    addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
    requestIdleCallback: (f) => setTimeout(f, 1),
  };
  win.window = win; win.self = win; win.top = win;
  if (o.consent) win.SokoniConsent = o.consent.api;
  if (o.callable) {
    win.firebase = { apps: [{}], functions: () => ({ httpsCallable: (name) => (data) => { calls.push({ name, data }); return o.reject ? Promise.reject(Object.assign(new Error('x'), { code: 'functions/not-found' })) : Promise.resolve({ data: { ok: true } }); } }) };
  }
  vm.createContext(win);
  let threw = null;
  try { vm.runInContext(SRC, win); } catch (e) { threw = e; }
  return { win, calls, storage: o.storage, fire: (t) => (listeners[t] || []).forEach((f) => f({})), threw, o };
}

(async () => {
  console.log('\n[consent gate — SokoniConsent.onChange, fail closed]');
  let p = load({ consent: null });
  await settle();
  p.fire('appinstalled'); await settle();
  ok('C1 no SokoniConsent on the page -> nothing sent (check-in or install)', p.calls.length === 0 && !p.threw);

  let c = consentStub(false);
  p = load({ consent: c });
  await settle();
  p.fire('appinstalled'); await settle();
  ok('C2 onChange delivers false -> nothing sent', p.calls.length === 0);

  c = consentStub(true);
  const store = new Map();
  p = load({ consent: c, storage: store });
  c.set(false);                       /* deny lands after scheduling, before the send */
  await settle();
  ok('C3 grant then deny before the send -> nothing sent (the deny wins)', p.calls.length === 0, p.calls);
  ok('C3 no day key recorded for a send that never happened', !store.has('sokoniInstallCheckinDay'));

  c = consentStub(true);
  const s2 = new Map();
  p = load({ consent: c, storage: s2 });
  await settle();
  ok('C4 after grant: exactly ONE check-in', p.calls.length === 1 && p.calls[0].data.event === 'checkin', p.calls.map((x) => x.data.event));
  const firstId = p.calls[0] && p.calls[0].data.installId;
  p = load({ consent: consentStub(true), storage: s2 });
  await settle();
  ok('C4 a second page load the same Nairobi day -> no check-in', p.calls.length === 0);
  p = load({ consent: consentStub(true), storage: s2, now: Date.parse('2026-10-01T21:00:01Z') });
  await settle();
  ok('C4 next Nairobi day (21:00Z) -> one check-in, same installId', p.calls.length === 1 && p.calls[0].data.installId === firstId);

  c = consentStub(true);
  p = load({ consent: c, storage: new Map([['sokoniInstallCheckinDay', '2026-10-01']]) });
  await settle();
  c.set(false);
  p.fire('appinstalled'); await settle();
  ok('C5 after grant -> deny, appinstalled sends nothing', p.calls.length === 0, p.calls);
  c.set(true);
  p.fire('appinstalled'); await settle();
  ok('C5 a later re-grant is honoured (install sent)', p.calls.length === 1 && p.calls[0].data.event === 'install');

  console.log('\n[payload]');
  p = load({ consent: consentStub(true), standalone: true, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' });
  await settle();
  const d = p.calls[0] && p.calls[0].data;
  ok('P1 callable name is appInstallReport', p.calls[0] && p.calls[0].name === 'appInstallReport');
  ok('P1 exactly the five fields', d && JSON.stringify(Object.keys(d).sort()) === JSON.stringify(['cacheVersion', 'event', 'installId', 'platform', 'standalone']), d);
  ok('P1 installId is a UUID v4, cacheVersion from GET_VERSION, standalone boolean', d && UUID_V4.test(d.installId) && d.cacheVersion === CV && d.standalone === true);
  ok('P1 platform is an enum (iPhone -> ios); the UA string is never sent', d && d.platform === 'ios' && !JSON.stringify(d).includes('Mozilla'));
  p = load({ consent: consentStub(true), storage: new Map([['sokoniInstallCheckinDay', '2026-10-01']]) });
  await settle();
  p.fire('appinstalled'); await settle();
  ok('P2 appinstalled with consent -> event install (even after today\'s check-in)', p.calls.length === 1 && p.calls[0].data.event === 'install' && p.calls[0].data.platform === 'android');

  console.log('\n[robustness — silent no-ops]');
  p = load({ consent: consentStub(true), callable: false });
  await settle();
  ok('P3 no callable transport -> nothing, no throw, no day key', p.calls.length === 0 && !p.threw && !p.storage.has('sokoniInstallCheckinDay'));
  p = load({ consent: consentStub(true), online: false });
  await settle();
  ok('P3 offline -> nothing sent', p.calls.length === 0);
  p = load({ consent: consentStub(true), controller: false });
  await settle();
  ok('P3 no service worker controller -> nothing sent (no version to report)', p.calls.length === 0);
  let unhandled = 0; const onUn = () => unhandled++; process.on('unhandledRejection', onUn);
  p = load({ consent: consentStub(true), reject: true });
  await settle();
  process.off('unhandledRejection', onUn);
  ok('P3 callable not deployed (rejects) -> no throw, no unhandled rejection; at most one attempt a day', p.calls.length === 1 && unhandled === 0 && p.storage.get('sokoniInstallCheckinDay') === '2026-10-01');

  console.log('\n[static]');
  const sw = fs.readFileSync(path.join(ROOT, 'sw-register.js'), 'utf8');
  const mods = sw.slice(sw.indexOf('const _mods = ['), sw.indexOf('];', sw.indexOf('const _mods = [')));
  ok('S1 sw-register.js injects /sokoni-install-report.js once, via _mods', (sw.match(/sokoni-install-report\.js/g) || []).length === 1 && mods.includes('"/sokoni-install-report.js"'));
  let base = null;
  /* Baseline = sw-register.js as it was just BEFORE the commit that introduced the
     reporter line (not HEAD, which already carries it). */
  try {
    const git = (a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const intro = git(['log', '--format=%H', '-S', 'sokoni-install-report.js', '--', 'sw-register.js']).trim().split('\n').filter(Boolean).pop();
    base = git(['show', (intro ? intro + '^' : 'HEAD') + ':sw-register.js']);
  } catch (_) {}
  const strip = (s) => s.replace(/\r\n?/g, '\n').split('\n').filter((l) => !/sokoni-install-report|Install \/ build reporter|Consent-gated on window\.SokoniConsent|ASKS the worker its version|or caching\. \*\//.test(l)).join('\n');
  ok('S1 every other sw-register.js line is unchanged vs HEAD (no SW logic touched)', base !== null && strip(sw) === strip(base));
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '');
  ok('S2 never reads consent storage keys directly (SokoniConsent is the authority)', !/sokoniPrivacy(Accepted|Rejected)/.test(code) && /SokoniConsent/.test(code) && /onChange/.test(code) && !/onGrant/.test(code));
  ok('S2 no innerHTML / document.write / eval', !/innerHTML|document\.write|eval\(/.test(code));

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
