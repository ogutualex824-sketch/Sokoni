'use strict';

/**
 * SOKONI Profile & Identity Engine v1.0
 *
 * "One Person. One Identity. One SOKONI Life."
 *
 * Powers the Next Generation Profile & Identity Center:
 *   - Full profile aggregation (verifications, employment, businesses, wallet)
 *   - Trust Score calculation (0–100) across 9 verification dimensions
 *   - Profile completion steps with AI-style recommendations
 *   - Achievement badges and milestone tracking
 *   - Cross-hub activity timeline
 *   - Digital business card data
 *   - Personalization preferences
 *   - Document vault
 *
 * Query strategy: all queries use single-field where clauses so no composite
 * indexes are consumed. Sorting and cross-field filtering happens in JS.
 * Index count is preserved at 199/200.
 */

const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
/* Markup lives in profile-page.js — the engine owns data, not presentation. */
const { renderProfilePage: _profilePage, renderProfileError: _profileErrorPage } = require('./profile-page');
/* Canonical verification vocabulary — one facet list, shared with the engine. */
const { activeFacets: _activeFacets, primaryBadge: _primaryBadge } = require('./verification-vocabulary');

if (!admin.apps.length) admin.initializeApp();

const db        = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

/* ── Internal helpers ─────────────────────────────────────────── */

function _assertAuth(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  return req.auth.uid;
}

/** Generate the canonical SOKONI ID from a Firebase UID. */
function _sokoniId(uid) {
  const hex = uid.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase();
  return 'SKN-' + (hex || uid.slice(-8).toUpperCase());
}

/** Calculate trust score (0–100) across verification dimensions. */
function _trustScore(user = {}, verif = {}, bizCount = 0) {
  const factors = [];
  let score = 0;

  /* Facets are the single source of truth — see verification-vocabulary.js.
     `activeFacets` counts a facet only while approved AND unexpired, so a lapsed
     licence stops contributing without any sweep job. Email and phone stay
     self-service booleans on users/{uid}; they were never admin-decided.
     `merchantVerified` folded into `business`, and its 5 points folded with it
     (10 → 15) so the reachable ceiling is unchanged. */
  const _active = _activeFacets(verif);

  if (verif.emailVerified   || user.emailVerified)   { score += 15; factors.push('Email Verified'); }
  if (verif.phoneVerified   || user.phoneVerified)   { score += 15; factors.push('Phone Verified'); }
  if (_active.has('identity'))                       { score += 20; factors.push('Identity Verified'); }
  if (_active.has('business') || bizCount > 0)       { score += 15; factors.push('Business Verified'); }
  if (_active.has('kra'))                            { score += 10; factors.push('KRA Verified'); }
  if (_active.has('address'))                        { score += 5;  factors.push('Address Verified'); }
  if (_active.has('bank'))                           { score += 10; factors.push('Payment Verified'); }
  if (user.photoURL)                                 { score += 5;  factors.push('Profile Photo'); }
  if (user.legalSigned)                              { score += 5;  factors.push('Legal Agreements'); }

  const capped = Math.min(score, 100);
  const level  = capped >= 90 ? 'Platinum'
               : capped >= 70 ? 'Gold'
               : capped >= 45 ? 'Silver'
               : 'Bronze';

  return { score: capped, level, factors };
}

/** Calculate profile completion steps. */
/**
 * OWNER-ONLY presentation state for non-approved facets.
 *
 * Returns the minimum a profile needs to say "pending" / "needs attention" /
 * "expired" and nothing more. Explicitly NOT the request document: no evidence
 * array, no uploaded file references, no decidedBy, no applicant fields. Those
 * remain in verificationRequests and the document vault, both owner-or-admin.
 *
 * `approved` facets are omitted — they are already carried by verifications{},
 * and repeating them would create a second place to ask the same question.
 * An approved-but-expired facet surfaces here as `expired`, because otherwise a
 * lapsed credential just vanishes with no explanation to the person who holds it.
 */
function _facetStates(verif = {}) {
  const out = {};
  const facets = (verif && verif.facets) || {};
  const now = Date.now();

  for (const [facet, rec] of Object.entries(facets)) {
    if (!rec || !rec.state) continue;

    let state = rec.state;
    let expiresAt = null;

    if (state === 'approved') {
      const exp = rec.expiresAt;
      if (!exp) continue;                       /* approved + no expiry — nothing to say */
      const ms = exp.toMillis ? exp.toMillis()
               : exp._seconds ? exp._seconds * 1000
               : new Date(exp).getTime();
      if (isNaN(ms) || ms > now) continue;      /* still valid — carried by verifications{} */
      state = 'expired';
      expiresAt = new Date(ms).toISOString();
    }

    out[facet] = { state };
    if (expiresAt) out[facet].expiresAt = expiresAt;
    /* The rejection reason is the one free-text field worth returning: without it
       "needs attention" is another dead end. It is admin-authored copy, not
       applicant PII. */
    if (state === 'rejected' && rec.reason) out[facet].reason = String(rec.reason).slice(0, 300);
  }
  return out;
}

