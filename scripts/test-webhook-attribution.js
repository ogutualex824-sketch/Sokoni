#!/usr/bin/env node
/* webhookIntasend financial attribution — Q6 certification of the pure core.
 *
 * No Firestore, no network, no deployment, no emulator — certifies
 * functions/payment-attribution.js's mergeAttribution directly, the same
 * methodology scripts/test-sokoni-qr-payment.js (Q5) and
 * scripts/test-money-authority.js already use for their own pure cores.
 * The I/O wrapper (resolveFinancialAttribution) and webhookIntasend itself
 * are thin call sites around this decision — certifying the decision
 * certifies what matters.
 *
 * IT CARRIES ITS OWN CONTROLS, per this session's standing rule:
 *   - a NEGATIVE control that must itself fail
 *   - a SABOTAGE control: the "Till fields never come from legacyMeta" floor
 *     is removed from a temporary, weakened copy of the source, and the same
 *     "wrong merchant" attack the real code denies is proven to be WRONGLY
 *     allowed by the sabotaged copy.
 * If either misbehaves the run is BLOCKED, regardless of how many tests passed.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const A = require('../functions/payment-attribution');

let pass = 0, fail = 0;

function ok(label, cond, note) {
  if (cond) { pass++; }
  else { fail++; console.log('  FAIL  ' + label + (note ? '   [' + note + ']' : '')); }
}

console.log('');
console.log('  webhookIntasend FINANCIAL ATTRIBUTION (Q6) — pure core certification');
console.log('');

/* ── 1. Valid intent → attribution sourced from it, correctly ─────────────── */
console.log('  -- valid intent -> correct attribution --');
{
  const productIntent = {
    purpose: 'product_order',
    metadata: {
      orderId: 'ORD123', sellerUid: 'seller-real', category: 'product',
      items: [{ productId: 'p1', qty: 2, unitPrice: 100, sellerUid: 'seller-real' }],
    },
  };
  const r = A.mergeAttribution({ intent: productIntent, legacyMeta: {} });
  ok('source is "intent"', r.source === 'intent');
  ok('sellerUid resolves from intent.metadata', r.sellerUid === 'seller-real');
  ok('orderId resolves from intent.metadata', r.orderId === 'ORD123');
  ok('items resolves from intent.metadata', Array.isArray(r.items) && r.items.length === 1);

  const tillIntent = {
    purpose: 'pos_till_sale',
    metadata: {
      sokoniTillId: 'SK-KASSAB12-0001', shopId: 'shop1', branchId: 'shop1-main',
      merchantUid: 'shop1', category: 'pos_till',
    },
  };
  const rt = A.mergeAttribution({ intent: tillIntent, legacyMeta: {} });
  ok('Till: sokoniTillId resolves from intent.metadata', rt.sokoniTillId === 'SK-KASSAB12-0001');
  ok('Till: shopId resolves from intent.metadata', rt.shopId === 'shop1');
  ok('Till: branchId resolves from intent.metadata', rt.branchId === 'shop1-main');
  ok('Till: merchantUid resolves from intent.metadata', rt.merchantUid === 'shop1');
  ok('Till: sellerUid is null (not applicable to a Till sale)', rt.sellerUid === null);

  const bookingIntent = { purpose: 'service_booking', metadata: { type: 'service-booking', providerId: 'prov1', bookingId: 'BK1' } };
  const rb = A.mergeAttribution({ intent: bookingIntent, legacyMeta: {} });
  ok('booking: providerId resolves from intent.metadata', rb.providerId === 'prov1');
  ok('booking: type resolves from intent.metadata', rb.type === 'service-booking');
}

