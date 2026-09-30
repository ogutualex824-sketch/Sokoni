/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — POS/TILL DAILY BUSINESS-DAY GATE  (07:00 Africa/Nairobi)
   functions/pos-business-day-gate.js

   A business may not BEGIN a new POS/Till business day while it owes SOKONI
   commission. The gate closes at 07:00 every morning.

       ...trading  ─┤07:00├─  outstanding > 0 ? ─ yes ─► BLOCKED, day cannot start
                                     │
                                     no
                                     ▼
                              day opens, trading resumes

   WHAT THIS IS NOT
   ────────────────
   It is NOT "take 5% out of today's sale." The POS financial model is deliberate and
   unchanged by this file: the seller HOLDS the cash from a till sale, so the 5% is a
   RECEIVABLE they owe (DEBIT seller / CREDIT platform:revenue), never a deduction from
   money SOKONI does not hold. See pos-commission-collection.js. This gate reads that
   outstanding obligation; it never touches sale proceeds and never re-prices a sale.

   ONE SOURCE OF "OUTSTANDING"
   ───────────────────────────
   The balance comes from pos-commission-collection.outstandingForSeller() — the same
   function the collection rail uses. A second definition of "what this business owes"
   is exactly the kind of divergence the commission single-source guard exists to stop.

   THE BUSINESS DAY IS SERVER-DEFINED
   ──────────────────────────────────
   07:00 Africa/Nairobi, resolved with Intl in the SERVER process. Never the browser's
   clock and never a hardcoded UTC+3 offset — a fixed offset is a latent bug the moment
   a tz database changes, and a client-supplied "today" is not an authority at all.
   Africa/Nairobi is already this platform's business timezone: commission-collection.js
   schedules its sweep with `timeZone: 'Africa/Nairobi'`.

   A day is keyed by the DATE IT STARTED. 06:59 on the 7th still belongs to the day that
   began at 07:00 on the 6th, so a late-night shift is one continuous business day rather
   than two.

   IDEMPOTENT AND CONCURRENCY-SAFE
   ───────────────────────────────
   Opening a day is a transaction on ONE document, `posBusinessDays/{businessId}_{day}`,
   created with a guard that a second concurrent caller sees. Ten tills opening at 07:00:00
   produce one open record and nine idempotent successes — never nine ledger effects.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const { HttpsError } = require('firebase-functions/v2/https');

const BUSINESS_TZ    = 'Africa/Nairobi';
const DAY_START_HOUR = 7;
const DAYS           = 'posBusinessDays';
const SETTLEMENTS    = 'posGateSettlements';

/* ── The business day, resolved in the business timezone ─────────────────────── */

/* Local wall-clock parts for an instant, in BUSINESS_TZ. Intl is the authority: it
   carries the tz database, so this stays correct across offset changes. */
function _localParts(ms) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
  });
  const p = {};
  for (const { type, value } of f.formatToParts(new Date(ms))) p[type] = value;
  /* 'en-CA' yields ISO-ish parts; hour can come back as '24' at midnight in some ICU
     builds, which would push the date forward by a day if taken literally. */
  const hour = (Number(p.hour) === 24) ? 0 : Number(p.hour);
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), hour };
}

/**
 * The business day an instant belongs to, as `YYYY-MM-DD` — the date the day STARTED.
 * Before 07:00 local, the instant still belongs to the previous calendar date.
 */
function businessDayKey(ms) {
  const { y, m, d, hour } = _localParts(typeof ms === 'number' ? ms : Date.now());
  /* Shift back one calendar day when the local time is before the 07:00 boundary.
     Date.UTC handles month/year rollover, so 1 January at 06:00 correctly belongs to
     31 December. */
  const shifted = new Date(Date.UTC(y, m - 1, d) - (hour < DAY_START_HOUR ? 86400000 : 0));
  const p = shifted.toISOString().slice(0, 10);
  return p;
}

/* Full local parts, including minutes and seconds — needed to derive the tz offset at an
   instant. Kept separate from _localParts so the day-key path is untouched. */
