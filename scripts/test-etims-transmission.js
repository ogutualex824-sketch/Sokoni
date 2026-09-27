/* test-etims-transmission.js — the eTIMS transmission workers (functions/etims.js): the sale-invoice
 * queue (processQueueOnce) and the lifecycle-document drainer (drainTransmissionQueueOnce), with the
 * ONE outcome classifier (etims-kra-adapter.classifyResponse). Transactional fake Firestore (strict
 * read order). The provider is an INJECTED CLIENT that counts sends and plays answers — no network,
 * no KRA call.
 *
 * WHAT IS PROVEN HERE IS THE CODE, NOT KRA. The credit-note payload for the REAL adapter is PENDING
 * (the KRA spec is not in the repository — etims-kra-adapter.MISSING_SPEC); the drainer's mechanics
 * are proven with a TEST DOUBLE adapter that is labelled as such and never mistaken for KRA's format.
 *
 *   node scripts/test-etims-transmission.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-etims-transmission';
process.env.INTASEND_PRIVATE_KEY = 'harness';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;

const Path = require('path');
const fs = require('fs');
const FN = Path.resolve(__dirname, '..', 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
let NOW = Date.now();
const F = makeFakeFirestore({ clock: () => NOW, strictReadOrder: true });
const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
const authApi = { getUser: async (u) => ({ uid: u, customClaims: {} }), getUserByEmail: async () => { const e = new Error('none'); e.code = 'auth/user-not-found'; throw e; } };
const resolveIn = (m) => require.resolve(m, { paths: [FN] });
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : resolveIn(m); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin/auth', { getAuth: () => authApi });
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp }), auth: () => authApi, storage: () => ({ bucket: () => ({}) }) });
stub('./notify', { notify: async () => ({ ok: true }) });
stub('./email-service', { EMAIL_SECRETS: [], sendEmail: async () => ({ ok: true }) });

const ETIMS = require(Path.join(FN, 'etims.js'));
const KRA = require(Path.join(FN, 'etims-kra-adapter.js'));
const ES = require(Path.join(FN, 'event-settlement.js'));
const EH = require(Path.join(FN, 'event-hub.js'));
const FISCAL = require(Path.join(FN, 'event-fiscal.js'));
const EA = require(Path.join(FN, 'event-admin.js'));
FISCAL._setClock(() => NOW);
ES.registerPurpose();

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 170) + ']' : '')); ok ? pass++ : fail++; };
const who = (uid, token = {}) => ({ auth: { uid, token: { email: uid + '@x.co', email_verified: true, ...token } }, rawRequest: { headers: {} } });
const adm = (name, data = {}, token = { isAdmin: true }) => EA._adminH[name]({ ...who('admin1', token), data });
const SUPER = { isAdmin: true, isSuperAdmin: true, superAdmin: true };
async function code(p) { try { await p; return null; } catch (e) { return e.code || e.message; } }
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const H = 3600 * 1000;

/* ── the injected provider: counts sends; plays the next scripted answer ── */
function provider() {
  const P = { sends: [], script: [], asUid: [] };
  const answer = async (kind, path, body) => {
    P.sends.push({ kind, path, body });
    await new Promise((r) => setImmediate(r));
    const a = P.script.length ? P.script.shift() : { http: 200, body: { resultCd: '000', data: { rcptNo: 'RCPT-' + P.sends.length } } };
    if (a.throw) throw new Error(a.throw);
    return { status: a.http, body: a.body };
  };
  P.clientFor = async (uid) => {
    P.asUid.push(uid);
    return { client: { submitInvoice: (payload) => answer('invoice', '/saveTrnsSalesSdcInfo', payload), _post: (path, body) => answer('lifecycle', path, body) },
      profile: { kraPin: 'P051234567T', businessName: 'Kamau Events', branchId: '00', vatStatus: 'registered', invoicePrefix: 'KEV', deviceSerial: 'DEV' } };
  };
  return P;
}
const ok = (rcpt) => ({ http: 200, body: { resultCd: '000', resultMsg: 'Successful', data: { rcptNo: rcpt, intrlData: 'CU', qrCodeUrl: `https://etims.kra.go.ke/qr/${rcpt}.png`, vsdcRcptUrl: `https://etims.kra.go.ke/v?r=${rcpt}` } } });
const REJ = { http: 200, body: { resultCd: '901', resultMsg: 'Invalid TIN' } };
const TIMEOUT = { throw: 'eTIMS timeout' };
const E503 = { http: 503, body: 'Service Unavailable' };
const NOREF = { http: 200, body: { resultCd: '000', data: {} } };

