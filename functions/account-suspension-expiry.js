'use strict';
/**
 * SUSPENSION AUTO-EXPIRY (owner ruling 2026-10-04): a suspension lasts SUSPENSION_DAYS (14) and is then lifted
 * automatically. A BAN is permanent and is never touched here.
 *
 * The job lifts NOTHING itself: every lift goes through the ONE contract, shared/account-suspension.js setSuspension,
 * as actor { system:true } with source 'auto_expiry' — the same Auth re-enable + status restore + history + adminAudit +
 * auditLog (severity high) as a manual reinstate. The contract re-reads each document and claims the episode with
 * create(), so a concurrent run, an early manual reinstate or a fresh suspension is never clobbered or double-recorded.
 *
 * Bounded: PAGE_SIZE documents per page, MAX_PAGES pages per run; the rest wait for the next hourly run.
 * Fail closed: a suspended account whose suspendedUntil is missing or unreadable is NEVER lifted; once a day (the 00:xx UTC
 * run) a bounded scan flags such accounts in suspensionExpiryFlags/{uid} for a human decision.
 */
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { setSuspension, untilMs } = require('./shared/account-suspension');

const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const FLAG_SCAN_LIMIT = 500;

/* Pure core (injectable for tests). → { lifted, skipped, failed, flagged, pages } */
async function runSuspensionExpiry({ db, auth, now = Date.now(), serverTs, toTs, flagScan = false, pageSize = PAGE_SIZE, maxPages = MAX_PAGES }) {
  const ts = serverTs || (() => FieldValue.serverTimestamp());
  const cutoff = toTs ? toTs(now) : Timestamp.fromMillis(now);
  const out = { lifted: 0, skipped: 0, failed: 0, flagged: 0, pages: 0 };
  let last = null;
  for (let page = 0; page < maxPages; page++) {
    let q = db.collection('users').where('status', '==', 'suspended').where('suspendedUntil', '<=', cutoff)
      .orderBy('suspendedUntil').limit(pageSize);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    out.pages++;
    for (const d of snap.docs) {
      try {
        const r = await setSuspension({ db, auth, serverTs: ts, now: () => now, actor: { system: true },
          uid: d.id, suspend: false, kind: 'suspend', source: 'auto_expiry' });
        if (r.changed) out.lifted++; else out.skipped++;
      } catch (e) {
        out.failed++;
        console.error('[suspension-expiry] lift failed', { uid: d.id, code: e && e.code ? e.code : 'error' });
      }
    }
    if (snap.docs.length < pageSize) break;
    last = snap.docs[snap.docs.length - 1];
  }
  if (flagScan) {
    const s = await db.collection('users').where('status', '==', 'suspended').limit(FLAG_SCAN_LIMIT).get();
    for (const d of s.docs) {
      const u = d.data() || {};
      if (untilMs(u.suspendedUntil) === null) {
        await db.collection('suspensionExpiryFlags').doc(d.id).set({ uid: d.id, reason: 'suspendedUntil missing or unreadable — never auto-lifted',
          flaggedAt: ts() }, { merge: true });
        out.flagged++;
      }
    }
  }
  return out;
}

exports.expireSuspensions = onSchedule({ schedule: '15 * * * *', timeZone: 'UTC', region: 'us-central1', maxInstances: 1 }, async () => {
  const now = Date.now();
  const r = await runSuspensionExpiry({ db: getFirestore(), auth: getAuth(), now, flagScan: new Date(now).getUTCHours() === 0 });
  console.log('[suspension-expiry]', r);
});
exports._runSuspensionExpiry = runSuspensionExpiry;   // test hook
