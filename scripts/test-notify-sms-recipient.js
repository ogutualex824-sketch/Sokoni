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
