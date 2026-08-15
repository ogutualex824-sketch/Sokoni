#!/usr/bin/env node
/* POS mobile shell readiness contract  (Gate C stability)
 *
 *   node scripts/test-pos-mobile-readiness.js
 *
 * WHY THIS EXISTS
 * pos.html ships <div id="panel-pos" class="pos-panel active"> in its MARKUP, and
 * pos-mobile.js only overrides that at the very end of init():
 *
 *     await refreshDashboard();     <- async, hits PosDB/Firestore
 *     tab('home');                  <- the default-panel decision
 *
 * So the panel choice was unobservable from outside: a reader could not tell
 * "the shell chose Checkout" from "the shell has not decided yet". A fixed sleep
 * in test-pos-tab-transitions sometimes sampled the static default and reported a
 * selection failure that had not happened — the same assertion passed and failed
 * across five gate runs, at BOTH concurrency levels, blocking two releases.
 *
 * Every alternative signal was checked first and rejected on evidence:
 *   window.PosMobile        assigned at script load, before init()      — too early
 *   #mobile-bottom-nav      built at init step 1                        — too early
 *   #mobile-home-panel      created at init step 3, before the await    — too early
 *   #mobile-home-panel.active                                           — IS the assertion
 *   window.SPos             independent of PosMobile.init               — unrelated
 *   every refreshDashboard artifact (kpi-*, mhp-*)                      — see below
 *
 * The dashboard artifacts are the important negative. refreshDashboard() wraps its
 * work in try/catch and SWALLOWS the failure, so on the failing path — App Check
 * refusing to attest 127.0.0.1 — not one of them is ever written, while tab('home')
 * still runs. Waiting on them would time out exactly when the shell HAD initialised.
 *
 * Hence a real signal. This file pins what it must and must not mean.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 76) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log('\n── ' + t + ' ──');

/* ── Minimal DOM, enough for init() to run end to end ─────────────────────────
   Deliberately not a DOM library: the point is to drive the REAL pos-mobile.js
   init path and observe when readiness is announced, not to simulate a browser. */
function makeEnv({ dashboardFails }) {
  const listeners = {};
  const byId = {};
  const mkEl = (tag) => {
    const el = {
      tagName: tag, id: '', className: '', innerHTML: '', style: {},
      children: [], _classes: new Set(),
      classList: {
        add: (c) => el._classes.add(c),
        remove: (c) => el._classes.delete(c),
        contains: (c) => el._classes.has(c),
      },
      appendChild: (c) => { el.children.push(c); return c; },
      remove: () => { delete byId[el.id]; },
      querySelectorAll: () => [],
      addEventListener: () => {},
      setAttribute: () => {}, getAttribute: () => null,
    };
    return el;
  };
  const document = {
    body: Object.assign(mkEl('body'), {
      appendChild: (c) => { if (c.id) byId[c.id] = c; return c; },
      insertBefore: (c) => { if (c.id) byId[c.id] = c; return c; },
    }),
    createElement: mkEl,
    getElementById: (id) => byId[id] || null,
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener: () => {},
    dispatchEvent: (e) => { (listeners[e.type] || []).forEach((f) => f(e)); return true; },
  };
  /* createElement must register by id once the caller assigns one. */
  const origCreate = document.createElement;
  document.createElement = (tag) => {
    const el = origCreate(tag);
    let _id = '';
    Object.defineProperty(el, 'id', {
      get: () => _id,
      set: (v) => { _id = v; if (v) byId[v] = el; },
    });
    return el;
  };

  const win = {
    document,
    matchMedia: () => ({ matches: true }),          /* mobile */
    ontouchstart: true,
    addEventListener: () => {},
    CustomEvent: class { constructor(t, o) { this.type = t; this.detail = (o || {}).detail; } },
    /* SPos deliberately ABSENT — readiness must not depend on it. */
  };
  const navigator = { maxTouchPoints: 5 };          /* no wakeLock — optional path */

  /* PosDB: either resolves, or rejects the way App Check failure does. */
  const reject = () => Promise.reject(new Error('FirebaseError: App Check token is invalid'));
  const PosDB = dashboardFails ? {
    reports:      { forDateRange: reject },
    products:     { getLowStock: reject },
    settings:     { getAll: reject },
    transactions: { getAll: reject },
  } : {
    reports:      { forDateRange: async () => ({ total: 0, count: 0, profit: 0, mpesa: 0, cash: 0 }) },
    products:     { getLowStock: async () => [] },
    settings:     { getAll: async () => ({ bizName: 'Test Shop' }) },
    transactions: { getAll: async () => [] },
  };

  return { win, document, navigator, PosDB, listeners, byId };
}

