/* ══════════════════════════════════════════════════════════════════════════════
   W2 — webhookIntasend subscription entitlement          (A4-F3D certification)
   scripts/test-webhook-subscription-entitlement.js

   WHAT THIS PINS
   A4 made activateSubscription (W1) and the reconciliation backstop (W3) derive
   entitlement from paymentIntents/{ref}.billingCycle. It did not reach W2, the
   webhook writer — which was not merely a third opinion but the DECIDING one:

     • W2 is the handler that sets payments/{ref}.status = COMPLETE.
     • COMPLETE is the precondition W1 refuses to act without.
     • W2 continues to the subscription write in the SAME invocation.
     • The browser calls W1 only after the confirmation it awaits, behind a human
       click — by which time the document exists, so W1 matches its own paymentRef
       and returns without writing.
     • W3 declines whenever a document exists at all, whatever its expiry.

   So the corrected writers both yield to the uncorrected one. Whatever W2 records
   is what the merchant gets, and W2 recorded thirty days while stamping
   `billingCycle: "annual"` on the same document.

   Production at the time of the repair: 7 subscription documents, 0 annual, 1
   webhook-attributed monthly (correctly 30 days). The defect was live and loaded
   but had never fired, because no annual plan had ever been sold.

   HOW THIS IS PROVEN
   The shipped activation block is EXTRACTED FROM functions/index.js AND EXECUTED
   against stubs. What is asserted is the document W2 actually writes — not a
   restatement of it, and not a pattern match on its source.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d ? '   [' + d + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (d ? '   [' + d + ']' : '')); }
};
const head = t => console.log('\n' + t);

/* W2_SRC_ROOT lets the sabotage driver point this suite at a throwaway copy of the
   shipped files instead of the working tree another agent is writing. */
const SRCROOT = process.env.W2_SRC_ROOT || ROOT;
const SRC = fs.readFileSync(path.join(SRCROOT, 'functions/index.js'), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* ── EXTRACT: the handler, then its subscription-activation block ─────────── */
function block (src, from) {
  const open = src.indexOf('{', from);
  let d = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}') { d--; if (d === 0) return src.slice(from, i + 1); }
  }
  return null;
}
const W2_START = 'const intentRef  = existing.intentRef || apiRef;';
const HANDLER = SRC.slice(SRC.indexOf('exports.webhookIntasend = onRequest('),
                          SRC.indexOf('exports.webhookMpesa = onRequest('));
/* The block is `try { ... } catch (subErr) { ... }`; take the try body only, so
   a refusal inside it surfaces here instead of being swallowed by that catch. */
const TRY_AT = SRC.lastIndexOf('try {', SRC.indexOf(W2_START));
/* Brace-matching stops at the try's own closing brace, so what comes back is
   `try { ... }` with no catch — not valid on its own. Take the BODY: that is
   also what we want semantically, since running it bare means a refusal or a
   fault surfaces in this suite instead of being absorbed by the handler's
   catch and reported as a generic activation failure. */
const W2_RAW = (TRY_AT >= 0 && SRC.indexOf(W2_START) > -1) ? block(SRC, TRY_AT) : null;
const W2_SRC = W2_RAW ? W2_RAW.replace(/^try\s*\{/, '').replace(/\}\s*$/, '') : null;
/* FAIL CLOSED. If the block cannot be located the suite must SAY SO and stop with
   a verdict — not throw halfway through and leave no summary, which reads to a
   caller as an infrastructure problem rather than as "this proved nothing". */
if (!W2_SRC) {
  console.log('\n  FAIL  the W2 activation block could not be extracted from functions/index.js');
  console.log('        The anchor moved or the handler was restructured. NOTHING WAS PROVEN.');
  console.log('\n  0 passed, 1 failed\n');
  process.exit(1);
}

/* Period function, taken from the shipped file — the same one W1 uses. */
const PERIOD_SRC = (() => {
  const i = SRC.indexOf('function _subPeriodEnd(');
  return block(SRC, i);
})();
const _subPeriodEnd = new Function(PERIOD_SRC + '\n return _subPeriodEnd;')();

const D = s => new Date(s + 'T00:00:00Z');
const f = d => d.toISOString().slice(0, 10);

