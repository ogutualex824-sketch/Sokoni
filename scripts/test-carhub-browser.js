#!/usr/bin/env node
/* test-carhub-browser.js — Car Hub C1b containment in a REAL browser (car-hub.html + carhub-containment.js).
 * Static checks cannot prove the containment layer WINS at runtime (it must load after sokoni-carhub-pro.js and the
 * inline scripts). Every network dependency is stubbed; nothing reaches production. Run only with ≥512 MB free.
 *   B1 layer active, CarHubPro patched; B2 rent → car-rental.html; B3 licence approval refused, nothing approved;
 *   B4 map shows "not available", no marker movement; B5 SOS → support ticket; B6 finance/inspection → not available,
 *   no Firestore write; B7 no page errors from the containment layer.
 * Run: node scripts/test-carhub-browser.js
 */
'use strict';
const path = require('path'), fs = require('fs'), http = require('http');
const ROOT = path.join(__dirname, '..');
const PW = process.env.PLAYWRIGHT_PATH || 'C:/Users/USER1/OneDrive/Desktop/SOKONI/node_modules/playwright';
const { chromium } = require(PW);
let pass = 0, fail = 0;
const ck = (l, ok, g) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok ? '' : '   [' + String(JSON.stringify(g)).slice(0, 220) + ']')); ok ? pass++ : fail++; };
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
const KEEP = /\/(carhub-containment|sokoni-carhub-pro|leaflet\.min)\.js$/;   /* the code under test + the map lib */
(async () => {
  const srv = await serve(); const base = 'http://127.0.0.1:' + srv.address().port;
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, serviceWorkers: 'block' });
    const page = await ctx.newPage(); const errors = [], navs = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message)));
    await page.addInitScript(() => { window.__writes = []; window.HubRegister = { open: (o) => { window.__hub = o; } }; });
    await page.route('**/*', async (route) => {
      const u = route.request().url(); const p = new URL(u).pathname;
      if (route.request().isNavigationRequest() && !/car-hub\.html$/.test(p)) { navs.push(p + new URL(u).search); return route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>nav</body></html>' }); }
      if (/gstatic\.com\/firebasejs/.test(u)) return route.fulfill({ status: 200, contentType: 'text/javascript', body: 'export const getApps=()=>[];export const initializeApp=()=>({});export const getFirestore=()=>({});export const collection=()=>({});export const addDoc=async()=>{window.__writes.push(1)};export const setDoc=async()=>{window.__writes.push(1)};export const serverTimestamp=()=>0;export const doc=()=>({});' });
      if (u.startsWith(base) && /\.js$/.test(p) && !KEEP.test(p)) return route.fulfill({ status: 200, contentType: 'text/javascript', body: '/* stubbed */' });
      if (u.startsWith(base)) return route.continue();
      return route.fulfill({ status: 204, body: '' });
    });
    await page.goto(base + '/car-hub.html', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    const st = await page.evaluate(() => ({ c: !!window.__carhubContained, pro: !!(window.CarHubPro && window.CarHubPro.__contained) }));
    ck('B1 containment layer active and CarHubPro patched (it won over the inline + deferred definitions)', st.c && st.pro, st);
    await page.evaluate(() => window.confirmBooking());
    await page.waitForTimeout(200);
    ck('B2 confirmBooking → car-rental.html (approved providers + booking engine)', navs.some((n) => /\/car-rental\.html/.test(n)), navs);
    const dl = await page.evaluate(() => { localStorage.setItem('sokoniDLQueue', JSON.stringify([{ id: 'DL1', dlNumber: 'X1', holderName: 'Me', status: 'pending' }])); localStorage.setItem('sokoniDLRecord', JSON.stringify({ dlNumber: 'X1', status: 'approved' })); window.approveDLFromQueue('DL1'); return { q: JSON.parse(localStorage.getItem('sokoniDLQueue'))[0].status, rec: window.getDLStatus().status }; });
    ck('B3 approveDLFromQueue refuses (queue unchanged) and a stored "approved" reads as unverified', dl.q === 'pending' && dl.rec === 'unverified', dl);
    const map = await page.evaluate(() => { window.initMap(); return (document.getElementById('fleetMap') || {}).innerText || ''; });
    ck('B4 the fleet map says live location is not available (no simulated markers)', /Live vehicle location is not available/.test(map), map.slice(0, 120));
    navs.length = 0; await page.evaluate(() => window.CarHubPro.submitRoadsideRequest('towing')); await page.waitForTimeout(200);
    ck('B5 roadside SOS → support.html?topic=sos (critical ticket)', navs.some((n) => /support\.html\?topic=sos/.test(n)), navs);
    const w0 = await page.evaluate(() => window.__writes.length);
    await page.evaluate(() => { window.CarHubPro.submitFinancingApplication(); window.CarHubPro.submitInspectionBooking(); });
    const nt = await page.evaluate(() => (document.getElementById('chContainNote') || {}).innerText || '');
    ck('B6 finance / inspection → "not available yet", nothing written', /not available in SOKONI yet/.test(nt) && (await page.evaluate(() => window.__writes.length)) === w0, nt);
    await page.evaluate(() => window.addCarToFleet());
    ck('B6b list your car → HubRegister car-rental', (await page.evaluate(() => window.__hub)) && (await page.evaluate(() => window.__hub.category)) === 'car-rental');
    const ours = errors.filter((e) => /carhub-containment|__carhub|CarHubPro\.__contained/.test(e));
    ck('B7 no page errors from the containment layer', ours.length === 0, ours);
    console.log('      (other page errors, from stubbed dependencies, not asserted: ' + errors.length + ')');
    await ctx.close();
  } finally { await browser.close(); srv.close(); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
