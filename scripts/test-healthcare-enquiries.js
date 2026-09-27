/* test-healthcare-enquiries.js — a public question to a healthcare provider is an ENQUIRY (CHANGELOG 232; owner
 * decision 2026-09-28). Transactional fake Firestore + the REAL functions/ent-enquiries.js and messages.js. No network.
 *
 * PROVES
 *   classify     a provider is "healthcare" only when the SERVER classified it (providers/{uid}.healthcare), never by
 *                free text — a photographer / a self-described "Clinic" keeps the ordinary enquiry behaviour
 *   public       healthcare storefront info: healthcare topics only (INSURANCE in, EVENT_QUESTION / COLLABORATION out),
 *                a clinical-privacy notice, and NO call requests
 *   send         an enquiry opens the server-anchored conversation (exactly buyer + provider), tagged hub:'healthcare';
 *                an Entertainment-only topic is refused for a healthcare provider; the existing limits still apply
 *                (duplicate, per-buyer daily cap) — nothing new to bypass
 *   calls        a call request to a healthcare provider is refused (calls not authorized); a non-healthcare provider
 *                is unchanged
 *   push         a message in a healthcare enquiry pushes no text and no sender
 *   no client    createConversation cannot create an enquiry conversation (forged relationship)
 *
 *   node scripts/test-healthcare-enquiries.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-hc-enquiries';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;
const Path = require('path');
const FN = Path.join(Path.resolve(__dirname, '..'), 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now(), strictReadOrder: true });
const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.debug = () => {};
const PUSHES = [];
const resolveIn = (m) => require.resolve(m, { paths: [FN] });
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : resolveIn(m); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
const authApi = { getUser: async (u) => ({ uid: u, customClaims: {} }) };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin/auth', { getAuth: () => authApi });
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }),
  auth: () => authApi, storage: () => ({ bucket: () => ({}) }), messaging: () => ({ send: async (m) => { PUSHES.push(m); return 'ok'; } }) });
stub('./notify', { notify: async () => ({ ok: true }), TYPES: {} });
const EQ = require(Path.join(FN, 'ent-enquiries.js'));
const MSG = require(Path.join(FN, 'messages.js'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 170) + ']' : '')); ok ? pass++ : fail++; };
const who = (uid, token = {}) => ({ auth: uid ? { uid, token: Object.assign({ email_verified: true }, token) } : null, rawRequest: { headers: {} } });
const codeOf = async (p) => { try { await p; return null; } catch (e) { return (e.details && e.details.code) || e.code || e.message; } };
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const q = (uid, op, data, token) => EQ._h[op]({ ...who(uid, token), data: data || {} });
const WEEK = {}; ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].forEach((d) => { WEEK[d] = { closed: false, periods: [{ open: '00:00', close: '23:59' }], breaks: [] }; });

async function seed(uid, extra) {
  await db.doc(`providers/${uid}`).set(Object.assign({ name: uid, status: 'active', acceptsBookings: true }, extra || {}));
  await db.doc(`applications/app_${uid}`).set({ uid, status: 'approved', role: extra && extra.healthcare ? 'health' : 'provider', category: (extra && extra.category) || 'x' });
  await db.doc(`providerAvailability/${uid}`).set({ uid, modes: ['fixed_hours'], schedule: WEEK, appt: { enabled: true, durationMins: 60, maxDaysAhead: 90, minNoticeHours: 1, allowSameDay: true } });
  await db.doc(`users/${uid}`).set({ displayName: 'Name ' + uid, fcmToken: 'tok_' + uid });
  await db.doc(`entMessagingSettings/${uid}`).set({ enquiriesEnabled: true, whoCanMessage: 'ANYONE', callRequests: 'ENABLED' });
}

(async () => {
  for (const u of ['pat1', 'pat2', 'mallory']) await db.doc(`users/${u}`).set({ displayName: 'Name ' + u, fcmToken: 'tok_' + u });
  await seed('clinic1', { healthcare: { category: 'facility', source: 'application' } });
  await seed('photo1', { category: 'photographer' });
  await seed('fakeclinic', { category: 'Clinic' });   /* free-text claim, no server classification */

  say('\n── classification is the server\'s ──');
  const hp = await q(null, 'entMessagingPublic', { providerId: 'clinic1' });
  const pp = await q(null, 'entMessagingPublic', { providerId: 'photo1' });
  const fp = await q(null, 'entMessagingPublic', { providerId: 'fakeclinic' });
  ck('a server-classified healthcare provider is recognised', hp.hub === 'healthcare');
  ck('a photographer and a self-described "Clinic" are NOT treated as healthcare', pp.hub === null && fp.hub === null);

  say('\n── the public storefront ──');
  ck('healthcare topics only: INSURANCE in, EVENT_QUESTION / COLLABORATION out', hp.enquiryCategories.includes('INSURANCE') && !hp.enquiryCategories.includes('EVENT_QUESTION') && !hp.enquiryCategories.includes('COLLABORATION'), hp.enquiryCategories);
  ck('a clinical-privacy notice is returned', /do not share symptoms/i.test(hp.clinicalNotice || ''));
  ck('NO call requests for a healthcare provider (even with call requests ENABLED in its settings)', hp.callRequestsOpen === false);
  ck('(control) a non-healthcare provider keeps its call requests and topics', pp.callRequestsOpen === true && pp.enquiryCategories.includes('EVENT_QUESTION') && !pp.clinicalNotice);

  say('\n── sending ──');
  const e1 = await q('pat1', 'entEnquirySend', { providerId: 'clinic1', category: 'AVAILABILITY', question: 'Do you have appointments on Saturday morning?' });
  const conv = await get('conversations/' + e1.conversationId);
  ck('the enquiry opens the server-anchored conversation between exactly the patient and the provider', conv && conv.serverAnchored === true && conv.transactionType === 'ent_enquiry' && conv.participants.slice().sort().join() === 'clinic1,pat1');
  ck('…tagged hub:"healthcare" and PUBLIC mode (pre-relationship)', conv && conv.metadata.hub === 'healthcare' && conv.metadata.mode === 'PUBLIC');
  ck('an Entertainment-only topic is refused for a healthcare provider', await codeOf(q('pat2', 'entEnquirySend', { providerId: 'clinic1', category: 'EVENT_QUESTION', question: 'Can you perform at my event?' })) === 'invalid-argument');
  ck('the INSURANCE topic is accepted', !!(await q('pat2', 'entEnquirySend', { providerId: 'clinic1', category: 'INSURANCE', question: 'Do you accept SHA or private insurance?' })).enquiryId);
  ck('the existing duplicate suppression still applies', await codeOf(q('pat1', 'entEnquirySend', { providerId: 'clinic1', category: 'AVAILABILITY', question: 'Do you have appointments on Saturday morning?' })) === 'DUPLICATE');
  const pe = await q('pat1', 'entEnquirySend', { providerId: 'photo1', category: 'AVAILABILITY', question: 'Are you free for a wedding shoot?' }).catch((e) => ({ error: e.message }));
  ck('(control) a photographer enquiry is not tagged healthcare', !pe.error && ((await get('conversations/' + pe.conversationId)) || { metadata: {} }).metadata.hub === undefined, pe.error);

  say('\n── calls ──');
  ck('a call request to a healthcare provider is refused (calls not authorized)', await codeOf(q('pat1', 'entCallRequest', { context: { type: 'enquiry', id: e1.enquiryId } })) === 'CALLS_DISABLED');

  say('\n── notifications ──');
  PUSHES.length = 0;
  const sent = await MSG._h.sendMessage({ ...who('pat1'), data: { conversationId: e1.conversationId, type: 'text', text: 'Is there parking at the clinic?', clientMessageId: 'cm_hc_enq_0001' } });
  const m = (await db.collection('conversations/' + e1.conversationId + '/messages').get()).docs.find((d) => d.data().text === 'Is there parking at the clinic?');
  await MSG.onMessageCreated.run({ data: { data: () => m.data() }, params: { convId: e1.conversationId, msgId: m.id } });
  ck('a healthcare enquiry push carries neither the text nor the sender', !!sent && PUSHES.length >= 1 && PUSHES.every((p) => !/parking|Name pat1/.test(JSON.stringify(p.notification))), PUSHES.map((p) => p.notification));

  say('\n── no client-made relationship ──');
  ck('createConversation cannot create an enquiry conversation (forged relationship)', await codeOf(MSG._h.createConversation({ ...who('mallory'), data: { transactionType: 'ent_enquiry', transactionId: e1.enquiryId, participantUids: ['mallory', 'clinic1'] } })) === 'permission-denied');

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
