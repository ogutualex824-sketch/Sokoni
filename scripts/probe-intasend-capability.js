#!/usr/bin/env node
/* PROBE: which payment methods does the SOKONI IntaSend account ACTUALLY have?
   ───────────────────────────────────────────────────────────────────────────

   WHY THIS EXISTS

   SOKONI currently presents ten payment tiles at checkout and can take money
   through exactly one of them. The fix is not a better hard-coded list — it is
   to stop asserting capability the platform cannot see. IntaSend's enabled
   methods are an ACCOUNT setting, not a documentation fact, and the public docs
   and the public site have disagreed about card availability.

   So: ask the account.

   ── THIS SCRIPT IS NOT READ-ONLY, AND SAYS SO ─────────────────────────────

   IntaSend exposes no "list my enabled methods" endpoint. The only way to learn
   whether a method is enabled is to ASK FOR A CHECKOUT SESSION with it and see
   whether the account accepts. Each accepted probe CREATES AN INVOICE on the
   account. Nothing is charged — no customer ever opens the link — but the
   invoices are real and will appear in the IntaSend dashboard.

   Therefore:
     • it runs against SANDBOX unless --live is passed;
     • --live additionally requires --i-understand-this-creates-invoices;
     • it never runs itself, from a hook, a suite or a deploy step;
     • it writes nothing to Firestore. The operator reads the table and
       records the result deliberately.

   A probe that quietly created production invoices on import would be a worse
   defect than the one it exists to close.

   ── WHAT "UNKNOWN" MEANS ──────────────────────────────────────────────────

   Three outcomes per method, and the third is not a failure of the probe:

     ENABLED    the account accepted a session for this method
     REFUSED    the account answered, and said no
     UNKNOWN    no answer, a 5xx, or a malformed body

   UNKNOWN must never be rendered to a customer as "unavailable" — it means the
   probe could not tell. Only ENABLED may light a tile.

   USAGE
     node scripts/probe-intasend-capability.js                      # sandbox
     node scripts/probe-intasend-capability.js --live --i-understand-this-creates-invoices

   KEYS  (never hard-code, never commit)
     INTASEND_PUBLIC_KEY   required — checkout is the public-key flow
     INTASEND_AMOUNT_KES   optional, default 1
*/
'use strict';

const https = require('https');
const path  = require('path');
const C     = require(path.join(__dirname, '..', 'functions', 'shared', 'intasend-checkout'));

const argv    = process.argv.slice(2);
const LIVE    = argv.includes('--live');
const CONSENT = argv.includes('--i-understand-this-creates-invoices');
const SANDBOX = !LIVE;

const PUB    = process.env.INTASEND_PUBLIC_KEY || '';
const AMOUNT = Math.max(1, Number(process.env.INTASEND_AMOUNT_KES) || 1);

function die(msg) { console.error('\n  ' + msg + '\n'); process.exit(2); }

if (!PUB) {
  die('INTASEND_PUBLIC_KEY is not set. Checkout is the public-key flow.\n' +
      '  Set it in the environment; do NOT pass it on the command line (it lands in shell history).');
}
if (LIVE && !CONSENT) {
  die('--live creates REAL invoices on the production IntaSend account.\n' +
      '  Re-run with --i-understand-this-creates-invoices if that is what you want.');
}
if (LIVE && !/_live_/.test(PUB)) {
  die('--live was passed but INTASEND_PUBLIC_KEY does not look like a live key.\n' +
      '  Refusing rather than probing the wrong account.');
}
if (!LIVE && /_live_/.test(PUB)) {
  die('A LIVE key was supplied without --live. Refusing: this would create production\n' +
      '  invoices while reporting itself as a sandbox run.');
}

/* A ref that is unmistakable in the dashboard. Nobody should have to guess
   later what these invoices were. */
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const refFor = (m) => `PROBE_${stamp}_${m.replace(/[^A-Z0-9]/gi, '')}`.slice(0, 64);