/* ── HARNESS: execute the shipped block ──────────────────────────────────── */
async function runW2 (over) {
  const o = Object.assign({
    apiRef: 'REF1',
    existing: { intentRef: 'REF1' },
    intent: { purpose: 'subscription', planId: 'pro', uid: 'u1', billingCycle: 'annual' },
    sub: null,                       /* existing subscriptions/{uid} document */
    amount: 12000,
    now: D('2026-03-15'),
  }, over || {});

  const log = { subWrite: null, audit: null, reads: [], errors: [], materialised: null };
  const TS = { fromDate: d => ({ __ts: d }) };
  const db = {
    collection: (c) => ({
      doc: (id) => ({
        get: async () => {
          log.reads.push(c + '/' + id);
          if (c === 'paymentIntents') return { exists: !!o.intent, data: () => o.intent };
          if (c === 'subscriptions') return { exists: !!o.sub, data: () => o.sub };
          return { exists: false, data: () => ({}) };
        },
        set: async (d) => { log.subWrite = d; },
      }),
      add: (d) => { log.audit = d; return { catch: () => {} }; },
    }),
  };
  const sandbox = {
    db, apiRef: o.apiRef, existing: o.existing, amount: o.amount,
    admin: { firestore: { Timestamp: TS, FieldValue: { serverTimestamp: () => '<ts>' } } },
    _subPeriodEnd: (start, cycle) => _subPeriodEnd(o.now, cycle),
    console: { log () {}, error (m, d) { log.errors.push(m + ' ' + JSON.stringify(d || {})); } },
    require: (m) => {
      if (m === './subscription-authority') {
        return { _internal: { materialiseEntitlements: async (uid, why) => { log.materialised = uid + '/' + why; } } };
      }
      throw new Error('unexpected require: ' + m);
    },
  };
  const fn = new Function('sandbox',
    'return async function () { with (sandbox) {' + W2_SRC + '} };')(sandbox);
  await fn();
  return log;
}

