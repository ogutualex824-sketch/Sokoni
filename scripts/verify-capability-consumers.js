#!/usr/bin/env node
/* Every declared capability must have a real consumer.
 *
 *   node scripts/verify-capability-consumers.js
 *
 * WHY THIS GUARD EXISTS
 * Two feature tables in this repository were dead on arrival:
 *
 *   subscription-catalog.js  walletEnabled / premiumAnalytics / prioritySupport /
 *                            multiBranch / staffSeats  — zero readers, ever
 *   subscription-os.js       MKT_PLANS                   — same defect, same discovery
 *
 * Both were found the same way: by asking who READS a table rather than what it looks like.
 * subscription-catalog's own header records the lesson — "the table was dead the day it was
 * written". A capability key with no reader is a promise made to a paying customer that
 * nothing in the platform keeps, and it is invisible until someone asks the right question.
 *
 * So the question is asked on every run. A key may exist only if something outside the
 * declaring module reads it, which makes "declare it" and "wire it" one change by
 * construction rather than two by good intentions.
 *
 * WHAT COUNTS AS A CONSUMER
 * A read of the key's NAME in a file other than capability-authority.js — `c.stories`,
 * `capabilities.serviceLimit`, `can(uid,'shopRequestable')`. The declared `consumer` path is
 * checked too: it must exist AND contain the key, so a rename that orphans the binding is
 * caught rather than silently passing on some other file's incidental mention.
 *
 * Assertions run on COMMENT-STRIPPED source. This file's own prose names every key it checks,
 * and so does capability-authority.js's header — a guard that counted its own documentation
 * as the consumer would pass while the platform kept nothing.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const AUTHORITY = path.join('functions', 'capability-authority.js');

let pass = 0, fail = 0;
const ck = (ok, label, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

/* Strip JS comments, tracking strings so `https://` is never read as a line comment. */
function strip(src) {
  let out = '', i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], nx = src[i + 1];
    if (c === '/' && nx === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; out += ' '; continue; }
    if (c === '/' && nx === '/') { while (i < n && src[i] !== '\n') i++; out += ' '; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += c; i++;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        out += src[i];
        if (src[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.isFile() && /\.(js|html)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

console.log('Capability consumer guard\n');

const authorityAbs = path.join(ROOT, AUTHORITY);
if (!fs.existsSync(authorityAbs)) {
  ck(false, 'capability-authority.js exists', AUTHORITY + ' not found');
  process.exit(1);
}

const { DECLARED, KEYS } = require(authorityAbs);
ck(KEYS.length > 0, 'at least one capability is declared', KEYS.length + ' keys');

/* Every file except the declaring module — its own declaration must never count as a read. */
const files = walk(path.join(ROOT, 'functions'))
  .concat(walk(path.join(ROOT, 'scripts')))
  .filter((p) => path.relative(ROOT, p) !== AUTHORITY)
  /* This guard names every key in its own prose and in its own code. Excluding it keeps the
     detector from certifying itself. */
  .filter((p) => path.resolve(p) !== path.resolve(__filename));

const sources = new Map();
for (const f of files) {
  try { sources.set(f, strip(fs.readFileSync(f, 'utf8'))); } catch (_) { /* unreadable */ }
}

console.log('\nDeclared keys');
for (const key of KEYS) {
  const spec = DECLARED[key];
  const re = new RegExp('\\b' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');

  const readers = [];
  for (const [f, src] of sources) if (re.test(src)) readers.push(path.relative(ROOT, f).replace(/\\/g, '/'));

  ck(readers.length > 0, `${key.padEnd(26)} has a consumer`,
    readers.length ? readers.slice(0, 3).join(', ') : 'NO READER — a promise nothing keeps');

  /* The declared consumer must exist and must actually contain the key: a stale `consumer`
     path is a claim about the code that the code no longer supports. */
  if (spec && spec.consumer) {
    const abs = path.join(ROOT, spec.consumer);
    const exists = fs.existsSync(abs);
    const contains = exists && re.test(strip(fs.readFileSync(abs, 'utf8')));
    ck(contains, `${key.padEnd(26)} declared consumer reads it`,
      !exists ? spec.consumer + ' does not exist' : (contains ? spec.consumer : spec.consumer + ' does not mention it'));
  }
}

/* There must be exactly ONE capability authority. A second one is how ten plan catalogues
   happened, and the whole point of naming this module distinctly from entitlement-engine. */
console.log('\nSingle authority');
const rivals = [];
for (const [f, src] of sources) {
  if (/\bfunction\s+capabilitiesFor\b|\bcapabilitiesFor\s*=\s*(async\s*)?function|\bcapabilitiesFor\s*\(.*\)\s*\{/.test(src)) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    if (!rel.startsWith('scripts/')) rivals.push(rel);
  }
}
ck(rivals.length === 0, 'no second capabilitiesFor implementation', rivals.join(', ') || 'only capability-authority.js');

console.log('\n' + '-'.repeat(70));
console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('\nA declared capability with no consumer is a promise nothing keeps.');
  console.log('Either wire a reader, or remove the key.');
}
process.exit(fail === 0 ? 0 : 1);