function _completion(user = {}, verif = {}, prof = {}) {
  /* Facets, not the retired *Verified booleans. Reading the dead shape here made
     identity/address/bank/kra impossible to complete, so the strength percentage
     was permanently understated — a visibly wrong number, which is exactly what
     the no-fabricated-metrics rule forbids. */
  const _f = _activeFacets(verif);
  const steps = [
    { id:'photo',    label:'Add profile photo',         done: !!user.photoURL },
    { id:'bio',      label:'Write a bio / headline',    done: !!(prof.headline || prof.summary || user.bio) },
    { id:'email',    label:'Verify email address',      done: !!(verif.emailVerified || user.emailVerified) },
    { id:'phone',    label:'Verify phone number',       done: !!(verif.phoneVerified || user.phoneVerified) },
    { id:'identity', label:'Verify identity (ID/passport)', done: _f.has('identity') },
    { id:'address',  label:'Add physical address',      done: !!(user.address || user.location) || _f.has('address') },
    { id:'skills',   label:'Add at least 3 skills',     done: (prof.skills || []).length >= 3 },
    { id:'cert',     label:'Upload a certificate',      done: (prof.certifications || []).length > 0 },
    { id:'bank',     label:'Add bank / payment method', done: _f.has('bank') },
    { id:'kra',      label:'Add KRA PIN',               done: _f.has('kra') },
  ];

  const done    = steps.filter(s => s.done).length;
  const percent = Math.round((done / steps.length) * 100);

  return { percent, done, total: steps.length, steps };
}

/* ═══════════════════════════════════════════════════════════════
   PROFILE OVERVIEW
   Full aggregation — user, verifications, career, employment,
   business count, wallet balance, trust score, completion.
   Public data when viewing another user; private data for self.
   ═══════════════════════════════════════════════════════════════ */
exports.profileGetOverview = onCall({ region: 'us-central1' }, async (req) => {
  const callerId = _assertAuth(req);
  const { targetUid } = req.data || {};
  const uid     = targetUid || callerId;
  const isOwner = uid === callerId;

  const [userSnap, verifSnap, profSnap, memberSnap, bizSnap, walletSnap] = await Promise.all([
    db.collection('users').doc(uid).get(),
    db.collection('verifications').doc(uid).get().catch(() => null),
    db.collection('professionalProfiles').doc(uid).get().catch(() => null),
    db.collection('workspaceMemberships').where('uid', '==', uid).where('status', '==', 'active').get().catch(() => null),
    db.collection('businesses').where('ownerId', '==', uid).get().catch(() => null),
    isOwner ? db.collection('wallets').doc(uid).get().catch(() => null) : Promise.resolve(null),
  ]);

  const user  = userSnap.exists ? userSnap.data() : {};
  const verif = verifSnap?.exists  ? verifSnap.data()  : {};
  const prof  = profSnap?.exists   ? profSnap.data()   : {};
  const bizCount = bizSnap?.size   || 0;
  const wallet   = walletSnap?.exists ? walletSnap.data() : null;

  const trust = _trustScore(user, verif, bizCount);
  const compl = _completion(user, verif, prof);
  const _facets = _activeFacets(verif);
  const sid   = _sokoniId(uid);

  // Filter active memberships (not resigned/terminated/archived)
  const TERMINAL = new Set(['resigned', 'terminated', 'archived']);
  const activeWorkspaces = (memberSnap?.docs || [])
    .filter(d => !TERMINAL.has(d.data().employmentStatus))
    .map(d => {
      const m = d.data();
      return {
        membershipId: d.id,
        businessId:   m.businessId,
        businessName: m.businessName || '',
        role:         m.role         || '',
        roleTitle:    m.roleTitle    || '',
        branch:       m.branchName   || '',
        department:   m.department   || '',
        status:       m.status,
        employmentStatus: m.employmentStatus || 'active',
      };
    });

  return {
    uid,
    sokoniId:      sid,
    displayName:   user.displayName || user.name || '',
    username:      user.username    || user.handle || '',
    email:         isOwner ? (user.email || null) : null,
    phone:         isOwner ? (user.phone || null) : null,
    photoURL:      user.photoURL    || null,
    coverPhotoURL: user.coverPhotoURL || null,
    headline:      prof.headline    || '',
    summary:       prof.summary     || '',
    location:      user.location    || user.address || '',
    website:       user.website     || prof.website || '',
    createdAt:     user.createdAt   || null,
    roles:         user.roles       || ['buyer'],
    subscription:  user.planId      || 'free',
    /* Derived from canonical facets. APPROVED-and-unexpired only: a pending,
       rejected, revoked or expired facet is never "verified" here, so it cannot
       leak into trust score, completion, achievements or any badge. Email, phone
       and legal remain self-service booleans and were never admin-decided.
       `merchant` folded into `business`. */
    verifications: {
      email:          !!(verif.emailVerified || user.emailVerified),
      phone:          !!(verif.phoneVerified || user.phoneVerified),
      legal:          !!user.legalSigned,
      identity:       _facets.has('identity'),
      business:       _facets.has('business') || bizCount > 0,
      professional:   _facets.has('professional'),
      driver:         _facets.has('driver'),
      doctor:         _facets.has('doctor'),
      lawyer:         _facets.has('lawyer'),
      property_agent: _facets.has('property_agent'),
      kra:            _facets.has('kra'),
      address:        _facets.has('address'),
      bank:           _facets.has('bank'),
    },
    /* OWNER ONLY. Minimum presentation state so the profile can say "pending",
       "needs attention" or "expired" instead of silently showing nothing — the
       dead-end the old flow had. Deliberately NOT the request document: no
       evidence, no uploaded files, no decidedBy, no KYC material. Those stay in
       the protected vault. Null for anyone viewing another user's profile, and
       the public projection remains approved-only regardless. */
    facetStates: isOwner ? _facetStates(verif) : null,
    trust,
    profileCompletion: compl,
    businessCount:     bizCount,
    workspaceCount:    activeWorkspaces.length,
    activeWorkspaces:  activeWorkspaces.slice(0, 5),
    languages:         prof.languages   || [],
    skills:            (prof.skills     || []).slice(0, 12),
    wallet: isOwner && wallet ? {
      available: wallet.available || wallet.balance || 0,
      pending:   wallet.pending   || 0,
    } : null,
    profileUrl: `https://mysokoni.co.ke/profile/${uid}`,
  };
});

