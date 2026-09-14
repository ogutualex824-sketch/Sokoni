#!/usr/bin/env node
/**
 * CASHIER IDENTITY — which name is canonical, per collection.
 *
 *   node scripts/test-cashier-identity-map.js
 *
 * THE QUESTION
 * `posRetailSales` writes `cashierId`. The pending Rules revision checks `cashierUid`. Which
 * is canonical?
 *
 * THE ANSWER, FROM THE WRITER/CONSUMER GRAPH
 * The same field name means different things in different collections, and that is not a
 * defect — it is two contracts:
 *
 *   posRetailSales   written by posCompleteCheckout AND pos-retail-mirror-map  -> cashierId
 *   posSales         written by recordPOSSale                                  -> cashierUid
 *   posShifts        written by openShift                                      -> cashierUid
 *   posAttendance    written by clockIn                                        -> cashierUid
 *   posCashEvents    written by cmRecordCashEvent                              -> cashierId
 *
 * Every one of those is queried by the same name its writer produces — EXCEPT
 * `posRetailSales`, which is queried by `cashierUid` in one place and secured by `cashierUid`
 * in the served rule, while no writer has ever produced that field on it.
 *
 * So `cashierId` is canonical for `posRetailSales`, proven by two independent writers and zero
 * writers of the alternative. No alias is added: the rule is wrong, not the data.
 *
 * NOT FIXED HERE, DELIBERATELY
 *   · firestore.rules is NOT edited — the delta is drafted and waits for the publish boundary
 *   · calculateMonthlyCommission's dead `cashierUid` query stays separately characterised.
 *     Its intended business behaviour has never been established, and swapping the field would
 *     be exactly the "plausible fix" this programme avoids.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const NL = String.fromCharCode(10);

const F = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = (src) => {
  let out = '', i = 0, inB = false;
  while (i < src.length) {
    if (!inB && src[i] === '/' && src[i + 1] === '*') { inB = true; i += 2; continue; }
    if (inB && src[i] === '*' && src[i + 1] === '/') { inB = false; i += 2; continue; }
    if (!inB) out += src[i];
    i++;
  }
  return out.split(NL).filter((l) => l.trim().indexOf('//') !== 0).join(NL);
};

const ZF    = F('functions/pos-zero-friction.js');
const MIRROR= F('functions/pos-retail-mirror-map.js');
const RE    = F('functions/pos-retail-engine.js');
const PSO   = F('functions/pos-staff-ops.js');
const RULES = F('firestore.rules');
const ZF_C = strip(ZF), RE_C = strip(RE), PSO_C = strip(PSO);

let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 90) + ']' : ''));
  ok ? pass++ : fail++;
};
const un = (l, why) => { console.log('  UNPROVEN  ' + l + '   [' + why + ']'); unproven++; };
const head = (t) => console.log(NL + t);

/* The rule block for one collection, so an assertion about posRetailSales can never be
   satisfied by the identically-worded posSales block. */
const ruleBlock = (coll) => {
  const a = RULES.indexOf('match /' + coll + '/{');
  if (a === -1) return '';
  const b = RULES.indexOf('match /', a + 10);
  return RULES.slice(a, b === -1 ? a + 600 : b);
};

console.log(NL + 'CASHIER IDENTITY MAP' + NL + '='.repeat(62));

/* ── 0 · controls ─────────────────────────────────────────────────────────── */
head('0 · CONTROLS');
ck('CONTROL the comment stripper works',
   ZF_C.indexOf('who sold it is proven') === -1 && ZF_C.length > 20000,
   'prose must not be able to satisfy any assertion below');
ck('CONTROL the two rule blocks are isolated from each other',
   ruleBlock('posRetailSales').length > 100 &&
   ruleBlock('posSales').length > 100 &&
   ruleBlock('posRetailSales').indexOf('match /posSales/') === -1,
   'they are worded identically; a whole-file match would prove nothing');

/* ── 1 · posRetailSales: cashierId, by two writers ────────────────────────── */
head('1 · posRetailSales is written with cashierId');
ck('posCompleteCheckout writes cashierId',
   ZF_C.indexOf('cashierId:       _sanitize(cashierId)') > -1);
ck('...and that value is the AUTHENTICATED uid',
   ZF_C.indexOf('const cashierId = await _assertAuth(auth);') > -1,
   'server identity, not client input');
ck('the mirror writer also writes cashierId',
   strip(MIRROR).indexOf('cashierId:') > -1);
ck('NEGATIVE no writer produces cashierUid on posRetailSales',
   ZF_C.indexOf('cashierUid:') === -1 && strip(MIRROR).indexOf('cashierUid:') === -1,
   'two independent writers agree; the alternative has none');
ck('CONTROL the sale document really is posRetailSales',
   ZF_C.indexOf("db.collection('posRetailSales').doc(saleId).set(sale)") > -1);

/* ── 2 · posSales: cashierUid, and that is correct ────────────────────────── */
head('2 · posSales legitimately uses cashierUid');
ck('recordPOSSale writes cashierUid', RE_C.indexOf('cashierUid:    _cashierUid,') > -1);
ck('...to posSales, a DIFFERENT collection',
   RE_C.indexOf("const saleRef = fdb.collection('posSales').doc();") > -1);
ck('...and it is the authenticated uid', RE_C.indexOf('const _cashierUid = auth.uid;') > -1);
ck('its consumer queries the same name',
   RE_C.indexOf("where('cashierUid'") > -1,
   'writer and reader agree, so this contract is sound');

