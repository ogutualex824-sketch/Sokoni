/* ══════════════════════════════════════════════════════════════════════════════
   CF REACHABILITY — which exported onCall functions can anything actually reach?
   ══════════════════════════════════════════════════════════════════════════════
   The consolidation programme needs 212 fewer exports. The candidates report
   showed whole modules with 30+ onCall functions and no client call site at all,
   which would make this a DELETION problem, not a dispatcher problem.

   "No regex match" is not "dead", so a name is treated as reachable if ANY of
   these hold, and each is reported separately so the reason is visible:

     client     a client file names it in httpsCallable/sokoniCallable/CF/callable
     server     another functions/ module names it (server-to-server or re-export)
     dynamic    the module builds callable names at runtime, so NOTHING in it can
                be judged unreachable by name — the whole module is excluded
     docs       a doc, test or script names it (weak, reported but not protective)

   Nothing is deleted or edited here. Deleting a DEPLOYED Cloud Function is
   destructive and an orphaned function aborts a deploy, so this produces a
   review list, never an action.

     node scripts/cf-reachability.js
     node scripts/cf-reachability.js --module <name>
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');

const ONLY = (() => {
  const i = process.argv.indexOf('--module');
  return i > -1 ? process.argv[i + 1] : null;
})();

/* ── collect sources ──────────────────────────────────────────────────────── */
function collect(dir, skipFunctions) {
  const out = [];
  (function walk(d) {
    let e; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const x of e) {
      if (x.name === 'node_modules' || x.name === '.git') continue;
      if (skipFunctions && x.name === 'functions') continue;
      const p = path.join(d, x.name);
      if (x.isDirectory()) { walk(p); continue; }
      if (!/\.(js|html|mjs|md|json)$/.test(x.name)) continue;
      let s; try { s = fs.readFileSync(p, 'utf8'); } catch (_) { continue; }
      out.push({ p: path.relative(ROOT, p).split(path.sep).join('/'), s });
    }
  })(dir);
  return out;
}

const clientFiles = collect(ROOT, true).filter((f) => !/^(docs|scripts)\//.test(f.p) && /\.(js|html|mjs)$/.test(f.p));
const docFiles    = collect(ROOT, true).filter((f) => /^(docs|scripts)\//.test(f.p));
const serverFiles = collect(FN, false);

/* Modules that build callable names dynamically cannot be judged by name. */
const DYNAMIC_RE = /httpsCallable\s*\(\s*[^'")]/;

/* ── enumerate onCall exports per module ──────────────────────────────────── */
const files = fs.readdirSync(FN).filter((f) => /\.js$/.test(f));
const rows = [];

for (const f of files) {
  const mod = f.replace(/\.js$/, '');
  if (ONLY && mod !== ONLY) continue;
  let src; try { src = fs.readFileSync(path.join(FN, f), 'utf8'); } catch (_) { continue; }

  const names = [];
  const re = /^\s*(?:exports\.([A-Za-z0-9_]+)\s*=|const\s+([A-Za-z0-9_]+)\s*=)\s*onCall\s*\(/gm;
  let m;
  while ((m = re.exec(src))) names.push(m[1] || m[2]);
  if (!names.length) continue;

  const dynamic = DYNAMIC_RE.test(src);

  for (const n of names) {
    const word = new RegExp('\\b' + n + '\\b');
    const inClient = clientFiles.some((x) => word.test(x.s));
    const inServer = serverFiles.some((x) => x.p !== 'functions/' + f && word.test(x.s));
    const inDocs   = docFiles.some((x) => word.test(x.s));
    rows.push({ mod, name: n, dynamic, client: inClient, server: inServer, docs: inDocs });
  }
}

/* ── report ───────────────────────────────────────────────────────────────── */
const byMod = {};
rows.forEach((r) => { (byMod[r.mod] = byMod[r.mod] || []).push(r); });

const unreachable = (r) => !r.dynamic && !r.client && !r.server;

console.log('\nCF REACHABILITY');
console.log('='.repeat(88));
console.log('  A name is reachable if a client OR another server module references it.');
console.log('  "docs only" is reported but NEVER treated as reachable.\n');
console.log('  ' + 'MODULE'.padEnd(30) + 'onCall   client  server   NO-REF  (docs only)');
console.log('  ' + '-'.repeat(82));

let totalUnreach = 0, totalOnCall = 0;
const modRows = Object.entries(byMod).map(([mod, list]) => {
  const noref = list.filter(unreachable);
  return { mod, list, noref };
}).sort((a, b) => b.noref.length - a.noref.length);

for (const { mod, list, noref } of modRows) {
  totalOnCall += list.length;
  totalUnreach += noref.length;
  if (!noref.length && !ONLY) continue;
  const docsOnly = noref.filter((r) => r.docs).length;
  console.log('  ' + mod.padEnd(30) +
    String(list.length).padStart(6) +
    String(list.filter((r) => r.client).length).padStart(9) +
    String(list.filter((r) => r.server).length).padStart(8) +
    String(noref.length).padStart(9) +
    ('   ' + docsOnly).padStart(12));
}

console.log('');
console.log('  total onCall examined              : ' + totalOnCall);
console.log('  NO reference anywhere but its own module : ' + totalUnreach);
console.log('  target reduction                   : 212');
console.log('');
console.log('  These are REVIEW CANDIDATES, not a delete list. A deployed function');
console.log('  removed from source becomes an orphan, and an orphan aborts the next');
console.log('  deploy until it is explicitly deleted.');
console.log('='.repeat(88) + '\n');

if (ONLY) {
  console.log('  ' + ONLY + ' detail:');
  for (const r of (byMod[ONLY] || [])) {
    const tag = r.dynamic ? 'dynamic-module' : [r.client && 'client', r.server && 'server', r.docs && 'docs'].filter(Boolean).join('+') || 'NO-REF';
    console.log('    ' + r.name.padEnd(42) + tag);
  }
  console.log('');
}