const _FMT_FULL = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TZ, hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});
function _fullParts(ms) {
  const p = {};
  for (const { type, value } of _FMT_FULL.formatToParts(new Date(ms))) p[type] = value;
  const hour = (Number(p.hour) === 24) ? 0 : Number(p.hour);
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day),
           hour, min: Number(p.minute), sec: Number(p.second) };
}

/* The BUSINESS_TZ offset at an instant, in ms. Derived from Intl at that instant, never
   assumed: Africa/Nairobi is UTC+3 today, but a hardcoded +3 is a latent bug the moment a
   tz rule changes, and this file already refuses that shortcut for the day key. */
function _offsetMsAt(ms) {
  const p = _fullParts(ms);
  return Date.UTC(p.y, p.m - 1, p.d, p.hour, p.min, p.sec) - (ms - (ms % 1000));
}

/**
 * The instant at which the 07:00 boundary of business day `key` (YYYY-MM-DD) occurred.
 * This is what a till needs in order to say "your day began at…" without doing timezone
 * arithmetic on the client, which is the thing this file exists to prevent.
 */
function gateTimeMsFor(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d, DAY_START_HOUR, 0, 0);
  /* Two passes: the offset is first read near the target, then at the corrected instant,
     so the result converges even across an offset change. */
  let t = wall - _offsetMsAt(wall);
  t = wall - _offsetMsAt(t);
  return t;
}

/* ── THE ONE DECISION SITE ────────────────────────────────────────────────────
   Whether a business may trade is decided HERE and nowhere else. evaluateGate (read-only)
   and openBusinessDay (mutating) both call it, so a dashboard and a till can never
   disagree about the same facts — a divergence of that kind would be invisible until a
   merchant was told OPEN by one surface and refused by the other. */
const STATUS = { OPEN: 'OPEN', BLOCKED: 'BLOCKED' };

function _decide(alreadyOpen, outstandingCents) {
  const blocked = !alreadyOpen && outstandingCents > 0;
  return {
    status: blocked ? STATUS.BLOCKED : STATUS.OPEN,
    open: !blocked,
    blocked,
    reason: alreadyOpen ? 'already_open'
          : (blocked ? 'outstanding_commission' : 'no_outstanding'),
  };
}

/* The structured state Merchant V2 / POS reads. Contract fields first; the original field
   names are kept alongside because callers and the existing certification depend on them,
   and silently renaming a field a till already reads is a breaking change dressed as a
   cleanup.

   UNITS: the money field is `outstandingForSellerCents` — integer cents — NOT a bare
   `outstandingForSeller`. This platform has already been bitten by a shillings/cents
   mix-up (wallets store shillings, the receivable is cents; see settleFromWallet). A money
   field whose name does not carry its unit is how that happens again. */
function _shape(businessId, businessDay, outstandingCents, decision, nowMs) {
  const gateTimeMs = gateTimeMsFor(businessDay);
  return {
    /* ── the B/C contract surface ── */
    status: decision.status,
    businessDate: businessDay,
    gateTimeMs,
    gateTime: new Date(gateTimeMs).toISOString(),
    outstandingForSellerCents: outstandingCents,
    reason: decision.reason,
    timezone: BUSINESS_TZ,
    dayStartHour: DAY_START_HOUR,
    serverNowMs: nowMs,

    /* ── original vocabulary, unchanged ── */
    businessId,
    businessDay,
    outstandingCents,
    open: decision.open,
  };
}

/* ── Outstanding, from the ONE existing source ───────────────────────────────── */
async function outstandingCentsFor(db, businessId) {
  const { outstandingForSeller } = require('./pos-commission-collection');
  const bal = await outstandingForSeller(db, businessId);
  const c = Number(bal && bal.outstandingCents);
  return Number.isFinite(c) ? Math.max(0, Math.trunc(c)) : 0;
}

/**
 * Evaluate the gate WITHOUT changing anything. Safe to call from a dashboard.
 */
