'use strict';

/**
 * SOKONI PAYMENT IDENTITY AUTHORITY
 * ────────────────────────────────────────────────────────────────────────────
 * Payment is where a guest becomes a buyer. This module owns the rules of that
 * conversion, and nothing else: it holds no database, mints no account, and moves no
 * money. It answers "who is this, and what may happen next".
 *
 * ── FOUR THINGS THAT ARE NOT EACH OTHER ──────────────────────────────────────
 *
 *   anonymousSession   a browsing context. Not a person, not an account. It can hold a
 *                      basket and a chosen title; it can never hold an entitlement.
 *
 *   paymentInstrument  a card, a till, a phone number as the payer of a transaction.
 *                      It proves a PAYMENT happened. It proves nothing about who owns
 *                      any SOKONI account.
 *
 *   verifiedIdentity   a contact channel somebody has demonstrated control of, by
 *                      answering a challenge sent to it.
 *
 *   buyerAccount       a SOKONI account with the buyer role.
 *
 * Collapsing any two of these is how accounts get taken over. The dangerous collapse is
 * instrument → account: "this card/phone paid, therefore this is that person's account".
 * A phone number is typed into a browser by whoever is holding the browser.
 *
 * ── THE RULE THAT DOES THE WORK ──────────────────────────────────────────────
 * A contact that MATCHES an existing account does not grant access to it. It requires
 * authentication. Silently binding a purchase to an account because someone typed its
 * phone number would let anyone buy their way into somebody else's library, order
 * history and saved addresses.
 *
 * A contact that matches NOTHING may, once verified, found a new account.
 */

/* ── WHAT A THING IS ─────────────────────────────────────────────────────────── */
const KIND = Object.freeze({
  ANONYMOUS_SESSION: 'anonymousSession',
  PAYMENT_INSTRUMENT: 'paymentInstrument',
  VERIFIED_IDENTITY: 'verifiedIdentity',
  BUYER_ACCOUNT: 'buyerAccount',
});

/* ── WHAT MAY NEVER BE AN IDENTITY ───────────────────────────────────────────
   Card data identifies an INSTRUMENT. Treating it as an account key would mean two
   people sharing a family card share an account, and that a stolen card grants a
   stranger somebody's purchase history.
 *
 * SOKONI also never stores it: these fields must not reach a document, a log or an
 * identity lookup. The set is asserted against, not merely documented. */
const NEVER_IDENTITY = Object.freeze([
  'pan', 'cardNumber', 'card_number', 'cardNo', 'ccnum',
  'cvv', 'cvc', 'cvv2', 'securityCode',
  'expiry', 'expMonth', 'expYear', 'cardExpiry',
  'track1', 'track2', 'cardholderData',
]);

/* ── WHAT IDENTIFIES A PERSON ────────────────────────────────────────────────
   Only channels a challenge can be delivered to, because only those can be verified. */
const CONTACT = Object.freeze({ PHONE: 'phone', EMAIL: 'email' });

/* ── THE OUTCOMES ────────────────────────────────────────────────────────────── */
const PLAN = Object.freeze({
  /* The caller is already signed in as the account that owns this contact. */
  CONTINUE_AS_BUYER: 'CONTINUE_AS_BUYER',
  /* The contact belongs to an existing account and the caller has not proved they are
     it. NOT a refusal to sell — a requirement to sign in first. */
  AUTHENTICATE_EXISTING: 'AUTHENTICATE_EXISTING',
  /* Nothing matches. Once the contact is verified, an account may be founded. */
  VERIFY_THEN_CREATE: 'VERIFY_THEN_CREATE',
  /* The contact is verified and unclaimed. Create. */
  CREATE_BUYER: 'CREATE_BUYER',
});

function refuse(reason, detail) {
  return { ok: false, reason, detail: detail == null ? null : detail };
}
function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/* ── 1. NOTHING FROM THE INSTRUMENT MAY BE USED AS IDENTITY ──────────────────
   Checked on the whole request, at every depth, before anything else happens. A field
   that must never be stored must never be READ either — a lookup by card number is a
   lookup that has already handled a card number. */
