#!/usr/bin/env node
/* ================================================================
   SOKONI — Verification ↔ Support context (Slice V2), the closed loop in a browser
   scripts/test-support-context.js

   WHAT IT HOLDS
     T  a ticket's business context renders as a chip on the AdminOS Support
        list and detail; the chip opens the exact record:
          requestId     → #applications/verification with THAT request open
          applicationId → #applications/queue with THAT card focused (any status)
     L  from a record, "Related tickets" narrows the Support list to the tickets
        about it (in memory, over the same canonical read), and Clear restores it
     C  from a record, ONE ticket dialog (AdminOS's) raises a case through
        SokoniSupportContact with the record as context — the payload that leaves
        the browser carries op adminCreateSupportTicket + context; the id shown
        is the server's; an empty message is refused before any call
     N  unknown ids fail closed: an unknown ticket opens nothing, an unknown
        request/application says so, nothing is invented
   A served-markup negative control blanks the chip renderer and must turn the
   chip checks red.

   HERMETIC: fake host from disk, other origins aborted, the compat stub from
   scripts/lib/adminos-probe-lib.js plus an in-page fixture layer installed
   BEFORE sokoni-aos.js captures firebase.functions()/firestore(). Cannot
   reach production.
   Exit: 0 all passed · 1 a test failed · 2 the harness could not run
   ================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const HOST = 'sokoni-cert.test';
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));
const shared = require(path.join(__dirname, 'lib', 'adminos-probe-lib.js'));

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '  -> ' + (typeof d === 'string' ? d : JSON.stringify(d)) : '')); } };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

/* Fixture layer. Runs after compatInit (init scripts run in registration order)
   and before any page script, so sokoni-aos.js captures the wrapped handles. */
