'use strict';
/**
 * SOKONI POINTS — P1: EARNING (2026-09-29)
 *
 * OWNER DECISIONS
 *   · ONE SOKONI-wide balance per buyer — the canonical loyaltyAccounts/{uid} + loyaltyLedger (the same store online
 *     checkout already redeems from). No second points store.
 *   · EARN: 1 point for every KES 10 of a COMPLETED sale, computed by the SERVER from the AUTHORITATIVE amount.
 *   · VALUE: 10 points = KES 1 (P2 spends them). Each earn row records the ISSUING shop, so whichever funding rule P2
 *     lands on (the owner is confirming issuer vs redeeming shop) the ledger already carries what it needs.
 *
 * THE TILL NEVER HAS AUTHORITY OVER A BUYER'S ACCOUNT
 *   · A cashier types the buyer's phone. That is IDENTIFICATION, nothing more: the lookup returns a masked name and a
 *     balance; the points themselves are credited only by the sale the server just recorded, from its own total.
 *   · A buyer with no account can have one CREATED at the till — with their consent — and SOKONI texts them. The cashier
 *     receives no password, link or code: the buyer claims the account by signing in with their own number and a code
 *     texted to it. An existing number is never re-used or modified.
 *
 * Callables (App Check; the caller must be staff of the named shop):
 *   tillBuyerLookup({ shopId, phone })          → { found, maskedName, maskedPhone, points }
 *   tillCreateBuyer({ shopId, phone, name?, consent:true }) → { created|found, maskedName, maskedPhone, points }
 * Server-internal:
 *   earnForSale(db, { buyerUid | buyerPhone, issuerShopId, saleId, amountKES, source, shopName })
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();

const REGION = 'us-central1';
const KES_PER_POINT_EARNED = 10;            /* 1 point per KES 10 */
const POINT_VALUE_KES = 0.10;               /* 10 points = KES 1 */
const ORDER_SOURCES = ['online', 'card'];   /* one earn per (order, shop), whichever payment path confirms it */
const DAILY_CREATE_LIMIT = 100;             /* per shop per day — a till cannot mass-register numbers */
const TILL_ROLES = ['owner', 'admin', 'manager', 'cashier'];

const _db = () => admin.firestore();
const FV = () => admin.firestore.FieldValue;

function pointsForAmount(kes) {
  const n = Number(kes);
  return (Number.isFinite(n) && n > 0) ? Math.floor(n / KES_PER_POINT_EARNED) : 0;
}

function maskName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'SOKONI member';
  return parts.slice(0, 2).map((p) => p.charAt(0).toUpperCase() + '.').join(' ');
}
function maskPhone(p) { const d = String(p || '').replace(/\D/g, ''); return d.length >= 6 ? '••••' + d.slice(-3) : '••••'; }

function _wallet() { return require('./wallet-engine')._internal; }
function _loy() { return require('./loyalty')._internal; }

/** A phone in any common Kenyan form → "2547…" / "2541…", else null. */
function normalize(phone) { return _wallet().normalizePhone(phone); }

/** The SOKONI user who owns a phone, or null. The one resolver (wallet-engine) — Firestore users, then Firebase Auth. */
async function resolveBuyer(db, phone) {
  const n = normalize(phone);
  if (!n) return null;
  const r = await _wallet().resolveRecipientByPhone(db, n);
  return r ? { uid: r.uid, name: (r.data && (r.data.displayName || r.data.name)) || '', phone: '+' + n } : null;
}

/* Staff of THIS shop, with a till role — the same canonical shop authority offers use. */
async function assertTillStaff(uid, shopId) {
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  if (!shopId || typeof shopId !== 'string' || shopId.includes('/')) throw new HttpsError('invalid-argument', 'shopId is required.');
  const access = await require('./shop-employees').resolveShopAccess(uid, shopId);
  if (!access || TILL_ROLES.indexOf(access.role) === -1) throw new HttpsError('permission-denied', 'Only this shop\'s staff can do that.');
  return access;
}

/**
 * A loyalty account for `uid`, in EXACTLY the shape createLoyaltyAccount writes (loyalty.js internals), with the
 * programme's welcome points recorded as SOKONI-issued. Idempotent: an existing account is returned untouched.
 */
