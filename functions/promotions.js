/* ══════════════════════════════════════════════════════════════════════════
   SOKONI PROMOTION ENGINE  —  promotions.js

   Every promotion is DATA, not code.

   The requirement was that new campaign types must not require an architectural
   change. So there is no `if (type === 'flash_sale')` anywhere in here. A campaign
   is a document with a placement, an audience and a priority; the engine resolves
   which ones a given user sees. Adding "seasonal_ramadan" or "sponsored_service"
   is a Firestore write, not a deploy.

   This deliberately mirrors the KASS knowledge engine (kass-knowledge.js):
   versioned, draft/published, admin-managed, cached, retrieved per request. That
   is not laziness — it is the same problem (admin-controlled content that must
   change without shipping code), and two solutions to one problem is how a
   codebase rots.

   ── The rule that keeps promotion from becoming spam ──────────────────────
   A promotion engine's failure mode is not "too few promotions". It is a product
   that feels like an ad network. So:
     • Every placement has a HARD CAP. The engine cannot return more than the slot
       allows, regardless of how many campaigns are live.
     • Promotions are ranked, then truncated. Admins compete for a slot; they do
       not accumulate into one.
     • Nothing is injected into checkout or payment surfaces. Ever.

   Collections
     promotions          — campaigns (draft | published | archived)
     promotionEvents     — impressions/clicks, for ranking and reporting
═════════════════════════════════════════════════════════════════════════ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin  = require('firebase-admin');
const logger = require('firebase-functions/logger');

if (!admin.apps.length) admin.initializeApp();
const db = () => admin.firestore();

const REGION   = 'us-central1';
const COL      = 'promotions';
const COL_EV   = 'promotionEvents';

/* Placements are the ONLY thing the client knows about. A new campaign type slots
   into an existing placement; a genuinely new surface is the only thing that needs
   a code change — which is the correct boundary. */
const PLACEMENTS = {
  home_hero:        { max: 3 },
  home_strip:       { max: 6 },
  category_banner:  { max: 2 },
  search_sponsored: { max: 2 },
  merchant_promo:   { max: 4 },
  announcement:     { max: 1 },
  kass_suggestion:  { max: 2 },
};

/* Surfaces where a promotion is NEVER acceptable. A banner between a user and
   their money is how a marketplace loses trust — and conversions. */
const FORBIDDEN_PLACEMENTS = new Set(['checkout', 'payment', 'wallet', 'dispute', 'refund']);

const CACHE_MS = 3 * 60 * 1000;
let _cache = { at: 0, rows: [] };

