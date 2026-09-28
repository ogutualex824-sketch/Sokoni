#!/usr/bin/env node
/* discovery-cleanup.js — CLI for the existing-index discovery cleanup (CHANGELOG 246, convergence C3b-2).
 *
 * DRY RUN BY DEFAULT: reads the index and Firestore, prints the report, writes NOTHING. The core is
 * functions/discovery-cleanup.js (the C3a-1 gate decides; ownership is resolved against every writer of the index).
 *
 *   node scripts/discovery-cleanup.js --project=<id> --engine=algolia   --index=sokoni_services
 *   node scripts/discovery-cleanup.js --project=<id> --engine=algolia   --index=sokoni_global --global
 *   node scripts/discovery-cleanup.js --project=<id> --engine=typesense --index=sokoni_services
 *   options: --page-size=500 --max-pages=10 --max-removals=1000 --cursor=<resume> --json
 *
 * --apply (queues gated DELETE entries — never a direct engine delete) is REFUSED unless
 *   SOKONI_C3B2_APPLY_AUTHORIZED=<the same project id>   and the project is not production.
 * Production is refused for --apply outright in this programme (owner: written, tested, NOT executed).
 * A dry run against production is a production READ: run it only when the owner explicitly asks for one.
 * Credentials come from the environment (ALGOLIA_APP_ID + ALGOLIA_ADMIN_KEY, or TYPESENSE_NODES +
 * TYPESENSE_ADMIN_KEY, and Application Default Credentials for Firestore); no key is ever printed.
 */
'use strict';
const Path = require('path');
const FN = Path.resolve(__dirname, '..', 'functions');
const PRODUCTION = Object.freeze(['sokoni-aeb26']);
const ENGINES = Object.freeze(['algolia', 'typesense']);

function parseArgs(argv, env) {
  const a = {}; (argv || []).forEach((s) => { const m = /^--([a-z-]+)(?:=(.*))?$/.exec(s); if (m) a[m[1]] = m[2] === undefined ? true : m[2]; });
  const errs = [];
  const int = (k, d, max) => { if (a[k] === undefined) return d; const n = Number(a[k]); if (!Number.isInteger(n) || n < 1 || n > max) errs.push(`--${k} must be an integer 1..${max}`); return n; };
  const o = {
    project: typeof a.project === 'string' ? a.project : null,
    engine: typeof a.engine === 'string' ? a.engine : null,
    index: typeof a.index === 'string' ? a.index : null,
    global: a.global === true,
    apply: a.apply === true,
    json: a.json === true,
    cursor: typeof a.cursor === 'string' ? a.cursor : null,
    pageSize: int('page-size', 500, 1000),
    maxPages: int('max-pages', 10, 100),
    maxRemovals: int('max-removals', 1000, 5000),
  };
  if (!o.project) errs.push('--project=<id> is required (there is no default project)');
  if (!ENGINES.includes(o.engine)) errs.push('--engine must be algolia or typesense');
  if (!o.index) errs.push('--index=<name> is required');
  if (o.global && o.engine !== 'algolia') errs.push('--global applies to the Algolia global index only');
  if (o.apply) {
    if (PRODUCTION.includes(o.project)) errs.push('--apply is REFUSED on production in this programme (C3b-2 is written and tested, not executed)');
    else if (!env || env.SOKONI_C3B2_APPLY_AUTHORIZED !== o.project) errs.push('--apply requires SOKONI_C3B2_APPLY_AUTHORIZED=<the same project id>');
  }
  return { opts: o, errors: errs, dryRun: !o.apply };
}

async function main(argv, env) {
  const { opts, errors, dryRun } = parseArgs(argv, env);
  if (errors.length) { console.error('discovery-cleanup: ' + errors.join('\n  ')); return 2; }
  const admin = require(require.resolve('firebase-admin', { paths: [FN] }));
  if (!admin.apps.length) admin.initializeApp({ projectId: opts.project });
  const db = admin.firestore();
  const DC = require(Path.join(FN, 'discovery-cleanup.js'));
  let readPage, enqueue, writers, primaryWritersOf;
  if (opts.engine === 'algolia') {
    const { AlgoliaClient, COLLECTION_INDEX_MAP: M } = require(Path.join(FN, 'algolia-indexer.js'));
    readPage = DC.algoliaReader(new AlgoliaClient(env.ALGOLIA_APP_ID, env.ALGOLIA_ADMIN_KEY), opts.index);
    if (opts.global) {
      writers = DC.globalWritersOf(M);   /* independent of the index name: the queue writes `global_search`, the map says `sokoni_global` */
      primaryWritersOf = (col) => DC.writersOf(M, M[col] && M[col].index, 'index');
    } else writers = DC.writersOf(M, opts.index, 'index');
    if (!dryRun) enqueue = require(Path.join(FN, 'algolia-queue.js')).enqueue;
  } else {
    const { TypesenseClient, COLLECTION_MAP: M } = require(Path.join(FN, 'typesense-client.js'));
    const nodes = String(env.TYPESENSE_NODES || '').split(',').map((s) => s.trim()).filter(Boolean);
    readPage = DC.typesenseReader(new TypesenseClient(nodes, env.TYPESENSE_ADMIN_KEY, { timeoutMs: 20000, maxRetries: 2 }), opts.index);
    writers = DC.writersOf(M, opts.index, 'collection');
    if (!dryRun) enqueue = require(Path.join(FN, 'typesense-queue.js')).enqueue;
  }
  if (!writers.length) { console.error(`discovery-cleanup: no collection writes ${opts.engine} index "${opts.index}" — nothing to reconcile`); return 2; }
  const report = await DC.reconcileIndex({
    db, engine: opts.engine, index: opts.index, writers, global: opts.global, primaryWritersOf, readPage,
    enqueueDelete: dryRun ? undefined : ({ collection, docId }) => enqueue({ collection, docId, operation: 'delete' }),
    dryRun, cursor: opts.cursor, pageSize: opts.pageSize, maxPages: opts.maxPages, maxRemovals: opts.maxRemovals,
  });
  console.log(opts.json ? JSON.stringify(report) : [
    `${dryRun ? 'DRY RUN (nothing written)' : 'APPLIED (gated queue deletes)'} — ${opts.engine}/${opts.index} on ${opts.project}`,
    `  examined ${report.examined} · eligible ${report.eligible} · removed ${report.removed}` + (dryRun ? ` · would remove ${report.wouldRemove}` : '') + ` · retained ${report.retained} · failed ${report.failed}`,
    `  by verdict ${JSON.stringify(report.byVerdict)}`,
    `  ${report.done ? 'walk complete' : 'resume with --cursor=' + JSON.stringify(report.nextCursor)}`,
  ].join('\n'));
  return report.failed ? 1 : 0;
}

module.exports = { parseArgs, main, PRODUCTION };
if (require.main === module) main(process.argv.slice(2), process.env).then((c) => process.exit(c), (e) => { console.error('discovery-cleanup: ' + (e && e.message)); process.exit(3); });
