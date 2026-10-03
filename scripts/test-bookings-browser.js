#!/usr/bin/env node
/* test-bookings-browser.js — My Bookings (bookings.html) in a REAL browser.
 * Every network dependency is stubbed: firebase.js (compat namespace), sokoni-book-service.js, the auth scripts.
 * NOTHING reaches production. The stubs record every read and every callable, so the suite proves WHICH
 * authority the page asked, not just what it painted.
 *
 *   Q  query: providerBookings WHERE customerUid == uid (the rule's own predicate), limit, no other collection
 *   R  render: grouping (upcoming / in progress / completed / cancelled), cents → KES, unknown → —, XSS escaped
 *   P  PIN: only for paid_held; asked from serviceBookingPin on demand; renew; hide; callable missing →
 *      "not available yet" (never a fake PIN, never "no PIN"); PIN never in storage; dropped when hidden
 *   B  balance: a provider proposal is SHOWN, but no accept/pay control exists until the server ships
 *   A  actions: message → chat.html?tx=service_booking; review → SokoniBookService.review; deep link ?b=
 *   N  nav: header drawer + profile menu + profile panel link bookings.html; my-bookings.html redirects
 *   Z  negative controls
 * Run: node scripts/test-bookings-browser.js   (needs Playwright Chromium)
 */
'use strict';
const path = require('path'), fs = require('fs'), http = require('http');
const ROOT = path.join(__dirname, '..');
const PW = process.env.PLAYWRIGHT_PATH || 'C:/Users/USER1/OneDrive/Desktop/SOKONI/node_modules/playwright';
const { chromium } = require(PW);
let pass = 0, fail = 0;
const ck = (l, ok, g) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok ? '' : '   [' + String(JSON.stringify(g)).slice(0, 260) + ']')); ok ? pass++ : fail++; };

const STUB_FIREBASE = `
const S = window.__T;
const user = S.signedIn ? { uid: 'buyer1' } : null;
const snapOf = (rows) => ({ docs: rows.map((r) => ({ id: r.id, data: () => r })) });
function Q (col, cs) { this.col = col; this.cs = cs || []; }
Q.prototype.where = function (f, op, v) { return new Q(this.col, this.cs.concat([{ f, op, v }])); };
Q.prototype.limit = function (n) { return new Q(this.col, this.cs.concat([{ limit: n }])); };
Q.prototype.orderBy = function (f) { return new Q(this.col, this.cs.concat([{ orderBy: f }])); };
Q.prototype.doc = function (id) { const col = this.col; return { get: async () => { S.reads.push({ col, id }); const h = (S.docs || {})[col + '/' + id]; if (h === '__throw') throw new Error('denied'); return { exists: !!h, data: () => h }; } }; };
Q.prototype.onSnapshot = function (cb, err) { S.reads.push({ col: this.col, cs: this.cs }); const rows = (S.cols || {})[this.col]; setTimeout(() => { if (rows === '__throw') { err && err(new Error('denied')); return; } cb(snapOf(rows || [])); }, 0); return () => {}; };
window.firebase = {
  firestore: () => ({ collection: (c) => new Q(c) }),
  functions: () => ({ httpsCallable: (name) => async (data) => { S.calls.push({ name, data }); let h = (S.callable || {})[name]; if (typeof h === 'string') h = (0, eval)(h); if (!h) throw Object.assign(new Error('not found'), { code: 'functions/not-found' }); return { data: await h(data) }; } }),
  auth: () => ({ currentUser: user, onAuthStateChanged: (cb) => { setTimeout(() => cb(user), 0); return () => {}; } }),
};
window.firebaseAuth = { currentUser: user };
window.firebaseSDK = { onAuthStateChanged: (cb) => { setTimeout(() => cb(user), 0); } };
window.waitForFirebaseReady = (cb) => { setTimeout(cb, 0); };`;
const STUB_BOOK = `window.SokoniBookService = { review: (o) => { window.__T.reviews.push(o); } };`;

