#!/usr/bin/env node
/**
 * POS SALE ATTRIBUTION — who sold it, for which shop, and who may read it.
 *
 *   node scripts/test-pos-sale-attribution.js
 *
 * THE DEFECT THIS CLOSES
 * The served rule authorises a read with `resource.data.sellerId == request.auth.uid`.
 * `posCompleteCheckout` wrote only `merchantId`. The disjunct was therefore DEAD, and a shop
 * owner could not read their own POS sales — which is a plausible mechanism for POS sales
 * being absent from Orders, Analytics and Revenue.
 *
 * WHY THE FIELD MUST BE WRITTEN AFTER `...metadata`
 * `metadata` is caller-supplied and spread FIRST. Any field the server does not subsequently
 * write can be supplied by the caller. `sellerId` was exactly such a name — so before this
 * change, the only way a sale could carry a read key was for a CLIENT to put one there. A
 * client-controlled authorisation key is worse than a dead rule, because it looks like it
 * works.
 *
 * WHAT WAS ALREADY CORRECT, and is asserted so it stays that way:
 *   cashierId  is `auth.uid` via _assertAuth — NOT client-supplied
 *   merchantId is validated by resolveActor — a caller cannot sell for another shop
 *   servedBy   is resolved from employment records, never from the request
 *
 * WHAT REMAINS UNFIXED, deliberately:
 *   shiftId    is destructured from the request and only sanitized. A caller can attach a
 *              sale to another shift. Fixing it means deriving the authoritative open shift
 *              inside checkout, which is money-path work and is reported, not attempted.
 *   cashierUid the rule's second disjunct names a field NO writer produces. Making a
 *              cashier able to read their own sales needs either that field or a rule
 *              change; both are decisions, not cleanups.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const NL = String.fromCharCode(10);
const ZF = fs.readFileSync(path.join(ROOT, 'functions/pos-zero-friction.js'), 'utf8');
const RULES = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
const MAP = require(path.join(ROOT, 'functions/pos-retail-mirror-map.js'));

let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 92) + ']' : ''));
  ok ? pass++ : fail++;
};
const un = (l, why) => { console.log('  UNPROVEN  ' + l + '   [' + why + ']'); unproven++; };
const head = (t) => console.log(NL + t);

/* The sale-document literal, so assertions are about the WRITE and not about prose
   elsewhere in a 1,000-line file. */
const SALE_DOC = (function () {
  const at = ZF.indexOf('const sale = {');
  if (at === -1) return '';
  return ZF.slice(at, ZF.indexOf('await db.collection(\'posRetailSales\')', at));
})();

console.log(NL + 'POS SALE ATTRIBUTION' + NL + '='.repeat(60));

/* ── 1 · the read key exists and is authoritative ─────────────────────────── */
head('1 · the sale carries the key the rule actually checks');
ck('the sale document was located', SALE_DOC.length > 400, SALE_DOC.length + ' chars');
ck('the rule authorises on sellerId',
   /resource\.data\.sellerId == request\.auth\.uid/.test(RULES));
ck('the writer now WRITES sellerId',
   SALE_DOC.indexOf('sellerId:        _sanitize(merchantId)') > -1,
   'before this the disjunct was dead and an owner could not read their own sales');
ck('CONTROL it is written AFTER caller metadata',
   (function () {
     const m = SALE_DOC.indexOf('...metadata');
     const s = SALE_DOC.indexOf('sellerId:');
     return m > -1 && s > m;
   })(),
   'a caller-supplied authorisation key is worse than a dead rule');
ck('CONTROL it derives from merchantId, not from the request body',
   SALE_DOC.indexOf('sellerId:        _sanitize(merchantId)') > -1 &&
   SALE_DOC.indexOf('sellerId:        _sanitize(data.sellerId') === -1);

/* ── 2 · identity provenance ──────────────────────────────────────────────── */
head('2 · identity comes from the token, not the payload');
ck('cashierId is the AUTHENTICATED uid',
   ZF.indexOf('const cashierId = await _assertAuth(auth);') > -1 &&
   /return auth\.uid;/.test(ZF),
   'not a client field — a caller cannot sell as someone else');
ck('merchantId is validated against the actor',
   ZF.indexOf('_actor = await resolveActor(cashierId, merchantId);') > -1,
   'a caller cannot sell for a shop they do not belong to');
ck('servedBy is resolved from employment records',
   ZF.indexOf('servedBy: (_actor && _actor.ok && _actor.servedBy)') > -1);
/* Scoped by offset rather than a fixed regex window — the block carries a long comment
   about employeeNo, so a 400-character window ended before the `: null` it was looking for
   and failed correct code. */
ck('CONTROL servedBy is NULL rather than guessed when unresolvable',
   (function () {
     const at = ZF.indexOf('servedBy: (_actor && _actor.ok && _actor.servedBy)');
     if (at === -1) return false;
     const block = ZF.slice(at, at + 1600);
     return block.indexOf('? {') > -1 && block.indexOf(': null') > -1;
   })(),
   'an unattributable sale must stay unattributed, never credited to the owner');
