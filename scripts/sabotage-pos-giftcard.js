'use strict';
/* Sabotage proof for the till gift-card authority (owner P0 brief 2026-10-03, GC rows in test-pos-gate-behavioural.js).
   A mutation is CAUGHT only when its NAMED GC row FAILS in a run that reached its result line. Missing anchor or a
   crash → UNPROVEN, never CAUGHT. functions/pos-zero-friction.js is restored after every mutation.
     node scripts/sabotage-pos-giftcard.js       (repo QUIESCENT — it edits functions/pos-zero-friction.js) */
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const F = path.join(__dirname, '..', 'functions', 'pos-zero-friction.js');
const ORIG = fs.readFileSync(F, 'utf8');
const M = [
  ['card never debited', 'for (const d of giftDebits) {', 'for (const d of []) {', 'GC-01'],
  ['card code leaks into the sale', "o.redemptionId = code ? String(saleId) + '_' + _gcKey(code) : null;", "o.redemptionId = code ? String(saleId) + '_' + code : null;", 'GC-01c'],
  ['balance not checked', 'if (!isFinite(bal) || Math.round(bal * 100) < Math.round(want.amount * 100)) {', 'if (false) {', 'GC-02'],
  ['status not checked', "if (c.status !== 'active') throw", 'if (false) throw', 'GC-03'],
  ['expiry not checked', "if (c.expiryDate && typeof c.expiryDate.toMillis === 'function' && c.expiryDate.toMillis() < Date.now()) {", 'if (false) {', 'GC-04'],
  ['missing card not refused as such', "if (!cSnap.exists) throw new HttpsError('failed-precondition', 'That gift card was not found.", "if (false) throw new HttpsError('failed-precondition', 'That gift card was not found.", 'GC-06'],
  ['other shop\'s card accepted', "if (!_shops.includes(String(c.shopId || ''))) throw", 'if (false) throw', 'GC-07'],
  ['gift card may pay less than the total', "if (_pay.some((p) => String((p && p.method) || '').toLowerCase() === 'gift_card') && tendered < authoritativeTotal) {", 'if (false) {', 'GC-09'],
  ['payment-line currency ignored', "if (p && p.currency !== undefined && p.currency !== null && String(p.currency).toUpperCase() !== 'KES') {", 'if (false) {', 'GC-10'],
  ['card currency ignored', "if (c.currency && String(c.currency).toUpperCase() !== 'KES') throw", 'if (false) throw', 'GC-10'],
  ['code not required', "if (!code) _e('Enter the gift card code.'", "if (false) _e('Enter the gift card code.'", 'GC-13'],
  ['recorded redemption debited again', 'if (rSnap.exists) {', 'if (false) {', 'GC-15b'],
  ['another sale\'s record accepted', "if (String(rr.saleId) !== String(saleId)) throw", 'if (false) throw', 'GC-08b'],
  ['one-cent tolerance on balance', 'if (!isFinite(bal) || Math.round(bal * 100) < Math.round(want.amount * 100)) {', 'if (!isFinite(bal) || bal + 1 < want.amount) {', 'GC-19'],
];
const rows = [];
try {
  for (const [name, find, repl, row] of M) {
    if (ORIG.split(find).length !== 2) { rows.push([name, row, 'anchor not found / not unique', 'UNPROVEN']); continue; }
    fs.writeFileSync(F, ORIG.replace(find, repl));
    const r = spawnSync(process.execPath, [path.join(__dirname, 'test-pos-gate-behavioural.js')], { encoding: 'utf8', timeout: 300000 });
    fs.writeFileSync(F, ORIG);
    const out = (r.stdout || '') + (r.stderr || '');
    const done = /\d+ passed, \d+ failed/.test(out) && !/suite crashed/.test(out);
    const failed = new RegExp('^\\s*FAIL\\s+' + row.replace(/-/g, '\\-') + '\\s', 'm').test(out);
    rows.push([name, row, !done ? 'crash / no result' : (failed ? row + ' FAILED' : row + ' passed'), !done ? 'UNPROVEN' : (failed ? 'CAUGHT' : 'MISSED')]);
  }
} finally { fs.writeFileSync(F, ORIG); }
console.log('\nSabotage — till gift card\n');
console.log('  MUTATION                                  | EXPECTED      | ACTUAL              | ASSERTION | RESULT');
rows.forEach((x) => console.log('  ' + x[0].padEnd(42) + '| ' + (x[1] + ' FAILS').padEnd(14) + '| ' + x[2].padEnd(20) + '| ' + x[1].padEnd(10) + '| ' + x[3]));
const caught = rows.filter((x) => x[3] === 'CAUGHT').length;
const restored = fs.readFileSync(F, 'utf8') === ORIG;
console.log('\nSABOTAGE: ' + caught + '/' + rows.length + ' caught' + (restored ? '' : '   !! FILE NOT RESTORED'));
process.exit(caught === rows.length && restored ? 0 : 1);
