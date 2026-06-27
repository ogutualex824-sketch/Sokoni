/* ================================================================
   SOKONI SmartPOS — Universal Loyalty Engine v1.0
   Merchant-configurable: points, cashback, punch cards, tiers,
   coupons, gift cards, store credit, campaigns
   IndexedDB-first — works fully offline
================================================================ */
'use strict';

window.PosLoyalty = (() => {

  /* ── IndexedDB ── */
  const DB_NAME = 'sokoni_loyalty_v1';
  const DB_VER  = 1;
  const STORES  = { PROGRAMS:'programs', COUPONS:'coupons', GIFTS:'gift_cards', PUNCHES:'punch_cards', CAMPAIGNS:'campaigns', LEDGER:'ledger' };
  let _db = null;

  async function _openDB() {
    if (_db) return _db;
    return new Promise((res, rej) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        const mk = (n, opts, idxs=[]) => {
          if (db.objectStoreNames.contains(n)) return;
          const s = db.createObjectStore(n, opts);
          idxs.forEach(([nm, kp, o]) => s.createIndex(nm, kp, o||{}));
        };
        mk(STORES.PROGRAMS,  {keyPath:'merchantId'});
        mk(STORES.COUPONS,   {keyPath:'code'}, [['active','active'],['merchantId','merchantId']]);
        mk(STORES.GIFTS,     {keyPath:'code'}, [['merchantId','merchantId']]);
        mk(STORES.PUNCHES,   {keyPath:'id'},   [['customerId','customerId'],['programId','programId']]);
        mk(STORES.CAMPAIGNS, {keyPath:'id'},   [['merchantId','merchantId'],['active','active']]);
        mk(STORES.LEDGER,    {keyPath:'id', autoIncrement:true}, [['customerId','customerId'],['merchantId','merchantId']]);
      };
      req.onsuccess = e => { _db = e.target.result; res(_db); };
      req.onerror   = e => rej(e.target.error);
    });
  }

  async function _get(store, key) {
    const db = await _openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(store,'readonly');
      const req = tx.objectStore(store).get(key);
      req.onsuccess = e => res(e.target.result||null);
      req.onerror   = e => rej(e.target.error);
    });
  }

  async function _put(store, obj) {
    const db = await _openDB();
    return new Promise((res, rej) => {
      const tx  = db.transaction(store,'readwrite');
      const req = tx.objectStore(store).put(obj);
      req.onsuccess = e => res(e.target.result);
      req.onerror   = e => rej(e.target.error);
    });
  }

  async function _getAll(store) {
    const db = await _openDB();
    return new Promise((res, rej) => {
      const tx  = db.transaction(store,'readonly');
      const req = tx.objectStore(store).getAll();
      req.onsuccess = e => res(e.target.result||[]);
      req.onerror   = e => rej(e.target.error);
    });
  }

  async function _getByIndex(store, index, value) {
    const db = await _openDB();
    return new Promise((res, rej) => {
      const tx  = db.transaction(store,'readonly');
      const req = tx.objectStore(store).index(index).getAll(value);
      req.onsuccess = e => res(e.target.result||[]);
      req.onerror   = e => rej(e.target.error);
    });
  }

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2);

  /* ════════════════════════════════════════════════════════
     DEFAULT PROGRAM TEMPLATE
  ════════════════════════════════════════════════════════ */
  const DEFAULT_PROGRAM = {
    type:    'points',      // points | cashback | punch | tiered | hybrid
    enabled: true,
    points: {
      earnRate:  1,         // points per KES spent (denominator)
      earnDenom: 100,       // earn 1 point per KES 100
      pointValue: 0.5,      // KES per point on redemption
      minRedeem:  50,       // minimum points to redeem
      expiryDays: 365,      // points expire after N days (0 = never)
    },
    cashback: {
      rate:    0.02,        // 2% cashback on every purchase
      minPurchase: 0,
      creditToWallet: true,
    },
    punch: {
      requiredPunches: 10,  // punches needed for reward
      rewardType: 'free_item', // free_item | discount | points
      rewardValue: 0,
      rewardItemId: null,
    },
    tiers: [
      { name:'Bronze',   minSpend:0,      multiplier:1,   color:'#cd7f32', perks:[] },
      { name:'Silver',   minSpend:20000,  multiplier:1.5, color:'#c0c0c0', perks:['priority_queue'] },
      { name:'Gold',     minSpend:100000, multiplier:2,   color:'#ffd700', perks:['priority_queue','free_delivery'] },
      { name:'Platinum', minSpend:500000, multiplier:3,   color:'#e5e4e2', perks:['priority_queue','free_delivery','dedicated_support'] },
    ],
    campaigns: [],
  };

  /* ════════════════════════════════════════════════════════
     PROGRAM MANAGEMENT
  ════════════════════════════════════════════════════════ */
  async function getProgram(merchantId) {
    const saved = await _get(STORES.PROGRAMS, merchantId);
    if (saved) return saved;
    /* Also try Firestore */
    try {
      if (typeof firebase !== 'undefined') {
        const snap = await firebase.firestore().collection('loyaltyPrograms').doc(merchantId).get();
        if (snap.exists) {
          const prog = { merchantId, ...snap.data() };
          await _put(STORES.PROGRAMS, prog);
          return prog;
        }
      }
    } catch(_) {}
    return { merchantId, ...DEFAULT_PROGRAM };
  }

  async function saveProgram(merchantId, program) {
    const prog = { merchantId, ...program, updatedAt: Date.now() };
    await _put(STORES.PROGRAMS, prog);
    try {
      if (typeof firebase !== 'undefined') {
        await firebase.firestore().collection('loyaltyPrograms').doc(merchantId).set(prog);
      }
    } catch(_) {}
    return prog;
  }

  /* ════════════════════════════════════════════════════════
     EARNINGS CALCULATION
  ════════════════════════════════════════════════════════ */
  function calcEarnings(subtotal, program, customer) {
    if (!program?.enabled || subtotal <= 0) return { points: 0, cashback: 0, description: '' };

    const type = program.type || 'points';
    const tier  = _getTier(customer?.totalSpent || 0, program.tiers || DEFAULT_PROGRAM.tiers);
    const multiplier = tier?.multiplier || 1;
    const results = { points: 0, cashback: 0, tierName: tier?.name, multiplier, description: '' };

    if (type === 'points' || type === 'hybrid' || type === 'tiered') {
      const cfg   = program.points || DEFAULT_PROGRAM.points;
      const base  = Math.floor(subtotal / cfg.earnDenom) * cfg.earnRate;
      results.points = Math.floor(base * multiplier);
      results.description = `+${results.points} pts`;
    }

    if (type === 'cashback' || type === 'hybrid') {
      const cfg = program.cashback || DEFAULT_PROGRAM.cashback;
      if (subtotal >= (cfg.minPurchase || 0)) {
        results.cashback = Math.round(subtotal * cfg.rate * 100) / 100;
        results.description += (results.description ? ' · ' : '') + `KES ${results.cashback.toFixed(2)} cashback`;
      }
    }

    return results;
  }

  function calcRedemptionValue(points, program) {
    const cfg = (program?.points || DEFAULT_PROGRAM.points);
    return Math.round(points * cfg.pointValue * 100) / 100;
  }

  function maxRedeemablePoints(points, subtotal, program) {
    const cfg = program?.points || DEFAULT_PROGRAM.points;
    if (points < (cfg.minRedeem || 50)) return 0;
    /* Cannot redeem more than the subtotal */
    const maxByValue = Math.floor(subtotal / cfg.pointValue);
    return Math.min(points, maxByValue);
  }

  function _getTier(totalSpent, tiers) {
    if (!tiers?.length) return null;
    const sorted = [...tiers].sort((a, b) => b.minSpend - a.minSpend);
    return sorted.find(t => totalSpent >= t.minSpend) || sorted[sorted.length - 1];
  }

  /* ════════════════════════════════════════════════════════
     PUNCH CARDS
  ════════════════════════════════════════════════════════ */
  async function getPunchCard(customerId, programId) {
    const cards = await _getByIndex(STORES.PUNCHES, 'customerId', customerId);
    return cards.find(c => c.programId === programId) || null;
  }

  async function recordPunch(customerId, merchantId, saleId) {
    const program = await getProgram(merchantId);
    if (program.type !== 'punch') return null;
    const cfg = program.punch || DEFAULT_PROGRAM.punch;
    const id  = `${merchantId}_${customerId}`;
    const existing = await _get(STORES.PUNCHES, id) || { id, customerId, merchantId, programId: merchantId, punches: 0, totalCompleted: 0 };
    existing.punches++;
    existing.lastPunchAt = Date.now();
    existing.lastSaleId  = saleId;

    let reward = null;
    if (existing.punches >= cfg.requiredPunches) {
      reward = { type: cfg.rewardType, value: cfg.rewardValue, itemId: cfg.rewardItemId };
      existing.punches = 0;
      existing.totalCompleted = (existing.totalCompleted || 0) + 1;
    }
    await _put(STORES.PUNCHES, existing);
    return { card: existing, reward, remaining: cfg.requiredPunches - existing.punches };
  }

  /* ════════════════════════════════════════════════════════
     COUPONS
  ════════════════════════════════════════════════════════ */
  async function validateCoupon(code, merchantId, subtotal, customerId) {
    const clean = String(code||'').trim().toUpperCase();
    /* Check local cache first */
    let coupon = await _get(STORES.COUPONS, clean);

    if (!coupon) {
      /* Try Firestore */
      try {
        if (typeof firebase !== 'undefined') {
          const snap = await firebase.firestore().collection('coupons').doc(clean).get();
          if (snap.exists) {
            coupon = snap.data();
            await _put(STORES.COUPONS, { code: clean, ...coupon });
          }
        }
      } catch(_) {}
    }

    if (!coupon) return { valid: false, error: 'Coupon not found' };
    if (!coupon.active) return { valid: false, error: 'Coupon is inactive' };
    if (coupon.merchantId && coupon.merchantId !== merchantId) return { valid: false, error: 'Coupon not valid for this store' };
    if (coupon.expiresAt && Date.now() > coupon.expiresAt) return { valid: false, error: 'Coupon has expired' };
    if (coupon.startsAt && Date.now() < coupon.startsAt) return { valid: false, error: 'Coupon not yet active' };
    if (coupon.minPurchase && subtotal < coupon.minPurchase) return { valid: false, error: `Minimum purchase KES ${coupon.minPurchase.toFixed(2)} required` };
    if (coupon.usageLimit && (coupon.usageCount || 0) >= coupon.usageLimit) return { valid: false, error: 'Coupon usage limit reached' };
    if (coupon.perCustomerLimit && customerId) {
      const uses = (coupon.customerUses || {})[customerId] || 0;
      if (uses >= coupon.perCustomerLimit) return { valid: false, error: 'You have already used this coupon' };
    }
    if (coupon.oneTimeUse && coupon.usedBy === customerId) return { valid: false, error: 'You have already used this coupon' };

    /* Calculate discount */
    let discountAmount = 0;
    if (coupon.type === 'percent') {
      discountAmount = Math.min(subtotal * (coupon.value / 100), coupon.maxDiscount || subtotal);
    } else if (coupon.type === 'fixed') {
      discountAmount = Math.min(coupon.value, subtotal);
    } else if (coupon.type === 'free_item') {
      discountAmount = coupon.freeItemPrice || 0;
    }

    return {
      valid:          true,
      code:           clean,
      type:           coupon.type,
      discountAmount: Math.round(discountAmount * 100) / 100,
      description:    coupon.description || `${clean} applied`,
      coupon,
    };
  }

  async function markCouponUsed(code, customerId) {
    const coupon = await _get(STORES.COUPONS, code);
    if (!coupon) return;
    coupon.usageCount = (coupon.usageCount || 0) + 1;
    if (customerId) coupon.customerUses = { ...(coupon.customerUses||{}), [customerId]: ((coupon.customerUses||{})[customerId]||0) + 1 };
    await _put(STORES.COUPONS, coupon);
    /* Sync to Firestore */
    try {
      if (typeof firebase !== 'undefined') {
        await firebase.firestore().collection('coupons').doc(code).update({
          usageCount:   firebase.firestore.FieldValue.increment(1),
          [`customerUses.${customerId}`]: firebase.firestore.FieldValue.increment(1),
        });
      }
    } catch(_) {}
  }

  /* ════════════════════════════════════════════════════════
     GIFT CARDS
  ════════════════════════════════════════════════════════ */
  async function checkGiftCard(code) {
    const clean = String(code||'').trim().toUpperCase();
    let gc = await _get(STORES.GIFTS, clean);
    if (!gc) {
      try {
        if (typeof firebase !== 'undefined') {
          const snap = await firebase.firestore().collection('giftCards').doc(clean).get();
          if (snap.exists) { gc = snap.data(); await _put(STORES.GIFTS, { code: clean, ...gc }); }
        }
      } catch(_) {}
    }
    if (!gc) return { valid: false, error: 'Gift card not found' };
    if (gc.status !== 'active') return { valid: false, error: `Gift card is ${gc.status}` };
    if (gc.expiresAt && Date.now() > gc.expiresAt) return { valid: false, error: 'Gift card has expired' };
    return { valid: true, code: clean, balance: gc.balance || 0, currency: 'KES' };
  }

  async function redeemGiftCard(code, amount) {
    const gc = await _get(STORES.GIFTS, code);
    if (!gc || gc.status !== 'active') throw new Error('Gift card not available');
    if (gc.balance < amount) throw new Error(`Insufficient balance. Available: KES ${gc.balance.toFixed(2)}`);
    gc.balance -= amount;
    if (gc.balance <= 0) gc.status = 'depleted';
    gc.lastUsedAt = Date.now();
    await _put(STORES.GIFTS, gc);
    try {
      if (typeof firebase !== 'undefined') {
        await firebase.firestore().collection('giftCards').doc(code).update({
          balance: gc.balance, status: gc.status, lastUsedAt: gc.lastUsedAt,
        });
      }
    } catch(_) {}
    return { success: true, balanceRemaining: gc.balance };
  }

  /* ════════════════════════════════════════════════════════
     CAMPAIGNS
  ════════════════════════════════════════════════════════ */
  async function getActiveCampaigns(merchantId) {
    const now = Date.now();
    const all = await _getByIndex(STORES.CAMPAIGNS, 'merchantId', merchantId);
    return all.filter(c => c.active && (!c.startsAt || c.startsAt <= now) && (!c.endsAt || c.endsAt >= now));
  }

  async function syncCampaigns(merchantId) {
    try {
      if (typeof firebase !== 'undefined') {
        const snap = await firebase.firestore().collection('loyaltyCampaigns').where('merchantId','==',merchantId).get();
        for (const doc of snap.docs) {
          await _put(STORES.CAMPAIGNS, { id: doc.id, ...doc.data() });
        }
      }
    } catch(_) {}
  }

  function applyCampaignBonus(basePoints, campaigns, cart) {
    let bonusMultiplier = 1;
    let bonusFlat = 0;
    const applied = [];

    for (const c of campaigns) {
      if (c.type === 'multiplier' && c.multiplier) {
        /* Check trigger conditions */
        const ok = !c.minPurchase || cart.subtotal >= c.minPurchase;
        if (ok) { bonusMultiplier = Math.max(bonusMultiplier, c.multiplier); applied.push(c.name); }
      } else if (c.type === 'bonus_points' && c.bonusPoints) {
        const ok = !c.minPurchase || cart.subtotal >= c.minPurchase;
        if (ok) { bonusFlat += c.bonusPoints; applied.push(c.name); }
      } else if (c.type === 'category_boost' && c.categoryIds?.length) {
        const hasCategory = cart.items?.some(i => c.categoryIds.includes(i.categoryId));
        if (hasCategory) { bonusMultiplier = Math.max(bonusMultiplier, c.multiplier||2); applied.push(c.name); }
      }
    }

    const total = Math.floor(basePoints * bonusMultiplier) + bonusFlat;
    return { totalPoints: total, applied };
  }

  /* ════════════════════════════════════════════════════════
     LEDGER
  ════════════════════════════════════════════════════════ */
  async function addLedgerEntry(customerId, merchantId, type, points, amount, saleId, note) {
    await _put(STORES.LEDGER, {
      id: uid(), customerId, merchantId, type, points, amount: amount||0,
      saleId, note, createdAt: Date.now(),
    });
  }

  /* ════════════════════════════════════════════════════════
     CHECKOUT HELPER — called at cart level
  ════════════════════════════════════════════════════════ */
  async function computeCheckoutLoyalty(cart, customer, merchantId) {
    const program   = await getProgram(merchantId);
    const campaigns = await getActiveCampaigns(merchantId);

    /* Base earnings */
    const earnings  = calcEarnings(cart.subtotal, program, customer);
    /* Campaign bonus */
    const withBonus = applyCampaignBonus(earnings.points, campaigns, cart);
    /* Max redeemable */
    const availPts  = customer?.loyaltyPoints || 0;
    const maxRedeem = maxRedeemablePoints(availPts, cart.subtotal, program);
    const redeemVal = calcRedemptionValue(maxRedeem, program);

    return {
      program,
      earning: {
        points:      withBonus.totalPoints,
        cashback:    earnings.cashback,
        campaigns:   withBonus.applied,
        description: earnings.description,
      },
      redemption: {
        available:   availPts,
        max:         maxRedeem,
        maxValue:    redeemVal,
        pointValue:  program.points?.pointValue || 0.5,
      },
      tier: _getTier(customer?.totalSpent || 0, program.tiers || DEFAULT_PROGRAM.tiers),
    };
  }

  /* ════════════════════════════════════════════════════════
     SCAN TYPE AUTO-DETECTION (for loyalty items)
  ════════════════════════════════════════════════════════ */
  function detectLoyaltyScan(scanValue) {
    const v = String(scanValue||'').trim().toUpperCase();
    /* Gift card: GC + 12-16 digits */
    if (/^GC\d{10,16}$/.test(v)) return { type: 'gift_card', code: v };
    /* Coupon: letters and digits, 4-20 chars */
    if (/^[A-Z0-9]{4,20}$/.test(v) && !/^\d+$/.test(v)) return { type: 'coupon', code: v };
    /* SOKONI QR: starts with SOKONI: prefix */
    if (v.startsWith('SOKONI:C:')) return { type: 'customer_qr', id: v.slice(9) };
    if (v.startsWith('SOKONI:GC:')) return { type: 'gift_card', code: v.slice(10) };
    if (v.startsWith('SOKONI:CP:')) return { type: 'coupon', code: v.slice(10) };
    /* Phone number */
    if (/^(07|01|\+2547|\+2541)\d{8}$/.test(v)) return { type: 'phone', value: v };
    return { type: 'unknown', value: v };
  }

  return {
    /* Program */
    getProgram, saveProgram, DEFAULT_PROGRAM,
    /* Calculation */
    calcEarnings, calcRedemptionValue, maxRedeemablePoints, computeCheckoutLoyalty,
    /* Punch card */
    getPunchCard, recordPunch,
    /* Coupons */
    validateCoupon, markCouponUsed,
    /* Gift cards */
    checkGiftCard, redeemGiftCard,
    /* Campaigns */
    getActiveCampaigns, syncCampaigns, applyCampaignBonus,
    /* Ledger */
    addLedgerEntry,
    /* Utilities */
    detectLoyaltyScan,
  };
})();
