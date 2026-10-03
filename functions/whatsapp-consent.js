/* ============================================================================
   WHATSAPP CONSENT — the ONE writer of users/{uid}.whatsappOptIn (2026-10-03)
   ----------------------------------------------------------------------------
   Meta requires an opt-in before a business-initiated WhatsApp message. notify()'s
   WhatsApp channel (notify.js _whatsappChannel) refuses every send without it, and
   until now NOTHING wrote it — so no SOKONI message could ever reach WhatsApp.

   CONSENT IS TIED TO A NUMBER, not to an account. The record stores the number the
   person agreed for (whatsappOptInPhone, normalised 2547…/2541…). If the account's
   phoneNumber later changes, the gate in notify() refuses (NO_CONSENT): a new owner
   of the old number, or a new number, has agreed to nothing.

   WRITERS, and only these:
     • whatsappConsent callable — the signed-in person, for THEIR OWN account only
       (op 'get' | 'set'); the number is read from users/{uid}.phoneNumber on the
       server, never taken from the browser.
     • optOutByPhone() — the inbound webhook, when someone replies STOP to SOKONI's
       WhatsApp number. Opt-out never needs a sign-in.

   AUDIT: every change appends whatsappConsentEvents/{autoId} { uid, optIn, source,
   version, phoneMasked, at }. Admin SDK only; no firestore.rules entry, so every client
   is default-denied. An unchanged state writes nothing (no event spam on double taps).

   NO PAYMENT, NO MESSAGE, NO TEMPLATE here — consent only.
   ============================================================================ */
'use strict';

const { normalisePhone, maskPhone } = require('./whatsapp-sender');

const EVENTS = 'whatsappConsentEvents';
/* Bump when the wording shown to the person changes; the record says which wording they agreed to. */
const CONSENT_VERSION = 'wa-consent-2026-10-03';
const SOURCES = Object.freeze(['profile', 'whatsapp_stop']);
/* Replies Meta users conventionally send to stop business messages (English + Swahili). */
const STOP_WORDS = /^\s*(stop|unsubscribe|cancel|acha|sitisha)\s*[.!]?\s*$/i;

function isStopText (text) { return typeof text === 'string' && text.length <= 40 && STOP_WORDS.test(text); }

/** State as the person may see it: their own consent and a masked number — never another account. */
function view (u) {
  const d = u || {};
  const phone = normalisePhone(d.phoneNumber);
  const consented = normalisePhone(d.whatsappOptInPhone);
  const active = d.whatsappOptIn === true && !!phone && consented === phone;
  return {
    optIn: active,
    /* consent exists but for a different number than the account's current one */
    phoneChanged: d.whatsappOptIn === true && !!consented && consented !== phone,
    hasPhone: !!phone,
    phoneMasked: phone ? maskPhone(phone) : null,
    version: d.whatsappConsentVersion || null,
    currentVersion: CONSENT_VERSION,
  };
}

/* setConsent — transactional read-then-write so two taps cannot interleave into a state
   whose audit row disagrees with the user doc. Returns { changed, state } or throws
   { code } for the callable to translate. */