async function evaluateGate(db, businessId, nowMs) {
  if (!businessId) throw new HttpsError('invalid-argument', 'businessId required.');
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const businessDay = businessDayKey(now);
  const outstandingCents = await outstandingCentsFor(db, businessId);
  const snap = await db.collection(DAYS).doc(businessId + '_' + businessDay).get();
  const alreadyOpen = snap.exists && snap.data().state === 'open';
  /* A day already opened stays open for the rest of that day: a sale made at 14:00 must
     not be refused because a receivable accrued at 13:00. The obligation is collected at
     the NEXT 07:00 boundary, which is what "daily gate" means. That rule lives in
     _decide, so this function cannot drift from openBusinessDay. */
  return { ..._shape(businessId, businessDay, outstandingCents,
                     _decide(alreadyOpen, outstandingCents), now),
           alreadyOpen };
}

/**
 * Open the business day. Idempotent, and safe for concurrent callers.
 * Returns { opened, alreadyOpen, blocked, ... }. A block is a RESULT, not an exception,
 * so a till that asks politely gets a clean answer instead of a stack trace.
 */
async function openBusinessDay(db, businessId, nowMs) {
  if (!businessId) throw new HttpsError('invalid-argument', 'businessId required.');
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const businessDay = businessDayKey(now);
  const ref = db.collection(DAYS).doc(businessId + '_' + businessDay);

  /* Read outstanding BEFORE the transaction: it aggregates a query, and Firestore
     transactions may not run queries. The transaction then re-checks the day document,
     which is the value concurrency actually contends on. */
  const outstandingCents = await outstandingCentsFor(db, businessId);

  return db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    const alreadyOpen = snap.exists && snap.data().state === 'open';
    const decision = _decide(alreadyOpen, outstandingCents);

    if (alreadyOpen) {
      return { ..._shape(businessId, businessDay, outstandingCents, decision, now),
               opened: false, alreadyOpen: true, blocked: false };
    }
    if (decision.blocked) {
      return { ..._shape(businessId, businessDay, outstandingCents, decision, now),
               opened: false, alreadyOpen: false, blocked: true };
    }
    txn.set(ref, {
      businessId, businessDay, state: 'open',
      openedAtMs: now, timezone: BUSINESS_TZ, dayStartHour: DAY_START_HOUR,
      outstandingAtOpenCents: 0,
    });
    return { ..._shape(businessId, businessDay, 0, decision, now),
             opened: true, alreadyOpen: false, blocked: false, reason: 'opened' };
  });
}

/**
 * THE ENFORCEMENT POINT. Throws `failed-precondition` when the day cannot start.
 * Called by the SERVER on the POS sale path, so no client can decline to ask.
 */
async function assertBusinessDayOpen(db, businessId, nowMs) {
  const r = await openBusinessDay(db, businessId, nowMs);
  if (r.blocked) {
    throw new HttpsError('failed-precondition',
      'Outstanding SOKONI commission of KES ' + (r.outstandingCents / 100).toFixed(2) +
      ' must be settled before starting the new business day.',
      { code: 'business_day_blocked', businessDay: r.businessDay,
        outstandingCents: r.outstandingCents });
  }
  return r;
}

/**
 * Settle the outstanding obligation from the business wallet.
 *
 * ── IT NOW DEBITS THE WALLET THAT ACTUALLY HOLDS THE MONEY ────────────────────────────────
 * This read `wallets/{businessId}` — a BUSINESS id addressed in the PERSONAL wallet
 * keyspace. Nothing in the codebase ever credited that document: POS/Till proceeds go to
 * `businessWallets/{businessId}` (pos-zero-friction.js) and marketplace settlement now goes
 * there too (order-settlement.js). So this function looked up an account that could not
 * exist, returned `no_wallet`, and a merchant could never pay their commission out of their
 * own earnings — while the morning gate closed their till for not having paid it.
 *
 * That is exactly the collision business-wallet.js warns about: an id without a collection
 * is not an identity. `wallets/{X}` and `businessWallets/{X}` are different accounts, in
 * different units, and only one of them is ever credited for trading.
 *
 * UNITS — the bug class this platform has already been burned by:
 * the business wallet is `balanceMinor`, integer CENTS, and the receivable is CENTS. The
 * shillings conversion this function used to perform is gone with the shillings wallet; there
 * is no longer any division, so no float dust can reach money.
 *
 * NOT a recovery debit. A commission sweep that cannot be funded must fail LOUDLY with
 * `insufficient_wallet_balance` — that refusal is what the morning gate is for. Quietly
 * turning an unfunded obligation into a wallet debt would collect nothing and tell nobody.
 *
 * Idempotent per business per business-day: a retried settle finds the attempt document
 * and returns the first outcome rather than debiting twice.
 */
