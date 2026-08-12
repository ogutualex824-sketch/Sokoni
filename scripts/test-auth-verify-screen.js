/* ══════════════════════════════════════════════════════════════════════════════
   AUTH SLICE 4 — verification screen suite
   ------------------------------------------------------------------------------
   Runs the SHIPPED sokoni-verify-screen.js in a vm sandbox against a stubbed
   authDispatch. The stub returns the SAME shapes the real dispatcher returns (Slice 2
   asserts those shapes against real emulators), so this suite tests the screen's
   behaviour without re-testing the backend.

   The state that matters most is the last one: a screen that says "Verified!" when the
   account is not verified sends the user straight back into the gate. Block G exists to
   make that impossible.
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
const eq = (l, a, e) => ok(l, a === e, 'expected ' + JSON.stringify(e) + ', got ' + JSON.stringify(a));
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

const head = (t) => console.log('\n\x1b[1m' + t + '\x1b[0m');

/* ── a very small DOM ─────────────────────────────────────────────────────────
   Enough for the screen: getElementById, innerHTML that registers ids, classList,
   textContent, disabled, onclick. Deliberately not a real DOM library — the screen's
   contract with the page is narrow, and a fake that is too clever hides breakage. */
function makeDom() {
  const byId = new Map();
  function mkEl(id) {
    const el = {
      id, textContent: '', disabled: false, onclick: null,
      style: {}, className: '',
      classList: {
        _s: new Set(),
        add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
        contains(c) { return this._s.has(c); },
      },
      closest(sel) { return sel === '.auth-card' ? card : null; },
      set innerHTML(v) { this._html = v; registerIds(v); },
      get innerHTML() { return this._html || ''; },
    };
    byId.set(id, el);
    return el;
  }
  /* Any id="x" in a template string becomes a queryable element. */
  function registerIds(html) {
    const re = /id="([^"]+)"/g; let m;
    while ((m = re.exec(String(html)))) if (!byId.has(m[1])) mkEl(m[1]);
  }
  const card = mkEl('__card');
  const mount = mkEl('skvMount');
  return {
    document: { getElementById: (id) => byId.get(id) || null },
    byId, mount, card, mkEl,
  };
}

function makeUser(o) {
  o = o || {};
  const u = {
    uid: o.uid || 'u1', email: o.email || 'shopper@example.com',
    emailVerified: !!o.emailVerified, reloadCalls: 0,
  };
  u.reload = function () {
    u.reloadCalls++;
    if (o.reloadThrows) return Promise.reject(new Error('offline'));
    if (o.verifiesOnReload) u.emailVerified = true;
    return Promise.resolve();
  };
  return u;
}

/* Load the screen with a scripted dispatcher. `plan` maps op → response (or a function). */
function loadScreen(plan, opts) {
  opts = opts || {};
  const dom = makeDom();
  const calls = [];
  const nav = [];
  const signOuts = [];

  const w = {
    document: dom.document,
    sessionStorage: { _m: new Map(), getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
                      setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); } },
    location: { replace: (u) => nav.push(u), href: '' },
    console: { log() { }, warn() { }, error() { } },
    setInterval: (fn) => ({ _fn: fn, unref() { } }),
    clearInterval: () => { },
    module: { exports: {} },
    /* The OTP component, stubbed to the documented contract. */
    SokoniOtp: {
      mount: (sel, o) => {
        const api = {
          _v: opts.code == null ? '' : String(opts.code),
          _err: false, _cleared: 0, _focused: 0,
          value() { return this._v; },
          clear() { this._v = ''; this._cleared++; },
          focus() { this._focused++; },
          error(on) { this._err = !!on; },
          destroy() { },
          _onComplete: o && o.onComplete,
        };
        w.__otp = api;
        return api;
      },
    },
    SokoniAuth: { signOut: () => { signOuts.push(1); return Promise.resolve(); } },
    sokoniCallable: (name) => (payload) => {
      calls.push({ name, op: payload.op, code: payload.code });
      const r = plan[payload.op];
      const val = typeof r === 'function' ? r(payload, calls) : r;
      if (val instanceof Error) return Promise.reject(val);
      return Promise.resolve({ data: val });
    },
  };
  const _ret = { _code: opts.code == null ? "" : String(opts.code) };
  vm.createContext(w); w.window = w;
  let src = read('sokoni-verify-screen.js');
  if (opts.mutate) {
    if (src.indexOf(opts.mutate[0]) < 0) throw new Error('mutation target absent: ' + opts.mutate[0]);
    src = src.replace(opts.mutate[0], opts.mutate[1]);
  }
  vm.runInContext(src, w, { filename: 'sokoni-verify-screen.js' });
  return Object.assign(_ret, { w, dom, calls, nav, signOuts, screen: w.SokoniVerifyScreen });
}

