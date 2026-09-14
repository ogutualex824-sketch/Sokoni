#!/usr/bin/env node
/* ============================================================================
   RC MANIFEST — what belongs in the Merchant Launch RC, and what must not
   ============================================================================
   The working tree holds 234 uncommitted paths from SEVERAL agents. Hosting
   publishes the working tree, so "deploy" without this classification ships all
   of it — including other people's half-finished work.

   This enumerates the launch changes EXPLICITLY rather than inferring them.
   Inference by timestamp would sweep in anything else edited today; inference by
   "looks related" would sweep in anything with a similar name. The manifest is a
   list someone can read and disagree with, which is the point.

   Everything NOT on the list is left exactly where it is. Cleanliness is not a
   reason to touch another agent's work.

   Usage:
     node scripts/rc-manifest.js            classify and report
     node scripts/rc-manifest.js --json     machine-readable
   ========================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const JSON_OUT = process.argv.includes('--json');

/* ── THE LAUNCH CHANGES ────────────────────────────────────────────────────
   Every path this session changed in service of the merchant journey, grouped by
   what it does. A path is here because someone decided it belongs, not because a
   heuristic matched it. */
const LAUNCH = {
  'identity + provisioning': [
    'functions/merchant-identity.js',        /* recovered; see the note in REPORT */
    'functions/application-lifecycle.js',    /* declared-type routing, businesses, wallet */
  ],
  'merchant intake + legal acceptance': [
    'sokoni-merchant-application.js',
    'onboarding-seller.html',
    'hub-register.js',
    'seller.js',
    'seller.html',
    'seller-terms.html',
    'legal.html',
  ],
  'entry routing': [
    'sokoni-merchant-entry.js',
  ],
  'free beta allowance': [
    'functions/subscription-catalog.js',
  ],
  'commission model': [
    'functions/commission-config.js',
    'functions/finos-utils.js',
    'sokoni-commission-rates.js',
    'scripts/build-commission-snapshot.js',
  ],
  'POS/Till commission rail': [
    'functions/pos-commission-rail.js',
    'functions/business-wallet.js',
    'functions/pos-commission-surface.js',
    'functions/pos-zero-friction.js',
    'functions/pos-retail-engine.js',
  ],
  'settlement + delivery proof': [
    'functions/order-settlement.js',
    'functions/sokoni-logistics.js',
    'sokoni-logistics.js',
    'track.html',
  ],
  'AdminOS surfaces': [
    'admin-os.html',
    'sokoni-aos.js',
    'functions/admin-os.js',
  ],
  'notifications': [
    'functions/notify.js',
  ],
  'security rules': [
    'firestore.rules',
    'firestore.rules.build',
  ],
  'function exports': [
    'functions/index.js',
  ],
  'tests': [
    'scripts/test-pos-commission-rail.js',
    'scripts/test-business-wallet.js',
    'scripts/test-marketplace-plan-ladder.js',
    'scripts/test-settlement-proof-gate.js',
    'scripts/test-post-pin-money-chain.js',
    'scripts/test-delivery-visibility.js',
    'scripts/test-refund-approval-gate.js',
    'scripts/test-pos-gate-enforcement.js',
    'scripts/test-pos-gate-behavioural.js',
    'scripts/test-admin-os-wiring.js',
    'scripts/test-admin-os-render.js',
    'scripts/test-merchant-application.js',
    'scripts/test-application-decision-authority.js',
    'scripts/test-commission-5pct-agreement.js',
    'scripts/test-pos-commission-lane.js',
    'scripts/test-pos-sale-commission.js',
    'scripts/merchant-launch-gate.js',
    'scripts/rc-manifest.js',
  ],
  'documentation': [
    'CHANGELOG.md',
    'docs/MERCHANT_ONBOARDING_CHAIN.md',
    'docs/POS_COMMISSION_RAIL.md',
  ],
};

/* NEVER in the RC, whatever their state. version.json is stamped by the deploy
   pipeline; carrying a hand-edited one is how a tree claims a commit it is not. */
const EXCLUDE = new Set(['version.json']);

const flat = new Map();
for (const [group, files] of Object.entries(LAUNCH)) for (const f of files) flat.set(f, group);

/* ── the actual working tree ───────────────────────────────────────────────── */
const status = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter(Boolean)
  .map((l) => ({ code: l.slice(0, 2).trim(), file: l.slice(3).replace(/^"|"$/g, '') }));

/* ── classify what is NOT a launch change ──────────────────────────────────── */
function classifyOther(f) {
  const base = path.basename(f);
  if (/^census-/.test(base)) return 'standing census (leave untouched — explicitly protected)';
  if (/^(diagnose|probe|measure|bisect|prescan|survey|audit)-/.test(base)) return 'diagnostic / investigation script';
  if (f.startsWith('docs/')) return 'documentation by another workstream';
  if (f.startsWith('scripts/')) return 'another agent\'s script';
  if (f.startsWith('functions/')) return 'another agent\'s function work';
  if (f.startsWith('tests/')) return 'another agent\'s test work';
  if (/\.(html|js|css)$/.test(f)) return 'another agent\'s surface work';
  return 'unclassified';
}

const inRc = [], notInRc = [], missing = [];
for (const s of status) {
  if (EXCLUDE.has(s.file)) { notInRc.push({ ...s, why: 'excluded: pipeline artifact' }); continue; }
  if (flat.has(s.file)) inRc.push({ ...s, group: flat.get(s.file) });
  else notInRc.push({ ...s, why: classifyOther(s.file) });
}
/* A manifest entry with no working-tree change is a lie about what the RC contains. */
for (const f of flat.keys()) {
  if (!status.some((s) => s.file === f)) missing.push(f);
}

if (JSON_OUT) {
  console.log(JSON.stringify({ inRc, notInRc, missing }, null, 2));
  process.exit(missing.length ? 1 : 0);
}

console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
console.log('║  RC MANIFEST — Merchant Launch                                       ║');
console.log('╚══════════════════════════════════════════════════════════════════════╝');

console.log('\nIN THE RC (' + inRc.length + ' paths)');
let g = null;
for (const r of inRc.sort((a, b) => (a.group + a.file).localeCompare(b.group + b.file))) {
  if (r.group !== g) { g = r.group; console.log('\n  ' + g); }
  console.log('    ' + (r.code === '??' ? 'new ' : 'mod ') + r.file);
}

if (missing.length) {
  console.log('\n  ⚠ ON THE MANIFEST BUT UNCHANGED IN THE TREE (' + missing.length + ')');
  console.log('    A manifest naming a path it does not carry misstates the RC.');
  for (const m of missing) console.log('      ' + m);
}

const byWhy = new Map();
for (const r of notInRc) { if (!byWhy.has(r.why)) byWhy.set(r.why, []); byWhy.get(r.why).push(r.file); }
console.log('\nNOT IN THE RC (' + notInRc.length + ' paths) — left exactly as they are');
for (const [why, files] of [...byWhy.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log('\n  ' + why + '  (' + files.length + ')');
  for (const f of files.slice(0, 6)) console.log('    ' + f);
  if (files.length > 6) console.log('    … and ' + (files.length - 6) + ' more');
}

console.log('\n──────────────────────────────────────────────────────────────────────');
console.log('  RC: ' + inRc.length + '   leave alone: ' + notInRc.length + '   total: ' + status.length);
console.log('  Nothing outside the RC list is reset, deleted or committed.');
console.log('');
process.exit(missing.length ? 1 : 0);
