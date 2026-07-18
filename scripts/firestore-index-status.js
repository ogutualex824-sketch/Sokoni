#!/usr/bin/env node
/**
 * FIRESTORE INDEX BUILD-STATE GATE
 *
 * A composite index in the BUILDING state produces the SAME user-visible failure as a missing
 * one: the query throws FAILED_PRECONDITION. Evaluating index-dependent functionality before
 * every index reports READY therefore produces false defect reports.
 *
 * This gate answers one question: are the indexes we depend on READY yet?
 *
 *   node scripts/firestore-index-status.js                    # summarise all index states
 *   node scripts/firestore-index-status.js --collection posWalletTransactions
 *   node scripts/firestore-index-status.js --wait              # poll until all are READY
 *   node scripts/firestore-index-status.js --pilot             # only the pilot-critical set
 *
 * Read-only: lists state, never creates, modifies or deletes an index.
 * Per the standing index rule, indexes are only ever ADDED — never dropped — and deployment
 * must run WITHOUT --force so nothing can be removed.
 */
'use strict';

const { execSync } = require('child_process');

const args = process.argv.slice(2);
const PROJECT = 'sokoni-aeb26';
const WAIT = args.includes('--wait');
const PILOT_ONLY = args.includes('--pilot');
const COLL = (() => { const i = args.indexOf('--collection'); return i >= 0 ? args[i + 1] : null; })();

/* Pilot-critical collections — see docs/FIRESTORE_INDEX_AUDIT.md (I-1 .. I-4). */
const PILOT = ['posWalletTransactions', 'posSales', 'posRetailSales', 'posProducts',
               'posStaff', 'branches', 'subscriptions'];

/* `firestore:indexes` reports the desired set but not build state; the REST/gcloud surface
   carries state. Try gcloud first, fall back to the CLI listing with state unknown. */
function fetchIndexes() {
  try {
    const raw = execSync(
      `gcloud firestore indexes composite list --project=${PROJECT} --format=json`,
      { encoding: 'utf8', timeout: 90000, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    return { source: 'gcloud', indexes: JSON.parse(raw) };
  } catch (_) { /* gcloud unavailable (its python shim is broken on this host) */ }

  try {
    const raw = execSync(
      `npx -y firebase-tools@latest firestore:indexes --project ${PROJECT}`,
      { encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const j = JSON.parse(raw);
    return {
      source: 'firebase-cli',
      indexes: (j.indexes || []).map((i) => ({
        name: i.collectionGroup + '/' + i.fields.filter((f) => f.fieldPath !== '__name__').map((f) => f.fieldPath).join('+'),
        collectionGroup: i.collectionGroup,
        fields: i.fields,
        state: 'UNKNOWN',           // the CLI listing does not expose build state
      })),
    };
  } catch (e) {
    return { source: 'none', indexes: [], error: e.message };
  }
}

function summarise() {
  const { source, indexes, error } = fetchIndexes();
  if (error) { console.log('  ERROR: ' + error); return { ready: false, total: 0 }; }

  const norm = indexes.map((i) => {
    const cg = i.collectionGroup || (i.name || '').split('/').filter(Boolean).slice(-3, -2)[0] || '?';
    const fields = (i.fields || []).filter((f) => f.fieldPath !== '__name__')
      .map((f) => f.fieldPath).join(' + ');
    return { cg, fields, state: i.state || 'UNKNOWN' };
  });

  let list = norm;
  if (COLL) list = list.filter((x) => x.cg === COLL);
  if (PILOT_ONLY) list = list.filter((x) => PILOT.includes(x.cg));

  const byState = {};
  list.forEach((x) => { byState[x.state] = (byState[x.state] || 0) + 1; });

  console.log('\n  Firestore composite index states  (source: ' + source + ')\n');
  Object.entries(byState).sort().forEach(([s, n]) => console.log('    ' + s.padEnd(12) + n));

  const building = list.filter((x) => /CREATING|BUILDING/i.test(x.state));
  if (building.length) {
    console.log('\n  STILL BUILDING — do NOT evaluate dependent functionality yet:');
    building.forEach((x) => console.log('    ' + x.cg + '  [' + x.fields + ']'));
  }

  if (source === 'firebase-cli') {
    console.log('\n  NOTE: build state is UNKNOWN via the firebase CLI listing — it reports the');
    console.log('  desired index set, not construction progress. Confirm READY in the Firebase');
    console.log('  console (Firestore > Indexes) before running index-dependent checks.');
  }

  /* Pilot coverage: are the collections we need represented at all? */
  console.log('\n  Pilot-critical collection coverage:');
  PILOT.forEach((c) => {
    const n = norm.filter((x) => x.cg === c).length;
    console.log('    ' + (n ? 'present ' : 'ABSENT  ') + c.padEnd(24) + n + ' composite index(es)');
  });

  return { ready: building.length === 0 && source !== 'none', total: list.length, building: building.length };
}

(async () => {
  if (!WAIT) { summarise(); return; }

  /* Poll until nothing is BUILDING. Bounded so it cannot spin forever. */
  const DEADLINE = Date.now() + 60 * 60 * 1000;   // 1 hour
  for (;;) {
    const r = summarise();
    if (r.ready) { console.log('\n  All listed indexes READY.\n'); process.exit(0); }
    if (Date.now() > DEADLINE) { console.log('\n  Deadline reached with indexes still building.\n'); process.exit(1); }
    console.log('\n  ' + r.building + ' still building — re-checking in 60s...\n');
    await new Promise((res) => setTimeout(res, 60000));
  }
})();
