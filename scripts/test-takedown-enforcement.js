#!/usr/bin/env node
/* test-takedown-enforcement.js — TAKEDOWN / HIDDEN PRODUCT enforcement, end to end (owner spec 2026-10-01, §26 §27 §33)
 *
 *   node scripts/test-takedown-enforcement.js                       # working tree — must PASS
 *   SABOTAGE=<name> node scripts/test-takedown-enforcement.js       # one fault injected into a TEMP COPY (never the tree)
 *   node scripts/test-takedown-enforcement.js --failure-injection   # every fault, one at a time: each must fail its NAMED
 *                                                                   # row; the tree's files are hashed before and after
 *
 * The REAL functions code — trust-safety.js, product-visibility.js, algolia-sync.js, typesense-sync.js, algolia-queue.js,
 * typesense-queue.js, search-service.js (+ search-sync.js registry), algolia-recommend.js, api-gateway.js, minishop.js,
 * pos-marketplace-sync.js, marketplace-extensions.js, and the KASS tools + generateTrending EXTRACTED from index.js —
 * runs on the transactional fake Firestore (scripts/lib/fake-firestore-txn.js, strict read order) with two FAKE search
 * engines behind a fake `https` module (Algolia sokoni_products + Typesense sokoni_products). A fake queue processor
 * applies algoliaQueue / typesenseQueue items to those engines, so the index path under test is the real one:
 * trigger → enqueue (guard) → queue → engine.
 *
 * NO PRODUCTION, NO NETWORK, NO EMULATOR. TRIPWIRES (incident 2026-10-01): `./notify` THROWS on require; the real
 * `firebase-admin` is NEVER loaded — every require of it receives an in-memory stub bound to the fake Firestore; any real
 * http/https socket THROWS. Row Z1 asserts all three held (no real firebase-admin / notify module in require.cache, and
 * the stub was what the modules received).
 *
 * Rules rows (seller hidden=false, moderationStatus=approved, active=true, direct product get) live in the rules suite
 * C:/temp/sok-takedown-rules/scripts/test-takedown-rules.js (K1–K15 + served-ruleset control C1–C4).
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process'), Module = require('module'), crypto = require('crypto');
const { EventEmitter } = require('events');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');

const FILES = ['product-visibility.js', 'trust-safety.js', 'algolia-sync.js', 'typesense-sync.js', 'algolia-queue.js', 'typesense-queue.js',
  'algolia-indexer.js', 'algolia-sanitize.js', 'search-terms.js', 'typesense-client.js', 'search-service.js', 'search-sync.js',
  'algolia-recommend.js', 'api-gateway.js', 'minishop.js', 'minishop-config-schema.js', 'pos-marketplace-sync.js',
  'marketplace-extensions.js', 'moderation-media.js', 'index.js'];

/* ── failure injection: each fault, the exact text it replaces, and the NAMED row that must catch it ── */
const SABOTAGES = {
  'gate-ignores-hold':          { file: 'product-visibility.js', catch: 'V2',
    from: "  if (p.moderationHold != null) return { visible: false, reason: 'moderation_hold' };\n", to: '' },
  'search-no-recheck':          { file: 'search-service.js', catch: 'X1',
    from: "async function _gateResult(kind, req, r) {\n  if (!r || typeof r !== 'object') return r;", to: 'async function _gateResult(kind, req, r) {\n  return r;' },
  'recs-no-recheck':            { file: 'algolia-recommend.js', catch: 'X3',
    from: 'results: await _gateRecommendations(requests, result.results) };', to: 'results: result.results };' },
  'gateway-no-filter':          { file: 'api-gateway.js', catch: 'G2',
    from: 'const ok = _visibility.isPubliclyVisible(d.data()) && (!keep || keep(d));', to: 'const ok = true;' },
  'minishop-no-filter':         { file: 'minishop.js', catch: 'SH2',
    from: '.filter(d => _visibility.isPubliclyVisible(d.data()))', to: '.filter(d => true)' },
  'kass-no-filter':             { file: 'index.js', catch: 'K2',
    from: '          if (!_visibility.isPubliclyVisible(d.data())) return false;\n', to: '' },
  'queue-guard-removed':        { file: 'algolia-queue.js', catch: 'B1',
    from: "  if (collection === 'products' && operation !== 'delete' && data && (data.isVisible === false || data.moderationHold != null)) {",
    to: '  if (false) {' },
  'restore-ignores-enforcement': { file: 'trust-safety.js', catch: 'R2', from: '      if (other.length) {', to: '      if (false) {' },
  'restore-no-admin':           { file: 'trust-safety.js', catch: 'A1',
    from: 'exports.tsReviewReport = onCall(OPT, async (req) => {\n  _requireAdmin(req);',
    to: "exports.tsReviewReport = onCall(OPT, async (req) => {\n  if (!req.auth) throw new HttpsError('unauthenticated', 'sign in');" },
  'promo-not-paused':           { file: 'trust-safety.js', catch: 'P1',
    from: '          for (const d of promos) {\n            tx.update(d.ref, { status: PROMO_PAUSED', to: '          for (const d of []) {\n            tx.update(d.ref, { status: PROMO_PAUSED' },
  'hold-leaks-reporter':        { file: 'trust-safety.js', catch: 'PR1',
    from: 'moderationHold: { active: true, ref: holdRef,', to: 'moderationHold: { active: true, ref: holdRef, reportId, by: uid, reason: report.reason || null,' },
  'clickcollect-no-gate':       { file: 'pos-marketplace-sync.js', catch: 'CC1',
    from: "|| !require('./product-visibility').isPubliclyVisible(pd))", to: '|| false)' },
  'trending-no-filter':         { file: 'index.js', catch: 'TR1',
    from: '.filter(d => _visibility.isPubliclyVisible(d.data())).slice(0, 20)', to: '.slice(0, 20)' },
  /* the trigger-level skip (algolia-sync / typesense-sync) is a REDUNDANT layer in front of the enqueue guard, so a fault
     in it alone is not observable end to end — it is caught by test-moderation-queue E1–E3 (enqueue stubbed). */
  'ts-queue-guard-removed':     { file: 'typesense-queue.js', catch: 'B1',
    from: "  if (collection === 'products' && operation !== 'delete' && data && (data.isVisible === false || data.moderationHold != null)) {",
    to: '  if (false) {' },
  'seo-no-gate':                { file: 'marketplace-extensions.js', catch: 'SEO1',
    from: "      if (col === 'products' && !require('./product-visibility').isPubliclyVisible(d)) break;\n", to: '' },
  'restore-not-canonical':      { file: 'trust-safety.js', catch: 'R3',
    from: "      tx.set(pref, { isVisible: prior, moderationHold: FieldValue.delete(),", to: "      tx.set(pref, { isVisible: prior," },
};

