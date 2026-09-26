/* test-creator-royalty.js — the Creator Hub royalty arithmetic, proven pure.
 *
 * WHAT THESE PROVE
 *   - agreement invariants: integer bps, > 0, ≤ 10000, Σ ≤ 10000, Σ = 10000 to lock,
 *     no duplicate participant / uid+role, registered uid required
 *   - versioning: a lock is never back-dated; the governing version is selected by time
 *   - pool: Creator policy 30/70 of NET (gross − fee − tax), examples A–C, rounding, no bare rate
 *   - allocation: Σ shares == pool EXACTLY for 2,000 random cases (largest remainder)
 *   - ids: deterministic, one per (payment, version, participant); unsafe refs refused
 *   - periods: EAT quarter boundaries; no calculation before period end; distinct approver
 *   - release: whole shillings only, remainder and reversal debt carried, never negative
 *   - reversal: partial refunds converge on, and never exceed, the recognised amount
 *   - purity: the module performs no I/O and reads no clock
 *
 *   node scripts/test-creator-royalty.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const R = require(path.join(__dirname, '..', 'functions', 'shared', 'creator-royalty'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 90) + ']' : '')); ok ? pass++ : fail++; };
const code = (fn) => { try { fn(); return null; } catch (e) { return e.code || e.message; } };

const P = (participantId, participantType, uid, bps) => ({ participantId, participantType, uid, bps });
const FIVE = [
  P('producer', 'producer', 'uProd', 4000), P('actorA', 'actor', 'uA', 2000),
  P('actorB', 'actor', 'uB', 1500), P('director', 'director', 'uDir', 1000),
  P('publisher', 'publisher', 'uPub', 1500),
];

console.log('\n── agreement invariants ──');
{
  const v = R.validateAgreement(FIVE, { requireFull: true });
  ck('five-party 100% agreement accepted (POSITIVE CONTROL)', v.ok && v.totalBps === 10000, v.errors.join(';'));
  ck('partial (≤100%) accepted as a draft', R.validateAgreement([P('a', 'creator', 'u1', 6000)]).ok);
  ck('partial refused when full allocation required', !R.validateAgreement([P('a', 'creator', 'u1', 6000)], { requireFull: true }).ok);
  ck('negative share refused', !R.validateAgreement([P('a', 'creator', 'u1', -100)]).ok);
  ck('zero share refused', !R.validateAgreement([P('a', 'creator', 'u1', 0)]).ok);
  ck('> 100% single share refused', !R.validateAgreement([P('a', 'creator', 'u1', 10001)]).ok);
  ck('Σ > 100% refused', !R.validateAgreement([P('a', 'creator', 'u1', 6000), P('b', 'actor', 'u2', 4001)]).ok);
  ck('fractional bps refused (no floats)', !R.validateAgreement([P('a', 'creator', 'u1', 5000.5)]).ok);
  ck('percentage-as-string refused', !R.validateAgreement([P('a', 'creator', 'u1', '5000')]).ok);
  ck('duplicate participantId refused', !R.validateAgreement([P('a', 'creator', 'u1', 5000), P('a', 'actor', 'u2', 5000)]).ok);
  ck('same uid SAME role refused (duplicate allocation)', !R.validateAgreement([P('a', 'actor', 'u1', 5000), P('b', 'actor', 'u1', 5000)]).ok);
  ck('same uid DIFFERENT roles allowed (explicitly modelled)', R.validateAgreement([P('a', 'producer', 'u1', 5000), P('b', 'actor', 'u1', 5000)], { requireFull: true }).ok);
  ck('unknown role refused', !R.validateAgreement([P('a', 'king', 'u1', 10000)]).ok);
  ck('missing uid refused (unpayable participant)', !R.validateAgreement([P('a', 'creator', '', 10000)]).ok);
  ck('uid with path separator refused', !R.validateAgreement([P('a', 'creator', 'u/1', 10000)]).ok);
  ck('empty list refused', !R.validateAgreement([]).ok);
  ck('> 50 participants refused', !R.validateAgreement(Array.from({ length: 51 }, (_, i) => P('p' + i, 'other', 'u' + i, 1))).ok);
}

console.log('\n── versioning & lock ──');
{
  const T0 = Date.UTC(2026, 6, 1);
  const v1 = { version: 1, status: 'DRAFT', participants: FIVE };
  const p1 = R.planLock([v1], 1, T0);
  ck('v1 locks at now', p1.lock.status === 'LOCKED' && p1.lock.effectiveFrom === T0 && p1.supersede === null);
  const locked1 = { ...v1, ...p1.lock };
  const v2 = { version: 2, status: 'DRAFT', participants: [P('producer', 'producer', 'uProd', 10000)] };
  const p2 = R.planLock([locked1, v2], 2, T0 + 5000);
  ck('v2 lock supersedes v1 at its effectiveFrom', p2.supersede && p2.supersede.version === 1 && p2.supersede.effectiveUntil === T0 + 5000);
  const locked2 = { ...v2, ...p2.lock };
  const sup1 = { ...locked1, ...p2.supersede };
  ck('revenue before v2 governed by v1', R.selectVersionAt([sup1, locked2], T0 + 10).version === 1);
  ck('revenue after v2 governed by v2', R.selectVersionAt([sup1, locked2], T0 + 6000).version === 2);
  ck('revenue before any lock → no version (refusal)', R.selectVersionAt([sup1, locked2], T0 - 1) === null);
  ck('locking a LOCKED version refused (immutable)', code(() => R.planLock([locked1], 1, T0 + 9)) === 'version_not_draft');
  ck('locking a partial draft refused', code(() => R.planLock([{ version: 3, status: 'DRAFT', participants: [P('a', 'creator', 'u', 10)] }], 3, T0)) === 'agreement_invalid');
  const back = R.planLock([locked1, { version: 2, status: 'DRAFT', participants: FIVE }], 2, T0 - 99999);
  ck('a lock is never back-dated before the current version', back.lock.effectiveFrom > locked1.effectiveFrom);
  ck('overlapping versions → no version (refusal, not a guess)', R.selectVersionAt([locked1, { ...locked2, effectiveFrom: T0 }], T0 + 10) === null);
}

console.log('\n── pool: Creator 30 / 70 of NET (owner policy 2026-09-26) ──');
{
  const C = require(path.join(__dirname, '..', 'functions', 'shared', 'creator-commercial'));
  const POL = C.CREATOR_PPV;
  ck('policy: SOKONI 3000 + pool 7000 == 10000 bps', POL.sokoniCommissionBps === 3000 && POL.creatorPoolBps === 7000 && POL.sokoniCommissionBps + POL.creatorPoolBps === 10000);
  ck('policy basis is NET of provider fee (not gross)', POL.basis === 'NET_OF_PROVIDER_FEE');
  ck('policy object is frozen (no runtime mutation)', Object.isFrozen(POL));
  ck('a policy not summing to 10000 is refused', code(() => C.assertPolicy({ ...POL, creatorPoolBps: 6999 })) === 'policy_invalid');
  const A = R.computePool({ grossCents: 50000, providerFeeCents: 2000, policy: POL });
  ck('Example A: 500 − 20 = 480 → SOKONI 144, pool 336', A.netCents === 48000 && A.commissionCents === 14400 && A.poolCents === 33600, JSON.stringify(A));
  const B = R.computePool({ grossCents: 100000, providerFeeCents: 3000, policy: POL });
  ck('Example B: 1000 − 30 = 970 → SOKONI 291, pool 679', B.netCents === 97000 && B.commissionCents === 29100 && B.poolCents === 67900, JSON.stringify(B));
  ck('Example C: fee missing → NOT finalized (fee_indeterminate), never 0', code(() => R.computePool({ grossCents: 50000, providerFeeCents: undefined, policy: POL })) === 'fee_indeterminate');
  ck('Example C: fee null → NOT finalized', code(() => R.computePool({ grossCents: 50000, providerFeeCents: null, policy: POL })) === 'fee_indeterminate');
  ck('NOT 70% of gross: pool on 500 gross / 20 fee is 336, not 350', A.poolCents !== 35000);
  ck('commission + pool == net exactly', A.commissionCents + A.poolCents === A.netCents && B.commissionCents + B.poolCents === B.netCents);
  const odd = R.computePool({ grossCents: 101, providerFeeCents: 0, policy: POL });
  ck('minimum unit: 101c → SOKONI 30c (floored), pool 71c', odd.commissionCents === 30 && odd.poolCents === 71);
  const one = R.computePool({ grossCents: 1, providerFeeCents: 0, policy: POL });
  ck('1 cent → SOKONI 0c, pool 1c (sub-cent stays with creators)', one.commissionCents === 0 && one.poolCents === 1);
  let bad = 0, n = 0;
  for (let g = 1; g <= 5000; g += 7) for (const fee of [0, 1, 3, Math.floor(g / 3)]) {
    if (fee > g) continue;
    n++;
    const r = R.computePool({ grossCents: g, providerFeeCents: fee, policy: POL });
    const exact10k = (g - fee) * 3000;             /* compare in integer bps-cents, no floats */
    if (r.commissionCents + r.poolCents !== g - fee || r.commissionCents * 10000 > exact10k || exact10k - r.commissionCents * 10000 >= 10000 || r.poolCents < 0) bad++;
  }
  ck(n + ' sales: split exact, SOKONI never over 30%, never ≥1c under', bad === 0, bad + ' bad');
  ck('fee = gross → net 0, both shares 0', (() => { const z = R.computePool({ grossCents: 500, providerFeeCents: 500, policy: POL }); return z.netCents === 0 && z.commissionCents === 0 && z.poolCents === 0; })());
  ck('fee > gross refused', code(() => R.computePool({ grossCents: 100, providerFeeCents: 101, policy: POL })) === 'deductions_exceed_gross');
  ck('fractional cents refused', code(() => R.computePool({ grossCents: 100.5, providerFeeCents: 0, policy: POL })) === 'amount_invalid');
  ck('no policy → refused (no caller can pass a bare rate)', code(() => R.computePool({ grossCents: 100, providerFeeCents: 0, commissionBps: 1500 })) === 'policy_invalid');
  ck('forged policy 1500/8500 on a gross basis refused', code(() => R.computePool({ grossCents: 100, providerFeeCents: 0, policy: { sokoniCommissionBps: 1500, creatorPoolBps: 8500, basis: 'GROSS' } })) === 'policy_invalid');
  ck('Example A pool 336 across the five-party split sums to 336', R.allocate(A.poolCents, FIVE).reduce((t, r) => t + r.amountCents, 0) === 33600);
  const pr = R.allocate(70000, FIVE); const by = Object.fromEntries(pr.map((r) => [r.participantId, r.amountCents]));
  ck('pool 700: producer 280 · A 140 · B 105 · director 70 · publisher 105', by.producer === 28000 && by.actorA === 14000 && by.actorB === 10500 && by.director === 7000 && by.publisher === 10500);
  ck('zero-share participant refused', !R.validateAgreement([P('a', 'creator', 'u1', 10000), P('z', 'actor', 'u2', 0)]).ok);
  ck('half-up helper still exact for bps math', R.applyBps(1, 5000) === 1 && R.applyBps(1, 4999) === 0);
}

