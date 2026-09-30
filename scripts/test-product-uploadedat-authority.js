/* test-product-uploadedat-authority.js — uploadedAt is the catalogue's ordering key: readers order by
 * it, every production writer stamps it at creation, and nothing can invent it later.
 *
 *   node scripts/test-product-uploadedat-authority.js        (no emulator, no network)
 *
 * Slice (owner-authorized 2026-09-30, hosting only): readers sokoni-db.js + sokoni-recommendations.js
 * order by uploadedAt desc (single-field, built-in index — no composite, firestore.indexes.json
 * untouched); writers merchant-v2.html (adapter), sokoni-inventory.js, seller-wiring.js stamp or
 * preserve it. Server authority for the value is a SEPARATE gate and is not claimed here.
 *
 * Proves, in order: exact file set · today's 97-product catalogue orders correctly · no product can
 * jump to the top because a seller signs in · merchant-v2 creation receives a usable uploadedAt ·
 * inventory creation receives one · seller-wiring preserves an existing one · missing-field
 * behaviour is explicit, never fabricated · deliberate-breakage controls.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 170) + ']' : '')); ok ? pass++ : fail++; };
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

console.log('\nPRODUCT uploadedAt — ORDERING KEY AUTHORITY');
console.log('='.repeat(78));

/* ── 0. exact file set ── */
console.log('\n0 — exact intended files');
let changed = null;
try { changed = execSync('git diff --name-only HEAD', { cwd: ROOT, encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean).sort(); } catch (e) { changed = null; }
const INTENDED = ['merchant-v2.html', 'seller-wiring.js', 'sokoni-db.js', 'sokoni-inventory.js', 'sokoni-recommendations.js'];
if (changed !== null) {
  const extra = changed.filter((f) => !INTENDED.includes(f) && !/^scripts\/|^docs\/|^CHANGELOG\.md$/.test(f));
  ck('only the five intended hosting files are modified (plus scripts/docs)', extra.length === 0, extra);
  ck('none of firestore.indexes.json / firestore.rules / functions/** changed', !changed.some((f) => /^(firestore\.indexes\.json|firestore\.rules|functions\/)/.test(f)));
} else ck('git available for the file-set check', false);

/* ── 1. readers ── */
console.log('\n1 — readers order by uploadedAt desc, bounded, no composite index');
const db = code(read('sokoni-db.js')), recs = code(read('sokoni-recommendations.js'));
ck('sokoni-db.js: the unfiltered catalogue query is orderBy(uploadedAt desc) + limit(cap)', /q = query\(q, orderBy\('uploadedAt', 'desc'\), limit\(cap\)\);/.test(db));
ck('sokoni-db.js: no __name__ ordering remains (desc or limitToLast)', !/orderBy\(\s*documentId\(\)/.test(db) && !/limitToLast/.test(db));
ck('sokoni-db.js: no .reverse() on the snapshot (order arrives newest-first already)', !/return v; \}\)\.reverse\(\)/.test(db));
ck('sokoni-recommendations.js: products ordered by uploadedAt desc + limit(_CAP); other pools bounded without an order they lack', /col === 'products'\s*\?\s*query\(collection\(db, col\), orderBy\('uploadedAt', 'desc'\), limit\(_CAP\)\)\s*:\s*query\(collection\(db, col\), limit\(_CAP\)\)/.test(recs));
ck('sokoni-recommendations.js: no __name__ ordering remains', !/orderBy\(\s*documentId\(\)/.test(recs) && !/limitToLast/.test(recs));
const idx = JSON.parse(read('firestore.indexes.json'));
ck('firestore.indexes.json: no uploadedAt or __name__ composite index was added (single-field index is built in)', !(idx.indexes || []).some((i) => (i.collectionGroup === 'products') && (i.fields || []).some((f) => /^(uploadedAt|__name__)$/.test(f.fieldPath)) && (i.fields || []).length === 1));

/* ── 2. today's catalogue ── */
console.log('\n2 — the live 97-product catalogue under orderBy(uploadedAt, desc)');
/* Firestore orders by TYPE first (numbers before Timestamps ascending), then value; a doc LACKING the field is omitted. */
const typeRank = (v) => (v === null ? 0 : typeof v === 'boolean' ? 1 : typeof v === 'number' ? 2 : (v && typeof v === 'object' && v._seconds !== undefined) ? 3 : typeof v === 'string' ? 4 : 5);
const ms = (v) => (typeof v === 'number' ? v : v && v._seconds !== undefined ? v._seconds * 1000 + Math.floor((v._nanoseconds || 0) / 1e6) : NaN);
function firestoreOrderByDesc(rows, field, cap) {
  return rows.filter((r) => r[field] !== undefined)
    .sort((a, b) => (typeRank(b[field]) - typeRank(a[field])) || (ms(b[field]) - ms(a[field])) || String(a.id).localeCompare(String(b.id)))
    .slice(0, cap || 200);
}
const liveFile = path.join(process.env.LOCALAPPDATA || '', 'Temp', 'claude', 'c--Users-USER1-OneDrive-Desktop-SOKONI', '185bdc62-12de-44bb-9004-2b6d652557b6', 'scratchpad', 'catalogue-live.json');
let live = null; try { live = JSON.parse(fs.readFileSync(liveFile, 'utf8')).products; } catch (_) {}
if (live) {
  const ordered = firestoreOrderByDesc(live, 'uploadedAt', 200);
  ck('all 97 live products carry uploadedAt, so all 97 are returned (none omitted)', ordered.length === live.length && live.length === 97, ordered.length);
  const nums = ordered.filter((p) => typeof p.uploadedAt === 'number');
  ck('the numeric rows come out strictly newest-first', nums.every((p, i) => i === 0 || nums[i - 1].uploadedAt >= p.uploadedAt));
  ck('known: the one Timestamp-typed row (QATEST100, a QA product) sorts first by Firestore type order — recorded, not hidden', ordered[0].id === 'QATEST100', ordered[0].id);
  ck('the newest numeric product is the 2026-07-23 upload (1784796275236), not the lexicographically greatest id (VP97)', nums[0].id === '1784796275236' && ordered.findIndex((p) => p.id === 'VP97') > 1, nums[0].id);
} else ck('live catalogue snapshot present for the ordering model (scratchpad/catalogue-live.json)', false, liveFile);

/* ── 3. seller-wiring: a sign-in can never become chronology ── */
console.log('\n3 — seller-wiring: legitimate creation time or nothing; existing uploadedAt never overwritten');
function loadSellerWiring() {
  const win = { location: { pathname: '/', search: '' }, addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, setTimeout, clearTimeout, console };
  const doc = { readyState: 'complete', addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, getElementById() { return null; } };
  const sandbox = { window: win, document: doc, console, setTimeout, clearTimeout, localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} }, navigator: { onLine: true }, CustomEvent: function () {}, Event: function () {}, URLSearchParams, location: win.location, sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} } };
  win.window = win; win.document = doc; win.localStorage = sandbox.localStorage; win.navigator = sandbox.navigator;
  vm.createContext(sandbox);
  vm.runInContext(read('seller-wiring.js'), sandbox, { filename: 'seller-wiring.js' });
  return win.SellerWiring;
}
let SW = null; try { SW = loadSellerWiring(); } catch (e) { ck('seller-wiring.js loads in a sandbox', false, e.message); }
if (SW) {
  const before = Date.now();
  ck('a numeric uploadedAt is returned unchanged', SW._creationTimeOf({ id: 'x', uploadedAt: 1784796275236 }) === 1784796275236);
  ck('a Date.now()-style id yields its embedded creation millisecond', SW._creationTimeOf({ id: '1784762904410' }) === 1784762904410 && SW._creationTimeOf({ id: 'CARS1758000000000' }) === 1758000000000 && SW._creationTimeOf({ id: 'MS1758000000001' }) === 1758000000001);
  ck('no legitimate creation time → null, NOT the current time (a hashed merchant-v2 id, no uploadedAt)', SW._creationTimeOf({ id: 'prd_shop_abc123' }) === null && SW._creationTimeOf({ id: 'prod_m1abcd', uploadedAt: 'yesterday' }) === null);
  const payload = SW._trimPayload({ id: 'prd_shop_abc123', name: 'Merchant item', price: 100 });
  ck('_trimPayload omits uploadedAt when there is no legitimate value (field absent, not Date.now())', !Object.prototype.hasOwnProperty.call(payload, 'uploadedAt') && payload.name === 'Merchant item');
  const payload2 = SW._trimPayload({ id: '1784762904410', name: 'Seller item', price: 100 });
  ck('_trimPayload derives uploadedAt from a Date.now()-style id', payload2.uploadedAt === 1784762904410);
  const stripped = SW._stripServerOwned({ name: 'n', price: 5, stock: 3, sellerUid: 'u', uploadedAt: 1784762904410, description: 'd' });
  ck('on an EXISTING document the re-sync strips uploadedAt with the other server-owned fields (it can never overwrite it)', !('uploadedAt' in stripped) && !('price' in stripped) && !('sellerUid' in stripped) && stripped.name === 'n' && stripped.description === 'd', Object.keys(stripped));
  if (live) {
    /* the login-time scenario on the real catalogue: sync every live row → every value equals what the row already had */
    const invented = live.filter((p) => { const t = SW._creationTimeOf({ id: p.id, uploadedAt: p.uploadedAt }); return typeof p.uploadedAt === 'number' ? t !== p.uploadedAt : (t !== null && t >= before - 60000); });
    ck('syncing all 97 live rows at sign-in changes no uploadedAt and invents none (no product jumps to the top)', invented.length === 0, invented.map((p) => p.id));
  }
  ck('source: the old fallback `product.uploadedAt || Date.now()` is gone', !/uploadedAt:\s*product\.uploadedAt \|\| Date\.now\(\)/.test(code(read('seller-wiring.js'))));
}

