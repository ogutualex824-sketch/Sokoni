#!/usr/bin/env node
/* FOOD HUB GATE 1 — approval → seller/business provisioning → C1 category → capabilities → merchant-v2.
 *
 *   node scripts/test-food-gate1-approval.js
 *   BASE=f66f2c1 node scripts/test-food-gate1-approval.js     (the live lifecycle — must FAIL)
 *   WORKSPACE=C:/temp/sok-cap0 node scripts/test-food-gate1-approval.js   (E2E rows; default C:/temp/sok-cap0)
 *
 * Executes the REAL applyDecision / projectSeller / resolveRole against an in-memory Firestore (firebase-admin is
 * replaced in the require cache; FieldValue sentinels are the real ones and are interpreted by the fake). The E2E rows
 * then hand the SAME store to the REAL business-workspace.workspaceFor (the providerDispatch authority, Slice 0 line),
 * so "approved food business opens merchant-v2" is proven through the reader, not assumed from the writer.
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 220) + ']')); ok ? pass++ : fail++; };

/* ── the lifecycle under test: this tree, or BASE's bytes in a temp copy of functions/ ── */
let FN = path.join(ROOT, 'functions');
if (process.env.BASE) {
  const tmp = fs.mkdtempSync(path.join(ROOT, 'functions', '.g1base-')); process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });
  for (const f of ['application-lifecycle.js', 'role-vocabulary.js', 'search-terms.js', 'business-category.js', 'healthcare-category.js']) {
    try { fs.writeFileSync(path.join(tmp, f), execSync('git show ' + process.env.BASE + ':functions/' + f, { cwd: ROOT, stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: 64 << 20 })); } catch (_) { /* absent at BASE */ }
  }
  FN = tmp;
}
const real = require(path.join(ROOT, 'functions', 'node_modules', 'firebase-admin', 'lib', 'firestore', 'index.js'));
const FieldValue = real.FieldValue;

/* ── fake Firestore ── */
function fakeDb(seed) {
  const store = JSON.parse(JSON.stringify(seed || {}));
  const kind = (v) => (v && typeof v === 'object' && v.constructor && /Transform|FieldValue/.test(v.constructor.name)) ? (v.methodName || v._methodName || v.constructor.name) : null;
  const apply = (cur, patch, merge) => {
    const out = merge && cur ? Object.assign({}, cur) : {};
    for (const [k, v] of Object.entries(patch)) {
      const m = kind(v);
      if (m && /delete/i.test(m)) { delete out[k]; continue; }
      if (m && /serverTimestamp/i.test(m)) { out[k] = '<ts>'; continue; }
      if (m && /arrayUnion/i.test(m)) { const el = v.elements || v._elements || []; out[k] = [...new Set([...(Array.isArray(out[k]) ? out[k] : []), ...el])]; continue; }
      if (m && /arrayRemove/i.test(m)) { const el = v.elements || v._elements || []; out[k] = (Array.isArray(out[k]) ? out[k] : []).filter((x) => !el.includes(x)); continue; }
      if (v && typeof v === 'object' && !Array.isArray(v)) { out[k] = apply(null, v, false); continue; }
      out[k] = v;
    }
    return out;
  };
  const docRef = (col, id) => ({
    id, parent: { id: col }, path: col + '/' + id,
    get: async () => { const d = store[col] && store[col][id]; return { id, exists: !!d, ref: docRef(col, id), data: () => (d ? JSON.parse(JSON.stringify(d)) : undefined) }; },
    set: async (patch, o) => { store[col] = store[col] || {}; store[col][id] = apply(store[col][id], patch, o && o.merge); },
    delete: async () => { if (store[col]) delete store[col][id]; },
  });
  const query = (col, filters, lim) => ({
    where: (f, op, v) => query(col, filters.concat([[f, op, v]]), lim),
    limit: (n) => query(col, filters, n),
    get: async () => {
      const rows = Object.entries(store[col] || {}).filter(([, d]) => filters.every(([f, , v]) => d[f] === v)).slice(0, lim || 1e9);
      const docs = rows.map(([id, d]) => ({ id, exists: true, ref: docRef(col, id), data: () => JSON.parse(JSON.stringify(d)) }));
      return { empty: !docs.length, size: docs.length, docs };
    },
  });
  let adds = 0;
  return {
    _store: store,
    collection: (col) => Object.assign(query(col, [], 0), { doc: (id) => docRef(col, id || ('auto' + (++adds))), add: async (d) => { const r = docRef(col, 'auto' + (++adds)); await r.set(d); return r; } }),
    batch: () => { const ops = []; return { set: (ref, p, o) => ops.push(() => ref.set(p, o)), commit: async () => { for (const op of ops) await op(); } }; },
    runTransaction: async (fn) => fn({ get: (r) => r.get(), set: (r, p, o) => r.set(p, o) }),
  };
}