async function probe(method) {
  let payload;
  try {
    payload = C.buildPayload({
      amountKES: AMOUNT,
      apiRef:    refFor(method),
      publicKey: PUB,
      currency:  'KES',
      narrative: 'SOKONI capability probe',
      method,
    });
  } catch (e) {
    return { method, verdict: 'REFUSED', detail: 'rejected before the wire: ' + e.message };
  }

  let res;
  try {
    res = await C.createCheckout({ payload, publicKey: PUB, sandbox: SANDBOX, https });
  } catch (e) {
    /* A non-answer. NOT a refusal — the session may even exist. */
    return { method, verdict: 'UNKNOWN', detail: 'no answer: ' + (e.message || e) };
  }

  const outcome = C.classifyOutcome(res.status);
  if (outcome === 'GATEWAY_ACCEPTED') {
    return {
      method, verdict: 'ENABLED',
      detail: 'invoice ' + (C.invoiceIdOf(res.data) || '?') +
              (C.checkoutUrlOf(res.data) ? ' · url issued' : ' · NO url in response'),
      methodsSaid: C.methodsOf(res.data),
    };
  }
  if (outcome === 'GATEWAY_REJECTED') {
    let why = '';
    try { why = JSON.stringify(res.data).slice(0, 160); } catch (_) { why = '(unparseable)'; }
    return { method, verdict: 'REFUSED', detail: 'HTTP ' + res.status + ' ' + why };
  }
  return { method, verdict: 'UNKNOWN', detail: 'HTTP ' + res.status + ' — not an answer' };
}

(async () => {
  console.log('\n  IntaSend capability probe');
  console.log('  account : ' + PUB.slice(0, 18) + '…');
  console.log('  target  : ' + C.hostFor(SANDBOX) + (LIVE ? '   *** LIVE — CREATES INVOICES ***' : '   (sandbox)'));
  console.log('  amount  : KES ' + AMOUNT + ' per probe');
  console.log('  ref     : PROBE_' + stamp + '_*\n');

  const results = [];
  for (const m of C.CANDIDATE_METHODS) {
    process.stdout.write('  ' + m.padEnd(16));
    /* Serial, deliberately. A burst of checkout creations against a live
       account is indistinguishable from abuse, and the probe has no deadline. */
    const r = await probe(m);            // eslint-disable-line no-await-in-loop
    results.push(r);
    console.log(r.verdict.padEnd(9) + r.detail);
  }

  /* An unnamed session is the most useful probe of all: it is what a real
     customer gets, and its response may enumerate what the page will offer. */
  process.stdout.write('\n  (no method named) ');
  let open = null;
  try {
    const payload = C.buildPayload({
      amountKES: AMOUNT, apiRef: refFor('OPEN'), publicKey: PUB,
      narrative: 'SOKONI capability probe',
    });
    const res = await C.createCheckout({ payload, publicKey: PUB, sandbox: SANDBOX, https });
    open = { status: res.status, url: C.checkoutUrlOf(res.data), methods: C.methodsOf(res.data) };
    console.log(C.classifyOutcome(res.status) + '   ' + (open.url || 'no url'));
  } catch (e) {
    console.log('UNKNOWN   ' + (e.message || e));
  }

  const enabled = results.filter((r) => r.verdict === 'ENABLED').map((r) => r.method);
  const unknown = results.filter((r) => r.verdict === 'UNKNOWN').map((r) => r.method);

  console.log('\n  ── Result ──');
  console.log('  ENABLED : ' + (enabled.length ? enabled.join(', ') : '(none)'));
  console.log('  UNKNOWN : ' + (unknown.length ? unknown.join(', ') + '  ← re-run; do NOT treat as unavailable' : '(none)'));
  if (open && open.methods) {
    console.log('  the open session reported: ' + open.methods.join(', '));
  } else {
    console.log('  the open session did not enumerate methods — capability is per-method above');
  }

  console.log('\n  Next: record this in docs/PAYMENT_ARCHITECTURE_UNIFICATION.md and enable ONLY');
  console.log('  the methods listed as ENABLED. UNKNOWN is not permission to show a tile.\n');

  if (LIVE) {
    console.log('  Housekeeping: ' + (results.filter(r => r.verdict === 'ENABLED').length + (open && open.url ? 1 : 0)) +
                ' real invoice(s) were created on the account with ref PROBE_' + stamp + '_*.');
    console.log('  They are unpaid and will expire. Cancel them in the dashboard if you prefer.\n');
  }

  /* Exit 0 means THE PROBE RAN, not that card is available. The verdicts above
     are the output; the exit code is not evidence of anything else. */
  process.exit(0);
})().catch((e) => {
  console.error('\n  PROBE CRASHED — no conclusion may be drawn about any method:\n', e);
  process.exit(2);
});