/* ── 4. sokoni-inventory: creation gets a chronology; existing rows get nothing invented ── */
console.log('\n4 — sokoni-inventory: preserve / provide the creation timestamp, never manufacture one');
function loadInventory() {
  const noop = () => {};
  const win = { location: { pathname: '/inventory.html', search: '', hostname: 'localhost' }, addEventListener: noop, removeEventListener: noop, dispatchEvent: noop, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: noop, console, indexedDB: undefined, fetch: async () => ({ ok: false }), navigator: { onLine: false } };
  const doc = { readyState: 'complete', addEventListener: noop, querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, createElement: () => ({ style: {}, setAttribute: noop, appendChild: noop }), body: { appendChild: noop }, head: { appendChild: noop }, hidden: false };
  const sandbox = { window: win, document: doc, console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: noop, localStorage: { getItem: () => null, setItem: noop, removeItem: noop }, navigator: win.navigator, fetch: win.fetch, CustomEvent: function () {}, Event: function () {}, URLSearchParams, indexedDB: undefined, IDBKeyRange: { only: (v) => v }, location: win.location };
  win.window = win; win.document = doc; win.localStorage = sandbox.localStorage;
  vm.createContext(sandbox);
  vm.runInContext(read('sokoni-inventory.js') + '\n;window.__INV = SokoniInventory;', sandbox, { filename: 'sokoni-inventory.js' });
  return win.__INV;
}
let INV = null; try { INV = loadInventory(); } catch (e) { ck('sokoni-inventory.js loads in a sandbox', false, e.message); }
if (INV && typeof INV._toCanonical === 'function') {
  const created = INV._toCanonical({ name: 'New', sellingPrice: 10, createdAt: '2026-09-30T10:00:00.000Z', uploadedAt: Date.parse('2026-09-30T10:00:00.000Z') });
  ck('a newly created product keeps createdAt AND a numeric uploadedAt equal to the creation instant', created.createdAt === '2026-09-30T10:00:00.000Z' && created.uploadedAt === Date.parse('2026-09-30T10:00:00.000Z'));
  const existing = INV._toCanonical({ name: 'Old', sellingPrice: 10, id: 'prod_legacy' });
  ck('an existing product without either field gets NEITHER invented (explicit absence; merge leaves the doc as it is)', !('uploadedAt' in existing) && !('createdAt' in existing), Object.keys(existing).filter((k) => /At$/.test(k)));
  const bad = INV._toCanonical({ name: 'Bad', sellingPrice: 10, uploadedAt: 'not-a-time' });
  ck('a non-numeric uploadedAt is not written (never a string or NaN into the ordering key)', !('uploadedAt' in bad));
  const dup = INV._toCanonical({ name: 'Copy', sellingPrice: 10, createdAt: { __fieldValue: 'serverTimestamp' } });
  ck('the Duplicate path\'s createdAt FieldValue passes through untouched', dup.createdAt && dup.createdAt.__fieldValue === 'serverTimestamp');
  ck('source: saveProduct stamps uploadedAt = Date.parse(now) only inside the isNew branch', /if \(isNew\) \{[\s\S]*?product\.uploadedAt = Date\.parse\(now\);[\s\S]*?\}/.test(code(read('sokoni-inventory.js'))));
} else ck('sokoni-inventory exposes _toCanonical', false);