async function _loadLive() {
  const now = Date.now();
  if (_cache.rows.length && (now - _cache.at) < CACHE_MS) return _cache.rows;
  const snap = await db().collection(COL).where('status', '==', 'published').limit(500).get();
  _cache = { at: now, rows: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
  return _cache.rows;
}

/* ── Targeting ────────────────────────────────────────────────────────────
   A promotion may target audience, county, category and role. Absent fields mean
   "no constraint" — so an untargeted campaign is global by default, which is what
   an admin expects when they leave a field blank. */
function _matches(p, ctx) {
  const now = Date.now();

  if (p.startsAt && now < Number(p.startsAt)) return false;
  if (p.endsAt   && now > Number(p.endsAt))   return false;   /* expiry is enforced here, not by a cron */

  if (p.county   && ctx.county   && p.county   !== ctx.county)   return false;
  if (p.role     && ctx.role     && p.role     !== ctx.role)     return false;
  if (p.category && ctx.category && p.category !== ctx.category) return false;

  /* audience: 'all' | 'guest' | 'user' | 'seller' | 'merchant' */
  if (p.audience && p.audience !== 'all') {
    if (p.audience === 'guest' && ctx.uid) return false;
    if (p.audience === 'user'  && !ctx.uid) return false;
    if ((p.audience === 'seller' || p.audience === 'merchant') && ctx.role !== p.audience) return false;
  }
  return true;
}

/* Ranking: explicit priority first, then measured click-through, then recency.
   CTR is used only as a tie-breaker — letting it dominate would turn the homepage
   into whatever is most clickbait-y, which is not the same as most useful. */
function _rank(a, b) {
  const pa = Number(a.priority || 0), pb = Number(b.priority || 0);
  if (pb !== pa) return pb - pa;
  const ca = (a.clicks || 0) / Math.max(1, a.impressions || 0);
  const cb = (b.clicks || 0) / Math.max(1, b.impressions || 0);
  if (cb !== ca) return cb - ca;
  return Number(b.updatedAtMs || 0) - Number(a.updatedAtMs || 0);
}

/* ── PUBLIC: what should this user see, here? ─────────────────────────────
   Callable by the client (guests included — promotions are public content). */
exports.getPromotions = onCall({ region: REGION }, async (request) => {
  const { placement, county, category, role } = request.data || {};
  const uid = (request.auth && request.auth.uid) || null;

  if (!placement) throw new HttpsError('invalid-argument', 'placement is required.');
  if (FORBIDDEN_PLACEMENTS.has(placement)) {
    /* Refuse loudly rather than silently returning []. If someone is trying to put a
       banner on checkout, that is a product decision that needs a conversation. */
    throw new HttpsError('permission-denied', `Promotions are not permitted on "${placement}".`);
  }
  const slot = PLACEMENTS[placement];
  if (!slot) throw new HttpsError('invalid-argument', `Unknown placement "${placement}".`);

  try {
    const rows = await _loadLive();
    const ctx  = { uid, county, category, role };

    const chosen = rows
      .filter(p => p.placement === placement)
      .filter(p => _matches(p, ctx))
      .sort(_rank)
      .slice(0, slot.max);          /* the cap is the product decision, enforced server-side */

    return {
      ok: true,
      placement,
      promotions: chosen.map(p => ({
        id: p.id, type: p.type, title: p.title, body: p.body,
        image: p.image || null, ctaLabel: p.ctaLabel || null, ctaUrl: p.ctaUrl || null,
        badge: p.badge || null, theme: p.theme || null,
      })),
    };
  } catch (err) {
    /* A promotion failure must NEVER break a page. Degrade to no promotions. */
    logger.warn('[promotions] resolve failed', { error: err.message, placement });
    return { ok: true, placement, promotions: [] };
  }
});

/* ── Impression / click tracking ──────────────────────────────────────────
   Counters only. No user identifiers are stored on the event — we need to know
   that a promotion works, not who saw it. */
exports.trackPromotion = onCall({ region: REGION }, async (request) => {
  const { id, event } = request.data || {};
  if (!id || !['impression', 'click'].includes(event)) {
    throw new HttpsError('invalid-argument', 'id and event (impression|click) required.');
  }
  try {
    const inc = admin.firestore.FieldValue.increment(1);
    await db().collection(COL).doc(id).update(
      event === 'click' ? { clicks: inc } : { impressions: inc }
    );
    await db().collection(COL_EV).add({
      promotionId: id, event,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    logger.warn('[promotions] track failed', { error: err.message });
  }
  return { ok: true };   /* never fail the caller over analytics */
});

/* ══════════════════════════════════════════════════════════════════════════
   ADMIN — campaign management
═════════════════════════════════════════════════════════════════════════ */
async function _assertAdmin(request) {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const snap = await db().collection('users').doc(uid).get();
  const u = snap.exists ? snap.data() : {};
  const roles = Array.isArray(u.roles) ? u.roles : (u.role ? [u.role] : []);
  if (!roles.includes('admin') && !roles.includes('superadmin')) {
    throw new HttpsError('permission-denied', 'Admin access required.');
  }
  return uid;
}

exports.promotionUpsert = onCall({ region: REGION }, async (request) => {
  const uid = await _assertAdmin(request);
  const d = request.data || {};
  if (!d.title || !d.placement) throw new HttpsError('invalid-argument', 'title and placement required.');
  if (FORBIDDEN_PLACEMENTS.has(d.placement)) {
    throw new HttpsError('permission-denied', `Promotions are not permitted on "${d.placement}".`);
  }
  if (!PLACEMENTS[d.placement]) throw new HttpsError('invalid-argument', `Unknown placement "${d.placement}".`);

  const ref = d.id ? db().collection(COL).doc(d.id) : db().collection(COL).doc();
  const prev = d.id ? await ref.get() : null;

  /* `type` is free-form ON PURPOSE. flash_sale, verified_seller, referral,
     seasonal_ramadan — the engine never branches on it, so a new campaign type
     needs no code. The client uses it only for styling. */
  await ref.set({
    type: String(d.type || 'generic').slice(0, 40),
    placement: d.placement,
    title: String(d.title).slice(0, 120),
    body: String(d.body || '').slice(0, 300),
    image: d.image || null,
    ctaLabel: d.ctaLabel || null,
    ctaUrl: d.ctaUrl || null,
    badge: d.badge || null,
    theme: d.theme || null,
    audience: d.audience || 'all',
    county: d.county || null,
    category: d.category || null,
    role: d.role || null,
    priority: Number(d.priority || 0),
    startsAt: d.startsAt ? Number(d.startsAt) : null,
    endsAt: d.endsAt ? Number(d.endsAt) : null,
    status: d.status === 'published' ? 'published' : 'draft',
    version: (prev && prev.exists ? (prev.data().version || 1) : 0) + 1,
    updatedBy: uid,
    updatedAtMs: Date.now(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  _cache = { at: 0, rows: [] };
  return { ok: true, id: ref.id };
});

exports.promotionPublish = onCall({ region: REGION }, async (request) => {
  const uid = await _assertAdmin(request);
  const { id, publish } = request.data || {};
  if (!id) throw new HttpsError('invalid-argument', 'id is required.');
  await db().collection(COL).doc(id).update({
    status: publish === false ? 'draft' : 'published',
    updatedBy: uid,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  _cache = { at: 0, rows: [] };
  return { ok: true, id };
});

exports.promotionList = onCall({ region: REGION }, async (request) => {
  await _assertAdmin(request);
  const snap = await db().collection(COL).limit(300).get();
  return {
    ok: true,
    promotions: snap.docs.map(d => {
      const p = d.data();
      const imp = p.impressions || 0, clk = p.clicks || 0;
      return {
        id: d.id, title: p.title, type: p.type, placement: p.placement,
        status: p.status, priority: p.priority, audience: p.audience,
        impressions: imp, clicks: clk,
        ctr: imp ? +(clk / imp * 100).toFixed(2) : 0,
      };
    }),
  };
});

exports.promotionArchive = onCall({ region: REGION }, async (request) => {
  const uid = await _assertAdmin(request);
  const { id } = request.data || {};
  if (!id) throw new HttpsError('invalid-argument', 'id is required.');
  await db().collection(COL).doc(id).update({
    status: 'archived', updatedBy: uid,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  _cache = { at: 0, rows: [] };
  return { ok: true, id };
});

module.exports.PLACEMENTS = PLACEMENTS;
module.exports.FORBIDDEN_PLACEMENTS = FORBIDDEN_PLACEMENTS;
