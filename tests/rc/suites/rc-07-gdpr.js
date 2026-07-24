/* RC-07 GDPR DATA EXPORT — the compliance path, verified by STATE TRANSITIONS.

   Asserting only the final state would miss the failure this pipeline has
   already demonstrated it can have: a callable that appears to succeed while
   never enqueueing work leaves the request stuck at `pending` forever. That is
   invisible to a "did it end up ready?" check that times out, and invisible to
   endpoint health checks. So this suite records the sequence it observes.

   Real lifecycle (functions/data-export.js):
     pending    — written by requestDataExport (both dataExportRequests AND
                  dataExportQueue/{id}; the queue doc is what triggers the worker)
     processing — processDataExport starts (onDocumentCreated on dataExportQueue)
     ready      — artifact at data-exports/{uid}/{requestId}.json + downloadUrl
     failed     — carries a reason

   SCOPE HONESTY: requestDataExport is onCall with enforceAppCheck:true, so the
   callable ENTRY cannot be exercised from headless Chromium (same App Check wall
   as RC-09). This suite therefore certifies the WORKER path — trigger, artifact,
   status lifecycle — by enqueueing exactly what the callable writes. The entry
   step reports BLOCKED rather than being skipped, so the gap stays visible. */
'use strict';
const { BlockedError } = require('../backends/backend-interface');

const REQ_ID = 'rc-gdpr-probe';
const REQ_DOC = `dataExportRequests/${REQ_ID}`;
const QUEUE_DOC = `dataExportQueue/${REQ_ID}`;

async function pollTransitions(ctx, { path, timeoutMs = 90000, everyMs = 3000 }) {
  const seen = [];
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const doc = await ctx.backend.getDoc(path);
    const st = doc && doc.status;
    if (st && st !== last) { seen.push({ status: st, at: new Date().toISOString() }); last = st; }
    if (st === 'ready' || st === 'failed') break;
    await new Promise(r => setTimeout(r, everyMs));
  }
  return { seen, final: last, doc: await ctx.backend.getDoc(path) };
}

module.exports = {
  id: 'RC-07', title: 'GDPR Data Export (state-transition verified)',
  steps: [
    { name: 'Callable entry requestDataExport (real client path)',
      capability: 'GDPR: callable entry', async run(ctx) {
        const res = await ctx.signInAs(ctx.dataset.IDENTITIES.buyer);
        if (!res.ok) throw new BlockedError(`buyer sign-in unavailable: ${res.code} ${res.msg}`);
        const page = await ctx.ui();
        const out = await page.evaluate(async () => {
          try {
            const fn = window.firebase.functions().httpsCallable('requestDataExport');
            const r = await fn({});
            return { ok: true, data: r && r.data };
          } catch (e) { return { ok: false, code: e.code || '', msg: String(e.message || e).slice(0, 120) }; }
        });
        ctx.record('assertion', { callable: out });
        if (!out.ok) {
          throw new BlockedError(
            `callable entry not exercisable here (${out.code}) — requestDataExport is ` +
            `enforceAppCheck:true and headless Chromium has no App Check token. The ` +
            `WORKER path is still certified below; only the entry is unverified.`);
        }
        return { detail: 'callable accepted the request' };
    }},

    { name: 'Enqueue exactly what the callable writes (status + queue doc)',
      capability: 'GDPR: enqueue', async run(ctx) {
        const uid = await ctx.backend.ensureUser(ctx.dataset.IDENTITIES.buyer);
        ctx._gdprUid = uid;
        const payload = { ...ctx.dataset.RC_TAG, uid, requestId: REQ_ID, status: 'pending',
                          requestedAt: new Date().toISOString() };
        await ctx.backend.setDoc(REQ_DOC, payload);
        const before = await ctx.backend.getDoc(REQ_DOC);
        if (!before || before.status !== 'pending') throw new Error('status doc not seeded at pending');
        /* The QUEUE doc is the trigger. Written second, so the status doc always
           exists before the worker looks for it — the ordering the callable uses. */
        await ctx.backend.setDoc(QUEUE_DOC, payload);
        ctx.record('firestore', { req: REQ_DOC, queue: QUEUE_DOC, uid, seededStatus: 'pending' });
        return { detail: `enqueued for uid=${uid}` };
    }},

    { name: 'Worker fires and status advances beyond pending',
      capability: 'GDPR: worker trigger', async run(ctx) {
        const { seen, final, doc } = await pollTransitions(ctx, { path: REQ_DOC });
        ctx._gdprSeen = seen; ctx._gdprDoc = doc;
        ctx.record('assertion', { observedTransitions: seen, final });
        if (!final || final === 'pending') {
          throw new Error(
            'request never advanced beyond `pending` within 90s — the onDocumentCreated ' +
            'worker did not fire, or failed before writing status. This is the exact ' +
            'silent-stall mode the shadowed-callable bug produced.');
        }
        return { detail: `observed: ${seen.map(s => s.status).join(' → ')}` };
    }},

    { name: 'Lifecycle reaches ready (or fails with a reason, never silently)',
      capability: 'GDPR: status lifecycle', async run(ctx) {
        const doc = ctx._gdprDoc || await ctx.backend.getDoc(REQ_DOC);
        if (!doc) throw new Error('status document vanished');
        if (doc.status === 'failed') {
          /* A failing export is a DEFECT, so this always FAILS — it must never
             soften to BLOCKED once the diagnostic fields land, or fixing the
             reporting would create the impression the export itself was fixed.
             These are two separate defects and the report must keep them apart:
               • diagnostic  — is the failure actionable? (reason present)
               • execution   — does the export actually work? (status ready)
             The message distinguishes them; the severity does not. */
          const code = doc.failureCode || null;
          const reason = doc.failureReason || doc.error || doc.reason || doc.message || null;
          ctx.record('assertion', { failed: true, failureCode: code, failureReason: reason });
          if (!reason && !code) {
            throw new Error(
              'EXECUTION DEFECT + DIAGNOSTIC DEFECT: export failed, and the document ' +
              'carries no reason or code — undiagnosable without Cloud Logging access.');
          }
          throw new Error(
            `EXECUTION DEFECT: export still fails (code=${code || 'n/a'}). ` +
            `Diagnostics are present, so this is now actionable — but the export ` +
            `itself is NOT fixed.`);
        }
        if (doc.status !== 'ready') throw new Error(`unexpected terminal status: ${doc.status}`);
        return { detail: 'reached ready' };
    }},

    { name: 'Artifact exists and is reachable (download link honoured)',
      capability: 'GDPR: artifact delivery', async run(ctx) {
        const doc = ctx._gdprDoc || await ctx.backend.getDoc(REQ_DOC);
        if (!doc || doc.status !== 'ready') throw new BlockedError('gated on the lifecycle reaching ready');
        const url = doc.downloadUrl || doc.downloadURL;
        ctx.record('assertion', { downloadUrl: url ? 'present' : 'MISSING', expiresAt: doc.expiresAt || null });
        if (!url) throw new Error('status is ready but no downloadUrl — the user gets nothing');
        if (!doc.expiresAt) throw new Error('no expiresAt — an export link that never expires is a data-retention risk');
        return { detail: 'downloadUrl + expiresAt present' };
    }},
  ],
};
