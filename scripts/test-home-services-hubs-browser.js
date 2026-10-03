#!/usr/bin/env node
/* test-home-services-hubs-browser.js — cleaning.html + plumbing.html in a REAL browser.
 * Every external script is stubbed (SokoniProviders, SokoniBookService, SokoniInbox; all others empty), so only the
 * pages' own inline code runs and NOTHING reaches production. The stubs record what the page asked for.
 *
 *   L  listing: providers come from SokoniProviders.list({category}); escaped; no invented rating/jobs; read error ≠ empty
 *   K  booking: 📩 → SokoniBookService.open({providerId, providerName}); generic "Book now" shows the pick note
 *      and opens NO form; no localStorage write, no Firestore write, no wa.me / waConnect
 *   M  message: 💬 → SokoniInbox.openChat (in-app)
 *   F  fabrication: plumbing has no hard-coded plumbers, phones, reviews, price guide, "25+ / 4.7★ / 30 minutes"
 *   Z  negative controls
 * Run: node scripts/test-home-services-hubs-browser.js   (needs Playwright Chromium)
 */
'use strict';
const path = require('path'), fs = require('fs'), http = require('http');
const ROOT = path.join(__dirname, '..');
const PW = process.env.PLAYWRIGHT_PATH || 'C:/Users/USER1/OneDrive/Desktop/SOKONI/node_modules/playwright';
const { chromium } = require(PW);
let pass = 0, fail = 0;
const ck = (l, ok, g) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok ? '' : '   [' + String(JSON.stringify(g)).slice(0, 260) + ']')); ok ? pass++ : fail++; };

const XSS = '<img src=x onerror="window.__xss=1">';
const STUB_PROVIDERS = `
(function(){ const T = window.__T;
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (m) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
  window.firebaseDB = { stub: true };
  window.SokoniProviders = {
    esc,
    list: (o) => { T.lists.push(o); return Promise.resolve(T.listResult || { providers: [], error: null }); },
    emptyStateHtml: (err) => '<div class="sp-empty">' + (err ? 'Could not load providers' : 'No providers') + '</div>',
  };
})();`;
const STUB_BOOK = `window.SokoniBookService = { open: (o) => window.__T.opens.push(o) };`;
const STUB_INBOX = `window.SokoniInbox = { openChat: (o) => window.__T.chats.push(o) };`;

function prov (uid, extra) {
  return Object.assign({ uid, id: uid, name: 'Pro ' + uid, emoji: '🔧', location: 'Nairobi', city: 'Nairobi', description: 'Leak and pipe repairs',
    skills: ['Leak Repair'], rating: null, jobsCompleted: 0, rate: null, rateType: '', verified: false, available: true, acceptsBookings: true,
    profileUrl: 'provider-profile.html?uid=' + uid, categoryLabel: 'Plumbing', serviceType: '' }, extra || {});
}

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
async function open (browser, base, page, state, opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.mobile ? { width: 390, height: 844 } : { width: 1100, height: 900 }, serviceWorkers: 'block' });
  const pg = await ctx.newPage(); const errors = [];
  pg.on('pageerror', (e) => errors.push(String(e && e.message)));
  pg.on('dialog', (d) => d.dismiss());
  await pg.addInitScript((t) => {
    window.__T = t; t.lists = []; t.opens = []; t.chats = []; t.ls = []; t.fs = [];
    const set = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { t.ls.push(k); return set.call(this, k, v); };
    const wo = window.open; window.open = function (u) { t.wopen = (t.wopen || []).concat([String(u)]); return null; };
  }, state);
  await pg.route('**/*', async (route) => {
    const u = route.request().url(); const p = new URL(u).pathname;
    const js = (body) => route.fulfill({ status: 200, contentType: 'text/javascript', body });
    if (/\/sokoni-providers\.js$/.test(p)) return js(STUB_PROVIDERS);
    if (/\/sokoni-book-service\.js$/.test(p)) return js(STUB_BOOK);
    if (/\/sokoni-inbox\.js$/.test(p)) return js(STUB_INBOX);
    if (/gstatic\.com\/firebasejs/.test(u)) { route.request(); await pg.evaluate(() => {}).catch(() => {}); return js('export const getFirestore=()=>({});export const collection=()=>({});export const addDoc=async()=>{window.__T.fs.push(1)};export const serverTimestamp=()=>0;export const initializeApp=()=>({});export const getApps=()=>[];'); }
    if (u.startsWith(base) && /\.js$/.test(p)) return js('/* stubbed */');
    if (u.startsWith(base)) return route.continue();
    return route.fulfill({ status: 204, body: '' });
  });
  await pg.goto(base + '/' + page, { waitUntil: 'domcontentloaded' });
  await pg.waitForTimeout(opts.wait || 700);
  return { ctx, pg, errors };
}
const T = (pg) => pg.evaluate(() => window.__T);
const txt = (pg, sel) => pg.$eval(sel, (e) => e.innerText).catch(() => '');

const HUBS = [
  { page: 'cleaning.html', cat: 'cleaning', grid: '#clProviderGrid', book: '.cl-ico--book', msg: '.cl-ico--msg', note: '#clPickNote' },
  { page: 'plumbing.html', cat: 'plumbing', grid: '#pgProviderGrid', book: '[data-pg-book]', msg: '[data-pg-msg]', note: '#pgPickNote' },
];

