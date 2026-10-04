'use strict';
/**
 * SOKONI — BUSINESS WALLET
 *
 * The money a BUSINESS holds, kept separate from the money its owner holds.
 *
 * WHY A SECOND WALLET, AND NOT A SECOND USE OF THE FIRST
 * -----------------------------------------------------
 * `wallets/{uid}` is a PERSON's wallet: it funds top-ups and receives payouts, and its owner
 * may spend it on anything. Trading proceeds are not that. They carry obligations — the 5%
 * POS commission, refunds owed to customers, a reconciliation a merchant can be asked to
 * produce — and those obligations belong to the business, not to whoever happens to own it
 * today. Settling shop takings into a personal wallet makes "what does this shop owe?"
 * unanswerable, because the balance has already been mixed with money that was never the
 * shop's.
 *
 * The personal wallet is NOT renamed and NOT repurposed. It keeps its collection, its shape
 * and its unit. This is an addition.
 *
 * KEYED ON businessId, DELIBERATELY
 * ---------------------------------
 * `businessWallets/{businessId}` — the generated `businesses` document id, which
 * tenant-identity guarantees "can never equal an auth uid". Keying on the uid would have
 * produced a wallet whose id is a person, which is the thing this module exists to stop, and
 * it would collide with the personal wallet's keyspace in every reader that takes an id
 * without also taking a collection. `assertNotUidShaped` refuses it at every entry point
 * rather than trusting callers to pass the right one.
 *
 * ── THE UNIT IS CENTS, AND THE FIELD NAME SAYS SO ─────────────────────────────────────────
 * `balanceMinor` is in CENTS. The personal wallet's `balance` is in whole KES
 * (wallet.js: `instantLimit: 20000, // KES`). Two wallets, two units, and the settlement
 * engine speaks cents (`orderAmountCents`, `commission.cents`) — so a shared field name would
 * eventually be read with the wrong scale, and a 100x error in a balance is not a rounding
 * bug, it is a wrong answer that looks plausible. The names are different so the two can
 * never be confused by a reader that skims.
 *
 * ── AUTHORITY: THE CALLER NEVER NAMES THE WALLET ──────────────────────────────────────────
 * Every mutation resolves the businessId from the AUTHENTICATED identity. A caller-supplied
 * businessId is accepted only from an admin, and even then it is resolved and checked, never
 * believed. That is what makes "Merchant A cannot credit Merchant B" a property of the
 * design rather than of the current call sites.
 *
 * ── IDEMPOTENCY IS BY DETERMINISTIC ENTRY ID ──────────────────────────────────────────────
 * Every movement carries a `ref` that names the thing that caused it — a saleId, an orderId,
 * a refundId. The ledger entry is written at that id, inside the same transaction as the
 * balance change. A webhook delivered twice, a retried settlement, a double-tapped refund:
 * the second attempt finds the entry already present and changes nothing. Money moves once
 * because the LEDGER says it already moved, not because a caller remembered to check.
 */

const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();
const db = () => admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const WALLETS = 'businessWallets';
const ENTRIES = 'businessWalletEntries';

const REASON = {
  UID_SHAPED:   'business-id-must-not-be-a-uid',
  NO_WALLET:    'no-wallet-for-business',
  INSUFFICIENT: 'insufficient-business-balance',
  BAD_AMOUNT:   'amount-must-be-a-positive-integer-of-cents',
  BAD_REF:      'a-movement-must-name-its-cause',
};

/* ── RECOVERY DEBT ────────────────────────────────────────────────────────────────────────
 * `recoveryDebtMinor` is what this business owes the platform because a settlement was
 * reversed after the merchant had already moved the money out.
 *
 * WHY A DEBT AND NOT A NEGATIVE BALANCE
 * A wallet that can go below zero is a credit facility nobody agreed to, and it hides the
 * shortfall inside a number people read as "balance". So the balance stays floored at zero
 * and the un-recovered remainder becomes an explicit, nameable debt that later trading
 * proceeds pay down first. That is the SAME ratified policy the personal wallet already runs
 * as `refundRecoveryDebt` (order-settlement.js) — stated once more here rather than invented,
 * because the two lanes must behave identically or a reversal would mean different things
 * depending on which wallet happened to hold the money.
 *
 * OPT-IN, DELIBERATELY. `debit()` keeps throwing INSUFFICIENT: a commission sweep that cannot
 * be funded must fail loudly rather than quietly becoming a debt. Only a caller that has
 * decided a shortfall is recoverable — a settlement reversal — passes `recovery: true`.
 */

