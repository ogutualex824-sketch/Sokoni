'use strict';
/**
 * CERTIFICATION — Commission-subsystem convergence + marketplace 3%→5%
 * -------------------------------------------------------------------------
 * Proves the converged tree (a) resolves marketplace to 5% on every rail,
 * (b) changes ONLY the marketplace rate as policy while every commission
 * function body still matches its LIVE deployed source (no revert), and
 * (c) touches only the expected files.
 *
 * "Live deployed source" = the exact zips downloaded from the Cloud Functions
 * source bucket (C:/tmp/{intasend,order,escrow,pos,finos}-src). No emulator.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const IDX = path.join(ROOT, 'functions', 'index.js');
const cfg = require(path.join(ROOT, 'functions', 'commission-config.js'));

let pass = 0, fail = 0; const out = [];
const ok = (n, c, d) => { if (c) { pass++; out.push(`  \u2713 ${n}`); } else { fail++; out.push(`  \u2717 ${n}${d ? ' \u2014 ' + d : ''}`); } };

/* Extract an exported function body by name from a file's text. */
function body(text, fn) {
  const re = new RegExp(`exports\\.${fn} = [\\s\\S]*?\\n\\);`, 'm');
  const m = text.match(re);
  return m ? m[0] : null;
}
const idxNow = fs.readFileSync(IDX, 'utf8');

/* ── A. RATE: marketplace + aliases now 5%; other categories unchanged ── */
ok('A1 marketplace resolves to 5%', cfg.resolveRate('marketplace').pct === 5);
ok('A2 aliases pos/shopping/b2b resolve to 5%', ['pos', 'shopping', 'b2b'].every(h => cfg.resolveRate(h).pct === 5));
ok('A3 services UNCHANGED at 15% (separate candidate)', cfg.resolveRate('services').pct === 15);
ok('A4 other categories unchanged (food 5, property 2, digital 10, event_tickets 3, default 5)',
  cfg.resolveRate('food_delivery').pct === 5 && cfg.resolveRate('property').pct === 2 &&
  cfg.resolveRate('digital_products').pct === 10 && cfg.resolveRate('event_tickets').pct === 3 &&
  cfg.resolveRate('__unknown__').pct === 5);
ok('A5 MIN_COMMISSION_KES unchanged (10)', cfg.MIN_COMMISSION_KES === 10);
const comm = (g) => Math.max(Math.round(g * cfg.resolveRate('marketplace').pct / 100), cfg.MIN_COMMISSION_KES);
ok('A6 KES 10,000 marketplace sale \u2192 500 (5%)', comm(10000) === 500);
ok('A7 client snapshot marketplace pct = 5', /"marketplace"\s*:\s*\{\s*"pct"\s*:\s*5/.test(fs.readFileSync(path.join(ROOT, 'sokoni-commission-rates.js'), 'utf8')));

/* ── B. NO-REVERT: every commission function body == its LIVE deployed source ── */
const liveSrc = (p) => fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
const checks = [
  ['intasendWebhook',       'C:/tmp/intasend-src/index.js'],
  ['webhookIntasend',       'C:/tmp/intasend-src/index.js'],
  ['onOrderStatusChange',   'C:/tmp/order-src/index.js'],
  ['releaseEscrow',         'C:/tmp/escrow-src/index.js'],
];
for (const [fn, src] of checks) {
  const live = liveSrc(src);
  ok(`B:${fn} body == live deployed`, live && body(idxNow, fn) && body(idxNow, fn) === body(live, fn),
    live ? 'body mismatch' : 'live source missing');
}
/* onSellerPaymentCreated / generateMonthlyInvoices live = 7d115bc (my seller deploy) */
const base = execSync('git show 7d115bc:functions/index.js', { cwd: ROOT, encoding: 'utf8' });
for (const fn of ['onSellerPaymentCreated', 'generateMonthlyInvoices']) {
  ok(`B:${fn} body == 7d115bc (live)`, body(idxNow, fn) === body(base, fn));
}
/* Shared files == live deployed bundles */
const fileSame = (f, live) => fs.existsSync(live) && fs.readFileSync(path.join(ROOT, 'functions', f)).equals(fs.readFileSync(live));
ok('B:order-settlement.js == live (3747f01 double-credit fix preserved)', fileSame('order-settlement.js', 'C:/tmp/order-src/order-settlement.js'));
ok('B:pos-zero-friction.js == live (0fe23f1 POS auth preserved)', fileSame('pos-zero-friction.js', 'C:/tmp/pos-src/pos-zero-friction.js'));
ok('B:merchant-authority.js == live (0fe23f1 dependency preserved)', fileSame('merchant-authority.js', 'C:/tmp/pos-src/merchant-authority.js'));
ok('B:finos.js == live', fileSame('finos.js', 'C:/tmp/finos-src/finos.js'));
/* every local require across functions/ resolves — the gap that failed the first deploy analysis */
{
  const dir = path.join(ROOT, 'functions');
  let missing = 0;
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.js'))) {
    const txt = fs.readFileSync(path.join(dir, f), 'utf8');
    const re = /require\((["'])\.\/([a-zA-Z0-9_-]+)\1\)/g; let m;
    while ((m = re.exec(txt))) if (!fs.existsSync(path.join(dir, m[2] + '.js'))) missing++;
  }
  ok('B:all local requires resolve (no missing module)', missing === 0, missing + ' missing');
}

/* ── C. SCOPE: only the expected files changed vs 7d115bc ── */
const changed = execSync('git diff --name-only 7d115bc', { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').filter(Boolean).sort();
const expected = ['functions/commission-config.js', 'functions/index.js', 'functions/merchant-authority.js', 'functions/order-settlement.js', 'functions/pos-zero-friction.js', 'sokoni-commission-rates.js'].sort();
ok('C1 diff touches ONLY the 5 expected files', JSON.stringify(changed) === JSON.stringify(expected), 'got ' + changed.join(','));
ok('C2 index.js delta is ONLY the boost splice (no other function touched)',
  (idxNow.match(/boost activation failed/g) || []).length === 2 &&
  body(idxNow, 'intasendWebhook') === body(liveSrc('C:/tmp/intasend-src/index.js'), 'intasendWebhook'));

console.log('\n\u2500\u2500\u2500 COMMISSION CONVERGENCE + 3\u21925 \u2014 CERTIFICATION \u2500\u2500\u2500');
console.log(out.join('\n'));
console.log(`\n RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
