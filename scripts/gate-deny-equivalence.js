#!/usr/bin/env node
/* ============================================================================
   GATE 2 — the 16 Git-only guards: explicit vs absent, behaviourally
   ============================================================================
   17 blocks live in firestore.rules and not in the deployed ruleset. A static
   read of their `allow` clauses said 16 grant no client access at all, and that
   Firestore's implicit default-deny therefore makes their absence harmless.

   THAT IS A HYPOTHESIS, NOT A RESULT. A helper function, a nested match or a
   shared predicate could grant something the clause text does not show, and the
   whole reason this gate exists is that reading rule text has now misled this
   work four times.

   So both states are EXECUTED against the emulator:

       Variant A   the 16 blocks present, exactly as written
       Variant B   the 16 blocks excised, everything else identical

   and every applicable client operation must come back DENIED in both, and
   equal between them. The variants are cut from the BUILT artifact, so helper
   functions, nested matches and surrounding context are the real ones.

   Usage:
     firebase emulators:exec --only firestore "node scripts/gate-deny-equivalence.js"
   ========================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertFails, assertSucceeds } =
  require('@firebase/rules-unit-testing');
const { scan } = require('./rules-blocks.js');

const ROOT = path.join(__dirname, '..');
const SP = process.env.SOKONI_EVIDENCE_DIR ||
  'C:/Users/USER1/AppData/Local/Temp/claude/c--Users-USER1-OneDrive-Desktop-SOKONI/51f05820-e88d-48b4-8b14-ba44300630f9/scratchpad';
const HOST = (process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':');

/* The 17 Git-only blocks. shops/{uid} is EXCLUDED: it is the one that grants
   client access, and it is being dropped in favour of the deployed
   shops/{storeId}. It is not part of this equivalence claim. */
const COLLECTIONS = ['_counters', 'productViewDedup', 'qrTokens', 'challenges', '_health',
  'eventOrderIdempotency', 'healthApptIdempotency', 'digitalPurchaseIdempotency',
  'legalConsultIdempotency', 'versions', 'legalAcceptances', 'legalCertificates',
  'legalConfig', 'legalRegistry', 'entertainmentPurchaseIdempotency', '_chaosCanary'];

let pass = 0; const failures = []; const rows = [];
const ck = (n, c, d) => { if (c) pass++; else failures.push(n + (d ? '  — ' + d : '')); return c; };

const built = fs.readFileSync(path.join(ROOT, 'firestore.rules.build'), 'utf8');

/* ── Variant construction ───────────────────────────────────────────────── */
const blocks = scan(built);
const targets = COLLECTIONS.map((c) => {
  const b = blocks.find((x) => x.path === '/' + c + '/{' ||
    x.path.indexOf('/' + c + '/{') === 0);
  return { collection: c, block: b || null };
});
const missing = targets.filter((t) => !t.block).map((t) => t.collection);

/* Excise by span, highest offset first so earlier offsets stay valid. */
let variantB = built;
targets.filter((t) => t.block).sort((a, b) => b.block.start - a.block.start)
  .forEach((t) => { variantB = variantB.slice(0, t.block.start) + variantB.slice(t.block.end); });
const variantA = built;

async function runOnce(label) {
  const results = [];
  for (const variant of [['A', variantA], ['B', variantB]]) {
    const env = await initializeTestEnvironment({
      projectId: 'gate2-' + variant[0].toLowerCase() + '-' + Date.now(),
      firestore: { rules: variant[1], host: HOST[0], port: Number(HOST[1]) },
    });
    /* Seed through the admin path so a denied READ is denied by the RULE, not
       by the document being absent. */
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      for (const c of COLLECTIONS) await db.collection(c).doc('seed').set({ v: 1 });
      await db.collection('shops').doc('seedshop').set({ name: 'Control Shop' });
    });

    const anon = env.unauthenticatedContext().firestore();
    const auth = env.authenticatedContext('gate2_user').firestore();

    for (const c of COLLECTIONS) {
      for (const [who, db] of [['unauth', anon], ['auth', auth]]) {
        const ref = db.collection(c).doc('seed');
        const cases = [
          ['get', () => ref.get()],
          ['list', () => db.collection(c).limit(1).get()],
          ['create', () => db.collection(c).doc('new_' + who).set({ v: 2 })],
          ['update', () => ref.update({ v: 3 })],
          ['delete', () => ref.delete()],
        ];
        for (const [op, fn] of cases) {
          let outcome;
          try { await assertFails(fn()); outcome = 'DENIED'; }
          catch (e) { outcome = 'ALLOWED'; }
          results.push({ variant: variant[0], collection: c, who, op, outcome });
        }
      }
    }

    /* NEGATIVE CONTROL — an operation the surrounding ruleset ALLOWS. Without
       it, a broken harness that denies everything would pass this gate. */
    let control;
    try { await assertSucceeds(anon.collection('shops').doc('seedshop').get()); control = 'ALLOWED'; }
    catch (e) { control = 'DENIED'; }
    results.push({ variant: variant[0], collection: '(control) shops', who: 'unauth', op: 'get', outcome: control });

    await env.cleanup();
  }
  return results;
}

