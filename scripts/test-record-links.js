#!/usr/bin/env node
/* ================================================================
   SOKONI — Record links (Slice C6): every app reaches the same record by its stable id
   scripts/test-record-links.js

   WHAT IT HOLDS
     V  the vocabulary module: builds a link only for a known kind and a lawful id;
        parses only `open=<kind>:<id>`; never throws; ids keep their case
     D  AdminOS deep links open the record through the SAME functions the in-app
        chips call, then consume the id (the hash becomes the plain route);
        a hostile id, a kind on the wrong route and an unknown section open nothing
     H  a hand-edited URL after boot (hashchange) opens the record too
     T  the ticket modal shows the record link and the customer link
     C  the Connect console links a verification's application by id; a malformed
        id is a dash (positive control in the same table)
     S  support.html?ticket=<id> lands on Track with the id (case preserved) and
        looks the ticket up for the signed-in owner; a bad id is ignored; signed
        out it shows the sign-in message, never a status
     N  with the vocabulary module served EMPTY, nothing opens and nothing links
        (an absent guard fails closed)
   HERMETIC (fixture layer by accessor hooks; other origins aborted). ONE Chromium.
   Exit: 0 all passed · 1 a test failed · 2 the harness could not run
   ================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const HOST = 'sokoni-cert.test';
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));
const shared = require(path.join(__dirname, 'lib', 'adminos-probe-lib.js'));
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '  -> ' + (typeof d === 'string' ? d : JSON.stringify(d)) : '')); } };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

/* ── V: the vocabulary, in a bare VM ─────────────────────────────────────── */
function vocab() {
  const w = {}; vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'sokoni-record-links.js'), 'utf8'), { window: w }); return w.SokoniRecordLinks;
}

/* ── the fixture layer for AdminOS and support.html ──────────────────────── */
function fixtureInit() {
  const TICKETS = [{ id: 't1', subject: 'Help', email: 'm@x', uid: 'uid_2', priority: 'high', status: 'open', message: 'hello' },
                   { id: 'abcDEF123', subject: 'Mixed case id', email: 'rc@sokoni.test', uid: 'rc', priority: 'low', status: 'open', message: 'case' }];
  const APPS = [{ id: 'app_1', name: 'One Co', status: 'pending', role: 'seller', uid: 'uid_2' }];
  const REQUESTS = [{ id: 'modern2', data: { fullName: 'Modern', verifyType: 'Verified Professional', status: 'pending', email: 'm@x', applicantUid: 'uid_2' } }];
  const CVER = [{ id: 'cv1', reason: 'identity', subjectUid: 'uid_2', businessId: 'b1', applicationId: 'app_1', createdAt: null },
                { id: 'cv2', reason: 'identity', subjectUid: 'uid_3', businessId: 'b2', applicationId: 'bad id!', createdAt: null }];
  window.__C6 = { calls: [] };
  let fnsRef = null, fsRef = null;
  /* The dashboard's live KPI listener subscribes to supportTickets with onSnapshot, so a
     collection stub without it is a HARNESS defect (it surfaced as a page error). */
  const snap = (rows) => ({ forEach: (fn) => rows.forEach((d) => fn({ id: d.id, data: () => (d.data || d) })), empty: !rows.length, size: rows.length, docs: [] });
  const listQ = (rows) => { const q = { where() { return q; }, orderBy() { return q; }, limit() { return q; },
    onSnapshot(cb) { try { cb(snap(rows)); } catch (e) {} return () => {}; }, count() { return { get: async () => ({ data: () => ({ count: rows.length }) }) }; },
    get: async () => snap(rows),
    doc: (id) => ({ get: async () => { const t = rows.find((x) => x.id === id); return { exists: !!t, id, data: () => (t ? (t.data || t) : undefined) }; }, update: async () => {} }) }; return q; };
  const wrappedFns = () => {
    const base = fnsRef ? fnsRef() : { httpsCallable: () => async () => ({ data: {} }) };
    return { httpsCallable: (name) => async (data) => {
      const op = (name === 'adminOsDispatch' || name === 'connectDispatch') && data && data.op ? data.op : name;
      window.__C6.calls.push({ name, op, data });
      if (op === 'applicationList') return { data: { items: APPS, counts: { pending: 1 } } };
      if (op === 'adminGetSupportTickets') return { data: { tickets: TICKETS, items: TICKETS, count: TICKETS.length } };
      return base.httpsCallable(name)(data);
    } };
  };
  const wrappedFs = () => {
    const base = fsRef ? fsRef() : { collection: () => ({}) };
    return { collection: (name) => {
      if (name === 'supportTickets') return listQ(TICKETS);
      if (name === 'verificationRequests') return listQ(REQUESTS);
      if (name === 'connectVerifications') return listQ(CVER);
      if (name === 'connectSessions') return listQ([]);
      return base.collection(name);
    } };
  };
  const install = (fb) => {
    if (!fb || typeof fb !== 'object' || fb.__c6Hooked) return fb;
    fnsRef = typeof fb.functions === 'function' ? fb.functions : fnsRef; fsRef = typeof fb.firestore === 'function' ? fb.firestore : fsRef;
    Object.defineProperty(fb, 'functions', { configurable: true, enumerable: true, get: () => wrappedFns, set: (v) => { fnsRef = v; } });
    Object.defineProperty(fb, 'firestore', { configurable: true, enumerable: true, get: () => { if (fsRef && fsRef.FieldValue) wrappedFs.FieldValue = fsRef.FieldValue; if (fsRef && fsRef.Timestamp) wrappedFs.Timestamp = fsRef.Timestamp; return wrappedFs; }, set: (v) => { fsRef = v; } });
    if (window.__C6_SIGNED_OUT__) { const a = fb.auth; fb.auth = () => Object.assign({}, typeof a === 'function' ? a() : {}, { currentUser: null, onAuthStateChanged: (cb) => { try { cb(null); } catch (e) {} return () => {}; } }); }
    const origApp = fb.app; fb.app = () => Object.assign({}, (typeof origApp === 'function' ? origApp() : {}) || {}, { functions: () => wrappedFns() });
    Object.defineProperty(fb, '__c6Hooked', { value: true }); return fb;
  };
  let cur = install(window.firebase);
  Object.defineProperty(window, 'firebase', { configurable: true, get: () => cur, set: (v) => { cur = install(v); } });
}

