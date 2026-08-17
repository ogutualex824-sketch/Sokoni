#!/usr/bin/env node
/* Signup-transaction barrier — the page must not be navigated away while the
 * signup's canonical writes are in flight.
 *
 *   npm run test:signup:barrier
 *
 * WHY THIS EXISTS
 * A signup on the FIXED runtime produced an Auth account whose profile committed
 * server-side but whose consentRecords row was never issued. A Navigation API probe
 * (userInitiated:false) named the initiator:
 *
 *     firebase.js:780 onAuthStateChanged
 *       -> _publishSokoniAuthReady (firebase.js:220)   dispatches 'sokoniAuthReady'
 *         -> auth.js _onReady
 *           -> auth.js _redir -> location.replace('index.html')
 *
 * _alreadyLoggedInGuard bounces an ALREADY-signed-in visitor off the auth forms, and
 * could not tell that apart from "is signing up right now" — which every signup is,
 * because createUserWithEmailAndPassword signs the visitor in as its first act. The
 * page unloaded before _doSignup resumed, so the consent write never ran. Across the
 * whole account population, consentRecords held zero rows.
 *
 * WHAT THIS TESTS
 * The REAL source: the region between the SIGNUP-TXN-BARRIER markers in auth.js is
 * extracted and executed under mocked browser globals. It is not a re-implementation,
 * so it cannot drift from the shipped code, and deleting or renaming the markers
 * fails the suite rather than silently skipping it.
 *
 * The negative control is the point. Asserting "no redirect happened" proves nothing
 * unless the same harness DOES redirect when the barrier is removed — so the last
 * section neuters the barrier condition in the extracted source and requires the
 * failure to come back.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 90) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log('\n── ' + t + ' ──');

const AUTH_SRC = fs.readFileSync(path.join(ROOT, 'auth.js'), 'utf8');

/* ── extract the region under test ──────────────────────────────────────────── */
const BEGIN = 'SIGNUP-TXN-BARRIER:BEGIN';
const END = 'SIGNUP-TXN-BARRIER:END';
const iB = AUTH_SRC.indexOf(BEGIN), iE = AUTH_SRC.indexOf(END);
if (iB < 0 || iE < 0 || iE < iB) {
  console.error('FATAL: barrier markers missing from auth.js — the guard region could not be located.');
  process.exit(1);
}
/* Cut at the OPENING of each marker comment. Slicing to the END marker's index lands
   inside that comment and leaves `/*` unterminated, which fails as a syntax error
   rather than as a test result. */
const REGION = AUTH_SRC.slice(AUTH_SRC.lastIndexOf('/*', iB), AUTH_SRC.lastIndexOf('/*', iE));

/* ── harness: run the region with mocked browser globals ────────────────────── */
function runRegion(src, opts) {
  opts = opts || {};
  const nav = [];                       /* every navigation the region attempts   */
  const listeners = {};
  const store = { local: Object.assign({}, opts.localStorage), session: Object.assign({}, opts.sessionStorage) };
  const mk = (bag) => ({
    getItem: (k) => (k in bag ? bag[k] : null),
    setItem: (k, v) => { bag[k] = String(v); },
    removeItem: (k) => { delete bag[k]; },
  });

  const documentMock = {
    addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
    removeEventListener: (ev, fn) => {
      if (!listeners[ev]) return;
      listeners[ev] = listeners[ev].filter((f) => f !== fn);
    },
  };
  const locationMock = {
    pathname: opts.pathname || '/signup.html',
    search: opts.search || '',
    replace: (u) => nav.push({ how: 'replace', to: u }),
    set href(u) { nav.push({ how: 'href', to: u }); },
    get href() { return locationMock.pathname; },
  };
  /* The source navigates via `window.location.replace(...)`, so the window mock must
     carry the same location object the bare `location` binding resolves to. */
  const windowMock = { location: locationMock };
  const consoleMock = { info: () => {}, warn: () => {}, error: () => {}, log: () => {} };

  const fn = new Function(
    'window', 'document', 'location', 'localStorage', 'sessionStorage', 'console', 'URLSearchParams', 'Date',
    src + '\n;return { txn: (typeof _sokoniSignupTxn !== "undefined" ? _sokoniSignupTxn : null) };'
  );
  const out = fn(windowMock, documentMock, locationMock, mk(store.local), mk(store.session),
                 consoleMock, URLSearchParams, Date);

  return {
    nav,
    txn: out.txn || windowMock.SokoniSignupTxn,
    fire: (ev, detail) => (listeners[ev] || []).slice().forEach((f) => f({ detail: detail })),
    hasListener: (ev) => !!(listeners[ev] && listeners[ev].length),
  };
}

/* ══ 1 · the barrier exists and is wired to the transaction ══ */
head('1 · the guard region exposes a signup transaction');
const base = runRegion(REGION, { pathname: '/signup.html' });
ck('region executes under mocked globals', !!base.txn);
ck('transaction starts inactive', base.txn.isActive() === false);
ck('the guard registered a sokoniAuthReady listener', base.hasListener('sokoniAuthReady'));

