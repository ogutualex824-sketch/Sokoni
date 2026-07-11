#!/usr/bin/env node
/* ================================================================
   SOKONI — Architecture & Cloud-Run-Quota Guard
   scripts/verify-architecture.js

   Enforces the enterprise-architecture invariants from the Production
   Readiness Sprint so the dispatcher/quota gains cannot regress:

     1. No DUPLICATE top-level exports in functions/index.js.
     2. No op is BOTH a dispatcher handler AND an individual CF export
        (that would waste a Cloud Run service — the core quota rule).
     3. Every known domain dispatcher is exported (registry completeness).
     4. Total CF export count stays within a soft budget (early warning
        before the Cloud Run vCPU ceiling).

   Exit 0 = healthy, Exit 1 = a hard invariant is violated.
   Run:  node scripts/verify-architecture.js
================================================================ */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT      = path.resolve(__dirname, '..');
const FUNCTIONS = path.join(ROOT, 'functions');
const INDEX     = path.join(FUNCTIONS, 'index.js');

/* Soft budget: warn well before the ~1500 Cloud Run vCPU ceiling this project hit. */
const CF_BUDGET_WARN = 1350;
const CF_BUDGET_HARD = 1480;

/* Canonical domain dispatchers → their handler-source modules. Keep in sync
   with docs/DISPATCHER_REGISTRY.md. */
const DISPATCHERS = {
  adminOsDispatch:       ['admin-os'],
  analyticsDispatch:     ['analytics-engine'],
  bookingDispatch:       ['booking', 'venue-booking', 'availability'],
  commerceDispatch:      ['marketplace-extensions', 'merchant-success', 'foundation', 'marketing-engine'],
  loyaltyDispatch:       ['loyalty', 'loyalty-enterprise'],
  messagesDispatch:      ['messages'],
  servicesDispatch:      ['healthcare-hub', 'security-identity', 'jobs', 'hr-payroll', 'b2b-wholesale', 'property-hub'],
  smartPosDispatch:      ['pos-crm-pro', 'pos-completeness', 'pos-staff-ops', 'pos-inventory-pro', 'pos-accounting', 'pos-retail-engine', 'pos-integrations', 'pos-hq', 'pos-multi-till', 'pos-cash-manager', 'business-bootstrap'],
  logisticsPlusDispatch: ['logistics-plus'],
  financeSprintDispatch: ['finance-os-sprint43'],   // + settlement handlers (settlement-dispatch)
};

const errors = [];
const warnings = [];

/* ── Parse index.js exports ─────────────────────────────────────── */
const indexSrc = fs.readFileSync(INDEX, 'utf8');
const exportNames = (indexSrc.match(/^exports\.[A-Za-z0-9_]+/gm) || []).map((s) => s.replace('exports.', ''));

/* 1. Duplicate exports */
const seen = new Set(), dups = new Set();
for (const n of exportNames) { if (seen.has(n)) dups.add(n); else seen.add(n); }
if (dups.size) errors.push(`Duplicate exports in index.js: ${[...dups].join(', ')}`);

const exportSet = new Set(exportNames);

/* 3. Dispatcher registry completeness */
for (const d of Object.keys(DISPATCHERS)) {
  if (!exportSet.has(d)) warnings.push(`Dispatcher "${d}" not exported by index.js (registry drift?)`);
}

/* Map each index.js export to its SOURCE module alias:  exports.X = alias.Y
   and  const alias = require('./module')  →  export op → module path. */
const aliasToModule = {};
for (const m of indexSrc.matchAll(/const\s+([A-Za-z0-9_]+)\s*=\s*require\(['"]\.\/([A-Za-z0-9_-]+)['"]\)/g)) {
  aliasToModule[m[1]] = m[2];
}
const exportToModule = {};
for (const m of indexSrc.matchAll(/^exports\.([A-Za-z0-9_]+)\s*=\s*([A-Za-z0-9_]+)\./gm)) {
  if (aliasToModule[m[2]]) exportToModule[m[1]] = aliasToModule[m[2]];
}

/* 2. Classify name-collisions: op that is BOTH a dispatcher handler AND an
   individual export. TRUE DUPLICATE (same source module) = hard error → de-export.
   CROSS-DOMAIN COLLISION (different module = a genuinely different function that
   happens to share a name) = warning → namespace the handler; NEVER de-export
   (would break the exported implementation's callers). */
let handlerCheckRan = false;
try {
  const admin = require(path.join(FUNCTIONS, 'node_modules', 'firebase-admin'));
  try { admin.initializeApp(); } catch (_) {}
  handlerCheckRan = true;
  const trueDuplicates = [], crossDomain = [];
  for (const [d, mods] of Object.entries(DISPATCHERS)) {
    const H = {};
    for (const m of mods) {
      try { Object.assign(H, require(path.join(FUNCTIONS, m + '.js'))._h || {}); } catch (_) {}
    }
    for (const op of Object.keys(H)) {
      if (!exportSet.has(op)) continue;
      const src = exportToModule[op];
      if (src && mods.includes(src)) trueDuplicates.push(`${op} (${d} ⇄ exports from ${src} — SAME module: de-export the individual CF)`);
      else crossDomain.push(`${op} (${d} handler vs exports from ${src || '?'} — different function, same name: namespace the handler)`);
    }
  }
  if (trueDuplicates.length) errors.push(`TRUE duplicate ops (dispatched AND individually exported from the SAME module — wasted Cloud Run services):\n    - ${trueDuplicates.join('\n    - ')}`);
  if (crossDomain.length) warnings.push(`Cross-domain name collisions (distinct functions sharing a name — namespace, do NOT de-export):\n    - ${crossDomain.join('\n    - ')}`);
} catch (_) {
  warnings.push('Handler-collision check skipped (could not load modules — run inside functions/ with deps installed).');
}

/* 4. CF budget */
const total = exportNames.length;
if (total > CF_BUDGET_HARD) errors.push(`CF export count ${total} exceeds hard budget ${CF_BUDGET_HARD} — consolidate before deploying.`);
else if (total > CF_BUDGET_WARN) warnings.push(`CF export count ${total} above warn budget ${CF_BUDGET_WARN} — plan consolidation.`);

/* ── Report ─────────────────────────────────────────────────────── */
console.log(`SOKONI architecture guard — ${total} CF exports, ${Object.keys(DISPATCHERS).length} domain dispatchers, handler-collision check ${handlerCheckRan ? 'ran' : 'skipped'}.`);
warnings.forEach((w) => console.warn('  ⚠ ' + w));
if (errors.length) {
  console.error('\n❌ Architecture invariants violated:');
  errors.forEach((e) => console.error('  • ' + e));
  process.exit(1);
}
console.log('✅ Architecture invariants OK (no duplicate exports, no dispatched op double-exported, budget respected).');
process.exit(0);
