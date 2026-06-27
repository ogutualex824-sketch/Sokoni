/* ================================================================
   SOKONI FinOS — Client Library  v1.0
   Read-only Firestore access + Cloud Function delegates.
   ALL financial calculations happen server-side only.
   Monetary display in KES. Internal values in integer cents.
================================================================ */
(function (g) {
  'use strict';

  /* ─────────────────────────────────────────────────────────────
     CURRENCY FORMATTING  (display only — never calculate with these)
  ──────────────────────────────────────────────────────────────*/
  function formatKES(cents, opts) {
    if (cents == null || isNaN(cents)) return 'KES —';
    const amount = (Number(cents) / 100).toFixed(opts?.decimals ?? 2);
    const [whole, dec] = amount.split('.');
    const formatted = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return 'KES ' + formatted + (opts?.noDecimals ? '' : '.' + dec);
  }

  function formatPercent(rate) {
    return (Number(rate) || 0).toFixed(1) + '%';
  }

  function toCents(kes) {
    return Math.round(Number(kes) * 100);
  }

  function fromCents(cents) {
    return (Number(cents) || 0) / 100;
  }

  /* ─────────────────────────────────────────────────────────────
     TRANSACTION TYPE LABELS  (display)
  ──────────────────────────────────────────────────────────────*/
  var TX_LABELS = {
    payment_received:    'Payment Received',
    seller_earning:      'Seller Earning',
    commission:          'Commission',
    delivery_fee:        'Delivery Fee',
    tip:                 'Tip',
    tax:                 'Tax',
    refund:              'Refund',
    commission_reversal: 'Commission Reversal',
    tax_reversal:        'Tax Reversal',
    payout_initiated:    'Payout Initiated',
    payout_settled:      'Payout Settled',
    adjustment:          'Adjustment',
    subscription:        'Subscription',
    advertising:         'Advertising',
    promotion:           'Promotion',
    reversal:            'Reversal',
    order_earning:       'Order Earning',
    delivery_earning:    'Delivery Earning',
    withdrawal:          'Withdrawal',
    hold:                'Hold',
    hold_released:       'Hold Released',
  };

  function txLabel(type) {
    return TX_LABELS[type] || (type || 'Transaction').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  /* ─────────────────────────────────────────────────────────────
     WALLET  (read-only Firestore access)
  ──────────────────────────────────────────────────────────────*/
  function getWallet(db, entityId) {
    return db.collection('wallets').doc(entityId).get()
      .then(function (snap) {
        if (!snap.exists) return { entityId, availableBalance: 0, heldBalance: 0, lifetimeEarnings: 0, currency: 'KES' };
        return snap.data();
      });
  }

  function watchWallet(db, entityId, callback) {
    return db.collection('wallets').doc(entityId).onSnapshot(function (snap) {
      callback(snap.exists ? snap.data() : { entityId, availableBalance: 0, heldBalance: 0, lifetimeEarnings: 0 });
    });
  }

  function getWalletStatement(entityId, opts) {
    return firebase.functions().httpsCallable('getWalletStatement')({
      entityId, limit: opts?.limit || 20, startAfter: opts?.cursor || null,
    });
  }

  /* ─────────────────────────────────────────────────────────────
     COMMISSION PREVIEW  (calls CF — server-side calculation)
  ──────────────────────────────────────────────────────────────*/
  function previewCommission(orderAmountKES, category) {
    return firebase.functions().httpsCallable('calculateTaxBreakdown')({
      orderAmountCents: toCents(orderAmountKES),
      category:         category || 'marketplace',
    });
  }

  /* ─────────────────────────────────────────────────────────────
     PROMO CODES  (validates server-side)
  ──────────────────────────────────────────────────────────────*/
  function applyPromoCode(code, orderAmountKES, category, orderId) {
    return firebase.functions().httpsCallable('applyPromoCode')({
      code, orderAmountCents: toCents(orderAmountKES), category: category || 'marketplace', orderId: orderId || null,
    }).then(function (r) { return r.data; });
  }

  /* ─────────────────────────────────────────────────────────────
     PAYOUTS  (delegates to CF)
  ──────────────────────────────────────────────────────────────*/
  function requestPayout(amountKES, phone, entityType) {
    return firebase.functions().httpsCallable('requestPayout')({
      amountCents: toCents(amountKES), phone, entityType: entityType || 'seller',
    }).then(function (r) { return r.data; });
  }

  function getPayouts(db, entityId, status) {
    var q = db.collection('payouts').where('entityId', '==', entityId);
    if (status) q = q.where('status', '==', status);
    return q.get().then(function (snap) {
      return snap.docs.map(function (d) { return d.data(); })
        .sort(function (a, b) { return (b.createdAtMs || 0) - (a.createdAtMs || 0); });
    });
  }

  /* ─────────────────────────────────────────────────────────────
     FINANCIAL REPORTS  (admin only — delegates to CF)
  ──────────────────────────────────────────────────────────────*/
  function getFinancialReport(startDate, endDate) {
    return firebase.functions().httpsCallable('getFinancialReport')({ startDate, endDate })
      .then(function (r) { return r.data; });
  }

  function getAIInsights() {
    return firebase.functions().httpsCallable('getAIFinancialInsights')({})
      .then(function (r) { return r.data; });
  }

  /* ─────────────────────────────────────────────────────────────
     PAYMENT RECORDING  (called after order completion)
  ──────────────────────────────────────────────────────────────*/
  function recordPayment(opts) {
    /* opts: { orderId, orderAmountKES, category, sellerId, riderId, buyerId, deliveryFeeKES, tipKES } */
    return firebase.functions().httpsCallable('recordPayment')({
      orderId:          opts.orderId,
      orderAmountCents: toCents(opts.orderAmountKES || opts.orderAmountCents / 100),
      category:         opts.category         || 'marketplace',
      sellerId:         opts.sellerId         || null,
      riderId:          opts.riderId          || null,
      buyerId:          opts.buyerId          || null,
      deliveryFeeCents: toCents(opts.deliveryFeeKES || 0),
      tipCents:         toCents(opts.tipKES   || 0),
    }).then(function (r) { return r.data; });
  }

  /* ─────────────────────────────────────────────────────────────
     PROMOTIONS MANAGEMENT  (admin)
  ──────────────────────────────────────────────────────────────*/
  function createPromotion(data) {
    return firebase.functions().httpsCallable('createPromotion')(data)
      .then(function (r) { return r.data; });
  }

  function getActivePromotions(db) {
    return db.collection('promotions').where('isActive', '==', true).get()
      .then(function (snap) {
        return snap.docs.map(function (d) { return d.data(); });
      });
  }

  /* ─────────────────────────────────────────────────────────────
     SNAPSHOT / DAILY METRICS  (admin read)
  ──────────────────────────────────────────────────────────────*/
  function getLatestSnapshot(db) {
    return db.collection('finosSnapshots')
      .where('dateStr', '>=', new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10))
      .get()
      .then(function (snap) {
        if (snap.empty) return null;
        return snap.docs.map(function (d) { return d.data(); })
          .sort(function (a, b) { return (b.dateStr || '').localeCompare(a.dateStr || ''); })[0];
      });
  }

  function getDailySnapshots(db, days) {
    var cutoff = new Date(Date.now() - (days || 30) * 86400000).toISOString().slice(0, 10);
    return db.collection('finosSnapshots').where('dateStr', '>=', cutoff).get()
      .then(function (snap) {
        return snap.docs.map(function (d) { return d.data(); })
          .sort(function (a, b) { return (a.dateStr || '').localeCompare(b.dateStr || ''); });
      });
  }

  /* ─────────────────────────────────────────────────────────────
     ADMIN ACTIONS
  ──────────────────────────────────────────────────────────────*/
  function reverseTransaction(ledgerId, reason) {
    return firebase.functions().httpsCallable('reverseTransaction')({ ledgerId, reason })
      .then(function (r) { return r.data; });
  }

  function adjustWallet(entityId, amountKES, direction, reason, entityType) {
    return firebase.functions().httpsCallable('adjustWallet')({
      entityId, amountCents: toCents(amountKES), direction, reason, entityType: entityType || 'seller',
    }).then(function (r) { return r.data; });
  }

  function processRefund(orderId, opts) {
    return firebase.functions().httpsCallable('processRefund')({
      orderId, refundAmountCents: opts?.refundAmountCents || null,
      fullRefund: opts?.fullRefund || false, reason: opts?.reason || '',
    }).then(function (r) { return r.data; });
  }

  /* ─────────────────────────────────────────────────────────────
     UI HELPERS  (colour-coded severity, badge rendering)
  ──────────────────────────────────────────────────────────────*/
  function healthColor(score) {
    if (score >= 80) return '#71ff00';
    if (score >= 60) return '#ffd700';
    if (score >= 40) return '#ff8c00';
    return '#ff6b6b';
  }

  function txDirectionColor(direction) {
    return direction === 'credit' ? '#71ff00' : '#ff6b6b';
  }

  function statusBadge(status) {
    var map = {
      completed: 'rgba(113,255,0,0.15)',  pending: 'rgba(255,140,0,0.15)',
      processing:'rgba(0,170,255,0.15)',  failed:  'rgba(255,107,107,0.15)',
      settled:   'rgba(113,255,0,0.10)',  reversed:'rgba(255,107,107,0.10)',
      active:    'rgba(113,255,0,0.12)',  suspended:'rgba(255,107,107,0.12)',
    };
    return map[status] || 'rgba(255,255,255,0.06)';
  }

  /* ─────────────────────────────────────────────────────────────
     EXPORT
  ──────────────────────────────────────────────────────────────*/
  var SokoniFinOS = {
    /* Formatting */
    formatKES, formatPercent, toCents, fromCents, txLabel, healthColor, txDirectionColor, statusBadge,
    /* Wallet */
    getWallet, watchWallet, getWalletStatement,
    /* Commission + Tax */
    previewCommission,
    /* Promos */
    applyPromoCode, createPromotion, getActivePromotions,
    /* Payouts */
    requestPayout, getPayouts,
    /* Payments + Refunds */
    recordPayment, processRefund,
    /* Reports + AI */
    getFinancialReport, getAIInsights,
    getLatestSnapshot, getDailySnapshots,
    /* Admin */
    reverseTransaction, adjustWallet,
  };

  g.SokoniFinOS = SokoniFinOS;
  if (typeof module !== 'undefined') module.exports = SokoniFinOS;

})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