/* Type into the mounted field. Must happen AFTER open(): issuing a code clears the
   entry, which is correct — a new code should not be verified against stale digits —
   and it silently emptied this suite's stub until B1 caught it. */
function enter(t, code) { if (t.w.__otp) t.w.__otp._v = String(code); return t; }

const msgOf = (dom) => (dom.byId.get('skvMsg') || {}).textContent;
const msgKind = (dom) => ((dom.byId.get('skvMsg') || {}).className || '').replace('auth-msg ', '');

(async function run() {

  /* ══ A · opening — status before issue ═══════════════════════════════════ */
  head('A · opening the screen asks what is already true before spending a send');
  {
    const t = loadScreen({
      emailChallengeStatus: { ok: true, emailVerified: false, emailHint: 'sh••••@example.com', challenge: null },
      emailChallengeIssue: { ok: true, delivered: true, cooldownMs: 60000, sendCount: 1, emailHint: 'sh••••@example.com' },
    });
    await t.screen.open({ user: makeUser({}), mount: t.dom.mount });

    eq('A1  status is called first', t.calls[0].op, 'emailChallengeStatus');
    eq('A2  ...then issue, because there was nothing to resume', t.calls[1].op, 'emailChallengeIssue');
    eq('A3  exactly two calls', t.calls.length, 2);
    ok('A4  the masked address is shown, never the full one',
       /sh••••@example\.com/.test((t.dom.byId.get('skvSub') || {}).textContent));
    ok('A5  the card is taken over so the login form cannot sit underneath',
       t.dom.card.classList.contains('skv-active'));

    /* A live challenge must be RESUMED, not resent — the code in the inbox still works,
       and reissuing would burn a send and start a cooldown the user did not ask for. */
    const t2 = loadScreen({
      emailChallengeStatus: {
        ok: true, emailVerified: false, emailHint: 'a••@b.c',
        challenge: { expired: false, consumed: false, attemptsRemaining: 5, canResendAt: Date.now() + 40000 },
      },
      emailChallengeIssue: { ok: true },
    });
    await t2.screen.open({ user: makeUser({}), mount: t2.dom.mount });
    eq('A6  a live challenge is resumed, not resent', t2.calls.length, 1);
    ok('A7  ...and no issue call was made', !t2.calls.some((c) => c.op === 'emailChallengeIssue'));

    /* An expired challenge is NOT resumable. */
    const t3 = loadScreen({
      emailChallengeStatus: {
        ok: true, emailVerified: false,
        challenge: { expired: true, consumed: false, attemptsRemaining: 5, canResendAt: 0 },
      },
      emailChallengeIssue: { ok: true, delivered: true, cooldownMs: 60000 },
    });
    await t3.screen.open({ user: makeUser({}), mount: t3.dom.mount });
    ok('A8  an expired challenge triggers a fresh issue',
       t3.calls.some((c) => c.op === 'emailChallengeIssue'));

    /* A challenge with no attempts left is equally unusable. */
    const t4 = loadScreen({
      emailChallengeStatus: {
        ok: true, emailVerified: false,
        challenge: { expired: false, consumed: false, attemptsRemaining: 0, canResendAt: 0 },
      },
      emailChallengeIssue: { ok: true, delivered: true, cooldownMs: 60000 },
    });
    await t4.screen.open({ user: makeUser({}), mount: t4.dom.mount });
    ok('A9  a challenge with zero attempts left triggers a fresh issue',
       t4.calls.some((c) => c.op === 'emailChallengeIssue'));
  }

  /* ══ B · code entry ══════════════════════════════════════════════════════ */
  head('B · code entry');
  {
    const t = loadScreen({
      emailChallengeStatus: { ok: true, emailVerified: false, challenge: null },
      emailChallengeIssue: { ok: true, delivered: true, cooldownMs: 60000 },
      emailChallengeVerify: { ok: true, verified: true },
    }, { code: '123456' });
    const user = makeUser({ verifiesOnReload: true });
    await t.screen.open({ user, mount: t.dom.mount });
    enter(t, t._code); await t.screen._verify();

    const vc = t.calls.filter((c) => c.op === 'emailChallengeVerify');
    eq('B1  the code is sent to the server', vc.length, 1);
    eq('B2  ...exactly as entered', vc[0].code, '123456');
    ok('B3  the uid is never sent — the server takes it from the token',
       !t.calls.some((c) => c.uid));

    /* A short code must not reach the server at all. */
    const t2 = loadScreen({
      emailChallengeStatus: { ok: true, emailVerified: false, challenge: null },
      emailChallengeIssue: { ok: true, delivered: true, cooldownMs: 60000 },
      emailChallengeVerify: { ok: true, verified: true },
    }, { code: '12' });
    await t2.screen.open({ user: makeUser({}), mount: t2.dom.mount });
    enter(t2, t2._code); await t2.screen._verify();
    ok('B4  a too-short code is rejected locally, not sent',
       !t2.calls.some((c) => c.op === 'emailChallengeVerify'));
    ok('B5  ...and the field is marked invalid', t2.w.__otp._err === true);
  }

  /* ══ C · invalid / expired / max attempts ════════════════════════════════ */
  head('C · invalid, expired, consumed, attempt ceiling');
  {
    async function verifyWith(reason, extra) {
      const t = loadScreen({
        emailChallengeStatus: { ok: true, emailVerified: false, challenge: null },
        emailChallengeIssue: { ok: true, delivered: true, cooldownMs: 60000 },
        emailChallengeVerify: Object.assign({ ok: false, reason }, extra || {}),
      }, { code: '999999' });
      await t.screen.open({ user: makeUser({}), mount: t.dom.mount });
      enter(t, t._code); await t.screen._verify();
      return t;
    }

    const bad = await verifyWith('bad-code', { attemptsRemaining: 3 });
    ok('C1  a wrong code says so', /not correct/i.test(msgOf(bad.dom)), msgOf(bad.dom));
    ok('C2  ...and reports attempts remaining', /3 attempts left/.test(msgOf(bad.dom)), msgOf(bad.dom));
    eq('C3  ...as an error, never a success', msgKind(bad.dom), 'error');
    ok('C4  ...and the field is cleared and re-focused for the retry',
       bad.w.__otp._cleared > 0 && bad.w.__otp._focused > 0);

    const one = await verifyWith('bad-code', { attemptsRemaining: 1 });
    ok('C5  singular attempt is not "1 attempts"', /1 attempt left/.test(msgOf(one.dom)), msgOf(one.dom));

    const exp = await verifyWith('expired');
    ok('C6  expired is distinguished from wrong', /expired/i.test(msgOf(exp.dom)), msgOf(exp.dom));
    const con = await verifyWith('consumed');
    ok('C7  an already-used code is distinguished', /already been used/i.test(msgOf(con.dom)), msgOf(con.dom));
    const max = await verifyWith('max-attempts');
    ok('C8  the attempt ceiling is explained with a way forward',
       /Too many/i.test(msgOf(max.dom)) && /new code/i.test(msgOf(max.dom)), msgOf(max.dom));
    const mis = await verifyWith('mismatch');
    ok('C9  a changed address invalidates the challenge', /changed/i.test(msgOf(mis.dom)), msgOf(mis.dom));

    /* An unknown reason must degrade to a neutral failure, never leak a raw code and
       never read as success. */
    const unk = await verifyWith('some-new-server-reason');
    eq('C10 an unrecognised reason is still an error', msgKind(unk.dom), 'error');
    ok('C11 ...and does not leak the raw code to the user',
       !/some-new-server-reason/.test(msgOf(unk.dom)), msgOf(unk.dom));
    ok('C12 ...and no attempts-remaining is invented for it',
       !/attempt/.test(msgOf(unk.dom)), msgOf(unk.dom));
  }

  /* ══ D · resend + cooldown ═══════════════════════════════════════════════ */
  head('D · resend and cooldown');
  {
    const t = loadScreen({
      emailChallengeStatus: { ok: true, emailVerified: false, challenge: null },
      emailChallengeIssue: { ok: true, delivered: true, cooldownMs: 60000 },
    });
    await t.screen.open({ user: makeUser({}), mount: t.dom.mount });
    const resend = t.dom.byId.get('skvResendBtn');
    ok('D1  resend is disabled while the cooldown runs', resend.disabled === true);
    ok('D2  ...and the wait is stated in seconds',
       /another code in \d+s/.test((t.dom.byId.get('skvTimer') || {}).textContent),
       (t.dom.byId.get('skvTimer') || {}).textContent);

    /* The server refusing on cooldown must start the clock rather than just complaining. */
    const t2 = loadScreen({
      emailChallengeStatus: { ok: true, emailVerified: false, challenge: null },
      emailChallengeIssue: { ok: false, reason: 'cooldown', retryAfterMs: 45000 },
    });
    await t2.screen.open({ user: makeUser({}), mount: t2.dom.mount });
    ok('D3  a server cooldown is surfaced', /wait/i.test(msgOf(t2.dom)), msgOf(t2.dom));
    ok('D4  ...and starts the local countdown from retryAfterMs',
       /another code in (4[0-5])s/.test((t2.dom.byId.get('skvTimer') || {}).textContent),
       (t2.dom.byId.get('skvTimer') || {}).textContent);

    const t3 = loadScreen({
      emailChallengeStatus: { ok: true, emailVerified: false, challenge: null },
      emailChallengeIssue: { ok: false, reason: 'max-sends' },
    });
    await t3.screen.open({ user: makeUser({}), mount: t3.dom.mount });
    ok('D5  the send ceiling is explained', /several codes/i.test(msgOf(t3.dom)), msgOf(t3.dom));
    eq('D6  ...as an error', msgKind(t3.dom), 'error');

    /* delivered:false — the code exists but the mail did not leave. Telling the user to
       check their inbox would send them to wait for something that is not coming. */
    const t4 = loadScreen({
      emailChallengeStatus: { ok: true, emailVerified: false, challenge: null },
      emailChallengeIssue: { ok: true, delivered: false, deliveryError: 'opted_out', cooldownMs: 60000 },
    });
    await t4.screen.open({ user: makeUser({}), mount: t4.dom.mount });
    ok('D7  a code that was issued but not delivered says so',
       /could not send/i.test(msgOf(t4.dom)), msgOf(t4.dom));
    eq('D8  ...as an error, not a cheerful "check your inbox"', msgKind(t4.dom), 'error');
    ok('D9  ...and never claims the mail was sent',
       !/check your (inbox|email)/i.test(msgOf(t4.dom)), msgOf(t4.dom));
  }

  /* ══ E · loading states ══════════════════════════════════════════════════ */
  head('E · loading states — no double submit');
  {
    let release;
    const gate = new Promise((r) => { release = r; });
    const t = loadScreen({
      emailChallengeStatus: { ok: true, emailVerified: false, challenge: null },
      emailChallengeIssue: { ok: true, delivered: true, cooldownMs: 60000 },
      emailChallengeVerify: () => gate.then(() => ({ ok: true, verified: true })),
    }, { code: '123456' });
    const user = makeUser({ verifiesOnReload: true });
    await t.screen.open({ user, mount: t.dom.mount });

    enter(t, t._code);
    const p = t.screen._verify();
    const btn = t.dom.byId.get("skvVerifyBtn");
    ok("E1  the verify button is disabled in flight", btn.disabled === true);
    ok("E2  ...and says what is happening", /Verifying/.test(btn.textContent), btn.textContent);

    /* A second submit while the first is in flight must not produce a second call.
       NOT awaited before the gate is released — awaiting a call that is deliberately
       held open is a deadlock, which is how this block first hung. */
    const second = t.screen._verify();
    eq("E3  a second submit while busy is ignored",
       t.calls.filter((c) => c.op === "emailChallengeVerify").length, 1);

    release();
    await p; await second;
    ok("E4  the flow completed", user.emailVerified === true);
    ok("E5  ...and the button is released", t.dom.byId.get("skvVerifyBtn").disabled === false ||
       t.nav.length > 0);
  }

  /* ══ F · network / transport failure ═════════════════════════════════════ */
  head('F · transport failure never reads as success');
  {
    const t = loadScreen({
      emailChallengeStatus: { ok: true, emailVerified: false, challenge: null },
      emailChallengeIssue: { ok: true, delivered: true, cooldownMs: 60000 },
      emailChallengeVerify: Object.assign(new Error('unavailable'), { code: 'unavailable' }),
    }, { code: '123456' });
    const user = makeUser({});
    await t.screen.open({ user, mount: t.dom.mount });
    enter(t, t._code); await t.screen._verify();

    eq('F1  a thrown call is an error state', msgKind(t.dom), 'error');
    ok('F2  ...phrased for a person', /connection|server/i.test(msgOf(t.dom)), msgOf(t.dom));
    eq('F3  ...and never navigates', t.nav.length, 0);
    eq('F4  ...and the user is still unverified', user.emailVerified, false);
    ok('F5  ...and the button is usable again', t.dom.byId.get('skvVerifyBtn').disabled === false);

    /* An empty/undefined response body is not a success either. */
    const t2 = loadScreen({
      emailChallengeStatus: { ok: true, emailVerified: false, challenge: null },
      emailChallengeIssue: { ok: true, delivered: true, cooldownMs: 60000 },
      emailChallengeVerify: undefined,
    }, { code: '123456' });
    await t2.screen.open({ user: makeUser({}), mount: t2.dom.mount });
    enter(t2, t2._code); await t2.screen._verify();
    eq('F6  an empty response is an error, not a pass', msgKind(t2.dom), 'error');
    eq('F7  ...and does not navigate', t2.nav.length, 0);
  }

  /* ══ G · NO FALSE SUCCESS — the one that matters ═════════════════════════ */
  head('G · success is proven against a refreshed token, never taken on trust');
  {
    /* The server says verified. The Auth record does NOT agree. The screen must refuse
       to celebrate, because the gate is about to refuse this user anyway. */
    const t = loadScreen({
      emailChallengeStatus: { ok: true, emailVerified: false, challenge: null },
      emailChallengeIssue: { ok: true, delivered: true, cooldownMs: 60000 },
      emailChallengeVerify: { ok: true, verified: true },
    }, { code: '123456' });
    const stubborn = makeUser({});                       /* reload does NOT flip the flag */
    await t.screen.open({ user: stubborn, mount: t.dom.mount });
    enter(t, t._code); await t.screen._verify();

    ok('G1  the token was refreshed before any claim', stubborn.reloadCalls > 0);
    eq('G2  ok:true + unverified token → ERROR, not success', msgKind(t.dom), 'error');
    ok('G3  ...and the word "confirmed" is never shown',
       !/confirmed/i.test(msgOf(t.dom)), msgOf(t.dom));
    eq('G4  ...and it does NOT navigate into the app', t.nav.length, 0);

    /* The honest path: the flag really does flip. */
    const t2 = loadScreen({
      emailChallengeStatus: { ok: true, emailVerified: false, challenge: null },
      emailChallengeIssue: { ok: true, delivered: true, cooldownMs: 60000 },
      emailChallengeVerify: { ok: true, verified: true },
    }, { code: '123456' });
    const real = makeUser({ verifiesOnReload: true });
    t2.screen._navigateOverride = (target) => t2.nav.push(target);
    await t2.screen.open({ user: real, mount: t2.dom.mount, next: 'wallet.html' });
    enter(t2, t2._code); await t2.screen._verify();
    ok('G5  a genuine verification is confirmed', /confirmed/i.test(msgOf(t2.dom)), msgOf(t2.dom));
    eq('G6  ...as a success', msgKind(t2.dom), 'success');
    eq('G7  ...and navigates to the saved destination', t2.nav[0], 'wallet.html');

    /* Reload failing is not proof either. */
    const t3 = loadScreen({
      emailChallengeStatus: { ok: true, emailVerified: false, challenge: null },
      emailChallengeIssue: { ok: true, delivered: true, cooldownMs: 60000 },
      emailChallengeVerify: { ok: true, verified: true },
    }, { code: '123456' });
    await t3.screen.open({ user: makeUser({ reloadThrows: true }), mount: t3.dom.mount });
    enter(t3, t3._code); await t3.screen._verify();
    eq('G8  a reload that fails cannot confirm anything', msgKind(t3.dom), 'error');
    eq('G9  ...and does not navigate', t3.nav.length, 0);

    /* Already-verified on open should pass straight through, still via the proof path. */
    const t4 = loadScreen({
      emailChallengeStatus: { ok: true, emailVerified: true, challenge: null },
    });
    const already = makeUser({ emailVerified: true });
    t4.screen._navigateOverride = (target) => t4.nav.push(target);
    await t4.screen.open({ user: already, mount: t4.dom.mount, next: 'index.html' });
    eq('G10 an already-verified user is passed through', t4.nav[0], 'index.html');
    ok('G11 ...without issuing a pointless code',
       !t4.calls.some((c) => c.op === 'emailChallengeIssue'));
  }

  /* ══ H · back / change-account path ══════════════════════════════════════ */
  head('H · the back path leaves no half-session behind');
  {
    const t = loadScreen({
      emailChallengeStatus: { ok: true, emailVerified: false, challenge: null },
      emailChallengeIssue: { ok: true, delivered: true, cooldownMs: 60000 },
    });
    await t.screen.open({ user: makeUser({}), mount: t.dom.mount });
    t.w.sessionStorage.setItem('sokoniVerifyPending', '{"uid":"u1"}');
    await t.screen._back();
    await new Promise((r) => setImmediate(r));

    eq('H1  it signs out of Firebase', t.signOuts.length, 1);
    eq('H2  ...clears the pending marker', t.w.sessionStorage.getItem('sokoniVerifyPending'), null);
    eq('H3  ...and returns to a clean login', t.nav[t.nav.length - 1], 'login.html');
  }

  /* ══ I · the screen's own limits ═════════════════════════════════════════ */
  head('I · what the screen must never contain');
  {
    const src = read('sokoni-verify-screen.js');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

    ok('I1  it cannot generate a code — no randomness', !/Math\.random|crypto\./.test(code));
    ok('I2  it stores no code anywhere persistent',
       !/localStorage\.setItem|sessionStorage\.setItem\([^)]*code/i.test(code));
    ok('I3  it never reads a verified flag from storage',
       !/(localStorage|sessionStorage)[\s\S]{0,40}(verified|emailVerified)/.test(code));
    ok('I4  it takes the uid from nobody — never sends one', !/uid:\s*/.test(code));
    ok('I5  the only backend it talks to is authDispatch',
       (code.match(/httpsCallable\(|sokoniCallable\(/g) || []).length > 0 &&
       !/adminOsDispatch|commerceDispatch|initiateSTKPush/.test(code));
    ok('I6  success is gated on emailVerified === true, explicitly',
       /emailVerified\s*===\s*true/.test(code));
  }

  /* ══ J · wiring ══════════════════════════════════════════════════════════ */
  head('J · wiring and slice boundary');
  {
    const html = read('login.html');
    ok('J1  login.html has the mount point', /id="skvMount"/.test(html));
    ok('J2  ...hidden by default', /id="skvMount"[^>]*display:none/.test(html));
    ok('J3  ...and loads the screen', /src="sokoni-verify-screen\.js"/.test(html));
    ok('J4  the screen loads BEFORE auth.js, which hands off to it',
       html.indexOf('sokoni-verify-screen.js') < html.indexOf('src="auth.js"'));
    ok('J5  sokoni-otp.js is present, since the screen mounts it',
       /src="sokoni-otp\.js"/.test(html));

    const au = read('auth.js');
    ok('J6  the gated branch hands off to the screen', /SokoniVerifyScreen\.open/.test(au));
    ok('J7  ...passing the user object, not a uid from the page',
       /user:\s*cred\.user/.test(au));
    ok('J8  ...and still writes no session', !/_verdict[\s\S]{0,900}setItem\("loggedIn"/.test(au));
    const gated = braceBlock(au, '_verdict.gated');
    ok('J9a the gated branch was located', gated.length > 0);
    ok('J9  a missing screen fails loudly rather than looking like a dead click',
       /could not load/i.test(gated) && /\belse\b/.test(gated));

    /* PRE-EXISTING FINDING, reported rather than silently accepted: auth.js carries
       FIVE copies of the same open-redirect guard. Slice 4 removed the one inside
       loginUser by extracting _sokoniLoginRedirect, which the login path and the
       verification screen now share. The other four live in the bootstrap (2) and the
       Google/OAuth fallbacks (2) — paths this slice is not authorised to touch.
       Ratcheted at the current count so a sixth copy fails here. */
    const copies = (au.match(/includes\('\/\/'\)/g) || []).length;
    eq('J10 open-redirect guard copies held at the documented count', copies, 5);
    ok('J10b loginUser no longer carries its own inline copy — it uses the helper',
       !/const _rawRedir/.test(au) && /_safeRedir = _sokoniLoginRedirect\(\)/.test(au));
    ok('J11 the held user\'s destination is peeked, not consumed',
       /_sokoniLoginRedirect\(true\)/.test(au));

    const css = read('auth.css');
    ok('J12 the card take-over rule exists', /\.auth-card\.skv-active/.test(css));
    ok('J13 ...and keeps the brand visible so the user knows where they are',
       /not\(\.auth-brand\)/.test(css));

    /* Boundary: no Slice 5, no Stories, no rules. */
    ok('J14 firestore.rules untouched', !/skv|VerifyScreen/i.test(read('firestore.rules')));
    const stories = fs.readdirSync(ROOT).filter((f) => /^sokoni-stories|^stories\./i.test(f))
      .filter((f) => /VerifyScreen/.test(read(f)));
    eq('J15 Stories untouched', stories.length, 0);
    ok('J16 the gate from Slice 3 is unchanged by this slice',
       !/SokoniVerifyScreen/.test(read('sokoni-verify-gate.js')));

    const cp = require('child_process');
    for (const f of ['auth.css', 'login.html']) {
      const st2 = cp.execSync('git diff --numstat HEAD -- ' + f, { cwd: ROOT, encoding: 'utf8' }).trim();
      const dels = st2 ? Number(st2.split(/\s+/)[1]) : 0;
      eq('J17 ' + f + ' is a pure addition', dels, 0);
    }

    /* auth.js legitimately DELETES lines: the old gated-branch message and the inline
       redirect sanitiser it replaced. A line budget would be a number nobody can check,
       so assert WHAT went instead — nothing removed may touch a session write, an
       authentication call, or a security guard that is not re-added by the helper. */
    const removed = cp.execSync('git diff -U0 HEAD -- auth.js', { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter((l) => /^-/.test(l) && !/^---/.test(l)).map((l) => l.slice(1));
    ok('J18 no removed line wrote a session',
       !removed.some((l) => /loggedIn|sokoniUser|setSession/.test(l)),
       removed.filter((l) => /loggedIn|sokoniUser|setSession/.test(l)).join(' | '));
    ok('J19 no removed line performed authentication',
       !removed.some((l) => /signInWith|createUserWith|updateUser|signOut/.test(l)),
       removed.filter((l) => /signInWith|createUserWith/.test(l)).join(' | '));
    ok('J20 the only removed guard is the sanitiser, and it still exists in the helper',
       removed.filter((l) => /includes\('\/\/'\)/.test(l)).length === 1 &&
       /includes\('\/\/'\)/.test(read('auth.js')),
       removed.filter((l) => /includes/.test(l)).join(' | '));
  }

  /* ══ K · positive controls ═══════════════════════════════════════════════
     Break the screen on purpose and require the answer to change. Without these, a
     green G block proves only that the code runs — not that the assertions would catch
     the defect they name. */
  head('K · positive controls');
  {
    const PLAN = {
      emailChallengeStatus: { ok: true, emailVerified: false, challenge: null },
      emailChallengeIssue: { ok: true, delivered: true, cooldownMs: 60000 },
      emailChallengeVerify: { ok: true, verified: true },
    };

    /* K1 — trust the response instead of proving it against the refreshed token.
       This is precisely the false success G exists to forbid. */
    const m1 = loadScreen(PLAN, {
      code: '123456',
      mutate: ['var verified = !!(S.user && S.user.emailVerified === true);', 'var verified = true;'],
    });
    const stubborn1 = makeUser({});
    m1.screen._navigateOverride = (t) => m1.nav.push(t);
    await m1.screen.open({ user: stubborn1, mount: m1.dom.mount, next: 'index.html' });
    enter(m1, '123456');
    await m1.screen._verify();
    ok('K1  the mutant celebrates an unverified account — so G2/G3 really bite',
       /confirmed/i.test(msgOf(m1.dom)) && m1.nav.length > 0,
       msgOf(m1.dom) + ' nav=' + m1.nav.length);

    /* K2 — drop the in-flight guard, and a double submit becomes two verifications. */
    let release2;
    const gate2 = new Promise((r) => { release2 = r; });
    const m2 = loadScreen(Object.assign({}, PLAN, {
      emailChallengeVerify: () => gate2.then(() => ({ ok: true, verified: true })),
    }), { code: '123456', mutate: ['if (S.busy) return Promise.resolve();\n    var code =', 'var code ='] });
    const u2 = makeUser({ verifiesOnReload: true });
    await m2.screen.open({ user: u2, mount: m2.dom.mount });
    enter(m2, '123456');
    const a = m2.screen._verify(); enter(m2, '123456');
    const b = m2.screen._verify();
    ok('K2  the mutant double-submits — so E3 really bites',
       m2.calls.filter((c) => c.op === 'emailChallengeVerify').length === 2,
       String(m2.calls.filter((c) => c.op === 'emailChallengeVerify').length));
    release2(); await a; await b;

    /* K3 — always issue on open, ignoring a live challenge: burns a send and starts a
       cooldown the user never asked for. */
    const m3 = loadScreen({
      emailChallengeStatus: {
        ok: true, emailVerified: false,
        challenge: { expired: false, consumed: false, attemptsRemaining: 5, canResendAt: Date.now() + 40000 },
      },
      emailChallengeIssue: { ok: true, delivered: true, cooldownMs: 60000 },
    }, { mutate: ['if (live) {', 'if (false) {'] });
    await m3.screen.open({ user: makeUser({}), mount: m3.dom.mount });
    ok('K3  the mutant resends over a live challenge — so A6/A7 really bite',
       m3.calls.some((c) => c.op === 'emailChallengeIssue'));
  }

  /* ── result ────────────────────────────────────────────────────────────── */
  console.log('\n' + '─'.repeat(70));
  if (fail) { console.log('\x1b[31mFAILURES\x1b[0m'); failures.forEach((f) => console.log('  ✗ ' + f)); }
  console.log((fail ? '\x1b[31m' : '\x1b[32m') + 'auth verify screen: ' + pass + '/' + (pass + fail) + '\x1b[0m');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
