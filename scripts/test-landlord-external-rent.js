#!/usr/bin/env node
/* test-landlord-external-rent.js — B2 closure (owner 2026-10-01): rent is the landlord's money.
 *
 *   L1-L5  landlord.html never collects or confirms rent through a provider from the browser:
 *          no IntaSend inline SDK, no SokoniMpesa/Daraja call, no STK push, no timer that
 *          "confirms" a payment, no "Payment Confirmed"/"Rent collected" wording.
 *   E1-E8  buildExternalRentEntry (EXECUTED): records the landlord's own statement as
 *          paymentSource EXTERNAL / verification LANDLORD_RECORDED; refuses bad input rather
 *          than inventing an amount; the reference is sanitised.
 *   I1-I3  every rent/water/service-charge payment instruction states it is paid directly to
 *          the landlord/agency and not processed or verified by SOKONI; invoice WhatsApp sends
 *          keep their wa-allowed:invoice markers (WhatsApp for invoices stays allowed).
 *   N1-N2  negative controls.
 * Run: node scripts/test-landlord-external-rent.js
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
const L = fs.readFileSync(path.join(ROOT, 'landlord.html'), 'utf8');
let pass = 0, fail = 0;
const ck = (label, ok, got) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : '   [got ' + JSON.stringify(got) + ']')); ok ? pass++ : fail++; };
const code = L.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

console.log('\n── L: no browser-side rent collection or fake confirmation ──');
ck('L1 no IntaSend inline SDK is loaded', !/intasend-inlinejs-sdk/.test(code));
ck('L2 no browser provider call (new IntaSend / SokoniMpesa.pay / darajaSTKPush / sokoni-mpesa.js)', !/new window\.IntaSend|new IntaSend\(|SokoniMpesa\.pay|darajaSTKPush|sokoni-mpesa\.js/.test(code));
ck('L3 no STK wording or send-STK handler', !/sendRentStkPush|Send STK Push/.test(code));
/* the move-out checklist item "☐ Final rent payment confirmed" is a landlord's own tick-box, not a claim */
ck('L4 no fabricated confirmation copy', !/Payment Confirmed|Rent collected|collected via M-Pesa/i.test(code.replace('☐ Final rent payment confirmed', '')));
ck('L6 no SOKONI commission is taken on rent in the browser (rent is never SOKONI revenue)', !/_recordCommission|SOKONI_COMMISSION_RATE|sokoniCommissionLedger|recordCommission\(\{ type:"landlord_rent"/.test(code));
const rec = code.slice(code.indexOf('function recordRentReceived('), code.indexOf('window.openCollectRent'));
ck('L5 recording a payment uses no timer and no provider', rec.length > 100 && !/setTimeout|IntaSend|Mpesa\.pay|fetch\(/.test(rec), rec.length);

console.log('\n── E: buildExternalRentEntry, executed ──');
const bSrc = code.slice(code.indexOf('const RENT_CHANNELS'), code.indexOf('window.buildExternalRentEntry'));
const B = vm.runInNewContext(bSrc + '; buildExternalRentEntry;', {});
const ok = B('2026-10', '25000', 'mpesa_to_landlord', 'QJK4XYZ12A', '1/10/2026');
ck('E1 a valid record is EXTERNAL / LANDLORD_RECORDED with the entered amount', ok.ok && ok.entry.paymentSource === 'EXTERNAL' && ok.entry.verification === 'LANDLORD_RECORDED' && ok.entry.amount === 25000, ok);
ck('E2 it never claims SOKONI or provider verification', ok.ok && !/SOKONI|INTASEND|VERIFIED$/.test(ok.entry.paymentSource + ok.entry.verification), ok.entry);
ck('E3 zero / negative / non-numeric amount is refused (no invented figure)', ['0', '-5', 'abc', ''].every((a) => B('2026-10', a, 'cash', '', 'd').reason === 'bad_amount'));
ck('E4 an unknown channel is refused', B('2026-10', '100', 'intasend', '', 'd').reason === 'bad_channel');
ck('E5 a malformed month is refused', B('Oct', '100', 'cash', '', 'd').reason === 'bad_month');
const hostile = B('2026-10', '100', 'bank', '<img src=x onerror=1>"\'', 'd');
ck('E6 the reference is sanitised to [A-Za-z0-9 _-], max 40', hostile.ok && /^[A-Za-z0-9 _-]{0,40}$/.test(hostile.entry.ref), hostile.entry && hostile.entry.ref);
ck('E7 an inherited key is not a channel (hasOwnProperty)', B('2026-10', '100', 'toString', '', 'd').reason === 'bad_channel');
ck('E8 amounts are whole shillings', B('2026-10', '100.6', 'cash', '', 'd').entry.amount === 101);

console.log('\n── I: invoices say who is paid ──');
const NOTE = /not processed or verified by SOKONI/;
const lines = L.split(/\r?\n/);
const payLines = lines.map((l, i) => [l, i]).filter(([l]) => /(Pay via M-Pesa|Please pay via M-Pesa to|Pay to: \$\{)/.test(l));
const unlabelled = payLines.filter(([, i]) => !NOTE.test(lines.slice(Math.max(0, i - 1), i + 3).join('\n'))).map(([, i]) => i + 1);
ck('I1 every payment instruction is labelled as paid directly to the landlord/agency', payLines.length >= 6 && unlabelled.length === 0, { found: payLines.length, unlabelled });
ck('I2 invoice WhatsApp sends keep their wa-allowed:invoice marker (8 lines)', (L.match(/wa-allowed:invoice/g) || []).length >= 8, (L.match(/wa-allowed:invoice/g) || []).length);
ck('I3 the printed water bill escapes the landlord number', /Pay via M-Pesa: \$\{_esc\(prop\?\.phone/.test(L));

console.log('\n── N: negative controls ──');
ck('N1 the L4 detector fires on the old wording', /Payment Confirmed|Rent collected/i.test("btn.innerHTML = '✓ Payment Confirmed!'"));
ck('N2 an unlabelled instruction would be caught by I1', !NOTE.test('`Pay via M-Pesa: ${prop.phone}\\n`'));

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
