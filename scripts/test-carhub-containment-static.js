#!/usr/bin/env node
/* test-carhub-containment-static.js — Car Hub containment (2026-10-03), static (no browser, no network).
 *   R  car-rental.html: registry (SokoniProviders car-rental) + the ONE booking engine; no hard-coded cars, no browser
 *      STK push / amount / reference, no false "deposit confirmed", no carRentals second-app write, no invented stats,
 *      prices, reviews or "insurance included"
 *   M  mechanics.html: escaped listing, no invented 5★ / jobs / years, no raw tel:, booking = SokoniBookService for an
 *      account uid only, ask = SokoniLeads, register / sell parts = HubRegister (the ONE intake), repairs = My Bookings,
 *      no localStorage listings/bookings, no waConnect / 'plumbing'
 *   A  sokoni-providers.js: car-rental + mechanic category aliases
 *   Z  negative controls against f799841 (the pre-containment tree)
 * Run: node scripts/test-carhub-containment-static.js
 */
'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process');
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ck = (l, ok, g) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok ? '' : '   [' + String(JSON.stringify(g)).slice(0, 200) + ']')); ok ? pass++ : fail++; };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const strip = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const old = (f) => cp.execSync('git show f799841:' + f, { cwd: ROOT, encoding: 'utf8' });
const fnBody = (s, name) => { const i = s.indexOf('function ' + name + '('); if (i < 0) return ''; let d = 0, j = s.indexOf('{', i); for (let k = j; k < s.length; k++) { if (s[k] === '{') d++; else if (s[k] === '}' && --d === 0) return s.slice(j, k + 1); } return ''; };

const CR = read('car-rental.html'), cr = strip(CR);
const MC = read('mechanics.html'), mc = strip(MC);
const SP = read('sokoni-providers.js');

