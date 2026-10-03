#!/usr/bin/env node
/* Deliberate breakages of the Legal Hub web slice; each must turn its NAMED row red in test-legal-hub-web. */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const ROOT = path.join(__dirname, '..');
const FILES = ['legal-hub.html', 'legal-profile.html', 'sokoni-legal-taxonomy.js', 'sokoni-legal-account.js'];
const M = [
  ['a Book button back inside the lawyer card', 'legal-hub.html', '<span class="lc-rate-type" aria-hidden="true">View profile →</span>', '<button type="button" class="lc-book-btn">Book</button>', 'W1'],
  ['unrated advocate shown with a default 5 stars', 'legal-hub.html', '`<span>New on SOKONI · no reviews yet</span>`', '`<span>★ 5.0</span>`', 'W2'],
  ['localStorage advocates restored', 'legal-hub.html', 'function getLawyers(){', 'function getLawyers(){ try { var x = JSON.parse(localStorage.getItem("sokoniServiceProviders")); if (x && x.length) return x; } catch (e) {}', 'W3'],
  ['unknown filter shows everyone', 'legal-hub.html', '    else lawyers = [];   /* an unknown filter shows nothing, never everyone */', '', 'W4'],
  ['stats average over unrated advocates', 'legal-hub.html', 'const rated = lawyers.filter(l=>l.rating != null);', 'const rated = lawyers.map(l=>Object.assign({}, l, { rating: l.rating == null ? 5 : l.rating }));', 'W5'],
  ['storefront lists inactive / unpriced rate cards', 'legal-profile.html', 'return s.active === true && Number(s.price) > 0;', 'return true;', 'S1'],
  ['storefront shares a WhatsApp link', 'legal-profile.html', "var url = location.origin + '/legal-profile.html?id=' + encodeURIComponent(id);", "var url = 'https://wa.me/?text=' + encodeURIComponent(location.href);", 'S2'],
  ['PIN offered before SOKONI holds the payment', 'sokoni-legal-account.js', "if (b.paymentStatus === 'paid_held') acts += '<button type=\"button\" class=\"lc-filter-btn active-lf\" data-lb-pin=", "if (true) acts += '<button type=\"button\" class=\"lc-filter-btn active-lf\" data-lb-pin=", 'A1'],
  ['application copied into localStorage', 'legal-hub.html', "  _lhMsg('Submitting your application…', '#c8ff80');", "  localStorage.setItem('sokoniLawyerApp', JSON.stringify(data)); _lhMsg('Submitting your application…', '#c8ff80');", 'R1'],
  ['Paybill commission form restored on the getting-paid tab', 'legal-hub.html', '<div class="lh-section-title">💰 How you get paid on SOKONI</div>', '<div class="lh-section-title">💰 How you get paid on SOKONI</div><input id="caseFee"> Pay 5% to Paybill 522522', 'A2'],
];
let caught = 0, missed = 0;
for (const [name, file, a, b, row] of M) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lgws-'));
  FILES.forEach((f) => fs.copyFileSync(path.join(ROOT, f), path.join(d, f)));
  const f = path.join(d, file);
  const s = fs.readFileSync(f, 'utf8');
  if (s.split(a).length !== 2) { console.log('  MISSED  ' + name + ' (anchor ' + (s.split(a).length - 1) + 'x — UNPROVEN)'); missed++; continue; }
  fs.writeFileSync(f, s.replace(a, () => b));
  const o = cp.spawnSync(process.execPath, [path.join(__dirname, 'test-legal-hub-web.js')], { env: Object.assign({}, process.env, { LEGAL_WEB_ROOT: d }), encoding: 'utf8' });
  const out = o.stdout || '';
  const red = new RegExp('^  FAIL ' + row + ' ', 'm').test(out) && !/W-0/.test(out);
  console.log('  ' + (red ? 'CAUGHT' : 'MISSED') + '  ' + name + ' → ' + row);
  red ? caught++ : missed++;
}
console.log('\nSABOTAGE: ' + caught + '/' + M.length + ' caught');
process.exit(missed ? 1 : 0);