if (process.argv.includes('--failure-injection')) {
  const hash = () => FILES.map((f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(FN, f))).digest('hex')).join(',');
  const before = hash(); let ok = true;
  for (const [name, s] of Object.entries(SABOTAGES)) {
    const r = cp.spawnSync(process.execPath, [__filename], { env: Object.assign({}, process.env, { SABOTAGE: name }), encoding: 'utf8', maxBuffer: 64e6 });
    const out = (r.stdout || '') + (r.stderr || '');
    const applied = !/SABOTAGE NOT APPLIED/.test(out);
    const caught = new RegExp('^  FAIL  ' + s.catch + ' ', 'm').test(out);
    const pass = applied && caught && r.status === 1;
    if (!pass) ok = false;
    console.log(`  ${pass ? 'CAUGHT ' : 'MISSED '} ${name.padEnd(30)} → ${s.catch}${applied ? '' : '  (sabotage did not apply — harness fails closed)'}${caught ? '' : '  (named row did not fail)'}  exit=${r.status}`);
  }
  const after = hash();
  console.log(`  tree unchanged after injection: ${before === after ? 'YES' : 'NO'}`);
  console.log(ok && before === after ? '\nFAILURE INJECTION: all caught, all restored' : '\nFAILURE INJECTION: FAILED');
  process.exit(ok && before === after ? 0 : 1);
}

/* ── the copy of the functions closure under test (sabotage applied to ONE file, never the tree) ── */
const SAB = process.env.SABOTAGE || null;
const say = console.log; console.log = console.info = console.warn = console.debug = console.error = () => {};
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'takedown-'));
for (const f of FILES) {
  let text = fs.readFileSync(path.join(FN, f), 'utf8');
  if (SAB) {
    const s = SABOTAGES[SAB];
    if (!s) { say('UNKNOWN SABOTAGE ' + SAB); process.exit(2); }
    if (s.file === f) {
      const t2 = text.replace(/\r\n/g, '\n');
      if (t2.split(s.from).length !== 2) { say('SABOTAGE NOT APPLIED: ' + SAB); process.exit(3); }
      text = t2.replace(s.from, () => s.to);
      say(`\nSABOTAGE ${SAB} applied to a temp copy of ${f}`);
    }
  }
  fs.writeFileSync(path.join(TMP, f), text);
}

let pass = 0, fail = 0;
const ck = (n, ok, d) => { if (ok) { pass++; say('  PASS  ' + n); } else { fail++; say('  FAIL  ' + n + (d !== undefined ? '   ' + JSON.stringify(d).slice(0, 500) : '')); } };

/* ── the fake world ── */
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now(), strictReadOrder: true });
const db = F.db;
class HttpsError extends Error { constructor(c, m, d) { super(m); this.code = c; this.details = d; } }
const adminStub = { __stub: true, apps: [{}], initializeApp() {}, app() { return {}; },
  firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }),
  auth: () => ({ verifyIdToken: async () => { throw new Error('no auth in tests'); }, getUser: async () => ({}) }),
  messaging: () => ({}), storage: () => ({}) };
let adminStubServed = 0;
const SECRETS = { ALGOLIA_SEARCH_KEY: 'k', ALGOLIA_ADMIN_KEY: 'k', TYPESENSE_SEARCH_KEY: 'k', TYPESENSE_ADMIN_KEY: 'k' };
process.env.ALGOLIA_APP_ID = 'TESTAPP'; process.env.TYPESENSE_HOST = 'ts.invalid'; process.env.TYPESENSE_PORT = '443';
delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET; delete process.env.FUNCTIONS_EMULATOR;

