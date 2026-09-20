/* ══════════════════════════════════════════════════════════════════════════════
   SUBSCRIPTION ENTITLEMENT — A4 certification
   scripts/test-subscription-entitlement.js

   THE DEFECT THIS PINS
   A paid subscription recorded thirty days of entitlement regardless of what was
   purchased. An annual plan is advertised as "Annual — Save 17%", priced "KES X /yr"
   and "≈ KES Y/mo billed annually", and the registry builds the annual price as the
   monthly rate x 12 — but both writers hardcoded a flat month:

       index.js activateSubscription          expiresAt = Date.now() + 30 * 86400000
       payment-reconciliation.js  (backstop)  expiresAt = Date.now() + SUB_PLAN_DAYS * 86400000

   THE CYCLE WAS NEVER MISSING — only dropped. createPaymentIntent normalises it to
   'monthly'|'annual', prices against it, and persists it on paymentIntents/{ref}. The
   client wrapper then called activateSubscription with { plan, paymentRef } and the
   cycle went no further.

   THE REPAIR RESTORES PROVENANCE, it does not hardcode a bigger number:

       paymentRef  (crypto-minted server-side)
         -> payments/{paymentRef}     uid === caller, status === COMPLETE  (already enforced)
         -> .intentRef                written server-side
         -> paymentIntents/{ref}.billingCycle
         -> calendar period: monthly +1 month, annual +12 months

   So the browser cannot choose its own entitlement length, and no client cycle field
   was added for it to try.

   BOTH handlers are EXTRACTED FROM THE SHIPPED FILES AND EXECUTED against stubs — what
   is asserted is the expiry each writer actually computes, not a restatement of it.
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
/* Sources are read from SUBENT_SRC when set, so the sabotage driver can mutate a
   throwaway copy of the shipped files rather than the working tree another agent is
   writing. The git-scope checks in section 8 deliberately stay on the real ROOT. */
const SRC = process.env.SUBENT_SRC || ROOT;
const read = f => fs.readFileSync(path.join(SRC, f), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const indexJs = read('functions/index.js');
const recon   = read('functions/payment-reconciliation.js');
const subBill = read('functions/sub-billing.js');

/* Brace-match from a start index to the matching close. */
function block (src, from) {
  const open = src.indexOf('{', from);
  let d = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}') { d--; if (d === 0) return src.slice(from, i + 1); }
  }
  return null;
}
function fnSrc (src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i === -1) return null;
  /* Keep a leading `async` — dropping it makes the extracted body a syntax error. */
  const start = src.slice(Math.max(0, i - 6), i) === 'async ' ? i - 6 : i;
  return block(src, start);
}

/* ── THE SHIPPED PERIOD FUNCTIONS, EXECUTED ──────────────────────────────── */
const idxPeriodSrc   = fnSrc(indexJs, '_subPeriodEnd');
const reconPeriodSrc = fnSrc(recon, '_periodEnd');
const billPeriodSrc  = fnSrc(subBill, '_periodEnd');
const billAddSrc     = fnSrc(subBill, '_addMonths');

/* eslint-disable no-new-func */
const idxPeriod   = new Function(idxPeriodSrc + '\n return _subPeriodEnd;')();
const reconPeriod = new Function(reconPeriodSrc + '\n return _periodEnd;')();
const billPeriod  = new Function(billAddSrc + '\n' + billPeriodSrc + '\n return _periodEnd;')();

const D = (s) => new Date(s + 'T00:00:00Z');
/* A write that never happened, or one that landed on a different field, must read
   as a FAILED assertion — not as a TypeError that kills the run before its summary. */
const exp = (r, pick) => {
  const w = r && r.log && (pick === 'audit' ? r.log.audit : r.log.subWrite);
  if (!w) return '<nothing written>';
  if (!w.expiresAt || !w.expiresAt.__ts) return '<no expiresAt: ' + Object.keys(w).join(',') + '>';
  return f(w.expiresAt.__ts);
};
const f = (d) => d.toISOString().slice(0, 10);