async function ensureAccount(db, uid, { phone, name, email }) {
  const L = _loy();
  const ref = db.collection('loyaltyAccounts').doc(uid);
  /* FAIL CLOSED: the card QR is an HMAC over (loyaltyId, uid). Signing with a missing / placeholder key would mint a
     QR anyone can forge — so no secret, no account. Every function that can reach this binds LOYALTY_HMAC_SECRET. */
  let secret = '';
  try { secret = L.LOYALTY_HMAC.value() || ''; } catch (_) { secret = ''; }
  if (!secret) {
    const existing = await ref.get();
    if (existing.exists) return existing.data();
    throw new Error('LOYALTY_HMAC_SECRET unavailable — account not created');
  }
  const cfgSnap = await db.collection('loyaltyMerchantConfigs').doc('sokoni').get();
  const config = cfgSnap.exists ? cfgSnap.data() : L._defaultConfig('sokoni');
  const welcome = Number(config.welcomePoints) >= 0 ? Number(config.welcomePoints || 125) : 125;
  let out = null;
  await db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (snap.exists) { out = snap.data(); return; }
    const loyaltyId = L._generateLoyaltyId();
    const tier = L._tierFor(welcome);
    const account = {
      uid, loyaltyId, cardNumber: L._generateCardNumber(),
      qrPayload: `sokoni_loyalty:${loyaltyId}:${L._hmac16(secret, `${loyaltyId}:${uid}`)}`,
      phone: String(phone || '').slice(0, 20), name: String(name || '').slice(0, 128), email: String(email || '').slice(0, 128),
      birthdayMonth: null, birthdayDay: null,
      balance: welcome, lifetimePoints: welcome, totalEarned: welcome, totalRedeemed: 0, expiredPoints: 0,
      tier: tier.key, tierName: tier.name, linkedCards: [], status: 'active', fraudRiskScore: 0,
      lastMerchantId: 'sokoni', lastUpdated: FV().serverTimestamp(), joinedAt: FV().serverTimestamp(),
      birthdayRewardYear: null, referredBy: null,
    };
    t.set(ref, account);
    t.set(db.collection('loyaltyLedger').doc('welcome__' + uid), {
      uid, loyaltyId, type: 'welcome', merchantId: 'sokoni', issuerShopId: 'sokoni', points: welcome, pointsEarned: welcome, amountKES: 0,
      balanceBefore: 0, balanceAfter: welcome, description: 'Welcome bonus', createdAt: FV().serverTimestamp(),
    });
    out = account;
  });
  return out;
}

/**
 * THE EARN — server-internal only. Points from the AUTHORITATIVE amount of a COMPLETED sale / order.
 * One ledger row per (source, sale): a replayed webhook or retried till completion earns once. An ORDER (online / card)
 * is keyed by (order, issuing shop) whichever path confirms it, so the webhook finaliser and verifyIntasendPayment can
 * never both credit the same order.
 * Never throws for a buyer problem (no number, unknown number, blocked account) — it reports, and the sale stands.
 */
