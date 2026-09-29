#!/usr/bin/env node
/* ================================================================
   SOKONI — Verification convergence (Slice V1): one route, one reviewer
   scripts/test-verification-convergence.js

   WHAT IT HOLDS
     R  #applications/verification is a REAL route on the canonical AdminOS
        workspace: it survives a real reload, lands on the Applications panel
        with the "Verification requests" tab active and the shared reviewer
        mounted; the tab bar and the URL stay in step both ways.
     M  the shared reviewer (sokoni-verification-review.js) renders the queue
        from the canonical collection, marks a request that has no applicant
        record and offers it NO approve control, and on a modern request:
          - issues the badge FIRST (verifications/{applicantUid} update),
            then the profile projection, then the request, then adminLog,
            then notifies through the ONE sender (notifySend, registered type);
          - FAILS CLOSED: a refused badge write leaves the request untouched
            and says so;
          - rejects only with a reason, records it, and says no notice was sent
            (no registered type exists for a rejection).
     P  the applicant page complies with the SERVED rules: submits as the
        site's signed-in user with applicantUid, creates its own pending badge
        record without verifiedAt/approvedBy, queries duplicates by its own uid,
        and names a rules refusal instead of blaming the network.
     S  Super Admin reaches the same destination by link.
   A served-markup negative control removes the reviewer's legacy guard and
   must turn the "no approve on a legacy request" check red.

   HERMETIC. Fake host from disk, other origins aborted, the compat stub from
   scripts/lib/adminos-probe-lib.js; Firestore/functions are replaced in-page by
   recording fakes. Nothing here reaches production.
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

async function openPage(browser, { hash = '', overrides = {} }) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
  await ctx.addInitScript(shared.compatInit);
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
  if (booted) { await page.waitForTimeout(300); await page.evaluate(() => ['sk-splash', 'sk-offline-bar'].forEach((id) => { const e = document.getElementById(id); if (e) e.remove(); })); }
  return { page, ctx, booted, errors };
}
const state = (p) => p.evaluate(() => ({
  shown: [...document.querySelectorAll('.aos-panel')].filter((x) => !x.hidden).map((x) => x.id.slice(6)),
  tab: [...document.querySelectorAll('#panel-applications .tab-bar .tab-btn.active')].map((b) => b.dataset.tab),
  hash: location.hash, cur: [...document.querySelectorAll('#aosNav [aria-current="page"]')].map((n) => n.dataset.section),
  rootVisible: !!document.getElementById('verificationRoot') && !document.getElementById('verificationRoot').hidden,
  queueVisible: !!document.getElementById('appsQueue') && !document.getElementById('appsQueue').hidden,
  mounted: !!document.querySelector('#verificationRoot #vrList'),
}));

/* In-page recording fakes for Firestore + functions. Installed BEFORE the tab mounts. */
const FAKES = `(() => {
  const F = { serverTimestamp: () => ({ __ts: true }) };
  const fixture = [
    { id: 'legacy1', data: { fullName: 'Legacy Applicant', practiceName: 'Old Co', verifyType: 'Verified Business', status: 'pending', email: 'l@x', createdAt: null } },
    { id: 'modern2', data: { fullName: 'Modern Applicant', practiceName: 'New Co', verifyType: 'Verified Professional', status: 'pending', email: 'm@x', applicantUid: 'uid_2', refNumber: 'REF-2', createdAt: null } },
    { id: 'done3',   data: { fullName: 'Approved One', verifyType: 'Verified Business', status: 'approved', applicantUid: 'uid_3', createdAt: null } },
  ];
  window.__VR = { writes: [], calls: [], refuse: null };
  const qobj = (name) => ({ orderBy() { return this; }, limit() { return this; }, where() { return this; },
    get: async () => ({ forEach: (fn) => { if (name === 'verificationRequests') fixture.forEach((d) => fn({ id: d.id, data: () => d.data })); }, empty: name !== 'verificationRequests', size: 0, docs: [] }),
    doc: (id) => ({
      update: async (patch) => { const p = name + '/' + id; if (window.__VR.refuse === p) { const e = new Error('Missing or insufficient permissions.'); e.code = 'permission-denied'; throw e; } window.__VR.writes.push({ op: 'update', path: p, patch }); },
      set: async (data) => { window.__VR.writes.push({ op: 'set', path: name + '/' + id, data }); },
      get: async () => ({ exists: false, data: () => null }),
    }),
    add: async (data) => { window.__VR.writes.push({ op: 'add', path: name, data }); return { id: 'new' }; },
  });
  window.firebase = window.firebase || {};
  const fs_ = () => ({ collection: (n) => qobj(n) });
  fs_.FieldValue = F;
  window.firebase.firestore = fs_;
  /* Extend the stub's auth object rather than replace it: the page keeps calling
     firebase.auth().onAuthStateChanged after this runs. */
  const origAuth = window.firebase.auth;
  window.firebase.auth = () => Object.assign(origAuth ? origAuth() : {}, { currentUser: { uid: 'admin_9', email: 'admin@sokoni.test' } });
  window.firebase.functions = () => ({ httpsCallable: (n) => async (d) => { window.__VR.calls.push({ n, d }); return { data: { ok: true } }; } });
})();`;