(async () => {
  console.log('\nGATE 2 — 16-BLOCK DENY EQUIVALENCE  (' + (process.env.GATE2_RUN || '1') + ')\n');

  ck('all 16 Git-only guards were located in the built artifact',
    missing.length === 0, missing.join(','));
  ck('Variant B is strictly smaller than Variant A', variantB.length < variantA.length,
    variantA.length + ' -> ' + variantB.length);
  ck('Variant B removed exactly 16 blocks',
    scan(variantA).length - scan(variantB).length === 16,
    String(scan(variantA).length - scan(variantB).length));
  ck('…and removed nothing else: every other block survives', (() => {
    const a = new Set(scan(variantA).map((b) => b.path));
    const b = new Set(scan(variantB).map((b) => b.path));
    const gone = [...a].filter((p) => !b.has(p));
    return gone.length === 16;
  })());
  if (failures.length) { report(); return; }

  const r1 = await runOnce('run1');
  const r2 = await runOnce('run2');

  /* Determinism across two clean emulator environments. */
  ck('run #2 reproduces run #1 exactly',
    JSON.stringify(r1.map((x) => x.outcome)) === JSON.stringify(r2.map((x) => x.outcome)));

  const ctrlA = r1.find((x) => x.collection.indexOf('(control)') === 0 && x.variant === 'A');
  const ctrlB = r1.find((x) => x.collection.indexOf('(control)') === 0 && x.variant === 'B');
  ck('NEGATIVE CONTROL: an allowed operation IS allowed in Variant A',
    ctrlA && ctrlA.outcome === 'ALLOWED', ctrlA && ctrlA.outcome);
  ck('NEGATIVE CONTROL: …and in Variant B', ctrlB && ctrlB.outcome === 'ALLOWED',
    ctrlB && ctrlB.outcome);

  const guard = r1.filter((x) => x.collection.indexOf('(control)') !== 0);
  const A = guard.filter((x) => x.variant === 'A');
  const B = guard.filter((x) => x.variant === 'B');
  ck('every applicable operation is DENIED with the explicit guard',
    A.every((x) => x.outcome === 'DENIED'),
    A.filter((x) => x.outcome !== 'DENIED').map((x) => x.collection + '.' + x.op).join(','));
  ck('every applicable operation is DENIED with the guard ABSENT',
    B.every((x) => x.outcome === 'DENIED'),
    B.filter((x) => x.outcome !== 'DENIED').map((x) => x.collection + '.' + x.op).join(','));
  const unequal = A.filter((a, i) => a.outcome !== B[i].outcome)
    .map((a) => a.collection + '.' + a.who + '.' + a.op);
  ck('A == B for every case', unequal.length === 0, unequal.join(','));
  ck('no unexpected grant observed anywhere in the 16',
    guard.every((x) => x.outcome === 'DENIED'));

  rows.push(...r1);
  report({ cases: guard.length / 2, blocks: COLLECTIONS.length });

  function report(agg) {
    const ev = {
      gate: 'deny-equivalence', at: new Date().toISOString(),
      blocks: COLLECTIONS.length, applicable_cases: agg ? agg.cases : null,
      explicit_denied: A ? A.filter((x) => x.outcome === 'DENIED').length : null,
      absent_denied: B ? B.filter((x) => x.outcome === 'DENIED').length : null,
      unexpected_grants: guard ? guard.filter((x) => x.outcome !== 'DENIED').length : null,
      shops_uid_excluded: 'the one Git-only block that GRANTS client access; dropped in favour of deployed shops/{storeId}',
      rows,
      result: failures.length ? 'BLOCKED' : 'GREEN',
    };
    try { fs.writeFileSync(path.join(SP, 'gate2-deny-equivalence-evidence.json'), JSON.stringify(ev, null, 2)); } catch (e) {}
    console.log('  blocks              ' + COLLECTIONS.length);
    if (agg) console.log('  applicable cases    ' + agg.cases + ' per variant');
    failures.forEach((f) => console.log('  FAIL  ' + f));
    console.log('  ' + pass + ' passed, ' + failures.length + ' failed');
    console.log('\n  GATE 2 = ' + (failures.length ? 'BLOCKED' : 'GREEN') + '\n');
    process.exit(failures.length ? 1 : 0);
  }
})().catch((e) => {
  console.error('\n  GATE 2 CRASHED — a failure, not a skip');
  console.error(e && e.stack);
  process.exit(1);
});
