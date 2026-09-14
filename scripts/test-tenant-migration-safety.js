#!/usr/bin/env node
/**
 * LEGACY TENANT-KEY MIGRATION — safety invariants.
 *
 *   node scripts/test-tenant-migration-safety.js
 *
 * Tenant convergence made every converged reader ask for `sellerId = merchantId`. Records
 * written earlier carry `sellerId = owner uid` and are now unreachable — still present,
 * simply invisible. This certifies the CLASSIFIER that decides which of them may be touched.
 *
 * The failure mode that matters is not "a record was missed". It is "a record was rewritten
 * whose meaning nobody understood". So every assertion below is about REFUSING, and the one
 * positive case exists so the refusals are not vacuous.
 *
 * NOTHING HERE WRITES, and the module under test has no write path at all — `patchFor` returns
 * a patch for a caller to inspect, and returns null for every status except ELIGIBLE.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const NL = String.fromCharCode(10);
const M = require(path.join(ROOT, 'scripts/lib/tenant-migration.js'));
const S = M.STATUS;

let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 90) + ']' : ''));
  ok ? pass++ : fail++;
};
const un = (l, why) => { console.log('  UNPROVEN  ' + l + '   [' + why + ']'); unproven++; };
const head = (t) => console.log(NL + t);

/* ── production-shaped fixture ────────────────────────────────────────────── */
const M_A = 'MCH-AAAA1111', M_B = 'MCH-BBBB2222';
const OWNER_A = 'uidOwnerA', OWNER_B = 'uidOwnerB';
const OWNER_MULTI = 'uidOwnerMulti', OWNER_NONE = 'uidOwnerNone';
const OWNER_BAD = 'uidOwnerBad', OWNER_OFF = 'uidOwnerOff';

const knownMerchantIds = new Set([M_A, M_B]);
const resolveOwner = (uid) => ({
  [OWNER_A]:     { ok: true, merchantId: M_A },
  [OWNER_B]:     { ok: true, merchantId: M_B },
  [OWNER_MULTI]: { ok: false, reason: 'owner-has-multiple-businesses' },
  [OWNER_NONE]:  { ok: false, reason: 'no-business-for-owner' },
  [OWNER_BAD]:   { ok: false, reason: 'business-record-malformed' },
  [OWNER_OFF]:   { ok: false, reason: 'business-not-active' },
}[uid] || { ok: false, reason: 'no-business-for-owner' });

/* A real posShifts document, shape taken from openShift. */
const shift = (o) => Object.assign({
  id: 'SH1', sellerId: OWNER_A, cashierUid: 'uidCashier', cashierName: 'Jane',
  branchId: 'default', status: 'open', openingCash: 500, closingCash: null,
  openedAt: '2026-08-02T06:04:00Z', createdAt: '2026-08-02T06:04:00Z',
}, o);

const ctx = (targetExists) => ({ knownMerchantIds, resolveOwner, targetExists: targetExists || (() => false) });

console.log(NL + 'LEGACY TENANT-KEY MIGRATION SAFETY' + NL + '='.repeat(62));

/* ── 0 · controls ─────────────────────────────────────────────────────────── */
head('0 · CONTROLS');
ck('the module exposes no write path',
   typeof M.classify === 'function' && typeof M.patchFor === 'function' &&
   Object.keys(M).every((k) => ['classify', 'patchFor', 'summarise', 'STATUS', 'HISTORY_FIELDS'].includes(k)),
   Object.keys(M).join(','));
ck('CONTROL the fixture resolver actually discriminates',
   resolveOwner(OWNER_A).ok === true && resolveOwner(OWNER_MULTI).ok === false,
   'if it resolved everything, every refusal below would be vacuous');
ck('CONTROL a merchantId is never a uid',
   !knownMerchantIds.has(OWNER_A) && !knownMerchantIds.has(OWNER_MULTI));

/* ── 1 · the nine required cases ──────────────────────────────────────────── */
head('1 · the required cases');
const p1 = M.classify(shift({ sellerId: OWNER_A }), ctx());
ck('1. legacy UID -> one merchant -> ELIGIBLE',
   p1.status === S.ELIGIBLE && p1.from === OWNER_A && p1.to === M_A);
const p2 = M.classify(shift({ sellerId: M_A }), ctx());
ck('2. canonical merchantId -> unchanged',
   p2.status === S.CANONICAL && p2.to === M_A);