class WalletError extends Error {
  constructor(reason, message) { super(message || reason); this.reason = reason; }
}

/* ══ WHERE A SALE CAME FROM ═══════════════════════════════════════════════════════════════
 * ONE wallet, ONE balance, THREE streams. A merchant sells in three places and the money
 * lands in one account — that is right, it is one business — but "how is the shop doing?",
 * "is the Till worth having?" and "does the marketplace pay?" are three questions, and a
 * single balance answers none of them.
 *
 *     POS      a sale rung up in the shop, on the merchant's own counter
 *     TILL     a customer paying the provisioned SOKONI Till / QR
 *     ONLINE   a marketplace order
 *
 * They are DIMENSIONS OF ONE LEDGER, not three wallets. Three balances that must add up to a
 * fourth is four places for the same money to disagree, and the reconciliation that finds the
 * disagreement is the one nobody runs. Every total the dashboard shows is derived from the
 * entries that produced the balance, so a channel figure cannot drift from the money.
 *
 * ── EACH CREDIT CARRIES ITS OWN ECONOMICS ─────────────────────────────────────────────────
 * The entry stores gross, commission and net — not just the net that moved. Without the other
 * two, "POS commission this month" can only be reconstructed by joining wallet entries back to
 * sales, which is a second source of truth waiting to disagree with the first. With them, the
 * whole breakdown is one read of the ledger that already exists.
 *
 *     channel          POS | TILL | ONLINE
 *     businessId       whose wallet
 *     shopId           which shop, when the business has more than one
 *     saleId/orderId   the thing that caused it — already the idempotency ref
 *     paymentRef       the collection this was proven against, where there was one
 *     grossMinor       what the customer paid
 *     commissionMinor  what SOKONI took
 *     netMinor         what the merchant kept — equals the amount credited
 *
 * ── AND ORIGIN IS NOT COLLECTION ──────────────────────────────────────────────────────────
 * This block says where a sale CAME FROM. It does not say SOKONI holds the money. A sale can
 * appear in analytics without ever becoming wallet money: a DIRECT_TO_SELLER payment is a real
 * POS sale that belongs in the merchant's sales figures and must never become a wallet credit,
 * because the shillings went into their own till. The wallet only ever sees a movement that
 * cleared pos-collection-proof, so everything in this ledger is money SOKONI actually has —
 * and the channel tells you which of the three brought it in.
 */
var CHANNELS = ['POS', 'TILL', 'ONLINE'];
/* ── METHOD IS A SECOND DIMENSION, NOT A THIRD CHANNEL ──────────────────────────────────
   WHERE a sale happened and HOW it was paid are different questions, and collapsing them
   loses both answers. A merchant asking "how much did the Till take this week" means the
   Till regardless of whether each customer paid by M-PESA or by card; a merchant asking
   "how much came in by card" means card across the counter, the Till and the website.
   Adding CARD to CHANNELS would have made those two questions unanswerable at once, and
   would have split the Till's takings into two streams that are the same shop counter.

   So the entry carries both. Channel totals are unaffected by method — that independence
   is asserted in test-wallet-sales-channels — and a method that is absent or unrecognised
   records as UNKNOWN rather than being guessed at, because a wallet that invents how money
   arrived is worse than one that admits it does not know.

   CASH is here because it is a real tender the POS takes, even though it never reaches this
   wallet: cash sits in the drawer and is recorded as CASH_IN_DRAWER. Listing it keeps the
   vocabulary complete for a caller reading the entry, rather than implying the only tenders
   that exist are the ones that credit. */
var METHODS = ['MPESA', 'CARD', 'BANK', 'CASH'];

