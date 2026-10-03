#!/usr/bin/env node
/* test-media-hold-storage-rules.js — the MEDIA HOLD at the Storage (and vault) client boundary (2026-10-03).
 *
 *   firebase emulators:exec --only storage,firestore --project demo-media-hold "node scripts/test-media-hold-storage-rules.js"
 *
 * STATUS: WRITTEN, QUEUED — not run (no emulators on this machine while it is below the 512 MB memory floor).
 *
 * LOCALHOST ONLY. A `demo-` project id; the suite REFUSES to start unless FIREBASE_STORAGE_EMULATOR_HOST and
 * FIRESTORE_EMULATOR_HOST point at 127.0.0.1 / localhost. No firebase-admin, no credentials.
 *
 * TWO STORAGE RULESETS, SEQUENTIALLY IN ONE PROCESS:
 *   CANDIDATE  storage.rules.media-hold-candidate   — every SR row must PASS
 *   CONTROL    storage.rules.served-182624f3        — the SERVED ruleset: C rows must show the gap (a held photo is
 *              publicly readable; the seller can drop the flag), proving the candidate's denials come from the change.
 * FIRESTORE: firestore.rules.takedown-candidate and firestore.rules.served-f259c0b5 — moderationMediaVault is
 *   default-deny on both (no rule names it, no top-level wildcard).
 *
 * NAMED ROWS
 *   SR1 anonymous + signed-in buyer: get (getMetadata / getBytes) of a HELD product photo     → DENIED
 *   SR2 anonymous: get of a normal (unheld) product photo                                      → ALLOWED
 *   SR3 admin and superAdmin: get of a held photo                                             → ALLOWED
 *   SR4 the seller: get of their OWN held photo                                               → DENIED
 *   SR5 the seller: updateMetadata dropping moderationHold on a held photo                     → DENIED;
 *       updateMetadata on an unheld photo                                                      → ALLOWED
 *   SR6 the seller: re-upload over a held path                                                → DENIED
 *   SR7 list of product-images/{uid}/                                                          → ALLOWED (unchanged)
 *   SR8 the seller: create a new photo / delete an unheld photo                               → ALLOWED (unchanged)
 *   SR9 an object carrying moderationHold='1' OUTSIDE product-images (provider-service-images) → ALLOWED (only the
 *       product-images block changed)
 *   C1  CONTROL (served): anonymous get of the held photo                                    → ALLOWED (the gap today)
 *   C2  CONTROL (served): the seller drops the flag via updateMetadata                         → ALLOWED (the gap today)
 *   V1  moderationMediaVault: anonymous / buyer / seller / admin get, list, create, update, delete → DENIED
 *       (candidate AND served Firestore rulesets)
 */
'use strict';
const fs = require('fs'), path = require('path');
const sHost = process.env.FIREBASE_STORAGE_EMULATOR_HOST || '', fHost = process.env.FIRESTORE_EMULATOR_HOST || '';
const local = (h) => /^(127\.0\.0\.1|localhost):\d+$/.test(h);
if (!local(sHost) || !local(fHost)) {
  console.error(`REFUSED: FIREBASE_STORAGE_EMULATOR_HOST (${sHost}) and FIRESTORE_EMULATOR_HOST (${fHost}) must be localhost emulators. Run via firebase emulators:exec.`);
  process.exit(2);
}
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { ref, uploadBytes, getMetadata, getBytes, updateMetadata, listAll, deleteObject } = require('firebase/storage');
const { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs } = require('firebase/firestore');

const ROOT = path.resolve(__dirname, '..');
const CANDIDATE = process.env.STORAGE_RULES_FILE || 'storage.rules.media-hold-candidate';
const SERVED = 'storage.rules.served-182624f3';
const FS_RULES = ['firestore.rules.takedown-candidate', 'firestore.rules.served-f259c0b5'];
const PROJECT = 'demo-media-hold';
let pass = 0, fail = 0;
const ck = (l, ok) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l); ok ? pass++ : fail++; };
const ok = (p) => assertSucceeds(p).then(() => true).catch(() => false);
const no = (p) => assertFails(p).then(() => true).catch(() => false);

const SELLER = 'uSeller', BUYER = 'uBuyer', ADMIN = 'uAdmin', SUPER = 'uSuper';
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const HELD = `product-images/${SELLER}/p1/0.jpg`, FREE = `product-images/${SELLER}/p2/0.jpg`, OTHER_HELD = `provider-service-images/${SELLER}/s1.jpg`;

async function seed(env) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const st = ctx.storage();
    await uploadBytes(ref(st, HELD), JPG, { contentType: 'image/jpeg', customMetadata: { moderationHold: '1' } });
    await uploadBytes(ref(st, FREE), JPG, { contentType: 'image/jpeg' });
    await uploadBytes(ref(st, OTHER_HELD), JPG, { contentType: 'image/jpeg', customMetadata: { moderationHold: '1' } });
  });
}
const storageEnv = (file) => initializeTestEnvironment({ projectId: PROJECT,
  storage: { rules: fs.readFileSync(path.join(ROOT, file), 'utf8'), host: sHost.split(':')[0], port: Number(sHost.split(':')[1]) } });

