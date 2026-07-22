'use strict';

/**
 * Admin-gated catalogue repair.
 *
 * WHY A CALLABLE AND NOT A SCRIPT
 * This changes ownership of production inventory. Run from a laptop it depends
 * on Application Default Credentials, leaves no server-side record, and cannot
 * be repeated by anyone else. Run here it executes under the function's own
 * identity, refuses a caller without the admin claim, and writes what it did to
 * adminAudit before returning. The audit trail is the point: an ownership change
 * that nobody can later explain is indistinguishable from a compromise.
 *
 * WHAT IT WILL NOT DO
 * Create a product. Delete a product. Guess an owner. Every document it touches
 * is named explicitly by the caller, and reassignment additionally requires the
 * target uid to be confirmed as the owner of a merchant record — the caller
 * saying so is not sufficient, because the whole defect being repaired is a
 * product carrying an owner that nobody verified.
 *
 * DRY RUN IS THE DEFAULT
 * dryRun defaults to true and must be explicitly set false. The response has the
 * same shape either way, so what you review is what you get.
 *
 * THE DEFECT THIS EXISTS FOR (measured 2026-07-22)
 * Three KASS VAPES products carry uid = the merchant's owner and sellerUid = an
 * admin account. Everything authoritative keys off sellerUid — the security
 * rule, the counter trigger, recountMarketplaceProducts, the store query — so
 * the merchant is locked out of their own catalogue by permission-denied, and
 * their listings count against the admin's product cap. The same documents
 * store price and stock as strings, and carry full base64 image data alongside
 * the Storage URLs that already hold the same images.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const { buildSearchTerms } = require('./search-terms');

if (!admin.apps.length) admin.initializeApp();

const db = admin.firestore();
const F  = admin.firestore.FieldValue;
const REGION = 'us-central1';

/* Matches admin-os: the admin claim, never a role field on a user document.
   A users/{uid}.role is client-visible data that the account itself can be
   induced to carry; a custom claim is minted server-side and is the only
   statement of privilege this function will accept. */
function requireAdmin(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  if (!req.auth.token?.admin && !req.auth.token?.superAdmin) {
    throw new HttpsError('permission-denied', 'Admin required.');
  }
  return req.auth.uid;
}

const isDataUri = v => typeof v === 'string' && v.startsWith('data:');

const kb = n => Math.round(n / 1024) + 'KB';

/* Approximate stored size of a document. Firestore's real accounting adds field
   name lengths and per-type overhead, so this undercounts slightly — it is here
   to show the order of magnitude of what an inline image costs against the 1 MiB
   per-document limit, not to be an exact billing figure. Reported as an estimate
   for that reason: a precise-looking number that is quietly wrong is worse than
   an admitted approximation. */
function approxDocBytes(obj) {
  try { return Buffer.byteLength(JSON.stringify(obj) || '', 'utf8'); }
  catch (_) { return 0; }
}

/**
 * Confirm a uid genuinely owns a merchant before anything is reassigned to it.
 *
 * Checked against merchants/ and businesses/ rather than trusted from the
 * request. Reassigning inventory to whatever uid the caller names would replace
 * a misattribution bug with a way to hand any product to any account — and the
 * caller here is an admin, which is exactly the privilege level where an
 * unverified write does the most damage.
 */
async function confirmOwner(uid) {
  for (const col of ['merchants', 'businesses']) {
    const snap = await db.collection(col).where('ownerId', '==', uid).limit(1).get();
    if (!snap.empty) {
      const d = snap.docs[0];
      return { ok: true, via: col, merchantId: d.id, name: d.data().name || d.data().businessName || null };
    }
  }
  return { ok: false };
}

/**
 * repairCatalogue — normalise explicitly named product documents.
 *
 * data: {
 *   productIds: string[]        REQUIRED. Nothing is discovered; nothing else is touched.
 *   dryRun: boolean             defaults true
 *   reassignTo: string|null     uid to become sellerUid; must own a merchant record
 *   ops: string[]               subset of NORMALISE_OPS; defaults to all of them
 * }
 */
