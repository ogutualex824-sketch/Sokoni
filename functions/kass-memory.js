/* ══════════════════════════════════════════════════════════════════════════
   KASS MEMORY  —  kass-memory.js

   Remembers enough to stop asking the user the same thing twice. Nothing more.

   ── The privacy position, stated plainly ─────────────────────────────────
   This stores DERIVED PREFERENCES, not conversation transcripts.

   Kenya's Data Protection Act 2019 applies here, and beyond compliance there is
   a simple product argument: an assistant that quietly retains everything you
   ever said to it is not a concierge, it is surveillance. So:

   • Authenticated users only. No profiling of anonymous visitors.
   • A short allowlist of fields. Anything not on it is not stored — the schema
     is the privacy policy, enforced in code rather than in a document.
   • NEVER stored: message transcripts, payment details, ID numbers, phone
     numbers, addresses, health/legal enquiry content, or anything a user typed
     verbatim. Free text is where the sensitive things hide.
   • Rolling window: recent categories/searches only, capped and overwritten.
     Memory that only ever grows is a liability that only ever grows.
   • The user can see it (kassMemoryGet) and erase it (kassMemoryForget). If a
     user cannot delete it, you should not be keeping it.

   Memory is a CONVENIENCE, never an authority. It records that someone tends to
   buy electronics — never that their payment succeeded or their refund is due.
   Those must always be read live from a tool.

   Collection: kassMemory/{uid}
═════════════════════════════════════════════════════════════════════════ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin  = require('firebase-admin');
const logger = require('firebase-functions/logger');

if (!admin.apps.length) admin.initializeApp();
const db = () => admin.firestore();

const REGION = 'us-central1';
const COL    = 'kassMemory';

/* The allowlist IS the privacy boundary. To store something new, you must add it
   here deliberately — you cannot do it by accident. */
const ALLOWED = new Set([
  'preferredLanguage',   // 'en' | 'sw' | 'sheng' | 'mixed'
  'favouriteCategories', // string[] — derived, capped
  'recentSearches',      // string[] — capped, rolling
  'favouriteSellers',    // string[] — seller ids/names
  'businessType',        // e.g. 'retail shop', 'electronics'
  'deliveryPreference',  // e.g. 'pickup', 'boda', 'courier'
  'county',              // coarse location only — county, never a street address
]);

const CAP_LIST   = 8;     /* keep it small: this is injected into every prompt */
const CAP_STRING = 60;

function _clean(patch) {
  const out = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (!ALLOWED.has(k)) continue;                       /* silently drop anything off-list */
    if (Array.isArray(v)) {
      out[k] = v.filter(x => typeof x === 'string')
                .map(x => x.trim().slice(0, CAP_STRING))
                .filter(Boolean)
                .slice(0, CAP_LIST);
    } else if (typeof v === 'string') {
      out[k] = v.trim().slice(0, CAP_STRING);
    }
    /* numbers/objects/nested data are not accepted — nothing needs them, and they
       are how transcripts and PII would sneak in. */
  }
  return out;
}

/* ── Read for the prompt ──────────────────────────────────────────────────
   Returns a short human-readable block, or '' when there is nothing worth saying.
   Guests get nothing: no uid, no memory, no profiling. */
async function loadForPrompt(uid) {
  if (!uid) return '';
  try {
    const snap = await db().collection(COL).doc(uid).get();
    if (!snap.exists) return '';
    const m = snap.data() || {};

    const lines = [];
    if (m.preferredLanguage)               lines.push(`Preferred language: ${m.preferredLanguage}`);
    if (m.county)                          lines.push(`County: ${m.county}`);
    if (m.businessType)                    lines.push(`Business: ${m.businessType}`);
    if (m.deliveryPreference)              lines.push(`Delivery preference: ${m.deliveryPreference}`);
    if ((m.favouriteCategories || []).length) lines.push(`Usually buys: ${m.favouriteCategories.join(', ')}`);
    if ((m.favouriteSellers || []).length)    lines.push(`Trusted sellers: ${m.favouriteSellers.join(', ')}`);
    if ((m.recentSearches || []).length)      lines.push(`Recently searched: ${m.recentSearches.slice(0, 4).join('; ')}`);

    if (!lines.length) return '';

    return `\n\n━━━ WHAT YOU REMEMBER ABOUT THIS USER ━━━
${lines.join('\n')}

Use this to avoid re-asking what you already know, and to personalise. Do NOT recite it back at them —
being told what a system has stored about you is unsettling, not helpful. It is context, not content.
It is also NOT authoritative: never infer an order, payment or account state from it. Read those live.`;
  } catch (err) {
    /* Memory is an enhancement. If it fails, KASS still works — it just asks. */
    logger.warn('[KASS] memory load failed', { error: err.message });
    return '';
  }
}

/* ── Write (server-side, from observed behaviour) ─────────────────────────
   Merged, capped, and stamped. Called by the platform, not by the model — an
   LLM should not be able to write its own long-term memory about a user. */
/* Rolling lists: newest first, de-duplicated, capped.

   A plain set({merge:true}) REPLACES an array rather than appending, so
   `recentSearches` would only ever hold the single latest query — not a history.
   These fields must roll, so they are read-merged.

   The cap is the point, not an afterthought: an unbounded history is both a
   privacy liability and prompt bloat on every turn. */
const ROLLING = new Set(['recentSearches', 'favouriteCategories', 'favouriteSellers']);

async function remember(uid, patch) {
  if (!uid) return;
  const clean = _clean(patch);
  if (!Object.keys(clean).length) return;

  const ref = db().collection(COL).doc(uid);
  try {
    const rollingKeys = Object.keys(clean).filter(k => ROLLING.has(k));

    if (rollingKeys.length) {
      const snap = await ref.get();
      const prev = snap.exists ? (snap.data() || {}) : {};
      for (const k of rollingKeys) {
        const merged = [...clean[k], ...(Array.isArray(prev[k]) ? prev[k] : [])];
        clean[k] = [...new Set(merged.map(s => s.toLowerCase()))]   /* de-dupe, case-insensitive */
          .slice(0, CAP_LIST);                                       /* newest first, capped */
      }
    }

    await ref.set({
      ...clean,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  } catch (err) {
    logger.warn('[KASS] memory write failed', { error: err.message });
  }
}

/* ── User-facing controls (Kenya DPA 2019: access + erasure) ─────────────── */

exports.kassMemoryGet = onCall({ region: REGION }, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const snap = await db().collection(COL).doc(uid).get();
  return { ok: true, memory: snap.exists ? snap.data() : {} };
});

/* Full erasure, not a soft flag. "Forget me" must actually forget. */
exports.kassMemoryForget = onCall({ region: REGION }, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  await db().collection(COL).doc(uid).delete();
  logger.info('[KASS] memory erased at user request', { uid: uid.slice(0, 8) });
  return { ok: true, erased: true };
});

/* Let a user correct what KASS believes about them. */
exports.kassMemorySet = onCall({ region: REGION }, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const clean = _clean(request.data || {});
  if (!Object.keys(clean).length) throw new HttpsError('invalid-argument', 'No storable fields provided.');
  await db().collection(COL).doc(uid).set({
    ...clean, updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  return { ok: true, stored: Object.keys(clean) };
});

module.exports.loadForPrompt = loadForPrompt;
module.exports.remember = remember;
module.exports.ALLOWED = ALLOWED;
