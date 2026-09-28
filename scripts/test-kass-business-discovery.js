/* test-kass-business-discovery.js — Kass finds APPROVED businesses immediately through the canonical directory, and is
 * never an approver (C8: search_restaurants / search_stays / approve_seller; autoOnSellerApplication).
 *
 *   node scripts/test-kass-business-discovery.js                 # the fix — must PASS
 *   COUNTERPROOF=1 node scripts/test-kass-business-discovery.js  # index.js + automation-engine.js @ 4e9607b
 *
 * The SHIPPED handlers are executed — _execChatTool (public Kass) and executeTool (admin Kass) are sliced out of
 * functions/index.js exactly as scripts/test-kass-cart-truth.js does, and run in a vm sandbox; autoOnSellerApplication
 * is the real trigger handler. Firestore is the transactional fake (scripts/lib/fake-firestore-txn); firebase-admin /
 * functions are stubbed. No emulator, no network, no production, no AI call.
 *
 * PROVES
 *   K1  find_businesses("dj") returns an approved, eligible DJ the moment it exists — no index, no delay
 *   K2  …and never a suspended, a pending (unapproved), an unclassified or a hidden (isPublic:false) provider
 *   K3  location narrows; an unknown word gets an honest "couldn't tell" answer with no results
 *   K4  search_restaurants no longer returns a SUSPENDED food provider (the canonical gate), and still returns an
 *       eligible one (control)
 *   K5  search_stays returns an APPROVED hotel (it only read hotels/listings, which approval never writes)
 *   K6  admin Kass approve_seller REFUSES and writes nothing — neither flips an existing provider nor creates one
 *   K8  search_events reads the CANONICAL live events (status live, upcoming) — never the retired entEvents store
 *   K7  autoOnSellerApplication with the rule ENABLED and complete documents does NOT approve: the application goes
 *       under_review, no shop is written, no seller role is granted
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-kass-discovery';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
const fs = require('fs'), path = require('path'), vm = require('vm'), cp = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const CPM = !!process.env.COUNTERPROOF;
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const { stripComments } = require('./scan-legacy-wishlist.js');
const F = makeFakeFirestore({ clock: () => Date.now() });
const db = F.db;
const say = console.log;
console.log = console.info = console.warn = console.debug = () => {};

/* firebase-admin / functions stubs for the modules the handlers require */
const resolveIn = (m) => require.resolve(m, { paths: [FN] });
const stub = (m, exp) => { const p = m.startsWith('./') ? path.join(FN, m + '.js') : resolveIn(m); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
const CLAIMS = [];
const ADMIN = { apps: [{}], initializeApp: () => ({}), app: () => ({}),
  firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }),
  auth: () => ({ getUser: async (u) => ({ uid: u, customClaims: {} }), setCustomUserClaims: async (u, c) => { CLAIMS.push({ u, c }); } }) };
stub('firebase-admin', ADMIN);
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin/auth', { getAuth: () => ADMIN.auth() });
/* by DOCUMENT PATH — automation-engine registers six onDocumentCreated triggers; keeping only the last one invoked the
   wrong handler (autoOnApprovalRequest) */
const HANDLERS = {};
stub('firebase-functions/v2/firestore', { onDocumentCreated: (o, h) => { HANDLERS[o && o.document] = h; return h; }, onDocumentWritten: (_o, h) => h, onDocumentUpdated: (_o, h) => h });
stub('firebase-functions/v2/scheduler', { onSchedule: (_o, h) => h });
stub('firebase-functions/logger', { info() {}, warn() {}, error() {}, debug() {}, log() {} });
stub('firebase-functions/params', { defineSecret: (n) => ({ name: n, value: () => 'x' }) });

const read = (f) => (CPM ? cp.execFileSync('git', ['show', '4e9607b:functions/' + f], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6 }) : fs.readFileSync(path.join(FN, f), 'utf8'));
function sliceFunction(src, signature) {
  const bare = stripComments(src);
  const start = bare.indexOf(signature);
  if (start === -1) throw new Error('not found: ' + signature);
  let i = bare.indexOf('{', start), depth = 0;
  for (; i < bare.length; i++) { if (bare[i] === '{') depth++; else if (bare[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); } }
  throw new Error('unbalanced: ' + signature);
}
const SRC = read('index.js');
const fnRequire = (m) => require(m.startsWith('./') ? path.join(FN, m) : resolveIn(m));
const sandbox = vm.createContext({ db, admin: ADMIN, require: fnRequire, console: { log() {}, warn() {}, error() {} }, encodeURIComponent, Promise, Object, Array, JSON, Number, String, Date, Math });
/* Since the KASS auth fix, _execChatTool consults an explicit per-tool access map and only a VERIFIED caller reaches
   it (an invalid token is refused before any tool). Slice that gate when the source has it (the 4e9607b counterproof
   does not), and call as the signed-in customer that is the only real path to these tools. */
