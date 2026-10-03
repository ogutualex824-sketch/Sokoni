#!/usr/bin/env node
/**
 * Fitness Memberships UI — browser certification. QUEUED: written with the slice, NOT yet run
 * (2026-10-03: free RAM ≈270 MB < the 512 MB floor — no browsers launched).
 *
 * At 390x844 (phone) and 1280x800 (desktop):
 *   GYM (sokoni-fitness-memberships.js mounted in a harness page with the provider-dashboard tokens)
 *     FMB1 hidden when the workspace lacks 'memberships'; visible when AVAILABLE
 *     FMB2 gym list renders server rows ("Unlimited", "—", escaped names); no horizontal scroll
 *     FMB3 scan flow with a stubbed fitnessCheckIn: "Checking with SOKONI…" first, then the server-built
 *          ATTENDANCE RECORDED card; a refusal shows the mapped text; offline shows "Attendance unavailable — retry when connected"
 *     FMB4 BUSINESS_LINK_MISSING → SCAN MEMBER QR disabled with the setup/support reason; keyboard focus visible on the button
 *   MEMBER (the real fitness-memberships.html)
 *     FMB5 member page lists memberships, pending shows "Waiting for payment confirmation", owner refund wording
 *     FMB6 QR screen: active only; canvas drawn; Escape closes and focus returns
 *     FMB7 buy flow with the flag OFF: BUY disabled + "Memberships aren't on sale yet"; no create/intent call
 *     FMB8 buy flow with the flag ON: create → intent → STK stub; the card stays "Waiting for payment confirmation"
 *     FMB9 no horizontal page scroll at either width; no uncaught error from the page's own scripts
 *
 * Real files over a local static server. ALL external network (Firebase, gstatic, IntaSend) is aborted; Firebase is
 * replaced by an in-page stub, so nothing reaches production.   node scripts/test-fitness-memberships-browser.js
 */
'use strict';
const path = require('path'), http = require('http'), fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
const pw = require(path.join(ROOT, 'node_modules', 'playwright'));
const say = console.log;
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 400) + ']' : '')); ok ? pass++ : fail++; };
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml' };
const HARNESS = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<style>:root{--bg:#050505;--surf:#0d0d0d;--surf2:#141414;--border:#1a1a1a;--acc:#71ff00;--text:#e8e8e8;--sub:#888}html,body{background:var(--bg);color:var(--text);margin:0;overflow-x:hidden}</style>' +
  '<script src="security.js"></script></head><body><div class="panel" id="panel-memberships"><div style="padding:14px 16px"><div id="mbList"></div></div></div>' +
  '<script src="sokoni-fitness-memberships.js"></script></body></html>';
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  if (u === '/__fitness-gym-harness.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(HARNESS); }
  if (u === '/sokoni-intasend.js') { res.writeHead(200, { 'Content-Type': 'application/javascript' }); return res.end('/* stubbed by the test */'); }
  const f = path.join(ROOT, u === '/' ? 'index.html' : u);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});

/* In-page Firebase stub. `cfg` is serialised into the page: callables (name → {data}|{error}|{delayMs,data}), docs, flag. */
function stub(cfg) {
  const calls = (window.__calls = []);
  const membership = cfg.memberships || [];
  const callable = (name) => async (data) => {
    calls.push({ name, data });
    const h = cfg.callables[name];
    if (!h) throw Object.assign(new Error('not stubbed'), { code: 'functions/not-found' });
    if (h.delayMs) await new Promise((r) => setTimeout(r, h.delayMs));
    if (h.error) throw Object.assign(new Error(h.error.message), { code: 'functions/' + h.error.code, details: h.error.details });
    return { data: h.data };
  };
  const snapOf = (rows) => ({ docs: rows.map((x) => ({ id: x.id, data: () => x.data })) });
  const q = (p) => ({ where: () => q(p), orderBy: () => q(p), limit: () => q(p),
    get: async () => snapOf(p === 'providerServices' ? (cfg.offers || []) : []),
    onSnapshot: (fn) => { window.__push = (rows) => fn(snapOf(rows)); fn(snapOf(membership)); return () => {}; },
    doc: (id) => ({ collection: () => q(p + '/' + id + '/x'), get: async () => ({ exists: false, data: () => undefined }) }) });
  const user = { uid: 'UID_TEST', phoneNumber: '+254712345678' };
  window.firebase = {
    functions: () => ({ httpsCallable: callable }),
    firestore: () => ({ collection: (p) => (p === 'featureFlags'
      ? { doc: () => ({ get: async () => (cfg.flag === undefined ? { exists: false, data: () => undefined } : { exists: true, data: () => cfg.flag }) }) }
      : q(p)) }),
    auth: () => ({ currentUser: user, onAuthStateChanged: (cb) => { setTimeout(() => cb(user), 0); return () => {}; } }),
  };
  window.waitForFirebaseReady = () => Promise.resolve();
  window.__stk = [];
  Object.defineProperty(window, 'SokoniIntaSend', { configurable: true, value: { initiateSTKPush: async (p, a, r) => { window.__stk.push({ p, a, r }); return { checkoutId: 'C1' }; } } });
  if (cfg.workspace !== undefined) window.__sokoniWorkspace = cfg.workspace;
  if (cfg.offline) Object.defineProperty(navigator, 'onLine', { get: () => false });
}

