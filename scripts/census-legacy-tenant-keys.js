#!/usr/bin/env node
/**
 * LEGACY TENANT-KEY CENSUS — read-only. Requires authorised production credentials.
 *
 *   GOOGLE_APPLICATION_CREDENTIALS=<service-account.json> \
 *   node scripts/census-legacy-tenant-keys.js --project <id> [--limit N] [--page 2000]
 *
 * Omitting --limit censuses the WHOLE of each collection by paging on document id.
 * Passing --limit stops early, and that collection is reported as a FLOOR, never a total.
 *
 * WHAT IT ANSWERS
 * Tenant convergence made every converged reader ask for `sellerId = merchantId`. Records
 * written earlier carry `sellerId = owner uid` and are now unreachable — present, but
 * invisible. This counts exactly how many, per collection, before anything is changed.
 *
 * IT CANNOT WRITE. There is no set/update/delete/batch call anywhere in this file, and the
 * classifier it uses (scripts/lib/tenant-migration.js) has no I/O at all. That is asserted by
 * scripts/test-tenant-migration-safety.js rather than promised here.
 *
 * COLLECTIONS — the six reached by a `sellerId` filter in pos-staff-ops.js:
 *   posShifts (4 queries) · posAttendance (3) · posRetailSales (2) · posCommissions (2)
 *   posCashReconciliation (2) · posApprovals (1)
 *
 * A NOTE ON posRetailSales, which the census must settle rather than assume: checkout writes
 * `sellerId` from a `merchantId` validated by `resolveActor` against `shops/{shopId}` — the
 * OWNER-UID space — while `pos-staff-ops` now reads it with a canonical merchantId. Whether
 * those are the same value for any real merchant is exactly what this run determines.
 */
'use strict';
const path = require('path');
const MIG = require(path.join(__dirname, 'lib/tenant-migration.js'));

const COLLECTIONS = [
  'posShifts', 'posAttendance', 'posRetailSales',
  'posCommissions', 'posCashReconciliation', 'posApprovals',
];

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i > -1 ? args[i + 1] : d; };
/* --limit is an explicit CAP, not a default ceiling. Omitting it censuses the WHOLE
   collection by paging; passing it stops early and the result is labelled a FLOOR. */
const LIMIT = argOf('--limit', null) ? Number(argOf('--limit', null)) : 0;
const PAGE  = Number(argOf('--page', 2000));

function die (msg) { console.error(NL + '  ' + msg); process.exit(2); }
const NL = String.fromCharCode(10);

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !argOf('--project', null)) {
  die('Refusing to run without explicit credentials.' + NL +
      '  Set GOOGLE_APPLICATION_CREDENTIALS to an authorised read-only service account,' + NL +
      '  or pass --project <id> when application-default credentials are already present.' + NL +
      '  This script reads production and must never be run by accident.');
}