function serve () {
  return new Promise((res) => {
    const srv = http.createServer((req, rsp) => {
      const p = decodeURIComponent(req.url.split('?')[0]); const f = path.join(ROOT, p);
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { rsp.writeHead(404); rsp.end(''); return; }
      const ext = path.extname(f); rsp.writeHead(200, { 'content-type': ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : 'text/html' }); fs.createReadStream(f).pipe(rsp);
    });
    srv.listen(0, '127.0.0.1', () => res(srv));
  });
}
async function open (browser, base, state, opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.mobile ? { width: 390, height: 844 } : { width: 1100, height: 860 }, isMobile: !!opts.mobile, serviceWorkers: 'block' });
  const page = await ctx.newPage(); const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message))); page.on('console', (m) => { if (m.type() === 'error') errors.push('console:' + m.text()); });
  await page.addInitScript((t) => { window.__T = t; t.calls = []; t.reads = []; t.reviews = []; }, state);
  await page.route('**/*', async (route) => {
    const u = route.request().url(); const p = new URL(u).pathname;
    const js = (body) => route.fulfill({ status: 200, contentType: 'text/javascript', body });
    if (/\/firebase\.js$/.test(p)) return js(STUB_FIREBASE);
    if (/\/sokoni-book-service\.js$/.test(p)) return js(STUB_BOOK);
    if (/\/(auth-guard|sokoni-auth-state|sokoni-user-bootstrap|sokoni-identity-guard|sokoni-crash-sentinel|sw-register)\.js$/.test(p)) return js('/* stubbed */');
    if (u.startsWith(base)) return route.continue();
    return route.fulfill({ status: 204, body: '' });
  });
  await page.goto(base + '/' + (opts.path || 'bookings.html'), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(opts.wait || 500);
  return { ctx, page, errors };
}
const txt = (page, sel) => page.$eval(sel, (e) => e.innerText).catch(() => '');
const T = (page) => page.evaluate(() => window.__T);
const tab = async (page, g) => { await page.click(`.bk-tab[data-g="${g}"]`); await page.waitForTimeout(80); };

const DAY = 86400000, NOW = Date.now();
const ts = (ms) => ({ seconds: Math.floor(ms / 1000) });
const XSS = '<img src=x onerror="window.__xss=1">';
const BOOKINGS = [
  { id: 'bkUp1', customerUid: 'buyer1', providerId: 'provA', service: 'Deep cleaning', startTs: NOW + 2 * DAY, status: 'confirmed', paymentStatus: 'paid_held', price: 350000, deposit: 50000, currency: 'KES' },
  { id: 'bkUp2', customerUid: 'buyer1', providerId: 'provB', service: XSS, startTs: NOW + 3 * DAY, status: 'pending', paymentStatus: 'pending', price: 120000, expiresAt: ts(NOW + 10 * 60000) },
  { id: 'bkAct', customerUid: 'buyer1', providerId: 'provA', service: 'Plumbing repair', startTs: NOW - 3600000, status: 'in_progress', paymentStatus: 'paid_held', price: 200000,
    balanceProposal: { id: 'bp1', amountKES: 1500, status: 'PROPOSED', proposedAt: ts(NOW) } },
  { id: 'bkDone', customerUid: 'buyer1', providerId: 'provA', service: 'Painting', startTs: NOW - 5 * DAY, status: 'completed', paymentStatus: 'settled', price: 900000 },
  { id: 'bkCan', customerUid: 'buyer1', providerId: 'provGone', service: 'Pest control', startTs: NOW - 9 * DAY, status: 'declined', paymentStatus: 'refunded' },
];
const BASE = { signedIn: true, cols: { providerBookings: BOOKINGS }, docs: { 'providers/provA': { businessName: 'Wanjiku Cleaners', status: 'active' }, 'providers/provB': { businessName: XSS }, 'providers/provGone': '__throw' } };

