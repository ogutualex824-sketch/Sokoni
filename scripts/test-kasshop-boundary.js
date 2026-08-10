#!/usr/bin/env node
'use strict';

/**
 * KassShop canonical boundary — against a REAL Firestore (emulator).
 *
 *   npm run test:kasshop
 *
 * The acceptance test this encodes, from the seller's side:
 *
 *   Seller A → Shop Setup → enter "KassShop" → Save → reload → still there
 *            → change availability → the same canonical state everywhere
 *   Seller B → cannot resolve, edit, or inherit KassShop
 *
 * "Reload" is modelled the only way that means anything on the server: a completely fresh
 * getShopProfile call that shares no state with the save. If the value comes back, it came
 * back out of Firestore.
 *
 * Ownership is asserted to be `shops/{shopId}.sellerUid === uid` and NEVER `shopId === uid` —
 * every shop here is created with a generated id precisely so that a uid-keyed implementation
 * would fail rather than accidentally pass.
 */

const path = require('path');
const FUNCTIONS_DIR = path.join(__dirname, '..', 'functions');
const admin = require(require.resolve('firebase-admin', { paths: [FUNCTIONS_DIR] }));

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.log('SKIP — FIRESTORE_EMULATOR_HOST is unset. Run: npm run test:kasshop');
  process.exit(0);
}

admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'sokoni-aeb26' });
const db = admin.firestore();

const kasshop = require('../functions/kasshop');
const call = (fn, uid, data) => fn.run({ auth: uid ? { uid } : null, data });
const caught = async (p) => { try { return { value: await p }; } catch (e) { return { err: e }; } };

const A = 'seller-A-uid';
const B = 'seller-B-uid';

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + name + (detail !== undefined ? '\n      ' + JSON.stringify(detail) : '')); }
};
const group = (n) => console.log('\n' + n);

