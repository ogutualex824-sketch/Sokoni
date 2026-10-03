#!/usr/bin/env node
'use strict';
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const F = path.join(__dirname, '..', 'functions', 'payment-attribution.js');
const O = fs.readFileSync(F, 'utf8');
process.on('exit', () => fs.writeFileSync(F, O));
const M = [
  ['payer fallback restored', "  const earner = a.sellerUid || a.merchantUid || null;", "  const earner = a.sellerUid || a.merchantUid || x.payerUid || 'PAYER';", 'A-1'],
  ['platform purposes ignored', "  if (x.isSubscription === true || PLATFORM_PURPOSES.includes(String(x.intentPurpose || '')) || PLATFORM_CATEGORIES.includes(cat)", "  if (x.isSubscription === true || PLATFORM_CATEGORIES.includes(cat)", 'P-1'],
  ['unreadable intent credits', "  if (x.intentUnreadable === true) return { action: 'withhold', earner: null, reason: 'intent_unreadable' };", "", 'U-1'],
  ['booking without provider credits the payer', "  if (isBooking) return a.providerId ? { action: 'credit_booking', earner: String(a.providerId), reason: null } : { action: 'withhold', earner: null, reason: 'no_earner' };", "  if (isBooking) return { action: 'credit_booking', earner: String(a.providerId || 'PAYER'), reason: null };", 'A-2'],
];
let c = 0;
for (const [l, a, b, row] of M) {
  if (O.split(a).length !== 2) { console.log('  ANCHOR x' + (O.split(a).length - 1) + '  ' + l); continue; }
  fs.writeFileSync(F, O.replace(a, b));
  const r = spawnSync(process.execPath, [path.join(__dirname, 'test-webhook-no-payer-credit.js')], { encoding: 'utf8' });
  fs.writeFileSync(F, O);
  const f = (r.stdout.match(/^\s+FAIL \S+/mg) || []).map((x) => x.trim().split(' ')[1]);
  const ok = r.status === 1 && f.includes(row); if (ok) c++;
  console.log('  ' + (ok ? 'CAUGHT' : 'MISSED') + '  ' + l + '  <- ' + f.join(','));
}
console.log('\nSABOTAGE: ' + c + '/' + M.length);
process.exit(c === M.length ? 0 : 1);