/* ══ 2 · signup in flight — the slow path must NOT redirect ══ */
head('2 · sokoniAuthReady does not eject a signup in flight');
const inflight = runRegion(REGION, { pathname: '/signup.html' });
inflight.txn.begin();
inflight.fire('sokoniAuthReady', { uid: 'U_SIGNUP' });
ck('no navigation while the transaction is open', inflight.nav.length === 0, JSON.stringify(inflight.nav));
ck('the suppression was counted, not silently dropped', inflight.txn.deferredCount() === 1);

/* ══ 3 · signup in flight — the FAST path must NOT redirect either ══
   The fast path is DOMContentLoaded -> _redir when localStorage.loggedIn is already
   'true'. firebase.js writes loggedIn='true' during signup, so this route is live for
   a second signup attempt in the same browser, not theoretical. */
head('3 · the DOMContentLoaded fast path does not eject a signup in flight');
const fastInflight = runRegion(REGION, { pathname: '/signup.html', localStorage: { loggedIn: 'true' } });
ck('fast path armed (DOMContentLoaded listener registered)', fastInflight.hasListener('DOMContentLoaded'));
fastInflight.txn.begin();
fastInflight.fire('DOMContentLoaded');
ck('no navigation via the fast path while in flight', fastInflight.nav.length === 0, JSON.stringify(fastInflight.nav));

/* ══ 4 · the marker clears — success and failure ══ */
head('4 · the transaction always ends');
const done = runRegion(REGION, { pathname: '/signup.html' });
done.txn.begin(); done.txn.end();
ck('end() lowers the marker', done.txn.isActive() === false);
done.txn.begin(); done.txn.end(); done.txn.end();
ck('end() is idempotent (success path + finally both call it)', done.txn.isActive() === false);
done.fire('sokoniAuthReady', { uid: 'U_AFTER' });
ck('a redirect after the transaction ends is NOT suppressed', done.nav.length === 1, JSON.stringify(done.nav));

/* auth.js must call begin() before account creation and end() in BOTH paths. */
const SIGNUP_SRC = AUTH_SRC.slice(AUTH_SRC.indexOf('async function _doSignup'));
const iBegin = SIGNUP_SRC.indexOf('_sokoniSignupTxn.begin()');
const iCreate = SIGNUP_SRC.indexOf('createUserWithEmailAndPassword(');
const iConsent = SIGNUP_SRC.indexOf("collection(window.firebaseDB, 'consentRecords')");
const iEnd = SIGNUP_SRC.indexOf('_sokoniSignupTxn.end()', iConsent);
ck('begin() precedes createUserWithEmailAndPassword', iBegin > -1 && iCreate > iBegin);
ck('end() comes AFTER the consentRecords write', iEnd > iConsent);
ck('end() also runs in a finally (failure can never strand the marker)',
   /finally\s*\{[\s\S]{0,600}?_sokoniSignupTxn\.end\(\)/.test(SIGNUP_SRC));

/* ══ 5 · normal login is untouched ══ */
head('5 · login still redirects when no signup is in flight');
const login = runRegion(REGION, { pathname: '/login.html' });
login.fire('sokoniAuthReady', { uid: 'U_LOGIN' });
ck('login redirects normally', login.nav.length === 1 && login.nav[0].how === 'replace', JSON.stringify(login.nav));
ck('...to the stored destination when present', (() => {
  const l = runRegion(REGION, { pathname: '/login.html', sessionStorage: { sokoniLoginRedirect: 'wallet.html' } });
  l.fire('sokoniAuthReady', { uid: 'U2' });
  return l.nav.length === 1 && l.nav[0].to === 'wallet.html';
})());
/* loginUser performs its OWN redirect and does not depend on this guard — that is
   what makes a signup-scoped barrier safe for login. */
ck('loginUser owns its redirect independently of the guard',
   /const _safeRedir = _sokoniLoginRedirect\(\);[\s\S]{0,200}?window\.location\.href = _safeRedir/.test(AUTH_SRC));

/* ══ 6 · content pages are still exempt ══ */
head('6 · the guard still only applies to the auth forms');
const content = runRegion(REGION, { pathname: '/inventory.html', localStorage: { loggedIn: 'true' } });
content.fire('sokoniAuthReady', { uid: 'U3' });
ck('a content page registers no redirect', content.nav.length === 0 && !content.hasListener('sokoniAuthReady'));

/* ══ 7 · NEGATIVE CONTROL — remove the barrier, the bug must return ══
   Without this the whole suite could pass against a harness that never navigates
   at all. Neuter only the barrier predicate and require the failure back. */
head('7 · negative control — without the barrier the redirect returns');
const NEUTERED = REGION.replace('if (_sokoniSignupTxn.isActive()) {', 'if (false) {');
ck('the barrier predicate was actually removed for this run', NEUTERED !== REGION);
const broken = runRegion(NEUTERED, { pathname: '/signup.html' });
broken.txn.begin();
broken.fire('sokoniAuthReady', { uid: 'U_SIGNUP' });
ck('un-barriered guard DOES navigate mid-signup (reproduces the defect)',
   broken.nav.length === 1, JSON.stringify(broken.nav));
ck('...and it navigates to index.html, as measured in production',
   broken.nav.length === 1 && broken.nav[0].to === 'index.html');

console.log('\n' + '='.repeat(70));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