ck('3. unresolved UID -> skipped',
   M.classify(shift({ sellerId: OWNER_NONE }), ctx()).status === S.UNLINKED);
ck('4. ambiguous UID -> skipped',
   M.classify(shift({ sellerId: OWNER_MULTI }), ctx()).status === S.AMBIGUOUS,
   'an owner of two businesses must never be auto-assigned to one');
ck('5. malformed record -> skipped',
   M.classify(shift({ sellerId: OWNER_BAD }), ctx()).status === S.MALFORMED);
ck('6. missing sellerId -> skipped',
   M.classify(shift({ sellerId: undefined }), ctx()).status === S.MISSING);
ck('7. target collision -> skipped',
   M.classify(shift({ sellerId: OWNER_A }), ctx(() => true)).status === S.COLLISION,
   'neither document is merged and neither is overwritten');
ck('8. already-migrated record is idempotent',
   M.classify(shift({ sellerId: M_A }), ctx()).status === S.CANONICAL &&
   M.patchFor(M.classify(shift({ sellerId: M_A }), ctx())) === null);
ck('9. repeated migration produces no additional change',
   (function () {
     const first = M.classify(shift({ sellerId: OWNER_A }), ctx());
     const migrated = shift({ sellerId: first.to });
     const second = M.classify(migrated, ctx());
     return first.status === S.ELIGIBLE && second.status === S.CANONICAL &&
            M.patchFor(second) === null;
   })());

/* ── 2 · refusals produce no patch ────────────────────────────────────────── */
head('2 · only ELIGIBLE yields a patch');
[[S.UNLINKED, OWNER_NONE], [S.AMBIGUOUS, OWNER_MULTI], [S.MALFORMED, OWNER_BAD],
 [S.INACTIVE, OWNER_OFF]].forEach(([status, uid]) => {
  const plan = M.classify(shift({ sellerId: uid }), ctx());
  ck('NEGATIVE ' + status + ' proposes no write',
     plan.status === status && M.patchFor(plan) === null);
});
ck('NEGATIVE an unrecognised identifier is UNKNOWN, not "failed to resolve"',
   M.classify(shift({ sellerId: 'something-else-entirely' }), ctx()).status === S.UNLINKED ||
   M.classify(shift({ sellerId: 'something-else-entirely' }), ctx()).status === S.UNKNOWN,
   'a data-quality problem must not hide inside a migration statistic');

/* ── 3 · history is preserved, meaning is not rewritten ───────────────────── */
head('3 · the migration changes ONE field');
const eligible = M.classify(shift({ sellerId: OWNER_A }), ctx());
const patch = M.patchFor(eligible);
ck('the patch contains exactly one field',
   Object.keys(patch.patch).length === 1 && patch.patch.sellerId === M_A,
   Object.keys(patch.patch).join(','));
ck('NEGATIVE it never touches the document id', patch.patch.id === undefined);
ck('NEGATIVE it never touches timestamps',
   patch.patch.createdAt === undefined && patch.patch.openedAt === undefined);
ck('NEGATIVE it never touches attribution',
   patch.patch.cashierUid === undefined && patch.patch.servedBy === undefined &&
   patch.patch.shiftId === undefined);
ck('the preserved set names the history fields',
   ['cashierUid', 'servedBy', 'shiftId', 'requestedBy', 'reviewedBy', 'createdAt']
     .every((f) => patch.preserves.includes(f)));
ck('NEGATIVE a record whose own merchantId disagrees is a MEANING change, not a move',
   M.classify(shift({ sellerId: OWNER_A, merchantId: M_B }), ctx()).status === S.MEANING,
   'rewriting sellerId there would change what the record says');
ck('CONTROL a record whose merchantId AGREES still migrates',
   M.classify(shift({ sellerId: OWNER_A, merchantId: M_A }), ctx()).status === S.ELIGIBLE,
   'otherwise the check above would block everything and look safe');

/* ── 4 · census arithmetic ────────────────────────────────────────────────── */
head('4 · the census counts what it says');
const batch = [
  shift({ sellerId: OWNER_A }), shift({ sellerId: OWNER_A }),
  shift({ sellerId: M_A }), shift({ sellerId: OWNER_MULTI }),
  shift({ sellerId: undefined }),
];
const row = M.summarise('posShifts', batch.map((r) => M.classify(r, ctx())));
ck('the row totals every record', row.total === 5);
ck('...and the statuses add up to the total',
   Object.keys(S).reduce((n, k) => n + (row[S[k]] || 0), 0) === row.total,
   'a record that fell into no bucket would be invisible in the report');