async function openPage(browser, { page: file = 'admin-os.html', hash = '', search = '', overrides = {}, signedOut = false }) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
  await ctx.addInitScript(shared.compatInit);
  if (signedOut) await ctx.addInitScript('window.__C6_SIGNED_OUT__ = true;');
  await ctx.addInitScript(fixtureInit);
  await ctx.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== HOST) return route.abort();
    if (overrides[url.pathname] !== undefined) return route.fulfill({ status: 200, contentType: MIME[path.extname(url.pathname)] || 'text/plain', body: overrides[url.pathname] });
    if (/\/firebase\.js$/.test(url.pathname)) return route.fulfill({ status: 200, contentType: 'application/javascript', body: shared.instrumentedModule(ROOT) });
    if (/firebasejs/.test(url.pathname)) return route.fulfill({ status: 200, contentType: 'application/javascript', body: shared.gstaticStub(url.pathname) });
    const f = path.join(ROOT, decodeURIComponent(url.pathname).replace(/^\/+/, ''));
    if (!f.startsWith(ROOT)) return route.fulfill({ status: 403, body: '' });
    let buf; try { buf = fs.readFileSync(f); } catch (_) { return route.fulfill({ status: 404, body: '404' }); }
    return route.fulfill({ status: 200, contentType: MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', body: buf });
  });
  const page = await ctx.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('about:blank');
  await page.goto('https://' + HOST + '/' + file + search + hash, { waitUntil: 'domcontentloaded', timeout: 30000 });
  let booted = true;
  if (file === 'admin-os.html') {
    try { await page.waitForFunction(() => !!(window.SokoniAOS && document.querySelector('#aosNav .nav-item.active')), { timeout: 20000 }); } catch (_) { booted = false; }
    if (booted) { await page.waitForTimeout(500); await page.evaluate(() => ['sk-splash', 'sk-offline-bar'].forEach((id) => { const e = document.getElementById(id); if (e) e.remove(); })); }
  } else { await page.waitForTimeout(800); }
  return { page, ctx, booted, errors };
}
const aosState = (p) => p.evaluate(() => ({
  hash: location.hash,
  shown: [...document.querySelectorAll('.aos-panel')].filter((x) => !x.hidden).map((x) => x.id.replace('panel-', '')),
  modal: (document.querySelector('.ticket-detail') || {}).textContent || null,
  modalTitle: (document.querySelector('#aosModalTitle, .aos-modal h2, .aos-modal h3, .modal-title') || {}).textContent || null,
  recordLink: (document.querySelector('.ticket-detail [data-record-link]') || {}).textContent || null,
  customerLink: (document.querySelector('.ticket-detail [data-customer-link]') || {}).getAttribute?.('href') || null,
  vrOpen: (document.querySelector('.vr-card[data-id="modern2"] [data-act="toggle"]') || {}).getAttribute?.('aria-expanded') || null,
  appCard: !!document.getElementById('app-app_1'),
}));

