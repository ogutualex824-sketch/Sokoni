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

console.log('\n── H: car-hub.html + carhub-containment.js (C1b) ──');
const CH = read('car-hub.html'), CC = read('carhub-containment.js'), cc = strip(CC), PRO = read('sokoni-carhub-pro.js');
const fnSrc = (src, name) => fnBody(src, name);
ck('H1 containment layer loaded LAST (after hub-register.js), deferred', /<script defer src="hub-register\.js"><\/script>\n(?:\s*<!--[^\n]*-->\n)?(?:\s*<script defer src="sokoni-vehicles\.js"><\/script>\n)?\s*<script defer src="carhub-containment\.js"><\/script>/.test(CH.replace(/\r/g, '')));
ck('H2 confirmBooking records NO commission / fee (b2 2ddaee5 text); no saveCommission / saveFee call left in car-hub', !/SokoniPay\.saveCommission\(|SokoniPay\.saveFee/.test(strip(CH)) && /No fee or commission is recorded here \(2026-10-03\)/.test(CH));
ck('H3 rent / book → car-rental.html (approved providers + booking engine), not a browser booking', /G\.openBookingModal = function \(\) \{ goRent\(\); \}/.test(CC) && /G\.confirmBooking = function \(\) \{ goRent\(\); \}/.test(CC) && /G\.location\.href = 'car-rental\.html'/.test(CC));
ck('H4 licence approval refused on the page; a browser "approved" is reported as unverified', /G\.approveDLFromQueue = G\.rejectDLFromQueue = function \(\) \{ note\('Driving licences are verified by SOKONI staff/.test(CC) && /status: 'unverified'/.test(CC));
ck('H5 simulated GPS: startLiveTracking / _animateRented / initMap return before any random movement', /function startLiveTracking\(\)\{\n[^\n]*\n  return;/.test(CH.replace(/\r/g, '')) && /function _animateRented\(\)\{\n  return;/.test(CH.replace(/\r/g, '')) && /window\.initMap = function\(\)\{[\s\S]{0,900}?Live vehicle location is not available here[\s\S]{0,120}?return;/.test(CH));
ck('H6 tracking plans: no hard-coded KES 299 / 799 / 2,499 prices shown; trkSubscribe = not available', !/trk-plan-price[^>]*>KES (299|799|2,499)/.test(CH) && /G\.trkSubscribe = NA\('Vehicle tracking plans'\)/.test(CC));
ck('H7 roadside SOS + triggerSOS → CRITICAL support ticket (never a "provider accepted" claim)', /P\.submitRoadsideRequest = function \(\) \{[\s\S]{0,200}supportTicket\('sos'/.test(CC) && /G\.triggerSOS = function \(\) \{ supportTicket\('sos'/.test(CC) && !/accepted|on the way|dispatched/i.test(cc));
ck('H8 finance / inspection / price estimate / financing calc / transport quote → not available (no invented numbers)', ['submitFinancingApplication', 'calcFinancing', 'submitInspectionBooking', 'calcTransportQuote', 'estimateVehiclePrice'].every((m) => new RegExp('P\\.' + m + ' = NA\\(').test(CC)));
ck('H9 list car / register mechanic / sell parts → HubRegister (car-rental / mechanic / auto-parts)', /G\.addCarToFleet = hubRegister\('car-rental'/.test(CC) && /G\.submitRegisterMechanic = hubRegister\('mechanic'/.test(CC) && /P\.submitSellPart = P\.openSellPartForm = hubRegister\('auto-parts'/.test(CC));
ck('H10 the containment layer writes nothing: no Firestore / localStorage writes, no payment calls', !/setDoc|addDoc|updateDoc|\.set\(|localStorage\.setItem|initiateSTKPush|createPaymentIntent|saveCommission|saveFee/.test(cc));
ck('H11 bookings view → My Bookings (bookings.html)', /G\.renderBookings = function \(\) \{[\s\S]{0,400}href="bookings\.html"/.test(CC));
ck('H12 invented finance partners / inspection centres / transport firms are demo-only in sokoni-carhub-pro.js', ['FINANCE_PARTNERS', 'INSPECTION_CENTERS', 'TRANSPORT_PROVIDERS'].every((n) => new RegExp('const ' + n + ' = !_demoAllowed \\? \\[\\] : \\[').test(PRO)));

console.log('\n── C: applications (C3) ──');
const HR = read('hub-register.js'), AD = read('admin.html');
const CAR_IDS = ['mechanic', 'car-wash', 'car-rental', 'auto-parts', 'driving-school', 'insurance-auto', 'car-dealer', 'vehicle-inspection', 'towing-roadside', 'fleet-operator', 'vehicle-transport', 'vehicle-tracking', 'car-finance', 'ntsa-agent'];
ck('C1 every Car Hub service has an application category in the ONE intake (HubRegister CATS, hub car)', CAR_IDS.every((id) => new RegExp("\\{ id:'" + id + "',\\s+label:'[^']+',\\s+hub:'car'").test(HR)), CAR_IDS.filter((id) => !new RegExp("\\{ id:'" + id + "',").test(HR)));
ck('C2 every car category has category-specific questions', CAR_IDS.every((id) => new RegExp("'" + id + "': \\[").test(HR)), CAR_IDS.filter((id) => !new RegExp("'" + id + "': \\[").test(HR)));
ck('C3 answers are collected, required ones enforced, saved as applications.details (strings, capped)', /var _det = _collectDetails\(cat\);\n\s*if \(!_det\.ok\) \{ _err\(_det\.error\); return; \}/.test(HR) && /details:\s+_det\.details,/.test(HR) && /if \(q\.required && !v\) return \{ ok: false/.test(HR));
ck('C4 licence numbers are declarations AdminOS verifies (labelled so); no NTSA / insurance / loan result issued by the form', /IRA licence number \(AdminOS verifies\)/.test(HR) && /Regulator licence number \(AdminOS verifies\)/.test(HR) && /SOKONI does not issue NTSA results, insurance cover or loan approvals/.test(HR));
ck('C5 mechanics apply as bookable providers (no mechanic → mechanic role override)', /var _ROLE_BY_CATEGORY = \{ landlord: 'landlord' \};/.test(HR));
ck('C6 the form grants nothing: no status / approved / verified / business written by HubRegister', !/status:\s*'(approved|active|verified)'|approved:\s*true|verified:\s*true|business:\s*\{/.test(strip(HR)));
ck('C7 AdminOS application card shows description + details, every value escaped through h()', /h\(String\(a\.description\)\.slice\(0,400\)\)/.test(AD) && /h\(String\(a\.details\[k\]\)\.slice\(0,200\)\)/.test(AD) && /Declared by the applicant — verify licences/.test(AD));
ck('C8 each Car Hub service tab offers its application (12 tabs → HubRegister categories)', (CC.match(/'tab-[a-z-]+':\s+\['[a-z-]+'/g) || []).length === 12 && /box\.querySelector\('button'\)\.addEventListener\('click', hubRegister\(cat,/.test(CC));
ck('C9 mechanics.html merges approved mechanic providers (SokoniProviders mechanic) with legacy mechanics/{uid}', /SokoniProviders\.list\(\{category:"mechanic"\}\)/.test(MC) && /const prov=await _loadProviderMechs\(\);/.test(MC) && MC.includes('src="sokoni-providers.js"'));

console.log('\n── V: buy & sell on vehicle-hub (C4) ──');
const SV = read('sokoni-vehicles.js'), sv = strip(SV);
ck('V1 only the canonical vehicle-hub callables are used (list/search/enquiry/report/create/publish/close/mine/enquiries)', ['listVehicles', 'searchVehicles', 'submitVehicleEnquiry', 'reportVehicleListing', 'createVehicleListing', 'publishVehicleListing', 'closeVehicleListing', 'listMyVehicleListings', 'getVehicleEnquiries'].every((n) => SV.includes("'" + n + "'")));
ck('V2 the browser never sets a listing status, never moderates, never writes Firestore directly', !/status\s*:\s*'(active|published|approved)'|moderateVehicleListing|setDoc|addDoc|updateDoc|\.collection\(/.test(sv));
ck('V3 selling = create then publish → "submitted for review" (never "live")', /call\('createVehicleListing', data\)\.then\(function \(r\) \{\s*return call\('publishVehicleListing'/.test(SV) && /Submitted for review/.test(SV) && !/is now live|listed successfully/i.test(sv));
ck('V4 marketplace-first copy: SOKONI takes no payment for the car; no checkout / STK / payment intent in the module', /SOKONI does not take payment for the car/.test(SV) && !/createPaymentIntent|initiateSTKPush|checkout/i.test(sv));
ck('V5 every listing value rendered through esc(); listing ids validated before use', (sv.match(/esc\(v\./g) || []).length >= 6 && /\^\[A-Za-z0-9_-\]\{1,128\}\$/.test(SV));
ck('V6 seller declarations are never shown as verified (no "verified" badge in the module)', !/verified/i.test(sv.replace(/never shown as verified/gi, '')));
ck('V7 car-hub routes Buy & Sell to SokoniVehicles (browse / sell) and mounts My vehicle listings', /G\.submitCarForSale = function \(\) \{ if \(G\.SokoniVehicles\) return G\.SokoniVehicles\.sell\(\);/.test(CC) && /G\.renderBuySellGrid = function \(\) \{ if \(G\.SokoniVehicles\) return G\.SokoniVehicles\.browse\(\); \}/.test(CC) && /id="skVehMine"/.test(CC));
ck('V8 the "verified sellers" claim and the WhatsApp phone field are gone from Buy & Sell', !/from verified sellers/.test(CH) && !/id="bsPhone" placeholder="07XX/.test(CH));

console.log('\n── D: AdminOS Car Hub area (C5) ──');
const AD2 = read('admin.html'), ad2 = strip(AD2);
const rch = fnBody(ad2, 'renderCarHub');
ck('D1 Car Hub admin reads the server review queue (listVehicleReviewQueue) and decides via moderateVehicleListing', /sokoniCallable\('listVehicleReviewQueue'\)/.test(ad2) && /sokoniCallable\('moderateVehicleListing'\)/.test(ad2));
ck('D2 reject / suspend require a reason; listing ids validated; actions by index, never id-in-onclick', /if\(decision==='reject'\|\|decision==='suspend'\)\{ reason=/.test(ad2) && /moderateCarListing\('\+i\+',\\'approve\\'\)/.test(AD2) && /\^\[A-Za-z0-9_-\]\{1,128\}\$/.test(fnBody(ad2, '_carModerate')));
ck('D3 Car Hub applications are decided in the ONE Applications pane (applicationDecide), not here', /Review in Applications/.test(rch) && !/sokoniCallable\('applicationDecide'\)|approveApp\(/.test(rch));
ck('D4 the localStorage car tables / DL queue / confirmCarBooking / processDL are gone (they decided nothing)', !/function confirmCarBooking|function processDL|localStorage\.setItem\('sokoniDLQueue'|localStorage\.setItem\('sokoniCarBookings'/.test(ad2) && !/carBookingsBody|dlQueueBody/.test(AD2));
ck('D5 unknown ≠ empty: queue load error says "not an empty queue"; count shows — until loaded', /This is not an empty queue/.test(rch) && /_carQueueState==='ready'\?_carQueue\.length:'—'/.test(rch));
ck('D6 Services → Car Hub sub-tab renders the area (it showed static markup only)', /if \(tab === 'carhub' && typeof renderCarHub === 'function'\) renderCarHub\(\);/.test(AD2));
ck('D7 every value escaped through h() in the renderer', (rch.match(/h\(/g) || []).length >= 8);

console.log('\n── Z: negative controls (f799841) ──');
const OCR = old('car-rental.html'), OMC = old('mechanics.html');
ck('Z1 the old car-rental really had hard-coded cars and a browser STK path (R3/R4 not vacuous)', /const CARS = \[/.test(OCR) && /SokoniMpesa|waConnect/.test(OCR));
ck('Z2 the old mechanics really had raw tel: and waConnect "plumbing" (M3/M8 not vacuous)', /href="tel:/.test(OMC) && /category: 'plumbing'/.test(OMC));
ck('Z3 the old mechanics really defaulted ratings to 5 (M2 not vacuous)', /rating\|\|5/.test(OMC));
const OCH = old('car-hub.html');
ck('Z4 the old car-hub really recorded commission auto_collected and moved markers with Math.random (H2/H5 not vacuous)', /SokoniPay\.saveCommission\(/.test(OCH) && /trackingInterval=setInterval/.test(OCH));
ck('Z5 the old car-hub really had approveDLFromQueue and plans priced at KES 299 (H4/H6 not vacuous)', /function approveDLFromQueue/.test(OCH) && /KES 299<span/.test(OCH));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