/* ── 2. Tampered client metadata alongside a VALID intent — all ignored ───── */
console.log('  -- tampered legacyMeta alongside a valid intent (all must be IGNORED) --');
{
  const intent = {
    purpose: 'product_order',
    metadata: { orderId: 'ORD-REAL', sellerUid: 'seller-real', items: [{ productId: 'p1' }] },
  };
  const hostileMeta = {
    orderId: 'ORD-FAKE', sellerUid: 'ATTACKER-UID', providerId: 'ATTACKER-PROVIDER',
    sokoniTillId: 'SK-ATTACKER-0001', shopId: 'ATTACKER-SHOP', branchId: 'ATTACKER-BRANCH',
    merchantUid: 'ATTACKER-MERCHANT', type: 'booking', items: [{ productId: 'fake-item' }],
  };
  const r = A.mergeAttribution({ intent, legacyMeta: hostileMeta });
  ok('tampered sellerUid in legacyMeta is ignored', r.sellerUid === 'seller-real');
  ok('tampered orderId in legacyMeta is ignored', r.orderId === 'ORD-REAL');
  ok('tampered items in legacyMeta is ignored', r.items[0].productId === 'p1');
  ok('tampered providerId in legacyMeta is ignored (not in this intent\'s metadata -> null, not the attacker\'s value)', r.providerId === null);
  ok('tampered sokoniTillId in legacyMeta is ignored', r.sokoniTillId === null);
  ok('tampered shopId/branchId/merchantUid in legacyMeta are ignored', r.shopId === null && r.branchId === null && r.merchantUid === null);
  ok('tampered type in legacyMeta is ignored (intent carried none -> null, not "booking")', r.type === null);
}

/* ── 3. Wrong merchant — the Till floor: NEVER from legacyMeta, intent or not ── */
console.log('  -- "wrong merchant" denial: Till fields never populate from legacyMeta --');
{
  const hostileMeta = {
    sokoniTillId: 'SK-ATTACKER-0001', shopId: 'ATTACKER-SHOP',
    branchId: 'ATTACKER-BRANCH', merchantUid: 'ATTACKER-MERCHANT',
  };
  const noIntent = A.mergeAttribution({ intent: null, legacyMeta: hostileMeta });
  ok('no intent at all: Till fields still null, not the hostile legacyMeta values',
    noIntent.sokoniTillId === null && noIntent.shopId === null && noIntent.branchId === null && noIntent.merchantUid === null);

  const nonTillIntent = { purpose: 'digital_download', metadata: { sellerUid: 'seller-x' } };
  const wrongPurpose = A.mergeAttribution({ intent: nonTillIntent, legacyMeta: hostileMeta });
  ok('an intent that is NOT a Till sale: Till fields still null, not the hostile legacyMeta values',
    wrongPurpose.sokoniTillId === null && wrongPurpose.merchantUid === null);

  const intentNoMetadata = { purpose: 'subscription' }; // subscription intents carry no .metadata at all
  const noMeta = A.mergeAttribution({ intent: intentNoMetadata, legacyMeta: hostileMeta });
  ok('an intent with NO .metadata field falls back to legacy_meta source, but Till fields STILL null',
    noMeta.source === 'legacy_meta' && noMeta.merchantUid === null && noMeta.sokoniTillId === null);
}

/* ── 4. Missing/invalid intent — behaviour matches legacyMeta, byte-identical ── */
console.log('  -- missing/invalid intent: byte-identical fallback (D2 compatibility) --');
{
  const legacyMeta = { sellerUid: 'legacy-seller', orderId: 'LEGACY-ORD', providerId: 'legacy-provider', type: 'booking', items: [{ productId: 'x' }] };

  const r1 = A.mergeAttribution({ intent: null, legacyMeta });
  ok('intent:null -> source is legacy_meta', r1.source === 'legacy_meta');
  ok('intent:null -> sellerUid matches legacyMeta exactly', r1.sellerUid === 'legacy-seller');
  ok('intent:null -> orderId matches legacyMeta exactly', r1.orderId === 'LEGACY-ORD');
  ok('intent:null -> providerId matches legacyMeta exactly', r1.providerId === 'legacy-provider');
  ok('intent:null -> type matches legacyMeta exactly', r1.type === 'booking');

  const r2 = A.mergeAttribution({ intent: undefined, legacyMeta });
  ok('intent:undefined behaves identically to intent:null', JSON.stringify(r1) === JSON.stringify(r2));

  const r3 = A.mergeAttribution({ intent: { purpose: 'x' }, legacyMeta }); // intent exists but has no .metadata
  ok('intent with no .metadata -> falls back to legacy_meta, matching legacyMeta exactly',
    r3.source === 'legacy_meta' && r3.sellerUid === 'legacy-seller');

  const r4 = A.mergeAttribution({ intent: null, legacyMeta: undefined });
  ok('no legacyMeta at all (undefined) does not throw, returns nulls', r4.sellerUid === null && r4.orderId === null);
}