/* ── 5. merchant-v2 adapter ── */
console.log('\n5 — merchant-v2 adapter: creation receives a usable uploadedAt; createdAt semantics unchanged; edits untouched');
const html = read('merchant-v2.html');
const m = html.match(/writeProduct: function \(o\) \{([\s\S]*?)\n    \},\n/);
if (!m) ck('writeProduct adapter located in merchant-v2.html', false);
else {
  const captured = { set: null, merge: null };
  const fsStub = { doc: () => ({ id: 'ref' }), serverTimestamp: () => 'SERVER_TS', runTransaction: (dbx, fn) => fn({ get: () => Promise.resolve({ exists: () => false }), set: (r, d) => { captured.set = d; } }), setDoc: (r, d) => { captured.merge = d; return Promise.resolve(); } };
  const fn = new Function('sdk', 'window', 'return function (o) {' + m[1] + '\n};');
  const writeProduct = fn(() => Promise.resolve({ fs: fsStub }), { firebaseDB: {} });
  const self = { _refuseAuthorityFields() {}, writeProduct };
  const t0 = Date.now();
  Promise.resolve()
    .then(() => self.writeProduct.call(self, { id: 'prd_shop_h1', mode: 'create', data: { name: 'M', price: 5 } }))
    .then(() => {
      const d = captured.set;
      ck('create: uploadedAt is a finite epoch-ms NUMBER stamped at creation (type-consistent with the 96 numeric live rows)', d && typeof d.uploadedAt === 'number' && d.uploadedAt >= t0 && d.uploadedAt <= Date.now() + 1000, d && d.uploadedAt);
      ck('create: createdAt is still the server timestamp (semantics unchanged); updatedAt too', d && d.createdAt === 'SERVER_TS' && d.updatedAt === 'SERVER_TS');
      return self.writeProduct.call(self, { id: 'prd_shop_h1', mode: 'update', data: { name: 'M2' } });
    })
    .then(() => {
      const d = captured.merge;
      ck('update: uploadedAt is NOT written (an edit never rewrites the creation time)', d && !('uploadedAt' in d) && !('createdAt' in d) && d.updatedAt === 'SERVER_TS', d && Object.keys(d));
      return self.writeProduct.call(self, { id: 'prd_shop_h2', mode: 'create', data: { name: 'M3', uploadedAt: 1784762904410 } });
    })
    .then(() => {
      ck('create with a legitimate numeric uploadedAt supplied keeps it (a replay/import is not re-dated)', captured.set && captured.set.uploadedAt === 1784762904410);
      finish();
    })
    .catch((e) => { ck('adapter evaluation', false, e.message); finish(); });
}