/* ═══════════════════════════════════════════════════════════════
   PROFILE COMPLETION + AI RECOMMENDATIONS
   ═══════════════════════════════════════════════════════════════ */
exports.profileGetCompletion = onCall({ region: 'us-central1' }, async (req) => {
  const uid = _assertAuth(req);

  const [userSnap, verifSnap, profSnap, bizSnap] = await Promise.all([
    db.collection('users').doc(uid).get(),
    db.collection('verifications').doc(uid).get().catch(() => null),
    db.collection('professionalProfiles').doc(uid).get().catch(() => null),
    db.collection('businesses').where('ownerId', '==', uid).limit(1).get().catch(() => null),
  ]);

  const user   = userSnap.exists  ? userSnap.data()  : {};
  const verif  = verifSnap?.exists ? verifSnap.data() : {};
  const prof   = profSnap?.exists  ? profSnap.data()  : {};
  const hasBiz = (bizSnap?.size   || 0) > 0;

  const compl = _completion(user, verif, prof);
  const trust = _trustScore(user, verif, hasBiz ? 1 : 0);

  // Rule-based recommendations (KASS-style, no LLM call needed for this)
  const recommendations = [];
  const pending = compl.steps.filter(s => !s.done);

  const IMPACTS = {
    photo:    { impact: '+5 Trust Score', cta: 'Upload a profile photo', href: null },
    bio:      { impact: 'Better discoverability', cta: 'Add a bio or headline', href: 'professional-profile.html' },
    email:    { impact: '+15 Trust Score', cta: 'Verify your email address', href: 'account-centre.html#verification' },
    phone:    { impact: '+15 Trust Score', cta: 'Verify your phone number', href: 'account-centre.html#verification' },
    identity: { impact: '+20 Trust Score', cta: 'Verify your identity (ID/passport)', href: 'account-centre.html#verification' },
    address:  { impact: '+5 Trust Score', cta: 'Add your physical address', href: null },
    skills:   { impact: 'Appear in professional search', cta: 'Add 3+ skills to your profile', href: 'professional-profile.html' },
    cert:     { impact: 'Build credibility', cta: 'Upload a certificate', href: 'professional-profile.html' },
    bank:     { impact: '+10 Trust Score · Enable withdrawals', cta: 'Add a bank account', href: 'account-centre.html#payments' },
    kra:      { impact: '+10 Trust Score · Enable invoicing', cta: 'Add your KRA PIN', href: 'account-centre.html#verification' },
  };

  pending.slice(0, 4).forEach(s => {
    const info = IMPACTS[s.id] || { impact: 'Improves profile', cta: s.label, href: null };
    recommendations.push({ id: s.id, action: info.cta, impact: info.impact, href: info.href });
  });

  return {
    ...compl,
    trustScore: trust.score,
    trustLevel: trust.level,
    recommendations,
  };
});