async function setConsent ({ uid, optIn, source }, deps) {
  const d = deps || {};
  if (!uid || typeof uid !== 'string') throw Object.assign(new Error('uid required'), { code: 'invalid-argument' });
  if (typeof optIn !== 'boolean') throw Object.assign(new Error('optIn must be boolean'), { code: 'invalid-argument' });
  if (!SOURCES.includes(source)) throw Object.assign(new Error('bad source'), { code: 'invalid-argument' });
  const fs = d.firestore;
  const now = d.serverTimestamp();
  return fs.runTransaction(async (tx) => {
    const ref = fs.collection('users').doc(uid);
    const snap = await tx.get(ref);
    if (!snap.exists) throw Object.assign(new Error('no account'), { code: 'not-found' });
    const u = snap.data() || {};
    const phone = normalisePhone(u.phoneNumber);
    if (optIn && !phone) throw Object.assign(new Error('NO_PHONE'), { code: 'failed-precondition' });
    const before = view(u);
    if (optIn && before.optIn && u.whatsappConsentVersion === CONSENT_VERSION) return { changed: false, state: before };
    if (!optIn && u.whatsappOptIn !== true) return { changed: false, state: before };
    const patch = optIn
      ? { whatsappOptIn: true, whatsappOptInPhone: phone, whatsappConsentAt: now, whatsappConsentSource: source, whatsappConsentVersion: CONSENT_VERSION }
      : { whatsappOptIn: false, whatsappOptInPhone: null, whatsappOptOutAt: now, whatsappConsentSource: source };
    tx.update(ref, patch);
    tx.set(fs.collection(EVENTS).doc(), {
      uid, optIn, source, version: CONSENT_VERSION,
      phoneMasked: phone ? maskPhone(phone) : null,  /* masked: the audit proves WHICH number without holding it */
      at: now,
    });
    return { changed: true, state: view(Object.assign({}, u, patch)) };
  });
}

/* Inbound STOP from a WhatsApp number: opt out EVERY account whose phoneNumber is that number.
   `from` is Meta's wa_id (digits, e.g. 2547…). Stored formats differ (+2547…, 07…), so the
   candidates are queried explicitly rather than guessed from one format. */
async function optOutByPhone (from, deps) {
  const d = deps || {};
  const n = normalisePhone(from);
  if (!n) return { matched: 0, changed: 0 };
  const forms = ['+' + n, n, '0' + n.slice(3)];
  const users = d.firestore.collection('users');
  const seen = new Set();
  for (const f of forms) {
    const q = await users.where('phoneNumber', '==', f).limit(10).get();
    q.forEach((doc) => seen.add(doc.id));
  }
  let changed = 0;
  for (const uid of seen) {
    try {
      const r = await setConsent({ uid, optIn: false, source: 'whatsapp_stop' }, d);
      if (r.changed) changed++;
    } catch (_) { /* one bad account must not stop the others from being opted out */ }
  }
  return { matched: seen.size, changed };
}

function adminDeps () {
  const admin = require('firebase-admin');
  return { firestore: admin.firestore(), serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp() };
}

/* ── THE CALLABLE ─────────────────────────────────────────────────────────── */
let whatsappConsent;
{
  const { onCall, HttpsError } = require('firebase-functions/v2/https');
  whatsappConsent = onCall({ region: 'us-central1', maxInstances: 20 }, async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');
    const data = request.data || {};
    const deps = adminDeps();
    if (data.op === 'get' || data.op == null) {
      const s = await deps.firestore.collection('users').doc(uid).get();
      return { ok: true, state: view(s.exists ? s.data() : null) };
    }
    if (data.op !== 'set') throw new HttpsError('invalid-argument', 'Unknown operation.');
    try {
      /* uid is ALWAYS the caller: there is no parameter that names another account. */
      const r = await setConsent({ uid, optIn: data.optIn, source: 'profile' }, deps);
      require('firebase-functions/logger').info('[whatsappConsent] set', { uid, optIn: data.optIn, changed: r.changed });
      return { ok: true, changed: r.changed, state: r.state };
    } catch (e) {
      if (e && e.message === 'NO_PHONE') throw new HttpsError('failed-precondition', 'Add your phone number to your profile first.');
      if (e && e.code === 'invalid-argument') throw new HttpsError('invalid-argument', 'Invalid request.');
      if (e && e.code === 'not-found') throw new HttpsError('not-found', 'Account not found.');
      require('firebase-functions/logger').error('[whatsappConsent] failed', { uid, error: (e && e.name) || 'Error' });
      throw new HttpsError('internal', 'Could not save your choice. Please try again.');
    }
  });
}

module.exports = { whatsappConsent, setConsent, optOutByPhone, view, isStopText, CONSENT_VERSION, EVENTS, adminDeps };
