#!/usr/bin/env node
'use strict';
/**
 * COMMISSION PATH AUDIT (Phase 6) — every place the platform computes a platform take.
 *
 * Classifies each into:
 *   USES ENGINE  — calls calculateCommission(db, …). The only acceptable answer.
 *   INDEPENDENT  — computes a platform commission itself. A defect.
 *   NOT COMMISSION — a rate that is deliberately NOT platform commission (tax, plan pricing,
 *                    staff sales commission, rider revenue share). Listed with its reason so
 *                    the distinction is reviewable rather than assumed.
 *
 * This is a REPORT, not a gate. scripts/verify-commission-single-source.js is the gate.
 * Run: node scripts/audit-commission-paths.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

/* Deliberately not platform commission. Each needs a REASON, not just an exemption. */
const NOT_COMMISSION = {
  'functions/subscription-core.js':   'plan catalogue + the seam the engine READS in compatibility mode',
  'functions/provider-onboarding.js': 'provider PLAN pricing (what a plan costs, and its rate)',
  'functions/sub-billing.js':         'subscription plan catalogue',
  'functions/sasos-core.js':          'SaaS plan tiers',
  'functions/sasos-billing.js':       'SaaS plan billing',
  'functions/hr-payroll.js':          'Kenya PAYE/NHIF/NSSF statutory bands',
  'functions/pos-staff-ops.js':       'STAFF sales commission — what a cashier EARNS, not a platform take',
  'functions/finos-utils.js':         'THE ENGINE (+ TAX_CONFIG: VAT/WHT are taxes ON commission)',
  'functions/shared/constants.js':    'VAT/WHT/DST tax constants',
  'functions/commission-config.js':   'THE single rate table',
  'functions/settlement-engine.js':   'consumes the engine; rider revenue share (0.88) is a payout split',
  'functions/finos-router.js':        'consumes the engine; rider revenue share',
  'functions/finos.js':               'consumes the engine',
  'functions/impact.js':              '1% impact contribution — a donation, not commission',
  'functions/business-health-score.js': 'an assumed cost input to a SCORE, moves no money',
  'functions/inventory-health.js':    'score weightings',
  'functions/inventory-v2.js':        'score weightings',
  'functions/marketplace-quality.js': 'price percentiles',
};

const files = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter(f => f.startsWith('functions/') && f.endsWith('.js'))
  /* git may still list a file that has been deleted from the working tree */
  .filter(f => fs.existsSync(path.join(ROOT, f)));

const strip = s => s
  .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));

/* A platform take being COMPUTED (not merely read back for a report). */
const COMPUTE = [
  /\bcommission\w*\s*=\s*[^=][^;\n]*[*]/i,
  /\bplatformFee\w*\s*=\s*[^=][^;\n]*[*]/i,
  /\*\s*0\.(?:0[1-9]|[12]\d)\b[^\n]{0,40}(?:commission|platform\s*fee)/i,
  /(?:commission|platformFee)[^\n]{0,40}\*\s*0\.(?:0[1-9]|[12]\d)\b/i,
];

const usesEngine = [], independent = [], exempt = [], annotated = [];

/* An `@commission-safe: <reason>` annotation on the preceding lines is an EXPLICIT, justified,
   VISIBLE exception — the same device docs/FINANCIAL_TRANSACTION_STANDARD.md uses for guards a
   static tool cannot infer. It is listed in the report, never hidden. */
function annotation(rawLines, i) {
  for (let k = Math.max(0, i - 12); k <= i; k++) {
    const m = (rawLines[k] || '').match(/@commission-safe:\s*(.+)/);
    if (m) return m[1].trim().replace(/\*\/\s*$/, '').trim();
  }
  return null;
}

for (const f of files) {
  const raw = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const rawLines = raw.split('\n');
  const src = strip(raw);
  const engine = /calculateCommission\s*\(\s*\w/.test(src);

  if (engine) usesEngine.push(f);

  if (NOT_COMMISSION[f]) { exempt.push([f, NOT_COMMISSION[f]]); continue; }

  src.split('\n').forEach((l, i) => {
    if (/calculateCommission|resolveRate|COMMISSION_CONFIG/.test(l)) return;
    if (/\bvat|\bwht|\bdst|\btax/i.test(l)) return;
    if (COMPUTE.some(re => re.test(l))) {
      const why = annotation(rawLines, i);
      if (why) annotated.push({ f, line: i + 1, why });
      else independent.push({ f, line: i + 1, code: l.trim().slice(0, 62) });
    }
  });
}

console.log('COMMISSION PATH AUDIT\n');
console.log('  USES THE ENGINE  (' + usesEngine.length + ')');
usesEngine.forEach(f => console.log('    OK   ' + f));

console.log('\n  NOT PLATFORM COMMISSION  (' + exempt.length + ') — each with its reason');
exempt.forEach(([f, why]) => console.log('    --   ' + f.padEnd(36) + why));

console.log('\n  ANNOTATED EXCEPTION  (' + annotated.length + ') — explicit, justified, visible');
annotated.forEach(a => console.log('    ANN  ' + a.f + ':' + a.line + '  ' + a.why));

console.log('\n  INDEPENDENT CALCULATION  (' + independent.length + ')');
if (!independent.length) {
  console.log('    none — every platform commission is computed by the engine.');
} else {
  independent.forEach(d => console.log('    WARN ' + d.f + ':' + d.line + '  ' + d.code));
}

console.log('\n  ' + (independent.length
  ? independent.length + ' independent calculation(s) remain.'
  : 'EXACTLY ONE AUTHORITATIVE COMMISSION ENGINE.'));
process.exit(independent.length ? 1 : 0);
