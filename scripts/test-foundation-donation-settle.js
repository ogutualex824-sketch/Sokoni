'use strict';
/* SOKONI Foundation — the ONE donation completion writer (functions/foundation-donation-settle.js), owner 2026-10-01.
   Serialised in-memory Firestore (create() refuses an existing doc; increments applied). + the webhookIntasend wiring.
     node scripts/test-foundation-donation-settle.js */
const path = require('path'), fs = require('fs');
const ROOT = path.join(__dirname, '..');
const D = require(path.join(ROOT, 'functions', 'foundation-donation-settle.js'));
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 240) + ']')); ok ? pass++ : fail++; };

const DOCS = new Map();
const INC = (n) => ({ __inc: n }), TS = 'TS';
const apply = (prev, d, merge) => { const o = merge ? Object.assign({}, prev || {}) : {}; for (const [k, v] of Object.entries(d)) o[k] = (v && v.__inc !== undefined) ? (Number((prev || {})[k]) || 0) + v.__inc : v; return o; };
let THROW_READ = false;
const ref = (p) => ({ path: p, get: async () => { if (THROW_READ && p.indexOf('paymentIntents/') === 0) throw new Error('DEADLINE_EXCEEDED'); return { exists: DOCS.has(p), data: () => DOCS.get(p) }; },
  set: async (d, o) => { DOCS.set(p, apply(DOCS.get(p), d, o && o.merge)); } });
let chain = Promise.resolve();
const db = { collection: (c) => ({ doc: (id) => ref(c + '/' + id) }),
  runTransaction: (fn) => { const run = chain.then(async () => { const w = [];
    const t = { get: async (r) => ({ exists: DOCS.has(r.path), data: () => DOCS.get(r.path) }),
      set: (r, d, o) => w.push(() => DOCS.set(r.path, apply(DOCS.get(r.path), d, o && o.merge))),
      update: (r, d) => w.push(() => DOCS.set(r.path, apply(DOCS.get(r.path), d, true))),
      create: (r, d) => w.push(() => { if (DOCS.has(r.path)) throw Object.assign(new Error('ALREADY_EXISTS'), { code: 6 }); DOCS.set(r.path, apply(null, d, false)); }) };
    const out = await fn(t); w.forEach((f) => f()); return out; }); chain = run.catch(() => {}); return run; } };
const admin = { firestore: { FieldValue: { serverTimestamp: () => TS, increment: INC, delete: () => undefined } } };

const seed = (pid, o, io) => {
  DOCS.set('foundationDonations/' + pid, Object.assign({ uid: 'donor', amount: 1000, status: 'pledged', currency: 'KES', programmeId: null }, o));
  DOCS.set('paymentIntents/DON_' + pid, Object.assign({ uid: 'donor', purpose: 'donation', resourceType: 'foundationDonation', resourceId: pid, amount: 1000, amountCents: 100000 }, io));
};
const pay = (pid, o) => D.settleDonationPayment(db, admin, Object.assign({ apiRef: 'DON_' + pid, intentRef: 'DON_' + pid, state: 'COMPLETE',
  gross: 1000, net: 970, charges: 30, currency: 'KES', providerRef: 'INV' + pid }, o));
const ledger = () => [...DOCS.keys()].filter((k) => k.indexOf('impactLedger/') === 0);

