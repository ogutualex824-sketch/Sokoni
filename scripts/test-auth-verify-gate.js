/* ══════════════════════════════════════════════════════════════════════════════
   AUTH SLICE 3 — login-path gate suite
   ------------------------------------------------------------------------------
   Runs the SHIPPED sokoni-verify-gate.js inside a vm sandbox. Nothing here
   reimplements the rule: if this file passes, that file behaves.

   The wiring blocks (F, G) read firebase.js and auth.js as text, because the thing
   being asserted there is ORDER — that the gate is consulted before a session
   exists. Order is not observable from the gate module alone.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function ok(label, cond, detail) {
  if (cond) { pass++; return true; }
  fail++; failures.push(label + (detail ? '  → ' + detail : ''));
  return false;
}
function eq(label, actual, expected) {
  return ok(label, actual === expected, 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}
function head(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }

/* Extract the { … } block that follows `marker`, by matching braces. Used so the
   wiring assertions test a whole branch instead of an arbitrary character window.
   Returns '' when the marker or its block is absent, which fails the caller loudly
   rather than passing on an empty string. */
function braceBlock(src, marker) {
  const at = src.indexOf(marker);
  if (at < 0) return '';
  const open = src.indexOf('{', at);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return '';
}

/* ── sandbox ──────────────────────────────────────────────────────────────────
   A minimal browser. Storage is real objects so the suite can inspect exactly what
   the gate wrote, and location.replace is recorded rather than performed. */
function makeStorage() {
  const m = new Map();
  return {
    _m: m,
    getItem: (k) => (m.has(String(k)) ? m.get(String(k)) : null),
    setItem: (k, v) => { m.set(String(k), String(v)); },
    removeItem: (k) => { m.delete(String(k)); },
    clear: () => m.clear(),
  };
}

function loadGate(opts) {
  opts = opts || {};
  const events = [];
  const nav = [];
  const doc = {
    documentElement: { dataset: { requireAuth: opts.protectedPage ? 'true' : 'false' } },
    dispatchEvent: (e) => { events.push(e); return true; },
  };

  /* The sandbox IS the window. Handing the gate a separate stub object would let it
     publish its API somewhere the page could never see it — and the suite would still
     pass, which is the wrong kind of green. */
  const win = {
    document: doc,
    localStorage: makeStorage(),
    sessionStorage: makeStorage(),
    location: {
      pathname: opts.pathname || '/dashboard.html',
      search: opts.search || '',
      replace: (u) => { nav.push({ how: 'replace', url: u }); },
      href: '',
    },
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
    console: console,
    module: { exports: {} },
  };
  if (opts.security) win.SokoniSecurity = opts.security;

  vm.createContext(win);
  win.window = win;
  vm.runInContext(read('sokoni-verify-gate.js'), win, { filename: 'sokoni-verify-gate.js' });

  return { gate: win.SokoniVerifyGate, win, doc, events, nav, sandbox: win };
}

/* Fake Firebase User. `reload` is what the server refresh calls; the flag it flips is
   the only way emailVerified may become true, mirroring the Admin SDK write. */
function user(o) {
  o = o || {};
  const u = {
    uid: o.uid || 'uid-1',
    email: 'email' in o ? o.email : 'shopper@example.com',
    emailVerified: !!o.emailVerified,
    providerData: (o.providers || ['password']).map((id) => ({ providerId: id })),
    reloadCalls: 0,
  };
  u.reload = function () {
    u.reloadCalls++;
    if (o.reloadThrows) return Promise.reject(new Error('network'));
    if (o.verifiesOnReload) u.emailVerified = true;
    return Promise.resolve();
  };
  return u;
}

