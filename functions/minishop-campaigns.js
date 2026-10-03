'use strict';
/**
 * MiniShop Campaign Engine v1.0
 * Trackable campaign links with click/conversion analytics.
 * Collections: minishopCampaigns/{campaignId}
 * All queries: doc-ID or single-field — no composite indexes needed.
 */
const { onCall, onRequest } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');

// ── Helpers ──────────────────────────────────────────────────────────────────

function _requireAuth(ctx) {
  if (!ctx.auth) throw new Error('UNAUTHENTICATED: Login required');
}

function _san(s, max = 200) {
  if (!s) return '';
  return String(s).replace(/<[^>]*>/g, '').trim().slice(0, max);
}

function _cors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
}

const CAMPAIGN_TYPES = ['flash-sale', 'weekend-sale', 'holiday', 'new-arrivals', 'referral', 'back-to-school', 'black-friday', 'custom'];

// ── 1. createMinishopCampaign ─────────────────────────────────────────────────
exports.createMinishopCampaign = onCall({ cors: true }, async (request) => {
  _requireAuth(request);
  const uid = request.auth.uid;
  const { shopId, name, type, description, targetUrl, startsAt, endsAt } = request.data || {};

  if (!shopId || typeof shopId !== 'string') throw new Error('shopId required');
  if (!name || typeof name !== 'string' || name.trim().length < 2) throw new Error('Campaign name required (min 2 chars)');
  if (type && !CAMPAIGN_TYPES.includes(type)) throw new Error('Invalid campaign type');

  const db = getFirestore();

  // Verify caller owns the shop
  const shopSnap = await db.collection('shops').doc(shopId).get();
  if (!shopSnap.exists || shopSnap.data().sellerUid !== uid) {
    throw new Error('PERMISSION_DENIED: Not your shop');
  }

  // Get the minishop handle
  const configSnap = await db.collection('minishopConfig').doc(shopId).get();
  const handle = configSnap.exists ? (configSnap.data().handle || '') : '';

  // Build campaign slug (used in URL)
  const slug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
  const campaignId = `${shopId}_${Date.now()}_${slug}`;

  // Build the campaign URL
  const shopUrl = handle
    ? `https://mysokoni.co.ke/shop/${handle}`
    : `https://mysokoni.co.ke/shop?shopId=${shopId}`;
  const campaignUrl = `${shopUrl}?utm_source=campaign&utm_campaign=${encodeURIComponent(slug)}&utm_medium=minishop`;

  const campaign = {
    campaignId,
    shopId,
    uid,
    handle,
    name: _san(name, 100),
    slug,
    type: type || 'custom',
    description: _san(description, 500),
    targetUrl: targetUrl ? _san(targetUrl, 500) : shopUrl,
    campaignUrl,
    status: 'active',
    clicks: 0,
    views: 0,
    orders: 0,
    revenue: 0,
    createdAt: Timestamp.now(),
    startsAt: startsAt ? Timestamp.fromMillis(startsAt) : Timestamp.now(),
    endsAt: endsAt ? Timestamp.fromMillis(endsAt) : null
  };

  await db.collection('minishopCampaigns').doc(campaignId).set(campaign);

  return {
    success: true,
    campaignId,
    campaignUrl,
    slug,
    shareLinks: {
      whatsapp: `https://wa.me/?text=${encodeURIComponent(`Check out our ${campaign.name}! ${campaignUrl}`)}`,
      facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(campaignUrl)}`,
      x: `https://x.com/intent/tweet?text=${encodeURIComponent(campaign.name)}&url=${encodeURIComponent(campaignUrl)}`,
      telegram: `https://t.me/share/url?url=${encodeURIComponent(campaignUrl)}&text=${encodeURIComponent(campaign.name)}`,
      instagram: campaignUrl // Instagram doesn't support direct share links
    }
  };
});

