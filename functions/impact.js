/* ============================================================
   SOKONI Impact — Enterprise Social Impact Platform
   Cloud Functions v1.0
   Financial architecture: segregated Foundation ledger,
   double-entry accounting, multi-level disbursement approval,
   corporate giving, campaigns, grants, scholarships, badges.
============================================================ */

'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const { defineSecret }       = require('firebase-functions/params');
const admin  = require('firebase-admin');
const crypto = require('crypto');
const https  = require('https');

const INTASEND_PRIVATE_KEY = defineSecret('INTASEND_PRIVATE_KEY');
const SENDGRID_API_KEY     = defineSecret('SENDGRID_API_KEY');

/* ── helpers ─────────────────────────────────────────────── */
const fdb     = () => admin.firestore();
const _now    = () => admin.firestore.FieldValue.serverTimestamp();
const _incr   = (n) => admin.firestore.FieldValue.increment(n);
const _san    = (s, max = 500) => String(s || '').replace(/[<>]/g, '').trim().slice(0, max);
const _esc    = (s) => String(s || '').replace(/[<>"'&]/g, c => ({ '<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','&':'&amp;' })[c]);
const _phone  = (p) => String(p || '').replace(/\D/g, '').replace(/^0/, '254').replace(/^254254/, '254');
const _isAdmin = (auth) => auth && (auth.token?.admin === true || auth.token?.superAdmin === true || ['admin','superAdmin'].includes(auth.token?.role));
const _uid    = (auth) => auth && auth.uid;

/* Receipt number */
const _txnId = (prefix = 'IMP') => {
  const ymd  = new Date().toISOString().slice(0,10).replace(/-/g,'');
  const rand = crypto.randomBytes(5).toString('hex').toUpperCase();
  return `${prefix}-${ymd}-${rand}`;
};

/* Rate limit */
async function _rateLimit(key, max, windowMs) {
  const ref  = fdb().collection('_rateLimits').doc(key);
  const snap = await ref.get();
  const now  = Date.now();
  if (snap.exists) {
    const { count, windowStart } = snap.data();
    if (now - windowStart < windowMs) {
      if (count >= max) return false;
      await ref.update({ count: _incr(1) });
    } else { await ref.set({ count: 1, windowStart: now }); }
  } else { await ref.set({ count: 1, windowStart: now }); }
  return true;
}

/* ════════════════════════════════════════════════════════════
   FINANCIAL LEDGER — core accounting function
   All money movements write here first.
════════════════════════════════════════════════════════════ */

async function _writeLedgerEntry(txn, {
  type,      /* donation | marketplace_contribution | corporate | disbursement | fee | refund | roundup | grant | scholarship */
  debit,     /* money leaving Foundation (0 if credit) */
  credit,    /* money entering Foundation (0 if debit) */
  uid,       /* user who triggered it */
  campaignId,
  orderId,
  paymentRef,
  description,
  meta,
}) {
  const entryRef = fdb().collection('impactLedger').doc(_txnId('LED'));
  const balRef   = fdb().collection('impactBalance').doc('current');

  const balSnap  = await txn.get(balRef);
  const prev     = balSnap.exists ? (balSnap.data().balance || 0) : 0;
  const newBal   = prev + (credit || 0) - (debit || 0);

  txn.set(entryRef, {
    type, debit: debit || 0, credit: credit || 0,
    balanceBefore: prev, balanceAfter: newBal,
    uid: uid || null, campaignId: campaignId || null,
    orderId: orderId || null, paymentRef: paymentRef || null,
    description: _san(description, 300), meta: meta || {},
    status: 'completed', createdAt: _now(),
  });

  txn.set(balRef, {
    balance:         newBal,
    totalReceived:   _incr(credit || 0),
    totalDisbursed:  _incr(type === 'disbursement' ? debit : 0),
    totalFees:       _incr(type === 'fee' ? debit : 0),
    lastUpdated:     _now(),
  }, { merge: true });

  return newBal;
}

/* ══════════════════════════════════════════════════════════
   1. impactGetPublicDashboard — live public transparency
══════════════════════════════════════════════════════════ */
exports.impactGetPublicDashboard = onCall(
  { timeoutSeconds: 20, enforceAppCheck: true },
  async () => {
    const [balSnap, statsSnap, campaignSnap, recentSnap, corporateSnap] = await Promise.all([
      fdb().collection('impactBalance').doc('current').get(),
      fdb().collection('foundationStats').doc('current').get(),
      fdb().collection('impactCampaigns').where('status','==','active').orderBy('raised','desc').limit(6).get(),
      fdb().collection('impactLedger').where('credit','>',0).orderBy('credit','desc').orderBy('createdAt','desc').limit(5).get(),
      fdb().collection('impactCorporate').where('status','==','active').limit(20).get(),
    ]);

    const bal   = balSnap.exists   ? balSnap.data()   : {};
    const stats = statsSnap.exists ? statsSnap.data() : {};

    const campaigns = campaignSnap.docs.map(d => {
      const c = d.data();
      return {
        id: d.id, title: c.title, description: c.description, coverImage: c.coverImage,
        goal: c.goal, raised: c.raised || 0, category: c.category,
        daysLeft: c.daysLeft, verified: c.verified, beneficiaries: c.beneficiaries,
        location: c.location, urgent: c.urgent,
      };
    });

    const recent = recentSnap.docs.map(d => {
      const e = d.data();
      return { amount: e.credit, type: e.type, description: e.description, createdAt: e.createdAt };
    });

    const corporate = corporateSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    return {
      ok: true,
      balance: {
        /* VERIFIED money only (2026-10-01). balance − verifiedBalance is money RECORDED without provider proof:
           shown as "requires reconciliation", never as donated or available. */
        available:     Math.max(0, (Number(bal.verifiedBalance) || 0) - (Number(bal.reservedKES) || 0)),
        verified:      Number(bal.verifiedBalance) || 0,
        requiresReconciliation: Math.max(0, (Number(bal.balance) || 0) - (Number(bal.verifiedBalance) || 0)),
        totalReceived: bal.totalReceived || 0,
        totalDisbursed:bal.totalDisbursed || 0,
        totalFees:     bal.totalFees || 0,
        adminCostPct:  bal.totalReceived > 0 ? ((bal.totalFees || 0) / bal.totalReceived * 100).toFixed(1) : '0',
      },
      stats,
      campaigns,
      recentActivity: recent,
      corporate,
    };
  }
);

/* ══════════════════════════════════════════════════════════
   2. impactGetUserProfile — personal impact profile
══════════════════════════════════════════════════════════ */
exports.impactGetUserProfile = onCall(
  { timeoutSeconds: 15, enforceAppCheck: true },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
    const uid = request.auth.uid;

    const [profileSnap, donSnap, badgeSnap, roundupSnap] = await Promise.all([
      fdb().collection('impactUserProfiles').doc(uid).get(),
      fdb().collection('foundationDonations').where('uid','==',uid).where('status','==','completed').get(),
      fdb().collection('impactBadges').where('uid','==',uid).get(),
      fdb().collection('impactRoundupSettings').doc(uid).get(),
    ]);

    /* Compute live aggregates from donations */
    let totalDonated = 0, treesPlanted = 0, mealsFunded = 0, studentsSupported = 0;
    donSnap.docs.forEach(d => {
      const don = d.data();
      totalDonated += don.amount || 0;
      /* Impact conversion rates */
      if ((don.destination||'').toLowerCase().includes('environment') || (don.destination||'').toLowerCase().includes('tree')) {
        treesPlanted += Math.floor((don.amount || 0) / 100);
      }
      if ((don.destination||'').toLowerCase().includes('food') || (don.destination||'').toLowerCase().includes('meal')) {
        mealsFunded += Math.floor((don.amount || 0) / 50);
      }
      if ((don.destination||'').toLowerCase().includes('education') || (don.destination||'').toLowerCase().includes('scholar')) {
        studentsSupported += Math.floor((don.amount || 0) / 500);
      }
    });

    const profile = profileSnap.exists ? profileSnap.data() : {};
    const badges  = badgeSnap.docs.map(d => d.data());

    /* Auto-award badges */
    const earnedBadges = await _checkAndAwardBadges(uid, totalDonated, donSnap.docs.length, badges);

    return {
      ok: true,
      profile: {
        ...profile,
        totalDonated, treesPlanted, mealsFunded, studentsSupported,
        donationCount:    donSnap.docs.length,
        projectsSupported: [...new Set(donSnap.docs.map(d => d.data().destination))].length,
        badges:           badges.concat(earnedBadges),
        roundupEnabled:   roundupSnap.exists ? roundupSnap.data().enabled : false,
        roundupTarget:    roundupSnap.exists ? roundupSnap.data().target : 10,
      },
    };
  }
);

/* Badge award helper */
async function _checkAndAwardBadges(uid, totalDonated, donCount, existingBadges) {
  const earnedKeys = new Set(existingBadges.map(b => b.key));
  const toAward = [];

  const defs = [
    { key: 'first_donation',    label: 'First Donation',    emoji: '💛', condition: donCount >= 1 },
    { key: 'bronze_supporter',  label: 'Bronze Supporter',  emoji: '🥉', condition: totalDonated >= 500 },
    { key: 'silver_supporter',  label: 'Silver Supporter',  emoji: '🥈', condition: totalDonated >= 2500 },
    { key: 'gold_supporter',    label: 'Gold Supporter',    emoji: '🥇', condition: totalDonated >= 10000 },
    { key: 'platinum_supporter',label: 'Platinum Supporter',emoji: '💎', condition: totalDonated >= 50000 },
    { key: 'community_builder', label: 'Community Builder', emoji: '🏘', condition: donCount >= 10 },
  ];

  const batch = fdb().batch();
  for (const def of defs) {
    if (def.condition && !earnedKeys.has(def.key)) {
      const ref = fdb().collection('impactBadges').doc(`${uid}_${def.key}`);
      batch.set(ref, { uid, key: def.key, label: def.label, emoji: def.emoji, awardedAt: _now() });
      toAward.push(def);
    }
  }
  if (toAward.length) await batch.commit();
  return toAward;
}

/* ══════════════════════════════════════════════════════════
   3. impactCheckoutDonate — optional donation at checkout
   Called by checkout.html when user opts in
══════════════════════════════════════════════════════════ */
exports.impactCheckoutDonate = onCall(
  { timeoutSeconds: 20, enforceAppCheck: true },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
    const uid = request.auth.uid;
    const { amount, orderId, destination, type } = request.data || {};

    const amt = Math.round(Number(amount) || 0);
    if (amt < 1)  return { ok: true, skipped: true }; /* no-op if zero */
    if (amt > 100000) throw new HttpsError('invalid-argument', 'Donation too large for checkout add-on.');

    /* ── A CHECKOUT DONATION IS A PLEDGE UNTIL MONEY IS CONFIRMED (2026-10-01) ──────────────────
       This wrote status 'completed', credited the Foundation ledger and bumped foundationStats for
       ANY amount 1–100,000 the caller named, without looking at the order or its payment — any
       signed-in user could mint "completed" donations (and ledger balance that feeds
       impactDisbursements) with no money behind them. That breaks the server-confirmed-payment rule.
       Now: the order must exist and belong to the caller; ONE pledge per order (doc id CHK_<orderId>,
       created once); status 'pledged'; NO ledger entry, NO stats. A pledge becomes a completed
       donation only when a server-verified payment that actually includes it is recorded — that
       completion step belongs to the payment authority and is not performed here. */
    const oid = String(orderId || '');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(oid)) throw new HttpsError('invalid-argument', 'A valid orderId is required.');
    const ordSnap = await fdb().collection('orders').doc(oid).get();
    if (!ordSnap.exists) throw new HttpsError('not-found', 'Order not found.');
    const ord = ordSnap.data() || {};
    const buyer = ord.buyerUid || ord.uid || ord.userId || ord.customerUid || null;
    if (buyer !== uid) throw new HttpsError('permission-denied', 'This is not your order.');

    const donId    = 'CHK_' + oid;
    const dateStr  = new Date().toLocaleDateString('en-KE', { year:'numeric', month:'long', day:'numeric' });
    const verifyCode = crypto.randomBytes(8).toString('hex').toUpperCase();
    const ref = fdb().collection('foundationDonations').doc(donId);

    let existing = null;
    await fdb().runTransaction(async txn => {
      const cur = await txn.get(ref);
      if (cur.exists) { existing = cur.data(); return; }   /* one pledge per order — a retry is a no-op */
      txn.create(ref, {
        id: donId, uid, checkoutId: donId, verifyCode,
        amount: amt, destination: _san(destination, 60) || 'General Foundation',
        method: type === 'roundup' ? 'Round-Up' : 'Checkout Add-On',
        frequency: 'one-time', status: 'pledged', donorName: 'SOKONI User',
        anonymous: false, orderId: oid, dateStr,
        createdAt: _now(), updatedAt: _now(),
      });
    });

    return { ok: true, donationId: donId, status: existing ? existing.status : 'pledged', alreadyPledged: !!existing };
  }
);

