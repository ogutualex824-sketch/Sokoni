/* ══════════════════════════════════════════════════════════════════════════════════════
   POS REDEMPTION — the two callables, and nothing else.
   ══════════════════════════════════════════════════════════════════════════════════════
   These are THIN. Every rule they enforce lives in a module that was certified before this
   file existed, and is called rather than restated:

       pos-loyalty-redemption.js   what points are worth, and whether they may be spent
       pos-redemption-challenge.js the code, its binding, and who may confirm it
       rewards-rate.js             the one economic rule, normalised once

   A callable that re-implemented any of those would be a second authority with no
   certification behind it, and the first place the two would drift is the one nobody
   re-reads. So: no crypto here, no rate arithmetic here, no balance rules here.

   ── WHO MAY CONFIRM ──────────────────────────────────────────────────────────────────
   Confirmation REQUIRES an authenticated principal, and it is refused when that principal
   is the cashier who minted the challenge. Together those mean a redemption cannot be
   completed by someone merely holding the code — which is the whole point, since the code
   is displayed on the till and the cashier can always read it.

   It also means there is NO cashier-typed path. The customer enters the code, or scans the
   QR, in their OWN signed-in SOKONI session. That is stronger than treating the displayed
   code as a convenience factor: both routes end at the customer's own device, and the
   difference between them is only typing versus scanning.

   The cost is honest and worth stating: a walk-in with no SOKONI account cannot redeem at
   the till. Points redemption requires an account. The alternative — accepting an
   unauthenticated confirmation — would make "the customer confirmed" mean "somebody
   pressed a button", which is exactly the assertion this design refuses to make.
   ══════════════════════════════════════════════════════════════════════════════════════ */
'use strict';

const { HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

const CHAL   = require('./pos-redemption-challenge');
const LOYAL  = require('./pos-loyalty-redemption');
const RATES  = require('./rewards-rate');

const _db = () => admin.firestore();

function _uid(req) {
  const uid = req && req.auth && req.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  return uid;
}
function _san(v, n) { return String(v == null ? '' : v).trim().slice(0, n || 128); }

/* The signing key. Read at call time, and its ABSENCE is fatal rather than papered over —
   see the note in pos-redemption-challenge.js on why a constant fallback would leave a
   six-digit code brute-forceable from its stored hash. */
function _secret() {
  try {
    const { defineSecret } = require('firebase-functions/params');
    const s = defineSecret('SOKONI_HMAC_KEY');
    return s.value() || '';
  } catch (_) { return process.env.SOKONI_HMAC_KEY || ''; }
}

/* ── MINT ────────────────────────────────────────────────────────────────────
   The till asks for a redemption; the SERVER decides what it is worth and mints a
   challenge for exactly that. Nothing about the value comes from the request. */
async function posMintRedemptionChallenge(req) {
  const uid = _uid(req);
  const d = req.data || {};
  const merchantId = _san(d.merchantId, 64);
  const customerId = _san(d.customerId, 128);
  const saleKey    = _san(d.saleKey, 128);
  const pointsRequested = Math.floor(Number(d.pointsRequested) || 0);

  if (!merchantId) throw new HttpsError('invalid-argument', 'merchantId required.');
  if (!customerId) throw new HttpsError('invalid-argument', 'A customer is required to redeem points.');
  if (!saleKey)    throw new HttpsError('invalid-argument', 'saleKey required — the challenge binds to one sale.');
  if (!(pointsRequested > 0)) throw new HttpsError('invalid-argument', 'pointsRequested must be positive.');

  /* THE SAME SHOP GATE THE SALE USES. A challenge is a claim on a customer's balance, so
     it must not be mintable by someone who could not ring up the sale it settles. */
  const { assertShopAccess } = require('./shop-employees');
  await assertShopAccess(uid, merchantId);

  const db = _db();
  const [custSnap, cfgSnap] = await Promise.all([
    db.collection('posCustomers').doc(customerId).get(),
    RATES.configRef(db, merchantId).get(),
  ]);

  /* The redeemable base is the SERVER's, derived from the figures the till submitted for
     this sale and re-derived again when the sale itself runs. A challenge minted against
     an inflated base would still be refused at sale time, because checkSpendable compares
     against what the sale actually prices to. */
  const base = Math.max(0, Number(d.subtotal || 0) - Number(d.discountTotal || 0));

  const auth = LOYAL.authorize({
    custSnap, progSnap: cfgSnap, pointsRequested, redeemableBaseKES: base,
  });
  if (!auth.ok) {
    throw new HttpsError('failed-precondition',
      'Points cannot be redeemed: ' + (auth.reason || 'not authorised') + '.');
  }

  const secret = _secret();
  if (!secret) {
    throw new HttpsError('failed-precondition',
      'Redemption is unavailable: the signing key is not configured.');
  }

  const m = CHAL.mint({
    secret, merchantId, storeId: _san(d.storeId, 64) || null, customerId, saleKey,
    points: auth.approvedPoints, valueKES: auth.approvedKES,
    mintedBy: uid, now: Date.now(),
  });
  await db.collection(CHAL.COLLECTION).doc(m.id).set(m.doc);

  /* The code goes to the till for DISPLAY. The stored document holds only its hash. */
  return {
    challengeId: m.id,
    code:        m.code,
    points:      auth.approvedPoints,
    valueKES:    auth.approvedKES,
    pointValueKES: auth.pointValue,
    expiresAt:   m.doc.expiresAt,
    /* What the customer's device scans. Carries no secret of its own: possession of the
       QR is not authority — the confirming session still has to be authenticated and
       still has to not be the cashier. */
    qrPayload:   'sokoni://redeem/' + m.id,
  };
}

/* ── CONFIRM ─────────────────────────────────────────────────────────────────
   The customer, in their own signed-in session, authorises this specific redemption. */
async function posConfirmRedemptionChallenge(req) {
  const uid = _uid(req);
  const d = req.data || {};
  const challengeId = _san(d.challengeId, 128);
  const code        = _san(d.code, 16);

  if (!challengeId) throw new HttpsError('invalid-argument', 'challengeId required.');
  if (!code)        throw new HttpsError('invalid-argument', 'code required.');

  const secret = _secret();
  if (!secret) throw new HttpsError('failed-precondition', 'Redemption is unavailable: the signing key is not configured.');

  const db  = _db();
  const ref = db.collection(CHAL.COLLECTION).doc(challengeId);

  /* Confirmed inside a transaction so two devices racing the same challenge cannot both
     record a confirmation, and so the state read is the state written. */
  const out = await db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    const v = CHAL.checkConfirmable({ secret, snap, code, confirmedBy: uid, now: Date.now() });
    if (!v.ok) return { ok: false, reason: v.reason };

    const cur = snap.data() || {};
    /* Already confirmed by this same customer is idempotent, not an error — a double tap
       on a phone must not look like a failed redemption. Confirmed by someone ELSE is a
       refusal, because two principals cannot both be the customer. */
    if (cur.status === CHAL.STATUS.CONFIRMED) {
      if (String(cur.confirmedBy || '') === String(uid)) {
        return { ok: true, already: true, points: cur.points, valueKES: cur.valueKES };
      }
      return { ok: false, reason: CHAL.REASON.ALREADY_USED };
    }

    txn.update(ref, {
      status: CHAL.STATUS.CONFIRMED,
      confirmedAt: Date.now(),
      confirmedBy: uid,
      confirmMethod: _san(d.method, 16) || 'device',
    });
    return { ok: true, already: false, points: cur.points, valueKES: cur.valueKES };
  });

  if (!out.ok) {
    const code2 = out.reason === CHAL.REASON.SELF_CONFIRM ? 'permission-denied' : 'failed-precondition';
    throw new HttpsError(code2, 'This redemption could not be confirmed: ' + out.reason + '.');
  }
  return { confirmed: true, idempotent: !!out.already, points: out.points, valueKES: out.valueKES };
}

/* Registered through smartpos-dispatch, which is what index.js deploys. A handler absent
   from a dispatcher's registry is not reachable however complete it is. */
module.exports._h = {
  posMintRedemptionChallenge,
  posConfirmRedemptionChallenge,
};