async function settleFromWallet(db, businessId, nowMs) {
  if (!businessId) throw new HttpsError('invalid-argument', 'businessId required.');
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const businessDay = businessDayKey(now);
  const BW = require('./business-wallet');
  const attemptRef = db.collection(SETTLEMENTS).doc(businessId + '_' + businessDay);
  const walletRef  = db.collection(BW.WALLETS).doc(String(businessId));

  const outstandingCents = await outstandingCentsFor(db, businessId);
  if (outstandingCents <= 0) {
    return { businessId, businessDay, settledCents: 0, ok: true, reason: 'nothing_outstanding' };
  }

  const outcome = await db.runTransaction(async (txn) => {
    const [prev, wallet] = await Promise.all([txn.get(attemptRef), txn.get(walletRef)]);
    if (prev.exists) {
      const d = prev.data();
      return { ...d, ok: d.ok === true, duplicate: true };
    }
    if (!wallet.exists) {
      const r = { businessId, businessDay, ok: false, settledCents: 0, reason: 'no_wallet' };
      txn.set(attemptRef, { ...r, atMs: now }); return { ...r, duplicate: false };
    }
    /* CENTS, natively. The business wallet already speaks the receivable's unit. */
    const balanceCents = Number(wallet.data().balanceMinor || 0);
    if (balanceCents < outstandingCents) {
      const r = { businessId, businessDay, ok: false, settledCents: 0,
                  reason: 'insufficient_wallet_balance',
                  walletCents: balanceCents, requiredCents: outstandingCents };
      txn.set(attemptRef, { ...r, atMs: now }); return { ...r, duplicate: false };
    }
    const newBalanceCents = balanceCents - outstandingCents;
    txn.update(walletRef, { balanceMinor: newBalanceCents });
    /* The wallet's own statement line, at the deterministic id business-wallet.js uses, so
       this debit appears in the merchant's statement beside the sales that funded it rather
       than as an unexplained drop in the balance. */
    txn.set(db.collection(BW.ENTRIES).doc(
      BW.entryDocId(businessId, 'poscommission_' + businessDay)), {
      ref: 'poscommission_' + businessDay,
      businessId: String(businessId),
      direction: 'debit',
      amountMinor: outstandingCents,
      balanceBeforeMinor: balanceCents,
      balanceAfterMinor: newBalanceCents,
      appliedToDebtMinor: 0,
      shortfallMinor: 0,
      currency: 'KES',
      kind: 'pos_commission',
      metadata: { businessDay },
      createdAt: now,
    });
    const r = { businessId, businessDay, ok: true, settledCents: outstandingCents,
                reason: 'settled_from_wallet', walletCentsBefore: balanceCents,
                walletCentsAfter: newBalanceCents };
    txn.set(attemptRef, { ...r, atMs: now });
    return { ...r, duplicate: false };
  });

  /* The settling ledger entry is written OUTSIDE the transaction, and only on a fresh
     success, because createLedgerEntry carries its own idempotency key. Ledger entries
     are immutable: this is a SETTLING entry, never an edit of the accrual. */
  if (outcome.ok && !outcome.duplicate && outcome.settledCents > 0) {
    const FU = require('./finos-utils');
    await FU.createLedgerEntry(db, {
      type: 'pos_commission_collected',
      amountCents: outcome.settledCents,
      /* ── THE DEBIT WAS CANCELLING THE REVENUE IT COLLECTED ────────────────────────────
         The accrual (pos-zero-friction.js `pos_commission_receivable`) is
             DR seller:{id}          CR platform:revenue
         i.e. the seller owes it and the platform has recognised it. COLLECTING that
         receivable turns it into cash: the credit to seller:{id} clears the debt (which this
         entry already did correctly), and the debit belongs on the account the money arrived
         in — platform clearing.

         It debited PLATFORM_REVENUE, which reverses the revenue recognised at accrual. Every
         commission actually collected therefore erased itself from revenue, so the ledger
         reported income only for commission that was still UNPAID. */
      debitAccount: (FU.ACCOUNTS && FU.ACCOUNTS.PLATFORM_CLEARING) || 'platform:clearing',
      creditAccount: FU.ACCOUNTS ? FU.ACCOUNTS.seller(businessId) : ('seller:' + businessId),
      description: 'POS commission settled from business wallet, day ' + businessDay,
      sellerId: businessId,
      category: 'pos',
      createdBy: 'posBusinessDayGate',
      idempotencyKey: 'posgate_wallet_' + businessId + '_' + businessDay,
      metadata: { businessDay, source: 'wallet' },
    }).catch((e) => { outcome.ledgerError = (e && e.message) || String(e); });
  }
  return outcome;
}