ck('CONTROL no identity field is read from metadata',
   SALE_DOC.indexOf('metadata.sellerId') === -1 &&
   SALE_DOC.indexOf('metadata.cashierId') === -1 &&
   SALE_DOC.indexOf('metadata.servedBy') === -1);

/* ── 3 · the two writers agree ────────────────────────────────────────────── */
head('3 · one collection, one shape');
const mirrored = MAP.mapTxnToRetail({ sellerId: 'SHOP_1', cashierId: 'CASH_1', total: 500 }, 'S1');
ck('the mirror writes sellerId', mirrored.sellerId === 'SHOP_1');
ck('...and merchantId with the same value', mirrored.merchantId === 'SHOP_1',
   'the convention this fix adopts, rather than inventing a third spelling');
ck('CONTROL the mirror does not invent a cashierUid', mirrored.cashierUid === undefined,
   'no writer produces it — see the unproven section');
ck('CONTROL a txn with no merchant yields null, not a guess',
   MAP.mapTxnToRetail({ total: 10 }, 'S2').sellerId === null);

/* ── 4 · what a client still cannot do ────────────────────────────────────── */
head('4 · the negatives that matter');
ck('NEGATIVE a caller cannot choose the seller identity',
   SALE_DOC.indexOf('sellerId:') > SALE_DOC.indexOf('...metadata'),
   'the authoritative write lands after the caller spread');
ck('NEGATIVE a caller cannot choose the cashier identity',
   SALE_DOC.indexOf('cashierId:       _sanitize(cashierId)') > SALE_DOC.indexOf('...metadata'),
   'and cashierId is auth.uid regardless');
ck('NEGATIVE writes remain Cloud-Functions only',
   /match \/posRetailSales\/\{saleId\}[\s\S]{0,220}allow write: if false;/.test(RULES),
   'no client writes this collection at all');

/* ── 5 · the shift is server-derived ──────────────────────────────────────── */
head('5 · a caller cannot choose the shift');
/* Scoped to the derivation block. A whole-file search would be satisfied by openShift's
   own query living in another module, or by this file's explanatory comment. */
const DERIVE = (function () {
  const a = ZF.indexOf('let resolvedShiftId = null;');
  if (a === -1) return '';
  return ZF.slice(a, ZF.indexOf('/* ── 5. Write sale record ── */', a));
})();
ck('the derivation block was located', DERIVE.length > 300, DERIVE.length + ' chars');
ck('the sale records the DERIVED shift',
   SALE_DOC.indexOf('shiftId:         resolvedShiftId') > -1);
ck('NEGATIVE the request value is never written',
   SALE_DOC.indexOf('_sanitize(shiftId)') === -1 &&
   SALE_DOC.indexOf('shiftId ? ') === -1,
   'the caller claim reaches the document by no path');
ck('NEGATIVE a caller cannot reach another employee shift',
   DERIVE.indexOf("where('cashierUid', '==', cashierId)") > -1,
   'cashierId is auth.uid — the query cannot address anyone else');
ck('NEGATIVE a caller cannot reach another shop shift',
   DERIVE.indexOf("where('sellerId', '==', merchantId)") > -1,
   'merchantId is refused by resolveActor when !_actor.ok');
ck('NEGATIVE a closed shift cannot be attached',
   DERIVE.indexOf("where('status', '==', 'open')") > -1);
ck('NEGATIVE no shift is fabricated when none is open',
   DERIVE.indexOf('_shiftSnap.empty ? null :') > -1,
   'selling without an open shift is legitimate; inventing an id is not');
ck('CONTROL a lookup failure records null, it does not fail a paid sale',
   DERIVE.indexOf('catch') > -1 && DERIVE.indexOf('resolvedShiftId = null;') > -1);
ck('CONTROL a mismatched claim is logged as a security signal',
   DERIVE.indexOf('client shiftId ignored') > -1,
   'the caller naming a shift that is not theirs is worth seeing');
ck('CONTROL no second shift authority is introduced',
   DERIVE.indexOf("collection('posShifts')") > -1 &&
   DERIVE.indexOf('shiftSessions') === -1,
   'posShifts is what openShift/getCurrentShift already use — see EMPLOYEE_AUTHORITY_MAP');
un('a cashier can read their own sales',
   'the rule names cashierUid; no writer produces it — needs a field or a rule decision');
un('the derived shift is correct against a real open shift',
   'needs the deployed function, a real posShifts record and a real sale');
un('a real owner read succeeds against production',
   'needs the deployed function and a real sale — the rule is proven by inspection only');

console.log(NL + '  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
console.log('  NOTE: attribution + read-key contract. The Sales UI is a separate slice.');
process.exit(fail ? 1 : 0);