/* ═══════════════════════════════════════════════════════════════════════════
   3b. impactPledgeDonation — a standalone Foundation pledge (no order) — 2026-10-01
   Owner decision (option b): a donation is its OWN IntaSend payment, completed only on
   IntaSend's server confirmation (the webhook, owned by the payment authority). This callable
   only records the PLEDGE that payment will be for:
     foundationDonations/PLG_<uid>_<requestId>  status 'pledged'  — created ONCE (create() on a
     deterministic id: a retried tap returns the same pledge, never a second one)
   No ledger, no impactBalance, no foundationStats — those are written only when the payment is
   confirmed. requestId is a client-generated UUID v4; amount and destination are validated here.
═══════════════════════════════════════════════════════════════════════════ */
const PLEDGE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
exports.impactPledgeDonation = onCall(
  { timeoutSeconds: 20, enforceAppCheck: true },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
    const uid = request.auth.uid;
    const { amount, destination, requestId, anonymous, programmeId, purpose } = request.data || {};
    if (typeof requestId !== 'string' || requestId.length > 36 || !PLEDGE_UUID_RE.test(requestId)) {
      throw new HttpsError('invalid-argument', 'A valid requestId (UUID v4) is required.');
    }
    if (typeof amount !== 'number' && typeof amount !== 'string') throw new HttpsError('invalid-argument', 'Enter an amount.');
    const amt = Math.round(Number(amount));
    if (!Number.isFinite(amt) || amt < 10) throw new HttpsError('invalid-argument', 'The minimum donation is KES 10.');
    if (amt > 100000) throw new HttpsError('invalid-argument', 'The maximum single donation is KES 100,000.');
    /* Optional tags (2026-10-01). A purpose is a donor PREFERENCE, not a legal restriction: Foundation funds
       are unrestricted unless a programme says otherwise, and the receipt says so. A programme must exist
       and be active — the browser's word is not enough. */
    const PURPOSES = ['GENERAL_FOUNDATION', 'FOOD_SUPPORT', 'EDUCATION', 'HEALTH_SUPPORT', 'EMERGENCY_SUPPORT', 'COMMUNITY_SUPPORT', 'LIVELIHOOD_SUPPORT', 'OTHER'];
    const purp = purpose == null || purpose === '' ? 'GENERAL_FOUNDATION' : String(purpose);
    if (!PURPOSES.includes(purp)) throw new HttpsError('invalid-argument', 'Choose a listed purpose.');
    let prog = null, progTitle = null;
    if (programmeId != null && programmeId !== '') {
      if (typeof programmeId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(programmeId)) throw new HttpsError('invalid-argument', 'Invalid programme.');
      const ps = await fdb().collection('impactCampaigns').doc(programmeId).get();
      if (!ps.exists || ps.data().status !== 'active') throw new HttpsError('invalid-argument', 'That programme is not accepting donations.');
      prog = programmeId; progTitle = _san(ps.data().title, 60);
    }
    const dest = progTitle || _san(destination, 60) || 'General Foundation';

    /* Durable, fail-closed limit: pledges are cheap to create and must not be spammable. */
    await require('./shared/durable-limit').limit(fdb(), admin, { bucket: 'impactPledge', key: uid, max: 20, windowSec: 3600 });

    const donId = 'PLG_' + uid + '_' + requestId.toLowerCase();
    const ref = fdb().collection('foundationDonations').doc(donId);
    let existing = null;
    await fdb().runTransaction(async (txn) => {
      const cur = await txn.get(ref);
      if (cur.exists) { existing = cur.data(); return; }
      txn.create(ref, {
        id: donId, uid, requestId: requestId.toLowerCase(),
        amount: amt, destination: dest, programmeId: prog, purpose: purp, restricted: false, currency: 'KES', method: 'Foundation Pledge',
        frequency: 'one-time', status: 'pledged', donorName: anonymous === true ? 'Anonymous' : 'SOKONI User',
        anonymous: anonymous === true, orderId: null,
        dateStr: new Date().toLocaleDateString('en-KE', { year: 'numeric', month: 'long', day: 'numeric' }),
        createdAt: _now(), updatedAt: _now(),
      });
    });
    if (existing && existing.uid !== uid) throw new HttpsError('permission-denied', 'This pledge is not yours.');
    return { ok: true, pledgeId: donId, amount: existing ? existing.amount : amt, status: existing ? existing.status : 'pledged', alreadyPledged: !!existing };
  }
);

/* 3c. impactGetMyPledge — the donor's own pledge status (2026-10-01). The donation wizard shows
   "Confirming…" until this reads 'completed' (written ONLY by the payment authority's verified webhook).
   Returns status and receipt fields only; never another person's pledge. */
exports.impactGetMyPledge = onCall(
  { timeoutSeconds: 15, enforceAppCheck: true },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
    const id = String((request.data || {}).pledgeId || '');
    if (!/^(PLG|CHK)_[A-Za-z0-9_-]{1,200}$/.test(id)) throw new HttpsError('invalid-argument', 'Invalid pledge.');
    const snap = await fdb().collection('foundationDonations').doc(id).get();
    if (!snap.exists || snap.data().uid !== request.auth.uid) throw new HttpsError('not-found', 'Pledge not found.');
    const d = snap.data();
    const ms = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : null);
    return { ok: true, pledgeId: id, status: d.status, amount: d.amount, currency: d.currency || 'KES', destination: d.destination || null,
      programmeId: d.programmeId || null, purpose: d.purpose || null, receiptId: d.receiptId || null,
      completedAt: ms(d.completedAt), restricted: d.restricted === true };
  }
);

/* ══════════════════════════════════════════════════════════
   4. impactSetRoundUp — enable / disable round-up
══════════════════════════════════════════════════════════ */
exports.impactSetRoundUp = onCall(
  { timeoutSeconds: 15, enforceAppCheck: true },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
    const uid = request.auth.uid;
    const { enabled, target, destination } = request.data || {};
    const validTargets = [10, 50, 100, 500];
    const t = validTargets.includes(Number(target)) ? Number(target) : 10;

    await fdb().collection('impactRoundupSettings').doc(uid).set({
      uid, enabled: !!enabled, target: t,
      destination: _san(destination, 60) || 'General Foundation',
      updatedAt: _now(),
    }, { merge: true });

    return { ok: true };
  }
);

/* ══════════════════════════════════════════════════════════
   5. impactCorporateApply — business partnership application
══════════════════════════════════════════════════════════ */
exports.impactCorporateApply = onCall(
  { timeoutSeconds: 20, enforceAppCheck: true },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
    const uid = request.auth.uid;
    const { businessName, contactName, phone, email, tier, commitmentPct, focus, description } = request.data || {};

    if (!businessName || !contactName || !phone) {
      throw new HttpsError('invalid-argument', 'Business name, contact name and phone required.');
    }

    const ok = await _rateLimit(`corp_apply_${uid}`, 2, 86400000);
    if (!ok) throw new HttpsError('resource-exhausted', 'Application already submitted.');

    const validTiers = ['education','health','community','green','emergency'];
    const partnerFocus = validTiers.includes(tier) ? tier : 'community';

    const docRef = fdb().collection('impactCorporate').doc();
    await docRef.set({
      id: docRef.id, uid,
      businessName:  _san(businessName, 100),
      contactName:   _san(contactName, 80),
      phone:         _san(phone, 20),
      email:         _san(email, 200) || '',
      tier:          partnerFocus,
      commitmentPct: Math.min(100, Math.max(0, Number(commitmentPct) || 0)),
      focus:         _san(focus, 200) || '',
      description:   _san(description, 1000) || '',
      status:        'pending',
      badgeDisplayed: false,
      totalContributed: 0,
      impactScore:   0,
      createdAt:     _now(), updatedAt: _now(),
    });

    return { ok: true, applicationId: docRef.id };
  }
);