/* ═══════════════════════════════════════════════════════════════
   ACHIEVEMENTS & BADGES
   Computed from cross-hub activity — zero composite indexes.
   ═══════════════════════════════════════════════════════════════ */
exports.profileGetAchievements = onCall({ region: 'us-central1' }, async (req) => {
  const uid = _assertAuth(req);

  const [ordersAsBuyer, ordersAsSeller, bizSnap, memberSnap, userSnap, verifSnap] = await Promise.all([
    db.collection('orders').where('customerId', '==', uid).limit(500).get().catch(() => null),
    db.collection('orders').where('sellerId',   '==', uid).limit(500).get().catch(() => null),
    db.collection('businesses').where('ownerId', '==', uid).get().catch(() => null),
    db.collection('workspaceMemberships').where('uid', '==', uid).get().catch(() => null),
    db.collection('users').doc(uid).get(),
    db.collection('verifications').doc(uid).get().catch(() => null),
  ]);

  const user      = userSnap.exists   ? userSnap.data()   : {};
  const verif     = verifSnap?.exists ? verifSnap.data()  : {};
  const buyCount  = ordersAsBuyer?.size  || 0;
  const sellCount = ordersAsSeller?.size || 0;
  const bizCount  = bizSnap?.size        || 0;
  const empCount  = memberSnap?.docs.filter(d => d.data().status === 'active').length || 0;
  const allEmpCount = memberSnap?.size   || 0;

  // Membership age
  const createdSecs = user.createdAt?.seconds || user.createdAt?._seconds || null;
  const ageMs  = createdSecs ? (Date.now() - createdSecs * 1000) : 0;
  const ageYrs = ageMs / (365.25 * 24 * 3600 * 1000);

  /* identity comes from the canonical facets; email/phone stay self-service
     booleans. Reading verif.identityVerified made this badge unreachable. */
  const _achFacets = _activeFacets(verif);
  const allVerified = !!verif.emailVerified && !!verif.phoneVerified && _achFacets.has('identity');

  /* ── Earned badges ── */
  const badges = [];
  const _badge = (id, label, icon, desc) => badges.push({ id, label, icon, desc, earned: true });

  if (buyCount  >= 1)    _badge('first_purchase',  'First Purchase',       '🛍️', 'Placed your first order');
  if (buyCount  >= 10)   _badge('regular_shopper', 'Regular Shopper',      '🛒', `${buyCount} orders placed`);
  if (buyCount  >= 50)   _badge('power_buyer',     'Power Buyer',          '⚡', `${buyCount} orders placed`);
  if (buyCount  >= 200)  _badge('elite_buyer',     'Elite Buyer',          '💎', `${buyCount} orders placed`);
  if (sellCount >= 1)    _badge('first_sale',      'First Sale',           '💰', 'Made your first sale');
  if (sellCount >= 25)   _badge('active_seller',   'Active Seller',        '🏪', `${sellCount} sales`);
  if (sellCount >= 100)  _badge('top_seller',      'Top Seller',           '🏆', `${sellCount} sales`);
  if (sellCount >= 500)  _badge('power_seller',    'Power Seller',         '🔥', `${sellCount} sales`);
  if (bizCount  >= 1)    _badge('entrepreneur',    'Entrepreneur',         '🏢', 'Registered a business');
  if (bizCount  >= 3)    _badge('mogul',           'Business Mogul',       '💼', `${bizCount} businesses`);
  if (empCount  >= 1)    _badge('team_member',     'Team Member',          '👥', 'Active in an organization');
  if (allEmpCount >= 3)  _badge('multi_org',       'Multi-Org Pro',        '🌐', `${allEmpCount} organizations`);
  if (allVerified)       _badge('verified_id',     'Fully Verified',       '✅', 'All core verifications done');
  /* merchantVerified folded into the `business` facet — one fact, one name. */
  if (_achFacets.has('business')) _badge('trusted_merchant', 'Trusted Merchant', '🏅', 'Business verified by SOKONI');
  if (ageYrs >= 0.5)     _badge('established',     'Established Member',   '✨', '6+ months on SOKONI');
  if (ageYrs >= 1)       _badge('year_1',          '1 Year on SOKONI',     '🎖️', 'Loyal member');
  if (ageYrs >= 2)       _badge('year_2',          '2 Years on SOKONI',    '🥈', '2 years of excellence');
  if (ageYrs >= 3)       _badge('year_3',          '3 Years on SOKONI',    '🥇', '3 years of excellence');
  if (user.photoURL && (user.bio || user.headline)) _badge('complete_profile', 'Complete Profile', '⭐', 'Profile looks great');

  /* ── Upcoming (next milestone not yet reached) ── */
  const upcoming = [];
  const _upcoming = (id, label, icon, curr, target) => upcoming.push({
    id, label, icon, progress: Math.min(curr / target, 1), current: curr, target,
    requirement: `${Math.max(0, target - curr)} more needed`,
  });

  if (buyCount  < 10 && buyCount  > 0)   _upcoming('regular_shopper', 'Regular Shopper', '🛒', buyCount,  10);
  if (buyCount  < 50 && buyCount  >= 10)  _upcoming('power_buyer',     'Power Buyer',     '⚡', buyCount,  50);
  if (sellCount < 25 && sellCount > 0)    _upcoming('active_seller',   'Active Seller',   '🏪', sellCount, 25);
  if (sellCount < 100 && sellCount >= 25) _upcoming('top_seller',      'Top Seller',      '🏆', sellCount, 100);
  if (ageYrs < 1 && ageYrs >= 0.5)        _upcoming('year_1',          '1 Year Member',   '🎖️', Math.floor(ageYrs * 12), 12);

  return {
    badges,
    upcoming: upcoming.slice(0, 4),
    stats: { buyCount, sellCount, bizCount, empCount: allEmpCount, ageYrs: Math.floor(ageYrs * 10) / 10 },
  };
});

