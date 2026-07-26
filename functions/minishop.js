/* ================================================================
   SOKONI MiniShop & Social Commerce Engine  v1.0
   Firebase Cloud Functions — Gen 2, Node 22

   9 Cloud Functions:
     getMinishopPublic         — public storefront page (onRequest)
     claimMinishopHandle       — reserve a vanity handle (onCall)
     saveMinishopConfig        — save storefront settings (onCall)
     trackMinishopView         — record a page view (onRequest)
     getMinishopAnalytics      — read analytics (onCall)
     generateMinishopShareCard — build share URLs + text (onCall)
     aiGenerateMinishopContent — AI-written copy via Claude (onCall)
     followShop                — follow / unfollow a shop (onCall)
     getMyMinishop             — caller's own MiniShop summary (onCall)

   Collections (all new — no composite indexes required):
     shopHandles/{handle}
     minishopConfig/{shopId}
     minishopAnalytics/{shopId}
     shopFollowers/{shopId_uid}
     msViewRL/{ip_minute}          — IP rate-limit scratch docs
     aiGenRL/{uid_YYYYMMDD}        — AI gen rate-limit scratch docs

   Design constraints:
     • 200/200 Firestore index limit reached — every query in this
       file is a single-field lookup or doc-ID get.
     • No plaintext secrets; ANTHROPIC_API_KEY via defineSecret().
     • All onCall functions require auth first.
     • No PII in log messages.
================================================================ */

'use strict';

const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret }                  = require('firebase-functions/params');
const { getFirestore, FieldValue }      = require('firebase-admin/firestore');
const logger                            = require('firebase-functions/logger');
/* The single definition of a shop's storefront config — field list, legacy-name
   aliases, sanitisation, and the read-time merge across the two stores this
   config was historically split between. See minishop-config-schema.js. */
const { forWrite: configForWrite, resolve: resolveConfig } = require('./minishop-config-schema');

/* ── Secrets ──────────────────────────────────────────────────────────────── */
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

/* ── Constants ────────────────────────────────────────────────────────────── */
const REGION       = 'us-central1';
const BASE_URL     = 'https://mysokoni.co.ke';
const SHOP_URL     = `${BASE_URL}/shop/`;

/** Handles that cannot be claimed by sellers */
const RESERVED_HANDLES = new Set([
  'admin', 'sokoni', 'shop', 'api', 'www', 'app',
  'help', 'support', 'terms', 'privacy',
]);

/** Allowed social-traffic sources for view tracking */
const VALID_SOURCES = new Set([
  'direct', 'whatsapp', 'instagram', 'facebook',
  'tiktok', 'x', 'linkedin', 'qr', 'other',
]);

/** All whitelisted fields for minishopConfig (prevents mass-assignment) */
/* Field list moved to minishop-config-schema.js — it is now shared by the
   writer, the public reader and the prerenderer, which is the only way the
   three stay in agreement. */

/* ── Internal helpers ─────────────────────────────────────────────────────── */

/** Shorthand for the Firestore client */
const _db = () => getFirestore();

/**
 * Require Firebase Auth on an onCall request.
 * Returns the uid on success; throws HttpsError on failure.
 */
function _requireAuth(context) {
  if (!context.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Login required.');
  }
  return context.auth.uid;
}

/**
 * Strip HTML tags, trim, and truncate a string value.
 * Returns empty string for non-string inputs.
 */
function _san(s, max = 500) {
  if (typeof s !== 'string') return '';
  return s.replace(/<[^>]*>/g, '').trim().slice(0, max);
}

/**
 * Set permissive CORS headers on an onRequest response object.
 * Call this before writing any body.
 */
function _setCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
}

/**
 * Return today's date as YYYYMMDD string (UTC).
 */
function _today() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * Verify the caller owns a given shopId by checking
 * `shops/{shopId}.sellerUid == uid`.
 * Throws permission-denied if mismatch.
 */
async function _assertShopOwner(shopId, uid) {
  if (typeof shopId !== 'string' || !shopId.trim()) {
    throw new HttpsError('invalid-argument', 'shopId is required.');
  }
  const snap = await _db().collection('shops').doc(shopId).get();
  if (!snap.exists) {
    throw new HttpsError('not-found', 'Shop not found.');
  }
  if (snap.data().sellerUid !== uid) {
    throw new HttpsError('permission-denied', 'You do not own this shop.');
  }
  return snap.data();
}

