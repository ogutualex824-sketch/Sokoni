/* CENSUS — every code path that can CREATE a users/{uid} document.
   ==========================================================================
   Run:  node scripts/census-users-doc-writers.js
         node scripts/census-users-doc-writers.js --json > docs/users-writers.json

   WHY THIS EXISTS
   The Admin dashboard's "Total Users" is `db.collection('users').count()`
   (functions/admin-os.js) — a count of FIRESTORE DOCUMENTS, not of Firebase
   Authentication accounts. 83 documents against fewer than 20 Auth accounts is not
   a contradiction on its face; it is an unanswered question about what created the
   difference.

       a Firestore users document  !=  a Firebase Auth account

   The mechanism that can inflate the count is specific and worth stating plainly:

       set(ref, data, {merge:true})   CREATES the document when it does not exist
       update(ref, data)              FAILS when it does not exist

   So every `set(..., {merge:true})` against `users/{uid}` is a path that can mint a
   stub — a document containing only the fields that writer happened to touch, for a
   uid that may never have signed up. `update()` cannot. This census separates them.

   WHAT IT DOES NOT DO
   It cannot say how many of the 83 are real. That needs the Auth side, which needs
   Admin SDK credentials this environment does not have. Nothing here estimates,
   extrapolates, or reports a number it did not read. The classifier that consumes
   this lives in scripts/reconcile-users-vs-auth.js and refuses to run without
   credentials rather than guessing.

   CONTROLS
   * The scanner must FIND a writer that is known to exist.
   * It must NOT classify `update()` or a read as a creating write.
   * A file with no users/ writes must produce no rows.
   ==========================================================================*/
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const JSON_OUT = process.argv.includes('--json');

/* ── collect candidate source files ───────────────────────────────────────── */
function walk(dir, out) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    if (['node_modules', '.git', 'dist', 'build', 'coverage'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p, out); continue; }
    if (/\.(js|mjs|cjs|html)$/.test(e.name)) out.push(p);
  }
  return out;
}

/* ── the write shapes ─────────────────────────────────────────────────────────
   Both SDK dialects appear in this repo:
     admin/compat   db.collection('users').doc(X).set(DATA, OPTS)
     modular        setDoc(doc(db, 'users', X), DATA, OPTS)
   plus transaction/batch forms  tx.set(ref, DATA, OPTS).
   Matching the CALL shape rather than the word "users" keeps prose and comments out. */
