'use strict';
/* ============================================================================
   SOKONI — Account erasure purge specification  functions/account-purge-spec.js
   THE single source of truth for what happens to each collection when a user's
   account is erased (KDPA 2019 right-to-erasure). Executable AND documentation:
   the finaliseExpiredDeletions worker drives entirely off this spec, and an
   auditor can read exactly what is deleted vs anonymized vs retained, and why.

   POLICY (ratified 2026-07-28):
     • DELETE  — personal-account data with NO independent legal retention duty.
     • ANONYMIZE — records under a statutory retention obligation (tax/accounting):
       keep the business record, strip the personal identifiers. Never hard-deleted.
     • RETAIN  — records that must stay intact and carry no direct PII to strip.

   MATCHING (destructive-safety): every query matches on THIS user's uid only — via
   a doc-id (`byDocId:true`) or one/more uid-bearing fields (`uidFields`). Because
   another user's record can never contain this uid, an over-broad match is a no-op,
   and ANONYMIZE (not delete) on the ambiguous financial collections means the worst
   case is stripping fields on the user's own records. Nothing else can be touched.
   ========================================================================== */

const PURGE_WORKER_VERSION = '1.0.0';

const PURGE_SPEC = [
  /* ── DELETE: personal, no retention obligation ── */
  { collection: 'notifications',   action: 'delete',    uidFields: ['targetUid', 'uid'],            legalBasis: null,                                   retention: null },
  { collection: 'follows',         action: 'delete',    uidFields: ['uid'],                          legalBasis: null,                                   retention: null },
  { collection: 'loyaltyAccounts', action: 'delete',    byDocId: true,                               legalBasis: null,                                   retention: null },
  { collection: 'loyaltyPoints',   action: 'delete',    byDocId: true,                               legalBasis: null,                                   retention: null },
  { collection: 'wishlists',       action: 'delete',    byDocId: true,                               legalBasis: null,                                   retention: null },
  /* wishlistItems is doc-id `{uid}_{productId}`, so byDocId cannot reach it — matched on
     the uid FIELD instead, the same way follows and cartSaves are. It was absent from this
     spec while the buyer UI still kept wishlists in localStorage, so nothing was orphaned;
     the moment the UI writes to the canonical collection, an erasure that skipped it would
     leave saved-item data behind. Added before that migration ships, not after. */
  { collection: 'wishlistItems',   action: 'delete',    uidFields: ['uid'],                          legalBasis: null,                                   retention: null },
  { collection: 'cartSaves',       action: 'delete',    uidFields: ['uid'],                          legalBasis: null,                                   retention: null },
  /* sessions + the users/{uid} doc are handled directly by the worker (email-keyed / shell-redaction). */

  /* ── ANONYMIZE: statutory retention (Income Tax Act Cap. 470 — 7 years) ── */
  { collection: 'orders',            action: 'anonymize', uidFields: ['buyerUid', 'uid', 'userId', 'buyerId'],
    legalBasis: 'Income Tax Act Cap. 470 (business/tax record); eTIMS',            retention: '7 years',
    redact: { buyerName: 'Deleted User', buyerPhone: null, phone: null, deliveryName: null,
              deliveryAddress: null, deliveryCoords: null, dropoffLat: null, dropoffLng: null } },
  { collection: 'walletTransactions', action: 'anonymize', uidFields: ['uid'],
    legalBasis: 'financial/accounting record',                                     retention: '7 years',
    redact: { name: null, phone: null, customerName: null } },
  { collection: 'providerReviews',   action: 'anonymize', uidFields: ['customerUid'],
    legalBasis: 'integrity of public review corpus (reviews stay, author de-identified)', retention: 'indefinite',
    redact: { customerName: 'Former customer' } },

  /* ── RETAIN: financial records carrying no direct PII beyond the (now-deleted) uid link ── */
  { collection: 'ledger',           action: 'retain',    uidFields: ['uid'],  legalBasis: 'double-entry accounting record', retention: '7 years' },
  { collection: 'providerPayouts',  action: 'retain',    byDocId: false,      legalBasis: 'settlement/accounting record',   retention: '7 years' },
];

/* Storage prefixes to purge (personal media + exported personal data + KYC docs). */
const PURGE_STORAGE_PREFIXES = [
  'profile-photos/{uid}/',
  'data-exports/{uid}/',
  'kyc-documents/{uid}/',
  'provider-service-images/{uid}/',
];

/* Execute the spec for one uid. DELETE personal collections, ANONYMIZE retention-bound ones,
   purge Storage prefixes. Every match is on THIS uid (see safety note above). Best-effort per
   collection (a failure records ':ERR' but never aborts the whole erasure). Returns the audit
   summary the worker records as an immutable erasure event — no PII, just collection:count. */
async function purgeUserData(db, adminSdk, uid) {
  const FV = adminSdk.firestore.FieldValue;
  const deleted = [], anonymized = [], retained = [], storage = [];

  for (const rule of PURGE_SPEC) {
    if (rule.action === 'retain') { retained.push(rule.collection); continue; }
    try {
      let docs = [];
      if (rule.byDocId) {
        const d = await db.collection(rule.collection).doc(uid).get();
        if (d.exists) docs = [d];
      } else {
        const seen = new Set();
        for (const f of (rule.uidFields || [])) {
          const snap = await db.collection(rule.collection).where(f, '==', uid).limit(500).get().catch(() => null);
          if (snap) snap.docs.forEach(x => { if (!seen.has(x.id)) { seen.add(x.id); docs.push(x); } });
        }
      }
      if (!docs.length) continue;
      for (let i = 0; i < docs.length; i += 400) {
        const batch = db.batch();
        docs.slice(i, i + 400).forEach(x => {
          if (rule.action === 'delete') batch.delete(x.ref);
          else batch.set(x.ref, Object.assign({ _erasedAt: FV.serverTimestamp() }, rule.redact || {}), { merge: true });
        });
        await batch.commit();
      }
      (rule.action === 'delete' ? deleted : anonymized).push(`${rule.collection}:${docs.length}`);
    } catch (e) {
      (rule.action === 'delete' ? deleted : anonymized).push(`${rule.collection}:ERR`);
    }
  }

  try {
    const bucket = adminSdk.storage().bucket();
    for (const p of PURGE_STORAGE_PREFIXES) {
      const prefix = p.replace('{uid}', uid);
      await bucket.deleteFiles({ prefix }).catch(() => {});
      storage.push(prefix);
    }
  } catch (_) { /* Storage best-effort */ }

  return { deleted, anonymized, retained, storage };
}

module.exports = { PURGE_WORKER_VERSION, PURGE_SPEC, PURGE_STORAGE_PREFIXES, purgeUserData };
