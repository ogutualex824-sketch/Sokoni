#!/usr/bin/env node
/* STK MSISDN safety gate — engineering only. Sends NO STK push.
 *
 * Scope: the three fixes ported onto the live lineage (b223635).
 * payment-destinations.js / checkout-mode.js do NOT exist on this lineage, so
 * the production-authorisation proof is taken from PRODUCTION DATA, not code.
 *
 *   node scripts/test-stk-msisdn-safety.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail !== undefined ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};
const ROOT = path.join(__dirname, '..');
const IDX  = fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8');
/* Comment-stripped view: an assertion that a construct is GONE must not be
   defeated by the comment that explains its removal. */
const CODE = IDX.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* NO NETWORK. Any attempt to reach Safaricom during this gate is a failure, not
   a side effect — so fetch becomes a tripwire rather than being trusted. */
const networkCalls = [];
global.fetch = (u) => { networkCalls.push(String(u)); throw new Error('network blocked in gate'); };

const helper = (() => {
  const src  = IDX.slice(IDX.indexOf('function _normalizeMsisdn(raw) {'));
  const body = src.slice(0, src.indexOf('\n}') + 2);
  const ctx  = vm.createContext({ String });
  new vm.Script(body + '\nglobalThis.__n = _normalizeMsisdn;').runInContext(ctx);
  return ctx.__n;
})();

/* ══ A. Valid input -> correct normalised MSISDN ═══════════════════════════ */
console.log('\nA. Valid input normalises correctly\n');
{
  ck('exactly ONE definition of the helper', (IDX.split('function _normalizeMsisdn').length - 1) === 1);
  ck('all three STK sites use it', (IDX.split('_normalizeMsisdn(').length - 2) === 3,
     (IDX.split('_normalizeMsisdn(').length - 2) + ' call sites');
  const ok = [['0712345678','254712345678'],['+254712345678','254712345678'],
              ['254712345678','254712345678'],['712345678','254712345678'],
              ['0712 345 678','254712345678'],['0112345678','254112345678'],
              ['00254712345678','254712345678']];
  for (const pair of ok) ck(JSON.stringify(pair[0]).padEnd(18) + '-> ' + pair[1], helper(pair[0]) === pair[1], helper(pair[0]));
  ck('every accepted value is 254[17] + 8 digits', ok.every((p) => /^254[17]\d{8}$/.test(helper(p[0]))));
}

/* ══ B. Malformed input is REFUSED before anything is sent ════════════════ */
console.log('\nB. Malformed input -> invalid-argument\n');
{
  for (const bad of ['07123456789','071234567','','not-a-phone','0812345678','254','00'])
    ck('refused: ' + JSON.stringify(bad).padEnd(16), helper(bad) === null, JSON.stringify(helper(bad)));
  ck('refused: null / undefined', helper(null) === null && helper(undefined) === null);

  /* EXECUTED, not matched. A source regex passed even when the guard condition
     was replaced with `false` — proximity is not a guarantee, so run the guard. */
  const guard = (marker) => {
    const st = CODE.indexOf(marker);
    if (st < 0) return null;
    const seg = CODE.slice(st);
    return seg.slice(0, seg.indexOf('}', seg.indexOf('throw new HttpsError')) + 1);
  };
  const runGuard = (block, vars) => {
    const ctx = vm.createContext(Object.assign({
      _normalizeMsisdn: helper,
      HttpsError: function (code, msg) { this.code = code; this.message = msg; },
    }, vars));
    try { new vm.Script(block).runInContext(ctx); return 'ALLOWED'; }
    catch (e) { return e.code || ('THREW:' + e.message); }
  };

  const gA = guard('const normPhone = _normalizeMsisdn(phone);');
  ck('darajaSTKPush guard located', !!gA);
  ck('darajaSTKPush REFUSES a malformed number',
     runGuard(gA, { phone: '07123456789' }) === 'invalid-argument', runGuard(gA, { phone: '07123456789' }));
  ck('  ...refuses an empty number', runGuard(gA, { phone: '' }) === 'invalid-argument');
  ck('  ...and ALLOWS a valid one', runGuard(gA, { phone: '0712345678' }) === 'ALLOWED',
     runGuard(gA, { phone: '0712345678' }));
  ck('  ...the old unvalidated prepend is gone', !/normPhone = "254" \+ normPhone/.test(CODE));

  const gB = guard('const phone = _normalizeMsisdn(request.data?.phone);');
  ck('sendTestSTKPush guard located', !!gB);
  ck('sendTestSTKPush REFUSES a malformed number',
     runGuard(gB, { request: { data: { phone: '07123456789' } } }) !== 'ALLOWED',
     runGuard(gB, { request: { data: { phone: '07123456789' } } }));
  ck('  ...and ALLOWS a valid one',
     runGuard(gB, { request: { data: { phone: '0712345678' } } }) === 'ALLOWED');
}

/* ══ C. Ownership check, EXECUTED against fixtures ════════════════════════ */
console.log('\nC. Seller-phone ownership\n');
{
  const start = CODE.indexOf('const sellerPhone = _normalizeMsisdn');
  const seg   = CODE.slice(start);
  const mark  = 'registered phone number.");';
  const end   = seg.indexOf('}', seg.indexOf(mark)) + 1;   /* through the closing brace */
  const block = seg.slice(0, end);
  ck('the ownership block was located',
     block.includes('failed-precondition') && block.includes('permission-denied'));

  const run = (cfg, phone) => {
    const ctx = vm.createContext({
      _normalizeMsisdn: helper, cfg: cfg, phone: phone,
      HttpsError: function (code, msg) { this.code = code; this.message = msg; },
    });
    try { new vm.Script(block).runInContext(ctx); return 'ALLOWED'; }
    catch (e) { return e.code || ('THREW:' + e.message); }
  };

  ck('no stored phone           -> failed-precondition',
     run({}, '254712345678') === 'failed-precondition', run({}, '254712345678'));
  ck('unparseable stored phone  -> failed-precondition',
     run({ phone: 'n/a' }, '254712345678') === 'failed-precondition');
  ck('wrong-length stored phone -> failed-precondition',
     run({ phone: '07123456789' }, '254712345678') === 'failed-precondition');
  ck('mismatched seller phone   -> permission-denied',
     run({ phone: '0722000000' }, '254712345678') === 'permission-denied',
     run({ phone: '0722000000' }, '254712345678'));
  ck('MATCHING seller phone     -> ALLOWED to construct the request',
     run({ phone: '0712345678' }, '254712345678') === 'ALLOWED',
     run({ phone: '0712345678' }, '254712345678'));
  ck('  ...match works via ownerPhone too',
     run({ ownerPhone: '+254712345678' }, '254712345678') === 'ALLOWED');
  ck('the old fail-OPEN guard is gone',
     !/if \(sellerPhone && sellerPhone\.length === 12/.test(CODE));
}

/* ══ D. Nothing was sent ═══════════════════════════════════════════════════ */
console.log('\nD. No STK push was sent by this gate\n');
{
  const self = fs.readFileSync(__filename, 'utf8');
  ck('no network call attempted', networkCalls.length === 0, networkCalls.join(',') || 'none');
  ck('this suite names no Safaricom host', !/sandbox\.safaricom|api\.safaricom/.test(self));
  const stkPath = 'process' + 'request';   /* split so this check is not its own match */
  ck('  ...and no stkpush path', !self.includes(stkPath));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