console.log('\n── allocation (I3) ──');
{
  const a = R.allocate(41000, FIVE);
  const by = Object.fromEntries(a.map((r) => [r.participantId, r.amountCents]));
  ck('producer 40% of 41000 = 16400', by.producer === 16400);
  ck('Σ == pool', a.reduce((s, r) => s + r.amountCents, 0) === 41000);
  const odd = R.allocate(101, [P('x', 'creator', 'u1', 3333), P('y', 'actor', 'u2', 3333), P('z', 'actor', 'u3', 3334)]);
  ck('101c over thirds sums exactly', odd.reduce((s, r) => s + r.amountCents, 0) === 101, JSON.stringify(odd.map((r) => r.amountCents)));
  ck('allocation deterministic', JSON.stringify(R.allocate(101, [P('x', 'creator', 'u1', 3333), P('y', 'actor', 'u2', 3333), P('z', 'actor', 'u3', 3334)])) === JSON.stringify(odd));
  ck('under-allocated agreement refused for accrual', code(() => R.allocate(1000, [P('a', 'creator', 'u', 9000)])) === 'agreement_invalid');
  let bad = 0; let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let i = 0; i < 2000; i++) {
    const n = 1 + rnd(12); let left = 10000; const ps = [];
    for (let k = 0; k < n; k++) { const b = k === n - 1 ? left : 1 + rnd(Math.max(1, left - (n - k - 1))); ps.push(P('p' + k, 'other', 'u' + k, b)); left -= b; }
    if (ps.some((p) => p.bps <= 0)) continue;
    const pool = rnd(15000001);
    const out = R.allocate(pool, ps);
    const s = out.reduce((t, r) => t + r.amountCents, 0);
    if (s !== pool || out.some((r) => r.amountCents < 0 || !Number.isSafeInteger(r.amountCents))) bad++;
  }
  ck('2,000 random agreements: Σ allocated == pool, all integer ≥ 0', bad === 0, bad + ' bad');
}

