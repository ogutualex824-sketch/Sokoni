#!/usr/bin/env node
'use strict';
/* ============================================================================
   Profile → Settings → "WhatsApp updates" (2026-10-03). The only UI that records WhatsApp consent.
   Server authority: functions/whatsapp-consent.js (callable whatsappConsent, branch functions/whatsapp-channel-on-9894df2).
     P1  the switch starts DISABLED and reads "—" — never a guessed on/off before the server answers
     P2  state is painted only from the server (op:'get'), loaded each time Settings opens
     P3  saving calls op:'set' with ONLY optIn — no uid, no phone (the server reads the account's own number)
     P4  a failed save reverts the switch and says so; the success toast follows the server's reply only
     P5  no localStorage for consent (it is a legal record, not a UI preference)
     P6  the person is told what they get and that STOP opts out
   node scripts/test-profile-whatsapp-consent.js   (SOK_FILES_ROOT=<dir> to point at another tree's files)
   ============================================================================ */
const fs = require('fs'), path = require('path');
const ROOT = process.env.SOK_FILES_ROOT || path.resolve(__dirname, '..');
const P = fs.readFileSync(path.join(ROOT, 'profile.html'), 'utf8');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + String(d).slice(0, 200) : '')); } };
const js = (P.match(/<script>\r?\n\/\* WhatsApp consent \(2026-10-03\)[\s\S]*?<\/script>/) || [''])[0];
ck('P1 switch starts disabled, state reads "—"', /id="waConsent" disabled/.test(P) && /id="waConsentState"[^>]*>—</.test(P));
ck('P2 painted from the server (op:get), loaded when Settings opens', /call\(\{ op: 'get' \}\)/.test(js) && /function openSettings\(\)\{\r?\n[^\n]*\r?\n  try\{ skWaConsentLoad\(\); \}catch\(_\)\{\}/.test(P));
ck('P3 save sends only { op:"set", optIn } — no uid, no phone', /call\(\{ op: 'set', optIn: want \}\)/.test(js) && !/uid\s*:|phone\s*:/.test(js));
ck('P4 failure reverts the switch and says "Not saved"; toast only after the server replied',
  /cb\.checked = !want;/.test(js) && /Not saved — please try again\./.test(js) && js.indexOf("var d = await call({ op: 'set'") < js.indexOf('_skToast'));
ck('P5 no browser storage for consent', !/localStorage|sessionStorage/.test(js));
ck('P6 the person is told what they get and that STOP opts out', /Reply STOP to opt out/.test(P) && /official WhatsApp number/.test(P));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
