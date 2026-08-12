/* ══════════════════════════════════════════════════════════════════════════════
   AUTH SLICE 5 — session-transition safety
   ------------------------------------------------------------------------------
   THE INVARIANT
     Application access is derived from CURRENT Firebase Auth state, never from cached
     verification or session state.

   Everything below is a way of trying to break that. Each scenario builds real tabs —
   separate vm contexts sharing one localStorage, with storage events crossing between
   them exactly as a browser delivers them (to every tab EXCEPT the writer) — and runs
   the shipped sokoni-verify-gate.js and sokoni-verify-screen.js inside them.

   A "refresh", "back/forward" and "typed URL" are all the same thing to this model: a
   fresh context over the same storage. That is not a simplification — it is precisely
   why the gate was put at onAuthStateChanged, which every one of them re-runs.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const GATE = read('sokoni-verify-gate.js');
const POLICY = read('sokoni-verify-policy.js');
const SCREEN = read('sokoni-verify-screen.js');

let pass = 0, fail = 0;
const failures = [];
function ok(label, cond, detail) {
  if (cond) { pass++; return true; }
  fail++; failures.push(label + (detail ? '  → ' + detail : ''));
  return false;
}
const eq = (l, a, e) => ok(l, a === e, 'expected ' + JSON.stringify(e) + ', got ' + JSON.stringify(a));
const head = (t) => console.log('\n\x1b[1m' + t + '\x1b[0m');

/* ── a browser: one storage, many tabs ───────────────────────────────────────── */
function makeBrowser() {
  const store = new Map();
  const tabs = [];

  function storageFor(tab) {
    return {
      getItem: (k) => (store.has(String(k)) ? store.get(String(k)) : null),
      setItem(k, v) {
        const key = String(k), val = String(v), old = store.has(key) ? store.get(key) : null;
        store.set(key, val);
        broadcast(tab, key, old, val);
      },
      removeItem(k) {
        const key = String(k), old = store.has(key) ? store.get(key) : null;
        store.delete(key);
        broadcast(tab, key, old, null);
      },
      clear() { store.clear(); },
    };
  }

  /* A storage event reaches every tab EXCEPT the one that wrote. Getting that backwards
     would make a tab react to itself and hide the cross-tab bug entirely.

     And it fires ONLY when the stored value actually changed — removing a key that was
     not there is not an event. That is the spec, and it is load-bearing: without it two
     watching tabs ping-pong forever, each one's no-op removeItem waking the other. The
     first version of this harness got it wrong and hung the suite, which is a fault in
     the model rather than in the gate — but a browser that behaved this way would hang
     the product too, so it is worth stating rather than quietly fixing. */
  function broadcast(from, key, oldValue, newValue) {
    if (oldValue === newValue) return;
    tabs.forEach((t) => {
      if (t === from) return;
      (t._listeners.storage || []).forEach((fn) => {
        try { fn({ key, oldValue, newValue }); } catch (e) { }
      });
    });
  }

  function openTab(opts) {
    opts = opts || {};
    const tab = { _listeners: {}, reloads: 0, nav: [], name: opts.name || ('tab' + tabs.length) };
    const docListeners = {};

    const byId = new Map();
    function mkEl(id) {
      const el = {
        id, textContent: '', disabled: false, style: {}, className: '',
        classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
                     contains(c) { return this._s.has(c); } },
        closest() { return null; },
        set innerHTML(v) { this._h = v; const re = /id="([^"]+)"/g; let m;
                           while ((m = re.exec(String(v)))) if (!byId.has(m[1])) mkEl(m[1]); },
        get innerHTML() { return this._h || ''; },
      };
      byId.set(id, el);
      return el;
    }
    mkEl('skvMount');

    const w = {
      document: {
        documentElement: { dataset: { requireAuth: opts.protectedPage ? 'true' : 'false' } },
        visibilityState: 'visible',
        getElementById: (id) => byId.get(id) || null,
        addEventListener: (t, fn) => { (docListeners[t] = docListeners[t] || []).push(fn); },
        dispatchEvent: () => true,
      },
      addEventListener: (t, fn) => { (tab._listeners[t] = tab._listeners[t] || []).push(fn); },
      location: {
        pathname: opts.pathname || '/wallet.html', search: '',
        replace: (u) => tab.nav.push(u), href: '',
        reload: () => { tab.reloads++; },
      },
      sessionStorage: (() => { const m = new Map(); return {
        getItem: (k) => (m.has(String(k)) ? m.get(String(k)) : null),
        setItem: (k, v) => m.set(String(k), String(v)),
        removeItem: (k) => m.delete(String(k)) }; })(),
      CustomEvent: function (t, i) { this.type = t; this.detail = i && i.detail; },
      console: { log() { }, warn() { }, error() { } },
      setInterval: () => ({ unref() { } }), clearInterval() { },
      module: { exports: {} },
      SokoniOtp: { mount: () => ({ value: () => '', clear() { }, focus() { }, error() { }, destroy() { } }) },
    };
    w.localStorage = storageFor(tab);
    tab._docListeners = docListeners;
    tab.byId = byId;

    vm.createContext(w); w.window = w;
  /* AUTH SLICE 6A — these suites test the GATE MECHANISM, which sits below the rollout
     policy. The shipped policy default is enforcement OFF (the sentinel), so without
     this the gate would correctly refuse to gate anyone and every scenario here would
     fail for a reason that has nothing to do with what it is testing.

     So enforcement is switched ON for these contexts with a long-past cutoff, and the
     shipped default is asserted separately. Test users carry a creationTime after that
     cutoff for the same reason — an undateable account is deliberately grandfathered. */
    vm.runInContext(POLICY, w, { filename: 'sokoni-verify-policy.js' });
    w.SokoniVerifyPolicy.CUTOFF_ISO = '2000-01-01T00:00:00.000Z';
    vm.runInContext(GATE, w, { filename: 'sokoni-verify-gate.js' });
    if (opts.withScreen) vm.runInContext(SCREEN, w, { filename: 'sokoni-verify-screen.js' });

    tab.w = w;
    tab.gate = w.SokoniVerifyGate;
    tab.screen = w.SokoniVerifyScreen;
    tab.gate._reloadOverride = () => { tab.reloads++; };
    tab.focus = () => (docListeners.visibilitychange || []).forEach((fn) => fn());
    tabs.push(tab);
    return tab;
  }

  return { openTab, store, tabs };
}