console.log('\n── deterministic identities (I4) ──');
{
  ck('earn id = payment + version + participant', R.earnEntryId('SKNab12', 2, 'actorA') === 'earn_SKNab12_v2_actorA');
  ck('same inputs → same id (replay collides)', R.earnEntryId('X1', 1, 'p') === R.earnEntryId('X1', 1, 'p'));
  ck('different version → different id', R.earnEntryId('X1', 1, 'p') !== R.earnEntryId('X1', 2, 'p'));
  ck('ref with "/" refused (no path injection)', code(() => R.accrualId('a/b')) === 'ref_invalid');
  ck('version 0 refused', code(() => R.earnEntryId('X', 0, 'p')) === 'version_invalid');
  ck('wallet tx id mirrors ${uid}_${source}_${kind}', R.walletTxId('u1', '2026-Q3') === 'u1_2026-Q3_royalty');
}

console.log('\n── periods ──');
{
  const julyEAT = Date.UTC(2026, 5, 30, 21, 30); /* 00:30 EAT 1 July */
  ck('00:30 EAT 1 July is Q3', R.periodFor(julyEAT).periodId === '2026-Q3');
  ck('23:59 EAT 30 June is Q2', R.periodFor(Date.UTC(2026, 5, 30, 20, 59)).periodId === '2026-Q2');
  const b = R.periodBounds('2026-Q4');
  ck('Q4 ends at 00:00 EAT 1 Jan', b.endMs === Date.UTC(2027, 0, 1) - R.EAT_OFFSET_MS);
  ck('next of Q4 is next year Q1', R.nextPeriodId('2026-Q4') === '2027-Q1');
  ck('prev of Q1 is last year Q4', R.prevPeriodId('2026-Q1') === '2025-Q4');
  ck('bad period id refused', code(() => R.parsePeriodId('2026-Q5')) === 'period_invalid');
  ck('cannot calculate before period end', code(() => R.assertPeriodTransition('OPEN', 'CALCULATED', { nowMs: b.endMs - 1, endMs: b.endMs })) === 'period_not_ended');
  ck('calculate after end allowed', R.assertPeriodTransition('OPEN', 'CALCULATED', { nowMs: b.endMs, endMs: b.endMs }) === true);
  ck('OPEN → PAYABLE refused (no skipping approval)', code(() => R.assertPeriodTransition('OPEN', 'PAYABLE', {})) === 'period_transition_refused');
  ck('PAYABLE → OPEN refused (no reopening paid periods)', code(() => R.assertPeriodTransition('PAYABLE', 'OPEN', {})) === 'period_transition_refused');
  ck('self-approval refused', code(() => R.assertPeriodTransition('CALCULATED', 'APPROVED', { calculatedBy: 'adm1', actorUid: 'adm1' })) === 'approver_not_distinct');
  ck('distinct approver allowed', R.assertPeriodTransition('CALCULATED', 'APPROVED', { calculatedBy: 'adm1', actorUid: 'adm2' }) === true);
  ck('superAdmin override needs a reason', code(() => R.assertPeriodTransition('CALCULATED', 'APPROVED', { calculatedBy: 'a', actorUid: 'a', superAdmin: true })) === 'approver_not_distinct');
  ck('superAdmin override with reason allowed', R.assertPeriodTransition('CALCULATED', 'APPROVED', { calculatedBy: 'a', actorUid: 'a', superAdmin: true, overrideReason: 'sole admin during pilot' }) === true);
}