(async () => {
  /* ═══ CANDIDATE ═══ */
  let env = await storageEnv(CANDIDATE);
  await env.clearStorage(); await seed(env);
  const anon = env.unauthenticatedContext().storage();
  const buyer = env.authenticatedContext(BUYER).storage();
  const seller = env.authenticatedContext(SELLER).storage();
  const admin = env.authenticatedContext(ADMIN, { admin: true }).storage();
  const sup = env.authenticatedContext(SUPER, { superAdmin: true }).storage();
  console.log('\nCANDIDATE ' + CANDIDATE);
  ck('SR1 anonymous + buyer get of a HELD product photo → DENIED',
    (await no(getMetadata(ref(anon, HELD)))) && (await no(getBytes(ref(anon, HELD)))) && (await no(getMetadata(ref(buyer, HELD)))));
  ck('SR2 anonymous get of an unheld product photo → ALLOWED', (await ok(getMetadata(ref(anon, FREE)))) && (await ok(getBytes(ref(anon, FREE)))));
  ck('SR3 admin + superAdmin get of a held photo → ALLOWED', (await ok(getMetadata(ref(admin, HELD)))) && (await ok(getMetadata(ref(sup, HELD)))));
  ck('SR4 the seller get of their own held photo → DENIED', await no(getMetadata(ref(seller, HELD))));
  ck('SR5 seller drops moderationHold on a held photo → DENIED; metadata update on an unheld photo → ALLOWED',
    (await no(updateMetadata(ref(seller, HELD), { customMetadata: { moderationHold: null } })))
    && (await ok(updateMetadata(ref(seller, FREE), { cacheControl: 'public, max-age=60' }))));
  ck('SR6 seller re-upload over a held path → DENIED', await no(uploadBytes(ref(seller, HELD), JPG, { contentType: 'image/jpeg' })));
  ck('SR7 list product-images/{uid}/ → ALLOWED (unchanged)', await ok(listAll(ref(anon, `product-images/${SELLER}/p1`))));
  ck('SR8 seller create a new photo / delete an unheld photo → ALLOWED (unchanged)',
    (await ok(uploadBytes(ref(seller, `product-images/${SELLER}/p3/0.jpg`), JPG, { contentType: 'image/jpeg' })))
    && (await ok(deleteObject(ref(seller, `product-images/${SELLER}/p3/0.jpg`)))));
  ck('SR9 a flagged object outside product-images (provider-service-images) → ALLOWED (block unchanged)', await ok(getMetadata(ref(anon, OTHER_HELD))));
  await env.cleanup();

  /* ═══ CONTROL — the served ruleset ═══ */
  env = await storageEnv(SERVED);
  await env.clearStorage(); await seed(env);
  console.log('\nCONTROL ' + SERVED);
  ck('C1 CONTROL served: anonymous get of the held photo → ALLOWED (the gap exists today)', await ok(getMetadata(ref(env.unauthenticatedContext().storage(), HELD))));
  ck('C2 CONTROL served: the seller drops the flag → ALLOWED (the gap exists today)',
    await ok(updateMetadata(ref(env.authenticatedContext(SELLER).storage(), HELD), { customMetadata: { moderationHold: null } })));
  await env.cleanup();

  /* ═══ V1 — the vault, both Firestore rulesets ═══ */
  for (const file of FS_RULES) {
    const fenv = await initializeTestEnvironment({ projectId: PROJECT,
      firestore: { rules: fs.readFileSync(path.join(ROOT, file), 'utf8'), host: fHost.split(':')[0], port: Number(fHost.split(':')[1]) } });
    await fenv.clearFirestore();
    await fenv.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore(), 'moderationMediaVault', 'p1'), { holdRef: 'r', objects: [] }); });
    const who = [fenv.unauthenticatedContext(), fenv.authenticatedContext(BUYER), fenv.authenticatedContext(SELLER),
      fenv.authenticatedContext(ADMIN, { admin: true }), fenv.authenticatedContext(SUPER, { superAdmin: true })];
    let all = true;
    for (const c of who) {
      const d = c.firestore();
      all = all && (await no(getDoc(doc(d, 'moderationMediaVault', 'p1')))) && (await no(getDocs(collection(d, 'moderationMediaVault'))))
        && (await no(setDoc(doc(d, 'moderationMediaVault', 'p9'), { objects: [] }))) && (await no(updateDoc(doc(d, 'moderationMediaVault', 'p1'), { holdRef: 'x' })))
        && (await no(deleteDoc(doc(d, 'moderationMediaVault', 'p1'))));
    }
    ck(`V1 moderationMediaVault get/list/create/update/delete DENIED to anonymous, buyer, seller, admin, superAdmin (${file})`, all);
    await fenv.cleanup();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH ' + (e && e.stack)); process.exit(1); });
