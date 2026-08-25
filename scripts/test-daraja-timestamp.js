#!/usr/bin/env node
/* Daraja STK timestamp — the bug that cost a sandbox attempt and an app audit.
 *
 * WHAT WENT WRONG
 * `Timestamp` is YYYYMMDDHHmmss in EAST AFRICA TIME, and the SAME value is
 * hashed into `Password` = base64(ShortCode + PassKey + Timestamp). The code
 * used `new Date().toISOString()`, which is ALWAYS UTC — three hours behind
 * Kenya. Safaricom could not reproduce the password and refused the request
 * with ResultCode 2001, "The initiator information is invalid" — an error whose
 * wording points at credentials, which is why it sent us auditing the passkey,
 * the consumer key/secret and the Daraja app, all of which were fine.
 *
 * EVIDENCE (2026-08-25 sandbox, checkout ws_CO_250820262212318708374149):
 * SOKONI generated the STK timestamp in UTC (20260825191232) while the
 * successful Daraja simulator establishes the expected sandbox request
 * behaviour; Daraja's own CheckoutRequestID for that call embeds 25082026221231
 * (22:12:31). The resulting 3-hour mismatch is consistent with the 2001 error.
 *
 * WHY THIS SUITE EXISTS
 * A test that only checked "is the timestamp 14 digits" would have PASSED
 * against the broken code — the UTC value was also 14 digits. So the assertions
 * below pin the ZONE, and pin the Password to the SAME timestamp that is sent
 * on the wire, which is the coupling that actually broke.
 *
 *   node scripts/test-daraja-timestamp.js
 */
'use strict';
const fs   = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

const ROOT = path.join(__dirname, '..');
const SRC  = fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8');

/* Extract the SHIPPED helper rather than reimplementing it — a copy would let
   the test and the code drift, which is exactly how three call sites ended up
   sharing one bug. */
const s = SRC.indexOf('const DARAJA_UTC_OFFSET_MS');
const e = SRC.indexOf('/* ── Helper: get Daraja OAuth access token ── */');
if (s < 0 || e < 0 || e < s) {
  console.log('  FAIL  could not locate the timestamp helper in functions/index.js');
  process.exit(1);
}
const BLOCK = SRC.slice(s, e);
const _darajaTimestamp = new Function(BLOCK + '; return _darajaTimestamp;')();

/* ══ A. The zone is EAT, not UTC ═════════════════════════════════════════ */
console.log('\nA. Timestamp is East Africa Time\n');
{
  /* The exact instant of the failed sandbox call. */
  const T = Date.parse('2026-08-25T19:12:32.182Z');
  const got = _darajaTimestamp(T);
  ck('the failing call would now stamp 20260825221232', got === '20260825221232', got);
  ck('  ...which is what Daraja recorded (CheckoutRequestID 25082026221231)',
     got.slice(0, 8) === '20260825' && got.slice(8, 12) === '2212');
  ck('  ...and NOT the UTC value that was rejected', got !== '20260825191232');

  const utc = new Date(T).toISOString().replace(/\D/g, '').slice(0, 14);
  const diffH = Number(got.slice(8, 10)) - Number(utc.slice(8, 10));
  ck('offset from UTC is exactly +3 hours', diffH === 3, diffH + 'h');
}
{
  /* Date rollover: 23:30 UTC is the NEXT day in Nairobi. A naive fix that only
     adjusted the hour would corrupt the date here. */
  const T = Date.parse('2026-03-14T23:30:00.000Z');
  const got = _darajaTimestamp(T);
  ck('rolls the DATE forward across midnight EAT', got === '20260315023000', got);
}
{
  /* EAT has no daylight saving. Same offset in both hemispherical summers —
     a timezone library that applied DST would break one of these. */
  const jul = _darajaTimestamp(Date.parse('2026-07-01T12:00:00.000Z'));
  const jan = _darajaTimestamp(Date.parse('2026-01-01T12:00:00.000Z'));
  ck('no DST shift in July', jul === '20260701150000', jul);
  ck('no DST shift in January', jan === '20260101150000', jan);
}
{
  ck('format is exactly 14 digits', /^\d{14}$/.test(_darajaTimestamp(Date.now())));
  ck('  (note: the BROKEN UTC value was also 14 digits — length alone proves nothing)',
     /^\d{14}$/.test(new Date().toISOString().replace(/\D/g, '').slice(0, 14)));
}