const _opt = (sig) => { try { return sliceFunction(SRC, sig); } catch (e) { return ''; } };
const _gate = [(SRC.match(/const KASS_GUEST_CHAT = [^;]+;/) || [''])[0],
  (SRC.match(/const _KASS_TOOL_ACCESS = Object\.freeze\(\{[\s\S]*?\}\);/) || [''])[0],
  _opt('function _kassToolAllowed(name, ctx)'), _opt('function _authRequired()')].join('\n');
vm.runInContext(_gate + '\n' + sliceFunction(SRC, 'async function _execChatTool') + '\nthis.__chat = _execChatTool;', sandbox);
vm.runInContext(sliceFunction(SRC, 'async function executeTool') + '\nthis.__admin = executeTool;', sandbox);

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 170) + ']' : '')); ok ? pass++ : fail++; };
async function chat(name, input) { const results = [], actions = []; const r = await sandbox.__chat(name, input, { uid: 'cust_1', addResult: (x) => results.push(x), addAction: (a) => actions.push(a) }); return { r, results, actions }; }
const names = (res) => res.results.map((x) => x.name);

const prov = (uid, o) => db.doc('providers/' + uid).set(Object.assign({ name: uid, status: 'active', searchable: true, isPublic: true, city: 'Nairobi' }, o));