(async () => {
  console.log('\nFoundation donation completion\n');
  /* exact payment */
  DOCS.set('impactBalance/current', { balance: 5000 });
  DOCS.set('impactCampaigns/prog1', { status: 'active', raised: 200, donors: 2 });
  seed('PLG_a', { programmeId: 'prog1', purpose: 'water' });
  let r = await pay('PLG_a');
  const p = DOCS.get('foundationDonations/PLG_a');
  ck('C-1', r.outcome === 'completed' && p.status === 'completed' && p.receiptId === 'SKF-INVPLG_a' && typeof p.completedAt === 'number'
    && p.grossKES === 1000 && p.feeKES === 30 && p.netKES === 970 && p.providerReference === 'INVPLG_a', 'exact GROSS (= pledge = intent) → pledge completed with receiptId / completedAt / gross / fee / net', p);
  const L = DOCS.get('impactLedger/DON_INVPLG_a'), F = DOCS.get('impactLedger/DONFEE_INVPLG_a'), B = DOCS.get('impactBalance/current');
  ck('C-2', L && L.type === 'donation' && L.credit === 1000 && L.balanceBefore === 5000 && L.balanceAfter === 6000 && F && F.type === 'fee' && F.debit === 30 && B.balance === 5970 && B.totalReceived === 1000 && B.totalFees === 30,
    'ledger: +1000 donation credit, −30 IntaSend fee debit; balance 5000 → 5970 (what actually arrived)', { L, F, B });
  ck('C-3', DOCS.get('foundationStats/current').totalDonations === 1000 && DOCS.get('foundationStats/current').donationsCount === 1
    && DOCS.get('impactCampaigns/prog1').raised === 1200 && DOCS.get('impactCampaigns/prog1').donors === 3,
    'foundationStats + the programme: raised += GROSS (1000), donors += 1', { s: DOCS.get('foundationStats/current'), c: DOCS.get('impactCampaigns/prog1') });
  ck('C-4', DOCS.get('paymentIntents/DON_PLG_a').status === 'paid', 'the intent is marked paid');
  /* idempotency */
  const before = JSON.stringify([...DOCS.entries()]);
  r = await pay('PLG_a');
  ck('I-1', r.outcome === 'replay' && JSON.stringify([...DOCS.entries()]) === before, 'a REPLAYED callback changes nothing (no second credit)', r);
  seed('PLG_b');
  const two = await Promise.all([pay('PLG_b'), pay('PLG_b'), pay('PLG_b')]);
  ck('I-2', two.filter((x) => x.outcome === 'completed').length === 1 && DOCS.get('foundationStats/current').donationsCount === 2,
    'three concurrent callbacks → exactly ONE completion', two.map((x) => x.outcome));
  /* evidence failures → review, never credit */
  const L0 = ledger().length;
  seed('PLG_c'); r = await pay('PLG_c', { gross: 999 });
  ck('R-1', r.outcome === 'review' && DOCS.get('foundationDonations/PLG_c').status === 'review' && DOCS.get('foundationDonations/PLG_c').reviewReason === 'gross_mismatch' && ledger().length === L0,
    'gross ≠ pledge → pledge REVIEW, no ledger, no balance', r);
  seed('PLG_d'); r = await pay('PLG_d', { currency: 'USD' });
  ck('R-2', r.outcome === 'review' && r.reason === 'currency_not_kes' && ledger().length === L0, 'non-KES → REVIEW, no credit', r);
  seed('PLG_e', {}, { amount: 500 }); r = await pay('PLG_e');
  ck('R-3', r.outcome === 'review' && r.reason === 'intent_mismatch', 'the intent\'s amount disagrees with the pledge → REVIEW', r);
  seed('PLG_f'); r = await pay('PLG_f', { gross: undefined, net: 970 });
  ck('R-4', r.outcome === 'review' && r.reason === 'no_gross_evidence', 'NET alone is not evidence of what the donor paid → REVIEW', r);
  /* failure / abandonment */
  seed('PLG_g'); r = await pay('PLG_g', { state: 'FAILED' });
  ck('F-1', r.outcome === 'failed' && DOCS.get('foundationDonations/PLG_g').status === 'failed' && ledger().length === L0, 'FAILED → pledge failed, no credit', r);
  r = await pay('PLG_a', { state: 'CANCELLED' });
  ck('F-2', DOCS.get('foundationDonations/PLG_a').status === 'completed', 'a late CANCELLED never un-completes a completed donation');
  seed('PLG_h'); r = await pay('PLG_h', { state: 'PENDING' });
  ck('F-3', r.outcome === 'pending' && DOCS.get('foundationDonations/PLG_h').status === 'pledged', 'a non-terminal state leaves the pledge as it is');
  /* not a donation / unreadable */
  DOCS.set('paymentIntents/X1', { purpose: 'product_order', resourceType: 'order', resourceId: 'o1' });
  r = await D.settleDonationPayment(db, admin, { apiRef: 'X1', intentRef: 'X1', state: 'COMPLETE', gross: 10 });
  ck('N-1', r === false, 'a non-donation intent is NOT handled here (the caller continues)');
  seed('PLG_i'); THROW_READ = true; r = await pay('PLG_i'); THROW_READ = false;
  ck('N-2', r === false && DOCS.get('foundationDonations/PLG_i').status === 'pledged', 'an unreadable intent: not settled here — the pledge stays pledged (the caller withholds every credit)');
  /* inactive programme */
  DOCS.set('impactCampaigns/prog2', { status: 'closed', raised: 0, donors: 0 });
  seed('PLG_j', { programmeId: 'prog2' }); r = await pay('PLG_j');
  ck('P-1', r.outcome === 'completed' && DOCS.get('foundationDonations/PLG_j').campaignInactiveAtCompletion === true && DOCS.get('impactCampaigns/prog2').raised === 1000,
    'a programme closed after the pledge: the received money still completes and counts, flagged for admins', DOCS.get('foundationDonations/PLG_j'));
  /* the wiring */
  const idx = fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8');
  const wi = idx.indexOf('exports.webhookIntasend = onRequest(');
  const seg = idx.slice(wi, wi + 30000);
  ck('W-1', /settleDonationPayment\(db, admin, \{[\s\S]{0,500}gross: +invoice\.value/.test(seg) && seg.indexOf("require('./foundation-donation-settle')") < seg.indexOf('_holdServiceBookingPayment(db, admin'),
    'webhookIntasend completes a donation on GROSS (invoice.value), BEFORE the booking hold and every wallet/commission branch');
  ck('W-2', /\["FAILED", "CANCELLED", "EXPIRED", "REJECTED", "TIMEOUT"\]\.includes\(state\)\) \{[\s\S]{0,400}foundation-donation-settle/.test(seg), '...and a failed / abandoned donation is handled on the terminal states');
  const mod = fs.readFileSync(path.join(ROOT, 'functions', 'foundation-donation-settle.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  ck('W-3', !/wallets|creditWalletTxn|commission/i.test(mod), 'the donation writer never touches wallets or commission');
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