/* The vectors pinned by the A4 design. They encode JavaScript's forward-rolling of
   impossible dates — 31 Jan + 1 month is 3 March — which is PRE-EXISTING sub-billing
   behaviour adopted unchanged, not something this repair introduced. */
const VECTORS = [
  ['2026-01-31', 'monthly', '2026-03-03'],
  ['2026-02-28', 'monthly', '2026-03-28'],
  ['2024-02-29', 'monthly', '2024-03-29'],
  ['2026-01-31', 'annual',  '2027-01-31'],
  ['2024-02-29', 'annual',  '2025-03-01'],
  ['2026-03-15', 'monthly', '2026-04-15'],
  ['2026-03-15', 'annual',  '2027-03-15'],
];

/* ── HARNESS: execute the shipped activateSubscription handler ───────────── */
function loadActivate () {
  /* Brace-match the HANDLER, not onCall's options object — which is the first
     `{` after the declaration and would otherwise be all we captured. */
  const i = indexJs.indexOf('exports.activateSubscription = onCall(');
  return block(indexJs, indexJs.indexOf('async (request)', i));
}
const ACTIVATE_SRC = loadActivate();

async function activate (over) {
  const o = Object.assign({
    callerUid: 'u1', plan: 'pro', paymentRef: 'REF1',
    payment: { uid: 'u1', status: 'COMPLETE', intentRef: 'REF1' },
    intent: { billingCycle: 'annual', planId: 'pro' },
    now: D('2026-03-15'),
    requestExtra: {},
  }, over || {});

  const log = { subWrite: null, audit: null, reads: [] };
  class HttpsError extends Error { constructor (c, m) { super(m); this.code = c; } }
  const TS = { fromDate: (d) => ({ __ts: d }) };
  const db = {
    collection: (c) => ({
      doc: (id) => ({
        get: async () => {
          log.reads.push(c + '/' + id);
          if (c === 'payments')       return { exists: !!o.payment, data: () => o.payment };
          if (c === 'paymentIntents') return { exists: !!o.intent,  data: () => o.intent };
          return { exists: false, data: () => ({}) };
        },
      }),
      add: async (d) => { log.audit = d; },
    }),
    runTransaction: async (fn) => fn({
      get: async () => ({ exists: false, data: () => ({}) }),
      set: (_ref, d) => { log.subWrite = d; },
    }),
  };
  const sandbox = {
    HttpsError,
    db,
    admin: { firestore: { Timestamp: TS, FieldValue: { serverTimestamp: () => '<ts>' } } },
    _subPeriodEnd: (start, cycle) => idxPeriod(o.now, cycle),
    console: { log () {}, error () {} },
  };
  const fn = new Function('sandbox',
    'with (sandbox) { return (' + ACTIVATE_SRC + '); }')(sandbox);
  const request = { auth: { uid: o.callerUid },
                    data: Object.assign({ plan: o.plan, paymentRef: o.paymentRef }, o.requestExtra) };
  try { return { ok: true, result: await fn(request), log }; }
  catch (e) { return { ok: false, error: e, log }; }
}

/* ── HARNESS: execute the shipped heal function ──────────────────────────── */
const HEAL_SRC = fnSrc(recon, 'healSubscriptionEntitlement');