/* ═══════════════════════════════════════════════════════════════
   ACTIVITY TIMELINE
   Cross-hub events — orders as buyer, sales, shifts.
   Sorted client-side from single-field queries to avoid indexes.
   ═══════════════════════════════════════════════════════════════ */
exports.profileGetActivityTimeline = onCall({ region: 'us-central1' }, async (req) => {
  const uid = _assertAuth(req);
  const { limit: lim = 30 } = req.data || {};
  const n = Math.min(lim, 50);

  const [buyerSnap, sellerSnap, shiftSnap] = await Promise.all([
    db.collection('orders').where('customerId', '==', uid).limit(n).get().catch(() => null),
    db.collection('orders').where('sellerId',   '==', uid).limit(n).get().catch(() => null),
    db.collection('shiftSessions').where('uid', '==', uid).limit(15).get().catch(() => null),
  ]);

  const events = [];

  (buyerSnap?.docs || []).forEach(d => {
    const o = d.data();
    events.push({
      type:   'order',
      id:     d.id,
      label:  `Order from ${o.sellerName || o.businessName || 'Store'}`,
      ref:    '#' + d.id.slice(-6).toUpperCase(),
      amount: o.totalAmount || 0,
      status: o.status || 'placed',
      ts:     o.createdAt?.seconds || 0,
      icon:   '🛍️',
    });
  });

  (sellerSnap?.docs || []).forEach(d => {
    const o = d.data();
    events.push({
      type:   'sale',
      id:     'sale_' + d.id,
      label:  `Sale to ${o.customerName || 'Customer'}`,
      ref:    '#' + d.id.slice(-6).toUpperCase(),
      amount: o.totalAmount || 0,
      status: o.status || 'completed',
      ts:     o.createdAt?.seconds || 0,
      icon:   '💰',
    });
  });

  (shiftSnap?.docs || []).forEach(d => {
    const s = d.data();
    const duration = s.durationMinutes
      ? `${Math.round(s.durationMinutes / 60 * 10) / 10}h`
      : 'Active';
    events.push({
      type:   'shift',
      id:     d.id,
      label:  `Shift at ${s.businessName || 'Business'}`,
      ref:    '',
      amount: null,
      status: s.clockedOut ? 'completed' : 'active',
      detail: duration,
      ts:     s.clockedInAt?.seconds || 0,
      icon:   '⏱️',
    });
  });

  events.sort((a, b) => b.ts - a.ts);

  return { events: events.slice(0, n) };
});

/* ═══════════════════════════════════════════════════════════════
   DIGITAL BUSINESS CARD
   Returns all data needed to render the card client-side.
   ═══════════════════════════════════════════════════════════════ */