/* ================================================================
   1. getMinishopPublic  (onRequest GET)
   Public storefront endpoint — no auth required.
   Query: ?handle=<handle>
================================================================ */
exports.getMinishopPublic = onRequest(
  { region: REGION, cors: false },
  async (req, res) => {
    _setCors(res);

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    const handle = (req.query.handle || '').toLowerCase().trim();
    if (!handle) {
      res.status(400).json({ error: 'handle query param is required.' });
      return;
    }

    try {
      const db = _db();

      /* 1 — Resolve handle to shopId + uid */
      const handleSnap = await db.collection('shopHandles').doc(handle).get();
      if (!handleSnap.exists) {
        res.status(404).json({ error: 'Shop handle not found.' });
        return;
      }
      const { shopId, uid } = handleSnap.data();

      /* 2 — Load shop document */
      const [shopSnap, configSnap] = await Promise.all([
        db.collection('shops').doc(shopId).get(),
        db.collection('minishopConfig').doc(shopId).get(),
      ]);

      if (!shopSnap.exists) {
        res.status(404).json({ error: 'Shop not found.' });
        return;
      }

      const shopRaw   = shopSnap.data();
      const configRaw = configSnap.exists ? configSnap.data() : {};
      const shop      = { id: shopId, ...shopRaw };

      /* Branding was historically written to shops/{id}.minishopConfig under a
         different set of key names, so reading only minishopConfig/{id} renders
         those shops with no logo, cover or tagline at all. resolve() merges the
         canonical store over the legacy one and normalises both. */
      const config = {
        ...resolveConfig(configRaw, shopRaw.minishopConfig, shopRaw),
        /* Counters share the config document but are not display config, so
           they are carried across explicitly rather than through the schema. */
        totalProducts: configRaw.totalProducts,
        followerCount: configRaw.followerCount,
      };

      // Strip sensitive seller fields before sending to public
      delete shop.sellerUid;
      delete shop.bankDetails;
      delete shop.taxPin;
      /* Remove the legacy blob so the response has exactly one config source —
         leaving it invites a consumer to read the un-normalised copy. */
      delete shop.minishopConfig;

      /* 3 — Products (single-field query: shopId == shopId, no composite) */
      const productsSnap = await db
        .collection('products')
        .where('shopId', '==', shopId)
        .limit(16)
        .get();

      const products = productsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

      /* 4 — Recent reviews (single-field query: targetId == shopId) */
      const reviewsSnap = await db
        .collection('reviews')
        .where('targetId', '==', shopId)
        .limit(6)
        .get();

      const reviews = reviewsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

      /* 5 — Total product count (field: shopId) — reuse productsSnap length
             For large stores totalProducts comes from config counter if set */
      const totalProducts = config.totalProducts ?? products.length;
      const followerCount = config.followerCount  ?? 0;

      res.status(200).json({
        shop,
        config,
        products,
        reviews,
        totalProducts,
        followerCount,
      });
    } catch (err) {
      logger.error('getMinishopPublic error', { code: err.code });
      res.status(500).json({ error: 'Failed to load storefront.' });
    }
  }
);

