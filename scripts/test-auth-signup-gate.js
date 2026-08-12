/* ══════════════════════════════════════════════════════════════════════════════
   AUTH SLICE 6C — signup enforcement
   ------------------------------------------------------------------------------
   A new email/password account created while enforcement is enabled must not receive a
   usable application session until the code is verified. Existing accounts, Google and
   phone are untouched, and with the shipped 2099 sentinel this whole slice is a no-op.

   Two kinds of assertion, because signup is a long procedural function:

     ORDER      read as text — the account must be fully created (Auth record, Firestore
                profile, consent row) BEFORE the gate, and every session write must come
                after it. An account gated without its user document would be broken the
                moment it verified.
     BEHAVIOUR  the gate and policy are executed, so "a new account is held / is not held"
                is demonstrated rather than asserted about source.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const AUTH = read('auth.js');

let pass = 0, fail = 0;
const failures = [];
function ok(label, cond, detail) {
  if (cond) { pass++; return true; }
  fail++; failures.push(label + (detail ? '  → ' + detail : ''));
  return false;
}
const eq = (l, a, e) => ok(l, a === e, 'expected ' + JSON.stringify(e) + ', got ' + JSON.stringify(a));
const head = (t) => console.log('\n\x1b[1m' + t + '\x1b[0m');

function braceBlock(src, marker) {
  const at = src.indexOf(marker); if (at < 0) return '';
  const open = src.indexOf('{', at); if (open < 0) return '';
  let d = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}') { d--; if (d === 0) return src.slice(open, i + 1); }
  }
  return '';
}

/* Gate + policy in one sandbox, with an optional live cutoff. */
function loadGate(cutoff, opts) {
  opts = opts || {};
  const nav = [];
  const store = new Map();
  const w = {
    document: {
      documentElement: { dataset: { requireAuth: opts.protectedPage ? 'true' : 'false' } },
      dispatchEvent: () => true,
      addEventListener: () => { },
      getElementById: () => null,
      visibilityState: 'visible',
    },
    addEventListener: () => { },
    localStorage: {
      getItem: (k) => (store.has(String(k)) ? store.get(String(k)) : null),
      setItem: (k, v) => store.set(String(k), String(v)),
      removeItem: (k) => store.delete(String(k)),
    },
    sessionStorage: (() => { const m = new Map(); return {
      getItem: (k) => (m.has(String(k)) ? m.get(String(k)) : null),
      setItem: (k, v) => m.set(String(k), String(v)),
      removeItem: (k) => m.delete(String(k)) }; })(),
    location: { pathname: opts.pathname || '/signup.html', search: '',
                replace: (u) => nav.push(u), href: '', reload: () => nav.push('<reload>') },
    CustomEvent: function (t, i) { this.type = t; this.detail = i && i.detail; },
    console: { log() { }, warn() { }, error() { } },
    setInterval: () => ({ unref() { } }), clearInterval() { },
    module: { exports: {} },
  };
  vm.createContext(w); w.window = w;
  vm.runInContext(read('sokoni-verify-policy.js'), w, { filename: 'policy.js' });
  if (cutoff) w.SokoniVerifyPolicy.CUTOFF_ISO = cutoff;
  vm.runInContext(read('sokoni-verify-gate.js'), w, { filename: 'gate.js' });
  return { w, store, nav, gate: w.SokoniVerifyGate, policy: w.SokoniVerifyPolicy };
}

/* A user as Firebase hands it back from createUserWithEmailAndPassword. */
function newAccount(createdIso, o) {
  o = o || {};
  const u = {
    uid: o.uid || 'new-1', email: o.email || 'new@example.com',
    emailVerified: !!o.emailVerified,
    providerData: (o.providers || ['password']).map((id) => ({ providerId: id })),
    metadata: { creationTime: createdIso },
    reloadCalls: 0,
  };
  u.reload = function () {
    u.reloadCalls++;
    if (o.verifiesOnReload) u.emailVerified = true;
    return Promise.resolve();
  };
  return u;
}

const CUT = '2026-09-01T00:00:00.000Z';
const AFTER = '2026-09-02T10:00:00.000Z';
const BEFORE = '2026-07-15T10:00:00.000Z';

