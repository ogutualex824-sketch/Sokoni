#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   FUNCTION ESTATE INVENTORY — scripts/function-estate-inventory.js      PHASE 1

   READ-ONLY. It parses source and a recorded snapshot. It deletes nothing,
   deploys nothing, contacts nothing, and CLASSIFIES nothing.

   WHY CLASSIFICATION IS ABSENT ON PURPOSE
   ---------------------------------------
   Classification is Phase 5 and depends on evidence this script cannot see:
   traffic, errors, invocation counts, deployment history. A name that appears
   in production but not in source is an ORPHAN CANDIDATE — a question — and
   this script says so rather than calling it obsolete.

       UNKNOWN DOES NOT MEAN OBSOLETE.

   A function with no observed traffic is not automatically safe to delete, and
   a function absent from `index.js` may still be reachable, may be deployed
   from another branch, or may predate a refactor nobody finished.

   WHAT IT JOINS
   -------------
     source registry   every `exports.X = …` in functions/index.js — the only
                       thing that determines what a deploy will ship
     deployed snapshot scripts/infra/deployed-functions.txt, a RECORDED list of
                       1,709 names captured 2026-09-19. NOT live truth: the
                       estate may have changed since, and this script cannot
                       tell. Every figure derived from it inherits that caveat.

   THE DEPLOYMENT-IDENTITY MAP
   ---------------------------
   A handler registered on a dispatcher has NO independent deployment identity.
   `adminGetGcpEvidence` is not exported from index.js; it ships only when
   `adminOsDispatch` ships. Saying "we are deploying the handler" when
   production receives the whole dispatcher is how a narrow change becomes a
   wide one, so this script reports dispatchers and their handler counts
   separately from ordinary exports.

     node scripts/function-estate-inventory.js
     node scripts/function-estate-inventory.js --json
     node scripts/function-estate-inventory.js --orphans   # candidates only
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs   = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const ARGS    = process.argv.slice(2);
const AS_JSON = ARGS.indexOf('--json') !== -1;
const ORPHANS = ARGS.indexOf('--orphans') !== -1;

const INDEX    = path.join(ROOT, 'functions/index.js');
const SNAPSHOT = path.join(ROOT, 'scripts/infra/deployed-functions.txt');

/* ── The source registry ─────────────────────────────────────────────────
   `exports.X = …` in index.js is the ONLY thing that decides what a deploy
   ships. Anything else — a module that defines an onCall, a handler on a
   dispatcher — has no deployment identity of its own. */
function sourceRegistry () {
  const src = fs.readFileSync(INDEX, 'utf8');
  const out = new Map();

  /* ── BULK EXPORTS COME FIRST, AND THEY ARE NOT OPTIONAL ──────────────
     `Object.assign(exports, mod)` ships every symbol a module exports, and
     names built as COMPUTED KEYS never appear literally in index.js at all.
     `algolia-sync.js` emits `algoliaSync_${col}_{create,update,delete}` this
     way — 90 deployed functions that a regex over `exports.X =` cannot see.

     Omitting this did not merely undercount. It reported those 90 as ORPHAN
     CANDIDATES: live triggers presented as deletion questions. A parser gap
     that manufactures a retirement list is worse than no inventory, and this
     one was caught only because `algoliaSync_bnbListings_create` looked
     machine-generated rather than hand-written. */
  const bulk = /Object\.assign\(\s*(?:module\.)?exports\s*,\s*([^)]+)\)/g;
  let b;
  while ((b = bulk.exec(src))) {
    const expr = b[1].trim();
    /* Resolve either `require('./x')` inline or a const bound to a require. */
    let rel = (/require\(['"]([^'"]+)['"]\)/.exec(expr) || [])[1];
    if (!rel) {
      const bind = new RegExp('const\\s+' + expr.replace(/[^A-Za-z0-9_]/g, '') +
                              '\\s*=\\s*require\\(["\']([^"\']+)["\']\\)');
      rel = (bind.exec(src) || [])[1];
    }
    if (!rel) continue;
    let mod;
    try { mod = require(path.join(ROOT, 'functions', rel)); }
    catch (e) { continue; /* a module that will not load is its own finding */ }
    Object.keys(mod || {}).forEach((k) => {
      if (k === '_h' || k.charAt(0) === '_') return;
      out.set(k, { name: k, form: 'bulk-export', viaSymbol: expr,
                   module: rel, trigger: null });
    });
  }

  const re = /^exports\.([A-Za-z0-9_]+)\s*=\s*([^;\n]*)/gm;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1];
    const rhs  = (m[2] || '').trim();
    /* Inline definition, or a re-export of a module's symbol. Both ship; they
       differ only in where the body lives. */
    const inline = /^(onCall|onRequest|onSchedule|onDocument|onObject|onMessage|functions\.)/.test(rhs);
    const mod = inline ? null : (rhs.split('.')[0] || null);
    out.set(name, {
      name,
      form: inline ? 'inline' : 're-export',
      viaSymbol: inline ? null : rhs.replace(/[,;]$/, ''),
      module: mod,
      trigger: /onCall/.test(rhs) ? 'callable'
             : /onRequest/.test(rhs) ? 'https'
             : /onSchedule/.test(rhs) ? 'scheduled'
             : /onDocument/.test(rhs) ? 'firestore'
             : /onObject/.test(rhs) ? 'storage'
             : null,
    });
  }
  return out;
}

