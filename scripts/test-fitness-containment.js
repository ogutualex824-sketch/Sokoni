#!/usr/bin/env node
/* FITNESS HUB CONTAINMENT (F0, owner 2026-10-03) — the live Fitness Hub (72dca56) took client-priced
 * M-Pesa payments (SokoniPay.platformBook / gateway / waConnect) whose amount came from public user-written
 * fitness_classes docs or localStorage, confirmed bookings with no payment, wrote fitness_bookings
 * {status:'confirmed'} from the browser, handed users off to WhatsApp, showed DEMO gyms/coaches/classes with
 * invented ratings and member counts, and rendered user-written class/club fields unescaped (stored XSS).
 *
 * The page's REAL classic inline scripts are EXECUTED in a vm with a spy on SokoniPay / SokoniIntaSend /
 * window.open, a demo flag switched on, hostile user-written docs injected, and every legacy action entry
 * point invoked with real-looking arguments. The module script (Firestore) is checked by source.
 *
 *   node scripts/test-fitness-containment.js              (this tree — must PASS)
 *   BASE=72dca56 node scripts/test-fitness-containment.js (live — named rows must FAIL; FT-9 is a CONTROL)
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const FILE = process.env.FILE; // optional: a temp copy to test instead of the tree file
const read = (f) => FILE && f === 'fitness-hub.html' ? fs.readFileSync(FILE, 'utf8')
  : process.env.BASE ? execSync('git show ' + process.env.BASE + ':' + f, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 })
  : fs.readFileSync(path.join(ROOT, f), 'utf8');
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + String(got).slice(0, 200) + ']')); ok ? pass++ : fail++; };
const scripts = (html) => { const out = []; const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g; let m; while ((m = re.exec(html))) out.push({ attrs: m[1], code: m[2], module: /type="module"/.test(m[1]) }); return out; };
console.log('\nFitness Hub containment   ' + (FILE ? 'FILE=' + FILE : process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');

const HTML = read('fitness-hub.html');
const ALL = scripts(HTML);
const CLASSIC = ALL.filter((s) => !s.module).map((s) => s.code).join('\n;\n');
const MODULE = ALL.filter((s) => s.module).map((s) => s.code).join('\n;\n');

/* ── EXECUTE the classic inline scripts ── */
const XSS = '<img src=x onerror=alert(1)>';
const store = {
  sokoniDemoData: 'true',
  sokoniGyms: JSON.stringify([{ id: 'U1', name: 'Hostile Gym ' + XSS, loc: XSS, rating: 4.9, members: 999, daypass: 300, monthly: 3500, phone: '0712000000', facilities: [XSS], area: 'all', type: 'commercial' }]),
  sokoniClasses: JSON.stringify([{ id: 'UC1', type: 'yoga', name: 'Local Class ' + XSS, instructor: XSS, loc: XSS, fee: 500, phone: '0712000001', slots: 9 }]),
  sokoniClubs: JSON.stringify([{ id: 'UB1', name: 'Local Club ' + XSS, members: 40, desc: XSS, phone: '0712000002' }]),
  sokoniWorkouts: JSON.stringify([{ id: 'UW1', cat: 'home', title: 'Local Workout ' + XSS, coach: XSS, phone: '0712000003', exercises: [XSS] }]),
  sokoniGymEquip: JSON.stringify([{ id: 'UE1', name: 'Local Equip ' + XSS, price: 1000, phone: '0712000004', desc: XSS }]),
  askHub_fitness: JSON.stringify([{ id: 'UA1', text: 'help', cat: XSS, phone: '0712000005', ts: Date.now() }]),
  sokoniBookings: JSON.stringify([{ id: 'UK1', type: 'gym', provider: XSS, date: '2099-01-01', time: '08:00', phone: '0712000006', status: 'confirmed' }]),
  prGoals: JSON.stringify([{ id: "G1');alert(1);('", type: XSS, val: XSS, date: XSS, done: false }]),
  prWorkoutLog: JSON.stringify([{ id: 'L1', type: XSS, dur: 30, cals: 100, date: XSS }]),
  prWeightLog: JSON.stringify([{ kg: 80, date: '2026-10-01' }]),
};
const els = {};
const mkEl = (id) => ({ id, innerHTML: '', textContent: '', value: id === 'bkType' ? 'gym' : id === 'bkDate' ? '2099-01-01' : id === 'bkProvider' ? 'Some Gym' : (/Phone$/i.test(id) ? '0712345678' : (/Price|Fee|Monthly|DayPass|Cals|Dur/i.test(id) ? '500' : 'x')),
  style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, querySelectorAll: () => [], querySelector: () => null,
  addEventListener() {}, appendChild() {}, remove() {}, focus() {}, scrollIntoView() {} });