exports.profileGenerateCard = onCall({ region: 'us-central1' }, async (req) => {
  const callerId = _assertAuth(req);
  const { targetUid } = req.data || {};
  const uid = targetUid || callerId;

  const [userSnap, profSnap, verifSnap, memberSnap] = await Promise.all([
    db.collection('users').doc(uid).get(),
    db.collection('professionalProfiles').doc(uid).get().catch(() => null),
    db.collection('verifications').doc(uid).get().catch(() => null),
    db.collection('workspaceMemberships')
      .where('uid', '==', uid)
      .where('status', '==', 'active')
      .limit(3)
      .get()
      .catch(() => null),
  ]);

  const user  = userSnap.exists  ? userSnap.data()  : {};
  const prof  = profSnap?.exists  ? profSnap.data()  : {};
  const verif = verifSnap?.exists ? verifSnap.data() : {};

  // Active workspaces for card
  const workspaces = (memberSnap?.docs || []).map(d => {
    const m = d.data();
    return { businessName: m.businessName || '', role: m.roleTitle || m.role || '' };
  });

  /* Canonical facets. The previous shape scanned for keys ending in 'Verified',
     which nothing ever wrote — so this list was permanently empty. */
  const verifiedTypes = [..._activeFacets(verif)];
  const primaryBadge  = _primaryBadge(verifiedTypes);

  return {
    sokoniId:      _sokoniId(uid),
    displayName:   user.displayName || user.name || 'SOKONI Member',
    photoURL:      user.photoURL    || null,
    headline:      prof.headline    || (workspaces[0] ? `${workspaces[0].role} at ${workspaces[0].businessName}` : ''),
    email:         uid === callerId ? (user.email || null) : null,
    phone:         uid === callerId ? (user.phone || null) : null,
    website:       user.website     || prof.website || null,
    location:      user.location    || '',
    primaryWorkspace: workspaces[0] || null,
    skills:        (prof.skills || []).slice(0, 5),
    isVerified:    verifiedTypes.length > 0,
    verifiedTypes,
    primaryBadge,
    profileUrl:    `https://mysokoni.co.ke/profile/${uid}`,
  };
});

/* ═══════════════════════════════════════════════════════════════
   PUBLIC PROFILE  (onRequest GET — no auth)

   Backs https://mysokoni.co.ke/profile/{uid}, the URL every other
   function in this file already hands out as `profileUrl`. Until
   this existed that path had no hosting rewrite and hard-404'd, so
   every shared profile link was dead and the client fell back to
   sharing /profile — the owner's private dashboard shell.

   This is the ONLY profile endpoint reachable without auth, so the
   allowlist below is the whole security boundary. It is built by
   naming each field explicitly; a spread of the user document here
   would leak email, phone and wallet in one edit. Never widen it to
   a spread, and never echo a field the owner did not publish.

   Deliberately NOT returned: email, phone, wallet, documents,
   orders, KRA/bank verification detail, and the numeric trust score
   (the coarse level is a public signal; the exact number is not).
   ═══════════════════════════════════════════════════════════════ */
