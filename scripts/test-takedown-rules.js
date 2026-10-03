#!/usr/bin/env node
/* test-takedown-rules.js — TAKEDOWN enforcement at the Firestore client boundary (2026-10-02).
 *
 *   firebase emulators:exec --only firestore --project demo-takedown-rules "node scripts/test-takedown-rules.js"
 *
 * LOCALHOST ONLY. The project id is a `demo-` id (the emulator suite never contacts production for demo projects) and
 * the suite REFUSES to start unless FIRESTORE_EMULATOR_HOST points at 127.0.0.1 / localhost. No firebase-admin, no
 * application-default credentials: @firebase/rules-unit-testing talks to the emulator only.
 *
 * TWO RULESETS, ONE PROCESS:
 *   CANDIDATE  firestore.rules.takedown-candidate  — every row must PASS
 *   CONTROL    firestore.rules.served-f259c0b5     — the SERVED ruleset; the gap rows must show the gap (the seller CAN
 *              un-hide), proving the candidate's denials come from the change and not from the harness.
 *
 * NAMED ROWS (spec §5, §26, §28):
 *   K1  seller edits the TITLE of their taken-down product              → ALLOWED (ordinary commerce field)
 *   K2  seller sets isVisible:true on it                                → DENIED   (SB-hidden=false)
 *   K3  seller sets status:'active'                                     → DENIED   (SB-active)
 *   K4  seller sets moderationStatus:'approved'                         → DENIED
 *   K5  seller sets active:true / published:true                        → DENIED
 *   K6  seller deletes the moderationHold field                         → DENIED
 *   K7  seller deletes the held product (delete + re-create = restore)  → DENIED
 *   K8  seller writes moderationHold on own unheld product / at create  → DENIED; a plain create → ALLOWED
 *   K9  seller availability toggle with NO hold (isVisible + status)    → ALLOWED (unchanged behaviour)
 *   K10 admin CLIENT clears the hold / sets isVisible on a held product → DENIED (restore is the audited callable)
 *   K11 admin client edits price on a held product                      → ALLOWED
 *   K12 another seller / a buyer edits the held product                 → DENIED
 *   K13 public get of a held product → DENIED; its seller → ALLOWED; admin → ALLOWED; get of an unheld product → ALLOWED;
 *       public list query → ALLOWED (rules are not filters; recorded residual)
 *   K14 reports: admin client create / update / delete → DENIED; admin read → ALLOWED
 *   K15 fraudAlerts: any signed-in create → DENIED; moderator read/update → ALLOWED; buyer read → DENIED; admin delete → ALLOWED
 *   C1–C4 CONTROL on the served ruleset: K2, K6, K7 and K14-create(admin) SUCCEED there (the gap exists today)
 */
'use strict';
const fs = require('fs'), path = require('path');
const host = process.env.FIRESTORE_EMULATOR_HOST || '';
if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) {
  console.error('REFUSED: FIRESTORE_EMULATOR_HOST must be a localhost emulator (got "' + host + '"). Run via firebase emulators:exec.');
  process.exit(2);
}
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, setDoc, getDoc, deleteDoc, updateDoc, deleteField, collection, getDocs, query, where, limit } = require('firebase/firestore');

const ROOT = path.resolve(__dirname, '..');
const CANDIDATE = process.env.RULES_FILE || 'firestore.rules.takedown-candidate';
const SERVED = 'firestore.rules.served-f259c0b5';
let pass = 0, fail = 0;
const ck = (l, ok) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l); ok ? pass++ : fail++; };
const ok = (p) => assertSucceeds(p).then(() => true).catch(() => false);
const no = (p) => assertFails(p).then(() => true).catch(() => false);

const SELLER = 'uSeller', OTHER = 'uOther', BUYER = 'uBuyer', ADMIN = 'uAdmin', MOD = 'uMod';
const HOLD = { active: true, ref: 'abcdef0123456789', at: 1, correlationId: 'c1', previousIsVisible: true };
const prod = (extra) => Object.assign({ sellerUid: SELLER, name: 'Item', price: 100, stock: 5, status: 'active', isVisible: true }, extra || {});

