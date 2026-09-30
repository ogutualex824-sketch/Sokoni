'use strict';
/**
 * SOKONI — THE DRAW: business wallet → the owner's personal wallet
 *
 *     businessWallets/{businessId}          wallets/{uid}
 *     trading proceeds, CENTS        ──▶    personal balance, SHILLINGS
 *     (obligations attached)                (withdrawable, spendable)
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────────────────────
 * Marketplace settlement and POS/Till sales both credit the BUSINESS wallet. Nothing could
 * take money out of it: `requestSellerPayout` reserves from `wallets/{uid}.balance`, and the
 * merchant-facing wallet surface reads the same document. Without a route between the two, a
 * merchant's earnings would be recorded, correct, reconcilable — and unreachable.
 *
 * ── WHY A DRAW, AND NOT A SECOND PAYOUT RAIL ──────────────────────────────────────────────
 * Paying out directly from the business wallet would mean changing `requestSellerPayout` —
 * the B2C money-out path, carrying the `wallet-backend-v1.0-frozen` tag, with its own risk
 * engine, velocity gate, idempotency and reversal handling. Re-pointing a frozen, certified
 * rail at a different account in a different unit is a far larger financial change than
 * adding one guarded transfer, and it would put every existing payout assertion back in
 * question. This moves money BETWEEN two accounts the platform already owns; the rail that
 * moves money OUT is untouched.
 *
 * It is also the honest accounting. A business wallet holding takings, and an owner drawing
 * from it into their own money, are two different accounts and one deliberate act between
 * them — which is what makes "what has this shop earned?" and "what has its owner taken?"
 * separately answerable. Settling straight into personal money is what made them the same
 * unanswerable question in the first place.
 *
 * ── THE COMMISSION IS RESERVED, NOT MERELY OWED ───────────────────────────────────────────
 * A merchant may not draw the balance below what they currently owe in POS/Till commission.
 * Commission is a receivable recorded against a sale SOKONI never custodied, so the only
 * thing funding it is the balance sitting here. Allowing a full draw would let a merchant
 * take the money and leave the obligation, which the 06:00 gate would then punish them for
 * — a rule that lets someone walk into a locked till is not a rule, it is a trap.
 *
 * The reservation is stated in the refusal (owed / available / requested) so a merchant can
 * see exactly what is holding their money rather than being told "insufficient".
 *
 * ── AUTHORITY ─────────────────────────────────────────────────────────────────────────────
 * The caller never names the business, the wallet, or the destination. The business is
 * resolved from the authenticated uid through the canonical chain, and the credit goes to
 * that same uid's personal wallet. There is no parameter that can redirect this money.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();

const BW = require('./business-wallet');

const REGION = 'us-central1';
const cfg = { region: REGION, cors: true, enforceAppCheck: true, memory: '256MiB', timeoutSeconds: 30 };

const db = () => admin.firestore();
const FieldValue = admin.firestore.FieldValue;

/**
 * What this business still owes in POS/Till commission, in cents.
 *
 * Read through the gate's own function rather than re-querying the liabilities: two ways of
 * computing what someone owes is how a merchant gets told two different numbers. A failure to
 * read it is NOT treated as "owes nothing" — an unreadable obligation must block the draw,
 * because the alternative is releasing money against a debt we could not see.
 */
async function _outstandingCents(businessId) {
  const gate = require('./pos-business-day-gate');
  return gate.outstandingCentsFor(db(), businessId);
}

/**
 * Move `amountShillings` from the caller's business wallet into their personal wallet.
 *
 * Both movements happen in ONE transaction: a debit that committed without its credit would
 * destroy the merchant's money, and a credit without its debit would create money.
 */