function assertNoInstrumentAsIdentity(input) {
  const found = [];
  (function walk(v, depth) {
    if (depth > 6 || !isPlainObject(v)) return;
    Object.keys(v).forEach((k) => {
      const key = String(k);
      if (NEVER_IDENTITY.some((bad) => key.toLowerCase() === bad.toLowerCase())) found.push(key);
      walk(v[k], depth + 1);
    });
  })(input, 0);

  if (found.length) {
    return refuse('INSTRUMENT_IS_NOT_IDENTITY', found.join(','));
  }
  return { ok: true };
}

/* ── 2. NORMALISING A CONTACT ────────────────────────────────────────────────
   Kenyan mobile numbers arrive in four shapes. Normalised to E.164 once, here, rather
   than at each caller — two spellings of one number are two accounts. */
function normalisePhone(raw) {
  const digits = String(raw == null ? '' : raw).replace(/[^\d+]/g, '');
  if (!digits) return null;
  let d = digits.replace(/^\+/, '');
  if (d.startsWith('0')) d = '254' + d.slice(1);
  else if (d.startsWith('7') || d.startsWith('1')) d = '254' + d;
  if (!/^254[17]\d{8}$/.test(d)) return null;
  return '+' + d;
}

function normaliseEmail(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s || s.length > 254) return null;
  /* Deliberately permissive on the local part and strict on shape: rejecting valid
     unusual addresses turns a buyer away at the till. */
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(s)) return null;
  return s;
}

/* ── 3. WHAT MUST BE COLLECTED, GIVEN HOW THEY ARE PAYING ────────────────────
 *
 * M-PESA carries a phone number as part of the payment itself, so that number is
 * already in play and can serve as the contact — once VERIFIED, which is a separate
 * step from having been typed in.
 *
 * A card carries no usable contact at all. The instrument tells SOKONI nothing about
 * how to reach the buyer, so a contact must be collected separately — which is exactly
 * the separation this module exists to keep.
 */
function requiredContactFor(method, opts) {
  const o = isPlainObject(opts) ? opts : {};
  const m = String(method || '').trim().toUpperCase();
  if (!m) return refuse('NO_METHOD');

  if (m === 'MPESA') {
    return {
      ok: true, method: m,
      required: [CONTACT.PHONE],
      optional: [CONTACT.EMAIL],
      why: 'The number that pays can also be the number we reach you on, once verified.',
    };
  }

  /* Every other provider method — card, bank, and anything else the account enables.
     Not enumerated: a method SOKONI enables tomorrow must not silently fall through to
     "no contact required". */
  return {
    ok: true, method: m,
    required: [CONTACT.PHONE],
    /* Email is required where the product's policy says so — a digital purchase with no
       physical delivery has no other way to send a receipt or a recovery link. */
    optional: o.requireEmail === true ? [] : [CONTACT.EMAIL],
    alsoRequired: o.requireEmail === true ? [CONTACT.EMAIL] : [],
    why: 'A card tells us nothing about how to reach you, so we ask separately.',
  };
}

/* ── 3b. WHERE THE PROOF COMES FROM, AND THEREFORE WHEN THE ACCOUNT IS MADE ──
 *
 * A phone number typed into a browser is typed by whoever is holding the browser. It is
 * a claim, not a proof. What turns it into a proof differs by method, and that decides
 * the ORDER of the whole flow.
 *
 *   M-PESA    The provider's own confirmation names the MSISDN that actually paid.
 *             Somebody who completed an M-PESA payment from a number controlled that
 *             number at that moment — a stronger proof than a code sent to it, because
 *             it cannot be forwarded or read over a shoulder. So the account is resolved
 *             or created AFTER confirmation, from the PROVIDER-CONFIRMED number, and the
 *             typed one is used only to address the payment request.
 *
 *   CARD /    The confirmation names no contact SOKONI can use. There is nothing to
 *   others    verify against afterwards, so the collected contact must be verified
 *             BEFORE the intent, by a challenge sent to it.
 *
 * This is why there is no single answer to "is the account created before or after
 * payment". It is created when the proof arrives, and the proof arrives at different
 * moments.
 */
