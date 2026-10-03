#!/usr/bin/env node
'use strict';
/* ============================================================================
   Finance OS seller payout — no browser authority (owner P0 2026-10-03, sokoni-finance-os)
     FO-01  financial-os.html has NO client write to payouts/* (status, amount, destination — nothing)
     FO-13  firestore.rules: payouts/{id} allows READ only (no create/update/delete) and no catch-all
            match exists that could OR a write in
     FO-x   the page points admins to the canonical wallet payout authority (AdminOS → Payments,
            adminProcessPayout) and never claims "completed" itself
   Live evidence (read-only, 2026-10-03): ruleset f259c0b5 has the same single read-only payouts match;
   production holds 0 payouts docs (retired FinOS ledger) and 7 payoutRequests (wallet authority).
   node scripts/test-finos-payout-authority.js
   ============================================================================ */
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'financial-os.html'), 'utf8');
const rules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
let pass = 0, fail = 0;
const ck = (id, l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + id + ' ' + l); } else { fail++; console.log('  FAIL  ' + id + ' ' + l + (d !== undefined ? '  -> ' + String(d).slice(0, 200) : '')); } };
const code = html.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

console.log('Finance OS payouts — no browser authority\n');
ck('FO-01', 'no client write to the payouts collection anywhere in financial-os.html',
  !/collection\(\s*['"]payouts['"]\s*\)\s*\.doc\([^)]*\)\s*\.(update|set|delete)\(/.test(code) && !/collection\(\s*['"]payouts['"]\s*\)\s*\.add\(/.test(code),
  (code.match(/collection\(\s*['"]payouts['"]\s*\)[^\n]{0,80}/g) || []).join(' | '));
ck('FO-01b', 'the "Mark as Completed" form and its handlers are gone', !/_approveBankPayoutDirect|_quickApprovePayout|_approveBankPayout\b|Mark as Completed/.test(code));
ck('FO-01c', 'no browser code sets a payout status to completed / paid', !/status\s*:\s*['"](completed|paid|settled_manually)['"]/.test(code.split('/* ── Refunds')[0].split('function _loadPayouts')[1] || ''));
const m = rules.match(/match \/payouts\/\{[a-zA-Z]+\}\s*\{([\s\S]*?)\n\s*\}/);
const matches = (rules.match(/match \/payouts\/\{/g) || []).length;
ck('FO-13', 'rules: exactly one payouts match, read-only (no create/update/delete/write)', matches === 1 && m && /allow read/.test(m[1]) && !/allow\s+(create|update|delete|write)/.test(m[1]), m && m[1]);
ck('FO-13b', 'rules: no recursive catch-all outside tenants/ that could OR a payouts write',
  !(rules.match(/match \/\{[a-zA-Z]+=\*\*\}/g) || []).length);
ck('FO-x', 'page sends admins to AdminOS → Payments (wallet payout authority) and states completion = provider confirmation',
  /href="admin-os\.html#payments"/.test(html) && /only when the payment provider confirms it/.test(html));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
