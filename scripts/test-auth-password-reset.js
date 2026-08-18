#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   PASSWORD RESET — failure must be visible, existence must not be
   ------------------------------------------------------------------------------
   The reset flow used to show its confirmation panel unconditionally. Two paths
   produced "check your inbox" for an email that was never sent:

     · `if(window.firebaseAuth)` wrapped the send with no else — the SDK not being
       ready meant nothing was requested, and the panel appeared anyway.
     · `catch(e){}` was empty — every failure fell through to the same panel.

   This suite pins both directions of the fix:

     HONEST FAILURE     a real failure shows a real message and NO confirmation panel
     NO ENUMERATION     existence-revealing codes are indistinguishable from success

   Those two pull against each other, which is why they are tested together: a fix
   that surfaces auth/user-not-found would pass "honest failure" and leak the user
   table. A fix that swallows everything would pass "no enumeration" and restore the
   original defect.

   The Firebase SDK import is stubbed at the network boundary, so auth.js runs
   completely unmodified and each case chooses what the SDK does.

     node scripts/test-auth-password-reset.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const { webkit } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
  console.log('    ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + String(detail).replace(/\s+/g,' ').slice(0,110) + ']' : ''));
  if (ok) pass++; else { fail++; failures.push(label + (detail ? '  → ' + detail : '')); }
  return ok;
};

/* A page carrying only what requestPasswordReset() touches. Nothing else from
   login.html is involved, so a failure here is about the reset flow and not about
   whatever else that page happens to be doing. */
const HARNESS = `<!doctype html><meta charset="utf-8"><title>reset harness</title>
<div id="authMsg"></div>
<input id="resetEmail">
<div id="resetStep1"></div>
<div id="resetStep2"></div>
<script>
  window.__resetCalls = [];
  window.__resetMode  = 'ok';
</script>
<script src="/auth.js"></script>`;

/* Stub standing in for the real firebase-auth module. */
const STUB = `
export async function sendPasswordResetEmail(auth, email){
  globalThis.__resetCalls.push(email);
  const mode = globalThis.__resetMode;
  if (mode && mode !== 'ok') { const e = new Error(mode); e.code = mode; throw e; }
}
export default {};
`;

const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css',
  '.json':'application/json', '.png':'image/png', '.svg':'image/svg+xml', '.ico':'image/x-icon' };

/* AUTH_JS_PATH swaps in a different auth.js. Its purpose is the NEGATIVE CONTROL:
   point it at the pre-fix file (`git show <sha>:auth.js > /tmp/auth-legacy.js`) and
   this suite must FAIL. A regression test that has never been seen to fail is not
   evidence that it pins anything. */
const AUTH_JS = process.env.AUTH_JS_PATH || path.join(ROOT, 'auth.js');

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/' || p === '/harness.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(HARNESS);
  }
  const f = (p === '/auth.js') ? AUTH_JS : path.join(ROOT, p);
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'text/plain' });
    res.end(d);
  });
});

const wd = setTimeout(() => { console.log('\nWATCHDOG — 4 min'); process.exit(1); }, 240000);
wd.unref && wd.unref();

