/* test-legal-verification.js — the Legal Verification Authority (CHANGELOG 220): SOKONI admin verification
 * + LSK professional verification → ONE server-derived booking-eligibility predicate. Transactional fake
 * Firestore (strict read order) + the REAL modules (legal-verification, legal-hub, application-lifecycle,
 * ent-availability, booking-service, the migration) + the REAL AdminOS panel and Legal Hub in Chromium.
 * No network, no production, no LSK call.
 *
 * PROVES
 *   predicate     the full matrix: unapproved · admin approved/LSK pending · admin pending/LSK verified ·
 *                 both verified (the ONLY bookable state) · Inactive · Suspended · Unknown · Struck Off ·
 *                 Deceased · stale (practising year over) · forged combinations · provider not linked ·
 *                 quarantined — and P.105 / name / status normalisation
 *   intake        registerLegalProvider ignores injected verification/status/bookable; creates the ONE
 *                 AdminOS review item; a second registration is refused
 *   admin         only applicationDecide (canonical admin claim) decides; numeric role / non-admin refused;
 *                 the retired approveLegalProvider writes nothing; a client-written "approved" application
 *                 grants nothing; approval requires the canonical acceptances; approval records reviewer +
 *                 reason, links providers/{uid} (pending_verification, not bookable), creates an INACTIVE
 *                 consultation service, and does NOT make the advocate bookable; suspend works; a provider
 *                 of another kind is never merged (conflict → not linked)
 *   lsk           admin-only; P.105 bound to the registered number; malformed / forged status / future /
 *                 missing evidence refused; name mismatch recorded as FAILED; last practising year →
 *                 expired; source is set by the path (manual), never the client; Mode A says NOT AVAILABLE
 *                 and writes nothing; re-verification drops eligibility and keeps history
 *   surfaces      directory + profile + consultation request list/allow ONLY eligible advocates, public
 *                 projection carries no licence number / phone / evidence; the canonical availability gate
 *                 refuses every non-eligible advocate (even with provider flags forced bookable) and, while
 *                 Legal payment is not connected, the eligible one too; a plumber is unaffected
 *   audit         every decision / check is an append-only event (actor · action · target · previous · next ·
 *                 reason · time); nothing overwritten
 *   T.M.M         as onboard-batch2 wrote it: never listed / requested / bookable; DRY RUN writes nothing;
 *                 apply quarantines (record kept, verification never fabricated), re-run no-op, and the uid
 *                 cannot re-register or be re-approved
 *   browser       AdminOS › Legal Verification renders the SERVER's BOOKABLE / NOT BOOKABLE, labels manual
 *                 checks as manual, states the integration is not available, offers no bookable toggle,
 *                 records a check and a decision; Legal Hub lists only the eligible advocate with ✅ LSK
 *
 *   node scripts/test-legal-verification.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-legal-verification';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;

const fs = require('fs');
const Path = require('path');
const ROOT = Path.resolve(__dirname, '..');
const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now(), strictReadOrder: true });
const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : require.resolve(m, { paths: [FN] }); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
const CLAIMS = {};
const AUTH = { getUser: async (u) => ({ uid: u, customClaims: CLAIMS[u] || {} }), setCustomUserClaims: async (u, c) => { CLAIMS[u] = c; } };
const ADMIN = { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }),
  auth: () => AUTH, storage: () => ({ bucket: () => ({}) }), messaging: () => ({ send: async () => ({}) }) };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin/auth', { getAuth: () => AUTH });
stub('firebase-admin', ADMIN);
stub('./notify', { notify: async () => ({ ok: true }), TYPES: {} });

const LV = require(Path.join(FN, 'legal-verification.js'));
const LH = require(Path.join(FN, 'legal-hub.js'));
const LC = require(Path.join(FN, 'application-lifecycle.js'));
const LA = require(Path.join(FN, 'legal-agreements.js'));
const AV = require(Path.join(FN, 'ent-availability.js'));
const MIG = require(Path.join(ROOT, 'scripts', 'migrate-legal-quarantine.js'));
const { makePageHarness } = require('./lib/page-harness.js');

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 180) + ']' : '')); ok ? pass++ : fail++; };
const run = (cf) => (req) => (cf.run || cf)(req);
const req = (uid, data, claims) => ({ auth: uid ? { uid, token: Object.assign({}, claims || {}) } : null, data: data || {}, rawRequest: { headers: {} } });
const ADM = { admin: true };
async function code(p) { try { await p; return null; } catch (e) { return (e.details && e.details.code) || e.code || e.message; } }
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const all = async (c) => (await db.collection(c).get()).docs.map((d) => Object.assign({ _id: d.id }, d.data()));
const H = LV._adminH;
const NOW = Date.now();
const YEAR_END = LV.practisingYearEndMs(NOW);

/* Seed an advocate DIRECTLY in a given verification state (the matrix). */
const V = (admin, lsk, extra) => Object.assign({ admin: { status: admin } }, lsk ? { lsk } : {}, extra || {});
const LSK_OK = () => ({ status: 'verified', practiceStatus: 'Active', source: LV.SOURCES.OFFICIAL_SOURCE_MANUAL, checkedAtMs: NOW - 86400000, validUntilMs: YEAR_END });
const LINKED = { providerLink: { status: 'linked' } };
async function seedAdv(uid, verification, over) {
  await db.doc('legalProviders/' + uid).set(Object.assign({ providerId: uid, uid, name: 'Advocate ' + uid, licenseNumber: 'P.105/9' + uid.length + '/15', status: 'active', rating: 4, consultationFee: 2000, currency: 'KES', specializations: ['family_law'], county: 'Nairobi' }, verification ? { verification } : {}, over || {}));
  /* The worst case for the gate: generic provider flags say "bookable". */
  await db.doc('providers/' + uid).set({ uid, status: 'active', acceptsBookings: true, name: uid, category: 'legal' });
}

