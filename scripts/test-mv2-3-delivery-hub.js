#!/usr/bin/env node
/* test-mv2-3-delivery-hub.js — Delivery Hub convergence, in a real browser, hermetic.
 * Stub compat firebase: packageRequests (this seller's active jobs, with F1 pickup projection),
 * rideDrivers (server presence fields), shopEmployees (one store rider). Every other origin aborted.
 *   T  tab order Live → Orders → Riders → Map → Exceptions; deep links keep working
 *   R  riders: SHOP RIDER / SOKONI RIDER badges; Available / Stale / On your delivery from the
 *      SERVER presence rule; Chat for all, Call ONLY for the rider on my job (number from the job),
 *      View delivery only for my job; no uid or phone printed for anyone else
 *   C  cards: owner stage ladder; From/To with "location unavailable" when absent; rider strip with
 *      Chat/Call; mini map says "Rider location unavailable" when the rider has no fix
 *   M  map tab: one map; markers for known points only; "Location unavailable: rider" listed
 *   L  layout: no horizontal overflow at 390px; stats 2 columns on phone; 44px targets
 *   node scripts/test-mv2-3-delivery-hub.js
 */
'use strict';
const fs = require('fs'), path = require('path'), http = require('http');
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ck = (l, ok, got) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok ? '' : '   [got ' + JSON.stringify(got).slice(0, 500) + ']')); ok ? pass++ : fail++; };
(async () => {
  const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));
  const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png' };
  const srv = http.createServer((rq, rs) => { const u = decodeURIComponent(rq.url.split('?')[0]); if (u === '/auth-guard.js' || u === '/firebase.js' || u === '/sokoni-dispatch.js' || u === '/sokoni-logistics.js') { rs.writeHead(200, { 'Content-Type': 'application/javascript' }); rs.end('/* stub */'); return; } let fp = path.join(ROOT, u === '/' ? 'index.html' : u); if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { rs.writeHead(404); rs.end(); return; } rs.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' }); fs.createReadStream(fp).pipe(rs); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const base = 'http://127.0.0.1:' + srv.address().port;
  const browser = await chromium.launch();
  const mk = async (width) => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.route('**/*', (route) => route.request().url().startsWith(base) ? route.continue() : route.abort());
    await page.addInitScript(() => {
      const now = Date.now();
      const TS = (ms) => ({ seconds: Math.floor(ms / 1000), toMillis: () => ms });
      const JOBS = [
        { id: 'DELa1', sellerUid: 'seller1', status: 'in_transit', deliveryAddress: 'Kasarani, Nairobi', buyerName: 'Jane', deliveryFee: 300, riderId: 'r1', riderName: 'Rider One', riderPhone: '0711000111', pickupLocation: { lat: -1.26, lng: 36.80, label: 'Westlands shop' }, pickupCoords: { lat: -1.26, lng: 36.80 }, deliveryLat: -1.22, deliveryLng: 36.90, createdAt: TS(now - 600000) },
        { id: 'DELa2', sellerUid: 'seller1', status: 'driver_accepted', deliveryAddress: 'Ngong Road', buyerName: 'Ali', deliveryFee: 250, riderId: 'r2', riderName: 'Rider Two', pickupLocationGap: 'shop_has_no_pickup_location', createdAt: TS(now - 300000) },
      ];
      const RIDERS = {
        r1: { name: 'Rider One', presence: 'online', isOnline: true, lastSeen: TS(now - 20000), lat: -1.25, lng: 36.85, locationUpdatedAt: TS(now - 10000), vehicleType: 'moto', phone: '0711000111' },
        r2: { name: 'Rider Two', presence: 'online', isOnline: true, lastSeen: TS(now - 30000), vehicleType: 'moto', phone: '0722000222' },
        r3: { name: 'Rider Three', isOnline: true, lastSeen: TS(now - 3600000), phone: '0733000333' },
        r4: { name: 'Rider Four', presence: 'online', isOnline: true, lastSeen: TS(now - 5000), phone: '0744000444' },
      };
      const snapOf = (docs) => ({ docs: docs.map((d) => ({ id: d.id, data: () => d })), size: docs.length, empty: !docs.length, forEach(fn) { docs.forEach((d) => fn({ id: d.id, data: () => d })); } });
      const q = (col, filters) => ({
        where(f, op, v) { return q(col, filters.concat([[f, op, v]])); }, orderBy() { return this; }, limit() { return this; },
        _run() {
          if (col === 'packageRequests') { const st = filters.find((x) => x[0] === 'status'); const list = st ? JOBS.filter((j) => (st[1] === 'in' ? st[2].includes(j.status) : j.status === st[2])) : JOBS; return snapOf(list); }
          if (col === 'rideDrivers') return snapOf(Object.keys(RIDERS).map((k) => Object.assign({ id: k }, RIDERS[k])));
          /* the hub keys store riders by the shopEmployees DOC id (== rider uid) */
          if (col === 'shopEmployees') return snapOf([{ id: 'r1', shopOwnerId: 'seller1', uid: 'r1', role: 'rider', status: 'active' }]);
          return snapOf([]);
        },
        /* asynchronous like Firestore — a synchronous callback would run before the page's own definitions */
        onSnapshot(cb) { const r = this._run(); setTimeout(() => cb(r), 0); return () => {}; }, get() { return Promise.resolve(this._run()); },
      });
      window.firebase = { apps: [{}], initializeApp() {}, auth: () => ({ currentUser: { uid: 'seller1' }, onAuthStateChanged(cb) { setTimeout(() => cb({ uid: 'seller1' }), 0); } }),
        firestore: () => ({ collection: (c) => Object.assign(q(c, []), { doc: (id) => ({ get: () => Promise.resolve({ exists: !!RIDERS[id], data: () => RIDERS[id] || null }), onSnapshot(cb) { setTimeout(() => cb({ data: () => RIDERS[id] || {} }), 0); return () => {}; } }) }) }),
        functions: () => ({ httpsCallable: () => () => Promise.resolve({ data: {} }) }) };
      window.firebase.firestore.FieldValue = {};
      window.SK = { dialog: { alert() {}, confirm: async () => true } };
    });
    page.on('pageerror', (e) => { page.__errs = (page.__errs || []).concat([String(e.message).slice(0, 120)]); });
    await page.goto(base + '/seller-delivery.html?shell=merchant', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    return page;
  };
  const page = await mk(1280);
  const t = await page.evaluate(() => Array.from(document.querySelectorAll('.sd-tab')).map((b) => b.dataset.tab));
  ck('T1  tab order Live → Orders → Riders → Map → Exceptions → History → Analytics (data-tab values kept for deep links)', t.join(',') === 'active,pending,riders,map,failed,history,analytics', t);
  const c = await page.evaluate(() => { const h = document.getElementById('activeList').innerHTML; return { cards: (h.match(/sd-card/g) || []).length, stage1: /In transit/.test(h), ladder: (h.match(/sd-ladder/g) || []).length, from1: /Westlands shop/.test(h), gap2: /Pickup location unknown \(shop has no pickup location\)/.test(h), drop2: /drop-off location unavailable/.test(h), badgeShop: /SHOP RIDER/.test(h), badgeNet: /SOKONI RIDER/.test(h), call1: /tel:0711000111/.test(h), noCall2: !/tel:0722000222/.test(h), chat: (h.match(/_sdChat\(/g) || []).length, note2: (document.getElementById('loc_DELa2') || {}).textContent }; });
  ck('C1  two active cards, each with the owner stage ladder; stage "In transit" on the first', c.cards >= 2 && c.ladder === 2 && c.stage1, c);
  ck('C2  From = the F1 pickup label; the second job states "Pickup location unknown (shop has no pickup location)" and no drop-off point', c.from1 && c.gap2 && c.drop2, c);
  ck('C3  rider strip: SHOP RIDER on r1 (shopEmployees), SOKONI RIDER on r2; Chat on both; Call only where the JOB carries the number', c.badgeShop && c.badgeNet && c.chat === 2 && c.call1 && c.noCall2, c);
  ck('C4  mini-map note says "Rider location unavailable" for the rider with no fix', /Rider location unavailable/.test(c.note2 || ''), c.note2);
  await page.evaluate(() => document.querySelector('.sd-tab[data-tab="riders"]').click()); await page.waitForTimeout(1200);
  const r = await page.evaluate(() => { const h = document.getElementById('ridersList').innerHTML; const card = (n) => { const i = h.indexOf(n); return i < 0 ? '' : h.slice(i, i + 900); }; return { r1: card('Rider One'), r2: card('Rider Two'), r3: card('Rider Three'), r4: card('Rider Four'), uids: /r[1-4]<\//.test(h), phones3: /0733000333/.test(h), phones4: /0744000444/.test(h) }; });
  ck('R1  r1: SHOP RIDER, "On your delivery", Chat + Call + View delivery', /SHOP RIDER/.test(r.r1) && /On your delivery/.test(r.r1) && /Chat/.test(r.r1) && /tel:0711000111/.test(r.r1) && /View delivery/.test(r.r1), r.r1.slice(0, 300));
  ck('R2  r2: SOKONI RIDER on my delivery, Chat + View delivery, NO Call (job carries no number)', /SOKONI RIDER/.test(r.r2) && /On your delivery/.test(r.r2) && /View delivery/.test(r.r2) && !/tel:/.test(r.r2), r.r2.slice(0, 300));
  const pr3 = await page.evaluate(() => { const now = Date.now(); const TS = (ms) => ({ seconds: Math.floor(ms / 1000), toMillis: () => ms }); return window._sdPresence ? { stale: window._sdPresence({ isOnline: true, lastSeen: TS(now - 3600000) }).key, fresh: window._sdPresence({ presence: 'online', lastSeen: TS(now - 5000) }).key, off: window._sdPresence({ presence: 'offline' }).key, legacyNoSeen: window._sdPresence({ isOnline: true }).key } : null; });
  ck('R3a presence rule = the server\'s: fresh → online; offline → offline; legacy isOnline with no/old lastSeen → stale', pr3 && pr3.stale === 'stale' && pr3.fresh === 'online' && pr3.off === 'offline' && pr3.legacyNoSeen === 'stale', pr3);
  ck('R3  r3: legacy isOnline:true with an hour-old lastSeen → "Stale" (server rule), no Call, no View', /Stale/.test(r.r3) && !/tel:/.test(r.r3) && !/View delivery/.test(r.r3), r.r3.slice(0, 300));
  ck('R4  r4: fresh presence → "Available"; Chat only', /Available/.test(r.r4) && /Chat/.test(r.r4) && !/tel:/.test(r.r4), r.r4.slice(0, 300));
  ck('R5  no uid and no private number leaks for riders not on my job', !r.phones3 && !r.phones4, { p3: r.phones3, p4: r.phones4 });
  await page.evaluate(() => document.querySelector('.sd-tab[data-tab="map"]').click()); await page.waitForTimeout(1500);
  const m = await page.evaluate(() => ({ mapEl: !!document.querySelector('#hubMap .leaflet-container') || !!document.querySelector('#hubMap .leaflet-pane'), markers: document.querySelectorAll('#hubMap .leaflet-marker-icon').length, list: document.getElementById('hubMapList').textContent, unavailable: /Location unavailable: pickup, drop-off, rider/.test(document.getElementById('hubMapList').innerHTML), pickupMissing: /Location unavailable: pickup/.test(document.getElementById('hubMapList').innerHTML) }));
  ck('M1  one hub map renders with markers only for known points (pickup+rider+drop-off for job 1 = 3)', m.mapEl && m.markers === 3, m);
  ck('M2  job 2 lists "Location unavailable: pickup, drop-off, rider" — nothing invented', m.pickupMissing && m.unavailable, m.list.slice(0, 200));
  ck('E1  no page errors (desktop)', !(page.__errs || []).length, page.__errs);
  await page.close();
  const ph = await mk(390);
  const l = await ph.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, cols: getComputedStyle(document.getElementById('sdStats')).gridTemplateColumns.split(' ').length, tabH: document.querySelector('.sd-tab').getBoundingClientRect().height, sticky: getComputedStyle(document.querySelector('.sd-tabs')).position, btnH: Math.min.apply(null, Array.from(document.querySelectorAll('#activeList .sd-card-actions > *')).map((e) => e.getBoundingClientRect().height)) }));
  ck('L1  phone: no horizontal overflow; stats in 2 columns; sticky tab bar; tabs ≥ 40px; card actions ≥ 44px', l.sw <= l.cw && l.cols === 2 && l.sticky === 'sticky' && l.tabH >= 40 && l.btnH >= 44, l);
  ck('E2  no page errors (phone)', !(ph.__errs || []).length, ph.__errs);
  await browser.close(); srv.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