// ── 2. getMinishopCampaigns ───────────────────────────────────────────────────
exports.getMinishopCampaigns = onCall({ cors: true }, async (request) => {
  _requireAuth(request);
  const uid = request.auth.uid;
  const { shopId, status } = request.data || {};

  if (!shopId) throw new Error('shopId required');

  const db = getFirestore();

  // Verify ownership
  const shopSnap = await db.collection('shops').doc(shopId).get();
  if (!shopSnap.exists || shopSnap.data().sellerUid !== uid) {
    throw new Error('PERMISSION_DENIED: Not your shop');
  }

  // Single-field query — no composite index needed
  let query = db.collection('minishopCampaigns').where('shopId', '==', shopId);
  const snap = await query.limit(50).get();

  let campaigns = snap.docs.map(d => {
    const data = d.data();
    return {
      campaignId: data.campaignId,
      name: data.name,
      type: data.type,
      slug: data.slug,
      status: data.status,
      campaignUrl: data.campaignUrl,
      clicks: data.clicks || 0,
      views: data.views || 0,
      orders: data.orders || 0,
      revenue: data.revenue || 0,
      createdAt: data.createdAt?._seconds || null,
      startsAt: data.startsAt?._seconds || null,
      endsAt: data.endsAt?._seconds || null,
      roi: data.revenue > 0 ? ((data.orders / Math.max(data.clicks, 1)) * 100).toFixed(1) + '%' : '0%'
    };
  });

  // Filter by status in JS (avoids composite index)
  if (status && status !== 'all') {
    campaigns = campaigns.filter(c => c.status === status);
  }

  // Sort by createdAt desc in JS
  campaigns.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  return { campaigns, total: campaigns.length };
});

// ── 3. trackCampaignClick ─────────────────────────────────────────────────────
exports.trackCampaignClick = onRequest(async (req, res) => {
  _cors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  const { campaignId, shopId, event = 'click' } = req.body || {};
  if (!campaignId || !shopId) { res.status(200).json({ ok: true }); return; }

  // Validate event type
  const validEvents = ['click', 'view', 'order'];
  const safeEvent = validEvents.includes(event) ? event : 'click';

  try {
    const db = getFirestore();
    const docRef = db.collection('minishopCampaigns').doc(campaignId);

    // Rate limit: max 10 clicks per IP per campaign per hour
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim().slice(0, 45);
    const rlKey = `${campaignId}_${ip}_${Math.floor(Date.now() / 3600000)}`;
    const rlRef = db.collection('campaignClickRL').doc(rlKey);

    const rlOk = await db.runTransaction(async t => {
      const rlSnap = await t.get(rlRef);
      const count = rlSnap.exists ? (rlSnap.data().count || 0) : 0;
      if (count >= 10) return false;
      t.set(rlRef, { count: count + 1, ip, updatedAt: Timestamp.now() }, { merge: true });
      return true;
    });

    if (rlOk) {
      const update = { [`${safeEvent}s`]: FieldValue.increment(1) };
      await docRef.update(update);
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    // Silent — analytics should never break the user experience
    res.status(200).json({ ok: true });
  }
});

// ── 4. pauseMinishopCampaign ──────────────────────────────────────────────────
exports.pauseMinishopCampaign = onCall({ cors: true }, async (request) => {
  _requireAuth(request);
  const uid = request.auth.uid;
  const { campaignId, pause = true } = request.data || {};

  if (!campaignId) throw new Error('campaignId required');

  const db = getFirestore();
  const docSnap = await db.collection('minishopCampaigns').doc(campaignId).get();
  if (!docSnap.exists || docSnap.data().uid !== uid) {
    throw new Error('PERMISSION_DENIED: Not your campaign');
  }

  await db.collection('minishopCampaigns').doc(campaignId).update({
    status: pause ? 'paused' : 'active',
    updatedAt: Timestamp.now()
  });

  return { success: true, status: pause ? 'paused' : 'active' };
});

// ── 5. deleteMinishopCampaign ─────────────────────────────────────────────────
exports.deleteMinishopCampaign = onCall({ cors: true }, async (request) => {
  _requireAuth(request);
  const uid = request.auth.uid;
  const { campaignId } = request.data || {};

  if (!campaignId) throw new Error('campaignId required');

  const db = getFirestore();
  const docSnap = await db.collection('minishopCampaigns').doc(campaignId).get();
  if (!docSnap.exists || docSnap.data().uid !== uid) {
    throw new Error('PERMISSION_DENIED: Not your campaign');
  }

  await db.collection('minishopCampaigns').doc(campaignId).delete();
  return { success: true };
});
