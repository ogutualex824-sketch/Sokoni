'use strict';

/**
 * SOKONI RESOLUTION AUTHORITY
 * ────────────────────────────────────────────────────────────────────────────
 * What happens after somebody decides a buyer is owed something.
 *
 * Until now only ONE remedy had a lifecycle. A buyer could ask for a replacement, a repair
 * or an exchange, the server would record the request, and then the only machine available
 * to carry it forward could end in exactly two places: REFUNDED, or nothing. Three of the
 * five things a seller may promise had nowhere to go.
 *
 * This module is that missing machine. It owns the branch — which remedy, which milestones,
 * who may move each one — and it owns nothing about money.
 *
 *                              REQUESTED
 *                                  ↓
 *                              ELIGIBLE
 *                                  ↓
 *                       RESOLUTION_AUTHORIZED
 *                                  ↓
 *   ┌────────────┬────────────────┬────────────────┬────────────────┐
 *   │ REFUND     │ REPLACEMENT    │ REPAIR         │ EXCHANGE       │  STORE_CREDIT
 *   │ PROCESSING │ SELLER_HANDOVER│ SELLER_HANDOVER│ SELLER_HANDOVER│  CREDIT_ISSUED
 *   │ PROVIDER_… │                │                │                │
 *   │ REFUNDED   │ REPLACED       │ REPAIRED       │ EXCHANGED      │  CREDITED
 *   └────────────┴────────────────┴────────────────┴────────────────┘
 *
 * ── V1 IS SELLER-ARRANGED ─────────────────────────────────────────────────────
 * A replacement, repair or exchange is handed over by the seller. SOKONI does not dispatch
 * a rider for it: rider business identity is UNLINKED, and a remedy that waited on rider
 * provisioning would be a remedy nobody could actually receive. SOKONI records the
 * milestones, keeps the case attached to the dispute, and shows the buyer where it is.
 *
 * When rider provisioning exists, SELLER_HANDOVER becomes the place a real delivery leg
 * attaches. Nothing else in this machine has to change for that.
 *
 * ── THE LIABILITY IS STILL RECORDED ───────────────────────────────────────────
 * Not dispatching a rider is not the same as not knowing who pays. `returnDeliveryLiability`
 * is computed by the warranty authority from fault and is PERSISTED on the resolution, so
 * that when the cost is settled — by the seller, by the platform, or later by a real
 * delivery leg — the answer to "whose cost was this" is already on the record rather than
 * reconstructed months later from an argument.
 *
 * ── THE INVARIANT THAT MATTERS MOST ───────────────────────────────────────────
 * A branch cannot leak into another branch. A repair can never reach REFUNDED. If it could,
 * a logistics obligation would be able to turn itself into a payment without anyone
 * deciding that it should.
 */

const REFUND = require('./refund-authority');
const WP = require('./warranty-policy');

const REMEDY = WP.REMEDY;

/* ── STATES ──────────────────────────────────────────────────────────────────
   The shared head of the machine, then one tail per remedy.

   The refund tail is TAKEN FROM the refund authority rather than restated here. Two
   spellings of the same lifecycle is two lifecycles, kept in agreement by nothing but
   attention — and the refund path is the one with money on it. */
const STATE = Object.freeze({
  /* shared */
  REQUESTED: 'REQUESTED',
  ELIGIBLE: 'ELIGIBLE',
  RESOLUTION_AUTHORIZED: 'RESOLUTION_AUTHORIZED',
  REFUSED: 'REFUSED',

  /* refund — the refund authority's own words */
  PROCESSING: REFUND.STATE.PROCESSING,
  PROVIDER_CONFIRMED: REFUND.STATE.PROVIDER_CONFIRMED,
  REFUNDED: REFUND.STATE.REFUNDED,
  FAILED: REFUND.STATE.FAILED,

  /* seller-arranged */
  SELLER_HANDOVER: 'SELLER_HANDOVER',
  REPLACED: 'REPLACED',
  REPAIRED: 'REPAIRED',
  EXCHANGED: 'EXCHANGED',

  /* store credit */
  CREDIT_ISSUED: 'CREDIT_ISSUED',
  CREDITED: 'CREDITED',
});