/* ── 5. Different reference -> independent evaluation (purity) ────────────── */
console.log('  -- purity: independent calls do not share state --');
{
  const a = A.mergeAttribution({ intent: { metadata: { sellerUid: 'A' } }, legacyMeta: {} });
  const b = A.mergeAttribution({ intent: { metadata: { sellerUid: 'B' } }, legacyMeta: {} });
  ok('two calls with different intents return independent, non-aliased results', a.sellerUid === 'A' && b.sellerUid === 'B');
  a.sellerUid = 'MUTATED';
  const c = A.mergeAttribution({ intent: { metadata: { sellerUid: 'B' } }, legacyMeta: {} });
  ok('mutating one result does not affect a subsequent call with the same input', c.sellerUid === 'B');
}

/* ── NEGATIVE CONTROL ───────────────────────────────────────────────────── */
console.log('  -- negative control (must fail; proves the harness can detect failure) --');
{
  const before = fail;
  ok('deliberately false assertion', 1 === 2);
  ok('control recorded exactly one failure', fail === before + 1);
  fail--; // the deliberate failure above is not a real defect
}

/* ── SABOTAGE CONTROL ───────────────────────────────────────────────────── */
console.log('  -- sabotage control (Till-floor removal must be CAUGHT failing) --');
{
  const realSrc = fs.readFileSync(path.join(__dirname, '..', 'functions', 'payment-attribution.js'), 'utf8');

  // Remove the floor: let the intent branch pull Till fields from legacyMeta too.
  const sabotagedSrc = realSrc.replace(
    /sokoniTillId: m\.sokoniTillId \|\| null,\n(\s*)shopId:       m\.shopId \|\| null,\n\s*branchId:     m\.branchId \|\| null,\n\s*merchantUid:  m\.merchantUid \|\| null,/,
    'sokoniTillId: m.sokoniTillId || legacyMeta.sokoniTillId || null,\n$1shopId:       m.shopId || legacyMeta.shopId || null,\n$1branchId:     m.branchId || legacyMeta.branchId || null,\n$1merchantUid:  m.merchantUid || legacyMeta.merchantUid || null,'
  );
  if (sabotagedSrc === realSrc) {
    throw new Error('SABOTAGE CONTROL SETUP FAILED — the Till-floor lines to weaken were not found; ' +
      'the control cannot prove anything and the run must be blocked.');
  }

  const tmpFile = path.join(os.tmpdir(), `payment-attribution.sabotaged.${process.pid}.js`);
  fs.writeFileSync(tmpFile, sabotagedSrc);
  let sabotaged;
  try {
    sabotaged = require(tmpFile);

    // A VALID (non-Till) intent exists, but the client smuggles a Till merchantUid
    // into legacyMeta anyway — the real code ignores it (proven in §2); the
    // sabotaged code should wrongly leak it through.
    const intent = { purpose: 'digital_download', metadata: { sellerUid: 'seller-x' } };
    const hostileMeta = { merchantUid: 'ATTACKER-MERCHANT', shopId: 'ATTACKER-SHOP' };

    const sabotagedResult = sabotaged.mergeAttribution({ intent, legacyMeta: hostileMeta });
    ok('SABOTAGE: weakened code WRONGLY leaks a hostile merchantUid through (proves the real floor matters)',
      sabotagedResult.merchantUid === 'ATTACKER-MERCHANT');

    const realResult = A.mergeAttribution({ intent, legacyMeta: hostileMeta });
    ok('control: the REAL (unmodified) module still refuses the same hostile merchantUid',
      realResult.merchantUid === null);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) { /* best-effort cleanup */ }
  }
}

/* ── Summary ────────────────────────────────────────────────────────────── */
console.log('');
console.log(`  ${pass} passed, ${fail} failed`);
console.log('');

if (fail > 0) {
  console.log('  BLOCKED — see FAIL lines above.');
  process.exit(1);
} else {
  console.log('  CERTIFIED — Q6 pure core (functions/payment-attribution.js).');
  process.exit(0);
}
