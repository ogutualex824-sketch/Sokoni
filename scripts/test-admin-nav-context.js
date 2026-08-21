/* Admin navigation must stay in the current browser/PWA context.

   Run:  node scripts/test-admin-nav-context.js

   THE RULE
   An admin surface link to another SOKONI page must navigate IN PLACE. `target="_blank"`
   creates a new browsing context; under an installed PWA (display: standalone) that context
   is the operating system's browser, so the operator is thrown out of the app mid-task.

   WHAT IS DELIBERATELY ALLOWED
   Genuinely external destinations SHOULD leave the app — a WhatsApp deep link, the Google
   Cloud console, the Firebase console. Those keep `target="_blank"`, and this file asserts
   they are still there: a fix that stripped every target indiscriminately would break them,
   and a census that ignored them could not tell the two cases apart.

   WHAT THIS DOES NOT PROVE
   That an installed PWA hands the new context to the OS browser. That is documented platform
   behaviour and is not measured here — no PWA is installed in CI. This file proves the
   MECHANISM is absent from internal links, which is the part the codebase controls.

   Destination authority is NOT this file's business. Which destinations an account may reach
   is decided by role authority and the destination page's own guard; only the navigation
   CONTEXT is under test.
*/
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const SURFACES = ['admin.html', 'admin-os.html', 'super-admin.html',
                  'admin-feedback.html', 'admin-messages.html', 'admin-subscriptions.html'];

/* A destination that legitimately leaves the app. */
const EXTERNAL = /^(https?:|mailto:|tel:|whatsapp:|intent:|\/\/)/i;

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 92) + ']' : ''));
  ok ? pass++ : fail++;
};

/* Every <a ...> that carries target="_blank", with its href. */
function blankAnchors(src) {
  const out = [];
  const re = /<a\b[^>]*>/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    const tag = m[0];
    if (!/target\s*=\s*["']_blank["']/i.test(tag)) continue;
    const h = tag.match(/href\s*=\s*["']([^"']*)["']/i);
    out.push({ href: h ? h[1] : '(no href)', line: src.slice(0, m.index).split('\n').length });
  }
  return out;
}

console.log('\nADMIN NAVIGATION — SAME-CONTEXT PROOF');
console.log('='.repeat(78));

let internalTotal = 0, externalTotal = 0;
const offenders = [];

for (const f of SURFACES) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) { console.log('  (absent) ' + f); continue; }
  const src = fs.readFileSync(p, 'utf8');
  const anchors = blankAnchors(src);
  const internal = anchors.filter((a) => !EXTERNAL.test(a.href));
  const external = anchors.filter((a) => EXTERNAL.test(a.href));
  internalTotal += internal.length;
  externalTotal += external.length;
  internal.forEach((a) => offenders.push(f + ':' + a.line + '  ' + a.href));
  console.log('  ' + f.padEnd(26) + 'internal _blank=' + String(internal.length).padStart(3) +
              '   external _blank=' + String(external.length).padStart(2));
}

console.log('');
ck('no admin link to a SOKONI page opens a new browsing context', internalTotal === 0,
   internalTotal ? internalTotal + ' internal target="_blank" link(s)' : '');
if (internalTotal) offenders.slice(0, 30).forEach((o) => console.log('        ' + o));

/* Control: the external allowances must SURVIVE. Without this a fix that stripped every
   target would score as a pass while breaking WhatsApp and the cloud consoles. */
ck('external destinations still open outside the app (control)', externalTotal > 0,
   externalTotal === 0 ? 'every external target was stripped too — over-broad fix' : externalTotal + ' kept');

/* Control: the detector can see a target when one exists. A parser that silently matched
   nothing would report a clean tree. */
const probe = blankAnchors('<a href="x.html" target="_blank">x</a><a href="y.html">y</a>');
ck('detector control — finds a real target="_blank" and ignores a plain link',
   probe.length === 1 && probe[0].href === 'x.html');

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