/* Load the REAL pos-mobile.js against the stub. */
function loadPosMobile(env) {
  const src = fs.readFileSync(path.join(ROOT, 'pos-mobile.js'), 'utf8');
  const sandbox = {
    window: env.win, document: env.document, navigator: env.navigator,
    PosDB: env.PosDB, console: { error: () => {}, log: () => {}, warn: () => {} },
    setTimeout, clearTimeout, Promise, Date, Math, JSON, Object, Array, String, Number,
    CustomEvent: env.win.CustomEvent,
    PosScanner: {}, SPos: undefined,
  };
  env.win.window = env.win;
  const vm = require('vm');
  vm.createContext(sandbox);
  try { vm.runInContext(src, sandbox, { timeout: 10000 }); }
  catch (e) { return { err: e.message }; }
  return { PosMobile: sandbox.window.PosMobile || sandbox.PosMobile };
}

(async () => {

  /* ══ 1 · the signal exists and means one thing ══ */
  head('1 · the readiness signal exists');
  const SRC = fs.readFileSync(path.join(ROOT, 'pos-mobile.js'), 'utf8');
  ck('a readiness flag is declared', /let _shellReady\s*=\s*false;/.test(SRC));
  ck('it is exposed as isShellReady()', /isShellReady:\s*\(\)\s*=>\s*_shellReady/.test(SRC));
  ck('a namespaced event is dispatched', /sokoniPosMobileReady/.test(SRC));
  /* THE ORDERING THAT MAKES IT MEANINGFUL — announced after the decision. */
  ck('readiness is set AFTER tab(\'home\'), not before',
     SRC.indexOf("tab('home');") < SRC.indexOf('_shellReady = true;'));
  ck('...and after the dashboard await',
     SRC.indexOf('await refreshDashboard();') < SRC.indexOf('_shellReady = true;'));

  /* ══ 2 · it fires on the HAPPY path ══ */
  head('2 · readiness fires when the dashboard loads');
  {
    const env = makeEnv({ dashboardFails: false });
    const { PosMobile, err } = loadPosMobile(env);
    ck('pos-mobile.js loads', !err, err);
    const seen = [];
    env.document.addEventListener('sokoniPosMobileReady', (e) => seen.push(e));
    ck('not ready before init', PosMobile.isShellReady() === false);
    await PosMobile.init();
    ck('ready after init', PosMobile.isShellReady() === true);
    ck('the event fired exactly once', seen.length === 1, seen.length);
    ck('the home panel is the active one', !!env.byId['mobile-home-panel']
       && env.byId['mobile-home-panel'].classList.contains('active'));
  }

  /* ══ 3 · THE CASE THAT BROKE THE GATE — it fires when the backend does not ══ */
  head('3 · readiness fires even when refreshDashboard() fails (App Check)');
  {
    const env = makeEnv({ dashboardFails: true });
    const { PosMobile, err } = loadPosMobile(env);
    ck('pos-mobile.js loads', !err, err);
    const seen = [];
    env.document.addEventListener('sokoniPosMobileReady', (e) => seen.push(e));
    await PosMobile.init();
    /* refreshDashboard swallows its own error, so tab('home') runs regardless —
       and readiness must follow it just as unconditionally. */
    ck('init still completes', PosMobile.isShellReady() === true);
    ck('the event still fired', seen.length === 1, seen.length);
    ck('the shell still made its decision', !!env.byId['mobile-home-panel']
       && env.byId['mobile-home-panel'].classList.contains('active'));
    /* The dashboard artifacts are NOT written on this path — which is exactly why
       none of them could serve as the readiness signal. */
    const kpi = env.byId['kpi-sales'];
    ck('no dashboard artifact was written (why they cannot be the signal)',
       !kpi || /—/.test(String(kpi.textContent || kpi.innerHTML || '—')));
  }

  /* ══ 4 · it means ONLY what it says ══ */
  head('4 · the signal does not smuggle in other meanings');
  {
    const env = makeEnv({ dashboardFails: true });
    const { PosMobile } = loadPosMobile(env);
    await PosMobile.init();
    ck('it does not require SPos (absent here, still ready)',
       PosMobile.isShellReady() === true && typeof env.win.SPos === 'undefined');
    ck('it does not require Firebase to have succeeded', PosMobile.isShellReady() === true);
    ck('it does not report WHICH panel won — the reader must inspect',
       !/isShellReady[\s\S]{0,120}(panel-pos|mobile-home-panel)/.test(SRC));
    ck('a late reader still gets the truth from the flag',
       PosMobile.isShellReady() === true);
  }

  /* ══ 5 · the panel decision itself is unchanged ══ */
  head('5 · product behaviour is untouched');
  ck("tab('home') still shows the mobile home panel", /if \(name === 'home'\) \{\s*_showMobileHome\(\);/.test(SRC));
  ck('the SPos branch is still only for non-home tabs', /\} else if \(window\.SPos\) \{/.test(SRC));
  ck('_showMobileHome still clears other panels first',
     /_showMobileHome[\s\S]{0,200}querySelectorAll\('\.pos-panel'\)[\s\S]{0,80}remove\('active'\)/.test(SRC));
  ck('readiness adds no branch to the decision',
     !/_shellReady[\s\S]{0,80}(if|\?)[\s\S]{0,40}tab\(/.test(SRC));

  /* ══ 6 · the consuming suite waits for the signal, not for the answer ══ */
  head('6 · test-pos-tab-transitions observes readiness, not .active');
  const SUITE = fs.readFileSync(path.join(ROOT, 'scripts', 'test-pos-tab-transitions.js'), 'utf8');
  ck('it waits on the readiness signal', /isShellReady|sokoniPosMobileReady/.test(SUITE));
  ck('it does NOT wait for the panel to be active (that is the assertion)',
     !/waitFor[\s\S]{0,160}mobile-home-panel[\s\S]{0,60}active/.test(SUITE));
  ck('the expectedDefault contract is unchanged',
     /const shellDefault\s*=\s*vp\.m && !selected\.hasSPos;/.test(SUITE) &&
     /expectedDefault\s*=\s*shellDefault \? 'mobile-home-panel' : 'pos'/.test(SUITE));
  ck('the ck() assertion is unchanged',
     /selected\.active\.length === 1 &&\s*selected\.active\[0\] === expectedDefault/.test(SUITE));
  /* A timeout must not become a green result. */
  /* 449 chars between the guard and its `continue` — measured, not guessed, so the
     window is not another thing that silently drifts. */
  ck('an un-initialised shell SKIPs rather than passing or failing',
     /if \(vp\.m && !shellReady\)[\s\S]{0,700}continue;/.test(SUITE));
  ck('...and says so loudly', /did not finish initialising/.test(SUITE));
  ck('desktop does not wait for a mobile shell', /if \(vp\.m\) \{[\s\S]{0,80}shellReady = await/.test(SUITE));

  console.log('\n' + '='.repeat(74));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE CRASHED:', e && e.stack); process.exit(1); });