const PROOF = Object.freeze({
  /* The provider tells us who paid, and that is the identity. */
  PROVIDER_CONFIRMED_PAYER: 'PROVIDER_CONFIRMED_PAYER',
  /* The provider tells us nothing about who paid; a challenge must. */
  CHALLENGE_BEFORE_INTENT: 'CHALLENGE_BEFORE_INTENT',
});

function identityProofFor(method) {
  const m = String(method || '').trim().toUpperCase();
  if (!m) return refuse('NO_METHOD');

  /* Methods whose settlement names the payer's own mobile number. Listed rather than
     inferred: a method that merely CONTAINS a phone field in some payload is not the
     same as one whose confirmation identifies the payer. */
  const PAYER_NAMED = ['MPESA', 'AIRTEL_MONEY', 'TKASH'];

  if (PAYER_NAMED.indexOf(m) > -1) {
    return { ok: true, method: m, proof: PROOF.PROVIDER_CONFIRMED_PAYER,
             accountCreatedAt: 'after_confirmation',
             why: 'the settlement names the number that paid' };
  }

  /* THE DEFAULT IS THE STRICTER ONE. A method nobody has classified must not fall
     through to "the provider will tell us who it was" — that is precisely the
     assumption that would let an unverified contact found an account. */
  return { ok: true, method: m, proof: PROOF.CHALLENGE_BEFORE_INTENT,
           accountCreatedAt: 'before_intent',
           why: 'the settlement names no contact we can reach' };
}

/**
 * The MSISDN that ACTUALLY PAID, taken from the provider's confirmation.
 *
 * Never from the request. The typed number addressed the payment; this one is what the
 * provider observed, and only this one may found or resolve an account.
 */
function payerFromConfirmation(payload) {
  const p = isPlainObject(payload) ? payload : {};
  const inv = isPlainObject(p.invoice) ? p.invoice : {};
  /* The shapes IntaSend uses across its payloads, in the order it uses them. */
  const raw = inv.account || inv.mpesa_reference || p.account || p.msisdn || p.phone_number || null;
  const phone = normalisePhone(raw);
  if (!phone) return refuse('NO_PAYER_IN_CONFIRMATION');
  return { ok: true, phone, source: 'provider_confirmation' };
}

/**
 * Does the number the provider confirmed match the one the buyer typed?
 *
 * A mismatch is NOT an error — somebody may legitimately pay from a different handset
 * than the one they gave as a contact. It matters because the PROVIDER'S number is the
 * one that proves identity, so the answer decides which number founds the account.
 */
function reconcilePayer(typed, confirmed) {
  const t = normalisePhone(typed);
  const c = normalisePhone(confirmed);
  if (!c) return refuse('NO_CONFIRMED_PAYER');
  return {
    ok: true,
    /* THE ONE THAT COUNTS. */
    identityPhone: c,
    typedPhone: t,
    matched: !!t && t === c,
    /* Said out loud so a caller cannot quietly prefer the typed one. */
    note: (!!t && t !== c)
      ? 'paid from a different number than the one given; the paying number is the identity'
      : null,
  };
}

/* ── 4. MAY A GUEST FINISH WITHOUT AN ACCOUNT? ───────────────────────────────
   Browsing: yes, always. Completing a purchase: no.

   A purchase with no account is a purchase with no owner — nobody to attach an
   entitlement to, nobody to refund, nobody to show it to tomorrow. */
function mayCompleteAnonymously() {
  return { ok: false, reason: 'ACCOUNT_REQUIRED_AT_PAYMENT',
           detail: 'A purchase needs an owner. Browsing does not.' };
}

/* ── 5. THE PLAN ─────────────────────────────────────────────────────────────
 *
 * Given who is calling and what the contact matches, what happens next.
 *
 * `existingUid` is the result of an authoritative lookup the CALLER performed
 * (Firebase Auth's phone→uid map, or the email index). This module does not read a
 * database; it decides what the lookup MEANS.
 */