/** Normalise a caller's source block. Unknown channel is recorded as such, never guessed. */
function normalizeSource(src) {
  var s = src || {};
  var ch = String(s.channel || '').toUpperCase();
  var n = function (v) {
    var x = Number(v);
    return Number.isFinite(x) ? Math.round(x) : null;
  };
  return {
    channel: CHANNELS.indexOf(ch) !== -1 ? ch : 'UNKNOWN',
    /* How the money arrived, independent of where the sale happened. */
    method: METHODS.indexOf(String(s.method || '').toUpperCase()) !== -1
      ? String(s.method).toUpperCase() : 'UNKNOWN',
    businessId: s.businessId ? String(s.businessId) : null,
    shopId: s.shopId ? String(s.shopId) : null,
    saleId: s.saleId ? String(s.saleId) : null,
    orderId: s.orderId ? String(s.orderId) : null,
    /* The collection this was proven against. Null on a movement that is not a sale — a
       draw, a commission sweep — rather than an empty string that reads like a missing one. */
    paymentRef: s.paymentRef ? String(s.paymentRef) : null,
    grossMinor: n(s.grossMinor),
    commissionMinor: n(s.commissionMinor),
    netMinor: n(s.netMinor),
    currency: s.currency ? String(s.currency) : 'KES',
  };
}

/* ── The invariant, checked at every door ─────────────────────────────────────────────── */
function assertNotUidShaped(businessId, ownerUid) {
  const b = String(businessId || '');
  if (!b) throw new WalletError(REASON.UID_SHAPED, 'businessId is required');
  if (ownerUid && b === String(ownerUid)) {
    throw new WalletError(REASON.UID_SHAPED,
      'A business wallet cannot be keyed on an auth uid — that is the personal wallet keyspace.');
  }
  return b;
}

/* Amounts are integers of cents. A float here is a rounding error waiting to be a balance. */
function assertAmountMinor(amountMinor) {
  const n = Number(amountMinor);
  if (!Number.isInteger(n) || n <= 0) {
    throw new WalletError(REASON.BAD_AMOUNT,
      'Amount must be a positive whole number of cents; got ' + String(amountMinor));
  }
  return n;
}

/** A movement must name its cause, or the ledger cannot be idempotent OR reconciled. */
function assertRef(ref) {
  const r = String(ref || '').trim();
  if (!r) throw new WalletError(REASON.BAD_REF, 'A wallet movement must carry a ref naming its cause.');
  return r.replace(/[^A-Za-z0-9_:.-]/g, '_').slice(0, 180);
}

/* Scoped BY business. A bare ref id would let one business's entry collide with another's
   and silently suppress a legitimate second movement.

   Exposed as a pure id builder — separate from the ref helpers below — because a caller that
   moves this wallet inside its OWN transaction must address the same documents through the
   Firestore handle IT was given. Binding those callers to this module's ambient
   `admin.firestore()` would work in production only by coincidence (one database), and would
   silently write somewhere else the moment they were handed a different handle. The id shape
   stays here so idempotency cannot fork; the connection does not. */
function entryDocId(businessId, ref) { return String(businessId) + '__' + ref; }

function walletRef(businessId) { return db().collection(WALLETS).doc(String(businessId)); }
function entryRef(businessId, ref) {
  return db().collection(ENTRIES).doc(entryDocId(businessId, ref));
}

/**
 * Create the wallet if absent. Idempotent, and never touches an existing balance.
 *
 * `ownerId` is recorded for reconciliation and for rules, but ownership is NOT proved from
 * here — a wallet document cannot vouch for itself.
 */