const el = (id) => els[id] || (els[id] = mkEl(id));
const spy = { pay: [], open: [] };
const payStub = new Proxy({}, { get: (_, k) => (...a) => { spy.pay.push(String(k)); return Promise.resolve({}); } });
const ctx = {
  console: { log() {}, warn() {}, error() {}, info() {} }, Math, Date, JSON, String, Number, Array, Object, Promise, Set, Proxy, encodeURIComponent, URLSearchParams,
  setTimeout: (f) => { try { if (typeof f === 'function') f(); } catch (e) {} return 0; }, clearTimeout() {},
  location: { hostname: 'mysokoni.co.ke', search: '', href: '' },
  document: { getElementById: el, querySelector: () => null, querySelectorAll: () => [], createElement: () => mkEl('x' + Math.random()), body: mkEl('body'), addEventListener() {} },
  localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
  SokoniPay: payStub, SokoniIntaSend: payStub, SokoniSecurity: { persistentRateLimit: () => true },
  HubRegister: { open() {} }, alert() {}, open: (u) => { spy.open.push(String(u)); },
  escapeHTML: (s) => (s === null || s === undefined ? '' : String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;').replace(/\//g, '&#x2F;').replace(/`/g, '&#x60;'),
};
ctx.window = ctx; ctx.self = ctx;
ctx._firestoreClasses = [{ id: 'FC1', type: 'yoga', name: 'Firestore Class ' + XSS, instructor: XSS, loc: XSS, fee: '1);alert(1);(', phone: '07', slots: 5 }];
ctx._firestoreClubs = [{ id: 'FB1', name: 'Firestore Club ' + XSS, members: 12, desc: XSS, phone: '07' }];
vm.createContext(ctx);
let runErr = null;
try { vm.runInContext(CLASSIC, ctx, { timeout: 4000 }); } catch (e) { runErr = e.message; }

/* invoke every legacy action entry point the live page exposed, with real-looking arguments */
const ACTIONS = [
  ['bookClass', ['CL01', 'Yoga', '0712345678', 500]], ['bookDayPass', ['0712345678', 'Gym', 300]], ['makeBooking', []],
  ['bookNutritionist', ['N01', 'Dr X', '0712345678', 3500]], ['fitGymConnect', ['0712345678', 'Gym', 3500]],
  ['fitEquipConnect', ['0712345678', 'Bench', 18000]], ['fitCoachConnect', ['0712345678', 'Coach', 2500]],
  ['registerEvent', ['0712345678', '10K', 'KES 500']], ['joinClub', ['0712345678', 'Club']], ['shareGym', []],
  ['postClass', []], ['createClub', []], ['postWorkout', []], ['sellEquipment', []], ['saveGymProfile', []],
  ['postFitRequest', []], ['joinChallenge', ['CH01', 'Run', null]], ['checkInMember', []],
];
const present = [];
for (const [fn, args] of ACTIONS) {
  if (typeof ctx[fn] !== 'function') continue;
  present.push(fn);
  try { ctx[fn](...args); } catch (e) { runErr = runErr || fn + ': ' + e.message; }
}
const rendered = Object.values(els).map((e) => e.innerHTML + ' ' + e.textContent).join('\n');

ck('FT-1', spy.pay.length === 0, 'EXECUTED: every legacy Book / Day pass / Nutritionist / Event / Connect / class-fee entry point starts NO SokoniPay / IntaSend call (platformBook, gateway, waConnect, saveBookingFee)',
  JSON.stringify(spy.pay) + ' via ' + present.join(','));
const SRC_PAY = /SokoniPay\.|platformBook|\.gateway\(|waConnect|saveBookingFee|SokoniIntaSend\.|initiateSTKPush/;
ck('FT-2', !SRC_PAY.test(CLASSIC + MODULE), 'no inline script on the page references SokoniPay / platformBook / gateway / waConnect / saveBookingFee / initiateSTKPush', (CLASSIC + MODULE).match(SRC_PAY));
ck('FT-3', spy.open.filter((u) => /wa\.me|whatsapp/i.test(u)).length === 0 && !/wa\.me|api\.whatsapp|whatsapp:\/\//i.test(HTML) && !/WhatsApp/.test(HTML.replace(/<!--[\s\S]*?-->/g, '')),
  'no wa.me / WhatsApp hand-off anywhere (EXECUTED: nothing opened; source: no wa.me link, no "WhatsApp" field or button)', spy.open.join(' ') || (HTML.match(/.{30}(wa\.me|WhatsApp).{30}/) || [''])[0]);
ck('FT-4', !/Booking confirmed|CONFIRMED<|status\s*:\s*'confirmed'|booked! Ref|Class listed|published to the hub|Listed!|Club created|Workout posted/i.test(HTML + rendered),
  'no fake success: no "Booking confirmed", no CONFIRMED badge, no client status:\'confirmed\', no "listed / published / created / posted" toast', (HTML + rendered).match(/Booking confirmed|CONFIRMED<|status\s*:\s*'confirmed'|booked! Ref|Class listed|published to the hub|Listed!|Club created|Workout posted/i));

const DEMO_IDS = ['DEMO_GYMS', 'DEMO_COACHES', 'DEMO_WORKOUTS', 'DEMO_EQUIPMENT', 'DEMO_CLASSES', 'DEMO_NUTRITIONISTS', 'DEMO_MEAL_PLAN', 'DEMO_CLUBS', 'DEMO_CHALLENGES', 'DEMO_EVENTS', 'DEMO_LEADERBOARD', '_demoAllowed'];
const SAMPLE_NAMES = ['Westlands Fitness Centre', 'Kilimani CrossFit Box', 'Karen Yoga Studio', 'City Fitness CBD', 'MMA & Fitness', 'Mombasa Aqua Fitness',
  'Janet Wanjiku', 'Kevin Odhiambo', 'Amina Hassan', 'Peter Kamau', 'Grace Akinyi', 'Brian Mutua', 'Sandra Njeri', 'Mary Achieng', 'Fatuma Osman', 'James Otieno', 'Paul Kamau',
  'Susan Odhiambo', 'Fatima Ali', 'Grace Wambui', 'John Maina', 'Carol Njoki', 'Nairobi Runners', 'Nairobi Cycling Club', 'Kenya Hikers', 'Morning Yoga Circle', 'Nairobi Masters Swim',
  'Iron Tribe Nairobi', '30-Day Running Challenge', 'SOKONI Sport Voucher', 'Nairobi 10K Fun Run', 'Cycling for Good', 'Open Water Swim Challenge', 'Mt. Longonot Hike',
  'Commercial Treadmill', 'Battle Ropes', 'Sample 7-Day Meal Plan', 'Iron Beast Gym'];
const hitDemo = DEMO_IDS.filter((d) => HTML.includes(d)).concat(SAMPLE_NAMES.filter((n) => (HTML + rendered).includes(n)));
ck('FT-5', hitDemo.length === 0, 'no DEMO_* array, no _demoAllowed flag, and none of the ' + SAMPLE_NAMES.length + ' sample gym / coach / class / nutritionist / club / challenge / event / equipment names', hitDemo.join(', '));

const GRIDS = ['gymsGrid', 'fitCoachesGrid', 'clsGrid', 'nutGrid', 'equipmentGrid', 'cmClubsGrid', 'workoutsGrid', 'fitAskFeed', 'bkUpcoming', 'cmChallengesGrid', 'cmEventsGrid', 'cmLeaderboard', 'mealPlanGrid'];
const renderedListing = GRIDS.filter((g) => els[g] && els[g].innerHTML.trim());
const LOCAL_NAMES = /Hostile Gym|Local Class|Local Club|Local Workout|Local Equip|Firestore Class|Firestore Club/;
const emptyOk = ['gymsGrid', 'fitCoachesGrid', 'clsGrid', 'nutGrid'].every((g) => new RegExp('id="' + g + '"[^>]*>[\\s\\S]{0,400}Listings appear here once approved providers publish them').test(HTML));
ck('FT-6', renderedListing.length === 0 && !LOCAL_NAMES.test(rendered) && emptyOk,
  'EXECUTED (demo flag ON, localStorage + Firestore classes/clubs injected): no listing is rendered from localStorage, DEMO or client-created docs; gyms / coaches / classes / nutrition show "Listings appear here once approved providers publish them"',
  'rendered=' + renderedListing.join(',') + ' emptyState=' + emptyOk + (runErr ? ' err=' + runErr : ''));
const RATING = /⭐\s*\$?\{?[^<]{0,12}\d\.\d|rating\s*:\s*\d|\brating\|\|\d|>120\+<|47<\/strong><span>Counties|members\s*:\s*\d{2,}/;
ck('FT-7', !RATING.test(HTML) && !/⭐\s*\d/.test(rendered), 'no rating literal (5.0 / 4.9 / ||4.5), no self-stamped rating, no "120+ Gyms Listed / 47 Counties" stat, no hard-coded member count', (HTML.match(RATING) || rendered.match(/⭐\s*\d.{0,10}/) || [''])[0]);

const WRITE = /(addDoc|setDoc|updateDoc|deleteDoc)\(\s*(collection|doc)\(\s*db\s*,\s*'(fitness_(?!progress')[a-z_]+)'/g;
const writes = [...MODULE.matchAll(WRITE)].map((m) => m[3]);
const reads = (MODULE.match(/'fitness_(classes|clubs|bookings|equipment|gyms|requests|challenges|checkins|community_posts)'/g) || []);
ck('FT-8', writes.length === 0 && reads.length === 0 && !/_firestoreSaveBooking|_firestoreClasses|_firestoreClubs/.test(HTML),
  'no Firestore write to any fitness_* collection except the user\'s own fitness_progress; no read of classes / clubs / bookings / equipment / gyms / requests / challenges / check-ins', 'writes=' + writes.join(',') + ' reads=' + reads.join(','));
ck('FT-9', /HubRegister\.open\(\{hub:'fitness',category:'gym'\}\)/.test(HTML) && /HubRegister\.open\(\{hub:'fitness',category:'nutrition'\}\)/.test(HTML) && /<script defer src="hub-register\.js"><\/script>/.test(HTML),
  'CONTROL: both register entry points (gym/studio, coach/trainer) still call the ONE intake HubRegister.open, and hub-register.js is loaded');

/* escaping: progress (still rendered) with hostile stored values; no inline-JS string interpolation left */
const progOut = ['prGoalsList', 'prWorkoutLog', 'prStatsGrid', 'prWeightChart', 'prBadges'].map((g) => (els[g] ? els[g].innerHTML : '')).join('');
const rawSink = /<img src=x/.test(rendered) || /alert\(1\);\('/.test(progOut);
const inlineInterp = /onclick="[^"]*'\$\{/.test(HTML);
ck('FT-10', !rawSink && !inlineInterp && /escapeHTML\(g\.val\)/.test(HTML) && /<script src="security\.js"><\/script>/.test(HTML),
  'EXECUTED: every remaining dynamic field goes through the canonical escapeHTML (security.js loaded); no raw <img onerror> reaches innerHTML; handler args ride data-* (no onclick="…\'${…}\'")',
  'rawSink=' + rawSink + ' inlineInterp=' + inlineInterp);

/* owner O-7: community features moved to the ONE Community Hub */
const O7_FN = /function\s+(renderClubs|createClub|joinClub|renderChallenges|joinChallenge|renderLeaderboard|renderEvents|registerEvent|renderWorkouts|postWorkout|postFitRequest|renderFitAskFeed)\b/;
const O7_COL = /fitness_(community_posts|clubs|challenges|requests)/;
const panelLinks = ['community', 'workouts', 'askhub'].every((p) => new RegExp('id="fhpanel-' + p + '"[\\s\\S]{0,900}href="community\\.html"').test(HTML));
ck('FT-11', !O7_FN.test(CLASSIC) && !O7_COL.test(MODULE) && !/cmClubName|cmClubsGrid|cmChallengesGrid|fitAskText|wkExercises/.test(HTML),
  'O-7: no fitness-local feed / club / challenge / event / Ask Hub write or render (functions, forms, grids and collections gone)', (CLASSIC.match(O7_FN) || MODULE.match(O7_COL) || [''])[0]);
ck('FT-12', panelLinks && fs.existsSync(path.join(ROOT, 'community.html')),
  'O-7: Community, Workouts and Ask Hub panels each link to the Community Hub (community.html, which exists in this tree)');
ck('FT-13', /href="category\.html\?cat=sports"/.test(HTML) && fs.existsSync(path.join(ROOT, 'category.html')) && !/Sell Memberships|seller\.html|eqSellPrice|clsFee|bkProvider/.test(HTML),
  'equipment routes to the real marketplace category page (category.html?cat=sports); no second equipment catalogue, no "Sell Memberships", no class-fee / booking form');
/* Fitness Memberships entry (2026-10-03): a PLAIN link to the member page — no handler, no payment, no booking. */
const MB_LINKS = HTML.match(/<a\b[^>]*href="fitness-memberships\.html"[^>]*>/g) || [];
ck('FT-15', process.env.BASE ? true : (MB_LINKS.length >= 1 && MB_LINKS.every((a) => !/\bon[a-z]+=/i.test(a)) && fs.existsSync(path.join(ROOT, 'fitness-memberships.html'))),
  '"My memberships" entry is a plain <a href="fitness-memberships.html"> (no on* handler) and the page exists' + (process.env.BASE ? ' (n/a on BASE)' : ''), MB_LINKS.join(' '));
ck('FT-16', !/SokoniPay\s*\.|platformBook|initiateSTKPush|createPaymentIntent|fitnessCreateMembership/.test(HTML.replace(/<script[^>]*\bsrc=[^>]*><\/script>/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')),
  'fitness-hub.html itself still starts no payment: no SokoniPay / platformBook / initiateSTKPush / createPaymentIntent / fitnessCreateMembership anywhere in its markup or inline code (buying lives on fitness-memberships.html, flag-gated)');
ck('FT-14',/src="sw-register\.js"/.test(HTML) && /src="shared-header\.js"/.test(HTML), 'CONTROL: the page still self-updates (sw-register.js + shared-header.js)');

console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed' + (runErr ? '   (script error during execution: ' + runErr + ')' : ''));
process.exit(fail ? 1 : 0);
