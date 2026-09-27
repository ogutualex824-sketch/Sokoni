'use strict';
/**
 * SOKONI — Entertainment Hub › Integrations: STATUS and ROUTING only.
 * ============================================================================================
 * The Entertainment Hub owns the experience; it does NOT own integration configuration. Every card
 * here is a READ of the canonical authorities, and every "View integrations" link routes to the
 * canonical page that owns the integration:
 *
 *   canonical inventory      sokoni-integration-catalogue.js (entries tagged hubs:['entertainment'])
 *   canonical console        sokoni-integrations.js, mounted in AdminOS › Integrations
 *                            (admin-os.html?hub=entertainment&integration=<id>#integrations)
 *   payment capability       functions/shared/payment-capability.js + config/intasendCapability
 *   organizer eTIMS          etims-seller.html → etimsRegisterSeller / etimsGetProfile (caller-scoped)
 *   fiscal records           functions/event-fiscal.js
 *
 * States (explicit — code existing is NEVER "live"):
 *   UNKNOWN · CONFIGURED · VERIFIED · LIVE_AND_PROVEN · FAILED · DISABLED · NOT_APPLICABLE
 * A payment method is LIVE_AND_PROVEN only with a recorded evidence entry (Super Admin, AdminOS).
 *
 * SECURITY. entIntegrationStatus reads ONLY the caller's own records (a uid in the request is
 * ignored). No taxpayer secret, device serial, credential or provider response is ever returned —
 * the organizer's KRA PIN is shown masked. Admins read any organizer through AdminOS.
 */
const { HttpsError } = require('firebase-functions/v2/https');
const { getFirestore } = require('firebase-admin/firestore');
const AC = require('./admin-claim');
const PCAP = require('./shared/payment-capability');

const _db = () => getFirestore();
const fail = (code, msg) => { throw new HttpsError(code, msg); };

const STATE = Object.freeze({
  UNKNOWN: 'UNKNOWN', CONFIGURED: 'CONFIGURED', VERIFIED: 'VERIFIED', LIVE_AND_PROVEN: 'LIVE_AND_PROVEN',
  FAILED: 'FAILED', DISABLED: 'DISABLED', NOT_APPLICABLE: 'NOT_APPLICABLE',
});
const ADMIN = (integration) => `/admin-os.html?hub=entertainment${integration ? '&integration=' + integration : ''}#integrations`;

/* The ONE Entertainment integration mapping. Identity + routing only; status is computed below. */
const CARDS = Object.freeze([
  { id: 'intasend', label: 'IntaSend payments', category: 'payments', catalogueIds: ['intasend-collections', 'intasend-webhook', 'intasend-payouts'],
    organizerRoute: null, organizerNote: 'Payments are run by SOKONI — organizers and creators have nothing to configure.', adminRoute: ADMIN('intasend-collections') },
  { id: 'kra_etims', label: 'KRA / eTIMS', category: 'fiscal', catalogueIds: ['etims'],
    organizerRoute: '/etims-seller.html', organizerNote: 'Your own KRA eTIMS registration — managed on the eTIMS page.', adminRoute: ADMIN('etims') },
  { id: 'sokoni_connect', label: 'SOKONI Connect', category: 'communications', catalogueIds: [],
    organizerRoute: null, organizerNote: 'In-app messaging and calls for Entertainment are not enabled yet.', adminRoute: '/admin-os.html#comms' },
  { id: 'creator_streaming', label: 'Creator / Streaming', category: 'content', catalogueIds: [],
    organizerRoute: '/creator-studio.html', organizerNote: 'Your creator account and verification.', adminRoute: '/admin-os.html#creator' },
  { id: 'events', label: 'Events', category: 'events', catalogueIds: [],
    organizerRoute: '/event-manager.html', organizerNote: 'Ticketing depends on payments and (where you are registered) KRA eTIMS.', adminRoute: '/admin-os.html#entertainment' },
]);

const maskPin = (p) => { const s = String(p || ''); return s.length < 6 ? '***' : s.slice(0, 3) + '*'.repeat(s.length - 5) + s.slice(-2); };
const CAP_TO_STATE = { LIVE_AND_PROVEN: STATE.LIVE_AND_PROVEN, COMMITTED_BUT_UNPROVEN: STATE.CONFIGURED, PRESENT_BUT_DISABLED: STATE.DISABLED,
  BLOCKED: STATE.DISABLED, UNSUPPORTED: STATE.DISABLED, PROVIDER_CAPABILITY_UNKNOWN: STATE.UNKNOWN };

async function _payments() {
  const rec = await _db().collection('config').doc(PCAP.RECORD).get();
  const methods = PCAP.classify(rec.exists ? rec.data() : null).map((m) => {
    /* LIVE only with evidence; the status alone is not enough */
    const st = m.status === 'LIVE_AND_PROVEN' && !m.evidence ? STATE.CONFIGURED : (CAP_TO_STATE[m.status] || STATE.UNKNOWN);
    return { method: m.method, label: m.label, capability: m.status, state: st, evidence: m.evidence ? { type: m.evidence.type } : null,
      environment: m.evidence ? (m.evidence.type === 'live_probe_session' || m.evidence.type === 'completed_invoice' ? 'live' : 'provider_confirmation') : null,
      lastVerifiedMs: m.recordedAtMs || null };
  });
  const mpesa = methods.find((m) => m.method === 'M-PESA');
  const state = mpesa && mpesa.state === STATE.LIVE_AND_PROVEN ? STATE.LIVE_AND_PROVEN : STATE.CONFIGURED;
  return { state, reason: state === STATE.LIVE_AND_PROVEN ? null : 'M-PESA (STK) runs through IntaSend; no evidence entry is recorded in config/intasendCapability', methods };
}

