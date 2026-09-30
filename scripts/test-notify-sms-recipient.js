/* ============================================================================
   REGRESSION — notify() must RESOLVE an SMS recipient, not merely accept one
   scripts/test-notify-sms-recipient.js
   ============================================================================
   THE DEFECT THIS PROVES CLOSED

     const wantSms = ch.sms || (ch.smsFallback && !pushOk);
     if (wantSms && t.smsTemplate && phone) { … sms.enqueue(…) }
                                    ^^^^^
   `phone` is a CALLER-SUPPLIED parameter. notify() never looked a number up,
   and no caller in the codebase passes one — so the condition was false at its
   last term every time, sms.enqueue() was never reached, and smsQueueWorker
   drained an empty queue every 60s with zero errors for months.

   Production at the time of the repair, read-only census of 100 users:

       phoneNumber present   14   (14/14 well-formed +254XXXXXXXXX)
       legacy `phone` only    1
       neither field         85

   So this repair moves reach from 0% to ~14%. It does NOT make SMS universally
   available, and nothing here should be read as "SMS works" — the remaining 86%
   is a phone-number POPULATION question, and actual Africa's Talking delivery is
   proven by neither this suite nor the static one.

   WHAT IS ASSERTED

     1  explicit phone supplied        -> that number is used verbatim
     2  no phone, phoneNumber exists   -> canonical number resolved and queued
     3  no phone, no phoneNumber       -> NO enqueue, channels.sms reports it
     4  legacy `phone` only            -> NOT used; treated as absent

   Case 4 is the inverting control. Resolving the legacy field would raise the
   apparent reach and silently undo a canonicalisation the write path already
   completed, so "it does not send" is the required behaviour, not a gap.

   METHOD

   notify.js is a Cloud Functions module; requiring it pulls firebase-functions
   and Firestore. Rather than stub a whole runtime, this extracts the SMS block
   from the shipped source and executes it against fakes. That means the test
   runs THE SHIPPED TEXT — if the block is edited, this suite sees the edit, and
   if the block is removed the extraction fails loudly rather than passing.

   RUN  node scripts/test-notify-sms-recipient.js
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '..', 'functions', 'notify.js');
const src = fs.readFileSync(SRC, 'utf8');

let PASS = 0, FAIL = 0;
const FAILURES = [];
/* Remove block comments, line comments and string bodies so a source assertion tests
   EXECUTABLE CODE. Added 2026-09-30 after a repair's own comment, which quoted the
   defect it fixed, made a negative source assertion fail against correct code. */
function stripComments (src) {
  let out = '', i = 0; const n = src.length;
  let inS = null, inBlock = false, inLine = false;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (inLine) { if (c === '\n') { inLine = false; out += c; } i++; continue; }
    if (inBlock) { if (c === '*' && d === '/') { inBlock = false; i += 2; } else { if (c === '\n') out += c; i++; } continue; }
    if (inS) { out += c; if (c === '\\') { out += (d || ''); i += 2; continue; } if (c === inS) inS = null; i++; continue; }
    if (c === '/' && d === '*') { inBlock = true; i += 2; continue; }
    if (c === '/' && d === '/') { inLine = true; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') { inS = c; out += c; i++; continue; }
    out += c; i++;
  }
  return out;
}

function ok(label, cond, detail) {
  if (cond) { PASS++; console.log('  PASS  ' + label); return true; }
  FAIL++; FAILURES.push(label + (detail ? '  — ' + detail : ''));
  console.log('  FAIL  ' + label + (detail ? '  — ' + detail : ''));
  return false;
}

/* ── Extract the shipped SMS block ──────────────────────────────────── */
const startMark = 'const wantSms =';
const endMark   = "} else if (ch.smsFallback && pushOk) {";
const i = src.indexOf(startMark);
const j = src.indexOf(endMark, i);
if (i === -1 || j === -1) {
  console.error('EXTRACTION FAILED — the SMS block was not found in notify.js.');
  console.error('Either it moved or it was removed. This suite cannot pass vacuously.');
  process.exit(2);
}
/* +1 so the closing brace of the `if (wantSms …)` block is included — it is the
   first character of the `} else if …` marker, and without it the extracted
   text ends mid-statement and cannot parse. */
const block = src.slice(i, j + 1);

/* The block must still contain a real enqueue call, or every "did not send"
   assertion below would pass against a block that can never send at all. */
