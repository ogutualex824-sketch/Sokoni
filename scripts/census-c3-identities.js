#!/usr/bin/env node
/* C3 — READ-ONLY production census. Writes NOTHING to Auth or Firestore (authorized by the owner 2026-09-29,
   read-only scope). Two outputs, kept apart:
     A  classification census: one row per business identity (owner uid) → observed facts → proposed capability
        → authority status → conflict codes, computed by the C2 read model (functions/shared/business-capabilities.js)
     B  exact cleanup manifest: ONLY records positively identified by an established evidence rule:
          R1  Auth account whose email is on a certification domain (@sokoni-cert.invalid, @sokoni-cert.test)
              — the rule used by the authorized 2026-09-28 cleanup
          R2  users/{uid} doc whose uid has NO Auth account (orphaned profile)
          R3  sellers/{uid} or providers/{uid} doc whose uid has NO Auth account (orphaned registry record)
          R4  businesses / merchants / shops doc whose owner uid has NO Auth account (orphaned business record)
          R5  products doc whose sellerUid has NO Auth account (orphaned product)
        Anything that merely LOOKS unused or test-like is listed under "candidates_needing_owner_judgement",
        never in the manifest. The manifest carries a sha256 over its sorted ids so a later step can re-census
        and require exact-set equality before any deletion is even proposed. */
'use strict';
const path = require('path'); const fs = require('fs'); const crypto = require('crypto');
const REPO = path.resolve(__dirname, '..');
const _r = require('module').createRequire(REPO + '/functions/package.json');
const admin = _r('firebase-admin');
const { getFirestore } = _r('firebase-admin/firestore');
const CAP = require(REPO + '/functions/shared/business-capabilities.js');
const app = admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: 'sokoni-aeb26' });
const db = getFirestore(app); const ops = getFirestore(app, 'sokoni-ops');
const OUTDIR = process.env.C3_OUT || require("os").tmpdir(); const SCAN = 20000;
const CERT_DOMAIN = /\.invalid$|@sokoni-cert\.test$/i;   /* RFC 2606: a .invalid domain can never be a real mailbox */
const TEST_NAME = /\b(test|fake|demo|dummy|sample|lorem|placeholder)\b/i;
const red = (s) => (s ? String(s).replace(/(.{2}).+(@.*)/, '$1***$2') : s);
const ts = (v) => (v && v.toDate ? v.toDate().toISOString() : (v && v._seconds ? new Date(v._seconds * 1000).toISOString() : (v || null)));
async function scan(col, dbx = db) { const out = []; try { const s = await dbx.collection(col).limit(SCAN).get(); s.forEach((d) => out.push(Object.assign({ __id: d.id }, d.data()))); } catch (e) { out.__error = e.message; } return out; }
async function listAuth() { const users = []; let token; do { const r = await admin.auth().listUsers(1000, token); users.push(...r.users); token = r.pageToken; } while (token); return users; }
const ownerOf = (d) => d.ownerId || d.ownerUid || d.sellerUid || d.uid || d.userId || d.merchantId || null;
const nameOf = (d) => d.name || d.shopName || d.businessName || d.storeName || d.displayName || d.title || d.fullName || '';