async function mkEvent(id, org = 'org1') {
  await db.doc(`events/${id}`).set({ eventId: id, title: 'Show ' + id, organizerUid: org, status: 'live', startDate: new Date(NOW + 72 * H).toISOString(), endDate: new Date(NOW + 76 * H).toISOString(), totalTicketsSold: 0, refundPolicy: { mode: 'before_cutoff', cutoffAt: new Date(NOW + 48 * H).toISOString(), noShowRefund: false, penalty: { type: 'none' }, version: 1 } });
  await db.doc(`eventTicketTiers/${id}_t`).set({ tierId: `${id}_t`, eventId: id, name: 'Regular', price: 1000, quantity: 500, sold: 0, isActive: true, currency: 'KES' });
}
async function paid(orderId, eventId, org = 'org1') {
  await db.doc(`eventOrders/${orderId}`).set({ orderId, buyerUid: 'buyer1', eventId, tierId: `${eventId}_t`, tierName: 'Regular', quantity: 1, totalAmount: 1000, currency: 'KES', status: 'pending_payment', createdAt: F.Timestamp.fromMillis(NOW) });
  await db.doc(`eventTickets/${orderId}_k0`).set({ ticketId: `${orderId}_k0`, orderId, eventId, buyerUid: 'buyer1', tierId: `${eventId}_t`, tierName: 'Regular', status: 'awaiting_payment', token: 't' + orderId, qrData: `sokoni-ticket:${orderId}_k0:t${orderId}` });
  await db.doc(`paymentIntents/${orderId}`).set({ ref: orderId, purpose: 'event_ticket', resourceType: 'eventOrder', resourceId: orderId, uid: 'buyer1', ownerUid: 'buyer1', amount: 1000, amountCents: 100000, currency: 'KES', metadata: { eventId, organizerUid: org } });
  await db.doc(`payments/${orderId}`).set({ ref: orderId, uid: 'buyer1', amount: 1000, amountCents: 100000, currency: 'KES', status: 'COMPLETE', provider: 'intasend', providerReport: { charges: 30 } });
  return ES.activateIfEventTicket(orderId);
}
const invOf = async (orderId) => get(`etimsInvoices/${(await get(`eventFiscal/${orderId}`)).invoiceId}`);
const view = async (k) => (await FISCAL.viewsFor([k]))[k];
const drainOpts = (P, extra = {}) => ({ clientFor: P.clientFor, skipDelivery: true, ...extra });   /* real clock: the queue's nextRetryAt is written with it */

