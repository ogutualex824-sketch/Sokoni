/* ══════════════════════════════════════════════════════════════════════════════
   AUTH — verification landing path   (Finding 1 from the auth-flow review)
   ------------------------------------------------------------------------------
   The gate redirects a held user to login.html?verify=1&next=…, sets
   sokoniVerifyPending and dispatches sokoniVerificationRequired. Nothing consumed any
   of the three, so the user landed on an ordinary login form — still signed in to
   Firebase, with no explanation — and had to retype the password they had just used.

   THE THING THIS SUITE EXISTS TO PROVE
   ------------------------------------
   The landing opens on the GATE'S VERDICT, never on the marker or the URL. A forged
   sokoniVerifyPending, or a hand-typed ?verify=1, must produce nothing — and must never
   be mistaken for evidence about verification. Block D is that proof; block G mutates
   the trigger to confirm block D is not decorative.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SCREEN = read('sokoni-verify-screen.js');
const GATE = read('sokoni-verify-gate.js');
const POLICY = read('sokoni-verify-policy.js');

let pass = 0, fail = 0;
const failures = [];
function ok(label, cond, detail) {
  if (cond) { pass++; return true; }
  fail++; failures.push(label + (detail ? '  → ' + detail : ''));
  return false;
}
const eq = (l, a, e) => ok(l, a === e, 'expected ' + JSON.stringify(e) + ', got ' + JSON.stringify(a));
const head = (t) => console.log('\n\x1b[1m' + t + '\x1b[0m');

/* ── a login.html-shaped page ────────────────────────────────────────────────── */
function makePage(opts) {
  opts = opts || {};
  const calls = [];
  const docListeners = {};
  const winListeners = {};
  const byId = new Map();
  const store = new Map();

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
  if (opts.hasMount !== false) mkEl('skvMount');

  const w = {
    document: {
      documentElement: { dataset: { requireAuth: 'false' } },
      readyState: opts.readyState || 'complete',
      visibilityState: 'visible',
      getElementById: (id) => byId.get(id) || null,
      addEventListener: (t, fn) => { (docListeners[t] = docListeners[t] || []).push(fn); },
      dispatchEvent: (e) => { (docListeners[e.type] || []).forEach((fn) => fn(e)); return true; },
    },
    addEventListener: (t, fn) => { (winListeners[t] = winListeners[t] || []).push(fn); },
    localStorage: {
      getItem: (k) => (store.has(String(k)) ? store.get(String(k)) : null),
      setItem: (k, v) => store.set(String(k), String(v)),
      removeItem: (k) => store.delete(String(k)),
    },
    sessionStorage: (() => { const m = new Map(); return {
      getItem: (k) => (m.has(String(k)) ? m.get(String(k)) : null),
      setItem: (k, v) => m.set(String(k), String(v)),
      removeItem: (k) => m.delete(String(k)), _m: m }; })(),
    location: { pathname: '/login.html', search: opts.search || '', replace() { }, href: '' },
    CustomEvent: function (t, i) { this.type = t; this.detail = i && i.detail; },
    console: { log() { }, warn() { }, error() { } },
    setInterval: () => ({ unref() { } }), clearInterval() { },
    setTimeout: (fn) => { fn(); return 0; },     /* run the reconciler synchronously */
    module: { exports: {} },
    SokoniOtp: { mount: () => ({ value: () => '', clear() { }, focus() { }, error() { }, destroy() { } }) },
    sokoniCallable: () => (payload) => {
      calls.push(payload.op);
      const plan = {
        emailChallengeStatus: { ok: true, emailVerified: false, emailHint: 'a••@b.c', challenge: null },
        emailChallengeIssue: { ok: true, delivered: true, cooldownMs: 60000 },
      };
      return Promise.resolve({ data: plan[payload.op] });
    },
    /* auth.js's single copy of the open-redirect rule, as the page would provide it. */
    _sokoniLoginRedirect: opts.noHelper ? undefined : function (peek, raw) {
      const v = raw != null && raw !== '' ? String(raw) : 'index.html';
      return /^[a-zA-Z0-9_\-\.\/\?=&%#]+$/.test(v) && !v.includes('//') ? v : 'index.html';
    },
  };

  vm.createContext(w); w.window = w;
  vm.runInContext(POLICY, w, { filename: 'policy.js' });
  w.SokoniVerifyPolicy.CUTOFF_ISO = opts.cutoff || '2000-01-01T00:00:00.000Z';
  vm.runInContext(GATE, w, { filename: 'gate.js' });
  vm.runInContext(opts.screenSrc || SCREEN, w, { filename: 'screen.js' });

  return {
    w, calls, byId, store, docListeners, winListeners,
    /* The reconciler hangs off sokoniFirebaseReady — the signal that means Firebase is
       actually up. Firing "load" alone would prove nothing about the path the product uses. */
    fireReady: () => (docListeners.sokoniFirebaseReady || []).forEach((fn) => fn()),
    fireLoad: () => (winListeners.load || []).forEach((fn) => fn()),
    isOpen: () => !!(byId.get('skvMount') && /skvOtp/.test(byId.get('skvMount').innerHTML)),
  };
}

function user(o) {
  o = o || {};
  const u = {
    uid: o.uid || 'u1', email: 'a@b.c', emailVerified: !!o.emailVerified,
    providerData: (o.providers || ['password']).map((id) => ({ providerId: id })),
    metadata: { creationTime: o.created || '2020-06-01T00:00:00.000Z' },
    reloadCalls: 0,
  };
  u.reload = function () { u.reloadCalls++; return Promise.resolve(); };
  return u;
}
const settle = () => new Promise((r) => setImmediate(r));

(async function run() {

  /* ══ A · the event opens the screen ══════════════════════════════════════ */
  head('A · a held user landing on login.html gets the challenge, not a login form');
  {
    const p = makePage({ search: '?verify=1&next=%2Fwallet.html%3Ftab%3Dhistory' });
    p.w.firebaseAuth = { currentUser: user({}) };
    ok('A1  nothing is shown before the gate speaks', p.isOpen() === false);

    /* This is what firebase.js does after an authoritative evaluation. */
    await p.w.SokoniVerifyGate.enforce(p.w.firebaseAuth.currentUser, { redirect: false });
    await settle(); await settle();

    ok('A2  the screen opened on the gate event', p.isOpen() === true);
    ok('A3  ...and it asked the server what state to render',
       p.calls[0] === 'emailChallengeStatus', p.calls.join(','));
    ok('A4  the user is NOT looking at the login form — the card was taken over',
       p.byId.get('skvMount').innerHTML.indexOf('Confirm your email') > -1);
  }

  /* ══ B · the destination survives, safely ════════════════════════════════ */
  head('B · ?next= is carried through the shared sanitiser');
  {
    const p = makePage({ search: '?verify=1&next=%2Fwallet.html%3Ftab%3Dhistory' });
    eq('B1  a same-origin path is preserved', p.w.SokoniVerifyScreen._nextFromUrl(),
       '/wallet.html?tab=history');

    for (const [label, raw] of [
      ['absolute http', 'http%3A%2F%2Fevil.test%2Fx'],
      ['absolute https', 'https%3A%2F%2Fevil.test%2Fx'],
      ['protocol-relative', '%2F%2Fevil.test%2Fx'],
      ['javascript:', 'javascript%3Aalert(1)'],
      ['backslash trick', '%5C%5Cevil.test'],
    ]) {
      const q = makePage({ search: '?verify=1&next=' + raw });
      const got = q.w.SokoniVerifyScreen._nextFromUrl();
      ok('B·  ' + label + ' cannot become the destination',
         got === 'index.html' || got === null, String(got));
    }

    const none = makePage({ search: '?verify=1' });
    eq('B7  no next at all → null, and the screen falls back to index.html',
       none.w.SokoniVerifyScreen._nextFromUrl(), null);

    /* If auth.js is not present, the destination is DROPPED rather than trusted — the
       safe direction, and it is why this file carries no second copy of the rule. */
    const bare = makePage({ search: '?verify=1&next=%2Fwallet.html', noHelper: true });
    eq('B8  without the shared sanitiser the destination is dropped, not used raw',
       bare.w.SokoniVerifyScreen._nextFromUrl(), null);
    const screenCode = SCREEN.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    ok('B9  the screen contains no copy of the open-redirect regex',
       !/a-zA-Z0-9_\\-/.test(screenCode));
  }

  /* ══ C · who must NOT see it ═════════════════════════════════════════════ */
  head('C · signed-out, verified and grandfathered users get the ordinary page');
  {
    /* Signed out. */
    const out = makePage({ search: '?verify=1' });
    out.w.firebaseAuth = { currentUser: null };
    out.fireReady(); await settle(); await settle();
    ok('C1  a signed-out visitor sees no verification screen', out.isOpen() === false);
    ok('C2  ...and no server call was made', out.calls.length === 0, out.calls.join(','));

    /* Verified. */
    const ver = makePage({ search: '?verify=1' });
    ver.w.firebaseAuth = { currentUser: user({ emailVerified: true }) };
    await ver.w.SokoniVerifyGate.enforce(ver.w.firebaseAuth.currentUser, { redirect: false });
    ver.fireReady(); await settle(); await settle();
    ok('C3  a verified user is never shown the challenge', ver.isOpen() === false);

    /* Grandfathered — unverified, but the policy does not reach them. */
    const old = makePage({ search: '?verify=1', cutoff: '2026-09-01T00:00:00.000Z' });
    old.w.firebaseAuth = { currentUser: user({ created: '2026-07-01T00:00:00.000Z' }) };
    await old.w.SokoniVerifyGate.enforce(old.w.firebaseAuth.currentUser, { redirect: false });
    old.fireReady(); await settle(); await settle();
    ok('C4  a grandfathered user is not shown the challenge', old.isOpen() === false);
    ok('C5  ...and is not asked anything by the server', old.calls.length === 0, old.calls.join(','));

    /* Google / phone. */
    for (const pr of ['google.com', 'phone']) {
      const g = makePage({ search: '?verify=1' });
      g.w.firebaseAuth = { currentUser: user({ providers: [pr] }) };
      await g.w.SokoniVerifyGate.enforce(g.w.firebaseAuth.currentUser, { redirect: false });
      g.fireReady(); await settle(); await settle();
      ok('C·  ' + pr + ' is never shown the challenge', g.isOpen() === false);
    }
  }

  /* ══ D · THE MARKER IS NOT EVIDENCE ══════════════════════════════════════ */
  head('D · a forged marker or URL grants nothing');
  {
    /* Forged pending marker + ?verify=1, but NO user at all. */
    const a = makePage({ search: '?verify=1&next=%2Fwallet.html' });
    a.w.sessionStorage.setItem('sokoniVerifyPending', JSON.stringify({ uid: 'u1' }));
    a.w.firebaseAuth = { currentUser: null };
    a.fireReady(); await settle(); await settle();
    ok('D1  forged marker with no session opens nothing', a.isOpen() === false);
    eq('D2  ...and the orphan marker is cleared',
       a.w.sessionStorage.getItem('sokoniVerifyPending'), null);

    /* Forged marker with a VERIFIED user — the marker must not override Firebase. */
    const b = makePage({ search: '?verify=1' });
    b.w.sessionStorage.setItem('sokoniVerifyPending', JSON.stringify({ uid: 'u1' }));
    b.w.firebaseAuth = { currentUser: user({ emailVerified: true }) };
    b.fireReady(); await settle(); await settle();
    ok('D3  a forged marker cannot summon the challenge for a verified account',
       b.isOpen() === false);

    /* Forged marker with a grandfathered user — policy still wins. */
    const c = makePage({ search: '?verify=1', cutoff: '2026-09-01T00:00:00.000Z' });
    c.w.sessionStorage.setItem('sokoniVerifyPending', JSON.stringify({ uid: 'u1' }));
    c.w.firebaseAuth = { currentUser: user({ created: '2026-07-01T00:00:00.000Z' }) };
    c.fireReady(); await settle(); await settle();
    ok('D4  a forged marker cannot override grandfathering', c.isOpen() === false);

    /* And the decisive one: the landing NEVER creates a session, whatever it opens. */
    const d = makePage({ search: '?verify=1' });
    d.w.firebaseAuth = { currentUser: user({}) };
    await d.w.SokoniVerifyGate.enforce(d.w.firebaseAuth.currentUser, { redirect: false });
    await settle(); await settle();
    ok('D5  the challenge IS shown for a genuinely held user', d.isOpen() === true);
    eq('D6  ...and no session flag was created by showing it', d.store.get('loggedIn'), undefined);
    eq('D7  ...and no cached profile either', d.store.get('sokoniUser'), undefined);

    /* Structural: this file cannot mint a session even if it wanted to. */
    const code = SCREEN.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    ok('D8  the screen never writes loggedIn', !/setItem\((["'])loggedIn\1/.test(code));
    ok('D9  the screen never writes a cached profile', !/setItem\((["'])sokoniUser\1/.test(code));
    ok('D10 the screen never assigns emailVerified', !/emailVerified\s*=(?!=)/.test(code));
  }

  /* ══ E · sign-out and account switching ══════════════════════════════════ */
  head('E · the landing follows the session it was opened for');
  {
    const p = makePage({ search: '?verify=1' });
    const u1 = user({ uid: 'u1' });
    p.w.firebaseAuth = { currentUser: u1 };
    await p.w.SokoniVerifyGate.enforce(u1, { redirect: false });
    await settle(); await settle();
    ok('E1  open for u1', p.isOpen() === true);

    ok('E2  a different account tears it down',
       p.w.SokoniVerifyScreen.onAuthChange(user({ uid: 'u2' })) === true);
    ok('E3  ...and the mount is emptied', p.byId.get('skvMount').innerHTML === '');

    const q = makePage({ search: '?verify=1' });
    const u3 = user({ uid: 'u3' });
    q.w.firebaseAuth = { currentUser: u3 };
    await q.w.SokoniVerifyGate.enforce(u3, { redirect: false });
    await settle(); await settle();
    ok('E4  open for u3', q.isOpen() === true);
    ok('E5  sign-out tears it down', q.w.SokoniVerifyScreen.onAuthChange(null) === true);

    /* Reopening must be possible for the next genuinely-held user. */
    const u4 = user({ uid: 'u4' });
    q.w.firebaseAuth = { currentUser: u4 };
    await q.w.SokoniVerifyGate.enforce(u4, { redirect: false });
    await settle(); await settle();
    ok('E6  a later held user can still be landed', q.isOpen() === true);
  }

  /* ══ F · no double-open, and the reconciler ══════════════════════════════ */
  head('F · idempotence, and the late-load path');
  {
    const p = makePage({ search: '?verify=1' });
    const u = user({});
    p.w.firebaseAuth = { currentUser: u };
    await p.w.SokoniVerifyGate.enforce(u, { redirect: false });
    await settle(); await settle();
    const first = p.calls.length;
    /* Event fires again (a token refresh, another enforce) — must not restart the screen. */
    await p.w.SokoniVerifyGate.enforce(u, { redirect: false });
    await settle(); await settle();
    eq('F1  a second event does not reopen or re-query', p.calls.length, first);

    /* Reconciler path: the screen loads AFTER the gate already ran. */
    const late = makePage({ search: '?verify=1', readyState: 'loading' });
    const lu = user({});
    late.w.firebaseAuth = { currentUser: lu };
    late.w.SokoniVerifyGate.enforce(lu, { redirect: false });
    await settle(); await settle();
    late.fireReady(); await settle(); await settle();
    ok('F2  the reconciler covers a late load', late.isOpen() === true);
    ok('F3  ...having re-derived from Firebase rather than trusting the marker',
       lu.reloadCalls >= 1, 'reloads=' + lu.reloadCalls);

    /* A page with no mount must not throw or half-open. */
    const bare = makePage({ search: '?verify=1', hasMount: false });
    bare.w.firebaseAuth = { currentUser: user({}) };
    await bare.w.SokoniVerifyGate.enforce(bare.w.firebaseAuth.currentUser, { redirect: false });
    bare.fireReady(); await settle(); await settle();
    ok('F4  a page without a mount is unaffected', bare.isOpen() === false);
  }

  /* ══ G · positive controls ═══════════════════════════════════════════════ */
  head('G · positive controls — the marker check must be real');
  {
    /* A FRESH page per mutant. Re-running a mutated screen over a context that already
       ran the real one leaves both sets of listeners registered, and the genuine handler
       quietly repairs what the mutant was supposed to break — G2 passed for that reason
       and proved nothing. */
    function mutant(from, to, opts) {
      ok('G·  mutation target present: ' + from.slice(0, 38), SCREEN.indexOf(from) >= 0);
      return makePage(Object.assign({}, opts, { screenSrc: SCREEN.replace(from, to) }));
    }

    /* Open on the MARKER instead of the gate's verdict — the exact mistake this
       suite exists to forbid. A verified user would be shown a challenge. */
    const m1 = mutant('if (res && res.gated) _landIfHeld(u);', '_landIfHeld(u);',
                      { search: '?verify=1' });
    m1.w.sessionStorage.setItem('sokoniVerifyPending', JSON.stringify({ uid: 'u1' }));
    m1.w.firebaseAuth = { currentUser: user({ emailVerified: true }) };
    m1.fireReady(); await settle(); await settle();
    ok('G1  the mutant shows a verified user the challenge — so D3 really bites',
       m1.isOpen() === true);

    /* Drop the signed-out guard: a marker with no session would open a screen for
       nobody, and the orphan marker would survive. */
    const m2 = mutant('if (!u) { clearPendingIfAny(); return; }', 'if (!u) { return; }',
                      { search: '?verify=1' });
    m2.w.sessionStorage.setItem('sokoniVerifyPending', JSON.stringify({ uid: 'u1' }));
    m2.w.firebaseAuth = { currentUser: null };
    m2.fireReady(); await settle(); await settle();
    ok('G2  the mutant leaves an orphan marker behind — so D2 really bites',
       m2.w.sessionStorage.getItem('sokoniVerifyPending') !== null);

    /* Trust ?next= unsanitised. */
    const m3 = mutant('return global._sokoniLoginRedirect(true, raw);', 'return raw;',
                      { search: '?verify=1&next=https%3A%2F%2Fevil.test%2Fx' });
    eq('G3  the mutant accepts an absolute URL — so B2-B6 really bite',
       m3.w.SokoniVerifyScreen._nextFromUrl(), 'https://evil.test/x');
  }

  /* ══ H · boundary ════════════════════════════════════════════════════════ */
  head('H · nothing outside the landing path moved');
  {
    const cp = require('child_process');
    const changed = cp.execSync('git diff --name-only HEAD', { cwd: ROOT, encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean);

    ok('H1  the policy is untouched', !changed.includes('sokoni-verify-policy.js'), changed.join(', '));
    ok('H2  the server policy is untouched', !changed.includes('functions/auth-policy.js'));
    ok('H3  the gate is untouched', !changed.includes('sokoni-verify-gate.js'));
    ok('H4  the dispatcher is untouched', !changed.includes('functions/auth-dispatch.js'));
    ok('H5  firestore.rules untouched', !changed.includes('firestore.rules'));
    ok('H6  no Stories file touched', !changed.some((f) => /stor(y|ies)/i.test(f)));

    /* Both cutoffs must still be the sentinel. */
    ok('H7  the client cutoff is still the sentinel',
       /CUTOFF_ISO:\s*SENTINEL_ISO/.test(read('sokoni-verify-policy.js')));
    ok('H8  the server cutoff is still the sentinel',
       /CUTOFF_ISO:\s*SENTINEL_ISO/.test(read('functions/auth-policy.js')));
    ok('H9  the sentinel value itself is unchanged on the client',
       /SENTINEL_ISO\s*=\s*'2099-01-01T00:00:00\.000Z'/.test(read('sokoni-verify-policy.js')));
    ok('H10 ...and on the server',
       /SENTINEL_ISO\s*=\s*'2099-01-01T00:00:00\.000Z'/.test(read('functions/auth-policy.js')));

    /* Byte-safety: the two edited files must be pure additions with no EOL flip. */
    for (const f of ['sokoni-verify-screen.js', 'auth.js']) {
      const plain = cp.execSync('git diff --numstat HEAD -- ' + f, { cwd: ROOT, encoding: 'utf8' }).trim();
      const ign = cp.execSync('git diff --ignore-cr-at-eol --numstat HEAD -- ' + f,
                              { cwd: ROOT, encoding: 'utf8' }).trim();
      eq('H11 ' + f + ' carries no line-ending flip', plain, ign);
    }
  }

  console.log('\n' + '─'.repeat(70));
  if (fail) { console.log('\x1b[31mFAILURES\x1b[0m'); failures.forEach((f) => console.log('  ✗ ' + f)); }
  console.log((fail ? '\x1b[31m' : '\x1b[32m') + 'auth verify landing: ' + pass + '/' + (pass + fail) + '\x1b[0m');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