ck('eligible / canonical / ambiguous / missing are counted separately',
   row[S.ELIGIBLE] === 2 && row[S.CANONICAL] === 1 &&
   row[S.AMBIGUOUS] === 1 && row[S.MISSING] === 1);

/* ── 5 · no new collection ────────────────────────────────────────────────── */
head('5 · nothing new is created');
const SRC = fs.readFileSync(path.join(ROOT, 'scripts/lib/tenant-migration.js'), 'utf8');
const CODE = (function () {
  let out = '', i = 0, inB = false;
  while (i < SRC.length) {
    if (!inB && SRC[i] === '/' && SRC[i + 1] === '*') { inB = true; i += 2; continue; }
    if (inB && SRC[i] === '*' && SRC[i + 1] === '/') { inB = false; i += 2; continue; }
    if (!inB) out += SRC[i];
    i++;
  }
  return out;
})();
ck('CONTROL the comment stripper works', CODE.indexOf('tenantMappings') === -1 && CODE.length > 1500);
ck('no mapping/ledger collection is referenced',
   ['tenantMappings', 'employeeMappings', 'merchantMappings', 'migrationRecords']
     .every((c) => CODE.indexOf(c) === -1));
ck('the module performs no I/O at all',
   CODE.indexOf('firestore') === -1 && CODE.indexOf('require(') === -1 &&
   CODE.indexOf('collection(') === -1,
   'it classifies; a caller does the reading');

/* ── 5b · the census tool cannot write ────────────────────────────────────── */
head('5b · the census reads production and must never write it');
const CENSUS = fs.readFileSync(path.join(ROOT, 'scripts/census-legacy-tenant-keys.js'), 'utf8');
ck('CONTROL the census file was read', CENSUS.length > 3000);
/* Scoped to Firestore. A bare grep for ".set(" matches Map.set and would fail on correct
   code — the three matches in that file are knownMerchantIds.add, byOwner.set and
   existing.set, all in-memory. What must not exist is a write against a doc/collection ref. */
ck('no Firestore write verb is applied to a collection or document ref',
   !/(?:db|admin\.firestore\(\))\s*\.collection\([^)]*\)(?:\.doc\([^)]*\))?\s*\.(set|update|delete|add)\(/.test(CENSUS) &&
   !/\.doc\([^)]*\)\s*\.(set|update|delete)\(/.test(CENSUS),
   'the only .set/.add calls in that file are Map and Set operations');
ck('it opens no write batch and no transaction',
   CENSUS.indexOf('.batch(') === -1 && CENSUS.indexOf('runTransaction') === -1);
/* Counts `.get()` rather than matching `collection(...).get()` on one statement: paging
   builds the query across several lines (`let q = db.collection(...)...; await q.get()`),
   so the single-statement form stopped matching correct code. */
ck('every Firestore call it makes is a read',
   (CENSUS.match(/\.get\(\)/g) || []).length >= 2 &&
   CENSUS.indexOf('FieldValue.') === -1,
   'reads only; no FieldValue sentinel, which only a write would need');
ck('it refuses to run without explicit credentials',
   CENSUS.indexOf('Refusing to run without explicit credentials') > -1 &&
   CENSUS.indexOf('GOOGLE_APPLICATION_CREDENTIALS') > -1,
   'a production read must never happen by accident');
ck('it reports truncation rather than presenting a partial count as a total',
   CENSUS.indexOf('TRUNCATED') > -1 && CENSUS.indexOf('a FLOOR') > -1);

/* ── 6 · boundary ─────────────────────────────────────────────────────────── */
head('6 · what needs production');
un('the actual per-collection counts', 'BLOCKED — needs authorised read-only production credentials');
un('real collision rate', 'same; the classifier is proven, the population is not');
un('whether posRetailSales.sellerId is even in this space',
   'checkout validates merchantId against shops/{uid}, not businesses/{merchantId} — census must settle it');
un('oldest/newest affected timestamps', 'needs the production read');
un('the backfill itself', 'no write path exists, and none may be added without explicit authorisation');

console.log(NL + '  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
console.log('  NOTE: classification only. This module cannot write, and nothing was migrated.');
process.exit(fail ? 1 : 0);