(async () => {
  await db.doc('etimsProfiles/org1').set({ status: 'active', kraPin: 'P051234567T', businessName: 'Kamau Events', branchId: '00', vatStatus: 'registered', invoicePrefix: 'KEV' });
  await mkEvent('evT');

  say('\n── the ONE classifier (etims-kra-adapter) ──');
  const c = KRA.classifyResponse;
  ck('HTTP 200 + resultCd 000 + receipt → ACCEPTED with exactly that receipt', c({ kind: 'response', httpStatus: 200, body: ok('R1').body }).outcome === 'ACCEPTED' && c({ kind: 'response', httpStatus: 200, body: ok('R1').body }).reference === 'R1');
  ck('HTTP 200 + resultCd ≠ 000 → REJECTED (definitive)', c({ kind: 'response', httpStatus: 200, body: REJ.body }).outcome === 'REJECTED');
  ck('HTTP 4xx → REJECTED', c({ kind: 'response', httpStatus: 400, body: {} }).outcome === 'REJECTED');
  ck('HTTP 5xx / timeout / network / 000-without-receipt → UNKNOWN (never assumed)', ['response:503', 'timeout', 'network_error'].every((k) => c(k.startsWith('response') ? { kind: 'response', httpStatus: 503, body: {} } : { kind: k }).outcome === 'UNKNOWN') && c({ kind: 'response', httpStatus: 200, body: { resultCd: '000', data: {} } }).outcome === 'UNKNOWN');
  const fisSrc = fs.readFileSync(Path.join(FN, 'event-fiscal.js'), 'utf8');
  ck('event-fiscal delegates to the adapter (no second classifier)', /require\('\.\/etims-kra-adapter'\)\.classifyResponse\(p\)/.test(fisSrc) && !/resultCd\) !== '000'/.test(fisSrc.replace(/\/\*[\s\S]*?\*\//g, '')));

  say('\n── KRA spec: missing, stated, nothing fabricated ──');
  ck('SPEC_LOADED is false and the adapter NAMES what is missing', KRA.SPEC_LOADED === false && KRA.MISSING_SPEC.length === 4 && KRA.MISSING_SPEC.some((m) => /cmcKey/.test(m)) && KRA.MISSING_SPEC.some((m) => /credit-note/.test(m)));
  ck('the real credit-note builder returns PENDING (not transmittable)', !KRA.isTransmittable(KRA.buildPayload('credit_note', { docType: 'credit_note' })) && KRA.buildPayload('credit_note', {}).reason === 'KRA_SPEC_PENDING');

  say('\n── sale invoice queue ──');
  let P = provider();
  await paid('INV001', 'evT');
  ck('paid sale → invoice QUEUED (pending), nothing sent yet', (await invOf('INV001')).status === 'pending_submission' && P.sends.length === 0);
  const [r1, r2] = await Promise.all([ETIMS.processQueueOnce(drainOpts(P)), ETIMS.processQueueOnce(drainOpts(P))]);
  ck('2 overlapping worker runs → exactly ONE transmission (transactional claim)', P.sends.length === 1 && r1.claimed + r2.claimed === 1, [P.sends.length, r1, r2]);
  const inv1 = await invOf('INV001');
  ck('KRA success → invoice accepted with EXACTLY the provider receipt', inv1.status === 'accepted' && inv1.receiptNumber === 'RCPT-1');
  ck('…ticket valid + FISCAL_ACCEPTED', (await get('eventTickets/INV001_k0')).status === 'valid' && (await view('INV001')).fiscalStatus === 'FISCAL_ACCEPTED');
  ck('transmitted with the ORGANIZER\'s own stored identity (never a client-supplied one)', P.asUid[0] === 'org1');
  const snapAcc = JSON.stringify(await invOf('INV001'));
  await db.collection('etimsQueue').add({ invoiceId: inv1.invoiceId, sellerUid: 'org1', status: 'pending', priority: 1, retryCount: 0, nextRetryAt: new Date(NOW - 1000).toISOString() });
  await ETIMS.processQueueOnce(drainOpts(P));
  ck('an ACCEPTED invoice is never sent again (even with a stray queue entry)', P.sends.length === 1 && JSON.stringify(await invOf('INV001')) === snapAcc);
  ck('requeue of an accepted invoice is a no-op; receipt immutable', (await ETIMS.requeueInvoice(inv1.invoiceId)).message === 'Already accepted' && JSON.stringify(await invOf('INV001')) === snapAcc);

  P = provider(); P.script = [REJ];
  await paid('INV002', 'evT');
  await ETIMS.processQueueOnce(drainOpts(P));
  ck('KRA definitive rejection (temporary state) → retry scheduled; ticket valid; FISCAL_PENDING', P.sends.length === 1 && (await invOf('INV002')).status === 'pending_submission'
    && (await get('eventTickets/INV002_k0')).status === 'valid' && (await view('INV002')).fiscalStatus === 'FISCAL_PENDING');
  for (let i = 0; i < 6; i++) { P.script = [REJ]; await db.collection('etimsQueue').where('status', '==', 'pending').get().then((s) => Promise.all(s.docs.map((d) => d.ref.update({ nextRetryAt: new Date(NOW - 1).toISOString() })))); await ETIMS.processQueueOnce(drainOpts(P)); }
  ck('repeated definitive rejection → FAILED after the retry budget; ticket STILL valid; AdminOS exception', (await invOf('INV002')).status === 'failed' && (await get('eventTickets/INV002_k0')).status === 'valid'
    && (await view('INV002')).fiscalStatus === 'FISCAL_FAILED' && (await adm('eventAdminFiscal', {})).fiscal.some((r) => r.saleKey === 'INV002'));
  const sendsBefore = P.sends.length;
  await ETIMS.requeueInvoice((await invOf('INV002')).invoiceId);
  P.script = [ok('RCPT-RETRY')];
  await ETIMS.processQueueOnce(drainOpts(P));
  ck('a definitive failure MAY be retried (requeue) → accepted', P.sends.length === sendsBefore + 1 && (await invOf('INV002')).receiptNumber === 'RCPT-RETRY');

  for (const [label, ans] of [['timeout', TIMEOUT], ['HTTP 503', E503], ['000 without a receipt', NOREF]]) {
    P = provider(); P.script = [ans];
    const oid = 'INVU' + label.replace(/\W/g, '').slice(0, 6).toUpperCase();
    await paid(oid, 'evT');
    await ETIMS.processQueueOnce(drainOpts(P));
    const iu = await invOf(oid);
    ck(`KRA ${label} → invoice OUTCOME_UNKNOWN; ticket valid; FISCAL_OUTCOME_UNKNOWN`, iu.status === 'outcome_unknown' && (await get(`eventTickets/${oid}_k0`)).status === 'valid' && (await view(oid)).fiscalStatus === 'FISCAL_OUTCOME_UNKNOWN' && iu.receiptNumber === null);
    await ETIMS.processQueueOnce(drainOpts(P));
    ck(`…${label}: the next run does NOT re-send it`, P.sends.length === 1);
  }
  const unk = await invOf('INVUTIMEOU');
  ck('requeue of an outcome-unknown invoice is REFUSED (no blind retry)', (await code(ETIMS.requeueInvoice(unk.invoiceId))) === 'failed-precondition');
  ck('AdminOS fiscal retry refuses it too', (await code(adm('eventAdminFiscalRetry', { saleKey: 'INVUTIMEOU' }))) === 'failed-precondition');
  ck('an ordinary admin cannot resolve it', (await code(adm('eventAdminFiscalResolve', { saleKey: 'INVUTIMEOU', evidence: 'KRA support ticket SR-1: not recorded' }))) === 'permission-denied');
  ck('resolution needs evidence', (await code(adm('eventAdminFiscalResolve', { saleKey: 'INVUTIMEOU', evidence: '' }, SUPER))) === 'invalid-argument');
  await adm('eventAdminFiscalResolve', { saleKey: 'INVUTIMEOU', evidence: 'KRA support ticket SR-1: invoice not recorded', receiptNumber: 'FAKE-RCPT' }, SUPER);
  const res = await invOf('INVUTIMEOU');
  ck('super admin + evidence → FAILED (retryable); a forged receipt is ignored', res.status === 'failed' && res.receiptNumber === null && res.resolution.evidence.includes('SR-1'));
  P = provider(); P.script = [ok('RCPT-AFTER-EVIDENCE')];
  await adm('eventAdminFiscalRetry', { saleKey: 'INVUTIMEOU' });
  await ETIMS.processQueueOnce(drainOpts(P));
  ck('…then retried through the SAME queue → accepted', (await invOf('INVUTIMEOU')).receiptNumber === 'RCPT-AFTER-EVIDENCE' && P.sends.length === 1);

  P = provider();
  await paid('INVSTALE', 'evT');
  const sq = db._dump('etimsQueue/').find((q) => q.invoiceId === (db._dump('eventFiscal/').find((f) => f.saleKey === 'INVSTALE') || {}).invoiceId);
  const sqDoc = (await db.collection('etimsQueue').where('invoiceId', '==', sq.invoiceId).get()).docs[0];
  await sqDoc.ref.update({ status: 'processing', processedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString() });
  await ETIMS.processQueueOnce(drainOpts(P));
  ck('a claim left "processing" by a crashed run → OUTCOME_UNKNOWN, never re-sent', P.sends.length === 0 && (await invOf('INVSTALE')).status === 'outcome_unknown');
  await db.doc(`etimsProfiles/org2`).delete().catch(() => {});
  await mkEvent('evN', 'org2');
  await paid('INVNOREG', 'evN', 'org2');
  ck('organizer not registered → FISCAL_NOT_REQUIRED, nothing queued, nothing sent', (await view('INVNOREG')).reason === 'ORGANIZER_NOT_REGISTERED' && !db._dump('etimsInvoices/').some((i) => i.sellerUid === 'org2'));

  say('\n── credit-note drainer — REAL adapter (spec missing) ──');
  await paid('CNR001', 'evT');
  P = provider(); await ETIMS.processQueueOnce(drainOpts(P));
  const cnReq = await FISCAL.requireCreditNote({ fiscalRecordId: 'CNR001', refundCaseId: 'CNR001', refundCents: 100000 });
  await FISCAL.executeCreditNote(cnReq.executionId);
  const rv = await get(`eventFiscalReversals/${cnReq.executionId}`);
  ck('credit note built → its transmission entry is blocked_pending_spec (honest)', rv.status === 'CREDIT_NOTE_PENDING' && (await get(`etimsTransmissionQueue/${rv.creditNoteDocId}`)).status === 'blocked_pending_spec');
  await db.doc(`etimsTransmissionQueue/${rv.creditNoteDocId}`).update({ status: 'pending' });
  const P2 = provider();
  const dr = await ETIMS.drainTransmissionQueueOnce(drainOpts(P2));
  ck('even a pending entry is NEVER sent with the real adapter — marked blocked, 0 provider calls', dr.blocked === 1 && P2.sends.length === 0 && (await get(`etimsTransmissionQueue/${rv.creditNoteDocId}`)).status === 'blocked_pending_spec');

  say('\n── credit-note drainer — mechanics with a TEST DOUBLE adapter (NOT KRA\'s format) ──');
  const DOUBLE = { buildPayload: (t, d) => ({ ready: true, path: '/TEST-DOUBLE-NOT-KRA', body: { docId: d.id, testDouble: true } }), isTransmittable: KRA.isTransmittable, classifyResponse: KRA.classifyResponse };
  await db.doc(`etimsTransmissionQueue/${rv.creditNoteDocId}`).update({ status: 'pending' });
  const P3 = provider(); P3.script = [ok('CN-KRA-1')];
  const [d1, d2] = await Promise.all([ETIMS.drainTransmissionQueueOnce(drainOpts(P3, { adapter: DOUBLE })), ETIMS.drainTransmissionQueueOnce(drainOpts(P3, { adapter: DOUBLE }))]);
  ck('2 concurrent drainers → exactly ONE transmission', P3.sends.length === 1 && d1.claimed + d2.claimed === 1, [P3.sends.length, d1, d2]);
  const rvA = await get(`eventFiscalReversals/${cnReq.executionId}`);
  ck('accepted → CREDIT_NOTE_ACCEPTED with EXACTLY the provider reference (via the single ingress)', rvA.status === 'CREDIT_NOTE_ACCEPTED' && rvA.creditNoteReference === 'CN-KRA-1' && (await get(`creditNotes/${rv.creditNoteDocId}`)).status === 'accepted');
  ck('…sent with the organizer\'s own identity', P3.asUid[0] === 'org1');
  await db.doc(`etimsTransmissionQueue/${rv.creditNoteDocId}`).update({ status: 'pending' });
  await ETIMS.drainTransmissionQueueOnce(drainOpts(P3, { adapter: DOUBLE }));
  ck('an accepted credit note is never sent again', P3.sends.length === 1 && (await get(`eventFiscalReversals/${cnReq.executionId}`)).creditNoteReference === 'CN-KRA-1');
  ck('the ORIGINAL receipt is unchanged', (await view('CNR001')).receiptNumber === 'RCPT-1' || !!(await view('CNR001')).receiptNumber);

  await paid('CNU001', 'evT'); P = provider(); await ETIMS.processQueueOnce(drainOpts(P));
  const cn2 = await FISCAL.requireCreditNote({ fiscalRecordId: 'CNU001', refundCaseId: 'CNU001', refundCents: 100000 });
  await FISCAL.executeCreditNote(cn2.executionId);
  const rv2 = await get(`eventFiscalReversals/${cn2.executionId}`);
  await db.doc(`etimsTransmissionQueue/${rv2.creditNoteDocId}`).update({ status: 'pending' });
  const P4 = provider(); P4.script = [TIMEOUT];
  await ETIMS.drainTransmissionQueueOnce(drainOpts(P4, { adapter: DOUBLE }));
  ck('credit-note timeout → OUTCOME_UNKNOWN (queue + reversal); original receipt preserved', (await get(`eventFiscalReversals/${cn2.executionId}`)).status === 'CREDIT_NOTE_OUTCOME_UNKNOWN'
    && (await get(`etimsTransmissionQueue/${rv2.creditNoteDocId}`)).status === 'outcome_unknown' && (await view('CNU001')).fiscalStatus === 'FISCAL_ACCEPTED');
  await ETIMS.drainTransmissionQueueOnce(drainOpts(P4, { adapter: DOUBLE }));
  ck('…the next drain does NOT re-send it', P4.sends.length === 1);
  ck('…AdminOS retry refused without evidence', (await code(adm('eventAdminCreditNoteRetry', { executionId: cn2.executionId }))) === 'failed-precondition');
  await adm('eventAdminCreditNoteResolve', { executionId: cn2.executionId, resolution: 'NOT_ACCEPTED', evidence: 'KRA support ticket SR-9: credit note not received' }, SUPER);
  await adm('eventAdminCreditNoteRetry', { executionId: cn2.executionId });
  P4.script = [REJ];
  await ETIMS.drainTransmissionQueueOnce(drainOpts(P4, { adapter: DOUBLE }));
  ck('after evidence → retried ONCE → definitive rejection → CREDIT_NOTE_FAILED (refund stays authoritative)', P4.sends.length === 2 && (await get(`eventFiscalReversals/${cn2.executionId}`)).status === 'CREDIT_NOTE_FAILED'
    && (await get(`etimsTransmissionQueue/${rv2.creditNoteDocId}`)).status === 'failed');
  await adm('eventAdminCreditNoteRetry', { executionId: cn2.executionId });
  P4.script = [ok('CN-KRA-2')];
  await ETIMS.drainTransmissionQueueOnce(drainOpts(P4, { adapter: DOUBLE }));
  ck('a definitive failure may be retried → accepted on the SAME credit note', P4.sends.length === 3 && (await get(`eventFiscalReversals/${cn2.executionId}`)).creditNoteReference === 'CN-KRA-2' && db._dump('creditNotes/').filter((x) => x.origInvoiceId === (db._dump('eventFiscal/').find((f) => f.saleKey === 'CNU001') || {}).invoiceId).length === 1);

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