/* ================================================================
   2. claimMinishopHandle  (onCall)
   Reserve a vanity handle for the calling seller's shop.
================================================================ */
exports.claimMinishopHandle = onCall(
  { region: REGION, cors: true },
  async (request) => {
    const uid = _requireAuth(request);
    const { handle: rawHandle } = request.data || {};

    /* ── Validate handle ── */
    if (typeof rawHandle !== 'string') {
      throw new HttpsError('invalid-argument', 'handle must be a string.');
    }
    const handle = rawHandle.toLowerCase().trim();

    if (handle.length < 3 || handle.length > 30) {
      throw new HttpsError('invalid-argument', 'handle must be 3–30 characters.');
    }
    if (!/^[a-z0-9_-]+$/.test(handle)) {
      throw new HttpsError(
        'invalid-argument',
        'handle may only contain lowercase letters, numbers, hyphens, and underscores.'
      );
    }
    if (RESERVED_HANDLES.has(handle)) {
      throw new HttpsError('invalid-argument', `"${handle}" is a reserved name.`);
    }

    const db = _db();

    /* ── Check for existing claim ── */
    const existingSnap = await db.collection('shopHandles').doc(handle).get();
    if (existingSnap.exists) {
      const existing = existingSnap.data();
      if (existing.uid !== uid) {
        throw new HttpsError('already-exists', 'This handle is already taken.');
      }
      // Same uid — idempotent success
      const url = SHOP_URL + handle;
      return { success: true, handle, url };
    }

    /* ── Find the seller's shop (single-field query) ── */
    const shopsSnap = await db
      .collection('shops')
      .where('sellerUid', '==', uid)
      .limit(1)
      .get();

    if (shopsSnap.empty) {
      throw new HttpsError('not-found', 'No shop found for your account. Please register as a seller first.');
    }

    const shopId    = shopsSnap.docs[0].id;
    const batch     = db.batch();
    const now       = FieldValue.serverTimestamp();

    /* ── Write handle doc ── */
    batch.set(db.collection('shopHandles').doc(handle), {
      shopId,
      uid,
      handle,
      createdAt: now,
    });

    /* ── Update config with handle ── */
    batch.set(
      db.collection('minishopConfig').doc(shopId),
      { handle, updatedAt: now },
      { merge: true }
    );

    await batch.commit();

    logger.info('MiniShop handle claimed', { shopId, handle });

    const url = SHOP_URL + handle;
    return { success: true, handle, url };
  }
);

/* ================================================================
   3. saveMinishopConfig  (onCall)
   Save / update storefront appearance and settings.
================================================================ */
exports.saveMinishopConfig = onCall(
  { region: REGION, cors: true },
  async (request) => {
    const uid = _requireAuth(request);
    const { shopId, config: rawConfig } = request.data || {};

    if (typeof shopId !== 'string' || !shopId.trim()) {
      throw new HttpsError('invalid-argument', 'shopId is required.');
    }
    if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
      throw new HttpsError('invalid-argument', 'config must be an object.');
    }

    /* ── Verify ownership ── */
    await _assertShopOwner(shopId, uid);

    /* ── Normalise to the canonical schema ──────────────────────────────
       minishop-config-schema.js owns the field list, the legacy-name aliases
       and the sanitisation. It replaces the allowlist that used to live here,
       which silently dropped brandColor, responseTime, deliveryPolicy, tagline,
       location, category and fontFamily — seven fields the storefront actually
       renders — on every single save.

       normalize() also accepts the legacy names the built-in admin controller
       sends (coverImage, logoImage, phone, email, flat social keys) and folds
       them into canonical form, so both controllers now converge here. */
    const safeConfig = configForWrite(rawConfig);

    if (!Object.keys(safeConfig).length) {
      throw new HttpsError('invalid-argument', 'config contained no recognised fields.');
    }
    /* ── Persist ── */
    await _db()
      .collection('minishopConfig')
      .doc(shopId)
      .set({ ...safeConfig, updatedAt: FieldValue.serverTimestamp() }, { merge: true });

    return { success: true };
  }
);

/* ================================================================
   4. trackMinishopView  (onRequest POST)
   Record a storefront page view. No auth required.
   IP-based rate limit: 5 views per IP per minute.
================================================================ */
exports.trackMinishopView = onRequest(
  { region: REGION, cors: false },
  async (req, res) => {
    _setCors(res);

    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'POST required.' });
      return;
    }

    const { shopId, source: rawSource } = req.body || {};

    if (typeof shopId !== 'string' || !shopId.trim()) {
      res.status(400).json({ error: 'shopId is required.' });
      return;
    }
    const source = typeof rawSource === 'string' ? rawSource.toLowerCase().trim() : 'other';
    const safeSource = VALID_SOURCES.has(source) ? source : 'other';

    /* ── IP rate limit (5 views per IP per minute) ── */
    const ip     = (req.headers['x-forwarded-for'] || req.ip || 'unknown').split(',')[0].trim();
    const minute = Math.floor(Date.now() / 60000);
    const rlKey  = `${ip.replace(/[^a-zA-Z0-9]/g, '_')}_${minute}`;

    try {
      const db    = _db();
      const rlRef = db.collection('msViewRL').doc(rlKey);

      let rateLimited = false;
      await db.runTransaction(async tx => {
        const rlDoc = await tx.get(rlRef);
        const count = rlDoc.exists ? (rlDoc.data().count || 0) : 0;
        if (count >= 5) {
          rateLimited = true;
          return;
        }
        tx.set(rlRef, {
          count:     count + 1,
          ip,
          minute,
          expiresAt: FieldValue.serverTimestamp(),
        });
      });

      if (rateLimited) {
        // Silently accept (don't reveal rate limit to scrapers)
        res.status(200).json({ ok: true });
        return;
      }

      /* ── Increment analytics counters ── */
      const today   = _today();
      const incData = {
        views:                          FieldValue.increment(1),
        [`sources.${safeSource}`]:      FieldValue.increment(1),
        [`daily.${today}`]:             FieldValue.increment(1),
      };

      await db
        .collection('minishopAnalytics')
        .doc(shopId)
        .set(incData, { merge: true });

      res.status(200).json({ ok: true });
    } catch (err) {
      logger.error('trackMinishopView error', { code: err.code });
      res.status(500).json({ error: 'View tracking failed.' });
    }
  }
);

