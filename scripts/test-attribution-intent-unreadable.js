'use strict';
/* resolveFinancialAttribution FAILS OPEN on a read error (the payment is captured; nothing may block the webhook),
   but it must SAY so: owner 2026-10-01 — no wallet is credited on client-supplied attribution when the server's
   own intent could not be read. Pure; fake db.
     node scripts/test-attribution-intent-unreadable.js
     BASE=<rev> node scripts/test-attribution-intent-unreadable.js   (f076c64 must FAIL A-2) */
const path = require('path'), fs = require('fs'), os = require('os'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
let file = path.join(ROOT, 'functions', 'payment-attribution.js');
if (process.env.BASE) { file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-')), 'payment-attribution.js');
  fs.writeFileSync(file, execSync('git show ' + process.env.BASE + ':functions/payment-attribution.js', { cwd: ROOT, encoding: 'utf8' })); }
const PA = require(file);
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok ? '' : '   [got ' + JSON.stringify(got) + ']')); ok ? pass++ : fail++; };
const dbWith = (getImpl) => ({ collection: () => ({ doc: () => ({ get: getImpl }) }) });
(async () => {
  console.log('\nAttribution — unreadable intent   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
  const meta = { type: 'booking', providerId: 'p1', sellerUid: 'attacker' };
  const ok1 = await PA.resolveFinancialAttribution(dbWith(async () => ({ exists: true, data: () => ({ metadata: { type: 'service-booking', providerId: 'real' } }) })), { intentRef: 'r', legacyMeta: meta });
  ck('A-1', ok1.source === 'intent' && ok1.providerId === 'real' && ok1.intentReadFailed === false, 'a readable intent wins and is not flagged', ok1);
  const bad = await PA.resolveFinancialAttribution(dbWith(async () => { throw new Error('DEADLINE_EXCEEDED'); }), { intentRef: 'r', legacyMeta: meta });
  ck('A-2', bad.intentReadFailed === true && bad.source === 'legacy_meta', 'a READ ERROR is flagged intentReadFailed (still merged, never thrown)', bad);
  const none = await PA.resolveFinancialAttribution(dbWith(async () => ({ exists: false, data: () => null })), { intentRef: 'r', legacyMeta: meta });
  ck('A-3', none.intentReadFailed === false && none.source === 'legacy_meta', 'a MISSING intent is not a read error (legacy callers unchanged)', none);
  /* the webhook consumes the flag before any credit branch */
  const idx = fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8');
  const blk = (idx.match(/if \(_isSubscription\) \{[\s\S]{0,6000}?creditWalletTxn\(txn/) || [''])[0];
  ck('A-4', /else if \(attribution\.intentReadFailed\) \{[\s\S]{0,900}commissionReviewQueue/.test(blk) && blk.indexOf('attribution.intentReadFailed') < blk.indexOf('_isBooking)'),
    'webhookIntasend withholds EVERY credit when the intent was unreadable, before the booking and seller branches');
  ck('A-5', !/type: "booking_earning"/.test(idx) && !/_\$\{apiRef\}_booking`/.test(idx), 'the payment-time booking credit (booking_earning) is gone from the webhook');
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
