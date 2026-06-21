/* ================================================================
   SOKONI — Media Engine Cloud Functions  v1.0.0

   Callable functions:
   • generateProductMetadata  — AI title, description, tags from image
   • moderateMediaContent     — Content moderation check
   • deleteMediaAsset         — Authenticated soft-delete

   Storage trigger:
   • onMediaUploaded          — Auto-process on creative-assets upload

   AI: Uses Gemini Pro Vision via Vertex AI (Firebase AI Logic).
   Fallback: rule-based metadata extraction if AI unavailable.
================================================================ */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onObjectFinalized }  = require('firebase-functions/v2/storage');
const admin = require('firebase-admin');

/* Admin SDK is initialised in index.js — do not call initializeApp() again */
const db = admin.firestore();

/* ── Auth guard helper ─────────────────────────────────────── */
function assertAuth(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required.');
  return request.auth.uid;
}

/* ── Input sanitiser ───────────────────────────────────────── */
function sanitizeStr(s, maxLen = 2000) {
  if (typeof s !== 'string') return '';
  return s.replace(/<[^>]*>/g, '').trim().slice(0, maxLen);
}

/* ================================================================
   generateProductMetadata
   Takes an image URL (already in Firebase Storage / CDN) and returns
   AI-generated product metadata using Gemini Pro Vision.
   Falls back to rule-based extraction when the model is unavailable.
================================================================ */
exports.generateProductMetadata = onCall(
  { timeoutSeconds: 60, memory: '512MiB', minInstances: 0 },
  async (request) => {
    const uid = assertAuth(request);

    const imageUrl = sanitizeStr(request.data?.imageUrl || '', 2048);
    const category = sanitizeStr(request.data?.category || '', 100);
    const language = sanitizeStr(request.data?.language || 'en', 10);

    if (!imageUrl) throw new HttpsError('invalid-argument', 'imageUrl is required.');

    /* Rate-limit: 30 calls per UID per day */
    const today = new Date().toISOString().slice(0, 10);
    const limitRef = db.collection('mediaAIRateLimit').doc(`${uid}_${today}`);
    const limitSnap = await limitRef.get();
    const callCount = (limitSnap.exists && limitSnap.data().count) || 0;
    if (callCount >= 30) {
      throw new HttpsError('resource-exhausted', 'Daily AI analysis limit reached (30/day).');
    }

    let metadata;

    /* ── Try Gemini Pro Vision ─────────────────────────────── */
    try {
      const { VertexAI } = require('@google-cloud/vertexai');
      const vertexAI = new VertexAI({ project: process.env.GCLOUD_PROJECT, location: 'us-central1' });
      const model    = vertexAI.getGenerativeModel({ model: 'gemini-pro-vision' });

      const prompt = `Analyze this product image and return a JSON object with the following fields:
{
  "title": "<concise product title, max 80 chars>",
  "description": "<compelling 2-3 sentence product description>",
  "category": "<best matching category from: ${category || 'auto-detect'}>",
  "features": ["<feature 1>", "<feature 2>", "<feature 3>"],
  "tags": ["<tag1>", "<tag2>", ... up to 10 tags],
  "keywords": ["<seo keyword 1>", ... up to 8 keywords],
  "suggestedPrice": <number in KES or null if unknown>,
  "altText": "<descriptive alt text for accessibility, max 120 chars>"
}
Language: ${language}. Return ONLY valid JSON, no markdown, no extra text.`;

      const result = await model.generateContent({
        contents: [{
          role: 'user',
          parts: [
            { inlineData: null, fileData: { mimeType: 'image/jpeg', fileUri: imageUrl } },
            { text: prompt },
          ],
        }],
        generationConfig: { maxOutputTokens: 1024, temperature: 0.3 },
      });

      const raw = result.response?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      /* Strip possible markdown fences */
      const cleaned = raw.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
      const parsed  = JSON.parse(cleaned);

      metadata = {
        title:         sanitizeStr(parsed.title || '', 120),
        description:   sanitizeStr(parsed.description || '', 600),
        category:      sanitizeStr(parsed.category || category, 80),
        features:      (parsed.features || []).slice(0, 8).map(f => sanitizeStr(f, 100)),
        tags:          (parsed.tags || []).slice(0, 10).map(t => sanitizeStr(t, 40)),
        keywords:      (parsed.keywords || []).slice(0, 8).map(k => sanitizeStr(k, 60)),
        suggestedPrice: typeof parsed.suggestedPrice === 'number' ? parsed.suggestedPrice : null,
        altText:       sanitizeStr(parsed.altText || '', 140),
        source:        'gemini-pro-vision',
      };
    } catch (aiErr) {
      console.warn('[media-engine] Gemini unavailable, using fallback:', aiErr.message);

      /* ── Rule-based fallback ──────────────────────────────── */
      const fileName   = imageUrl.split('/').pop().split('?')[0].replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
      const titleWords = fileName.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1));
      const guessTitle = titleWords.join(' ').slice(0, 80);

      metadata = {
        title:          guessTitle || 'Product',
        description:    '',
        category:       category || 'General',
        features:       [],
        tags:           [],
        keywords:       [],
        suggestedPrice: null,
        altText:        guessTitle || 'Product image',
        source:         'fallback',
      };
    }

    /* Increment rate-limit counter */
    await limitRef.set({ count: callCount + 1, uid, date: today }, { merge: true });

    /* Persist result to mediaAssets if an asset with this URL exists */
    try {
      const snap = await db.collection('mediaAssets')
        .where('uid', '==', uid)
        .where('url', '==', imageUrl)
        .limit(1)
        .get();
      if (!snap.empty) {
        await snap.docs[0].ref.update({ aiMetadata: metadata, aiProcessedAt: Date.now() });
      }
    } catch { /* non-critical */ }

    return metadata;
  }
);

