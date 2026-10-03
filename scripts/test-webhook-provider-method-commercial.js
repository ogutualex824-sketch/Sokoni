#!/usr/bin/env node
'use strict';
/* commercial-fn copy of webhookIntasend: the payment METHOD is what IntaSend reported (owner 2026-10-03)
     M1  the providerMethod expression is byte-identical to sokoni-5b's 525fd9f (one rule on both lineages)
     M2  behaviour: invoice.provider wins over body.provider; trimmed; control chars stripped; capped at 40; absent/blank → null
     M3  no hard-coded method is written anywhere inside webhookIntasend ("M-PESA", "mpesa_intasend"); every
         paymentMethod there is providerMethod (Quick Charge, buyer receipt, merchant receipt, marketplace order)
   node scripts/test-webhook-provider-method-commercial.js */
const fs = require('fs'), path = require('path'), cp = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const IX = fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok || d === undefined ? '' : '  -> ' + JSON.stringify(d).slice(0, 200))); ok ? pass++ : fail++; };

const start = IX.indexOf('exports.webhookIntasend = onRequest(');
const nextExport = IX.indexOf('\nexports.', start + 10);
const H = IX.slice(start, nextExport);
const defRe = /    const providerMethod = \(\(\) => \{[\s\S]*?\}\)\(\);/;
const mine = (H.match(defRe) || [])[0];
let theirs = null;
try { theirs = (cp.execSync('git show 525fd9f:functions/index.js', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).toString().match(defRe) || [])[0]; } catch (_) {}
ck('M1 providerMethod definition byte-identical to 5b\'s 525fd9f', !!mine && mine === theirs, theirs ? 'differs' : '525fd9f not readable');

const run = (invoice, body) => new Function('invoice', 'req', mine.replace('const providerMethod =', 'return'))(invoice, { body });
ck('M2 invoice.provider wins; raw kept; trimmed; control chars stripped; capped 40; absent / blank → null',
  run({ provider: ' CARD-PAYMENT ' }, { provider: 'M-PESA' }) === 'CARD-PAYMENT' && run({}, { provider: 'PESALINK' }) === 'PESALINK'
  && run({ provider: 'M-PE\u0007SA' }, {}) === 'M-PESA' && run({ provider: 'x'.repeat(60) }, {}).length === 40
  && run({}, {}) === null && run({ provider: '   ' }, {}) === null && run({ provider: null }, {}) === null);

const literals = H.match(/paymentMethod:\s*"(?:M-PESA|mpesa_intasend|mpesa)"/g) || [];
const all = H.match(/paymentMethod:\s*[^,\n]+/g) || [];
ck('M3 no hard-coded method inside webhookIntasend; every paymentMethod is providerMethod',
  literals.length === 0 && all.length >= 4 && all.every((m) => /paymentMethod:\s*providerMethod\b/.test(m)), { literals, all });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