async function wipe () {
  for (const col of ['shops', 'minishopConfig', 'providerAvailability']) {
    const snap = await db.collection(col).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}

(async () => {
  console.log('\nKASSSHOP CANONICAL BOUNDARY — real Firestore');
  console.log('='.repeat(70));
  await wipe();

  let shopId = null;

  /* ── 1. Before setup ── */
  group('1. A seller with no shop');
  {
    const r = await caught(call(kasshop.getShopProfile, A, {}));
    ok('getShopProfile succeeds', !r.err, r.err && r.err.message);
    ok('reports exists:false rather than erroring', r.value && r.value.exists === false, r.value);
    ok('invents no shopId', r.value && r.value.shopId === null, r.value && r.value.shopId);

    const av = await caught(call(kasshop.setShopAvailability, A, { availability: { online: false } }));
    ok('availability REFUSES rather than creating a shop', av.err && av.err.code === 'not-found', av.err && av.err.code);
    ok('no shop was created as a side effect', (await db.collection('shops').get()).empty);
  }

  /* ── 2. First-time setup CREATES the canonical shop ── */
  group('2. First save creates the canonical shop');
  {
    const r = await caught(call(kasshop.saveShopProfile, A, {
      profile: { name: 'KassShop', about: 'Fresh groceries daily', city: 'Nairobi', phone: '+254700000000' },
    }));
    ok('save succeeds', r.value && r.value.success === true, r.err && r.err.message);
    ok('reports created:true', r.value && r.value.created === true, r.value);
    shopId = r.value && r.value.shopId;
    ok('returns a shopId', !!shopId, shopId);
    ok('the shop id is NOT the uid', shopId !== A, shopId);

    const doc = (await db.collection('shops').doc(shopId).get()).data();
    ok('shops/{shopId}.sellerUid is the authenticated uid', doc && doc.sellerUid === A, doc && doc.sellerUid);
    ok('the name persisted', doc && doc.name === 'KassShop', doc && doc.name);
    ok('exactly one shop exists', (await db.collection('shops').get()).size === 1);
  }

  /* ── 3. RELOAD ── */
  group('3. Reload — a fresh read, sharing nothing with the save');
  {
    const r = await caught(call(kasshop.getShopProfile, A, {}));
    ok('exists:true', r.value && r.value.exists === true, r.value);
    ok('same shopId', r.value && r.value.shopId === shopId, r.value && r.value.shopId);
    ok('ownerUid is seller A', r.value && r.value.ownerUid === A, r.value && r.value.ownerUid);
    ok('name comes back', r.value && r.value.profile && r.value.profile.name === 'KassShop', r.value && r.value.profile);
    ok('description comes back', r.value && r.value.profile.about === 'Fresh groceries daily', r.value.profile.about);
    ok('availability defaults to open', r.value && r.value.availability.acceptingOrders === true, r.value.availability);
  }

  /* ── 4. Editing updates the SAME document ── */
  group('4. Editing updates the same shop, never a second one');
  {
    const r = await caught(call(kasshop.saveShopProfile, A, { profile: { name: 'KassShop Nairobi' } }));
    ok('save succeeds', r.value && r.value.success === true, r.err && r.err.message);
    ok('reports created:false', r.value && r.value.created === false, r.value);
    ok('same shopId', r.value && r.value.shopId === shopId, r.value && r.value.shopId);
    ok('still exactly one shop', (await db.collection('shops').get()).size === 1);

    const back = await call(kasshop.getShopProfile, A, {});
    ok('the new name reads back', back.profile.name === 'KassShop Nairobi', back.profile.name);
    ok('untouched fields survived the merge', back.profile.about === 'Fresh groceries daily', back.profile.about);
  }

  /* ── 5. Live availability ── */
  group('5. Availability writes the canonical shop');
  {
    const r = await caught(call(kasshop.setShopAvailability, A, { availability: { online: false, acceptingOrders: false } }));
    ok('set succeeds', r.value && r.value.success === true, r.err && r.err.message);
    ok('applied to the owned shop', r.value && r.value.shopId === shopId, r.value && r.value.shopId);

    const back = await call(kasshop.getShopProfile, A, {});
    ok('management reads it back', back.availability.online === false, back.availability);

    const eff = await kasshop.effectiveForShop(shopId, Date.now());
    ok('the effective state the storefront reads is closed', eff && eff.open === false, eff);
    ok('and it says why', eff && eff.reason === 'offline', eff && eff.reason);
  }

  /* ── 6. Effective = live + schedule + override ── */
  group('6. Effective availability combines live state, schedule and overrides');
  {
    await call(kasshop.setShopAvailability, A, { availability: { online: true, acceptingOrders: true } });

    /* Monday 2026-08-10 is a Monday. 09:00 EAT = 06:00Z. */
    const mondayOpen  = Date.UTC(2026, 7, 10, 6, 0);
    const mondayLate  = Date.UTC(2026, 7, 10, 18, 0);   /* 21:00 EAT */
    await db.collection('providerAvailability').doc(A).set({
      hours: { mon: { closed: false, periods: [{ open: '08:00', close: '17:00' }] },
               sun: { closed: true, periods: [] } },
      overrides: { '2026-08-12': { closed: true } },
    });

    let eff = await kasshop.effectiveForShop(shopId, mondayOpen);
    ok('open inside opening hours', eff.open === true && eff.reason === 'within_hours', eff);

    eff = await kasshop.effectiveForShop(shopId, mondayLate);
    ok('closed outside opening hours', eff.open === false && eff.reason === 'outside_hours', eff);

    /* A date override contradicts the timetable outright. */
    eff = await kasshop.effectiveForShop(shopId, Date.UTC(2026, 7, 12, 6, 0));
    ok('a closure override beats open hours', eff.open === false && eff.source === 'override', eff);

    /* The live switch beats everything — a seller flipping offline means it now. */
    await call(kasshop.setShopAvailability, A, { availability: { online: false } });
    eff = await kasshop.effectiveForShop(shopId, mondayOpen);
    ok('going offline beats the schedule immediately', eff.open === false && eff.source === 'live', eff);
    await call(kasshop.setShopAvailability, A, { availability: { online: true } });
  }

  /* ── 7. SELLER B ── */
  group('7. Seller B cannot resolve, edit, or inherit KassShop');
  {
    const r = await caught(call(kasshop.getShopProfile, B, {}));
    ok('B does not resolve A\'s shop', r.value && r.value.exists === false, r.value);
    ok('B gets no shopId', r.value && r.value.shopId === null, r.value && r.value.shopId);

    const av = await caught(call(kasshop.setShopAvailability, B, { availability: { online: false } }));
    ok('B cannot set availability on it', av.err && av.err.code === 'not-found', av.err && av.err.code);

    const stillOnline = (await db.collection('shops').doc(shopId).get()).data();
    ok('A\'s shop is untouched', stillOnline.online === true, stillOnline.online);
    ok('A\'s shop still belongs to A', stillOnline.sellerUid === A, stillOnline.sellerUid);

    /* B saving creates B's OWN shop — it must never fold into A's. */
    const save = await caught(call(kasshop.saveShopProfile, B, { profile: { name: 'B Shop' } }));
    ok('B\'s save creates a separate shop', save.value && save.value.shopId !== shopId, save.value && save.value.shopId);
    ok('there are now two distinct shops', (await db.collection('shops').get()).size === 2);
    const aDoc = (await db.collection('shops').doc(shopId).get()).data();
    ok('A\'s shop name was not overwritten', aDoc.name === 'KassShop Nairobi', aDoc.name);
  }

  /* ── 8. Concurrent first-time setup must not mint two shops ── */
  group('8. Two simultaneous first saves create ONE shop');
  {
    const C = 'seller-C-uid';
    const results = await Promise.all([0, 1, 2, 3].map(() =>
      caught(call(kasshop.saveShopProfile, C, { profile: { name: 'C Shop' } }))));
    const okCount = results.filter((r) => r.value && r.value.success).length;
    const cShops = await db.collection('shops').where('sellerUid', '==', C).get();
    ok('every caller got an answer', okCount === 4, okCount + '/4');
    ok('exactly one shop exists for C', cShops.size === 1, cShops.size);
    const ids = new Set(results.filter((r) => r.value).map((r) => r.value.shopId));
    ok('every caller was told the same shopId', ids.size === 1, [...ids]);
  }

  /* ── 9. Only whitelisted fields cross the boundary ── */
  group('9. The boundary refuses fields a seller does not own');
  {
    await call(kasshop.saveShopProfile, A, {
      profile: { name: 'KassShop Nairobi', status: 'verified', commissionRate: 0,
                 rating: 5, sellerUid: B, isAdmin: true, balance: 999999 },
    });
    const d = (await db.collection('shops').doc(shopId).get()).data();
    ok('status was not writable', d.status === 'active', d.status);
    ok('commissionRate was not injected', d.commissionRate === undefined, d.commissionRate);
    ok('rating was not injected', d.rating === undefined, d.rating);
    ok('balance was not injected', d.balance === undefined, d.balance);
    ok('ownership could not be reassigned to B', d.sellerUid === A, d.sellerUid);
  }

  /* ── 10. Auth ── */
  group('10. Unauthenticated callers');
  {
    for (const [label, fn] of [['getShopProfile', kasshop.getShopProfile],
                               ['saveShopProfile', kasshop.saveShopProfile],
                               ['setShopAvailability', kasshop.setShopAvailability]]) {
      const r = await caught(call(fn, null, { profile: { name: 'x' }, availability: { online: true } }));
      ok(label + ' requires auth', r.err && r.err.code === 'unauthenticated', r.err && r.err.code);
    }
  }

  await wipe();
  console.log('\n' + '='.repeat(70));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('\n  SCOPE: the real callables against the real Firestore transaction engine.');
  console.log('         Ownership is shops/{shopId}.sellerUid === uid throughout, and every shop');
  console.log('         here has a generated id, so a shopId === uid implementation would FAIL.');
  console.log('         NOT VERIFIED here: the browser wiring and the on-device run.');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