async function heal (over) {
  const o = Object.assign({
    intent: { uid: 'u1', planId: 'pro', billingCycle: 'annual' },
    payment: { uid: 'u1', status: 'COMPLETE' },
    now: D('2026-03-15'), exists: false,
  }, over || {});
  const log = { subWrite: null, audit: null };
  const db = {
    collection: (c) => ({
      doc: () => ({ get: async () => (c === 'payments'
        ? { exists: !!o.payment, data: () => o.payment }
        : { exists: false, data: () => ({}) }) }),
      add: async (d) => { log.audit = d; return {}; },
    }),
    runTransaction: async (fn) => fn({
      get: async () => ({ exists: o.exists, data: () => ({}) }),
      set: (_r, d) => { log.subWrite = d; },
    }),
  };
  const sandbox = {
    db,
    F: { serverTimestamp: () => '<ts>' },
    admin: { firestore: { Timestamp: { fromDate: (d) => ({ __ts: d }) } } },
    _periodEnd: (start, cycle) => reconPeriod(o.now, cycle),
    SUB_PLAN_DAYS: 30,
  };
  const fn = new Function('sandbox',
    'with (sandbox) {' + HEAL_SRC + '\n return healSubscriptionEntitlement; }')(sandbox);
  const log2 = { error () {}, audit () {} };
  try { return { ok: true, result: await fn(o.intent, 'REF1', log2), log }; }
  catch (e) { return { ok: false, error: e, log }; }
}

