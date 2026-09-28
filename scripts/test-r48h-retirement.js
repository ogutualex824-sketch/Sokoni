'use strict';
/**
 * CERTIFICATION — R-48H: the 48-hour marketplace commission is RETIRED from source (owner ruling 2026-09-28).
 *
 * Before: onSellerPaymentCreated stamped marketplace commission rows `billingModel: PER_SALE_48H` with a dueAt 48 h
 * after the sale; commission-collection.js ran an HOURLY sweep that sent a reminder at 46 h, marked rows OVERDUE,
 * assessed penalties and RESTRICTED the seller (sellerRestrictions); getCommissionBalance / getSellerRestriction /
 * issueCommissionInvoice served it; the Merchant store UI carried a "Commission & penalties" panel for it.
 * After: every new commission row is MONTHLY and is invoiced by generateMonthlyInvoices; the commission AMOUNT
 * authority is unchanged; historical PER_SALE_48H rows are untouched and still never re-billed monthly.
 *
 *   B  behaviour — the REAL onSellerPaymentCreated trigger, against the Firestore EMULATOR
 *   S  structure — the retired machinery is gone from the deployable source (comments stripped)
 *
 *   REPAIR_ROOT  tree under test (default: this repo). Refuses without FIRESTORE_EMULATOR_HOST.
 */
const path = require('path');
const fs = require('fs');

if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('REFUSED: FIRESTORE_EMULATOR_HOST is not set.'); process.exit(2); }
const ROOT = path.resolve(process.env.REPAIR_ROOT || path.join(__dirname, '..'));
const FN = path.join(ROOT, 'functions');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-r48h';
const WATCHDOG = setTimeout(() => { process.stdout.write('\n  ✖ WATCHDOG — suite exceeded 280s\n'); process.exit(3); }, 280000);

let pass = 0, fail = 0;
const ok = (c, id, m) => { if (c) pass++; else fail++; process.stdout.write('  ' + (c ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + '\n'); };
const _REAL = { so: process.stdout.write.bind(process.stdout), se: process.stderr.write.bind(process.stderr), cw: console.warn, ce: console.error, cl: console.log };
async function quiet(fn) {
  process.stdout.write = () => true; process.stderr.write = () => true; console.warn = () => {}; console.error = () => {}; console.log = () => {};
  try { return await fn(); } finally { process.stdout.write = _REAL.so; process.stderr.write = _REAL.se; console.warn = _REAL.cw; console.error = _REAL.ce; console.log = _REAL.cl; }
}
/* comment stripper — assertions are about CODE, never about prose that mentions the retired model */
function strip(src) {
  let out = '', i = 0, blk = false, str = null;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (blk) { if (c === '*' && n === '/') { blk = false; i += 2; continue; } i++; continue; }
    if (str) { out += c; if (c === '\\') { out += n || ''; i += 2; continue; } if (c === str) str = null; i++; continue; }
    if (c === '/' && n === '*') { blk = true; i += 2; continue; }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '"' || c === "'" || c === '`') str = c;
    out += c; i++;
  }
  return out;
}
const read = (p) => { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (_) { return null; } };

