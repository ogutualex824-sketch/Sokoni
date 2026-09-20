/* ============================================================================
   C1 — a subscription payment must NEVER credit the payer's wallet, and the
   browser must not get a vote in that
   scripts/test-webhook-subscription-credit-guard.js
   ============================================================================
   THE DEFECT THIS PROVES CLOSED

     const _isSubscription =
       category === "subscription" || payData.meta?.category === "subscription";
                    ^^^^^^^^                      ^^^^^^^^^^^^^^^^^^^
   Both terms read the SAME client-supplied string. initiateSTKPush writes
   payments/{ref}.meta verbatim from request.data (index.js ~6451), so the only
   thing standing between a subscriber and a credit of their own subscription
   fee was a label their own browser chose.

   Nothing else in the chain could stop it:

       _sellerId = attribution.sellerUid || attribution.merchantUid
                   || payData.uid          <- the PAYER, for a subscription
       _netCents = amount - sokoniCut      <- ~95%, because "subscription" is
                                              unmapped in RATES (that is C2)

   So a merchant paying KES 9,990 for an annual plan, on a client that sent
   category "default", would be credited ~KES 9,490 into their wallet.

   WHAT C1 CHANGES — three code lines

     payment-attribution.js   carry intent.purpose (TOP level, BOTH branches)
     index.js                 add `attribution.purpose === "subscription"` as an
                              OR term on the existing guard

   The commission RATE lookup is deliberately NOT re-sourced: `category` still
   feeds RATES/ALIASES untouched, per WEBHOOK_ATTRIBUTION_AUTHORITY.md §2,
   whose live-evidence finding is that purpose keys resolve to RATES.default and
   would silently drop digital_download from 10% to 5%.

   WHY BOTH BRANCHES CARRY purpose

   createPaymentIntent's subscription branch writes NO `metadata` field, so a
   subscription intent takes mergeAttribution's legacy_meta branch. Carrying
   purpose only on the intent branch would miss precisely the case C1 exists
   for — and would read GREEN against a test that only checked the intent
   branch. Case 5 below is that inverting control.

   ── ORDERING: THIS SUITE EXPIRES ─────────────────────────────────────────────
   S1 discriminates ONLY while "subscription" is unmapped in RATES. Once C2
   lands, sokoniCut === amount, so _netCents === 0 and the `_netCents <= 0`
   branch suppresses the credit no matter what this guard says. S1 would then
   pass for the wrong reason. RUN THIS BEFORE C2, and when C2 lands, re-read
   this note rather than trusting a green run.

   WHAT IS ASSERTED

     1  S1 SABOTAGE   subscription intent, browser says "default"  -> REFUSED
     2  N1 NEGATIVE   product_order intent, category "product"     -> CREDITED
     3  N2 REGRESSION subscription + category "subscription"       -> REFUSED
                      (cannot discriminate; retained as regression only)
     4  no intent, non-subscription meta                           -> CREDITED
     5  subscription intent WITH metadata present                  -> REFUSED
     6  fail-open: intent unreadable, category still says so       -> REFUSED

   METHOD

   The guard expression is EXTRACTED FROM THE SHIPPED index.js and evaluated,
   rather than re-typed here. A re-typed predicate would certify this file, not
   the deployed one. Extraction failure exits 2; it cannot pass vacuously.
   `mergeAttribution` is the real function, required from functions/.

   RUN  node scripts/test-webhook-subscription-credit-guard.js
   ========================================================================== */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const IDX  = path.join(ROOT, 'functions', 'index.js');
const { mergeAttribution } = require(path.join(ROOT, 'functions', 'payment-attribution.js'));

let PASS = 0, FAIL = 0;
const FAILURES = [];
function ok(label, cond, detail) {
  if (cond) { PASS++; console.log('  PASS  ' + label); return true; }
  FAIL++; FAILURES.push(label + (detail ? '  — ' + detail : ''));
  console.log('  FAIL  ' + label + (detail ? '  — ' + detail : ''));
  return false;
}

/* ── Extract the shipped guard expression ───────────────────────────────── */
const src = fs.readFileSync(IDX, 'utf8');
const START = 'const _isSubscription =';
const i = src.indexOf(START);
if (i === -1) {
  console.error('EXTRACTION FAILED — `const _isSubscription =` not found in functions/index.js.');
  console.error('The guard moved or was removed. This suite refuses to pass vacuously.');
  process.exit(2);
}
const j = src.indexOf(';', i);
if (j === -1) { console.error('EXTRACTION FAILED — no statement terminator.'); process.exit(2); }
const guardSrc = src.slice(i, j + 1);

/* The extracted text must actually consult the server-authored purpose, or
   every "refused" assertion below could pass against the OLD predicate. */