(async () => {
  const auth = await listAuth(); const authById = new Map(auth.map((u) => [u.uid, u]));
  const [users, sellers, providers, businesses, shops, merchants, products, applications, providerProfiles] = await Promise.all(
    ['users', 'sellers', 'providers', 'businesses', 'shops', 'merchants', 'products', 'applications', 'providerProfiles'].map((c) => scan(c)));
  /* other product-bearing collections, for the two named owners and for orphan detection */
  const [posProducts, inventoryProducts, listings, providerServices, services] = await Promise.all(['posProducts', 'inventory_products', 'listings', 'providerServices', 'services'].map((c) => scan(c)));
  const opsCols = {}; try { for (const c of await ops.listCollections()) if (/^(users|businesses|shops|sellers|providers|products|applications)$/.test(c.id)) opsCols[c.id] = (await ops.collection(c.id).count().get()).data().count; } catch (e) { opsCols.error = e.message; }
  const usersUnique = new Set(users.map((u) => u.__id));

  /* ── A · classification census ──────────────────────────────────────── */
  const byUid = (rows, key) => { const m = new Map(); for (const r of rows) { const k = key(r); if (!k) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };
  const sellerBy = new Map(sellers.map((s) => [s.__id, s])), providerBy = new Map(providers.map((p) => [p.__id, p]));
  const bizByOwner = byUid(businesses, ownerOf), shopByOwner = byUid(shops, ownerOf), appsByUid = byUid(applications, (a) => a.uid || a.providerUid || a.applicantUid);
  const prodByOwner = byUid(products, (p) => p.sellerUid || p.ownerId || p.uid);
  const identities = new Set([...sellerBy.keys(), ...providerBy.keys(), ...bizByOwner.keys(), ...shopByOwner.keys(), ...appsByUid.keys()]);
  const censusA = [];
  for (const uid of identities) {
    const biz = (bizByOwner.get(uid) || [])[0] || null, shop = (shopByOwner.get(uid) || [])[0] || null;
    const rm = CAP.readModel({ seller: sellerBy.get(uid) || null, provider: providerBy.get(uid) || null, applications: appsByUid.get(uid) || [], business: biz, shop, productCount: (prodByOwner.get(uid) || []).length });
    const a = authById.get(uid);
    censusA.push({ uid, auth: a ? 'present' : 'ABSENT', email: a ? red(a.email) : null, claims: a ? Object.keys(a.customClaims || {}).filter((k) => a.customClaims[k]) : [], usersDoc: usersUnique.has(uid),
      name: nameOf(biz || shop || providerBy.get(uid) || sellerBy.get(uid) || {}), businesses: (bizByOwner.get(uid) || []).length, shops: (shopByOwner.get(uid) || []).length,
      observed: { seller: rm.observed.seller, provider: rm.observed.provider, applications: rm.observed.applications, business: rm.observed.business, shop: rm.observed.shop, productCount: rm.observed.productCount },
      proposed: rm.proposed, classification: rm.classification, authorityStatus: rm.authorityStatus, conflicts: rm.conflicts.map((c) => c.code + (c.capability ? ':' + c.capability : '')), notes: rm.notes.map((n) => n.code + ':' + n.capability) });
  }
  /* the two named owners: every product-bearing collection */
  const NAMED = { dgwine: 'Ohg9HrtGpCXBUSzbRfaUifOPWQ32', latomi: 'IaOBkEJYcCXk23UDWk0OPp7XXeD3' };
  const named = {};
  for (const [k, uid] of Object.entries(NAMED)) {
    const hits = (rows, col) => rows.filter((r) => JSON.stringify(r).includes(uid)).map((r) => col + '/' + r.__id);
    named[k] = { uid, products: hits(products, 'products'), posProducts: hits(posProducts, 'posProducts'), inventory_products: hits(inventoryProducts, 'inventory_products'), listings: hits(listings, 'listings'), providerServices: hits(providerServices, 'providerServices'), services: hits(services, 'services'), providerProfiles: hits(providerProfiles, 'providerProfiles'), row: censusA.find((r) => r.uid === uid) || null };
  }

  /* ── B · exact manifest ─────────────────────────────────────────────── */
  const manifest = [];
  const add = (rule, collection, id, why) => manifest.push({ rule, collection, id, why });
  for (const u of auth) if (CERT_DOMAIN.test(u.email || '')) add('R1', 'auth', u.uid, 'cert-domain email ' + red(u.email));
  for (const u of users) if (!authById.has(u.__id)) add('R2', 'users', u.__id, 'no Auth account');
  for (const s of sellers) if (!authById.has(s.__id)) add('R3', 'sellers', s.__id, 'no Auth account');
  for (const p of providers) if (!authById.has(p.__id)) add('R3', 'providers', p.__id, 'no Auth account');
  for (const [col, rows] of [['businesses', businesses], ['merchants', merchants], ['shops', shops]]) for (const d of rows) { const o = ownerOf(d); if (o && !authById.has(o)) add('R4', col, d.__id, 'owner ' + o + ' has no Auth account'); }
  for (const p of products) { const o = p.sellerUid; if (o && !authById.has(o)) add('R5', 'products', p.__id, 'sellerUid ' + o + ' has no Auth account'); }
  /* R6: registry / business / shop / product records OWNED by an R1 account are the same synthetic identity */
  const r1 = new Set(manifest.filter((x) => x.rule === 'R1').map((x) => x.id));
  for (const [col, rows] of [['sellers', sellers], ['providers', providers]]) for (const d of rows) if (r1.has(d.__id)) add('R6', col, d.__id, 'registry doc of a reserved-domain account');
  for (const [col, rows] of [['businesses', businesses], ['merchants', merchants], ['shops', shops], ['products', products]]) for (const d of rows) { const o = ownerOf(d); if (o && r1.has(o)) add('R6', col, d.__id, 'owned by reserved-domain account ' + o); }
  /* R1 accounts' own users docs are part of the same identity (precedent) */
  for (const m of manifest.filter((x) => x.rule === 'R1')) if (usersUnique.has(m.id) && !manifest.some((x) => x.collection === 'users' && x.id === m.id)) add('R1', 'users', m.id, 'users doc of a cert-domain account');
  const ids = manifest.map((m) => m.collection + '/' + m.id).sort();
  const digest = crypto.createHash('sha256').update(ids.join('\n')).digest('hex');
  /* candidates by name only — judgement, not evidence */
  const candidates = [];
  for (const [col, rows] of [['products', products], ['businesses', businesses], ['shops', shops], ['sellers', sellers], ['providers', providers]]) for (const d of rows) if (TEST_NAME.test(nameOf(d))) candidates.push({ collection: col, id: d.__id, name: nameOf(d), owner: ownerOf(d), ownerAuth: ownerOf(d) ? authById.has(ownerOf(d)) : null });
  const patternAuth = auth.filter((u) => !CERT_DOMAIN.test(u.email || '') && /@example\.|@test\.|mailinator|yopmail|^test[\w.+-]*@|^fake|^demo[\w.+-]*@/i.test(u.email || '')).map((u) => ({ collection: 'auth', id: u.uid, email: red(u.email), created: u.metadata.creationTime, lastSignIn: u.metadata.lastSignInTime || null, usersDoc: usersUnique.has(u.uid) }));

  const out = { at: new Date().toISOString(), readOnly: true, scanBound: SCAN, populations: { auth: auth.length, users: users.length, sellers: sellers.length, providers: providers.length, businesses: businesses.length, shops: shops.length, merchants: merchants.length, products: products.length, applications: applications.length, posProducts: posProducts.length, inventory_products: inventoryProducts.length, listings: listings.length, providerServices: providerServices.length, services: services.length, opsDatabase: opsCols },
    authVsUsers: { authWithoutUsersDoc: auth.filter((u) => !usersUnique.has(u.uid)).map((u) => ({ uid: u.uid, email: red(u.email), created: u.metadata.creationTime, lastSignIn: u.metadata.lastSignInTime || null, providers: u.providerData.map((p) => p.providerId) })), usersDocWithoutAuth: users.filter((u) => !authById.has(u.__id)).map((u) => ({ id: u.__id, email: red(u.email), roles: u.roles || null, role: u.role || null, createdAt: ts(u.createdAt) })) },
    censusA, named, manifest: { rules: { R1: 'Auth account on an RFC 2606 reserved .invalid domain or @sokoni-cert.test (+ its users doc)', R2: 'users doc with no Auth account', R3: 'sellers/providers doc with no Auth account', R4: 'businesses/merchants/shops whose owner has no Auth account', R5: 'products whose sellerUid has no Auth account', R6: 'sellers/providers/businesses/merchants/shops/products owned by an R1 account' }, count: manifest.length, ids, digest, entries: manifest },
    candidates_needing_owner_judgement: { byName: candidates, authPatternNonCert: patternAuth } };
  fs.writeFileSync(path.join(OUTDIR, 'c3-census.json'), JSON.stringify(out, null, 2));
  /* summary (uids, redacted emails only) */
  const byClass = censusA.reduce((m, r) => { m[r.classification] = (m[r.classification] || 0) + 1; return m; }, {});
  console.log('C3 READ-ONLY CENSUS @ ' + out.at + '  identities ' + censusA.length + '  ' + JSON.stringify(byClass));
  console.log('populations ' + JSON.stringify(out.populations));
  console.log('--- A · identities');
  for (const r of censusA) console.log([r.uid, r.auth, (r.name || '—').slice(0, 24).padEnd(24), r.classification.padEnd(22), r.authorityStatus, 'seller=' + r.observed.seller, 'provider=' + r.observed.provider, 'apps=' + r.observed.applications.approved.join('+') + (r.observed.applications.pending.length ? '(pending ' + r.observed.applications.pending.join('+') + ')' : ''), 'biz=' + r.businesses, 'shop=' + r.shops, 'prod=' + r.observed.productCount, r.conflicts.length ? 'CONFLICT ' + r.conflicts.join(',') : '', r.notes.join(',')].join('  '));
  console.log('--- named owners');
  for (const [k, v] of Object.entries(named)) console.log(k, v.uid, JSON.stringify({ products: v.products.length, posProducts: v.posProducts.length, inventory_products: v.inventory_products.length, listings: v.listings.length, providerServices: v.providerServices.length, services: v.services.length, providerProfiles: v.providerProfiles }), v.row ? v.row.classification + '/' + v.row.authorityStatus + ' conflicts=' + v.row.conflicts.join(',') : 'NO ROW');
  console.log('--- B · manifest  count ' + manifest.length + '  digest ' + digest);
  for (const m of manifest) console.log(' ', m.rule, m.collection + '/' + m.id, m.why);
  console.log('--- auth without users doc ' + out.authVsUsers.authWithoutUsersDoc.length + ' · users doc without auth ' + out.authVsUsers.usersDocWithoutAuth.length);
  for (const u of out.authVsUsers.authWithoutUsersDoc) console.log('  auth-only', u.uid, u.email, u.created, 'lastSignIn=' + u.lastSignIn, u.providers.join('+'));
  console.log('--- candidates needing owner judgement: byName ' + candidates.length + ' · non-cert pattern auth ' + patternAuth.length);
  for (const c of candidates) console.log('  name', c.collection + '/' + c.id, JSON.stringify(c.name), 'owner=' + c.owner, 'ownerAuth=' + c.ownerAuth);
  for (const c of patternAuth) console.log('  authpattern', c.id, c.email, c.created, 'lastSignIn=' + c.lastSignIn, 'usersDoc=' + c.usersDoc);
  console.log('json → ' + path.join(OUTDIR, 'c3-census.json'));
  process.exit(0);
})().catch((e) => { console.error('CENSUS FAILED — ' + (e.stack || e)); process.exit(2); });
