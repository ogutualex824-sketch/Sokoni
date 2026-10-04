#!/usr/bin/env node
/* sabotage-invoice-payment-settle.js — every mutant must turn test-invoice-payment-settle.js RED (exit 1).
   One per money guard of the invoice chain. Mutates in place, ALWAYS restores. Crash / dead anchor = NOT a catch. */
'use strict';
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const FN = path.join(__dirname, '..', 'functions');
const S = 'invoice-payment-settle.js';
const M = [
  [S, 'payment verification skipped (callback trusted)', "  if (!pc || pc.ok !== true) return hold((pc && pc.reason) || 'provider_unconfirmed');", ''],
  [S, 'commission taken on the RECEIVED amount (not applied)', '    const s = SA.settle({ heldAmountCents: appliedCents, passThroughCents: 0, commissionSnapshot: snap });', '    const s = SA.settle({ heldAmountCents: rec, passThroughCents: 0, commissionSnapshot: snap });'],
  [S, 'commission from TODAY\'S rate, not the snapshot', '    const s = SA.settle({ heldAmountCents: appliedCents, passThroughCents: 0, commissionSnapshot: snap });', "    const s = SA.settle({ heldAmountCents: appliedCents, passThroughCents: 0, commissionSnapshot: Object.assign({}, snap, { commissionRate: 30 }) });"],
  [S, 'no commission at all', '    commissionCents = s.commissionCents; netCents = s.netCents;', '    commissionCents = 0; netCents = appliedCents;'],
  [S, 'wallet credit not idempotent', '      if (be.exists || st.exists) return { replay: true };', '      if (false) return { replay: true };'],
  /* the credit is guarded by TWO keys (wallet entry + create-once settlement record): break BOTH — one alone cannot double-pay */
  [S, 'wallet credit + settlement record keyed per delivery (both idempotency keys broken)',
    "  const ref = walletRefFor(BW, apiRef);\n  const bwRef = db.collection(BW.WALLETS).doc(businessId);\n  const beRef = db.collection(BW.ENTRIES).doc(BW.entryDocId(businessId, ref));\n  const setRef = db.collection(SETTLEMENTS).doc(apiRef);",
    "  const _nonce = Math.random().toString(36).slice(2, 8);\n  const ref = walletRefFor(BW, apiRef + '_' + _nonce);\n  const bwRef = db.collection(BW.WALLETS).doc(businessId);\n  const beRef = db.collection(BW.ENTRIES).doc(BW.entryDocId(businessId, ref));\n  const setRef = db.collection(SETTLEMENTS).doc(apiRef + '_' + _nonce);"],
  [S, 'replay does not recover amounts (crash leaves the merchant unpaid)', '    appliedCents = a.amountCents; excessHeldCents = a.excessHeldCents || 0; rec = a.receivedCents || receivedCents;', '    appliedCents = undefined;'],
  [S, 'receipt not idempotent (per-delivery source id)', "  const paidArgs = { kind: 'invoice', sourceId: apiRef.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120),", "  const paidArgs = { kind: 'invoice', sourceId: (apiRef + '_' + Date.now() + Math.random().toString(36).slice(2, 6)).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120),"],
  [S, 'receipt records the applied amount as received', '    method: p.providerMethod || null, serviceLabel', '    method: p.providerMethod || null, paidCents: appliedCents || rec, serviceLabel'],
  [S, 'allocation refusal swallowed (silently settled)', "    if (e instanceof IA.AllocationError || (e && e.code && typeof e.code === 'string')) return hold('allocation_refused', { allocationCode: e.code || null });", '    return { outcome: \'settled\', appliedCents: 0 };'],
  [S, 'unresolved payment not flagged', "    await db.collection(HOLDS).doc(apiRef).set(row, { merge: true });", "    await db.collection(HOLDS).doc(apiRef).set(Object.assign({}, row, { flagged: false }), { merge: true });"],
  [S, 'merchant may pay own invoice', "  if (String(payer) === String(m.sellerUid)) return hold('payer_is_merchant');", ''],
  [S, 'non-invoice intent settled as an invoice', "  if (!intent || intent.resourceType !== 'invoice') return false;", '  if (!intent) return false;'],
  ['invoice-allocation.js', 'overpayment credited (allocation applies the full amount)', '    const appliedCents = Math.min(amountCents, balanceBefore);', '    const appliedCents = amountCents;'],
];
let caught = 0, bad = 0;
for (const [rel, label, a, b] of M) {
  const F = path.join(FN, rel); const ORIG = fs.readFileSync(F, 'utf8');
  const n = ORIG.split(a).length - 1;
  if (n !== 1) { console.log('  ANCHOR x' + n + '  ' + label); bad++; continue; }
  try {
    fs.writeFileSync(F, ORIG.replace(a, b));
    const r = spawnSync(process.execPath, [path.join(__dirname, 'test-invoice-payment-settle.js')], { encoding: 'utf8', timeout: 240000 });
    const fails = (r.stdout.match(/^\s+FAIL\s+(\S+)/mg) || []).map((l) => l.trim().split(/\s+/)[1]);
    if (r.status === 1) { caught++; console.log('  CAUGHT  ' + label + '  ← ' + fails.join(',')); }
    else { bad++; console.log('  ' + (r.status === 2 ? 'CRASH ' : 'MISSED') + '  ' + label + '  (exit ' + r.status + ')'); }
  } finally { fs.writeFileSync(F, ORIG); }
}
console.log('\nSABOTAGE: ' + caught + '/' + M.length + ' caught, ' + bad + ' missed/anchor/crash');
process.exit(bad ? 1 : 0);