/* ══════════════════════════════════════════════════════════
   6. impactGetBusinessScore — compute business impact score
══════════════════════════════════════════════════════════ */
exports.impactGetBusinessScore = onCall(
  { timeoutSeconds: 20, enforceAppCheck: true },
  async (request) => {
    const { sellerUid } = request.data || {};
    if (!sellerUid) throw new HttpsError('invalid-argument', 'sellerUid required.');

    const [sellerSnap, orderSnap, reviewSnap, disputeSnap, corpSnap] = await Promise.all([
      fdb().collection('sellers').doc(sellerUid).get().catch(() => null),
      fdb().collection('orders').where('sellerUid','==',sellerUid).where('status','==','delivered').limit(200).get().catch(() => ({ docs: [] })),
      fdb().collection('reviews').where('sellerUid','==',sellerUid).limit(100).get().catch(() => ({ docs: [] })),
      fdb().collection('disputes').where('sellerUid','==',sellerUid).where('status','in',['resolved','closed']).limit(50).get().catch(() => ({ docs: [] })),
      fdb().collection('impactCorporate').where('uid','==',sellerUid).where('status','==','active').limit(1).get().catch(() => ({ docs: [] })),
    ]);

    if (!sellerSnap || !sellerSnap.exists) return { ok: true, score: 0 };

    const seller = sellerSnap.data();
    const orders  = orderSnap.docs.length;
    const reviews = reviewSnap.docs;
    const avgRating = reviews.length > 0
      ? reviews.reduce((s, d) => s + (d.data().rating || 0), 0) / reviews.length
      : 0;
    const disputeResolved = disputeSnap.docs.length;
    const isCorp = !corpSnap.empty && corpSnap.docs[0].data().status === 'active';
    const corpContrib = isCorp ? (corpSnap.docs[0].data().totalContributed || 0) : 0;

    /* Score: max 100 */
    let score = 0;
    score += seller.verified   ? 15 : 0;      /* verified badge */
    score += Math.min(25, orders / 4);         /* orders: up to 25 pts */
    score += Math.min(20, avgRating * 4);      /* rating: up to 20 pts (5.0 → 20) */
    score += Math.min(15, disputeResolved * 3);/* dispute resolution */
    score += isCorp ? 15 : 0;                  /* corporate partner */
    score += Math.min(10, corpContrib / 10000);/* corporate contribution */

    score = Math.round(Math.min(100, score));

    /* Persist for display */
    await fdb().collection('impactBusinessScores').doc(sellerUid).set({
      uid: sellerUid, score, orders, avgRating: Math.round(avgRating * 10) / 10,
      disputeResolved, corporatePartner: isCorp, updatedAt: _now(),
    }, { merge: true });

    return { ok: true, score, breakdown: { verified: seller.verified || false, orders, avgRating, disputeResolved, isCorp } };
  }
);

/* ══════════════════════════════════════════════════════════
   7. impactCreateCampaign — admin: create campaign
══════════════════════════════════════════════════════════ */
exports.impactCreateCampaign = onCall(
  { timeoutSeconds: 20, enforceAppCheck: true },
  async (request) => {
    if (!_isAdmin(request.auth)) throw new HttpsError('permission-denied', 'Admin only.');
    const {
      title, description, category, goal, coverImage,
      location, beneficiaries, daysLeft, urgent, gpsLat, gpsLng,
    } = request.data || {};
    if (!title || !goal) throw new HttpsError('invalid-argument', 'Title and goal required.');

    const validCats = ['education','health','food','environment','community','emergency','disaster','youth'];
    const ref = fdb().collection('impactCampaigns').doc();
    await ref.set({
      id: ref.id, title: _san(title, 150), description: _san(description, 5000),
      category: validCats.includes(category) ? category : 'community',
      goal: Math.round(Number(goal) || 0), raised: 0,
      coverImage: _san(coverImage, 500) || '',
      location: _san(location, 100) || '', beneficiaries: Number(beneficiaries) || 0,
      daysLeft: Number(daysLeft) || 30, urgent: !!urgent,
      gpsLat: Number(gpsLat) || null, gpsLng: Number(gpsLng) || null,
      status: 'active', verified: false,
      createdBy: request.auth.uid, createdAt: _now(), updatedAt: _now(),
      updates: [], milestones: [], donors: 0,
    });
    return { ok: true, campaignId: ref.id };
  }
);

/* ══════════════════════════════════════════════════════════
   8. impactUpdateCampaign — admin: update/approve/complete
══════════════════════════════════════════════════════════ */
exports.impactUpdateCampaign = onCall(
  { timeoutSeconds: 20, enforceAppCheck: true },
  async (request) => {
    if (!_isAdmin(request.auth)) throw new HttpsError('permission-denied', 'Admin only.');
    const { campaignId, status, verified, raised, daysLeft, update } = request.data || {};
    if (!campaignId) throw new HttpsError('invalid-argument', 'campaignId required.');
    /* 2026-10-01: "raised" is a public money figure. It was settable to ANY number by an admin — a
       fabricated metric. It is now moved only by verified donations (the payment authority's webhook). */
    if (raised !== undefined) throw new HttpsError('invalid-argument', '"raised" is computed from confirmed donations and cannot be set.');
    if (status !== undefined && !['active', 'paused', 'completed', 'closed'].includes(status)) throw new HttpsError('invalid-argument', 'Invalid status.');

    const ref = fdb().collection('impactCampaigns').doc(campaignId);
    const updates = { updatedAt: _now() };

    if (status   !== undefined) updates.status   = _san(status, 20);
    if (verified !== undefined) updates.verified  = !!verified;
    if (daysLeft !== undefined) updates.daysLeft  = Math.max(0, Number(daysLeft) || 0);
    if (update   && update.text) {
      updates.updates = admin.firestore.FieldValue.arrayUnion({
        text:      _san(update.text, 2000),
        imageUrl:  _san(update.imageUrl, 500) || '',
        createdAt: new Date().toISOString(),
        author:    request.auth.uid,
      });
    }

    await ref.update(updates);
    return { ok: true };
  }
);

/* ══════════════════════════════════════════════════════════
   9. impactGetCampaignDetail — public full campaign data
══════════════════════════════════════════════════════════ */
exports.impactGetCampaignDetail = onCall(
  { timeoutSeconds: 15, enforceAppCheck: true },
  async (request) => {
    const { campaignId } = request.data || {};
    if (!campaignId) throw new HttpsError('invalid-argument', 'campaignId required.');

    const [campSnap, donSnap] = await Promise.all([
      fdb().collection('impactCampaigns').doc(campaignId).get(),
      fdb().collection('foundationDonations')
        .where('destination', '==', campaignId)
        .where('status', '==', 'completed')
        .orderBy('createdAt', 'desc').limit(10).get().catch(() => ({ docs: [] })),
    ]);

    if (!campSnap.exists) throw new HttpsError('not-found', 'Campaign not found.');
    const camp = campSnap.data();

    const donors = donSnap.docs.map(d => {
      const don = d.data();
      return {
        amount:    don.amount,
        donorName: don.anonymous ? 'Anonymous' : don.donorName,
        dateStr:   don.dateStr || '',
      };
    });

    return { ok: true, campaign: camp, recentDonors: donors };
  }
);

/* ══════════════════════════════════════════════════════════
   10. impactSubmitGrant — grant application
══════════════════════════════════════════════════════════ */
exports.impactSubmitGrant = onCall(
  { timeoutSeconds: 20, enforceAppCheck: true },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
    const uid = request.auth.uid;

    const ok = await _rateLimit(`grant_${uid}`, 2, 86400000 * 30);
    if (!ok) throw new HttpsError('resource-exhausted', 'Maximum 2 grant applications per month.');

    const {
      businessName, ownerName, phone, email, county, businessType,
      businessPlan, amountRequested, impactDescription, yearsInBusiness,
    } = request.data || {};

    if (!businessName || !ownerName || !phone || !businessPlan || !amountRequested) {
      throw new HttpsError('invalid-argument', 'All required fields must be filled.');
    }
    const amt = Math.round(Number(amountRequested) || 0);
    if (amt < 1000 || amt > 200000) throw new HttpsError('invalid-argument', 'Grant must be between KES 1,000 and KES 200,000.');

    const ref = fdb().collection('impactGrants').doc();
    await ref.set({
      id: ref.id, uid,
      businessName:     _san(businessName, 100),
      ownerName:        _san(ownerName, 80),
      phone:            _san(phone, 20),
      email:            _san(email, 200) || '',
      county:           _san(county, 60),
      businessType:     _san(businessType, 60),
      businessPlan:     _san(businessPlan, 10000),
      amountRequested:  amt,
      impactDescription:_san(impactDescription, 5000) || '',
      yearsInBusiness:  Number(yearsInBusiness) || 0,
      status:           'submitted',
      aiScore:          null,  /* filled by AI screening CF */
      committeeDecision: null,
      disbursed:        false, disbursedAt: null, disbursedAmount: 0,
      milestones:       [],
      createdAt:        _now(), updatedAt: _now(),
    });

    return { ok: true, grantId: ref.id };
  }
);

/* ══════════════════════════════════════════════════════════
   11. impactSubmitScholarship — scholarship application
══════════════════════════════════════════════════════════ */
exports.impactSubmitScholarship = onCall(
  { timeoutSeconds: 20, enforceAppCheck: true },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
    const uid = request.auth.uid;

    const ok = await _rateLimit(`scholar_${uid}`, 1, 86400000 * 90);
    if (!ok) throw new HttpsError('resource-exhausted', 'One scholarship application per 90 days.');

    const {
      studentName, schoolName, county, form, feeAmount, phone, parentName,
      academicRecord, financialNeed, guardianDetails,
    } = request.data || {};

    if (!studentName || !schoolName || !phone || !feeAmount) {
      throw new HttpsError('invalid-argument', 'All required fields must be filled.');
    }

    const ref = fdb().collection('impactScholarships').doc();
    await ref.set({
      id: ref.id, uid,
      studentName:   _san(studentName, 80),
      schoolName:    _san(schoolName, 100),
      county:        _san(county, 60),
      form:          _san(form, 10),
      feeAmount:     Math.round(Number(feeAmount) || 0),
      phone:         _san(phone, 20),
      parentName:    _san(parentName, 80) || '',
      academicRecord:_san(academicRecord, 5000) || '',
      financialNeed: _san(financialNeed, 5000) || '',
      guardianDetails:_san(guardianDetails, 1000) || '',
      status:        'submitted',
      approved:      false, disbursed: false,
      createdAt:     _now(), updatedAt: _now(),
    });

    return { ok: true, scholarshipId: ref.id };
  }
);

