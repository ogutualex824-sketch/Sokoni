#!/usr/bin/env node
/* ============================================================================
   scripts/deploy/guard-secrets-present.js
   ============================================================================
   Predeploy gate. Refuses a functions deploy when a secret the code BINDS does
   not exist in Secret Manager.

   WHY THIS EXISTS
   ----------------
   `defineSecret()` binds at DEPLOY time, not at call time. A function that
   declares a secret which has not been created takes the WHOLE deploy down —
   every function in the bundle, not just the one that declared it. The failure
   arrives late, from Firebase's own error, and names the symptom rather than
   the cause.

   This asks the question early and names the cause: which secret, bound by
   which file, and the command that creates it.

   WHAT IT DOES NOT DO
   --------------------
   It never reads a secret VALUE. `secrets list` returns names and metadata;
   `versions.access` returns payloads and is never called here. A gate that had
   to read every production secret in order to check them would have the blast
   radius of the whole estate.

   UNREADABLE IS NOT ABSENT
   -------------------------
   If the inventory cannot be read — no gcloud, no credentials, no network —
   this WARNS LOUDLY and ALLOWS. Blocking every deploy on the absence of a
   local tool would be a new class of breakage, and reporting an unreadable
   inventory as "the secret is missing" is the RC-1 defect this platform has
   already paid for once. What it must never do is pass silently.
   ============================================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const FUNCTIONS = path.join(ROOT, 'functions');
const PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-aeb26';

/* ── WHICH SECRETS DOES THE CODE BIND? ────────────────────────────────────
   Literal-only, on purpose. defineSecret(SOME_VARIABLE) cannot be resolved by
   reading the source, and guessing at it would produce a gate that is
   confidently wrong. Instead, a variable form is REPORTED as unresolvable so
   it gets fixed rather than silently skipped. */
const BIND = /defineSecret\(\s*(['"])([A-Z0-9_]+)\1\s*\)/g;
const BIND_DYNAMIC = /defineSecret\(\s*(?!['"])[^)]+\)/;

const bound = new Map();          /* NAME -> Set(files) */
const dynamic = [];
for (const f of fs.readdirSync(FUNCTIONS)) {
  if (!f.endsWith('.js')) continue;
  let src;
  try { src = fs.readFileSync(path.join(FUNCTIONS, f), 'utf8'); } catch (_) { continue; }
  const bare = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  let m; BIND.lastIndex = 0;
  while ((m = BIND.exec(bare))) {
    if (!bound.has(m[2])) bound.set(m[2], new Set());
    bound.get(m[2]).add(f);
  }
  if (BIND_DYNAMIC.test(bare)) dynamic.push(f);
}

if (!bound.size) {
  console.error('\n  [guard-secrets-present] Found NO defineSecret() calls at all.');
  console.error('  That is almost certainly a broken scan rather than a codebase');
  console.error('  with no secrets. Refusing to report a clean result.\n');
  process.exit(1);
}

/* ── WHICH EXIST? ─────────────────────────────────────────────────────────── */
function listSecretNames () {
  const env = Object.assign({}, process.env);
  if (!env.CLOUDSDK_PYTHON) {
    const bundled = path.join(process.env.LOCALAPPDATA || '',
      'Google/Cloud SDK/google-cloud-sdk/platform/bundledpython/python.exe');
    if (fs.existsSync(bundled)) env.CLOUDSDK_PYTHON = bundled;
  }
  const args = ['secrets', 'list', '--project', PROJECT, '--format=value(name)'];
  const out = process.platform === 'win32'
    /* Node refuses to spawn a .cmd shim directly on Windows; a shell is needed,
       so every argument is quoted rather than trusted. */
    ? execSync('gcloud.cmd ' + args.map((a) => '"' + a + '"').join(' '),
        { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] })
    : execFileSync('gcloud', args, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

let present = null, why = '';
try { present = new Set(listSecretNames()); }
catch (e) { why = String((e && e.message) || 'gcloud failed').split('\n')[0].slice(0, 120); }

if (present === null) {
  console.warn('\n  [guard-secrets-present] ⚠  COULD NOT READ Secret Manager — ' + why);
  console.warn('  ' + bound.size + ' bound secret(s) were NOT verified. This is not a');
  console.warn('  pass: if one is missing, this deploy will fail late and take every');
  console.warn('  other function with it. Allowing, because an unreadable inventory is');
  console.warn('  not evidence of absence — but you are deploying unchecked.\n');
  process.exit(0);
}

/* A positive control: an inventory that returns nothing, or that somehow misses
   a secret this estate certainly has, is a broken query rather than an empty
   project — and must not be reported as "everything is missing". */
if (!present.size) {
  console.error('\n  [guard-secrets-present] Secret Manager returned ZERO secrets for ' +
    PROJECT + '.');
  console.error('  Treating that as a broken query, not as an empty project. Refusing.\n');
  process.exit(1);
}

const missing = [...bound.keys()].filter((n) => !present.has(n)).sort();

if (dynamic.length) {
  console.warn('  [guard-secrets-present] note: defineSecret(<variable>) in ' +
    dynamic.join(', ') + ' — not resolvable by reading source, so NOT checked.');
}

if (missing.length) {
  console.error('\n  [guard-secrets-present] DEPLOY BLOCKED — ' + missing.length +
    ' bound secret(s) do not exist in ' + PROJECT + ':\n');
  missing.forEach((n) => {
    console.error('    ' + n + '   bound by ' + [...bound.get(n)].join(', '));
    console.error('      gcloud secrets create ' + n + ' --data-file=- --project ' + PROJECT);
  });
  console.error('\n  defineSecret binds at deploy time, so this would fail the ENTIRE');
  console.error('  functions deploy, not only the function that declared it.\n');
  process.exit(1);
}

console.log('  [guard-secrets-present] ok — all ' + bound.size +
  ' bound secrets exist in ' + PROJECT + '.');
process.exit(0);
