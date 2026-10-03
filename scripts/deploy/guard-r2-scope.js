#!/usr/bin/env node
'use strict';
/* R2 SCOPE GUARD — predeploy hook for release/marketing-functions-r2 (owner 2026-10-03, via sokoni-b2).
   A document is not a control: this ABORTS the deploy unless it was launched through scripts/deploy/r2-deploy.js with an
   explicit, allowed function list. A predeploy hook cannot see firebase's --only flags, so the wrapper passes the scope in
   SOKONI_R2_SCOPE (comma list) and this hook refuses:
     · no scope at all            → a bare / unscoped `firebase deploy` (would deploy every function from this tree)
     · any forbidden function     → every IntaSend webhook handler (5b ships them from their own tree), intasendWebhook
                                    (own P0-4 gate), processTypesenseQueue and bookingDispatch (own trees)
     · any function NOT on the explicit ALLOW list (b2 2026-10-04: deny-lists miss live-only behaviour — until the step-D
       lineage gate has run on a function, it is not deployable from r2; adding one is a reviewed commit here + manifest)
   Accept a deploy only when "R2 SCOPE GUARD: PASS" appears IN the deploy log. */
const FORBIDDEN_EXACT = new Set(['webhookIntasend', 'intasendWebhook', 'processTypesenseQueue', 'bookingDispatch',
  /* r2's application-lifecycle.js LACKS K13-A, which production applicationDecide carries — deploying these from r2 would
     reopen admin self-approval / status-only approval (b2 + 5b, 2026-10-04). Until stage (c) lands. */
  'applicationDecide', 'applicationReconcile', 'applicationLifecycle',
  /* Sports: held by the owner — never from r2 without an explicit owner approval. */
  'sportsDispatch', 'sportsFixtureReminders',
  /* Users security unit (owner 2026-10-04): r2's super-admin.js has NO Authority Core (setUserRole would DESTROY non-role
     claims) and r2 has none of the account-lock contract. These ship ONLY from hosting/adminos-receipts-on-72dca56 under
     its reconciliation guard. */
  'setUserRole', 'suspendUser', 'tsBanUser', 'tsReviewReport', 'adminOsDispatch', 'expireSuspensions', 'adminUpdateUserRole']);
/* EXPLICIT ALLOW-LIST — the manifest's candidate scope. A function absent here is out of scope (not retired). */
const ALLOW = new Set(['providerDispatch', 'createPaymentIntent', 'myTransactionReceipts', 'providerLedger',
  'requestSellerPayout', 'processPayoutRetries', 'processPendingPayouts', 'autoScheduledPayouts', 'initiateSellerPayout']);
const FORBIDDEN_RE = /webhook|intasend/i;

function check(scope) {
  const raw = String(scope == null ? '' : scope).trim();
  if (!raw) return { ok: false, reason: 'UNSCOPED: no SOKONI_R2_SCOPE — deploy only via node scripts/deploy/r2-deploy.js <fn,...>' };
  const names = raw.split(',').map((s) => s.trim().replace(/^functions:/, '')).filter(Boolean);
  if (!names.length) return { ok: false, reason: 'UNSCOPED: empty function list' };
  const bad = names.filter((n) => FORBIDDEN_EXACT.has(n) || FORBIDDEN_RE.test(n) || !/^[A-Za-z0-9_-]+$/.test(n));
  if (bad.length) return { ok: false, reason: 'FORBIDDEN in r2: ' + bad.join(', ') };
  const unlisted = names.filter((n) => !ALLOW.has(n));
  if (unlisted.length) return { ok: false, reason: 'NOT ON THE r2 ALLOW-LIST: ' + unlisted.join(', ') + ' — add it only after its step-D live comparison (guard + manifest commit)' };
  return { ok: true, names };
}

if (require.main === module) {
  const r = check(process.env.SOKONI_R2_SCOPE);
  if (!r.ok) { console.error('R2 SCOPE GUARD: ABORT — ' + r.reason); process.exit(1); }
  console.log('R2 SCOPE GUARD: PASS — ' + r.names.join(', '));
}
module.exports = { check, FORBIDDEN_EXACT, FORBIDDEN_RE, ALLOW };
