/* test-entertainment-registry.js — the Entertainment category lifecycle, approval routing and
 * AdminOS authority, end to end on the transactional fake Firestore.
 *
 * PROVES
 *   Registry     every category has application · approval · role · dashboard · payment · refund ·
 *                policy · search · AdminOS (no orphan) · every named page EXISTS on disk ·
 *                Streaming is a Creator content type with its own Creator subcategory ·
 *                the browser copies equal the server sources
 *   Policy       each category's commercialPolicy is a real policy (or an explicit "none")
 *   Approval     an event_organizer application resolves to event_organizer (a prose
 *                "event planner" still resolves to provider — a different product) · approval
 *                grants users.roles + the event_organizer claim, MERGED with existing claims ·
 *                projects NO provider profile · notifies with the Event Manager link · rejection
 *                revokes both · the role map no longer defaults event_organizer to provider
 *   AdminOS      entAdmin* refuse a plain user · approve/reject/suspend/restore state machine ·
 *                reason required · audit carries before/after/createdAt · every panel op is a
 *                dispatcher handler · the panel is whitelisted and loaded before sokoni-aos.js ·
 *                NO Entertainment control in admin.html / superadmin.html / super-admin.html
 *   Checkout     getCheckoutMethods offers hosted methods ONLY when enabled for the purpose AND
 *                proven; otherwise M-PESA only
 *
 * NO NETWORK: firebase-admin replaced in the require cache.
 *   node scripts/test-entertainment-registry.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-ent-registry';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

const Path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const ROOT = Path.resolve(__dirname, '..');
const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() });
const db = F.db;

/* auth: claims are recorded so the MERGE can be proven */
const claims = { org1: { seller: true, merchantId: 'SOK-1' } };
const authApi = { getUser: async (u) => ({ uid: u, customClaims: claims[u] || {} }),
  setCustomUserClaims: async (u, c) => { claims[u] = c; } };
const notified = [];
const resolveIn = (m) => require.resolve(m, { paths: [FN] });
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : resolveIn(m); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin/auth', { getAuth: () => authApi });
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp }), auth: () => authApi });
stub('./notify', { notify: async (n) => { notified.push(n); return { ok: true }; } });