exports.profileGetPublicProfile = onRequest(
  /* minInstances: 1 — this function IS the page at /profile/{uid}, so a cold
     start is not a slow API call, it is a blank screen on a link somebody just
     tapped in WhatsApp. One warm instance is the cost of that path being a
     function at all. */
  { region: 'us-central1', cors: false, minInstances: 1, memory: '256MiB' },
  async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    /* The response varies on nothing but the path, but it IS shared cache
       content — say so explicitly so no intermediary keys it on a cookie. */
    res.set('Vary', 'Accept-Encoding');

    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'GET')     { res.status(405).send('Method not allowed.'); return; }

    /* Served through a hosting rewrite at /profile/**, so the uid arrives as a
       path segment. ?uid= is kept working for direct calls and for the JSON
       mode used by non-browser clients. */
    const fromPath = (req.path || '').match(/^\/profile\/([^/?#]+)/);
    const uid = decodeURIComponent(fromPath ? fromPath[1] : String(req.query.uid || '')).trim();
    const wantsJson = String(req.query.format || '').toLowerCase() === 'json';

    /* Firebase UIDs are 28 alphanumerics. Validating the shape before
       touching Firestore turns a scripted scan of this open endpoint into
       a rejected string compare rather than a billed document read. */
    if (!/^[A-Za-z0-9]{20,64}$/.test(uid)) {
      res.set('Cache-Control', 'public, max-age=300');
      if (wantsJson) { res.status(400).json({ error: 'A valid uid is required.' }); return; }
      res.status(404).send(_profileErrorPage(
        'Profile not found',
        'This link does not point to a SOKONI profile.'
      ));
      return;
    }

    try {
      const [userSnap, profSnap, verifSnap, handleSnap] = await Promise.all([
        db.collection('users').doc(uid).get(),
        db.collection('professionalProfiles').doc(uid).get().catch(() => null),
        db.collection('verifications').doc(uid).get().catch(() => null),
        /* Single-field query — no composite index consumed (see file header). */
        db.collection('shopHandles').where('uid', '==', uid).limit(1).get().catch(() => null),
      ]);

      /* A missing user and a user who opted out are answered identically.
         Distinguishing them would turn this endpoint into an oracle that
         confirms whether a given uid exists. */
      const user = userSnap.exists ? userSnap.data() : null;
      if (!user || user.profileVisibility === 'private') {
        res.set('Cache-Control', 'public, max-age=60');
        if (wantsJson) { res.status(404).json({ found: false }); return; }
        res.status(404).send(_profileErrorPage(
          'Profile unavailable',
          'This profile is private or no longer exists.'
        ));
        return;
      }

      const prof  = profSnap?.exists  ? profSnap.data()  : {};
      const verif = verifSnap?.exists ? verifSnap.data() : {};

      /* Badge NAMES only. The underlying documents stay private.
         The full active set is returned — a provider who is both a doctor and a
         business is BOTH, and the projection says so. `primaryBadge` is a
         presentation convenience for surfaces that can show only one. */
      const verifiedTypes = [..._activeFacets(verif)];
      const primaryBadge  = _primaryBadge(verifiedTypes);

      const shopDoc = handleSnap && !handleSnap.empty ? handleSnap.docs[0] : null;

      /* createdAt is exposed as a year-month string. The exact signup
         timestamp is a correlation handle and is not public data. */
      let memberSince = '';
      try {
        const created = user.createdAt?.toDate ? user.createdAt.toDate()
                      : user.createdAt ? new Date(user.createdAt) : null;
        if (created && !isNaN(created)) memberSince = created.toISOString().slice(0, 7);
      } catch (_) { /* unparseable timestamp is simply omitted */ }

      const payload = {
        found:         true,
        uid,
        sokoniId:      _sokoniId(uid),
        displayName:   user.displayName || user.name || 'SOKONI Member',
        photoURL:      user.photoURL    || null,
        headline:      prof.headline    || '',
        location:      user.location    || '',
        skills:        (prof.skills     || []).slice(0, 5),
        isVerified:    verifiedTypes.length > 0,
        verifiedTypes,
        primaryBadge,
        trustLevel:    _trustScore(user, verif, 0).level,
        memberSince,
        shop: shopDoc ? {
          handle: shopDoc.id,
          url:    `https://mysokoni.co.ke/shop/${shopDoc.id}`,
        } : null,
        profileUrl:    `https://mysokoni.co.ke/profile/${uid}`,
      };

      /* Public profiles are identical for every viewer, so they are safe to
         cache at the edge. This is also what keeps the endpoint cheap under
         a link that may be forwarded to a large WhatsApp group at once. */
      res.set('Cache-Control', 'public, max-age=300, s-maxage=600, stale-while-revalidate=86400');
      if (wantsJson) { res.status(200).json(payload); return; }
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(_profilePage(payload));
    } catch (err) {
      logger.error('[profile] public profile read failed', { uid, err: err.message });
      /* An error must never be cached as if it were the profile. */
      res.set('Cache-Control', 'no-store');
      if (wantsJson) { res.status(500).json({ error: 'Could not load this profile.' }); return; }
      res.status(500).send(_profileErrorPage(
        'Could not load this profile',
        'Something went wrong on our side. Please try again shortly.'
      ));
    }
  }
);

/* ═══════════════════════════════════════════════════════════════
   EMPLOYMENT OVERVIEW
   Current, past, and pending workspace memberships.
   ═══════════════════════════════════════════════════════════════ */
exports.profileGetEmployment = onCall({ region: 'us-central1' }, async (req) => {
  const uid = _assertAuth(req);

  const [memberSnap, inviteSnap] = await Promise.all([
    db.collection('workspaceMemberships').where('uid', '==', uid).get().catch(() => null),
    db.collection('workspaceInvitations').where('invitedEmail', '==', req.auth.token.email || '').where('status', '==', 'pending').get().catch(() => null),
  ]);

  const TERMINAL = new Set(['resigned', 'terminated', 'archived']);
  const current = [], past = [];

  (memberSnap?.docs || []).forEach(d => {
    const m = d.data();
    const entry = {
      membershipId:     d.id,
      businessId:       m.businessId,
      businessName:     m.businessName    || '',
      role:             m.role            || '',
      roleTitle:        m.roleTitle       || '',
      department:       m.department      || '',
      branch:           m.branchName      || '',
      employmentStatus: m.employmentStatus || 'active',
      employmentType:   m.employmentType  || 'permanent',
      joinedAt:         m.addedAt         || null,
    };
    if (m.status === 'active' && !TERMINAL.has(m.employmentStatus)) {
      current.push(entry);
    } else {
      past.push(entry);
    }
  });

  past.sort((a, b) => (b.joinedAt?.seconds || 0) - (a.joinedAt?.seconds || 0));

  const pending = (inviteSnap?.docs || []).map(d => {
    const inv = d.data();
    return {
      invitationId:  d.id,
      businessId:    inv.businessId,
      businessName:  inv.businessName || '',
      role:          inv.role         || '',
      invitedAt:     inv.sentAt       || null,
    };
  });

  return { current, past: past.slice(0, 20), pending };
});

/* ═══════════════════════════════════════════════════════════════
   PERSONALIZATION PREFERENCES
   Theme, language, currency, region, accessibility.
   ═══════════════════════════════════════════════════════════════ */
exports.profileUpdatePersonalization = onCall({ region: 'us-central1' }, async (req) => {
  const uid = _assertAuth(req);
  const { theme, accentColor, language, currency, region, accessibility } = req.data || {};

  const patch = {};
  if (theme        !== undefined) patch.theme        = theme;
  if (accentColor  !== undefined) patch.accentColor  = accentColor;
  if (language     !== undefined) patch.language     = language;
  if (currency     !== undefined) patch.currency     = currency;
  if (region       !== undefined) patch.region       = region;
  if (accessibility !== undefined) patch.accessibility = accessibility;

  if (!Object.keys(patch).length) throw new HttpsError('invalid-argument', 'No preferences provided.');

  patch.updatedAt = FieldValue.serverTimestamp();
  await db.collection('userPrefs').doc(uid).set(patch, { merge: true });

  return { ok: true };
});

/* ═══════════════════════════════════════════════════════════════
   DOCUMENT VAULT
   Lists stored documents. Upload handled client-side via Firebase Storage.
   ═══════════════════════════════════════════════════════════════ */
exports.profileGetDocumentVault = onCall({ region: 'us-central1' }, async (req) => {
  const uid = _assertAuth(req);

  const snap = await db.collection('userDocuments').doc(uid).collection('docs')
    .get()
    .catch(() => null);

  const documents = (snap?.docs || []).map(d => {
    const data = d.data();
    return {
      id:          d.id,
      name:        data.name        || 'Document',
      type:        data.type        || 'other',
      downloadUrl: data.downloadUrl || null,
      uploadedAt:  data.uploadedAt  || null,
      expiresAt:   data.expiresAt   || null,
      isVerified:  data.isVerified  || false,
    };
  });

  return { documents };
});

/* ═══════════════════════════════════════════════════════════════
   PROFESSIONAL PROFILE — READ
   Returns the full professionalProfiles/{uid} document.
   Covers Sprint 4: Career tab (headline, bio, skills, certs,
   licenses, education, memberships, portfolio, projects, languages).
   ═══════════════════════════════════════════════════════════════ */
exports.profileGetProfessional = onCall({ region: 'us-central1' }, async (req) => {
  const callerId = _assertAuth(req);
  const { targetUid } = req.data || {};
  const uid = targetUid || callerId;

  const snap = await db.collection('professionalProfiles').doc(uid).get().catch(() => null);
  if (!snap || !snap.exists) {
    return {
      headline: '', summary: '', skills: [], specializations: [], languages: [],
      availability: '', yearsExperience: null, industry: '',
      certifications: [], licenses: [], education: [],
      memberships: [], portfolio: [], projects: [],
    };
  }

  const d = snap.data();
  return {
    headline:        d.headline        || '',
    summary:         d.summary         || '',
    skills:          d.skills          || [],
    specializations: d.specializations || [],
    languages:       d.languages       || [],
    availability:    d.availability    || '',
    yearsExperience: d.yearsExperience ?? null,
    industry:        d.industry        || '',
    certifications:  d.certifications  || [],
    licenses:        d.licenses        || [],
    education:       d.education       || [],
    memberships:     d.memberships     || [],
    portfolio:       d.portfolio       || [],
    projects:        d.projects        || [],
    updatedAt:       d.updatedAt       || null,
  };
});

/* ═══════════════════════════════════════════════════════════════
   PROFESSIONAL PROFILE — WRITE
   Merges supplied fields into professionalProfiles/{uid}.
   Array fields are completely replaced (not appended) so the
   client sends the full updated array each time.
   ═══════════════════════════════════════════════════════════════ */
exports.profileSaveProfessional = onCall({ region: 'us-central1' }, async (req) => {
  const uid = _assertAuth(req);

  const ARRAY_FIELDS   = ['skills','specializations','languages','certifications','licenses','education','memberships','portfolio','projects'];
  const STRING_FIELDS  = ['headline','summary','availability','industry'];
  const NUMBER_FIELDS  = ['yearsExperience'];

  const patch = { updatedAt: FieldValue.serverTimestamp(), uid };

  STRING_FIELDS.forEach(f => {
    if (req.data[f] !== undefined) patch[f] = String(req.data[f] || '').slice(0, 2000);
  });
  NUMBER_FIELDS.forEach(f => {
    if (req.data[f] !== undefined) patch[f] = Number(req.data[f]) || null;
  });
  ARRAY_FIELDS.forEach(f => {
    if (Array.isArray(req.data[f])) patch[f] = req.data[f];
  });

  if (Object.keys(patch).length === 2) { // only updatedAt + uid
    throw new HttpsError('invalid-argument', 'No professional profile fields provided.');
  }

  await db.collection('professionalProfiles').doc(uid).set(patch, { merge: true });
  return { ok: true };
});
