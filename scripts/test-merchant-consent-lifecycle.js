#!/usr/bin/env node
/**
 * MERCHANT CONSENT LIFECYCLE — why the "black layer" existed.
 *
 *   node scripts/test-merchant-consent-lifecycle.js
 *
 * THE DEFECT, measured against the LIVE build: the black layer covering Plan, POS,
 * Returns, Fulfilment, Verification and Stories was the CONSENT DIALOG doing exactly
 * what it is built to do — position:fixed inset:0, rgba(0,0,0,.66), z-index 300001.
 *
 * Inside the shell it is correctly hidden (sokoni-inshell.js), and that was verified:
 * framed, the element does not even exist. It appeared when a page was opened
 * STANDALONE — and it never went away, because the answer was never recorded.
 *
 * WHY IT WAS NEVER RECORDED: merchant-v2.html did not load security.js at all. A
 * merchant entering through the PWA shortcut lands on /merchant-v2 and nowhere else, so
 * consent was never OFFERED, therefore never ACCEPTED, so every standalone page kept
 * showing the blocking modal for ever.
 *
 * THE FIX IS NOT "hide the scrim". The scrim is the consent gate and removing it would
 * be an ODPC regression. The shell now ASKS — using the same non-blocking bottom sheet
 * the auth pages already use, so a merchant's console is never taken hostage.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const NL = String.fromCharCode(10);
const SEC = fs.readFileSync(path.join(ROOT, 'security.js'), 'utf8');
const SHELL = fs.readFileSync(path.join(ROOT, 'merchant-v2.html'), 'utf8');
const INSHELL = fs.readFileSync(path.join(ROOT, 'sokoni-inshell.js'), 'utf8');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 96) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log(NL + t);

console.log(NL + 'MERCHANT CONSENT LIFECYCLE' + NL + '='.repeat(60));

/* ── 1 · the shell can now ask ────────────────────────────────────────────── */
head('1 · the shell offers consent at all');
ck('merchant-v2 loads security.js', SHELL.split('src="security.js"').length - 1 === 1,
   'without it the merchant is never asked, so the answer is never recorded');
ck('...exactly once', SHELL.split('src="security.js"').length - 1 === 1);

/* ── 2 · and asks WITHOUT taking the console hostage ──────────────────────── */
head('2 · the shell sheet must not be a full-screen scrim');
const defAuth = SEC.split(NL).find((l) => l.indexOf('var _isAuthPage =') > -1);
const defShell = SEC.split(NL).find((l) => l.indexOf('var _isMerchantShell =') > -1);
ck('a shell predicate exists', !!defShell, defShell && defShell.trim().slice(0, 70));
ck('presentation follows _nonBlocking, not the auth-only name',
   SEC.indexOf('var _nonBlocking = _isAuthPage || _isMerchantShell;') > -1 &&
   SEC.indexOf('if (_nonBlocking) {') > -1);
ck('CONTROL the definition is not self-referential',
   SEC.indexOf('_nonBlocking = _nonBlocking') === -1,
   'a blanket rename produced exactly that, which would have broken the AUTH pages');

/* the two predicates, executed */
(function () {
  const f = new Function('_p',
    'var _isAuthPage' + defAuth.split('var _isAuthPage')[1] +
    ' var _isMerchantShell' + defShell.split('var _isMerchantShell')[1] +
    ' return { auth:_isAuthPage, shell:_isMerchantShell, nb:_isAuthPage||_isMerchantShell };');
  const nb = (p) => f(p).nb;
  ck('the merchant shell is non-blocking', nb('/merchant-v2') && nb('/merchant'));
  ck('auth pages are STILL non-blocking', nb('/login') && nb('/signup'),
     'the rename must not have cost them their bottom sheet');
  ck('CONTROL an ordinary page still gets the blocking gate',
     !nb('/plans') && !nb('/pos') && !nb('/index'),
     'consent is still enforced everywhere else — this is not a way to switch it off');
  ck('CONTROL the anchors reject look-alike paths',
     !nb('/merchant-v2-evil') && !nb('/merchantx') && !nb('/loginx'));
})();

/* ── 3 · framed modules stay clean ────────────────────────────────────────── */
head('3 · inside the shell the dialog must still not appear');
ck('the in-shell boundary hides the banner',
   INSHELL.indexOf('.sk-in-shell #_sokoniPrivacyBanner{display:none !important}') > -1);
ck('...and hides the id security.js actually creates',
   SEC.indexOf('_sokoniPrivacyBanner') > -1,
   'the rule and the element must name the same thing, or it hides nothing');
ck('CONTROL the hide is SCOPED to the shell',
   INSHELL.indexOf("'#_sokoniPrivacyBanner{display:none") === -1,
   'an unscoped rule would disable consent on every standalone page — an ODPC regression');

/* ── 4 · the gate itself is untouched ─────────────────────────────────────── */
head('4 · consent is still consent');
ck('the blocking presentation still exists for pages that need it',
   SEC.indexOf('position:fixed') > -1 && SEC.indexOf('300001') > -1);
ck('accept/reject controls are unchanged',
   SEC.indexOf('_sokoniPrivacyAcceptBtn') > -1 && SEC.indexOf('_sokoniPrivacyRejectBtn') > -1);
ck('CONTROL nothing deletes the banner outright',
   SEC.indexOf('_sokoniPrivacyBanner') > -1,
   'the fix is to ASK in the shell, never to remove the gate');

console.log(NL + '  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