/* fake engines: Map objectID → record */
const ENG = { algolia: new Map(), typesense: new Map() };
const recOf = (id, d) => ({ objectID: id, id, name: d.name || '', category: d.category || '', status: d.status || 'active', price: d.price || 0,
  createdAt: d.createdAt || 0 });
function engineQuery(map, { q, category, page, per }) {
  let rows = [...map.values()].filter((r) => r.status === 'active');
  if (q && q !== '*') rows = rows.filter((r) => (r.name + ' ' + r.category).toLowerCase().includes(q.toLowerCase()));
  if (category) rows = rows.filter((r) => r.category === category);
  rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return { total: rows.length, hits: rows.slice(page * per, page * per + per) };
}
const fakeHttps = {
  request(opts, cb) {
    let body = '';
    const req = new EventEmitter();
    req.setTimeout = () => req; req.destroy = () => {}; req.write = (b) => { body += b; };
    req.end = () => setImmediate(() => {
      const out = route(opts, body ? JSON.parse(body) : null);
      const res = new EventEmitter(); res.statusCode = out.status;
      cb(res); res.emit('data', Buffer.from(JSON.stringify(out.body))); res.emit('end');
    });
    return req;
  },
};
function route(opts, body) {
  const p = opts.path || '';
  let m;
  if ((m = p.match(/^\/1\/indexes\/([^/]+)\/query$/))) {
    const catm = String((body && body.filters) || '').match(/category:"([^"]+)"/);
    const r = engineQuery(ENG.algolia, { q: body.query, category: catm && catm[1], page: body.page || 0, per: body.hitsPerPage || 20 });
    return { status: 200, body: { hits: r.hits, nbHits: r.total, page: body.page || 0, nbPages: Math.ceil(r.total / (body.hitsPerPage || 20)) } };
  }
  if (p === '/1/indexes/*/queries') {
    return { status: 200, body: { results: body.requests.map((rq) => ({ hits: rq.indexName === 'sokoni_products' ? engineQuery(ENG.algolia, { q: rq.query, page: 0, per: 20 }).hits : [] })) } };
  }
  if (p === '/1/indexes/*/recommendations') {
    return { status: 200, body: { results: body.requests.map((rq) => ({ hits: [...ENG.algolia.values()].filter((r) => r.objectID !== rq.objectID) })) } };
  }
  if ((m = p.match(/^\/collections\/([^/]+)\/documents\/search\?(.*)$/))) {
    const qs = new URLSearchParams(m[2]);
    const catm = String(qs.get('filter_by') || '').match(/category:=\[?`?([^`\]&]+)/);
    const per = Number(qs.get('per_page') || 20), page = Number(qs.get('page') || 1) - 1;
    const r = engineQuery(ENG.typesense, { q: qs.get('q'), category: catm && catm[1], page, per });
    return { status: 200, body: { hits: r.hits.map((d) => ({ document: d })), found: r.total, request_params: { per_page: per } } };
  }
  return { status: 404, body: { message: 'fake engine: no route ' + p } };
}
/* the queue processor stand-in: applies the REAL enqueued items to the fake engines */
async function processQueues() {
  for (const [col, eng] of [['algoliaQueue', ENG.algolia], ['typesenseQueue', ENG.typesense]]) {
    const snap = await db.collection(col).get();
    for (const d of snap.docs) {
      const it = d.data();
      if (it.collection !== 'products') { await d.ref.delete(); continue; }
      if (it.operation === 'delete') eng.delete(it.docId); else eng.set(it.docId, recOf(it.docId, it.data || {}));
      await d.ref.delete();
    }
  }
}

const origReq = Module.prototype.require;
const noop = () => {};
const logger = { info: noop, warn: noop, error: noop, debug: noop, log: noop, write: noop };
Module.prototype.require = function (id) {
  if (id === './notify' || /[\\/]notify(\.js)?$/.test(id)) throw new Error('TRIPWIRE: notify.js required from a test');
  if (id === 'firebase-admin') { adminStubServed++; return adminStub; }
  if (id === 'firebase-admin/app' || id === 'firebase-admin/auth' || id === 'firebase-admin/messaging') throw new Error('TRIPWIRE: real firebase-admin submodule ' + id);
  if (id === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath };
  if (id === 'https' || id === 'http') return fakeHttps;
  if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => (h || _o), onRequest: (_o, h) => (h || _o), HttpsError };
  if (id === 'firebase-functions/v2/firestore') { const t = (_o, h) => h; return { onDocumentCreated: t, onDocumentUpdated: t, onDocumentDeleted: t, onDocumentWritten: t }; }
  if (id === 'firebase-functions/v2/scheduler') return { onSchedule: (_o, h) => (h || _o) };
  if (id === 'firebase-functions/params') return { defineSecret: (n) => ({ name: n, value: () => SECRETS[n] || 'k' }), defineString: (n) => ({ name: n, value: () => '' }), defineInt: () => ({ value: () => 0 }) };
  if (id === 'firebase-functions/logger') return logger;
  if (id === 'firebase-functions/v2') return { logger, https: { onRequest: (_o, h) => (h || _o), onCall: (_o, h) => (h || _o), HttpsError } };
  if (id === 'firebase-functions') return { logger, https: { HttpsError } };
  if (id === '@anthropic-ai/sdk') return function Anthropic() {};
  if (id === './kasshop') return { publicShopState: async () => ({ open: true }) };
  if (id === './pickup-location') return { ensureDeliveryPickup: async () => ({}) };
  if (id === './pos-audit') return { writeAudit: async () => {} };
  return origReq.apply(this, arguments);
};
const L = (f) => require(path.join(TMP, f));