if (guardSrc.indexOf('attribution.purpose') === -1) {
  console.error('EXTRACTION CONTROL FAILED — the shipped guard does not read');
  console.error('attribution.purpose. C1 is not present in this tree.');
  console.error('extracted: ' + guardSrc.replace(/\s+/g, ' '));
  process.exit(2);
}

const evalGuard = new Function('attribution', 'category', 'payData',
  '"use strict";' + guardSrc + ' return _isSubscription;');

/* ── The decision chain, as index.js orders it ──────────────────────────────
   _isSubscription is the FIRST branch; its body only logs. This models the
   ORDER, not the predicate — the predicate under test is the extracted one.
   Asserted structurally below so the model cannot drift from the source. */
function creditDecision({ attribution, category, payData, netCents, sellerId }) {
  if (evalGuard(attribution, category, payData)) return 'REFUSED_SUBSCRIPTION';
  if (!sellerId || netCents <= 0) return 'REFUSED_NO_SELLER_OR_ZERO_NET';
  return 'CREDITED';
}

/* Structural control: the guard really heads the credit chain, and its branch
   body does not move money. The declaration and the branch are separated by
   the _isBooking/_sellerId/_netCents declarations, so this locates the branch
   rather than assuming it is adjacent — an earlier draft assumed adjacency and
   this control is what caught it.

   If index.js is ever reordered so another branch precedes the guard, or so
   the guard's body does anything but log, the decision model below would no
   longer describe the shipped code and these fail loudly. */
const branchIdx = src.indexOf('if (_isSubscription) {', j);
const between   = branchIdx === -1 ? '' : src.slice(j + 1, branchIdx);

/* Nothing between the predicate and the branch may credit, and the branch must
   be an `if`, not an `else if` hanging off some earlier test. */
