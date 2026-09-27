/* test-entertainment-integrations.js — Entertainment Hub › Integrations: status + routing on the
 * CANONICAL integration authorities (owner decision 2026-09-27: status cards + canonical deep links;
 * no second configuration system). Transactional fake Firestore; no network.
 *
 * PROVES
 *   Honest states   a method is LIVE_AND_PROVEN only with recorded evidence (a "LIVE" without evidence
 *                   is CONFIGURED); unproven card / Google Pay / Apple Pay / PesaLink / bank are never
 *                   LIVE; eTIMS is CONFIGURED (not live), credit notes DISABLED (spec missing), sandbox
 *                   UNKNOWN; the canonical catalogue no longer claims eTIMS "live"
 *   Isolation       an organizer reads ONLY their own status (a uid in the request is ignored); organizer
 *                   B's KRA identity never appears; no taxpayer secret / device serial / full KRA PIN in
 *                   any response; admin-only investigation of another organizer
 *   Routing         every card routes to a canonical page (KRA → etims-seller.html; admins → AdminOS ›
 *                   Integrations with hub=entertainment); no route to admin.html / superadmin.html;
 *                   the Event / Creator / Hub links carry context; the canonical console reads the hub
 *                   filter from the URL and keeps it across tabs; the Entertainment view is a FILTER of
 *                   the canonical catalogue, not a second list
 *   No duplicate    the Entertainment page and module write nothing and hold no configuration form
 *   AdminOS         the money trace carries integration → provider → capability → organizer (masked)
 *
 *   node scripts/test-entertainment-integrations.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-ent-integrations';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;

const Path = require('path');
const fs = require('fs');
const ROOT = Path.resolve(__dirname, '..');
const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now(), strictReadOrder: true });
const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
const claims = { org1: { event_organizer: true }, org2: {} };
const authApi = { getUser: async (u) => ({ uid: u, customClaims: claims[u] || {} }), getUserByEmail: async () => { throw Object.assign(new Error('none'), { code: 'auth/user-not-found' }); } };
const resolveIn = (m) => require.resolve(m, { paths: [FN] });
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : resolveIn(m); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin/auth', { getAuth: () => authApi });
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp }), auth: () => authApi, storage: () => ({ bucket: () => ({}) }) });
stub('./notify', { notify: async () => ({ ok: true }) });
stub('./email-service', { EMAIL_SECRETS: [], sendEmail: async () => ({ ok: true }) });

const EI = require(Path.join(FN, 'entertainment-integrations.js'));
const OPS = require(Path.join(FN, 'event-ops.js'));
const EA = require(Path.join(FN, 'event-admin.js'));
const ES = require(Path.join(FN, 'event-settlement.js'));
ES.registerPurpose();
global.window = globalThis;
require(Path.join(ROOT, 'sokoni-integration-catalogue.js'));
const CAT = globalThis.SokoniIntegrationCatalogue;

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 170) + ']' : '')); ok ? pass++ : fail++; };
const who = (uid, token = {}) => ({ auth: { uid, token: { email: uid + '@x.co', email_verified: true, ...(claims[uid] || {}), ...token } }, rawRequest: { headers: {} } });
async function code(p) { try { await p; return null; } catch (e) { return e.code || e.message; } }
const card = (out, id) => out.cards.find((c) => c.id === id);
const read = (f) => fs.readFileSync(Path.join(ROOT, f), 'utf8');

(async () => {
  await db.doc('etimsProfiles/org1').set({ status: 'active', kraPin: 'P051234567T', businessName: 'Kamau Events', branchId: '00', vatStatus: 'registered',
    deviceSerialEnc: 'ENC-DEVICE-SERIAL-xyz', taxpayerSecretEnc: 'ENC-TAXPAYER-SECRET-abc', invoicePrefix: 'KEV' });
  await db.doc('etimsProfiles/org3').set({ status: 'active', kraPin: 'A123456789Z', businessName: 'Other Promoter', taxpayerSecretEnc: 'ENC-ORG3-SECRET' });
  await db.doc('config/intasendCapability').set({ methods: {
    'M-PESA': { status: 'LIVE_AND_PROVEN', evidence: { type: 'completed_invoice', reference: 'INV-2026-0001' }, note: 'A COMPLETE M-PESA invoice on the live account', recordedAtMs: 1790000000000 },
    'GOOGLE-PAY': { status: 'LIVE_AND_PROVEN', note: 'claimed live without evidence' },
    'CARD-PAYMENT': { status: 'COMMITTED_BUT_UNPROVEN', note: 'sdk wired, never probed' },
  } });
  await db.doc('creators/org1').set({ state: 'ACTIVE', verification: 'VERIFIED' });

  say('\n── honest states ──');
  const s1 = await OPS._h.entIntegrationStatus ? null : null; void s1;
  const dispatch = (uid, data, token) => OPS.eventOpsDispatch.run({ ...who(uid, token), data: { op: 'entIntegrationStatus', ...(data || {}) } });
  const o1 = await dispatch('org1');
  ck('the entry routes through the existing event-ops dispatcher (no new service)', Array.isArray(o1.cards) && o1.cards.length === 5);
  const pay = card(o1, 'intasend').status;
  const m = (id) => pay.methods.find((x) => x.method === id);
  ck('M-PESA LIVE_AND_PROVEN only because an evidence entry is recorded (type, environment, last verified)', m('M-PESA').state === 'LIVE_AND_PROVEN' && m('M-PESA').evidence.type === 'completed_invoice' && m('M-PESA').environment === 'live' && m('M-PESA').lastVerifiedMs === 1790000000000);
  ck('"LIVE" WITHOUT evidence is not live (Google Pay → CONFIGURED)', m('GOOGLE-PAY').state === 'CONFIGURED');
  ck('card committed-but-unproven → CONFIGURED; Apple Pay / PesaLink / bank with no record → UNKNOWN', m('CARD-PAYMENT').state === 'CONFIGURED' && ['APPLE-PAY', 'PESALINK', 'BANK-ACH'].every((x) => m(x).state === 'UNKNOWN'));
  ck('no payment method is LIVE except the evidenced one', pay.methods.filter((x) => x.state === 'LIVE_AND_PROVEN').map((x) => x.method).join() === 'M-PESA');
  await db.doc('config/intasendCapability').set({ methods: {} });
  ck('without M-PESA evidence the payments card is CONFIGURED, not live', card(await dispatch('org1'), 'intasend').status.state === 'CONFIGURED');
  await db.doc('config/intasendCapability').set({ methods: { 'M-PESA': { status: 'LIVE_AND_PROVEN', evidence: { type: 'completed_invoice', reference: 'INV-2026-0001' }, note: 'A COMPLETE M-PESA invoice on the live account', recordedAtMs: 1790000000000 } } });
  const k1 = card(o1, 'kra_etims').status;
  ck('KRA registered → CONFIGURED (never VERIFIED / LIVE: protocol uncertified)', k1.state === 'CONFIGURED' && k1.registration.status === 'REGISTERED');
  ck('invoice capability CONFIGURED; credit notes DISABLED naming the missing spec; sandbox UNKNOWN', k1.invoiceCapability.state === 'CONFIGURED' && k1.creditNoteCapability.state === 'DISABLED' && /cmcKey/.test(k1.creditNoteCapability.note) && k1.sandbox.state === 'UNKNOWN');
  ck('Connect → DISABLED with the reason (owner-frozen)', card(o1, 'sokoni_connect').status.state === 'DISABLED' && /frozen/.test(card(o1, 'sokoni_connect').status.reason));
  ck('creator ACTIVE → VERIFIED; approved organizer → Events VERIFIED with dependencies', card(o1, 'creator_streaming').status.state === 'VERIFIED' && card(o1, 'events').status.state === 'VERIFIED' && card(o1, 'events').status.dependencies.fiscal === 'CONFIGURED');
  const etimsEntry = CAT.integrations ? CAT.integrations.find((i) => i.id === 'etims') : (CAT.list ? CAT.list().find((i) => i.id === 'etims') : null);
  const catSrc = read('sokoni-integration-catalogue.js');
  ck('the canonical catalogue no longer claims eTIMS "live" (configured, citing the readiness report)', /id: 'etims'[\s\S]{0,900}status: 'configured'/.test(catSrc) && !/id: 'etims'[\s\S]{0,700}status: 'live'/.test(catSrc) && /ETIMS_CERTIFICATION_READINESS/.test(catSrc), etimsEntry && etimsEntry.status);

  say('\n── isolation / secrets ──');
  const forged = await dispatch('org1', { uid: 'org3' });
  ck('a uid in the request is IGNORED — organizer A still reads only their own status', card(forged, 'kra_etims').status.registration.kraPinMasked === 'P05******7T' && !JSON.stringify(forged).includes('Other Promoter'));
  const all = JSON.stringify(o1) + JSON.stringify(forged);
  ck('no taxpayer secret, device serial or FULL KRA PIN anywhere in the response', !/ENC-|taxpayerSecret|deviceSerial/.test(all) && !all.includes('P051234567T') && !all.includes('A123456789Z'));
  const o2 = await dispatch('org2');
  ck('an unregistered organizer → KRA NOT_APPLICABLE (ORGANIZER_NOT_REGISTERED); Events NOT_APPLICABLE', card(o2, 'kra_etims').status.state === 'NOT_APPLICABLE' && card(o2, 'kra_etims').status.reason === 'ORGANIZER_NOT_REGISTERED' && card(o2, 'events').status.state === 'NOT_APPLICABLE');
  ck('signed-out refused', (await code(OPS.eventOpsDispatch.run({ auth: null, rawRequest: { headers: {} }, data: { op: 'entIntegrationStatus' } }))) === 'unauthenticated');
  ck('an organizer cannot use the admin read', (await code(EI._adminH.eventAdminIntegrationStatus({ ...who('org1'), data: { uid: 'org3' } }))) === 'permission-denied');
  const adm = await EI._adminH.eventAdminIntegrationStatus({ ...who('admin1', { isAdmin: true }), data: { uid: 'org3' } });
  ck('an admin investigates another organizer — still masked, still no secret', card(adm, 'kra_etims').status.registration.kraPinMasked === 'A12******9Z' && !/ENC-|taxpayerSecret/.test(JSON.stringify(adm)));
  ck('the admin read is merged into adminOsDispatch', /entInt\._adminH/.test(read('functions/admin-os-dispatch.js')));

  say('\n── routing (canonical pages only) ──');
  ck('organizers see NO admin route; admins do', o1.cards.every((c) => c.adminRoute === undefined) && (await dispatch('admin1', {}, { isAdmin: true })).cards.every((c) => /^\/admin-os\.html/.test(c.adminRoute)));
  ck('KRA routes to the organizer\'s canonical eTIMS page', card(o1, 'kra_etims').organizerRoute === '/etims-seller.html');
  ck('admin routes open AdminOS › Integrations filtered to Entertainment', EI.CARDS.find((c) => c.id === 'kra_etims').adminRoute === '/admin-os.html?hub=entertainment&integration=etims#integrations');
  ck('no route to admin.html / superadmin.html / super-admin.html', !EI.CARDS.some((c) => /\/(admin|superadmin|super-admin)\.html/.test(String(c.adminRoute) + String(c.organizerRoute))));
  const hubIds = CAT.forHub('entertainment').map((i) => i.id).sort().join();
  ck('the Entertainment view is a FILTER of the canonical catalogue', hubIds === 'etims,intasend-collections,intasend-payouts,intasend-webhook', hubIds);
  ck('every card\'s catalogue ids exist in the canonical catalogue', EI.CARDS.every((c) => c.catalogueIds.every((id) => CAT.forHub('entertainment').some((i) => i.id === id))));
  const con = read('sokoni-integrations.js');
  ck('the canonical console reads hub + integration from the URL and filters the catalogue by hub', /_qs\.get\('hub'\)/.test(con) && /_qs\.get\('integration'\)/.test(con) && /\(i\.hubs \|\| \[\]\)\.indexOf\(_filter\.hub\) === -1/.test(con));
  ck('…and keeps the hub context across tab changes', /hub: _filter\.hub \}/.test(con));
  ck('Event Manager links to the entry with context', /href="\/entertainment-integrations\.html\?context=events"/.test(read('event-manager.html')));
  ck('Event finance links payment + fiscal integrations with context', /context=events&amp;integration=intasend/.test(read('sokoni-event-ops.js')) && /context=events&amp;integration=kra_etims/.test(read('sokoni-event-ops.js')));
  ck('Creator Studio links payment + fiscal integrations with context', /context=creator&amp;integration=intasend/.test(read('creator-studio.html')) && /context=creator&amp;integration=kra_etims/.test(read('creator-studio.html')));
  ck('the Entertainment Hub has ONE Integrations entry (links, not comments)', (read('entertainment.html').replace(/<!--[\s\S]*?-->/g, '').match(/href="\/entertainment-integrations\.html/g) || []).length === 1);

  say('\n── no duplicate configuration system ──');
  const page = read('entertainment-integrations.html');
  ck('the Entertainment page has no form / input / write call — status and links only', !/<form|<input|<select|<textarea|\.set\(|\.update\(|\.add\(|setDoc|updateDoc/.test(page));
  const modSrc = read('functions/entertainment-integrations.js').replace(/\/\*[\s\S]*?\*\//g, '');
  ck('the status module writes nothing', !/\.set\(|\.update\(|\.add\(|\.delete\(|\.create\(/.test(modSrc));
  ck('the page self-updates (shared-header → sw-register)', /shared-header\.js/.test(page));
  ck('no new integration console / catalogue file was added', !fs.readdirSync(ROOT).some((f) => /integration/i.test(f) && !['sokoni-integration-catalogue.js', 'sokoni-integration-governance.js', 'sokoni-integrations.js', 'entertainment-integrations.html'].includes(f)));

  say('\n── AdminOS trace ──');
  await db.doc('events/evT').set({ eventId: 'evT', title: 'Show', organizerUid: 'org1', status: 'live', startDate: new Date(Date.now() + 72 * 3600e3).toISOString() });
  await db.doc('eventOrders/ORDINT1').set({ orderId: 'ORDINT1', eventId: 'evT', buyerUid: 'b1', paymentRef: 'ORDINT1', quantity: 1, totalAmount: 1000, status: 'paid' });
  const tr = await EA._adminH.eventAdminTrace({ ...who('admin1', { isAdmin: true }), data: { orderId: 'ORDINT1' } });
  const ig = tr.stages.find((x) => x.stage === 'integration');
  ck('trace: integration → provider → capability → organizer (masked, no secret)', ig && ig.record.organizerUid === 'org1' && ig.record.kraRegistration.kraPinMasked === 'P05******7T' && ig.record.creditNoteCapability === 'DISABLED' && ig.record.paymentState === 'LIVE_AND_PROVEN' && !/ENC-|taxpayerSecret/.test(JSON.stringify(ig)));
  ck('stage order keeps the states separate', tr.stages.map((x) => x.stage).slice(0, 6).join('>') === 'event>integration>tickets>sale>payment>fiscal');

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
