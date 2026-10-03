#!/usr/bin/env node
/* EDUCATION — ONE source of truth (owner 2026-10-03: "add a deliberate-break test so it cannot quietly become a second
 * source of truth again"). The orphan `education/{docId}` collection is client-writable on the served rules, has NO
 * writer in code, yet three live triggers (ts_education_*) push every write into Typesense search. Courses live in
 * `courses` (written only by functions/education.js); applicants in `applications`; enterprises in educationEnterprises.
 *
 *   node scripts/test-education-single-source.js [TREE ...]        default TREE = this repo
 *   RULES=<firestore.rules> node scripts/test-education-single-source.js    (default: C:/temp/sok-caprules/firestore.rules,
 *                                                                           f3's combined candidate)
 * W  no file in any TREE writes the `education` collection (web v9, compat, admin, REST path) — any new writer FAILS
 * R  the rules deny client create / update / delete on education/{docId}; the rules block is parsed by brace depth
 * C  positive controls: the scanner DOES find the legitimate `courses` writer and a planted writer string */
'use strict';
const fs = require('fs'), path = require('path');
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 300) + ']')); ok ? pass++ : fail++; };
const TREES = process.argv.slice(2).length ? process.argv.slice(2) : [path.join(__dirname, '..')];
const SKIP = /node_modules|\.git[\\/]|[\\/]docs[\\/]|[\\/]backups?[\\/]|[\\/]archive[\\/]|test-education-single-source\.js$/;
const files = [];
const walk = (d) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
  for (const e of es) { const p = path.join(d, e.name); if (SKIP.test(p)) continue; if (e.isDirectory()) walk(p); else if (/\.(js|mjs|cjs|html)$/.test(e.name)) files.push(p); } };
TREES.forEach(walk);
console.log('\neducation single source   trees=' + TREES.join(', ') + '   files=' + files.length + '\n');

/* a WRITE to the education collection, in any SDK shape; reads are allowed (search display, legacy owner read) */
const COL = String.raw`(?:collection\(\s*(?:[\w.]+\s*,\s*)?['"\x60]education['"\x60]\s*\)|doc\(\s*(?:[\w.]+\s*,\s*)?['"\x60]education\/[^'"\x60]*['"\x60]|doc\(\s*[\w.]+\s*,\s*['"\x60]education['"\x60]\s*,)`;
const WRITE = new RegExp(String.raw`(?:${COL}[\s\S]{0,160}?\.(?:set|add|update|delete|create)\s*\(|(?:setDoc|addDoc|updateDoc|deleteDoc)\s*\(\s*(?:${COL}))`);
const writers = [];
for (const f of files) { const s = fs.readFileSync(f, 'utf8'); if (WRITE.test(s)) writers.push(path.relative(TREES[0], f)); }
ck('W-1', writers.length === 0, 'no code writes the `education` collection (it must never become a second course / institution store)', writers);

/* positive controls — the scanner is not blind */
ck('C-1', WRITE.test("db.collection('education').doc(id).set({x:1})") && WRITE.test("addDoc(collection(db, 'education'), d)") && WRITE.test("setDoc(doc(db, 'education', id), d)") && WRITE.test("updateDoc(doc(db, 'education/' + id), d)"),
  'CONTROL: a planted writer in each SDK shape (admin / addDoc / setDoc / updateDoc) is detected');
ck('C-2', !WRITE.test("db.collection('courses').doc(id).set({x:1})") && !WRITE.test("collection('educationEnterprises').doc(uid).set(p)"),
  'CONTROL: the canonical `courses` writer and `educationEnterprises` are NOT mistaken for the orphan');
const courseWriter = files.some((f) => /education\.js$/.test(f) && /collection\(['"]courses['"]\)/.test(fs.readFileSync(f, 'utf8')));
ck('C-3', courseWriter || TREES.every((t) => !fs.existsSync(path.join(t, 'functions'))), 'CONTROL: the scan actually reached functions/education.js (the `courses` authority)');

/* rules */
const RULES = process.env.RULES || 'C:/temp/sok-caprules/firestore.rules';
let rules = null; try { rules = fs.readFileSync(RULES, 'utf8'); } catch (_) {}
if (!rules) { console.log('  BLOCKED R-* rules file not readable: ' + RULES + ' (BLOCKED is not PASS)'); fail++; }
else {
  const blocks = []; const re = /match\s+\/education\/\{docId\}\s*\{/g; let m;
  while ((m = re.exec(rules))) { let d = 0, j = rules.indexOf('{', m.index + m[0].length - 1); for (let k = j; k < rules.length; k++) { if (rules[k] === '{') d++; else if (rules[k] === '}' && --d === 0) { blocks.push(rules.slice(j, k + 1)); break; } } }
  ck('R-0', blocks.length >= 1, 'the rules carry an education/{docId} block (' + RULES + ')', blocks.length);
  const allowsWrite = (b, op) => { const r = new RegExp(String.raw`allow\s+([a-z,\s]*\b${op}\b[a-z,\s]*):\s*if\s+([\s\S]*?);`, 'g'); let x, any = false; while ((x = r.exec(b))) { if (x[2].trim() !== 'false') any = true; } return any; };
  for (const op of ['create', 'update', 'delete']) {
    const open = blocks.filter((b) => allowsWrite(b, op) || new RegExp(String.raw`allow\s+write\s*:\s*if\s+(?!false\s*;)`).test(b));
    ck('R-' + op, blocks.length && open.length === 0, 'clients cannot ' + op + ' education/{docId} (every duplicate block, since duplicate matches OR)', open.map((b) => b.slice(0, 160)));
  }
}
console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