/* ══════════════════════════════════════════════════════════
   12–14. FOUNDATION DISBURSEMENTS — rebuilt 2026-10-01
   ----------------------------------------------------------
   Three different people move Foundation money: initiator (admin) → approver (a different admin) →
   authorizer (superAdmin, neither of the others). Then:
     · M-PESA  → the PROVEN IntaSend send-money contract (finos-utils.intasendB2C). The ledger is debited
                 ONLY when IntaSend reports the payout Completed (impactRefreshDisbursementStatus) — never on
                 the initiate response. A gateway error releases the reservation; nothing is debited.
     · BANK / TILL / PAYBILL → NO automated rail exists on the platform (no PesaLink / B2B integration).
                 These are MANUAL: an admin pays outside SOKONI and records the provider reference; a
                 DIFFERENT admin confirms; only then is the ledger debited. Never shown as sent before that.
   Money is RESERVED at authorization (impactBalance.reservedKES) so two payouts cannot spend the same
   shilling; available = balance − reserved, re-checked inside the claiming transaction.
   Every state change is a transaction on the disbursement doc (claim-before-act), so a double click or a
   concurrent call cannot pay twice. Destinations are masked in every listing.
   Statuses: pending_approval → pending_authorization → processing → (awaiting_confirmation →) completed
             | failed | cancelled
══════════════════════════════════════════════════════════ */
const DSB_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const _isSuperAdmin = (auth) => !!auth && (auth.token?.superAdmin === true || auth.token?.role === 'superAdmin' || auth.token?.role === 'super_admin');
const _mask = (s) => { const v = String(s || ''); return v.length <= 4 ? '****' : '****' + v.slice(-4); };
function _destination(type, d) {
  const t = String(type || '').toUpperCase();
  const digits = (v) => String(v || '').replace(/\D/g, '');
  if (t === 'MPESA') {
    const ph = digits(d.phone);
    const m = /^(?:254|0)?([17]\d{8})$/.exec(ph);
    if (!m) throw new HttpsError('invalid-argument', 'Enter a valid Kenyan M-PESA number.');
    return { type: t, rail: 'intasend_b2c', phone: '254' + m[1], display: 'M-PESA ' + _mask(m[1]) };
  }
  if (t === 'TILL') {
    const till = digits(d.tillNumber);
    if (!/^\d{5,7}$/.test(till)) throw new HttpsError('invalid-argument', 'Enter a valid Till number.');
    return { type: t, rail: 'manual', tillNumber: till, display: 'Till ' + _mask(till) };
  }
  if (t === 'PAYBILL') {
    const pb = digits(d.paybillNumber), acc = _san(d.accountRef, 40);
    if (!/^\d{5,7}$/.test(pb) || !acc) throw new HttpsError('invalid-argument', 'Enter a Paybill number and account.');
    return { type: t, rail: 'manual', paybillNumber: pb, accountRef: acc, display: 'Paybill ' + pb + ' · ' + _mask(acc) };
  }
  if (t === 'BANK') {
    const acct = digits(d.accountNumber), bank = _san(d.bankName, 80), name = _san(d.accountName, 100);
    if (!bank || !name || !/^\d{6,20}$/.test(acct)) throw new HttpsError('invalid-argument', 'Enter the bank, account name and account number.');
    return { type: t, rail: 'manual', bankName: bank, bankCode: _san(d.bankCode, 10) || null, accountNumber: acct, accountName: name, display: bank + ' ' + _mask(acct) };
  }
  throw new HttpsError('invalid-argument', 'Destination must be MPESA, BANK, TILL or PAYBILL.');
}
function _dsbRow(id, x) {
  const ms = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : null);
  return { id, status: x.status, amount: x.amount, currency: 'KES', purpose: x.description || '', beneficiaryName: x.beneficiaryName,
    destination: (x.destination && x.destination.display) || (x.beneficiaryPhone ? 'M-PESA ' + _mask(x.beneficiaryPhone) : null),
    destinationType: (x.destination && x.destination.type) || 'MPESA', rail: (x.destination && x.destination.rail) || 'intasend_b2c',
    grantId: x.grantId || null, campaignId: x.campaignId || null, paymentRef: x.paymentRef || null, trackingId: x.trackingId || null,
    initiatedBy: x.initiatedBy, approvedBy: x.approvedBy || null, authorizedBy: x.authorizedBy || null, confirmedBy: x.confirmedBy || null,
    failureReason: x.failureReason || null, initiatedAt: ms(x.initiatedAt), completedAt: ms(x.completedAt) };
}
async function _dsbAudit(txn, ref, entry) {
  txn.update(ref, { auditLog: admin.firestore.FieldValue.arrayUnion({ ...entry, at: new Date().toISOString() }), updatedAt: _now() });
  txn.set(fdb().collection('adminActions').doc(), { type: 'foundation_disbursement', disbursementId: ref.id, ...entry, createdAt: _now() });
}
/* Release a reservation and (only on success) debit the ledger — one transaction, guarded by status. */
async function _settle(ref, from, outcome, extra) {
  return fdb().runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Disbursement not found.');
    const d = snap.data();
    if (!from.includes(d.status)) return { already: true, status: d.status };
    const balRef = fdb().collection('impactBalance').doc('current');
    let pledge = null, pledgeRef = null;
    if (d.refundOfPledgeId) { pledgeRef = fdb().collection('foundationDonations').doc(d.refundOfPledgeId); const ps = await txn.get(pledgeRef); pledge = ps.exists ? ps.data() : null; }
    if (outcome === 'completed' && pledgeRef) {
      await _writeLedgerEntry(txn, {
        type: 'refund', debit: d.amount, credit: 0, uid: d.initiatedBy, campaignId: (pledge && pledge.programmeId) || null,
        paymentRef: extra.paymentRef || d.trackingId || null,
        description: 'Donation refund ' + d.refundOfPledgeId + ' (' + ((d.destination && d.destination.display) || 'M-PESA') + ')',
        meta: { disbursementId: ref.id, pledgeId: d.refundOfPledgeId, receiptId: (pledge && pledge.receiptId) || null, reversalOf: (pledge && pledge.providerReference) || null },
      });
      txn.update(pledgeRef, { status: d.amount >= Number((pledge && (pledge.grossKES ?? pledge.amount)) || 0) ? 'refunded' : 'partially_refunded', refundedKES: _incr(d.amount), refundedAt: _now(), updatedAt: _now() });
      txn.set(fdb().collection('foundationStats').doc('current'), { totalDonations: _incr(-d.amount), totalRefunded: _incr(d.amount), updatedAt: _now() }, { merge: true });
      if (pledge && pledge.programmeId) txn.set(fdb().collection('impactCampaigns').doc(pledge.programmeId), { raised: _incr(-d.amount) }, { merge: true });
    } else if (pledgeRef) {
      txn.update(pledgeRef, { refundDisbursementId: null, updatedAt: _now() });   /* failed / cancelled: the donation can be refunded again */
    }
    if (outcome === 'completed' && !pledgeRef) {
      await _writeLedgerEntry(txn, {
        type: 'disbursement', debit: d.amount, credit: 0, uid: d.initiatedBy, campaignId: d.campaignId,
        paymentRef: extra.paymentRef || d.trackingId || null,
        description: 'Disbursement to ' + d.beneficiaryName + ' (' + ((d.destination && d.destination.display) || 'M-PESA') + ') — ' + (d.description || ''),
        meta: { disbursementId: ref.id, rail: (d.destination && d.destination.rail) || 'intasend_b2c' },
      });
    }
    txn.set(balRef, { reservedKES: _incr(-d.amount), ...(outcome === 'completed' ? { verifiedBalance: _incr(-d.amount) } : {}), lastUpdated: _now() }, { merge: true });
    if (d.grantId && outcome !== 'completed') txn.set(fdb().collection('impactGrants').doc(d.grantId), { committedKES: _incr(-d.amount) }, { merge: true });
    if (d.grantId && outcome === 'completed') txn.set(fdb().collection('impactGrants').doc(d.grantId), { disbursedKES: _incr(d.amount), committedKES: _incr(-d.amount) }, { merge: true });
    txn.update(ref, { status: outcome, ...(outcome === 'completed' ? { completedAt: _now() } : { failedAt: _now() }), ...extra });
    await _dsbAudit(txn, ref, { action: outcome, by: extra.settledBy || 'system', note: extra.failureReason || null });
    return { already: false, status: outcome };
  });
}