(async () => {
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('  W2 — webhookIntasend subscription entitlement (A4-F3D)');
  console.log('══════════════════════════════════════════════════════════════════');

  head('0 - the shipped block');
  ok('control — activation block extracted', !!W2_SRC && W2_SRC.length > 500,
     W2_SRC ? W2_SRC.length + ' chars' : 'MISSING');
  ok('control — it is the block that writes the subscription',
     /collection\("subscriptions"\)/.test(W2_SRC) && /expiresAt/.test(W2_SRC));
  ok('control — the harness executes it', (await runW2({})).subWrite !== null);

  /* ── 1. THE PERIOD ───────────────────────────────────────────────────────── */
  head('1 - W2 honours the purchased cycle');
  {
    const a = await runW2({ intent: { purpose: 'subscription', planId: 'pro', uid: 'u1', billingCycle: 'annual' } });
    ok('an annual purchase records 12 months', f(a.subWrite.expiresAt.__ts) === '2027-03-15',
       f(a.subWrite.expiresAt.__ts));
    const m = await runW2({ intent: { purpose: 'subscription', planId: 'pro', uid: 'u1', billingCycle: 'monthly' } });
    ok('a monthly purchase records 1 month', f(m.subWrite.expiresAt.__ts) === '2026-04-15',
       f(m.subWrite.expiresAt.__ts));
    ok('the recorded cycle matches the recorded expiry — no self-contradiction',
       a.subWrite.billingCycle === 'annual' && m.subWrite.billingCycle === 'monthly',
       a.subWrite.billingCycle + ' / ' + m.subWrite.billingCycle);

    /* Boundary vectors, same as A4's. */
    const V = [['2026-01-31', 'monthly', '2026-03-03'], ['2024-02-29', 'annual', '2025-03-01'],
               ['2026-01-31', 'annual', '2027-01-31'], ['2024-02-29', 'monthly', '2024-03-29']];
    for (const [start, cycle, want] of V) {
      const r = await runW2({ now: D(start),
        intent: { purpose: 'subscription', planId: 'pro', uid: 'u1', billingCycle: cycle } });
      ok(start + ' ' + cycle.padEnd(7) + ' -> ' + want, f(r.subWrite.expiresAt.__ts) === want,
         f(r.subWrite.expiresAt.__ts));
    }
  }

  /* ── 2. THE CYCLE IS SERVER-AUTHORITATIVE ────────────────────────────────── */
  head('2 - the cycle comes from the intent, never the callback body');
  {
    ok('it reads the payment intent', (await runW2({})).reads.some(r => r.startsWith('paymentIntents/')));
    const viaRef = await runW2({ existing: { intentRef: 'OTHER-INTENT' } });
    ok('via payments.intentRef, not the api_ref',
       viaRef.reads.indexOf('paymentIntents/OTHER-INTENT') > -1, viaRef.reads.join(' · '));

    /* A webhook body is provider-supplied, so it must not be able to choose a term. */
    const code = strip(W2_SRC);
    ok('the cycle is read from the intent document', /intent\.billingCycle/.test(code));
    ok('no cycle is read from the request body', !/req\.body[\s\S]{0,80}billingCycle/.test(code));
    ok('no flat 30-day arithmetic remains', !/30 \* 86400000/.test(code));
    ok('the old `|| "monthly"` default is gone', !/\|\| *"monthly"/.test(code));
    /* INVERTING CONTROL — the stripper really removed the prose those patterns
       also appear in, so the four absences above are about code. */
    ok('control — stripping actually removed comment text', strip(W2_SRC).length < W2_SRC.length * 0.9,
       W2_SRC.length + ' -> ' + strip(W2_SRC).length);
  }

  /* ── 3. FAIL CLOSED ──────────────────────────────────────────────────────── */
  head('3 - an unknown cycle writes nothing, and says so');
  {
    const none = await runW2({ intent: { purpose: 'subscription', planId: 'pro', uid: 'u1' } });
    ok('a missing cycle writes no subscription', none.subWrite === null);
    ok('and no audit row claims an activation', none.audit === null);
    ok('and no entitlement is materialised', none.materialised === null);
    ok('the skip is logged as a SKIP, not as a failure',
       none.errors.some(e => /SKIPPED/.test(e) && /billing cycle/i.test(e)),
       none.errors.join(' | ') || 'nothing logged');

    const bad = await runW2({ intent: { purpose: 'subscription', planId: 'pro', uid: 'u1', billingCycle: 'weekly' } });
    ok('an unrecognised cycle is skipped the same way', bad.subWrite === null);
    ok('control — a valid cycle still activates', (await runW2({})).subWrite !== null);
  }

  /* ── 4. NOTHING ELSE MOVED ───────────────────────────────────────────────── */
  head('4 - lifecycle, shape and idempotency unchanged');
  {
    const r = await runW2({});
    const keys = Object.keys(r.subWrite).sort().join(',');
    ok('the document shape is unchanged',
       keys === 'activatedAt,amountPaid,billingCycle,expiresAt,paymentRef,plan,planName,source,status,uid,updatedAt',
       keys);
    ok('no second expiry field was introduced', keys.indexOf('currentPeriodEnd') === -1);
    ok('provenance still records the writer', r.subWrite.source === 'webhookIntasend');
    ok('the audit row carries the same expiry',
       f(r.audit.expiresAt.__ts) === f(r.subWrite.expiresAt.__ts));
    ok('entitlements are still materialised', r.materialised === 'u1/payment-complete');

    /* IDEMPOTENCY — unchanged: the same paymentRef must not rewrite. */
    const same = await runW2({ sub: { paymentRef: 'REF1', plan: 'pro' } });
    ok('a repeat delivery for the same paymentRef writes nothing', same.subWrite === null);
    const renewal = await runW2({ sub: { paymentRef: 'OLDREF', plan: 'pro' } });
    ok('a NEW paymentRef still activates (renewal)', renewal.subWrite !== null);
    ok('and the renewal gets the purchased term', f(renewal.subWrite.expiresAt.__ts) === '2027-03-15');

    /* Non-subscription payments must be untouched by any of this. */
    const order = await runW2({ intent: { purpose: 'order', planId: null, uid: 'u1' } });
    ok('a non-subscription intent is ignored', order.subWrite === null && order.errors.length === 0);
  }

  /* ── 5. ALL REACHABLE WRITERS AGREE ──────────────────────────────────────── */
  head('5 - W1, W2 and W3 derive the same period');
  {
    const recon = fs.readFileSync(path.join(SRCROOT, 'functions/payment-reconciliation.js'), 'utf8');
    const w3 = new Function(block(recon, recon.indexOf('function _periodEnd(')) + '\n return _periodEnd;')();
    const w1 = _subPeriodEnd;   /* W1 and W2 share this function in one file */

    let agree = true;
    [['2026-03-15', 'monthly'], ['2026-03-15', 'annual'], ['2026-01-31', 'monthly'],
     ['2024-02-29', 'annual'], ['2026-01-31', 'annual'], ['2026-02-28', 'monthly']]
      .forEach(([s, c]) => { if (f(w1(D(s), c)) !== f(w3(D(s), c))) agree = false; });
    ok('W1/W2 and W3 agree on every boundary vector', agree);

    /* W2's own executed output must match that shared function, not merely import it. */
    const exec = await runW2({ now: D('2026-01-31'),
      intent: { purpose: 'subscription', planId: 'pro', uid: 'u1', billingCycle: 'annual' } });
    ok('and W2, executed, produces exactly that period',
       f(exec.subWrite.expiresAt.__ts) === f(w1(D('2026-01-31'), 'annual')),
       f(exec.subWrite.expiresAt.__ts));

    /* W4 stays out. Its status is LATENT, not repaired — asserted so that a
       future reachable caller cannot quietly promote it without failing here. */
    const ad = fs.readFileSync(path.join(SRCROOT, 'functions/entitlement-adapters.js'), 'utf8');
    ok('W4 is UNCHANGED by this repair — still PLAN_DAYS-based',
       /PLAN_DAYS \* 86400000/.test(ad), 'latent; reachability unproven — A4-F3E');
    ok('and the webhook still only SHADOW-compares it, never activates it',
       /shadowCompareSubscription/.test(HANDLER) && !/adapters\.subscription\.activate/.test(HANDLER));
  }

  console.log('\n  what this suite does NOT prove');
  console.log('  UNPROVEN  a live Firestore round-trip; the block runs against stubs.');
  console.log('  LATENT    W4 (entitlement-adapters) still writes PLAN_DAYS=30. It is not on');
  console.log('            the verified live path; establishing its callers is A4-F3E.');
  console.log('  HISTORY   A4\'s own suite still contains the unsound 40,000-char assertion');
  console.log('            about this handler. Left as recorded evidence, superseded by');
  console.log('            scripts/test-subscription-expiry-writers.js.');

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('══════════════════════════════════════════════════════════════════');
  process.exit(fail ? 1 : 0);
})();