(async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port;
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
  try {
    for (const H of HUBS) {
      const tag = H.page.replace('.html', '').toUpperCase();
      console.log(`\n── ${tag} ──`);
      const listResult = { providers: [prov('provA', { name: 'Akinyi Plumbing & Cleaning', rating: 4.6, jobsCompleted: 12, rate: 1500, rateType: 'per job', verified: true }), prov('provB', { name: XSS, description: XSS, skills: [XSS] })], error: null };
      let h = await open(browser, base, H.page, { listResult });
      let t = await T(h.pg);
      ck(`${tag} L1 providers come from SokoniProviders.list({category:'${H.cat}'})`, t.lists.length >= 1 && t.lists[0].category === H.cat, t.lists);
      let g = await txt(h.pg, H.grid);
      ck(`${tag} L2 real providers rendered (name, KES rate, rating only where real)`, g.includes('Akinyi Plumbing & Cleaning') && /KES 1,500/.test(g) && g.includes('4.6') && g.includes('New on SOKONI'), g.slice(0, 300));
      ck(`${tag} L3 XSS in name / description / skills rendered as text, never executed`, !(await h.pg.evaluate(() => window.__xss)) && (await h.pg.$$(H.grid + ' img')).length === 0);
      await h.pg.click(H.book);   /* first card = provA */
      await h.pg.waitForTimeout(80);
      t = await T(h.pg);
      ck(`${tag} K1 📩 → SokoniBookService.open({providerId, providerName}) — the ONE booking authority`, t.opens.length === 1 && t.opens[0].providerId === 'provA' && t.opens[0].providerName === 'Akinyi Plumbing & Cleaning', t.opens);
      ck(`${tag} K2 the 📩 tap did not navigate away`, /\/(cleaning|plumbing)\.html/.test(h.pg.url()), h.pg.url());
      await h.pg.click(H.msg); await h.pg.waitForTimeout(60);
      t = await T(h.pg);
      ck(`${tag} M1 💬 → SokoniInbox.openChat (in-app) with the provider uid`, t.chats.length === 1 && t.chats[0].otherUid === 'provA', t.chats);
      await h.pg.locator('button[onclick="openBooking()"]:visible').first().click(); await h.pg.waitForTimeout(120);
      t = await T(h.pg);
      ck(`${tag} K3 generic "Book now" shows the pick note, opens NO form and NO booking`, await h.pg.$eval(H.note, (e) => !e.hidden) && t.opens.length === 1 && !(await h.pg.$('#clModalOverlay.open, #pgModalOverlay.open, #clName, #pgName')));
      ck(`${tag} K4 no booking written to localStorage, no Firestore SDK write, no wa.me`, !t.ls.some((k) => /Booking/i.test(k)) && t.fs.length === 0 && !(t.wopen || []).some((u) => /wa\.me|whatsapp/i.test(u)), { ls: t.ls, fs: t.fs, w: t.wopen });
      ck(`${tag} K5 no page errors`, h.errors.length === 0, h.errors);
      await h.ctx.close();

      h = await open(browser, base, H.page, { listResult: { providers: [], error: new Error('denied') } });
      ck(`${tag} L4 read error → "Could not load providers" (not "No providers")`, (await txt(h.pg, H.grid)).includes('Could not load providers'));
      await h.ctx.close();
      h = await open(browser, base, H.page, { listResult: { providers: [], error: null } }, { mobile: true });
      ck(`${tag} L5 empty registry → honest empty state + register link; no horizontal scroll on phone`, /No (cleaners|plumbers) found yet/.test(await txt(h.pg, H.grid)) && await h.pg.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
      await h.ctx.close();
    }

    console.log('\n── F: fabrication removed ──');
    const PL = fs.readFileSync(path.join(ROOT, 'plumbing.html'), 'utf8');
    const CL = fs.readFileSync(path.join(ROOT, 'cleaning.html'), 'utf8');
    const strip = (x) => x.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const pl = strip(PL), cl = strip(CL);
    ck('F1 plumbing: no hard-coded plumbers or phone numbers', !/PipePro|AquaFix|DrainMaster|07\d{8}/.test(pl));
    ck('F2 plumbing: no invented reviews, price guide or stats', !/class="pg-review-card|KES 300 – 800|25\+<\/strong>|4\.7★|within 30 minutes|same day/i.test(pl));
    ck('F3 plumbing: the count is the registry\'s, "—" until known', /id="pgStatCount">—</.test(PL) && /pgStatCount'\); if \(st\) st\.textContent = _pgError \? '—' : String\(PROVIDERS\.length\)/.test(PL));
    ck('F4 neither page writes a booking itself (no addDoc / homeServiceBookings / sokoniBookings / waConnect / submitBooking)', ![pl, cl].some((x) => /addDoc|homeServiceBookings|sokoniBookings|sokoniCleaningBookings|waConnect|submitBooking/.test(x)));
    ck('F5 both pages load the booking modal + in-app inbox', [PL, CL].every((x) => /sokoni-book-service\.js/.test(x) && /sokoni-inbox\.js/.test(x)));
    ck('F6 both pages still self-update (sw-register.js)', [PL, CL].every((x) => /sw-register\.js/.test(x)));

    console.log('\n── Z: negative controls ──');
    ck('Z1 the git parent of plumbing.html really had the fabricated plumbers F1 rejects', /PipePro/.test(require('child_process').execSync('git show HEAD:plumbing.html', { cwd: ROOT, encoding: 'utf8' })));
    ck('Z2 the git parent of cleaning.html really wrote homeServiceBookings (F4 is not vacuous)', /homeServiceBookings/.test(require('child_process').execSync('git show HEAD:cleaning.html', { cwd: ROOT, encoding: 'utf8' })));
  } finally { await browser.close(); srv.close(); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