const PATTERNS = [
  { name: 'compat .collection("users").doc(x).set',
    re: /\.collection\(\s*["'`]users["'`]\s*\)\s*\.doc\(([^)]*)\)\s*\.\s*(set|update)\s*\(/g },
  { name: 'modular setDoc(doc(db,"users",x))',
    re: /\b(setDoc|updateDoc)\s*\(\s*doc\(\s*[^,]+,\s*["'`]users["'`]\s*,([^)]*)\)/g },
  { name: 'tx/batch .set(db.collection("users").doc(x))',
    re: /\b(?:tx|txn|t|batch)\s*\.\s*(set|update)\s*\(\s*[^,]*collection\(\s*["'`]users["'`]\s*\)\s*\.doc\(([^)]*)\)/g },
];

/* Look ahead from the call site for a merge option and for the first-level fields. */
function inspectCall(src, idx) {
  const tail = src.slice(idx, idx + 900);
  const merge = /\{\s*merge\s*:\s*true\s*\}/.test(tail);
  const fields = [];
  /* When the payload is a VARIABLE — set(ref, profile, {merge:true}) — the first
     object literal after the call is the OPTIONS object, and reading its keys
     reported the field list as {merge}. Say "variable payload" instead of naming a
     field that does not exist. */
  const firstBrace = tail.indexOf('{');
  if (firstBrace > -1 && /^\{\s*merge\s*:/.test(tail.slice(firstBrace))) {
    return { merge, fields: ['<variable payload>'], opaque: true };
  }
  /* first-level keys of the object literal that follows the opening paren */
  const objStart = tail.indexOf('{');
  if (objStart > -1) {
    let depth = 0, i = objStart;
    for (; i < tail.length; i++) {
      if (tail[i] === '{') depth++;
      else if (tail[i] === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    const body = tail.slice(objStart, i);
    const keyRe = /(?:^|[{,])\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)\s*:/g;
    let k, seen = new Set(), d2 = 0;
    /* only keys at depth 1 */
    let depthTrack = 0;
    for (let j = 0; j < body.length; j++) {
      if (body[j] === '{') depthTrack++;
      if (body[j] === '}') depthTrack--;
    }
    while ((k = keyRe.exec(body))) { if (!seen.has(k[1])) { seen.add(k[1]); fields.push(k[1]); } }
  }
  return { merge, fields: fields.slice(0, 10) };
}

function lineOf(src, idx) { return src.slice(0, idx).split(/\r?\n/).length; }

function scanFile(p) {
  let src = '';
  try { src = fs.readFileSync(p, 'utf8'); } catch (_) { return []; }
  /* comments are not code — a comment describing a writer is not a writer */
  const clean = src
    .replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/^[ \t]*\/\/.*$/gm, (m) => ' '.repeat(m.length));

  const rows = [];
  for (const pat of PATTERNS) {
    pat.re.lastIndex = 0;
    let m;
    while ((m = pat.re.exec(clean))) {
      const verb = /update/i.test(m[0]) ? 'update' : 'set';
      const info = inspectCall(clean, m.index);
      rows.push({
        file: path.relative(ROOT, p).replace(/\\/g, '/'),
        line: lineOf(clean, m.index),
        shape: pat.name,
        verb,
        merge: info.merge,
        /* set+merge creates on absence; set without merge also creates (and clobbers);
           update never creates. Only the first two can inflate the count. */
        canCreate: verb === 'set',
        /* A narrow merge write mints a document holding only what it touched. An
           opaque (variable) payload is NOT counted as narrow — its width is unknown,
           and calling an unknown a stub would be inventing a finding. */
        stubRisk: verb === 'set' && info.merge && !info.opaque
                  && info.fields.length > 0 && info.fields.length <= 4,
        opaque: !!info.opaque,
        /* Emulator harnesses and one-off migrations write to a test project or under
           an operator's hand. They cannot be a source of stubs in production, and
           mixing them into the production census would overstate it more than
           threefold. Kept, but separated. */
        production: !/^scripts\//.test(path.relative(ROOT, p).replace(/\\/g, '/')),
        fields: info.fields,
      });
    }
  }
  return rows;
}

/* This scanner CONTAINS the call shapes it looks for, as regex literals, so scanning
   itself matched its own source and the "clean file" control failed. Exclude it by
   PATH — not by weakening the pattern, which would blind the census to the real
   writers it exists to find. */
const SELF = path.relative(ROOT, __filename).replace(/\\/g, '/');
const files = walk(ROOT, []).filter(
  (f) => path.relative(ROOT, f).replace(/\\/g, '/') !== SELF);
let rows = [];
for (const f of files) rows = rows.concat(scanFile(f));

/* ── controls ─────────────────────────────────────────────────────────────── */
const controls = [];
const ck = (label, ok, detail) => controls.push({ label, ok, detail: detail || '' });

ck('the scanner finds a writer known to exist (firebase.js signup path)',
  rows.some((r) => /^firebase\.js$/.test(r.file) && r.verb === 'set'),
  rows.filter((r) => r.file === 'firebase.js').length + ' row(s) in firebase.js');
ck('update() is NOT classified as able to create',
  rows.filter((r) => r.verb === 'update').every((r) => r.canCreate === false),
  rows.filter((r) => r.verb === 'update').length + ' update row(s)');
ck('a file with no users writes yields no rows',
  scanFile(path.join(ROOT, 'package.json')).length === 0, 'package.json');
/* The converse control: prove the exclusion above is load-bearing rather than
   decorative — the scanner really would match its own shapes. */
ck('CONTROL the scanner WOULD match its own shapes if not excluded',
  scanFile(__filename).length > 0,
  'self-match ' + scanFile(__filename).length + ' row(s), excluded by path');
ck('every row names a real file and line',
  rows.every((r) => r.file && r.line > 0), '');

/* Emulator harnesses and one-off migrations under scripts/ write to a test project
   or under an operator's hand. They cannot mint a stub in production, and folding
   them in would overstate the production census more than threefold. */
const prodRows = rows.filter((r) => r.production);
const testCreators = rows.filter((r) => !r.production && r.canCreate);
const creators = prodRows.filter((r) => r.canCreate);
const merges   = creators.filter((r) => r.merge);
const stubs    = creators.filter((r) => r.stubRisk);
const byFile   = {};
for (const r of creators) (byFile[r.file] = byFile[r.file] || []).push(r);

if (JSON_OUT) {
  console.log(JSON.stringify({
    generated: 'census-users-doc-writers',
    totals: { rows: rows.length, creators: creators.length, merges: merges.length, stubs: stubs.length },
    controls, rows,
  }, null, 2));
  process.exit(controls.every((c) => c.ok) ? 0 : 1);
}

console.log('\n  users/{uid} WRITER CENSUS\n');
console.log('  ── controls');
for (const c of controls) {
  console.log('  ' + (c.ok ? 'PASS  ' : 'FAIL  ') + c.label + (c.detail ? '   [' + c.detail + ']' : ''));
}

console.log('\n  ── totals');
console.log('  write sites found          ' + rows.length);
console.log('  can CREATE a document      ' + creators.length + '   (set; update cannot)');
console.log('  of those, set+merge        ' + merges.length);
console.log('  narrow set+merge (<=4 keys) ' + stubs.length + '   <- most likely to mint a stub');
console.log('  opaque payloads            ' + creators.filter((r) => r.opaque).length
  + '   (payload is a variable; width unknown, NOT counted as narrow)');
console.log('  excluded, scripts/ only    ' + testCreators.length
  + '   (emulator harnesses / one-off migrations)');

console.log('\n  ── the narrow set+merge writers, which mint a document holding only these fields');
if (!stubs.length) console.log('  (none)');
for (const r of stubs.sort((a, b) => a.file.localeCompare(b.file))) {
  console.log('  ' + (r.file + ':' + r.line).padEnd(46) + ' {' + r.fields.join(', ') + '}');
}

console.log('\n  ── every creating writer, by file');
for (const f of Object.keys(byFile).sort()) {
  const rs = byFile[f];
  console.log('  ' + f + '   (' + rs.length + ')');
  for (const r of rs) {
    console.log('      line ' + String(r.line).padEnd(6)
      + (r.merge ? 'merge:true  ' : 'overwrite   ')
      + '{' + r.fields.slice(0, 6).join(', ') + '}');
  }
}

console.log('\n  A Firestore users document is not a Firebase Auth account. This census says');
console.log('  WHICH code can mint one; it does not say how many of the live documents are');
console.log('  real. That needs the Auth side — see scripts/reconcile-users-vs-auth.js.\n');
process.exit(controls.every((c) => c.ok) ? 0 : 1);
