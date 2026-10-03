#!/usr/bin/env node
/* FOOD HUB GATE 2 — Menu + Drinks authority (functions/food-menu.js, callable foodMenu).
 *
 *   node scripts/test-food-menu.js
 *   BASE=5dc505e node scripts/test-food-menu.js        (the capability line before Gate 2 — must FAIL)
 *
 * Runs the REAL handler with the REAL merchant-identity.resolveActor (firebase-admin replaced in the require cache)
 * and the REAL business-workspace.workspaceFor, against an in-memory Firestore (scripts/lib/fake-firestore.js).
 * Every refusal row also asserts that NOTHING was written.
 */
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const { fakeDb } = require('./lib/fake-firestore');
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 240) + ']')); ok ? pass++ : fail++; };

let FN = path.join(ROOT, 'functions');
if (process.env.BASE) {
  /* BASE's bytes for the files Gate 2 adds/changes, in a temp dir that still resolves functions/node_modules */
  /* BASE's functions tree, materialised from git into a sibling dir that still resolves functions/node_modules. */
  const tmp = fs.mkdtempSync(path.join(FN, '.g2base-'));
  process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });
  const files = execSync('git ls-tree -r --name-only ' + process.env.BASE + ' -- functions', { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 })
    .split('\n').filter((f) => /\.js$/.test(f) && !/node_modules/.test(f));
  for (const f of files) {
    const out = path.join(tmp, f.replace(/^functions\//, ''));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, execSync('git show ' + process.env.BASE + ':' + f, { cwd: ROOT, maxBuffer: 64 << 20 }));
  }
  FN = tmp;
}

let DB = fakeDb({});
const realFS = require(require.resolve('firebase-admin/firestore', { paths: [path.join(ROOT, 'functions')] }));
const adminPath = require.resolve('firebase-admin', { paths: [path.join(ROOT, 'functions')] });
const fsFn = () => DB; fsFn.FieldValue = realFS.FieldValue;
require.cache[adminPath] = { id: adminPath, filename: adminPath, loaded: true, exports: { firestore: fsFn, auth: () => ({ getUser: async (u) => ({ uid: u, displayName: 'Person ' + u }) }), apps: [1], initializeApp() {} } };

let FM, BW, MI;
try {
  FM = require(path.join(FN, 'food-menu.js'))._internal;
  BW = require(path.join(FN, 'business-workspace.js'));
  MI = require(path.join(FN, 'merchant-identity.js'))._internal;
} catch (e) { console.log('\nGate 2 Menu   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n\n  FAIL LOAD food-menu authority absent or broken: ' + e.message.split('\n')[0] + '\n\nRESULT: 0 passed, 1 failed'); process.exit(1); }

const ADMIN = 'ADMIN1';
let LIMIT = { allowed: true, count: 0, limit: 50 };
const deps = () => ({
  db: DB, FieldValue: realFS.FieldValue,
  resolveActor: (uid, sid) => MI.resolveActor(uid, sid),
  workspaceFor: (db, uid) => BW.workspaceFor(db, uid, { approval: { getUser: async (u) => ({ uid: u, customClaims: u === ADMIN ? { admin: true } : {} }) } }),
  productLimit: async () => LIMIT,
  now: () => new Date('2026-10-03T12:00:00Z'),
});
const call = async (uid, data) => { try { return await FM.handle(deps(), uid, data); } catch (e) { return { err: e.code || 'error', reason: (e.details && e.details.reason) || e.message }; } };

/* An approved business exactly as Gate 1 provisions it (cbbce0c). */
function business(uid, appCat, cat, extra) {
  return {
    [`shops/${uid}`]: Object.assign({ shopId: uid, ownerId: uid, sellerUid: uid, name: 'Shop ' + uid, status: 'active', approvedAt: '<ts>', business: { category: cat, source: 'application', applicationId: 'APP_' + uid } }, extra || {}),
    [`sellers/${uid}`]: { uid, shopId: uid, status: 'active', active: true, approvedAt: '<ts>', approvedBy: ADMIN, business: { category: cat, source: 'application' } },
    [`businesses/${uid}`]: { uid, shopId: uid, status: 'active', approvedAt: '<ts>', business: { category: cat, source: 'application', applicationId: 'APP_' + uid } },
    [`applications/APP_${uid}`]: { uid, applicationId: 'APP_' + uid, status: 'approved', statusCanonical: 'approved', decidedBy: ADMIN, role: 'seller', category: appCat },
    [`users/${uid}`]: { name: 'Owner ' + uid },
  };
}
function seed(...parts) {
  const out = {};
  for (const p of parts) for (const [k, v] of Object.entries(p)) { const [c, id] = k.split('/'); (out[c] = out[c] || {})[id] = v; }
  return out;
}
const A = 'uRestA', B = 'uRestB', PEND = 'uPend', RET = 'uRetail';
const emp = (uid, role, owner) => ({ [`shopEmployees/${uid}`]: { shopOwnerId: owner, role, status: 'active', name: role + ' ' + uid } });
function world() {
  return seed(business(A, 'cafe', 'restaurant'), business(B, 'restaurant', 'restaurant'), business(RET, 'supermarket', 'supermarket'),
    { [`shops/${PEND}`]: { shopId: PEND, ownerId: PEND, name: 'Pending kitchen', status: 'pending' }, [`users/${PEND}`]: { name: 'P' },
      [`applications/APP_${PEND}`]: { uid: PEND, status: 'pending', statusCanonical: 'pending', role: 'seller', category: 'cafe' } },
    emp('uMgr', 'manager', A), emp('uCash', 'cashier', A), emp('uStaff', 'staff', A), emp('uInv', 'inventory', A));
}
const S = () => DB._store;
const nWrites = () => DB._writes.length;
const SECTIONS = [{ name: 'Breakfast', kind: 'food' }, { name: 'Mains', kind: 'food' }, { name: 'Soft drinks', kind: 'drinks' }];

(async () => {
  console.log('\nGate 2 Menu + Drinks   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
  DB = fakeDb(world());

  /* ── CAP: the capability engine switches the modules on ── */
  const w = await deps().workspaceFor(DB, A);
  ck('CAP-1', w.route === 'merchant-v2.html' && w.state === 'AVAILABLE' && w.merchantModules && w.merchantModules.menu.state === 'AVAILABLE' && w.merchantModules.drinks.state === 'AVAILABLE',
    'an approved food business gets Menu + Drinks AVAILABLE on merchant-v2', w.merchantModules);
  ck('CAP-2', w.merchantModules && w.merchantModules.kitchen && w.merchantModules.kitchen.state === 'NOT_IMPLEMENTED' && w.merchantModules.kitchen.reason === 'FOOD_ORDERS_PENDING',
    'Kitchen stays NOT_IMPLEMENTED (FOOD_ORDERS_PENDING) until real food orders exist — never a fake working kitchen', w.merchantModules && w.merchantModules.kitchen);

  /* ── MOD: the shop-scoped module answer merchant-v2 shows/hides the Food views by ── */
  let mo = await call('uMgr', { op: 'modules', shopId: A });
  ck('MOD-1', mo.ok && mo.role === 'manager' && mo.merchantModules.menu.state === 'AVAILABLE' && mo.merchantModules.kitchen.state === 'NOT_IMPLEMENTED',
    'a MANAGER sees the shop owner\'s food modules (the caller\'s own account has no business)', mo);
  mo = await call(RET, { op: 'modules', shopId: RET });
  ck('MOD-2', mo.ok && mo.merchantModules.menu === null && mo.merchantModules.drinks === null, 'a non-food business gets no food modules', mo);
  mo = await call('uStranger', { op: 'modules', shopId: A });
  ck('MOD-3', mo.err && mo.reason === 'not-employed-here', 'a stranger cannot read another shop\'s modules', mo);
  mo = await call(PEND, { op: 'modules', shopId: PEND });
  ck('MOD-4', mo.ok && mo.merchantModules.menu === null && mo.state !== 'AVAILABLE', 'a pending business gets no modules (and its holding state)', mo);

  /* ── MENU ── */
  let r = await call(A, { op: 'saveSections', shopId: A, sections: SECTIONS });
  const secs = r.sections || [];
  ck('M-1', r.ok && secs.length === 3 && secs[2].kind === 'drinks' && secs[0].id === 'breakfast', 'the owner organises the menu into sections (food + drinks), stored server-side on the shop', r);
  const mains = (secs[1] || {}).id, drinks = (secs[2] || {}).id;
  r = await call(A, { op: 'saveItem', shopId: A, draftToken: 't1', name: 'Chapati & beans', description: 'Two chapatis', price: 150, sectionId: mains, prepMinutes: 12 });
  const id1 = r.itemId; const p1 = (S().products || {})[id1] || {};
  ck('M-2', r.ok && r.created && p1.shopId === A && p1.sellerUid === A && p1.status === 'draft' && p1.price === 150 && p1.menu.kind === 'food' && p1.category === 'Mains' && !('stock' in p1),
    'create → ONE canonical products/{id} (shop + owner from the server, draft, base price, no stock written)', p1);
  ck('M-2b', id1 === FM.itemIdFor(A, 't1') && /^prd_uRestA_/.test(id1), 'the id is the merchant-v2 product id derivation (one id space with every other product writer)', id1);
  r = await call(A, { op: 'saveItem', shopId: A, draftToken: 't1', name: 'Chapati & beans', price: 150, sectionId: mains });
  ck('M-3', r.ok && r.replay && Object.keys(S().products).length === 1, 'a replayed create returns the same item — never a second one', r);
  r = await call(A, { op: 'saveItem', shopId: A, itemId: id1, name: 'Chapati & beans', price: 180, sectionId: mains });
  ck('M-4', r.ok && S().products[id1].price === 180 && S().products[id1].revision === 2, 'edit persists the new base price and bumps the product revision', S().products[id1]);
  r = await call(A, { op: 'setStatus', shopId: A, itemId: id1, status: 'published' });
  ck('M-5', r.ok && S().products[id1].status === 'active' && S().products[id1].isVisible === true, 'publish → status active (what every listing reads)');
  r = await call(A, { op: 'setStatus', shopId: A, itemId: id1, status: 'draft' });
  ck('M-6', r.ok && S().products[id1].status === 'draft', 'unpublish → draft');
  r = await call(A, { op: 'setAvailability', shopId: A, itemId: id1, availability: 'unavailable' });
  ck('M-7', r.ok && S().products[id1].outOfStock === true && S().products[id1].menu.availability === 'unavailable', 'unavailable → the canonical outOfStock flag sellability honours');
  r = await call(A, { op: 'setAvailability', shopId: A, itemId: id1, availability: 'temporarily_unavailable', hours: 2 });
  ck('M-8', r.ok && S().products[id1].menu.availableAgainAt === '2026-10-03T14:00:00.000Z' && S().products[id1].outOfStock === true, 'temporarily unavailable records when it comes back', S().products[id1].menu);
  r = await call(A, { op: 'setAvailability', shopId: A, itemId: id1, availability: 'available' });
  ck('M-8b', r.ok && S().products[id1].outOfStock === false && S().products[id1].menu.availability === 'available', 'available again clears the flag');
  r = await call(A, { op: 'saveItem', shopId: A, draftToken: 't2', name: 'Mandazi', price: 20, sectionId: (secs[0] || {}).id });
  const id2 = r.itemId;
  r = await call(A, { op: 'reorder', shopId: A, itemIds: [id2, id1] });
  ck('M-9', r.ok && S().products[id2].menu.sortOrder === 0 && S().products[id1].menu.sortOrder === 1, 'items are reordered');
  r = await call(A, { op: 'archive', shopId: A, itemId: id2 });
  ck('M-10', r.ok && S().products[id2].status === 'archived' && S().products[id2].isVisible === false && !DB._writes.some((x) => x.op === 'delete'),
    'archive is the canonical tombstone — the product is never deleted');

  /* ── DRINKS ── */
  r = await call(A, { op: 'saveItem', shopId: A, draftToken: 'd1', name: 'Passion juice', price: 120, sectionId: drinks, variants: [{ name: '300ml', price: 120 }, { name: '500ml', price: 180 }] });
  const d1 = r.itemId; const pd = (S().products || {})[d1] || {};
  ck('D-1', r.ok && pd.menu && pd.menu.kind === 'drinks' && pd.variants.length === 2 && pd.variants[1].price === 180, 'a drink is a canonical product in a drinks section, with sizes', pd);
  const load = await call(A, { op: 'load', shopId: A });
  const ids = (load.items || []).map((x) => x.id);
  ck('D-2', load.ok && ids.filter((x) => x === d1).length === 1 && (load.items || []).filter((x) => x.kind === 'drinks').map((x) => x.id).join() === d1,
    'one record, two views: the drink appears once in the menu and is the Drinks projection — never cloned', load.items);
  DB._store.products[d1].stock = 24; DB._store.products[d1].inventoryVersion = 1;   /* as merchantAdjustStock leaves it */
  r = await call(A, { op: 'saveItem', shopId: A, itemId: d1, name: 'Passion juice', price: 130, sectionId: drinks, stock: 0, inventoryVersion: 99 });
  ck('D-3', r.ok && S().products[d1].stock === 24 && S().products[d1].inventoryVersion === 1, 'INVENTORY LINK: the item IS the stock-carrying product; menu edits never write stock (merchantAdjustStock owns it)', S().products[d1]);
  const l2 = await call(A, { op: 'load', shopId: A });
  ck('D-4', (l2.items || []).some((x) => x.id === d1 && x.metered && x.stock === 24) && (l2.items || []).some((x) => x.id === id1 && !x.metered),
    'the menu shows metered drinks with their canonical stock and unmetered dishes as unmetered (not zero)');

  /* ── PRICING ── */
  const n0 = nWrites();
  const bad = [];
  for (const price of ['abc', -5, 0, 10.555, 2e6, null]) { const x = await call(A, { op: 'saveItem', shopId: A, draftToken: 'bp' + price, name: 'X', price, sectionId: mains }); if (x.reason !== 'BAD_PRICE') bad.push([price, x]); }
  ck('P-1', bad.length === 0 && nWrites() === n0, 'a forged/invalid price is refused and NOTHING is written', bad);
  r = await call(A, { op: 'saveItem', shopId: A, draftToken: 'forge', name: 'Ugali', price: 100, sectionId: mains, sellerUid: B, shopIdOverride: B, status: 'active', salePrice: 1, commissionRate: 0, stock: 999, approved: true });
  const pf = (S().products || {})[r.itemId] || {};
  ck('P-2', r.ok && pf.sellerUid === A && pf.status === 'draft' && !('salePrice' in pf) && !('commissionRate' in pf) && !('stock' in pf) && !('approved' in pf),
    'browser-supplied owner / status / salePrice / commission / stock / approval fields are ignored', pf);

  /* ── SECURITY ── */
  const sec = async (id, uid, data, wantReason, msg) => { const w0 = nWrites(); const x = await call(uid, data); ck(id, x.err && (!wantReason || x.reason === wantReason) && nWrites() === w0, msg + ' (nothing written)', x); };
  await sec('S-1', 'uStranger', { op: 'saveItem', shopId: A, draftToken: 's1', name: 'X', price: 10, sectionId: mains }, 'not-employed-here', 'a stranger cannot edit a menu');
  await sec('S-2', B, { op: 'setStatus', shopId: B, itemId: id1, status: 'published' }, 'ITEM_NOT_OWNED', 'business B cannot publish business A\'s item through its own shop');
  await sec('S-3', B, { op: 'saveItem', shopId: A, itemId: id1, name: 'Hijack', price: 1, sectionId: mains }, 'not-employed-here', 'business B cannot act as shop A');
  await sec('S-4', PEND, { op: 'saveSections', shopId: PEND, sections: SECTIONS }, null, 'a PENDING business gets no menu');
  {
    /* The approval gate on its own: a workspace that is NOT routed/available must refuse even if it (wrongly) carries a
       module map — so the gate never depends on the module map being absent. */
    const w0 = nWrites();
    const stale = Object.assign(deps(), { workspaceFor: async () => ({ state: 'CAPABILITY_CONFLICT', route: null, reason: 'CAPABILITY_CONFLICT', merchantModules: { menu: { state: 'AVAILABLE' }, drinks: { state: 'AVAILABLE' } } }) });
    let x; try { x = await FM.handle(stale, A, { op: 'saveSections', shopId: A, sections: SECTIONS }); } catch (e) { x = { err: e.code, reason: e.details && e.details.reason }; }
    ck('S-4b', x.err && x.reason === 'CAPABILITY_CONFLICT' && nWrites() === w0, 'a business whose workspace is not AVAILABLE is refused even with a stale module map (nothing written)', x);
  }
  await sec('S-5', RET, { op: 'saveSections', shopId: RET, sections: SECTIONS }, 'MODULE_NOT_APPLICABLE', 'an approved NON-food business (supermarket) gets no menu module');
  await sec('S-6', 'uCash', { op: 'saveItem', shopId: A, draftToken: 'c1', name: 'X', price: 10, sectionId: mains }, 'ROLE_NOT_PERMITTED', 'a cashier cannot edit the menu');
  r = await call('uCash', { op: 'setAvailability', shopId: A, itemId: id1, availability: 'unavailable' });
  ck('S-7', r.ok === true, 'a cashier CAN mark a dish sold out (availability only)', r);
  await sec('S-8', 'uStaff', { op: 'setAvailability', shopId: A, itemId: id1, availability: 'available' }, 'ROLE_NOT_PERMITTED', 'plain staff cannot change availability');
  r = await call('uMgr', { op: 'saveItem', shopId: A, draftToken: 'm1', name: 'Pilau', price: 300, sectionId: mains });
  ck('S-9', r.ok === true && S().products[r.itemId].sellerUid === A, 'a manager can add items — owned by the SHOP OWNER, not the manager', r);
  await sec('S-10', 'uInv', { op: 'load', shopId: A }, 'employment-role-unknown', 'an employee role the staff authority does not define gets nothing');
  await sec('S-11', 'uMgr', { op: 'saveSections', shopId: A, sections: [{ name: 'Soft drinks', kind: 'drinks', id: drinks }] }, 'SECTION_IN_USE', 'a section holding live items cannot be removed');
  LIMIT = { allowed: false, count: 10, limit: 10 };
  await sec('S-12', A, { op: 'saveItem', shopId: A, draftToken: 'over', name: 'Over limit', price: 50, sectionId: mains }, 'PRODUCT_LIMIT_REACHED', 'PLAN LOCK: the product limit refuses a new item before anything is written');
  LIMIT = { allowed: true, count: 0, limit: 50 };
  await sec('S-13', A, { op: 'saveItem', shopId: A, itemId: '../shops/uRestB', name: 'X', price: 1, sectionId: mains }, 'NO_ITEM', 'a path-like item id is refused');
  await sec('S-14', A, { op: 'nuke', shopId: A }, 'UNKNOWN_OP', 'an unknown operation is refused');
  await sec('S-15', null, { op: 'load', shopId: A }, 'UNAUTHENTICATED', 'signed out → refused');
  DB._store.products.prd_foreign = { shopId: B, sellerUid: B, name: 'B dish', price: 99, status: 'active', menu: { sectionId: 'mains', kind: 'food' } };
  await sec('S-16', A, { op: 'archive', shopId: A, itemId: 'prd_foreign' }, 'ITEM_NOT_OWNED', 'business A cannot archive business B\'s product');

  /* ── PUBLIC MENU (storefront projection) ── */
  await call(A, { op: 'setStatus', shopId: A, itemId: id1, status: 'published' });
  await call(A, { op: 'setStatus', shopId: A, itemId: d1, status: 'published' });
  const pub = await call(null, { op: 'public', shopId: A });
  const pids = (pub.items || []).map((x) => x.id);
  ck('PUB-1', pub.ok && pub.available && pids.includes(id1) && pids.includes(d1) && !pids.includes(id2) && !pids.some((x) => S().products[x].status === 'draft'),
    'the public menu shows published items only — drafts and archived items are absent', pids);
  const pi1 = (pub.items || []).find((x) => x.id === id1) || {};
  ck('PUB-2', pi1.availability === 'out_of_stock' && pi1.sellable === false && pub.items.every((x) => x.orderable === false) && pub.ordering === 'NOT_OPEN',
    'an unavailable dish is shown as not sellable; nothing is orderable until Gate 3 opens ordering', pi1);
  ck('PUB-3', (pub.items || []).every((x) => !('sellerUid' in x) && !('createdBy' in x) && !('updatedBy' in x) && !('stock' in x)), 'the public projection carries no private fields');
  const pr = await call(null, { op: 'public', shopId: RET });
  ck('PUB-4', pr.ok && pr.available === false && pr.reason === 'NO_FOOD_MENU', 'a non-food shop has no public menu', pr);
  DB._store.shops[A].status = 'suspended';
  const ps = await call(null, { op: 'public', shopId: A });
  ck('PUB-5', ps.available === false && ps.reason === 'SHOP_NOT_PUBLIC' && (ps.items || []).length === 0, 'a suspended shop shows no menu (the one shop discovery gate)', ps);
  DB._store.shops[A].status = 'active';
  const pp = await call(null, { op: 'public', shopId: PEND });
  ck('PUB-6', pp.available === false, 'a pending business shows no public menu', pp);

  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
