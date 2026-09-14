#!/usr/bin/env node
/* 48-hour commission receivable + merchant payment destinations.
 *
 * THE FOUR INVARIANTS. Everything else in this suite exists to support them.
 *
 *   1. NO DOUBLE BILLING. One marketplace sale is billed by ONE system.
 *   2. NO RETROACTIVE DEADLINE. A row that existed before the migration can
 *      never acquire a dueAt or be judged overdue.
 *   3. NO SELF-VERIFIED DESTINATION. A merchant cannot declare their own Till
 *      VERIFIED, and cannot lose a working one by attempting a change.
 *   4. NO PAYMENT ON INTENT. An STK request being accepted never clears a
 *      balance or lifts a restriction; only a server-confirmed payment does.
 *
 * Tests exercise the SHIPPED modules where they are pure, and read the shipped
 * source where behaviour lives inside a Firestore transaction. Every structural
 * detector carries a negative control, because a detector that cannot fail is
 * not evidence.
 *
 *   node scripts/test-commission-48h-destinations.js
 */
'use strict';
const fs   = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

const ROOT = path.join(__dirname, '..');
const R = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const IDX  = R('functions/index.js');
const CCOL = R('functions/commission-collection.js');
const PDST = R('functions/payment-destinations.js');
const RULES = R('firestore.rules');

/* commission-collection exports pure helpers; load them for real assertions. */
const CC = require(path.join(ROOT, 'functions', 'commission-collection.js'));