/* ── WHICH TAIL BELONGS TO WHICH REMEDY ──────────────────────────────────────
   The single source of the branch. Everything else — legal moves, who may make them,
   whether a state is terminal — is derived from this, so a remedy cannot acquire a state
   belonging to another one by anybody forgetting to update a second table. */
const BRANCH = Object.freeze({
  [REMEDY.REFUND]: Object.freeze({
    path: Object.freeze([STATE.PROCESSING, STATE.PROVIDER_CONFIRMED, STATE.REFUNDED]),
    terminal: STATE.REFUNDED,
    monetary: true,
    sellerArranged: false,
  }),
  [REMEDY.REPLACEMENT]: Object.freeze({
    path: Object.freeze([STATE.SELLER_HANDOVER, STATE.REPLACED]),
    terminal: STATE.REPLACED,
    monetary: false,
    sellerArranged: true,
  }),
  [REMEDY.REPAIR]: Object.freeze({
    path: Object.freeze([STATE.SELLER_HANDOVER, STATE.REPAIRED]),
    terminal: STATE.REPAIRED,
    monetary: false,
    sellerArranged: true,
  }),
  [REMEDY.EXCHANGE]: Object.freeze({
    path: Object.freeze([STATE.SELLER_HANDOVER, STATE.EXCHANGED]),
    terminal: STATE.EXCHANGED,
    monetary: false,
    sellerArranged: true,
  }),
  [REMEDY.STORE_CREDIT]: Object.freeze({
    /* NOT A WALLET CREDIT, and deliberately not modelled as one. The wallet backend is
       frozen, and a "credit" that wrote a balance would be this module minting money.
       What SOKONI records is the seller's OBLIGATION to honour a credit they issued —
       the same trust shape as a handover: the seller performs it, the buyer confirms it.

       When the wallet is unfrozen this becomes a real ledger entry, and CREDITED becomes
       the point at which that entry is written. */
    path: Object.freeze([STATE.CREDIT_ISSUED, STATE.CREDITED]),
    terminal: STATE.CREDITED,
    monetary: false,
    sellerArranged: true,
  }),
});

const REMEDY_KEYS = Object.freeze(Object.keys(BRANCH));

/* Every state that belongs to some branch, so "is this state part of a different branch"
   is answerable without enumerating them by hand anywhere else. */
const BRANCH_STATES = Object.freeze(
  REMEDY_KEYS.reduce((acc, k) => acc.concat(BRANCH[k].path), [])
);

/* ── WHO MAY MAKE EACH MOVE ──────────────────────────────────────────────────
   A milestone nobody is named for is a milestone anybody can claim.

   The seller says they have handed the item over; the BUYER confirms they received it.
   A seller who could complete their own obligation would be marking their own homework,
   and a buyer who could complete it alone would be closing a case the seller never
   performed. This is the same split the delivery rail already uses — shop departure, then
   buyer receipt — minus the PIN, because there is no rider in the middle to bind one to. */
const ACTOR = Object.freeze({
  SELLER: 'seller',
  BUYER: 'buyer',
  ADMIN: 'admin',
  /* The provider's own confirmation, arriving over a webhook. Never a person. */
  PROVIDER: 'provider',
});