const ROWS = [
  { membershipId: 'MEMBERSHIPAAA111', member: { displayName: 'Hostile <img src=x onerror=alert(1)>' }, title: 'Gold', sessionsIncluded: null, attendedSessions: 3, remaining: null, status: 'active', paymentStatus: 'paid_held' },
  { membershipId: 'MEMBERSHIPCCC333', member: {}, title: 'Mystery', sessionsIncluded: 8, status: 'active' },
];
const OK_CHECKIN = { ok: true, duplicate: false, attendanceId: 'd_1', status: 'checked_in', attendedSessions: 4, sessionsIncluded: 12, membershipId: 'MEMBERSHIPABC123', member: { displayName: 'Alex' }, checkedInAt: '2026-10-03T07:42:00Z' };
const MEMBERS = [
  { id: 'MEM_ACTIVE_0001', data: { title: 'Gold', status: 'active', paymentStatus: 'paid_held', attendedSessions: 0, refundEligible: true, priceCents: 350000, periodCount: 1, periodUnit: 'month' } },
  { id: 'MEM_PENDING_001', data: { title: 'Silver', status: 'pending_payment', paymentStatus: 'pending' } },
];
const OFFERS = [{ id: 'SVC_1', data: { name: 'Monthly', price: 350000, periodCount: 1, periodUnit: 'month', serviceKind: 'membership', active: true } }];

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = 'http://127.0.0.1:' + server.address().port;
  const browser = await pw.chromium.launch();
  const open = async (vp, url, cfg) => {
    const ctx = await browser.newContext({ viewport: vp, serviceWorkers: 'block' });
    await ctx.route('**/*', (r) => (r.request().url().startsWith(BASE) ? r.continue() : r.abort()));
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(stub, cfg);
    await page.goto(BASE + url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);
    return { ctx, page, errors };
  };
  const noScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  try {
    for (const vp of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
      say('\n  viewport ' + vp.width + 'x' + vp.height);
      /* FMB1 */
      let t = await open(vp, '/__fitness-gym-harness.html', { workspace: { state: 'AVAILABLE', modules: { leads: { state: 'AVAILABLE' } } }, callables: {} });
      const hidden = await t.page.evaluate(() => { const ok = SokoniFitnessMemberships.mount(document.getElementById('mbList')); return { ok, html: document.getElementById('mbList').innerHTML, calls: window.__calls.length }; });
      await t.ctx.close();
      t = await open(vp, '/__fitness-gym-harness.html', { workspace: { state: 'AVAILABLE', modules: { memberships: { state: 'AVAILABLE' } } },
        callables: { fitnessScannerStatus: { data: { canScan: true, role: 'owner' } }, fitnessGymMemberships: { data: { rows: ROWS } }, fitnessCheckIn: { delayMs: 600, data: OK_CHECKIN } } });
      await t.page.evaluate(() => SokoniFitnessMemberships.mount(document.getElementById('mbList')));
      await t.page.waitForTimeout(300);
      ck('FMB1 hidden without the memberships module; shown when AVAILABLE', hidden.ok === false && hidden.html === '' && hidden.calls === 0 && await t.page.isVisible('text=SCAN MEMBER QR'), hidden);
      const list = await t.page.evaluate(() => document.querySelector('.sfm-rows').innerText);
      ck('FMB2 rows: Unlimited, "—" for unknowns, escaped names, no horizontal scroll', /Unlimited/.test(list) && /—/.test(list) && /<img src=x/.test(list) && !(await t.page.$('.sfm-rows img')) && await noScroll(t.page), list.slice(0, 200));
      await t.page.click('text=SCAN MEMBER QR');
      await t.page.fill('#sfmPaste', 'fm1.token.sig');
      await t.page.click('button:has-text("Check in")');
      const mid = await t.page.evaluate(() => document.querySelector('.sfm-result').innerText);
      await t.page.waitForSelector('[data-sfm-result="recorded"]', { timeout: 3000 }).catch(() => {});
      const fin = await t.page.evaluate(() => document.querySelector('.sfm-result').innerText);
      ck('FMB3 scan: "Checking with SOKONI…" first, then the server-built card', /Checking with SOKONI/.test(mid) && !/ATTENDANCE RECORDED/.test(mid)
        && /ATTENDANCE RECORDED · Alex — Membership #ABC123 · Session 4 of 12 · Check-in: 10:42/.test(fin), { mid, fin });
      await t.ctx.close();
      t = await open(vp, '/__fitness-gym-harness.html', { workspace: { state: 'AVAILABLE', modules: { memberships: { state: 'AVAILABLE' } } },
        callables: { fitnessScannerStatus: { data: { canScan: false, reason: 'BUSINESS_LINK_MISSING' } }, fitnessGymMemberships: { data: { rows: [] } } } });
      await t.page.evaluate(() => SokoniFitnessMemberships.mount(document.getElementById('mbList')));
      await t.page.waitForTimeout(300);
      const dis = await t.page.evaluate(() => ({ d: document.querySelector('.sfm-scan').disabled, n: document.getElementById('sfmScanNote').innerText }));
      ck('FMB4 BUSINESS_LINK_MISSING → scan disabled with the real reason', dis.d === true && /isn't linked to a business record yet/.test(dis.n) && /SOKONI support/.test(dis.n), dis);
      await t.ctx.close();

      /* member page */
      t = await open(vp, '/fitness-memberships.html?provider=PROVIDER_1', { memberships: MEMBERS, offers: OFFERS,
        callables: { fitnessMembershipQr: { data: { token: 'fm1.QRTOKEN.sig', expiresAt: new Date(Date.now() + 300000).toISOString(), ttlSeconds: 300 } } } });
      await t.page.waitForTimeout(500);
      const ml = await t.page.evaluate(() => document.getElementById('fmList').innerText);
      ck('FMB5 member list: pending wording, owner refund wording', /Waiting for payment confirmation/.test(ml) && /Eligible to request, subject to policy/.test(ml), ml.slice(0, 300));
      await t.page.click('button:has-text("VIEW MEMBERSHIP QR")');
      await t.page.waitForSelector('#fmQrImg canvas', { timeout: 3000 }).catch(() => {});
      const qr = await t.page.evaluate(() => ({ canvas: !!document.querySelector('#fmQrImg canvas'), txt: document.getElementById('fmQr').innerText, qrBtns: document.querySelectorAll('[data-fm-act="qr"]').length }));
      await t.page.keyboard.press('Escape');
      const closed = await t.page.evaluate(() => document.getElementById('fmQr').hidden && /VIEW MEMBERSHIP QR/.test(document.activeElement && document.activeElement.textContent || ''));
      ck('FMB6 QR: one button (active only), canvas drawn, short ref only, Escape closes and returns focus', qr.canvas && qr.qrBtns === 1 && !/MEM_ACTIVE_0001/.test(qr.txt) && closed, qr);
      const buyOff = await t.page.evaluate(() => { const b = document.querySelector('[data-fm-act="buy"]'); return { dis: b && b.disabled, txt: document.getElementById('fmBuy').innerText }; });
      ck('FMB7 flag OFF: BUY disabled, "Memberships aren\'t on sale yet", no create/intent call', buyOff.dis === true && /Memberships aren't on sale yet/.test(buyOff.txt)
        && !(await t.page.evaluate(() => window.__calls.some((c) => /fitnessCreateMembership|createPaymentIntent/.test(c.name)))), buyOff);
      ck('FMB9a member page: no horizontal scroll; no uncaught page error', await noScroll(t.page) && t.errors.length === 0, t.errors);
      await t.ctx.close();
      t = await open(vp, '/fitness-memberships.html?provider=PROVIDER_1', { memberships: MEMBERS, offers: OFFERS, flag: { enabled: true },
        callables: { fitnessCreateMembership: { data: { membershipId: 'MEM_PENDING_001' } }, createPaymentIntent: { data: { ref: 'SOK-REF-1', amount: 3500, currency: 'KES' } } } });
      await t.page.waitForTimeout(500);
      await t.page.click('button:has-text("BUY MEMBERSHIP")');
      await t.page.waitForSelector('#fmPhone', { timeout: 3000 }).catch(() => {});
      await t.page.fill('#fmPhone', '0712345678');
      await t.page.click('#fmPayBtn');
      await t.page.waitForTimeout(300);
      const buyOn = await t.page.evaluate(() => ({ calls: window.__calls.map((c) => c.name), stk: window.__stk, list: document.getElementById('fmList').innerText, note: document.getElementById('fmPayNote').innerText }));
      ck('FMB8 flag ON: create → intent → STK (server amount); card still "Waiting for payment confirmation"', JSON.stringify(buyOn.calls.filter((n) => /fitnessCreateMembership|createPaymentIntent/.test(n))) === '["fitnessCreateMembership","createPaymentIntent"]'
        && buyOn.stk.length === 1 && buyOn.stk[0].a === 3500 && /Waiting for payment confirmation/.test(buyOn.list) && !/success|confirmed/i.test(buyOn.note), buyOn);
      ck('FMB9b buy screen: no horizontal scroll', await noScroll(t.page));
      await t.ctx.close();
    }
  } finally { await browser.close(); server.close(); }
  say('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR (fail closed):', e && e.stack || e); process.exit(2); });