async function _fiscal(uid) {
  const KRA = require('./etims-kra-adapter');
  const prof = await _db().collection('etimsProfiles').doc(uid).get();
  const p = prof.exists ? prof.data() : null;
  const registered = !!(p && p.status === 'active');
  const FISCAL = require('./event-fiscal');
  const recs = await _db().collection('eventFiscal').where('organizerUid', '==', uid).limit(300).get();
  const views = await FISCAL.viewsFor(recs.docs.map((d) => d.id));
  const counts = {}; const cn = {};
  Object.values(views).forEach((v) => { counts[v.fiscalStatus] = (counts[v.fiscalStatus] || 0) + 1; (v.creditNotes || []).forEach((c) => { cn[c.status] = (cn[c.status] || 0) + 1; }); });
  return {
    state: registered ? STATE.CONFIGURED : STATE.NOT_APPLICABLE,
    reason: registered ? 'KRA transmission is not certified (KRA spec + sandbox outstanding)' : 'ORGANIZER_NOT_REGISTERED',
    registration: registered ? { status: 'REGISTERED', kraPinMasked: maskPin(p.kraPin), businessName: p.businessName || null } : { status: 'NOT_REGISTERED' },
    invoiceCapability: { state: STATE.CONFIGURED, note: 'Invoices are created and queued; KRA protocol unverified (docs/ETIMS_CERTIFICATION_READINESS.md)' },
    creditNoteCapability: { state: KRA.SPEC_LOADED ? STATE.CONFIGURED : STATE.DISABLED, note: KRA.SPEC_LOADED ? null : 'KRA credit-note mapping missing: ' + KRA.MISSING_SPEC.join('; ') },
    sandbox: { state: STATE.UNKNOWN, note: 'eTIMS sandbox certification has not been run' },
    invoices: { total: recs.size, byStatus: counts, truncated: recs.size >= 300 }, creditNotes: cn,
  };
}

async function _creator(uid) {
  const c = await _db().collection('creators').doc(uid).get();
  if (!c.exists) return { state: STATE.NOT_APPLICABLE, reason: 'NOT_A_CREATOR' };
  const d = c.data();
  const map = { ACTIVE: STATE.VERIFIED, PENDING: STATE.CONFIGURED, SUSPENDED: STATE.DISABLED, REJECTED: STATE.FAILED };
  return { state: map[d.state] || STATE.UNKNOWN, creatorState: d.state || null, verification: d.verification || null };
}

async function _events(uid, token, payments, fiscal) {
  const approved = !!(token && token.event_organizer === true);
  return { state: approved ? STATE.VERIFIED : STATE.NOT_APPLICABLE, reason: approved ? null : 'NOT_AN_APPROVED_ORGANIZER',
    dependencies: { payments: payments.state, fiscal: fiscal.state, ticketing: approved ? STATE.VERIFIED : STATE.NOT_APPLICABLE } };
}

/** The Entertainment integration status for ONE account (never a secret). */
async function statusFor(uid, token) {
  const [payments, fiscal, creator] = await Promise.all([_payments(), _fiscal(uid), _creator(uid)]);
  const events = await _events(uid, token, payments, fiscal);
  const byId = {
    intasend: payments, kra_etims: fiscal, creator_streaming: creator, events,
    sokoni_connect: { state: STATE.DISABLED, reason: 'Connect / Comms are owner-frozen; no Entertainment anchor exists (docs/EVENTS_OPERATIONS.md §9)' },
  };
  return { cards: CARDS.map((c) => ({ ...c, status: byId[c.id] })) };
}

/* the caller's own status — any uid in the request is IGNORED */
async function entIntegrationStatus(req) {
  if (!req.auth || !req.auth.uid) fail('unauthenticated', 'Sign in required.');
  const out = await statusFor(req.auth.uid, req.auth.token || {});
  const admin = AC.isAdmin(req);
  /* the admin route is only shown to admins; organizers get their own canonical routes */
  out.cards = out.cards.map((c) => (admin ? c : { ...c, adminRoute: undefined }));
  return out;
}

/* AdminOS: any organizer's status (admin claim), for investigation */
async function adminStatus(req) {
  if (!req.auth || !req.auth.uid) fail('unauthenticated', 'Sign in required.');
  if (!AC.isAdmin(req)) fail('permission-denied', 'Admin only.');
  const uid = String((req.data || {}).uid || '');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) fail('invalid-argument', 'uid is invalid.');
  const u = await require('firebase-admin/auth').getAuth().getUser(uid).catch(() => null);
  return statusFor(uid, (u && u.customClaims) || {});
}

const _h = { entIntegrationStatus };
const _adminH = { eventAdminIntegrationStatus: adminStatus };
module.exports = { STATE, CARDS, maskPin, statusFor, _h, _adminH };
