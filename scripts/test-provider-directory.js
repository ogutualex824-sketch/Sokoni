/* test-provider-directory.js — ONE public provider directory, server-decided (CHANGELOG 244, convergence C3a-2).
 * Transactional fake Firestore + the REAL functions/provider-directory.js, business-category.js,
 * discovery-eligibility.js, provider-onboarding.js (providerSearchProviders) and provider-dispatch.js routing; the REAL
 * providers.html / provider-profile.html + sokoni-providers.js in Chromium (page harness). No network.
 *
 * PROVES
 *   eligibility  listed ONLY when business-category.publicEligibility says so: an approved, CLASSIFIED provider is;
 *                legacy-unclassified, pending, suspended (status or flag), not-searchable and not-public ones are not —
 *                in the list AND by id
 *   one gate     for every fixture the directory and the search-index gate (discovery-eligibility, C3a-1) agree
 *   category     the SERVER's C1 category, never the free-text one; a C1 filter returns only that category; the
 *                integrated authorities (healthcare's own category, the Legal authority) are found under theirs;
 *                an unknown category is REFUSED (UNKNOWN_CATEGORY), never widened
 *   projection   exactly the whitelist — no phone / email / owner / internal field, no self-declared `featured`, a
 *                rating only with repV, only an https photo, markup stripped
 *   ops          providerDirectory is routed by providerDispatch; providerSearchProviders answers from the same
 *                directory with its old response keys, refusing an unknown category
 *   pages        providers.html renders ONLY the server's cards, with no raw browser read of providers /
 *                providerProfiles and no WhatsApp link; a stale pre-244 last-good copy (raw documents) is deleted,
 *                never rendered; provider-profile.html shows an eligible provider and "not available" for one the
 *                server does not list
 *   retired      the realtime.js hub bridge and the services.html raw listener no longer read providers; the search
 *                fallback's providers spec asks the server directory
 *
 *   node scripts/test-provider-directory.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-provider-directory';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
const fs = require('fs');
const Path = require('path');
const ROOT = Path.resolve(__dirname, '..');
const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() });
const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : require.resolve(m, { paths: [FN] }); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }), auth: () => ({}) });
stub('firebase-admin/auth', { getAuth: () => ({}) });
const PD = require(Path.join(FN, 'provider-directory.js'));
const DE = require(Path.join(FN, 'discovery-eligibility.js'));
const PO = require(Path.join(FN, 'provider-onboarding.js'))._h;
const { makePageHarness } = require('./lib/page-harness.js');

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 180) + ']' : '')); ok ? pass++ : fail++; };
const req = (data) => ({ auth: null, data: data || {}, rawRequest: { headers: {} } });
const code = async (p) => { try { await p; return null; } catch (e) { return (e.details && e.details.code) || e.code || e.message; } };
const PRIVATE = { phone: '0722000111', phoneNumber: '+254722000111', email: 'private@x.co', ownerName: 'Owner Person', sourceApplicationId: 'app1', adminNote: 'internal' };
const biz = (category, extra) => Object.assign({ status: 'active', name: 'Biz', business: { category, source: 'application', lane: { hub: 'provider', entClass: null } } }, PRIVATE, extra || {});
const WHITELIST = ['uid', 'providerId', 'name', 'businessName', 'category', 'categoryLabel', 'displayCategory', 'serviceType', 'description', 'location', 'city', 'skills', 'rate', 'rateType', 'photo', 'verified', 'available', 'acceptsBookings', 'chatEnabled', 'rating', 'reviewCount', 'followerCount', 'jobsCompleted', 'profilePending'];
const dir = (data) => PD._h.providerDirectory(req(data));

(async () => {
  const P = (uid, doc) => db.doc('providers/' + uid).set(doc);
  await P('plumber', biz('trades', { name: 'Paul Plumbing', category: 'hotel', serviceType: 'Luxury hotel', featured: true, rating: 4.9, reviewCount: 12, photo: 'https://cdn.x/p.jpg', rate: 1500, rateType: 'per job', skills: ['pipes'] }));
  await P('rated', biz('trades', { name: 'Rated Repairs <script>x</script>', repV: 1, rating: 4.26, reviewCount: 3, photo: 'javascript:alert(1)', verified: true }));
  await P('cleaner', biz('cleaning', { name: 'Clean Co' }));
  await P('legacy1', Object.assign({ status: 'active', name: 'Old Legacy', category: 'Plumbing' }, PRIVATE));
  await P('pend1', biz('trades', { status: 'pending', name: 'Pending P' }));
  await P('susp1', biz('trades', { status: 'suspended', name: 'Susp S' }));
  await P('suspFlag', biz('trades', { suspended: true, name: 'Flag F' }));
  await P('hidden', biz('trades', { searchable: false, name: 'Hidden H' }));
  await P('priv1', biz('trades', { isPublic: false, name: 'Private P' }));
  await P('doc1', Object.assign({ status: 'active', name: 'Dr One', healthcare: { category: 'clinician', source: 'application' } }, PRIVATE));
  await P('law1', Object.assign({ status: 'active', name: 'Advocate L', legalProviderId: 'law1', provisionedBy: 'legal-verification' }, PRIVATE));
  const INELIGIBLE = ['legacy1', 'pend1', 'susp1', 'suspFlag', 'hidden', 'priv1'];

  say('\n── eligibility: the server decides ──');
  const all = await dir({});
  const ids = all.providers.map((p) => p.uid).sort();
  ck('the list holds ONLY approved, classified providers (healthcare + Legal authorities included)', ids.join() === 'cleaner,doc1,law1,plumber,rated', ids);
  for (const u of INELIGIBLE) ck(`${u} → not listed, and by id → null`, !ids.includes(u) && (await dir({ providerId: u })).provider === null);
  ck('an eligible provider by id → its card', (await dir({ providerId: 'plumber' })).provider.category === 'trades');
  ck('a missing provider by id → null (a real answer, not an error)', (await dir({ providerId: 'nobody' })).provider === null);
  ck('an unsafe id is REFUSED', await code(dir({ providerId: 'a/b' })) === 'invalid-argument' && await code(dir({ providerId: '' })) === 'invalid-argument');

  say('\n── one gate: directory == search-index gate ──');
  const agree = [];
  for (const u of ['plumber', 'rated', 'cleaner', 'doc1', 'law1'].concat(INELIGIBLE)) {
    const d = (await db.doc('providers/' + u).get()).data();
    const idx = await DE.prepareForIndex(db, 'providers', u, d);
    const card = PD.cardIfEligible(u, d);
    agree.push(!!idx === !!card && (!idx || idx.category === card.category));
  }
  ck('for every fixture the directory and discovery-eligibility.prepareForIndex agree (listed ⇔ indexed, same category)', agree.every(Boolean), agree);

  say('\n── category: C1 only ──');
  const pl = all.providers.find((p) => p.uid === 'plumber');
  ck('listed under the SERVER category (trades), not its free-text "hotel"', pl.category === 'trades' && pl.categoryLabel && pl.displayCategory === 'hotel', { c: pl.category, d: pl.displayCategory });
  ck('a trades filter returns only trades', (await dir({ category: 'trades' })).providers.map((p) => p.uid).sort().join() === 'plumber,rated');
  ck('a hotel filter does not return the plumber who calls itself a hotel', (await dir({ category: 'hotel' })).providers.length === 0);
  ck('healthcare\'s own category and the Legal authority are found under theirs', (await dir({ category: 'clinician' })).providers.map((p) => p.uid).join() === 'doc1' && (await dir({ category: 'lawyer' })).providers.map((p) => p.uid).join() === 'law1');
  /* DISCRIMINATING: a provider the SECONDARY (healthcare) query fetches for 'clinician', but whose server category is
     trades (business.category wins in categoryOf) — only the post-query category check keeps it off the Clinician list.
     Created here and removed below so no other assertion's population changes. */
  await P('dual1', biz('trades', { name: 'Dual Stamp', healthcare: { category: 'clinician', source: 'application' } }));
  const clin = (await dir({ category: 'clinician' })).providers.map((p) => p.uid);
  const trd = (await dir({ category: 'trades' })).providers.find((p) => p.uid === 'dual1');
  ck('a provider fetched by the healthcare query but classified trades is NOT listed as a clinician — it is listed under trades',
    clin.join() === 'doc1' && !!trd && trd.category === 'trades', { clinician: clin, tradesCard: trd && trd.category });
  await db.doc('providers/dual1').delete();
  ck('an unknown category is REFUSED, never widened to all', await code(dir({ category: 'Plumbing' })) === 'UNKNOWN_CATEGORY' && await code(dir({ category: 'laundry' })) === 'UNKNOWN_CATEGORY');
  ck('the reply names the C1 categories', all.categories.length === 25 && all.categories.every((c) => c.id && c.label));

  say('\n── projection: a whitelist ──');
  ck('every card carries EXACTLY the whitelist', all.providers.every((c) => Object.keys(c).sort().join() === WHITELIST.slice().sort().join()) && PD.PUBLIC_FIELDS.slice().sort().join() === WHITELIST.slice().sort().join());
  const blob = JSON.stringify(all);
  ck('no phone, email, owner or internal field anywhere', !/0722000111|254722000111|private@x\.co|Owner Person|app1|internal/.test(blob));
  ck('no self-declared `featured` is carried', all.providers.every((c) => !('featured' in c)));
  const rt = all.providers.find((p) => p.uid === 'rated');
  ck('a rating only with repV (the underived 4.9 is dropped; the derived one is rounded)', pl.rating === null && pl.reviewCount === 0 && rt.rating === 4.3 && rt.reviewCount === 3);
  ck('only an https photo; markup stripped from the name', pl.photo === 'https://cdn.x/p.jpg' && rt.photo === '' && !/[<>]/.test(rt.name));
  ck('verified first in the order', all.providers[0].uid === 'rated');

  say('\n── ops: routing and the old search op ──');
  const disp = fs.readFileSync(Path.join(FN, 'provider-dispatch.js'), 'utf8');
  ck('providerDispatch routes providerDirectory to provider-directory._h', /'providerDirectory',/.test(disp) && /require\('\.\/provider-directory'\)\._h/.test(disp));
  const s1 = await PO.providerSearchProviders(req({ category: 'trades' }));
  ck('providerSearchProviders answers from the directory — eligible trades only, old keys kept', s1.providers.map((p) => p.name).sort().join('|') === 'Paul Plumbing|Rated Repairs scriptx/script' && s1.count === 2
    && Object.keys(s1.providers[0]).sort().join() === 'category,coverage,featured,name,pricing,profilePhotoUrl,providerId,rating,reviewCount,subcategory,verified', s1.providers.map((p) => p.name));
  ck('…refuses an unknown category', await code(PO.providerSearchProviders(req({ category: 'Plumbing' }))) === 'UNKNOWN_CATEGORY');
  ck('…never lists an ineligible provider, whatever it wrote', !(await PO.providerSearchProviders(req({}))).providers.some((p) => /Old Legacy|Pending|Susp|Flag|Hidden|Private/.test(p.name)));

  say('\n── retired browser paths ──');
  const rtSrc = fs.readFileSync(Path.join(ROOT, 'realtime.js'), 'utf8');
  ck('realtime.js: the hub bridge no longer reads providers', /async function _listenProviders\(hub\) \{ return; \}/.test(rtSrc) && !/collection\(db, 'providers'\)/.test(rtSrc));
  const svc = fs.readFileSync(Path.join(ROOT, 'services.html'), 'utf8');
  ck('services.html: the raw providers listener is gone', !/SokoniDB\.listenProviders\(/.test(svc));
  const fss = fs.readFileSync(Path.join(ROOT, 'sokoni-firestore-search.js'), 'utf8');
  ck('search fallback: the providers spec asks the server directory, with no browser status guard',
    /col: 'providers',[^\n]*remote: 'providerDirectory'/.test(fss) && !/col: 'providers'[^}]*guard:/.test(fss) && /spec\.remote \? await runRemote\(spec\)/.test(fss));
  const sp = fs.readFileSync(Path.join(ROOT, 'sokoni-providers.js'), 'utf8');
  ck('sokoni-providers.js makes no Firestore read of its own', !/getDocs|getDoc\(|m\.collection|firebase-firestore\.js/.test(sp));

  say('\n── pages: only the server\'s cards ──');
  const reads = [];
  const spyDb = { doc: (p) => { reads.push(String(p).split('/')[0]); return db.doc(p); }, collection: (c) => { reads.push(String(c)); return db.collection(c); } };
  const HAR = makePageHarness({ db: spyDb, root: ROOT, callables: { providerDispatch: { providerDirectory: PD._h.providerDirectory } } });
  await HAR.start();
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  try {
    const ghost = JSON.stringify({ at: Date.now(), providers: [{ uid: 'ghost', id: 'ghost', name: 'Ghost Legacy', phone: '0711999888', categories: [], skills: [] }] });
    const pg = await HAR.page(browser, { user: null, storage: { sokoniProvidersLastGood: ghost } });
    await pg.goto(HAR.BASE + '/providers.html');
    await pg.waitForFunction(() => document.querySelectorAll('[id^="pv-card-"]').length > 0, null, { timeout: 15000 }).catch(() => {});
    const r = await pg.evaluate(() => ({ cards: [...document.querySelectorAll('[id^="pv-card-"]')].map((c) => c.id.replace('pv-card-', '')).sort(), html: document.body.innerHTML,
      wa: !!document.querySelector('a[href*="wa.me"]'), v1: localStorage.getItem('sokoniProvidersLastGood'), v2: localStorage.getItem('sokoniProvidersLastGood.v2') }));
    ck('providers.html renders exactly the server\'s eligible providers', r.cards.join() === 'cleaner,doc1,law1,plumber,rated', r.cards);
    ck('…with no WhatsApp link and no phone number', !r.wa && !/0722000111|0711999888/.test(r.html));
    ck('…the stale pre-244 copy (raw documents) is deleted, never rendered', r.v1 === null && !/Ghost Legacy/.test(r.html) && /plumber/.test(r.v2 || ''));
    ck('…and the page made NO raw read of providers / providerProfiles', !reads.some((c) => c === 'providers' || c === 'providerProfiles'), [...new Set(reads)]);
    ck('…through the directory op', HAR.calls.some((c) => c === 'providerDispatch:providerDirectory'));
    await pg.__ctx.close();

    for (const [uid, want] of [['plumber', 'Paul Plumbing'], ['legacy1', null], ['priv1', null]]) {
      const pp = await HAR.page(browser, { user: null });
      await pp.goto(HAR.BASE + '/provider-profile.html?uid=' + uid);
      await pp.waitForFunction(() => document.querySelector('.pp-name') || /not available/i.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
      const t = await pp.evaluate(() => ({ name: (document.querySelector('.pp-name') || {}).textContent || null, na: /Provider not available/i.test(document.body.innerText) }));
      ck(want ? `provider-profile: an eligible provider (${uid}) is shown` : `provider-profile: ${uid} (not listed by the server) → "not available"`, want ? t.name === want : (t.name === null && t.na), t);
      await pp.__ctx.close();
    }
  } finally { await browser.close(); HAR.stop(); }

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
