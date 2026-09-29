'use strict';
/**
 * SOKONI POINTS — P2: SPENDING (2026-09-29)
 *
 * OWNER DECISIONS
 *   · 10 points = KES 1. ONE rate, here — online checkout, the M-PESA order path and the till all call capFor().
 *     (Online used KES 0.50 a point until now.)
 *   · At most 25% of the goods (after the shop's offers) may be paid with points — the existing online rule, kept, and
 *     applied at the till too so one rule governs every channel.
 *   · The shop where the points are SPENT funds the redemption: it receives that much less money for the sale. No money
 *     moves from the shop that issued the points. The ledger keeps both facts — the earn lots drawn (issuing shops) and
 *     the funding shop — for reconciliation and merchant reporting.
 *
 * HOLDS — why points are held, not deducted at payment
 *   A discount priced into a payment must be backed by points that still exist when the payment lands. Pricing from the
 *   balance and deducting later lets two checkouts spend the same points (the balance went negative before this). So a
 *   price that includes points first HOLDS them, atomically: balance −N, heldPoints +N, and the oldest earn lots are
 *   drawn down (pointsRemaining). The hold is then:
 *     consumed — by the payment that completed (ledger 'redeem' rows, one per funding shop), exactly once;
 *     released — when the checkout is abandoned: the balance and the lots are restored.
 *   A hold past its time is SETTLED, never blindly released: if its payment did complete, it is consumed. A payment
 *   that lands after its hold was released re-deducts; if the points are gone by then, the sale stands and the shortfall
 *   is flagged in pointsRedemptionAlerts — a paid buyer is never refused afterwards.
 *
 *   pointsHolds/{channel}__{ref}   channel: 'checkout' (card session) · 'order' (M-PESA product_order) · 'till'
 */

const admin = require('firebase-admin');
const { HttpsError } = require('firebase-functions/v2/https');
const LP = require('./loyalty-points');

const POINTS_PER_KES = Math.round(1 / LP.POINT_VALUE_KES);   /* 10 */
const MAX_REDEEM_PCT = 0.25;
const HOLD_TTL_MS = 60 * 60 * 1000;
const HOLDS = 'pointsHolds';
const LOT_SCAN = 200;

const FV = () => admin.firestore.FieldValue;
const _ms = (x) => (x && typeof x.toMillis === 'function') ? x.toMillis() : (typeof x === 'number' ? x : 0);
const _int = (x) => Math.max(0, Math.floor(Number(x) || 0));

/** THE RATE. The most a buyer may take off: min(their points, 25% of the goods, the payable less KES 1). Whole shillings,
 *  so the points spent are always an exact multiple of 10. */
function capFor({ balance, goodsKES, payableKES }) {
  const byBalance = Math.floor(_int(balance) / POINTS_PER_KES);
  const byShare = Math.floor(Math.max(0, Number(goodsKES) || 0) * MAX_REDEEM_PCT);
  const byPayable = payableKES == null ? Infinity : Math.max(0, Math.floor(Number(payableKES) - 1));
  const kes = Math.max(0, Math.min(byBalance, byShare, byPayable));
  return { kes, points: kes * POINTS_PER_KES };
}
function valueOf(points) { return Math.round(_int(points) / POINTS_PER_KES * 100) / 100; }

/** Split a redemption across the shops being paid, in proportion to each shop's goods (largest remainder). */
function allocate(kes, shops) {
  const list = (shops || []).filter((s) => s && s.shopId && Number(s.goods) > 0);
  if (!kes || !list.length) return [];
  const total = list.reduce((a, s) => a + Number(s.goods), 0);
  const parts = list.map((s) => { const exact = kes * Number(s.goods) / total; return { shopId: String(s.shopId), kes: Math.floor(exact), frac: exact - Math.floor(exact) }; });
  let left = kes - parts.reduce((a, p) => a + p.kes, 0);
  parts.slice().sort((a, b) => b.frac - a.frac).forEach((p) => { if (left > 0) { p.kes += 1; left -= 1; } });
  return parts.filter((p) => p.kes > 0).map((p) => ({ shopId: p.shopId, kes: p.kes, points: p.kes * POINTS_PER_KES }));
}

