#!/usr/bin/env node
/* App Check enforcement census across the SOKONI callable surface. READ ONLY.
 *
 * Why this is not a grep: `enforceAppCheck: true` usually appears ONCE per
 * module, in a shared options constant —
 *     const OPTS = { region: REGION, enforceAppCheck: true };
 *     exports.foo = onCall(OPTS, handler);
 * so counting the flag near each onCall undercounts enforcement badly. This
 * resolves single-level option constants within a file.
 *
 * It also follows index.js re-exports, because the DEPLOYED function name is
 * the name index.js exports, not the name inside the defining module.
 *
 * Output is a census, NOT a vulnerability list. "No App Check" is not
 * "insecure" — App Check attests the CALLER APP; authentication and
 * authorization are separate controls and are audited separately.
 *
 * Usage: node scripts/infra/appcheck-census.js [--json]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', 'functions');
const JSON_OUT = process.argv.includes('--json');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/* Strip comments so a commented-out onCall or an explanatory mention of
   enforceAppCheck is never counted as code. Preserves line count. */
function strip(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' ');
}

const files = walk(ROOT);
const defs = new Map();      // "relpath::localName" -> record
const constAppCheck = new Map(); // "relpath::CONSTNAME" -> true/false

for (const f of files) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  const src = strip(fs.readFileSync(f, 'utf8'));

  /* 1. option constants: const X = { ... enforceAppCheck: true ... } */
  const constRe = /(?:const|let|var)\s+([A-Za-z0-9_]+)\s*=\s*\{([^}]*)\}/g;
  let m;
  while ((m = constRe.exec(src))) {
    const body = m[2];
    if (/enforceAppCheck/.test(body)) {
      constAppCheck.set(`${rel}::${m[1]}`, /enforceAppCheck\s*:\s*true/.test(body));
    }
  }

  /* 2. callable definitions: exports.NAME = onCall(ARG, ...)
     ARG must be extracted by BRACE MATCHING, not "up to the first comma".
     A multi-property options object contains commas, so a comma-terminated
     capture truncates `{ region: REGION, ..., enforceAppCheck: true }` to
     `{ region: REGION` and reports enforcement as ABSENT. That defect
     misclassified every money callable in the first run of this script. */
  const callRe = /exports\.([A-Za-z0-9_]+)\s*=\s*(?:functions\.[^=]*?)?(?:https\.)?onCall\s*\(\s*/g;
  while ((m = callRe.exec(src))) {
    const name = m[1];
    let arg = '';
    const start = m.index + m[0].length;
    if (src[start] === '{') {
      let depth = 0;
      for (let i = start; i < src.length; i++) {
        const c = src[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { arg = src.slice(start, i + 1); break; } }
      }
    } else {
      const comma = src.indexOf(',', start);
      arg = comma === -1 ? '' : src.slice(start, comma);
    }
    arg = arg.trim();
    let appCheck = null; /* null = could not determine */
    let how = '';
    if (/^\{/.test(arg) || arg.includes('enforceAppCheck')) {
      if (/enforceAppCheck\s*:\s*true/.test(arg)) { appCheck = true; how = 'inline literal'; }
      else if (/enforceAppCheck\s*:\s*false/.test(arg)) { appCheck = false; how = 'inline literal (explicit false)'; }
      else {
        /* Object SPREAD: { ..._CF_OPTS, timeoutSeconds: 30 }. The flag may live
           in the spread constant, so resolve it before declaring it absent.
           Missing this reported redisDispatch as unenforced without looking. */
        const spread = [...arg.matchAll(/\.\.\.\s*([A-Za-z0-9_]+)/g)].map((x) => x[1]);
        let found = null, via = '';
        for (const s of spread) {
          const k = `${rel}::${s}`;
          if (constAppCheck.has(k)) { found = constAppCheck.get(k); via = `spread ${s}`; break; }
        }
        if (found !== null) { appCheck = found; how = `inline literal + ${via}`; }
        else if (spread.length) { appCheck = false; how = `inline literal + spread ${spread[0]} (no flag found)`; }
        else if (/^\{/.test(arg)) { appCheck = false; how = 'inline literal, flag absent'; }
      }
    } else if (/^[A-Za-z0-9_]+$/.test(arg)) {
      const k = `${rel}::${arg}`;
      if (constAppCheck.has(k)) { appCheck = constAppCheck.get(k); how = `via const ${arg}`; }
      else { appCheck = false; how = `via const ${arg} (no flag found)`; }
    }
    const line = src.slice(0, m.index).split('\n').length;
    defs.set(`${rel}::${name}`, { rel, name, line, appCheck, how });
  }
}

/* 3. index.js re-exports: exports.DEPLOYED = mod.local  /  require('./m').local */
const idx = strip(fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8'));
const modAlias = new Map();
let m2;
const reqRe = /(?:const|let|var)\s+([A-Za-z0-9_]+)\s*=\s*require\(\s*['"]\.\/([^'"]+)['"]\s*\)/g;
while ((m2 = reqRe.exec(idx))) modAlias.set(m2[1], m2[2].replace(/\.js$/, '') + '.js');

const deployedFromIndex = new Map(); // deployedName -> defKey | null
const reexpRe = /exports\.([A-Za-z0-9_]+)\s*=\s*([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)\s*;/g;
while ((m2 = reexpRe.exec(idx))) {
  const [, deployed, alias, local] = m2;
  const file = modAlias.get(alias);
  deployedFromIndex.set(deployed, file ? `${file}::${local}` : null);
}
/* bulk re-export: Object.assign(exports, alias) — every callable defined in
   that module becomes deployable under its own local name. Missing this
   silently drops whole modules from the census. */
const assignRe = /Object\.assign\(\s*exports\s*,\s*([A-Za-z0-9_]+)\s*\)/g;
while ((m2 = assignRe.exec(idx))) {
  const file = modAlias.get(m2[1]);
  if (!file) continue;
  for (const [k, v] of defs) if (v.rel === file) deployedFromIndex.set(v.name, k);
}

/* direct definitions inside index.js itself */
for (const [k, v] of defs) if (v.rel === 'index.js') deployedFromIndex.set(v.name, k);

/* ---- report ------------------------------------------------------------- */
const rows = [];
for (const [deployed, key] of deployedFromIndex) {
  const d = key && defs.get(key);
  if (!d) continue; /* not a callable, or unresolved — excluded from callable census */
  rows.push({ deployed, file: d.rel, line: d.line, appCheck: d.appCheck, how: d.how });
}
/* callables defined but never re-exported through index.js */
const reexported = new Set([...deployedFromIndex.values()].filter(Boolean));
const orphans = [...defs.entries()].filter(([k]) => !reexported.has(k)).map(([, v]) => v);

const enforced = rows.filter((r) => r.appCheck === true);
const unenforced = rows.filter((r) => r.appCheck === false);
const unknown = rows.filter((r) => r.appCheck === null);

if (JSON_OUT) { console.log(JSON.stringify({ rows, orphans }, null, 1)); process.exit(0); }

/* Join against the AUTHORITATIVE deployed list so coverage is measured, not
   assumed. Anything deployed that we cannot resolve is reported as UNRESOLVED
   — never silently dropped, and never counted as "enforced". */
const deployedFile = path.join(__dirname, 'deployed-functions.txt');
let deployedNames = null;
if (fs.existsSync(deployedFile)) {
  deployedNames = new Set(fs.readFileSync(deployedFile, 'utf8').split('\n')
    .map((s) => s.trim()).filter(Boolean));
}

console.log('APP CHECK CENSUS — callable surface (repo source)');
console.log('='.repeat(64));
if (deployedNames) {
  const resolved = rows.filter((r) => deployedNames.has(r.deployed));
  const notDeployed = rows.filter((r) => !deployedNames.has(r.deployed));
  const unresolved = [...deployedNames].filter((n) => !rows.some((r) => r.deployed === n));
  console.log(`  DEPLOYED functions (authoritative)     : ${deployedNames.size}`);
  console.log(`    resolved to a CALLABLE definition    : ${resolved.length}`);
  console.log(`    deployed but NOT resolved as callable: ${unresolved.length}`);
  console.log(`      (triggers, schedules, onRequest, or unparsed — NOT assumed safe)`);
  console.log(`  callables found in source but NOT deployed: ${notDeployed.length}`);
  const de = resolved.filter((r) => r.appCheck === true).length;
  const du = resolved.filter((r) => r.appCheck === false).length;
  const dn = resolved.filter((r) => r.appCheck === null).length;
  console.log(`\n  OF THE DEPLOYED CALLABLES:`);
  console.log(`    App Check ENFORCED                   : ${de}`);
  console.log(`    App Check NOT enforced               : ${du}`);
  console.log(`    UNDETERMINED                         : ${dn}`);
  console.log('='.repeat(64));
}
console.log(`  callable definitions found (all files) : ${defs.size}`);
console.log(`  re-exported via index.js (deployable)  : ${rows.length}`);
console.log(`    App Check ENFORCED                   : ${enforced.length}`);
console.log(`    App Check NOT enforced               : ${unenforced.length}`);
console.log(`    UNDETERMINED                         : ${unknown.length}`);
console.log(`  defined but NOT re-exported (orphans)  : ${orphans.length}`);
console.log('\n  NOTE: "not enforced" is not "vulnerable". App Check attests the');
console.log('  calling app; auth/authz are separate controls, audited separately.');

console.log('\n-- how enforcement was determined (method distribution):');
const byHow = {};
for (const r of rows) byHow[r.how] = (byHow[r.how] || 0) + 1;
for (const [k, v] of Object.entries(byHow).sort((a, b) => b[1] - a[1])) {
  console.log(`   ${String(v).padStart(5)}  ${k}`);
}

console.log('\n-- unenforced callables by defining module (top 20):');
const byFile = {};
for (const r of unenforced) byFile[r.file] = (byFile[r.file] || 0) + 1;
for (const [k, v] of Object.entries(byFile).sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`   ${String(v).padStart(4)}  ${k}`);
}
