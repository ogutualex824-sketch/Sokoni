'use strict';
/* shared/intasend-status.js — the one way to ask IntaSend for a collection's state. Fake fetch; no network.
     node scripts/test-intasend-status.js */
const path = require('path');
const { intasendCollectionStatus: S } = require(path.join(__dirname, '..', 'functions', 'shared', 'intasend-status.js'));
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got) + ']')); ok ? pass++ : fail++; };
const calls = [];
const fake = (status, body) => async (url, opt) => { calls.push({ url, auth: opt && opt.headers && opt.headers.Authorization }); return { ok: status === 200, status, json: async () => body }; };
(async () => {
  console.log('\nIntaSend collection status\n');
  let r = await S('INV123', { privateKey: 'k_live', fetchImpl: fake(200, { results: [{ invoice_id: 'X' }, { invoice_id: 'INV123', state: 'complete', value: '1000', net_amount: '970', charges: '30', currency: 'KES', api_ref: 'DON_PLG_a' }] }) });
  ck('S-1', r.ok && r.found && r.state === 'COMPLETE' && r.value === 1000 && r.net_amount === 970 && r.charges === 30 && r.currency === 'KES' && r.api_ref === 'DON_PLG_a', 'the matching record: state + gross/net/charges/currency/api_ref', r);
  ck('S-2', calls[0].url === 'https://payment.intasend.com/api/v1/payment/collection/?invoice_id=INV123' && calls[0].auth === 'Token k_live', 'the same endpoint + Token auth as the live verifyIntasendPayment call', calls[0]);
  r = await S('INV9', { privateKey: 'k', live: false, fetchImpl: fake(200, { results: [] }) });
  ck('S-3', r.ok && r.found === false && /sandbox\.intasend\.com/.test(calls[1].url), 'not found is a real answer (ok, found:false); sandbox base when live:false', r);
  r = await S('INV1', { privateKey: 'k', fetchImpl: fake(401, {}) });
  ck('S-4', !r.ok && r.error === 'HTTP_401', 'an HTTP failure is reported, never a state', r);
  r = await S('INV1', { privateKey: 'k', fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  ck('S-5', !r.ok && r.error === 'NETWORK', 'a network error is reported, never a state', r);
  r = await S('INV1', { privateKey: '', fetchImpl: fake(200, {}) });
  ck('S-6', !r.ok && r.error === 'NO_KEY', 'no key → refused before any call', r);
  r = await S('../x', { privateKey: 'k', fetchImpl: fake(200, {}) });
  ck('S-7', !r.ok && r.error === 'BAD_REF', 'a malformed ref is refused before any call', r);
  r = await S('INV1', { privateKey: 'k', fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }) });
  ck('S-8', !r.ok && r.error === 'BAD_RESPONSE', 'an unparseable body is reported', r);
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
