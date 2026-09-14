'use strict';
/**
 * SOKONI — POS / TILL COMMISSION: the deployable surface
 * functions/pos-commission-surface.js
 *
 * The rail (`pos-commission-rail`) knows the ledger. This is what a POS terminal, the
 * merchant's phone and the scheduler can actually call.
 *
 *   posGateStatus          onCall     what do I owe, and may I trade?
 *   posSettleCommission    onCall     pay it — at ANY time, not only when gated
 *   posCommissionReminder  onSchedule 06:00 EAT, one hour before the gate closes
 *
 * ── WHY THE REMINDER IS AN HOUR EARLY AND NOT AT THE GATE ───────────────────────────
 * A message that arrives at 07:00 tells a merchant their till has already stopped. The
 * point of the reminder is that being gated is never a surprise: it goes out at 06:00, it
 * names the amount and the deadline, and it is a separate notification TYPE from the
 * closure so a merchant can mute the courtesy without muting the reason their till stopped.
 *
 * ── THE SCHEDULER NEVER DECIDES ─────────────────────────────────────────────────────
 * It notifies. It does not gate, it does not collect, and it does not write a liability.
 * The gate is recomputed from the clock on every POS operation (`assertGateOpen`), so a
 * merchant calling an older callable directly cannot transact past it, and a scheduler
 * outage cannot hand out a free trading day. If this function never ran, the gate would
 * still close on time — merchants would simply not have been warned.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { getFirestore } = require('firebase-admin/firestore');
const logger = require('firebase-functions/logger');

const MA = require('./money-authority');
const S  = require('./commission-settlement-authority');
const R  = require('./pos-commission-rail');
const BW = require('./business-wallet');

const REGION = 'us-central1';
const _db = () => getFirestore();

/* ── Identity ───────────────────────────────────────────────────────────────────────
   The merchant is the CALLER, never a field in the request. A `merchantUid` accepted from
   the client would let anyone read — or settle — somebody else's liability, and settling
   another merchant's debt from your own wallet is as much a defect as the reverse. */
function _callerUid(req) {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in to view your commission.');
  return uid;
}

/* The shop whose BUSINESS wallet settles this merchant's liability. Resolved server-side
   from the account, never taken from the client: a client-supplied shopId would choose
   which wallet gets debited. */
async function _resolveShopId(db, uid) {
  const snap = await db.collection('users').doc(String(uid)).get().catch(() => null);
  const activeShopId = snap && snap.exists ? (snap.data() || {}).activeShopId : null;
  if (activeShopId) return String(activeShopId);
  /* No fallback to the uid. `shopId === uid` is true for shops projectSeller creates today
     and will stop being true after the Store-identity migration; guessing it here would
     silently debit the wrong wallet the day that lands. */
  throw new HttpsError('failed-precondition',
    'This account has no active shop, so there is no business wallet to settle from.');
}

function _money(m) {
  return { minorUnits: m.minorUnits, currency: m.currency || 'KES', display: MA.toMajorString(m) };
}

/* ═══════════════════════════════════════════════════════════════════════════
   READ — what do I owe, and may I trade?
   ═══════════════════════════════════════════════════════════════════════════ */
exports.posGateStatus = onCall(
  { region: REGION, enforceAppCheck: true, maxInstances: 20, memory: '256MiB', timeoutSeconds: 30 },
  async (req) => {
    const uid = _callerUid(req);
    const db = _db();
    const nowMs = Date.now();

    let gate;
    try {
      gate = await R.evaluateMerchantGate(db, uid, nowMs);
    } catch (e) {
      /* UNREADABLE IS NOT ZERO, all the way to the client. A screen that receives
         `outstanding: 0` because a read failed will cheerfully tell the merchant they owe
         nothing, and the merchant will find out at 07:00. */
      throw new HttpsError('unavailable',
        'Your commission balance could not be read just now. This is not a zero balance — ' +
        'please try again in a moment.', { code: e && e.code });
    }

    /* The wallet is reported as UNKNOWN when it cannot be read, and as absent when it
       genuinely does not exist. A screen must be able to tell those apart. */
    let wallet = null, walletState = 'NONE';
    try {
      const shopId = await _resolveShopId(db, uid).catch(() => null);
      if (shopId) {
        const w = await BW.getBusinessWallet(db, shopId);
        if (w) { wallet = { shopId, balance: _money(w.balance) }; walletState = 'READ'; }
      }
    } catch (_) { walletState = 'UNKNOWN'; }

    return {
      ok: true,
      closed: gate.closed,
      canTrade: !gate.closed,
      today: gate.today,
      overdue: _money(gate.overdue),
      overdueDays: gate.overdueDays,
      accruingToday: _money(gate.accruingToday),
      totalOutstanding: _money(gate.totalOutstanding),
      unpaid: gate.unpaid.map((u) => ({
        settlementDay: u.settlementDay, outstanding: _money(u.outstanding),
      })),
      nextGateAt: gate.nextGateAt,
      reason: gate.reason,
      /* Stated so the UI never has to encode the rule itself. */
      settleableNow: gate.totalOutstanding.minorUnits > 0,
      walletState,
      wallet,
    };
  }
);