async function seed(env) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'products', 'held'), prod({ isVisible: false, moderationHold: HOLD }));
    await setDoc(doc(db, 'products', 'held2'), prod({ isVisible: false, moderationHold: HOLD }));
    await setDoc(doc(db, 'products', 'free'), prod());
    await setDoc(doc(db, 'reports', 'r1'), { status: 'pending', entityId: 'held' });
    await setDoc(doc(db, 'fraudAlerts', 'f1'), { status: 'open', targetId: 'x', reason: 'y', flaggedBy: 'system' });
    for (const u of [SELLER, OTHER, BUYER]) await setDoc(doc(db, 'productCounters', u), { uid: u, maxProducts: -1, count: 0 });
  });
}
function ctxs(env) {
  const A = { deactivated: false };
  return {
    seller: env.authenticatedContext(SELLER, { ...A, seller: true }).firestore(),
    other: env.authenticatedContext(OTHER, { ...A, seller: true }).firestore(),
    buyer: env.authenticatedContext(BUYER, { ...A }).firestore(),
    admin: env.authenticatedContext(ADMIN, { ...A, admin: true }).firestore(),
    mod: env.authenticatedContext(MOD, { ...A, moderator: true }).firestore(),
    anon: env.unauthenticatedContext().firestore(),
  };
}