function resolutionPlan(input) {
  const i = isPlainObject(input) ? input : {};

  const callerUid = typeof i.callerUid === 'string' ? i.callerUid.trim() : '';
  const callerIsAnonymous = i.callerIsAnonymous === true;
  const existingUid = typeof i.existingUid === 'string' ? i.existingUid.trim() : '';
  const verified = i.contactVerified === true;

  /* A signed-in, non-anonymous caller who owns the contact simply continues. */
  if (callerUid && !callerIsAnonymous && existingUid && callerUid === existingUid) {
    return { ok: true, plan: PLAN.CONTINUE_AS_BUYER, uid: callerUid, creates: false };
  }

  /* A signed-in caller whose contact belongs to SOMEBODY ELSE. Refused rather than
     quietly switched: paying with another person's phone number must not move the
     purchase onto their account. */
  if (callerUid && !callerIsAnonymous && existingUid && callerUid !== existingUid) {
    return refuse('CONTACT_BELONGS_TO_ANOTHER_ACCOUNT',
      'That contact is registered to a different SOKONI account.');
  }

  /* THE TAKEOVER GUARD. The contact matches an existing account and the caller has not
     proved they are it. Verifying the contact is NOT enough on its own here, because a
     challenge sent to a number proves control of the number today — and an account may
     have been created by someone who has since lost it, or the number may have been
     recycled. Reaching an existing account is an authentication, not a purchase step. */
  if (existingUid) {
    return { ok: true, plan: PLAN.AUTHENTICATE_EXISTING, uid: existingUid, creates: false,
             detail: 'This contact already has a SOKONI account. Sign in to use it.' };
  }

  /* Nothing matches. An account may be founded — but only once the contact has actually
     been verified. An unverified contact founds an account nobody can recover. */
  if (!verified) {
    return { ok: true, plan: PLAN.VERIFY_THEN_CREATE, uid: null, creates: false };
  }

  return { ok: true, plan: PLAN.CREATE_BUYER, uid: null, creates: true,
           anonymousUpgrade: callerIsAnonymous && !!callerUid };
}

/* ── 6. WHAT A NEW BUYER RECORD MAY CONTAIN ──────────────────────────────────
   Built from VERIFIED contact only. Never from the instrument, and never from whatever
   else the request happened to carry. */
function buyerProfileFrom(input) {
  const i = isPlainObject(input) ? input : {};

  const guard = assertNoInstrumentAsIdentity(i);
  if (!guard.ok) return guard;

  const phone = normalisePhone(i.phone);
  const email = normaliseEmail(i.email);
  if (!phone && !email) return refuse('NO_VERIFIED_CONTACT');
  if (i.contactVerified !== true) return refuse('CONTACT_NOT_VERIFIED');

  const name = String(i.name == null ? '' : i.name).trim().slice(0, 80) || null;

  return {
    ok: true,
    profile: {
      phoneNumber: phone,
      email: email,
      displayName: name,
      /* The role this conversion grants, and the only one. Paying for something does
         not make anybody a seller, a rider or an administrator. */
      role: 'buyer',
      createdVia: 'payment_conversion',
      /* WHICH channel was actually proved, so a later reader is never left guessing
         which of the two was verified. */
      verifiedChannel: i.verifiedChannel === CONTACT.EMAIL ? CONTACT.EMAIL : CONTACT.PHONE,
    },
  };
}

/* ── 7. WHAT THE SESSION MAY CARRY ───────────────────────────────────────────
   An anonymous session holds a selection. It never holds an entitlement, a balance or a
   role — those belong to an account, and the session is not one. */
const SESSION_MAY_NOT_HOLD = Object.freeze([
  'entitlement', 'entitlements', 'balance', 'balanceMinor', 'role', 'roles',
  'claims', 'walletId', 'businessId',
]);

function assertSessionScope(session) {
  const s = isPlainObject(session) ? session : {};
  const bad = SESSION_MAY_NOT_HOLD.filter((k) => Object.prototype.hasOwnProperty.call(s, k));
  if (bad.length) return refuse('SESSION_OVERREACH', bad.join(','));
  return { ok: true };
}

module.exports = {
  KIND, NEVER_IDENTITY, CONTACT, PLAN, SESSION_MAY_NOT_HOLD,
  PROOF, identityProofFor, payerFromConfirmation, reconcilePayer,
  assertNoInstrumentAsIdentity, normalisePhone, normaliseEmail,
  requiredContactFor, mayCompleteAnonymously, resolutionPlan,
  buyerProfileFrom, assertSessionScope,
};
