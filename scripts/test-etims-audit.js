'use strict';
/**
 * eTIMS immutable audit trail — tamper-evidence guard.
 *
 *   node scripts/test-etims-audit.js
 *
 * Proves the hash-chained audit log actually detects tampering (the whole point of
 * an "immutable" trail for certification): a valid chain verifies, and any edit,
 * deletion, or reorder is caught. Doubles as the audit-integrity release gate.
 */
const A = require('../functions/etims-audit');

/* Build a valid chained record set the way recordAuditEvent would. */
function buildChain(entityId, events) {
  const recs = [];
  let prev = A.GENESIS;
  events.forEach((e, i) => {
    const core = A.coreOf({ entityType: 'invoice', entityId, event: e.event, prevStatus: e.prevStatus || null,
      newStatus: e.newStatus || null, actor: 'system', sellerUid: 'S1', hubId: null, seq: i, at: `2026-08-03T10:0${i}:00Z`, detail: e.detail || null });
    const hash = A.chainHash(prev, core);
    recs.push({ ...core, prevHash: prev, hash, immutable: true });
    prev = hash;
  });
  return recs;
}

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}`); };

console.log('\n=== eTIMS audit trail — tamper-evidence guard ===');

const lifecycle = [
  { event: 'created',   newStatus: 'pending_submission' },
  { event: 'queued',    prevStatus: 'pending_submission', newStatus: 'queued' },
  { event: 'submitted', prevStatus: 'queued', newStatus: 'processing' },
  { event: 'accepted',  prevStatus: 'processing', newStatus: 'accepted', detail: 'rcptNo=123' },
];

/* 1. A valid chain verifies clean */
{
  const recs = buildChain('INV-1', lifecycle);
  const v = A.verifyRecords(recs);
  check('1 valid chain verifies (ok, no issues)', v.ok && v.count === 4 && v.issues.length === 0);
}

/* 2. Editing a record's field is detected (hash mismatch) */
{
  const recs = buildChain('INV-2', lifecycle);
  recs[2].newStatus = 'accepted';   // tamper: pretend it was accepted at the submit step
  const v = A.verifyRecords(recs);
  check('2 field edit detected', !v.ok && v.issues.some(s => s.includes('tampered')));
}

/* 3. Deleting a middle record is detected (prevHash break + seq gap) */
{
  const recs = buildChain('INV-3', lifecycle);
  recs.splice(2, 1);                // delete the 'submitted' event
  const v = A.verifyRecords(recs);
  check('3 deletion detected', !v.ok && v.issues.some(s => s.includes('prevHash') || s.includes('seq')));
}

/* 4. Reordering is detected */
{
  const recs = buildChain('INV-4', lifecycle);
  const tmp = recs[1]; recs[1] = recs[2]; recs[2] = tmp;   // swap queued/submitted
  const v = A.verifyRecords(recs);
  check('4 reorder detected', !v.ok);
}

/* 5. Appending a forged record with a wrong prevHash is detected */
{
  const recs = buildChain('INV-5', lifecycle);
  const forgedCore = A.coreOf({ entityType: 'invoice', entityId: 'INV-5', event: 'accepted', prevStatus: 'processing',
    newStatus: 'accepted', actor: 'attacker', sellerUid: 'S1', hubId: null, seq: 4, at: '2026-08-03T10:05:00Z', detail: null });
  recs.push({ ...forgedCore, prevHash: 'GENESIS', hash: A.chainHash('GENESIS', forgedCore), immutable: true });
  const v = A.verifyRecords(recs);
  check('5 forged-append detected (broken link)', !v.ok);
}

/* 6. Hash is deterministic */
{
  const core = A.coreOf({ entityType: 'invoice', entityId: 'INV-6', event: 'created', seq: 0, at: '2026-08-03T10:00:00Z' });
  check('6 chainHash deterministic', A.chainHash('GENESIS', core) === A.chainHash('GENESIS', core));
}

console.log(`\n${fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' PASSED'}`);
process.exitCode = fail ? 1 : 0;