function fixtureInit() {
  const TICKETS = [
    { id: 't1', subject: 'Docs unclear', email: 'a@x', priority: 'high', status: 'open', context: { requestId: 'modern2' } },
    { id: 't2', subject: 'Shop not published', email: 'b@x', priority: 'medium', status: 'resolved', context: { applicationId: 'app_7' } },
    { id: 't3', subject: 'Plain ticket', email: 'c@x', priority: 'low', status: 'open' },
    { id: 't4', subject: 'Other request', email: 'd@x', priority: 'medium', status: 'open', context: { requestId: 'other9' } },
    { id: 'srv_ticket_1', subject: 'Application: Seven Co', email: 'admin@x', priority: 'medium', status: 'open', context: { applicationId: 'app_7' } },
  ];
  const APPS = [
    { id: 'app_7', name: 'Seven Co', status: 'approved', role: 'seller', projectionStatus: 'applied', phone: '0700', email: 's@x' },
    { id: 'app_8', name: 'Eight Ltd', status: 'pending', role: 'seller', phone: '0701', email: 'e@x' },
  ];
  const REQUESTS = [
    { id: 'legacy1', data: { fullName: 'Legacy', verifyType: 'Verified Business', status: 'pending', email: 'l@x' } },
    { id: 'modern2', data: { fullName: 'Modern', practiceName: 'New Co', verifyType: 'Verified Professional', status: 'pending', email: 'm@x', applicantUid: 'uid_2', refNumber: 'REF-2' } },
  ];
  window.__V2 = { calls: [] };
  /* ACCESSOR hooks, not plain assignment: the page's firebase.js and the probe's
     instrumented module may reassign window.firebase or its functions/firestore
     after this init script runs. Whatever is assigned later becomes the "base"
     the wrappers delegate to, so sokoni-aos.js captures the wrapped handles at
     boot whichever order the scripts land in. */
  let fnsRef = null, fsRef = null;
  const wrappedFns = () => {
    const base = fnsRef ? fnsRef() : { httpsCallable: () => async () => ({ data: {} }) };
    return { httpsCallable: (name) => async (data) => {
      const op = name === 'adminOsDispatch' && data && data.op ? data.op : name;
      window.__V2.calls.push({ name, op, data });
      if (op === 'adminGetSupportTickets') return { data: { tickets: TICKETS, items: TICKETS, count: TICKETS.length } };
      if (op === 'applicationList') return { data: { items: APPS, counts: { pending: 1 } } };
      if (op === 'adminCreateSupportTicket') return { data: { ticketId: 'srv_ticket_1', context: data.context } };
      return base.httpsCallable(name)(data);
    } };
  };
  const wrappedFs = () => {
    const base = fsRef ? fsRef() : { collection: () => ({}) };
    return { collection: (name) => {
      /* Only doc(id).get() is fixture-backed; where()/onSnapshot() (the open-ticket
         badge at boot) keep the base's behaviour. A fresh object, so a shared
         chainable query is never mutated. */
      if (name === 'supportTickets') return Object.assign({}, base.collection(name), { doc: (id) => ({ get: async () => { const t = TICKETS.find((x) => x.id === id); return { exists: !!t, data: () => t }; } }) });
      if (name === 'verificationRequests') return { orderBy() { return this; }, limit() { return this; }, where() { return this; },
        get: async () => ({ forEach: (fn) => REQUESTS.forEach((d) => fn({ id: d.id, data: () => d.data })), empty: false, size: REQUESTS.length, docs: [] }),
        doc: (id) => ({ update: async () => {}, get: async () => ({ exists: false }) }) };
      return base.collection(name);
    } };
  };
  const install = (fb) => {
    if (!fb || typeof fb !== 'object' || fb.__v2Hooked) return fb;
    fnsRef = typeof fb.functions === 'function' ? fb.functions : fnsRef;
    fsRef = typeof fb.firestore === 'function' ? fb.firestore : fsRef;
    Object.defineProperty(fb, 'functions', { configurable: true, enumerable: true, get: () => wrappedFns, set: (v) => { fnsRef = v; } });
    Object.defineProperty(fb, 'firestore', { configurable: true, enumerable: true,
      get: () => { if (fsRef && fsRef.FieldValue) wrappedFs.FieldValue = fsRef.FieldValue; if (fsRef && fsRef.Timestamp) wrappedFs.Timestamp = fsRef.Timestamp; return wrappedFs; },
      set: (v) => { fsRef = v; } });
    /* firebase.app().functions('us-central1') is what SokoniSupportContact uses. */
    const origApp = fb.app;
    fb.app = () => Object.assign({}, (typeof origApp === 'function' ? origApp() : {}) || {}, { functions: () => wrappedFns() });
    Object.defineProperty(fb, '__v2Hooked', { value: true });
    return fb;
  };
  let cur = install(window.firebase);
  Object.defineProperty(window, 'firebase', { configurable: true, get: () => cur, set: (v) => { cur = install(v); } });
}

async function openPage(browser, { hash = '', overrides = {} }) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
  await ctx.addInitScript(shared.compatInit);
  await ctx.addInitScript(fixtureInit);
  await ctx.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== HOST) return route.abort();
    if (overrides[url.pathname] !== undefined) return route.fulfill({ status: 200, contentType: MIME[path.extname(url.pathname)] || 'text/plain', body: overrides[url.pathname] });
    if (/\/firebase\.js$/.test(url.pathname)) return route.fulfill({ status: 200, contentType: 'application/javascript', body: shared.instrumentedModule(ROOT) });
    if (/firebasejs/.test(url.pathname)) return route.fulfill({ status: 200, contentType: 'application/javascript', body: shared.gstaticStub(url.pathname) });
    const file = path.join(ROOT, decodeURIComponent(url.pathname).replace(/^\/+/, ''));
    if (!file.startsWith(ROOT)) return route.fulfill({ status: 403, body: '' });
    let buf; try { buf = fs.readFileSync(file); } catch (_) { return route.fulfill({ status: 404, body: '404' }); }
    return route.fulfill({ status: 200, contentType: MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', body: buf });
  });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('about:blank');
  await page.goto('https://' + HOST + '/admin-os.html' + hash, { waitUntil: 'domcontentloaded', timeout: 30000 });
  let booted = true;
  try { await page.waitForFunction(() => !!(window.SokoniAOS && document.querySelector('#aosNav .nav-item.active')), { timeout: 20000 }); } catch (_) { booted = false; }
  if (booted) { await page.waitForTimeout(400); await page.evaluate(() => ['sk-splash', 'sk-offline-bar'].forEach((id) => { const e = document.getElementById(id); if (e) e.remove(); })); }
  return { page, ctx, booted, errors };
}
const shown = (p) => p.evaluate(() => [...document.querySelectorAll('.aos-panel')].filter((x) => !x.hidden).map((x) => x.id.slice(6))[0]);
const rows = (p) => p.evaluate(() => [...document.querySelectorAll('#supportBody tr[data-ticket]')].map((r) => ({ id: r.dataset.ticket, chips: [...r.querySelectorAll('.ctx-chip')].map((c) => c.textContent.trim()) })));