(async () => {
  process.stdout.write(`\nR-48H — the 48-hour commission is retired   (tree: ${ROOT})\n\n`);

  process.stdout.write('[B] the real onSellerPaymentCreated trigger\n');
  /* index.js initialises the default app itself; load it FIRST and use that app. */
  const admin = require(require.resolve('firebase-admin', { paths: [FN] }));
  let IDX;
  try { IDX = await quiet(async () => require(path.join(FN, 'index.js'))); } catch (e) { process.stdout.write('  ✖ SETUP — index.js failed to load: ' + e.message + '\n'); process.exit(2); }
  if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
  const db = admin.firestore();
  const trig = IDX.onSellerPaymentCreated;
  if (!trig || typeof trig.run !== 'function') { process.stdout.write('  ✖ SETUP — onSellerPaymentCreated.run unavailable\n'); process.exit(2); }
  /* UNIQUE ids per run: index.js initialises its own app (FIREBASE_CONFIG), so every run may share one emulator
     namespace — and the trigger is idempotent on paymentId, so a stale row from an earlier run would mask this one. */
  const RUN = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const SELLER = 'r48h-seller-' + RUN;
  const fire = async (id, data) => {
    await db.collection('sellerPayments').doc(id).set(data);
    const snap = await db.collection('sellerPayments').doc(id).get();
    await quiet(() => trig.run({ data: snap, params: { paymentId: id } }));
    const row = await db.collection('commissionLedger').doc(id).get();
    return row.exists ? row.data() : null;
  };
  for (const [id0, hub] of [['r48h-pay-mkt', 'marketplace'], ['r48h-pay-pos', 'pos'], ['r48h-pay-svc', 'services']]) {
    const id = id0 + '-' + RUN;
    const row = await fire(id, { sellerUid: SELLER, amount: 1000, hub, orderId: 'ord-' + id });
    const gone = ['dueAt', 'collectionStatus', 'penaltyKES', 'totalOutstanding', 'reminderSentAt'].filter((f) => row && f in row && row[f] !== null && row[f] !== 0);
    ok(!!row && row.billingModel === 'MONTHLY' && gone.length === 0 && row.status === 'pending', 'B-' + hub,
      `a "${hub}" seller payment writes ONE commission row, billingModel MONTHLY, with no 48-hour deadline/collection/penalty/reminder state: ` +
      (row ? row.billingModel + (gone.length ? ' [48h fields: ' + gone.join(',') + ']' : '') + ' · commissionKES=' + row.commissionKES + ' pct=' + row.commissionPct : 'no row'));
  }
  { const bill = await db.collection('sellerBilling').doc(SELLER).collection('monthly').doc(new Date().toISOString().slice(0, 7)).get();
    const d = bill.exists ? bill.data() : {};
    ok(bill.exists && d.transactionCount === 3 && Number(d.totalCommissionKES) > 0, 'B-monthly',
      'every sale lands in the seller\'s MONTHLY billing aggregate — the replacement path generateMonthlyInvoices reads: ' + JSON.stringify({ tx: d.transactionCount, commissionKES: d.totalCommissionKES })); }

  process.stdout.write('\n[S] the retired machinery is gone from the deployable source\n');
  const IDXC = strip(read('functions/index.js') || '');
  const exported = (n) => new RegExp('exports\\.' + n + '\\s*=').test(IDXC);
  ok(!exported('sweepCommissionDue') && !/onSchedule\([\s\S]{0,400}?PER_SALE_48H/.test(IDXC) && read('functions/commission-collection.js') === null, 'S-1',
    'the HOURLY sweep is gone: sweepCommissionDue not exported, no scheduler selects PER_SALE_48H, commission-collection.js absent');
  ok(!/COMMISSION_DUE_HOURS|_is48hCommission|48\s*\*\s*3600000/.test(IDXC) && !/"PER_SALE_48H"\s*:\s*"MONTHLY"|billingModel:\s*[^,\n]*PER_SALE_48H/.test(IDXC) && !/dueAt\s*:/.test(IDXC.slice(IDXC.indexOf('exports.onSellerPaymentCreated'), IDXC.indexOf('exports.onSellerPaymentCreated') + 6000)), 'S-2',
    'the 48-HOUR CLOCK is gone: no due-hours constant, no hub test, no 48×3600000 deadline, no dueAt stamped at creation');
  ok(!/COMMISSION_REMINDER_HOURS|reminderSentAt/.test(IDXC) && !/REMINDER_HOURS\s*=\s*46/.test(strip(read('functions/commission-collection.js') || '')), 'S-3',
    'the 46-HOUR REMINDER is gone: no reminder constant, no reminderSentAt in the trigger');
  const FNDIR = fs.readdirSync(FN).filter((f) => f.endsWith('.js'));
  const restrictWriters = FNDIR.filter((f) => /collection\(\s*['"]sellerRestrictions['"]\s*\)[\s\S]{0,200}?\.(set|update|create)\(/.test(strip(fs.readFileSync(path.join(FN, f), 'utf8'))));
  ok(!exported('getSellerRestriction') && restrictWriters.length === 0, 'S-4',
    'the SELLER RESTRICTION is gone: getSellerRestriction not exported, and no function writes sellerRestrictions' + (restrictWriters.length ? ' [writers: ' + restrictWriters.join(',') + ']' : ''));
  ok(!exported('getCommissionBalance') && !exported('issueCommissionInvoice'), 'S-5',
    'the 48-hour balance and invoice callables are not exported (getCommissionBalance, issueCommissionInvoice)');
  const INV = read('functions/commission-invoice.js');
  ok(INV === null || !/require\(\s*['"]\.\/commission-invoice['"]\s*\)/.test(IDXC), 'S-6',
    'nothing in the deploy entrypoint reaches commission-invoice.js (kept only as a governance-ledger record)');
  ok(/data\.billingModel === "PER_SALE_48H"\)\s*\{\s*_skipped48h\+\+;\s*return;/.test(IDXC), 'S-7',
    'HISTORY is protected: generateMonthlyInvoices still SKIPS historical PER_SALE_48H rows, so retirement can never become a second bill');
  const UI = strip(read('sokoni-merchant-store-ui.js') || '');
  ok(!/callCommissionBalance|balanceHTML|mst-cb/.test(UI), 'S-8', 'the dead 48-hour "Commission & penalties" panel is gone from the Merchant store UI');

  process.stdout.write(`\n${pass} pass / ${fail} fail\n`);
  clearTimeout(WATCHDOG);
  process.exit(fail ? 1 : 0);
})().catch((e) => { process.stdout.write('  ✖ CRASH — ' + (e && e.stack || e) + '\n'); process.exit(4); });