(async () => {
  /* ── CANDIDATE ── */
  const env = await initializeTestEnvironment({ projectId: 'demo-takedown-rules',
    firestore: { rules: fs.readFileSync(path.join(ROOT, CANDIDATE), 'utf8'), host: host.split(':')[0], port: Number(host.split(':')[1]) } });
  await seed(env);
  const c = ctxs(env);
  console.log('\nCANDIDATE: ' + CANDIDATE);
  ck('K1 seller edits the title of a taken-down product → ALLOWED', await ok(updateDoc(doc(c.seller, 'products', 'held'), { name: 'Renamed' })));
  ck('K2 seller sets isVisible:true on a held product → DENIED', await no(updateDoc(doc(c.seller, 'products', 'held'), { isVisible: true })));
  ck("K3 seller sets status:'active' (from 'active' → 'draft' → … any change) → DENIED", await no(updateDoc(doc(c.seller, 'products', 'held'), { status: 'draft' })));
  ck("K4 seller sets moderationStatus:'approved' → DENIED", await no(updateDoc(doc(c.seller, 'products', 'held'), { moderationStatus: 'approved' })));
  ck('K5 seller sets active:true / published:true → DENIED',
    (await no(updateDoc(doc(c.seller, 'products', 'held'), { active: true }))) && (await no(updateDoc(doc(c.seller, 'products', 'held'), { published: true }))));
  ck('K6 seller deletes the moderationHold field → DENIED', await no(updateDoc(doc(c.seller, 'products', 'held'), { moderationHold: deleteField() })));
  ck('K7 seller deletes the held product (delete + re-create would restore it) → DENIED', await no(deleteDoc(doc(c.seller, 'products', 'held'))));
  ck('K8 seller writes moderationHold (own unheld product, and at create) → DENIED; a plain create → ALLOWED',
    (await no(updateDoc(doc(c.seller, 'products', 'free'), { moderationHold: null })))
    && (await no(setDoc(doc(c.seller, 'products', 'newHeld'), prod({ moderationHold: HOLD }))))
    && (await ok(setDoc(doc(c.seller, 'products', 'newPlain'), prod()))));
  ck('K9 seller availability toggle with NO hold (isVisible + status) → ALLOWED',
    (await ok(updateDoc(doc(c.seller, 'products', 'free'), { isVisible: false })))
    && (await ok(updateDoc(doc(c.seller, 'products', 'free'), { isVisible: true, status: 'active' }))));
  ck('K10 admin CLIENT clears the hold / sets isVisible on a held product → DENIED (restore = audited callable)',
    (await no(updateDoc(doc(c.admin, 'products', 'held2'), { moderationHold: deleteField(), isVisible: true })))
    && (await no(updateDoc(doc(c.admin, 'products', 'held2'), { isVisible: true }))));
  ck('K11 admin client edits price on a held product → ALLOWED', await ok(updateDoc(doc(c.admin, 'products', 'held2'), { price: 120 })));
  ck('K12 another seller / a buyer edits the held product → DENIED',
    (await no(updateDoc(doc(c.other, 'products', 'held'), { name: 'x' }))) && (await no(updateDoc(doc(c.buyer, 'products', 'held'), { name: 'x' }))));
  ck('K13 get(held): public DENIED, buyer DENIED, seller ALLOWED, admin ALLOWED; get(unheld) public ALLOWED; public list ALLOWED',
    (await no(getDoc(doc(c.anon, 'products', 'held')))) && (await no(getDoc(doc(c.buyer, 'products', 'held'))))
    && (await ok(getDoc(doc(c.seller, 'products', 'held')))) && (await ok(getDoc(doc(c.admin, 'products', 'held'))))
    && (await ok(getDoc(doc(c.anon, 'products', 'free')))) && (await ok(getDoc(doc(c.anon, 'products', 'missing'))))
    && (await ok(getDocs(query(collection(c.anon, 'products'), where('sellerUid', '==', SELLER), limit(10))))));
  ck('K14 reports: admin client create/update/delete DENIED; admin read ALLOWED',
    (await no(setDoc(doc(c.admin, 'reports', 'r2'), { status: 'pending' }))) && (await no(updateDoc(doc(c.admin, 'reports', 'r1'), { status: 'actioned' })))
    && (await no(deleteDoc(doc(c.admin, 'reports', 'r1')))) && (await ok(getDoc(doc(c.admin, 'reports', 'r1')))));
  ck('K15 fraudAlerts: signed-in create DENIED; moderator read/update ALLOWED; buyer read DENIED; admin delete ALLOWED',
    (await no(setDoc(doc(c.buyer, 'fraudAlerts', 'f2'), { targetId: 'a', reason: 'b', flaggedBy: BUYER })))
    && (await ok(getDoc(doc(c.mod, 'fraudAlerts', 'f1')))) && (await ok(updateDoc(doc(c.mod, 'fraudAlerts', 'f1'), { status: 'resolved' })))
    && (await no(getDoc(doc(c.buyer, 'fraudAlerts', 'f1')))) && (await ok(deleteDoc(doc(c.admin, 'fraudAlerts', 'f1')))));
  await env.cleanup();

  /* ── CONTROL: the SERVED ruleset (the gap must be visible there) ── */
  const env2 = await initializeTestEnvironment({ projectId: 'demo-takedown-rules-served',
    firestore: { rules: fs.readFileSync(path.join(ROOT, SERVED), 'utf8'), host: host.split(':')[0], port: Number(host.split(':')[1]) } });
  await seed(env2);
  const s = ctxs(env2);
  console.log('\nCONTROL (served f259c0b5): the gap rows must SUCCEED');
  ck('C1 served: seller sets isVisible:true on a held product → SUCCEEDS (the live gap)', await ok(updateDoc(doc(s.seller, 'products', 'held'), { isVisible: true })));
  ck('C2 served: seller deletes the moderationHold field → SUCCEEDS', await ok(updateDoc(doc(s.seller, 'products', 'held2'), { moderationHold: deleteField() })));
  ck('C3 served: seller deletes a held product → SUCCEEDS', await ok(deleteDoc(doc(s.seller, 'products', 'held2'))));
  ck('C4 served: admin client writes a report directly → SUCCEEDS', await ok(updateDoc(doc(s.admin, 'reports', 'r1'), { status: 'actioned' })));
  await env2.cleanup();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR (not a result):', e && e.message); process.exit(3); });
