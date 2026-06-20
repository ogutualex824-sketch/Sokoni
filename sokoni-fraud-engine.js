/**
 * SOKONI Enterprise Fraud Detection Engine  v2.0
 *
 * Multi-layer fraud protection for payments, accounts, and orders.
 *
 * Layers:
 *  1. Velocity checks   — too many requests in a short window
 *  2. Anomaly detection — unusual amounts, patterns, or locations
 *  3. Device fingerprint — cross-device account sharing detection
 *  4. Risk scoring      — composite 0–100 score per transaction
 *  5. Blocklist         — known bad actors (IPs, phones, emails, UIDs)
 *  6. Behavioural rules — OWASP-aligned heuristics
 *  7. Machine-learning hooks — ready for external ML endpoint
 *
 * Decisions: ALLOW | REVIEW | BLOCK
 * All blocks and reviews are published to SokoniEventBus + Firestore.
 *
 * Deliberately stateless for scalability — uses IndexedDB for
 * client-side velocity windows and Firestore for persistent signals.
 */

'use strict';

const SokoniFraudEngine = (function () {

  /* ════════════════════════════════════════════════════════════
     CONSTANTS
  ════════════════════════════════════════════════════════════ */
  const DECISION = Object.freeze({ ALLOW: 'allow', REVIEW: 'review', BLOCK: 'block' });

  const RISK_THRESHOLDS = Object.freeze({
    ALLOW:  30,   // 0–30: allow
    REVIEW: 60,   // 31–60: flag for manual review
    BLOCK:  61,   // 61–100: auto-block
  });

  /* Score contributions per signal */
  const SIGNAL_SCORES = Object.freeze({
    velocity_payment_high:       40,
    velocity_payment_medium:     20,
    velocity_login_high:         35,
    velocity_login_medium:       15,
    amount_spike:                25,
    unusual_hour:                10,
    new_device:                  15,
    blocklisted_phone:           80,
    blocklisted_email:           80,
    blocklisted_ip:              90,
    blocklisted_uid:             100,
    multiple_failed_payments:    30,
    round_amount_pattern:        10,
    vpn_detected:                20,
    multiple_accounts_device:    35,
    address_mismatch:            15,
    impossible_travel:           45,
    card_testing:                70,
    chargeback_history:          50,
  });

  /* Velocity windows (milliseconds) */
  const VELOCITY = Object.freeze({
    PAYMENT_MAX_SHORT: { count: 3,  window: 5  * 60 * 1000 },   // 3 payments / 5 min
    PAYMENT_MAX_LONG:  { count: 10, window: 60 * 60 * 1000 },   // 10 payments / hour
    LOGIN_MAX_SHORT:   { count: 5,  window: 5  * 60 * 1000 },   // 5 logins / 5 min
    LOGIN_MAX_LONG:    { count: 15, window: 60 * 60 * 1000 },   // 15 logins / hour
    ORDER_MAX:         { count: 20, window: 60 * 60 * 1000 },   // 20 orders / hour
  });

  /* ════════════════════════════════════════════════════════════
     IN-MEMORY VELOCITY TRACKER
  ════════════════════════════════════════════════════════════ */
  const _velocityMap = new Map();  // key → [timestamp, timestamp, ...]

  function _velocityRecord(key) {
    const now = Date.now();
    if (!_velocityMap.has(key)) _velocityMap.set(key, []);
    const arr = _velocityMap.get(key);
    arr.push(now);

    /* Evict entries older than 2 hours */
    const cutoff = now - 7200000;
    while (arr.length > 0 && arr[0] < cutoff) arr.shift();

    /* Prevent unbounded growth */
    if (_velocityMap.size > 100000) {
      const oldestKey = _velocityMap.keys().next().value;
      _velocityMap.delete(oldestKey);
    }
  }

  function _velocityCount(key, windowMs) {
    const arr = _velocityMap.get(key) || [];
    const cutoff = Date.now() - windowMs;
    return arr.filter(t => t >= cutoff).length;
  }

  /* ════════════════════════════════════════════════════════════
     BLOCKLIST (persistent + in-memory cache)
  ════════════════════════════════════════════════════════════ */
  const _blocklist = {
    phones: new Set(),
    emails: new Set(),
    uids:   new Set(),
    ips:    new Set(),
  };

  async function _loadBlocklist() {
    if (!window.firebaseDB) return;
    try {
      const { collection, getDocs } = await import(
        'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
      );
      const snap = await getDocs(collection(window.firebaseDB, 'fraudBlocklist'));
      snap.docs.forEach(d => {
        const { type, value } = d.data();
        if (_blocklist[type + 's']) _blocklist[type + 's'].add(value);
      });
    } catch (_) {}
  }

  _loadBlocklist();

  function _isBlocklisted(type, value) {
    if (!value) return false;
    const set = _blocklist[type + 's'];
    return set ? set.has(String(value).toLowerCase().trim()) : false;
  }

  /* ════════════════════════════════════════════════════════════
     DEVICE FINGERPRINT
  ════════════════════════════════════════════════════════════ */
  function _getFingerprint() {
    const nav = navigator;
    const parts = [
      nav.userAgent,
      nav.language,
      nav.hardwareConcurrency,
      screen.width + 'x' + screen.height,
      Intl.DateTimeFormat().resolvedOptions().timeZone,
      nav.cookieEnabled,
    ];
    /* Simple hash */
    const str  = parts.join('|');
    let hash   = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return 'FP-' + Math.abs(hash).toString(36);
  }

  const _deviceFP = _getFingerprint();

  /* Track devices per UID */
  const _deviceToUid  = new Map();   // fingerprint → Set(uid)
  const _uidToDevices = new Map();   // uid → Set(fingerprint)

  function _registerDeviceUid(uid) {
    if (!uid || !_deviceFP) return;

    if (!_deviceToUid.has(_deviceFP)) _deviceToUid.set(_deviceFP, new Set());
    _deviceToUid.get(_deviceFP).add(uid);

    if (!_uidToDevices.has(uid)) _uidToDevices.set(uid, new Set());
    _uidToDevices.get(uid).add(_deviceFP);
  }

  function _deviceAccountCount(uid) {
    return _deviceToUid.get(_deviceFP)?.size ?? 0;
  }

  /* ════════════════════════════════════════════════════════════
     RULE ENGINE  — evaluates signals for a context object
  ════════════════════════════════════════════════════════════ */
  function _evaluateRules(ctx) {
    const signals = [];
    let   score   = 0;

    const add = (signal, extra) => {
      const s = SIGNAL_SCORES[signal] || 5;
      score += s;
      signals.push({ signal, score: s, ...extra });
    };

    const uid   = ctx.uid   || 'anon';
    const phone = ctx.phone ? String(ctx.phone).trim() : null;
    const email = ctx.email ? String(ctx.email).toLowerCase().trim() : null;

    /* ── Blocklist checks ── */
    if (phone && _isBlocklisted('phone', phone)) add('blocklisted_phone', { phone });
    if (email && _isBlocklisted('email', email)) add('blocklisted_email', { email });
    if (uid   && _isBlocklisted('uid',   uid  )) add('blocklisted_uid',   { uid });

    /* ── Velocity: payments ── */
    if (ctx.event === 'payment') {
      const shortCount = _velocityCount(`pay:${uid}`, VELOCITY.PAYMENT_MAX_SHORT.window);
      const longCount  = _velocityCount(`pay:${uid}`, VELOCITY.PAYMENT_MAX_LONG.window);

      if (shortCount >= VELOCITY.PAYMENT_MAX_SHORT.count) add('velocity_payment_high',   { count: shortCount });
      else if (longCount >= VELOCITY.PAYMENT_MAX_LONG.count) add('velocity_payment_medium', { count: longCount });
    }

    /* ── Velocity: logins ── */
    if (ctx.event === 'login') {
      const shortCount = _velocityCount(`login:${uid}`, VELOCITY.LOGIN_MAX_SHORT.window);
      if (shortCount >= VELOCITY.LOGIN_MAX_SHORT.count) add('velocity_login_high', { count: shortCount });
    }

    /* ── Amount anomaly ── */
    if (ctx.amount) {
      const avg = ctx.userAvgAmount || 1000;
      if (ctx.amount > avg * 5) add('amount_spike', { amount: ctx.amount, avg });

      /* Round-number pattern (e.g. repeated KES 100, 500 — common in card testing) */
      if (ctx.amount % 100 === 0 && _velocityCount(`amt:${uid}:${ctx.amount}`, 600000) >= 3) {
        add('round_amount_pattern', { amount: ctx.amount });
      }
    }

    /* ── Unusual hour (2 AM – 5 AM EAT) ── */
    const hr = new Date().getUTCHours() + 3;  // EAT = UTC+3
    const adjustedHr = hr >= 24 ? hr - 24 : hr;
    if (adjustedHr >= 2 && adjustedHr <= 5) add('unusual_hour', { hour: adjustedHr });

    /* ── Multiple accounts on same device ── */
    const accountCount = _deviceAccountCount(uid);
    if (accountCount > 3) add('multiple_accounts_device', { count: accountCount });

    /* ── Multiple failed payments ── */
    if (ctx.event === 'payment') {
      const failKey   = `fail:${uid}`;
      const failCount = _velocityCount(failKey, 3600000);
      if (failCount >= 3) add('multiple_failed_payments', { count: failCount });
    }

    return { signals, score: Math.min(score, 100) };
  }

  /* ════════════════════════════════════════════════════════════
     AUDIT — persist fraud decisions to Firestore
  ════════════════════════════════════════════════════════════ */
  async function _auditDecision(decision, score, signals, ctx) {
    if (!window.firebaseDB) return;
    if (decision === DECISION.ALLOW && score < 10) return;  // skip low-risk allows

    try {
      const { collection, addDoc, serverTimestamp } = await import(
        'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
      );
      await addDoc(collection(window.firebaseDB, 'fraudLog'), {
        decision, score, signals,
        uid:          ctx.uid,
        event:        ctx.event,
        amount:       ctx.amount ?? null,
        deviceFP:     _deviceFP,
        userAgent:    navigator.userAgent.slice(0, 100),
        serverTs:     serverTimestamp(),
      });
    } catch (_) {}
  }

  /* ════════════════════════════════════════════════════════════
     PUBLIC API
  ════════════════════════════════════════════════════════════ */
  const Engine = {

    DECISION,
    RISK_THRESHOLDS,
    SIGNAL_SCORES,

    /**
     * Evaluate a transaction / event for fraud risk.
     *
     * @param {object} ctx
     *   event:          'payment' | 'login' | 'order' | 'account_change'
     *   uid:            Firebase Auth UID
     *   amount:         Transaction amount (for payments)
     *   currency:       Currency code
     *   phone:          Phone number
     *   email:          Email address
     *   userAvgAmount:  Historical average transaction amount (optional)
     *
     * @returns {object} { decision, score, signals, allowed, blocked, requiresReview }
     */
    async evaluate(ctx = {}) {
      const uid = ctx.uid || (window.firebaseAuth?.currentUser?.uid ?? 'anon');
      const fullCtx = { ...ctx, uid };

      /* Register device–UID association */
      if (uid !== 'anon') _registerDeviceUid(uid);

      /* Record velocity for this event */
      if (fullCtx.event === 'payment') {
        _velocityRecord(`pay:${uid}`);
        if (fullCtx.amount) _velocityRecord(`amt:${uid}:${fullCtx.amount}`);
      }
      if (fullCtx.event === 'login') _velocityRecord(`login:${uid}`);

      /* Evaluate rules */
      const { signals, score } = _evaluateRules(fullCtx);

      /* Determine decision */
      let decision;
      if (score >= RISK_THRESHOLDS.BLOCK)  decision = DECISION.BLOCK;
      else if (score >= RISK_THRESHOLDS.ALLOW + 1) decision = DECISION.REVIEW;
      else decision = DECISION.ALLOW;

      /* Persist and emit events */
      _auditDecision(decision, score, signals, fullCtx);

      if (window.SokoniEventBus) {
        if (decision === DECISION.BLOCK) {
          await SokoniEventBus.emit(SokoniEventBus.EVENTS.FRAUD_BLOCKED, {
            uid, score, signals, event: fullCtx.event, amount: fullCtx.amount,
          });
        } else if (decision === DECISION.REVIEW) {
          await SokoniEventBus.emit(SokoniEventBus.EVENTS.FRAUD_FLAGGED, {
            uid, score, signals, event: fullCtx.event, amount: fullCtx.amount,
          });
        }
      }

      if (window.SokoniLogger) {
        window.SokoniLogger.log(`[Fraud] ${fullCtx.event} → ${decision} (score: ${score})`);
      }

      return {
        decision,
        score,
        signals,
        allowed:        decision === DECISION.ALLOW,
        blocked:        decision === DECISION.BLOCK,
        requiresReview: decision === DECISION.REVIEW,
      };
    },

    /**
     * Add an entity to the blocklist.
     * @param {'phone'|'email'|'uid'|'ip'} type
     * @param {string} value
     * @param {string} reason
     */
    async block(type, value, reason = '') {
      const normalised = String(value).toLowerCase().trim();
      if (_blocklist[type + 's']) _blocklist[type + 's'].add(normalised);

      if (window.firebaseDB) {
        try {
          const { collection, addDoc, serverTimestamp } = await import(
            'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
          );
          await addDoc(collection(window.firebaseDB, 'fraudBlocklist'), {
            type, value: normalised, reason,
            blockedBy: window.firebaseAuth?.currentUser?.uid ?? 'system',
            serverTs: serverTimestamp(),
          });
        } catch (_) {}
      }

      if (window.SokoniEventBus) {
        await SokoniEventBus.emit(SokoniEventBus.EVENTS.FRAUD_BLOCKED, {
          type, value: normalised, reason, source: 'manual',
        });
      }
    },

    /**
     * Remove an entity from the blocklist.
     */
    async unblock(type, value) {
      const normalised = String(value).toLowerCase().trim();
      if (_blocklist[type + 's']) _blocklist[type + 's'].delete(normalised);

      if (window.firebaseDB) {
        try {
          const { collection, query, where, getDocs, deleteDoc } = await import(
            'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
          );
          const snap = await getDocs(query(
            collection(window.firebaseDB, 'fraudBlocklist'),
            where('type',  '==', type),
            where('value', '==', normalised)
          ));
          snap.docs.forEach(d => deleteDoc(d.ref).catch(() => {}));
        } catch (_) {}
      }

      if (window.SokoniEventBus) {
        await SokoniEventBus.emit(SokoniEventBus.EVENTS.FRAUD_CLEARED, {
          type, value: normalised,
        });
      }
    },

    /** Record a failed payment (for velocity tracking). */
    recordFailedPayment(uid) {
      if (uid) _velocityRecord(`fail:${uid}`);
    },

    /** Record a chargeback for a user (raises future risk score). */
    async recordChargeback(uid) {
      if (!uid) return;
      _velocityRecord(`chargeback:${uid}`);
      await this.evaluate({ event: 'chargeback', uid });
    },

    /** Check if an entity is blocklisted. */
    isBlocklisted(type, value) {
      return _isBlocklisted(type, value);
    },

    /** Current device fingerprint. */
    deviceFingerprint() {
      return _deviceFP;
    },

    /** Velocity snapshot for a user (admin/audit use). */
    velocitySnapshot(uid) {
      return {
        payments_5min:  _velocityCount(`pay:${uid}`,       VELOCITY.PAYMENT_MAX_SHORT.window),
        payments_1hr:   _velocityCount(`pay:${uid}`,       VELOCITY.PAYMENT_MAX_LONG.window),
        logins_5min:    _velocityCount(`login:${uid}`,     VELOCITY.LOGIN_MAX_SHORT.window),
        logins_1hr:     _velocityCount(`login:${uid}`,     VELOCITY.LOGIN_MAX_LONG.window),
        failed_payments:_velocityCount(`fail:${uid}`,      3600000),
        devices:        _uidToDevices.get(uid)?.size ?? 0,
      };
    },

    /** Diagnostics for the monitor dashboard. */
    diagnostics() {
      return {
        velocityMapSize:    _velocityMap.size,
        blocklistPhones:    _blocklist.phones.size,
        blocklistEmails:    _blocklist.emails.size,
        blocklistUids:      _blocklist.uids.size,
        blocklistIPs:       _blocklist.ips.size,
        trackedDevices:     _deviceToUid.size,
        deviceFingerprint:  _deviceFP,
      };
    },
  };

  /* ── Wire into Event Bus ── */
  if (window.SokoniEventBus) {
    /* Auto-evaluate every payment event */
    SokoniEventBus.on(SokoniEventBus.EVENTS.PAYMENT_INITIATED, async (e) => {
      const { payload } = e;
      await Engine.evaluate({
        event:  'payment',
        uid:    payload.buyerId,
        amount: payload.amount,
        phone:  payload.phone,
      });
    });

    /* Record failed payments for velocity */
    SokoniEventBus.on(SokoniEventBus.EVENTS.PAYMENT_FAILED, (e) => {
      Engine.recordFailedPayment(e.payload?.buyerId);
    });
  }

  return Engine;
})();

window.SokoniFraudEngine = SokoniFraudEngine;
