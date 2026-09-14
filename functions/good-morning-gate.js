'use strict';
/**
 * SOKONI GOOD MORNING ☀️ — the 07:00 settlement moment, presented
 * functions/good-morning-gate.js
 *
 * STATUS: **NOT INTEGRATED, NOT DEPLOYED.** Nothing calls this.
 *
 * A presentation layer over `commission-settlement-authority`. The ritual is warm; the
 * numbers underneath it are not negotiable.
 *
 * ── THE ONE RULE THIS MODULE EXISTS TO ENFORCE ──────────────────────────────────────
 * **It cannot invent a figure.** Every amount it renders is one it was handed by the
 * certified gate. There is no arithmetic here, no default of 0, no "approximately", no
 * fallback that turns an unreadable balance into a confident number. A merchant reading
 * "KES 700" is reading the ledger, not a guess.
 *
 * When the liability or the wallet cannot be read, the state is UNKNOWN and the copy says
 * so. It does NOT say KES 0, and it does not offer a settle button for an amount nobody
 * established. That is the platform rule — a canonical source or a neutral state, never a
 * fabricated metric — and a cheerful screen is exactly where it would be tempting to break.
 *
 * ── WHY THE COPY IS DETERMINISTIC ───────────────────────────────────────────────────
 * The morning greeting rotates by SETTLEMENT DAY, not at random. A merchant who refreshes
 * twice should not see the shop's personality change under them, and a screenshot in a
 * support ticket should be reproducible.
 */

const MA = require('./money-authority');
const S = require('./commission-settlement-authority');

const STATE = {
  CLEAR: 'CLEAR',                 /* nothing overdue — good morning, go sell            */
  DUE_CAN_SETTLE: 'DUE_CAN_SETTLE',   /* overdue, business wallet covers it             */
  DUE_SHORT: 'DUE_SHORT',         /* overdue, wallet short — exact shortfall, no debit  */
  DUE_NO_WALLET: 'DUE_NO_WALLET', /* overdue, no readable business wallet               */
  UNKNOWN: 'UNKNOWN'              /* we could not read it — say so, never say zero      */
};

/* Rotating morning lines. Chosen by settlement day so the same day always greets the same
   way. Kept short: this sits above a number the merchant has to act on. */
const GREETINGS = [
  'New day. Fresh books. Let’s get selling.',
  'Yesterday is settled. Today starts now.',
  'Good morning. Your shop is ready.',
  'A clean slate, and a day to fill it.',
  'Books balanced. Doors open.',
  'Morning. Let’s make today count.',
  'Fresh day, fresh numbers.'
];

function greetingFor (settlementDay) {
  /* deterministic: sum the digits of the ISO date */
  const digits = String(settlementDay || '').replace(/\D/g, '');
  let n = 0;
  for (const ch of digits) n += Number(ch);
  return GREETINGS[n % GREETINGS.length];
}

/**
 * Build the Good Morning screen.
 *
 * Every Money value in the result is one that was PASSED IN. `shopName` is rendered as
 * given; it is never fabricated from a uid.
 *
 * @param {object} p
 * @param {string} p.shopName
 * @param {object} p.gate            the result of S.evaluateGate() — or null if unreadable
 * @param {object} [p.walletBalance] Money, the BUSINESS wallet — omit if unreadable
 * @param {number} p.nowMs
 */