const NORMALISE_OPS = ['normalizeTypes', 'stripInlineImages', 'rebuildSearchTerms'];

exports.repairCatalogue = onCall({ region: REGION, memory: '512MiB' }, async (req) => {
  const callerUid = requireAdmin(req);

  const ids = Array.isArray(req.data?.productIds) ? req.data.productIds.map(String) : [];
  if (!ids.length)     throw new HttpsError('invalid-argument', 'productIds is required.');
  if (ids.length > 50) throw new HttpsError('invalid-argument', 'At most 50 products per call.');

  const dryRun     = req.data?.dryRun !== false;
  const reassignTo = req.data?.reassignTo ? String(req.data.reassignTo) : null;
  const ops        = Array.isArray(req.data?.ops) ? req.data.ops : NORMALISE_OPS;

  let ownerCheck = null;
  if (reassignTo) {
    ownerCheck = await confirmOwner(reassignTo);
    if (!ownerCheck.ok) {
      throw new HttpsError('failed-precondition',
        'No merchant or business record lists ' + reassignTo + ' as ownerId. ' +
        'Reassignment refused — the target must be a verified owner, not a supplied value.');
    }
  }

  const results = [];
  let totalFreed = 0;

  for (const id of ids) {
    const ref  = db.collection('products').doc(id);
    const snap = await ref.get();
    if (!snap.exists) { results.push({ id, status: 'NOT_FOUND' }); continue; }

    const before = snap.data();
    const patch  = {};
    const notes  = [];
    let   freed  = 0;

    if (reassignTo && before.sellerUid !== reassignTo) {
      patch.sellerUid = reassignTo;
      notes.push('sellerUid ' + (before.sellerUid || '(none)') + ' → ' + reassignTo);
      /* The document keeps a record of who it used to be attributed to. A
         support question six months from now is "why did this move?", and the
         answer must live on the document rather than in a memory of this run. */
      patch.previousSellerUid = before.sellerUid || null;
      patch.reassignedAt      = F.serverTimestamp();
      patch.reassignedBy      = callerUid;
      if (ownerCheck.merchantId) patch.merchantId = ownerCheck.merchantId;
    }

    if (ops.includes('normalizeTypes')) {
      /* Strings pass through the create rule's `is number` check nowhere, and
         "2000" sorts below "300". Coerced only when the parse is unambiguous —
         a value that is not a finite number is left alone and reported, because
         silently turning junk into 0 would price a product at nothing. */
      for (const f of ['price', 'stock', 'costPrice', 'deliveryCost', 'sold', 'views']) {
        if (typeof before[f] === 'string' && before[f].trim() !== '') {
          const n = Number(before[f]);
          if (Number.isFinite(n)) { patch[f] = n; notes.push(f + ' "' + before[f] + '" → ' + n); }
          else notes.push('SKIPPED ' + f + ': "' + before[f] + '" is not numeric');
        }
      }
    }

    if (ops.includes('stripInlineImages')) {
      /* Only when Storage already holds the same images. Without that the data
         URI is the only copy and removing it destroys the product's imagery —
         a repair that loses data is not a repair. */
      const urls = Array.isArray(before.imageStorageUrls)
        ? before.imageStorageUrls.filter(u => typeof u === 'string' && u.startsWith('http')) : [];
      if (urls.length) {
        if (isDataUri(before.image)) {
          freed += String(before.image).length - String(urls[0]).length;
          patch.image = urls[0];
          notes.push('image: ' + kb(String(before.image).length) + ' data URI → Storage URL');
        }
        if (Array.isArray(before.images) && before.images.some(isDataUri)) {
          const wasBytes = before.images.reduce((a, v) => a + (typeof v === 'string' ? v.length : 0), 0);
          const nowBytes = urls.reduce((a, v) => a + v.length, 0);
          freed += wasBytes - nowBytes;
          patch.images = urls;
          notes.push('images[]: ' + before.images.filter(isDataUri).length + ' data URIs (' +
                     kb(wasBytes) + ') → ' + urls.length + ' Storage URLs');
        }
      } else if (isDataUri(before.image)) {
        notes.push('KEPT inline image — no imageStorageUrls, the data URI is the only copy');
      }
    }

    if (ops.includes('rebuildSearchTerms')) {
      /* Built from the merged document, not the stored one: a reassignment or a
         type fix changes the fields the terms derive from, and indexing the
         pre-repair values would leave the document searchable only by what it
         used to be. */
      const merged = Object.assign({}, before, patch);
      patch.searchableTerms = buildSearchTerms(merged);
      patch.nameLower       = String(merged.name || '').toLowerCase();
      /* NOT indexedAt. That field is written by the Algolia backfill as part of
         the Algolia record and means "this document is in the external index".
         Setting it here would make three products claim a membership they do not
         have, and the next reconciliation would skip them as already indexed —
         the repair would have hidden the very problem it was run to expose.
         This field says only what actually happened: the Firestore terms were
         rebuilt. External indexing remains outstanding. */
      patch.searchTermsRebuiltAt = Date.now();
      notes.push('searchableTerms rebuilt (' + patch.searchableTerms.length + ' terms) — ' +
                 'NOT indexed to Algolia/Typesense; indexedAt deliberately left absent');
    }

    const changed = Object.keys(patch).filter(k => !['reassignedAt', 'reassignedBy'].includes(k));
    if (!changed.length) { results.push({ id, name: before.name || null, status: 'NO_CHANGE' }); continue; }

    if (!dryRun) {
      patch.updatedAt = F.serverTimestamp();
      await ref.set(patch, { merge: true });
    }

    const sizeBefore = approxDocBytes(before);
    const sizeAfter  = approxDocBytes(Object.assign({}, before, patch));

    results.push({
      id, name: before.name || null,
      status: dryRun ? 'WOULD_CHANGE' : 'REPAIRED',
      fields: changed, notes,
      size: {
        beforeApprox: kb(sizeBefore),
        afterApprox:  kb(sizeAfter),
        freedApprox:  kb(freed),
        /* The share of Firestore's 1 MiB ceiling this document was using. Three
           products at a third of the limit each is the number that explains why
           a catalogue query is slow, and it is invisible in any console view. */
        pctOfDocLimitBefore: Math.round(sizeBefore / (1024 * 1024) * 100) + '%',
        pctOfDocLimitAfter:  Math.round(sizeAfter  / (1024 * 1024) * 100) + '%',
      },
    });

    totalFreed += freed;
  }

  const summary = {
    dryRun, callerUid,
    requested: ids.length,
    repaired:  results.filter(r => r.status === 'REPAIRED').length,
    wouldChange: results.filter(r => r.status === 'WOULD_CHANGE').length,
    noChange:  results.filter(r => r.status === 'NO_CHANGE').length,
    notFound:  results.filter(r => r.status === 'NOT_FOUND').length,
    bytesFreedApprox: totalFreed,
    bytesFreedHuman:  kb(totalFreed),
    reassignTo, ownerVerifiedVia: ownerCheck?.via || null,
    merchantId: ownerCheck?.merchantId || null,
    merchantName: ownerCheck?.name || null,
  };

  /* Audited only when it wrote. A dry run that left an audit entry would make
     the log claim changes that never happened, which is worse than no log. */
  if (!dryRun) {
    await db.collection('adminAudit').add({
      action: 'catalogueRepair',
      actor: callerUid,
      at: F.serverTimestamp(),
      summary,
      results,
    }).catch(() => { /* the repair already succeeded; a failed audit write must
                        not roll it back or report failure to the caller */ });
  }

  return { summary, results };
});