const codeOf = async (p) => { try { await p; return null; } catch (e) { return e.code || e.message; } };
const tryv = async (p) => { try { return await p; } catch (e) { return { error: e.code || e.message, details: e.details }; } };
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const as = (uid, data, token) => ({ auth: uid ? { uid, token: token || {} } : null, data, rawRequest: {} });
const ADMIN = { admin: true }, SUPER = { superAdmin: true };
const opaque = (id) => crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 16);

/* HTTP stand-ins for onRequest handlers */
function fakeRes() {
  const r = { statusCode: 200, headers: {}, body: null };
  r.set = (k, v) => { r.headers[k.toLowerCase()] = v; return r; };
  r.setHeader = r.set; r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; }; r.send = (b) => { r.body = b; return r; }; r.end = () => r;
  return r;
}
async function gw(pathname, query) {
  const res = fakeRes();
  await GW.sokoniAPIGateway({ method: 'GET', path: pathname, url: pathname, originalUrl: pathname, headers: { origin: 'https://mysokoni.co.ke' },
    query: query || {}, ip: '10.0.0.1', socket: { remoteAddress: '10.0.0.1' }, get: () => '' }, res);
  return res;
}
let TS, VIS, AS, TSY, AQ, TQ, SS, AR, GW, MS, PMS, MX, KASS, TREND;

