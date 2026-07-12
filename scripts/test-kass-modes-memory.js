#!/usr/bin/env node
/**
 * test-kass-modes-memory.js
 *
 * Guards two things that break quietly:
 *   1. Automatic expert-mode routing — the user must never have to pick a mode,
 *      and intent (selling) must beat subject matter (a phone).
 *   2. The memory PRIVACY ALLOWLIST — the schema is the privacy policy. If a
 *      field can be stored that shouldn't be, that is a data-protection defect,
 *      not a style issue. This test fails the build for it.
 */
'use strict';
const path = require('path');
const { detect } = require(path.resolve('functions/kass-modes.js'));
const { ALLOWED } = require(path.resolve('functions/kass-memory.js'));

let pass = 0, fail = 0;
const ok  = m => { pass++; console.log('  pass  ' + m); };
const bad = m => { fail++; console.error('  FAIL  ' + m); };

/* ── 1. Expert modes ─────────────────────────────────────────────────────── */
console.log('\nAutomatic expert-mode routing\n');

const ROUTES = [
  ['Nataka kuuza simu.',            'merchant',  'selling verb must beat the product noun'],
  ['I want to buy a phone',         'shopping',  ''],
  ['My listings are not selling',   'merchant',  'plural/-ing forms must still route'],
  ['my stock keeps running out',    'inventory', 'stock is inventory, not shopping'],
  ['Delivery itafika leo?',         'logistics', ''],
  ['Payment imekwama',              'payments',  ''],
  ['How do I get a KRA PIN?',       'kenya',     ''],
  ['natafuta nyumba ya kukodi',     'property',  ''],
  ['natafuta kazi',                 'jobs',      ''],
  ['hi',                            'concierge', 'no signal must NOT force a mode'],
  ['asdfgh qwerty',                 'concierge', 'noise must not route'],
];

for (const [q, expect, why] of ROUTES) {
  const got = detect(q).key;
  got === expect
    ? ok(`"${q}" → ${got}${why ? '  (' + why + ')' : ''}`)
    : bad(`"${q}" → ${got}, expected ${expect}${why ? '  — ' + why : ''}`);
}

/* ── 2. Memory privacy boundary ──────────────────────────────────────────── */
console.log('\nMemory privacy allowlist\n');

/* These must NEVER be storable. If someone adds one to ALLOWED, this fails —
   which is the entire point. Free text and identifiers are where PII hides. */
const FORBIDDEN = [
  'messages', 'transcript', 'history', 'conversation',
  'phone', 'phoneNumber', 'msisdn', 'email', 'address', 'street',
  'idNumber', 'nationalId', 'passport', 'kraPin',
  'card', 'cardNumber', 'cvv', 'pin', 'password', 'token',
  'paymentStatus', 'orderStatus', 'walletBalance',
  'health', 'medical', 'legal',
];

for (const f of FORBIDDEN) {
  ALLOWED.has(f)
    ? bad(`"${f}" is in the memory allowlist — PII / transcript / live-state must never be stored`)
    : null;
}
if (!FORBIDDEN.some(f => ALLOWED.has(f))) ok(`none of ${FORBIDDEN.length} forbidden fields are storable`);

/* Memory must not hold live financial/order state — it is convenience, not authority. */
const stateish = [...ALLOWED].filter(f => /status|balance|payment|order|refund/i.test(f));
stateish.length
  ? bad(`allowlist contains live-state fields: ${stateish.join(', ')} — these must be read from a tool, never remembered`)
  : ok('no live payment/order state is remembered (must always be read live)');

/* The allowlist must stay small. Scope creep here is how a preference store
   quietly becomes a profile. */
ALLOWED.size <= 10
  ? ok(`allowlist is small (${ALLOWED.size} fields) — scope creep is how a preference store becomes surveillance`)
  : bad(`allowlist has grown to ${ALLOWED.size} fields — justify each one`);

console.log('');
if (fail) { console.error(`KASS modes/memory FAILED (${fail} problem${fail > 1 ? 's' : ''})\n`); process.exit(1); }
console.log(`KASS modes/memory PASSED (${pass} checks)\n`);
