#!/usr/bin/env node
/* TECH HUB SLICE 4K — public search excludes unapproved / suspended providers and re-admits a reinstated one IN FULL.
 * Fires the REAL algolia-sync and typesense-sync providers update triggers (v2 .run) on an in-memory Firestore and reads
 * what they enqueue (algoliaQueue / the Typesense queue). No network, no index writes.
 *   node scripts/test-provider-search-eligibility.js        BASE=4ab4eb7 node scripts/test-provider-search-eligibility.js */
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), { execSync } = require('child_process');
const H = require('./lib/inmem-firestore').install({ admins: ['admin1'] });
const ROOT = path.join(__dirname, '..');
let FN = path.join(ROOT, 'functions');
if (process.env.BASE) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pse-'));
  execSync('git archive ' + process.env.BASE + ' functions | tar -x -C "' + d.replace(/\\/g, '/') + '"', { cwd: ROOT, shell: 'bash' });
  FN = path.join(d, 'functions');
}
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 260) + ']')); ok ? pass++ : fail++; };
console.log('\nProvider search eligibility (Tech Hub slice 4K)   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
const { DOCS } = H;

(async () => {
  const AS = require(path.join(FN, 'algolia-sync.js'));
  const TS = require(path.join(FN, 'typesense-sync.js'));
  const upd = AS.algoliaSync_providers_update, tsUpd = TS.ts_providers_onUpdate;
  const create = AS.algoliaSync_providers_create, tsCreate = TS.ts_providers_onCreate;
  if (!upd || !tsUpd) { ck('E-0', false, 'providers update triggers exist in both pipelines'); return done(); }
  const ev = (before, after) => ({ data: { before: { data: () => before }, after: { data: () => after } }, params: { docId: 'p1' } });
  const cev = (data) => ({ data: { data: () => data }, params: { docId: 'p1' } });
  const queued = () => {
    const a = [...DOCS.entries()].filter(([k]) => k.startsWith('algoliaQueue/')).map(([, v]) => v.operation);
    const t = [...DOCS.entries()].filter(([k]) => /^typesense/i.test(k.split('/')[0])).map(([, v]) => v.operation);
    return { a, t };
  };
  /* algolia queues one entry per index (sokoni_services + the global index) — assert EVERY queued op, at least one */
  const all = (arr, op) => arr.length > 0 && arr.every((x) => x === op);
  const run = async (b, a) => { H.reset(); await upd.run(ev(b, a)); await tsUpd.run(ev(b, a)); return queued(); };
  const runCreate = async (d) => { H.reset(); await create.run(cev(d)); await tsCreate.run(cev(d)); return queued(); };
  const LIVE = { name: 'Fix Ltd', status: 'active', searchable: true, category: 'Phone Repair' };

  let q = await runCreate({ name: 'New Co', status: 'pending', searchable: false });
  ck('E-1', q.a.length === 0 && q.t.length === 0, 'a PENDING provider record is never indexed (neither pipeline)', q);
  q = await runCreate(LIVE);
  ck('E-2', all(q.a, 'upsert') && all(q.t, 'upsert'), 'an APPROVED provider is indexed in both pipelines', q);

  q = await run(LIVE, Object.assign({}, LIVE, { status: 'suspended', searchable: false }));
  ck('E-3', all(q.a, 'delete') && all(q.t, 'delete'), 'SUSPENSION removes the provider from both indexes', q);
  q = await run(LIVE, Object.assign({}, LIVE, { status: 'rejected', searchable: false }));
  ck('E-4', all(q.a, 'delete') && all(q.t, 'delete'), 'a REFUSED provider is removed from both indexes', q);
  q = await run(LIVE, Object.assign({}, LIVE, { searchable: false }));
  ck('E-5', all(q.a, 'delete') && all(q.t, 'delete'), 'searchable:false alone removes it (retraction flag honoured)', q);

  H.reset();
  await upd.run(ev(Object.assign({}, LIVE, { status: 'suspended', searchable: false }), LIVE));
  await tsUpd.run(ev(Object.assign({}, LIVE, { status: 'suspended', searchable: false }), LIVE));
  const aq = [...DOCS.entries()].find(([k]) => k.startsWith('algoliaQueue/'));
  q = queued();
  ck('E-6', all(q.a, 'upsert') && all(q.t, 'upsert') && !!(aq && aq[1].data && aq[1].data.name === 'Fix Ltd'),
    'REINSTATEMENT re-admits the provider as a FULL record (upsert with data), not a partial of changed fields', { q, data: aq && aq[1].data });

  q = await run(Object.assign({}, LIVE, { status: 'pending' }), Object.assign({}, LIVE, { status: 'pending', name: 'Renamed' }));
  ck('E-7', q.a.length === 0 && q.t.length === 0, 'editing a still-pending record indexes nothing', q);

  const keys = Object.keys(AS).concat(Object.keys(TS));
  ck('E-8', !keys.includes('_internal') && keys.every((k) => typeof AS[k] === 'function' || typeof TS[k] === 'function'),
    'the test seam is non-enumerable — index.js exports only triggers (no new deploy target)', keys.filter((k) => !/^(algoliaSync_|ts_)/.test(k)));
  done();
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
function done() { console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0); }
