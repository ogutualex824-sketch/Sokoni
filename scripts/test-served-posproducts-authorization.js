/* ═══════════════════════════════════════════════════════════════════════════
   THE SERVED RULESET, EXERCISED — posProducts client authorization
   scripts/test-served-posproducts-authorization.js

   A–E left one question UNPROVEN: what does PRODUCTION actually permit a browser
   to do with `posProducts`? The repo's rule text says it is guarded on
   `sellerId`, a field neither writer produces — but repo text is not evidence.
   The deployed ruleset came from another lineage (`merchant-launch-rc`), and
   this file therefore refuses to read the answer off the local source.

   ── WHERE THE RULES COME FROM ───────────────────────────────────────────────

   The SERVED artifact, fetched read-only from the Rules REST API and passed to
   `initializeTestEnvironment` as text:

       GET /v1/projects/{p}/releases/cloud.firestore   -> rulesetName
       GET /v1/projects/{p}/rulesets/{id}              -> source.files[0]

   NOT `emulators:exec`. `firebase.json`'s `firestore` key is an ARRAY here, so
   the emulator loads NO rules and defaults to ALLOW-ALL — a corrupted ruleset
   passes that way, and so would a deleted one. And NOT `firestore.rules`: the
   served file is named `firestore.rules.build`, so the deployed artifact is the
   BUILD, not the source.

   ── THE CONTROL THAT MAKES THE REFUSALS MEAN SOMETHING ──────────────────────

   A suite that only shows denials cannot tell "the rule refused" from "the
   harness never connected" or "the ruleset failed to compile" — a rules
   expression error denies EVERYTHING, so a broken ruleset produces a perfect
   score. Every denial here is therefore paired with a write the same ruleset
   MUST allow. If the control stops passing, no denial below is evidence.

   Run: RULES_FILE=<served.rules> FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
        node scripts/test-served-posproducts-authorization.js
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs   = require('fs');
const path = require('path');

const RULES_FILE = process.env.RULES_FILE;
const HOST_PORT  = (process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':');
const PROJECT    = 'sokoni-rules-probe';

let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : '')); ok ? pass++ : fail++; return ok; };
const up = (l, why) => { console.log('  UNPROVEN  ' + l + '\n              ' + why); unproven++; };
const head = t => console.log('\n' + t + '\n' + '-'.repeat(t.length));

async function main() {
  console.log('\nSERVED RULESET — posProducts CLIENT AUTHORIZATION');
  console.log('='.repeat(74));

  if (!RULES_FILE || !fs.existsSync(RULES_FILE)) {
    console.log('\n  NOT RUN — no served ruleset supplied.');
    console.log('  Fetch it first, then pass RULES_FILE=<path>. This suite will NOT fall back');
    console.log('  to firestore.rules: the local source is not what production serves, and');
    console.log('  substituting it would answer a different question while looking the same.');
    process.exit(1);
  }

  const rules = fs.readFileSync(RULES_FILE, 'utf8');
  console.log('  ruleset text :', path.basename(RULES_FILE), Buffer.byteLength(rules, 'utf8'), 'bytes');
  console.log('  emulator     :', HOST_PORT.join(':'));

  let rut;
  try { rut = require('@firebase/rules-unit-testing'); }
  catch (e) {
    console.log('\n  LOAD_ERROR — @firebase/rules-unit-testing unavailable: ' + e.message);
    process.exit(1);
  }
  const { initializeTestEnvironment, assertFails, assertSucceeds } = rut;

  let env;
  try {
    env = await initializeTestEnvironment({
      projectId: PROJECT,
      firestore: { rules, host: HOST_PORT[0], port: Number(HOST_PORT[1]) },
    });
  } catch (e) {
    console.log('\n  NOT RUN — could not reach the emulator or the ruleset did not compile.');
    console.log('  ' + e.message);
    console.log('\n  This is NOT a denial and NOT a pass. A rules expression error denies');
    console.log('  everything, so a suite that treated this as "all refused" would report a');
    console.log('  perfect score for a broken ruleset.');
    process.exit(1);
  }

  const OWNER = 'uid-owner-1';
  const db    = (uid) => env.authenticatedContext(uid, { role: 'seller' }).firestore();
  const doc   = (d, id) => d.collection('posProducts').doc(id);

  /* ── Seeding bypasses rules, exactly as a Cloud Function does ─────────────
     posUpsertProduct runs with admin privileges, so rules never applied to it.
     Reproducing its documents through the privileged context is what makes the
     read/update results below describe the real situation. */
  await env.withSecurityRulesDisabled(async (ctx) => {
    const a = ctx.firestore();
    await a.collection('posProducts').doc('by-posupsert').set({
      name: 'Charger', price: 1000, merchantId: 'SOK-BIZ-001', branchId: 'SOK-BIZ-001-main',
      stockQty: 5, unit: 'pcs', active: true,
    });
    await a.collection('posProducts').doc('by-catalogue').set({
      name: 'Typing', price: 20, merchantId: OWNER, trackStock: false, unit: 'page', active: true,
    });
    await a.collection('posProducts').doc('with-sellerid').set({
      name: 'Cable', price: 500, sellerId: OWNER, stockQty: 2, active: true,
    });
  });

  head('0. CONTROL — the ruleset compiled, connected, and still ALLOWS what it must');
  const controlOk = await (async () => {
    try {
      await assertSucceeds(doc(db(OWNER), 'ctl-1').set({
        name: 'Control', price: 10, sellerId: OWNER,
      }));
      return true;
    } catch (e) { return false; }
  })();
  ck('a create carrying sellerId == uid is ALLOWED (harness is live)', controlOk,
     controlOk ? 'claimsPosOwner satisfied' : 'CONTROL FAILED — nothing below is evidence');
  ck('CONTROL — reading that same row back is ALLOWED', await (async () => {
    try { await assertSucceeds(doc(db(OWNER), 'ctl-1').get()); return true; } catch (e) { return false; }
  })(), 'isPosOwner satisfied');

  if (!controlOk) {
    console.log('\n  ABORTING — the positive control failed, so every refusal below would be');
    console.log('  indistinguishable from a dead harness. No verdict is issued.');
    await env.cleanup();
    process.exit(1);
  }

  head("1. The catalogue.html shape — merchantId: uid, no sellerId");
  const denied = async (label, op) => {
    let ok = false;
    try { await assertFails(op()); ok = true; } catch (e) { ok = false; }
    return ck(label, ok, ok ? 'DENIED by the served ruleset' : 'ALLOWED');
  };

  await denied('CREATE with merchantId: uid and no sellerId -> DENIED',
    () => doc(db(OWNER), 'new-from-browser').set({
      name: 'Typing', price: 20, merchantId: OWNER, trackStock: false, unit: 'page', active: true,
    }));
  await denied('READ a row the browser itself wrote (merchantId: uid) -> DENIED',
    () => doc(db(OWNER), 'by-catalogue').get());
  await denied('UPDATE that row -> DENIED',
    () => doc(db(OWNER), 'by-catalogue').set({ price: 25 }, { merge: true }));
  await denied('DELETE that row -> DENIED',
    () => doc(db(OWNER), 'by-catalogue').delete());

  head('2. Documents created by the canonical server writer');
  await denied('READ a posUpsertProduct row (merchantId: SOK-, no sellerId) -> DENIED',
    () => doc(db(OWNER), 'by-posupsert').get());
  await denied('UPDATE a posUpsertProduct row -> DENIED',
    () => doc(db(OWNER), 'by-posupsert').set({ price: 1200 }, { merge: true }));

  head('3. What DOES work — and it is the field neither writer produces');
  ck('READ a row carrying sellerId == uid is ALLOWED', await (async () => {
    try { await assertSucceeds(doc(db(OWNER), 'with-sellerid').get()); return true; } catch (e) { return false; }
  })(), 'isPosOwner -> resource.data.sellerId == uid');
  ck('UPDATE a row carrying sellerId == uid is ALLOWED', await (async () => {
    try { await assertSucceeds(doc(db(OWNER), 'with-sellerid').set({ price: 550 }, { merge: true })); return true; } catch (e) { return false; }
  })());

  head('4. The collection query catalogue.html actually issues');
  await denied("LIST where('merchantId','==',uid) -> DENIED",
    () => db(OWNER).collection('posProducts').where('merchantId', '==', OWNER).limit(500).get());
  ck("LIST where('sellerId','==',uid) is ALLOWED", await (async () => {
    try { await assertSucceeds(db(OWNER).collection('posProducts').where('sellerId', '==', OWNER).limit(500).get()); return true; } catch (e) { return false; }
  })(), 'the rule and the query must agree on the FIELD');

  await env.cleanup();

  console.log('\n' + '='.repeat(74));
  console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
  if (fail === 0) {
    console.log('  RESOLVED against the SERVED ruleset: posProducts client access is keyed');
    console.log('  on sellerId. Every catalogue.html operation is denied in production, and');
    console.log('  no posUpsertProduct document is client-readable.');
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('\n  CRASH — not a refusal:\n  ' + (e && e.stack || e)); process.exit(1); });