console.log('\n── statements & release (I6) ──');
{
  const s = R.computeStatement([{ kind: 'EARN', amountCents: 16450 }, { kind: 'EARN', amountCents: 99 }], 0);
  ck('release whole shillings: 16549c → KES 165, carry 49c', s.releaseKes === 165 && s.carryOutCents === 49);
  const s2 = R.computeStatement([{ kind: 'EARN', amountCents: 51 }], s.carryOutCents);
  ck('carried 49c + 51c → KES 1, carry 0', s2.releaseKes === 1 && s2.carryOutCents === 0);
  const debt = R.computeStatement([{ kind: 'REVERSAL', amountCents: 5000 }], 0);
  ck('reversal after release → debt carried, NO negative credit', debt.releaseKes === 0 && debt.carryOutCents === -5000);
  const pay = R.computeStatement([{ kind: 'EARN', amountCents: 8000 }], debt.carryOutCents);
  ck('debt netted against next earnings', pay.releaseKes === 30 && pay.carryOutCents === 0);
  ck('unknown entry kind refused', code(() => R.computeStatement([{ kind: 'BONUS', amountCents: 1 }])) === 'entry_kind_invalid');
  ck('float entry refused', code(() => R.computeStatement([{ kind: 'EARN', amountCents: 1.5 }])) === 'amount_invalid');
}