(async () => {
  say('\nSOURCE: working tree' + (SAB ? ' + SABOTAGE ' + SAB : '') + ' — ' + FN);
  VIS = L('product-visibility.js'); TS = L('trust-safety.js'); AS = L('algolia-sync.js'); TSY = L('typesense-sync.js');
  AQ = L('algolia-queue.js'); TQ = L('typesense-queue.js'); SS = L('search-service.js'); AR = L('algolia-recommend.js');
  GW = L('api-gateway.js'); MS = L('minishop.js'); PMS = L('pos-marketplace-sync.js'); MX = L('marketplace-extensions.js');
  /* index.js is not loadable in isolation (it wires 1,700 functions): the KASS tool executor and the generateTrending
     handler are EXTRACTED verbatim from the (possibly sabotaged) copy and run against the same fakes. */
  const IX = fs.readFileSync(path.join(TMP, 'index.js'), 'utf8');
  const cut = (start, endRe) => { const s = IX.indexOf(start); if (s < 0) throw new Error('extract: ' + start); const rest = IX.slice(s); const m = rest.slice(10).search(endRe); return rest.slice(0, m < 0 ? rest.length : m + 10); };
  const execSrc = cut('async function _execChatTool(', /\nasync function |\nfunction |\nexports\./);
  KASS = new Function('db', '_visibility', '_PAGE_MAP', '_authRequired', 'admin', 'logger', execSrc + '\nreturn _execChatTool;')(db, VIS, {}, () => ({ error: 'auth' }), adminStub, logger);
  const trSrc = cut('exports.generateTrending = onSchedule(', /\nexports\./);
  const trBody = trSrc.slice(trSrc.indexOf('async () => {'), trSrc.lastIndexOf('}') + 1);
  TREND = new Function('db', 'admin', '_visibility', 'return (' + trBody + ');')(db, adminStub, VIS);
  if (typeof TS._setNotifier !== 'function') { say('BLOCKED — trust-safety.js has no notifier seam'); process.exit(2); }
  const sent = []; TS._setNotifier(async (o) => { sent.push(o); return { ok: true, key: o.dedupeKey, channels: { inapp: 'sent' } }; });

  /* ═══ fixtures ═══ */
  const SELLER = 'sellerA', BUYER = 'buyer1', BUYER2 = 'buyer2';
  await db.doc('users/' + SELLER).set({ uid: SELLER, status: 'active' });
  await db.doc('shops/shopA').set({ name: 'Shop A', sellerUid: SELLER });
  await db.doc('shopHandles/shop-a').set({ shopId: 'shopA', uid: SELLER });
  await db.doc('searchConfig/settings').set({ primaryEngine: 'algolia' });
  const P = 'p1000';
  const base = { name: 'Rolex Watch', category: 'watches', price: 5000, stock: 9, status: 'active', isVisible: true, sellerUid: SELLER, shopId: 'shopA', hub: 'shopping', viewCount: 50, createdAt: 1000 };
  const ev = (id, before, after) => ({ params: { docId: id }, data: { before: { data: () => before }, after: { data: () => after }, data: () => after } });
  const sync = async (id, before, after) => {
    if (!before) { await AS.algoliaSync_products_create({ params: { docId: id }, data: { data: () => after } }); await TSY.ts_products_onCreate({ params: { docId: id }, data: { data: () => after } }); }
    else { await AS.algoliaSync_products_update(ev(id, before, after)); await TSY.ts_products_onUpdate(ev(id, before, after)); }
    await processQueues();
  };
  await db.doc('products/' + P).set(base);
  await db.doc('products/p2000').set(Object.assign({}, base, { name: 'Casio Watch', price: 900, createdAt: 900, viewCount: 10 }));
  await db.doc('products/p3000').set(Object.assign({}, base, { name: 'Seiko Watch', price: 700, createdAt: 800, viewCount: 5 }));
  await sync(P, null, base); await sync('p2000', null, await get('products/p2000')); await sync('p3000', null, await get('products/p3000'));
  await db.doc('featuredListings/fl1').set({ itemType: 'product', itemId: P, status: 'active', hub: 'shopping', amountPaid: 500, paymentRef: 'pay1', endDate: Date.now() + 864e5 });

  /* the queries every stage asks */
  const searchIds = async (engine, category) => {
    const r = await tryv(SS.searchQuery(as(BUYER, { query: 'watch', index: 'products', engine: engine || 'algolia', filters: category ? { category } : {} })));
    return r.error ? r : (r.hits || []).map((h) => h.id);
  };
  const autoIds = async () => { const r = await tryv(SS.searchAutocomplete(as(BUYER, { query: 'watch', index: '__all__' }))); return r.error ? r : r.suggestions.filter((s) => s.category === 'product').map((s) => s.id); };
  const recIds = async () => { const r = await tryv(AR.getAlgoliaRelated(as(BUYER, { objectID: 'p2000', indexName: 'sokoni_products' }))); return r.error ? r : ((r.results || [])[0] || {}).hits.map((h) => h.objectID); };
  const similarIds = async () => { const r = await tryv(SS.searchSimilar(as(BUYER, { itemId: 'p2000', index: 'products' }))); return r.error ? r : r.recommendations.map((h) => h.id); };
  const apiIds = async (q) => { const r = await gw('/api/v1/products', q || {}); return r.statusCode === 200 ? (r.body.data || r.body).products.map((p) => p.id) : { status: r.statusCode, body: r.body }; };
  const apiSearchIds = async (q) => { const r = await gw('/api/v1/search', q); return r.statusCode === 200 ? (r.body.data || r.body).results.map((p) => p.id) : { status: r.statusCode, body: r.body }; };
  const shopIds = async () => { const res = fakeRes(); await MS.getMinishopPublic({ method: 'GET', query: { handle: 'shop-a' }, headers: {} }, res); return res.statusCode === 200 ? res.body.products.map((p) => p.id) : { status: res.statusCode, body: res.body }; };
  const ctx = () => { const c = { uid: BUYER, results: [], actions: [] }; c.addResult = (r) => c.results.push(r); c.addAction = (a) => c.actions.push(a); return c; };
  const kassIds = async () => { const c = ctx(); await KASS('search_marketplace', { query: 'watch' }, c); return c.results.map((r) => r.id); };
  const kassCart = async (id) => KASS('add_to_cart', { productId: id }, ctx());
  const trending = async () => { await TREND(); return ((await get('trending/shopping')) || {}).productIds || []; };
  const cc = async (id) => codeOf(PMS.createClickAndCollect({ auth: { uid: BUYER, token: {} }, data: { sellerId: SELLER, items: [{ productId: id, qty: 1 }] } }));
  const seo = async (id) => tryv(MX.seoGetProductMeta(as(BUYER, { productId: id })));

  /* ═══ L — the lifecycle (§33): every transition ═══ */
  say('\n── L: visible → discovered everywhere ──');
  const vis0 = { s: await searchIds('algolia'), t: await searchIds('typesense'), c: await searchIds('algolia', 'watches'), a: await autoIds(), r: await recIds(),
    api: await apiIds(), apiS: await apiSearchIds({ q: 'watch' }), apiC: await apiIds({ category: 'watches' }), shop: await shopIds(), k: await kassIds(), tr: await trending(),
    cart: await kassCart(P), cc: await cc(P), seo: await seo(P) };
  vis0.sim = await similarIds();
  ck('L1 a visible product is public on every surface: search (Algolia + Typesense + category), autocomplete, recommendations, API list/search/category, shop page, KASS, trending, click-and-collect, SEO meta',
    [vis0.s, vis0.t, vis0.c, vis0.a, vis0.r, vis0.sim, vis0.api, vis0.apiS, vis0.apiC, vis0.shop, vis0.k, vis0.tr].every((x) => Array.isArray(x) && x.includes(P))
      && vis0.cart.found !== false && vis0.cc === null && vis0.seo.title === 'Rolex Watch' && ENG.algolia.has(P) && ENG.typesense.has(P), vis0);

  say('\n── report → queue → AdminOS decision → take-down ──');
  const rep = await tryv(TS.tsReportContent(as(BUYER, { entityType: 'product', entityId: P, reasonCode: 'counterfeit', detail: 'fake logo' })));
  const q = await tryv(TS.tsGetReports(as('adm1', { queueStatus: 'open' }, ADMIN)));
  ck('L2 the report reaches the moderation queue (tsGetReports)', !!rep.reportId && Array.isArray(q.reports) && q.reports.some((r) => r.id === rep.reportId), { rep, q: q.error });
  const sellerRestoreEarly = await codeOf(TS.tsReviewReport(as(SELLER, { reportId: rep.reportId, action: 'restore', internalNote: 'I fixed the listing myself' })));
  const up = await tryv(TS.tsReviewReport(as('adm1', { reportId: rep.reportId, action: 'approve', hideProduct: true, resolution: 'Counterfeit confirmed', internalNote: 'brand check' }, ADMIN)));
  const held = await get('products/' + P);
  ck('L3 AdminOS upholds + takes down through the canonical authority: isVisible:false + moderationHold, report upheld, audited',
    up.enforcement === 'listing_hidden' && held.isVisible === false && held.moderationHold
      /* re-anchored 2026-10-03 (hold-ref privacy fix): the ref is RANDOM, stored on the report as holdRef — never sha16(reportId) */
      && /^[A-Za-z0-9_-]{16}$/.test(String(held.moderationHold.ref)) && held.moderationHold.ref === (await get('reports/' + rep.reportId)).holdRef
      && held.moderationHold.ref !== opaque(rep.reportId)
      && (await get('reports/' + rep.reportId)).status === 'actioned'
      && (await db.collection('trustSafetyAudit').get()).docs.some((d) => d.data().reportId === rep.reportId && d.data().enforcement === 'listing_hidden'), { up, held });
  ck('PR1 the public product document carries NO reporter-derived value and no moderator identity (no reportId / by / reason on the hold)',
    held.moderationHold && held.moderationHold.reportId === undefined && held.moderationHold.by === undefined && held.moderationHold.reason === undefined
      && !JSON.stringify(held).includes(BUYER) && !JSON.stringify(held).includes('adm1'), held.moderationHold);
  ck('P1 PAID PROMOTION never bypasses moderation: the active featured listing is PAUSED_BY_MODERATION, its payment record untouched',
    (await get('featuredListings/fl1')).status === TS._reportModel.PROMO_PAUSED && (await get('featuredListings/fl1')).amountPaid === 500
      && (await get('featuredListings/fl1')).paymentRef === 'pay1', await get('featuredListings/fl1'));

  say('\n── seller / ordinary user cannot restore ──');
  const sellerRestore = await codeOf(TS.tsReviewReport(as(SELLER, { reportId: rep.reportId, action: 'restore', internalNote: 'I fixed the listing myself' })));
  const userRestore = await codeOf(TS.tsReviewReport(as(BUYER2, { reportId: rep.reportId, action: 'restore', internalNote: 'please restore this now' })));
  const sellerDismiss = await codeOf(TS.tsReviewReport(as(SELLER, { reportId: rep.reportId, action: 'dismiss', restoreListing: true })));
  ck('A1 the SELLER calling restore, an ORDINARY USER calling the AdminOS restore, and a seller dismiss+restore are all refused (permission-denied); the listing stays down',
    sellerRestoreEarly === 'permission-denied' && sellerRestore === 'permission-denied' && userRestore === 'permission-denied' && sellerDismiss === 'permission-denied'
      && (await get('products/' + P)).isVisible === false && !!(await get('products/' + P)).moderationHold, { sellerRestore, userRestore, sellerDismiss });

  say('\n── the index follows the canonical product ──');
  await sync(P, base, await get('products/' + P));
  ck('IX1 the indexers remove the taken-down product from BOTH engines (trigger → queue → engine)', !ENG.algolia.has(P) && !ENG.typesense.has(P),
    { algolia: ENG.algolia.has(P), typesense: ENG.typesense.has(P) });

  say('\n── taken down: gone from every public surface ──');
  const gone = { s: await searchIds('algolia'), t: await searchIds('typesense'), c: await searchIds('algolia', 'watches'), a: await autoIds(), r: await recIds(),
    sim: await similarIds(), api: await apiIds(), apiS: await apiSearchIds({ q: 'watch' }), apiC: await apiIds({ category: 'watches' }), shop: await shopIds(), k: await kassIds(),
    tr: await trending(), cart: await kassCart(P), cc: await cc(P), seo: await seo(P) };
  const absent = (x) => Array.isArray(x) && !x.includes(P) && x.includes('p2000');
  ck('L4 search none (Algolia, Typesense, category filter, autocomplete)', absent(gone.s) && absent(gone.t) && absent(gone.c) && absent(gone.a), gone);
  const absentRec = (x) => Array.isArray(x) && !x.includes(P) && x.includes('p3000');
  ck('L5 recommendations none (Algolia Recommend + searchSimilar)', absentRec(gone.r) && absentRec(gone.sim), { r: gone.r, sim: gone.sim });
  ck('G1 API none (gateway /products, /search, category)', absent(gone.api) && absent(gone.apiS) && absent(gone.apiC), { api: gone.api, apiS: gone.apiS, apiC: gone.apiC });
  ck('SH1 shop page lists the other products, not the taken-down one (the shop itself stays up)', absent(gone.shop), gone.shop);
  ck('K1 KASS: search none; add_to_cart answers exactly like a missing product', absent(gone.k) && gone.cart.found === false && gone.cart.added === false, { k: gone.k, cart: gone.cart });
  ck('TR1 trending/{hub} rebuilt without it (the stale projection is invalidated by the scheduled rebuild)', absent(gone.tr), gone.tr);
  ck('CC1 click-and-collect refuses it (failed-precondition, same wording as unavailable)', gone.cc === 'failed-precondition', gone.cc);
  ck('SEO1 share/SEO metadata answers like a missing product', gone.seo.error === 'product-not-found', gone.seo);

  say('\n── stale index race (§10): the engines still hold it ──');
  ENG.algolia.set(P, recOf(P, base)); ENG.typesense.set(P, recOf(P, base));
  const stale = { s: await searchIds('algolia'), t: await searchIds('typesense'), a: await autoIds(), r: await recIds(), sim: await similarIds() };
  ck('X1 a STALE search hit never becomes a public result (searchQuery re-checks the canonical product: Algolia + Typesense)', absent(stale.s) && absent(stale.t), stale);
  ck('X2 a stale autocomplete suggestion is dropped', absent(stale.a), stale.a);
  ck('X3 a stale recommendation is dropped (Algolia Recommend + searchSimilar)', absentRec(stale.r) && absentRec(stale.sim), { r: stale.r, sim: stale.sim });
  const allStale = await tryv(SS.searchQuery(as(BUYER, { query: 'rolex', index: 'products', engine: 'algolia' })));
  ck('X4 the result count is corrected for what was dropped (no phantom total)', Array.isArray(allStale.hits) && allStale.hits.length === 0 && allStale.total === 0, allStale);
  ENG.algolia.delete(P); ENG.typesense.delete(P);

  say('\n── backfill / reconcile cannot quietly re-index it ──');
  await AQ.enqueue({ collection: 'products', docId: P, operation: 'upsert', data: await get('products/' + P) });
  await TQ.enqueue({ collection: 'products', docId: P, operation: 'upsert', data: await get('products/' + P) });
  const qa = await get('algoliaQueue/products_' + P), qt = await get('typesenseQueue/products_' + P);
  await processQueues();
  ck('B1 an upsert of a hidden/held product (backfill, reconcile, repair) becomes a DELETE at enqueue — both engines', qa && qa.operation === 'delete' && qt && qt.operation === 'delete'
    && !ENG.algolia.has(P) && !ENG.typesense.has(P), { qa: qa && qa.operation, qt: qt && qt.operation });

  say('\n── the gate keys on the hold, not isVisible alone ──');
  ck('V1 a seller-paused product (isVisible:false, no hold) is not public; a held product is not public', !VIS.isPubliclyVisible({ isVisible: false }) && !VIS.isPubliclyVisible(held));
  ck('V2 a STRAY writer re-setting isVisible:true while the hold remains does NOT make it public (and the indexers keep it out)',
    !VIS.isPubliclyVisible(Object.assign({}, held, { isVisible: true })), VIS.publicVisibility(Object.assign({}, held, { isVisible: true })));

  say('\n── restore (§3, §22): AdminOS only, refused under another enforcement ──');
  await db.doc('users/' + SELLER).update({ status: 'suspended' });
  const noNote = await codeOf(TS.tsReviewReport(as('adm1', { reportId: rep.reportId, action: 'restore' }, ADMIN)));
  const blocked = await tryv(TS.tsReviewReport(as('adm1', { reportId: rep.reportId, action: 'restore', internalNote: 'seller proved authenticity' }, ADMIN)));
  ck('R1 a restore without an internal note (≥10 chars) is refused', noNote === 'invalid-argument', noNote);
  ck('R2 a restore while the SELLER IS SUSPENDED is refused and names the enforcement; the listing stays down',
    blocked.error === 'failed-precondition' && JSON.stringify(blocked.details || {}).includes('SELLER_SUSPENDED')
      && (await get('products/' + P)).isVisible === false && !!(await get('products/' + P)).moderationHold, blocked);
  await db.doc('users/' + SELLER).update({ status: 'active' });
  const caseV = await tryv(TS.tsGetReportCase(as('adm1', { reportId: rep.reportId }, ADMIN)));
  ck('R0 the AdminOS case view offers RESTORE on the upheld report that holds the listing, and names that report (admins only)',
    Array.isArray(caseV.actions) && caseV.actions.includes('restore') && caseV.listingHeldByThisReport === true && caseV.product.moderationHold.reportId === rep.reportId, caseV.actions);
  const nSent = sent.length;
  const restored = await tryv(TS.tsReviewReport(as('sup1', { reportId: rep.reportId, action: 'restore', internalNote: 'seller proved authenticity' }, SUPER)));
  const pR = await get('products/' + P);
  ck('R3 Super Admin restore: canonical state restored (isVisible back to the recorded value, hold removed, public-safe release record), report stays upheld',
    restored.enforcement === 'listing_restored' && pR.isVisible === true && pR.moderationHold === undefined && pR.moderationReleased
      && pR.moderationReleased.ref === held.moderationHold.ref && pR.moderationReleased.ref !== opaque(rep.reportId) && pR.moderationReleased.by === undefined && (await get('reports/' + rep.reportId)).status === 'actioned'
      && (await get('reports/' + rep.reportId)).productHidden === false, { restored, pR });
  const restAud = (await db.collection('trustSafetyAudit').get()).docs.map((d) => d.data()).filter((a) => a.reportId === rep.reportId && a.action === 'listing_restored');
  ck('R4 restore is audited (actor, role, previous/new, note) and the seller is told through the notification authority (no reporter identity)',
    restAud.length === 1 && restAud[0].performedBy === 'sup1' && restAud[0].actorRole === 'superAdmin' && restAud[0].internalNote === 'seller proved authenticity'
      && sent.length === nSent + 1 && sent[nSent].uid === SELLER && !JSON.stringify(sent[nSent]).includes(BUYER), { restAud, sent: sent.slice(nSent) });
  ck('P2 the paused promotion resumes on restore (status only; payment untouched)', (await get('featuredListings/fl1')).status === 'active'
    && (await get('featuredListings/fl1')).amountPaid === 500, await get('featuredListings/fl1'));
  const again = await codeOf(TS.tsReviewReport(as('adm1', { reportId: rep.reportId, action: 'restore', internalNote: 'second attempt at restoring' }, ADMIN)));
  ck('R5 a second restore is refused (nothing is held) — no double restore', again === 'failed-precondition', again);

  say('\n── public again, through the index ──');
  await sync(P, held, pR);
  const back = { s: await searchIds('algolia'), t: await searchIds('typesense'), api: await apiIds(), shop: await shopIds(), k: await kassIds() };
  ck('L6 after restore the product is reindexed and public again (search both engines, API, shop page, KASS)',
    [back.s, back.t, back.api, back.shop, back.k].every((x) => Array.isArray(x) && x.includes(P)) && ENG.algolia.has(P) && ENG.typesense.has(P), back);

  say('\n── pagination (§19): 100 products, hidden ones spread across pages ──');
  for (let i = 0; i < 100; i++) {
    const id = 'q' + String(i).padStart(3, '0');
    const hidden = i % 10 === 3;                                   /* 10 hidden: 5 moderation-held, 5 seller-paused */
    const d = { name: 'Gadget ' + i, category: 'gadgets', price: 100 + i, status: 'active', sellerUid: SELLER, shopId: 'shopB', createdAt: 5000 + i,
      isVisible: !hidden, ...(hidden && i % 20 === 3 ? { moderationHold: { active: true, ref: 'r' + i, at: 1 } } : {}) };
    await db.doc('products/' + id).set(d);
    ENG.algolia.set(id, recOf(id, d));                              /* the engine is STALE: it still has all 100 */
  }
  const seen = []; let cursor = null; let pages = 0; let pageHidden = [];
  do {
    const r = await gw('/api/v1/products', Object.assign({ category: 'gadgets', limit: '20' }, cursor ? { cursor } : {}));
    const b = r.body.data || r.body; pages++;
    const ids = (b.products || []).map((p) => p.id);
    pageHidden = pageHidden.concat(ids.filter((id) => Number(id.slice(1)) % 10 === 3));
    seen.push(...ids); cursor = b.nextCursor;
  } while (cursor && pages < 10);
  ck('G2 API pagination: across every page no hidden product appears, every visible one appears exactly once, pages are full (90 visible / 20 per page)',
    pageHidden.length === 0 && seen.length === 90 && new Set(seen).size === 90 && pages === 5, { pages, n: seen.length, pageHidden });
  const sp = [];
  for (let pg = 0; pg < 6; pg++) {
    const r = await tryv(SS.searchQuery(as(BUYER, { query: 'gadget', index: 'products', engine: 'algolia', page: pg, hitsPerPage: 20 })));
    sp.push(...(r.hits || []).map((h) => h.id));
  }
  ck('PG1 search pagination over a STALE index: page 2+ never carries a hidden product', sp.length === 90 && sp.every((id) => Number(id.slice(1)) % 10 !== 3), { n: sp.length });

  say('\n── shop page with hidden listings ──');
  await db.doc('shopHandles/shop-b').set({ shopId: 'shopB', uid: SELLER }); await db.doc('shops/shopB').set({ name: 'Shop B', sellerUid: SELLER });
  const resB = fakeRes(); await MS.getMinishopPublic({ method: 'GET', query: { handle: 'shop-b' }, headers: {} }, resB);
  const bIds = (resB.body && resB.body.products || []).map((p) => p.id);
  ck('SH2 the shop page fills its 16 slots from visible products only (bounded over-fetch), never a hidden one',
    bIds.length === 16 && bIds.every((id) => Number(id.slice(1)) % 10 !== 3) && (resB.body.products || []).every((p) => p.moderationHold === undefined), bIds);
  const k2 = ctx(); await KASS('search_marketplace', { query: 'gadget' }, k2);
  ck('K2 KASS search over the 100: no hidden product is recommended', k2.results.length > 0 && k2.results.every((r) => Number(String(r.id).slice(1)) % 10 !== 3), k2.results.map((r) => r.id));

  say('\n── tripwires ──');
  const realLoaded = Object.keys(require.cache).filter((k) => /node_modules[\\/]firebase-admin[\\/]/.test(k) || /[\\/]notify\.js$/.test(k));
  let notifyBlocked = false; try { require(path.join(TMP, 'notify')); } catch (e) { notifyBlocked = /TRIPWIRE/.test(e.message); }
  ck('Z1 TRIPWIRES held: the real firebase-admin was never loaded (every require got the in-memory stub), notify.js is unloadable, no real socket',
    realLoaded.length === 0 && adminStubServed > 0 && notifyBlocked && require('https') === fakeHttps, { realLoaded, adminStubServed, notifyBlocked });

  say(`\n${pass} passed, ${fail} failed`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('HARNESS ERROR (not a result): ' + (e && e.stack)); process.exit(4); });