async function drawToPersonal(o) {
  const uid = String(o.uid);
  const businessId = String(o.businessId);
  const amountShillings = Number(o.amountShillings);
  const ref = BW.assertRef('draw_' + String(o.idempotencyKey));

  /* THE UNIT BOUNDARY, CROSSED EXACTLY ONCE AND ONLY ON A WHOLE NUMBER.
     The business wallet is cents; the personal wallet is whole shillings. A draw of a
     fractional shilling could not be represented on the far side, so it is refused rather
     than rounded — rounding here would either invent or destroy cents on every draw. */
  if (!Number.isInteger(amountShillings) || amountShillings <= 0) {
    throw new HttpsError('invalid-argument', 'Draw amount must be a positive whole number of KES.');
  }
  const amountMinor = amountShillings * 100;

  const owedCents = await _outstandingCents(businessId);

  const bwRef = db().collection(BW.WALLETS).doc(businessId);
  const beRef = db().collection(BW.ENTRIES).doc(BW.entryDocId(businessId, ref));
  const pwRef = db().collection('wallets').doc(uid);

  return db().runTransaction(async (t) => {
    const [bwSnap, beSnap, pwSnap] = await Promise.all([t.get(bwRef), t.get(beRef), t.get(pwRef)]);

    /* IDEMPOTENT REPLAY — decided inside the transaction, so two concurrent taps of the same
       draw cannot both pass the check before either writes. */
    if (beSnap.exists) {
      const prior = beSnap.data() || {};
      return {
        applied: false, idempotent: true, amountShillings: Number(prior.amountMinor || 0) / 100,
        businessBalanceMinor: Number((bwSnap.exists ? bwSnap.data().balanceMinor : 0) || 0),
      };
    }

    if (!bwSnap.exists) {
      throw new HttpsError('failed-precondition', 'This business has no wallet yet.');
    }
    const before = Number(bwSnap.data().balanceMinor || 0);
    const debtBefore = Number(bwSnap.data().recoveryDebtMinor || 0);

    /* RESERVED, not merely reported. */
    const availableMinor = Math.max(0, before - owedCents);
    if (amountMinor > availableMinor) {
      throw new HttpsError('failed-precondition',
        'Not enough available balance to draw. You hold KES ' + (before / 100).toFixed(2) +
        ', of which KES ' + (owedCents / 100).toFixed(2) + ' is reserved for POS commission ' +
        'still owed, leaving KES ' + (availableMinor / 100).toFixed(2) + ' available.',
        { balanceMinor: before, reservedMinor: owedCents,
          availableMinor, requestedMinor: amountMinor });
    }

    /* Not a recovery debit: a draw the wallet cannot fund must be refused, never turned into
       a debt. Recovery exists for a reversal the merchant has already spent, which is a
       situation they did not choose; this one they did. */
    const plan = BW.planMove(-1, {
      amountMinor, recovery: false,
      balanceBeforeMinor: before, recoveryDebtBeforeMinor: debtBefore,
    });

    t.set(beRef, {
      ref,
      businessId,
      ownerId: uid,
      storeId: bwSnap.data().storeId || null,
      direction: 'debit',
      amountMinor,
      balanceBeforeMinor: plan.balanceBeforeMinor,
      balanceAfterMinor: plan.balanceAfterMinor,
      appliedToDebtMinor: 0,
      shortfallMinor: 0,
      recoveryDebtBeforeMinor: plan.recoveryDebtBeforeMinor,
      recoveryDebtAfterMinor: plan.recoveryDebtAfterMinor,
      currency: 'KES',
      kind: 'owner_draw',
      sourceUid: uid,
      metadata: { reservedForCommissionMinor: owedCents },
      createdAt: FieldValue.serverTimestamp(),
    });
    t.update(bwRef, {
      balanceMinor: plan.balanceAfterMinor,
      updatedAt: FieldValue.serverTimestamp(),
    });

    /* The personal side, in SHILLINGS. set-merge auto-creates a first-time wallet. */
    t.set(pwRef, {
      uid,
      balance: FieldValue.increment(amountShillings),
      currency: 'KES',
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    /* The personal wallet's own ledger, at a deterministic id, so the two statements can be
       reconciled against each other rather than merely both existing. */
    t.set(db().collection('walletTransactions').doc(uid + '_' + ref), {
      uid,
      type: 'business_wallet_draw',
      amount: amountShillings,
      currency: 'KES',
      businessId,
      sourceType: 'business_wallet',
      sourceId: businessId,
      ref,
      createdAt: FieldValue.serverTimestamp(),
    });

    return {
      applied: true, idempotent: false,
      amountShillings,
      businessBalanceMinor: plan.balanceAfterMinor,
      reservedMinor: owedCents,
    };
  });
}

/* ── The callable ─────────────────────────────────────────────────────────────────────── */
exports.businessWalletDraw = onCall(cfg, async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError('unauthenticated', 'Sign in required.');
  }
  const uid = request.auth.uid;
  const { amount, idempotencyKey } = request.data || {};

  const key = String(idempotencyKey || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 100);
  if (!key) {
    /* Required, not generated. A server-minted key would make every retry a NEW draw, which
       is precisely the double-withdrawal this guards against. */
    throw new HttpsError('invalid-argument', 'idempotencyKey is required.');
  }

  /* THE BUSINESS IS RESOLVED, NEVER SUPPLIED. There is no request field that can name a
     different merchant's wallet, so "Merchant A cannot drain Merchant B" is a property of the
     signature rather than of a check someone has to remember. */
  /* ── COMMISSION RESTRICTION ───────────────────────────────────────────────
     Drawing takings out while owing SOKONI commission is the concrete harm the
     restriction exists to stop. Trading is deliberately NOT gated: blocking sales would
     stop the very income the merchant settles with.

     An unreadable restriction pauses the withdrawal rather than allowing it. Refusing
     delays money by minutes; allowing it cannot be undone. */
  {
    const RG = require('./merchant-restriction-gate');
    const verdict = await RG.assertMayPerform('WITHDRAW_FUNDS', uid, db());
    if (!verdict.allowed) {
      console.warn('[business-wallet-draw] REFUSED uid=' + uid +
        ' reason=' + verdict.reason + ' state=' + verdict.state);
      throw new HttpsError('failed-precondition', RG.refusalMessage(verdict), {
        reason: verdict.reason,
        restrictionState: verdict.state,
      });
    }
  }

  const SD = require('./settlement-destination');
  const dest = await SD.resolveSettlementDestination(db(), {
    sellerUid: uid,
    /* This is not an order; the collected-payment gate does not apply to moving money that
       has ALREADY been settled between two accounts the platform owns. Stated explicitly so
       the exemption is visible rather than implied by a missing field. */
    paymentVerified: true,
  });
  if (!dest.ok) {
    throw new HttpsError('failed-precondition',
      dest.remedy || 'Your business account could not be resolved.', { reason: dest.reason });
  }

  const out = await drawToPersonal({
    uid, businessId: dest.businessId, amountShillings: Number(amount), idempotencyKey: key,
  });

  console.log('[business-wallet-draw] ' + (out.idempotent ? 'REPLAY' : 'DREW') +
    ' business=' + dest.businessId + ' uid=' + uid + ' KES ' + out.amountShillings);
  return out;
});