/* ══ B. Password is built from the SAME timestamp that is sent ═══════════ */
console.log('\nB. Password and Timestamp cannot diverge\n');
{
  /* Reproduce the documented construction and prove it round-trips. */
  const shortCode = '174379';
  const passKey   = 'x'.repeat(64);
  const ts        = _darajaTimestamp(Date.parse('2026-08-25T19:12:32.182Z'));
  const password  = Buffer.from(`${shortCode}${passKey}${ts}`).toString('base64');
  const decoded   = Buffer.from(password, 'base64').toString('utf8');
  ck('password decodes to shortCode + passKey + timestamp',
     decoded === shortCode + passKey + ts);
  ck('  ...and the embedded timestamp is the EAT one', decoded.endsWith('20260825221232'));
  ck('  ...not the UTC one', !decoded.endsWith('20260825191232'));
}
{
  /* Every call site must hash the SAME variable it sends. Assert on shipped
     source: the password line must reference `timestamp`, and the request body
     must send `Timestamp: timestamp`. */
  const sites = SRC.match(/const timestamp = _darajaTimestamp\(\);[\s\S]{0,400}?toString\("base64"\)/g) || [];
  ck('every call site derives its password from `timestamp`',
     sites.length === 3 && sites.every(b => /\$\{[A-Za-z]*[Ss]hortCode\}\$\{[A-Za-z]*[Pp]assKey\}\$\{timestamp\}/.test(b)),
     sites.length + ' sites');
  const bodies = SRC.match(/Timestamp:\s+timestamp,/g) || [];
  ck('the wire field sends that same variable', bodies.length >= 2, bodies.length + ' request bodies');
}

/* ══ C. No raw UTC construction survives anywhere ════════════════════════ */
console.log('\nC. The old construction is gone\n');
{
  const raw = SRC.match(/new Date\(\)\.toISOString\(\)\.replace\(\/\\D\/g, ""\)\.slice\(0, 14\)/g) || [];
  ck('zero raw UTC timestamp constructions remain', raw.length === 0, raw.length + ' found');
  ck('all three call sites use the helper',
     (SRC.match(/const timestamp = _darajaTimestamp\(\);/g) || []).length === 3);
  ck('the offset is a named constant, not a magic number',
     /const DARAJA_UTC_OFFSET_MS = 3 \* 60 \* 60 \* 1000;/.test(SRC));
  /* Negative control — the detector must be able to see the old shape. */
  const broken = 'const timestamp = new Date().toISOString().replace(/\\D/g, "").slice(0, 14);';
  ck('negative control: detector DOES flag the old construction',
     /new Date\(\)\.toISOString\(\)\.replace\(\/\\D\/g, ""\)\.slice\(0, 14\)/.test(broken));
}

/* ══ D. Request fields match the successful simulator call ═══════════════ */
console.log('\nD. Request shape matches the successful Daraja simulator parameters\n');
{
  /* Simulator succeeded with: shortcode 174379, PartyA 254708374149, Amount 1,
     PartyB 174379. Assert SOKONI builds the same shape. */
  const test = SRC.slice(SRC.indexOf('exports.sendTestSTKPush'), SRC.indexOf('SOKONI REVENUE ENGINE'));
  ck('BusinessShortCode = the configured shortcode', /BusinessShortCode: darajaShortCode,/.test(test));
  ck('PartyB = the same shortcode (as the simulator used)', /PartyB: darajaShortCode,/.test(test));
  ck('PartyA = the customer MSISDN', /PartyA: phone,/.test(test));
  ck('PhoneNumber = the same MSISDN', /PhoneNumber: phone,/.test(test));
  ck('Amount = 1 for the test push', /Amount: 1,/.test(test));
  ck('TransactionType comes from config (CustomerPayBillOnline for a paybill)',
     /TransactionType: darajaTransactionType,/.test(test));
  ck('endpoint is the STK processrequest path', /mpesa\/stkpush\/v1\/processrequest/.test(test));
  ck('sandbox base host is chosen by env, not hardcoded',
     /env === "production"[\s\S]{0,120}?sandbox\.safaricom\.co\.ke/.test(SRC));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