const firstBranchIsGuard = branchIdx !== -1
  && !/\belse\s*$/.test(between.trimEnd())
  && !/runTransaction|collection\((["'`])wallets\1\)/.test(between);

/* Body = the guard branch up to the next `} else`. It may log; it may not
   write, transact, or touch a wallet. */
const bodyEnd   = src.indexOf('} else', branchIdx);
const guardBody = branchIdx === -1 || bodyEnd === -1 ? ''
  : src.slice(branchIdx + 'if (_isSubscription) {'.length, bodyEnd);
const guardBodyOnlyLogs = guardBody.trim().length > 0
  && /console\.log\(/.test(guardBody)
  && !/runTransaction|\.set\(|\.update\(|wallets|finosRecordTransaction/.test(guardBody);

(async () => {
  console.log('\nC1 — subscription wallet-credit guard provenance\n' + '='.repeat(66));

  ok('0 guard is the FIRST branch of the credit chain', firstBranchIsGuard);
  ok('0 guard body only logs — it never credits', guardBodyOnlyLogs);

  /* ---- 1  S1 SABOTAGE: the browser lies about the category --------------- */
  {
    /* A real subscription intent: purpose at top level, NO metadata. */
    const intent = { ref: 'SKN1', uid: 'merchantA', planId: 'seller_basic',
                     billingCycle: 'annual', amount: 9990, purpose: 'subscription' };
    const legacyMeta = { category: 'default' };          /* <- the sabotage */
    const attribution = mergeAttribution({ intent, legacyMeta });

    ok('1 purpose survives an intent that has no metadata',
       attribution.purpose === 'subscription', 'got ' + attribution.purpose);

    const d = creditDecision({
      attribution, category: 'default', payData: { uid: 'merchantA', meta: legacyMeta },
      netCents: Math.round(9990 * 0.95 * 100), sellerId: 'merchantA',
    });
    ok('1 S1 — credit REFUSED despite the browser saying "default"',
       d === 'REFUSED_SUBSCRIPTION', 'got ' + d);
    ok('1 S1 — net was non-zero, so the refusal is the GUARD, not the net',
       Math.round(9990 * 0.95 * 100) > 0);
  }

  /* ---- 2  N1 NEGATIVE CONTROL: ordinary marketplace sale ----------------- */
  {
    const intent = { ref: 'SKN2', uid: 'buyerB', purpose: 'product_order',
                     metadata: { sellerUid: 'sellerB', orderId: 'ORD1' } };
    const legacyMeta = { category: 'product', sellerUid: 'sellerB' };
    const attribution = mergeAttribution({ intent, legacyMeta });

    ok('2 purpose is product_order, not subscription',
       attribution.purpose === 'product_order', 'got ' + attribution.purpose);
    ok('2 seller attribution unchanged by C1', attribution.sellerUid === 'sellerB');

    const d = creditDecision({
      attribution, category: 'product', payData: { uid: 'buyerB', meta: legacyMeta },
      netCents: 95000, sellerId: 'sellerB',
    });
    ok('2 N1 — an ordinary sale is STILL CREDITED', d === 'CREDITED', 'got ' + d);
  }

  /* ---- 3  N2 REGRESSION (non-discriminating, retained deliberately) ------ */
  {
    const intent = { ref: 'SKN3', uid: 'merchantC', purpose: 'subscription' };
    const legacyMeta = { category: 'subscription' };
    const attribution = mergeAttribution({ intent, legacyMeta });
    const d = creditDecision({
      attribution, category: 'subscription',
      payData: { uid: 'merchantC', meta: legacyMeta },
      netCents: 94905, sellerId: 'merchantC',
    });
    ok('3 N2 — honest client still refused (passes BEFORE and AFTER C1)',
       d === 'REFUSED_SUBSCRIPTION', 'got ' + d);
  }

  /* ---- 4  no intent at all: D2 compatibility ----------------------------- */
  {
    const legacyMeta = { category: 'product', sellerUid: 'sellerD' };
    const attribution = mergeAttribution({ intent: null, legacyMeta });
    ok('4 purpose is null when no intent exists — UNKNOWN, not "not a sub"',
       attribution.purpose === null, 'got ' + attribution.purpose);
    const d = creditDecision({
      attribution, category: 'product', payData: { uid: 'buyerD', meta: legacyMeta },
      netCents: 50000, sellerId: 'sellerD',
    });
    ok('4 unmigrated caller still credited, exactly as before',
       d === 'CREDITED', 'got ' + d);
  }

  /* ---- 5  INVERTING CONTROL: intent WITH metadata ------------------------
     Proves purpose is carried on the intent branch too. If purpose were added
     only to legacy_meta, this case would silently credit. */
  {
    const intent = { ref: 'SKN5', uid: 'merchantE', purpose: 'subscription',
                     metadata: { merchantUid: 'merchantE' } };
    const attribution = mergeAttribution({ intent, legacyMeta: { category: 'default' } });
    ok('5 intent branch carries purpose too', attribution.source === 'intent'
       && attribution.purpose === 'subscription',
       'source=' + attribution.source + ' purpose=' + attribution.purpose);
    const d = creditDecision({
      attribution, category: 'default',
      payData: { uid: 'merchantE', meta: { category: 'default' } },
      netCents: 94905, sellerId: 'merchantE',
    });
    ok('5 refused on the intent branch as well', d === 'REFUSED_SUBSCRIPTION', 'got ' + d);
  }

  /* ---- 6  FAIL-OPEN POSTURE IS PRESERVED, NOT SILENTLY CHANGED ----------
     resolveFinancialAttribution swallows a Firestore error and returns
     intent:null. C1 must not alter that; the category fallback still answers. */
  {
    const legacyMeta = { category: 'subscription' };
    const attribution = mergeAttribution({ intent: null, legacyMeta });
    ok('6 purpose unavailable when the intent could not be read',
       attribution.purpose === null);
    const d = creditDecision({
      attribution, category: 'subscription',
      payData: { uid: 'merchantF', meta: legacyMeta },
      netCents: 94905, sellerId: 'merchantF',
    });
    ok('6 category fallback still refuses — fail-open unchanged by C1',
       d === 'REFUSED_SUBSCRIPTION', 'got ' + d);
  }

  /* ---- 7  NEGATIVE CONTROL ON THE HARNESS ITSELF ------------------------
     A deliberately false assertion. If this does NOT appear as a failure, the
     harness cannot detect failure and every PASS above is meaningless. */
  console.log('  -- harness negative control (the next line MUST read FAIL) --');
  const before = FAIL;
  ok('7 deliberately false assertion', false, 'expected');
  const detects = FAIL === before + 1;
  FAIL--; FAILURES.pop();                 /* retract the intentional failure */
  if (!detects) {
    console.error('\n  HARNESS CANNOT DETECT FAILURE — refusing to report a pass.');
    process.exit(2);
  }
  PASS++;
  console.log('  PASS  7 harness detects failure (control retracted)');

  console.log('='.repeat(66));
  console.log('  passed ' + PASS + '   failed ' + FAIL);
  if (FAILURES.length) FAILURES.forEach((f) => console.log('   x ' + f));
  console.log(FAIL === 0
    ? '\n  C1 SUBSCRIPTION CREDIT GUARD: GREEN'
    : '\n  C1 SUBSCRIPTION CREDIT GUARD: RED');
  console.log('  Proves guard PROVENANCE only. Not the commission rate (C2),');
  console.log('  not annual expiry (A), not the trial path (B).');
  console.log('  S1 discriminates only while "subscription" is unmapped in RATES.\n');
  process.exit(FAIL === 0 ? 0 : 1);
})().catch((e) => {
  console.error('\n  HARNESS CRASHED — ' + (e && e.stack ? e.stack.split('\n')[0] : e));
  process.exit(2);
});