/**
 * What the merchant's shop holds, what is reserved, and what they may actually move.
 *
 * READ-ONLY, and it lives in THIS module on purpose. `availableMinor` is the same
 * subtraction `drawToPersonal` enforces inside its transaction, so the number the merchant
 * is shown and the number the server will accept cannot drift. Computing "available" in the
 * surface — or in a second module — is how a screen ends up offering a transfer the server
 * then refuses, and the merchant is told their own balance is wrong.
 *
 * It reports rather than decides: an unreadable obligation surfaces as an error, never as a
 * reserve of zero, for the same reason the draw refuses in that case.
 */
exports.businessWalletSummary = onCall(cfg, async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError('unauthenticated', 'Sign in required.');
  }
  const uid = request.auth.uid;

  const SD = require('./settlement-destination');
  const dest = await SD.resolveSettlementDestination(db(), { sellerUid: uid, paymentVerified: true });
  if (!dest.ok) {
    /* Not an error the surface should shout about: a seller with no business yet is a normal
       state during onboarding. It is reported as a NAMED absence so the card can say "no
       business account is linked yet" rather than rendering a zero balance. */
    return { ok: false, reason: dest.reason, remedy: dest.remedy || null };
  }

  const snap = await db().collection(BW.WALLETS).doc(dest.businessId).get();
  const balanceMinor = snap.exists ? Number(snap.data().balanceMinor || 0) : 0;
  const recoveryDebtMinor = snap.exists ? Number(snap.data().recoveryDebtMinor || 0) : 0;
  const reservedMinor = await _outstandingCents(dest.businessId);

  /* ONE BALANCE, THREE STREAMS. POS, Till and Online are dimensions of this same ledger, not
     separate wallets — derived from the entries that produced the balance, so a channel total
     cannot drift from the money.

     Best-effort: a wallet is not less usable because a breakdown could not be read, and a
     merchant must still be able to see and draw their money. Reported as absent, never as
     zero — "you have earned nothing online" is a claim, and a failed read is not evidence
     for it. */
  let sales = null;
  try { sales = await BW.salesByChannel(dest.businessId, 500); } catch (_) { sales = null; }

  /* ── THE FIVE FIGURES A MERCHANT ASKS FOR ─────────────────────────────────────────────
       balance       everything the wallet holds
       reserved      held back for POS commission still owed — see the draw
       available     balance minus reserved
       withdrawable  what could actually leave today. Equal to available here because the
                     draw is the only way out and it has no further floor of its own; kept
                     as its own field rather than aliased, because the moment a minimum or a
                     hold is introduced the two diverge and every reader should already be
                     asking the right one.
       outstanding   the commission itself, stated rather than only implied by `reserved` */
  const availableMinor = Math.max(0, balanceMinor - reservedMinor);

  return {
    ok: true,
    businessId: dest.businessId,
    storeId: dest.storeId || null,
    exists: snap.exists,
    currency: 'KES',
    balanceMinor,
    reservedMinor,
    availableMinor,
    withdrawableMinor: availableMinor,
    outstandingCommissionMinor: reservedMinor,
    /* Money that has been credited but is not yet spendable. Today the wallet has no holding
       period — a credit is immediate — so this is 0 and says so explicitly rather than being
       omitted, because a surface that has to infer "no pending" from a missing field will
       eventually infer it wrongly. */
    pendingMinor: 0,
    recoveryDebtMinor,
    /* The three streams, each with its own gross / commission / net, plus the combined
       total. Null when the breakdown could not be read. */
    channels: sales ? sales.channels : null,
    salesTotals: sales ? sales.totals : null,
    drawnMinor: sales ? sales.drawnMinor : null,
    salesComplete: sales ? sales.complete : null,
  };
});

module.exports.drawToPersonal = drawToPersonal;
module.exports._outstandingCents = _outstandingCents;