/* ── load the lifecycle with firebase replaced ── */
let DB = fakeDb({});
const calls = { pos: [], notify: [], claims: {} };
const stub = (abs, exp) => { require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: exp }; };
const nm = (p) => require.resolve(p, { paths: [path.join(ROOT, 'functions')] });
stub(nm('firebase-admin/firestore'), { getFirestore: () => DB, FieldValue });
stub(nm('firebase-admin/auth'), { getAuth: () => ({ getUser: async (u) => ({ uid: u, customClaims: calls.claims[u] || (u === 'ADMIN1' ? { admin: true } : {}) }), setCustomUserClaims: async (u, c) => { calls.claims[u] = c; } }) });
stub(path.join(FN, 'business-bootstrap.js'), { _ensureBusinessForOwner: async (o) => { calls.pos.push(o); return { created: true, reason: 'provisioned', merchantId: 'SOK-TEST01' }; } });
stub(path.join(FN, 'notify.js'), { notify: async (n) => { calls.notify.push(n); return { ok: true }; } });
let LC = null;
try { LC = require(path.join(FN, 'application-lifecycle.js'))._internal; } catch (e) { console.log('CRASH loading lifecycle (no verdict): ' + e.message); process.exit(2); }

const UID = 'uFood0001', ADMIN = 'ADMIN1';
const foodApp = (over) => Object.assign({ applicationId: 'APPF1', uid: UID, name: 'Mama Oliech Kitchen', category: 'cafe', categoryLabel: 'Café / Coffee Shop', hub: 'food',
  requestedRole: 'provider', role: 'provider', roleResolvedBy: 'explicit', type: 'business', status: 'approved', statusCanonical: 'approved', decidedBy: ADMIN, phoneNumber: '+254700000001' }, over || {});
const seed = (app, extra) => Object.assign({ applications: { APPF1: app }, applicationDecisions: { APPF1: { status: app.status, decidedBy: ADMIN } } }, extra || {});
const S = () => DB._store;
const G = (c, id) => ((S()[c] || {})[id || UID]) || {};

