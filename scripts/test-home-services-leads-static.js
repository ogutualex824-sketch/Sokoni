#!/usr/bin/env node
/* test-home-services-leads-static.js — Home Services quote/request convergence onto the ONE lead authority (b2 4F),
 * plus the buyer total under the owner's fee model. Static (no browser, no network) — the browser behaviour is covered
 * by test-home-services-hubs-browser / test-bookings-browser when memory allows.
 *   L  leads: requestQuotes / postHsRequest route to a provider (goFindType → directory 💬 → SokoniLeads.ask); the lead
 *      module is loaded; the customer's list is b2's service-requests.html (no second copy)
 *   W  writes: no browser write path left in home-services.html (no _hsFireWrite, no second Firebase app, no
 *      homeServiceQuotes/Requests, no localStorage quote/ask feeds, no phone collection); BASELINE has no hs-write
 *   C  claims: no "up to 5 providers respond" / public feed of requests
 *   M  money: bookings.html buyer total = server pricing.customerTotalKES, else the stored price; no fee arithmetic
 *   Z  negative controls against the parent commit
 * Run: node scripts/test-home-services-leads-static.js
 */
'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process');
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ck = (l, ok, g) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok ? '' : '   [' + String(JSON.stringify(g)).slice(0, 220) + ']')); ok ? pass++ : fail++; };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const strip = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const fnBody = (s, name) => { const i = s.indexOf('function ' + name + '('); if (i < 0) return ''; let d = 0, j = s.indexOf('{', i); for (let k = j; k < s.length; k++) { if (s[k] === '{') d++; else if (s[k] === '}' && --d === 0) return s.slice(j, k + 1); } return ''; };

const HS = read('home-services.html'), hs = strip(HS);
const BK = read('bookings.html'), bk = strip(BK);
const SFA = read('scripts/test-secondary-firebase-apps.js');

console.log('\n── L: leads ──');
ck('L1 sokoni-leads.js is loaded (the directory 💬 becomes SokoniLeads.ask)', /<script src="sokoni-leads\.js" defer><\/script>/.test(HS));
ck('L2 sokoni-leads.js exists on this line and calls providerDispatch leadCreate', fs.existsSync(path.join(ROOT, 'sokoni-leads.js')) && /call\('leadCreate'/.test(read('sokoni-leads.js')));
const rq = fnBody(hs, 'requestQuotes'), ph = fnBody(hs, 'postHsRequest');
ck('L3 requestQuotes routes to a provider (goFindType) and writes nothing', /goFindType\(_hsTypeKeyFor\(/.test(rq) && !/Write|addDoc|setItem|fetch\(/.test(rq), rq);
ck('L4 postHsRequest routes to a provider (goFindType) and writes nothing', /goFindType\(_hsTypeKeyFor\(/.test(ph) && !/Write|addDoc|setItem|fetch\(/.test(ph), ph);
ck('L5 the customer\'s requests & quotes = b2\'s service-requests.html (one list, not a copy)', /href="service-requests\.html"/.test(HS) && fs.existsSync(path.join(ROOT, 'service-requests.html')));
ck('L6 both functions are still exported for their onclick handlers', /window\.requestQuotes=requestQuotes;/.test(HS) && /window\.postHsRequest=postHsRequest;/.test(HS));

console.log('\n── W: writes ──');
ck('W1 no browser write path left: _hsFireWrite / initializeApp / addDoc', !/_hsFireWrite|initializeApp\(|addDoc\(/.test(hs));
ck('W2 no homeService* collections named in code (Quotes / Requests / Bookings / Providers / Reviews / Leads)', !/homeService(Quotes|Requests|Bookings|Providers|Reviews|Leads)/.test(hs));
ck('W3 no localStorage quote / ask feeds', !/hsQuoteRequests|askHub_homeservices|sokoniHomeBookings|hsReviews/.test(hs));
ck('W4 no phone number collected for a request (the server knows the signed-in customer)', !/id="qtPhone"|id="hsAskPhone"/.test(HS));
ck('W5 secondary-apps BASELINE no longer carries home-services hs-write', !/'home-services\.html':\s*\['hs-write'\]/.test(SFA));

console.log('\n── C: claims ──');
ck('C1 no "up to 5 providers respond" promise (outside comments)', !/up to 5 providers/i.test(hs));
ck('C2 no public feed of other people\'s requests (hsAskFeed / hsQuotesFeed rendering)', !/feed\.innerHTML\s*=\s*(quotes|reqs)\./.test(hs));

console.log('\n── M: money (owner 2026-10-03: SOKONI 5% is PROVIDER-paid; buyer pays the service amount) ──');
const tot = fnBody(bk, 'total');
ck('M1 buyer total reads server pricing.customerTotalKES first', /b\.pricing && b\.pricing\.customerTotalKES/.test(tot), tot);
ck('M2 …and falls back to the booking\'s stored price, nothing else', /return kes\(b\.price\)/.test(tot));
ck('M3 no fee / commission arithmetic in the page (no 0.05, 1.05, 5%, rate ×)', !/0\.05|1\.05|\*\s*rate|commissionRate\s*\*|5\s*%/.test(bk));
ck('M4 the card renders total(b) for "Booking total"', /Booking total<\/span><span class="v">' \+ total\(b\)/.test(BK));

console.log('\n── R: refunds / cancellation (owner 2026-10-03) ──');
ck('R1 Cancel goes to the booking authority providerDispatch providerCancelBooking (server applies the policy)', /askOp\(id, 'providerCancelBooking'/.test(BK) && /httpsCallable\('providerDispatch'\)\(\{ op: op, bookingId: id \}\)/.test(BK));
ck('R2 Cancel is offered only before the service starts (pending / requested / confirmed)', /var CANCELLABLE = \{ pending:1, requested:1, confirmed:1 \}/.test(BK));
ck('R3 provider-affected booking → customerRequestRefund (full refund, server-decided)', /askOp\(id, 'customerRequestRefund'/.test(BK) && /res === 'ACTION_REQUIRED' && b\.paymentStatus === 'paid_held'/.test(BK));
ck('R4 in progress / completed → a reviewed request (support ticket with the booking ref), never an automatic refund', /b\.status === 'in_progress' \|\| b\.status === 'completed'\) acts \+= '<a class="bk-btn" href="support\.html\?topic=booking&amp;ref='/.test(BK));
ck('R5 the page never writes refunded / cancelled / a refund amount itself', !/paymentStatus\s*[:=]\s*'refunded'|status\s*[:=]\s*'cancelled'|refundCents\s*[:=]/.test(bk));
ck('R6 no createDispute call with a booking (orders only today — a booking dispute is a server gap, not imitated)', !/createDispute/.test(bk));
ck('R7 success copy only after the server answered (inside .then of the callable)', /\.then\(function \(r\) \{\s*var d = r && r\.data \|\| \{\};\s*toast\(/.test(BK));

console.log('\n── Z: negative controls ──');
const parent = (f) => cp.execSync('git show 56c173d:' + f, { cwd: ROOT, encoding: 'utf8' });
let PH = ''; try { PH = parent('home-services.html'); } catch (e) {}
ck('Z1 the pre-convergence merge 56c173d really wrote homeServiceQuotes through _hsFireWrite (W1/W2 are not vacuous)', /_hsFireWrite\('homeServiceQuotes'/.test(PH));
ck('Z2 56c173d really collected a phone for quotes (W4 is not vacuous)', /id="qtPhone"/.test(PH));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
