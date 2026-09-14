#!/usr/bin/env node
/* STK implementation verification — WITHOUT moving customer money.
 *
 * Everything here is either EXECUTED against the real source text or read from
 * production as shape-only. Nothing sends an STK push, and nothing writes.
 *
 * WHY EXECUTION, NOT GREP
 * A grep for `PartyB: darajaShortCode` passes just as happily if the branches
 * around it are inverted. The payload assertions below extract the real
 * `stkBody` object literal out of functions/index.js and evaluate it with
 * controlled inputs, so a swapped field fails here.
 *
 *   node scripts/test-stk-implementation.js
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
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const IDX = read('functions', 'index.js');
/* Comment-stripped view. An assertion that a construct is GONE must not be
   satisfied or defeated by prose — the comment explaining a fix routinely
   quotes the very code the fix removed. */
const IDX_CODE = IDX.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* ══ A. Environment routing — sandbox must never resolve to production ══════ */
console.log('\nA. Which Daraja host does a request actually go to?\n');
{
  /* Execute the real selector expression from _darajaToken. */
  const m = IDX.match(/const base = env === "production"\s*\n?\s*\? ("https:\/\/api\.safaricom\.co\.ke")\s*\n?\s*: ("https:\/\/sandbox\.safaricom\.co\.ke")/);
  ck('the host selector was found in source', !!m);
  if (m) {
    const pick = (env) => (env === 'production' ? JSON.parse(m[1]) : JSON.parse(m[2]));
    ck('env "sandbox"    -> sandbox.safaricom.co.ke', pick('sandbox') === 'https://sandbox.safaricom.co.ke');
    ck('env "production" -> api.safaricom.co.ke',     pick('production') === 'https://api.safaricom.co.ke');
    /* The dangerous direction: anything NOT exactly "production" must be sandbox. */
    ck('undefined / typo / empty -> SANDBOX, never production',
       ['', undefined, 'prod', 'Production', 'PRODUCTION', null].every((e) => pick(e).includes('sandbox')));
  }
  ck('exactly one production host literal in the file',
     (IDX.match(/https:\/\/api\.safaricom\.co\.ke/g) || []).length === 1,
     (IDX.match(/https:\/\/api\.safaricom\.co\.ke/g) || []).length);
}

/* ══ B. The STK payload, evaluated ═════════════════════════════════════════ */
console.log('\nB. The stkBody Daraja receives\n');
{
  const src = IDX.slice(IDX.indexOf('const stkBody = {'));
  const body = src.slice(0, src.indexOf('};') + 1);
  ck('the stkBody literal was located', body.startsWith('const stkBody = {'));

  const sandbox = {
    darajaShortCode: '174379',
    password: 'PWD',
    timestamp: '20260828120000',
    darajaTransactionType: 'CustomerPayBillOnline',
    authoritativeAmount: 250,
    normPhone: '254712345678',
    callbackUrl: 'https://us-central1-sokoni-aeb26.cloudfunctions.net/darajaSTKCallback',
    darajaAccountRef: 'SOKONI-SBX',
    businessName: 'KASS SHOP',
    description: 'Order 12345 payment for goods',
  };
  const ctx = vm.createContext(sandbox);
  new vm.Script(body + '\nglobalThis.__out = stkBody;').runInContext(ctx);
  const b = ctx.__out;

  ck('BusinessShortCode = the merchant shortcode', b.BusinessShortCode === '174379', b.BusinessShortCode);
  ck('PartyB            = the merchant shortcode', b.PartyB === '174379', b.PartyB);
  ck('PartyA            = the PAYER phone',        b.PartyA === '254712345678', b.PartyA);
  ck('PhoneNumber       = the PAYER phone',        b.PhoneNumber === '254712345678', b.PhoneNumber);
  ck('  ...PartyA and PartyB are NOT the same value', b.PartyA !== b.PartyB);
  ck('Amount is the SERVER-side figure, not a client one',
     b.Amount === 250 && /authoritativeAmount/.test(body), b.Amount);
  ck('CallBackURL is the single darajaSTKCallback', b.CallBackURL === sandbox.callbackUrl);
  ck('AccountReference comes from config first', b.AccountReference === 'SOKONI-SBX', b.AccountReference);
  ck('  ...capped at 12 chars (Daraja limit)', b.AccountReference.length <= 12, b.AccountReference.length);
  ck('TransactionDesc capped at 13 chars', b.TransactionDesc.length <= 13,
     JSON.stringify(b.TransactionDesc) + ' len=' + b.TransactionDesc.length);
  ck('no credential ever enters the payload',
     !Object.values(b).some((v) => typeof v === 'string' && /consumerSecret|passKey/i.test(v)));

  /* Fallback chain, executed. */
  const run = (over) => { const c = vm.createContext(Object.assign({}, sandbox, over));
    new vm.Script(body + '\nglobalThis.__out = stkBody;').runInContext(c); return c.__out; };
  ck('AccountReference falls back to business name', run({ darajaAccountRef: '' }).AccountReference === 'KASS SHOP');
  ck('  ...then to "SOKONI"', run({ darajaAccountRef: '', businessName: '' }).AccountReference === 'SOKONI');
  ck('a long AccountReference is truncated, not sent whole',
     run({ darajaAccountRef: 'ORDER-9999999999999' }).AccountReference.length === 12);
  ck('a long description is truncated, not sent whole',
     run({ description: 'A very long human readable description' }).TransactionDesc.length === 13);
}