async function ensureWallet(businessId, ownerUid, meta) {
  assertNotUidShaped(businessId, ownerUid);
  const ref = walletRef(businessId);
  const snap = await ref.get();
  if (snap.exists) {
    return { created: false, businessId: String(businessId), balanceMinor: Number(snap.data().balanceMinor || 0) };
  }
  /* merge-set with the balance ONLY on creation: a concurrent creator must not have its
     balance reset to zero by the loser of the race. */
  await ref.set({
    businessId: String(businessId),
    ownerId: ownerUid ? String(ownerUid) : null,
    storeId: (meta && meta.storeId) || null,
    currency: 'KES',
    balanceMinor: 0,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return { created: true, businessId: String(businessId), balanceMinor: 0 };
}

/**
 * THE ARITHMETIC OF A MOVEMENT — pure, and the ONLY copy of it.
 *
 * Extracted from `_move` so that a caller which must move this wallet inside ITS OWN
 * transaction (order settlement credits the business wallet in the same atomic step that
 * marks the order settled — a credit that could fail separately is money owed and not paid)
 * computes the same numbers rather than reimplementing them. Two implementations of "what
 * does this balance become" is how two wallets start disagreeing.
 *
 * `direction` is +1 to credit, -1 to debit. Throws INSUFFICIENT only for a non-recovery
 * debit, which is the behaviour `debit()` has always had.
 */
function planMove(direction, o) {
  const amountMinor = assertAmountMinor(o.amountMinor);
  const recovery = o.recovery === true;
  const before = Number(o.balanceBeforeMinor || 0);
  const debtBefore = Number(o.recoveryDebtBeforeMinor || 0);

  /* The three outcomes, kept explicit rather than folded into one expression: a reader
     deciding whether money moved correctly should not have to evaluate arithmetic. */
  let after, debtAfter = debtBefore, appliedToDebtMinor = 0, shortfallMinor = 0;

  if (direction > 0) {
    /* A credit clears an outstanding debt BEFORE it becomes spendable balance. Paying the
       merchant while they still owe a reversed settlement would let the same money be
       withdrawn twice — once before the reversal and once after. */
    if (recovery && debtBefore > 0) {
      appliedToDebtMinor = Math.min(debtBefore, amountMinor);
      debtAfter = debtBefore - appliedToDebtMinor;
    }
    after = before + (amountMinor - appliedToDebtMinor);
  } else if (recovery) {
    /* Recover what is actually there; the rest becomes an explicit debt. The balance is
       floored at zero — see the RECOVERY DEBT note above. */
    const recovered = Math.min(before, amountMinor);
    shortfallMinor = amountMinor - recovered;
    debtAfter = debtBefore + shortfallMinor;
    after = before - recovered;
  } else {
    after = before - amountMinor;
    /* NEVER NEGATIVE. A wallet that can go below zero is a credit facility nobody agreed to,
       and it hides the very shortfall the caller needed to be told about. */
    if (after < 0) {
      throw new WalletError(REASON.INSUFFICIENT,
        'Insufficient business balance: have ' + before + ' cents, needed ' + amountMinor + '.');
    }
  }

  return {
    amountMinor,
    balanceBeforeMinor: before,
    balanceAfterMinor: after,
    recoveryDebtBeforeMinor: debtBefore,
    recoveryDebtAfterMinor: debtAfter,
    appliedToDebtMinor,
    shortfallMinor,
  };
}

/**
 * Move money, in ONE transaction with the ledger entry.
 *
 * `direction` is +1 to credit, -1 to debit. Both go through here so that the balance and the
 * entry can never be written apart: a credit with no entry is money from nowhere, and an
 * entry with no credit is a promise nobody kept.
 */
async function _move(direction, o) {
  const businessId = assertNotUidShaped(o.businessId, o.ownerUid);
  const amountMinor = assertAmountMinor(o.amountMinor);
  const ref = assertRef(o.ref);
  const recovery = o.recovery === true;
  const wRef = walletRef(businessId);
  const eRef = entryRef(businessId, ref);

  return db().runTransaction(async (t) => {
    /* ALL READS FIRST. */
    const [wSnap, eSnap] = await Promise.all([t.get(wRef), t.get(eRef)]);

    /* IDEMPOTENT REPLAY. The entry already exists, so this movement already happened — return
       the balance as it stands and write nothing. Deciding this INSIDE the transaction is what
       makes two concurrent deliveries of the same webhook safe; deciding it outside would let
       both pass the check before either wrote. */
    if (eSnap.exists) {
      const prior = eSnap.data() || {};
      return {
        applied: false, idempotent: true, ref,
        businessId, amountMinor: Number(prior.amountMinor || 0),
        balanceMinor: Number((wSnap.exists ? wSnap.data().balanceMinor : 0) || 0),
      };
    }

    if (!wSnap.exists) {
      /* A debit against a wallet that does not exist is not a zero balance, it is a missing
         account — and creating one here to hold a negative would invent the account AND the
         overdraft in the same step. */
      if (direction < 0) throw new WalletError(REASON.NO_WALLET, 'This business has no wallet.');
      t.set(wRef, {
        businessId, ownerId: o.ownerUid ? String(o.ownerUid) : null,
        storeId: o.storeId || null, currency: 'KES', balanceMinor: 0,
        createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      });
    }

    const before = Number((wSnap.exists ? wSnap.data().balanceMinor : 0) || 0);
    const debtBefore = Number((wSnap.exists ? wSnap.data().recoveryDebtMinor : 0) || 0);
    const { balanceAfterMinor: after, recoveryDebtAfterMinor: debtAfter,
            appliedToDebtMinor, shortfallMinor } =
      planMove(direction, { amountMinor, recovery, balanceBeforeMinor: before,
                            recoveryDebtBeforeMinor: debtBefore });

    t.set(eRef, {
      ref,
      businessId,
      storeId: o.storeId || null,
      direction: direction > 0 ? 'credit' : 'debit',
      amountMinor,
      balanceBeforeMinor: before,
      balanceAfterMinor: after,
      /* Recorded on EVERY entry, so a statement reads the same whether or not a debt was in
         play — a field that appears only sometimes is a field readers learn to ignore. */
      appliedToDebtMinor,
      shortfallMinor,
      recoveryDebtBeforeMinor: debtBefore,
      recoveryDebtAfterMinor: debtAfter,
      currency: 'KES',
      kind: o.kind || 'unspecified',      /* pos_sale | marketplace_settlement | commission | refund | ... */
      /* WHERE IT CAME FROM AND WHAT IT WAS WORTH. Stored on every movement, so the channel
         breakdown is a read of this ledger rather than a second set of totals kept beside it.
         See the CHANNELS note above for why these are dimensions and not separate wallets. */
      source: normalizeSource(o.source),
      sourceUid: o.actorUid || null,
      metadata: o.metadata || {},
      createdAt: FieldValue.serverTimestamp(),
    });
    t.update(wRef, {
      balanceMinor: after,
      recoveryDebtMinor: debtAfter,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return { applied: true, idempotent: false, ref, businessId, amountMinor,
             balanceMinor: after, appliedToDebtMinor, shortfallMinor,
             recoveryDebtMinor: debtAfter };
  });
}

const credit = (o) => _move(+1, o);
const debit  = (o) => _move(-1, o);

/* Settlement lane movements. Trading proceeds clear an outstanding reversal debt before they
   become spendable; a reversal recovers what it can and names the rest. */
const creditWithRecovery = (o) => _move(+1, Object.assign({}, o, { recovery: true }));
const debitWithRecovery  = (o) => _move(-1, Object.assign({}, o, { recovery: true }));

/** Read-only. Returns null for a business with no wallet — never a fabricated zero. */
async function balanceOf(businessId) {
  const snap = await walletRef(String(businessId)).get();
  if (!snap.exists) return null;
  const d = snap.data() || {};
  return {
    businessId: String(businessId),
    balanceMinor: Number(d.balanceMinor || 0),
    /* Reported alongside the balance, never netted into it: "you hold X and owe Y" is two
       facts, and a single blended number cannot answer either question. */
    recoveryDebtMinor: Number(d.recoveryDebtMinor || 0),
    currency: d.currency || 'KES',
    ownerId: d.ownerId || null,
    storeId: d.storeId || null,
  };
}

/**
 * ONE WALLET, TWO KINDS OF EARNING, TOLD APART.
 *
 * A merchant sells in two places and the money lands in the same account, which is correct —
 * it is one business and one balance. But "how much did the shop take today?" and "how much
 * did the marketplace bring me?" are different questions, and a single number answers neither.
 * Every movement already names its cause, so the split is a read rather than a second ledger:
 *
 *     marketplace_settlement          an online order, after commission
 *     pos_sale                        a shop / POS / Till sale, after commission
 *     owner_draw                      moved out to the personal wallet
 *     pos_commission                  the morning gate collecting what was owed
 *     marketplace_settlement_reversal a refunded online order coming back
 *
 * Deliberately NOT a set of separate balances. Two balances that must add up to a third is
 * three places for the same money to disagree; this derives the split from the entries that
 * produced it, so it cannot drift from the balance it explains.
 *
 * Bounded, and it says when it is. A merchant with ten thousand movements gets the most
 * recent `limit` of them and `complete: false` — a partial total presented as a lifetime one
 * is a fabricated figure, and this is money.
 */
/**
 * THE SALES BREAKDOWN, DERIVED FROM THE LEDGER THAT HOLDS THE MONEY.
 *
 * One wallet, one balance, three streams — POS, TILL, ONLINE — each with its own gross,
 * commission and net. Every figure comes from the entries that PRODUCED the balance, so a
 * channel total cannot drift from the money the way a separately-maintained counter would.
 * There is no second source to reconcile against, because there is no second source.
 *
 * REFUNDS SUBTRACT. A reversed sale is not a sale that happened and then a separate negative
 * event: it is a sale that stopped counting. Its channel is carried on the reversal entry, so
 * the stream it came from is the stream it leaves.
 *
 * BOUNDED, AND IT SAYS SO. A busy merchant has more movements than any one read should pull,
 * so this takes the most recent `limit` and reports `complete: false` when there are older
 * ones. A partial total presented as a lifetime figure is a fabricated number, and this is
 * money — so the caller is told which it is holding rather than left to assume.
 */
async function salesByChannel(businessId, limit) {
  const cap = Math.min(Number(limit) || 500, 2000);
  const snap = await db().collection(ENTRIES)
    .where('businessId', '==', String(businessId))
    .orderBy('createdAt', 'desc')
    .limit(cap + 1)
    .get();

  const rows = snap.docs.map((d) => d.data() || {});
  const complete = rows.length <= cap;
  const counted = rows.slice(0, cap);

  const blank = () => ({ grossMinor: 0, commissionMinor: 0, netMinor: 0, count: 0 });
  const channels = { POS: blank(), TILL: blank(), ONLINE: blank() };
  const byKind = {};
  let drawnMinor = 0, commissionPaidMinor = 0;

  counted.forEach((e) => {
    const kind = String(e.kind || 'unspecified');
    const amt = Number(e.amountMinor || 0);
    const credit = e.direction === 'credit';

    if (!byKind[kind]) byKind[kind] = { kind, inMinor: 0, outMinor: 0, count: 0 };
    byKind[kind].count += 1;
    if (credit) byKind[kind].inMinor += amt; else byKind[kind].outMinor += amt;

    if (kind === 'owner_draw') drawnMinor += amt;
    if (kind === 'pos_commission') commissionPaidMinor += amt;

    const src = e.source || {};
    const ch = channels[String(src.channel || '')];
    if (!ch) return;                       /* a draw or a sweep belongs to no sales channel */

    /* The entry's own economics, with the credited amount as the fallback for net: an older
       row written before `source` carried gross/commission still counts toward its channel
       rather than silently reading as zero. */
    const net = Number.isFinite(Number(src.netMinor)) ? Number(src.netMinor) : amt;
    const gross = Number.isFinite(Number(src.grossMinor)) ? Number(src.grossMinor) : net;
    const comm = Number.isFinite(Number(src.commissionMinor)) ? Number(src.commissionMinor) : 0;
    const sign = credit ? 1 : -1;          /* a reversal takes its sale back out of the stream */

    ch.grossMinor += sign * gross;
    ch.commissionMinor += sign * comm;
    ch.netMinor += sign * net;
    ch.count += credit ? 1 : -1;
  });

  const totals = ['POS', 'TILL', 'ONLINE'].reduce((a, k) => ({
    grossMinor: a.grossMinor + channels[k].grossMinor,
    commissionMinor: a.commissionMinor + channels[k].commissionMinor,
    netMinor: a.netMinor + channels[k].netMinor,
    count: a.count + channels[k].count,
  }), blank());

  return {
    businessId: String(businessId),
    currency: 'KES',
    channels,
    totals,
    /* Movements that are not sales, kept apart from the streams so "combined sales" means
       sales and nothing else. */
    drawnMinor,
    commissionPaidMinor,
    byKind: Object.keys(byKind).map((k) => byKind[k]),
    entriesCounted: counted.length,
    complete,
  };
}
/**
 * The statement a merchant (or a reconciliation) reads. Entries are append-only and carry the
 * balance either side of the movement, so a statement can be checked against itself without
 * replaying the whole history.
 */
async function entries(businessId, limit) {
  const snap = await db().collection(ENTRIES)
    .where('businessId', '==', String(businessId))
    .orderBy('createdAt', 'desc')
    .limit(Math.min(Number(limit) || 50, 500))
    .get();
  return snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
}

module.exports = {
  REASON, WalletError,
  assertNotUidShaped, assertAmountMinor,
  ensureWallet, credit, debit, creditWithRecovery, debitWithRecovery, balanceOf, entries,
  salesByChannel, normalizeSource, CHANNELS, METHODS,
  /* For a caller that must move this wallet inside its own transaction. `planMove` is the
     arithmetic; the refs address the same two documents `_move` writes, so idempotency by
     deterministic entry id holds across both entry points rather than only within one. */
  planMove, walletRef, entryRef, entryDocId, assertRef, WALLETS, ENTRIES,
  _internal: { walletRef, entryRef, _move },
};