/* ================================================================
   5. getMinishopAnalytics  (onCall)
   Return analytics + follower count to the shop owner.
================================================================ */
exports.getMinishopAnalytics = onCall(
  { region: REGION, cors: true },
  async (request) => {
    const uid = _requireAuth(request);
    const { shopId } = request.data || {};

    /* Verify ownership */
    await _assertShopOwner(shopId, uid);

    const db = _db();

    const [analyticsSnap, configSnap] = await Promise.all([
      db.collection('minishopAnalytics').doc(shopId).get(),
      db.collection('minishopConfig').doc(shopId).get(),
    ]);

    const analytics    = analyticsSnap.exists ? analyticsSnap.data() : {};
    const followerCount = configSnap.exists ? (configSnap.data().followerCount ?? 0) : 0;

    return { analytics, followerCount, shopId };
  }
);

/* ================================================================
   6. generateMinishopShareCard  (onCall)
   Return pre-filled share URLs and text for all major platforms.
================================================================ */
exports.generateMinishopShareCard = onCall(
  { region: REGION, cors: true },
  async (request) => {
    const uid = _requireAuth(request);
    const { shopId, type, itemId } = request.data || {};

    if (!['shop', 'product', 'service'].includes(type)) {
      throw new HttpsError('invalid-argument', 'type must be shop, product, or service.');
    }

    /* Verify ownership */
    await _assertShopOwner(shopId, uid);

    const db = _db();

    /* Get handle from minishopConfig */
    const configSnap = await db.collection('minishopConfig').doc(shopId).get();
    const config     = configSnap.exists ? configSnap.data() : {};
    const handle     = config.handle || shopId;

    /* Build the canonical share URL */
    let shareUrl = SHOP_URL + handle;
    if ((type === 'product' || type === 'service') && itemId) {
      shareUrl += `?item=${encodeURIComponent(_san(itemId, 80))}`;
    }

    /* Fetch shop name for share text */
    const shopSnap  = await db.collection('shops').doc(shopId).get();
    const shopName  = shopSnap.exists ? (shopSnap.data().name || 'this shop') : 'this shop';

    /* Build share text */
    let shareText = '';
    switch (type) {
      case 'product':
        shareText = `Check out this product on SOKONI! ${shareUrl}`;
        break;
      case 'service':
        shareText = `Book this service from ${shopName} on SOKONI: ${shareUrl}`;
        break;
      default:
        shareText = `Shop ${shopName} on SOKONI — Kenya's leading marketplace: ${shareUrl}`;
    }

    const encodedText = encodeURIComponent(shareText);
    const encodedUrl  = encodeURIComponent(shareUrl);

    /* OG image follows a predictable CDN pattern so crawlers pick it up */
    const ogImageUrl  = `${BASE_URL}/og/shop/${handle}.png`;

    return {
      shareUrl,
      text: shareText,
      ogImageUrl,
      urls: {
        whatsapp:  `https://wa.me/?text=${encodedText}`,
        telegram:  `https://t.me/share/url?url=${encodedUrl}&text=${encodeURIComponent(shareText)}`,
        facebook:  `https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`,
        twitter:   `https://twitter.com/intent/tweet?text=${encodedText}`,
        linkedin:  `https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}`,
      },
    };
  }
);

