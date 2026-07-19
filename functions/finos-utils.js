/* ================================================================
   SOKONI FinOS — Shared Utility Module
   Used internally by functions/finos.js Cloud Functions only.
   All monetary values in KES integer cents (1 KES = 100 units).
================================================================ */
'use strict';

const admin  = require('firebase-admin');
const crypto = require('crypto');

/* ─────────────────────────────────────────────────────────────
   ACCOUNT NAMESPACES  (double-entry account identifiers)
──────────────────────────────────────────────────────────────*/
const ACCOUNTS = {
  PLATFORM_REVENUE:  'platform:revenue',
  PLATFORM_CLEARING: 'platform:clearing',
  PLATFORM_EXPENSES: 'platform:expenses',
  PLATFORM_TAX:      'platform:tax_collected',
  PLATFORM_PROMOS:   'platform:promotions_fund',
  PLATFORM_HOLDS:    'platform:rolling_reserve',
  EXTERNAL_GATEWAY:  'external:gateway',
  EXTERNAL_MPESA:    'external:mpesa',
  EXTERNAL_BANK:     'external:bank',
  seller:  (id) => `seller:${id}`,
  rider:   (id) => `rider:${id}`,
  buyer:   (id) => `buyer:${id}`,
  hub:     (id) => `hub:${id}`,
  ad:      (id) => `advertiser:${id}`,
};

/* ─────────────────────────────────────────────────────────────
   TAX CONFIGURATION  (Kenya VAT 16%, WHT 5% on payouts)
──────────────────────────────────────────────────────────────*/
const TAX_CONFIG = {
  VAT_RATE:   16,   /* % on taxable categories */
  WHT_RATE:    5,   /* % Withholding Tax deducted from seller payouts to KRA */
  EXEMPT_CATEGORIES: new Set(['property', 'jobs', 'healthcare', 'education']),
};

/* The commission rate table used to live here. It is now the single authoritative
   config in ./commission-config.js — see that file for why, and for the pricing
   conflict it resolved. Do NOT reintroduce a table here; the drift guard
   (scripts/verify-commission-single-source.js) fails the deploy if you do. */
const CC = require('./commission-config');

/* ─────────────────────────────────────────────────────────────
   IDEMPOTENCY
──────────────────────────────────────────────────────────────*/
function generateIdempotencyKey(parts) {
  return crypto.createHash('sha256').update(parts.filter(Boolean).join('|')).digest('hex').slice(0, 32);
}

async function checkIdempotency(db, key) {
  const snap = await db.collection('finosIdempotency').doc(key).get();
  return snap.exists ? snap.data() : null;
}

async function markIdempotency(db, key, result) {
  try {
    await db.collection('finosIdempotency').doc(key).create({
      key, result,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expireAt:  admin.firestore.Timestamp.fromMillis(Date.now() + 86400000 * 7),
    });
  } catch (e) {
    // ALREADY_EXISTS (code 6) means another concurrent request already wrote this key — safe to ignore.
    if (e.code !== 6 && !e.message?.includes('ALREADY_EXISTS')) throw e;
  }
}