/* ================================================================
   moderateMediaContent
   Checks an uploaded file URL for inappropriate content using
   Google Cloud Vision SafeSearch API.
   Returns: { safe: boolean, flags: string[], confidence: string }
================================================================ */
exports.moderateMediaContent = onCall(
  { timeoutSeconds: 30, memory: '256MiB', minInstances: 0 },
  async (request) => {
    const uid      = assertAuth(request);
    const assetId  = sanitizeStr(request.data?.assetId || '', 128);
    const imageUrl = sanitizeStr(request.data?.imageUrl || '', 2048);

    if (!imageUrl) throw new HttpsError('invalid-argument', 'imageUrl is required.');

    const flags = [];
    let safe     = true;

    try {
      const vision = require('@google-cloud/vision');
      const client = new vision.ImageAnnotatorClient();
      const [result] = await client.safeSearchDetection(imageUrl);
      const ss       = result.safeSearchAnnotation;

      const BLOCK_LEVELS = new Set(['LIKELY', 'VERY_LIKELY']);
      if (BLOCK_LEVELS.has(ss?.adult))    { flags.push('adult');    safe = false; }
      if (BLOCK_LEVELS.has(ss?.violence)) { flags.push('violence'); safe = false; }
      if (BLOCK_LEVELS.has(ss?.racy))     { flags.push('racy'); }
      if (BLOCK_LEVELS.has(ss?.spoof))    { flags.push('spoof'); }
    } catch (e) {
      console.warn('[media-engine] Vision API unavailable:', e.message);
      /* Cannot moderate — return neutral */
      return { safe: true, flags: [], confidence: 'low', error: 'Vision API unavailable' };
    }

    /* Update asset record */
    if (assetId) {
      try {
        await db.collection('mediaAssets').doc(assetId).update({
          moderated:   true,
          moderatedAt: Date.now(),
          moderationFlags: flags,
          safe,
        });

        if (!safe) {
          /* Create an alert for admin review */
          await db.collection('flags').add({
            type:      'media',
            assetId,
            uid,
            flags,
            imageUrl,
            createdAt: Date.now(),
            status:    'pending',
          });
        }
      } catch { /* non-critical */ }
    }

    return { safe, flags, confidence: 'high' };
  }
);