console.log('\n── R: car-rental.html ──');
ck('R1 providers from SokoniProviders.list({category:"car-rental"})', /SokoniProviders\.list\(\{ category: 'car-rental'/.test(CR));
ck('R2 booking = SokoniBookService.open({providerId, providerName})', /SokoniBookService\.open\(\{ providerId: String\(id\), providerName: name \|\| '' \}\)/.test(CR));
ck('R3 no hard-coded cars / phones (CARS = [, CR01, 07xxxxxxxx)', !/const CARS\s*=\s*\[|CR0\d|07\d{8}/.test(cr));
ck('R4 no browser payment: no initiateSTKPush / SokoniMpesa / waConnect / sokoni-pay.js / sokoni-mpesa.js', !/initiateSTKPush|SokoniMpesa|waConnect|sokoni-pay\.js|sokoni-mpesa\.js/.test(cr));
ck('R5 no browser booking record: no carRentals / cr-write / sokoniCarBookings / localStorage.setItem', !/carRentals|cr-write|sokoniCarBookings|localStorage\.setItem/.test(cr));
ck('R6 no false confirmation ("deposit is confirmed", "recorded in SOKONI", "confirm within 30 minutes")', !/deposit is confirmed|recorded in SOKONI|within 30 minutes/i.test(cr));
ck('R7 no invented stats / price guide / reviews / insurance claims', !/80\+<\/strong>|4\.8★|Same Day<\/strong>|class="pg-review-card"|KES 3,500 – 5,500|insurance included|KwikRide/i.test(cr));
ck('R8 the count is the registry\'s, "—" until known', /id="pgStatCount">—</.test(CR) && /st\.textContent = _crError \? '—' : String\(PROVIDERS\.length\)/.test(CR));
ck('R9 provider values escaped through one helper; ids/names via data- attributes, not inline JS', /const e = _crEsc;/.test(CR) && /data-cr-book="' \+ e\(id\)/.test(CR) && !/onclick="openBookingFor\('\$\{/.test(CR));
ck('R10 💬 = SokoniLeads.ask (a lead) with in-app chat fallback, never wa.me', /SokoniLeads\.ask\(\{ providerId: uid, providerName: nm \}\)/.test(CR) && !/wa\.me/.test(cr));
ck('R11 page still self-updates (sw-register.js)', /sw-register\.js/.test(CR));

console.log('\n── M: mechanics.html ──');
const rg = fnBody(mc, 'renderGrid');
ck('M1 listing escaped (safeHtml over name / bio / services / type / area)', /const e=safeHtml;/.test(rg) && /e\(m\.name\|\|"Mechanic"\)/.test(rg) && /e\(String\(m\.bio\)/.test(rg) && /e\(x\)/.test(rg));
ck('M2 no invented rating / jobs / years (no m.rating||5, no "0 jobs", no years||1)', !/rating\|\|5|rating\|\|"5\.0"|jobs\|\|0|years\|\|1/.test(mc));
ck('M3 no raw tel: link', !/href="tel:/.test(mc));
ck('M4 book = SokoniBookService.open for an account uid only (20–128 id chars)', /SokoniBookService\.open\(\{providerId:String\(uid\),providerName:name\|\|""\}\)/.test(MC) && /\^\[A-Za-z0-9_-\]\{20,128\}\$/.test(MC));
ck('M5 ask = SokoniLeads.ask', /SokoniLeads\.ask\(\{providerId:uid,providerName:nm\}\)/.test(MC));
ck('M6 register garage → HubRegister mechanic; sell parts → HubRegister auto-parts (the ONE intake)', /HubRegister\.open\(\{hub:'car',category:'mechanic'\}\)/.test(MC) && /HubRegister\.open\(\{ hub: 'car', category: 'auto-parts' \}\)/.test(MC));
ck('M7 no browser listing / booking / request records (localStorage sokoniMech* / sokoniParts / askHub_, _saveFs(garage))', !/setItem\(["']sokoniMech|setItem\('sokoniParts'|askHub_|_saveFs\(garage/.test(mc));
ck('M8 no waConnect / category:"plumbing" / client payment scripts', !/waConnect|'plumbing'|sokoni-pay\.js|sokoni-intasend\.js|sokoni-commission-rates\.js/.test(mc));
ck('M9 repairs → My Bookings (bookings.html), not a localStorage ref lookup', /href="bookings\.html"/.test(MC) && /function trackRepair\(\) \{ location\.href = 'bookings\.html'; \}/.test(MC));
ck('M10 SOS stays the critical support ticket (no WhatsApp number as an emergency channel)', /support\.html\?topic=sos/.test(MC));
ck('M11 no "Request broadcast" / "now live" / "Part listed" claims', !/Request broadcast|is now live on SOKONI|Part listed successfully/.test(mc));
ck('M12 the booking engine, leads and inbox are loaded; firebase.js loaded for the compat namespace', ['sokoni-book-service.js', 'sokoni-leads.js', 'sokoni-inbox.js', 'firebase.js'].every((f) => MC.includes('src="' + f + '"')));

console.log('\n── A: aliases ──');
ck('A1 car-rental alias covers car_rental / car-hire', /'car-rental':\s*\['car-rental', 'car_rental', 'car-hire', 'car_hire'\]/.test(SP));
ck('A2 mechanic alias covers garage / auto_services', /mechanic:\s*\['mechanic', 'mechanics', 'garage', 'auto_services', 'auto-repair'\]/.test(SP));

console.log('\n── Z: negative controls (f799841) ──');
const OCR = old('car-rental.html'), OMC = old('mechanics.html');
ck('Z1 the old car-rental really had hard-coded cars and a browser STK path (R3/R4 not vacuous)', /const CARS = \[/.test(OCR) && /SokoniMpesa|waConnect/.test(OCR));
ck('Z2 the old mechanics really had raw tel: and waConnect "plumbing" (M3/M8 not vacuous)', /href="tel:/.test(OMC) && /category: 'plumbing'/.test(OMC));
ck('Z3 the old mechanics really defaulted ratings to 5 (M2 not vacuous)', /rating\|\|5/.test(OMC));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