async function earnForSale(db, { buyerUid, buyerPhone, issuerShopId, saleId, amountKES, source, shopName }) {
  const points = pointsForAmount(amountKES);
  if (!points) return { ok: true, points: 0, reason: 'below-minimum' };
  if (!saleId || !issuerShopId) return { ok: false, reason: 'no-sale' };
  let uid = buyerUid || null, phone = null, name = '';
  if (!uid && buyerPhone) {
    const b = await resolveBuyer(db, buyerPhone);
    if (!b) return { ok: false, reason: 'no-account' };
    uid = b.uid; phone = b.phone; name = b.name;
  }
  if (!uid) return { ok: false, reason: 'no-buyer' };
  if (!phone) {
    const u = await db.collection('users').doc(uid).get().catch(() => null);
    const d = (u && u.exists && u.data()) || {};
    phone = d.phoneNumber || d.phone || null; name = d.displayName || d.name || '';
  }
  await ensureAccount(db, uid, { phone, name });
  if (!shopName) {
    const s = await db.collection('shops').doc(String(issuerShopId)).get().catch(() => null);
    shopName = (s && s.exists && (s.data().name || s.data().shopName)) || null;
  }
  const L = _loy();
  const src = String(source || 'sale').replace(/[^a-z_]/gi, '').slice(0, 20);
  const _key = ORDER_SOURCES.indexOf(src) !== -1 ? 'order__' + String(saleId) + '__' + String(issuerShopId) : src + '__' + String(saleId);
  const ledgerRef = db.collection('loyaltyLedger').doc('earn__' + _key.replace(/\//g, '_').slice(0, 140));
  const accRef = db.collection('loyaltyAccounts').doc(uid);
  let result = null;
  await db.runTransaction(async (t) => {
    const [led, acc] = await Promise.all([t.get(ledgerRef), t.get(accRef)]);
    if (led.exists) { result = { ok: true, replay: true, points: (led.data() || {}).points || 0, balance: (acc.data() || {}).balance }; return; }
    const a = acc.data() || {};
    if (a.status === 'blocked') { result = { ok: false, reason: 'account-blocked' }; return; }
    const before = Number(a.balance) || 0, after = before + points;
    const life = (Number(a.lifetimePoints) || 0) + points;
    const tier = L._tierFor(life);
    t.update(accRef, { balance: after, lifetimePoints: life, totalEarned: FV().increment(points), tier: tier.key, tierName: tier.name,
      lastUpdated: FV().serverTimestamp(), lastMerchantId: String(issuerShopId) });
    t.set(ledgerRef, {
      uid, loyaltyId: a.loyaltyId || null, type: 'earn', source: src,
      merchantId: String(issuerShopId), issuerShopId: String(issuerShopId),   /* who funds these points (P2) */
      orderId: String(saleId), points, pointsEarned: points, pointsRemaining: points, amountKES: Math.round(Number(amountKES) * 100) / 100,
      rate: '1 point per KES ' + KES_PER_POINT_EARNED, balanceBefore: before, balanceAfter: after,
      description: 'Earned at ' + String(shopName || 'a SOKONI shop').slice(0, 60), createdAt: FV().serverTimestamp(),
    });
    result = { ok: true, points, balance: after };
  });
  if (result && result.ok && !result.replay && phone) {
    try {
      await require('./sms-service').enqueue({ to: phone, template: 'points_earned', uid, dedupeKey: 'points_earned__' + ledgerRef.id,
        vars: { points, shop: String(shopName || 'SOKONI').slice(0, 40), balance: result.balance } });
    } catch (_) { /* the points are credited; a text that could not be queued does not undo them */ }
  }
  return result;
}

/* ══ CALLABLES ═══════════════════════════════════════════════════════════════ */
async function lookup(db, { uid, data }) {
  await assertTillStaff(uid, data.shopId);
  if (!normalize(data.phone)) throw new HttpsError('invalid-argument', 'Enter a valid Kenyan phone number.');
  const b = await resolveBuyer(db, data.phone);
  if (!b) return { found: false };
  const acc = await db.collection('loyaltyAccounts').doc(b.uid).get();
  return { found: true, maskedName: maskName(b.name || (acc.exists && acc.data().name)), maskedPhone: maskPhone(b.phone),
    points: acc.exists ? (Number(acc.data().balance) || 0) : 0, hasAccount: acc.exists,
    /* Points P2b: the value, from the ONE rate — the till never computes it */
    valueKES: acc.exists ? Math.round((Number(acc.data().balance) || 0) * POINT_VALUE_KES * 100) / 100 : 0 };
}

async function createBuyer(db, { uid, data }) {
  const access = await assertTillStaff(uid, data.shopId);
  if (data.consent !== true) throw new HttpsError('failed-precondition', 'Ask the customer first — an account is created only with their consent.');
  const n = normalize(data.phone);
  if (!n) throw new HttpsError('invalid-argument', 'Enter a valid Kenyan phone number.');
  /* AN EXISTING NUMBER IS NEVER RE-USED, TAKEN OVER OR MODIFIED — its owner is simply found. */
  const existing = await resolveBuyer(db, n);
  if (existing) {
    await ensureAccount(db, existing.uid, { phone: existing.phone, name: existing.name });
    const acc = await db.collection('loyaltyAccounts').doc(existing.uid).get();
    return { found: true, created: false, maskedName: maskName(existing.name), maskedPhone: maskPhone(existing.phone), points: (acc.data() || {}).balance || 0 };
  }
  /* A daily ceiling per shop: a compromised till cannot mass-register other people's numbers. */
  const day = new Date().toISOString().slice(0, 10);
  const capRef = db.collection('tillBuyerCreates').doc(String(data.shopId) + '_' + day);
  await db.runTransaction(async (t) => {
    const c = await t.get(capRef);
    const used = c.exists ? Number(c.data().count) || 0 : 0;
    if (used >= DAILY_CREATE_LIMIT) throw new HttpsError('resource-exhausted', 'This shop has created the maximum number of accounts for today.');
    t.set(capRef, { shopId: String(data.shopId), day, count: used + 1, updatedAt: FV().serverTimestamp() }, { merge: true });
  });
  const name = String(data.name || '').replace(/[<>]/g, '').trim().slice(0, 80);
  const e164 = '+' + n;
  let user;
  try {
    user = await admin.auth().createUser(Object.assign({ phoneNumber: e164 }, name ? { displayName: name } : {}));
  } catch (e) {
    /* a number that raced into existence between the check and the create: find it, never overwrite it */
    if (e && (e.code === 'auth/phone-number-already-exists' || /already/i.test(String(e.message)))) {
      const again = await resolveBuyer(db, n);
      if (again) return { found: true, created: false, maskedName: maskName(again.name), maskedPhone: maskPhone(again.phone), points: 0 };
    }
    throw new HttpsError('internal', 'The account could not be created. Nothing was changed.');
  }
  await db.collection('users').doc(user.uid).set({
    phoneNumber: e164, displayName: name || null, createdVia: 'till', createdByShop: String(data.shopId),
    createdByStaff: uid, claimed: false, createdAt: FV().serverTimestamp(),
  }, { merge: true });
  const acc = await ensureAccount(db, user.uid, { phone: e164, name });
  const shopSnap = await db.collection('shops').doc(String(data.shopId)).get().catch(() => null);
  const shopName = (shopSnap && shopSnap.exists && (shopSnap.data().name || shopSnap.data().shopName)) || 'A SOKONI shop';
  try {
    await require('./sms-service').enqueue({ to: e164, template: 'till_welcome', uid: user.uid, dedupeKey: 'till_welcome__' + user.uid,
      vars: { shop: String(shopName).slice(0, 40), points: acc && acc.balance } });
  } catch (_) { /* the account exists; the text is retried by the queue or re-sent on the next earn */ }
  return { found: false, created: true, maskedName: maskName(name), maskedPhone: maskPhone(e164), points: (acc && acc.balance) || 0, via: access.role };
}

exports.tillBuyerLookup = onCall({ region: REGION, enforceAppCheck: true, maxInstances: 40, memory: '256MiB', timeoutSeconds: 30 },
  async (req) => lookup(_db(), { uid: req.auth && req.auth.uid, data: req.data || {} }));
exports.tillCreateBuyer = onCall({ region: REGION, enforceAppCheck: true, maxInstances: 20, memory: '256MiB', timeoutSeconds: 30,
  secrets: [require('./loyalty')._internal.LOYALTY_HMAC] }, async (req) => createBuyer(_db(), { uid: req.auth && req.auth.uid, data: req.data || {} }));

module.exports.KES_PER_POINT_EARNED = KES_PER_POINT_EARNED;
module.exports.POINT_VALUE_KES = POINT_VALUE_KES;
module.exports.pointsForAmount = pointsForAmount;
module.exports.maskName = maskName;
module.exports.maskPhone = maskPhone;
module.exports.resolveBuyer = resolveBuyer;
module.exports.ensureAccount = ensureAccount;
module.exports.earnForSale = earnForSale;
module.exports.lookup = lookup;
module.exports.createBuyer = createBuyer;
module.exports.assertTillStaff = assertTillStaff;
module.exports.normalize = normalize;