(async () => {
  const browser = await chromium.launch();
  console.log('VERIFICATION ↔ SUPPORT CONTEXT — the closed loop\n');
  console.log('  [T — tickets carry their record; the chip opens it]');
  const r = await openPage(browser, { hash: '#support' });
  if (!r.booted) { console.error('BLOCKED — AdminOS did not boot'); await browser.close(); process.exit(2); }
  const p = r.page;
  await p.waitForSelector('#supportBody tr[data-ticket]', { timeout: 10000 }).catch(() => {});
  let rs = await rows(p);
  const t1ok = rs.length === 5 && rs.find((x) => x.id === 't1')?.chips.some((c) => /Verification request/.test(c)) && rs.find((x) => x.id === 't2')?.chips.some((c) => /Application/.test(c)) && rs.find((x) => x.id === 't3')?.chips.length === 0;
  ok('T1  the Support list renders the canonical read with an "About" chip only where a context exists', t1ok,
     t1ok ? undefined : { rs, body: (await p.evaluate(() => (document.getElementById('supportBody') || {}).innerHTML || '')).slice(0, 300), errors: r.errors, calls: await p.evaluate(() => window.__V2.calls.map((c) => c.op)) });
  if (!t1ok) { console.error('BLOCKED — the Support list did not render; the rest of the loop cannot be measured'); await browser.close(); process.exit(2); }
  await p.click('#supportBody tr[data-ticket="t1"] .ctx-chip'); await p.waitForTimeout(500);
  let st = await p.evaluate(() => ({ hash: location.hash, open: [...document.querySelectorAll('.vr-card')].filter((c) => c.querySelector('.vr-body')).map((c) => c.dataset.id), filter: document.querySelector('.vr-filter.active')?.dataset.filter }));
  ok('T2  requestId chip → #applications/verification with THAT request open (filter widened to all)', (await shown(p)) === 'applications' && st.hash === '#applications/verification' && JSON.stringify(st.open) === '["modern2"]' && st.filter === 'all', st);
  await p.click('#aosNav .nav-item[data-section="support"]:not([data-tab])'); await p.waitForTimeout(300);
  await p.click('#supportBody tr[data-ticket="t2"] .ctx-chip'); await p.waitForTimeout(500);
  st = await p.evaluate(() => ({ hash: location.hash, status: document.getElementById('appsStatus').value, focused: !!document.querySelector('#app-app_7.aos-card-focus'), cards: document.querySelectorAll('.aos-card').length }));
  ok('T3  applicationId chip → #applications/queue, status widened to all, THAT card focused', (await shown(p)) === 'applications' && st.hash === '#applications/queue' && st.status === '' && st.focused && st.cards === 2, st);
  await p.evaluate(() => SokoniAOS.openTicket('t2')); await p.waitForTimeout(400);
  st = await p.evaluate(() => ({ modal: (document.getElementById('modalBody') || {}).innerHTML || '', shownModal: !!document.querySelector('#aosModal.open, #aosModal[style*="flex"], #aosModal[style*="block"]') || !!document.getElementById('aosModal') }));
  ok('T4  the ticket detail shows its "About" chip', (await shown(p)) === 'support' && /About:/.test(st.modal) && /ctx-chip/.test(st.modal), st.modal.slice(0, 200));
  await p.evaluate(() => SokoniAOS.closeModal());

  console.log('\n  [L — from the record to its tickets]');
  await p.evaluate(() => SokoniAOS.openVerificationRequest('modern2')); await p.waitForTimeout(400);
  await p.click('.vr-card[data-id="modern2"] [data-act="tickets"]'); await p.waitForTimeout(500);
  rs = await rows(p);
  st = await p.evaluate(() => ({ filter: !!document.getElementById('supportCtxFilter'), status: document.querySelector('#panel-support select').value }));
  ok('L1  "Related tickets" → Support narrowed to the tickets about this request, all statuses', (await shown(p)) === 'support' && st.filter && st.status === '' && rs.length === 1 && rs[0].id === 't1', { rs, st });
  await p.click('#supportCtxFilter button:last-child'); await p.waitForTimeout(400);
  rs = await rows(p);
  ok('L2  Clear restores the full list', !(await p.evaluate(() => !!document.getElementById('supportCtxFilter'))) && rs.length === 5, rs.length);
  await p.evaluate(() => SokoniAOS.openApplication('app_7')); await p.waitForTimeout(400);
  await p.click('#app-app_7 button[onclick*="openTicketsFor"]'); await p.waitForTimeout(500);
  rs = await rows(p);
  ok('L3  from an application card, "Tickets" narrows to the tickets about that application', rs.length === 2 && rs.every((x) => ['t2', 'srv_ticket_1'].includes(x.id)), rs);

  console.log('\n  [C — raising a case from a record, through the one path]');
  await p.evaluate(() => { window.__V2.calls = []; SokoniAOS.openApplication('app_7'); }); await p.waitForTimeout(400);
  await p.click('#app-app_7 button[onclick*="ticketDialog"]'); await p.waitForTimeout(300);
  ok('C1  the application card opens AdminOS\'s ticket dialog with the record as "About"', await p.evaluate(() => !!document.getElementById('ticketDialog') && /Application/.test(document.getElementById('ticketDialog').textContent) && document.getElementById('tkSubject').value.startsWith('Application: Seven Co')));
  await p.click('#tkSubmit'); await p.waitForTimeout(300);
  st = await p.evaluate(() => ({ out: document.getElementById('tkOut').textContent, calls: window.__V2.calls.filter((c) => c.op === 'adminCreateSupportTicket').length }));
  ok('C2  an empty message is refused by the contract before any call leaves the browser', /message required/i.test(st.out) && st.calls === 0, st);
  await p.fill('#tkMessage', 'Shop shows approved but nothing is published.');
  await p.click('#tkSubmit'); await p.waitForTimeout(500);
  st = await p.evaluate(() => ({ out: document.getElementById('tkOut').textContent, call: window.__V2.calls.find((c) => c.op === 'adminCreateSupportTicket') }));
  ok('C3  the payload that leaves the browser is op adminCreateSupportTicket with context.applicationId, through adminOsDispatch',
     st.call && st.call.name === 'adminOsDispatch' && st.call.data.op === 'adminCreateSupportTicket' && JSON.stringify(st.call.data.context) === JSON.stringify({ applicationId: 'app_7' }) && st.call.data.category === 'other', st.call);
  ok('C4  the id shown is the SERVER\'s, only after it returned', /srv_ticket_1/.test(st.out) && /created/i.test(st.out), st.out);
  await p.click('#tkOut button'); await p.waitForTimeout(500);
  ok('C5  "Open" lands on the new ticket in Support with its "About" chip', (await shown(p)) === 'support' && await p.evaluate(() => /srv_ticket_1|Application: Seven Co/.test((document.getElementById('modalBody') || {}).innerHTML || '') && /ctx-chip/.test((document.getElementById('modalBody') || {}).innerHTML || '')));
  await p.evaluate(() => SokoniAOS.closeModal());
  await p.evaluate(() => { window.__V2.calls = []; SokoniAOS.openVerificationRequest('modern2'); }); await p.waitForTimeout(400);
  await p.click('.vr-card[data-id="modern2"] [data-act="ticket"]'); await p.waitForTimeout(300);
  await p.fill('#tkMessage', 'Applicant asked for help with documents.');
  await p.click('#tkSubmit'); await p.waitForTimeout(500);
  st = await p.evaluate(() => window.__V2.calls.find((c) => c.op === 'adminCreateSupportTicket'));
  ok('C6  from the verification reviewer the same dialog sends context.requestId with category "verification"', st && st.data.category === 'verification' && JSON.stringify(st.data.context) === JSON.stringify({ requestId: 'modern2' }) && /^Verification REF-2/.test(st.data.subject), st && st.data);
  await p.evaluate(() => SokoniAOS.closeModal());
  ok('C7  no second ticket store: the dialog and the reviewer contain no Firestore write to supportTickets',
     !/collection\(["']supportTickets["']\)\.(add|doc\([^)]*\)\.set)/.test(fs.readFileSync(path.join(ROOT, 'sokoni-aos.js'), 'utf8')) && !/supportTickets/.test(fs.readFileSync(path.join(ROOT, 'sokoni-verification-review.js'), 'utf8')));

  console.log('\n  [N — unknown ids fail closed]');
  await p.evaluate(() => SokoniAOS.openTicket('nope')); await p.waitForTimeout(400);
  ok('N1  an unknown ticket opens nothing (no detail for "nope")', !(await p.evaluate(() => /nope/.test((document.getElementById('modalBody') || {}).innerHTML || '') && document.getElementById('aosModal') && getComputedStyle(document.getElementById('aosModal')).display !== 'none')));
  await p.evaluate(() => SokoniAOS.openVerificationRequest('ghost')); await p.waitForTimeout(500);
  st = await p.evaluate(() => ({ msg: (document.getElementById('vrNotice') || {}).textContent || '', open: [...document.querySelectorAll('.vr-card')].filter((c) => c.querySelector('.vr-body')).length }));
  ok('N2  an unknown verification request says so and opens nothing', /No verification request with id ghost/.test(st.msg) && st.open === 0, st);
  await p.evaluate(() => SokoniAOS.openApplication('ghost')); await p.waitForTimeout(400);
  ok('N3  an unknown application focuses nothing', !(await p.evaluate(() => !!document.querySelector('.aos-card-focus'))));
  ok('N4  no page errors across the loop', r.errors.length === 0, r.errors);
  await r.ctx.close();

  console.log('\n  [negative control]');
  const aos = fs.readFileSync(path.join(ROOT, 'sokoni-aos.js'), 'utf8');
  const cut = aos.replace('if (!ctx || typeof ctx !== "object") return "";', 'return "";');
  if (cut === aos) { console.error('PROBE INVALID — sabotage target not found'); await browser.close(); process.exit(2); }
  const n = await openPage(browser, { hash: '#support', overrides: { '/sokoni-aos.js': cut } });
  if (n.booted) {
    await n.page.waitForSelector('#supportBody tr[data-ticket]', { timeout: 10000 }).catch(() => {});
    const nr = await rows(n.page);
    ok('NEGATIVE: with the chip renderer blanked, no ticket shows an "About" chip (T1 is live)', nr.length === 5 && nr.every((x) => x.chips.length === 0), nr);
  } else ok('NEGATIVE booted', false);
  await n.ctx.close();

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR — ' + e.message); process.exit(2); });