exports.impactInitiateDisbursement = onCall(
  { timeoutSeconds: 20, enforceAppCheck: true },
  async (request) => {
    if (!_isAdmin(request.auth)) throw new HttpsError('permission-denied', 'Admin only.');
    const uid = request.auth.uid;
    const { campaignId, grantId, beneficiaryName, amount, description, requestId } = request.data || {};
    if (typeof requestId !== 'string' || !DSB_UUID_RE.test(requestId)) throw new HttpsError('invalid-argument', 'A valid requestId (UUID v4) is required.');
    const amt = Math.round(Number(amount));
    if (!Number.isFinite(amt) || amt < 100) throw new HttpsError('invalid-argument', 'Minimum disbursement KES 100.');
    if (amt > 1000000) throw new HttpsError('invalid-argument', 'Maximum single disbursement KES 1,000,000.');
    const name = _san(beneficiaryName, 100);
    if (!name) throw new HttpsError('invalid-argument', 'Beneficiary name required.');
    const purpose = _san(description, 500);
    if (!purpose) throw new HttpsError('invalid-argument', 'Say what this support is for.');
    /* back-compat: a bare beneficiaryPhone means M-PESA */
    const data = request.data || {};
    const dest = _destination(data.destinationType || (data.beneficiaryPhone ? 'MPESA' : ''), data.destination || { phone: data.beneficiaryPhone });
    const refundOf = data.refundOfPledgeId ? String(data.refundOfPledgeId) : null;
    if (refundOf && !/^(PLG|CHK)_[A-Za-z0-9_-]{1,200}$/.test(refundOf)) throw new HttpsError('invalid-argument', 'Invalid donation.');
    const ref = fdb().collection('impactDisbursements').doc('DSB_' + requestId.toLowerCase());
    let existing = null;
    await fdb().runTransaction(async (txn) => {
      const cur = await txn.get(ref);
      if (cur.exists) { existing = cur.data(); return; }
      /* DONATION REFUND (2026-10-01): the donation must be completed, not already being refunded, and the
         refund cannot exceed what was received. The claim (refundDisbursementId) is set in this transaction,
         so two refunds of one donation cannot both start. Ledger reversal happens only on payout confirmation. */
      let pledgeRef = null;
      if (refundOf) {
        pledgeRef = fdb().collection('foundationDonations').doc(refundOf);
        const pl = await txn.get(pledgeRef);
        if (!pl.exists || pl.data().status !== 'completed') throw new HttpsError('failed-precondition', 'Only a completed donation can be refunded.');
        if (pl.data().refundDisbursementId) throw new HttpsError('already-exists', 'A refund for this donation is already in progress or done.');
        const gross = Number(pl.data().grossKES ?? pl.data().amount);
        if (amt > gross) throw new HttpsError('invalid-argument', 'A refund cannot exceed the donation (KES ' + gross.toLocaleString() + ').');
      }
      const balSnap = await txn.get(fdb().collection('impactBalance').doc('current'));
      const bal = balSnap.exists ? balSnap.data() : {};
      const available = (Number(bal.verifiedBalance) || 0) - (bal.reservedKES || 0);   /* VERIFIED money only (2026-10-01) */
      if (amt > available) throw new HttpsError('failed-precondition', 'Insufficient VERIFIED Foundation funds. Verified available: KES ' + Math.max(0, available).toLocaleString() + '.');
      if (grantId) {
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(grantId))) throw new HttpsError('invalid-argument', 'Invalid grant.');
        const gRef = fdb().collection('impactGrants').doc(String(grantId));
        const g = await txn.get(gRef);
        if (!g.exists || g.data().status !== 'approved') throw new HttpsError('failed-precondition', 'The grant is not approved.');
        const left = (g.data().approvedAmount || 0) - (g.data().disbursedKES || 0) - (g.data().committedKES || 0);
        if (amt > left) throw new HttpsError('failed-precondition', 'This exceeds what is left on the approved grant (KES ' + Math.max(0, left).toLocaleString() + ').');
        txn.set(gRef, { committedKES: _incr(amt) }, { merge: true });
      }
      if (pledgeRef) txn.update(pledgeRef, { refundDisbursementId: ref.id, refundRequestedAt: _now(), updatedAt: _now() });
      txn.create(ref, {
        id: ref.id, kind: refundOf ? 'donation_refund' : 'support', refundOfPledgeId: refundOf,
        campaignId: campaignId ? _san(campaignId, 128) : null, grantId: grantId ? String(grantId) : null,
        beneficiaryName: name, destination: dest, amount: amt, currency: 'KES', description: purpose,
        status: 'pending_approval', initiatedBy: uid, initiatedAt: _now(),
        approvedBy: null, authorizedBy: null, confirmedBy: null, paymentRef: null, trackingId: null,
        auditLog: [{ action: 'initiated', by: uid, at: new Date().toISOString() }], createdAt: _now(), updatedAt: _now(),
      });
      txn.set(fdb().collection('adminActions').doc(), { type: 'foundation_disbursement', disbursementId: ref.id, action: 'initiated', by: uid, amount: amt, createdAt: _now() });
    });
    if (existing) return { ok: true, disbursementId: ref.id, status: existing.status, already: true };
    return { ok: true, disbursementId: ref.id, status: 'pending_approval' };
  }
);

exports.impactApproveDisbursement = onCall(
  { timeoutSeconds: 20, enforceAppCheck: true },
  async (request) => {
    if (!_isAdmin(request.auth)) throw new HttpsError('permission-denied', 'Admin only.');
    const uid = request.auth.uid;
    const id = String((request.data || {}).disbursementId || '');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new HttpsError('invalid-argument', 'disbursementId required.');
    const ref = fdb().collection('impactDisbursements').doc(id);
    await fdb().runTransaction(async (txn) => {
      const snap = await txn.get(ref);
      if (!snap.exists) throw new HttpsError('not-found', 'Disbursement not found.');
      const d = snap.data();
      if (d.status !== 'pending_approval') throw new HttpsError('failed-precondition', 'Disbursement not in pending approval state.');
      if (d.initiatedBy === uid) throw new HttpsError('permission-denied', 'Approver must be different from initiator.');
      txn.update(ref, { status: 'pending_authorization', approvedBy: uid, approvedAt: _now() });
      await _dsbAudit(txn, ref, { action: 'approved', by: uid });
    });
    return { ok: true, status: 'pending_authorization' };
  }
);

exports.impactAuthorizeDisbursement = onCall(
  { timeoutSeconds: 60, enforceAppCheck: true, secrets: [INTASEND_PRIVATE_KEY] },
  async (request) => {
    if (!_isSuperAdmin(request.auth)) throw new HttpsError('permission-denied', 'Super admin authorization required.');
    const uid = request.auth.uid;
    const id = String((request.data || {}).disbursementId || '');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new HttpsError('invalid-argument', 'disbursementId required.');
    const ref = fdb().collection('impactDisbursements').doc(id);
    /* CLAIM: pending_authorization → processing + reserve, atomically. A second call finds 'processing'. */
    const d = await fdb().runTransaction(async (txn) => {
      const snap = await txn.get(ref);
      if (!snap.exists) throw new HttpsError('not-found', 'Disbursement not found.');
      const x = snap.data();
      if (x.status !== 'pending_authorization') throw new HttpsError('failed-precondition', 'Disbursement is not awaiting authorization (status: ' + x.status + ').');
      if (x.approvedBy === uid || x.initiatedBy === uid) throw new HttpsError('permission-denied', 'The authorizer must differ from the initiator and the approver.');
      const balRef = fdb().collection('impactBalance').doc('current');
      const b = await txn.get(balRef);
      const bal = b.exists ? b.data() : {};
      const available = (Number(bal.verifiedBalance) || 0) - (bal.reservedKES || 0);   /* VERIFIED money only (2026-10-01) */
      if (x.amount > available) throw new HttpsError('failed-precondition', 'Insufficient VERIFIED Foundation funds now (KES ' + Math.max(0, available).toLocaleString() + ').');
      txn.set(balRef, { reservedKES: _incr(x.amount), lastUpdated: _now() }, { merge: true });
      txn.update(ref, { status: 'processing', authorizedBy: uid, authorizedAt: _now() });
      await _dsbAudit(txn, ref, { action: 'authorized', by: uid });
      return x;
    });
    const rail = (d.destination && d.destination.rail) || 'intasend_b2c';
    if (rail !== 'intasend_b2c') {
      return { ok: true, status: 'processing', rail, next: 'Pay outside SOKONI, then record the provider reference for a second admin to confirm.' };
    }
    const phone = (d.destination && d.destination.phone) || _phone(d.beneficiaryPhone);
    let res;
    try {
      res = await require('./finos-utils').intasendB2C(INTASEND_PRIVATE_KEY.value(), { phone, amountKES: d.amount, reference: id, remarks: 'SOKONI Foundation support' });
    } catch (e) {
      await _settle(ref, ['processing'], 'failed', { failureReason: 'Gateway refused: ' + _san((e.gateway && e.gateway.code) || e.message, 120), settledBy: uid });
      throw new HttpsError('unavailable', 'IntaSend did not accept the payout. Nothing was sent and the funds were released.');
    }
    const trackingId = (res && (res.tracking_id || res.file_id || res.invoice_id)) || null;
    await ref.update({ trackingId, gatewayAcceptedAt: _now() });
    /* NOT completed: IntaSend accepted the request. Completion is confirmed by impactRefreshDisbursementStatus. */
    return { ok: true, status: 'processing', rail, trackingId };
  }
);

/* 14b. Confirm an M-PESA payout with IntaSend (send-money status). Completed → debit + release; Failed →
   release. Anything else stays processing. The status contract (POST /api/v1/send-money/status/ with
   tracking_id, per the intasend-node SDK) is UNPROVEN against the live account; an unreadable answer
   leaves the payout processing, never completed. */
exports.impactRefreshDisbursementStatus = onCall(
  { timeoutSeconds: 30, enforceAppCheck: true, secrets: [INTASEND_PRIVATE_KEY] },
  async (request) => {
    if (!_isAdmin(request.auth)) throw new HttpsError('permission-denied', 'Admin only.');
    const id = String((request.data || {}).disbursementId || '');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new HttpsError('invalid-argument', 'disbursementId required.');
    const ref = fdb().collection('impactDisbursements').doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Disbursement not found.');
    const d = snap.data();
    if (d.status !== 'processing' || !d.trackingId) return { ok: true, status: d.status, checked: false };
    const base = process.env.INTASEND_SANDBOX === 'true' ? 'https://sandbox.intasend.com' : 'https://payment.intasend.com';
    let body = null;
    try {
      const r = await fetch(base + '/api/v1/send-money/status/', { method: 'POST', headers: { Authorization: 'Bearer ' + INTASEND_PRIVATE_KEY.value(), 'Content-Type': 'application/json' }, body: JSON.stringify({ tracking_id: d.trackingId }) });
      body = r.ok ? await r.json() : null;
    } catch (_) { body = null; }
    if (!body) return { ok: true, status: 'processing', checked: false, note: 'IntaSend status could not be read; still processing.' };
    const tx = Array.isArray(body.transactions) ? body.transactions[0] || {} : {};
    const st = String(tx.status || body.status || '').toLowerCase();
    if (/^(completed|successful|success)$/.test(st)) {
      const r = await _settle(ref, ['processing'], 'completed', { paymentRef: _san(tx.transaction_id || tx.mpesa_reference || d.trackingId, 80), settledBy: request.auth.uid });
      return { ok: true, status: r.status, checked: true };
    }
    if (/^(failed|cancelled|canceled|rejected|reversed)$/.test(st)) {
      const r = await _settle(ref, ['processing'], 'failed', { failureReason: 'IntaSend reported ' + st, settledBy: request.auth.uid });
      return { ok: true, status: r.status, checked: true };
    }
    return { ok: true, status: 'processing', checked: true, providerStatus: _san(st, 40) };
  }
);

