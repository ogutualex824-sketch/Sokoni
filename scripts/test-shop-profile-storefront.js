#!/usr/bin/env node
/* test-shop-profile-storefront.js — the shop profile (seller.html wizard + its merchant-v2 port) is SAVED by one server
 * authority and REACHES the public storefront (2026-09-29).
 *
 *   node scripts/test-shop-profile-storefront.js                 # working tree — must PASS
 *   COUNTERPROOF=1 node scripts/test-shop-profile-storefront.js  # functions @ 62e38b3 — failures ARE the defects
 *
 * REAL kasshop.saveShopProfile / getShopProfile and minishop-config-schema.resolve (the storefront's reader) on the
 * transactional fake Firestore.
 *
 * PROVES
 *   P1  every wizard field is saved on the canonical shop (identity, setup, socials incl. LinkedIn, delivery, returns)
 *   P2  the storefront reads the saved profile: tagline, description (= about), contact, logo, cover (= banner), accent,
 *       socials (incl. LinkedIn), location (address + city), delivery areas, delivery policy, returns policy
 *   P3  a stale, older storefront config no longer hides the saved profile (the projection is rebuilt on save)
 *   P4  clearing a social handle removes it from the storefront (socialLinks replaced, not deep-merged)
 *   P5  the shop's own `location` (read BEFORE the config) follows the saved address + city
 *   P6  freeDelivery is saved but NOT promised to buyers (no checkout path applies it)
 *   V1  a javascript: / data: website or image is refused and reported `invalid`
 *   V2  a pasted profile URL becomes a handle; a hostile handle is refused
 *   V3  choice fields accept only their codes; seller.html's gradient themeColor is refused (it truncated into invalid CSS)
 *   V4  permit documents are recorded only inside the caller's own kyc-documents folder, owner-only
 *   V5  getShopProfile returns the permits, the status and the SOKONI category (read-only)
 *   S1  storefront guard: sokoni-minishop.js renders a social / website link only when it is http(s)
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process'), Module = require('module');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
const CPM = !!process.env.COUNTERPROOF, BASE = '62e38b3';
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
let pass = 0, fail = 0;
const say = console.log; console.log = console.info = console.warn = console.debug = () => {};
const ck = (n, ok, d) => { if (ok) { pass++; say('  PASS  ' + n); } else { fail++; say('  FAIL  ' + n + (d !== undefined ? '   ' + JSON.stringify(d).slice(0, 300) : '')); } };
let tmp = null;
function load(rel) {
  if (!CPM) return require(path.join(FN, rel));
  tmp = tmp || fs.mkdtempSync(path.join(os.tmpdir(), 'shopprof-'));
  const out = path.join(tmp, rel.replace(/\//g, '__'));
  fs.writeFileSync(out, cp.execFileSync('git', ['show', BASE + ':functions/' + rel], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6 }));
  return require(out);
}
const F = makeFakeFirestore({ clock: () => Date.now() });
const db = F.db;
class HttpsError extends Error { constructor(c, m) { super(m); this.code = c; } }
const origReq = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath };
  if (id === 'firebase-admin') return { apps: [{}], initializeApp: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp }) };
  if (id === 'firebase-functions/logger') return { info() {}, warn() {}, debug() {}, error() {} };
  if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => (h || _o), onRequest: (_o, h) => (h || _o), HttpsError };
  if (tmp && this.filename && this.filename.startsWith(tmp) && id.startsWith('./')) return origReq.call(this, path.join(FN, id));
  return origReq.apply(this, arguments);
};
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };

(async () => {
  say('\nSOURCE: ' + (CPM ? `functions @ ${BASE} — failures below ARE the defects` : 'working tree (fix)'));
  const KS = load('kasshop.js');
  const SCHEMA = require(path.join(FN, 'minishop-config-schema.js'));   /* the storefront's reader (working tree in both runs) */
  const U = 'seller1';
  await db.doc('shops/' + U).set({ sellerUid: U, ownerId: U, name: 'Old Name', status: 'active', location: 'Applied: Nairobi',
    business: { category: 'fashion', source: 'application' }, searchable: true, isPublic: true });
  /* an OLDER storefront config written by the previous Details tab — it used to win over the shop document */
  await db.doc('minishopConfig/' + U).set({ handle: 'mama-njeri', tagline: 'STALE tagline', description: 'STALE description', schemaVersion: 2 });
  const save = (profile, compliance) => KS.saveShopProfile({ auth: { uid: U }, data: compliance ? { profile, compliance } : { profile } });
  const full = {
    name: 'Mama Njeri Fashion', tagline: 'Kitenge made to measure', about: 'We tailor kitenge dresses and shirts in Gikomba since 2009.',
    sellerType: 'longterm', logoUrl: 'https://firebasestorage.googleapis.com/v0/b/x/o/seller-assets%2Fseller1%2Flogo.jpg?alt=media',
    bannerUrl: 'https://firebasestorage.googleapis.com/v0/b/x/o/seller-assets%2Fseller1%2Fbanner.jpg?alt=media', themeColor: '#ff6b35',
    city: 'nairobi', shopType: 'hybrid', address: 'Gikomba Market, Stall 14', mapsLink: 'https://maps.app.goo.gl/abc123',
    phone: '0712345678', email: 'mama@njeri.co.ke', website: 'https://njeri.co.ke', instagram: 'https://www.instagram.com/mamanjeri/',
    tiktok: '@mamanjeri', facebook: 'mamanjeri', twitter: 'mamanjeri', youtube: '@mamanjeri', linkedin: 'https://www.linkedin.com/company/mama-njeri',
    delMethod: 'both', delTime: 'sameday', freeDelivery: '3000', zones: ['Nairobi CBD', 'Westlands', 'Ruiru'],
    packagingNote: 'Wrapped in reusable cloth bags.', returnPolicy: 'custom', returnText: 'Exchanges within 14 days with receipt.',
  };
  const r1 = await save(full, { kraPin: 'A012345678B', permits: { kra: 'kyc-documents/seller1/permit-kra-1.pdf', fire: 'kyc-documents/OTHER/permit-fire.pdf' } });
  const shop = await get('shops/' + U);
  ck('P1  every wizard field is saved on the canonical shop', ['name', 'tagline', 'about', 'sellerType', 'themeColor', 'city', 'shopType', 'address', 'mapsLink', 'phone', 'email',
    'delMethod', 'delTime', 'freeDelivery', 'packagingNote', 'returnPolicy', 'returnText'].every((k) => shop[k] === full[k])
    && shop.website === 'https://njeri.co.ke/' /* URL-normalised */ && shop.linkedin === 'company/mama-njeri' && shop.instagram === 'mamanjeri' && shop.zones.join() === 'Nairobi CBD,Westlands,Ruiru',
    Object.fromEntries(['sellerType', 'themeColor', 'linkedin', 'instagram', 'freeDelivery'].map((k) => [k, shop[k]])));
  const cfg = await get('minishopConfig/' + U);
  const eff = SCHEMA.resolve(cfg, null, shop);
  ck('P2  the storefront reads the saved profile (tagline, description, contact, logo, cover, accent, socials, areas, delivery, returns)',
    eff.tagline === full.tagline && eff.description === full.about && eff.contactPhone === '0712345678' && eff.contactEmail === full.email
    && /seller-assets%2Fseller1%2Flogo/.test(eff.logoUrl || '') && /banner/.test(eff.coverUrl || '') && eff.brandColor === '#ff6b35'
    && eff.socialLinks && eff.socialLinks.linkedin === 'company/mama-njeri' && eff.socialLinks.instagram === 'mamanjeri' && eff.socialLinks.website === 'https://njeri.co.ke/'
    && (eff.deliveryAreas || []).join() === 'Nairobi CBD,Westlands,Ruiru' && /SOKONI riders or our own riders/.test(eff.deliveryPolicy || '') && /same day/.test(eff.deliveryPolicy || '')
    && /reusable cloth/.test(eff.deliveryPolicy || '') && eff.policies === full.returnText, eff);
  ck('P3  the stale storefront config no longer hides the saved profile; the storefront keeps a handle', !/STALE/.test(eff.tagline + eff.description) && cfg && !!cfg.handle, { tagline: eff.tagline, handle: cfg && cfg.handle });
  ck('P5  the shop\'s own location follows the saved address + city', shop.location === 'Gikomba Market, Stall 14, Nairobi', shop.location);
  ck('P6  freeDelivery is saved but not promised to buyers', shop.freeDelivery === '3000' && !/3,?000|free/i.test(JSON.stringify(eff)), eff.deliveryPolicy);
  await save({ name: 'Mama Njeri Fashion', instagram: '', linkedin: '' });
  const eff2 = SCHEMA.resolve(await get('minishopConfig/' + U), null, await get('shops/' + U));
  ck('P4  clearing a social handle removes it from the storefront', eff2.socialLinks && !eff2.socialLinks.instagram && !eff2.socialLinks.linkedin && eff2.socialLinks.tiktok === 'mamanjeri', eff2.socialLinks);

  const r3 = await save({ name: 'Mama Njeri Fashion', website: 'javascript:alert(1)', logoUrl: 'data:image/png;base64,AAAA', bannerUrl: 'http://insecure.example/b.jpg', mapsLink: 'javascript:x' });
  const s3 = await get('shops/' + U);
  ck('V1  javascript: / data: / http images are refused and reported invalid; earlier values kept',
    Array.isArray(r3.invalid) && ['website', 'logoUrl', 'bannerUrl', 'mapsLink'].every((k) => r3.invalid.includes(k)) && s3.website === 'https://njeri.co.ke/' && s3.logoUrl === full.logoUrl, { invalid: r3.invalid, website: s3.website });
  const r4 = await save({ name: 'Mama Njeri Fashion', instagram: 'https://instagram.com/new.handle?igsh=xyz', twitter: '"><img src=x onerror=alert(1)>' });
  const s4 = await get('shops/' + U);
  ck('V2  a pasted profile URL becomes a handle; a hostile handle is refused', s4.instagram === 'new.handle' && (r4.invalid || []).includes('twitter') && s4.twitter === 'mamanjeri', { ig: s4.instagram, tw: s4.twitter, invalid: r4.invalid });
  const r5 = await save({ name: 'Mama Njeri Fashion', delMethod: 'drone', shopType: 'metaverse', themeColor: 'linear-gradient(135deg,#0d2010,#0a1020,#1a0d10)' });
  const s5 = await get('shops/' + U);
  ck('V3  choice fields accept only their codes; the gradient themeColor is refused', ['delMethod', 'shopType', 'themeColor'].every((k) => (r5.invalid || []).includes(k)) && s5.delMethod === 'both' && s5.themeColor === '#ff6b35', r5.invalid);
  const comp = await get('shops/' + U + '/private/compliance');
  ck('V4  permits are recorded only inside the caller\'s own kyc-documents folder', comp && comp.permits && comp.permits.kra === 'kyc-documents/seller1/permit-kra-1.pdf' && !comp.permits.fire, comp && comp.permits);
  const g = await KS.getShopProfile({ auth: { uid: U }, data: {} });
  ck('V5  getShopProfile returns permits, status and the SOKONI category (read-only)', g.compliance && g.compliance.permits && g.compliance.permits.kra && g.status === 'active'
    && g.sokoniCategory && g.sokoniCategory.id === 'fashion' && g.sokoniCategory.listed === true, { status: g.status, cat: g.sokoniCategory, permits: g.compliance && g.compliance.permits });

  const src = fs.readFileSync(path.join(ROOT, 'sokoni-minishop.js'), 'utf8');
  const guarded = /const _safeHref = \(u\) => \(\/\^https\?:\\\/\\\/\/i\.test/.test(src) && /socials\[s\.key\] && _safeHref\(s\.base \+ socials\[s\.key\]\)/.test(src);
  ck('S1  the storefront renders a social / website link only when it is http(s)', CPM ? /_safeHref/.test(cp.execFileSync('git', ['show', BASE + ':sokoni-minishop.js'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6 })) : guarded);
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