(async () => {
  console.log('RECORD LINKS — EVERY APP REACHES THE SAME RECORD BY ITS STABLE ID\n');
  console.log('  [V — the vocabulary]');
  const L = vocab();
  ok('V1  a known kind + lawful id builds the AdminOS link, tab included, case preserved', L.link('ticket', 'abcDEF123') === 'admin-os.html#support?open=ticket:abcDEF123' && L.link('application', 'app_1') === 'admin-os.html#applications/queue?open=application:app_1' && L.link('request', 'modern2') === 'admin-os.html#applications/verification?open=request:modern2');
  ok('V2  unknown kind, empty, too-long or hostile ids build NO link', L.link('user', 'x') === null && L.link('ticket', '') === null && L.link('ticket', 'a'.repeat(65)) === null && L.link('ticket', '<img src=x>') === null && L.link('ticket', 'a b') === null && L.link('ticket', null) === null);
  ok('V3  parseOpen reads only open=<kind>:<id>', L.parseOpen('open=ticket:t1').open === 'openTicket' && L.parseOpen('x=1&open=request:modern2').tab === 'verification' && L.parseOpen('open=bogus:t1') === null && L.parseOpen('open=ticket:<x>') === null && L.parseOpen('') === null && L.parseOpen(undefined) === null);
  ok('V4  customerTicket / ticketFromSearch: lawful only, case preserved', L.customerTicket('abcDEF123') === 'support.html?ticket=abcDEF123' && L.customerTicket('a b') === null && L.ticketFromSearch('?ticket=abcDEF123') === 'abcDEF123' && L.ticketFromSearch('?x=1&ticket=t1&y=2') === 't1' && L.ticketFromSearch('?ticket=<x>') === null && L.ticketFromSearch('') === null);

  const browser = await chromium.launch();
  console.log('\n  [D — AdminOS deep links open the record and consume the id]');
  let r = await openPage(browser, { hash: '#support?open=ticket:t1' });
  if (!r.booted) { console.error('BLOCKED — AdminOS did not boot'); await browser.close(); process.exit(2); }
  await r.page.waitForSelector('.ticket-detail', { timeout: 8000 }).catch(() => {});
  let st = await aosState(r.page);
  ok('D1  #support?open=ticket:t1 → Support panel, the ticket modal open, hash consumed to #support', st.shown[0] === 'support' && !!st.modal && /hello/.test(st.modal) && st.hash === '#support', { shown: st.shown, hash: st.hash, modal: !!st.modal });
  console.log('\n  [T — the ticket modal carries both links]');
  ok('T1  record link and customer link, both from the vocabulary', st.recordLink === 'admin-os.html#support?open=ticket:t1' && st.customerLink === 'support.html?ticket=t1', { rl: st.recordLink, cl: st.customerLink });
  ok('D1e no page error', r.errors.length === 0, r.errors);
  await r.ctx.close();

  r = await openPage(browser, { hash: '#applications/verification?open=request:modern2' });
  await r.page.waitForFunction(() => document.querySelector('.vr-card[data-id="modern2"] [data-act="toggle"][aria-expanded="true"]'), { timeout: 8000 }).catch(() => {});
  st = await aosState(r.page);
  ok('D2  #applications/verification?open=request:modern2 → the reviewer opens that request; hash consumed', st.shown[0] === 'applications' && st.vrOpen === 'true' && st.hash === '#applications/verification', { shown: st.shown, vrOpen: st.vrOpen, hash: st.hash });
  await r.ctx.close();

  r = await openPage(browser, { hash: '#applications/queue?open=application:app_1' });
  await r.page.waitForSelector('#app-app_1', { timeout: 8000 }).catch(() => {});
  st = await aosState(r.page);
  ok('D3  #applications/queue?open=application:app_1 → the queue with that card; hash consumed', st.shown[0] === 'applications' && st.appCard && st.hash === '#applications/queue', { shown: st.shown, appCard: st.appCard, hash: st.hash });
  await r.ctx.close();

  r = await openPage(browser, { hash: '#support?open=ticket:%3Cimg%20src%3Dx%3E' });
  await r.page.waitForTimeout(700); st = await aosState(r.page);
  ok('D4  a hostile id: Support lands, NO modal, no page error', st.shown[0] === 'support' && !st.modal && r.errors.length === 0, { shown: st.shown, modal: !!st.modal, errors: r.errors });
  await r.page.evaluate(() => { location.hash = '#support?open=application:app_1'; }); await r.page.waitForTimeout(600); st = await aosState(r.page);
  ok('D5  a kind on the wrong route is dropped: still Support, nothing opened', st.shown[0] === 'support' && !st.appCard && !st.modal, { shown: st.shown });
  await r.ctx.close();
  r = await openPage(browser, { hash: '#nosuch?open=ticket:t1' });
  st = await aosState(r.page);
  ok('D6  an unknown section with an open= falls back to the dashboard', st.shown[0] === 'dashboard' && !st.modal, st.shown);

  console.log('\n  [H — a hand-edited URL after boot]');
  await r.page.evaluate(() => { location.hash = '#support?open=ticket:t1'; });
  await r.page.waitForSelector('.ticket-detail', { timeout: 8000 }).catch(() => {});
  st = await aosState(r.page);
  ok('H1  hashchange with open= opens the ticket and consumes the id', st.shown[0] === 'support' && !!st.modal && st.hash === '#support', { shown: st.shown, modal: !!st.modal, hash: st.hash });
  await r.ctx.close();

  console.log('\n  [C — Connect links the application by id]');
  r = await openPage(browser, { hash: '#comms/connect' });
  await r.page.waitForSelector('a[data-record-link="application"]', { timeout: 8000 }).catch(() => {});
  st = await r.page.evaluate(() => { const rows = [...document.querySelectorAll('#commsBody table')].flatMap((t) => [...t.querySelectorAll('tbody tr')]);
    const links = [...document.querySelectorAll('#commsBody a[data-record-link="application"]')].map((a) => a.getAttribute('href'));
    const th = [...document.querySelectorAll('#commsBody th')].map((x) => x.textContent); return { links, rows: rows.length, th }; });
  ok('C1  the verification with a lawful applicationId links admin-os.html#applications/queue?open=application:app_1', st.links.length === 1 && st.links[0] === 'admin-os.html#applications/queue?open=application:app_1' && st.th.includes('Application'), st);
  ok('C1c CONTROL: two verification rows rendered, so the malformed id row is present and unlinked', st.rows >= 2 && st.links.length === 1, st.rows);
  await r.ctx.close();

  console.log('\n  [S — support.html?ticket=<id>]');
  r = await openPage(browser, { page: 'support.html', search: '?ticket=abcDEF123' });
  await r.page.waitForFunction(() => /open|sign in/i.test((document.getElementById('spTrackResult') || {}).textContent || ''), { timeout: 8000 }).catch(() => {});
  st = await r.page.evaluate(() => ({ tab: (document.querySelector('.sp-tab.active') || {}).textContent, val: (document.getElementById('spTrackId') || {}).value, out: (document.getElementById('spTrackResult') || {}).textContent || '' }));
  ok('S1  Track tab active, id prefilled with its CASE preserved, the real ticket looked up (status shown)', /Track/.test(st.tab || '') && st.val === 'abcDEF123' && /open/i.test(st.out) && !/No ticket/.test(st.out), st);
  ok('S1e no page error on support.html', r.errors.length === 0, r.errors);
  await r.ctx.close();
  r = await openPage(browser, { page: 'support.html', search: '?ticket=%3Cimg%3E' });
  st = await r.page.evaluate(() => ({ tab: (document.querySelector('.sp-tab.active') || {}).textContent, val: (document.getElementById('spTrackId') || {}).value }));
  ok('S2  a malformed ticket id is ignored: Contact tab, nothing prefilled', /Contact/.test(st.tab || '') && st.val === '', st);
  await r.ctx.close();
  r = await openPage(browser, { page: 'support.html', search: '?ticket=abcDEF123', signedOut: true });
  await r.page.waitForTimeout(1800);
  st = await r.page.evaluate(() => ({ out: (document.getElementById('spTrackResult') || {}).textContent || '' }));
  ok('S3  signed out: the sign-in message, never a status (fail closed)', /sign in/i.test(st.out) && !/\bopen\b/i.test(st.out), st.out.slice(0, 100));
  await r.ctx.close();

  console.log('\n  [N — the vocabulary served EMPTY: nothing opens, nothing links]');
  const empty = { '/sokoni-record-links.js': '/* empty on purpose */' };
  r = await openPage(browser, { hash: '#support?open=ticket:t1', overrides: empty });
  await r.page.waitForTimeout(700); st = await aosState(r.page);
  ok('N1  AdminOS: Support lands, NO modal, and recordLink() returns null', st.shown[0] === 'support' && !st.modal && (await r.page.evaluate(() => window.SokoniAOS.recordLink('ticket', 't1') === null)), { shown: st.shown, modal: !!st.modal });
  await r.ctx.close();
  r = await openPage(browser, { hash: '#comms/connect', overrides: empty });
  await r.page.waitForSelector('#commsBody table', { timeout: 8000 }).catch(() => {});
  st = await r.page.evaluate(() => document.querySelectorAll('#commsBody a[data-record-link]').length);
  ok('N2  Connect: no application link at all', st === 0, st);
  await r.ctx.close();

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR — ' + (e && e.stack || e)); process.exit(2); });
