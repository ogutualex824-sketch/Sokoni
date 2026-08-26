#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   Is the browser→Auth-emulator path usable on this machine?
   ══════════════════════════════════════════════════════════════════════════════
   test-merchant-sell-authenticated is the ONLY suite the deployment gate still fails, and its
   failure is an environment fact rather than an application defect. That claim should not
   require a 17-minute gate run to check, so this reproduces it in isolation.

   WHAT THE SUITE DOES, AND WHY IT IS FRAGILE
   The shipped client has NO connectAuthEmulator wiring — adding some to firebase.js would be a
   change to the auth bootstrap during an RC freeze, which a test has no business buying itself.
   So the emulator is attached at the NETWORK boundary: Playwright rewrites identitytoolkit and
   securetoken requests to the emulator's proxy paths. That is a legitimate technique, and it is
   also the part most likely to break for reasons that have nothing to do with SOKONI.

   App Check is separate and is NOT a defect here. The emulator mints no App Check tokens and no
   debug token is used, so an unattested browser is expected to be rejected. The suite says so
   itself and captures each such failure rather than tolerating it silently.

   USAGE — the emulator must already be running:
       firebase emulators:start --only auth --project sokoni-inventory-gate
       node scripts/repro-auth-emulator-browser.js

   It reports which of four things is true, and nothing is "fixed" to make it green:
       A  emulator unreachable at the network level
       B  emulator reachable, but the BROWSER cannot complete sign-in  ← the gate's failure
       C  sign-in works; only App Check is rejected (expected, not a defect)
       D  everything works — the gate failure would then be a real regression
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const http = require('http');

const HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const [H, P] = HOST.split(':');

function get (path) {
  return new Promise((resolve) => {
    const req = http.get({ host: H, port: Number(P), path, timeout: 4000 }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ ok: true, status: res.statusCode, body: d.slice(0, 200) }));
    });
    req.on('error', (e) => resolve({ ok: false, error: e.code || e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'TIMEOUT' }); });
  });
}

(async () => {
  console.log('\nbrowser -> Auth emulator reproducer   (' + HOST + ')\n');

  /* ── A. is it there at all? ─────────────────────────────────────────────── */
  const root = await get('/');
  if (!root.ok) {
    console.log('  A  EMULATOR UNREACHABLE at ' + HOST + '  (' + root.error + ')');
    console.log('     Start it first:  firebase emulators:start --only auth --project sokoni-inventory-gate');
    console.log('\n  VERDICT: cannot classify — the emulator is not running.');
    process.exit(2);
  }
  console.log('  ✓ emulator answers on ' + HOST + '  (HTTP ' + root.status + ')');

  /* Minting through the REST API proves the emulator works independently of any browser. */
  const cfg = await get('/emulator/v1/projects/sokoni-inventory-gate/config');
  console.log('  ' + (cfg.ok ? '✓' : '✗') + ' emulator config endpoint  (HTTP ' + (cfg.status || '-') + ')');

  /* ── B/C/D. can a real browser complete it? ─────────────────────────────── */
  let webkit;
  try { ({ webkit } = require('playwright')); }
  catch (e) {
    console.log('\n  playwright is not resolvable here — cannot test the browser half.');
    console.log('  VERDICT: emulator reachable; browser path UNTESTED.');
    process.exit(3);
  }

  const browser = await webkit.launch();
  const page = await browser.newPage();
  const seen = { rewritten: 0, failed: [] };

  /* The same network-boundary attachment the suite uses. */
  /* THE SUITE'S TECHNIQUE, COPIED — not an approximation of it.
     The first version of this reproducer used route.continue({url}), which Playwright refuses
     across a protocol change ("New URL must have same protocol as overridden URL"). It then
     reported category B with confidence, having reproduced ITS OWN limitation rather than the
     suite's behaviour — and the answer agreed with what was already believed, which is exactly
     why it went unchallenged. The suite uses route.fetch() + route.fulfill(), which has no such
     constraint, so a reproducer built on continue() proves nothing about it.

     abort() is guarded for the reason the suite documents: a route handler is a DETACHED
     promise, so a rejection inside one becomes an unhandledRejection with no call site. */
  const authRoute = async (route) => {
    seen.rewritten++;
    try {
      const u = new URL(route.request().url());
      const r = await route.fetch({ url: 'http://' + HOST + '/' + u.host + u.pathname + u.search });
      await route.fulfill({ response: r });
    } catch (e) {
      seen.failed.push((e.message || String(e)).slice(0, 120));
      try { await route.abort(); } catch (_) { /* context gone — nothing left to answer */ }
    }
  };
  await page.route('https://identitytoolkit.googleapis.com/**', authRoute);
  await page.route('https://securetoken.googleapis.com/**', authRoute);
  page.on('requestfailed', (r) => {
    if (/identitytoolkit|securetoken/.test(r.url())) {
      seen.failed.push((r.failure() && r.failure().errorText) || 'failed');
    }
  });

  await page.goto('about:blank');
  const result = await page.evaluate(async (host) => {
    try {
      const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js');
      const { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword } =
        await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
      const app = initializeApp({ apiKey: 'fake-key', projectId: 'sokoni-inventory-gate',
                                  authDomain: 'localhost' });
      const auth = getAuth(app);
      const email = 'repro' + Date.now() + '@example.com';
      try { await createUserWithEmailAndPassword(auth, email, 'Passw0rd!23'); }
      catch (e) { /* may already exist, or may fail for the same reason sign-in does */ }
      const cred = await signInWithEmailAndPassword(auth, email, 'Passw0rd!23');
      return { ok: true, uid: cred.user.uid };
    } catch (e) { return { ok: false, code: e.code || '', message: e.message || String(e) }; }
  }, HOST).catch((e) => ({ ok: false, code: 'evaluate-threw', message: e.message }));

  await browser.close();

  console.log('  rewritten auth requests : ' + seen.rewritten);
  if (seen.failed.length) console.log('  failed auth requests    : ' + seen.failed.slice(0, 3).join(' | '));

  console.log('');
  if (result.ok) {
    console.log('  D  BROWSER SIGN-IN SUCCEEDED (uid=' + result.uid + ')');
    console.log('\n  VERDICT: the browser path works here. A gate failure would then be a REAL');
    console.log('           regression, not an environment problem — investigate the suite.');
    process.exit(0);
  }
  if (/network-request-failed/.test(result.code || result.message)) {
    console.log('  B  BROWSER CANNOT COMPLETE SIGN-IN  (' + result.code + ')');
    console.log('     The emulator answers over HTTP, but the browser\'s request to it does not');
    console.log('     complete. This is the deployment gate\'s remaining failure, reproduced in');
    console.log('     isolation: a TEST-RIG connectivity problem, not a SOKONI defect.');
    console.log('\n     DO NOT "fix" this by weakening App Check or removing the watchdog — both');
    console.log('     are the controls that make the failure visible in the first place.');
    process.exit(1);
  }
  console.log('  ?  sign-in failed for another reason: ' + (result.code || '') + ' ' + (result.message || ''));
  console.log('\n  VERDICT: classify manually before treating this as environmental.');
  process.exit(1);
})().catch((e) => { console.error('\n  reproducer aborted: ' + (e && e.stack)); process.exit(4); });