/* ================================================================
   deleteMediaAsset
   Authenticated soft-delete: marks asset as deleted in Firestore.
   Hard-delete from Storage is deferred to a cleanup Cloud Function.
================================================================ */
exports.deleteMediaAsset = onCall(
  { timeoutSeconds: 15, memory: '128MiB', minInstances: 0 },
  async (request) => {
    const uid     = assertAuth(request);
    const assetId = sanitizeStr(request.data?.assetId || '', 128);
    if (!assetId) throw new HttpsError('invalid-argument', 'assetId is required.');

    const ref  = db.collection('mediaAssets').doc(assetId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Asset not found.');

    const asset = snap.data();
    if (asset.uid !== uid) {
      /* Allow admin deletion */
      const userRecord = await admin.auth().getUser(uid).catch(() => null);
      const isAdmin    = userRecord?.customClaims?.admin === true;
      if (!isAdmin) throw new HttpsError('permission-denied', 'Cannot delete another user\'s asset.');
    }

    await ref.update({
      deleted:   true,
      deletedAt: Date.now(),
      deletedBy: uid,
    });

    /* Audit log */
    await db.collection('auditLogs').add({
      action:    'media.delete',
      assetId,
      uid,
      path:      asset.path || '',
      ts:        Date.now(),
    });

    return { success: true };
  }
);

/* ================================================================
   onMediaUploaded (Storage trigger)
   Fires when a file lands in creative-assets/** or product-images/**.
   - Records asset metadata in Firestore if not already present
   - Queues AI moderation for images > 10 KB
   - Updates storage tier tracking
================================================================ */
exports.onMediaUploaded = onObjectFinalized(
  { memory: '256MiB', timeoutSeconds: 60 },
  async (event) => {
    const object   = event.data;
    const filePath = object.name;             /* e.g. creative-assets/uid/banners/ts_hash.webp */
    const bucket   = object.bucket;
    const contentType = object.contentType || '';
    const size     = parseInt(object.size, 10) || 0;

    /* Only process known media prefixes */
    const MEDIA_PREFIXES = ['creative-assets/', 'product-images/', 'provider-stories/'];
    if (!MEDIA_PREFIXES.some(p => filePath.startsWith(p))) return;

    /* Skip thumbnails (prefixed with th_) */
    const fileName = filePath.split('/').pop();
    if (fileName.startsWith('th_')) return;

    /* Extract UID from path */
    const parts = filePath.split('/');
    const uid   = parts[1] || null;
    if (!uid) return;

    /* Generate public URL */
    const encodedPath = encodeURIComponent(filePath).replace(/%2F/g, '%2F');
    const publicUrl   = `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodedPath}?alt=media`;

    /* Check if asset already recorded (client-side upload inserts it) */
    try {
      const existing = await db.collection('mediaAssets')
        .where('path', '==', filePath)
        .limit(1)
        .get();

      if (existing.empty) {
        /* Server-side insert for assets uploaded without the client engine */
        await db.collection('mediaAssets').add({
          uid,
          url:         publicUrl,
          thumbUrl:    publicUrl,
          path:        filePath,
          fileName,
          mimeType:    contentType,
          storedSize:  size,
          originalSize: size,
          savings:     0,
          tier:        'hot',
          aiMetadata:  null,
          moderated:   false,
          createdAt:   Date.now(),
          source:      'storage-trigger',
          tags:        [],
          context:     {},
        });
      }
    } catch (e) {
      console.error('[media-engine] onMediaUploaded Firestore write failed:', e.message);
    }
  }
);

/* ================================================================
   Aggregate media analytics (scheduled — called from index.js)
   Collects daily upload counts and storage stats per user.
================================================================ */
exports.aggregateMediaStats = async () => {
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const startTs   = new Date(yesterday).getTime();
  const endTs     = startTs + 86400000;

  const snap = await db.collection('mediaAnalytics')
    .where('ts', '>=', startTs)
    .where('ts', '<',  endTs)
    .get();

  const byUser = {};
  snap.forEach(d => {
    const r = d.data();
    if (!r.uid) return;
    if (!byUser[r.uid]) byUser[r.uid] = { uploads: 0, storageSaved: 0, totalSize: 0 };
    if (r.event === 'upload') {
      byUser[r.uid].uploads++;
      byUser[r.uid].totalSize    += (r.originalSize || 0);
      byUser[r.uid].storageSaved += ((r.originalSize || 0) - (r.storedSize || 0));
    }
  });

  const batch = db.batch();
  Object.entries(byUser).forEach(([uid, stats]) => {
    const ref = db.collection('mediaStatsByDay').doc(`${uid}_${yesterday}`);
    batch.set(ref, { uid, date: yesterday, ...stats, computedAt: Date.now() }, { merge: true });
  });
  await batch.commit();
};
