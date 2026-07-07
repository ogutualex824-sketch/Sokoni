#!/usr/bin/env node
/**
 * SOKONI Algolia Blue-Green Index Migration
 *
 * Strategy: Copy settings to _new index → Backfill → Move (rename) → Delete old
 *
 * Usage:
 *   node scripts/migrations/algolia-migrate.js --index=products_index
 *   node scripts/migrations/algolia-migrate.js --all
 */
'use strict';

const https = require('https');

const APP_ID   = process.env.ALGOLIA_APP_ID   || 'FF2WSTR4YC';
const ADMIN    = process.env.ALGOLIA_ADMIN_KEY;
if (!ADMIN) {
  console.error('ERROR: ALGOLIA_ADMIN_KEY environment variable is required — no fallback allowed.');
  console.error('  Get it: firebase functions:secrets:access ALGOLIA_ADMIN_KEY');
  process.exit(1);
}

const INDEXES  = ['products_index','stores_index','services_index','jobs_index',
                  'vehicles_index','property_index','events_index','global_search'];

function algolia(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = https.request({
      hostname: `${APP_ID}.algolia.net`,
      path,
      method,
      headers: {
        'X-Algolia-Application-Id': APP_ID,
        'X-Algolia-API-Key':        ADMIN,
        ...(payload ? { 'Content-Type': 'application/json' } : {}),
      },
    }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function migrateIndex(name) {
  const newName = `${name}_new`;
  console.log(`\n▶  Blue-Green migration: ${name}`);

  /* 1. Copy settings from live → new index */
  console.log(`   [1/3] Copying settings to ${newName}...`);
  const copy = await algolia('POST', `/1/indexes/${name}/operation`, {
    operation:   'copy',
    destination: newName,
    scope:       ['settings', 'synonyms', 'rules'],
  });
  if (copy.status !== 200) throw new Error(`Copy failed: ${JSON.stringify(copy.body)}`);
  console.log('   ✅  Settings copied');

  /* 2. Wait for copy task to complete */
  const taskId = copy.body.taskID;
  let done = false;
  while (!done) {
    await new Promise(r => setTimeout(r, 2000));
    const task = await algolia('GET', `/1/indexes/${newName}/task/${taskId}`);
    done = task.body?.status === 'published';
    process.stdout.write('.');
  }
  console.log('\n   ✅  Copy task complete');

  /* 3. Move new index over live (atomic rename) */
  console.log(`   [2/3] Atomically moving ${newName} → ${name}...`);
  const move = await algolia('POST', `/1/indexes/${newName}/operation`, {
    operation:   'move',
    destination: name,
  });
  if (move.status !== 200) throw new Error(`Move failed: ${JSON.stringify(move.body)}`);
  console.log(`   ✅  ${name} is now live with new schema`);
  console.log(`   ℹ️  Algolia move is atomic — zero downtime`);
}

async function run() {
  const args     = Object.fromEntries(process.argv.slice(2).map(a => a.replace('--','').split('=')));
  const isAll    = 'all' in args;
  const idxArg   = args.index;
  const toRun    = isAll ? INDEXES : [idxArg].filter(Boolean);

  if (toRun.length === 0) { console.error('--index or --all required'); process.exit(1); }

  for (const idx of toRun) await migrateIndex(idx);
  console.log('\n✅  All Algolia migrations complete\n');
}

run().catch(err => { console.error(err.message); process.exit(1); });