(async function main () {
  /* firebase-admin lives in functions/node_modules, not at the repo root, so a plain
     require() fails from scripts/. Resolve it explicitly from there before giving up —
     otherwise the operator's first run dies on a module error that looks like a
     credential problem. */
  let admin;
  try { admin = require('firebase-admin'); }
  catch (_) {
    try {
      admin = require(require.resolve('firebase-admin',
        { paths: [path.join(__dirname, '..', 'functions')] }));
    } catch (e2) {
      die('firebase-admin could not be resolved.' + NL +
          '  Looked at the repo root and at functions/node_modules.' + NL +
          '  Run `npm install` inside functions/ first.');
    }
  }
  if (!admin.apps.length) {
    admin.initializeApp(argOf('--project', null) ? { projectId: argOf('--project', null) } : {});
  }
  const db = admin.firestore();

  /* Every businesses doc: the merchantId set AND the ownerId -> merchantId index. Built once,
     so the per-record classification needs no further reads. Ambiguity is detected here for
     the same reason the runtime resolver reads limit(2) — an owner of two businesses must
     never be silently assigned to one. */
  console.log(NL + 'Reading businesses …');
  const bizSnap = await db.collection('businesses').get();
  const knownMerchantIds = new Set();
  const byOwner = new Map();
  bizSnap.forEach((d) => {
    const v = d.data() || {};
    knownMerchantIds.add(d.id);
    const malformed = v.merchantId && v.merchantId !== d.id;
    const inactive = v.status && v.status !== 'active';
    if (!v.ownerId) return;
    const list = byOwner.get(v.ownerId) || [];
    list.push({ id: d.id, malformed: !!malformed, inactive: !!inactive });
    byOwner.set(v.ownerId, list);
  });
  console.log('  businesses: ' + knownMerchantIds.size + ', distinct owners: ' + byOwner.size);

  const resolveOwner = (uid) => {
    const list = byOwner.get(uid);
    if (!list || !list.length) return { ok: false, reason: 'no-business-for-owner' };
    if (list.length > 1)      return { ok: false, reason: 'owner-has-multiple-businesses' };
    if (list[0].malformed)    return { ok: false, reason: 'business-record-malformed' };
    if (list[0].inactive)     return { ok: false, reason: 'business-not-active' };
    return { ok: true, merchantId: list[0].id };
  };

  const rows = [];
  const collisionDetail = [];
  const refusalDetail = [];

  for (const coll of COLLECTIONS) {
    process.stdout.write('Reading ' + coll + ' … ');

    /* PAGED. The first version took a single `.limit(N)` slice, so any collection larger
       than N could only ever be reported as a floor — there was no way to finish it. It now
       pages by document id until the collection is exhausted, and `--limit` becomes an
       explicit CAP rather than an accidental ceiling. Only the few fields the classifier and
       the collision index actually need are retained, so a large collection costs bandwidth
       rather than memory. */
    const docs = [];
    let cursor = null, capped = false, failed = null;
    try {
      for (;;) {
        let q = db.collection(coll)
          .orderBy(admin.firestore.FieldPath.documentId())
          .limit(PAGE);
        if (cursor) q = q.startAfter(cursor);
        const page = await q.get();
        if (page.empty) break;
        page.forEach((d) => {
          const v = d.data() || {};
          docs.push({
            id: d.id,
            sellerId: v.sellerId,
            merchantId: v.merchantId,
            cashierUid: v.cashierUid,
            cashierId: v.cashierId,
            requestedBy: v.requestedBy,
            openedAt: v.openedAt,
            createdAt: v.createdAt,
            timestamp: v.timestamp,
          });
        });
        cursor = page.docs[page.docs.length - 1].id;
        process.stdout.write('.');
        if (page.size < PAGE) break;
        if (LIMIT && docs.length >= LIMIT) { capped = true; break; }
      }
    } catch (err) { failed = err.message; }
    if (failed) { console.log(' FAILED (' + failed + ')'); continue; }

    /* Present the accumulated pages with the same shape the rest of this loop expects. */
    const snap = {
      size: docs.length,
      forEach: (fn) => docs.forEach((d) => fn({ id: d.id, data: () => d })),
    };

    /* Index what already exists per target so collisions are detected without extra reads.
       "Same logical record" is deliberately narrow — a shift is identified by its cashier and
       open time, an approval by its requester and creation time. Anything looser would call
       unrelated documents a collision and inflate the refusal count. */
    const existing = new Map();
    snap.forEach((d) => {
      const v = d.data() || {};
      if (!v.sellerId || !knownMerchantIds.has(v.sellerId)) return;
      const key = v.sellerId + '|' + (v.cashierUid || v.cashierId || v.requestedBy || '') +
                  '|' + String(v.openedAt || v.createdAt || v.timestamp || '');
      existing.set(key, d.id);
    });
    const targetExists = (to, rec) => {
      const key = to + '|' + (rec.cashierUid || rec.cashierId || rec.requestedBy || '') +
                  '|' + String(rec.openedAt || rec.createdAt || rec.timestamp || '');
      return existing.has(key) && existing.get(key) !== rec.id;
    };

    const plans = [];
    let oldest = null, newest = null;
    snap.forEach((d) => {
      const rec = Object.assign({ id: d.id }, d.data());
      const plan = MIG.classify(rec, { knownMerchantIds, resolveOwner, targetExists });
      plans.push(plan);
      if (plan.status !== MIG.STATUS.CANONICAL) {
        const t = String(rec.createdAt || rec.openedAt || rec.timestamp || '');
        if (t) { if (!oldest || t < oldest) oldest = t; if (!newest || t > newest) newest = t; }
      }
      if (plan.status === MIG.STATUS.COLLISION) {
        collisionDetail.push({ collection: coll, legacyId: d.id, from: plan.from, to: plan.to });
      } else if (plan.status !== MIG.STATUS.CANONICAL && plan.status !== MIG.STATUS.ELIGIBLE) {
        refusalDetail.push({ collection: coll, id: d.id, status: plan.status, from: plan.from });
      }
    });

    const row = MIG.summarise(coll, plans);
    row.oldestAffected = oldest; row.newestAffected = newest;
    row.truncated = capped;
    rows.push(row);
    console.log(' ' + snap.size + ' docs' + (row.truncated ? '  ** CAPPED at --limit — FLOOR, not a total **' : ' (complete)'));
  }

  const S = MIG.STATUS;
  const pad = (v, n) => String(v == null ? '' : v).padEnd(n).slice(0, n);
  const num = (v, n) => String(v == null ? 0 : v).padStart(n);

  console.log(NL + 'LEGACY TENANT-KEY CENSUS' + NL + '='.repeat(104));
  console.log('  ' + pad('collection', 24) + num('total', 7) + num('canon', 7) + num('legacy', 7) +
              num('missing', 8) + num('unresolv', 9) + num('ambig', 7) + num('malform', 8) +
              num('collide', 8) + num('meaning', 8));
  console.log('  ' + '-'.repeat(100));
  let eligible = 0;
  rows.forEach((r) => {
    eligible += r[S.ELIGIBLE] || 0;
    console.log('  ' + pad(r.collection, 24) + num(r.total, 7) + num(r[S.CANONICAL], 7) +
      num(r[S.ELIGIBLE], 7) + num(r[S.MISSING], 8) + num(r[S.UNLINKED], 9) +
      num(r[S.AMBIGUOUS], 7) + num(r[S.MALFORMED], 8) + num(r[S.COLLISION], 8) +
      num(r[S.MEANING], 8) + (r.truncated ? '  TRUNCATED' : ''));
  });
  console.log(NL + '  affected window per collection:');
  rows.forEach((r) => {
    if (r.oldestAffected || r.newestAffected) {
      console.log('    ' + pad(r.collection, 24) + (r.oldestAffected || '?') + '  ->  ' + (r.newestAffected || '?'));
    }
  });

  console.log(NL + '  ELIGIBLE FOR MIGRATION: ' + eligible + ' document(s)');
  console.log('  COLLISIONS: ' + collisionDetail.length + '   OTHER REFUSALS: ' + refusalDetail.length);
  if (collisionDetail.length) {
    console.log(NL + '  collisions (neither document may be merged or overwritten):');
    collisionDetail.slice(0, 40).forEach((c) =>
      console.log('    ' + pad(c.collection, 22) + pad(c.legacyId, 24) + c.from + ' -> ' + c.to));
    if (collisionDetail.length > 40) console.log('    … ' + (collisionDetail.length - 40) + ' more');
  }
  if (refusalDetail.length) {
    console.log(NL + '  refusals needing manual resolution:');
    const byStatus = {};
    refusalDetail.forEach((r) => { (byStatus[r.status] = byStatus[r.status] || []).push(r); });
    Object.keys(byStatus).forEach((st) => {
      console.log('    ' + pad(st, 20) + byStatus[st].length + '  e.g. ' +
        byStatus[st].slice(0, 3).map((r) => r.collection + '/' + r.id).join(', '));
    });
  }

  console.log(NL + '  NOTHING WAS WRITTEN. This is a census; the backfill is a separate,');
  console.log('  explicitly authorised step. Re-run after any change to compare.');
  if (rows.some((r) => r.truncated)) {
    console.log(NL + '  ** One or more collections hit --limit. The counts above are a FLOOR,');
    console.log('     not a total. Re-run with a higher --limit before planning a migration. **');
  }
})().catch((e) => { console.error(NL + '  CENSUS FAILED: ' + (e && e.stack || e)); process.exit(2); });