function buildGoodMorning ({ shopName, gate, walletBalance, nowMs }) {
  const name = (typeof shopName === 'string' && shopName.trim()) ? shopName.trim() : null;

  /* ── unreadable: the honest state ── */
  if (!gate || typeof gate !== 'object' || typeof gate.closed !== 'boolean') {
    return {
      state: STATE.UNKNOWN,
      heading: name ? 'Good morning, ' + name : 'Good morning',
      greeting: 'We’re still bringing your books up to date.',
      /* NO amount. Not zero, not a guess. */
      amount: null,
      amountLabel: '—',
      body: 'Your commission position isn’t available right now. Nothing has been ' +
            'charged and nothing is owed until we can confirm it.',
      cta: null,
      canSettle: false,
      blocking: false
    };
  }

  const heading = (name ? 'Good morning, ' + name : 'Good morning');

  /* ── clear: nothing overdue ── */
  if (!gate.closed) {
    return {
      state: STATE.CLEAR,
      heading,
      greeting: greetingFor(gate.today),
      amount: null,
      amountLabel: null,
      body: MA.isPositive(gate.accruingToday)
        ? 'Nothing outstanding. Today’s commission of ' +
          MA.toMajorString(gate.accruingToday) + ' settles tomorrow morning.'
        : 'Nothing outstanding. Today is yours. 🚀',
      cta: null,
      canSettle: false,
      blocking: false,
      accruingToday: gate.accruingToday
    };
  }

  /* ── overdue ── */
  const due = gate.overdue;
  const dayCount = gate.overdueDays.length;
  const dayPhrase = dayCount === 1 ? 'Yesterday’s' : dayCount + ' days’';

  if (!walletBalance || typeof walletBalance.minorUnits !== 'number') {
    return {
      state: STATE.DUE_NO_WALLET,
      heading,
      greeting: 'Let’s clear ' + (dayCount === 1 ? 'yesterday' : 'the last ' + dayCount + ' days') +
                ' and start fresh. ✨',
      amount: due,
      amountLabel: 'KES ' + MA.toMajorString(due),
      body: dayPhrase + ' SOKONI commission is KES ' + MA.toMajorString(due) + '.',
      cta: { label: 'Settle Now', methods: ['MPESA_STK'] },
      canSettle: true,
      blocking: true,
      overdueDays: gate.overdueDays
    };
  }

  if (MA.gte(walletBalance, due)) {
    return {
      state: STATE.DUE_CAN_SETTLE,
      heading,
      greeting: 'Let’s clear ' + (dayCount === 1 ? 'yesterday' : 'the last ' + dayCount + ' days') +
                ' and start today fresh. ✨',
      amount: due,
      amountLabel: 'KES ' + MA.toMajorString(due),
      body: dayPhrase + ' SOKONI commission is KES ' + MA.toMajorString(due) + '.',
      cta: { label: 'Settle Now', methods: ['BUSINESS_WALLET', 'MPESA_STK'] },
      walletBalance,
      canSettle: true,
      blocking: true,
      overdueDays: gate.overdueDays
    };
  }

  /* short — the shortfall is computed by SUBTRACTION of two given figures, never estimated */
  const shortfall = MA.sub(due, walletBalance);
  return {
    state: STATE.DUE_SHORT,
    heading,
    greeting: 'Almost there.',
    amount: due,
    amountLabel: 'KES ' + MA.toMajorString(due),
    body: 'Your Business Wallet has KES ' + MA.toMajorString(walletBalance) + '. ' +
          'KES ' + MA.toMajorString(due) + ' is required. You’re KES ' +
          MA.toMajorString(shortfall) + ' short.',
    /* stated plainly, because a merchant who sees a shortfall assumes something was taken */
    reassurance: 'No partial deduction was made.',
    cta: { label: 'Top Up & Settle', methods: ['MPESA_STK'] },
    walletBalance,
    shortfall,
    canSettle: false,
    blocking: true,
    overdueDays: gate.overdueDays
  };
}

/**
 * The screen shown after a successful settlement. Takes the amount that was ACTUALLY
 * settled — from the committed ledger entry, never from what the screen previously offered.
 */
function buildSettled ({ shopName, settled }) {
  if (!settled || typeof settled.minorUnits !== 'number') {
    throw new Error('buildSettled requires the amount that was actually settled');
  }
  const name = (typeof shopName === 'string' && shopName.trim()) ? shopName.trim() : null;
  return {
    state: 'SETTLED',
    heading: 'Good morning! 🌅',
    greeting: name ? name + ' is ready for the day.' : 'Your shop is ready for the day.',
    amount: settled,
    amountLabel: 'KES ' + MA.toMajorString(settled),
    body: 'Your KES ' + MA.toMajorString(settled) + ' SOKONI commission has been settled.',
    footer: 'Today is yours. Let’s sell. 🚀',
    cta: null,
    canSettle: false,
    blocking: false
  };
}

module.exports = { STATE, GREETINGS, greetingFor, buildGoodMorning, buildSettled };