/* ═══════════════════════════════════════════════════════════════════════════
   SETTLE — at any time
   ═══════════════════════════════════════════════════════════════════════════ */
exports.posSettleCommission = onCall(
  { region: REGION, enforceAppCheck: true, maxInstances: 10, memory: '256MiB', timeoutSeconds: 60 },
  async (req) => {
    const uid = _callerUid(req);
    const db = _db();
    const days = Array.isArray(req.data && req.data.settlementDays)
      ? req.data.settlementDays.filter((d) => typeof d === 'string').slice(0, 90)
      : null;

    const shopId = await _resolveShopId(db, uid);

    let res;
    try {
      res = await R.settleFromBusinessWallet(db, { businessWallet: BW }, {
        merchantUid: uid, shopId, settlementDays: days, nowMs: Date.now(),
      });
    } catch (e) {
      const d = (e && (e.details || e.detail)) || {};
      /* The shortfall is the single most useful thing this call can return when it fails —
         "pay KES 20 to continue" is actionable, "insufficient funds" is not. */
      if (e && e.code === 'SETTLE_INSUFFICIENT_BALANCE') {
        throw new HttpsError('failed-precondition', e.message, {
          code: e.code,
          dueMinor: d.dueMinor, balanceMinor: d.balanceMinor, shortfallMinor: d.shortfallMinor,
        });
      }
      if (e && e.code === 'RAIL_NO_BUSINESS_WALLET') {
        throw new HttpsError('failed-precondition', e.message, { code: e.code });
      }
      if (e && e.code === 'SETTLE_NOT_BUSINESS_WALLET' || e && e.code === 'SETTLE_WALLET_NOT_OWNED') {
        throw new HttpsError('permission-denied', e.message, { code: e.code });
      }
      logger.error('[posCommission] settlement failed', { uid, code: e && e.code, msg: e && e.message });
      throw new HttpsError('internal', 'The settlement could not be completed.', { code: e && e.code });
    }

    const gate = await R.evaluateMerchantGate(db, uid, Date.now());
    return {
      ok: true,
      action: res.action,
      settlementRef: res.settlementRef || null,
      settled: _money(MA.fromMinor(res.settledMinor || 0)),
      settlementDays: res.settlementDays || [],
      walletBalance: typeof res.walletBalanceMinor === 'number'
        ? _money(MA.fromMinor(res.walletBalanceMinor)) : null,
      /* The gate AFTER the settlement, so the terminal does not have to ask again — and
         cannot paint "you may trade" off an optimistic assumption. */
      closed: gate.closed,
      canTrade: !gate.closed,
      totalOutstanding: _money(gate.totalOutstanding),
    };
  }
);

/* ═══════════════════════════════════════════════════════════════════════════
   THE EARLY REMINDER — 06:00 EAT, an hour before the gate
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Which merchants will be gated at the next 07:00, and for how much.
 *
 * Exported for the test: the selection is the part that can be wrong in a way nobody
 * notices (reminding the wrong people, or nobody), and it must be assertable without a
 * scheduler, a clock or a network.
 */
