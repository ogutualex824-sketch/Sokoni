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

module.exports = {
  POINTS_PER_KES, MAX_REDEEM_PCT, HOLD_TTL_MS, HOLDS,
  capFor, valueOf, allocate, holdRef, placeHold, releaseHold, prepareConsumeTx, consumeHoldTx, consumeHold,
  settleExpired, preview, priceAndHold,
};