(async function () {
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('  SUBSCRIPTION ENTITLEMENT (A4)');
  console.log('══════════════════════════════════════════════════════════════════');

  head('0 - the shipped pieces');
  {
    ok('control — activateSubscription handler extracted', ACTIVATE_SRC.length > 400);
    ok('control — heal function extracted', !!HEAL_SRC && HEAL_SRC.length > 300);
    ok('control — both period functions extracted', !!idxPeriodSrc && !!reconPeriodSrc);
    ok('control — sub-billing reference extracted', !!billPeriodSrc && !!billAddSrc);
  }

  /* ── 1. CALENDAR SEMANTICS ───────────────────────────────────────────────── */
  head('1 - calendar periods, pinned against sub-billing');
  {
    VECTORS.forEach(([start, cycle, want]) => {
      ok(start + ' ' + cycle.padEnd(7) + ' -> ' + want,
         f(idxPeriod(D(start), cycle)) === want, f(idxPeriod(D(start), cycle)));
    });
    /* Both writers must agree with each other AND with the named reference. */
    let sameAsRecon = true, sameAsBilling = true;
    VECTORS.forEach(([start, cycle]) => {
      if (f(idxPeriod(D(start), cycle)) !== f(reconPeriod(D(start), cycle))) sameAsRecon = false;
      if (f(idxPeriod(D(start), cycle)) !== f(billPeriod(D(start), cycle)))  sameAsBilling = false;
    });
    ok('primary and recovery compute identical periods', sameAsRecon);
    ok('and both match sub-billing.js, the named reference', sameAsBilling);
    /* The distinction the whole repair exists for. */
    ok('monthly and annual genuinely differ',
       f(idxPeriod(D('2026-03-15'), 'monthly')) !== f(idxPeriod(D('2026-03-15'), 'annual')));
    ok('annual is not 365 days',
       f(idxPeriod(D('2024-03-01'), 'annual')) === '2025-03-01', 'leap year spans 366');
  }

  /* ── 2. PRIMARY ACTIVATION ───────────────────────────────────────────────── */
  head('2 - activateSubscription honours the purchased cycle');
  {
    const a = await activate({ intent: { billingCycle: 'annual' } });
    ok('an annual purchase succeeds', a.ok, a.ok ? '' : String(a.error && a.error.message));
    ok('and records a 12-month expiry',
       exp(a) === '2027-03-15', a.ok && exp(a));

    const m = await activate({ intent: { billingCycle: 'monthly' } });
    ok('a monthly purchase records a 1-month expiry',
       exp(m) === '2026-04-15', m.ok && exp(m));

    /* THE PROVENANCE. It must read the intent via the payment's intentRef. */
    ok('it reads the payment', a.log.reads.indexOf('payments/REF1') > -1, a.log.reads.join(' · '));
    ok('and then the payment intent', a.log.reads.indexOf('paymentIntents/REF1') > -1);
    const viaRef = await activate({
      payment: { uid: 'u1', status: 'COMPLETE', intentRef: 'OTHER-INTENT' },
      intent: { billingCycle: 'annual' } });
    ok('it follows payments.intentRef, not the paymentRef',
       viaRef.log.reads.indexOf('paymentIntents/OTHER-INTENT') > -1, viaRef.log.reads.join(' · '));
  }

  /* ── 3. THE BROWSER CANNOT CHOOSE ITS OWN ENTITLEMENT ────────────────────── */
  head('3 - entitlement follows the intent, never the request');
  {
    const a = await activate({ intent: { billingCycle: 'annual' },
                               requestExtra: { billingCycle: 'monthly' } });
    ok('intent annual + client says monthly -> 12 months',
       exp(a) === '2027-03-15', a.ok && exp(a));

    const m = await activate({ intent: { billingCycle: 'monthly' },
                               requestExtra: { billingCycle: 'annual' } });
    ok('intent monthly + client says annual -> 1 month',
       exp(m) === '2026-04-15', m.ok && exp(m));

    /* Stronger still: the handler never reads a cycle off the request at all. */
    const src = strip(ACTIVATE_SRC);
    ok('the request is destructured to plan + paymentRef only',
       /const \{ plan, paymentRef \} = request\.data/.test(src));
    ok('no billingCycle is read from request.data', !/request\.data[\s\S]{0,60}billingCycle/.test(src));
    ok('the cycle comes from the intent document', /intentSnap\.data\(\)\.billingCycle/.test(src));
  }

  /* ── 4. FAIL CLOSED ──────────────────────────────────────────────────────── */
  head('4 - an unknown cycle is refused, never defaulted to 30 days');
  {
    const none = await activate({ intent: { planId: 'pro' } });          /* no billingCycle */
    ok('a missing cycle is refused', !none.ok && /billing cycle/i.test(none.error.message));
    ok('and nothing is written', none.log.subWrite === null);

    const bad = await activate({ intent: { billingCycle: 'weekly' } });
    ok('an unrecognised cycle is refused', !bad.ok);
    const gone = await activate({ intent: null });
    ok('a missing intent document is refused', !gone.ok);

    /* The old fallback must be gone from this writer. */
    const src = strip(ACTIVATE_SRC);
    ok('no 30-day arithmetic remains', !/30 \* 86400000/.test(src));
    ok('control — an ordinary purchase still succeeds', (await activate({})).ok);
  }

  /* ── 5. DOCUMENT SHAPE UNCHANGED ─────────────────────────────────────────── */
  head('5 - the same field, corrected — not a second one');
  {
    const a = await activate({});
    const keys = Object.keys(a.log.subWrite).sort();
    ok('expiresAt is still written', keys.indexOf('expiresAt') > -1);
    ok('currentPeriodEnd is NOT introduced', keys.indexOf('currentPeriodEnd') === -1, keys.join(','));
    ok('the document shape is otherwise unchanged',
       keys.join(',') === 'activatedAt,expiresAt,paymentRef,plan,status,uid,updatedAt', keys.join(','));
    ok('the audit row carries the same expiry',
       exp(a, 'audit') === exp(a));
    /* subscription-authority resolves `sub.expiresAt || sub.currentPeriodEnd`, so a second
       field would shadow this one with a different value. */
    ok('control — the authority still prefers expiresAt',
       /sub\.expiresAt \|\| sub\.currentPeriodEnd/.test(read('functions/subscription-authority.js')));
  }

  /* ── 6. RECOVERY PARITY ──────────────────────────────────────────────────── */
  head('6 - the backstop cannot grant a different entitlement');
  {
    const a = await heal({ intent: { uid: 'u1', planId: 'pro', billingCycle: 'annual' } });
    ok('an annual heal succeeds', a.ok && a.result.healed === true,
       JSON.stringify(a.result || {}));
    ok('and records 12 months', exp(a) === '2027-03-15',
       exp(a));

    const m = await heal({ intent: { uid: 'u1', planId: 'pro', billingCycle: 'monthly' } });
    ok('a monthly heal records 1 month', exp(m) === '2026-04-15');

    /* PARITY: same intent, same entitlement, whichever path ran. */
    const prim = await activate({ intent: { billingCycle: 'annual' } });
    ok('primary and recovery agree for the same intent',
       exp(prim) === exp(a));

    const src = strip(HEAL_SRC);
    ok('the flat SUB_PLAN_DAYS expiry is gone from the heal path',
       !/SUB_PLAN_DAYS \* 86400000/.test(src));
    ok('the cycle comes from the intent', /intent\.billingCycle/.test(src));
  }

  /* ── 7. LEGACY INTENTS ───────────────────────────────────────────────────── */
  head('7 - an intent with no cycle is skipped, counted and reported');
  {
    const none = await heal({ intent: { uid: 'u1', planId: 'pro' } });
    ok('it is not healed', none.ok && none.result.healed === false);
    ok('with a named reason', none.result.reason === 'missing_billing_cycle', none.result.reason);
    ok('and nothing is written', none.log.subWrite === null);
    ok('no audit row claims an activation', none.log.audit === null);

    const bad = await heal({ intent: { uid: 'u1', planId: 'pro', billingCycle: 'fortnightly' } });
    ok('an invalid cycle is skipped the same way', bad.result.reason === 'missing_billing_cycle');

    /* It must be COUNTED, or it is an invisible no-op repeated daily. */
    ok('the run counts it separately', /skippedNoCycle\+\+/.test(recon));
    ok('the summary reports it', /scanned, gaps, healed, alerted, skipped, skippedNoCycle/.test(recon));
    ok('and the completion log states it', /skippedNoCycle,\s*\n\s*mode:/.test(recon));
    /* The existing alert path already surfaces the reason per record. */
    ok('control — every gap still raises an alert carrying the reason',
       /entry\.reason = r\.reason/.test(recon) && /writeAdminAlert\('entitlement_gap'/.test(recon));
    ok('the existing result contract is preserved',
       /healed: false, reason: 'payment_missing'/.test(recon) &&
       /healed: false, reason: 'already_active'/.test(recon));
    /* No silent back-fill. */
    ok('legacy intents are not back-filled here', !/backfill|back_fill/i.test(strip(recon)));
  }

  /* ── 8. NOTHING ELSE MOVED ───────────────────────────────────────────────── */
  head('8 - strict scope');
  {
    /* webhookIntasend is not a subscription-expiry writer and must stay untouched. */
    const wh = indexJs.slice(indexJs.indexOf('exports.webhookIntasend = onRequest('),
                             indexJs.indexOf('exports.webhookIntasend = onRequest(') + 40000);
    ok('webhookIntasend writes no subscription expiry',
       !/collection\("subscriptions"\)/.test(wh) || !/expiresAt/.test(wh));
    ok('it still does not compute a period', !/_subPeriodEnd/.test(wh));

    ok('SUB_PLAN_DAYS is no longer the subscription expiry rule',
       !/expiresAt = new Date\(Date\.now\(\) \+ SUB_PLAN_DAYS/.test(recon));

    /* ── FILES A4 MUST NOT HAVE TOUCHED — ANCHORED TO ITS LANDING ───────────
       RE-ANCHORED 2026-09-20. This read `git status --porcelain` on the LIVE
       WORKING TREE, which answers a different question than the one asked:

           the claim      did the A4 LANDING touch these five files?
           the mechanism  are these five files dirty RIGHT NOW?

       `fc0f758` predicted this in terms when it repaired the AdminOS half and
       deliberately left these alone: "they will rot the same way the moment
       anyone legitimately edits sub-engine.js, sasos-core.js, email-triggers.js,
       subscription-authority.js or sub-billing.js — at which point this suite
       will fail for a reason that has nothing to do with subscription
       entitlement." MEASURED 2026-09-20: appending one comment to sub-engine.js
       took the suite from 78/0 to 77/1 on `functions/sub-engine.js untouched`.

       NOT-DIRTY IS NOT INHERENTLY DEAD — it is the wrong MEASUREMENT for a
       historical claim. It has both failure modes: a false positive while
       unrelated authorized work is in flight, and a vacuous pass once that work
       is committed. Against the frozen boundary the claim is true permanently
       and no later edit can disturb it.

       GROUP B BELOW IS DELIBERATELY UNTOUCHED. Those seven AdminOS markers are
       a CURRENT content contract, not a scope claim — a revert removes the
       marker, so present-state is exactly the right measurement there. The two
       halves needed opposite treatments and keep them. */
    const a4git = (...a) => require('child_process')
      .execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8' }).trim();

    /* Self-verifying: a bare SHA would silently compare the wrong commit if
       history were rewritten, and that empty diff reads exactly like a landing
       which respected its boundary. A4 is named by what it DID — it is the
       commit that ADDED this suite. */
    const A4 = 'b4c9495';
    const A4_SELF = 'scripts/test-subscription-entitlement.js';
    const A4_PROTECTED = ['functions/sub-engine.js', 'functions/sasos-core.js',
      'functions/email-triggers.js', 'functions/subscription-authority.js',
      'functions/sub-billing.js'];

    let a4Ok = false, a4Added = '';
    try {
      a4Added = a4git('show', '--name-status', '--format=', A4, '--', A4_SELF);
      a4Ok = new RegExp('^A\\s+' + A4_SELF.replace(/[.\/]/g, '\\$&') + '$', 'm').test(a4Added);
    } catch (e) { a4Added = 'ref unresolved: ' + ((e && e.message) || '').slice(0, 60); }
    ok('the A4 landing resolves, and is the commit that ADDED this suite',
       a4Ok, a4Added || 'no output');

    if (!a4Ok) {
      ok('A4 SCOPE ANCHOR UNVERIFIABLE — refusing to report a scope verdict', false,
         'the boundary could not be established, so "untouched" would be unproven');
    } else {
      const a4Touched = a4git('diff', '--name-only', A4 + '~1', A4, '--', ...A4_PROTECTED);
      ok('the five subscription modules are untouched BY THE A4 LANDING',
         a4Touched === '', a4Touched || 'none of the five is in the landing');

      /* POSITIVE CONTROL — an empty diff is equally consistent with a landing
         that respected its boundary and a comparison that can never match. */
      const a4Control = a4git('diff', '--name-only', A4 + '~1', A4, '--', 'functions/index.js');
      ok('CONTROL: the same comparison DOES report a file the landing changed',
         a4Control === 'functions/index.js', a4Control || 'EMPTY — the detector is blind');
    }
    /* THE CERTIFIED AdminOS WORK MUST SURVIVE.
       This used to assert each path was still DIRTY. That was only ever a proxy
       for "A4 did not revert it", and the proxy died the moment the work was
       legitimately committed in the release batch c1c923c — at which point seven
       assertions failed while nothing was wrong. A guard whose premise expires
       reports rot as a regression, which is worse than not guarding at all.

       What the guard is actually for is unchanged: a later edit here must not
       revert or clobber the AdminOS surfaces. So the test is now for the CONTENT
       that A4 must not have destroyed — which holds whether that content is
       dirty, staged or committed, and which a revert would remove. */
    const survives = [
      ['functions/admin-os.js',            /adminScheduleUserDeletion|adminMessageUser/],
      ['sokoni-aos.js',                    /scheduleUserDeletion|messageUser/],
      ['sokoni-aos-users.js',              /del: !!A0\.deleteUser/],
      ['sokoni-aos-users.css',             /usx-msg/],
      ['super-admin.html',                 /SokoniAOSUsers/],
      ['scripts/test-aos-users.js',        /deleteUser/],
      ['scripts/harness-aos-users.html',   /sokoni-aos-users-css/],
    ];
    survives.forEach(([f2, marker]) => {
      let src = null;
      try { src = fs.readFileSync(path.join(ROOT, f2), 'utf8'); } catch (_) { src = null; }
      ok('AdminOS work intact: ' + f2,
         src !== null && marker.test(src),
         src === null ? 'FILE MISSING' : (marker.test(src) ? '' : 'MARKER GONE'));
    });
    /* INVERTING CONTROL — a marker check that cannot fail proves nothing. The
       same matcher is run against a source that must NOT contain it. */
    ok('INVERTING CONTROL — the marker check can fail',
       !/del: !!A0\.deleteUser/.test('const x = 1;'));
  }

  /* ── 9. ACCESS GATING ────────────────────────────────────────────────────── */
  head('9 - the access gate resolves the same, on the real catalogue');
  {
    /* Not a restatement: the REAL subscription-catalog is required and fed the
       document the shipped writer just produced. */
    const catalog = require(path.join(ROOT, 'functions/subscription-catalog.js'));
    const docOf = (w) => ({ status: w.status, plan: w.plan, expiresAt: w.expiresAt.__ts });

    const a = docOf((await activate({ intent: { billingCycle: 'annual' } })).log.subWrite);
    const m = docOf((await activate({ intent: { billingCycle: 'monthly' } })).log.subWrite);
    const ea = catalog.entitlementFor(a), em = catalog.entitlementFor(m);

    ok('an annual purchase entitles', ea.subscriptionStatus === 'ACTIVE', ea.subscriptionStatus);
    /* Derived, never pinned: `pro` is an ALIAS (-> BUSINESS) and a literal here would
       become a time bomb the day the catalogue is consolidated. What A4 must not do is
       change which plan the stored document resolves to. */
    ok('on the plan the catalogue resolves for the stored id',
       ea.plan === catalog.resolve('pro').id, ea.plan);
    /* THE POINT: length must buy DURATION, never a different capability. */
    ok('annual and monthly grant identical capability',
       JSON.stringify([ea.plan, ea.listingLimit, ea.staffSeats, ea.features]) ===
       JSON.stringify([em.plan, em.listingLimit, em.staffSeats, em.features]));
    ok('and differ only in the reported expiry',
       f(ea.expiresAt) === '2027-03-15' && f(em.expiresAt) === '2026-04-15',
       f(ea.expiresAt) + ' vs ' + f(em.expiresAt));
    ok('the gate reads the expiry the writer wrote', f(ea.expiresAt) === f(a.expiresAt));

    /* Positive control — the gate can say no, so the passes above mean something. */
    ok('control — a cancelled subscription does not entitle',
       catalog.entitlementFor({ status: 'cancelled', plan: 'pro' }).subscriptionStatus === 'INACTIVE');
    ok('control — and falls back to FREE',
       catalog.entitlementFor({ status: 'cancelled', plan: 'pro' }).plan === 'FREE');

    /* HONEST SCOPE. entitlementFor compares status, never expiresAt to now. A4
       corrects the DATE RECORDED; it does not add expiry enforcement, and this
       pins that so nobody reads the repair as more than it is. */
    const stale = catalog.entitlementFor({ status: 'active', plan: 'pro',
                                           expiresAt: D('2020-01-01') });
    ok('UNCHANGED — gating is status-driven, not expiry-driven',
       stale.subscriptionStatus === 'ACTIVE', 'a past expiresAt still entitles, as before');
  }

  console.log('\n  what this suite does NOT prove');
  console.log('  UNPROVEN  a live Firestore round-trip; handlers run against stubs.');
  console.log('  EXPECTED  email-triggers.js queries subscriptions by expiresAt, so annual');
  console.log('            reminders now fire near the annual expiry instead of at 30 days.');
  console.log('            That file is deliberately unmodified.');
  console.log('  ADOPTED   31 Jan + 1 month = 3 March is pre-existing sub-billing behaviour,');
  console.log('            pinned above and NOT changed by this repair.');

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('══════════════════════════════════════════════════════════════════');
  process.exit(fail ? 1 : 0);
})();