(async () => {
  say('\nSOURCE: index.js / automation-engine.js @ ' + (CPM ? '4e9607b (before) — failures below ARE the defects' : 'working tree (fix)'));
  await prov('dj_ok', { name: 'DJ Bambino', category: 'dj', business: { category: 'artist_creator' } });
  await prov('dj_susp', { name: 'DJ Suspended', category: 'dj', status: 'suspended', business: { category: 'artist_creator' } });
  await prov('dj_pend', { name: 'DJ Pending', category: 'dj', status: 'pending_approval', searchable: false, isPublic: false, business: { category: 'artist_creator' } });
  await prov('dj_uncl', { name: 'DJ Unclassified', category: 'dj', business: { category: null } });
  await prov('dj_hidden', { name: 'DJ Hidden', category: 'dj', isPublic: false, business: { category: 'artist_creator' } });
  await prov('dj_ksm', { name: 'DJ Kisumu', category: 'dj', city: 'Kisumu', business: { category: 'artist_creator' } });
  await prov('food_ok', { name: 'Mama Pendo Kitchen', category: 'restaurant', business: { category: 'service_business' } });
  await prov('food_susp', { name: 'Closed Kitchen', category: 'restaurant', status: 'suspended', business: { category: 'service_business' } });
  await prov('hotel_ok', { name: 'Lake Hotel', category: 'hotel', business: { category: 'hotel' } });

  let k1 = null, k1e = null; try { k1 = await chat('find_businesses', { category: 'dj' }); } catch (e) { k1e = e.message; }
  const got = k1 ? names(k1) : [];
  ck('K1  find_businesses("dj") returns the approved DJ immediately', got.includes('DJ Bambino'), k1e || got);
  ck('K2  …never a suspended / pending / unclassified / hidden DJ', !!k1 && !got.some((n) => /Suspended|Pending|Unclassified|Hidden/.test(n)), got);
  let k3 = null, k3u = null; try { k3 = await chat('find_businesses', { category: 'dj', location: 'Kisumu' }); k3u = await chat('find_businesses', { category: 'xyzzy' }); } catch (_) {}
  ck('K3  location narrows; an unknown word is answered honestly with no results', !!k3 && JSON.stringify(names(k3)) === '["DJ Kisumu"]' && !!k3u && k3u.r.found === 0 && k3u.results.length === 0,
    k3 ? { kisumu: names(k3), unknown: k3u && k3u.r.message } : 'no find_businesses tool');

  const k4 = await chat('search_restaurants', {});
  ck('K4  search_restaurants never returns a SUSPENDED food provider; an eligible one still appears (control)',
    !names(k4).includes('Closed Kitchen') && names(k4).includes('Mama Pendo Kitchen'), names(k4));

  const k5 = await chat('search_stays', { type: 'hotel' });
  ck('K5  search_stays returns an APPROVED hotel', names(k5).includes('Lake Hotel'), names(k5));

  await prov('seller_x', { name: 'Suspended Seller', status: 'suspended', business: { category: 'trades' } });
  const r6a = await sandbox.__admin('approve_seller', { sellerId: 'seller_x', approve: true, note: 'x' });
  const r6b = await sandbox.__admin('approve_seller', { sellerId: 'brand_new_id', approve: true });
  const sx = (await db.doc('providers/seller_x').get()).data();
  const created = (await db.doc('providers/brand_new_id').get()).exists;
  ck('K6  approve_seller REFUSES and writes nothing (no status flip, no new provider doc)',
    sx.status === 'suspended' && !created && !!(r6a && r6a.refused) && !!(r6b && r6b.refused), { status: sx.status, created, r: r6a });

  /* K7 — the real trigger; rule enabled with auto-approval on, application complete */
  let AE, loadErr = null, tmp = null;
  try {
    let file = path.join(FN, 'automation-engine.js');
    if (CPM) { tmp = path.join(FN, '.cp-' + process.pid + '-automation-engine.js'); fs.writeFileSync(tmp, read('automation-engine.js')); file = tmp; }
    AE = require(file);
  } catch (e) { loadErr = e.message; } finally { if (tmp) { try { fs.unlinkSync(tmp); } catch (_) {} } }
  const TRIGGER = HANDLERS['sellerApplications/{appId}'];
  if (loadErr || !TRIGGER) { ck('K7  autoOnSellerApplication does not approve', false, 'could not load the trigger: ' + loadErr); }
  else {
    await db.doc('automationRules/seller_application').set({ enabled: true, autoApproveStandardDocs: true });
    await db.doc('sellerApplications/sa1').set({ userId: 'u_sa1', businessName: 'Kona Shop', phone: '0712000000', idDocumentUrl: 'https://x/id.jpg' });
    const ref = db.doc('sellerApplications/sa1');
    await TRIGGER({ params: { appId: 'sa1' }, data: { data: () => ({ userId: 'u_sa1', businessName: 'Kona Shop', phone: '0712000000', idDocumentUrl: 'https://x/id.jpg' }), ref } });
    const app = (await ref.get()).data();
    const shop = (await db.doc('shops/u_sa1').get()).exists;
    ck('K7  autoOnSellerApplication (rule ENABLED, docs complete) does NOT approve: under_review, no shop, no seller claim',
      app.status === 'under_review' && !shop && !CLAIMS.some((c) => c.u === 'u_sa1'), { status: app.status, shop, claims: CLAIMS.length });
  }

  /* K8 — search_events reads the CANONICAL live events, never the retired entEvents store */
  const soon = new Date(Date.now() + 5 * 864e5).toISOString(), past = new Date(Date.now() - 5 * 864e5).toISOString();
  await db.doc('events/ev_live').set({ title: 'Live Gig', status: 'live', startDate: soon, city: 'Nairobi', venue: 'KICC', category: 'music' });
  await db.doc('events/ev_draft').set({ title: 'Draft Gig', status: 'draft', startDate: soon, city: 'Nairobi' });
  await db.doc('events/ev_past').set({ title: 'Past Gig', status: 'live', startDate: past, city: 'Nairobi' });
  await db.doc('entEvents/legacy1').set({ title: 'Legacy Gig', status: 'published', date: soon.slice(0, 10), city: 'Nairobi' });
  let k8 = null, k8e = null; try { k8 = await chat('search_events', { location: 'Nairobi' }); } catch (e) { k8e = e.message; }
  const evNames = k8 ? names(k8) : [];
  ck('K8  search_events returns only LIVE upcoming canonical events (no draft, past or legacy entEvents), linked to the event hub',
    JSON.stringify(evNames) === '["Live Gig"]' && !!k8 && k8.results.every((x) => /^event-hub\.html\?event=/.test(x.url)), k8e || { names: evNames, urls: k8 && k8.results.map((x) => x.url) });

  say(`\n${pass} passed, ${fail} failed`);
  if (CPM) say('(counter-proof: failures here ARE the defects; K4 includes a control)');
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