(async () => {
  const browser = await chromium.launch();

  console.log('VERIFICATION CONVERGENCE — ONE ROUTE, ONE REVIEWER\n');
  console.log('  [R — the route]');
  let r = await openPage(browser, { hash: '#applications/verification' });
  if (!r.booted) { console.error('BLOCKED — AdminOS did not boot'); await browser.close(); process.exit(2); }
  let p = r.page; let st = await state(p);
  ok('R1  #applications/verification survives a real reload: Applications panel, "Verification requests" tab, reviewer mounted, queue hidden',
     st.shown[0] === 'applications' && st.tab[0] === 'verification' && st.mounted && st.rootVisible && !st.queueVisible && st.hash === '#applications/verification' && st.cur[0] === 'applications', st);
  await p.click('#panel-applications .tab-bar .tab-btn[data-tab="queue"]'); await p.waitForTimeout(200); st = await state(p);
  ok('R2  the tab bar switches to the queue and the URL follows (#applications/queue)', st.tab[0] === 'queue' && st.queueVisible && !st.rootVisible && st.hash === '#applications/queue', st);
  await p.click('#panel-applications .tab-bar .tab-btn[data-tab="verification"]'); await p.waitForTimeout(200); st = await state(p);
  ok('R3  …and back to verification without re-mounting', st.tab[0] === 'verification' && st.rootVisible && st.hash === '#applications/verification' && (await p.evaluate(() => document.getElementById('verificationRoot').dataset.mounted === '1')), st);
  ok('R4  no page errors', r.errors.length === 0, r.errors);
  await r.ctx.close();

  console.log('\n  [M — the reviewer, against recording fakes]');
  r = await openPage(browser, { hash: '#applications' });
  p = r.page;
  await p.evaluate(FAKES);
  await p.evaluate(() => { const root = document.getElementById('verificationRoot'); delete root.dataset.mounted; SokoniAOS.applicationsTab('verification'); });
  await p.waitForTimeout(400);
  const cards = await p.evaluate(() => [...document.querySelectorAll('.vr-card')].map((c) => ({ id: c.dataset.id, legacy: !!c.querySelector('.st-warn') })));
  ok('M1  the queue renders from verificationRequests (pending filter → 2 of 3 fixture docs)', cards.length === 2 && cards.some((c) => c.id === 'legacy1') && cards.some((c) => c.id === 'modern2'), cards);
  ok('M2  a request without an applicant record is marked, and…', cards.find((c) => c.id === 'legacy1')?.legacy === true, cards);
  await p.click('.vr-card[data-id="legacy1"] [data-act="toggle"]'); await p.waitForTimeout(100);
  const legacyApprove = await p.evaluate(() => !!document.querySelector('.vr-card[data-id="legacy1"] [data-act="approve"]'));
  ok('M3  …offers NO approve control (the rules would refuse the badge write for a stranger)', legacyApprove === false);
  /* fail closed: badge refused → request untouched */
  await p.evaluate(() => { window.__VR.refuse = 'verifications/uid_2'; window.__VR.writes = []; });
  await p.click('.vr-card[data-id="modern2"] [data-act="toggle"]'); await p.waitForTimeout(100);
  await p.click('.vr-card[data-id="modern2"] [data-act="approve"]'); await p.waitForTimeout(400);
  let w = await p.evaluate(() => ({ writes: window.__VR.writes, msg: (document.querySelector('.vr-card[data-id="modern2"] .vr-out') || {}).textContent || '' }));
  ok('M4  FAIL CLOSED: a refused badge write leaves the request and profile untouched, and says so',
     w.writes.length === 0 && /Not approved/.test(w.msg) && /refused/i.test(w.msg), w);
  /* success path: order of writes */
  await p.evaluate(() => { window.__VR.refuse = null; window.__VR.writes = []; window.__VR.calls = []; });
  await p.waitForTimeout(400);   /* the card re-rendered after reload; re-open */
  await p.evaluate(() => { const c = document.querySelector('.vr-card[data-id="modern2"]'); if (c && !c.querySelector('.vr-body')) c.querySelector('[data-act="toggle"]').click(); });
  await p.waitForTimeout(100);
  await p.fill('.vr-card[data-id="modern2"] [data-f="notes"]', 'checked docs');
  await p.click('.vr-card[data-id="modern2"] [data-act="approve"]'); await p.waitForTimeout(500);
  w = await p.evaluate(() => ({ writes: window.__VR.writes.map((x) => x.op + ' ' + x.path), calls: window.__VR.calls, first: window.__VR.writes[0], req: window.__VR.writes.find((x) => x.path === 'verificationRequests/modern2') }));
  ok('M5  approval writes the BADGE first (verifications/uid_2 → approved) …', w.first && w.first.path === 'verifications/uid_2' && w.first.patch.status === 'approved' && w.first.patch.approvedByUid === 'admin_9', w.first);
  ok('M6  …then the profile projection, then the request (approved, with notes), then adminLog',
     JSON.stringify(w.writes) === JSON.stringify(['update verifications/uid_2', 'update users/uid_2', 'update verificationRequests/modern2', 'add adminLog']) && w.req && w.req.patch.status === 'approved' && w.req.patch.adminNotes === 'checked docs', w.writes);
  ok('M7  …and notifies through the ONE sender with a registered type (notifySend / seller_verified) to the applicant',
     w.calls.length === 1 && w.calls[0].n === 'notifySend' && w.calls[0].d.uid === 'uid_2' && w.calls[0].d.type === 'seller_verified', w.calls);
  ok('M8  the reviewer never writes a notifications document directly (no second sender)', !fs.readFileSync(path.join(ROOT, 'sokoni-verification-review.js'), 'utf8').match(/collection\(['"]notifications['"]\)/));
  /* reject */
  await p.evaluate(() => { window.__VR.writes = []; window.__VR.calls = []; });
  await p.evaluate(() => { const c = document.querySelector('.vr-card[data-id="modern2"]'); if (c && !c.querySelector('.vr-body')) c.querySelector('[data-act="toggle"]').click(); });
  await p.waitForTimeout(100);
  await p.click('.vr-card[data-id="modern2"] [data-act="reject"]'); await p.waitForTimeout(200);
  let rj = await p.evaluate(() => ({ writes: window.__VR.writes.length, msg: (document.querySelector('.vr-card[data-id="modern2"] .vr-out') || {}).textContent || '' }));
  ok('M9  reject without a reason is refused by the reviewer before any write', rj.writes === 0 && /reason is required/i.test(rj.msg), rj);
  await p.fill('.vr-card[data-id="modern2"] [data-f="reason"]', 'ID does not match');
  await p.click('.vr-card[data-id="modern2"] [data-act="reject"]'); await p.waitForTimeout(400);
  rj = await p.evaluate(() => ({ writes: window.__VR.writes.map((x) => x.op + ' ' + x.path), req: window.__VR.writes.find((x) => x.path === 'verificationRequests/modern2'), calls: window.__VR.calls.length, msg: (document.querySelector('.vr-card[data-id="modern2"] .vr-out') || {}).textContent || '' }));
  ok('M10 reject with a reason: request → rejected (reason kept), adminLog written, NO notice sent and it says why',
     rj.req && rj.req.patch.status === 'rejected' && rj.req.patch.rejectionReason === 'ID does not match' && rj.writes.includes('add adminLog') && rj.calls === 0 && /No notice sent/.test(rj.msg), rj);
  const identity = await p.evaluate(() => window.__VR.writes.find((x) => x.path === 'adminLog')?.data);
  ok('M11 the reviewer identity is the page session, never localStorage', identity && identity.adminUid === 'admin_9' && !/localStorage\s*\.\s*(get|set|remove)Item/.test(fs.readFileSync(path.join(ROOT, 'sokoni-verification-review.js'), 'utf8')), identity);
  ok('M12 no page errors', r.errors.length === 0, r.errors);
  await r.ctx.close();

  console.log('\n  [P — the applicant page complies with the served rules (static)]');
  const vh = fs.readFileSync(path.join(ROOT, 'verification.html'), 'utf8');
  const submit = vh.slice(vh.indexOf('const refNumber = genRef();'), vh.indexOf('window.resetForm'));
  ok('P1  the request carries applicantUid: applicant.uid', /applicantUid:\s*applicant\.uid/.test(submit));
  ok('P2  the duplicate check is by the applicant\'s OWN uid, not by email', /where\("applicantUid",\s*"==",\s*applicant\.uid\)/.test(submit) && !/where\("email"/.test(submit));
  ok('P3  it creates its own pending badge record without verifiedAt/approvedBy', /setDoc\(badgeRef,\s*\{[^}]*status:\s*"pending"/.test(submit) && !/approvedBy|verifiedAt/.test(submit.slice(submit.indexOf('setDoc(badgeRef'), submit.indexOf('setDoc(badgeRef') + 300)));
  ok('P4  it submits as the SITE\'s signed-in user (default app), and says "sign in" when there is none', /name === "\[DEFAULT\]"/.test(vh) && /getSignedInUser\(\)/.test(submit) && /Sign in to submit/.test(submit));
  ok('P5  a rules refusal is named, not blamed on the network', /permission-denied/.test(submit));

  console.log('\n  [S — Super Admin reaches the same destination]');
  const sa = fs.readFileSync(path.join(ROOT, 'super-admin.html'), 'utf8');
  ok('S1  Super Admin links to admin-os.html#applications or #applications/verification', /href="admin-os\.html#applications(\/verification)?"/.test(sa));

  console.log('\n  [V1b — the duplicate reviewers are retired behind the canonical routes]');
  const aos = fs.readFileSync(path.join(ROOT, 'sokoni-aos.js'), 'utf8');
  const va = fs.readFileSync(path.join(ROOT, 'verification-admin.html'), 'utf8');
  const adm = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
  ok('B1  POSITIVE: AdminOS still owns the application queue (applicationList + applicationDecide in sokoni-aos.js)', /"applicationList"/.test(aos) && /"applicationDecide"/.test(aos));
  ok('B2  Super Admin no longer carries a second application queue (no applicationList/applicationDecide, no panel-applications)', !/applicationList|applicationDecide|panel-applications/.test(sa));
  ok('B3  …and links to AdminOS #applications', /href="admin-os\.html#applications"/.test(sa));
  /* Usage, not words: both pages carry comments that NAME what was retired. */
  ok('B4  verification-admin.html is an entry point only: routes to the reviewer, keeps the admin guard, reviews nothing',
     /admin-os\.html#applications\/verification/.test(va) && /data-admin-guard="admin"/.test(va)
     && !/collection\(|initializeApp\(|localStorage\s*\.|getFirestore/.test(va) && va.length < 4000, va.length);
  ok('B5  admin.html\'s legacy entry points at the route and its orphaned reviewer (verification_requests) is gone',
     /href="admin-os\.html#applications\/verification"/.test(adm)
     && !/collection\(['"]verification_requests['"]\)|window\.(approve|reject)Verification\s*=|window\.loadVerifications\s*=/.test(adm));
  /* route certification: the old page really lands on the reviewer */
  const rctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
  await rctx.addInitScript(shared.compatInit);
  await rctx.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== HOST) return route.abort();
    if (/\/firebase\.js$/.test(url.pathname)) return route.fulfill({ status: 200, contentType: 'application/javascript', body: shared.instrumentedModule(ROOT) });
    if (/firebasejs/.test(url.pathname)) return route.fulfill({ status: 200, contentType: 'application/javascript', body: shared.gstaticStub(url.pathname) });
    const file = path.join(ROOT, decodeURIComponent(url.pathname).replace(/^\/+/, ''));
    if (!file.startsWith(ROOT)) return route.fulfill({ status: 403, body: '' });
    let buf; try { buf = fs.readFileSync(file); } catch (_) { return route.fulfill({ status: 404, body: '404' }); }
    return route.fulfill({ status: 200, contentType: MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', body: buf });
  });
  const rp = await rctx.newPage();
  await rp.goto('https://' + HOST + '/verification-admin.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  let landed = false;
  try { await rp.waitForFunction(() => location.pathname.endsWith('/admin-os.html') && location.hash === '#applications/verification' && !!document.querySelector('#verificationRoot #vrList'), { timeout: 25000 }); landed = true; } catch (_) {}
  ok('B6  ROUTE: opening verification-admin.html lands on admin-os.html#applications/verification with the reviewer mounted', landed, await rp.evaluate(() => location.href));
  await rctx.close();

  console.log('\n  [negative control]');
  const mod = fs.readFileSync(path.join(ROOT, 'sokoni-verification-review.js'), 'utf8');
  const cut = mod.replace("var st = a.status || 'pending', legacy = !a.applicantUid,", "var st = a.status || 'pending', legacy = false,");
  if (cut === mod) { console.error('PROBE INVALID — sabotage target not found'); await browser.close(); process.exit(2); }
  const n = await openPage(browser, { hash: '#applications', overrides: { '/sokoni-verification-review.js': cut } });
  if (n.booted) {
    await n.page.evaluate(FAKES);
    await n.page.evaluate(() => { const root = document.getElementById('verificationRoot'); delete root.dataset.mounted; SokoniAOS.applicationsTab('verification'); });
    await n.page.waitForTimeout(400);
    await n.page.click('.vr-card[data-id="legacy1"] [data-act="toggle"]'); await n.page.waitForTimeout(100);
    ok('NEGATIVE: with the legacy guard removed, a legacy request DOES show Approve (M3 is live)', await n.page.evaluate(() => !!document.querySelector('.vr-card[data-id="legacy1"] [data-act="approve"]')));
  } else ok('NEGATIVE booted', false);
  await n.ctx.close();

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR — ' + e.message); process.exit(2); });
