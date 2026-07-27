/* Unit test for sokoni-auth-state.js — THE invariant:
   authentication is authoritative only AFTER resolution; never conclude
   "logged out" while auth is still resolving. Runs the real module under mocked
   browser globals. */
'use strict';
const path = require('path');

/* ── mock browser globals BEFORE requiring the module ── */
const store = {};
global.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
let _onAuth = null;                 /* captured onAuthStateChanged callback         */
global.window = {
  waitForFirebaseReady: (cb) => cb(),               /* firebase "ready" immediately */
  firebaseSDK: { onAuthStateChanged: (cb) => { _onAuth = cb; } },
  firebaseAuth: { currentUser: null },
};
/* alias so the module's bare `window` / `localStorage` resolve */
global.window.localStorage = global.localStorage;

require(path.join(__dirname, '..', 'sokoni-auth-state.js'));
const AS = global.window.SokoniAuthState;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  FAIL:', m); } };

/* ── BEFORE resolution: never authoritative, optimistic from cache ── */
ok(AS && typeof AS.isLoggedIn === 'function', 'SokoniAuthState exposed');
ok(AS.isResolved() === false, 'starts unresolved');

/* unresolved + no cache → not logged in (but also not "authoritatively out") */
ok(AS.isLoggedIn() === false, 'unresolved + empty cache → false');

/* unresolved + cached session → OPTIMISTIC true (must NOT flash login) */
store['loggedIn'] = 'true';
store['sokoniUser'] = JSON.stringify({ uid: 'U1', email: 'a@b.com', name: 'Jane', roles: ['buyer'] });
ok(AS.isLoggedIn() === true, 'unresolved + cached login → optimistic true');
ok(AS.isResolved() === false, 'still unresolved after optimistic read');
const opt = AS.getCurrentSession();
ok(opt && opt.uid === 'U1' && opt.resolved === false, 'optimistic session flagged resolved:false');

/* ── RESOLUTION with a real user → authoritative true ── */
_onAuth({ uid: 'U1', email: 'a@b.com', displayName: 'Jane', emailVerified: true });
ok(AS.isResolved() === true, 'resolved after onAuthStateChanged');
ok(AS.isLoggedIn() === true, 'resolved + user → true');
const s = AS.getCurrentSession();
ok(s.uid === 'U1' && s.resolved === true && s.roles[0] === 'buyer', 'resolved session enriched from cache + resolved:true');

/* ── THE KEY INVARIANT: resolution with NO user is authoritative even if the
      stale loggedIn flag is still set — a genuine logout is not overridden ── */
_onAuth(null);
ok(AS.isLoggedIn() === false, 'resolved + no user → false EVEN WITH stale loggedIn flag');
ok(AS.getCurrentSession() === null, 'resolved + no user → null session');

/* ── whenResolved fires immediately once resolved ── */
let fired = false; AS.whenResolved(() => { fired = true; });
ok(fired === true, 'whenResolved fires immediately when already resolved');

console.log(fail === 0 ? ('\nALL ' + pass + ' PASSED') : ('\n' + pass + ' passed, ' + fail + ' FAILED'));
process.exit(fail === 0 ? 0 : 1);
