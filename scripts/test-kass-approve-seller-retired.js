#!/usr/bin/env node
'use strict';
/**
 * P0-G (owner 2026-10-03) — the KASS admin agent can never APPROVE a seller. It may still SUSPEND (containment), audited.
 * Runs the REAL executeTool from functions/index.js (extracted, executed in a vm with an in-memory store). No network.
 *   node scripts/test-kass-approve-seller-retired.js              → this tree (must pass)
 *   BASE=2861c98 node scripts/test-kass-approve-seller-retired.js → the live kass archive (must FAIL K-1)
 */
const fs = require('fs'); const path = require('path'); const vm = require('vm'); const { execSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const src = process.env.BASE ? execSync('git show ' + process.env.BASE + ':functions/index.js', { cwd: ROOT, encoding: 'utf8' }) : fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8');
let pass = 0, fail = 0;
const ck = (id, ok, msg, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + id + '  ' + msg + (ok ? '' : '  got=' + JSON.stringify(got))); ok ? pass++ : fail++; };

/* extract `async function executeTool(...) { ... }` by brace matching (strings / comments aware enough for this file) */
const at = src.indexOf('async function executeTool(');
if (at < 0) { console.log('CRASH (no verdict): executeTool not found'); process.exit(2); }
let i = src.indexOf('{', at), depth = 0, q = null;
for (; i < src.length; i++) { const ch = src[i], pr = src[i - 1];
  if (q) { if (ch === q && pr !== '\\') q = null; continue; }
  if (ch === '"' || ch === "'" || ch === '`') { q = ch; continue; }
  if (ch === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); continue; }
  if (ch === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 1; continue; }
  if (ch === '{') depth++; else if (ch === '}') { depth--; if (depth === 0) break; } }
const fnSrc = src.slice(at, i + 1);

let DOCS = {}; const AUD = [];
const db = { collection: (c) => ({
  doc: (id) => ({ set: async (d, o) => { const k = c + '/' + id; DOCS[k] = Object.assign({}, o && o.merge ? DOCS[k] : {}, d); }, get: async () => ({ exists: (c + '/' + id) in DOCS, data: () => DOCS[c + '/' + id] }) }),
  add: async (d) => { if (c === 'adminAudit') AUD.push(d); return { id: 'a' + AUD.length }; },
}) };
const admin = { firestore: { FieldValue: { serverTimestamp: () => 'TS' } } };
const ctx = vm.createContext({ db, admin, console: { log() {}, info() {}, warn() {}, error() {} } });
vm.runInContext(fnSrc + '\nthis.executeTool = executeTool;', ctx);
const run = async (input) => { try { return await ctx.executeTool('approve_seller', input); } catch (e) { return { threw: e.message }; } };

(async () => {
  console.log('\nP0-G KASS approve_seller   ' + (process.env.BASE ? 'BASE ' + process.env.BASE : 'this tree') + '\n');
  DOCS = { 'providers/p1': { status: 'pending' } };
  let r = await run({ sellerId: 'p1', approve: true, note: 'looks fine' });
  ck('K-1', DOCS['providers/p1'].status === 'pending' && r.success === false && r.code === 'APPROVAL_NOT_IN_KASS', 'THE BYPASS: approve:true never writes an approved/active state — refused, AdminOS named', [r, DOCS['providers/p1']]);
  r = await run({ sellerId: 'p1' });
  ck('K-2', DOCS['providers/p1'].status === 'pending' && r.success === false, 'an omitted approve flag is not a suspension or approval — refused, nothing written', [r, DOCS['providers/p1']]);
  DOCS = { 'providers/p2': { status: 'active' } };
  r = await run({ sellerId: 'p2', approve: false, note: 'fraud report' });
  ck('K-3', r.success === true && DOCS['providers/p2'].status === 'suspended' && AUD.some((a) => a.action === 'kass_seller_suspend' && a.targetId === 'p2'),
    'CONTROL: suspension (containment) still works, and is audited', [r, DOCS['providers/p2'], AUD]);
  r = await run({ sellerId: 'a/b', approve: false });
  ck('K-4', r.success === false && !Object.keys(DOCS).some((k) => k.includes('a/b')), 'a path-like sellerId is refused', r);
  ck('K-5', !/status:\s*input\.approve\s*\?\s*"active"/.test(fnSrc), 'no code path in executeTool can write status "active" from the tool input', null);
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