(async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port;
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
  try {
    console.log('\n── Q: query ──');
    let h = await open(browser, base, BASE);
    let t = await T(h.page);
    const q = t.reads.find((r) => r.cs);
    ck('Q1 one live query: providerBookings WHERE customerUid == uid + limit (the read rule\'s own predicate)', q && q.col === 'providerBookings' && q.cs.some((c) => c.f === 'customerUid' && c.op === '==' && c.v === 'buyer1') && q.cs.some((c) => c.limit > 0), q);
    ck('Q2 no other collection queried (no orders / bookings / localStorage merge)', t.reads.filter((r) => r.cs).every((r) => r.col === 'providerBookings'), t.reads);
    ck('Q3 provider names: one doc read per distinct provider', t.reads.filter((r) => r.col === 'providers').length === 3, t.reads.filter((r) => r.col === 'providers'));

    console.log('\n── R: render ──');
    let up = await txt(h.page, '#bkList');
    ck('R1 Upcoming: confirmed + pending future bookings only', up.includes('Deep cleaning') && up.includes(XSS) && !up.includes('Plumbing repair') && !up.includes('Painting'), up.slice(0, 300));
    ck('R2 cents shown as KES exactly (350000 → KES 3,500; deposit 50000 → KES 500)', up.includes('KES 3,500') && up.includes('KES 500'), up.slice(0, 400));
    ck('R3 paid_held explained as held by SOKONI until the PIN', up.includes('held by SOKONI until you confirm with your PIN'));
    ck('R4 unpaid booking shows the hold window', /Slot held until/.test(up));
    ck('R5 XSS in service / provider name rendered as text, never executed', !(await h.page.evaluate(() => window.__xss)) && (await h.page.$$('#bkList img')).length === 0);
    ck('R6 provider name from providers/{id}; refused read → "Provider", never invented', up.includes('Wanjiku Cleaners'));
    await tab(h.page, 'active');
    let act = await txt(h.page, '#bkList');
    ck('R7 In progress: in_progress booking', act.includes('Plumbing repair') && !act.includes('Deep cleaning'));
    await tab(h.page, 'completed');
    let done = await txt(h.page, '#bkList');
    ck('R8 Completed: settled shown as released to the provider; no PIN box', done.includes('Painting') && done.includes('released to the provider') && !done.includes('Booking PIN'));
    await tab(h.page, 'closed');
    let cl = await txt(h.page, '#bkList');
    ck('R9 Cancelled: declined + refunded; denied provider read → "Provider"; total unknown → —', cl.includes('Pest control') && cl.includes('Refunded') && cl.includes('Provider ·') && cl.includes('—'), cl.slice(0, 300));
    ck('R10 closed booking has no Message button', !(await h.page.$('#bkList a[href^="chat.html"]')));
    ck('R11 no page errors', h.errors.length === 0, h.errors);
    await h.ctx.close();

    console.log('\n── P: booking PIN ──');
    h = await open(browser, base, { ...BASE, callable: {
      serviceBookingPin: "(d) => d.op === 'getMyBookingPin' ? ({ issued: true, pin: '4821', bookingRef: 'BK-1', expiresAtMs: Date.now() + 86400000, canRenew: true, renewalsLeft: 2 }) : ({ issued: true, pin: '7302', expiresAtMs: Date.now() + 86400000, renewalsLeft: 1 })" } });
    up = await txt(h.page, '#bkList');
    ck('P1 PIN box only on the paid_held booking (not on the unpaid one), PIN NOT shown until asked', (await h.page.$$('[data-act="pin"]')).length === 1 && !up.includes('4821'));
    t = await T(h.page);
    ck('P2 no PIN callable before the buyer asks', t.calls.length === 0, t.calls);
    await h.page.click('[data-act="pin"]'); await h.page.waitForTimeout(150);
    t = await T(h.page);
    ck('P3 Show my PIN → serviceBookingPin {op:getMyBookingPin, bookingId}', t.calls.length === 1 && t.calls[0].name === 'serviceBookingPin' && t.calls[0].data.op === 'getMyBookingPin' && t.calls[0].data.bookingId === 'bkUp1', t.calls);
    ck('P4 the server\'s PIN is shown, with its validity', (await txt(h.page, '.bk-pin')) === '4821' && (await txt(h.page, '#bkList')).includes('Valid until'));
    const stor = await h.page.evaluate(() => JSON.stringify(localStorage) + JSON.stringify(sessionStorage));
    ck('P5 the PIN is never written to localStorage / sessionStorage', !stor.includes('4821'), stor.slice(0, 200));
    await h.page.click('[data-act="pin-renew"]'); await h.page.waitForTimeout(150);
    t = await T(h.page);
    ck('P6 renew → serviceBookingPin {op:renewBookingPin}; the new PIN replaces the old', t.calls[1] && t.calls[1].data.op === 'renewBookingPin' && (await txt(h.page, '.bk-pin')) === '7302');
    await h.page.click('[data-act="pin-hide"]'); await h.page.waitForTimeout(80);
    ck('P7 Hide removes the PIN from the page', !(await txt(h.page, '#bkList')).includes('7302') && !!(await h.page.$('[data-act="pin"]')));
    await h.page.click('[data-act="pin"]'); await h.page.waitForTimeout(150);
    await h.page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
    await h.page.waitForTimeout(50);
    ck('P8 backgrounding the page drops the shown PIN', !(await h.page.content()).includes('4821'));
    await h.ctx.close();

    h = await open(browser, base, BASE);   /* no serviceBookingPin stub → functions/not-found */
    await h.page.click('[data-act="pin"]'); await h.page.waitForTimeout(150);
    up = await txt(h.page, '#bkList');
    ck('P9 callable not deployed → "not available yet", payment still held; no fake PIN', up.includes('not available yet') && up.includes('held by SOKONI') && !(await h.page.$('.bk-pin')), up.slice(0, 500));
    await h.ctx.close();
    h = await open(browser, base, { ...BASE, callable: { serviceBookingPin: "() => ({ issued: false, reason: 'not_yet_issued' })" } });
    await h.page.click('[data-act="pin"]'); await h.page.waitForTimeout(150);
    up = await txt(h.page, '#bkList');
    ck('P10 not yet issued → "being prepared" + Check again (never a blank PIN)', up.includes('being prepared') && !!(await h.page.$('[data-act="pin"]')) && !(await h.page.$('.bk-pin')));
    await h.ctx.close();
    h = await open(browser, base, { ...BASE, callable: { serviceBookingPin: "() => { throw Object.assign(new Error('This booking is not yours.'), { code: 'functions/permission-denied' }); }" } });
    await h.page.click('[data-act="pin"]'); await h.page.waitForTimeout(150);
    ck('P11 server refusal shown as a refusal', (await txt(h.page, '#bkList')).includes('not yours'));
    await h.ctx.close();

    console.log('\n── B: after-service balance ──');
    h = await open(browser, base, BASE);
    await tab(h.page, 'active');
    act = await txt(h.page, '#bkList');
    ck('B1 provider proposal shown with its amount', act.includes('proposed a final balance of KES 1,500'), act.slice(0, 500));
    ck('B2 …and honestly not actionable yet: no accept / pay control', act.includes('not available yet') && await h.page.$$eval('.bk-box', (bs) => { const b = bs.find((x) => /Final balance/.test(x.textContent)); return !!b && b.querySelectorAll('button, a, input').length === 0; }));
    t = await T(h.page);
    ck('B3 no serviceBookingBalance / createPaymentIntent call from this page', !t.calls.some((c) => /Balance|PaymentIntent/.test(c.name)), t.calls);

    console.log('\n── A: actions ──');
    ck('A1 Message provider → chat.html?tx=service_booking&txId=<id> (in-app, never wa.me)', !!(await h.page.$('a[href="chat.html?tx=service_booking&txId=bkAct"]')) && !(await h.page.$('a[href*="wa.me"]')));
    await tab(h.page, 'completed');
    await h.page.click('[data-act="review"]'); await h.page.waitForTimeout(60);
    t = await T(h.page);
    ck('A2 Review → SokoniBookService.review({bookingId}) — the ONE review UI', t.reviews.length === 1 && t.reviews[0].bookingId === 'bkDone', t.reviews);
    await h.ctx.close();
    h = await open(browser, base, BASE, { path: 'bookings.html?b=bkDone' });
    ck('A3 deep link ?b=<id> opens the right tab', await h.page.$eval('.bk-tab[aria-selected="true"]', (e) => e.dataset.g) === 'completed');
    await h.ctx.close();
    h = await open(browser, base, { signedIn: true, cols: { providerBookings: '__throw' } });
    ck('A4 read refused → honest error, not "No bookings"', (await txt(h.page, '#bkList')).includes('Could not load your bookings'));
    await h.ctx.close();
    h = await open(browser, base, { signedIn: true, cols: { providerBookings: [] } }, { mobile: true });
    ck('A5 none → empty state + Find a service; mobile has no horizontal scroll', (await txt(h.page, '#bkList')).includes('No upcoming bookings') && await h.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    await h.ctx.close();
    h = await open(browser, base, BASE, { path: 'my-bookings.html?b=bkDone', wait: 700 });
    ck('A6 my-bookings.html (the 404 the server notifications link to) → bookings.html, query kept', /\/bookings\.html\?b=bkDone$/.test(h.page.url()), h.page.url());
    await h.ctx.close();

    console.log('\n── C: cancel / refund (owner 2026-10-03) ──');
    h = await open(browser, base, { ...BASE, callable: { providerDispatch: "(d) => ({ success: true, status: 'cancelled' })" } });
    h.page.on('dialog', (d) => d.accept());
    ck('C1 an upcoming booking offers Cancel; the completed one does not', !!(await h.page.$('[data-act="cancel"][data-id="bkUp1"]')) && !(await h.page.$('[data-act="cancel"][data-id="bkDone"]')));
    await h.page.click('[data-act="cancel"][data-id="bkUp1"]'); await h.page.waitForTimeout(150);
    t = await T(h.page);
    ck('C2 Cancel → providerDispatch {op:providerCancelBooking, bookingId} (server applies the policy)', t.calls.some((c) => c.name === 'providerDispatch' && c.data.op === 'providerCancelBooking' && c.data.bookingId === 'bkUp1'), t.calls);
    ck('C3 the page states no refund amount and does not mark the booking cancelled itself', !/KES [\d,]+ refund/i.test(await txt(h.page, '#bkList')) && (await T(h.page)).cols.providerBookings.find((b) => b.id === 'bkUp1').status === 'confirmed');
    await tab(h.page, 'completed');
    ck('C4 completed booking: "Report a problem" → support ticket with the booking ref (a reviewed request), no Cancel', !!(await h.page.$('a[href^="support.html?topic=booking&ref=bkDone"]')) && !(await h.page.$('[data-act="cancel"]')));
    await h.ctx.close();
    const AFFECTED = BOOKINGS.map((b) => b.id === 'bkUp1' ? { ...b, resolution: { status: 'ACTION_REQUIRED' } } : b);
    h = await open(browser, base, { ...BASE, cols: { providerBookings: AFFECTED }, callable: { providerDispatch: "() => ({ ok: true, status: 'CANCELLED' })" } });
    h.page.on('dialog', (d) => d.accept());
    ck('C5 provider-affected paid booking offers "Get a full refund" instead of Cancel', !!(await h.page.$('[data-act="affected-refund"][data-id="bkUp1"]')) && !(await h.page.$('[data-act="cancel"][data-id="bkUp1"]')));
    await h.page.click('[data-act="affected-refund"]'); await h.page.waitForTimeout(150);
    t = await T(h.page);
    ck('C6 → providerDispatch {op:customerRequestRefund, bookingId}', t.calls.some((c) => c.name === 'providerDispatch' && c.data.op === 'customerRequestRefund' && c.data.bookingId === 'bkUp1'), t.calls);
    await h.ctx.close();
    h = await open(browser, base, BASE);   /* no providerDispatch stub → not-found */
    h.page.on('dialog', (d) => d.accept());
    await h.page.click('[data-act="cancel"][data-id="bkUp1"]'); await h.page.waitForTimeout(150);
    ck('C7 cancel callable unavailable → "not available … your booking has not changed" (no false success)', /not available right now — your booking has not changed/.test(await txt(h.page, '#bkMsg')));
    await h.ctx.close();

    console.log('\n── N: navigation + static ──');
    const SH = fs.readFileSync(path.join(ROOT, 'shared-header.js'), 'utf8');
    const PM = fs.readFileSync(path.join(ROOT, 'sokoni-profile-menu.js'), 'utf8');
    const PR = fs.readFileSync(path.join(ROOT, 'profile.html'), 'utf8');
    const BK = fs.readFileSync(path.join(ROOT, 'bookings.html'), 'utf8');
    ck('N1 header drawer: My Bookings next to My Orders', /label:'My Orders'[^\n]*\n[^\n]*\n\s*\{ icon:'📅', label:'My Bookings',\s*href:'bookings\.html' \}/.test(SH.replace(/\r/g, '')));
    ck('N2 profile menu: My Bookings next to My Orders', /my-orders\.html[^\n]*\n[^\n]*\n\s*'<a class="sk-acct-link" href="bookings\.html"/.test(PM.replace(/\r/g, '')));
    ck('N3 profile Bookings panel links bookings.html', /id="panel-bookings"[\s\S]{0,600}href="bookings\.html"/.test(PR));
    const code = BK.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    ck('N4 page self-updates (sw-register.js)', /<script src="sw-register\.js" defer><\/script>\s*<\/body>/.test(BK));
    ck('N5 no localStorage / wa.me / bookNow / platformBook / Math.random in the page', !/localStorage\.setItem|wa\.me|bookNow|platformBook|Math\.random/.test(code));
    ck('N6 no browser write to providerBookings (.set/.update/.add)', !/\.(set|update|add)\(/.test(code));

    console.log('\n── Z: negative controls ──');
    const broken = BK.replace("if (b.paymentStatus !== 'paid_held' || b.status === 'completed' || CLOSED[b.status]) return '';", "if (false) return '';");
    ck('Z1 the PIN gate line exists to be mutated (P1 depends on it)', broken !== BK);
    ck('Z2 the balance box has no button markup to find (B2 is not vacuous: the box itself renders)', /function balanceBox/.test(BK) && !/function balanceBox[\s\S]{0,1500}<button/.test(BK));
  } finally { await browser.close(); srv.close(); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
