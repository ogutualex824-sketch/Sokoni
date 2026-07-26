'use strict';

/**
 * SOKONI Storage Integrity Auditor — Phase 1
 *
 * Continuous verification that the catalog's image references stay healthy. It
 * catches the class of failure that validation alone cannot: a Firestore product
 * whose image URL points at a Storage object that no longer exists (deleted file,
 * broken migration, partial upload).
 *
 *   products (paged)
 *        │
 *        ├─ validateProductWrite()      ← the shared Validation Contract (structure)
 *        │
 *        ├─ extract image references
 *        │
 *        └─ Storage object exists?      ← the only check that needs external state
 *              │
 *         exists → pass    missing → integrityIssues/{deterministic id}
 *
 * DESIGN
 *  • Reuses functions/product-validator.js — never re-implements structural checks.
 *  • Every issue is STRUCTURED and queryable (type/severity/code/field/path), never
 *    a free-form log. Deterministic doc id (productId__type__field) so a re-run
 *    updates in place instead of duplicating.
 *  • Modular checks: CHECKS is an array of { name, run } — add a new audit (orphan,
 *    thumbnail, MIME, cache-control) by pushing one entry; no new scheduled function.
 *  • Bounded + resumable: MAX_PER_RUN caps work per invocation; a cursor in
 *    integrityAudit/state resumes on the next run so the whole catalog is covered
 *    over time without a single unbounded scan.
 *
 * Phase 2 (later): auto-repair safe cases + resolve stale issues.
 * Phase 3 (later): alert when open-issue count crosses a threshold.
 */

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const validator = require('./product-validator');

const PAGE        = 60;     // products checked concurrently per page (fits timeout)
const MAX_PER_RUN = 3000;   // safety cap on products per invocation
const STATE_DOC   = 'integrityAudit/state';

/* ── Map a Firebase/GCS download URL to its Storage object path ──────────────
   Returns null for a URL that is not a recognised Storage object (external CDN,
   data:, etc.) — those are SKIPPED, never flagged as missing. */
function storagePathFromUrl(url) {
  if (typeof url !== 'string') return null;
  let m = url.match(/firebasestorage\.googleapis\.com\/v0\/b\/[^/]+\/o\/([^?]+)/i);
  if (m) { try { return decodeURIComponent(m[1]); } catch (e) { return null; } }
  m = url.match(/storage\.googleapis\.com\/[^/]+\/([^?]+)/i);
  if (m) { try { return decodeURIComponent(m[1]); } catch (e) { return null; } }
  return null;
}

/* Every image reference a product carries, from both the single-string fields and
   the images[] array (string or {url}). */
function imageRefs(p) {
  const refs = [];
  ['image', 'imageUrl', 'thumbnail', 'thumbnailUrl', 'coverImage'].forEach((k) => {
    if (typeof p[k] === 'string' && p[k]) refs.push({ field: k, url: p[k] });
  });
  if (Array.isArray(p.images)) {
    p.images.forEach((img, i) => {
      const url = (img && typeof img === 'object') ? img.url : img;
      if (typeof url === 'string' && url) refs.push({ field: 'images[' + i + ']', url });
    });
  }
  return refs;
}

function issueId(productId, type, field) {
  return (productId + '__' + type + '__' + field).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 480);
}

/* ── Modular checks. Each takes (product, ctx) and returns an array of issues. ── */
const CHECKS = [
  {
    name: 'structure',
    async run(p /*, ctx */) {
      /* Reuse the Validation Contract — do NOT duplicate structural rules here. */
      const v = validator.validateProductWrite(p);
      return v.errors.map((e) => ({
        type: 'STRUCTURAL_INVALID', severity: 'error',
        code: e.code, field: e.field, message: e.message,
      }));
    },
  },
  {
    name: 'storage-object-exists',
    async run(p, ctx) {
      const issues = [];
      const refs = imageRefs(p);
      await Promise.all(refs.map(async (ref) => {
        if (validator.isDataUri(ref.url)) return;      // already caught by structure
        const path = storagePathFromUrl(ref.url);
        if (!path) return;                             // external URL — not ours to verify
        let exists = null;
        try { [exists] = await ctx.bucket.file(path).exists(); }
        catch (e) { exists = null; }                   // probe failed — don't false-flag
        if (exists === false) {
          issues.push({
            type: 'MISSING_STORAGE_OBJECT', severity: 'warning', code: 'MISSING_STORAGE_OBJECT',
            field: ref.field, path, url: String(ref.url).slice(0, 500),
            message: 'Firestore references a Storage object that does not exist.',
          });
        }
      }));
      return issues;
    },
  },
];