if (block.indexOf('sms.enqueue(') === -1) {
  console.error('EXTRACTION CONTROL FAILED — extracted block has no sms.enqueue().');
  process.exit(2);
}

/* ── Harness ────────────────────────────────────────────────────────── */
async function run({ phone, userDoc }) {
  const enqueued = [];
  const sms = { enqueue: async (a) => { enqueued.push(a); return { ok: true }; } };
  const db = () => ({
    collection: () => ({
      doc: () => ({
        get: async () => ({
          exists: !!userDoc,
          data: () => userDoc || {},
        }),
      }),
    }),
  });

  const result = { channels: {} };
  const ch = { sms: true, smsFallback: false };
  const t = { smsTemplate: 'order_placed' };
  const pushOk = false, uid = 'u1', key = 'k1', vars = {}, title = 'T', body = 'B';

  const fn = new Function(
    'ch', 't', 'pushOk', 'phone', 'uid', 'key', 'vars', 'title', 'body',
    'sms', 'db', 'result',
    '"use strict"; return (async () => {\n' + block + '\n})();'
  );
  await fn(ch, t, pushOk, phone, uid, key, vars, title, body, sms, db, result);
  return { enqueued, result };
}

(async () => {
  console.log('\nnotify() — SMS recipient resolution\n' + '='.repeat(62));

  /* 1 — explicit override is honoured */
  {
    const { enqueued, result } = await run({
      phone: '+254700000001',
      userDoc: { phoneNumber: '+254799999999' },
    });
    ok('1 explicit phone is used', enqueued.length === 1 && enqueued[0].to === '+254700000001',
       'to=' + (enqueued[0] && enqueued[0].to));
    ok('1 the override beats the stored number', enqueued[0] && enqueued[0].to !== '+254799999999');
    ok('1 it reports queued', result.channels.sms === 'queued', 'got ' + result.channels.sms);
  }

  /* 2 — canonical fallback: THE REPAIR */
  {
    const { enqueued, result } = await run({
      phone: undefined,
      userDoc: { phoneNumber: '+254712345678' },
    });
    ok('2 canonical phoneNumber is resolved', enqueued.length === 1, 'enqueued=' + enqueued.length);
    ok('2 the stored number is used', enqueued[0] && enqueued[0].to === '+254712345678',
       'to=' + (enqueued[0] && enqueued[0].to));
    ok('2 it reports queued', result.channels.sms === 'queued', 'got ' + result.channels.sms);
  }

  /* 3 — no number anywhere: visible, not silent */
  {
    const { enqueued, result } = await run({ phone: undefined, userDoc: {} });
    ok('3 nothing is enqueued', enqueued.length === 0, 'enqueued=' + enqueued.length);
    ok('3 the skip is REPORTED', result.channels.sms === 'no_phone_on_record',
       'got ' + JSON.stringify(result.channels.sms));
    ok('3 channels.sms is not left undefined', result.channels.sms !== undefined);
  }

  /* 4 — INVERTING CONTROL: legacy field must NOT be resolved */
  {
    const { enqueued, result } = await run({
      phone: undefined,
      userDoc: { phone: '+254711111111' },      /* legacy field only */
    });
    ok('4 legacy `phone` is NOT used', enqueued.length === 0, 'enqueued=' + enqueued.length);
    ok('4 it reports no_phone_on_record', result.channels.sms === 'no_phone_on_record',
       'got ' + result.channels.sms);
  }

  /* 5 — a missing user document must not throw */
  {
    const { enqueued, result } = await run({ phone: undefined, userDoc: null });
    ok('5 an absent user doc does not throw', true);
    ok('5 it reports no_phone_on_record', result.channels.sms === 'no_phone_on_record',
       'got ' + result.channels.sms);
    ok('5 nothing enqueued', enqueued.length === 0);
  }

  /* 6 — THE FOUR BLOCKED CALL SITES, from the 2026-09-30 live-lineage census.
     Each passes an SMS-templated type and supplies NO phone, so each sent nothing
     under the old gate. Asserted against the real source so the sites cannot drift
     away from the repair that unblocked them. Two are inside the live payment
     webhook, which is why this is not a cosmetic fix. */
  {
    const fs2 = require('fs'), path2 = require('path');
    const rd = (f) => fs2.readFileSync(path2.resolve(f), 'latin1');   /* latin1: payment-success.js holds a NUL */
    const SITES = [
      ['functions/payment-success.js', 'payment_success', 'customer'],
      ['functions/payment-success.js', 'payment_success', 'merchant'],
      ['functions/index.js',           'payment_success', 'webhookIntasend buyer'],
      ['functions/index.js',           'order_placed',    'webhookIntasend seller'],
    ];
    const seen = {};
    for (const [f, ty, who] of SITES) {
      const src = seen[f] || (seen[f] = rd(f));
      ok(`6 ${who}: ${ty} call site still present`,
         new RegExp(`type:\\s*['"]${ty}['"]`).test(src));
    }
    /* Scoped to _notifyBoth, which holds both notify() calls. A whole-file scan is
       wrong here: the receipt written at line ~120 legitimately carries
       `customer: { phone: p.phone }` from the payment record. That number is
       payment-supplied and unverified, and the point is precisely that it is NOT
       handed to notify() — so it never becomes an SMS recipient. */
    {
      const ps = seen['functions/payment-success.js'];
      const i = ps.indexOf('async function _notifyBoth');
      const j = ps.indexOf('exports.onPaymentSucceeded');
      const fn = i !== -1 && j > i ? ps.slice(i, j) : '';
      ok('6 control — _notifyBoth was isolated', /notifyFn\(\{/.test(fn));
      ok('6 neither payment notify call supplies a caller phone', !/[\s,{]phone:/.test(fn));
      ok('6 control — the unverified receipt phone is elsewhere in the file, untouched',
         /phone: p\.phone \|\| null/.test(ps) && !/phone: p\.phone/.test(fn));
    }

    /* The gate itself: `phone` must no longer be a precondition.

       Asserted against EXECUTABLE CODE, not raw source. A source-text scan gave a false
       failure here on 2026-09-30: the repair's own explanatory comment quotes the old
       gate verbatim while describing why it was wrong, so `!/…&& phone/.test(src)` was
       false even though the code was correct. A comment that documents a defect must not
       read as the defect. Comments and strings are stripped before matching. */
    const nRaw = rd('functions/notify.js');
    const n = stripComments(nRaw);
    ok('6 the SMS gate no longer requires a caller phone',
       /if \(wantSms && t\.smsTemplate\) \{/.test(n) &&
       !/wantSms && t\.smsTemplate && phone/.test(n));
    ok('6 the canonical field is what is resolved',
       /\.collection\('users'\)\.doc\(uid\)[\s\S]{0,160}?phoneNumber/.test(n));
    ok('6 the legacy `phone` field is still not read',
       !/\(\)\s*\|\|\s*\{\}\)\.phone\b/.test(n));
    /* CONTROL — the stripper must actually remove prose, or the fix above is vacuous */
    ok('6 control — comment prose is stripped before matching',
       /wantSms && t\.smsTemplate && phone/.test(nRaw) !==
       /wantSms && t\.smsTemplate && phone/.test(n) ||
       !/wantSms && t\.smsTemplate && phone/.test(nRaw),
       'raw mentions it in prose; code does not');

    /* policy must be untouched by this repair */
    ok('6 wantSms is unchanged',
       /const wantSms = ch\.sms \|\| \(ch\.smsFallback && !pushOk\);/.test(n));
    ok('6 the dedupe key is unchanged', /dedupeKey: `sms:\$\{key\}`/.test(n));
    ok('6 the provider seam is untouched',
       /atSendSMS\(/.test(rd('functions/sms-service.js')));

    /* CONTROL — these detectors can fail */
    ok('6 control — the old gate pattern is detectable',
       /wantSms && t\.smsTemplate && phone/.test('if (wantSms && t.smsTemplate && phone) {'));
  }

  console.log('='.repeat(62));
  console.log('  passed ' + PASS + '   failed ' + FAIL);
  if (FAILURES.length) FAILURES.forEach((f) => console.log('   ✗ ' + f));
  console.log(FAIL === 0
    ? '\n  SMS RECIPIENT RESOLUTION: GREEN'
    : '\n  SMS RECIPIENT RESOLUTION: RED');
  console.log('  Proves eligibility resolution only. NOT delivery, and not the');
  console.log('  86% of users with no phone number on record.\n');
  process.exit(FAIL === 0 ? 0 : 1);
})().catch((e) => {
  console.error('\n  HARNESS CRASHED — ' + (e && e.stack ? e.stack.split('\n')[0] : e));
  process.exit(1);
});
