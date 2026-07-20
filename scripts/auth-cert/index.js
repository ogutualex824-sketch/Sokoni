#!/usr/bin/env node
/* SOKONI — Authentication Certification Validator.
   ═══════════════════════════════════════════════

     node scripts/auth-cert/index.js                 all layers, auto-detect
     node scripts/auth-cert/index.js --layers 1      static only, no network
     node scripts/auth-cert/index.js --offline       skip live smoke tests
     node scripts/auth-cert/index.js --gate          non-zero exit unless CERTIFIED
     node scripts/auth-cert/index.js --out docs/certificates

   Layer 2 activates automatically when `gcloud auth login` has been run; until
   then its rules report SKIPPED with the reason rather than passing silently.

   EXIT CODES
     0  CERTIFIED, or INCOMPLETE without --gate
     1  FAILED — a check ran and did not hold
     2  INCOMPLETE under --gate — checks could not run, state is unknown

   Exit 2 is separate on purpose. A deploy gate must be able to distinguish
   "verified broken" from "not verified", and must block on both. */
'use strict';
const path = require('path');
const { Registry, run } = require('./engine');
const report = require('./report');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const layers = val('--layers', '1,2,3').split(',').map(Number).filter((n) => [1, 2, 3].includes(n));
const root = path.resolve(__dirname, '..', '..');

const ctx = {
  root,
  offline: has('--offline'),
  outDir: path.resolve(root, val('--out', 'docs/certificates')),
  /* Injected so rules never reach for the clock directly — keeps them
     deterministic under test. */
  now: new Date().toISOString(),
  clock: () => Date.now(),
  expectedDomains: ['mysokoni.co.ke', 'www.mysokoni.co.ke', 'sokoni-aeb26.web.app'],
};

/* The registry is the only place rules are wired. A new check is a new entry in
   a rules file plus one line here — the engine, reporters and CI gate are
   untouched. */
const registry = new Registry()
  .addAll(require('./rules/layer1-static'))
  .addAll(require('./rules/layer2-gcp'))
  .addAll(require('./rules/layer3-smoke'));

(async () => {
  console.log('\n  SOKONI Authentication Certification Validator');
  console.log('  layers: ' + layers.join(', ') + (ctx.offline ? '   (offline)' : '') + '\n');

  const sum = await run(registry, ctx, { layers });
  report.console(sum, ctx);

  if (!has('--no-artifacts')) {
    console.log('  report: ' + report.json(sum, ctx));
    console.log('  report: ' + report.html(sum, ctx) + '\n');
  }

  if (sum.verdict === 'FAILED') process.exit(1);
  if (sum.verdict === 'INCOMPLETE' && has('--gate')) process.exit(2);
  process.exit(0);
})().catch((e) => {
  console.error('\n  validator crashed: ' + e.message + '\n' + (e.stack || ''));
  process.exit(1);
});