/* ================================================================
   7. aiGenerateMinishopContent  (onCall)
   AI-written copy for shop descriptions, captions, hashtags, etc.
   Uses Claude claude-haiku-4-5-20251001 via the Anthropic SDK.
   Rate limit: 10 calls per UID per day.
================================================================ */
exports.aiGenerateMinishopContent = onCall(
  { region: REGION, cors: true, secrets: [ANTHROPIC_API_KEY] },
  async (request) => {
    const uid = _requireAuth(request);
    const { type, context: ctx } = request.data || {};

    const VALID_TYPES = new Set(['description', 'caption', 'hashtags', 'offer', 'bio']);
    if (!VALID_TYPES.has(type)) {
      throw new HttpsError(
        'invalid-argument',
        'type must be one of: description, caption, hashtags, offer, bio.'
      );
    }
    if (!ctx || typeof ctx !== 'object') {
      throw new HttpsError('invalid-argument', 'context object is required.');
    }

    /* ── Daily rate limit (10 per UID per day) ── */
    const today  = _today();
    const rlKey  = `${uid}_${today}`;
    const db     = _db();
    const rlRef  = db.collection('aiGenRL').doc(rlKey);

    let rateLimited = false;
    await db.runTransaction(async tx => {
      const rlDoc = await tx.get(rlRef);
      const count = rlDoc.exists ? (rlDoc.data().count || 0) : 0;
      if (count >= 10) {
        rateLimited = true;
        return;
      }
      tx.set(rlRef, { uid, date: today, count: count + 1 });
    });

    if (rateLimited) {
      throw new HttpsError(
        'resource-exhausted',
        'You have reached the AI generation limit (10 per day). Try again tomorrow.'
      );
    }

    /* ── Sanitize context fields ── */
    const businessName = _san(ctx.businessName || '', 80);
    const category     = _san(ctx.category     || '', 60);
    const products     = Array.isArray(ctx.products)
      ? ctx.products.slice(0, 5).map(p => _san(p, 60)).join(', ')
      : '';
    const price        = _san(String(ctx.price    || ''), 30);
    const location     = _san(ctx.location     || '', 80);

    /* ── Build prompt per content type ── */
    const prompts = {
      description: [
        `Write a professional business description for a SOKONI storefront.`,
        `Business name: ${businessName}`,
        category  ? `Category: ${category}` : '',
        products  ? `Key products/services: ${products}` : '',
        location  ? `Location: ${location}` : '',
        `Write 2–3 sentences. Sound trustworthy and inviting. No emojis.`,
      ].filter(Boolean).join('\n'),

      caption: [
        `Write an engaging social media caption for WhatsApp, Instagram, or Facebook.`,
        `Business: ${businessName}`,
        category  ? `Category: ${category}` : '',
        products  ? `Featured items: ${products}` : '',
        price     ? `Price range: ${price}` : '',
        `Keep it under 150 characters. Use 1–2 relevant emojis. End with a call to action.`,
      ].filter(Boolean).join('\n'),

      hashtags: [
        `Generate 10 relevant hashtags for a Kenyan business on SOKONI.`,
        `Business: ${businessName}`,
        category  ? `Category: ${category}` : '',
        products  ? `Products: ${products}` : '',
        location  ? `Location: ${location}` : '',
        `Return them as a single comma-separated string with no line breaks. Include #Kenya and #SOKONI.`,
      ].filter(Boolean).join('\n'),

      offer: [
        `Write a short promotional offer text for a Kenyan business.`,
        `Business: ${businessName}`,
        products  ? `Products on offer: ${products}` : '',
        price     ? `Price / discount context: ${price}` : '',
        `Keep it under 100 characters. Be compelling and specific. Add urgency.`,
      ].filter(Boolean).join('\n'),

      bio: [
        `Write a one-line business tagline for a SOKONI storefront.`,
        `Business: ${businessName}`,
        category  ? `Category: ${category}` : '',
        location  ? `Location: ${location}` : '',
        `Maximum 70 characters. No hashtags. Make it memorable.`,
      ].filter(Boolean).join('\n'),
    };

    /* ── Fallback templates (if AI call fails) ── */
    const fallbacks = {
      description: `${businessName} is a trusted ${category || 'business'} on SOKONI, Kenya's leading marketplace. We offer quality products and exceptional customer service. Visit our storefront to see our full range.`,
      caption:     `Shop ${businessName} on SOKONI! Quality ${category || 'products'} at great prices. Tap the link to shop now. 🛒`,
      hashtags:    `#Kenya, #SOKONI, #${(businessName || 'Shop').replace(/\s+/g, '')}, #${(category || 'Shopping').replace(/\s+/g, '')}, #KenyaBusiness, #OnlineShopping, #Nairobi, #MarketPlace, #BuyKenya, #ShopLocal`,
      offer:       `Limited-time offer at ${businessName}! Shop now and save big. Don't miss out! 🔥`,
      bio:         `Your trusted ${category || 'business'} destination in Kenya.`,
    };

    /* ── Call Anthropic SDK ── */
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const client    = new Anthropic.default({ apiKey: ANTHROPIC_API_KEY.value() });

      const response = await client.messages.create({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 256,
        messages:   [{ role: 'user', content: prompts[type] }],
      });

      const content = response.content?.[0]?.text?.trim() || fallbacks[type];
      return { content };
    } catch (aiErr) {
      // Log the error type but not any payload that could contain PII
      logger.warn('aiGenerateMinishopContent: AI call failed, using fallback', {
        type,
        errorCode: aiErr?.status || 'unknown',
      });
      return { content: fallbacks[type] };
    }
  }
);

