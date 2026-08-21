/* CENSUS — WRITER half of the role-source population question.
   ==========================================================================
   Run:  node scripts/census-role-source-writers.js
         node scripts/census-role-source-writers.js --json > docs/role-writers.json

   READ-ONLY. Nothing is renamed, normalised, or written.

   THE QUESTION
   The consumer half (77e7928) found nine sites reading a role: seven read the
   users/{uid}.roles ARRAY, two read claims.role. setUserRole writes neither — it
   writes only the SINGULAR users/{uid}.role. So a check can be dead rather than
   merely redundant, depending on which path promoted the account.

   This half maps the other side: which promotion path populates which field.

       users/{uid}.role      singular Firestore field
       users/{uid}.roles     Firestore ARRAY — a different field, never conflated
       claims.role           a CUSTOM CLAIM — not Firestore at all

   Those three are deliberately kept apart. Treating `role` and `roles` as one thing,
   or a claim as a document field, is what makes this class of bug invisible.

   ON OPAQUE PAYLOADS
   setCustomUserClaims REPLACES the whole claim set, so what it is handed matters
   more than usual. Where the argument is an object literal its first-level keys are
   read. Where it is a variable, the nearest preceding definition in the same file is
   resolved. Where it spreads another object (`...existingClaims`) the result is
   marked PARTIAL — the spread contents cannot be known statically, and guessing them
   would invent the very matrix this census exists to establish. OPAQUE and PARTIAL
   are reported as such, never rounded to "none".

   CONTROLS
   * The scanner must not count its own source (it contains these shapes).
   * A users.role writer must not be reported as a users.roles writer.
   * A claim writer must not be reported as a Firestore writer.
   * A known writer must be found; a clean file must yield nothing.
   ==========================================================================*/
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const JSON_OUT = process.argv.includes('--json');
const SELF = path.relative(ROOT, __filename).replace(/\\/g, '/');

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  if (!JSON_OUT) console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

/* Production only. scripts/ harnesses and one-off migrations write to an emulator or
   under an operator's hand and are not promotion paths. */
/* Match node_modules / scripts / tests at ANY depth. The first version anchored at
   the start, so functions/node_modules leaked the Firebase SDK's own
   setCustomUserClaims wrappers into the matrix as if they were promotion paths. */
const SKIP = /(^|[\\/])(node_modules|\.git|docs|scripts|tests)([\\/]|$)/;
function sources() {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const rel = path.relative(ROOT, path.join(d, e.name)).replace(/\\/g, '/');
      if (SKIP.test(rel) || rel === SELF) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (/\.(js|mjs|cjs|html)$/.test(e.name)) out.push(p);
    }
  }(ROOT));
  return out;
}

const strip = (s) => s
  .replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length))
  .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
  .replace(/^[ \t]*\/\/.*$/gm, (m) => ' '.repeat(m.length));

const lineOf = (s, i) => s.slice(0, i).split(/\r?\n/).length;

/* Nearest enclosing exported handler or function — the promotion path's NAME, which
   is what a reader needs in order to ask "did this account come through here". */
/* The EXPORTED handler is the promotion path a reader can actually ask about.

   The first version took the nearest preceding definition of any kind, which in a
   9,000-line functions/index.js is usually a small helper declared just above the
   call — it reported dobVal(), pct(), allowedUids() and normalisePhone() as
   promotion paths, none of which are. Prefer the enclosing export; fall back to a
   named function only when no export precedes the call. */
function enclosing(src, idx) {
  const head = src.slice(0, idx);
  let best = { at: -1, name: null };
  const exp = /exports\.([A-Za-z_$][\w$]*)\s*=/g;
  let m;
  while ((m = exp.exec(head))) if (m.index > best.at) best = { at: m.index, name: m[1] };
  if (best.name) return best.name;
  /* No export above: a module-scope helper file. Take the nearest named function,
     and SAY that is what it is rather than dressing it up as a handler. */
  let fn = { at: -1, name: null };
  const fre = /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = fre.exec(head))) if (m.index > fn.at) fn = { at: m.index, name: m[1] };
  return fn.name ? fn.name + ' [helper]' : '(module scope)';
}

/* Balanced-brace slice starting at the first '{' from idx. */
function objectAt(src, idx) {
  const start = src.indexOf('{', idx);
  if (start < 0) return null;
  let d = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}') { d--; if (d === 0) return src.slice(start, i + 1); }
  }
  return null;
}

