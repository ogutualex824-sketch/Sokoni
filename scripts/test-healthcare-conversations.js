/* test-healthcare-conversations.js — a patient and a provider talk privately only inside an authorized clinical
 * relationship (CHANGELOG 231). Transactional fake Firestore + the REAL functions/messages.js (createConversation,
 * sendMessage, onMessageCreated) and functions/healthcare-conversations.js. No network.
 *
 * PROVES
 *   opening     the conversation is opened by the SERVER only for a healthcare providerBookings row that is confirmed
 *               or completed AND paid; exactly the booking's two parties; no clinical content in its metadata;
 *               idempotent; pending / unpaid / non-healthcare bookings open nothing
 *   no client   createConversation refuses hc_booking whatever participantUids it is sent (forged relationship)
 *   sending     only the booking's parties send; a stranger / another booking's patient / another provider is refused;
 *               a completed consultation still allows follow-up
 *   limits      the 31st message in an hour is RATE_LIMITED; an identical message within 60 s is a DUPLICATE; a new
 *               thread cannot reset the counter (the conversation id is the booking); a deactivated account is refused
 *   ending      cancelled / refunded / declined / no-show → read-only with a system note; sending is refused even
 *               when the trigger never ran (re-read on every message)
 *   privacy     the push notification carries neither the message text nor the sender
 *
 *   node scripts/test-healthcare-conversations.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-hc-conversations';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
const Path = require('path');
const FN = Path.join(Path.resolve(__dirname, '..'), 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() });
const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
const PUSHES = [];
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : require.resolve(m, { paths: [FN] }); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }),
  auth: () => ({ getUser: async (u) => ({ uid: u, customClaims: {} }) }), messaging: () => ({ send: async (m) => { PUSHES.push(m); return 'ok'; } }), storage: () => ({ bucket: () => ({}) }) });
stub('./notify', { notify: async () => ({ ok: true }), TYPES: {} });
const M = require(Path.join(FN, 'messages.js'));
const HCV = require(Path.join(FN, 'healthcare-conversations.js'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 170) + ']' : '')); ok ? pass++ : fail++; };
const req = (uid, data, token) => ({ auth: uid ? { uid, token: Object.assign({}, token || {}) } : null, data: data || {}, rawRequest: { headers: {} } });
async function code(p) { try { await p; return null; } catch (e) { return (e.details && e.details.code) || e.code || e.message; } }
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const BK = async (id, over) => { const b = Object.assign({ providerId: 'docB', customerUid: 'pat1', commissionHub: 'healthcare', status: 'confirmed', paymentStatus: 'paid_held', serviceName: 'General consultation', notes: 'chest pain for 3 days' }, over || {}); await db.doc('providerBookings/' + id).set(b); return b; };
/* a refusal / throw inside the trigger is a RESULT the checks below observe (fail closed), never a crash */
const fire = async (id) => { try { return await HCV.onProviderBookingWritten(db, id, await get('providerBookings/' + id)); } catch (e) { return { error: e.message }; } };
const send = (uid, conv, text, token) => M._h.sendMessage(req(uid, { conversationId: conv, type: 'text', text, clientMessageId: 'cm_' + Math.random().toString(36).slice(2) }, token));

