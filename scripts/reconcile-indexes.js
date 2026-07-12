#!/usr/bin/env node
/**
 * reconcile-indexes.js — make firestore.indexes.json an accurate mirror of production.
 *
 * THE RISK THIS CLOSES
 * `firebase deploy --only firestore:indexes` PRUNES any deployed index that is not in
 * firestore.indexes.json. Source currently tracks fewer indexes than production, so a
 * deploy today would offer to DELETE live indexes and break the queries behind them.
 *
 * POLICY: synchronize SOURCE with PRODUCTION. Never prune production to match source.
 *
 *   node scripts/reconcile-indexes.js                 # report drift only (read-only)
 *   node scripts/reconcile-indexes.js --sync          # write untracked prod indexes into source
 *   node scripts/reconcile-indexes.js --verify        # assert a deploy would delete NOTHING
 *
 * --verify exits non-zero if any production index is untracked. Wire into predeploy.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FILE = path.join(ROOT, 'firestore.indexes.json');
const REGISTRY = path.join(ROOT, 'docs', 'index-registry.json');
const PROJECT = 'sokoni-aeb26';
const DB = '(default)';

const readJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));

/* Identity of an index: collection + ordered (field:direction) list. */
const keyOf = (i) =>
  `${i.collectionGroup}|${(i.fields || [])
    .map((f) => `${f.fieldPath}:${f.order || f.arrayConfig || 'ASCENDING'}`)
    .join(',')}`;

function token() {
  const cfg = path.join(process.env.USERPROFILE || process.env.HOME, '.config', 'configstore', 'firebase-tools.json');
  const rt = JSON.parse(fs.readFileSync(cfg, 'utf8')).tokens.refresh_token;
  const body = new URLSearchParams({
    client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',
    client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi',
    refresh_token: rt, grant_type: 'refresh_token',
  }).toString();
  const at = JSON.parse(execSync(`curl -s -X POST -d "${body}" https://oauth2.googleapis.com/token`, { encoding: 'utf8' })).access_token;
  if (!at) throw new Error('could not mint access token — run: npx firebase-tools login');
  return at;
}

const listProd = (at) => new Promise((res, rej) => {
  const p = `/v1/projects/${PROJECT}/databases/${encodeURIComponent(DB)}/collectionGroups/-/indexes`;
  https.get({ host: 'firestore.googleapis.com', path: p, headers: { Authorization: 'Bearer ' + at } }, (r) => {
    let b = ''; r.on('data', (d) => b += d);
    r.on('end', () => { try { const j = JSON.parse(b); j.error ? rej(new Error(j.error.message)) : res(j.indexes || []); } catch (e) { rej(e); } });
  }).on('error', rej);
});

/* Firestore Admin -> firestore.indexes.json shape. __name__ is implicit; drop it. */
function toSource(i) {
  const collectionGroup = i.name.split('/collectionGroups/')[1].split('/')[0];
  const fields = (i.fields || [])
    .filter((f) => f.fieldPath !== '__name__')
    .map((f) => {
      const o = { fieldPath: f.fieldPath };
      if (f.arrayConfig) o.arrayConfig = f.arrayConfig; else o.order = f.order || 'ASCENDING';
      return o;
    });
  return { collectionGroup, queryScope: i.queryScope || 'COLLECTION', fields };
}

(async () => {
  const at = token();
  const prodRaw = await listProd(at);
  const prod = prodRaw.map(toSource).filter((i) => i.fields.length > 0);

  const src = readJSON(FILE);
  const srcIndexes = src.indexes || [];

  const prodKeys = new Map(prod.map((i) => [keyOf(i), i]));
  const srcKeys = new Map(srcIndexes.map((i) => [keyOf(i), i]));

  /* Untracked = deployed but absent from source => a deploy would DELETE these. */
  const untracked = [...prodKeys.entries()].filter(([k]) => !srcKeys.has(k));
  /* Orphan definitions = in source but not deployed => a deploy would CREATE these. */
  const orphanDefs = [...srcKeys.entries()].filter(([k]) => !prodKeys.has(k));
  /* Duplicates within source. */
  const seen = new Set(), dupes = [];
  for (const i of srcIndexes) { const k = keyOf(i); if (seen.has(k)) dupes.push(k); seen.add(k); }

  console.log('\nFirestore index reconciliation\n');
  console.log(`  production (deployed) : ${prod.length}`);
  console.log(`  tracked in source     : ${srcIndexes.length}`);
  console.log(`  UNTRACKED (deploy would DELETE these) : ${untracked.length}`);
  console.log(`  orphan defs (deploy would CREATE)     : ${orphanDefs.length}`);
  console.log(`  duplicate defs in source              : ${dupes.length}`);

  if (process.argv.includes('--verify')) {
    const bad = untracked.length + dupes.length;
    if (untracked.length) {
      console.error('\n  A deploy would DELETE these production indexes:');
      untracked.slice(0, 40).forEach(([k]) => console.error('    - ' + k));
    }
    if (dupes.length) { console.error('\n  Duplicate definitions:'); dupes.forEach((k) => console.error('    - ' + k)); }
    console.log('');
    if (bad) { console.error('RECONCILIATION FAILED — do NOT run firebase deploy --only firestore:indexes\n'); process.exit(1); }
    console.log('RECONCILED — a firestore:indexes deploy would delete NOTHING.\n');
    return;
  }

  if (!process.argv.includes('--sync')) {
    if (untracked.length) {
      console.log('\n  Untracked production indexes (source must adopt these):');
      untracked.slice(0, 60).forEach(([k]) => console.log('    ' + k));
    }
    console.log('\n  Run with --sync to write them into firestore.indexes.json (production is never pruned).\n');
    return;
  }

  /* --sync: adopt production into source. Deduplicate. Never delete from production. */
  const merged = [];
  const added = new Set();
  for (const i of [...srcIndexes, ...prod]) {
    const k = keyOf(i);
    if (added.has(k)) continue;      // drops duplicates
    if (!prodKeys.has(k)) {
      /* Keep source-only definitions: they are pending creations, not drift. */
      merged.push(i); added.add(k); continue;
    }
    merged.push(prodKeys.get(k)); added.add(k);
  }
  merged.sort((a, b) => (a.collectionGroup + keyOf(a)).localeCompare(b.collectionGroup + keyOf(b)));

  src.indexes = merged;
  fs.writeFileSync(FILE, JSON.stringify(src, null, 2) + '\n');

  /* Registry: any newly adopted index needs an entry so the governance gate passes.
     Adopted-from-production entries are marked so they can be attributed later. */
  const reg = fs.existsSync(REGISTRY) ? readJSON(REGISTRY) : {};
  let regAdded = 0;
  for (const i of merged) {
    const k = keyOf(i);
    if (!reg[k]) {
      reg[k] = { legacy: true, adoptedFromProduction: '2026-07-12', needsAttribution: true };
      regAdded++;
    }
  }
  fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2) + '\n');

  console.log(`\n  synced: source now tracks ${merged.length} indexes (deduped, sorted)`);
  console.log(`  registry: ${regAdded} adopted entries added (flagged needsAttribution)`);
  console.log('  production was NOT modified.\n');
})().catch((e) => { console.error('reconcile-indexes failed:', e.message); process.exit(2); });
