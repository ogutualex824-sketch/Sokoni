#!/usr/bin/env node
/* test-epra-pump-prices.js — the EPRA parser (functions/epra-pump-prices.js) against REAL page markup.
 * Fixture: scripts/fixtures/epra-pump-prices-2026-10-03.html, trimmed from https://www.epra.go.ke/pump-prices.
 *   P  parse: newest STARTED period, Nairobi Super/Diesel/Kerosene exactly as published, period dates returned
 *   T  time: a period dated in the future is not used until it starts
 *   S  shape: reordered columns still parse (header-located); a missing column / no table / old page → throw
 *   H  honesty: missing Nairobi fuel → throw (no fill-in); out-of-range prices refused; towns never invented
 *   W  wiring: index.js reads ONLY /pump-prices through this module; the ratio/regional fill-ins are gone
 *   Z  negative controls
 * Run: node scripts/test-epra-pump-prices.js
 */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const { parsePumpPrices } = require(path.join(ROOT, 'functions', 'epra-pump-prices.js'));
const FIX = fs.readFileSync(path.join(__dirname, 'fixtures', 'epra-pump-prices-2026-10-03.html'), 'utf8');
let pass = 0, fail = 0;
const ck = (l, ok, g) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok ? '' : '   [' + JSON.stringify(g) + ']')); ok ? pass++ : fail++; };
const throws = (fn) => { try { fn(); return null; } catch (e) { return e.message || String(e); } };
const OCT3 = Date.UTC(2026, 9, 3);

console.log('\n── P: parse the real page ──');
const r = parsePumpPrices(FIX, { now: OCT3 });
ck('P1 newest started period = 2026-08-15 .. 2026-09-14 (as EPRA published it)', r.period.from === '2026-08-15' && r.period.to === '2026-09-14', r.period);
ck('P2 Nairobi exactly as published: Super 214.03 · Diesel 217.86 · Kerosene 191.38', r.prices.super_petrol.nairobi === 214.03 && r.prices.diesel.nairobi === 217.86 && r.prices.kerosene.nairobi === 191.38, { s: r.prices.super_petrol.nairobi, d: r.prices.diesel.nairobi, k: r.prices.kerosene.nairobi });
ck('P3 other towns in the period parse too (Kwale, Nanyuki)', r.prices.super_petrol.kwale === 211.23 && r.prices.diesel.nanyuki === 220.83, { kwale: r.prices.super_petrol.kwale, nanyuki: r.prices.diesel.nanyuki });
ck('P4 the older period (2026-07-15) is NOT mixed in (Nairobi diesel 222.86 belongs to July)', r.prices.diesel.nairobi !== 222.86);

console.log('\n── T: time ──');
const future = FIX.replace('</tbody>', '<tr><td>15-10-2026</td><td>14-11-2026</td><td>Nairobi</td><td>199.00</td><td>201.00</td><td>180.00</td></tr></tbody>');
ck('T1 a period dated in the future is not used before it starts', parsePumpPrices(future, { now: OCT3 }).period.from === '2026-08-15');
const t2 = parsePumpPrices(future, { now: Date.UTC(2026, 9, 16) });
ck('T2 …and is used once it has started', t2.period.from === '2026-10-15' && t2.prices.super_petrol.nairobi === 199);

console.log('\n── S: shape ──');
const swapped = '<table><thead><tr><th>Town</th><th>Kerosene (IK)</th><th>To</th><th>Diesel (AGO)</th><th>From</th><th>Super (PMS)</th></tr></thead><tbody><tr><td>Nairobi</td><td>191.38</td><td>14-09-2026</td><td>217.86</td><td>15-08-2026</td><td>214.03</td></tr></tbody></table>';
let sw = null, swErr = null; try { sw = parsePumpPrices(swapped, { now: OCT3 }); } catch (e) { swErr = e.message; }
ck('S1 columns located by header text: a reordered table parses to the same prices', !!sw && sw.prices.super_petrol.nairobi === 214.03 && sw.prices.diesel.nairobi === 217.86 && sw.prices.kerosene.nairobi === 191.38, swErr);
ck('S2 a table missing the Kerosene column → throws (not a partial record)', !!throws(() => parsePumpPrices(swapped.replace(/<th>Kerosene \(IK\)<\/th>/, '<th>Notes</th>'), { now: OCT3 })));
ck('S3 no table at all → throws', !!throws(() => parsePumpPrices('<html><body><p>Pump Prices</p></body></html>', { now: OCT3 })));
ck('S4 the OLD page shape (prices in prose, no From/To/Town table) → throws', !!throws(() => parsePumpPrices('<html><body><h2>Maximum pump prices</h2><p>Super Petrol Nairobi 176.70, Diesel 163.41</p></body></html>', { now: OCT3 })));
ck('S5 garbage / empty input → throws', !!throws(() => parsePumpPrices('', { now: OCT3 })) && !!throws(() => parsePumpPrices(null, { now: OCT3 })));