/* ─────────────────────────────────────────────────────────────
   DOUBLE-ENTRY LEDGER
──────────────────────────────────────────────────────────────*/
async function createLedgerEntry(db, {
  type, amountCents, currency = 'KES', debitAccount, creditAccount,
  description, orderId, sellerId, riderId, buyerId, category,
  metadata = {}, createdBy = 'system', idempotencyKey,
}) {
  if (!idempotencyKey)                              throw new Error('idempotencyKey is required');
  if (!Number.isInteger(amountCents) || amountCents <= 0)
    throw new Error(`amountCents must be a positive integer (got ${amountCents})`);
  if (!debitAccount || !creditAccount)              throw new Error('debitAccount and creditAccount are required');

  const cached = await checkIdempotency(db, idempotencyKey);
  if (cached) return { ...cached.result, duplicate: true };

  const ref  = db.collection('ledger').doc();
  const data = {
    id:             ref.id,
    type,
    amountCents,
    currency,
    debitAccount,
    creditAccount,
    description:    description || '',
    orderId:        orderId     || null,
    sellerId:       sellerId    || null,
    riderId:        riderId     || null,
    buyerId:        buyerId     || null,
    category:       category    || null,
    metadata,
    status:         'settled',
    reversalRef:    null,
    createdBy,
    idempotencyKey,
    createdAt:      admin.firestore.FieldValue.serverTimestamp(),
    settledAt:      admin.firestore.FieldValue.serverTimestamp(),
  };

  await db.runTransaction(async (txn) => {
    txn.set(ref, data);
    txn.set(db.collection('finosIdempotency').doc(idempotencyKey), {
      key: idempotencyKey,
      result: { ledgerId: ref.id },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  return { ledgerId: ref.id };
}

async function reverseLedgerEntry(db, originalId, { reason, adminUid }) {
  const origSnap = await db.collection('ledger').doc(originalId).get();
  if (!origSnap.exists)         throw new Error('Ledger entry not found: ' + originalId);
  const orig = origSnap.data();
  if (orig.status === 'reversed') throw new Error('Entry already reversed');

  const ikey   = generateIdempotencyKey(['reversal', originalId]);
  const result = await createLedgerEntry(db, {
    type:          'reversal',
    amountCents:   orig.amountCents,
    currency:      orig.currency,
    debitAccount:  orig.creditAccount, /* swap */
    creditAccount: orig.debitAccount,
    description:   `Reversal: ${orig.description}`,
    orderId:       orig.orderId,
    sellerId:      orig.sellerId,
    riderId:       orig.riderId,
    buyerId:       orig.buyerId,
    category:      orig.category,
    metadata:      { originalId, reason },
    createdBy:     adminUid || 'system',
    idempotencyKey: ikey,
  });

  await db.collection('ledger').doc(originalId).update({
    status:      'reversed',
    reversalRef: result.ledgerId,
    reversedAt:  admin.firestore.FieldValue.serverTimestamp(),
  });

  return result;
}

/* ─────────────────────────────────────────────────────────────
   WALLET OPERATIONS  (all inside Firestore transactions)
──────────────────────────────────────────────────────────────*/
function _walletRef(db, entityId)      { return db.collection('wallets').doc(entityId); }
function _walletTxRef(db, entityId)    { return db.collection('wallets').doc(entityId).collection('transactions').doc(); }

async function getOrInitWallet(db, entityId, entityType) {
  const ref  = _walletRef(db, entityId);
  const snap = await ref.get();
  if (snap.exists) return snap.data();
  const initial = {
    entityId, entityType: entityType || 'unknown', currency: 'KES',
    balance:             0, /* legacy compat field */
    availableBalance:    0,
    pendingBalance:      0,
    heldBalance:         0,
    withdrawableBalance: 0,
    lifetimeEarnings:    0,
    lifetimeWithdrawals: 0,
    lifetimeRefunds:     0,
    createdAt:           admin.firestore.FieldValue.serverTimestamp(),
    updatedAt:           admin.firestore.FieldValue.serverTimestamp(),
  };
  await ref.set(initial);
  return initial;
}

/* ══════════════════════════════════════════════════════════════════════════════
   MONETARY UNITS — wallets/{id}

   This module works in CENTS. wallet.js and wallet-engine.js work in whole KES,
   and wallet.js:88 renders  straight to the user.

   Until 2026-07-19 creditWalletTxn and debitWalletTxn also incremented    by amountCents. A FinOS credit of KES 500 therefore wrote balance += 50000 and
   the wallet UI displayed KSh 50,000 — and spendFromWallet's sufficiency check
   (wallet.js:328) passed against the inflated figure.

   It had never fired in production: audited 2026-07-19, all 3 live wallets/ docs
   were zero on every balance field, because no completed payment credits a wallet
   yet. The collision was fixed while it was still free to fix.

   RULE:  is owned solely by the KES engines (wallet.js, wallet-engine.js).
   This module owns the *Cents fields only — availableBalance, withdrawableBalance,
   lifetimeEarnings — all of which it already maintained. Do not reintroduce a
    write here without first converting units and migrating live docs.
   ══════════════════════════════════════════════════════════════════════════════ */

/* Credit: adds to availableBalance and lifetimeEarnings */
function creditWalletTxn(txn, db, entityId, entityType, amountCents, { description, orderId, type }) {
  const ref  = _walletRef(db, entityId);
  txn.set(ref, {
    entityId, entityType: entityType || 'unknown', currency: 'KES',
    availableBalance:    admin.firestore.FieldValue.increment(amountCents),
    /* NOT `balance`. See the unit note above _walletRef. */
    withdrawableBalance: admin.firestore.FieldValue.increment(amountCents),
    lifetimeEarnings:    admin.firestore.FieldValue.increment(amountCents),
    updatedAt:           admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  const txRef = _walletTxRef(db, entityId);
  txn.set(txRef, {
    type: type || 'credit', amountCents, direction: 'credit',
    description: description || '', orderId: orderId || null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/* Debit: removes from availableBalance. Throws if insufficient unless allowNegative */
async function debitWalletTxn(txn, db, entityId, amountCents, { description, orderId, type, allowNegative = false }) {
  const ref  = _walletRef(db, entityId);
  const snap = await txn.get(ref);
  const data = snap.exists ? snap.data() : {};
  const avail = data.availableBalance || 0;
  if (!allowNegative && avail < amountCents) {
    throw new Error(`Insufficient wallet balance for ${entityId}: has ${avail}, needs ${amountCents}`);
  }

  txn.update(ref, {
    availableBalance:    admin.firestore.FieldValue.increment(-amountCents),
    /* NOT `balance`. See the unit note above _walletRef. */
    withdrawableBalance: admin.firestore.FieldValue.increment(-amountCents),
    updatedAt:           admin.firestore.FieldValue.serverTimestamp(),
  });

  const txRef = _walletTxRef(db, entityId);
  txn.set(txRef, {
    type: type || 'debit', amountCents, direction: 'debit',
    description: description || '', orderId: orderId || null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/* Hold: move amount from available to held (pre-payout reserve) */
function holdWalletTxn(txn, db, entityId, amountCents, { description }) {
  const ref = _walletRef(db, entityId);
  txn.update(ref, {
    availableBalance:    admin.firestore.FieldValue.increment(-amountCents),
    /* NOT `balance` — cents. See the unit note above creditWalletTxn. */
    heldBalance:         admin.firestore.FieldValue.increment(amountCents),
    withdrawableBalance: admin.firestore.FieldValue.increment(-amountCents),
    updatedAt:           admin.firestore.FieldValue.serverTimestamp(),
  });
  const txRef = _walletTxRef(db, entityId);
  txn.set(txRef, {
    type: 'hold', amountCents, direction: 'debit',
    description: description || 'Hold for payout',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/* Release hold (on payout failure) */
function releaseHoldTxn(txn, db, entityId, amountCents, { description }) {
  const ref = _walletRef(db, entityId);
  txn.update(ref, {
    availableBalance:    admin.firestore.FieldValue.increment(amountCents),
    /* NOT `balance` — cents. See the unit note above creditWalletTxn. */
    heldBalance:         admin.firestore.FieldValue.increment(-amountCents),
    withdrawableBalance: admin.firestore.FieldValue.increment(amountCents),
    updatedAt:           admin.firestore.FieldValue.serverTimestamp(),
  });
  const txRef = _walletTxRef(db, entityId);
  txn.set(txRef, {
    type: 'hold_released', amountCents, direction: 'credit',
    description: description || 'Hold released', createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/* Settle hold (on payout success) — removes from held, records withdrawal */
function settleHoldTxn(txn, db, entityId, amountCents, { description }) {
  const ref = _walletRef(db, entityId);
  txn.update(ref, {
    heldBalance:         admin.firestore.FieldValue.increment(-amountCents),
    lifetimeWithdrawals: admin.firestore.FieldValue.increment(amountCents),
    updatedAt:           admin.firestore.FieldValue.serverTimestamp(),
  });
  const txRef = _walletTxRef(db, entityId);
  txn.set(txRef, {
    type: 'withdrawal', amountCents, direction: 'debit',
    description: description || 'Payout settled', createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/* ─────────────────────────────────────────────────────────────
   COMMISSION ENGINE  (server-side only)
──────────────────────────────────────────────────────────────*/
/* revenueConfig/plan_adjustments, memoised for the life of the container.
 *
 * ONE doc, not one per plan, and cached — a commission calculation happens on every payment,
 * and the constitution is explicit about minimal Firestore reads. The TTL means an operator's
 * change reaches production within a minute without a redeploy. */
let _planCfgCache = null, _planCfgAt = 0;
const _PLAN_CFG_TTL_MS = 60_000;

/* Drop the memo. Used by tests, and by an admin write that must take effect immediately
   rather than after the TTL. */
function _resetPlanConfigCache() { _planCfgCache = null; _planCfgAt = 0; }

async function _planAdjustmentOverrides(db) {
  const now = Date.now();
  if (_planCfgCache !== null && (now - _planCfgAt) < _PLAN_CFG_TTL_MS) return _planCfgCache;
  const snap = await db.collection('revenueConfig').doc(CC.PLAN_ADJUSTMENTS_DOC)
    .get().catch(() => null);
  _planCfgCache = (snap && snap.exists) ? (snap.data() || {}) : {};
  _planCfgAt = now;
  return _planCfgCache;
}

/* The seller's plan, from the CANONICAL Subscription Engine — never a second lookup, and never
   a second plan table. subscription-core.resolveSubscription() already reads across all five
   subscription stores and recomputes status from dates, so a stale stored status cannot make an
   expired plan keep discounting.

   discountPct is the plan catalog's OWN `features.commission_discount_pct` (sub-billing.js),
   which has existed all along and which nothing has ever read. */
async function _resolveSellerPlan(sellerId) {
  try {
    const subs = require('./subscription-core');
    const c = await subs.resolveSubscription(sellerId, { role: 'seller' });
    if (!c || !c.found || !c.tier) return null;
    const f = c.features || {};
    const discountPct = Number(f.commission_discount_pct);
    return {
      tier:        c.tier,
      status:      c.status,
      active:      subs.isActive(c.status),
      discountPct: Number.isFinite(discountPct) ? discountPct : 0,
    };
  } catch (_) {
    /* Subscription Engine unavailable: charge the base rate. Never guess a discount — an
       unearned discount is a silent revenue leak, and an unearned surcharge is theft. */
    return null;
  }
}

async function calculateCommission(db, opts) {
  /* Two call sites forgot the `db` argument and called calculateCommission({...}). `db` then
     bound to the options object, `opts` was undefined, and destructuring it threw a TypeError
     that BOTH call sites caught and treated as "commission = 0" (financial-os.js) or "charge
     a flat 10%" (index.js). The platform silently earned nothing on every FinOS payment.
     A misuse this expensive must not be catchable as a generic error, so it is named. */
  if (!db || typeof db.collection !== 'function') {
    throw new TypeError(
      'calculateCommission(db, opts): first argument must be a Firestore instance. ' +
      'Called as calculateCommission(opts) — commission cannot be computed and MUST NOT ' +
      'be defaulted to zero or to a flat rate. Fix the call site.'
    );
  }
  const { orderAmountCents, category, sellerId, hubId,
          /* ── COMPATIBILITY MODE: subscription-defined ABSOLUTE rate ──────────────────────
           * Some hubs price by PLAN, not by category. A provider's plan rate is the commercial
           * promise of that plan — Free Trial 20%, Starter 15%, Professional 10%, Business 7%,
           * Enterprise 5%: the more you pay for the plan, the LOWER your commission.
           *
           * The engine's `services` category is a single 15% for everyone. Those are different
           * concepts, and flattening one into the other is a repricing, not a refactor: it would
           * charge Enterprise providers 15% instead of 5% — KES 1,000 more on a KES 10,000
           * booking — and every paid tier would pay MORE the more they had paid for their plan.
           *
           * So the engine CONSUMES the plan rate rather than overwriting it. Set
           * `subscriptionRole` to opt a call site in. The rate comes from the canonical
           * Subscription Engine (subscription-core.getCommissionRate) — the exact function the
           * old bespoke path used — so pricing is byte-identical by construction.
           *
           * commissionRules and revenueConfig still take precedence, so platform governance now
           * reaches provider bookings for the first time; previously nothing could override them.
           */
          subscriptionRole,

          /* ── COMPATIBILITY: suppress the platform minimum ────────────────────────────────
           * MIN_COMMISSION_KES (KES 10) exists so a tiny marketplace sale does not cost more to
           * process than it earns. Several hub flows never had it, and introducing one during a
           * migration is a repricing:
           *
           *     a KES 50 event ticket at 3%  = KES 1.50  ->  KES 10   (a 567% increase)
           *     a KES 20 provider booking at 20% = KES 4  ->  KES 10   (a 150% increase)
           *
           * A call site that never applied a floor passes skipMinimum:true so the migration
           * changes the CALLER, not the PRICE. Removing the flag later is a deliberate business
           * decision, not a side effect of centralising the maths. */
          skipMinimum } = opts || {};

  /* Fetch rules; small collection — fetch all and pick best match */
  const rulesSnap = await db.collection('commissionRules').where('isActive', '==', true).get().catch(() => null);
  const rules = rulesSnap ? rulesSnap.docs.map(d => ({ id: d.id, ...d.data() })) : [];

  /* Priority: seller-specific → hub-specific → category → global default */
  const rule =
    rules.find(r => r.entityId === sellerId && (r.category === category || r.category === 'all'))
    || rules.find(r => r.entityId === hubId    && (r.category === category || r.category === 'all'))
    || rules.find(r => !r.entityId && r.category === category)
    || rules.find(r => !r.entityId && r.category === 'all')
    || null;

  /* revenueConfig overrides — the SECOND override system.
   *
   * index.js/_resolveCommission had its own precedence chain over revenueConfig/{seller_UID,
   * hub_NAME, global} and never looked at commissionRules; calculateCommission had
   * commissionRules and never looked at revenueConfig. The two collections were completely
   * disjoint: a rate an admin set in one had ZERO effect on payments that happened to take the
   * other rail. Both now resolve here, so there is one engine with one precedence.
   *
   * commissionRules wins over revenueConfig: rules are the richer, newer system (tiers, caps,
   * holidays, date windows), and putting them first preserves the behaviour of every payment
   * that already went through this function. */
  let rcPct = null, rcFixedKES = 0;
  if (!rule) {
    const rcDocs = await Promise.all([
      sellerId ? db.collection('revenueConfig').doc('seller_' + sellerId).get().catch(() => null) : null,
      db.collection('revenueConfig').doc('hub_' + (hubId || category || 'default')).get().catch(() => null),
      db.collection('revenueConfig').doc('global').get().catch(() => null),
    ]);
    const [sellerCfg, hubCfg, globalCfg] = rcDocs;
    for (const snap of [sellerCfg, hubCfg]) {
      if (snap && snap.exists) {
        const d = snap.data();
        if (rcPct === null && typeof d.commissionPct === 'number') rcPct = d.commissionPct;
        if (!rcFixedKES && typeof d.fixedFee === 'number') rcFixedKES = d.fixedFee;
      }
    }
    if (rcPct === null && globalCfg && globalCfg.exists
        && typeof globalCfg.data().defaultCommissionPct === 'number') {
      rcPct = globalCfg.data().defaultCommissionPct;
    }
  }

  /* ── PRECEDENCE 3: subscription-defined ABSOLUTE plan rate (compatibility mode) ──────────
   * Only when the call site opts in with `subscriptionRole`, and only after rules and
   * revenueConfig have had their say — so an admin can still override a provider's rate,
   * which was impossible before this migration.
   *
   * The number comes from subscription-core.getCommissionRate(uid, {role}) — the SAME call
   * the bespoke provider path made — so a migrated booking is charged exactly what it was
   * charged yesterday. It returns a FRACTION (0.05); the engine speaks percent (5).
   *
   * An operator can retire this compatibility mode without a deploy by writing
   * revenueConfig/hub_provider { commissionPct: 15 }, which outranks it. That is the
   * deliberate business decision; this code does not make it. */
  let subRatePct = null;
  if (!rule && rcPct === null && subscriptionRole && sellerId) {
    try {
      const subCore = require('./subscription-core');
      const frac = await subCore.getCommissionRate(sellerId, { role: subscriptionRole });
      /* 0.07 * 100 is 7.000000000000001 in IEEE-754. Round to 3dp: a rate written into an
         immutable ledger must not carry float dust. The commission itself is unaffected —
         Math.round() absorbs it — but the RECORDED rate would have been wrong forever. */
      if (Number.isFinite(frac) && frac >= 0 && frac <= 1) {
        subRatePct = Math.round(frac * 100 * 1000) / 1000;
      }
    } catch (_) {
      /* Subscription Engine unavailable: fall through to the category default rather than
         guess. A wrong rate is worse than a well-defined one. */
    }
  }

  const base = CC.resolveRate(category);
  let commissionCents;
  let effectiveRate = rule ? rule.rate
                    : (rcPct !== null ? rcPct
                    : (subRatePct !== null ? subRatePct : base.pct));
  /* Flat fees: a revenueConfig override wins, else the config's own fixedKES (e.g. vehicles). */
  const fixedKES = rcFixedKES || base.fixedKES || 0;
  /* True when the plan rate is the authority for this booking — used below to keep the
     platform minimum off a flow that never had one. */
  const usingSubRate = (!rule && rcPct === null && subRatePct !== null);

  /* ── STEP 4: subscription plan adjustment ──────────────────────────────────────────────
   * Applied to whatever base survived rules -> revenueConfig -> category, so the seller's
   * plan discounts the rate they would otherwise have paid. It NEVER replaces the base:
   * see commission-config.js for why absolute plan rates were a trap.
   *
   * Billing efficiency (constitution): the subscription lookup is skipped entirely unless a
   * plan adjustment is actually configured. While discounts are off — which is how this
   * ships — this costs ONE cached read of revenueConfig/plan_adjustments and nothing more.
   *
   * The plan comes from the canonical Subscription Engine (subscription-core.resolveSubscription),
   * not from a second lookup, and only counts when the subscription is genuinely active — an
   * expired Business plan must not keep discounting.
   *
   * A `fixed` rule has no percentage to discount, so the plan does not apply to it. */
  const baseRate = effectiveRate;
  let planId = null, planStatus = null, planDeltaPct = 0, planLabel = null;
  let planApplied = false, planSource = 'none', planType = null, planSkipped = null;

  /* The rollout switch is read FIRST, and it is the cheap check. While plan discounts are off
     — which is how this ships — the engine never even looks up the seller's subscription, so
     Phase 1 costs one cached config read and nothing else. */
  const planCfg = await _planAdjustmentOverrides(db);

  if (!CC.planRolloutEnabled(planCfg)) {
    planSkipped = 'rollout_disabled';
  } else if (sellerId && !(rule && rule.type === 'fixed')) {
    const sub = await _resolveSellerPlan(sellerId);
    if (!sub || !sub.tier) {
      planSkipped = 'no_plan';
    } else {
      planId = sub.tier;
      planStatus = sub.status;
      /* SAFETY: an expired or cancelled subscription must not keep discounting. Status is
         recomputed from dates by the Subscription Engine, so a stale stored status cannot
         leak a benefit. */
      if (!sub.active) {
        planSkipped = 'plan_inactive';
      } else {
        const adj = CC.applyPlanAdjustment(sub.tier, planCfg, sub.discountPct, effectiveRate);
        if (adj.applied) {
          effectiveRate = adj.rate;
          planDeltaPct  = adj.deltaPct;
          planLabel     = adj.label;
          planSource    = adj.source;
          planType      = adj.type;
          planApplied   = true;
        } else {
          planSkipped = adj.skipped;
        }
      }
    }
  }

  if (rule && rule.type === 'fixed') {
    commissionCents = rule.amountCents || 0;
    effectiveRate   = orderAmountCents ? Math.round(commissionCents / orderAmountCents * 100) : 0;
  } else if (rule && rule.type === 'percentage_plus_fixed') {
    commissionCents = Math.round(orderAmountCents * effectiveRate / 100) + (rule.amountCents || 0);
    effectiveRate   = orderAmountCents ? Math.round(commissionCents / orderAmountCents * 100) : effectiveRate;
  } else if (rule && rule.type === 'tiered') {
    const tier = (rule.tiers || []).find(t =>
      orderAmountCents >= (t.minCents || 0) &&
      orderAmountCents <= (t.maxCents || Infinity));
    effectiveRate   = tier ? tier.rate : effectiveRate;
    commissionCents = Math.round(orderAmountCents * effectiveRate / 100);
  } else {
    commissionCents = Math.round(orderAmountCents * effectiveRate / 100);
  }

  /* Apply caps in order: ceiling first, then floor (floor wins over ceiling if min > max would occur) */
  if (rule && rule.maxCommissionCents) commissionCents = Math.min(commissionCents, rule.maxCommissionCents);
  if (rule && rule.minCommissionCents) commissionCents = Math.max(commissionCents, rule.minCommissionCents);

  /* Flat fee and the platform minimum. Both used to live only in index.js/_resolveCommission,
     so a payment on the FinOS rail never picked up the vehicles KES 2,000 listing fee and never
     applied the KES 10 floor. Doing it here means every rail gets identical arithmetic. */
  if (!rule) {
    /* The KES 10 platform minimum must NOT be applied to a booking priced by its subscription
       plan. The bespoke provider path never had a minimum: a KES 20 booking at 20% charged
       KES 4. Introducing the floor here would silently raise it to KES 10 — a 150% increase on
       small bookings, and exactly the kind of unapproved repricing this migration must avoid.
       Compatibility mode means compatible, including at the edges. */
    if (effectiveRate > 0 && !usingSubRate && !skipMinimum) {
      commissionCents = Math.max(commissionCents, CC.MIN_COMMISSION_KES * 100);
    }
    if (fixedKES) commissionCents += fixedKES * 100;
  }

  /* Commission holiday: if currently in a campaign with 0% rate */
  const now = admin.firestore.Timestamp.now();
  const campaignSnap = await db.collection('commissionRules')
    .where('type', '==', 'commission_holiday').where('isActive', '==', true)
    .get().catch(() => null);
  if (campaignSnap) {
    const holiday = campaignSnap.docs.find(d => {
      const r = d.data();
      return (!r.category || r.category === category || r.category === 'all')
          && (!r.entityId || r.entityId === sellerId)
          && (!r.activeFrom || r.activeFrom.toMillis() <= now.toMillis())
          && (!r.activeTo   || r.activeTo.toMillis()   >= now.toMillis());
    });
    if (holiday) { commissionCents = 0; effectiveRate = 0; }
  }

  const sellerNetCents = orderAmountCents - commissionCents;

  /* A commission holiday zeroes the rate; the breakdown must say so rather than blaming
     whatever base or plan happened to be resolved first. */
  const holidayApplied = effectiveRate === 0 && baseRate > 0 && !planApplied;

  return {
    orderAmountCents,
    effectiveRate,
    commissionCents,
    sellerNetCents,
    /* fixedKES and category are surfaced so index.js/_resolveCommission can be a thin adapter
       over this function instead of a second engine with its own table and its own arithmetic. */
    fixedKES,
    category:   base.category,
    ruleId:     rule ? rule.id : 'default',
    ruleSource: rule ? (rule.entityId ? 'entity_specific' : rule.category)
              : (rcPct !== null ? 'revenue_config'
              : (usingSubRate ? 'subscription_plan_rate' : 'default_table')),
    /* Which authority actually priced this transaction. Written to the ledger so a settlement
       can be explained years later without re-deriving it. */
    pricingSource: rule ? 'commission_rule'
                 : (rcPct !== null ? 'revenue_config'
                 : (usingSubRate ? 'subscription_plan_rate (compatibility mode)'
                 : 'category_default')),

    /* ── AUDIT BREAKDOWN ────────────────────────────────────────────────────────────────
     * Written verbatim into commissionLedger and shown verbatim to the seller, so a
     * settlement is reproducible years later and a dashboard cannot disagree with it.
     * baseRate + planAdjustment == effectiveRate, except where a floor or a holiday clamped
     * it — which is precisely why the clamp is recorded rather than implied. */
    baseRate,                                   /* before the plan touched it */
    planId,                                     /* the tier, or null if the seller has none */
    planName: planLabel || planId || null,      /* the human name of the plan */
    planStatus,                                 /* active / trialing / grace / expired ... */
    planAdjustment: planApplied ? planDeltaPct : 0,
    adjustmentType: planType,                   /* 'relative' | 'points' | null */
    planApplied,
    planSource,
    /* Why no adjustment was made. 'rollout_disabled' is the Phase 1 answer, and recording it
       means a settlement can prove the discount was OFF at the time — not merely absent. */
    planSkipped,
    planLabel,                                  /* the human reason: "Business Plan Discount" */
    reason: planApplied
      ? (planLabel || ('Plan: ' + planId))
      : (holidayApplied ? 'Commission holiday'
        : (rule ? 'Commission rule' : (rcPct !== null ? 'Revenue configuration' : 'Category default'))),
    calculatedAt: Date.now(),
    engineVersion: 2,                           /* bumped when the resolution ORDER changes */
  };
}

/* ─────────────────────────────────────────────────────────────
   TAX ENGINE  (Kenya VAT + WHT)
──────────────────────────────────────────────────────────────*/
function calculateVAT(orderAmountCents, category) {
  if (TAX_CONFIG.EXEMPT_CATEGORIES.has(category)) {
    return { taxType: 'VAT', taxRate: 0, taxCents: 0, preTaxCents: orderAmountCents, isExempt: true };
  }
  const rate     = TAX_CONFIG.VAT_RATE;
  const taxCents = Math.round(orderAmountCents * rate / 100);
  return {
    taxType:      'VAT',
    taxRate:      rate,
    preTaxCents:  orderAmountCents,
    taxCents,
    totalWithTax: orderAmountCents + taxCents,
    isExempt:     false,
  };
}

function calculateWHT(payoutAmountCents) {
  const rate     = TAX_CONFIG.WHT_RATE;
  const whtCents = Math.round(payoutAmountCents * rate / 100);
  return { taxType: 'WHT', taxRate: rate, grossCents: payoutAmountCents, whtCents, netCents: payoutAmountCents - whtCents };
}

/* ─────────────────────────────────────────────────────────────
   PROMOTION ENGINE  (server-side validation only)
──────────────────────────────────────────────────────────────*/
async function validatePromoCode(db, { code, buyerUid, orderAmountCents, category }) {
  const snap = await db.collection('promotions').where('code', '==', code.toUpperCase()).get();
  if (snap.empty) return { valid: false, error: 'Promo code not found' };

  const doc   = snap.docs[0];
  const promo = doc.data();
  const now   = Date.now();

  if (!promo.isActive)                           return { valid: false, error: 'Promo code is no longer active' };
  if (promo.startDate?.toMillis?.() > now)       return { valid: false, error: 'Promo not yet active' };
  if (promo.endDate?.toMillis?.()   < now)       return { valid: false, error: 'Promo has expired' };
  if (promo.usageLimit && promo.usageCount >= promo.usageLimit) return { valid: false, error: 'Promo usage limit reached' };
  if (promo.minOrderAmountCents && orderAmountCents < promo.minOrderAmountCents)
    return { valid: false, error: `Minimum order KES ${promo.minOrderAmountCents / 100} required` };
  if (promo.category && promo.category !== category)
    return { valid: false, error: 'Promo not valid for this category' };

  /* Per-user limit check */
  if (promo.perUserLimit && buyerUid) {
    const usageSnap = await db.collection('promotionUsage')
      .where('promoId', '==', doc.id).where('buyerUid', '==', buyerUid).get();
    if (usageSnap.size >= promo.perUserLimit)
      return { valid: false, error: 'You have already used this promo code' };
  }

  /* Calculate discount */
  let discountCents;
  if (promo.discountType === 'percentage') {
    discountCents = Math.round(orderAmountCents * promo.discountValue / 100);
    if (promo.maxDiscountCents) discountCents = Math.min(discountCents, promo.maxDiscountCents);
  } else if (promo.discountType === 'fixed') {
    discountCents = Math.min(promo.discountValueCents || 0, orderAmountCents);
  } else if (promo.discountType === 'free_delivery') {
    discountCents = promo.maxDiscountCents || 0;
  } else {
    discountCents = 0;
  }

  return {
    valid:          true,
    promoId:        doc.id,
    promoCode:      promo.code,
    discountCents,
    discountType:   promo.discountType,
    fundedBy:       promo.fundedBy || 'platform',
    fundingEntityId:promo.fundingEntityId || null,
    platformPct:    promo.platformFundingPct || 100,
    sellerPct:      promo.sellerFundingPct   || 0,
  };
}

async function recordPromoUsage(db, { promoId, promoCode, buyerUid, orderId, discountCents }) {
  await db.runTransaction(async (txn) => {
    txn.set(db.collection('promotionUsage').doc(), {
      promoId, promoCode, buyerUid: buyerUid || null, orderId: orderId || null,
      discountCents, usedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    txn.update(db.collection('promotions').doc(promoId), {
      usageCount: admin.firestore.FieldValue.increment(1),
    });
  });
}

/* ─────────────────────────────────────────────────────────────
   FRAUD DETECTION SIGNALS
──────────────────────────────────────────────────────────────*/
async function checkFinancialFraud(db, { entityId, entityType, eventType, amountCents, orderId }) {
  const signals = [];
  const now     = Date.now();

  if (amountCents > 5000000 && eventType === 'payout')
    signals.push({ code: 'LARGE_SINGLE_PAYOUT', severity: 'high', detail: `KES ${amountCents / 100}` });

  if (amountCents > 10000000 && eventType === 'refund')
    signals.push({ code: 'LARGE_REFUND', severity: 'high', detail: `KES ${amountCents / 100}` });

  if (eventType === 'payout') {
    const recentSnap = await db.collection('payouts').where('entityId', '==', entityId).get().catch(() => null);
    if (recentSnap) {
      const recentHour = recentSnap.docs.filter(d => (now - (d.data().createdAtMs || 0)) < 3600000);
      if (recentHour.length >= 3)
        signals.push({ code: 'RAPID_PAYOUTS', severity: 'medium', detail: `${recentHour.length} payouts in 1h` });
    }
  }

  if (signals.length > 0) {
    const severity = signals.some(s => s.severity === 'critical') ? 'critical'
                   : signals.some(s => s.severity === 'high')     ? 'high' : 'medium';
    await db.collection('fraudAlerts').add({
      type: 'financial', entityId, entityType: entityType || 'unknown',
      eventType, orderId: orderId || null, signals, severity,
      status: 'open', amountCents, createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
  }

  return { hasFraud: signals.length > 0, signals };
}

/* ─────────────────────────────────────────────────────────────
   IMMUTABLE AUDIT LOG
──────────────────────────────────────────────────────────────*/
async function writeAuditLog(db, { action, entityId, entityType, before, after, metadata, performedBy }) {
  await db.collection('finosAuditLog').add({
    action, entityId: entityId || null, entityType: entityType || null,
    before:  before  || null, after: after || null,
    metadata:metadata || {}, performedBy: performedBy || 'system',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  }).catch(() => {}); /* audit log failure must never break the main flow */
}

/* ─────────────────────────────────────────────────────────────
   IntaSend B2C helper  (M-Pesa payouts)
──────────────────────────────────────────────────────────────*/
async function intasendB2C(privKey, { phone, amountKES, reference, remarks }) {
  const isSandbox = process.env.INTASEND_SANDBOX === 'true';
  const base      = isSandbox ? 'https://sandbox.intasend.com' : 'https://payment.intasend.com';

  const res = await fetch(`${base}/api/v1/payment/mpesa-b2c/initiate/`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${privKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      currency:  'KES',
      provider:  'M-PESA',
      amount:    String(amountKES),
      phone_number: String(phone).replace(/\D/g, '').replace(/^0/, '254'),
      name:      remarks   || 'SOKONI Payout',
      account:   reference || 'payout',
      narrative: remarks   || 'SOKONI earnings payout',
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => 'Unknown error');
    throw new Error(`IntaSend B2C failed (${res.status}): ${err}`);
  }
  return await res.json();
}

module.exports = {
  _resetPlanConfigCache,
  ACCOUNTS, TAX_CONFIG,
  /* Rates come from commission-config; re-exported so existing importers keep working. */
  COMMISSION_CONFIG: CC,
  generateIdempotencyKey, checkIdempotency, markIdempotency,
  createLedgerEntry, reverseLedgerEntry,
  getOrInitWallet, creditWalletTxn, debitWalletTxn, holdWalletTxn, releaseHoldTxn, settleHoldTxn,
  calculateCommission, calculateVAT, calculateWHT,
  validatePromoCode, recordPromoUsage,
  checkFinancialFraud, writeAuditLog, intasendB2C,
};