const holdRef = (db, channel, ref) => db.collection(HOLDS).doc(channel + '__' + String(ref).replace(/\//g, '_').slice(0, 140));

async function _lotsTx(t, db, uid) {
  const s = await t.get(db.collection('loyaltyLedger').where('uid', '==', uid).where('type', '==', 'earn').limit(LOT_SCAN));
  return s.docs.map((d) => { const v = d.data() || {}; return { ref: d.ref, id: d.id, issuerShopId: v.issuerShopId || null, remaining: _int(v.pointsRemaining), at: _ms(v.createdAt) }; })
    .filter((l) => l.remaining > 0).sort((a, b) => (a.at - b.at) || (a.id < b.id ? -1 : 1));
}
/** Oldest lots first. Points with no lot (welcome points, balances from before lots existed) are 'unattributed'. */
function _draw(lots, points) {
  let need = points; const drawn = [];
  for (const l of lots) { if (need <= 0) break; const take = Math.min(l.remaining, need); drawn.push({ lot: l, take }); need -= take; }
  return { drawn, unattributed: Math.max(0, need) };
}

/**
 * HOLD points for a price. Idempotent per (channel, ref): a retry returns the hold already made — so a replayed
 * payment intent re-prices to the SAME amount. Refuses a blocked account and a balance that cannot cover it.
 */
async function placeHold(db, { uid, channel, ref, points, kes, fundingShops, ttlMs, meta }) {
  points = _int(points); kes = _int(kes);
  if (!uid || !channel || !ref) throw new HttpsError('invalid-argument', 'A points hold needs a buyer and a reference.');
  if (!points || kes * POINTS_PER_KES !== points) throw new HttpsError('invalid-argument', 'Points are spent in whole shillings (10 points = KES 1).');
  const hRef = holdRef(db, channel, ref), aRef = db.collection('loyaltyAccounts').doc(String(uid));
  let out = null;
  await db.runTransaction(async (t) => {
    const [h, a] = await Promise.all([t.get(hRef), t.get(aRef)]);
    if (h.exists) {
      const hv = h.data() || {};
      if (hv.uid !== uid) throw new HttpsError('permission-denied', 'This reference is already in use.');
      if (hv.status === 'held') { out = Object.assign({ id: h.id, replay: true }, hv); return; }
      if (hv.status === 'consumed') throw new HttpsError('failed-precondition', 'These points were already spent on this purchase.');
    }
    if (!a.exists) throw new HttpsError('failed-precondition', 'No SOKONI points account.');
    const av = a.data() || {};
    if (av.status === 'blocked') throw new HttpsError('permission-denied', 'This points account is blocked.');
    const bal = _int(av.balance);
    if (bal < points) throw new HttpsError('failed-precondition', 'Not enough points: ' + bal + ' available, ' + points + ' needed.');
    const lots = await _lotsTx(t, db, uid);
    const { drawn, unattributed } = _draw(lots, points);
    const now = Date.now();
    const hold = {
      uid, channel, ref: String(ref), points, kes, status: 'held',
      fundingShops: (fundingShops || []).map((s) => ({ shopId: String(s.shopId), kes: _int(s.kes), points: _int(s.points) })),
      lots: drawn.map((d) => ({ ledgerId: d.lot.id, issuerShopId: d.lot.issuerShopId, points: d.take })), unattributedPoints: unattributed,
      balanceBefore: bal, createdAtMs: now, expiresAtMs: now + (ttlMs || HOLD_TTL_MS), createdAt: FV().serverTimestamp(),
      meta: meta || null,
    };
    t.update(aRef, { balance: bal - points, heldPoints: FV().increment(points), lastUpdated: FV().serverTimestamp() });
    drawn.forEach((d) => t.update(d.lot.ref, { pointsRemaining: d.lot.remaining - d.take }));
    t.set(hRef, hold);
    out = Object.assign({ id: hRef.id }, hold);
  });
  return out;
}

/** Give held points back (an abandoned checkout, a cancelled till redemption). Only a HELD hold moves. */
async function releaseHold(db, { channel, ref, reason }) {
  const hRef = holdRef(db, channel, ref);
  let out = { released: false };
  await db.runTransaction(async (t) => {
    const h = await t.get(hRef);
    if (!h.exists || (h.data() || {}).status !== 'held') { out = { released: false, status: h.exists ? h.data().status : 'none' }; return; }
    const hv = h.data();
    const lotSnaps = await Promise.all((hv.lots || []).map((l) => t.get(db.collection('loyaltyLedger').doc(l.ledgerId))));
    const aRef = db.collection('loyaltyAccounts').doc(hv.uid);
    t.update(aRef, { balance: FV().increment(hv.points), heldPoints: FV().increment(-hv.points), lastUpdated: FV().serverTimestamp() });
    (hv.lots || []).forEach((l, i) => { if (lotSnaps[i].exists) t.update(lotSnaps[i].ref, { pointsRemaining: _int(lotSnaps[i].data().pointsRemaining) + l.points }); });
    t.update(hRef, { status: 'released', releasedAtMs: Date.now(), releaseReason: String(reason || 'released').slice(0, 60) });
    out = { released: true, points: hv.points };
  });
  return out;
}

/** READ phase of a consume, for a transaction that has its own writes to make (all reads before all writes). */
async function prepareConsumeTx(t, db, { channel, ref, uid }) {
  const hRef = holdRef(db, channel, ref);
  const h = await t.get(hRef);
  const hv = h.exists ? h.data() : null;
  const owner = (hv && hv.uid) || uid || null;
  const a = owner ? await t.get(db.collection('loyaltyAccounts').doc(String(owner))) : null;
  return { hRef, hold: hv, uid: owner, acc: a && a.exists ? a.data() : null, accRef: owner ? db.collection('loyaltyAccounts').doc(String(owner)) : null };
}

/**
 * WRITE phase: spend a hold, exactly once. `expect` = what the payment priced ({ points, kes, fundingShops }) — used
 * when the hold is missing or was released before the payment landed (then the points are re-deducted, or the
 * shortfall flagged). Returns { consumed, replay, shortfall }.
 */
function consumeHoldTx(t, db, ctx, { channel, ref, saleRef, orderId, expect }) {
  const now = Date.now();
  const hv = ctx.hold;
  if (hv && hv.status === 'consumed') return { consumed: false, replay: true };
  const exp = expect || {};
  const points = hv ? _int(hv.points) : _int(exp.points);
  const kes = hv ? _int(hv.kes) : _int(exp.kes);
  if (!points || !ctx.uid) return { consumed: false, none: true };
  const shops = (hv && hv.fundingShops && hv.fundingShops.length) ? hv.fundingShops : (exp.fundingShops || []);
  let shortfall = 0, lots = (hv && hv.lots) || [];
  if (hv && hv.status === 'held') {
    t.update(ctx.accRef, { heldPoints: FV().increment(-points), totalRedeemed: FV().increment(points), lastRedeemedAt: FV().serverTimestamp() });
  } else {
    /* no live hold: the payment landed after the hold was released (or was priced before holds existed) */
    const bal = ctx.acc ? _int(ctx.acc.balance) : 0;
    const take = Math.min(bal, points);
    shortfall = points - take; lots = [];
    if (take > 0) t.update(ctx.accRef, { balance: bal - take, totalRedeemed: FV().increment(take), lastRedeemedAt: FV().serverTimestamp() });
    if (shortfall > 0) {
      t.set(db.collection('pointsRedemptionAlerts').doc(channel + '__' + String(ref).slice(0, 140)), {
        uid: ctx.uid, channel, ref: String(ref), orderId: orderId || null, pricedPoints: points, deducted: take, shortfall,
        reason: hv ? 'hold_released_before_payment' : 'no_hold', status: 'open', createdAt: FV().serverTimestamp(),
      });
    }
  }
  const rows = shops.length ? shops : [{ shopId: 'unknown', kes, points }];
  rows.forEach((s) => {
    t.set(db.collection('loyaltyLedger').doc('redeem__' + channel + '__' + String(ref).slice(0, 100) + '__' + String(s.shopId).slice(0, 60)), {
      uid: ctx.uid, type: 'redeem', source: channel,
      merchantId: String(s.shopId), fundingShopId: String(s.shopId),          /* the shop where the points were SPENT pays */
      points: -_int(s.points), pointsRedeemed: _int(s.points), valueKES: _int(s.kes), rate: POINTS_PER_KES + ' points = KES 1',
      orderId: orderId || null, saleRef: saleRef || null, holdId: ctx.hRef.id,
      lots: rows.length === 1 ? lots : [],                                     /* the issuing shops the points came from */
      description: 'Redeemed ' + _int(s.points) + ' points = KES ' + _int(s.kes), createdAt: FV().serverTimestamp(),
    });
  });
  t.set(ctx.hRef, { status: 'consumed', consumedAtMs: now, saleRef: saleRef || null, orderId: orderId || null, shortfall,
    uid: ctx.uid, channel, ref: String(ref), points, kes }, { merge: true });
  return { consumed: true, shortfall, points, kes };
}

async function consumeHold(db, opts) {
  let r = null;
  await db.runTransaction(async (t) => {
    const ctx = await prepareConsumeTx(t, db, { channel: opts.channel, ref: opts.ref, uid: opts.uid });
    r = consumeHoldTx(t, db, ctx, opts);
  });
  return r;
}

/** Holds past their time, settled against their payment: paid → consumed; not paid → released. Called before a new
 *  hold and before a balance is shown, so a stale hold never keeps a buyer's points. */
async function settleExpired(db, uid) {
  const now = Date.now();
  const s = await db.collection(HOLDS).where('uid', '==', String(uid)).where('status', '==', 'held').limit(20).get().catch(() => null);
  if (!s) return 0;
  let n = 0;
  for (const d of s.docs) {
    const hv = d.data() || {};
    if (!(hv.expiresAtMs < now)) continue;
    let paid = false;
    try {
      if (hv.channel === 'checkout') paid = ['consumed'].includes(String(((await db.collection('checkoutSessions').doc(hv.ref).get()).data() || {}).status));
      else if (hv.channel === 'order') paid = ['paid', 'completed'].includes(String(((await db.collection('paymentIntents').doc(hv.ref).get()).data() || {}).status));
    } catch (_) { continue; }                                     /* cannot tell → leave it held, never guess */
    if (paid) await consumeHold(db, { channel: hv.channel, ref: hv.ref, orderId: hv.ref, saleRef: 'settled' });
    else await releaseHold(db, { channel: hv.channel, ref: hv.ref, reason: 'expired' });
    n++;
  }
  return n;
}

/** What a buyer can spend, for display: the balance, its value, and — for goods — the most points would take off. */
async function preview(db, uid, { goodsKES, payableKES } = {}) {
  await settleExpired(db, uid).catch(() => 0);
  const a = await db.collection('loyaltyAccounts').doc(String(uid)).get();
  const av = a.exists ? a.data() : {};
  const balance = _int(av.balance);
  const cap = goodsKES == null ? null : capFor({ balance, goodsKES, payableKES });
  return { balance, held: _int(av.heldPoints), valueKES: valueOf(balance), pointsPerKES: POINTS_PER_KES, maxPct: MAX_REDEEM_PCT,
    maxPoints: cap ? cap.points : null, maxKES: cap ? cap.kes : null, blocked: av.status === 'blocked' };
}

/**
 * THE ONLINE REDEMPTION, shared by the card session and the M-PESA order path: price from the real balance, then hold.
 * redeem=false releases any hold this reference still carries (the buyer switched points off and retried).
 */
async function priceAndHold(db, { uid, channel, ref, redeem, goodsKES, payableKES, shops }) {
  if (!redeem) { await releaseHold(db, { channel, ref, reason: 'not_redeeming' }).catch(() => null); return { kes: 0, points: 0 }; }
  await settleExpired(db, uid).catch(() => 0);
  const existing = await holdRef(db, channel, ref).get();
  if (existing.exists && (existing.data() || {}).status === 'held') {
    const hv = existing.data();
    return { kes: hv.kes, points: hv.points, fundingShops: hv.fundingShops, holdId: existing.id, replay: true };
  }
  const a = await db.collection('loyaltyAccounts').doc(String(uid)).get();
  if (!a.exists || _int(a.data().balance) <= 0) return { kes: 0, points: 0, error: 'No points available to redeem' };
  if (a.data().status === 'blocked') return { kes: 0, points: 0, error: 'This points account is blocked' };
  const cap = capFor({ balance: a.data().balance, goodsKES, payableKES });
  if (!cap.kes) return { kes: 0, points: 0, error: 'Order too small to redeem points' };
  const fundingShops = allocate(cap.kes, shops);
  const hold = await placeHold(db, { uid, channel, ref, points: cap.points, kes: cap.kes, fundingShops });
  return { kes: hold.kes, points: hold.points, fundingShops: hold.fundingShops, holdId: hold.id };
}

/* ══ P2b — PAY WITH POINTS AT THE TILL ═══════════════════════════════════════════════════════════════════════════
 * The cashier identifies the buyer by phone; SOKONI texts THE BUYER a one-time code; the buyer reads it to the cashier;
 * only then are the points held for THIS sale. The cashier never receives a credential, and the code is bound to:
 * the buyer, the shop, the sale (its idempotency key), the points and their value, an expiry, and one use.
 *
 *   tillRedemptions/{id}  status: code_sent → confirmed (points HELD) → consumed (by posCompleteCheckout)
 *                                         ↘ locked (5 wrong codes) · expired · cancelled · failed
 */
const crypto = require('crypto');
const TILL_CODE_TTL_MS = 5 * 60 * 1000;
const TILL_HOLD_TTL_MS = 20 * 60 * 1000;
const TILL_MAX_ATTEMPTS = 5;
const TILL_CODES_PER_BUYER_DAY = 10;
const REDEMPTIONS = 'tillRedemptions';
const _hash = (salt, code) => crypto.createHash('sha256').update(String(salt) + ':' + String(code)).digest('hex');

async function tillStart(db, { uid, data }) {
  const shopId = String((data && data.shopId) || '');
  await LP.assertTillStaff(uid, shopId);
  const saleKey = String((data && data.saleKey) || '');
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(saleKey)) throw new HttpsError('invalid-argument', 'This sale has no reference yet — ring it up first.');
  if (!LP.normalize(data.phone)) throw new HttpsError('invalid-argument', 'Enter a valid Kenyan phone number.');
  const buyer = await LP.resolveBuyer(db, data.phone);
  if (!buyer) throw new HttpsError('not-found', 'No SOKONI account on this number.');
  await settleExpired(db, buyer.uid).catch(() => 0);
  const a = await db.collection('loyaltyAccounts').doc(buyer.uid).get();
  if (!a.exists) throw new HttpsError('failed-precondition', 'This customer has no SOKONI points yet.');
  if ((a.data() || {}).status === 'blocked') throw new HttpsError('permission-denied', 'This points account is blocked.');
  const saleTotal = Number(data.saleTotalKES);
  if (!(saleTotal > 0)) throw new HttpsError('invalid-argument', 'The sale total is needed to work out the points allowed.');
  const cap = capFor({ balance: a.data().balance, goodsKES: saleTotal, payableKES: saleTotal });
  let points = cap.points;
  if (data.points != null) points = Math.min(cap.points, Math.floor(_int(data.points) / POINTS_PER_KES) * POINTS_PER_KES);
  if (points < POINTS_PER_KES) throw new HttpsError('failed-precondition', cap.points ? 'Choose at least 10 points.' : 'Not enough points for this sale (points can pay up to 25% of it).');
  const kes = points / POINTS_PER_KES;

  /* a ceiling per buyer per day: a till cannot spam a buyer's phone with codes */
  const day = new Date().toISOString().slice(0, 10);
  const capRef = db.collection('tillRedeemCodes').doc(buyer.uid + '_' + day);
  await db.runTransaction(async (t) => {
    const c = await t.get(capRef);
    const used = c.exists ? _int(c.data().count) : 0;
    if (used >= TILL_CODES_PER_BUYER_DAY) throw new HttpsError('resource-exhausted', 'Too many point codes for this customer today.');
    t.set(capRef, { uid: buyer.uid, day, count: used + 1 }, { merge: true });
  });

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const salt = crypto.randomBytes(8).toString('hex');
  const ref = db.collection(REDEMPTIONS).doc();
  const shopSnap = await db.collection('shops').doc(shopId).get().catch(() => null);
  const shopName = (shopSnap && shopSnap.exists && (shopSnap.data().name || shopSnap.data().shopName)) || 'a SOKONI shop';
  const now = Date.now();
  await ref.set({
    buyerUid: buyer.uid, shopId, saleKey, points, kes, codeHash: _hash(salt, code), salt, attempts: 0,
    status: 'code_sent', expiresAtMs: now + TILL_CODE_TTL_MS, createdBy: uid, createdAtMs: now, createdAt: FV().serverTimestamp(),
  });
  try {
    await require('./sms-service').enqueue({ to: buyer.phone, template: 'points_redeem_code', uid: buyer.uid, dedupeKey: 'points_redeem_code__' + ref.id,
      vars: { code, points, kes, shop: String(shopName).slice(0, 40) } });
  } catch (_) {
    await ref.update({ status: 'failed', failure: 'sms_not_queued' });
    throw new HttpsError('unavailable', 'The confirmation text could not be sent. Nothing was spent.');
  }
  return { redemptionId: ref.id, points, kes, valueText: 'KES ' + kes.toFixed(2), maskedName: LP.maskName(buyer.name), maskedPhone: LP.maskPhone(buyer.phone),
    balance: _int(a.data().balance), expiresInSec: TILL_CODE_TTL_MS / 1000 };
}

async function tillConfirm(db, { uid, data }) {
  const shopId = String((data && data.shopId) || '');
  await LP.assertTillStaff(uid, shopId);
  const id = String((data && data.redemptionId) || '');
  if (!/^[A-Za-z0-9]{10,40}$/.test(id)) throw new HttpsError('invalid-argument', 'Unknown points confirmation.');
  const code = String((data && data.code) || '').replace(/\D/g, '');
  const ref = db.collection(REDEMPTIONS).doc(id);
  let verdict = null;
  await db.runTransaction(async (t) => {
    const s = await t.get(ref);
    if (!s.exists) { verdict = { err: ['not-found', 'Unknown points confirmation.'] }; return; }
    const r = s.data();
    if (r.shopId !== shopId) { verdict = { err: ['permission-denied', 'This confirmation belongs to another shop.'] }; return; }
    if (r.status === 'confirmed') { verdict = { ok: true, r, replay: true }; return; }
    if (r.status !== 'code_sent') { verdict = { err: ['failed-precondition', 'This code can no longer be used (' + r.status + '). Send a new one.'] }; return; }
    if (!(r.expiresAtMs > Date.now())) { t.update(ref, { status: 'expired' }); verdict = { err: ['deadline-exceeded', 'The code expired. Send a new one.'] }; return; }
    const good = code.length === 6 && crypto.timingSafeEqual(Buffer.from(_hash(r.salt, code), 'hex'), Buffer.from(r.codeHash, 'hex'));
    if (!good) {
      const n = _int(r.attempts) + 1;
      t.update(ref, Object.assign({ attempts: n }, n >= TILL_MAX_ATTEMPTS ? { status: 'locked' } : {}));
      verdict = { err: ['permission-denied', n >= TILL_MAX_ATTEMPTS ? 'Too many wrong codes — this confirmation is locked.' : 'Wrong code (' + (TILL_MAX_ATTEMPTS - n) + ' tries left).'] };
      return;
    }
    t.update(ref, { status: 'confirming', confirmedBy: uid });           /* one confirm wins; a racing one sees 'confirming' */
    verdict = { ok: true, r };
  });
  if (verdict.err) throw new HttpsError(verdict.err[0], verdict.err[1]);
  const r = verdict.r;
  if (!verdict.replay) {
    try {
      await placeHold(db, { uid: r.buyerUid, channel: 'till', ref: id, points: r.points, kes: r.kes,
        fundingShops: [{ shopId, kes: r.kes, points: r.points }], ttlMs: TILL_HOLD_TTL_MS, meta: { saleKey: r.saleKey } });
    } catch (e) {
      await ref.update({ status: 'failed', failure: String((e && e.message) || e).slice(0, 120) });
      throw new HttpsError('failed-precondition', (e && e.message) || 'The points could not be held.');
    }
    await ref.update({ status: 'confirmed', confirmedAtMs: Date.now(), holdExpiresAtMs: Date.now() + TILL_HOLD_TTL_MS, codeHash: null, salt: null });
  }
  return { ok: true, redemptionId: id, points: r.points, kes: r.kes, valueText: 'KES ' + Number(r.kes).toFixed(2) };
}

async function tillCancel(db, { uid, data }) {
  const shopId = String((data && data.shopId) || '');
  await LP.assertTillStaff(uid, shopId);
  const id = String((data && data.redemptionId) || '');
  const ref = db.collection(REDEMPTIONS).doc(id);
  const s = await ref.get();
  if (!s.exists || s.data().shopId !== shopId) throw new HttpsError('not-found', 'Unknown points confirmation.');
  if (s.data().status === 'consumed') throw new HttpsError('failed-precondition', 'These points were already spent on a completed sale.');
  const rel = await releaseHold(db, { channel: 'till', ref: id, reason: 'cancelled_at_till' });
  await ref.update({ status: 'cancelled', cancelledBy: uid, cancelledAtMs: Date.now() });
  return { ok: true, released: rel.released };
}

/**
 * THE SALE'S CHECK (posCompleteCheckout, before anything is claimed or charged): a points tender is valid only as the
 * confirmed, unexpired redemption for THIS shop and THIS sale, for exactly its value, within 25% of the sale.
 */
async function validateTillTender(db, { tender, merchantId, idempotencyKey, saleTotal }) {
  const id = String((tender && tender.redemptionId) || '');
  if (!/^[A-Za-z0-9]{10,40}$/.test(id)) throw new HttpsError('failed-precondition', 'Points are paid only with the buyer\'s SOKONI confirmation code.');
  const s = await db.collection(REDEMPTIONS).doc(id).get();
  const r = s.exists ? s.data() : null;
  if (!r) throw new HttpsError('failed-precondition', 'Unknown points confirmation.');
  if (r.shopId !== String(merchantId)) throw new HttpsError('permission-denied', 'That points confirmation belongs to another shop.');
  if (r.saleKey !== String(idempotencyKey)) throw new HttpsError('failed-precondition', 'That points confirmation was made for a different sale.');
  if (r.status !== 'confirmed') throw new HttpsError('failed-precondition', 'Those points are not confirmed for spending (' + r.status + ').');
  if (!(r.holdExpiresAtMs > Date.now())) throw new HttpsError('deadline-exceeded', 'The points confirmation expired. Ask the customer for a new code.');
  if (Math.round(Number(tender.amount) * 100) !== Math.round(Number(r.kes) * 100)) throw new HttpsError('failed-precondition', 'The points payment must be exactly KES ' + r.kes + '.');
  const cap = capFor({ balance: r.points, goodsKES: saleTotal, payableKES: saleTotal });
  if (r.kes > cap.kes) throw new HttpsError('failed-precondition', 'Points can pay at most 25% of this sale (KES ' + cap.kes + ').');
  return { redemptionId: id, points: r.points, kes: r.kes, buyerUid: r.buyerUid };
}

const { onCall } = require('firebase-functions/v2/https');
const _OPTS = { region: 'us-central1', enforceAppCheck: true, maxInstances: 40, memory: '256MiB', timeoutSeconds: 30 };
const _call = (fn) => onCall(_OPTS, async (req) => fn(admin.firestore(), { uid: req.auth && req.auth.uid, data: req.data || {} }));
const tillPointsStart = _call(tillStart);
const tillPointsConfirm = _call(tillConfirm);
const tillPointsCancel = _call(tillCancel);

module.exports = {
  POINTS_PER_KES, MAX_REDEEM_PCT, HOLD_TTL_MS, HOLDS,
  capFor, valueOf, allocate, holdRef, placeHold, releaseHold, prepareConsumeTx, consumeHoldTx, consumeHold,
  settleExpired, preview, priceAndHold,
  TILL_CODE_TTL_MS, TILL_HOLD_TTL_MS, TILL_MAX_ATTEMPTS, REDEMPTIONS,
  tillStart, tillConfirm, tillCancel, validateTillTender,
  tillPointsStart, tillPointsConfirm, tillPointsCancel,
};