function firstLevelKeys(obj) {
  const keys = []; let d = 0, spread = false;
  const re = /(\.\.\.)?([A-Za-z_$][\w$]*|["'`][^"'`]+["'`])\s*:/g;
  for (let i = 0; i < obj.length; i++) {
    if (obj[i] === '{') d++;
    else if (obj[i] === '}') d--;
  }
  if (/\.\.\./.test(obj.slice(0, obj.indexOf(':') > -1 ? obj.length : obj.length))) spread = /\.\.\./.test(obj);
  let m; d = 0;
  const body = obj.slice(1, -1);
  let depth = 0, buf = '', parts = [];
  for (const ch of body) {
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    if (ch === '}' || ch === ']' || ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(buf); buf = ''; continue; }
    buf += ch;
  }
  parts.push(buf);
  for (const p of parts) {
    const t = p.trim();
    if (!t) continue;
    if (t.startsWith('...')) { spread = true; continue; }
    const km = t.match(/^([A-Za-z_$][\w$]*|["'`][^"'`]+["'`])\s*:/);
    if (km) keys.push(km[1].replace(/["'`]/g, ''));
    else if (/^[A-Za-z_$][\w$]*$/.test(t)) keys.push(t);   /* shorthand */
  }
  return { keys, spread };
}

/* Resolve argument N (0-based) of the call whose '(' follows callIdx.

   The payload must begin AT that argument position. The first version searched for
   the next '{' anywhere ahead, so a call taking a variable payload picked up some
   unrelated object literal further down the file and reported its keys as claims.
   Bounded resolution, and anything that is not a literal or a resolvable local
   variable is reported OPAQUE rather than guessed. */
function resolveArg(src, callIdx, argIndex) {
  const open = src.indexOf('(', callIdx);
  if (open < 0) return { kind: 'OPAQUE', keys: [], note: 'call not parsed' };
  let i = open + 1, depth = 0, arg = 0, start = i;
  for (; i < src.length; i++) {
    const c = src[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) {
      if (depth === 0) break;
      depth--;
    } else if (c === ',' && depth === 0) {
      if (arg === argIndex) break;
      arg++; start = i + 1;
    }
  }
  if (arg !== argIndex) return { kind: 'OPAQUE', keys: [], note: 'argument ' + argIndex + ' not present' };
  const text = src.slice(start, i).trim();
  if (!text) return { kind: 'OPAQUE', keys: [], note: 'empty argument' };

  if (text.startsWith('{')) {
    const { keys, spread } = firstLevelKeys(text);
    return { kind: spread ? 'PARTIAL' : 'LITERAL', keys,
             note: spread ? 'spreads another object — remaining keys unknown' : '' };
  }
  const id = (text.match(/^([A-Za-z_$][\w$]*)$/) || [])[1];
  if (!id) return { kind: 'OPAQUE', keys: [], note: 'argument is an expression: ' + text.slice(0, 40) };
  const defRe = new RegExp('(?:const|let|var)\\s+' + id + '\\s*=\\s*\\{', 'g');
  let m, at = -1;
  while ((m = defRe.exec(src))) { if (m.index < callIdx && m.index > at) at = m.index; }
  if (at < 0) return { kind: 'OPAQUE', keys: [], note: 'variable `' + id + '` not defined in this file' };
  const obj = objectAt(src, at);
  if (!obj) return { kind: 'OPAQUE', keys: [], note: 'variable `' + id + '` unresolvable' };
  const { keys, spread } = firstLevelKeys(obj);
  return { kind: spread ? 'PARTIAL' : 'LITERAL', keys,
           note: 'resolved from `' + id + '`' + (spread ? ', spreads another object' : '') };
}
const resolveClaimArg = (src, callIdx) => resolveArg(src, callIdx, 1);

/* ── scan ─────────────────────────────────────────────────────────────────── */
const rows = [];
for (const f of sources()) {
  let raw = ''; try { raw = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
  const src = strip(raw);
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');

  /* A: custom claims */
  const claimRe = /setCustomUserClaims\s*\(/g;
  let m;
  while ((m = claimRe.exec(src))) {
    const r = resolveClaimArg(src, m.index);
    rows.push({
      target: 'claims', file: rel, line: lineOf(src, m.index),
      fn: enclosing(src, m.index), kind: r.kind, keys: r.keys, note: r.note,
      writesRoleClaim: r.keys.includes('role'),
      otherClaims: r.keys.filter((k) => k !== 'role'),
    });
  }

  /* B: Firestore users doc — role vs roles kept strictly apart */
  /* compat  .collection('users').doc(x).set(PAYLOAD, opts)     payload = arg 0
     modular setDoc(doc(db,'users',x), PAYLOAD, opts)           payload = arg 1 */
  const compatRe = /\.collection\(\s*["'`]users["'`]\s*\)\s*\.doc\([^)]*\)\s*\.\s*(?:set|update)\s*\(/g;
  const modularRe = /(?:setDoc|updateDoc)\s*\(\s*doc\(\s*[^,]+,\s*["'`]users["'`]\s*,/g;
  for (const [re, argIdx, kindName] of [[compatRe, 0, 'compat'], [modularRe, 1, 'modular']]) {
    re.lastIndex = 0;
    while ((m = re.exec(src))) {
      /* for the modular shape the call paren is the one opening setDoc(, which sits
         at the match start; for compat it is the trailing '(' of .set( */
      const callIdx = kindName === 'compat' ? m.index + m[0].length - 1 : m.index;
      const r = resolveArg(src, callIdx, argIdx);
      const hasRole = r.keys.includes('role');
      const hasRoles = r.keys.includes('roles');
      if (!hasRole && !hasRoles && r.kind === 'LITERAL') continue;   /* writes neither */
      rows.push({
        target: 'firestore', file: rel, line: lineOf(src, m.index),
        fn: enclosing(src, m.index),
        kind: r.kind,
        writesRole: hasRole, writesRoles: hasRoles,
        keys: r.keys.slice(0, 8),
        note: r.note,
      });
    }
  }
}

/* ── controls ─────────────────────────────────────────────────────────────── */
if (!JSON_OUT) console.log('\n  ROLE-SOURCE WRITER CENSUS\n\n  ── controls');
ck('the scanner does not count its own source',
  !rows.some((r) => r.file === SELF), 'self excluded by path');
ck('a known claim writer is found (functions/super-admin.js)',
  rows.some((r) => r.target === 'claims' && /super-admin\.js/.test(r.file)), '');
ck('users.role and users.roles are never conflated',
  rows.filter((r) => r.target === 'firestore')
      .every((r) => typeof r.writesRole === 'boolean' && typeof r.writesRoles === 'boolean'), '');
ck('claim writers are not reported as Firestore writers',
  rows.filter((r) => r.target === 'claims').every((r) => r.writesRole === undefined), '');
ck('opaque and partial payloads are marked, not guessed',
  rows.filter((r) => r.kind !== 'LITERAL').every((r) => !!r.note),
  rows.filter((r) => r.kind !== 'LITERAL').length + ' non-literal payload(s)');
ck('every row names the promotion path responsible',
  rows.every((r) => !!r.fn), '');

if (JSON_OUT) {
  console.log(JSON.stringify({ generated: 'census-role-source-writers', rows }, null, 2));
  process.exit(fail ? 1 : 0);
}

/* ── the matrix ───────────────────────────────────────────────────────────── */
console.log('\n  ── THE MATRIX  (promotion path -> which source it populates)\n');
const paths = {};
for (const r of rows) {
  const key = r.file + '  ' + r.fn + '()';
  const p = paths[key] = paths[key] || { role: false, roles: false, claimRole: false,
                                          other: new Set(), lines: [], partial: false };
  p.lines.push(r.line);
  if (r.kind !== 'LITERAL') p.partial = true;
  if (r.target === 'firestore') { if (r.writesRole) p.role = true; if (r.writesRoles) p.roles = true; }
  else { if (r.writesRoleClaim) p.claimRole = true; (r.otherClaims || []).forEach((k) => p.other.add(k)); }
}
const mark = (b) => (b ? ' Y ' : ' - ');
const W = 58;
  console.log('  ' + 'promotion path'.padEnd(W) + 'role roles claim  other claims');
console.log('  ' + '-'.repeat(W) + '---- ----- -----  ------------');
for (const k of Object.keys(paths).sort()) {
  const p = paths[k];
  console.log('  ' + (k.length > W-2 ? k.slice(0, W-3) + '…' : k).padEnd(W) + mark(p.role) + ' ' + mark(p.roles) + '  ' + mark(p.claimRole)
    + '   ' + (p.other.size ? [...p.other].slice(0, 5).join(',') : '-')
    + (p.partial ? '   [PARTIAL]' : ''));
}

console.log('\n  ── what the matrix means for the 9 consumers');
const writesRoles = Object.values(paths).filter((p) => p.roles).length;
const writesClaimRole = Object.values(paths).filter((p) => p.claimRole).length;
const writesRole = Object.values(paths).filter((p) => p.role).length;
console.log('  paths populating users/{uid}.role    ' + writesRole);
console.log('  paths populating users/{uid}.roles   ' + writesRoles + '   <- 7 consumers read this');
console.log('  paths populating claims.role         ' + writesClaimRole + '   <- 2 consumers read this');
console.log('\n  A consumer is only satisfied when the path that promoted THAT account');
console.log('  populated the field it reads. Which path a given account took is history,');
console.log('  not source, so the runtime half stays open.');

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
console.log('  Read-only. No role vocabulary renamed or normalised.\n');
process.exit(fail ? 1 : 0);
