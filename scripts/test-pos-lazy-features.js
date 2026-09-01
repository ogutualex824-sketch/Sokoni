#!/usr/bin/env node
/**
 * LAZY FEATURE MODULES — five modules a till no longer parses to open.
 *
 *   node scripts/test-pos-lazy-features.js
 *
 * Analytics, reports, live analytics, voice and AI import were 103 KB of a 2,148 KB startup
 * payload, parsed on every till boot including the many that never open them. None is reachable
 * from the first usable POS screen.
 *
 * COUNTING FEWER SCRIPTS PROVES NOTHING. The questions that matter are whether the module still
 * arrives when the feature is used, whether a failure to arrive is honest, and whether anything
 * that used to run at boot has silently stopped running. Each is asserted, and each is shown
 * able to fail.
 *
 * WHY A PROXY. Enumerating methods means a call site added later silently becomes undefined.
 * The Proxy forwards any property, so a new caller keeps working. `if (window.PosAnalytics)`
 * guards stay TRUE because the shim is a real object — the existing feature checks are
 * unchanged.
 *
 * WHAT IS DELIBERATELY STILL EAGER, and why the boundary is here rather than further out:
 *   pos-plugins.js, pos-omni.js   run AT BOOT behind `if (window.X)` guards
 *                                 (installBuiltins / restoreEnabled / startSync). Deferring
 *                                 them would silently disable plugins and omni sync — a
 *                                 functional change wearing a performance change's clothes.
 *   pos-ai-engine.js              nested namespaces (PosAIEngine.pricing.optimizeAll) which a
 *                                 flat forwarder cannot represent.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const NL = String.fromCharCode(10);
const POS = fs.readFileSync(path.join(ROOT, 'pos.html'), 'utf8');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 90) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log(NL + t);

const LAZY = [
  ['PosAnalytics',      'pos-analytics.js'],
  ['PosReports',        'pos-reports.js'],
  ['SokonPOSAnalytics', 'pos-analytics-live.js'],
  ['PosVoice',          'pos-voice.js'],
  ['PosAI',             'pos-ai.js'],
];
const STILL_EAGER = ['pos-plugins.js', 'pos-omni.js', 'pos-ai-engine.js'];

/* Run the shim factory exactly as pos.html defines it, with script loading under our control. */
function makeFactory (outcome, onFetch) {
  const decl = POS.indexOf('function lazyGlobal (name, url) {');
  if (decl === -1) return null;
  const at = POS.lastIndexOf('(function () {', decl);
  const end = POS.indexOf('})();', decl);
  if (at === -1 || end === -1) return null;
  const src = POS.slice(at, end + 5);

  const win = {};
  const head_ = {
    appendChild: (s) => {
      if (onFetch) onFetch(s.src);
      setTimeout(() => {
        if (outcome === 'error') { s.onerror && s.onerror(); return; }
        if (outcome === 'silent') { s.onload && s.onload(); return; }
        /* The real module assigns ITS OWN global. Map the fetched url back to the right
           name — an earlier version took the first shim it found and stubbed only two
           methods, so a call to any other method returned undefined and the failure
           looked like the Proxy was broken. The double answers ANY method, because the
           thing under test is the forwarding, not the module's surface. */
        const entry = LAZY.find(([, file]) => s.src === file);
        if (entry) {
          win[entry[0]] = new Proxy({}, {
            get: (_t, p) => {
              /* MUST return undefined for `then`. Without it this double is an accidental
                 THENABLE: resolve(fake) makes the promise machinery call fake.then(...),
                 which never calls resolve, and the whole suite hangs with no tally and a
                 clean exit code — which reads as "the tests did not run" only if you are
                 looking. The production shim guards this for the same reason. */
              if (p === 'then') return undefined;
              return (...a) => (p === 'echo' ? a[0] : 'real');
            },
          });
        }
        s.onload && s.onload();
      }, 0);
    },
  };
  const doc = { createElement: () => ({ set src (v) { this._s = v; }, get src () { return this._s; } }), head: head_ };
  const fn = new Function('window', 'document', 'console', 'Proxy', 'Promise',
    src + NL + 'return window;');
  return fn(win, doc, { error: () => {}, warn: () => {}, log: () => {} }, Proxy, Promise);
}

console.log(NL + 'LAZY FEATURE MODULES' + NL + '='.repeat(60));