(async () => {
  for (const u of ['pat1', 'pat2', 'docB', 'docX', 'mallory']) await db.doc('users/' + u).set({ displayName: 'Name ' + u, fcmToken: 'tok_' + u });

  say('\n── the clinical-relationship predicate (shared with the records gate and the send gate) ──');
  const base = { commissionHub: 'healthcare', status: 'confirmed', paymentStatus: 'paid_held' };
  ck('predicate: healthcare + confirmed + paid → a clinical relationship', HCV.isClinicalBooking(base) && HCV.isClinicalBooking(Object.assign({}, base, { status: 'completed', paymentStatus: 'settled' })));
  ck('predicate: any other hub is NOT (provider / entertainment / missing)', !HCV.isClinicalBooking(Object.assign({}, base, { commissionHub: 'provider' })) && !HCV.isClinicalBooking(Object.assign({}, base, { commissionHub: 'entertainment' })) && !HCV.isClinicalBooking(Object.assign({}, base, { commissionHub: undefined })));
  ck('predicate: unpaid / refunded / pending / cancelled are NOT', ['pending', 'refunded'].every((p) => !HCV.isClinicalBooking(Object.assign({}, base, { paymentStatus: p }))) && ['pending', 'cancelled', 'declined', 'no_show'].every((s) => !HCV.isClinicalBooking(Object.assign({}, base, { status: s }))));
  ck('the records gate uses the SAME lists (one definition)', require(Path.join(FN, 'healthcare-conversations.js')).CLINICAL_PAID === HCV.CLINICAL_PAID && /require\('\.\/healthcare-conversations'\)/.test(require('fs').readFileSync(Path.join(FN, 'healthcare-hub.js'), 'utf8')));

  say('\n── opening ──');
  await BK('pend', { status: 'pending', paymentStatus: 'pending' }); await BK('unpaid', { paymentStatus: 'pending' });
  await BK('ent', { commissionHub: 'entertainment' }); await BK('gen', { commissionHub: 'provider' });
  for (const id of ['pend', 'unpaid', 'ent', 'gen']) { await fire(id); ck(`no conversation for a ${id} booking`, !(await get('conversations/hc_booking_' + id))); }
  await BK('b1');
  const r1 = await fire('b1'); const c1 = await get('conversations/hc_booking_b1');
  ck('a confirmed, paid healthcare booking opens hc_booking_{id}, server-anchored', r1.created && c1 && c1.serverAnchored === true && c1.transactionType === 'hc_booking');
  ck('…between EXACTLY the booking\'s patient and provider', c1 && c1.participants.slice().sort().join() === 'docB,pat1', c1 && c1.participants);
  ck('…with no clinical content, notes or amount in its metadata', c1 && !/chest pain|notes|price|amount/i.test(JSON.stringify(c1.metadata)) && c1.metadata.anchorType === 'providerBooking');
  await fire('b1');
  ck('re-firing is idempotent (one conversation)', (await db.collection('conversations').get()).docs.filter((d) => d.id === 'hc_booking_b1').length === 1);

  say('\n── no client-created relationship ──');
  ck('createConversation refuses hc_booking even with forged participantUids', await code(M._h.createConversation(req('mallory', { transactionType: 'hc_booking', transactionId: 'b1', participantUids: ['mallory', 'docB'] }))) === 'permission-denied');
  ck('…and naming a new booking id opens nothing either', await code(M._h.createConversation(req('mallory', { transactionType: 'hc_booking', transactionId: 'bNEW', participantUids: ['mallory', 'docB'] }))) === 'permission-denied' && !(await get('conversations/hc_booking_bNEW')));

  say('\n── sending ──');
  const s1 = await send('pat1', 'hc_booking_b1', 'Hello doctor');
  ck('the patient sends', !!s1 && (s1.messageId || s1.id || s1.ok !== false));
  ck('the provider replies', !!(await send('docB', 'hc_booking_b1', 'Hello, how can I help?')));
  ck('a stranger cannot send into it', await code(send('mallory', 'hc_booking_b1', 'hi')) === 'permission-denied');
  await BK('b2', { customerUid: 'pat2', providerId: 'docX' }); await fire('b2');
  ck('another booking\'s patient cannot send into it', await code(send('pat2', 'hc_booking_b1', 'hi')) === 'permission-denied');
  ck('another provider cannot send into it', await code(send('docX', 'hc_booking_b1', 'hi')) === 'permission-denied');
  ck('a deactivated account cannot send', await code(send('pat1', 'hc_booking_b1', 'still me', { deactivated: true })) === 'permission-denied');

  say('\n── limits ──');
  ck('an identical message within 60 s is refused as a DUPLICATE', await code(send('pat1', 'hc_booking_b1', 'Hello doctor')) === 'DUPLICATE');
  let n = 1; let limited = null;
  for (; n <= 40; n++) { const c = await code(send('pat1', 'hc_booking_b1', 'message number ' + n)); if (c) { limited = c; break; } }
  ck('the sender is RATE_LIMITED at the hourly ceiling (30, counting the earlier message)', limited === 'RATE_LIMITED' && n === HCV.LIMITS.perHour, { n, limited });
  ck('…the other party is not affected by the patient\'s limit', !!(await send('docB', 'hc_booking_b1', 'provider still ok')));
  const r1b = await fire('b1');
  ck('a "new thread" cannot reset the limit — the conversation IS the booking (same id, same counter)', r1b.created === false && await code(send('pat1', 'hc_booking_b1', 'after re-open')) === 'RATE_LIMITED');

  await BK('b4', { customerUid: 'pat2', providerId: 'docB' }); await fire('b4');
  await db.doc('providerBookings/b4').set({ providerId: 'docX' }, { merge: true });   /* the booking was reassigned */
  ck('a provider no longer on the booking (reassigned) cannot keep messaging the patient', await code(send('docB', 'hc_booking_b4', 'still here?')) === 'permission-denied');

  say('\n── follow-up after completion ──');
  await BK('b3', { status: 'completed', paymentStatus: 'settled', customerUid: 'pat2', providerId: 'docB' }); await fire('b3');
  ck('a completed, settled consultation still allows follow-up messages', !!(await send('pat2', 'hc_booking_b3', 'Follow-up question')));

  say('\n── the relationship ends ──');
  await db.doc('providerBookings/b2').set({ status: 'cancelled', paymentStatus: 'refunded' }, { merge: true }); await fire('b2');
  const c2 = await get('conversations/hc_booking_b2');
  ck('a cancelled / refunded booking makes the conversation read-only', c2 && c2.status === 'read_only');
  const sys2 = (await db.collection('conversations/hc_booking_b2/messages').get()).docs.map((d) => d.data()).filter((m) => m.type === 'system');
  ck('…with a system note saying so (no clinical content)', sys2.some((m) => /read-only/.test(m.text)) && !sys2.some((m) => /chest pain/i.test(m.text)), sys2.map((m) => m.text));
  ck('…and sending is refused', await code(send('pat2', 'hc_booking_b2', 'can I still write?')) === 'failed-precondition');
  await db.doc('providerBookings/b3').set({ paymentStatus: 'refunded' }, { merge: true });   /* the trigger never runs */
  ck('refunded WITHOUT the trigger: the send gate re-reads the booking and refuses (RELATIONSHIP_ENDED)', await code(send('pat2', 'hc_booking_b3', 'hello?')) === 'RELATIONSHIP_ENDED');
  ck('…and marks the conversation read-only itself', ((await get('conversations/hc_booking_b3')) || {}).status === 'read_only');
  for (const st of ['declined', 'no_show']) {
    await BK('e_' + st); await fire('e_' + st);
    await db.doc('providerBookings/e_' + st).set({ status: st }, { merge: true }); await fire('e_' + st);
    ck(`a ${st} booking ends the conversation (read-only)`, ((await get('conversations/hc_booking_e_' + st)) || {}).status === 'read_only');
  }

  say('\n── privacy of notifications ──');
  PUSHES.length = 0;
  const convSnap = await db.doc('conversations/hc_booking_b1').get();
  const msgs = await db.collection('conversations/hc_booking_b1/messages').get();
  const one = msgs.docs.find((d) => (d.data().text || '') === 'Hello doctor');
  await M.onMessageCreated.run({ data: { data: () => one.data() }, params: { convId: 'hc_booking_b1', msgId: one.id } });
  ck('the push for a consultation message carries neither the text nor the sender', PUSHES.length >= 1 && PUSHES.every((p) => !/Hello doctor|Name pat1/.test(JSON.stringify(p.notification)) && /appointment/.test(p.notification.body)), PUSHES.map((p) => p.notification));
  ck('(control) the conversation exists and the message was real', convSnap.exists && !!one);

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