function makeUser(o) {
  o = o || {};
  const u = {
    uid: o.uid || 'u1', email: 'email' in o ? o.email : 'a@b.c',
    emailVerified: !!o.emailVerified,
    providerData: (o.providers || ['password']).map((id) => ({ providerId: id })),
    /* dated after the suite's cutoff — an undateable account is grandfathered by
       design, which would quietly disarm every scenario below */
    metadata: { creationTime: o.created || '2020-06-01T00:00:00.000Z' },
    reloadCalls: 0,
  };
  u.reload = function () {
    u.reloadCalls++;
    if (o.server && o.server.verified) u.emailVerified = true;
    return Promise.resolve();
  };
  return u;
}

(async function run() {

  /* ══ 1 · refresh while unverified ════════════════════════════════════════ */
  head('1 · refresh while unverified — still gated, every time');
  {
    const b = makeBrowser();
    const held = makeUser({});
    for (let i = 1; i <= 3; i++) {
      const t = b.openTab({ protectedPage: true });
      const r = await t.gate.enforce(held);
      ok('1.' + i + ' refresh #' + i + ' is gated', r.gated === true);
      eq('1.' + i + 'b no session survives the refresh', b.store.get('loggedIn'), undefined);
    }
    ok('1.4 the verdict came from Firebase each time, not a cache', held.reloadCalls === 3,
       'reloads=' + held.reloadCalls);
  }

  /* ══ 2 · refresh after successful verification ═══════════════════════════ */
  head('2 · refresh after verification — through, and it stays through');
  {
    const b = makeBrowser();
    const done = makeUser({ emailVerified: true });
    for (let i = 1; i <= 3; i++) {
      const t = b.openTab({ protectedPage: true });
      const r = await t.gate.enforce(done);
      ok('2.' + i + ' refresh #' + i + ' passes', r.gated === false);
      eq('2.' + i + 'b ...and is not redirected', t.nav.length, 0);
    }
    eq('2.4 a verified user is never made to wait on the network', done.reloadCalls, 0);
  }

  /* ══ 3 · sign-out during verification ════════════════════════════════════ */
  head('3 · sign-out while the screen is open');
  {
    const b = makeBrowser();
    const t = b.openTab({ protectedPage: false, withScreen: true });
    const u = makeUser({});
    await t.gate.enforce(u);
    ok('3.1 the challenge marker exists while held', t.gate.isPending() === true);

    /* The screen is open for u1; Firebase then reports signed out. */
    t.screen._state.host = t.byId.get('skvMount');
    t.screen._state.user = u;
    const torn = t.screen.onAuthChange(null);
    ok('3.2 the screen tears itself down on sign-out', torn === true);
    eq('3.3 ...and stops holding the departed user', t.screen._state.user, null);

    t.gate.clearPending();
    ok('3.4 the marker does not outlive the session', t.gate.isPending() === false);

    const after = await t.gate.recheck('signed-out');
    eq('3.5 rechecking with no user grants nothing', after.gated, false);
    eq('3.6 ...and creates no session', b.store.get('loggedIn'), undefined);
  }

  /* ══ 4 · switching accounts ══════════════════════════════════════════════ */
  head('4 · switching accounts — the verdict follows the new account');
  {
    const b = makeBrowser();
    const t = b.openTab({ protectedPage: true, withScreen: true });

    const alice = makeUser({ uid: 'alice', emailVerified: true });
    const r1 = await t.gate.enforce(alice);
    eq('4.1 verified Alice passes', r1.gated, false);

    const bob = makeUser({ uid: 'bob', emailVerified: false });
    const r2 = await t.gate.enforce(bob);
    eq('4.2 unverified Bob is gated on the same tab', r2.gated, true);
    ok('4.3 ...and Bob got his OWN server refresh', bob.reloadCalls === 1);

    /* A screen opened for Alice must not stay up for Bob. */
    t.screen._state.host = t.byId.get('skvMount');
    t.screen._state.user = alice;
    ok('4.4 a screen opened for the previous account is torn down',
       t.screen.onAuthChange(bob) === true);
    ok('4.5 ...but the SAME account does not retrigger a teardown', (() => {
      t.screen._state.host = t.byId.get('skvMount');
      t.screen._state.user = bob;
      return t.screen.onAuthChange(bob) === false;
    })());

    /* And back to Alice: being gated once must not stick to the account. */
    const r3 = await t.gate.enforce(alice);
    eq('4.6 switching back to verified Alice passes again', r3.gated, false);
  }

  /* ══ 5 · expired challenge, live Firebase session ════════════════════════ */
  head('5 · an expired challenge does not become access');
  {
    const b = makeBrowser();
    const t = b.openTab({ protectedPage: true });
    const u = makeUser({});                       /* server never verifies */
    await t.gate.enforce(u);

    /* Before installing a watcher, recheck cannot know who is signed in — and must say
       so rather than answering "not gated", which would read as a clearance. */
    const blind = await t.gate.recheck('no-watcher');
    ok('5.0 recheck without a watcher reports UNKNOWN, not "not gated"', blind.unknown === true);
    ok('5.0b ...and does not discard the pending marker it cannot evaluate',
       t.gate.isPending() === true);
    t.gate.watch(() => u);

    /* Time passes, the challenge expires, the Firebase session is still perfectly alive.
       The gate reads emailVerified — not the challenge — so nothing changes. */
    for (let i = 0; i < 3; i++) {
      const r = await t.gate.recheck('expired-challenge');
      eq('5.' + (i + 1) + ' still gated after the challenge expired', r.gated, true);
    }
    eq('5.4 no session appeared', b.store.get('loggedIn'), undefined);
    ok('5.5 the gate never consulted the challenge document',
       !/authEmailChallenges/.test(GATE));
  }

  /* ══ 6 · stale cached emailVerified ══════════════════════════════════════ */
  head('6 · stale caches cannot decide anything');
  {
    const b = makeBrowser();
    const t = b.openTab({ protectedPage: true });

    /* A cached profile insisting the account is verified. */
    b.store.set('sokoniUser', JSON.stringify({ uid: 'u1', emailVerified: true, verified: true }));
    b.store.set('loggedIn', 'true');
    const u = makeUser({});                        /* Firebase says otherwise */
    const r = await t.gate.enforce(u);
    eq('6.1 the cached profile is ignored — still gated', r.gated, true);
    eq('6.2 ...and the lying cache is removed', b.store.get('sokoniUser'), undefined);
    eq('6.3 ...along with the session flag', b.store.get('loggedIn'), undefined);

    /* The reverse: a cache saying UNVERIFIED must not gate a verified account. */
    const b2 = makeBrowser();
    const t2 = b2.openTab({ protectedPage: true });
    b2.store.set('sokoniUser', JSON.stringify({ uid: 'u1', emailVerified: false }));
    const good = makeUser({ emailVerified: true });
    const r2 = await t2.gate.enforce(good);
    eq('6.4 a stale "unverified" cache cannot gate a verified account', r2.gated, false);
    eq('6.5 ...and does not redirect them', t2.nav.length, 0);
    eq('6.6 ...and their cache is left alone', typeof b2.store.get('sokoniUser'), 'string');
  }

  /* ══ 7 · stale loggedIn ══════════════════════════════════════════════════ */
  head('7 · a stale session flag is not a session');
  {
    const b = makeBrowser();
    const t = b.openTab({ protectedPage: true });
    const u = makeUser({});
    for (let i = 1; i <= 4; i++) {
      b.store.set('loggedIn', 'true');             /* restored, repeatedly */
      const r = await t.gate.enforce(u);
      eq('7.' + i + ' round ' + i + ': still gated', r.gated, true);
      eq('7.' + i + 'b ...flag stripped again', b.store.get('loggedIn'), undefined);
    }
  }

  /* ══ 8 · direct navigation to a protected route ══════════════════════════ */
  head('8 · a typed URL is not a way in');
  {
    const b = makeBrowser();
    for (const p of ['/wallet.html', '/seller.html', '/checkout.html']) {
      const t = b.openTab({ protectedPage: true, pathname: p });
      const r = await t.gate.enforce(makeUser({}));
      ok('8.' + p + ' gated', r.gated === true);
      ok('8.' + p + ' redirected away', t.nav.length === 1 && /login\.html\?verify=1/.test(t.nav[0]),
         t.nav.join(','));
    }
  }

  /* ══ 9 · back / forward ══════════════════════════════════════════════════ */
  head('9 · back and forward re-derive, they do not replay');
  {
    const b = makeBrowser();
    const u = makeUser({});
    /* forward to a protected page, back to a public one, forward again */
    const fwd1 = b.openTab({ protectedPage: true, pathname: '/wallet.html' });
    await fwd1.gate.enforce(u);
    const back = b.openTab({ protectedPage: false, pathname: '/index.html' });
    const rb = await back.gate.enforce(u);
    eq('9.1 the public page is not redirected', back.nav.length, 0);
    eq('9.2 ...but the session is still denied there', rb.gated, true);
    const fwd2 = b.openTab({ protectedPage: true, pathname: '/wallet.html' });
    const rf = await fwd2.gate.enforce(u);
    eq('9.3 going forward again is gated afresh', rf.gated, true);
    eq('9.4 ...and redirected again', fwd2.nav.length, 1);
    eq('9.5 every step asked Firebase', u.reloadCalls, 3);
  }

  /* ══ 10 · multiple tabs ══════════════════════════════════════════════════ */
  head('10 · many tabs, one truth');
  {
    const b = makeBrowser();
    const u = makeUser({});
    const t1 = b.openTab({ protectedPage: true, name: 'A' });
    const t2 = b.openTab({ protectedPage: true, name: 'B' });
    const t3 = b.openTab({ protectedPage: false, name: 'C' });
    const rs = await Promise.all([t1.gate.enforce(u), t2.gate.enforce(u), t3.gate.enforce(u)]);
    ok('10.1 every tab is gated', rs.every((r) => r.gated === true));
    eq('10.2 no tab left a session behind', b.store.get('loggedIn'), undefined);
    eq('10.3 the public tab was not bounced', t3.nav.length, 0);
    ok('10.4 the protected tabs were', t1.nav.length === 1 && t2.nav.length === 1);
  }

  /* ══ 11 · verification completed in ANOTHER tab ══════════════════════════ */
  head('11 · verifying in one tab releases the others');
  {
    const b = makeBrowser();
    const server = { verified: false };
    const uA = makeUser({ uid: 'u1', server });
    const uB = makeUser({ uid: 'u1', server });

    const tabA = b.openTab({ protectedPage: false, name: 'A', withScreen: true });
    const tabB = b.openTab({ protectedPage: false, name: 'B' });
    tabB.gate.watch(() => uB);

    await tabA.gate.enforce(uA);
    await tabB.gate.enforce(uB);
    ok('11.1 both tabs are held', tabA.gate.isPending() && tabB.gate.isPending());
    eq('11.2 tab B has not reloaded', tabB.reloads, 0);

    /* Tab A verifies for real: the server flips the flag, and A announces it. */
    server.verified = true;
    tabA.gate.announce('verified', 'u1');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    ok('11.3 tab B noticed and re-asked Firebase', uB.reloadCalls >= 2, 'reloads=' + uB.reloadCalls);
    ok('11.4 tab B is no longer held', tabB.gate.isPending() === false);
    ok('11.5 tab B reloaded so the session is built by the normal path', tabB.reloads === 1,
       'reloads=' + tabB.reloads);

    /* The announcing tab must not react to its own event — that is what the storage
       event's own semantics give us, and a harness that got it wrong would hide it. */
    eq('11.6 the announcing tab did not react to itself', tabA.reloads, 0);
  }

  /* ══ 12 · failure in one tab, another still open ═════════════════════════ */
  head('12 · a failed verification in one tab changes nothing anywhere');
  {
    const b = makeBrowser();
    const server = { verified: false };
    const uA = makeUser({ uid: 'u1', server });
    const uB = makeUser({ uid: 'u1', server });
    const tabA = b.openTab({ protectedPage: false, name: 'A' });
    const tabB = b.openTab({ protectedPage: true, name: 'B' });
    tabB.gate.watch(() => uB);

    tabA.gate.watch(() => uA);
    await tabA.gate.enforce(uA);
    await tabB.gate.enforce(uB);
    const bReloadsBefore = tabB.reloads;

    /* Tab A enters a wrong code. Nothing is announced — the screen only announces after
       a PROVEN verification — so nothing anywhere may change. */
    const rA = await tabA.gate.recheck('after-failed-attempt');
    eq('12.1 tab A is still gated', rA.gated, true);
    eq('12.2 tab B did not reload', tabB.reloads, bReloadsBefore);
    ok('12.3 tab B is still held', tabB.gate.isPending() === true);
    eq('12.4 no session appeared anywhere', b.store.get('loggedIn'), undefined);

    ok('12.5 the screen announces ONLY after the refreshed token agreed',
       /verified[\s\S]{0,80}?announce|announce\([\s\S]{0,40}verified/.test(
         SCREEN.slice(SCREEN.indexOf('function _complete'), SCREEN.indexOf('function _navigate'))) &&
       SCREEN.indexOf('announce') > SCREEN.indexOf('emailVerified === true'));
  }

  /* ══ 13 · the two anti-cases, stated explicitly ══════════════════════════ */
  head('13 · the two directions the invariant must hold');
  {
    /* (a) A verified account must never be gated by a stale cache. */
    const b = makeBrowser();
    const t = b.openTab({ protectedPage: true });
    b.store.set('sokoniVerifyEventStale', 'x');
    t.w.sessionStorage.setItem('sokoniVerifyPending', JSON.stringify({ uid: 'u1' }));
    b.store.set('sokoniUser', JSON.stringify({ uid: 'u1', emailVerified: false }));
    const good = makeUser({ emailVerified: true });
    const r = await t.gate.enforce(good);
    eq('13a.1 a verified account is NOT gated by a stale pending marker', r.gated, false);
    eq('13a.2 ...the stale marker is cleared', t.gate.isPending(), false);
    eq('13a.3 ...and no redirect happened', t.nav.length, 0);
    eq('13a.4 ...and no network round trip was spent', good.reloadCalls, 0);

    /* (b) An unverified account must never regain access by restoring cached state. */
    const b2 = makeBrowser();
    const t2 = b2.openTab({ protectedPage: true });
    const bad = makeUser({});
    const RESTORE = () => {
      b2.store.set('loggedIn', 'true');
      b2.store.set('sokoniUser', JSON.stringify({ uid: 'u1', emailVerified: true, roles: ['buyer'] }));
      b2.store.set('sokoniSession_v2', JSON.stringify({ uid: 'u1', expires: Date.now() + 1e9 }));
    };
    for (let i = 1; i <= 3; i++) {
      RESTORE();
      const rr = await t2.gate.enforce(bad);
      eq('13b.' + i + ' restore attempt ' + i + ' is still gated', rr.gated, true);
      eq('13b.' + i + 'a loggedIn stripped', b2.store.get('loggedIn'), undefined);
      eq('13b.' + i + 'b cached profile stripped', b2.store.get('sokoniUser'), undefined);
    }
    /* And via the recheck path, which is what a storage event triggers. */
    RESTORE();
    t2.gate.watch(() => bad);
    const rr = await t2.gate.recheck('restore');
    eq('13b.4 restoring cache and firing a storage event grants nothing', rr.gated, true);
    eq('13b.5 ...loggedIn stripped again', b2.store.get('loggedIn'), undefined);
  }

  /* ══ 14 · the invariant, structurally ════════════════════════════════════ */
  head('14 · the invariant holds in the source, not just in the scenarios');
  {
    const code = GATE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const decision = code.slice(code.indexOf('function needsVerification'), code.indexOf('function _refresh'));
    ok('14.1 the decision reads no storage', !/localStorage|sessionStorage/.test(decision));
    ok('14.2 the decision reads no cached profile', !/sokoniUser|loggedIn/.test(decision));
    ok('14.3 the gate never writes a session', !/setItem\((["'])loggedIn\1/.test(code));
    ok('14.4 the watcher is given a GETTER, not a captured user',
       /watch\(\s*\(\)\s*=>\s*auth\.currentUser\s*\)/.test(read('firebase.js')));
    ok('14.5 firebase.js clears the marker on sign-out',
       /clearPending\(\)/.test(read('firebase.js')));
    ok('14.6 firebase.js tears the screen down on sign-out',
       /onAuthChange\(null\)/.test(read('firebase.js')));
    ok('14.7 recheck asks the gate, never a cache',
       /function recheck[\s\S]{0,700}?enforce\(user\)/.test(code));
  }

  /* ══ 15 · positive controls ══════════════════════════════════════════════ */
  head('15 · positive controls');
  {
    function mutantTab(from, to) {
      ok('15·  mutation target present: ' + from.slice(0, 34), GATE.indexOf(from) >= 0);
      const b = makeBrowser();
      const t = b.openTab({ protectedPage: true });
      const w = t.w;
      /* re-run a mutated gate over the same context */
      vm.runInContext(GATE.replace(from, to), w, { filename: 'mutant.js' });
      t.gate = w.SokoniVerifyGate;
      t.gate._reloadOverride = () => { t.reloads++; };
      return { b, t };
    }

    /* Trust the cached profile instead of the Auth object. */
    const m1 = mutantTab('if (user.emailVerified === true) return false;',
                         'if (user.emailVerified === true) return false;\n    try { if (JSON.parse(global.localStorage.getItem("sokoniUser")||"{}").emailVerified) return false; } catch(e){}');
    m1.b.store.set('sokoniUser', JSON.stringify({ emailVerified: true }));
    const r1 = await m1.t.gate.enforce(makeUser({}));
    eq('15.1 the mutant lets a lying cache through — so 6.1 really bites', r1.gated, false);

    /* Stop stripping the session flag. */
    const m2 = mutantTab("global.localStorage.removeItem('loggedIn');", '');
    m2.b.store.set('loggedIn', 'true');
    await m2.t.gate.enforce(makeUser({}));
    eq('15.2 the mutant leaves a restored flag in place — so 7/13b really bite',
       m2.b.store.get('loggedIn'), 'true');

    /* Never recover a held tab — the cross-tab bug this slice exists to fix. */
    const b3 = makeBrowser();
    const server = { verified: false };
    const uB = makeUser({ uid: 'u1', server });
    const tA = b3.openTab({ name: 'A' });
    const tB = b3.openTab({ name: 'B' });
    vm.runInContext(GATE.replace('if (!res.gated && wasPending) {', 'if (false) {'), tB.w,
                    { filename: 'mutant3.js' });
    tB.gate = tB.w.SokoniVerifyGate;
    tB.gate._reloadOverride = () => { tB.reloads++; };
    tB.gate.watch(() => uB);
    await tB.gate.enforce(uB);
    server.verified = true;
    tA.gate.announce('verified', 'u1');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    eq('15.3 the mutant strands the second tab — so 11.5 really bites', tB.reloads, 0);
  }

  /* ── result ────────────────────────────────────────────────────────────── */
  console.log('\n' + '─'.repeat(70));
  if (fail) { console.log('\x1b[31mFAILURES\x1b[0m'); failures.forEach((f) => console.log('  ✗ ' + f)); }
  console.log((fail ? '\x1b[31m' : '\x1b[32m') + 'auth session transitions: ' + pass + '/' + (pass + fail) + '\x1b[0m');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