/* 14c. Manual rails (BANK / TILL / PAYBILL). Admin A records that they paid and the provider reference;
   admin B (different from A) confirms → ledger debit. Either may mark it failed (releases funds). */
exports.impactRecordManualDisbursement = onCall(
  { timeoutSeconds: 20, enforceAppCheck: true },
  async (request) => {
    if (!_isAdmin(request.auth)) throw new HttpsError('permission-denied', 'Admin only.');
    const uid = request.auth.uid;
    const { disbursementId, action, providerReference, note } = request.data || {};
    const id = String(disbursementId || '');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new HttpsError('invalid-argument', 'disbursementId required.');
    const ref = fdb().collection('impactDisbursements').doc(id);
    if (action === 'record') {
      const refNo = _san(providerReference, 80);
      if (!refNo || refNo.length < 4) throw new HttpsError('invalid-argument', 'Enter the bank / M-PESA reference of the payment you made.');
      await fdb().runTransaction(async (txn) => {
        const s = await txn.get(ref);
        if (!s.exists) throw new HttpsError('not-found', 'Disbursement not found.');
        const d = s.data();
        if ((d.destination && d.destination.rail) !== 'manual') throw new HttpsError('failed-precondition', 'This payout goes through IntaSend, not manually.');
        if (d.status !== 'processing') throw new HttpsError('failed-precondition', 'Only an authorized payout can be recorded.');
        txn.update(ref, { status: 'awaiting_confirmation', paymentRef: refNo, recordedBy: uid, recordedAt: _now() });
        await _dsbAudit(txn, ref, { action: 'recorded', by: uid, ref: refNo });
      });
      return { ok: true, status: 'awaiting_confirmation' };
    }
    if (action === 'confirm') {
      const s = await ref.get();
      if (!s.exists) throw new HttpsError('not-found', 'Disbursement not found.');
      if (s.data().recordedBy === uid) throw new HttpsError('permission-denied', 'A different admin must confirm the payment you recorded.');
      const r = await _settle(ref, ['awaiting_confirmation'], 'completed', { confirmedBy: uid, settledBy: uid });
      if (r.already) throw new HttpsError('failed-precondition', 'Nothing awaiting confirmation (status: ' + r.status + ').');
      return { ok: true, status: 'completed' };
    }
    if (action === 'fail') {
      const why = _san(note, 300);
      if (!why) throw new HttpsError('invalid-argument', 'Say why it failed.');
      const r = await _settle(ref, ['processing', 'awaiting_confirmation'], 'failed', { failureReason: why, settledBy: uid });
      if (r.already) throw new HttpsError('failed-precondition', 'This payout cannot be marked failed (status: ' + r.status + ').');
      return { ok: true, status: 'failed' };
    }
    throw new HttpsError('invalid-argument', 'action must be record, confirm or fail.');
  }
);

/* 14d. Cancel before money is committed (no reservation exists yet). */
exports.impactCancelDisbursement = onCall(
  { timeoutSeconds: 20, enforceAppCheck: true },
  async (request) => {
    if (!_isAdmin(request.auth)) throw new HttpsError('permission-denied', 'Admin only.');
    const id = String((request.data || {}).disbursementId || '');
    const why = _san((request.data || {}).note, 300);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || !why) throw new HttpsError('invalid-argument', 'disbursementId and a reason are required.');
    const ref = fdb().collection('impactDisbursements').doc(id);
    await fdb().runTransaction(async (txn) => {
      const s = await txn.get(ref);
      if (!s.exists) throw new HttpsError('not-found', 'Disbursement not found.');
      const d = s.data();
      if (!['pending_approval', 'pending_authorization'].includes(d.status)) throw new HttpsError('failed-precondition', 'Only a payout that has not been authorized can be cancelled.');
      if (d.grantId) txn.set(fdb().collection('impactGrants').doc(d.grantId), { committedKES: _incr(-d.amount) }, { merge: true });
      if (d.refundOfPledgeId) txn.update(fdb().collection('foundationDonations').doc(d.refundOfPledgeId), { refundDisbursementId: null, updatedAt: _now() });
      txn.update(ref, { status: 'cancelled', cancelledBy: request.auth.uid, cancelledAt: _now(), failureReason: why });
      await _dsbAudit(txn, ref, { action: 'cancelled', by: request.auth.uid, note: why });
    });
    return { ok: true, status: 'cancelled' };
  }
);

/* 14e. Admin views — donations and disbursements, bounded, donor contact never returned. */
/* 14f. FOUNDATION RECONCILIATION (2026-10-01) — "recorded" vs "verified paid".
   classify: scan foundationDonations; a 'completed' record WITHOUT provider evidence (providerReference + grossKES,
   written only by the verified webhook) is marked reconciliation.state 'REQUIRES_RECONCILIATION' — status and
   amount are NEVER rewritten. Snapshot → foundationReconciliation/current.
   propose / confirm (two different admins): 'verify' (with the IntaSend reference) credits verifiedBalance;
   'close' (no money arrived) posts an append-only 'adjustment' debit reversing the unbacked credit and unwinds
   foundationStats / programme raised. Nothing is deleted. */
exports.impactReconcileFoundation = onCall(
  { timeoutSeconds: 120, enforceAppCheck: true },
  async (request) => {
    if (!_isAdmin(request.auth)) throw new HttpsError('permission-denied', 'Admin only.');
    const uid = request.auth.uid;
    const { action, donationId, providerReference, note } = request.data || {};
    const ms = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : null);
    const evidence = (d) => !!(d.providerReference && (d.grossKES != null));
    if (action === 'classify') {
      const counts = { recorded: 0, verifiedPaid: 0, unverified: 0, failed: 0, refunded: 0, pledged: 0, review: 0, held: 0, duplicates: 0 };
      const amounts = { recorded: 0, verifiedPaid: 0, unverified: 0 };
      const seenOrders = {};
      let last = null, marked = 0;
      for (let page = 0; page < 20; page++) {
        let q = fdb().collection('foundationDonations').orderBy('__name__').limit(500);
        if (last) q = q.startAfter(last);
        const snap = await q.get();
        if (snap.empty) break;
        const batch = fdb().batch();
        let writes = 0;
        for (const doc of snap.docs) {
          const d = doc.data();
          if (d.orderId) { seenOrders[d.orderId] = (seenOrders[d.orderId] || 0) + 1; if (seenOrders[d.orderId] === 2) counts.duplicates++; }
          if (d.status === 'pledged') { counts.pledged++; continue; }
          if (d.status === 'failed') { counts.failed++; continue; }
          if (d.status === 'review') { counts.review++; counts.held++; continue; }
          if (d.status === 'refunded' || d.status === 'partially_refunded') { counts.refunded++; continue; }
          if (d.status === 'completed') {
            counts.recorded++; amounts.recorded += Number(d.amount) || 0;
            const rs = d.reconciliation && d.reconciliation.state;
            if (evidence(d) || rs === 'VERIFIED_PAID') { counts.verifiedPaid++; amounts.verifiedPaid += Number(d.grossKES ?? d.amount) || 0; continue; }
            if (rs === 'CLOSED_NO_PAYMENT') continue;
            counts.unverified++; counts.held++; amounts.unverified += Number(d.amount) || 0;
            if (!rs) { batch.update(doc.ref, { reconciliation: { state: 'REQUIRES_RECONCILIATION', classifiedAt: _now(), classifiedBy: uid } }); writes++; marked++; }
          }
        }
        if (writes) await batch.commit();
        last = snap.docs[snap.docs.length - 1];
        if (snap.size < 500) break;
      }
      const balSnap = await fdb().collection('impactBalance').doc('current').get();
      const b = balSnap.exists ? balSnap.data() : {};
      const snapshot = { counts, amounts, newlyMarked: marked, balance: b.balance ?? null, verifiedBalance: b.verifiedBalance ?? null,
        reservedKES: b.reservedKES ?? 0, totalDisbursed: b.totalDisbursed ?? null, computedAt: _now(), computedBy: uid };
      await fdb().collection('foundationReconciliation').doc('current').set(snapshot);
      await fdb().collection('adminActions').add({ type: 'foundation_reconciliation_classify', adminUid: uid, counts, createdAt: _now() });
      return { ok: true, counts, amounts, newlyMarked: marked };
    }
    if (!/^(PLG|CHK)_[A-Za-z0-9_-]{1,200}$/.test(String(donationId || ''))) throw new HttpsError('invalid-argument', 'Invalid donation.');
    const ref = fdb().collection('foundationDonations').doc(String(donationId));
    if (action === 'propose_verify' || action === 'propose_close') {
      const why = _san(note, 300);
      const refNo = _san(providerReference, 80);
      if (action === 'propose_verify' && (!refNo || refNo.length < 4)) throw new HttpsError('invalid-argument', 'Enter the IntaSend payment reference that proves the money arrived.');
      if (action === 'propose_close' && !why) throw new HttpsError('invalid-argument', 'Say why this donation has no payment.');
      await fdb().runTransaction(async (txn) => {
        const s0 = await txn.get(ref);
        if (!s0.exists) throw new HttpsError('not-found', 'Donation not found.');
        const d = s0.data();
        if (d.status !== 'completed' || !d.reconciliation || d.reconciliation.state !== 'REQUIRES_RECONCILIATION') throw new HttpsError('failed-precondition', 'This donation is not awaiting reconciliation.');
        txn.update(ref, { 'reconciliation.proposal': { action: action === 'propose_verify' ? 'verify' : 'close', by: uid, providerReference: refNo || null, note: why || null, at: _now() } });
        txn.set(fdb().collection('adminActions').doc(), { type: 'foundation_reconciliation_propose', donationId: ref.id, action, adminUid: uid, createdAt: _now() });
      });
      return { ok: true, state: 'PENDING_SECOND_REVIEW' };
    }
    if (action === 'confirm' || action === 'withdraw') {
      const out = await fdb().runTransaction(async (txn) => {
        const s0 = await txn.get(ref);
        if (!s0.exists) throw new HttpsError('not-found', 'Donation not found.');
        const d = s0.data();
        const pr = d.reconciliation && d.reconciliation.proposal;
        if (!pr || d.reconciliation.state !== 'REQUIRES_RECONCILIATION') throw new HttpsError('failed-precondition', 'Nothing awaiting a second review.');
        if (action === 'withdraw') { txn.update(ref, { 'reconciliation.proposal': null }); return { state: 'REQUIRES_RECONCILIATION' }; }
        if (pr.by === uid) throw new HttpsError('permission-denied', 'A different admin must confirm.');
        const amt = Number(d.amount) || 0;
        const balRef = fdb().collection('impactBalance').doc('current');
        if (pr.action === 'verify') {
          const bs = await txn.get(balRef);
          txn.set(balRef, { verifiedBalance: _incr(amt), lastUpdated: _now() }, { merge: true });
          txn.update(ref, { 'reconciliation.state': 'VERIFIED_PAID', 'reconciliation.providerReference': pr.providerReference, 'reconciliation.confirmedBy': uid, 'reconciliation.confirmedAt': _now() });
          void bs;
        } else {
          await _writeLedgerEntry(txn, { type: 'adjustment', debit: amt, credit: 0, uid: d.uid || null, campaignId: d.programmeId || null,
            description: 'Reconciliation: no payment for donation ' + ref.id + ' — reversing the recorded credit', meta: { reversalOf: ref.id, proposedBy: pr.by, confirmedBy: uid } });
          txn.set(fdb().collection('foundationStats').doc('current'), { totalDonations: _incr(-amt), updatedAt: _now() }, { merge: true });
          if (d.programmeId) txn.set(fdb().collection('impactCampaigns').doc(d.programmeId), { raised: _incr(-amt) }, { merge: true });
          txn.update(ref, { 'reconciliation.state': 'CLOSED_NO_PAYMENT', 'reconciliation.confirmedBy': uid, 'reconciliation.confirmedAt': _now() });
        }
        txn.set(fdb().collection('adminActions').doc(), { type: 'foundation_reconciliation_confirm', donationId: ref.id, outcome: pr.action, proposedBy: pr.by, adminUid: uid, createdAt: _now() });
        return { state: pr.action === 'verify' ? 'VERIFIED_PAID' : 'CLOSED_NO_PAYMENT' };
      });
      return { ok: true, ...out };
    }
    throw new HttpsError('invalid-argument', 'Unknown action.');
  }
);

