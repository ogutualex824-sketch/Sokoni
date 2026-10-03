'use strict';
/* Sabotage proof for the P0 payment-integrity gate (sokoni-5b 2026-10-03). Each mutation breaks ONE control; it is
   CAUGHT only when its NAMED row FAILS in a run that reached its RESULT line. Missing anchor → UNPROVEN (not applied);
   crash → UNPROVEN (no verdict). Files are restored after every mutation, including on a crash.
     node scripts/sabotage-p0-payment-integrity.js     (repo QUIESCENT — it edits functions/ in this tree) */
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const F = (f) => path.join(__dirname, '..', 'functions', f);
const PA = F('payment-attribution.js'), IX = F('index.js');
const ORIG = { [PA]: fs.readFileSync(PA, 'utf8'), [IX]: fs.readFileSync(IX, 'utf8') };
const M = [
  [PA, 'THE ATTACK allowed (no missing_intent)', "? { applies: true, ok: false, reason: 'missing_intent', expectedCents: null }", '? { applies: false }', 'A-02'],
  [PA, 'one-shilling tolerance', "if (confirmedCents !== expectedCents) return refuse('amount_mismatch'", "if (Math.abs(confirmedCents - expectedCents) > 100) return refuse('amount_mismatch'", 'A-04'],
  [PA, 'payer not bound to intent owner', "if (String(e.payerUid || '') !== owner) return refuse('wrong_buyer');", '', 'A-08'],
  [PA, "order buyer not bound", "if (buyer && buyer !== owner) return refuse('wrong_buyer');", '', 'A-09'],
  [PA, 'owner-less intent allowed', "if (!owner) return refuse('intent_owner_missing');", '', 'A-11'],
  [PA, 'order currency unchecked', "if (order.currency && String(order.currency).toUpperCase() !== 'KES') return refuse('wrong_currency');", '', 'A-13b'],
  [PA, 'consumed (paid) intent re-usable', 'if (TERMINAL_INTENT_STATUSES.includes(intent.status)) {', "if (TERMINAL_INTENT_STATUSES.includes(intent.status) && intent.status !== 'paid') {", 'A-16'],
  [PA, 'non-payable order accepted', "if (!PAYABLE_ORDER_STATUSES.includes(String(order.status || ''))) return refuse('order_not_payable', { orderStatus: String(order.status || '') });", '', 'A-18'],
  [PA, 'IntaSend state ignored', "if (String(st.state || '').toUpperCase() !== 'COMPLETE') return { ok: false, reason: 'provider_not_complete', detail: String(st.state || '') };", '', 'A-25'],
  [PA, 'IntaSend ref ignored', "if (!w.apiRef || String(st.api_ref || '') !== String(w.apiRef)) return { ok: false, reason: 'provider_ref_mismatch' };", '', 'A-26'],
  [PA, 'IntaSend amount ignored', 'if (!Number.isInteger(w.expectedCents) || cents !== w.expectedCents)', 'if (false)', 'A-27'],
  [IX, 'webhook does not feed the payer', 'payerUid:    existing.uid || null,', 'payerUid:    null,', 'W-01'],
  [IX, 'webhook skips the IntaSend confirmation', 'const _pc = assessProviderConfirmation(_st, { apiRef, expectedCents: _gate.expectedCents });', 'const _pc = { ok: true };', 'W-02'],
];
const rows = [];
try {
  for (const [file, name, find, repl, row] of M) {
    const o = ORIG[file];
    if (o.split(find).length !== 2) { rows.push([name, row, 'anchor not found / not unique', 'UNPROVEN']); continue; }
    fs.writeFileSync(file, o.replace(find, repl));
    const r = spawnSync(process.execPath, [path.join(__dirname, 'test-p0-payment-integrity.js')], { encoding: 'utf8', timeout: 180000 });
    fs.writeFileSync(file, o);
    const out = (r.stdout || '') + (r.stderr || '');
    const done = /RESULT: \d+ passed, \d+ failed/.test(out);
    const failed = new RegExp('^\\s*FAIL ' + row.replace(/[-]/g, '\\-') + '\\s', 'm').test(out);
    rows.push([name, row, !done ? 'crash / no RESULT' : (failed ? row + ' FAILED' : row + ' passed'), !done ? 'UNPROVEN' : (failed ? 'CAUGHT' : 'MISSED')]);
  }
} finally { for (const f of Object.keys(ORIG)) fs.writeFileSync(f, ORIG[f]); }
console.log('\nSabotage — P0 payment integrity\n');
console.log('  MUTATION                                   | EXPECTED      | ACTUAL               | ASSERTION | RESULT');
rows.forEach((x) => console.log('  ' + x[0].padEnd(43) + '| ' + (x[1] + ' FAILS').padEnd(14) + '| ' + x[2].padEnd(21) + '| ' + x[1].padEnd(10) + '| ' + x[3]));
const caught = rows.filter((x) => x[3] === 'CAUGHT').length;
const restored = Object.keys(ORIG).every((f) => fs.readFileSync(f, 'utf8') === ORIG[f]);
console.log('\nSABOTAGE: ' + caught + '/' + rows.length + ' caught' + (restored ? '' : '   !! FILES NOT RESTORED'));
process.exit(caught === rows.length && restored ? 0 : 1);