server.listen(0, async () => {
  const BASE = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try { browser = await webkit.launch(); }
  catch (e) { console.log('SKIP — webkit unavailable: ' + (e && e.message)); server.close(); process.exit(0); return; }

  const ctx = await browser.newContext();
  await ctx.route('https://www.gstatic.com/**/firebase-auth.js', (route) =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: STUB }));

  const page = await ctx.newPage();
  await page.goto(BASE + '/harness.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => typeof window.requestPasswordReset === 'function', null, { timeout: 15000 })
    .catch(() => null);

  const exists = await page.evaluate(() => typeof window.requestPasswordReset === 'function');
  if (!ck('requestPasswordReset is reachable from the harness', exists)) {
    console.log('\n  Cannot continue — auth.js did not expose the function.\n');
    clearTimeout(wd); await browser.close(); server.close(); process.exit(1);
  }

  /* Drive one case: set the email + what the SDK should do, call, read the DOM back. */
  const run = async ({ email, mode, firebaseReady = true, security = null }) => page.evaluate(async (o) => {
    window.__resetCalls = [];
    window.__resetMode  = o.mode;
    window.firebaseAuth = o.firebaseReady ? { __stub: true } : null;
    if (o.security === 'blocked')      window.SokoniSecurity = { persistentRateLimit: () => false, audit: () => {} };
    else if (o.security === 'allowed') window.SokoniSecurity = { persistentRateLimit: () => true,  audit: () => {} };
    else                               delete window.SokoniSecurity;

    document.getElementById('authMsg').textContent = '';
    document.getElementById('authMsg').className = '';
    document.getElementById('resetStep1').innerHTML = '';
    document.getElementById('resetEmail').value = o.email;

    await window.requestPasswordReset();

    const msgEl = document.getElementById('authMsg');
    const panel = document.getElementById('resetStep1').innerHTML || '';
    return {
      msg: msgEl.textContent || '',
      cls: msgEl.className || '',
      confirmed: /reset link has been sent/i.test(panel),
      panelText: panel.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      calls: window.__resetCalls.length,
    };
  }, { email, mode, firebaseReady, security });

  console.log('\n' + '='.repeat(74));
  console.log('  PASSWORD RESET — honest failure vs enumeration protection');
  console.log('='.repeat(74));

  /* ── 1 · nothing is attempted, and nothing is claimed ────────────────────── */
  console.log('\n1. NOTHING SENT ⇒ NOTHING CLAIMED');

  let r = await run({ email: 'merchant@example.com', mode: 'ok', firebaseReady: false });
  ck('SDK not ready: no send attempted', r.calls === 0, 'calls=' + r.calls);
  ck('SDK not ready: NO confirmation panel', !r.confirmed, r.confirmed ? 'claimed sent' : 'none');
  ck('SDK not ready: says so', /starting up/i.test(r.msg), r.msg);

  r = await run({ email: 'not-an-email', mode: 'ok' });
  ck('malformed address: no send attempted', r.calls === 0, 'calls=' + r.calls);
  ck('malformed address: NO confirmation panel', !r.confirmed);
  ck('malformed address: says so', /valid email/i.test(r.msg), r.msg);

  r = await run({ email: '', mode: 'ok' });
  ck('empty address: no send attempted', r.calls === 0, 'calls=' + r.calls);
  ck('empty address: NO confirmation panel', !r.confirmed);

  r = await run({ email: 'merchant@example.com', mode: 'ok', security: 'blocked' });
  ck('rate limited: no send attempted', r.calls === 0, 'calls=' + r.calls);
  ck('rate limited: NO confirmation panel', !r.confirmed);
  ck('rate limited: tells the user the limit was hit', /too many/i.test(r.msg), r.msg);

  /* ── 2 · a real failure is surfaced ──────────────────────────────────────── */
  console.log('\n2. REAL FAILURE ⇒ REAL MESSAGE, NO FALSE CONFIRMATION');

  for (const [mode, expect] of [
    ['auth/network-request-failed', /connection|internet/i],
    ['auth/too-many-requests',      /too many/i],
    ['auth/invalid-email',          /valid email/i],
    ['auth/internal-error',         /temporarily unavailable/i],
    ['auth/some-unmapped-code',     /could not send/i],
  ]) {
    r = await run({ email: 'merchant@example.com', mode });
    ck(mode + ': the SDK was actually called', r.calls === 1, 'calls=' + r.calls);
    ck(mode + ': NO confirmation panel', !r.confirmed, r.confirmed ? 'FALSE SUCCESS' : 'none');
    ck(mode + ': actionable message', expect.test(r.msg), r.msg);
    ck(mode + ': styled as an error', /error/.test(r.cls), r.cls);
  }

  /* ── 3 · enumeration protection survives the fix ─────────────────────────── */
  console.log('\n3. EXISTENCE IS NEVER REVEALED');

  const okCase = await run({ email: 'merchant@example.com', mode: 'ok' });
  ck('success: confirmation panel shown', okCase.confirmed);
  ck('success: SDK called exactly once', okCase.calls === 1, 'calls=' + okCase.calls);

  for (const mode of ['auth/user-not-found', 'auth/user-disabled', 'auth/invalid-recipient-email']) {
    r = await run({ email: 'stranger@example.com', mode });
    ck(mode + ': treated exactly like success', r.confirmed, r.confirmed ? 'neutral panel' : 'LEAK — diverged from success');
    ck(mode + ': no error message shown', r.msg === '', r.msg);
    /* The decisive property: a caller cannot tell this case from the success case. */
    ck(mode + ': indistinguishable from a registered address',
       r.confirmed === okCase.confirmed && r.msg === okCase.msg,
       'panel=' + r.confirmed + ' msg="' + r.msg + '"');
  }

  /* ── 4 · the Google-only account is told what to do ──────────────────────── */
  console.log('\n4. GOOGLE-ONLY ACCOUNTS ARE NOT LEFT WAITING');
  ck('confirmation panel names the Google case', /continue with google/i.test(okCase.panelText),
     okCase.panelText.slice(0, 120));
  ck('panel no longer promises a link unconditionally',
     /registered with a password/i.test(okCase.panelText), okCase.panelText.slice(0, 120));
  /* The hint is generic on purpose — it must not depend on the address typed in. */
  const strangerPanel = (await run({ email: 'stranger@example.com', mode: 'auth/user-not-found' })).panelText;
  ck('the Google hint is identical for an unknown address (reveals nothing)',
     /continue with google/i.test(strangerPanel));

  console.log('\n' + '='.repeat(74));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  if (fail) { console.log('\n  FAILURES:'); failures.forEach(f => console.log('    ✗ ' + f)); }
  console.log('='.repeat(74) + '\n');

  clearTimeout(wd);
  await browser.close(); server.close();
  process.exit(fail ? 1 : 0);
});