exports.impactAdminFoundationData = onCall(
  { timeoutSeconds: 30, enforceAppCheck: true },
  async (request) => {
    if (!_isAdmin(request.auth)) throw new HttpsError('permission-denied', 'Admin only.');
    const { view, status, cursor } = request.data || {};
    const ms = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : null);
    const count = async (q) => { try { return (await q.count().get()).data().count; } catch (_) { return null; } };
    if (view === 'summary') {
      const don = fdb().collection('foundationDonations'), dsb = fdb().collection('impactDisbursements');
      const [balSnap, completed, pledged, failed, review, refunded, dPending, dAuth, dProc, dConf, dDone, dFail] = await Promise.all([
        fdb().collection('impactBalance').doc('current').get().catch(() => null),
        count(don.where('status', '==', 'completed')), count(don.where('status', '==', 'pledged')), count(don.where('status', '==', 'failed')),
        count(don.where('status', '==', 'review')), count(don.where('status', '==', 'refunded')),
        count(dsb.where('status', '==', 'pending_approval')), count(dsb.where('status', '==', 'pending_authorization')),
        count(dsb.where('status', '==', 'processing')), count(dsb.where('status', '==', 'awaiting_confirmation')),
        count(dsb.where('status', '==', 'completed')), count(dsb.where('status', '==', 'failed')),
      ]);
      const b = balSnap && balSnap.exists ? balSnap.data() : null;
      return { ok: true,
        balance: b ? { recorded: b.balance ?? null, verified: b.verifiedBalance ?? 0, reserved: b.reservedKES ?? 0,
          available: (Number(b.verifiedBalance) || 0) - (b.reservedKES || 0),
          requiresReconciliation: b.balance == null ? null : Math.max(0, b.balance - (Number(b.verifiedBalance) || 0)),
          balance: b.balance ?? null, totalReceived: b.totalReceived ?? null, totalDisbursed: b.totalDisbursed ?? null, totalFees: b.totalFees ?? null } : null,
        reconciliation: await fdb().collection('foundationReconciliation').doc('current').get().then((x) => (x.exists ? { counts: x.data().counts, amounts: x.data().amounts, computedAt: ms(x.data().computedAt) } : null)).catch(() => null),
        donations: { completed, pledged, failed, review, refunded },
        disbursements: { pendingApproval: dPending, pendingAuthorization: dAuth, processing: dProc, awaitingConfirmation: dConf, completed: dDone, failed: dFail } };
    }
    const size = 50;
    if (view === 'donations') {
      const allowed = ['pledged', 'completed', 'failed', 'review', 'refunded', 'partially_refunded'];
      let q = fdb().collection('foundationDonations');
      if (status === 'requires_reconciliation') q = q.where('reconciliation.state', '==', 'REQUIRES_RECONCILIATION');
      else if (status) { if (!allowed.includes(status)) throw new HttpsError('invalid-argument', 'Invalid status.'); q = q.where('status', '==', status); }
      q = q.orderBy('createdAt', 'desc');
      if (cursor) { const c = await fdb().collection('foundationDonations').doc(String(cursor)).get(); if (c.exists) q = q.startAfter(c); }
      const s = await q.limit(size).get();
      return { ok: true, next: s.docs.length === size ? s.docs[s.docs.length - 1].id : null, rows: s.docs.map((x) => { const d = x.data(); return {
        id: x.id, status: d.status, amount: d.amount, grossKES: d.grossKES ?? null, feeKES: d.feeKES ?? null, netKES: d.netKES ?? null, currency: d.currency || 'KES',
        destination: d.destination || null, programmeId: d.programmeId || null, purpose: d.purpose || null, method: d.method || null,
        donor: d.anonymous ? 'Anonymous' : (d.donorName || 'SOKONI User'), receiptId: d.receiptId || null, providerReference: d.providerReference || null,
        orderId: d.orderId || null, reconciliation: d.reconciliation ? { state: d.reconciliation.state, proposal: d.reconciliation.proposal ? { action: d.reconciliation.proposal.action, by: d.reconciliation.proposal.by } : null } : null,
        verified: !!(d.providerReference && d.grossKES != null) || (d.reconciliation && d.reconciliation.state === 'VERIFIED_PAID'),
        refundDisbursementId: d.refundDisbursementId || null, refundedKES: d.refundedKES || 0, reviewReason: d.reviewReason || null,
        createdAt: ms(d.createdAt), completedAt: ms(d.completedAt) }; }) };
    }
    if (view === 'disbursements') {
      const allowed = ['pending_approval', 'pending_authorization', 'processing', 'awaiting_confirmation', 'completed', 'failed', 'cancelled'];
      let q = fdb().collection('impactDisbursements');
      if (status) { if (!allowed.includes(status)) throw new HttpsError('invalid-argument', 'Invalid status.'); q = q.where('status', '==', status); }
      q = q.orderBy('initiatedAt', 'desc');
      if (cursor) { const c = await fdb().collection('impactDisbursements').doc(String(cursor)).get(); if (c.exists) q = q.startAfter(c); }
      const s = await q.limit(size).get();
      return { ok: true, next: s.docs.length === size ? s.docs[s.docs.length - 1].id : null, rows: s.docs.map((x) => _dsbRow(x.id, x.data())) };
    }
    throw new HttpsError('invalid-argument', 'view must be summary, donations or disbursements.');
  }
);

/* ══════════════════════════════════════════════════════════
   15. impactGetFinancialReport — superAdmin financial ledger
══════════════════════════════════════════════════════════ */
exports.impactGetFinancialReport = onCall(
  { timeoutSeconds: 30, enforceAppCheck: true },
  async (request) => {
    if (!_isAdmin(request.auth)) throw new HttpsError('permission-denied', 'Admin only.');
    const { month, year } = request.data || {};

    const [balSnap, ledgerSnap, disbSnap, pendingSnap] = await Promise.all([
      fdb().collection('impactBalance').doc('current').get(),
      fdb().collection('impactLedger').orderBy('createdAt','desc').limit(100).get(),
      fdb().collection('impactDisbursements').where('status','==','completed').orderBy('executedAt','desc').limit(50).get(),
      fdb().collection('impactDisbursements').where('status','in',['pending_approval','pending_authorization']).get(),
    ]);

    /* Group ledger by type */
    const byType = {};
    ledgerSnap.docs.forEach(d => {
      const e = d.data();
      if (!byType[e.type]) byType[e.type] = { credits: 0, debits: 0, count: 0 };
      byType[e.type].credits += e.credit || 0;
      byType[e.type].debits  += e.debit  || 0;
      byType[e.type].count++;
    });

    return {
      ok: true,
      balance:      balSnap.exists ? balSnap.data() : {},
      byType,
      ledger:       ledgerSnap.docs.map(d => ({ id: d.id, ...d.data() })).slice(0, 50),
      disbursements:disbSnap.docs.map(d => ({ id: d.id, ...d.data() })),
      pending:      pendingSnap.docs.map(d => ({ id: d.id, ...d.data() })),
    };
  }
);

/* ══════════════════════════════════════════════════════════
   16. impactAdminCorporateApprove — approve corporate partner
══════════════════════════════════════════════════════════ */
exports.impactAdminCorporateApprove = onCall(
  { timeoutSeconds: 15, enforceAppCheck: true },
  async (request) => {
    if (!_isAdmin(request.auth)) throw new HttpsError('permission-denied', 'Admin only.');
    const { corporateId, status, tier } = request.data || {};
    if (!corporateId || !['active','rejected'].includes(status)) {
      throw new HttpsError('invalid-argument', 'corporateId and valid status required.');
    }
    await fdb().collection('impactCorporate').doc(corporateId).update({
      status, tier: _san(tier, 30) || undefined,
      approvedBy: request.auth.uid, approvedAt: _now(), updatedAt: _now(),
    });
    return { ok: true };
  }
);