console.log('\n── H: honesty ──');
const noKero = '<table><tr><th>From</th><th>To</th><th>Town</th><th>Super (PMS)</th><th>Diesel (AGO)</th><th>Kerosene (IK)</th></tr><tr><td>15-08-2026</td><td>14-09-2026</td><td>Nairobi</td><td>214.03</td><td>217.86</td><td>-</td></tr></table>';
const e1 = throws(() => parsePumpPrices(noKero, { now: OCT3 }));
ck('H1 Nairobi kerosene missing → THROWS (the old parser invented it from a ratio)', !!e1 && /Nairobi/.test(e1), e1);
const crazy = noKero.replace('<td>-</td>', '<td>1910.38</td>');
ck('H2 an out-of-range price (1910.38) is refused, not "corrected" → throws', !!throws(() => parsePumpPrices(crazy, { now: OCT3 })));
ck('H3 towns that are not in the table never appear (no regional fill-ins)', !('thika' in r.prices.super_petrol) && Object.keys(r.prices.super_petrol).every((k) => /^(nairobi|mombasa|kisumu|nakuru|eldoret|kwale|nanyuki)$/.test(k)), Object.keys(r.prices.super_petrol));
ck('H4 every returned price is inside 80–600 KES/litre', ['super_petrol', 'diesel', 'kerosene'].every((f) => Object.values(r.prices[f]).every((n) => n >= 80 && n <= 600)));

console.log('\n── W: wiring ──');
const IDX = fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8');
const sec = IDX.slice(IDX.indexOf('EPRA / ERC FUEL PRICE SCRAPER'), IDX.indexOf('exports.triggerEPRAFuelFetch'));
const secCode = sec.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
ck('W1 the scraper reads ONLY /pump-prices (the 404 category URLs are gone)', /https:\/\/www\.epra\.go\.ke\/pump-prices/.test(secCode) && !/maximum-pump-prices/.test(secCode));
ck('W2 parsing goes through epra-pump-prices.js', /require\("\.\/epra-pump-prices"\)/.test(sec) && /parsePumpPrices\(/.test(sec));
ck('W3 the invented-price machinery is gone (REGION_DIFFS, DIESEL_RATIO, KERO_RATIO, _parseEPRAHtml)', !/REGION_DIFFS|DIESEL_RATIO|KERO_RATIO|_parseEPRAHtml/.test(IDX));
ck('W4 the record carries the published period (effectiveFrom / effectiveTo)', /effectiveFrom:\s+period\.from/.test(sec) && /effectiveTo:\s+period\.to/.test(sec));
ck('W5 a failed run still keeps the last real prices (only scraperStatus/scraperError are written on failure)', /scraperStatus:\s+"failed"/.test(sec) && /Don't overwrite existing prices on failure/.test(sec));
ck('W6 the refresh callable still requires sign-in', /triggerEPRAFuelFetch[\s\S]{0,300}if \(!request\.auth\) throw new HttpsError\("unauthenticated"/.test(IDX));

console.log('\n── Z: negative controls ──');
ck('Z1 the fixture really is the real markup (Drupal views table id="datatable")', /id="datatable"/.test(FIX) && /views-field-field-from/.test(FIX));
ck('Z2 the fixture really contains the July period P4 must exclude', /15-07-2026/.test(FIX));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
