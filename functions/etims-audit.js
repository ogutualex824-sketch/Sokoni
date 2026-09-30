'use strict';
/**
 * SOKONI eTIMS — Immutable Audit Trail (single canonical audit subsystem)
 * ===========================================================================
 * Append-only, TAMPER-EVIDENT record of every significant invoice-lifecycle event
 * (creation, validation, queueing, submission, acknowledgement, failure, retry,
 * cancellation, amendment, credit/debit note, dead-letter).
 *
 * Immutability model:
 *   - Records are written once to `etimsAuditLog` and NEVER updated or deleted
 *     (enforced by firestore.rules: no client writes; append-only by convention +
 *     a hash chain that makes any tampering detectable).
 *   - Per-entity HASH CHAIN: each record carries prevHash + its own hash =
 *     sha256(prevHash | canonical(core fields)). A per-entity head pointer
 *     (`etimsAuditHeads/{entityId}`) is advanced in the SAME transaction as the
 *     append, so concurrent events cannot fork the chain.
 *   - `verifyChain()` recomputes the chain and flags any edit, deletion, or reorder.
 *
 * The hashing is PURE and exported so it can be unit-tested with no Firestore
 * (scripts/test-etims-audit.js). Do not add a second audit path anywhere — this is
 * the one canonical audit trail.
 *
 * @module etims-audit
 * @version 1.0.0
 */
const crypto = require('crypto');

const AUDIT_COLL = 'etimsAuditLog';
const HEADS_COLL = 'etimsAuditHeads';
const GENESIS = 'GENESIS';

/* Canonical, order-independent serialization of the signed core fields. */
function canonical(core) {
  return Object.keys(core).sort().map((k) => `${k}=${JSON.stringify(core[k] ?? null)}`).join('|');
}
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

/* The fields that are hash-protected (the immutable substance of an event). */
function coreOf(rec) {
  return {
    entityType: rec.entityType, entityId: rec.entityId, event: rec.event,
    prevStatus: rec.prevStatus ?? null, newStatus: rec.newStatus ?? null,
    actor: rec.actor ?? 'system', sellerUid: rec.sellerUid ?? null, hubId: rec.hubId ?? null,
    seq: rec.seq, at: rec.at, detail: rec.detail ?? null,
  };
}

/* Compute the chain hash for a record given its predecessor's hash. PURE. */
function chainHash(prevHash, core) { return sha256(`${prevHash || GENESIS}|${canonical(core)}`); }

/**
 * Append an immutable audit event. Atomic (transactional head advance → no forks).
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} evt { entityType, entityId, event, prevStatus?, newStatus?, actor?, sellerUid?, hubId?, detail?, meta? }
 * @returns {Promise<{id:string, hash:string, seq:number}>}
 */
async function recordAuditEvent(db, evt) {
  const admin = require('firebase-admin');
  const ts    = admin.firestore.Timestamp.now();
  const atIso = ts.toDate().toISOString();
  const headRef = db.collection(HEADS_COLL).doc(String(evt.entityId));
  const recRef  = db.collection(AUDIT_COLL).doc();
  let out = null;
  await db.runTransaction(async (t) => {
    const h = await t.get(headRef);
    const prevHash = h.exists ? (h.data().lastHash || GENESIS) : GENESIS;
    const seq      = h.exists ? ((h.data().lastSeq || 0) + 1)  : 0;
    const core = coreOf({ ...evt, seq, at: atIso });
    const hash = chainHash(prevHash, core);
    t.set(recRef, {
      ...core, atTs: ts, prevHash, hash, immutable: true,
      meta: evt.meta ? JSON.parse(JSON.stringify(evt.meta)) : null,
    });
    t.set(headRef, { entityId: String(evt.entityId), lastHash: hash, lastSeq: seq, updatedAt: ts }, { merge: true });
    out = { id: recRef.id, hash, seq };
  });
  return out;
}

/**
 * Verify the tamper-evidence of an entity's audit chain. Read-only.
 * @returns {Promise<{ok:boolean, count:number, issues:string[]}>}
 */
async function verifyChain(db, entityId) {
  const snap = await db.collection(AUDIT_COLL).where('entityId', '==', String(entityId)).orderBy('seq', 'asc').get();
  return verifyRecords(snap.docs.map((d) => d.data()));
}

/* PURE chain verification over an ordered array of records — the testable core. */
function verifyRecords(records) {
  let prev = GENESIS, count = 0;
  const issues = [];
  records.forEach((r, i) => {
    if (r.seq !== i) issues.push(`seq gap/reorder at index ${i}: seq=${r.seq}`);
    if ((r.prevHash || GENESIS) !== prev) issues.push(`seq ${r.seq}: prevHash mismatch (deletion/reorder)`);
    const expect = chainHash(r.prevHash, coreOf(r));
    if (r.hash !== expect) issues.push(`seq ${r.seq}: hash mismatch (record tampered)`);
    prev = r.hash;
    count++;
  });
  return { ok: issues.length === 0, count, issues };
}

/* Fire-and-forget wrapper — audit logging must NEVER break the money/tax path. */
function auditSafe(db, evt) {
  return recordAuditEvent(db, evt).catch((e) => {
    console.error('[etims-audit] record failed (non-fatal):', e && e.message, evt && evt.event, evt && evt.entityId);
    return null;
  });
}

module.exports = {
  AUDIT_COLL, HEADS_COLL, GENESIS,
  canonical, sha256, coreOf, chainHash,
  recordAuditEvent, verifyChain, verifyRecords, auditSafe,
};