async function _auditProduct(db, ctx, doc) {
  const p = doc.data() || {};
  const productId = doc.id;
  const sellerId = p.sellerUid || p.sellerId || null;

  let issues = [];
  for (const check of CHECKS) {
    try { issues = issues.concat(await check.run(p, ctx)); }
    catch (e) { /* one check failing must not abort the product */ }
  }

  const col = db.collection('integrityIssues');
  await Promise.all(issues.map((x) => col.doc(issueId(productId, x.type, x.field)).set({
    productId, sellerId,
    type: x.type, severity: x.severity, code: x.code, field: x.field,
    path: x.path || null, url: x.url || null, message: x.message,
    detectedAt: Timestamp.now(), runId: ctx.runId,
    schemaVersion: validator.SCHEMA_VERSION, resolved: false,
  }, { merge: true })));

  return {
    hadIssues: issues.length > 0,
    structural: issues.filter((i) => i.type === 'STRUCTURAL_INVALID').length,
    missing: issues.filter((i) => i.type === 'MISSING_STORAGE_OBJECT').length,
  };
}

/* ── The run. Shared by the schedule and the manual callable. ── */
async function _runAudit() {
  const db = getFirestore();
  const bucket = getStorage().bucket();
  const runId = 'run_' + Date.now().toString(36);
  const ctx = { bucket, runId };

  const stateRef = db.doc(STATE_DOC);
  const stateSnap = await stateRef.get();
  const startAfterId = stateSnap.exists ? (stateSnap.data().cursor || null) : null;

  const totals = { scanned: 0, withIssues: 0, structural: 0, missing: 0 };
  let lastId = startAfterId;
  let done = false;

  while (totals.scanned < MAX_PER_RUN) {
    let q = db.collection('products').orderBy('__name__').limit(PAGE);
    if (lastId) q = q.startAfter(lastId);
    const snap = await q.get();
    if (snap.empty) { done = true; break; }

    const results = await Promise.all(snap.docs.map((d) => _auditProduct(db, ctx, d)));
    results.forEach((r) => {
      totals.scanned++;
      if (r.hadIssues) totals.withIssues++;
      totals.structural += r.structural;
      totals.missing += r.missing;
    });
    lastId = snap.docs[snap.docs.length - 1].id;
    if (snap.size < PAGE) { done = true; break; }
  }

  /* Advance the cursor; wrap to the start once the catalog is fully covered. */
  await stateRef.set({
    cursor: done ? null : lastId,
    lastRunId: runId,
    lastRunAt: Timestamp.now(),
    lastRunTotals: totals,
    coveredFullCatalog: done,
  }, { merge: true });

  /* Queryable daily metrics — products scanned, missing objects, validation fails. */
  const day = new Date().toISOString().slice(0, 10);
  await db.collection('integrityMetrics').doc(day).set({
    date: day,
    scanned: FieldValue.increment(totals.scanned),
    productsWithIssues: FieldValue.increment(totals.withIssues),
    structuralFailures: FieldValue.increment(totals.structural),
    missingStorageObjects: FieldValue.increment(totals.missing),
    lastRunAt: Timestamp.now(),
  }, { merge: true });

  console.log('[IntegrityAudit] ' + runId + ' scanned=' + totals.scanned +
    ' withIssues=' + totals.withIssues + ' structural=' + totals.structural +
    ' missing=' + totals.missing + ' done=' + done);

  return { runId, ...totals, coveredFullCatalog: done };
}

/* ── Scheduled: daily. Resumes from the cursor, so it walks the whole catalog. ── */
exports.storageIntegrityAuditScheduled = onSchedule(
  { schedule: 'every 24 hours', region: 'us-central1', timeoutSeconds: 540, memory: '512MiB' },
  async () => { await _runAudit(); }
);

/* ── Admin callable: run on demand (testing, after a bulk import). ── */
exports.storageIntegrityAuditRun = onCall(
  { region: 'us-central1' },
  async (req) => {
    if (!req.auth?.token?.admin && !req.auth?.token?.superAdmin) {
      throw new HttpsError('permission-denied', 'Admin access required.');
    }
    return _runAudit();
  }
);

/* Exported for unit tests — the URL→path mapping is the subtle part. */
exports._internal = { storagePathFromUrl, imageRefs, issueId, CHECKS };