function refuse(reason, detail) {
  return { ok: false, reason, detail: detail == null ? null : detail };
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function branchFor(remedy) {
  const k = typeof remedy === 'string' ? remedy.trim() : '';
  if (!k) return refuse('NO_REMEDY');
  const b = BRANCH[k];
  if (!b) return refuse('UNKNOWN_REMEDY', k);
  return { ok: true, remedy: k, branch: b };
}

/* ── 1. THE LEGAL MOVES ──────────────────────────────────────────────────────
   Derived from BRANCH, and REMEDY-AWARE. The same state can have different successors
   depending on which remedy is being carried out, which is exactly why a single flat
   transition table could not express this machine. */
function allowedNext(state, remedy) {
  const b = branchFor(remedy);
  if (!b.ok) return b;
  const path = b.branch.path;
  const s = typeof state === 'string' ? state.trim() : '';

  if (s === STATE.REQUESTED) return { ok: true, next: [STATE.ELIGIBLE, STATE.REFUSED] };
  if (s === STATE.ELIGIBLE) return { ok: true, next: [STATE.RESOLUTION_AUTHORIZED, STATE.REFUSED] };

  /* The branch point. Authorising a resolution is what commits it to one tail. */
  if (s === STATE.RESOLUTION_AUTHORIZED) return { ok: true, next: [path[0]] };

  /* A provider outage is retryable: the money never moved, so eligibility never lapsed.
     Checked BEFORE the path lookup because FAILED is not on the happy path and would
     otherwise be rejected as belonging to no branch at all. Only the refund branch has
     a provider, so only the refund branch can reach it. */
  if (s === STATE.FAILED) {
    if (!b.branch.monetary) return refuse('WRONG_BRANCH', 'FAILED is not part of ' + b.remedy);
    return { ok: true, next: [STATE.ELIGIBLE] };
  }

  const at = path.indexOf(s);
  if (at === -1) {
    /* Not in this branch. Said precisely, because "that state belongs to a different
       remedy" and "that state does not exist" are different problems. */
    if (BRANCH_STATES.indexOf(s) > -1) return refuse('WRONG_BRANCH', s + ' is not part of ' + b.remedy);
    if (s === STATE.REFUSED) return { ok: true, next: [] };
    return refuse('UNKNOWN_STATE', s);
  }


  if (at === path.length - 1) return { ok: true, next: [] };

  const next = [path[at + 1]];
  if (b.branch.monetary && s === STATE.PROCESSING) next.push(STATE.FAILED);
  return { ok: true, next };
}

function canTransition(from, to, remedy) {
  const a = allowedNext(from, remedy);
  if (!a.ok) return a;
  const t = typeof to === 'string' ? to.trim() : '';
  if (!t) return refuse('NO_TARGET');
  if (a.next.indexOf(t) === -1) {
    return refuse('ILLEGAL_TRANSITION', from + ' -> ' + t + ' for ' + remedy);
  }
  const b = branchFor(remedy);
  return { ok: true, from, to: t, remedy: b.remedy, terminal: b.branch.terminal === t };
}

/* ── 2. WHO IS ALLOWED TO MAKE IT ────────────────────────────────────────────
   Returns the actor a move REQUIRES. The caller checks its own claims against this; the
   authority does not read tokens. */
function actorFor(from, to, remedy) {
  const move = canTransition(from, to, remedy);
  if (!move.ok) return move;
  const b = BRANCH[move.remedy];

  /* Deciding whether a claim is good, and authorising the remedy, are platform decisions.
     A seller who could refuse their own buyer's claim would be the judge of it. */
  if (to === STATE.ELIGIBLE || to === STATE.REFUSED || to === STATE.RESOLUTION_AUTHORIZED) {
    return { ok: true, actor: ACTOR.ADMIN, from, to, remedy: move.remedy };
  }

  if (b.monetary) {
    /* Money moves on the provider's word, never on a person pressing a button. */
    if (to === STATE.PROVIDER_CONFIRMED || to === STATE.FAILED) {
      return { ok: true, actor: ACTOR.PROVIDER, from, to, remedy: move.remedy };
    }
    return { ok: true, actor: ACTOR.ADMIN, from, to, remedy: move.remedy };
  }

  /* Seller-arranged: the seller performs, the buyer confirms. */
  if (to === STATE.SELLER_HANDOVER || to === STATE.CREDIT_ISSUED) {
    return { ok: true, actor: ACTOR.SELLER, from, to, remedy: move.remedy };
  }
  if (to === b.terminal) {
    return { ok: true, actor: ACTOR.BUYER, from, to, remedy: move.remedy };
  }
  return refuse('NO_ACTOR', from + ' -> ' + to);
}

/* ── 3. THE RECORD ───────────────────────────────────────────────────────────
 * The fields a resolution must carry, built from the case rather than from a request.
 *
 * `returnDeliveryLiability` is the one that used to be dropped. The warranty authority
 * computed it from fault on every assessment and nothing persisted it, so the answer to
 * "whose cost was this return" existed for the length of one function call. V1 does not
 * dispatch a rider, but it does record who would have owed for one.
 */
function buildRecord(input) {
  const i = isPlainObject(input) ? input : {};

  const b = branchFor(i.remedy);
  if (!b.ok) return b;

  const orderId = typeof i.orderId === 'string' ? i.orderId.trim() : '';
  if (!orderId) return refuse('NO_ORDER');

  const disputeId = typeof i.disputeId === 'string' ? i.disputeId.trim() : '';

  /* FAULT IS THE AUTHORITY'S, NEVER THE REQUEST'S. It arrives already decided by the
     warranty authority from the reason; accepting it from a caller would let whoever
     builds the record choose who pays. */
  const fault = typeof i.fault === 'string' ? i.fault : WP.FAULT.UNDETERMINED;
  const liability = WP.returnDeliveryLiability(fault);

  return {
    ok: true,
    record: {
      orderId,
      productId: typeof i.productId === 'string' ? i.productId.trim() || null : null,
      lineIndex: (i.lineIndex === null || i.lineIndex === undefined || i.lineIndex === '')
        ? null : Number(i.lineIndex),
      disputeId: disputeId || null,

      resolutionType: b.remedy,
      resolutionStatus: STATE.REQUESTED,

      /* WHOSE FAULT, AND THEREFORE WHOSE COST. Persisted together so neither can be read
         without the other. */
      sellerFault: fault === WP.FAULT.SELLER,
      fault,
      returnDeliveryLiability: liability,

      /* WHICH PROMISE governed this. Months later "why was this owed" has to be
         answerable from the document, not recomputed against a policy the seller has
         since edited. */
      policyVersion: typeof i.policyVersion === 'string' ? i.policyVersion : null,

      /* V1: nobody is dispatched. Recorded explicitly so that a later reader can tell a
         deliberate absence from a missing field. */
      handover: b.branch.sellerArranged ? 'seller_arranged' : null,
      deliveryLegId: null,

      monetary: b.branch.monetary,
    },
  };
}

/* ── 4. WHAT THE BUYER IS SHOWN ──────────────────────────────────────────────
   The milestones of THIS remedy, in order, with the reached ones marked. Built from the
   branch so a buyer is never shown a step their remedy does not have — a replacement that
   displayed "Refunded" as a future step would be promising money nobody agreed to. */
function milestones(remedy, current) {
  const b = branchFor(remedy);
  if (!b.ok) return b;

  const LABEL = {
    [STATE.REQUESTED]: 'Requested',
    [STATE.ELIGIBLE]: 'Accepted',
    [STATE.RESOLUTION_AUTHORIZED]: 'Resolution agreed',
    [STATE.PROCESSING]: 'Refund sent to the provider',
    [STATE.PROVIDER_CONFIRMED]: 'Provider confirmed',
    [STATE.REFUNDED]: 'Refunded',
    [STATE.SELLER_HANDOVER]: 'Seller arranging handover',
    [STATE.REPLACED]: 'Replaced',
    [STATE.REPAIRED]: 'Repaired',
    [STATE.EXCHANGED]: 'Exchanged',
    [STATE.CREDIT_ISSUED]: 'Credit issued by the seller',
    [STATE.CREDITED]: 'Credit received',
  };

  const full = [STATE.REQUESTED, STATE.ELIGIBLE, STATE.RESOLUTION_AUTHORIZED].concat(b.branch.path);
  const at = full.indexOf(current);

  return {
    ok: true,
    remedy: b.remedy,
    /* A refused case is not a step on the path; it is the path stopping. */
    refused: current === STATE.REFUSED,
    steps: full.map((s, n) => ({
      state: s,
      label: LABEL[s] || s,
      reached: at > -1 && n <= at,
      current: s === current,
    })),
  };
}

/* ── 5. THE MONEY BOUNDARY ───────────────────────────────────────────────────
   Asserted here rather than trusted. Only a refund is monetary, and only a refund may
   reach a state the refund authority knows about. */
function isMonetary(remedy) {
  const b = branchFor(remedy);
  return b.ok ? b.branch.monetary === true : false;
}

/**
 * Would this move let a non-monetary remedy reach money?
 *
 * The check exists because the failure it guards against is silent: a repair that reached
 * REFUNDED would look like a completed case, and the money would already be gone.
 */
function crossesIntoMoney(remedy, to) {
  const b = branchFor(remedy);
  if (!b.ok) return true;                      /* unknown remedy: treat as unsafe */
  if (b.branch.monetary) return false;
  return BRANCH[REMEDY.REFUND].path.indexOf(to) > -1;
}

module.exports = {
  STATE, BRANCH, BRANCH_STATES, REMEDY, REMEDY_KEYS, ACTOR,
  branchFor, allowedNext, canTransition, actorFor,
  buildRecord, milestones, isMonetary, crossesIntoMoney,
};