(async function run() {

  /* ══ A · order: the account is created, the session is not ═══════════════ */
  head('A · the account is fully created BEFORE the gate; the session comes after');
  {
    const iGate = AUTH.indexOf('AUTH SLICE 6C — signup enforcement');
    ok('A1  the signup gate exists', iGate > -1);

    const iCreate = AUTH.indexOf('createUserWithEmailAndPassword(window.firebaseAuth');
    const iProfile = AUTH.indexOf("setDoc(doc(window.firebaseDB, 'users', cred.user.uid)");
    const iConsent = AUTH.indexOf("collection(window.firebaseDB, 'consentRecords')");
    ok('A2  the Auth account is created before the gate', iCreate > -1 && iCreate < iGate);
    ok('A3  the Firestore profile is written before the gate', iProfile > -1 && iProfile < iGate);
    ok('A4  the consent row is written before the gate', iConsent > -1 && iConsent < iGate);

    /* Every session write must be after it. The signup session block is the second
       occurrence of the flag in the file (the first is the login path). */
    const flags = [];
    let at = -1;
    while ((at = AUTH.indexOf('localStorage.setItem("loggedIn", "true")', at + 1)) > -1) flags.push(at);
    eq('A5  auth.js still has exactly two "loggedIn" writers in these two flows', flags.length, 2);
    ok('A6  the signup session flag is written AFTER the gate', flags[1] > iGate);
    /* Search FROM the gate: the login path writes the same line earlier in the file, and
       indexOf() found that one — the assertion was reading the wrong flow entirely. */
    ok('A7  ...and so is the cached profile',
       AUTH.indexOf('localStorage.setItem("sokoniUser", JSON.stringify(profile))', iGate) > iGate);
    ok('A8  ...and the SokoniSecurity session',
       AUTH.indexOf("SokoniSecurity.setSession && SokoniSecurity.setSession(profile)", iGate) > iGate);
    ok('A9  ...and the success card that promises the account is ready',
       AUTH.indexOf('Replace the auth card with the success screen') > iGate);

    const branch = braceBlock(AUTH.slice(iGate), '_sv.gated');
    ok('A10 the gated branch returns without falling through', /\breturn;/.test(branch));
    ok('A11 ...and writes no session of any kind',
       !/setItem\((["'])loggedIn\1|sokoniUser|setSession/.test(branch), branch.slice(0, 160));
    ok('A12 ...and hands off to the verification screen',
       /SokoniVerifyScreen\.open/.test(branch));
    ok('A13 ...passing the user object, not an identity from the page',
       /user:\s*cred\.user/.test(branch));
  }

  /* ══ B · no duplicated policy logic ══════════════════════════════════════ */
  head('B · signup uses the existing verdict — it does not restate the policy');
  {
    const iGate = AUTH.indexOf('AUTH SLICE 6C — signup enforcement');
    const region = AUTH.slice(iGate, iGate + 2600);
    const code = region.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

    ok('B1  it calls the composed gate', /SokoniVerifyGate\.enforce\(cred\.user/.test(code));
    ok('B2  it never compares a creation date itself',
       !/creationTime|Date\.parse|getTime\(\)/.test(code), code.slice(0, 200));
    ok('B3  it never mentions a cutoff', !/CUTOFF|cutoff|2099/.test(code));
    ok('B4  it never reimplements the provider rule',
       !/providerData|emailVerified\s*===/.test(code));

    /* The whole file must contain no second copy of the policy. */
    const all = AUTH.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    ok('B5  auth.js declares no cutoff constant of its own', !/SENTINEL_ISO|CUTOFF_ISO\s*=/.test(all));
    ok('B6  auth.js never calls enforcementApplies directly — it goes through the gate',
       !/enforcementApplies/.test(all));
  }

  /* ══ C · behaviour: held, or not, according to the policy ════════════════ */
  head('C · a new account is held only when the policy says so');
  {
    const on = loadGate(CUT);
    const fresh = newAccount(AFTER);
    const r1 = await on.gate.enforce(fresh, { redirect: false });
    eq('C1  enforcement ON: a brand-new account is held', r1.gated, true);
    eq('C2  ...and no session flag was created', on.store.get('loggedIn'), undefined);

    const legacy = newAccount(BEFORE);
    const r2 = await on.gate.enforce(legacy, { redirect: false });
    eq('C3  an existing account created before the cutoff is untouched', r2.gated, false);
    eq('C4  ...named as grandfathered', r2.reason, 'grandfathered');

    /* THE SHIPPED DEFAULT: signup must behave exactly as it did before this slice. */
    const off = loadGate(null);
    const freshOff = newAccount(AFTER);
    const r3 = await off.gate.enforce(freshOff, { redirect: false });
    eq('C5  with the 2099 sentinel a brand-new account is NOT held', r3.gated, false);
    eq('C6  ...so signup is unchanged in production today', r3.reason, 'grandfathered');
    eq('C7  ...and it cost no network round trip', freshOff.reloadCalls, 0);
    eq('C8  the shipped cutoff really is the sentinel', off.policy.CUTOFF_ISO, off.policy.SENTINEL_ISO);
  }

  /* ══ D · other providers untouched ═══════════════════════════════════════ */
  head('D · Google and phone signup are unaffected at any cutoff');
  {
    const on = loadGate(CUT);
    for (const p of ['google.com', 'facebook.com', 'apple.com']) {
      const u = newAccount(AFTER, { providers: [p] });
      const r = await on.gate.enforce(u, { redirect: false });
      ok('D·  ' + p + ' signup is never held', r.gated === false);
    }
    const ph = newAccount(AFTER, { providers: ['phone'], email: null });
    eq('D4  phone signup is never held', (await on.gate.enforce(ph, { redirect: false })).gated, false);

    /* And the source: the OAuth/phone paths were not edited by this slice. */
    const g = AUTH.indexOf("provider:     'google'");
    ok('D5  the Google fallback block carries no signup gate',
       g > -1 && !AUTH.slice(g - 2500, g + 500).includes('SLICE 6C'));
    const o = AUTH.indexOf("(providerLabel || 'oauth')");
    ok('D6  the OAuth fallback block carries no signup gate',
       o > -1 && !AUTH.slice(o - 2500, o + 500).includes('SLICE 6C'));
  }

  /* ══ E · unknown states fail safe ════════════════════════════════════════ */
  head('E · a signup that cannot determine its status does not hand out a session');
  {
    const iGate = AUTH.indexOf('AUTH SLICE 6C — signup enforcement');
    const region = AUTH.slice(iGate, iGate + 2600);
    ok('E1  a gate error is treated as GATED, not as a pass',
       /catch[\s\S]{0,400}?gated:\s*true/.test(region));
    ok('E2  ...and the app session is dismantled on that path',
       /catch[\s\S]{0,500}?denyAppSession/.test(region));
    /* Read the whole branch rather than a character window — the window was a guess, and
       the phrase it looked for was split across a string concatenation in the source, so
       this failed for two independent reasons at once. */
    const gatedBranch = braceBlock(AUTH.slice(iGate), '_sv.gated');
    ok('E3a the gated branch was located', gatedBranch.length > 0);
    ok('E3  a missing screen still refuses the session and says so',
       /could not load/i.test(gatedBranch) && /\belse\b/.test(gatedBranch) &&
       /\breturn;/.test(gatedBranch));

    /* Behaviour: a reload failure must not open the gate. */
    const on = loadGate(CUT);
    const offline = newAccount(AFTER);
    offline.reload = function () { offline.reloadCalls++; return Promise.reject(new Error('offline')); };
    const r = await on.gate.enforce(offline, { redirect: false });
    eq('E4  a failed server refresh keeps a new account held', r.gated, true);
    eq('E5  ...and grants no session', on.store.get('loggedIn'), undefined);
  }

  /* ══ F · refresh, direct navigation, account switch ══════════════════════ */
  head('F · the held new account stays held across refresh, URLs and switching');
  {
    /* Refresh = a fresh context over the same account. */
    const held = newAccount(AFTER);
    for (let i = 1; i <= 3; i++) {
      const ctx = loadGate(CUT, { protectedPage: true, pathname: '/wallet.html' });
      const r = await ctx.gate.enforce(held);
      ok('F' + i + '  refresh/direct-URL #' + i + ' still held', r.gated === true);
      ok('F' + i + 'b ...and bounced off the protected page',
         ctx.nav.length === 1 && /login\.html\?verify=1/.test(ctx.nav[0]), ctx.nav.join(','));
    }
    ok('F4  every attempt re-derived from Firebase rather than a cache', held.reloadCalls === 3,
       'reloads=' + held.reloadCalls);

    /* Forging a session flag between attempts changes nothing. */
    const ctx = loadGate(CUT, { protectedPage: true });
    ctx.store.set('loggedIn', 'true');
    ctx.store.set('sokoniUser', JSON.stringify({ uid: 'new-1', emailVerified: true }));
    const r = await ctx.gate.enforce(newAccount(AFTER));
    eq('F5  a forged session does not survive', r.gated, true);
    eq('F6  ...loggedIn stripped', ctx.store.get('loggedIn'), undefined);
    eq('F7  ...cached profile stripped', ctx.store.get('sokoniUser'), undefined);

    /* Account switch: the new held account, then an established one. */
    const sw = loadGate(CUT, { protectedPage: true });
    eq('F8  the new account is held', (await sw.gate.enforce(newAccount(AFTER))).gated, true);
    eq('F9  switching to a grandfathered account passes',
       (await sw.gate.enforce(newAccount(BEFORE, { uid: 'old-1' }))).gated, false);
    eq('F10 switching back holds again',
       (await sw.gate.enforce(newAccount(AFTER))).gated, true);
  }

  /* ══ G · newly created → verified ════════════════════════════════════════ */
  head('G · the transition the new account actually makes');
  {
    const ctx = loadGate(CUT, { protectedPage: true });
    const u = newAccount(AFTER);

    const before = await ctx.gate.enforce(u);
    eq('G1  held immediately after signup', before.gated, true);
    ok('G2  the challenge marker is set for the screen', ctx.gate.isPending() === true);

    /* The server marks the record; the next evaluation must open the gate. */
    u.reload = function () { u.reloadCalls++; u.emailVerified = true; return Promise.resolve(); };
    const after = await ctx.gate.enforce(u);
    eq('G3  once verified, the same account passes', after.gated, false);
    eq('G4  ...on the strength of the refreshed token', after.reason, 'verified-on-reload');
    ok('G5  ...and the pending marker is cleared', ctx.gate.isPending() === false);

    /* And it stays passed on the next page load, with no further network cost. */
    const next = loadGate(CUT, { protectedPage: true });
    const r = await next.gate.enforce(u);
    eq('G6  a later page load passes without re-asking', r.gated, false);
    eq('G7  ...paying nothing, because a cached true cannot be a stale false', r.reason, 'verified');
  }

  /* ══ H · the two verification emails problem ═════════════════════════════ */
  head('H · one address, one instruction');
  {
    const iSend = AUTH.indexOf('_skvWillGate');
    ok('H1  the legacy link send is now conditional', iSend > -1);
    ok('H2  ...on the SAME composed verdict, not a second policy',
       /_skvWillGate\s*=\s*!!\(window\.SokoniVerifyGate && window\.SokoniVerifyGate\.isGated\(cred\.user\)\)/.test(AUTH));
    ok('H3  ...and the link still goes out when the account is not held',
       /if \(!_skvWillGate\) sendEmailVerification\(cred\.user\)/.test(AUTH));

    /* With the sentinel, isGated is false, so the legacy behaviour is bit-for-bit intact. */
    const off = loadGate(null);
    eq('H4  under the shipped sentinel a new account is not gated, so the link is sent',
       off.gate.isGated(newAccount(AFTER)), false);
    const on = loadGate(CUT);
    eq('H5  with enforcement on it is gated, so the link is suppressed',
       on.gate.isGated(newAccount(AFTER)), true);
  }

  /* ══ I · wiring and boundary ═════════════════════════════════════════════ */
  head('I · signup.html wiring, and what 6C did not touch');
  {
    const html = read('signup.html');
    ok('I1  signup.html has the mount point', /id="skvMount"/.test(html));
    ok('I2  ...hidden by default', /id="skvMount"[^>]*display:none/.test(html));
    ok('I3  ...and loads the screen', /src="sokoni-verify-screen\.js"/.test(html));
    ok('I4  ...and the OTP field the screen mounts', /src="sokoni-otp\.js"/.test(html));
    ok('I5  both load BEFORE auth.js, which hands off to them',
       html.indexOf('sokoni-verify-screen.js') < html.indexOf('src="auth.js"') &&
       html.indexOf('sokoni-otp.js') < html.indexOf('src="auth.js"'));
    ok('I6  signup.html has an auth-card for the screen to take over', /class="auth-card"/.test(html));

    /* Nothing may have changed emailVerified or the policy. */
    const all = AUTH.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    ok('I7  auth.js never assigns emailVerified', !/emailVerified\s*=(?!=)/.test(all));
    ok('I8  the policy file was not edited by this slice',
       !/SLICE 6C|signup/i.test(read('sokoni-verify-policy.js')));
    ok('I9  the server policy was not edited either',
       !/SLICE 6C|signup/i.test(read('functions/auth-policy.js')));
    ok('I10 firestore.rules untouched', !/skv|VerifyScreen|SLICE 6C/i.test(read('firestore.rules')));

    const stories = fs.readdirSync(ROOT).filter((f) => /^sokoni-stories|^stories\./i.test(f))
      .filter((f) => /SLICE 6C|VerifyScreen/.test(read(f)));
    eq('I11 Stories untouched', stories.length, 0);

    /* The sentinel must not have been quietly activated. */
    const cli = read('sokoni-verify-policy.js'), srv = read('functions/auth-policy.js');
    ok('I12 the client cutoff is still the sentinel',
       /CUTOFF_ISO:\s*SENTINEL_ISO/.test(cli), 'client');
    ok('I13 the server cutoff is still the sentinel',
       /CUTOFF_ISO:\s*SENTINEL_ISO/.test(srv), 'server');

    /* Line-ending corruption guard, same signature check as the other slices. */
    const cp = require('child_process');
    for (const f of ['auth.js', 'signup.html']) {
      const plain = cp.execSync('git diff --numstat HEAD -- ' + f, { cwd: ROOT, encoding: 'utf8' }).trim();
      const ign = cp.execSync('git diff --ignore-cr-at-eol --numstat HEAD -- ' + f,
                              { cwd: ROOT, encoding: 'utf8' }).trim();
      eq('I14 ' + f + ' carries no line-ending flip', plain, ign);
    }
  }

  /* ══ J · positive controls ═══════════════════════════════════════════════ */
  head('J · positive controls');
  {
    const gateSrc = read('sokoni-verify-gate.js');
    function mutant(from, to, cutoff) {
      ok('J·  mutation target present: ' + from.slice(0, 34), gateSrc.indexOf(from) >= 0);
      const w = {
        document: { documentElement: { dataset: { requireAuth: 'false' } }, dispatchEvent: () => true,
                    addEventListener: () => { } },
        addEventListener: () => { },
        localStorage: (() => { const m = new Map(); return {
          getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)),
          removeItem: (k) => m.delete(k), _m: m }; })(),
        sessionStorage: { getItem: () => null, setItem() { }, removeItem() { } },
        location: { pathname: '/signup.html', search: '', replace() { }, href: '' },
        CustomEvent: function () { }, console: { warn() { }, log() { } },
        setInterval: () => ({ unref() { } }), clearInterval() { }, module: { exports: {} },
      };
      vm.createContext(w); w.window = w;
      vm.runInContext(read('sokoni-verify-policy.js'), w, { filename: 'policy.js' });
      w.SokoniVerifyPolicy.CUTOFF_ISO = cutoff;
      vm.runInContext(gateSrc.replace(from, to), w, { filename: 'mutant.js' });
      return w;
    }

    /* Gate ignores the policy → a grandfathered account would be held at signup, which is
       the mass-lockout this whole 6-series exists to prevent. */
    const m1 = mutant('return policy.enforcementApplies(user);', 'return true;', CUT);
    eq('J1  the mutant holds a grandfathered account — so C3 really bites',
       m1.SokoniVerifyGate.isGated(newAccount(BEFORE)), true);

    /* Gate stops consulting the policy at all → the sentinel stops protecting production. */
    const m2 = mutant('return policy.enforcementApplies(user);', 'return true;',
                      '2099-01-01T00:00:00.000Z');
    eq('J2  the mutant holds a new account even under the sentinel — so C5 really bites',
       m2.SokoniVerifyGate.isGated(newAccount(AFTER)), true);

    /* And the real gate does neither. */
    const real = loadGate(CUT);
    eq('J3  the shipped gate leaves the grandfathered account alone',
       real.gate.isGated(newAccount(BEFORE)), false);
    eq('J4  ...and the shipped sentinel leaves the new one alone',
       loadGate(null).gate.isGated(newAccount(AFTER)), false);
  }

  console.log('\n' + '─'.repeat(70));
  if (fail) { console.log('\x1b[31mFAILURES\x1b[0m'); failures.forEach((f) => console.log('  ✗ ' + f)); }
  console.log((fail ? '\x1b[31m' : '\x1b[32m') + 'auth signup gate: ' + pass + '/' + (pass + fail) + '\x1b[0m');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
