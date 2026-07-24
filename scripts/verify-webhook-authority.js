#!/usr/bin/env node
'use strict';

/**
 * verify-webhook-authority.js — is every payment capability reachable through ONE endpoint?
 *
 *   node scripts/verify-webhook-authority.js webhookIntasend
 *   node scripts/verify-webhook-authority.js intasendWebhook --json
 *
 * WHY THIS EXISTS (ADR-0014, 2026-07-24)
 * Two IntaSend collection webhooks are deployed. ADR-0013 names `intasendWebhook`
 * canonical; the entitlement materialisation and the FinOS wallet credit were added
 * to `webhookIntasend`. They have diverged and neither is a superset.
 *
 * The danger is not the divergence itself — it is that a live payment becomes
 * UNINTERPRETABLE while it persists. A payment could exercise the endpoint without
 * the new logic, and the result would look like the integration failing when it was
 * never invoked. That is a false negative dressed as an acceptance test.
 *
 * ACCEPTANCE CRITERION (from review):
 *   Exactly one endpoint is the production authority, and every piece of
 *   payment-side business logic is reachable through it.
 *
 * Four things must agree: documentation, deployment, dashboard, code.
 * This checks THREE. The dashboard is operator-observable only — it is reported as
 * UNKNOWN and must be confirmed by a human, never assumed.
 *
 * Exits 1 if the named endpoint is missing any capability.
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const AS_JSON = argv.includes('--json');
const TARGET = argv.find((a) => !a.startsWith('--'));

if (!TARGET) {
  console.error('usage: node scripts/verify-webhook-authority.js <endpointName> [--json]');
  process.exit(2);
}

const src = fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8');

/* Slice the named export's body: from its `exports.<name> =` to the next
   top-level `exports.` declaration. Crude, but the file is one flat module and
   the alternative — a parser — buys nothing here. */
function bodyOf(name) {
  const start = src.search(new RegExp('^exports\\.' + name + '\\s*=', 'm'));
  if (start === -1) return null;
  const rest = src.slice(start + 1);
  const nextRel = rest.search(/^exports\.[A-Za-z0-9_]+\s*=/m);
  return nextRel === -1 ? src.slice(start) : src.slice(start, start + 1 + nextRel);
}

/* The payment-side business logic that must be reachable. Each is matched on what
   the code DOES, not on a comment mentioning it. */
const CAPABILITIES = [
  { key: 'payment finalization',    re: /collection\("payments"\)|collection\('payments'\)/ },
  { key: 'commission ledger',       re: /commissionLedger/ },
  { key: 'subscription activation', re: /collection\("subscriptions"\)|collection\('subscriptions'\)/ },
  { key: 'entitlement materialisation', re: /materialiseEntitlements/ },
  { key: 'wallet credit (FinOS)',   re: /creditWalletTxn/ },
  { key: 'audit logging',           re: /subscriptionAuditLog|entitlementAuditLog|commissionReviewQueue/ },
];

/* Every deployed onRequest that could plausibly be an IntaSend collection webhook,
   so the report shows the alternative rather than only judging the named one. */
const CANDIDATES = (src.match(/^exports\.([A-Za-z0-9_]+)\s*=\s*onRequest/gm) || [])
  .map((m) => m.replace(/^exports\.|\s*=\s*onRequest/g, ''))
  .filter((n) => /intasend/i.test(n));

const report = CANDIDATES.map((name) => {
  const body = bodyOf(name);
  if (!body) return { endpoint: name, found: false };
  const caps = CAPABILITIES.map((c) => ({ capability: c.key, present: c.re.test(body) }));
  return {
    endpoint: name,
    found: true,
    isTarget: name === TARGET,
    missing: caps.filter((c) => !c.present).map((c) => c.capability),
    caps,
  };
});

const target = report.find((r) => r.endpoint === TARGET);

if (AS_JSON) {
  console.log(JSON.stringify({ target: TARGET, report }, null, 2));
} else {
  console.log(`\nWebhook authority — candidate: ${TARGET}\n`);
  console.log('  ' + 'CAPABILITY'.padEnd(30) + CANDIDATES.map((c) => c.slice(0, 17).padEnd(19)).join(''));
  for (const cap of CAPABILITIES) {
    const cells = report.map((r) => {
      if (!r.found) return '—'.padEnd(19);
      return (r.caps.find((c) => c.capability === cap.key).present ? 'yes' : 'NO').padEnd(19);
    });
    console.log('  ' + cap.key.padEnd(30) + cells.join(''));
  }
  console.log('');

  if (!target || !target.found) {
    console.log(`  ${TARGET} is not an IntaSend onRequest export in functions/index.js\n`);
  } else if (target.missing.length) {
    console.log(`  FAIL — ${TARGET} cannot reach:`);
    target.missing.forEach((m) => console.log('    · ' + m));
    console.log('\n  A payment routed here would silently skip the above. Do not treat a live');
    console.log('  payment as acceptance evidence until this endpoint carries every capability.\n');
  } else {
    console.log(`  PASS — ${TARGET} reaches every payment-side capability.\n`);
    const others = report.filter((r) => r.endpoint !== TARGET && r.found);
    if (others.length) {
      console.log('  Still unresolved: a second endpoint remains deployed. Delete it or reduce');
      console.log('  it to a thin delegate — two live handlers WILL diverge again (ADR-0014).\n');
    }
  }

  console.log('  UNKNOWN (not checkable here): the IntaSend dashboard registration.');
  console.log('  Confirm by hand that it points at ' + TARGET + '. Code agreeing with itself');
  console.log('  is not the same as code agreeing with the dashboard.\n');
}

process.exit(target && target.found && !target.missing.length ? 0 : 1);