/* ── Dispatchers: one deployment unit, many logical capabilities ────────── */
function dispatchers () {
  const found = [];
  const dir = path.join(ROOT, 'functions');
  for (const f of fs.readdirSync(dir)) {
    if (!/\.js$/.test(f)) continue;
    let src;
    try { src = fs.readFileSync(path.join(dir, f), 'utf8'); } catch (e) { continue; }
    /* A dispatcher is a function that resolves an op against a handler table. */
    if (!/_h\s*\[\s*op\s*\]|adminOs\._h|\._h\[/.test(src)) continue;
    const m = /exports\.([A-Za-z0-9_]+)\s*=\s*onCall/.exec(src);
    if (!m) continue;
    found.push({ unit: m[1], file: 'functions/' + f });
  }
  return found;
}

/** Count handlers registered on a dispatcher's table, across functions/. */
function handlerCount (needle) {
  let n = 0;
  const dir = path.join(ROOT, 'functions');
  for (const f of fs.readdirSync(dir)) {
    if (!/\.js$/.test(f)) continue;
    let src;
    try { src = fs.readFileSync(path.join(dir, f), 'utf8'); } catch (e) { continue; }
    n += (src.match(new RegExp('exports\\._h\\.' + needle, 'g')) || []).length;
  }
  return n;
}

function allHandlerNames () {
  const names = new Set();
  const dir = path.join(ROOT, 'functions');
  for (const f of fs.readdirSync(dir)) {
    if (!/\.js$/.test(f)) continue;
    let src;
    try { src = fs.readFileSync(path.join(dir, f), 'utf8'); } catch (e) { continue; }
    const re = /exports\._h\.([A-Za-z0-9_]+)\s*=/g;
    let m;
    while ((m = re.exec(src))) names.add(m[1]);
  }
  return names;
}

/* ── The join ────────────────────────────────────────────────────────────── */
const registry = sourceRegistry();
const deployed = new Set(
  fs.readFileSync(SNAPSHOT, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
);
const handlers = allHandlerNames();
const disp = dispatchers().map((d) => ({ ...d, handlers: handlerCount('') || 0 }));

const exported = [...registry.keys()];
const both         = exported.filter((n) => deployed.has(n)).sort();
const exportedOnly = exported.filter((n) => !deployed.has(n)).sort();
const deployedOnly = [...deployed].filter((n) => !registry.has(n)).sort();

/* A deployed name that is not exported but IS a dispatcher handler is not an
   orphan — it is a capability whose deployment identity is its dispatcher. */
const deployedOnlyHandlers = deployedOnly.filter((n) => handlers.has(n));
const deployedOnlyUnknown  = deployedOnly.filter((n) => !handlers.has(n));

const report = {
  generatedAt: new Date().toISOString(),
  snapshot: {
    path: 'scripts/infra/deployed-functions.txt',
    count: deployed.size,
    caveat: 'A RECORDED snapshot captured 2026-09-19, not live truth. Every figure ' +
            'derived from it inherits that caveat; re-capture before acting.',
  },
  sourceRegistry: { count: registry.size, path: 'functions/index.js' },
  join: {
    inBoth: both.length,
    exportedNotDeployed: exportedOnly.length,
    deployedNotExported: deployedOnly.length,
    deployedNotExportedButDispatcherHandler: deployedOnlyHandlers.length,
    orphanCandidates: deployedOnlyUnknown.length,
  },
  dispatchers: disp,
  handlerNamesInSource: handlers.size,
  lists: { exportedNotDeployed: exportedOnly, orphanCandidates: deployedOnlyUnknown,
           deployedHandlers: deployedOnlyHandlers },
};

if (AS_JSON) { process.stdout.write(JSON.stringify(report, null, 2) + '\n'); process.exit(0); }

if (ORPHANS) {
  console.log('ORPHAN CANDIDATES — deployed, not exported, not a dispatcher handler');
  console.log('These are QUESTIONS, not retirement decisions. Unknown is not obsolete.');
  console.log('');
  deployedOnlyUnknown.forEach((n) => console.log('  ' + n));
  console.log('');
  console.log('  ' + deployedOnlyUnknown.length + ' candidates');
  process.exit(0);
}

console.log('══════════════════════════════════════════════════════════════════');
console.log('  FUNCTION ESTATE INVENTORY — PHASE 1 (read-only)');
console.log('══════════════════════════════════════════════════════════════════');
console.log('  source registry (functions/index.js exports) : ' + registry.size);
console.log('  deployed snapshot (2026-09-19, RECORDED)     : ' + deployed.size);
console.log('');
console.log('  ── THE JOIN ────────────────────────────────────────────────────');
console.log('  exported AND deployed                        : ' + both.length);
console.log('  exported, NOT in the snapshot                : ' + exportedOnly.length);
console.log('  deployed, NOT exported                       : ' + deployedOnly.length);
console.log('    of which are dispatcher handlers           : ' + deployedOnlyHandlers.length);
console.log('    ORPHAN CANDIDATES                          : ' + deployedOnlyUnknown.length);
console.log('');
console.log('  An orphan candidate is a QUESTION. It may be reachable, deployed');
console.log('  from another branch, or left by an unfinished refactor. UNKNOWN');
console.log('  DOES NOT MEAN OBSOLETE, and nothing here authorises a deletion.');
console.log('');
console.log('  ── DEPLOYMENT IDENTITY: dispatchers ────────────────────────────');
console.log('  A handler on a dispatcher has NO independent deployment identity.');
console.log('  handler names found in source                : ' + handlers.size);
disp.forEach((d) => console.log('  unit: ' + d.unit.padEnd(22) + d.file));
console.log('');
console.log('  ── TRIGGER SPREAD across exported functions ────────────────────');
const byTrigger = {};
registry.forEach((v) => { const k = v.trigger || 're-export (body elsewhere)';
  byTrigger[k] = (byTrigger[k] || 0) + 1; });
Object.keys(byTrigger).sort((a, b) => byTrigger[b] - byTrigger[a])
  .forEach((k) => console.log('  ' + String(byTrigger[k]).padStart(5) + '  ' + k));
console.log('');
console.log('  ── WHAT THIS PHASE CANNOT ESTABLISH ────────────────────────────');
console.log('  traffic · errors · invocations · instance counts · revisions ·');
console.log('  image digests · last deployment · scaling AS SERVED · secrets in');
console.log('  effect. Those need the GCP reader, which is implemented and NOT');
console.log('  DEPLOYED. Classification (Phase 5) must wait for them.');
console.log('══════════════════════════════════════════════════════════════════');
