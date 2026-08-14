/* Workstream C — Email/Password certification against PRODUCTION.

   Drives the real page and the real Firebase SDK. Disposable account, destroyed
   at the end and the teardown verified. No production user is touched. */
'use strict';
const { webkit, devices } = require('playwright');
const fs = require('fs');

const cfg = fs.readFileSync('./sokoni-config.js', 'utf8');
const API_KEY = (cfg.match(/apiKey:\s*"([^"]+)"/) || [])[1];
const IDT = 'https://identitytoolkit.googleapis.com/v1/accounts';
const BASE = 'https://sokoni-aeb26.web.app';

let pass = 0, fail = 0;
/* Shorter than this suite's runner budget (150000ms) ON PURPOSE. Without one, a hang is
   SIGKILLed by the runner and recorded as TIMEOUT -- not a defect verdict -- so the suite leaves
   the blocking set silently. Measured cost of this suite is far below the value chosen, so this
   fires only when the runner was going to kill it anyway. */
const _wd = setTimeout(() => { console.log('\n  WATCHDOG — suite exceeded 135s'); process.exit(1); }, 135000);
/* unref: the watchdog must never be the reason the process stays alive. A suite that
   finishes normally exits immediately; one that is genuinely stuck still has a live event
   loop, so the timer still fires and self-reports instead of being SIGKILLed silently. */
if (_wd && _wd.unref) _wd.unref();
const check = (l, ok, d) => { console.log('  ' + (ok?'PASS  ':'FAIL  ') + l + (d?'   ['+d+']':'')); ok?pass++:fail++; };
const post = (u, b) => fetch(u, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(b) })
  .then(async r => ({ status:r.status, body: await r.json().catch(()=>({})) }));

(async () => {
  const stamp = 'cert' + Math.abs(Date.now() % 1000000);
  const email = stamp + '@sokoni-cert.invalid';
  const pw    = 'Cert!' + stamp + 'Aa';
  let idToken = null, uid = null;

  const browser = await webkit.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => { const m=String(e.message); if(!/ResizeObserver loop/.test(m)) errs.push(m.slice(0,120)); });

  try {
    await page.goto(BASE + '/login.html', { waitUntil:'domcontentloaded', timeout:45000 });
    await page.waitForTimeout(8000);
    const acc = await page.$('#_sokoniPrivacyAcceptBtn');
    if (acc) { await acc.click({force:true}).catch(()=>{}); await page.waitForTimeout(1500); }

    console.log('\n── C1: Sign-up ──');
    const su = await page.evaluate(async ({ email, pw }) => {
      const m = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
      try { const c = await m.createUserWithEmailAndPassword(window.firebaseAuth, email, pw);
            return { ok:true, uid:c.user.uid, token: await c.user.getIdToken() }; }
      catch (e) { return { ok:false, code:e&&e.code, msg:e&&e.message }; }
    }, { email, pw });
    check('createUserWithEmailAndPassword succeeds', su.ok === true, su.code || ('uid ' + String(su.uid).slice(0,8)));
    if (!su.ok) throw new Error('signup failed: ' + su.code);
    uid = su.uid; idToken = su.token;

    console.log('\n── C2: Sign-out clears state ──');
    const so = await page.evaluate(async () => {
      const m = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
      await m.signOut(window.firebaseAuth);
      await new Promise(r => setTimeout(r, 1200));
      return { current: !!window.firebaseAuth.currentUser,
               loggedIn: localStorage.getItem('loggedIn'),
               cachedUser: !!localStorage.getItem('sokoniUser') };
    });
    check('signOut clears currentUser', so.current === false);
    check('signOut clears loggedIn flag', !so.loggedIn || so.loggedIn === 'false', String(so.loggedIn));
    check('signOut clears cached profile', so.cachedUser === false, String(so.cachedUser));

    console.log('\n── C3: Sign-in (returning user) ──');
    const si = await page.evaluate(async ({ email, pw }) => {
      const m = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
      try { const c = await m.signInWithEmailAndPassword(window.firebaseAuth, email, pw);
            return { ok:true, uid:c.user.uid, emailVerified:c.user.emailVerified }; }
      catch (e) { return { ok:false, code:e&&e.code }; }
    }, { email, pw });
    check('signInWithEmailAndPassword succeeds', si.ok === true, si.code || '');
    check('same uid returned on re-auth', si.uid === uid);

    console.log('\n── C4: Session persists to another page ──');
    await page.waitForTimeout(4000);
    await page.goto(BASE + '/profile.html', { waitUntil:'domcontentloaded', timeout:45000 });
    await page.waitForTimeout(9000);
    const landed = new URL(page.url()).pathname;
    check('authenticated user is NOT bounced to /login', !/login/.test(landed), 'landed ' + landed);
    const persisted = await page.evaluate(() => ({
      current: !!(window.firebaseAuth && window.firebaseAuth.currentUser),
    }));
    check('session persists across navigation', persisted.current === true);

    console.log('\n── C5: Wrong password is rejected ──');
    const bad = await page.evaluate(async ({ email }) => {
      const m = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
      try { await m.signInWithEmailAndPassword(window.firebaseAuth, email, 'WrongPassword123!'); return { ok:true }; }
      catch (e) { return { ok:false, code:e&&e.code }; }
    }, { email });
    check('wrong password refused', bad.ok === false, bad.code);
    check('refusal uses a credential error code',
          /invalid-credential|wrong-password|invalid-login/.test(bad.code || ''), bad.code);

    console.log('\n── C6: Password reset ──');
    const rs = await page.evaluate(async ({ email }) => {
      const m = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
      try { await m.sendPasswordResetEmail(window.firebaseAuth, email); return { ok:true }; }
      catch (e) { return { ok:false, code:e&&e.code }; }
    }, { email });
    check('sendPasswordResetEmail accepted', rs.ok === true, rs.code || '');

    console.log('\n── C7: Email verification send ──');
    const ev = await page.evaluate(async () => {
      const m = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
      try { if (!window.firebaseAuth.currentUser) return { ok:false, code:'no-current-user' };
            await m.sendEmailVerification(window.firebaseAuth.currentUser); return { ok:true }; }
      catch (e) { return { ok:false, code:e&&e.code }; }
    });
    check('sendEmailVerification accepted', ev.ok === true, ev.code || '');

    console.log('\n── Page health ──');
    check('no unexpected page errors during the flow', errs.length === 0, errs[0] || 'none');

  } catch (e) {
    console.log('  ERROR: ' + String(e.message).slice(0, 160)); fail++;
  } finally {
    if (idToken) await post(`${IDT}:delete?key=${API_KEY}`, { idToken }).catch(()=>{});
    const look = await post(`${IDT}:lookup?key=${API_KEY}`, { idToken: idToken || 'x' }).catch(()=>({body:{}}));
    check('test account destroyed', !(look.body && look.body.users && look.body.users.length));
    console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
    /* REPORT FIRST, THEN TEAR DOWN — teardown must never decide the verdict.
       Measured in the gate: suites printed every assertion PASS and were then SIGKILLed
       at their budget because close() never returned, so a finished result was recorded
       as TIMEOUT -- a non-blocking verdict -- and its coverage vanished silently. */
    await Promise.race([
      (async () => { try { await browser.close(); } catch (_) {} })(),
      new Promise((r) => setTimeout(r, 8000)),
    ]);
    process.exit(fail ? 1 : 0);
  }
})();