(async () => {
  /* ── 1 · genuinely removed from boot ─────────────────────────────────────── */
  head('1 · not parsed to open a till');
  LAZY.forEach(([g, f]) => {
    ck(f + ' is not loaded eagerly',
       POS.indexOf('src="' + f + '"') === -1,
       'a till that never opens this feature must not parse it');
    ck('...and ' + f + ' still exists on disk', fs.existsSync(path.join(ROOT, f)),
       'deferred, never deleted');
    ck('...and ' + g + ' has a shim', POS.indexOf('lazyGlobal("' + g + '"') > -1);
  });

  /* ── 2 · the boundary is deliberate ──────────────────────────────────────── */
  head('2 · what stays eager, and why');
  STILL_EAGER.forEach((f) => {
    ck(f + ' is STILL loaded eagerly', POS.indexOf('src="' + f + '"') > -1,
       'deferring it would change behaviour, not just timing');
  });
  /* Assert the SUBSTANCE, not a banner phrase. This pinned the exact words
     "DELIBERATELY NOT DEFERRED" and failed when the comment was reworded during a
     rebuild — a documentation check should survive an edit that keeps the reasoning. */
  ck('the reason is written where the decision was made',
     POS.indexOf('installBuiltins') > -1 && POS.indexOf('nested namespaces') > -1,
     'names the boot-time calls and the nested-namespace limit, not just a heading');

  /* ── 3 · it arrives when the feature is used ─────────────────────────────── */
  head('3 · the module loads on first use');
  let fetched = [];
  const okWin = makeFactory('ok', (u) => fetched.push(u));
  ck('the shim factory could be instantiated from the page', !!okWin,
     'if this fails everything below proves nothing');
  if (okWin) {
    ck('CONTROL nothing is fetched merely by installing the shims', fetched.length === 0,
       'installing a shim must not trigger a download');
    const r = await okWin.PosAnalytics.renderBosHub('x');
    ck('calling a method fetches the module', fetched.length === 1, fetched.join(','));
    ck('...and forwards the real answer', r === 'real');
    const e = await okWin.PosVoice.echo(7);
    ck('an UNENUMERATED method also forwards', e === 7,
       'the Proxy is why a call site added later keeps working');
  }

  /* ── 4 · failure is honest ───────────────────────────────────────────────── */
  head('4 · a module that will not load fails openly');
  const badWin = makeFactory('error');
  if (badWin) {
    const r = await badWin.PosAnalytics.renderBosHub('x');
    ck('NEGATIVE a 404 resolves undefined, not a fake result', r === undefined,
       'got ' + JSON.stringify(r));
    ck('NEGATIVE ...and does not throw into the caller', true,
       'the await completed; a throw would have failed this suite');
    ck('the failure is logged rather than swallowed',
       POS.indexOf('failed to load') > -1 && POS.indexOf('unavailable') > -1);
  }
  const silentWin = makeFactory('silent');
  if (silentWin) {
    const r = await silentWin.PosReports.anything();
    ck('NEGATIVE a script that loads but registers nothing also yields undefined',
       r === undefined);
  }

  /* ── 5 · loaded once ─────────────────────────────────────────────────────── */
  head('5 · one fetch per module, not one per call');
  let n = [];
  const onceWin = makeFactory('ok', (u) => n.push(u));
  if (onceWin) {
    /* CONCURRENT, deliberately. Awaiting them in sequence proved nothing: once the module
       loads it REPLACES the global, so calls two and three never reach the shim at all and
       the count was 1 whether or not the cache existed. A sabotage that removed the cache
       still passed. Firing all three before the first load settles is the only way they
       contend for it. */
    const [a1, a2, a3] = await Promise.all([
      onceWin.PosAI.ping(), onceWin.PosAI.ping(), onceWin.PosAI.ping(),
    ]);
    ck('three CONCURRENT calls fetch once', n.length === 1, n.length + ' fetches');
    ck('...and all three receive the answer',
       a1 === 'real' && a2 === 'real' && a3 === 'real');
    ck('the shim caches the pending load', POS.indexOf('if (pending) return pending;') > -1,
       'without this every panel open refetches the module');
  }

  /* ── 6 · nothing else changed ────────────────────────────────────────────── */
  head('6 · existing guards and call sites are untouched');
  const POSJS = fs.readFileSync(path.join(ROOT, 'pos.js'), 'utf8');
  ck('the boot-time plugin install still runs',
     POSJS.indexOf('PosPlugins.installBuiltins();') > -1);
  ck('the boot-time omni sync still runs',
     POSJS.indexOf('PosOmni.startSync(') > -1);
  ck('CONTROL feature guards still see an object',
     POSJS.indexOf('if (window.PosAnalytics)') > -1,
     'the shim is truthy, so `if (window.X)` behaves exactly as before');

  console.log(NL + '  ' + pass + ' passed, ' + fail + ' failed');
  console.log('  NOTE: loading behaviour only. No feature was re-implemented or removed.');
  process.exit(fail ? 1 : 0);
})();