/* NOTE — this ASSIGNS module.exports, which rebinds it and orphans the free `exports`
   variable. Everything defined after this line must therefore attach to
   `module.exports`, never to `exports`. The three callables below did the latter and
   were silently undefined: index.js re-exported them, Firebase saw `undefined`, and the
   gate had no deployable callable at all while looking, in every file, as though it did. */
module.exports = {
  businessDayKey,
  gateTimeMsFor,
  STATUS,
  _decide,
  evaluateGate,
  openBusinessDay,
  assertBusinessDayOpen,
  settleFromWallet,
  outstandingCentsFor,
  BUSINESS_TZ,
  DAY_START_HOUR,
  DAYS,
  SETTLEMENTS,
};

/* ── CALLABLES ───────────────────────────────────────────────────────────────
   Every one authorises the caller against the BUSINESS before answering. Auth alone
   is not authorisation: without the shop check, any signed-in account could read or
   settle another business's obligation, which is the IDOR class this platform has
   already been bitten by on orderAdvance. */
const { onCall } = require('firebase-functions/v2/https');
const { getFirestore } = require('firebase-admin/firestore');

const _cfg = { region: 'us-central1', enforceAppCheck: true, memory: '256MiB', timeoutSeconds: 30 };
const _db  = () => getFirestore();

async function _authorise(request, businessId) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  if (!businessId)   throw new HttpsError('invalid-argument', 'businessId required.');
  const { assertShopAccess } = require('./shop-employees');
  /* Throws permission-denied when the caller has no role at this business. */
  await assertShopAccess(request.auth.uid, String(businessId));
  return String(businessId);
}

/**
 * getBusinessDayStatus — read-only: what does this business owe, and can it trade today?
 *
 * THE ONLY value taken from the caller is `businessId`, and it is not trusted on its own:
 * _authorise puts it through assertShopAccess, so a caller can only ask about a business
 * they hold a corroborated role at. Everything else that could change the answer — the
 * current time, the business date, the 07:00 boundary and the outstanding balance — is
 * resolved on the SERVER. `evaluateGate` is deliberately called WITHOUT a nowMs argument:
 * the parameter exists for tests, and passing request data into it would hand the client a
 * clock. A forged `outstandingForSellerCents`, `status`, `businessDate` or `nowMs` in the
 * request is not rejected — it is never read, which is stronger, because there is no
 * validation branch to get wrong.
 */
module.exports.posGetBusinessDayGate = onCall(_cfg, async (request) => {
  const businessId = await _authorise(request, (request.data || {}).businessId);
  return evaluateGate(_db(), businessId);
});

/** Attempt to start the business day. A block is a RESULT, not an error. */
module.exports.posOpenBusinessDay = onCall(_cfg, async (request) => {
  const businessId = await _authorise(request, (request.data || {}).businessId);
  return openBusinessDay(_db(), businessId);
});

/** Settle the outstanding obligation from the business wallet, then re-evaluate. */
module.exports.posSettleCommissionFromWallet = onCall(_cfg, async (request) => {
  const businessId = await _authorise(request, (request.data || {}).businessId);
  const db = _db();
  const settled = await settleFromWallet(db, businessId);
  const gate = await evaluateGate(db, businessId);
  return { settled, gate };
});