(async function run() {

  /* ══ A · the rule ════════════════════════════════════════════════════════ */
  head('A · needsVerification — the rule, provider by provider');
  {
    const { gate } = loadGate();
    const n = gate.needsVerification;

    ok('A1  unverified password account is gated', n(user({ emailVerified: false })) === true);
    ok('A2  verified password account is not gated', n(user({ emailVerified: true })) === false);
    ok('A3  no user is not gated', n(null) === false);
    ok('A4  no user (undefined) is not gated', n(undefined) === false);

    /* Google / phone stay untouched — the acceptance boundary requires it. */
    ok('A5  google account is never gated', n(user({ providers: ['google.com'] })) === false);
    ok('A6  facebook account is never gated', n(user({ providers: ['facebook.com'] })) === false);
    ok('A7  apple account is never gated', n(user({ providers: ['apple.com'] })) === false);
    ok('A8  phone account is never gated (SMS is the factor)',
       n(user({ providers: ['phone'], email: null })) === false);
    ok('A9  phone account WITH an email is still not gated',
       n(user({ providers: ['phone'] })) === false);
    ok('A10 password+phone is not gated — phone already proved identity',
       n(user({ providers: ['password', 'phone'] })) === false);

    /* Documented, deliberate: password+google with an unproven address IS gated. */
    ok('A11 password+google, flag false, IS gated (documented case)',
       n(user({ providers: ['password', 'google.com'] })) === true);

    ok('A12 password account with no email is not gated (nothing to verify)',
       n(user({ email: null })) === false);
    ok('A13 password account with empty email is not gated',
       n(user({ email: '' })) === false);
    ok('A14 missing providerData does not throw and does not gate',
       n({ uid: 'x', email: 'a@b.c', emailVerified: false }) === false);
    ok('A15 malformed providerData entries are skipped, not thrown on',
       n({ uid: 'x', email: 'a@b.c', emailVerified: false,
           providerData: [null, {}, { providerId: 'password' }] }) === true);

    /* Only a strict true short-circuits — a truthy string must not pass for verified. */
    ok('A16 emailVerified must be exactly true, not merely truthy',
       n({ uid: 'x', email: 'a@b.c', emailVerified: 'yes',
           providerData: [{ providerId: 'password' }] }) === true);
  }

  /* ══ B · evaluate — the server refresh ═══════════════════════════════════ */
  head('B · evaluate — reload only where it can change the answer');
  {
    const { gate } = loadGate();

    const verified = user({ emailVerified: true });
    let r = await gate.evaluate(verified);
    eq('B1  verified → not gated', r.gated, false);
    eq('B2  verified → NO reload (a cached true cannot be a stale false)', verified.reloadCalls, 0);

    const google = user({ providers: ['google.com'] });
    r = await gate.evaluate(google);
    eq('B3  google → not gated', r.gated, false);
    eq('B4  google → no reload, so the gate costs it nothing', google.reloadCalls, 0);

    const stale = user({ emailVerified: false, verifiesOnReload: true });
    r = await gate.evaluate(stale);
    eq('B5  candidate → reload is called', stale.reloadCalls, 1);
    eq('B6  verified elsewhere → gate opens on the fresh flag', r.gated, false);
    eq('B7  ...and says so', r.reason, 'verified-on-reload');

    const unverified = user({ emailVerified: false });
    r = await gate.evaluate(unverified);
    eq('B8  still unverified after reload → gated', r.gated, true);
    eq('B9  machine-readable reason', r.reason, 'email-unverified');
    eq('B10 verdict carries the uid', r.uid, 'uid-1');

    const offline = user({ emailVerified: false, reloadThrows: true });
    r = await gate.evaluate(offline);
    eq('B11 reload failure fails CLOSED', r.gated, true);
    eq('B12 ...and the rejection is swallowed, not thrown at the caller', offline.reloadCalls, 1);

    const skipped = user({ emailVerified: false });
    r = await gate.evaluate(skipped, { reload: false });
    eq('B13 reload:false is honoured', skipped.reloadCalls, 0);
    eq('B14 ...and still gates', r.gated, true);

    r = await gate.evaluate(null);
    eq('B15 signed-out user is not gated (there is no session to deny)', r.gated, false);

    /* Re-entrancy. enforce() runs inside an auth-state listener and reload() can notify
       those listeners, so concurrent evaluations must share one refresh rather than
       becoming a reload storm. */
    const g2 = loadGate();
    const busy = user({ emailVerified: false });
    const verdicts = await Promise.all([
      g2.gate.evaluate(busy), g2.gate.evaluate(busy), g2.gate.evaluate(busy),
    ]);
    eq('B16 three concurrent evaluations share ONE server refresh', busy.reloadCalls, 1);
    ok('B17 ...and all three get the same verdict', verdicts.every((v) => v.gated === true));

    /* And the guard must release: a later evaluation still refreshes. */
    const after = await g2.gate.evaluate(busy);
    eq('B18 the in-flight guard releases — a later call refreshes again', busy.reloadCalls, 2);
    eq('B19 ...still gated', after.gated, true);

    /* Two different accounts must NOT share one refresh — an account switch fires
       sign-out then sign-in and can overlap here by a hair. */
    const g3 = loadGate();
    const alice = user({ uid: 'alice', emailVerified: false });
    const bob = user({ uid: 'bob', emailVerified: false });
    await Promise.all([g3.gate.evaluate(alice), g3.gate.evaluate(bob)]);
    ok('B20 a second account gets its OWN refresh, not the first one\'s',
       alice.reloadCalls === 1 && bob.reloadCalls === 1,
       'alice=' + alice.reloadCalls + ' bob=' + bob.reloadCalls);
  }

  /* ══ C · enforce — what denial actually removes ══════════════════════════ */
  head('C · enforce — the application session is dismantled, Firebase is not');
  {
    let cleared = 0;
    const { gate, win, events } = loadGate({
      protectedPage: false,
      security: { clearSession: () => { cleared++; } },
    });

    /* Pre-load every representation of a signed-in app session. */
    win.localStorage.setItem('loggedIn', 'true');
    win.localStorage.setItem('sokoniUser', JSON.stringify({ uid: 'uid-1', name: 'Shopper' }));

    const u = user({ emailVerified: false });
    const r = await gate.enforce(u);

    eq('C1  gated', r.gated, true);
    eq('C2  loggedIn removed — the flag auth-guard.js reads', win.localStorage.getItem('loggedIn'), null);
    eq('C3  cached profile removed', win.localStorage.getItem('sokoniUser'), null);
    eq('C4  SokoniSecurity session cleared', cleared, 1);
    ok('C5  challenge marker written to sessionStorage, not localStorage',
       !!win.sessionStorage.getItem(gate.PENDING_KEY) && win.localStorage.getItem(gate.PENDING_KEY) === null);
    ok('C6  sokoniVerificationRequired dispatched',
       events.length === 1 && events[0].type === 'sokoniVerificationRequired');
    eq('C7  ...carrying the uid for Slice 4', events[0].detail.uid, 'uid-1');
    ok('C8  the marker carries no secret — no code, no hash, no token',
       !/code|hash|salt|token|password/i.test(win.sessionStorage.getItem(gate.PENDING_KEY)));

    /* Nothing in the gate may sign the user out of Firebase: the challenge is an
       authenticated onCall and needs request.auth.uid. */
    const src = read('sokoni-verify-gate.js');
    ok('C9  the gate never calls signOut', !/\bsignOut\s*\(/.test(src));

    /* A verified user coming back clears the marker rather than leaving litter. */
    const g2 = loadGate();
    g2.win.sessionStorage.setItem(g2.gate.PENDING_KEY, JSON.stringify({ uid: 'uid-1' }));
    const r2 = await g2.gate.enforce(user({ emailVerified: true }));
    eq('C10 verified user is not gated', r2.gated, false);
    eq('C11 ...and the stale marker is cleared', g2.win.sessionStorage.getItem(g2.gate.PENDING_KEY), null);
    eq('C12 ...and their session flag is left ALONE (the gate only ever removes access)',
       g2.win.localStorage.getItem('loggedIn'), null);
  }

  /* ══ D · redirect behaviour ══════════════════════════════════════════════ */
  head('D · redirect — protected pages only, and never into a loop');
  {
    const p = loadGate({ protectedPage: true, pathname: '/wallet.html', search: '?tab=history' });
    const r = await p.gate.enforce(user({ emailVerified: false }));
    eq('D1  protected page redirects', p.nav.length, 1);
    ok('D2  ...via location.replace, so Back cannot return to the gated page',
       p.nav[0].how === 'replace');
    ok('D3  ...to the login surface with a verify marker',
       /^login\.html\?verify=1&next=/.test(p.nav[0].url), p.nav[0].url);
    ok('D4  ...carrying path AND query so the user lands back where they were',
       decodeURIComponent(p.nav[0].url.split('next=')[1]) === '/wallet.html?tab=history');
    ok('D5  ...and never an absolute URL (no open redirect through the address bar)',
       !/https?:/i.test(p.nav[0].url));

    const pub = loadGate({ protectedPage: false, pathname: '/index.html' });
    pub.win.localStorage.setItem('loggedIn', 'true');
    const r2 = await pub.gate.enforce(user({ emailVerified: false }));
    eq('D6  public page: still gated', r2.gated, true);
    eq('D7  public page: session still denied', pub.win.localStorage.getItem('loggedIn'), null);
    eq('D8  public page: but no redirect — browsing is not app access', pub.nav.length, 0);

    /* The loop guard. login.html carries no data-require-auth, but assert the path
       rule directly so a future page cannot acquire one and start bouncing itself. */
    for (const pg of ['/login.html', '/login', '/signup', '/register.html', '/reset-password']) {
      const a = loadGate({ protectedPage: true, pathname: pg });
      await a.gate.enforce(user({ emailVerified: false }));
      ok('D9  auth page ' + pg + ' is never redirected (no loop)', a.nav.length === 0);
    }

    const off = loadGate({ protectedPage: true, pathname: '/wallet.html' });
    await off.gate.enforce(user({ emailVerified: false }), { redirect: false });
    eq('D10 redirect:false is honoured (the login path uses it)', off.nav.length, 0);

    ok('D11 login.html really has no data-require-auth, so D9 is not vacuous',
       !/data-require-auth="true"/.test(read('login.html')));
  }

  /* ══ E · bypass attempts ═════════════════════════════════════════════════ */
  head('E · explicit bypass attempts — every one re-derived from Firebase Auth');
  {
    /* E1 — the obvious one: forge the session flag, then load a page. */
    const a = loadGate({ protectedPage: true });
    a.win.localStorage.setItem('loggedIn', 'true');
    a.win.localStorage.setItem('sokoniUser', JSON.stringify({ uid: 'uid-1', emailVerified: true }));
    const r1 = await a.gate.enforce(user({ emailVerified: false }));
    eq('E1  forged loggedIn does not survive the gate', r1.gated, true);
    eq('E2  ...it is removed', a.win.localStorage.getItem('loggedIn'), null);
    eq('E3  a cached profile claiming emailVerified:true is ignored outright',
       a.win.localStorage.getItem('sokoniUser'), null);

    /* E4 — forge the challenge marker itself. It is informational; it is not authority. */
    const b = loadGate({ protectedPage: true });
    b.win.sessionStorage.setItem(b.gate.PENDING_KEY, JSON.stringify({ uid: 'uid-1', verified: true }));
    const r2 = await b.gate.enforce(user({ emailVerified: false }));
    eq('E4  a forged pending marker grants nothing', r2.gated, true);

    /* E5 — a client-invented verified flag on the user object. */
    const c = loadGate();
    const liar = user({ emailVerified: false });
    liar.verified = true; liar.isVerified = true; liar.emailVerified_ = true;
    eq('E5  only emailVerified is read; look-alike properties are ignored',
       c.gate.needsVerification(liar), true);

    /* E6 — the gate must not consult storage for its decision at all. */
    const src = read('sokoni-verify-gate.js');
    const decision = src.slice(src.indexOf('function needsVerification'), src.indexOf('function evaluate'));
    ok('E6  the rule reads no storage', !/localStorage|sessionStorage/.test(decision));
    ok('E7  the rule reads no sokoniUser cache', !/sokoniUser/.test(decision));

    /* E8 — repeated enforcement is stable, not a counter that can be exhausted. */
    const d = loadGate({ protectedPage: false });
    const u = user({ emailVerified: false });
    for (let i = 0; i < 5; i++) {
      d.win.localStorage.setItem('loggedIn', 'true');      /* attacker re-forges each time */
      const rr = await d.gate.enforce(u);
      if (rr.gated !== true) { ok('E8  gate holds across repeats', false, 'opened on pass ' + i); break; }
    }
    eq('E8  gate holds across 5 forge-and-retry rounds', d.win.localStorage.getItem('loggedIn'), null);

    /* E9 — verification really does open the gate, so E1-E8 are not just "always denies". */
    const e = loadGate({ protectedPage: true });
    const rv = await e.gate.enforce(user({ emailVerified: true }));
    eq('E9  a genuinely verified user passes', rv.gated, false);
    eq('E10 ...and is not redirected', e.nav.length, 0);
  }

  /* ══ F · wiring — order is the whole point ═══════════════════════════════ */
  head('F · wiring — the gate runs before a session can exist');
  {
    const fb = read('firebase.js');

    const iGate = fb.indexOf('SokoniVerifyGate.enforce');
    const iFlag = fb.indexOf('localStorage.setItem("loggedIn", "true")');
    ok('F1  firebase.js consults the gate', iGate > -1);
    ok('F2  firebase.js still has the session flag write', iFlag > -1);
    ok('F3  the gate is consulted BEFORE the flag is written', iGate > -1 && iGate < iFlag);
    ok('F4  a gated user returns out of the handler', /_skGate\.gated[\s\S]{0,120}?return;/.test(fb));
    ok('F5  the gate is imported by firebase.js, so no page needs a script tag',
       /import\s+["']\.\/sokoni-verify-gate\.js["']/.test(fb));
    ok('F6  a gate ERROR denies rather than falls through',
       /catch[\s\S]{0,400}?gated:\s*true[\s\S]{0,200}?denyAppSession/.test(fb));

    /* sokoniAuthReady means "a usable session exists". It must not fire for a gated
       user, or every surface that waits on it would treat them as signed in. */
    const between = fb.slice(iGate, iFlag);
    ok('F7  sokoniAuthReady is not dispatched between the gate and the flag',
       !/_signalAuthReady|dispatchEvent\(new CustomEvent\('sokoniAuthReady'/.test(between));

    const au = read('auth.js');
    const aGate = au.indexOf('SokoniVerifyGate.enforce');
    const aProfile = au.indexOf("[AUTH STEP 4] Loading Firestore profile");
    const aFlag = au.indexOf('localStorage.setItem("loggedIn", "true")');
    ok('F8  auth.js consults the gate', aGate > -1);
    ok('F9  ...before the Firestore profile read', aGate > -1 && aGate < aProfile);
    ok('F10 ...and before any session write', aGate > -1 && aGate < aFlag);
    ok('F11 the login path does NOT redirect (Slice 4 renders in place)',
       /enforce\(cred\.user,\s*\{\s*redirect:\s*false\s*\}\)/.test(au));
    /* Assert the gated BRANCH, not a fixed number of characters after the word.
       A character window is a guess that silently goes stale the moment the branch
       grows — F12 first failed for exactly that reason, and widening the window would
       have taught the assertion to pass rather than checked anything. */
    const gatedBranch = braceBlock(au, '_verdict.gated');
    ok('F12a the gated branch was located', gatedBranch.length > 0);
    ok('F12 a gated login returns without writing a session',
       /\breturn;/.test(gatedBranch) && !/setItem\((["'])loggedIn\1/.test(gatedBranch));
    ok('F13 the sign-in button is re-enabled, so the form is not left dead',
       /btn\.disabled\s*=\s*false/.test(gatedBranch));
    ok('F14 a gated login is NOT recorded as a failed attempt (no lockout for a correct password)',
       !/recordFailedLogin/.test(gatedBranch));
    ok('F14b the gated branch writes no session of any kind',
       !/sokoniUser|setSession|createSession|sokoniEmployeeSession/.test(gatedBranch));

    /* The message must be able to render. auth.css hides .auth-msg by default. */
    ok('F15 the message type used by the gate has a visible style',
       /\.auth-msg\.info\s*\{[^}]*display:\s*block/.test(read('auth.css')));
    /* SUPERSEDED at Slice 4 — this asserted the gated branch called showAuthMsg(…,"info").
       That message was Slice 3's stopgap while the screen did not exist; Slice 4 replaced
       it with the handoff, so the assertion now describes a state the product has moved
       past. Rewritten to the thing that must stay true whoever owns the rendering: the
       branch shows the user SOMETHING and grants no session either way. */
    ok('F16 the gated branch surfaces the state rather than dying quietly',
       /SokoniVerifyScreen\.open|showAuthMsg/.test(gatedBranch));
    ok('F16b ...and still writes no session, whichever path it takes',
       !/setItem\((["'])loggedIn\1/.test(gatedBranch) && !/setSession/.test(gatedBranch));

    /* Slice 3 issues no code — Slice 4's screen is what calls authDispatch. A message
       saying one is on its way would leave the user waiting for mail nobody requested,
       which is the same "claim something the backend has not done" defect the platform
       already has a standing rule about. Comments are stripped first: the comment above
       that message quotes the wording it forbids. */
    const gatedCode = gatedBranch.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    ok('F17 the gated message promises no email that this slice does not send',
       !/sent|we'?ll send|check your (inbox|email|mail)/i.test(gatedCode), gatedCode.slice(0, 200));
  }

  /* ══ G · blast radius ════════════════════════════════════════════════════ */
  head('G · blast radius — Google/phone paths and the slice boundary');
  {
    const au = read('auth.js');

    /* The three other session writers in auth.js are signup and the two OAuth
       fallbacks. Slice 3 changes none of them; the gate reaches them through
       firebase.js instead, which is the point of putting it at the choke point. */
    const writes = (au.match(/setItem\((["'])loggedIn\1,\s*(["'])true\2\)/g) || []).length;
    eq('G1  auth.js still has its four session writers — none were removed', writes, 4);

    const gStart = au.indexOf("provider:     'google'");
    ok('G2  the Google fallback block is untouched by the gate',
       gStart > -1 && !au.slice(gStart - 2000, gStart + 500).includes('SokoniVerifyGate'));

    const oStart = au.indexOf("(providerLabel || 'oauth')");
    ok('G3  the OAuth fallback block is untouched by the gate',
       oStart > -1 && !au.slice(oStart - 2000, oStart + 500).includes('SokoniVerifyGate'));

    /* Slice boundary: no Slice 4 UI, no Slice 5, no Stories, no rules change. */
    ok('G4  firestore.rules untouched by this slice',
       !/SokoniVerifyGate|verifyPending/i.test(read('firestore.rules')));
    ok('G5  login.html untouched — Slice 4 owns the screen',
       !/SokoniVerifyGate|sokoniVerifyPending/.test(read('login.html')));
    ok('G6  no verification screen was created', !fs.existsSync(path.join(ROOT, 'verify-email.html')));
    ok('G7  auth-guard.js untouched', !/SokoniVerifyGate/.test(read('auth-guard.js')));

    /* Stories must not have been touched. */
    const storiesTouched = fs.readdirSync(ROOT)
      .filter((f) => /^sokoni-stories|^stories\./i.test(f))
      .filter((f) => /SokoniVerifyGate/.test(read(f)));
    eq('G8  Stories untouched', storiesTouched.length, 0);

    /* Payment / order behaviour preserved: the gate only ever removes access and never
       writes a session. Assert it has no setItem('loggedIn') anywhere. */
    ok('G9  the gate never CREATES a session — it has no loggedIn writer',
       !/setItem\((["'])loggedIn\1/.test(read('sokoni-verify-gate.js')));

    /* NO WHOLE-FILE LINE-ENDING FLIP.

       This started as "Slice 3 only adds, so deletions must be zero", which caught the
       real thing: auth.css is a mixed-EOL file and editing it converted 65 untouched LF
       lines to CRLF, reported by git as 65 deletions inside a 13-line change. But "zero
       deletions" expires the moment a later slice legitimately rewrites a line — Slice 4
       replaced the interim message and the inline redirect sanitiser, and the assertion
       failed for a correct reason.

       So assert the corruption SIGNATURE instead, which never expires: a diff that shrinks
       when carriage returns at end-of-line are ignored contains a CR-only change. Real
       edits are identical under both readings. */
    const cp = require('child_process');
    const num = (args, f) => {
      const out = cp.execSync('git diff ' + args + ' --numstat -- ' + f,
                              { cwd: ROOT, encoding: 'utf8' }).trim();
      if (!out) return [0, 0];
      const p = out.split('\n')[0].split(/\s+/);
      return [Number(p[0]) || 0, Number(p[1]) || 0];
    };
    for (const f of ['auth.js', 'firebase.js', 'auth.css', 'login.html']) {
      const plain = num('', f), ignoring = num('--ignore-cr-at-eol', f);
      ok('G10 ' + f + ' carries no line-ending flip (' + plain.join('/') + ' vs ' +
         ignoring.join('/') + ' ignoring CR)',
         plain[0] === ignoring[0] && plain[1] === ignoring[1],
         'a CR-only change is hiding in this diff');
    }
  }

  /* ══ H · coverage ════════════════════════════════════════════════════════ */
  head('H · coverage — which protected pages the choke point actually reaches');
  {
    const pages = fs.readdirSync(ROOT).filter((f) => /\.html$/.test(f));
    const protectedPages = pages.filter((f) => /data-require-auth="true"/.test(read(f)));
    ok('H1  protected pages found', protectedPages.length > 40, String(protectedPages.length));

    const uncovered = protectedPages.filter((f) => {
      const s = read(f);
      return !/src="\/?(firebase|sokoni-init)\.js"/.test(s);
    });
    /* Known and reported, not silently accepted: these two carry data-require-auth but
       load no Firebase at all, so they have never had authoritative auth on the page —
       they are gated by the localStorage flag alone. That is a PRE-EXISTING hole in
       auth-guard.js, not one this slice opens, and closing it means giving two pages a
       Firebase bootstrap they have never had. Named here so the number cannot drift
       upward unnoticed. */
    const KNOWN_UNCOVERED = ['dispute-portal.html', 'fleet-monitor.html'];
    eq('H2  no NEW page falls outside the choke point',
       uncovered.filter((f) => !KNOWN_UNCOVERED.includes(f)).join(',') || '(none)', '(none)');
    ok('H3  the known-uncovered list has not grown', uncovered.length <= KNOWN_UNCOVERED.length,
       uncovered.join(','));

    console.log('     covered ' + (protectedPages.length - uncovered.length) + '/' +
                protectedPages.length + ' protected pages · uncovered: ' +
                (uncovered.join(', ') || 'none'));
  }

  /* ══ I · positive controls ═══════════════════════════════════════════════
     A suite that only ever sees correct code cannot tell "this passes" from "this
     asserts nothing". Each control breaks the gate on purpose and requires the
     corresponding behaviour to change — if a mutation still passes, the assertion it
     shadows was decorative. */
  head('I · positive controls — break the gate, watch the answer change');
  {
    const src = read('sokoni-verify-gate.js');

    /* Returns the mutant's whole context, so a control can inspect its storage as
       well as call its API. A mutation whose target string is absent would silently
       apply nothing and "pass"; asserting the target exists is what stops that. */
    function mutated(label, from, to) {
      ok('I·  mutation target still present: ' + label, src.includes(from));
      const w = {
        document: { documentElement: { dataset: { requireAuth: 'false' } }, dispatchEvent: () => true },
        localStorage: makeStorage(), sessionStorage: makeStorage(),
        location: { pathname: '/index.html', search: '', replace: () => { }, href: '' },
        CustomEvent: function () { }, console: console, module: { exports: {} },
      };
      vm.createContext(w); w.window = w;
      vm.runInContext(src.replace(from, to), w, { filename: 'mutant-' + label + '.js' });
      return w;
    }

    /* Control 1 — drop the password-provider requirement so everything is gated.
       If A5/A8 (google/phone never gated) still passed under this, they were noise. */
    const m1 = mutated('password-only', "return ids.indexOf('password') !== -1;", 'return true;');
    ok('I1  mutant gates a google account — so A5 was really testing the rule',
       m1.SokoniVerifyGate.needsVerification(user({ providers: ['google.com'] })) === true);

    /* Control 2 — remove the phone exclusion. */
    const m2 = mutated('phone-excluded', "if (ids.indexOf('phone') !== -1) return false;", '');
    ok('I2  mutant gates a phone account — so A8 was really testing the exclusion',
       m2.SokoniVerifyGate.needsVerification(user({ providers: ['phone', 'password'] })) === true);

    /* Control 3 — trust the cached flag instead of refreshing from the server. */
    const m3 = mutated('server-refresh', '.then(function () { return user.reload && user.reload(); })', '');
    const stale = user({ emailVerified: false, verifiesOnReload: true });
    const r3 = await m3.SokoniVerifyGate.evaluate(stale);
    ok('I3  mutant never reloads and so wrongly gates a user who just verified — B5/B6 bite',
       stale.reloadCalls === 0 && r3.gated === true);

    /* Control 4 — stop removing the session flag on denial. */
    const m4 = mutated('deny-session', "global.localStorage.removeItem('loggedIn');", '');
    m4.localStorage.setItem('loggedIn', 'true');
    await m4.SokoniVerifyGate.enforce(user({ emailVerified: false }));
    ok('I4  mutant leaves a forged session flag in place — so C2/E2 bite',
       m4.localStorage.getItem('loggedIn') === 'true');
  }

  /* ── result ────────────────────────────────────────────────────────────── */
  console.log('\n' + '─'.repeat(70));
  if (fail) {
    console.log('\x1b[31mFAILURES\x1b[0m');
    failures.forEach((f) => console.log('  ✗ ' + f));
  }
  console.log((fail ? '\x1b[31m' : '\x1b[32m') + 'auth verify gate: ' + pass + '/' + (pass + fail) +
              '\x1b[0m');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