console.log('\n── reversal (I5) ──');
{
  const lines = [{ entryId: 'e1', amountCents: 16400, alreadyReversedCents: 0 }, { entryId: 'e2', amountCents: 8200, alreadyReversedCents: 0 }];
  const full = R.planReversal({ grossCents: 50000, lines, refundedBeforeCents: 0, refundCents: 50000 });
  ck('full refund reverses exactly what was recognised', full.fullyRefunded && full.reversals[0].reverseCents === 16400 && full.reversals[1].reverseCents === 8200);
  const half = R.planReversal({ grossCents: 50000, lines, refundedBeforeCents: 0, refundCents: 25000 });
  ck('half refund reverses half', half.reversals[0].reverseCents === 8200 && half.reversals[1].reverseCents === 4100);
  const rest = R.planReversal({ grossCents: 50000, lines: lines.map((l, i) => ({ ...l, alreadyReversedCents: half.reversals[i].reverseCents })), refundedBeforeCents: 25000, refundCents: 25000 });
  ck('second half converges on the original (no over-reversal)', rest.reversals[0].reverseCents === 8200 && rest.reversals[1].reverseCents === 4100);
  ck('refund beyond gross refused', code(() => R.planReversal({ grossCents: 50000, lines, refundedBeforeCents: 40000, refundCents: 20000 })) === 'refund_exceeds_gross');
  const odd = [{ entryId: 'o', amountCents: 3, alreadyReversedCents: 0 }];
  let acc = 0; let before = 0;
  for (let i = 0; i < 7; i++) { const r = R.planReversal({ grossCents: 7, lines: [{ ...odd[0], alreadyReversedCents: acc }], refundedBeforeCents: before, refundCents: 1 }); acc += (r.reversals[0] || { reverseCents: 0 }).reverseCents; before += 1; }
  ck('seven 1/7 refunds of 3c reverse exactly 3c', acc === 3, acc);
}

console.log('\n── participant summary ──');
{
  const sum = R.summarizeParticipant({
    entries: [
      { periodId: '2026-Q3', kind: 'EARN', amountCents: 1000 },
      { periodId: '2026-Q4', kind: 'EARN', amountCents: 500 },
      { periodId: '2026-Q4', kind: 'REVERSAL', amountCents: 200 },
      { periodId: '2026-Q2', kind: 'EARN', amountCents: 700 },
    ],
    periodStatusById: { '2026-Q2': 'PAYABLE', '2026-Q3': 'APPROVED', '2026-Q4': 'OPEN' },
    statements: [{ periodId: '2026-Q2', released: true, releaseCents: 700, carryOutCents: 0 }],
  });
  ck('accrued = open-period net', sum.accruedCents === 300);
  ck('pending settlement = calculated/approved net', sum.pendingSettlementCents === 1000);
  ck('released = released statements', sum.releasedCents === 700);
  ck('reversed tracked separately', sum.reversedCents === 200);
}

console.log('\n── purity ──');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'functions', 'shared', 'creator-royalty.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ck('no firestore / firebase require', !/firestore|require\(\s*['"]firebase/.test(src));
  ck('no clock read (Date.now / new Date())', !/Date\.now|new Date\(\s*\)/.test(src));
  ck('no Math.random', !/Math\.random/.test(src));
  ck('no parseFloat / toFixed money handling', !/parseFloat|toFixed/.test(src));
  ck('no bare commission rate in the royalty module (0.15 / RATES.ppv / commission-config)', !/0\.15|RATES\.ppv|commission-config/.test(src));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