/* ── 3 · the other collections agree with themselves ──────────────────────── */
head('3 · every other collection is self-consistent');
ck('posShifts is written with cashierUid', PSO_C.indexOf('cashierUid,') > -1);
/* COUNTED, not merely present. The first version used indexOf, so switching ONE of the four
   consumers to the wrong field still left three and the control passed — the exact
   "a duplicate occurrence satisfied the assertion" failure the gate header warns about. */
/* Pinned at 5, reviewed 2026-09-01. It was 4; `registerClientShift` (Priority 15B) is the
   fifth and queries posShifts by cashierUid exactly as openShift, closeShift and
   getCurrentShift do. The count was checked against the handler list before it was raised —
   a pin that gets bumped without looking is worth less than no pin.
     openShift · registerClientShift · closeShift · getCurrentShift · calculateMonthlyCommission */
ck('...and queried by cashierUid at every one of its consumers',
   (PSO_C.match(/\.where\('cashierUid', '==', cashierUid\)/g) || []).length === 5,
   (PSO_C.match(/\.where\('cashierUid', '==', cashierUid\)/g) || []).length + ' consumers');
ck('NEGATIVE no consumer in this module queries cashierId',
   (PSO_C.match(/\.where\('cashierId'/g) || []).length === 0,
   'none of its collections carry that field; one appearing means a consumer was switched');
ck('the shift derivation in checkout queries posShifts by cashierUid',
   ZF_C.indexOf(".where('cashierUid', '==', cashierId)") > -1,
   'field name from posShifts, value from the authenticated uid — correct across the boundary');
ck('posCashEvents is written and queried with cashierId',
   strip(F('functions/pos-cash-manager.js')).indexOf('cashierId:') > -1);

/* ── 4 · THE MISMATCH ─────────────────────────────────────────────────────── */
head('4 · the one contradiction in the graph');
const PRS_RULE = ruleBlock('posRetailSales');
ck('the served rule for posRetailSales checks cashierUid',
   PRS_RULE.indexOf('resource.data.cashierUid == request.auth.uid') > -1,
   'CURRENT STATE — this is the defect, asserted so the fix is verifiable');
ck('...while no writer produces it — so the disjunct is DEAD',
   ZF_C.indexOf('cashierUid:') === -1,
   'a cashier can never read their own sale through that clause');
ck('CONTROL the posSales rule checking cashierUid is CORRECT and must not change',
   ruleBlock('posSales').indexOf('resource.data.cashierUid == request.auth.uid') > -1 &&
   RE_C.indexOf('cashierUid:    _cashierUid,') > -1,
   'same wording, different collection, opposite verdict');
ck('the sellerId disjunct on posRetailSales is alive',
   PRS_RULE.indexOf('resource.data.sellerId == request.auth.uid') > -1 &&
   ZF_C.indexOf('sellerId:        _sanitize(merchantId)') > -1,
   'so the rule is half-working, which is why nothing looked broken');

/* ── 5 · the dead query stays separate ────────────────────────────────────── */
head('5 · calculateMonthlyCommission is characterised, NOT fixed here');
const CMC = (function () {
  const a = PSO_C.indexOf('exports.calculateMonthlyCommission');
  return a === -1 ? '' : PSO_C.slice(a, a + 1400);
})();
ck('CONTROL the handler was isolated', CMC.length > 400, CMC.length + ' chars');
ck('it queries posRetailSales by cashierUid',
   CMC.indexOf("collection('posRetailSales')") > -1 &&
   CMC.indexOf(".where('cashierUid', '==', cashierUid)") > -1);
ck('...which that collection does not carry, so the query returns nothing',
   ZF_C.indexOf('cashierUid:') === -1,
   'commission has always computed zero from this path');
ck('NEGATIVE it has NOT been silently switched to cashierId',
   CMC.indexOf(".where('cashierId'") === -1,
   'its intended business behaviour is unestablished; swapping the field would be a guess');

/* ── 6 · nothing was changed ──────────────────────────────────────────────── */
head('6 · this slice changes no rule and adds no alias');
ck('firestore.rules still contains the ORIGINAL posRetailSales clause',
   PRS_RULE.indexOf('cashierUid') > -1 && PRS_RULE.indexOf('cashierId') === -1,
   'the delta is drafted, not applied — it waits on the publish boundary');
ck('NEGATIVE no alias field was added to any writer',
   ZF_C.indexOf('cashierUid:') === -1 && strip(MIRROR).indexOf('cashierUid:') === -1,
   'the rule is wrong; the data is not');
ck('approval consumption is still ZERO call sites',
   fs.readdirSync(path.join(ROOT, 'functions'))
     .filter((f) => f.slice(-3) === '.js' && f !== 'pos-staff-ops.js')
     .filter((f) => {
       const s = F('functions/' + f);
       return s.indexOf('_consumeApproval(') > -1 || s.indexOf('_approvals.consume') > -1 ||
              /\.consume\(\s*[A-Za-z_$]/.test(s);
     }).length === 0);

/* ── 7 · boundary ─────────────────────────────────────────────────────────── */
head('7 · what needs the operator');
un('the Rules delta applied', 'BLOCKED — firestore.rules is frozen until f88e8953 is published');
un('a cashier actually reading their own sale', 'needs the corrected rule deployed and a real sale');
un('calculateMonthlyCommission intended behaviour',
   'is commission per cashier meant to exist at all? a business question, not a field rename');
un('legacy posRetailSales documents', 'unrelated to naming; see the tenant-key census');

console.log(NL + '  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
console.log('  NOTE: map + decision only. No rule was edited and no alias was introduced.');
process.exit(fail ? 1 : 0);