/* ══════════════════════════════════════════════════════════
   17. impactAdminGrantReview — committee decision on grant
══════════════════════════════════════════════════════════ */
exports.impactAdminGrantReview = onCall(
  { timeoutSeconds: 15, enforceAppCheck: true },
  async (request) => {
    if (!_isAdmin(request.auth)) throw new HttpsError('permission-denied', 'Admin only.');
    const { grantId, decision, notes, approvedAmount } = request.data || {};
    if (!grantId || !['approved','rejected','waitlisted'].includes(decision)) {
      throw new HttpsError('invalid-argument', 'grantId and valid decision required.');
    }
    const ref = fdb().collection('impactGrants').doc(grantId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Grant not found.');

    await ref.update({
      status:           decision,
      committeeDecision: decision,
      adminNotes:       _san(notes, 1000) || '',
      approvedAmount:   decision === 'approved' ? (Math.round(Number(approvedAmount) || snap.data().amountRequested)) : 0,
      reviewedBy:       request.auth.uid, reviewedAt: _now(), updatedAt: _now(),
    });
    return { ok: true };
  }
);

/* ══════════════════════════════════════════════════════════
   18. impactRecordMarketplaceContribution — called by FinOS on
   order completion to auto-credit 1% to Foundation
══════════════════════════════════════════════════════════ */
exports.impactRecordMarketplaceContribution = onCall(
  { timeoutSeconds: 20, enforceAppCheck: true },
  async (request) => {
    /* Only callable by internal Cloud Functions or admin */
    if (!_isAdmin(request.auth)) throw new HttpsError('permission-denied', 'Internal only.');
    /* REFUSED (2026-10-01). This credited 1% of an admin-SUPPLIED orderTotal to the Foundation ledger with no
       money moving into the Foundation — a ledger entry without cash, which then inflated the balance that
       disbursements trust. Nothing calls it. A marketplace contribution, if the owner wants one, must be an
       actual transfer recorded by the payment authority. No write happens here. */
    throw new HttpsError('failed-precondition', 'Marketplace contributions are not recorded without an actual transfer. Owner decision required.');
    const { orderId, orderTotal, uid } = request.data || {};
    if (!orderId || !orderTotal) throw new HttpsError('invalid-argument', 'orderId and orderTotal required.');

    const contribution = Math.round(Number(orderTotal) * 0.01); /* 1% */
    if (contribution < 1) return { ok: true, skipped: true };

    /* Idempotency: don't double-credit the same order */
    const existingSnap = await fdb().collection('impactLedger')
      .where('orderId','==', orderId)
      .where('type','==','marketplace_contribution')
      .limit(1).get();
    if (!existingSnap.empty) return { ok: true, skipped: true, reason: 'already credited' };

    await fdb().runTransaction(async txn => {
      await _writeLedgerEntry(txn, {
        type: 'marketplace_contribution', credit: contribution, debit: 0,
        uid: uid || null, orderId,
        description: `1% marketplace contribution — order ${orderId} (KES ${orderTotal.toLocaleString()})`,
      });

      txn.set(fdb().collection('foundationStats').doc('current'), {
        totalDonations: _incr(contribution), updatedAt: _now(),
      }, { merge: true });
    });

    return { ok: true, contribution };
  }
);

/* ══════════════════════════════════════════════════════════
   19. impactGetCampaigns — public paginated campaigns
══════════════════════════════════════════════════════════ */
exports.impactGetCampaigns = onCall(
  { timeoutSeconds: 15, enforceAppCheck: true },
  async (request) => {
    const { category, sort, limit: rawLimit, urgent } = request.data || {};
    const lim = Math.min(Number(rawLimit) || 12, 24);

    let q = fdb().collection('impactCampaigns').where('status','==','active');
    if (category && category !== 'all') q = q.where('category','==',_san(category,30));
    if (urgent) q = q.where('urgent','==',true);

    /* Sort options */
    if (sort === 'most_funded') q = q.orderBy('raised','desc');
    else if (sort === 'ending_soon') q = q.orderBy('daysLeft','asc');
    else q = q.orderBy('createdAt','desc');

    const snap = await q.limit(lim).get();
    const campaigns = snap.docs.map(d => {
      const c = d.data();
      return {
        id: d.id, title: c.title, description: (c.description||'').slice(0, 200),
        coverImage: c.coverImage, goal: c.goal, raised: c.raised || 0,
        category: c.category, daysLeft: c.daysLeft, verified: c.verified,
        beneficiaries: c.beneficiaries, location: c.location, urgent: c.urgent,
        donors: c.donors || 0, pct: c.goal > 0 ? Math.min(100, Math.round((c.raised||0)/c.goal*100)) : 0,
      };
    });

    return { ok: true, campaigns };
  }
);

/* ══════════════════════════════════════════════════════════
   20. impactBookmarkCampaign — toggle bookmark
══════════════════════════════════════════════════════════ */
exports.impactBookmarkCampaign = onCall(
  { timeoutSeconds: 10, enforceAppCheck: true },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
    const uid = request.auth.uid;
    const { campaignId } = request.data || {};
    if (!campaignId) throw new HttpsError('invalid-argument', 'campaignId required.');

    const ref  = fdb().collection('impactBookmarks').doc(`${uid}_${campaignId}`);
    const snap = await ref.get();
    if (snap.exists) { await ref.delete(); return { ok: true, bookmarked: false }; }
    await ref.set({ uid, campaignId, createdAt: _now() });
    return { ok: true, bookmarked: true };
  }
);

/* ══════════════════════════════════════════════════════════
   21. impactGetAdminGrants — admin grant list
══════════════════════════════════════════════════════════ */
exports.impactGetAdminGrants = onCall(
  { timeoutSeconds: 15, enforceAppCheck: true },
  async (request) => {
    if (!_isAdmin(request.auth)) throw new HttpsError('permission-denied', 'Admin only.');
    const { status } = request.data || {};
    let q = fdb().collection('impactGrants').orderBy('createdAt','desc').limit(50);
    if (status) q = fdb().collection('impactGrants').where('status','==',_san(status,20)).orderBy('createdAt','desc').limit(50);
    const snap = await q.get();
    return { ok: true, grants: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
  }
);

/* ══════════════════════════════════════════════════════════
   22. impactScheduledDailyReconciliation — daily ledger reconciliation
   Runs at 00:05 EAT (21:05 UTC) — before recurring donations
══════════════════════════════════════════════════════════ */
exports.impactScheduledDailyReconciliation = onSchedule(
  { schedule: '5 21 * * *', timeZone: 'Africa/Nairobi', timeoutSeconds: 120 },
  async () => {
    /* Reconcile: sum all ledger credits minus debits → compare to balance */
    const balSnap = await fdb().collection('impactBalance').doc('current').get();
    const stored  = balSnap.exists ? (balSnap.data().balance || 0) : 0;

    const ledgerSnap = await fdb().collection('impactLedger').get();
    let computed = 0;
    ledgerSnap.docs.forEach(d => {
      const e = d.data();
      computed += (e.credit || 0) - (e.debit || 0);
    });

    const diff = Math.abs(stored - computed);
    if (diff > 1) {
      /* Log discrepancy for investigation */
      console.error(`[IMPACT RECONCILIATION] DISCREPANCY: stored=${stored}, computed=${computed}, diff=${diff}`);
      await fdb().collection('impactAlerts').add({
        type: 'reconciliation_discrepancy', stored, computed, diff,
        resolvedAt: null, createdAt: _now(),
      });
    } else {
      console.log(`[IMPACT RECONCILIATION] OK — balance=${stored} KES`);
    }

    /* Update monthly snapshot */
    const monthKey = new Date().toISOString().slice(0,7);
    await fdb().collection('impactMonthlySnapshots').doc(monthKey).set({
      balance: stored, computed, diff,
      snapshotAt: _now(), month: monthKey,
    }, { merge: true });
  }
);

/* ══════════════════════════════════════════════════════════
   23. impactGetEnvironmental — environmental project stats
══════════════════════════════════════════════════════════ */
exports.impactGetEnvironmental = onCall(
  { timeoutSeconds: 15, enforceAppCheck: true },
  async () => {
    const snap = await fdb().collection('impactEnvironmental').doc('totals').get();
    const defaults = {
      treesPlanted: 0, carbonOffset: 0, riverCleanups: 0,
      plasticKg: 0, communityCleanups: 0, wildlifeProjects: 0,
    };
    return { ok: true, environmental: snap.exists ? snap.data() : defaults };
  }
);

/* ══════════════════════════════════════════════════════════
   24. impactAdminUpdateEnvironmental — update env stats
══════════════════════════════════════════════════════════ */
exports.impactAdminUpdateEnvironmental = onCall(
  { timeoutSeconds: 15, enforceAppCheck: true },
  async (request) => {
    if (!_isAdmin(request.auth)) throw new HttpsError('permission-denied', 'Admin only.');
    const { treesPlanted, carbonOffset, riverCleanups, plasticKg, communityCleanups, wildlifeProjects } = request.data || {};
    const updates = { updatedAt: _now(), updatedBy: request.auth.uid };
    if (treesPlanted   !== undefined) updates.treesPlanted   = Number(treesPlanted)   || 0;
    if (carbonOffset   !== undefined) updates.carbonOffset   = Number(carbonOffset)   || 0;
    if (riverCleanups  !== undefined) updates.riverCleanups  = Number(riverCleanups)  || 0;
    if (plasticKg      !== undefined) updates.plasticKg      = Number(plasticKg)      || 0;
    if (communityCleanups !== undefined) updates.communityCleanups = Number(communityCleanups) || 0;
    if (wildlifeProjects  !== undefined) updates.wildlifeProjects  = Number(wildlifeProjects)  || 0;
    await fdb().collection('impactEnvironmental').doc('totals').set(updates, { merge: true });
    return { ok: true };
  }
);

/* ══════════════════════════════════════════════════════════
   25. impactAdminCreateEnvProject — track environmental project
══════════════════════════════════════════════════════════ */
exports.impactAdminCreateEnvProject = onCall(
  { timeoutSeconds: 15, enforceAppCheck: true },
  async (request) => {
    if (!_isAdmin(request.auth)) throw new HttpsError('permission-denied', 'Admin only.');
    const { title, type, location, goal, completed, gpsLat, gpsLng, description } = request.data || {};
    if (!title) throw new HttpsError('invalid-argument', 'Title required.');
    const ref = fdb().collection('impactEnvProjects').doc();
    await ref.set({
      id: ref.id, title: _san(title, 150), type: _san(type, 50),
      location: _san(location, 100), goal: Number(goal) || 0,
      completed: Number(completed) || 0, description: _san(description, 3000),
      gpsLat: Number(gpsLat) || null, gpsLng: Number(gpsLng) || null,
      status: 'active', createdAt: _now(), updatedAt: _now(),
    });
    return { ok: true, projectId: ref.id };
  }
);