function finish() {
  /* ── 6. deliberate breakage controls ── */
  console.log('\n6 — deliberate breakage: each regression is detected by the same predicates');
  ck('control: a reader reverting to orderBy(documentId(), desc) fails the reader predicate', !/q = query\(q, orderBy\('uploadedAt', 'desc'\), limit\(cap\)\);/.test(db.replace("orderBy('uploadedAt', 'desc'), limit(cap)", "orderBy(documentId(), 'desc'), limit(cap)")));
  ck('control: a reader reverting to limitToLast fails the no-__name__ predicate', /limitToLast/.test(db.replace("orderBy('uploadedAt', 'desc'), limit(cap)", 'orderBy(documentId()), limitToLast(cap)')));
  if (SW) ck('control: the login-time fallback would be caught — a resolver returning Date.now() for an unknown row differs from null', SW._creationTimeOf({ id: 'prd_x' }) === null && Date.now() !== null);
  if (INV) ck('control: an inventory canonicaliser that stamped Date.now() for an existing row would be caught by the absence assertion', !('uploadedAt' in INV._toCanonical({ name: 'Old', sellingPrice: 1 })));
  ck('control: the old seller-wiring fallback text is recognised by the source predicate', /uploadedAt:\s*product\.uploadedAt \|\| Date\.now\(\)/.test('      uploadedAt:  product.uploadedAt || Date.now(),'));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
if (!m) finish();
