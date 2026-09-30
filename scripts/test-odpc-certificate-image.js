#!/usr/bin/env node
'use strict';
/* ============================================================================
   legal.html › #regulatory-registration shows the ODPC certificate IMAGE (owner, 2026-10-01)
   ----------------------------------------------------------------------------
   The registration TEXT is sokoni-27's (83363cd, scripts/test-odpc-registration-display.js).
   This suite covers only the image added inside that section. Expected values are DERIVED from
   functions/company-identity.js (COMPANY.dataProtection), never re-typed.
     A  placement: inside the Data Protection pane, after the registration card, one copy only
     B  the file: real JPEG at the served path, dimensions match the attributes, < 400 KB,
        not excluded by firebase.json hosting.ignore
     C  accessibility + honesty: alt names certificate/number/category; the caption says
        Data Processor; no controller-registration or compliance claim
   node scripts/test-odpc-certificate-image.js
   ============================================================================ */
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 300) : '')); } };

const { COMPANY } = require(path.join(ROOT, 'functions', 'company-identity.js'));
const dp = COMPANY.dataProtection;
const html = fs.readFileSync(path.join(ROOT, 'legal.html'), 'utf8');
const SRC = '/assets/legal/odpc-registration-certificate-2026.jpg';
const fig0 = html.indexOf('id="odpc-certificate"');
const fig = fig0 > 0 ? html.slice(fig0, html.indexOf('</figure>', fig0)) : '';

console.log('ODPC certificate image on legal.html\n');
console.log('A. placement');
ck('A1 the figure is inside the Data Protection pane', fig0 > html.indexOf('id="pane-data"') && html.indexOf('id="pane-data"') > 0);
ck('A2 it sits after the registration heading and card', fig0 > html.indexOf('id="regulatory-registration"') && html.indexOf('id="regulatory-registration"') > 0);
ck('A3 exactly one figure (no duplicate display)', html.split('id="odpc-certificate"').length === 2 && html.split(SRC).length - 1 === 2);

console.log('\nB. the file');
const file = path.join(ROOT, SRC.slice(1));
const b = fs.existsSync(file) ? fs.readFileSync(file) : null;
ck('B1 the image exists at the served path', !!b);
if (b) {
  ck('B2 real JPEG', b[0] === 0xFF && b[1] === 0xD8);
  let w = 0, h = 0;
  for (let i = 2; i < b.length - 9;) { if (b[i] !== 0xFF) { i++; continue; } const mk = b[i + 1]; if (mk >= 0xC0 && mk <= 0xC3) { h = b.readUInt16BE(i + 5); w = b.readUInt16BE(i + 7); break; } i += 2 + b.readUInt16BE(i + 2); }
  const m = fig.match(/width="(\d+)" height="(\d+)"/) || [];
  ck('B3 width/height attributes match the file (' + w + '×' + h + ')', +m[1] === w && +m[2] === h, { attr: m.slice(1), file: [w, h] });
  ck('B4 under 400 KB', b.length < 400 * 1024, b.length);
}
const fb = require(path.join(ROOT, 'firebase.json')); const hs = Array.isArray(fb.hosting) ? fb.hosting[0] : fb.hosting;
ck('B5 not excluded by firebase.json hosting.ignore', !(hs.ignore || []).some((g) => SRC.slice(1).startsWith(g.replace(/\*\*.*$/, '')) && g.startsWith('assets/')));

console.log('\nC. accessibility + honesty');
const alt = (fig.match(/alt="([^"]+)"/) || [])[1] || '';
ck('C1 alt names the certificate, number (' + dp.registrationNumber + '), serial and category (' + dp.category + ')', /Certificate of Registration/.test(alt) && alt.includes(dp.registrationNumber) && alt.includes(dp.certificateSerialNo) && alt.includes(dp.category));
ck('C2 lazy-loaded with a descriptive link label', /loading="lazy"/.test(fig) && /aria-label="Open the ODPC Certificate of Registration/.test(fig));
ck('C3 caption states the registered capacity', /<figcaption[^>]*>[^<]*\(Data Processor\)/.test(fig));
ck('C4 no controller-registration or compliance claim in the figure', !/Data Controller|compliant|certified/i.test(fig));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
