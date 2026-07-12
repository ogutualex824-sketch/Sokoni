#!/usr/bin/env node
/**
 * verify-index-governance.js — reject orphan / undocumented composite indexes.
 *
 * Every index in firestore.indexes.json must have an entry in docs/index-registry.json
 * declaring:
 *    purpose            why it exists
 *    feature            owning feature
 *    query              the query that requires it
 *    owner              who to ask before removing it
 *    dateAdded          YYYY-MM-DD
 *    expectedLifespan   e.g. "permanent" | "until-v1.2" | "temporary-migration"
 *
 * Indexes present before governance are grandfathered with { "legacy": true } and are
 * exempt from the metadata requirement — but NEW indexes are not. This makes the gate
 * adoptable today while stopping the bleeding.
 *
 *   node scripts/verify-index-governance.js          # CI gate
 *   node scripts/verify-index-governance.js --seed   # grandfather current indexes
 *
 * Exit 0 = pass, 1 = fail. Wire into predeploy / PR review.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const INDEXES = path.join(ROOT, 'firestore.indexes.json');
const REGISTRY = path.join(ROOT, 'docs', 'index-registry.json');
const REQUIRED = ['purpose', 'feature', 'query', 'owner', 'dateAdded', 'expectedLifespan'];

const readJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));

/* Stable identity for an index: collection + ordered field list. */
const keyOf = (i) =>
  `${i.collectionGroup}|${(i.fields || [])
    .map((f) => `${f.fieldPath}:${f.order || f.arrayConfig || 'ASC'}`)
    .join(',')}`;

const indexes = readJSON(INDEXES).indexes || [];

/* --seed: grandfather everything currently defined. */
if (process.argv.includes('--seed')) {
  const existing = fs.existsSync(REGISTRY) ? readJSON(REGISTRY) : {};
  let added = 0;
  for (const i of indexes) {
    const k = keyOf(i);
    if (!existing[k]) { existing[k] = { legacy: true }; added++; }
  }
  fs.writeFileSync(REGISTRY, JSON.stringify(existing, null, 2) + '\n');
  console.log(`Seeded ${added} existing index(es) as legacy. Registry: ${Object.keys(existing).length} entries.`);
  console.log('New indexes from now on require full metadata.');
  process.exit(0);
}

if (!fs.existsSync(REGISTRY)) {
  console.error('docs/index-registry.json is missing. Run: node scripts/verify-index-governance.js --seed');
  process.exit(1);
}

const registry = readJSON(REGISTRY);
const problems = [];

for (const i of indexes) {
  const k = keyOf(i);
  const entry = registry[k];

  if (!entry) {
    problems.push(`ORPHAN   ${k}\n           -> not in docs/index-registry.json. Add metadata (purpose, feature, query, owner, dateAdded, expectedLifespan) or drop the index.`);
    continue;
  }
  if (entry.legacy) continue; // grandfathered

  const missing = REQUIRED.filter((f) => !entry[f]);
  if (missing.length) {
    problems.push(`INCOMPLETE ${k}\n           -> missing: ${missing.join(', ')}`);
  }
}

/* Registry entries whose index no longer exists — stale docs. */
const live = new Set(indexes.map(keyOf));
const stale = Object.keys(registry).filter((k) => !live.has(k));

console.log('\nFirestore index governance\n');
console.log(`  indexes declared : ${indexes.length}`);
console.log(`  registry entries : ${Object.keys(registry).length}`);
console.log(`  legacy (exempt)  : ${Object.values(registry).filter((e) => e.legacy).length}`);
console.log(`  stale registry   : ${stale.length}`);

if (problems.length) {
  console.error(`\n  ${problems.length} problem(s):\n`);
  problems.forEach((p) => console.error('  ' + p));
  console.error('\nIndex governance FAILED\n');
  process.exit(1);
}

console.log('\nIndex governance PASSED\n');