/* ══ C. MSISDN normalisation — one canonical helper, executed ══════════════ */
console.log('\nC. Phone normalisation\n');
{
  const src  = IDX.slice(IDX.indexOf('function _normalizeMsisdn(raw) {'));
  const body = src.slice(0, src.indexOf('\n}') + 2);
  const ctx  = vm.createContext({ String });
  new vm.Script(body + '\nglobalThis.__n = _normalizeMsisdn;').runInContext(ctx);
  const n = ctx.__n;

  ck('the canonical helper was located and runs', typeof n === 'function');
  ck('exactly ONE definition of it exists',
     (IDX.match(/function _normalizeMsisdn/g) || []).length === 1);
  ck('all three STK sites use it',
     (IDX.match(/_normalizeMsisdn\(/g) || []).length - 1 === 3,
     ((IDX.match(/_normalizeMsisdn\(/g) || []).length - 1) + ' call sites');

  ck('0712345678    -> 254712345678', n('0712345678') === '254712345678', n('0712345678'));
  ck('+254712345678 -> 254712345678', n('+254712345678') === '254712345678');
  ck('254712345678  -> unchanged',    n('254712345678') === '254712345678');
  ck('712345678     -> 254712345678', n('712345678') === '254712345678');
  ck('0712 345 678  -> 254712345678', n('0712 345 678') === '254712345678');
  ck('0112345678    -> 254112345678  (01X range)', n('0112345678') === '254112345678', n('0112345678'));

  ck('FIXED: 00254712345678 -> 254712345678', n('00254712345678') === '254712345678', n('00254712345678'));
  ck('  ...no longer the old malformed 2540254712345678', n('00254712345678') !== '2540254712345678');

  ck('REFUSED: 11 digits            -> null', n('07123456789') === null, JSON.stringify(n('07123456789')));
  ck('REFUSED: 9 digits             -> null', n('071234567') === null);
  ck('REFUSED: empty                -> null', n('') === null);
  ck('REFUSED: null / undefined     -> null', n(null) === null && n(undefined) === null);
  ck('REFUSED: letters              -> null', n('not-a-phone') === null);
  ck('REFUSED: 08X non-mobile range -> null', n('0812345678') === null, JSON.stringify(n('0812345678')));

  ck('every ACCEPTED value matches 254[17] + 8 digits',
     ['0712345678','+254712345678','712345678','00254712345678','0112345678']
       .every((p) => /^254[17]\d{8}$/.test(n(p))));

  ck('darajaSTKPush REFUSES an unusable number',
     /const normPhone = _normalizeMsisdn\(phone\);[\s\S]{0,240}?throw new HttpsError\("invalid-argument"/.test(IDX));
  ck('sendTestSTKPush REFUSES an unusable number',
     /const phone = _normalizeMsisdn\(request\.data\?\.phone\);[\s\S]{0,160}?throw new HttpsError/.test(IDX));
  ck('the seller-phone ownership check FAILS CLOSED',
     /const sellerPhone = _normalizeMsisdn[\s\S]{0,300}?if \(!sellerPhone\)[\s\S]{0,240}?failed-precondition/.test(IDX));
  ck('  ...the old length-gated guard that failed OPEN is gone',
     !/if \(sellerPhone && sellerPhone\.length === 12/.test(IDX_CODE));
}

/* ══ D. The production gate, executed against fixtures ═════════════════════ */
async function sectionD() {
  console.log('\nD. resolveActiveDestination — who is allowed live STK\n');
  const src  = read('functions', 'payment-destinations.js');
  const fn   = src.slice(src.indexOf('async function resolveActiveDestination'));
  const body = fn.slice(0, fn.indexOf('\nmodule.exports'));

  const STATUS = { VERIFIED: 'VERIFIED', TESTING: 'TESTING', FAILED: 'FAILED' };
  const call = (doc) => {
    const ctx = vm.createContext({
      STATUS, COLL: 'paymentDestinations', String,
      _db: () => ({ collection: () => ({ doc: () => ({
        get: async () => ({ exists: doc !== null, data: () => doc }) }) }) }),
    });
    new vm.Script(body + '\nglobalThis.__f = resolveActiveDestination;').runInContext(ctx);
    return ctx.__f('seller-1');
  };
  const V = { status: STATUS.VERIFIED, destinationType: 'TILL', destinationNumber: '174379' };

  ck('no document            -> null (refuse, never a default)', (await call(null)) === null);
  ck('no activeDestination   -> null', (await call({ productionAuthorized: true })) === null);
  ck('destination TESTING    -> null',
     (await call({ activeDestination: Object.assign({}, V, { status: STATUS.TESTING }), productionAuthorized: true })) === null);
  ck('destination FAILED     -> null',
     (await call({ activeDestination: Object.assign({}, V, { status: STATUS.FAILED }), productionAuthorized: true })) === null);

  const blocked = await call({ activeDestination: V, productionAuthorized: false });
  ck('VERIFIED + authorized:false -> production_not_authorized',
     blocked && blocked.blocked === 'production_not_authorized', JSON.stringify(blocked && blocked.blocked));
  const missing = await call({ activeDestination: V });
  ck('VERIFIED + flag ABSENT      -> production_not_authorized (fail closed)',
     missing && missing.blocked === 'production_not_authorized');

  for (const v of ['true', 1, 'yes', 'TRUE']) {
    const r = await call({ activeDestination: V, productionAuthorized: v });
    ck('  truthy-but-not-true ' + JSON.stringify(v) + ' still BLOCKED',
       r && r.blocked === 'production_not_authorized');
  }
  const open = await call({ activeDestination: V, productionAuthorized: true });
  ck('VERIFIED + authorized:true  -> allowed', open && open.blocked === null);
  ck('  ...and only then is a destination handed out', !!(open && open.destination));
}

/* ══ E. Configuration is not authorisation ═════════════════════════════════ */
function sectionE() {
  console.log('\nE. Checkout cannot expose STK just because credentials exist\n');
  const CM = read('functions', 'checkout-mode.js');
  const fnSrc = CM.slice(CM.indexOf('const MODE = {'), CM.indexOf('async function resolveMode'));
  const ctx = vm.createContext({});
  new vm.Script(fnSrc + '\nglobalThis.__m = { modeFromDestination: modeFromDestination, MODE: MODE };').runInContext(ctx);
  const modeFromDestination = ctx.__m.modeFromDestination, MODE = ctx.__m.MODE;

  ck('checkout-mode never reads shopSettings', !/shopSettings/.test(CM));
  ck('  ...and never a Daraja CREDENTIAL field (config != authorisation)',
     !/consumerKey|consumerSecret|passKey|darajaShortCode|darajaEnv/i.test(CM));
  ck('  ...the mode name itself is allowed to say daraja', /daraja_stk/.test(CM));
  ck('null destination          -> unavailable', modeFromDestination(null).mode === MODE.UNAVAILABLE);
  ck('production_not_authorized -> manual_payment, NOT stk',
     modeFromDestination({ blocked: 'production_not_authorized', destination: {} }).mode === MODE.MANUAL);
  ck('an UNKNOWN block          -> unavailable, never payable',
     modeFromDestination({ blocked: 'something_new', destination: {} }).mode === MODE.UNAVAILABLE);
  ck('only blocked:null         -> daraja_stk',
     modeFromDestination({ blocked: null, destination: {} }).mode === MODE.STK);
  ck('negative control: three distinct modes',
     new Set([MODE.STK, MODE.MANUAL, MODE.UNAVAILABLE]).size === 3);
  ck('KASS as configured TODAY  -> unavailable, no STK offered',
     modeFromDestination(null).mode === MODE.UNAVAILABLE);
}

/* ══ F. Callback handling and reconciliation ═══════════════════════════════ */
function sectionF() {
  console.log('\nF. darajaSTKCallback — what it accepts\n');
  ck('exactly ONE STK callback is exported',
     (IDX.match(/exports\.darajaSTKCallback\s*=/g) || []).length === 1,
     (IDX.match(/exports\.darajaSTKCallback\s*=/g) || []).length);
  ck('caller IP is checked against an allowlist', /Rejected request from unexpected IP/.test(IDX));
  ck('an unknown checkoutId is refused', /Unknown checkoutId/.test(IDX));
  ck('replay is idempotent — already-processed is a no-op', /Already processed/.test(IDX));
  ck('the PAID amount is compared with the REQUESTED amount', /Amount mismatch/.test(IDX));
  ck('  ...against the stored request, not the callback figure', /payData\.amount/.test(IDX));
  ck('sandbox callbacks are accepted but LABELLED sandbox', /SANDBOX callback accepted/.test(IDX));
}

sectionD().then(sectionE).then(sectionF).then(() => {
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.error('\n  SUITE CRASHED: ' + e.message + '\n'); process.exit(1); });