const REG = require(Path.join(FN, 'shared', 'entertainment-registry.js'));
const POLICY = require(Path.join(FN, 'shared', 'commercial-policy.js'));
const PUB = require(Path.join(FN, 'shared', 'creator-publishing.js'));
const RA = require(Path.join(FN, 'role-authority.js'));
const AL = require(Path.join(FN, 'application-lifecycle.js'));
const EA = require(Path.join(FN, 'entertainment-admin.js'));
const HC = require(Path.join(FN, 'hosted-checkout.js'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 140) + ']' : '')); ok ? pass++ : fail++; };
const who = (uid, c = {}) => ({ auth: uid ? { uid, token: c } : null });
async function code(p) { try { await p; return null; } catch (e) { return e.code || e.message; } }
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const pagePath = (u) => Path.join(ROOT, String(u).split(/[?#]/)[0].replace(/^\//, ''));

(async () => {
  /* ═══ registry ═══ */
  console.log('\n── registry ──');
  ck('no category is missing a lifecycle step', REG.orphans().length === 0, REG.orphans());
  ck('categories: creator, streaming, events, performers, venues', JSON.stringify(REG.ids()) === JSON.stringify(['creator', 'streaming', 'events', 'performers', 'venues']));
  for (const c of REG.CATEGORIES) {
    ck(`${c.id}: application page exists (${c.application.path})`, fs.existsSync(pagePath(c.application.path)));
    ck(`${c.id}: dashboard page exists (${c.dashboard.path})`, fs.existsSync(pagePath(c.dashboard.path)));
    const pk = String(c.commercialPolicy);
    ck(`${c.id}: commercial policy is real or explicitly none/provider-owned (${pk.slice(0, 30)})`, !!POLICY.POLICIES[pk] || /^none|^provider_services/.test(pk));
    ck(`${c.id}: dashboard tier declared`, c.dashboard.tier === 'PREMIUM' || c.dashboard.tier === 'EQUIPPED');
  }
  ck('Streaming is a Creator content type', REG.get('streaming').contentTypeOf === 'creator' && REG.get('streaming').commercialPolicy === 'creator_ppv');
  ck('Streaming is a real Creator subcategory (server rules)', Object.prototype.hasOwnProperty.call(PUB.SUBCATEGORIES, 'streaming'));
  ck('Streaming does not claim live broadcast', /not implemented/i.test(REG.get('streaming').limits || ''));
  ck('role → dashboard is deterministic', REG.dashboardForRole('event_organizer') === '/event-manager.html'
    && REG.dashboardForRole('creator') === '/creator-studio.html' && REG.dashboardForRole('provider') === '/provider-dashboard.html'
    && REG.dashboardForRole('nobody') === null);
  ck('legacy performer spellings resolve to one canonical id', REG.performerType('live-band') === 'band' && REG.performerType('photography') === 'photographer' && REG.performerType('xyz') === null);
  const sync = spawnSync(process.execPath, [Path.join(__dirname, 'sync-creator-shared.js'), '--check'], { encoding: 'utf8' });
  ck('browser copies equal server sources (registry + creator rules)', sync.status === 0, (sync.stdout || '').trim().split('\n').filter((l) => /DRIFT/.test(l)).join(' '));

  /* ═══ approval routing ═══ */
  console.log('\n── approval routing ──');
  ck('event_organizer application → event_organizer (declared)', AL._internal.resolveRole({ type: 'event_organizer', hub: 'entertainment' }).role === 'event_organizer');
  ck('prose "event planner" still → provider (a bookable service, different product)', AL._internal.resolveRole({ type: 'business', category: 'event-planner services' }).role === 'provider');
  ck('role map: event_organizer keeps its OWN key (no provider fallback)', RA.roleKeyFor('event_organizer') === 'event_organizer');
  await db.doc('users/org1').set({ roles: ['buyer', 'seller'] });
  const app = { uid: 'org1', type: 'event_organizer', role: 'event_organizer', name: 'Kamau Events', status: 'approved', agreementAccepted: true, phoneNumber: '+254712345678' };
  await db.doc('applications/A1').set(app);
  await AL._internal.applyDecision('A1', app, { decidedBy: 'adm' });
  const u = await get('users/org1');
  ck('approval grants users.roles event_organizer (existing roles kept)', u.roles.includes('event_organizer') && u.roles.includes('seller'), u.roles);
  ck('approval mints the event_organizer claim, MERGED with existing claims', claims.org1.event_organizer === true && claims.org1.seller === true && claims.org1.merchantId === 'SOK-1', claims.org1);
  ck('NO provider profile projected for an organizer', !(await get('providers/org1')) && !(await get('providerProfiles/org1')));
  const n = notified.find((x) => x.uid === 'org1');
  ck('approval notice routes to Event Manager', n && n.type === 'organizer_approved' && n.data.dashboard === '/event-manager.html' && /Event Manager/.test(n.body), n && n.data);
  const EH = require(Path.join(FN, 'event-hub.js'));
  ck('the event-hub organizer gate now admits the approved organizer', !(await code(EH._internal.requireOrganizer('org1'))));
  const rej = { ...app, status: 'rejected' };
  await AL._internal.applyDecision('A1', rej, { decidedBy: 'adm' });
  ck('rejection revokes the role AND the claim', !(await get('users/org1')).roles.includes('event_organizer') && claims.org1.event_organizer === false && claims.org1.seller === true);
  ck('…and the organizer gate refuses again', (await code(EH._internal.requireOrganizer('org1'))) === 'permission-denied');

  /* ═══ AdminOS moderation ═══ */
  console.log('\n── AdminOS moderation ──');
  const adm = (op, data, c = { admin: true }) => EA._adminH[op]({ ...who('adm', c), data });
  for (const op of Object.keys(EA._adminH)) ck(`${op} refuses a plain user`, (await code(EA._adminH[op]({ ...who('u1'), data: { kind: 'venue', id: 'v1', decision: 'approve' } }))) === 'permission-denied');
  await db.doc('entVenues/v1').set({ uid: 'owner1', name: 'Hall', status: 'pending' });
  ck('pending venue listed for moderation', (await adm('entAdminListings', { kind: 'venue', status: 'pending' })).listings.some((l) => l.id === 'v1'));
  ck('approve pending → active', (await adm('entAdminSetListingStatus', { kind: 'venue', id: 'v1', decision: 'approve' })).to === 'active' && (await get('entVenues/v1')).status === 'active');
  ck('approve again refused (not pending)', (await code(adm('entAdminSetListingStatus', { kind: 'venue', id: 'v1', decision: 'approve' }))) === 'failed-precondition');
  ck('suspend without a reason refused', (await code(adm('entAdminSetListingStatus', { kind: 'venue', id: 'v1', decision: 'suspend' }))) === 'invalid-argument');
  ck('suspend with a reason', (await adm('entAdminSetListingStatus', { kind: 'venue', id: 'v1', decision: 'suspend', reason: 'complaints received' })).to === 'suspended');
  ck('restore suspended → active', (await adm('entAdminSetListingStatus', { kind: 'venue', id: 'v1', decision: 'restore', reason: 'resolved with owner' })).to === 'active');
  const audits = db._dump('adminAudit/').filter((a) => /^ent_listing_/.test(a.action));
  ck('every decision audited with who/before/after/reason/createdAt', audits.length === 3 && audits.every((a) => a.performedBy === 'adm' && a.before && a.after && a.createdAt && a.target && a.target.id === 'v1'), audits.length);
  const mx = await adm('entAdminMatrix', {});
  ck('matrix op returns categories + policies, no orphans', mx.categories.length === 5 && mx.orphans.length === 0 && mx.commercialPolicies.length >= 6);

  /* ═══ AdminOS wiring ═══ */
  console.log('\n── AdminOS wiring ──');
  global.window = global.window || globalThis;
  require(Path.join(ROOT, 'sokoni-aos-entertainment.js'));
  const OPS = globalThis.SokoniAOSEntertainment.OPS;
  const disp = fs.readFileSync(Path.join(FN, 'admin-os-dispatch.js'), 'utf8');
  const ES = require(Path.join(FN, 'event-settlement.js'));
  const handlers = { ...ES._adminH, ...EA._adminH };
  ck('every panel op is a dispatcher handler', OPS.every((o) => typeof handlers[o] === 'function'), OPS.filter((o) => !handlers[o]));
  ck('dispatcher merges both Entertainment registries', /events\._adminH/.test(disp) && /ent\._adminH/.test(disp));
  const aos = fs.readFileSync(Path.join(ROOT, 'sokoni-aos.js'), 'utf8');
  ck('panel ops are whitelisted in sokoni-aos.js', /SokoniAOSEntertainment\.OPS/.test(aos) && /entertainment:\s*\(\)\s*=>\s*_loadEntertainment\(\)/.test(aos));
  const html = fs.readFileSync(Path.join(ROOT, 'admin-os.html'), 'utf8');
  ck('admin-os.html loads the panel BEFORE sokoni-aos.js (whitelist is built at load)', html.indexOf('sokoni-aos-entertainment.js') > 0 && html.indexOf('sokoni-aos-entertainment.js') < html.indexOf('src="sokoni-aos.js"'));
  ck('admin-os.html has the Entertainment nav + panel + organizer filter', /data-section="entertainment"/.test(html) && /id="panel-entertainment"/.test(html) && /value="event_organizer"/.test(html));
  for (const f of ['admin.html', 'superadmin.html', 'super-admin.html']) {
    const p = Path.join(ROOT, f);
    if (!fs.existsSync(p)) { ck(`${f}: absent (nothing to leak into)`, true); continue; }
    const s = fs.readFileSync(p, 'utf8');
    ck(`${f}: carries NO Entertainment control (eventAdmin*/entAdmin*/event-settlement)`, !/eventAdmin|entAdmin|event-settlement|sokoni-aos-entertainment/.test(s));
  }

  /* ═══ checkout methods ═══ */
  console.log('\n── checkout methods ──');
  const cm = (purpose) => HC._internal.checkoutMethods({ ...who('buyer1'), data: { purpose } });
  let r = await cm('event_ticket');
  ck('nothing configured → M-PESA only, hosted false', r.hosted === false && r.hostedMethods.length === 0 && r.stk.method === 'M-PESA');
  await db.doc('config/hostedCheckout').set({ enabled: true, purposes: ['film_access'] });
  const PC = require(Path.join(FN, 'shared', 'payment-capability.js'));
  await db.doc('config/' + PC.RECORD).set({ methods: { 'CARD-PAYMENT': { status: 'LIVE_AND_PROVEN', evidence: { type: 'invoice', ref: 'INV1', at: Date.now(), by: 'adm' } } } });
  const proven = PC.provenHostedMethods((await get('config/' + PC.RECORD)));
  r = await cm('event_ticket');
  ck('enabled for film only → event_ticket still M-PESA only', r.hosted === false);
  await db.doc('config/hostedCheckout').set({ enabled: true, purposes: ['film_access', 'event_ticket'] });
  r = await cm('event_ticket');
  ck(`enabled for event_ticket + proven → hosted offered with ONLY the proven methods (${proven.join(',') || 'none proven in fixture'})`,
    proven.length ? (r.hosted === true && JSON.stringify(r.hostedMethods) === JSON.stringify(proven)) : r.hosted === false);
  ck('unauthenticated refused', (await code(HC._internal.checkoutMethods({ auth: null, data: { purpose: 'event_ticket' } }))) === 'unauthenticated');
  ck('malformed purpose refused', (await code(cm('Event Ticket!'))) === 'invalid-argument');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e && e.stack || e); process.exit(3); });