(async () => {
  console.log('\nFood Hub Gate 1   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');

  /* ── R: role ── */
  const rr = LC.resolveRole(foodApp());
  ck('R-1', rr.role === 'seller', 'a café declared `provider` by hub-register resolves to SELLER (its category is a merchant-v2 category)', rr);
  ck('R-2', LC.resolveRole(foodApp({ category: 'plumbing', hub: 'service' })).role === 'provider', 'CONTROL: a plumber stays a provider');
  ck('R-3', LC.resolveRole(foodApp({ requestedRole: 'health', category: 'cafe' })).role === 'health', 'only `provider` is re-filed — another declared role stands');
  ck('R-4', LC.resolveRole(foodApp({ category: 'free text restaurant' })).role === 'provider', 'free text never re-files (exact business ids only)');

  /* ── A: approval provisions ── */
  DB = fakeDb(seed(foodApp()));
  let res; try { res = await LC.applyDecision('APPF1', foodApp(), { decidedBy: ADMIN }); } catch (e) { res = { crash: e.message }; }
  const shop = (S().shops || {})[UID], sel = (S().sellers || {})[UID], biz = (S().businesses || {})[UID], app = S().applications.APPF1, user = (S().users || {})[UID] || {};
  ck('A-1', res && res.ok === true && res.role === 'seller', 'applyDecision applies the approval as a SELLER', res);
  ck('A-2', !!shop && shop.ownerId === UID && shop.sellerUid === UID && shop.status === 'active', 'shops/{uid} is created, owned by the applicant, active', shop);
  ck('A-3', !!sel && sel.status === 'active' && sel.active === true && sel.approvedAt && sel.approvedBy === ADMIN, 'sellers/{uid} carries APPROVAL EVIDENCE (approvedAt + approvedBy, client-unwritable)', sel);
  ck('A-4', [shop, sel, biz].every((d) => d && d.business && d.business.category === 'restaurant' && d.business.source === 'application' && d.business.applicationId === 'APPF1'),
    'the C1 category `restaurant` is stamped by the server on shop, seller and business', [shop, sel, biz].map((d) => d && d.business));
  ck('A-5', !!biz && !('ownerId' in biz), 'businesses/{uid} carries the stamp but NOT ownerId (the POS business stays the one `ownerId == uid` record)', biz);
  ck('A-6', [shop, sel, biz].every((d) => d && d._noIndex === true && d.discovery === 'HELD' && d.searchable !== true && d.isPublic !== true),
    'APPROVED ≠ DISCOVERABLE: new records are held from search (no searchable/isPublic true)', [shop, sel, biz].map((d) => d && [d._noIndex, d.discovery, d.searchable, d.isPublic]));
  ck('A-7', app.role === 'seller' && /\+category$/.test(app.roleResolvedBy || ''), 'the application records the role its decision applied (the workspace judges the approval by app.role)', [app.role, app.roleResolvedBy]);
  ck('A-8', (user.roles || []).includes('seller') && calls.claims[UID] && calls.claims[UID].seller === true, 'the account is granted the seller role and claim', [user.roles, calls.claims[UID]]);
  ck('A-9', calls.pos.length === 1 && calls.pos[0].uid === UID, 'POS business provisioning still runs once (unchanged path)', calls.pos);
  const msg = (calls.notify[0] || {}).body || '';
  ck('A-10', !!msg && !/customers can find you in search/.test(msg), 'the approval message does not claim the shop is already in search', msg);
  ck('A-11', user.activeShopId === UID, 'the account\'s active shop is set');

  /* ── I: idempotency ── */
  const before = JSON.stringify([S().shops, S().sellers, S().businesses].map((c) => Object.keys(c || {}).length));
  await LC.applyDecision('APPF1', S().applications.APPF1, { decidedBy: ADMIN });
  const after = JSON.stringify([S().shops, S().sellers, S().businesses].map((c) => Object.keys(c || {}).length));
  ck('I-1', before === after && G('shops').ownerId === UID, 're-approval converges on the same records (no second shop / seller / business)', [before, after]);

  /* ── E2E through the REAL workspace authority ── */
  const WS = process.env.WORKSPACE || 'C:/temp/sok-cap0';
  let workspaceFor = null;
  try { workspaceFor = require(path.join(WS, 'functions', 'business-workspace.js')).workspaceFor; } catch (e) { console.log('  (workspace authority not loadable from ' + WS + ': ' + e.message + ')'); }
  const wsOpts = { approval: { getUser: async (u) => ({ uid: u, customClaims: u === ADMIN ? { admin: true } : (calls.claims[u] || {}) }) } };
  if (workspaceFor) {
    const w = await workspaceFor(DB, UID, wsOpts).catch((e) => ({ crash: e.message }));
    ck('W-1', w.route === 'merchant-v2.html' && w.state === 'AVAILABLE' && w.category === 'restaurant', 'E2E: the approved café opens MERCHANT-V2 (route, AVAILABLE, category restaurant) through workspaceFor', { route: w.route, state: w.state, reason: w.reason, category: w.category, crash: w.crash });
    ck('W-2', ['FOOD_MENU', 'KITCHEN', 'DRINKS'].every((c) => (w.serviceCapabilities || []).includes(c)), 'E2E: the food capabilities resolve from the VALID approval', w.serviceCapabilities);
  } else { ck('W-1', false, 'E2E: workspace authority unavailable — UNPROVEN, not a pass'); }

  /* ── N: negative paths ── */
  DB = fakeDb(seed(foodApp({ status: 'pending', statusCanonical: 'pending', decidedBy: undefined })));
  calls.claims = {};
  if (workspaceFor) {
    const w = await workspaceFor(DB, UID, wsOpts);
    ck('N-1', w.route !== 'merchant-v2.html' && w.state !== 'AVAILABLE' && !(S().shops || {})[UID] && !(w.serviceCapabilities || []).length, 'a PENDING food application provisions nothing, opens no workspace and grants no capability', { route: w.route, state: w.state, reason: w.reason });
  }
  DB = fakeDb(seed(foodApp(), { shops: { [UID]: { ownerId: 'someoneElse', name: 'Not yours' } } }));
  const hijack = await LC.applyDecision('APPF1', foodApp(), { decidedBy: ADMIN }).catch((e) => ({ thrown: e.code || e.message }));
  ck('N-2', G('shops').ownerId === 'someoneElse' && !(S().sellers || {})[UID] && !((S().users || {})[UID] || {}).roles, 'a shop owned by ANOTHER account is never taken over — no seller, no role', { hijack, shop: G('shops') });
  DB = fakeDb(seed(foodApp({ shopId: 'shopOfVictim' }), { shops: { shopOfVictim: { sellerUid: 'victim' } } }));
  await LC.applyDecision('APPF1', foodApp({ shopId: 'shopOfVictim' }), { decidedBy: ADMIN }).catch(() => {});
  ck('N-3', G('shops','shopOfVictim').sellerUid === 'victim' && S().applications.APPF1.projectionStatus === 'failed', 'an applicant-written shopId naming another merchant\'s shop FAILS the projection', S().applications.APPF1.projectionStatus);
  DB = fakeDb(seed(foodApp({ shopId: '../../users/x' })));
  await LC.applyDecision('APPF1', foodApp({ shopId: '../../users/x' }), { decidedBy: ADMIN }).catch(() => {});
  ck('N-4', S().applications.APPF1.projectionStatus === 'failed' && !S().shops, 'a malformed shopId is refused, never sanitised into another id', S().applications.APPF1.projectionStatus);

  /* ── X: an AdminOS classification is never overwritten; a failed derivation never nulls a category ── */
  DB = fakeDb(seed(foodApp(), { businesses: { [UID]: { uid: UID, business: { category: 'supermarket', source: 'admin', classifiedBy: ADMIN } } } }));
  await LC.applyDecision('APPF1', foodApp(), { decidedBy: ADMIN });
  ck('X-1', (G('shops').business || {}).category === 'supermarket' && (G('shops').business || {}).source === 'admin', 'an AdminOS classification survives re-approval', G('shops').business);

  /* ── S: suspension hides, reinstatement restores exactly what it hid ── */
  DB = fakeDb(seed(foodApp(), { sellers: { [UID]: { uid: UID, name: 'Existing', searchable: true, status: 'active', approvedAt: 'x' } } }));
  await LC.applyDecision('APPF1', foodApp(), { decidedBy: ADMIN });
  ck('S-0', G('sellers').searchable === true && G('sellers')._noIndex === undefined && G('sellers').name === 'Existing', 'an EXISTING seller keeps its visibility and name (approval never de-indexes or renames)', G('sellers'));
  const susp = foodApp({ status: 'suspended', statusCanonical: 'suspended' });
  DB._store.applicationDecisions.APPF1 = { status: 'suspended', decidedBy: ADMIN };
  await LC.applyDecision('APPF1', susp, { decidedBy: ADMIN });
  ck('S-1', ['shops', 'sellers', 'businesses'].every((c) => G(c).status === 'suspended' && G(c).searchable === false && G(c).isPublic === false) && G('sellers').active === false,
    'suspension deactivates shop, seller and business and removes them from discovery (records kept)', ['shops', 'sellers', 'businesses'].map((c) => G(c) && G(c).status));
  await LC.applyDecision('APPF1', foodApp(), { decidedBy: ADMIN });
  ck('S-2', G('sellers').searchable === true && !('isPublic' in G('sellers')) && !('searchable' in G('shops')) && G('sellers').status === 'active',
    'reinstatement restores exactly the visibility the suspension removed — nothing more', [G('sellers'), G('shops')].map((d) => [d.searchable, d.isPublic, d.status]));
  ck('S-3', !((S().users || {})[UID] || {}).roles || (S().users[UID].roles || []).includes('seller'), 'the reinstated account holds the seller role again');

  /* ── C: rejection of a never-provisioned applicant writes nothing ── */
  DB = fakeDb(seed(foodApp({ status: 'rejected', statusCanonical: 'rejected' })));
  DB._store.applicationDecisions.APPF1 = { status: 'rejected', decidedBy: ADMIN };
  await LC.applyDecision('APPF1', foodApp({ status: 'rejected', statusCanonical: 'rejected' }), { decidedBy: ADMIN });
  ck('C-1', !S().shops && !S().sellers && !S().businesses, 'a rejected applicant gets no shop, seller or business');

  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