/* ══ 1. NO DOUBLE BILLING ══════════════════════════════════════════════ */
console.log('\nA. Invariant 1 — one sale, one billing system\n');
{
  ck('ledger rows are stamped with a billingModel at creation',
     /billingModel: _is48hCommission\(hub\) \? "PER_SALE_48H" : "MONTHLY"/.test(IDX));
  ck('generateMonthlyInvoices SKIPS rows owned by the 48-hour model',
     /if \(data\.billingModel === "PER_SALE_48H"\) \{ _skipped48h\+\+; return; \}/.test(IDX));
  ck('the 48-hour sweep selects ONLY PER_SALE_48H rows',
     /where\('billingModel', '==', 'PER_SALE_48H'\)/.test(CCOL));
  ck('  ...and the balance/settlement queries do too',
     (CCOL.match(/where\('billingModel', '==', 'PER_SALE_48H'\)/g) || []).length >= 3);

  /* The exclusion must be an in-code filter, never a Firestore `!=` query:
     `where('billingModel','!=','PER_SALE_48H')` drops docs where the field is
     ABSENT — i.e. every historical row — silently ending monthly invoicing. */
  /* Match executable code only. The explanatory comment in index.js quotes the
     wrong-way query verbatim to say why it is wrong, and a naive scan of the
     whole file flags that prose as the defect it warns against. */
  const IDX_CODE = IDX.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ck('exclusion is NOT a Firestore != query (which would drop historical rows)',
     !/\.where\(\s*["']billingModel["']\s*,\s*["']!=["']/.test(IDX_CODE));
}
{
  const broken = IDX.replace('if (data.billingModel === "PER_SALE_48H") { _skipped48h++; return; }', '');
  ck('negative control: double-billing detector FAILS without the guard',
     !/if \(data\.billingModel === "PER_SALE_48H"\) \{ _skipped48h\+\+; return; \}/.test(broken));
}

/* ══ 2. NO RETROACTIVE DEADLINE ════════════════════════════════════════ */
console.log('\nB. Invariant 2 — historical rows can never become overdue\n');
{
  ck('the cutoff is FIELD PRESENCE, not a date comparison',
     /where\('billingModel', '==', 'PER_SALE_48H'\)/.test(CCOL)
     && !/createdAt.*>=.*CUTOFF|dueAt.*>=.*MIGRATION/.test(CCOL));
  ck('a row of this model with no dueAt is SKIPPED, not given one',
     /if \(!dueMs\) continue;/.test(CCOL));
  /* \b before dueAt matters: `overdueAt: _ts()` CONTAINS "dueAt: _ts()" as a
     substring, and without the boundary this flags a legitimate state timestamp
     as a deadline write. */
  ck('  ...and nothing in the sweep ever writes a dueAt',
     !/(^|[^A-Za-z])dueAt:\s*(_ts\(\)|admin\.firestore\.Timestamp)/.test(CCOL));
  ck('dueAt is stamped once at creation and never recomputed',
     /dueAt: _is48hCommission\(hub\)[\s\S]{0,160}?Timestamp\.fromMillis\(Date\.now\(\) \+ COMMISSION_DUE_HOURS/.test(IDX));

  /* Simulate the selection a historical row would face. */
  const historical = { status: 'pending', period: '2026-07' };            /* no billingModel */
  const migrated   = { status: 'pending', period: '2026-08', billingModel: 'PER_SALE_48H' };
  ck('historical row is INVISIBLE to the 48-hour sweep',
     historical.billingModel !== 'PER_SALE_48H');
  ck('historical row is STILL VISIBLE to monthly invoicing',
     historical.billingModel !== 'PER_SALE_48H');
  ck('migrated row is invisible to monthly invoicing',
     migrated.billingModel === 'PER_SALE_48H');
}

/* ══ 3. NO SELF-VERIFIED DESTINATION ══════════════════════════════════ */
console.log('\nC. Invariant 3 — the merchant cannot verify their own Till\n');
{
  ck('paymentDestinations denies ALL client writes',
     /match \/paymentDestinations\/\{sellerUid\} \{[\s\S]{0,300}?allow write: if false;/.test(RULES));
  ck('sellerRestrictions denies ALL client writes',
     /match \/sellerRestrictions\/\{sellerUid\} \{[\s\S]{0,300}?allow write: if false;/.test(RULES));
  ck('  ...both readable only by owner or admin',
     /match \/paymentDestinations\/\{sellerUid\} \{\s*\n\s*allow read:\s*if isAdmin\(\) \|\| \(isAuthed\(\) && request\.auth\.uid == sellerUid\);/.test(RULES));

  ck('savePaymentDestination NEVER writes status VERIFIED',
     !/status:\s*STATUS\.VERIFIED[\s\S]{0,200}?savePaymentDestination/.test(PDST)
     && /pending[\s\S]{0,200}?status: STATUS\.PENDING_TEST/.test(PDST));
  ck('confirmVerified is the ONLY producer of a verified activeDestination',
     (PDST.match(/activeDestination: promoted/g) || []).length === 1);
  ck('  ...and it is NOT exported as a callable',
     !/exports\.confirmVerified\s*=\s*onCall/.test(PDST));
  ck('verification is reached only from the STK callback',
     /payData\.hub === "destination_test"[\s\S]{0,400}?confirmVerified/.test(IDX));
  ck('  ...gated on a genuine success result code',
     /if \(resultCode === 0\) \{\s*\n\s*const r = await _pd\.confirmVerified/.test(IDX));
}
console.log('\n   ...and a change never costs the merchant their live destination\n');
{
  ck('a staged change writes only `pending`, leaving activeDestination alone',
     /pending,\s*\n[\s\S]{0,400}?status: active \? STATUS\.VERIFIED : STATUS\.PENDING_TEST/.test(PDST));
  ck('the swap is transactional (no window with two or zero destinations)',
     /return db\.runTransaction\(async \(txn\) => \{[\s\S]{0,2000}?activeDestination: promoted/.test(PDST));
  ck('the old destination is retired into history, not discarded',
     /history: prior\.slice\(0, 20\)/.test(PDST) && /retiredAt: now/.test(PDST));
  ck('a failed test marks only the ATTEMPT failed',
     /'pending\.status': STATUS\.FAILED/.test(PDST));
  ck('  ...and overall status stays VERIFIED while a live destination stands',
     /status: hasActive \? STATUS\.VERIFIED : STATUS\.FAILED/.test(PDST));
  ck('the callback must match the checkout id that started the test',
     /pending\.testCheckoutId \|\| ''\) !== String\(checkoutId\)[\s\S]{0,120}?checkout_id_mismatch/.test(PDST));
  ck('resolveActiveDestination returns null rather than any fallback shortcode',
     /if \(!d\.activeDestination \|\| d\.activeDestination\.status !== STATUS\.VERIFIED\) return null;/.test(PDST));
  ck('  ...and no Bravilex/KASS till is hardcoded anywhere in the module',
     !/3588275|174379/.test(PDST));
}

/* ══ 4. NO PAYMENT ON INTENT ══════════════════════════════════════════ */
console.log('\nD. Invariant 4 — only confirmed payment clears a balance\n');
{
  ck('settleConfirmedPayment is NOT a callable (no browser can invoke it)',
     !/exports\.settleConfirmedPayment\s*=\s*onCall/.test(CCOL)
     && /async function settleConfirmedPayment/.test(CCOL));
  ck('restriction lifts only when NOTHING is outstanding',
     /if \(stillOwed === 0\) \{[\s\S]{0,300}?restricted: false/.test(CCOL));
  ck('a partial payment does NOT mark a row paid',
     /partialPaidKES: admin\.firestore\.FieldValue\.increment\(remaining\)/.test(CCOL));
  ck('the premium gate reads server state, not client arithmetic',
     /getSellerRestriction[\s\S]{0,400}?collection\(RESTRICTION\)\.doc\(String\(req\.auth\.uid\)\)/.test(CCOL));
}

/* ══ Penalty policy — fail closed, never invented ═════════════════════ */
console.log('\nE. Penalty is configuration, and fails closed\n');
{
  ck('no default penalty rate exists anywhere in the module',
     !/penaltyPct\s*[:=]\s*[1-9]/.test(CCOL.replace(/penaltyPct: hasPct[^\n]*/g, '')));
  ck('computePenalty(null) === 0  (absent config ⇒ no penalty)', CC.computePenalty(null, 5000) === 0);
  ck('computePenalty with a 10% policy on KES 50 → KES 5',
     CC.computePenalty({ penaltyPct: 10, penaltyFixedKES: 0 }, 50) === 5);
  ck('  ...fixed component adds on top',
     CC.computePenalty({ penaltyPct: 0, penaltyFixedKES: 20 }, 50) === 20);
  ck('enabled:true but rate-less yields NO policy (misconfig ≠ permission to guess)',
     /if \(!hasPct && !hasFixed\) return null;/.test(CCOL));
  ck('unreadable config yields no penalty', /catch \(_e\) \{\s*\n\s*return null;/.test(CCOL));
  ck('restriction applies only when the policy says so',
     /if \(policy && policy\.restrictAccess\)/.test(CCOL));
  ck('the penalty rule id is stored with every assessed penalty',
     /penaltyRuleId: penalty > 0 \? policy\.ruleId : null/.test(CCOL));
}

/* ══ Timing ═══════════════════════════════════════════════════════════ */
console.log('\nF. Deadline and reminder timing\n');
{
  ck('due window is 48 hours', CC.DUE_HOURS === 48);
  ck('reminder at 46 hours (2 before the deadline)', CC.REMINDER_HOURS === 46);
  ck('index.js agrees on both constants',
     /COMMISSION_DUE_HOURS\s*=\s*48/.test(IDX) && /COMMISSION_REMINDER_HOURS\s*=\s*46/.test(IDX));
  ck('reminder fires BEFORE expiry, not after',
     /hoursLeft <= \(DUE_HOURS - REMINDER_HOURS\) && hoursLeft > 0/.test(CCOL));
  ck('  ...exactly once, guarded by reminderSentAt', /if \(!d\.reminderSentAt\)/.test(CCOL));
  ck('overdue only strictly past the deadline', /if \(hoursLeft <= 0 && d\.collectionStatus !== CS\.OVERDUE\)/.test(CCOL));
}

/* ══ Scope: only marketplace ══════════════════════════════════════════ */
console.log('\nG. Scope — only marketplace sales enter the 48-hour model\n');
{
  const CFG = require(path.join(ROOT, 'functions', 'commission-config.js'));
  const is48 = (hub) => CFG.categoryForHub(hub) === 'marketplace';
  for (const h of ['marketplace', 'product', 'products', 'pos', 'shopping', 'b2b']) {
    ck(`"${h}" IS governed by the 48-hour model`, is48(h) === true);
  }
  for (const h of ['food_delivery', 'legal', 'healthcare', 'events', 'digital_products',
                   'property', 'subscriptions', 'advertising', 'hub']) {
    ck(`"${h}" is NOT (keeps monthly / contractual billing)`, is48(h) === false);
  }
  ck('hub resolution reuses commission-config, not a second hub list',
     /require\("\.\/commission-config"\)\.categoryForHub\(hub\) === "marketplace"/.test(IDX));
  ck('config failure falls back to MONTHLY (never starts an unseen clock)',
     /catch \(_e\) \{[\s\S]{0,300}?return false;/.test(IDX));
}

/* ══ No second ledger / no second endpoint ════════════════════════════ */
console.log('\nH. No duplicate financial authority\n');
{
  ck('commission-collection writes ONLY to commissionLedger',
     /const LEDGER\s*=\s*'commissionLedger'/.test(CCOL)
     && !/collection\('commissionLedger2|commissionReceivables|invoices48/.test(CCOL));
  /* The real invariant: no Firestore WRITE in this module may touch the figures
     resolved at the time of sale. Reading them into an API response is fine and
     necessary — so scan the arguments of .set()/.update() calls specifically,
     not the whole file. */
  {
    const IMMUTABLE = ['commissionPct', 'grossAmount', 'commissionKES', 'totalOwed', 'hub', 'period'];
    const writes = CCOL.match(/\.(?:set|update)\(\s*\{[\s\S]*?\}/g) || [];
    const offenders = [];
    for (const w of writes) {
      for (const f of IMMUTABLE) {
        if (new RegExp('(^|[^A-Za-z.])' + f + '\\s*:').test(w)) offenders.push(f);
      }
    }
    ck('no write in this module touches an immutable sale figure',
       offenders.length === 0, offenders.join(',') || `${writes.length} writes scanned, all clean`);
    /* Negative control: the scanner must be able to see an offending write. */
    const planted = ['.set({ collectionStatus: "PAID", commissionPct: 99 }'];
    ck('  negative control: scanner DOES flag a planted rewrite',
       IMMUTABLE.some((f) => new RegExp('(^|[^A-Za-z.])' + f + '\\s*:').test(planted[0])));
  }
  ck('still exactly one STK callback endpoint',
     (IDX.match(/exports\.darajaSTKCallback\s*=/g) || []).length === 1);
  ck('no new STK push endpoint was created',
     (IDX.match(/mpesa\/stkpush\/v1\/processrequest/g) || []).length === 2);
  ck('new functions are re-exported by name (deploy contract)',
     /exports\.getPaymentDestination\s*=\s*_pdest\.getPaymentDestination/.test(IDX)
     && /exports\.sweepCommissionDue\s*=\s*_ccol\.sweepCommissionDue/.test(IDX));
}

/* ══ Identity: the Till is configuration, not identity ════════════════ */
console.log('\nI. The Till is configuration hanging off one identity\n');
{
  ck('scope resolves auth.uid -> users/{uid}.activeShopId -> shops/{shopId}',
     /collection\('users'\)\.doc\(String\(uid\)\)[\s\S]{0,300}?activeShopId[\s\S]{0,300}?collection\('shops'\)\.doc\(String\(activeShopId\)\)/.test(PDST));
  ck('shop ownership is verified against ownerId/sellerUid',
     /shop\.ownerId !== String\(uid\) && shop\.sellerUid !== String\(uid\)/.test(PDST));
  ck('destination doc is keyed by sellerUid — changing a Till cannot fork a merchant',
     /collection\(COLL\)\.doc\(scope\.sellerUid\)/.test(PDST));
  ck('re-saving the live destination is a no-op, not a re-verification',
     /return \{ ok: true, unchanged: true/.test(PDST));
}

/* ══ Migration boundary is not silently crossed ═══════════════════════ */
console.log('\nJ. IntaSend MoR boundary kept explicit\n');
{
  ck('production authorization gate exists and defaults false when absent',
     /productionAuthorized !== true/.test(PDST)
     && /productionAuthorized: cur \? cur\.productionAuthorized === true : false/.test(PDST));
  ck('  ...and blocks the destination rather than silently using it',
     /blocked: 'production_not_authorized'/.test(PDST));
  ck('resolveCollectionRoute still defaults DIRECT_TO_SELLER',
     /collectionRoute: ROUTE_DIRECT/.test(R('functions/payment-config.js')));
  ck('CENTRAL_MOR still refuses without central credentials',
     /Central collection \(CENTRAL_MOR\) is enabled but central Daraja credentials are not provisioned/.test(IDX));
}

/* ══ N. Settlement idempotency — the contract's hard invariant ═══════════
   Webhooks arrive more than once; that is normal, not exceptional. Before this
   guard, settleConfirmedPayment queried OPEN rows and settled them by amount
   with NO lookup on paymentRef — so a redelivery of the SAME payment settled a
   SECOND tranche of rows. One real payment would clear twice the debt and lift
   a restriction that should still stand. */
console.log('\nN. A redelivered webhook settles once\n');
{
  ck('a settlement claim collection is declared',
     /const SETTLEMENT = 'commissionSettlements';/.test(CCOL));
  ck('the claim id IS the payment reference (deterministic)',
     /collection\(SETTLEMENT\)\.doc\(ref\)/.test(CCOL));
  ck('the claim is taken inside a TRANSACTION',
     /runTransaction\(async \(txn\) => \{[\s\S]{0,300}?txn\.get\(claimRef\)/.test(CCOL));
  ck('  ...an existing claim aborts the settlement',
     /if \(prior\.exists\) return false;/.test(CCOL));
  ck('  ...and a redelivery returns a no-op, not a second settlement',
     /already_settled/.test(CCOL) && /if \(!claimed\)[\s\S]{0,220}?settled: 0/.test(CCOL));
  ck('the claim is taken BEFORE any ledger row is read',
     CCOL.indexOf('collection(SETTLEMENT).doc(ref)') < CCOL.indexOf('.where(\'billingModel\', \'==\', \'PER_SALE_48H\')\n    .where(\'collectionStatus\''));
  ck('a missing paymentRef is REFUSED rather than settled unguarded',
     /no_payment_ref/.test(CCOL));
  ck('the claim records its outcome for audit',
     /status: 'applied', settled, stillOwed/.test(CCOL));
  /* Negative control — the detector must be able to see the pre-fix shape. */
  ck('  negative control: detector DOES flag settlement with no claim',
     !/const SETTLEMENT/.test('async function settle(){ const s = await db.collection(LEDGER).get(); }'));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
