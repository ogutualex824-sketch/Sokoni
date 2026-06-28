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
        available:     bal.balance || 0,
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

    const donId    = _txnId('CHK');
    const dateStr  = new Date().toLocaleDateString('en-KE', { year:'numeric', month:'long', day:'numeric' });
    const verifyCode = crypto.randomBytes(8).toString('hex').toUpperCase();

    await fdb().runTransaction(async txn => {
      /* Write donation record */
      txn.set(fdb().collection('foundationDonations').doc(donId), {
        id: donId, uid, checkoutId: donId, verifyCode,
        receiptNo: _txnId('RCP'),
        amount: amt, destination: _san(destination, 60) || 'General Foundation',
        method: type === 'roundup' ? 'Round-Up' : 'Checkout Add-On',
        frequency: 'one-time', status: 'completed', donorName: 'SOKONI User',
        anonymous: false, orderId: orderId || null, dateStr,
        createdAt: _now(), updatedAt: _now(), completedAt: _now(),
      });

      /* Write to Foundation ledger */
      await _writeLedgerEntry(txn, {
        type:        type === 'roundup' ? 'roundup' : 'marketplace_contribution',
        credit:      amt, debit: 0, uid,
        orderId:     orderId || null,
        description: type === 'roundup' ? `Round-up donation from order ${orderId}` : `Checkout donation — ${destination}`,
      });

      /* Update stats */
      txn.set(fdb().collection('foundationStats').doc('current'), {
        totalDonations: _incr(amt), totalDonors: _incr(1), updatedAt: _now(),
      }, { merge: true });
    });

    return { ok: true, donationId: donId };
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

    const ref = fdb().collection('impactCampaigns').doc(campaignId);
    const updates = { updatedAt: _now() };

    if (status   !== undefined) updates.status   = _san(status, 20);
    if (verified !== undefined) updates.verified  = !!verified;
    if (raised   !== undefined) updates.raised    = Math.round(Number(raised) || 0);
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
   12. impactInitiateDisbursement — Level 1: initiate payout
   Only admin can start; requires a second admin to approve
══════════════════════════════════════════════════════════ */
exports.impactInitiateDisbursement = onCall(
  { timeoutSeconds: 20, enforceAppCheck: true },
  async (request) => {
    if (!_isAdmin(request.auth)) throw new HttpsError('permission-denied', 'Admin only.');
    const uid = request.auth.uid;
    const { campaignId, grantId, beneficiaryPhone, beneficiaryName, amount, description } = request.data || {};

    const amt = Math.round(Number(amount) || 0);
    if (amt < 100) throw new HttpsError('invalid-argument', 'Minimum disbursement KES 100.');
    if (!beneficiaryPhone || !beneficiaryName) throw new HttpsError('invalid-argument', 'Beneficiary details required.');

    /* Check Foundation balance */
    const balSnap = await fdb().collection('impactBalance').doc('current').get();
    const available = balSnap.exists ? (balSnap.data().balance || 0) : 0;
    if (amt > available) throw new HttpsError('failed-precondition', `Insufficient Foundation balance. Available: KES ${available.toLocaleString()}.`);

    const ref = fdb().collection('impactDisbursements').doc();
    await ref.set({
      id: ref.id, campaignId: campaignId || null, grantId: grantId || null,
      beneficiaryPhone: _san(beneficiaryPhone, 20),
      beneficiaryName:  _san(beneficiaryName, 100),
      amount: amt, description: _san(description, 500) || '',
      status:           'pending_approval',
      initiatedBy:      uid, initiatedAt:  _now(),
      approvedBy:       null, approvedAt:   null,
      authorizedBy:     null, authorizedAt: null,
      executedAt:       null, paymentRef:   null,
      auditLog: [{ action: 'initiated', by: uid, at: new Date().toISOString(), note: 'Disbursement initiated' }],
    });

    return { ok: true, disbursementId: ref.id };
  }
);