/* ================================================================
   8. followShop  (onCall)
   Follow or unfollow a shop. Uses a Firestore transaction to
   keep the followerCount counter in sync atomically.
================================================================ */
exports.followShop = onCall(
  { region: REGION, cors: true },
  async (request) => {
    const uid = _requireAuth(request);
    const { shopId, follow } = request.data || {};

    if (typeof shopId !== 'string' || !shopId.trim()) {
      throw new HttpsError('invalid-argument', 'shopId is required.');
    }
    if (typeof follow !== 'boolean') {
      throw new HttpsError('invalid-argument', 'follow must be a boolean.');
    }

    const db         = _db();
    const followerRef = db.collection('shopFollowers').doc(`${shopId}_${uid}`);
    const configRef   = db.collection('minishopConfig').doc(shopId);

    const { following, followerCount } = await db.runTransaction(async tx => {
      const [followerSnap, configSnap] = await Promise.all([
        tx.get(followerRef),
        tx.get(configRef),
      ]);

      const alreadyFollowing = followerSnap.exists;
      const currentCount     = configSnap.exists ? (configSnap.data().followerCount || 0) : 0;

      if (follow && !alreadyFollowing) {
        tx.set(followerRef, {
          shopId,
          uid,
          followedAt: FieldValue.serverTimestamp(),
        });
        const newCount = currentCount + 1;
        tx.set(configRef, { followerCount: newCount, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        return { following: true, followerCount: newCount };
      }

      if (!follow && alreadyFollowing) {
        tx.delete(followerRef);
        const newCount = Math.max(0, currentCount - 1);
        tx.set(configRef, { followerCount: newCount, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        return { following: false, followerCount: newCount };
      }

      // No change — idempotent
      return { following: alreadyFollowing, followerCount: currentCount };
    });

    return { following, followerCount };
  }
);

/* ================================================================
   9. getMyMinishop  (onCall)
   Return the calling seller's own MiniShop summary.
================================================================ */
exports.getMyMinishop = onCall(
  { region: REGION, cors: true },
  async (request) => {
    const uid = _requireAuth(request);
    const db  = _db();

    /* Find the caller's shop (single-field query) */
    const shopsSnap = await db
      .collection('shops')
      .where('sellerUid', '==', uid)
      .limit(1)
      .get();

    if (shopsSnap.empty) {
      return {
        shopId:    null,
        handle:    null,
        config:    null,
        url:       null,
        hasHandle: false,
      };
    }

    const shopId    = shopsSnap.docs[0].id;
    const configSnap = await db.collection('minishopConfig').doc(shopId).get();
    const config     = configSnap.exists ? configSnap.data() : {};
    const handle     = config.handle || null;
    const url        = handle ? (SHOP_URL + handle) : null;

    return {
      shopId,
      handle,
      config,
      url,
      hasHandle: !!handle,
    };
  }
);