(async () => {
  say('\n── predicate + normalisation ──');
  ck('P.105 normalises (P.105/1234/05 · p105/1234/2005 · spaced) and refuses junk', LV.normP105('P.105/1234/05') === 'P.105/1234/05' && LV.normP105('p105/1234/2005') === 'P.105/1234/05' && LV.normP105(' P.105 / 01234 / 05 ') === 'P.105/1234/05' && LV.normP105('12345') === null && LV.normP105('P.106/1/05') === null);
  ck('practising status is one LSK reports (case-insensitive) — "Verified" is not a status', LV.canonPractice('active') === 'Active' && LV.canonPractice('STRUCK OFF') === 'Struck Off' && LV.canonPractice('Verified') === null);
  ck('the LSK name must be the registered advocate\'s', LV.nameMatches('Advocate Wanjiru Kamau', 'KAMAU WANJIRU JANE') && !LV.nameMatches('Wanjiru Kamau', 'Otieno Brian'));
  ck('an Active result is current only to the end of its practising year (31 Dec, Nairobi)', new Date(YEAR_END + 3 * 3600000).getUTCMonth() === 11 && new Date(YEAR_END + 3 * 3600000 + 1).getUTCFullYear() === new Date(NOW + 3 * 3600000).getUTCFullYear() + 1);
  const E = (lp, t) => LV.eligibility(lp, t).code;
  const M = {
    'no record': [null, 'NOT_REGISTERED'],
    'unapproved (nothing recorded — T.M.M shape)': [{ status: 'active', verified: false }, 'ADMIN_PENDING'],
    'admin approved · LSK pending': [{ verification: V('approved', { status: 'pending' }, LINKED) }, 'LSK_PENDING'],
    'admin pending · LSK verified': [{ verification: V('pending', LSK_OK(), LINKED) }, 'ADMIN_PENDING'],
    'admin rejected · LSK verified': [{ verification: V('rejected', LSK_OK(), LINKED) }, 'ADMIN_REJECTED'],
    'admin suspended · LSK verified': [{ verification: V('suspended', LSK_OK(), LINKED) }, 'ADMIN_SUSPENDED'],
    'LSK Inactive': [{ verification: V('approved', Object.assign(LSK_OK(), { status: 'failed', practiceStatus: 'Inactive' }), LINKED) }, 'LSK_FAILED'],
    'LSK Suspended': [{ verification: V('approved', Object.assign(LSK_OK(), { status: 'suspended', practiceStatus: 'Suspended' }), LINKED) }, 'LSK_SUSPENDED'],
    'LSK Unknown': [{ verification: V('approved', Object.assign(LSK_OK(), { status: 'unknown', practiceStatus: 'Unknown' }), LINKED) }, 'LSK_UNKNOWN'],
    'LSK Struck Off': [{ verification: V('approved', Object.assign(LSK_OK(), { status: 'failed', practiceStatus: 'Struck Off' }), LINKED) }, 'LSK_FAILED'],
    'LSK Deceased': [{ verification: V('approved', Object.assign(LSK_OK(), { status: 'failed', practiceStatus: 'Deceased' }), LINKED) }, 'LSK_FAILED'],
    'forged: status verified but practice Inactive': [{ verification: V('approved', Object.assign(LSK_OK(), { practiceStatus: 'Inactive' }), LINKED) }, 'LSK_NOT_ACTIVE'],
    'forged: unknown source': [{ verification: V('approved', Object.assign(LSK_OK(), { source: 'client' }), LINKED) }, 'LSK_SOURCE_UNKNOWN'],
    'forged: verified:true / bookable:true flags only': [{ verified: true, bookable: true, lskVerified: true, adminApproved: true, verification: { eligibility: { bookable: true } } }, 'ADMIN_PENDING'],
    'stale (validUntil passed)': [{ verification: V('approved', Object.assign(LSK_OK(), { validUntilMs: NOW - 1 }), LINKED) }, 'LSK_STALE'],
    'provider not linked': [{ verification: V('approved', LSK_OK()) }, 'PROVIDER_NOT_LINKED'],
    'quarantined': [{ quarantined: true, verification: V('approved', LSK_OK(), LINKED) }, 'QUARANTINED'],
    'both verified + current + linked': [{ verification: V('approved', LSK_OK(), LINKED) }, null],
  };
  for (const [k, [lp, want]] of Object.entries(M)) ck(`eligibility: ${k} → ${want || 'BOOKABLE'}`, E(lp, NOW) === want, E(lp, NOW));
  ck('the bookable state goes stale by itself next practising year (no write needed)', E(M['both verified + current + linked'][0], YEAR_END + 1) === 'LSK_STALE');

  say('\n── intake ──');
  await db.doc('users/adv1').set({ name: 'Wanjiru Kamau' });
  const reg = await run(LH.registerLegalProvider)(req('adv1', { name: 'Wanjiru Kamau', specializations: ['family_law'], licenseNumber: 'P.105/1234/15', consultationFee: 3000, county: 'Nairobi',
    status: 'active', verified: true, bookable: true, verification: { admin: { status: 'approved' }, lsk: LSK_OK(), providerLink: { status: 'linked' } } }));
  const lp1 = await get('legalProviders/adv1');
  ck('registration ignores injected status / verified / bookable / verification — both authorities start pending', lp1.status === 'pending_review' && lp1.verification.admin.status === 'pending' && lp1.verification.lsk.status === 'pending' && lp1.verified === undefined && lp1.bookable === undefined && !LV.eligibility(lp1).bookable, lp1.verification);
  const app1 = await get('applications/legal_adv1');
  ck('…and creates the ONE AdminOS review item (applications/legal_{uid}, role legal, pending)', reg.applicationId === 'legal_adv1' && app1 && app1.role === 'legal' && app1.status === 'pending' && app1.uid === 'adv1');
  ck('a second registration is refused (no duplicate Legal identity)', await code(run(LH.registerLegalProvider)(req('adv1', { name: 'X', specializations: ['other'], licenseNumber: 'P.105/1/15' }))) === 'already-exists');

  say('\n── SOKONI admin verification ──');
  const decide = (uid, claims, data) => run(LC.applicationDecide)(req(uid, data, claims));
  ck('a non-admin cannot decide', await code(decide('adv1', {}, { applicationId: 'legal_adv1', decision: 'approve', reason: 'self' })) === 'permission-denied');
  ck('admin impersonation — a numeric role 4 claim — cannot decide', await code(decide('imp1', { role: 4 }, { applicationId: 'legal_adv1', decision: 'approve', reason: 'x' })) === 'permission-denied');
  ck('the retired approveLegalProvider refuses (numeric role 4 or real admin) and writes nothing', await code(run(LH.approveLegalProvider)(req('imp1', { providerId: 'adv1', action: 'approve' }, { role: 4 }))) === 'LEGAL_APPROVAL_MOVED' && await code(run(LH.approveLegalProvider)(req('adm1', { providerId: 'adv1', action: 'approve' }, ADM))) === 'LEGAL_APPROVAL_MOVED' && (await get('legalProviders/adv1')).verification.admin.status === 'pending');
  ck('approval needs the canonical provider acceptances — refused without them, nothing recorded', await code(decide('adm1', ADM, { applicationId: 'legal_adv1', decision: 'approve', reason: 'LSK letter on file' })) === 'failed-precondition' && (await get('legalProviders/adv1')).verification.admin.status === 'pending');
  const need = (await LA.complianceFor('adv1', 'provider')).required;
  for (const a of need) await db.collection('legalAcceptances').doc('adv1_' + a.agreementId).set({ userId: 'adv1', agreementId: a.agreementId, version: a.version, accepted: true });
  ck('(the acceptances are derived from the producer: complianceFor(uid, "provider"))', need.length > 0 && (await LA.complianceFor('adv1', 'provider')).compliant, need.length);
  const evBefore = (await all('legalVerificationEvents')).length;
  const dec = await decide('adm1', ADM, { applicationId: 'legal_adv1', decision: 'approve', reason: 'Identity reviewed' });
  const lp1b = await get('legalProviders/adv1'); const v1 = await get('legalVerifications/adv1'); const pr1 = await get('providers/adv1');
  ck('approval through AdminOS records the SOKONI decision on the Legal record (the registry is no longer skipped)', dec.ok && lp1b.verification.admin.status === 'approved' && v1.admin.reviewedBy === 'adm1' && v1.admin.reason === 'Identity reviewed' && v1.admin.applicationId === 'legal_adv1', v1.admin);
  ck('…links ONE canonical provider identity (providers/{uid}, provisionedBy legal) — pending verification, not bookable', pr1 && pr1.provisionedBy === 'legal-verification' && pr1.legalProviderId === 'adv1' && pr1.status === 'pending_verification' && pr1.acceptsBookings === false && pr1.searchable === false, pr1 && pr1.status);
  const svc1 = await get('providerServices/legal_consult_adv1');
  ck('…and an INACTIVE consultation service priced from the Legal record (KES 3000 → 300000 cents)', svc1 && svc1.active === false && svc1.price === 300000 && svc1.legalConsultation === true);
  ck('…but admin approval alone is NOT bookable (LSK_PENDING) and is not listed', lp1b.verification.eligibility.code === 'LSK_PENDING' && lp1b.status === 'pending_verification' && !(await run(LH.getLegalProviders)(req(null, {}))).providers.some((p) => p.providerId === 'adv1'));
  ck('…and the decision is an appended audit event (actor, action, target, previous, next, reason, time)', (await all('legalVerificationEvents')).length === evBefore + 1 && (await all('legalVerificationEvents')).some((e) => e.kind === 'admin_decision' && e.actor === 'adm1' && e.action === 'admin_approved' && e.target === 'legalProviders/adv1' && e.previous === 'pending' && e.next === 'approved' && e.reason === 'Identity reviewed' && e.atMs));
  const again = await LC._internal.applyDecision('legal_adv1', await get('applications/legal_adv1'), { decidedBy: 'adm1' });
  ck('re-applying the same decision is idempotent (the trigger racing applicationDecide adds no second event)', again.ok && (await all('legalVerificationEvents')).length === evBefore + 1);

  /* a client writes its OWN application as approved (+ a real admin's uid) — the trigger must grant nothing */
  await db.doc('users/adv2').set({ name: 'Otieno Brian' });
  await run(LH.registerLegalProvider)(req('adv2', { name: 'Otieno Brian', specializations: ['criminal_law'], licenseNumber: 'P.105/2222/10', consultationFee: 1500 }));
  await db.doc('applications/legal_adv2').set({ status: 'approved', decidedBy: 'adm1', statusCanonical: 'approved' }, { merge: true });
  /* the trigger re-fires on its own writes (intake normalisation first) — run it as production would */
  for (let i = 0; i < 4; i++) {
    const aSnap = await db.doc('applications/legal_adv2').get();
    await run(LC.applicationLifecycle)({ data: { before: null, after: aSnap }, params: { appId: 'legal_adv2' } });
  }
  const a2 = await get('applications/legal_adv2');
  ck('a client-written "approved" application grants nothing (no server decision record)', a2.projectionStatus === 'blocked_unauthorised_decision' && (await get('legalProviders/adv2')).verification.admin.status === 'pending' && !(await get('providers/adv2')), a2.projectionStatus);

  say('\n── LSK professional verification (Mode B: official source, recorded by an admin) ──');
  const L = (uid, claims, over) => H.legalAdminRecordLsk(req(uid, Object.assign({ uid: 'adv1', p105Number: 'P.105/1234/15', verifiedName: 'KAMAU WANJIRU', practiceStatus: 'Active', checkedAt: NOW - 3600000, evidenceRef: 'LSK search 2026-09-27 capture #A1' }, over || {}), claims));
  ck('a non-admin (the advocate) cannot record LSK verification', await code(L('adv1', {})) === 'permission-denied');
  ck('another user cannot change another advocate\'s verification', await code(L('adv2', {}, { uid: 'adv1' })) === 'permission-denied');
  ck('admin impersonation (numeric role 4) cannot record', await code(L('imp1', { role: 4 })) === 'permission-denied');
  ck('forged P.105 — not the registered number — refused', await code(L('adm1', ADM, { p105Number: 'P.105/9999/15' })) === 'P105_MISMATCH');
  ck('malformed P.105 refused', await code(L('adm1', ADM, { p105Number: '1234' })) === 'invalid-argument');
  ck('forged status ("Verified") refused — only LSK\'s statuses', await code(L('adm1', ADM, { practiceStatus: 'Verified' })) === 'invalid-argument');
  ck('a future check date refused', await code(L('adm1', ADM, { checkedAt: NOW + 86400000 })) === 'invalid-argument');
  ck('no evidence reference refused', await code(L('adm1', ADM, { evidenceRef: '' })) === 'invalid-argument');
  const r1 = await L('adm1', ADM, { source: LV.SOURCES.AUTHORIZED_INTEGRATION, auditRef: 'forged-audit', eventId: 'forged' });
  const v1b = await get('legalVerifications/adv1'); const lp1c = await get('legalProviders/adv1');
  ck('an Active result from the official source makes the advocate BOOKABLE-eligible (both gates)', r1.eligibility.bookable && lp1c.status === 'active' && lp1c.verification.lsk.status === 'verified', r1.eligibility);
  ck('…source is the MANUAL official-source path — a client-sent "authorized integration" source is ignored', lp1c.verification.lsk.source === LV.SOURCES.OFFICIAL_SOURCE_MANUAL && /manual/.test(v1b.lsk.sourceLabel));
  ck('…the audit reference is the server\'s event id, never a client-supplied one', r1.auditRef && r1.auditRef !== 'forged-audit' && r1.auditRef !== 'forged' && !!(await get('legalVerificationEvents/' + r1.auditRef)));
  ck('…the evidence (P.105, name returned, reviewer, evidence ref) is PRIVATE (legalVerifications), not on the public record', v1b.lsk.p105Number === 'P.105/1234/15' && v1b.lsk.verifiedName === 'KAMAU WANJIRU' && v1b.lsk.reviewedBy === 'adm1' && !JSON.stringify(lp1c.verification).includes('capture #A1'));
  const pub = (await run(LH.getLegalProviders)(req(null, {}))).providers.find((p) => p.providerId === 'adv1');
  ck('the directory lists the eligible advocate with sokoniVerified + lskVerified', pub && pub.sokoniVerified === true && pub.lskVerified === true && pub.lskPractisingYear === new Date(NOW + 3 * 3600000).getUTCFullYear());
  ck('…and never the licence number, phone, evidence or verification internals', pub && pub.licenseNumber === undefined && pub.phone === undefined && pub.verification === undefined && !JSON.stringify(pub).includes('capture'));
  const card = await get('lawyers/adv1');
  ck('the public directory card is projected (projectedBy legal-verification) without P.105 / phone', card && card.projectedBy === 'legal-verification' && card.lskVerified === true && card.licenseNumber === undefined && card.phone === undefined);
  ck('getLegalProvider returns the public projection only', (await run(LH.getLegalProvider)(req(null, { providerId: 'adv1' }))).licenseNumber === undefined);

  /* name mismatch → recorded FAILED (evidence), never passed */
  const dec2 = await (async () => { for (const a of need) await db.collection('legalAcceptances').doc('adv2_' + a.agreementId).set({ userId: 'adv2', agreementId: a.agreementId, version: a.version, accepted: true });
    await db.doc('applications/legal_adv2').set({ status: 'pending', decidedBy: null, projectionStatus: null }, { merge: true });
    return decide('adm1', ADM, { applicationId: 'legal_adv2', decision: 'approve', reason: 'ok' }); })();
  const rN = await L('adm1', ADM, { uid: 'adv2', p105Number: 'P.105/2222/10', verifiedName: 'Someone Else Entirely' });
  ck('forged LSK name — the name LSK returned is not the advocate\'s → recorded FAILED, not bookable', dec2.ok && rN.lsk.status === 'failed' && rN.lsk.nameMatched === false && !rN.eligibility.bookable, rN.lsk);
  const rS = await L('adm1', ADM, { uid: 'adv2', p105Number: 'P.105/2222/10', verifiedName: 'OTIENO BRIAN', practiceStatus: 'Active', checkedAt: Date.UTC(new Date(NOW).getUTCFullYear() - 1, 11, 15) });
  ck('an Active check from the LAST practising year is recorded as expired — not bookable', rS.lsk.status === 'expired' && rS.eligibility.code === 'LSK_EXPIRED', rS.lsk.status);
  const rI = await L('adm1', ADM, { uid: 'adv2', p105Number: 'P.105/2222/10', verifiedName: 'OTIENO BRIAN', practiceStatus: 'Inactive' });
  ck('LSK Inactive → failed, not bookable', rI.lsk.status === 'failed' && !rI.eligibility.bookable);

  say('\n── Mode A (authorized LSK integration) ──');
  const evN = (await all('legalVerificationEvents')).length;
  /* a throw is a FAIL here, never a crash — the harness must fail closed */
  const auto = await H.legalAdminRunLskCheck(req('adm1', { uid: 'adv1' }, ADM)).catch((e) => ({ threw: String(e && e.message) }));
  ck('the integration says NOT AVAILABLE / NOT AUTHORIZED and writes nothing', auto.available === false && /NOT AVAILABLE \/ NOT AUTHORIZED/.test(auto.statement) && (await all('legalVerificationEvents')).length === evN);
  /* CHANGELOG 228 — deterministic, whatever the time of day the suite runs: the panel sends the START of the
     chosen day in Nairobi, and "checked today" at that instant is never in the server's future. */
  const PANEL = fs.readFileSync(Path.join(ROOT, 'sokoni-aos-legal.js'), 'utf8');
  const todayEAT = new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
  ck('the panel sends the start of the chosen Nairobi day (a same-morning check is not "in the future")',
    /Date\.parse\(f\.checkedAt\.value \+ 'T00:00:00\+03:00'\)/.test(PANEL) && Date.parse(todayEAT + 'T00:00:00+03:00') <= Date.now());
  ck('the adapter holds no endpoint, fetch or scraping code', !/https?:\/\/|fetch\(|axios|puppeteer|playwright|request\(/.test(fs.readFileSync(Path.join(FN, 'lsk-adapter.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')));

  say('\n── the canonical booking gate ──');
  const matrix = {
    advA: V('approved', { status: 'pending' }, LINKED), advB: V('pending', LSK_OK(), LINKED),
    advC: V('approved', Object.assign(LSK_OK(), { status: 'failed', practiceStatus: 'Inactive' }), LINKED),
    advD: V('approved', Object.assign(LSK_OK(), { status: 'suspended', practiceStatus: 'Suspended' }), LINKED),
    advE: V('approved', Object.assign(LSK_OK(), { status: 'unknown', practiceStatus: 'Unknown' }), LINKED),
    advF: V('approved', Object.assign(LSK_OK(), { validUntilMs: NOW - 1000 }), LINKED),
    advH: V('suspended', LSK_OK(), LINKED), advG: V('approved', LSK_OK(), LINKED),
  };
  for (const [u, v] of Object.entries(matrix)) await seedAdv(u, v);
  await db.doc('providers/lawyerX').set({ uid: 'lawyerX', status: 'active', acceptsBookings: true, category: 'Lawyer', name: 'Self-declared lawyer' });
  await db.doc('providers/plumb1').set({ uid: 'plumb1', status: 'active', acceptsBookings: true, category: 'Plumbing', name: 'Pipes Ltd' });
  const gate = async (u) => (await AV.loadCalendar({ providerId: u })).bookable;
  for (const u of ['advA', 'advB', 'advC', 'advD', 'advE', 'advF', 'advH']) { const g = await gate(u); ck(`${u}: refused by the canonical availability authority even with provider flags forced bookable`, !g.ok && /^LEGAL_/.test(g.code), g.code); }
  ck('a self-declared "Lawyer" provider with no Legal record is not bookable', (await gate('lawyerX')).code === 'LEGAL_NOT_REGISTERED', (await gate('lawyerX')).code);
  ck('the fully eligible advocate is refused too while Legal payment is not connected', (await gate('advG')).code === 'LEGAL_BOOKING_NOT_ENABLED', (await gate('advG')).code);
  ck('a plumber is unaffected (no Legal objection)', (await gate('plumb1')).ok === true, (await gate('plumb1')).code);
  LV.LEGAL_BOOKING_ENABLED = true;
  const opened = [];
  for (const u of Object.keys(matrix)) if ((await gate(u)).ok) opened.push(u);
  LV.LEGAL_BOOKING_ENABLED = false;
  ck('with Legal booking switched on (payment slice), ONLY the fully eligible state reaches the booking path', opened.length === 1 && opened[0] === 'advG', opened);
  ck('the consultation request refuses every non-eligible advocate and accepts the eligible one', await code(run(LH.bookLegalConsultation)(req('b1', { providerId: 'advA', dateTime: new Date(NOW + 2 * 86400000).toISOString(), matter: 'x', idempotencyKey: 'k1' }))) === 'not-found' &&
    !!(await run(LH.bookLegalConsultation)(req('b1', { providerId: 'adv1', dateTime: new Date(NOW + 2 * 86400000).toISOString(), matter: 'x', idempotencyKey: 'k2' }))).consultationId);

  say('\n── re-verification · suspension · identity conflicts ──');
  const rc = await H.legalAdminRequestRecheck(req('adm1', { uid: 'adv1', reason: 'New practising year' }, ADM));
  const v1c = await get('legalVerifications/adv1');
  ck('re-verification drops eligibility until a new check is recorded, and the public card goes', rc.eligibility.code === 'LSK_PENDING' && !(await get('lawyers/adv1')) && (await get('legalProviders/adv1')).status === 'pending_verification');
  ck('…the previous verification is retained (lskPrevious + history), never overwritten', v1c.lskPrevious && v1c.lskPrevious.status === 'verified' && (await all('legalVerificationEvents')).filter((e) => e.uid === 'adv1').map((e) => e.action).join(',').includes('lsk_verified'));
  await L('adm1', ADM);
  const sus = await decide('adm1', ADM, { applicationId: 'legal_adv1', decision: 'suspend', reason: 'Complaint under review' });
  ck('an AdminOS suspension makes a verified advocate not bookable and suspends the linked provider', sus.ok && (await get('legalProviders/adv1')).verification.eligibility.code === 'ADMIN_SUSPENDED' && (await get('providers/adv1')).status === 'suspended' && !(await get('lawyers/adv1')));
  await db.doc('providers/adv3').set({ uid: 'adv3', status: 'active', acceptsBookings: true, category: 'Plumbing', name: 'Pipes & Law' });
  await db.doc('legalProviders/adv3').set({ providerId: 'adv3', uid: 'adv3', name: 'Mary Achieng', licenseNumber: 'P.105/3333/12', status: 'pending_review', verification: { admin: { status: 'pending' }, lsk: { status: 'pending' } } });
  await db.doc('applications/legal_adv3').set({ uid: 'adv3', role: 'legal', status: 'pending', name: 'Mary Achieng', createdAt: 1 });
  for (const a of need) await db.collection('legalAcceptances').doc('adv3_' + a.agreementId).set({ userId: 'adv3', agreementId: a.agreementId, version: a.version, accepted: true });
  await decide('adm1', ADM, { applicationId: 'legal_adv3', decision: 'approve', reason: 'ok' });
  const p3 = await get('providers/adv3'); const l3 = await get('legalProviders/adv3');
  ck('an active provider of ANOTHER kind is never merged: link = conflict, provider untouched, not bookable', l3.verification.providerLink.status === 'conflict' && p3.status === 'active' && p3.legalProviderId === undefined && p3.category === 'Plumbing' && l3.verification.eligibility.code !== null);

  say('\n── T.M.M (as scripts/onboard-batch2.js wrote it) ──');
  const TMM = MIG.TARGETS[0].uid;
  await db.doc('legalProviders/' + TMM).set({ providerId: TMM, uid: TMM, name: 'T.M.M & Partners Advocates', firmName: 'T.M.M & Partners Advocates', specializations: ['other'], licenseNumber: '', status: 'active', verified: false, rating: 0, onboardedBy: 'scripts/onboard-batch2.js' });
  await db.doc('lawyers/' + TMM).set({ name: 'T.M.M & Partners Advocates', status: 'active', verified: false, searchable: true, onboardedBy: 'scripts/onboard-batch2.js' });
  await db.doc('users/' + TMM).set({ hasLegalProfile: true });
  ck('T.M.M is never listed, never profiled, never requestable (legacy "active" is not an approval)', !(await run(LH.getLegalProviders)(req(null, {}))).providers.some((p) => p.providerId === TMM) && await code(run(LH.getLegalProvider)(req(null, { providerId: TMM }))) === 'not-found' && await code(run(LH.bookLegalConsultation)(req('b1', { providerId: TMM, dateTime: new Date(NOW + 2 * 86400000).toISOString(), matter: 'x', idempotencyKey: 'k3' }))) === 'not-found');
  ck('…never bookable at the canonical gate', (await LV.bookingGate(db, TMM, { category: 'legal' })) === 'LEGAL_ADMIN_PENDING');
  ck('…its legacy directory card never appears in site search (title requires the projection)', /col: 'lawyers'[\s\S]{0,400}title: d => \(d\.projectedBy === 'legal-verification' && d\.name\) \|\| ''/.test(fs.readFileSync(Path.join(ROOT, 'sokoni-firestore-search.js'), 'utf8')));
  const lst = await H.legalAdminList(req('adm1', {}, ADM));
  ck('AdminOS lists it as a legacy record that was never verified — NOT BOOKABLE', lst.advocates.some((a) => a.uid === TMM && a.legacyUnverified && !a.eligibility.bookable));
  const snapCount = async () => (await all('legalProviders')).length + (await all('lawyers')).length + (await all('legalProviderQuarantine')).length;
  const before = await snapCount();
  const plan = await MIG.plan(db);
  ck('migration DRY RUN plans QUARANTINE + REMOVE for T.M.M and writes nothing', plan.targets[0].action === 'QUARANTINE + REMOVE' && (await snapCount()) === before);
  ck('…and REPORTS (never modifies) other never-verified legal records', Array.isArray(plan.unverifiedOthers) && plan.unverifiedOthers.every((x) => x.uid !== TMM));
  ck('apply without an operator is refused', await code(MIG.apply(db, {})) !== null);
  const ap = await MIG.apply(db, { operator: 'adm1' });
  const q = await get('legalProviderQuarantine/' + TMM);
  ck('apply removes T.M.M from the Legal registry and its directory card', ap[0].action === 'quarantined' && !(await get('legalProviders/' + TMM)) && !(await get('lawyers/' + TMM)) && (await get('users/' + TMM)).hasLegalProfile === false);
  ck('…keeping an internal audit record: legacy data, action, reason, time, script version, operator — no fabricated LSK', q && q.legacy.legalProviders.onboardedBy === 'scripts/onboard-batch2.js' && q.action === 'removed_from_legal_registry' && /blank LSK/.test(q.reason) && q.removedAtMs && q.scriptVersion === MIG.SCRIPT_VERSION && q.operator === 'adm1' && q.lskVerificationFabricated === false);
  ck('…and a quarantine event in the verification history', (await all('legalVerificationEvents')).some((e) => e.uid === TMM && e.kind === 'quarantine'));
  ck('re-running apply is a no-op', (await MIG.apply(db, { operator: 'adm1' }))[0].action === 'noop_already_quarantined');
  ck('the quarantined uid cannot register as an advocate again', await code(run(LH.registerLegalProvider)(req(TMM, { name: 'TMM', specializations: ['other'], licenseNumber: 'P.105/1/15' }))) === 'failed-precondition');
  await db.doc('applications/legal_' + TMM).set({ uid: TMM, role: 'legal', status: 'pending', name: 'TMM', createdAt: 1 });
  for (const a of need) await db.collection('legalAcceptances').doc(TMM + '_' + a.agreementId).set({ userId: TMM, agreementId: a.agreementId, version: a.version, accepted: true });
  const tmmDec = await code(decide('adm1', ADM, { applicationId: 'legal_' + TMM, decision: 'approve', reason: 'x' }));
  ck('…nor be re-created by an AdminOS approval (quarantine must be released deliberately)', tmmDec !== null && !(await get('legalProviders/' + TMM)), tmmDec);

  say('\n── static ──');
  const LAD = fs.readFileSync(Path.join(ROOT, 'legal-admin.html'), 'utf8');
  ck('legal-admin.html no longer approves advocates (no approveLegalProvider, no approval cards)', !/approveLegalProvider|apr-approve|pap-load/.test(LAD) && /AdminOS › Legal Verification/.test(LAD));
  ck('provider-wiring.js no longer writes the legal directory', !/_fsSet\('lawyers'/.test(fs.readFileSync(Path.join(ROOT, 'provider-wiring.js'), 'utf8')));
  ck('the application lifecycle no longer delegates legal', !/legal:\s*'legalProviders'/.test(fs.readFileSync(Path.join(FN, 'application-lifecycle.js'), 'utf8')));
  ck('onboard-batch2.js can no longer recreate T.M.M', !/patch\('legalProviders'|patch\('lawyers'/.test(fs.readFileSync(Path.join(ROOT, 'scripts', 'onboard-batch2.js'), 'utf8')));

  say('\n── browser: AdminOS › Legal Verification + Legal Hub ──');
  await seedAdv('advZ', { admin: { status: 'approved' }, lsk: { status: 'pending' }, providerLink: { status: 'linked' } }, { name: 'Njeri Mwangi', licenseNumber: 'P.105/5555/18' });
  await db.doc('applications/legal_advZ').set({ uid: 'advZ', role: 'legal', status: 'approved', name: 'Njeri Mwangi', createdAt: 1 });
  const AOS_PAGE = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    (fs.readFileSync(Path.join(ROOT, 'admin-os.html'), 'utf8').match(/<style[^>]*>[\s\S]*?<\/style>/g) || []).join('') +
    '</head><body style="background:#060a06;color:#eee;margin:0"><main class="aos-main"><div class="aos-content"><div class="aos-panel" id="panel-legal"><div id="host"></div></div></div></main><script src="/firebase.js" type="module"></script><script src="/sokoni-aos-legal.js"></script>' +
    '<script>window.__mounted = new Promise((r) => { const go = () => { if (typeof window.sokoniCallable !== "function") return setTimeout(go, 50); ' +
    'window.SokoniAOSLegal.mount({ host: document.getElementById("host"), call: async (op, d) => { const via = window.SokoniAOSLegal.OPS.includes(op) ? "adminOsDispatch" : op; const payload = via === "adminOsDispatch" ? Object.assign({ op: op }, d || {}) : (d || {}); const r = await window.sokoniCallable(via)(payload); return r.data; } }); r(true); }; go(); });</script></body></html>';
  const HAR = makePageHarness({ db, root: ROOT, pages: { '/aos-legal.html': AOS_PAGE }, callables: {
    adminOsDispatch: Object.fromEntries(Object.entries(H).map(([k, fnx]) => [k, fnx])),
    applicationDecide: run(LC.applicationDecide), getLegalProviders: run(LH.getLegalProviders),
  } });
  await HAR.start();
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  try {
    const A = await HAR.page(browser, { user: { uid: 'adm1', email: 'a@x.co', emailVerified: true, claims: ADM }, viewport: { width: 360, height: 800 } });
    await A.goto(HAR.BASE + '/aos-legal.html');
    await A.waitForFunction(() => /NOT BOOKABLE|BOOKABLE/.test(document.body.innerText), null, { timeout: 12000 }).catch(() => {});
    const list = await A.evaluate(() => document.body.innerText);
    ck('the list shows the SERVER\'s eligibility per advocate (BOOKABLE / NOT BOOKABLE with the reason code)', /NOT BOOKABLE/.test(list) && /LSK_PENDING|ADMIN_SUSPENDED/.test(list), list.slice(0, 160));
    ck('…and states plainly that the LSK integration is NOT AVAILABLE / NOT AUTHORIZED', /NOT AVAILABLE \/ NOT AUTHORIZED/.test(list));
    ck('…no control anywhere sets "bookable"', await A.evaluate(() => ![...document.querySelectorAll('input,select,button')].some((e) => /bookable/i.test((e.name || '') + (e.id || '') + (e.dataset && JSON.stringify(e.dataset))))));
    ck('no horizontal scroll at 360', await A.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1),
      await A.evaluate(() => { const W = document.documentElement.clientWidth; return [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > W + 1 && !e.closest('.aos-table-wrap table')).slice(0, 4).map((e) => e.tagName + '.' + e.className + ':' + Math.round(e.getBoundingClientRect().right)); }));
    await A.evaluate(() => { const b = document.querySelector('[data-open="advZ"]'); if (b) b.click(); });
    await A.waitForFunction(() => /1 · SOKONI verification/.test(document.body.innerText), null, { timeout: 8000 }).catch(() => {});
    await A.evaluate((iso) => { const f = document.querySelector('[data-lsk]'); f.verifiedName.value = 'MWANGI NJERI'; f.practiceStatus.value = 'Active'; f.checkedAt.value = iso; f.evidenceRef.value = 'LSK search capture #Z9'; f.requestSubmit(); }, new Date(NOW + 3 * 3600000).toISOString().slice(0, 10));
    await A.waitForFunction(() => /BOOKABLE/.test((document.querySelector('[data-eligibility]') || {}).innerText || '') && !/NOT BOOKABLE/.test((document.querySelector('[data-eligibility]') || {}).innerText || ''), null, { timeout: 8000 }).catch(() => {});
    const det = await A.evaluate(() => document.body.innerText);
    ck('recording an official-source check in the panel reaches the server; eligibility re-derives to BOOKABLE', (await get('legalProviders/advZ')).verification.lsk.status === 'verified' && /\bBOOKABLE\b/.test(det) && !/NOT BOOKABLE/.test((det.match(/Booking eligibility[\s\S]{0,120}/) || [''])[0]), (det.match(/Booking eligibility[\s\S]{0,120}/) || [''])[0]);
    ck('…labelled as a MANUAL official-source check, never as an automated integration', /Official LSK source — checked and recorded by a SOKONI administrator \(manual\)/.test(det) && !/Authorized LSK integration \(automated\)/.test(det.replace(/Check via authorized LSK integration/, '')));
    ck('…with the audit history (actor + action + evidence)', /lsk_verified/.test(det) && /capture #Z9/.test(det) && /adm1/.test(det));
    ck('…and says an eligible advocate still takes no paid bookings (payment not connected)', /Legal payment is not connected yet/.test(det));
    ck('…and the advocate view has no control that sets "bookable" either', await A.evaluate(() => ![...document.querySelectorAll('input,select,button,textarea')].some((e) => /bookable/i.test((e.name || '') + (e.id || '') + (e.dataset && JSON.stringify(e.dataset))))));
    await A.__ctx.close();

    const N = await HAR.page(browser, { user: { uid: 'adv1', email: 'v@x.co', emailVerified: true, claims: {} } });
    await N.goto(HAR.BASE + '/aos-legal.html');
    await N.waitForFunction(() => /Could not load/.test(document.body.innerText), null, { timeout: 8000 }).catch(() => {});
    ck('a non-admin opening the panel gets nothing (every op re-checks the admin claim)', await N.evaluate(() => /Could not load/.test(document.body.innerText) && /Administrators only/.test(document.body.innerText)));
    await N.__ctx.close();

    const P = await HAR.page(browser, { user: null });
    await P.goto(HAR.BASE + '/legal-hub.html');
    await P.waitForFunction(() => /Njeri Mwangi/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
    const dir = await P.evaluate(() => ({ text: document.body.innerText, badges: [...document.querySelectorAll('.lc-badge')].map((b) => b.textContent.trim()) }));
    ck('Legal Hub lists the eligible advocate with ✅ LSK', /Njeri Mwangi/.test(dir.text) && dir.badges.includes('✅ LSK'), dir.badges);
    ck('…and not T.M.M, not the suspended, not the LSK-pending advocates', !/T\.M\.M/.test(dir.text) && !/Advocate advA|Advocate advH/.test(dir.text));
    await P.__ctx.close();
  } finally { await browser.close(); HAR.stop(); }

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