/* ══════════════════════════════════════════════════════════
   13. impactApproveDisbursement — Level 2: approve
   Must be a DIFFERENT admin from the initiator
══════════════════════════════════════════════════════════ */
exports.impactApproveDisbursement = onCall(
  { timeoutSeconds: 20, enforceAppCheck: true },
  async (request) => {
    if (!_isAdmin(request.auth)) throw new HttpsError('permission-denied', 'Admin only.');
    const uid = request.auth.uid;
    const { disbursementId } = request.data || {};
    if (!disbursementId) throw new HttpsError('invalid-argument', 'disbursementId required.');

    const ref  = fdb().collection('impactDisbursements').doc(disbursementId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Disbursement not found.');
    const d = snap.data();

    if (d.status !== 'pending_approval') throw new HttpsError('failed-precondition', 'Disbursement not in pending approval state.');
    if (d.initiatedBy === uid) throw new HttpsError('permission-denied', 'Approver must be different from initiator.');

    await ref.update({
      status: 'pending_authorization', approvedBy: uid, approvedAt: _now(),
      auditLog: admin.firestore.FieldValue.arrayUnion({ action: 'approved', by: uid, at: new Date().toISOString() }),
    });

    return { ok: true };
  }
);

/* ══════════════════════════════════════════════════════════
   14. impactAuthorizeDisbursement — Level 3: final auth + execute payout
   Requires superAdmin. Executes the IntaSend B2C payout.
══════════════════════════════════════════════════════════ */
exports.impactAuthorizeDisbursement = onCall(
  { timeoutSeconds: 60, enforceAppCheck: true, secrets: [INTASEND_PRIVATE_KEY] },
  async (request) => {
    const isSuperAdmin = request.auth?.token?.superAdmin === true || request.auth?.token?.role === 'superAdmin';
    if (!isSuperAdmin) throw new HttpsError('permission-denied', 'Super admin authorization required.');
    const uid = request.auth.uid;
    const { disbursementId } = request.data || {};
    if (!disbursementId) throw new HttpsError('invalid-argument', 'disbursementId required.');

    const ref  = fdb().collection('impactDisbursements').doc(disbursementId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Disbursement not found.');
    const disburse = snap.data();

    if (disburse.status !== 'pending_authorization') throw new HttpsError('failed-precondition', 'Disbursement not approved yet.');
    if (disburse.approvedBy === uid) throw new HttpsError('permission-denied', 'Final authorizer must differ from approver.');

    /* Execute M-Pesa B2C */
    const privKey = INTASEND_PRIVATE_KEY.value();
    const isSandbox = process.env.INTASEND_SANDBOX === 'true';
    const base = isSandbox ? 'https://sandbox.intasend.com' : 'https://payment.intasend.com';
    const cleanPhone = _phone(disburse.beneficiaryPhone);

    const payRes = await new Promise((resolve, reject) => {
      const payload = JSON.stringify({
        currency: 'KES', provider: 'M-PESA',
        amount:   String(disburse.amount),
        phone_number: cleanPhone,
        name:     disburse.beneficiaryName,
        account:  disbursementId,
        narrative: disburse.description || 'SOKONI Impact Disbursement',
      });
      const req = require('https').request({
        hostname: isSandbox ? 'sandbox.intasend.com' : 'payment.intasend.com',
        path:    '/api/v1/payment/mpesa-b2c/initiate/',
        method:  'POST',
        headers: { 'Authorization': `Bearer ${privKey}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      }, res => {
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(body) }); } catch(_) { reject(new Error('Parse error')); } });
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });

    if (payRes.status !== 200 && payRes.status !== 201) {
      throw new HttpsError('internal', payRes.data?.detail || 'Payout failed.');
    }

    const payRef = payRes.data?.tracking_id || payRes.data?.id || disbursementId;

    /* Write to ledger + mark disbursement complete */
    await fdb().runTransaction(async txn => {
      await _writeLedgerEntry(txn, {
        type: 'disbursement', debit: disburse.amount, credit: 0,
        uid:         disburse.initiatedBy,
        campaignId:  disburse.campaignId,
        paymentRef:  payRef,
        description: `Disbursement to ${disburse.beneficiaryName} (${cleanPhone}) — ${disburse.description}`,
      });

      txn.update(ref, {
        status: 'completed', authorizedBy: uid, authorizedAt: _now(),
        executedAt: _now(), paymentRef: payRef,
        auditLog: admin.firestore.FieldValue.arrayUnion({
          action: 'executed', by: uid, at: new Date().toISOString(), payRef,
        }),
      });
    });

    return { ok: true, paymentRef: payRef };
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
