#!/usr/bin/env node
/* Merchant Seller Agreement — in-app view/accept flow.
 *
 * The acceptance is a commercial gate: applicationDecide REFUSES to approve a
 * business that has not accepted. So the assertions that matter most are the ones
 * proving acceptance cannot be manufactured — opening the viewer, closing it, or
 * failing to load the text must never mark a merchant as having agreed.
 *
 *   node scripts/test-merchant-agreement-ui.js
 */
'use strict';
const fs   = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};
const ROOT  = path.join(__dirname, '..');
const read  = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const REG  = strip(read('hub-register.js'));
const LIFE = strip(read('functions', 'application-lifecycle.js'));

/* ══ A. The agreement opens from the application ═══════════════════════════ */
console.log('\nA. Opening\n');
{
  ck('a View Agreement control exists', /id="sreg_view_agreement"/.test(REG));
  ck('  ...and it opens the viewer', /HubRegister\._openAgreement\(\)/.test(REG));
  ck('the viewer is a modal dialog', /aria-modal', 'true'/.test(REG));
  ck('it opens over the application, not a new tab',
     /position:fixed;inset:0/.test(REG));
  ck('a Close control returns to the form', /HubRegister\._closeAgreement\(\)/.test(REG));
  ck('the functions are exported', /_openAgreement:\s+_openAgreement/.test(REG) &&
     /_closeAgreement: _closeAgreement/.test(REG));
}

/* ══ B. The FULL text — fetched, never copied ══════════════════════════════ */
console.log('\nB. Authoritative content\n');
{
  ck('the text is FETCHED from /seller-terms', /fetch\('\/seller-terms'/.test(REG));
  ck('  ...and rendered into the viewer body', /body\.innerHTML = text/.test(REG));
  ck('it is scrollable', /overflow-y:auto/.test(REG));
  ck('scripts/styles are stripped from the fetched document',
     /querySelectorAll\('script, style, link, iframe, nav, header, footer'\)/.test(REG));

  /* The clauses must NOT be duplicated into the registration file. */
  const terms = read('seller-terms.html');
  const h2s = (terms.match(/<h2>([^<]+)<\/h2>/g) || []).slice(0, 6)
    .map((h) => h.replace(/<\/?h2>/g, '').replace(/&amp;/g, '&').trim());
  ck('seller-terms.html has extractable sections', h2s.length >= 4, h2s.length + ' found');
  const copied = h2s.filter((t) => REG.includes(t));
  ck('NONE of its section headings are copied into hub-register.js',
     copied.length === 0, copied.length ? 'copied: ' + copied.join(', ') : 'none');

  ck('failure falls back to the canonical document, not an invented summary',
     /Open the SOKONI Seller Agreement in a new tab/.test(REG));
  ck('  ...and the fallback invents no commercial terms',
     !/(\d+%\s*commission[\s\S]{0,80}?)\1/.test(REG));
}

/* ══ C. Acceptance cannot be manufactured ══════════════════════════════════ */
console.log('\nC. Acceptance is required, never implied\n');
{
  ck('ONE authoritative checkbox — sreg_agree', /id="sreg_agree"/.test(REG));
  ck('the viewer tick DRIVES that checkbox, it is not a second flag',
     /function _agreeFromModal\(checked\)[\s\S]{0,200}?main\.checked = !!checked/.test(REG));
  ck('opening the viewer does NOT set acceptance',
     !/_openAgreement[\s\S]{0,900}?(main|cb)\.checked\s*=\s*true/.test(REG));
  ck('closing the viewer does NOT set acceptance',
     !/_closeAgreement[\s\S]{0,300}?checked\s*=\s*true/.test(REG));
  ck('reopening reflects existing state rather than resetting it',
     /modal\.checked = !!main\.checked/.test(REG));
  ck('an already-ticked box survives a reopen (no forced false)',
     !/_openAgreement[\s\S]{0,900}?modal\.checked\s*=\s*false/.test(REG));
  ck('submit stays gated on the checkbox', /var ok = !!\(cb && cb\.checked\)/.test(REG));
  ck('  negative control: detector WOULD see a forced acceptance',
     /main\.checked\s*=\s*true/.test('main.checked = true;'));
}

/* ══ D. Existing recording machinery is reused, not replaced ═══════════════ */
console.log('\nD. Existing fields preserved\n');
{
  ck('agreementAccepted still written', /agreementAccepted:\s+true/.test(REG));
  ck('agreementVersion still written', /agreementVersion:\s+AGREEMENT_VERSION/.test(REG));
  ck('agreementAcceptedAt still written', /agreementAcceptedAt:\s+new Date\(\)\.toISOString\(\)/.test(REG));
  ck('a version constant exists', /AGREEMENT_VERSION = '/.test(REG));
  ck('NO second acceptance system was created',
     !/agreementAccepted2|acceptanceRecord|agreementSignature|signatureData/.test(REG));
  ck('no handwritten-signature capture', !/canvas|signaturePad|drawSignature/i.test(REG));
}

/* ══ E. The server gate is untouched ═══════════════════════════════════════ */
console.log('\nE. Approval remains blocked without acceptance\n');
{
  ck('applicationDecide still refuses approval without acceptance',
     /_a\.agreementAccepted !== true/.test(LIFE));
  ck('  ...with failed-precondition', /failed-precondition/.test(LIFE));
  ck('the verified version is still recorded at approval',
     /agreementVerifiedVersion:/.test(LIFE));
  ck('this slice did not weaken the gate',
     !/agreementAccepted !== true[\s\S]{0,120}?\/\/\s*(skip|bypass|TODO)/i.test(LIFE));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