function selectMerchantsToRemind(rows, nowMs) {
  /* THE OFF-BY-ONE THAT MATTERS. The settlement day rolls at 07:00, not at midnight — so
     when this runs at 06:00 on the 6th, `settlementDayFor(now)` is still '2026-09-05'. That
     day's gate closes at 07:00 on the 6th: ONE HOUR FROM NOW. It is exactly the cohort this
     reminder exists for.

     An earlier version skipped `settlementDay >= today`, reasoning that "today is not due
     yet". That reminded only merchants who were ALREADY overdue — for whom the message is
     too late — and stayed silent for everyone about to be gated within the hour, which is
     the entire purpose. Caught by running the selection against a fixture rather than
     reading it.

     The rule: everything up to and including the current settlement day becomes collectible
     at the very next 07:00. A day in the FUTURE cannot exist yet, so it is skipped. */
  const today = S.settlementDayFor(nowMs);
  const byMerchant = new Map();
  for (const r of rows) {
    if (r.settlementDay > today) continue;
    if (!(r.liabilityMinor > 0)) continue;
    const cur = byMerchant.get(r.merchantUid) || { merchantUid: r.merchantUid, minor: 0, days: new Set() };
    cur.minor += r.liabilityMinor;
    cur.days.add(r.settlementDay);
    byMerchant.set(r.merchantUid, cur);
  }
  return Array.from(byMerchant.values())
    .map((m) => ({ merchantUid: m.merchantUid, outstandingMinor: m.minor, days: Array.from(m.days).sort() }))
    .filter((m) => m.outstandingMinor > 0)
    .sort((a, b) => b.outstandingMinor - a.outstandingMinor);
}
exports._selectMerchantsToRemind = selectMerchantsToRemind;

exports.posCommissionReminder = onSchedule(
  {
    /* 06:00 Africa/Nairobi — one hour before the 07:00 gate. Early enough to act on, late
       enough that the figure is the one they will actually be gated for. */
    schedule: '0 6 * * *',
    timeZone: 'Africa/Nairobi',
    region: REGION,
    memory: '512MiB',
    timeoutSeconds: 540,
    retryCount: 0,
  },
  async () => {
    const db = _db();
    const nowMs = Date.now();

    let snap;
    try {
      snap = await db.collection(R.LIABILITIES)
        .where('status', '==', R.STATUS.OUTSTANDING)
        .limit(5000).get();
    } catch (e) {
      /* A failed read means nobody is reminded. It must NEVER mean nobody is gated —
         that decision is made independently, per operation, at 07:00. */
      logger.error('[posCommissionReminder] could not read liabilities; no reminders sent. ' +
        'The 07:00 gate is unaffected.', { error: e && e.message });
      return;
    }

    const rows = snap.docs.map((d) => {
      const x = d.data() || {};
      return { merchantUid: x.merchantUid, settlementDay: x.settlementDay, liabilityMinor: x.liabilityMinor };
    }).filter((r) => r.merchantUid && typeof r.settlementDay === 'string' && typeof r.liabilityMinor === 'number');

    const targets = selectMerchantsToRemind(rows, nowMs);
    const gateAt = S.gateClosesAt(S.settlementDayFor(nowMs));

    let sent = 0, failed = 0;
    const { notify } = require('./notify');
    for (const t of targets) {
      const amount = MA.toMajorString(MA.fromMinor(t.outstandingMinor));
      try {
        await notify({
          uid: t.merchantUid,
          type: 'pos_commission_due',
          title: 'Settle before 07:00 to keep selling',
          body: `You have ${amount} of unpaid POS commission from ${t.days.length} day(s). ` +
                'Settle it before 07:00 and your till stays open. You can pay any time from ' +
                'your business wallet.',
          /* One reminder per merchant per gate. A retried scheduler must not send it twice,
             and the settlement day is the natural identity of "this gate". */
          dedupeKey: `pos_commission_due:${t.merchantUid}:${S.settlementDayFor(nowMs)}`,
          data: { outstandingMinor: t.outstandingMinor, days: t.days, gateAt },
        });
        sent++;
      } catch (e) {
        failed++;
        logger.warn('[posCommissionReminder] notify failed', { uid: t.merchantUid, error: e && e.message });
      }
    }
    logger.info('[posCommissionReminder] done', { merchants: targets.length, sent, failed, gateAt });
  }
);
