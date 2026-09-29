#!/usr/bin/env node
/* ================================================================
   SOKONI — Connect video verification as a CONTEXTUAL action (Slice V3)
   scripts/test-video-verification-actions.js

   WHAT IT HOLDS
     E  eligibility is decided by the record: the action appears only while a
        decision is open (pending / request_info / under_review) AND the subject's
        uid is known — never on a decided record, never on one whose applicant
        never signed in, never on a support ticket.
     P  the subject is PREFILLED from the record and the request goes through
        SokoniConnectVerify.request — the Connect console's own callable path
        (connectDispatch → connectRequestVerification), the one caller in the
        code base — with applicationId for applications and the request id in
        the notes for verification requests.
     H  what is shown is what the server returned: the verification/session ids,
        "recording: DISABLED", the transport plan when the server planned one
        ("route: webrtc"), "no route yet" when it did not, never "pstn"; and the
        line that this is evidence, not a verdict. A server refusal is shown as a
        refusal and nothing is written.
     A  from a verification request, the returned id is ATTACHED to the request
        (videoVerificationId) so the evidence is findable from the record; an
        existing id renders with a Connect console link.
   A served-markup negative control widens application eligibility and must turn
   the eligibility check red.

   HERMETIC: fake host from disk, other origins aborted, the compat stub from
   scripts/lib/adminos-probe-lib.js plus an in-page fixture layer installed by
   accessor hooks before AdminOS captures its handles. Cannot reach production.
   The server gate itself is proven by scripts/test-connect-authority.js (856/0)
   and scripts/test-connect-rules.js; V3 changes no server code.
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

function fixtureInit() {
  const APPS = [
    { id: 'app_pend', name: 'Pending Co', status: 'pending', role: 'seller', uid: 'uid_online', businessId: 'biz_1' },
    { id: 'app_nouid', name: 'No Account', status: 'pending', role: 'seller' },
    { id: 'app_done', name: 'Done Ltd', status: 'approved', role: 'seller', uid: 'uid_x', projectionStatus: 'applied' },
    { id: 'app_info', name: 'Info Wanted', status: 'request_info', role: 'driver', uid: 'uid_off' },
    { id: 'app_refused', name: 'Refused Co', status: 'pending', role: 'provider', uid: 'uid_refused' },
  ];
  const REQUESTS = [
    { id: 'modern2', data: { fullName: 'Modern', verifyType: 'Verified Professional', status: 'pending', email: 'm@x', applicantUid: 'uid_off', refNumber: 'REF-2' } },
    { id: 'legacy1', data: { fullName: 'Legacy', verifyType: 'Verified Business', status: 'pending', email: 'l@x' } },
    { id: 'done3', data: { fullName: 'Done', verifyType: 'Verified Business', status: 'approved', applicantUid: 'uid_x' } },
    { id: 'vid4', data: { fullName: 'Reviewing', verifyType: 'Verified Driver', status: 'under_review', applicantUid: 'uid_online', videoVerificationId: 'ver_old' } },
  ];
  const TICKETS = [{ id: 't1', subject: 'A ticket', email: 'a@x', priority: 'high', status: 'open', context: { requestId: 'modern2' } }];
  window.__V3 = { calls: [], writes: [], n: 0 };
  let fnsRef = null, fsRef = null;
  const wrappedFns = () => {
    const base = fnsRef ? fnsRef() : { httpsCallable: () => async () => ({ data: {} }) };
    return { httpsCallable: (name) => async (data) => {
      const op = (name === 'adminOsDispatch' || name === 'connectDispatch') && data && data.op ? data.op : name;
      window.__V3.calls.push({ name, op, data });
      if (op === 'applicationList') return { data: { items: APPS, counts: { pending: 3 } } };
      if (op === 'adminGetSupportTickets') return { data: { tickets: TICKETS, items: TICKETS, count: 1 } };
      if (op === 'connectRequestVerification') {
        if (data.subjectUid === 'uid_refused') { const e = new Error('Platform admin only'); e.code = 'permission-denied'; throw e; }
        const n = ++window.__V3.n;
        return { data: { verificationId: 'ver_' + n, sessionId: 's_' + n, recording: 'DISABLED', transportPlan: data.subjectUid === 'uid_online' ? ['webrtc'] : [], authority: 'providerVerification' } };
      }
      return base.httpsCallable(name)(data);
    } };
  };
  const wrappedFs = () => {
    const base = fsRef ? fsRef() : { collection: () => ({}) };
    return { collection: (name) => {
      if (name === 'verificationRequests') return { orderBy() { return this; }, limit() { return this; }, where() { return this; },
        get: async () => ({ forEach: (fn) => REQUESTS.forEach((d) => fn({ id: d.id, data: () => d.data })), empty: false, size: REQUESTS.length, docs: [] }),
        doc: (id) => ({ update: async (patch) => { window.__V3.writes.push({ path: 'verificationRequests/' + id, patch }); }, get: async () => ({ exists: false }) }) };
      return base.collection(name);
    } };
  };
  const install = (fb) => {
    if (!fb || typeof fb !== 'object' || fb.__v3Hooked) return fb;
    fnsRef = typeof fb.functions === 'function' ? fb.functions : fnsRef;
    fsRef = typeof fb.firestore === 'function' ? fb.firestore : fsRef;
    Object.defineProperty(fb, 'functions', { configurable: true, enumerable: true, get: () => wrappedFns, set: (v) => { fnsRef = v; } });
    Object.defineProperty(fb, 'firestore', { configurable: true, enumerable: true,
      get: () => { if (fsRef && fsRef.FieldValue) wrappedFs.FieldValue = fsRef.FieldValue; if (fsRef && fsRef.Timestamp) wrappedFs.Timestamp = fsRef.Timestamp; return wrappedFs; },
      set: (v) => { fsRef = v; } });
    const origApp = fb.app;
    fb.app = () => Object.assign({}, (typeof origApp === 'function' ? origApp() : {}) || {}, { functions: () => wrappedFns() });
    Object.defineProperty(fb, '__v3Hooked', { value: true });
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
const shownPanel = (p) => p.evaluate(() => [...document.querySelectorAll('.aos-panel')].filter((x) => !x.hidden).map((x) => x.id.slice(6))[0]);

(async () => {
  const browser = await chromium.launch();
  console.log('VIDEO VERIFICATION — A CONTEXTUAL ACTION ON THE RECORD\n');
  console.log('  [E/P/H — applications]');
  const r = await openPage(browser, { hash: '#applications/queue' });
  if (!r.booted) { console.error('BLOCKED — AdminOS did not boot'); await browser.close(); process.exit(2); }
  const p = r.page;
  await p.evaluate(() => { document.getElementById('appsStatus').value = ''; SokoniAOS.loadApplications(); });
  await p.waitForSelector('.aos-card', { timeout: 10000 }).catch(() => {});
  const cards = await p.evaluate(() => [...document.querySelectorAll('.aos-card')].map((c) => ({ id: c.id.replace(/^app-/, ''), video: !!c.querySelector('button[onclick*="videoVerification"]') })));
  const withBtn = cards.filter((c) => c.video).map((c) => c.id).sort();
  ok('E1  the action appears exactly on open decisions with a known uid (pending / request_info), not on a decided or account-less one',
     cards.length === 5 && JSON.stringify(withBtn) === JSON.stringify(['app_info', 'app_pend', 'app_refused']), cards);
  await p.click('#app-app_pend button[onclick*="videoVerification"]'); await p.waitForTimeout(200);
  let f = await p.evaluate(() => ({ reason: document.querySelector('#appVideo-app_pend [data-f="reason"]')?.value, text: document.getElementById('appVideo-app_pend').textContent }));
  ok('P1  the form is prefilled from the record: subject uid shown, reason defaulted by role (seller → merchant_verification), consent + recording OFF stated',
     f.reason === 'merchant_verification' && /uid_online/.test(f.text) && /consent/i.test(f.text) && /recording is OFF/i.test(f.text), f);
  await p.click('#appVideo-app_pend [data-f="go"]'); await p.waitForTimeout(400);
  let st = await p.evaluate(() => ({ call: window.__V3.calls.find((c) => c.op === 'connectRequestVerification'), out: document.querySelector('#appVideo-app_pend [data-f="out"]').textContent }));
  ok('P2  the request goes through connectDispatch → connectRequestVerification with subjectUid, applicationId and businessId prefilled',
     st.call && st.call.name === 'connectDispatch' && st.call.data.subjectUid === 'uid_online' && st.call.data.applicationId === 'app_pend' && st.call.data.businessId === 'biz_1' && st.call.data.reason === 'merchant_verification', st.call && st.call.data);
  ok('H1  the result is the SERVER\'s: verification + session ids, recording DISABLED, "route: webrtc" (the subject was online), evidence-not-verdict',
     /ver_1/.test(st.out) && /s_1/.test(st.out) && /recording: DISABLED/.test(st.out) && /route: webrtc/.test(st.out) && /evidence, not a verdict/i.test(st.out) && !/pstn/i.test(st.out), st.out);
  await p.click('#app-app_info button[onclick*="videoVerification"]'); await p.waitForTimeout(200);
  f = await p.evaluate(() => document.querySelector('#appVideo-app_info [data-f="reason"]')?.value);
  ok('P3  a rider application defaults to rider_verification', f === 'rider_verification', f);
  await p.click('#appVideo-app_info [data-f="go"]'); await p.waitForTimeout(400);
  st = await p.evaluate(() => document.querySelector('#appVideo-app_info [data-f="out"]').textContent);
  ok('H2  an offline subject: "no route yet" — no route is implied, no PSTN invented', /no route yet/.test(st) && !/route: /.test(st) && !/pstn/i.test(st), st);
  await p.click('#app-app_refused button[onclick*="videoVerification"]'); await p.waitForTimeout(200);
  await p.click('#appVideo-app_refused [data-f="go"]'); await p.waitForTimeout(400);
  st = await p.evaluate(() => ({ out: document.querySelector('#appVideo-app_refused [data-f="out"]').textContent, enabled: !document.querySelector('#appVideo-app_refused [data-f="go"]').disabled }));
  ok('H3  a server refusal is shown as a refusal and the control recovers', /Refused by the server/.test(st.out) && st.enabled, st);

  console.log('\n  [E/P/A — verification requests]');
  await p.evaluate(() => { SokoniAOS.navigate('applications', 'verification'); }); await p.waitForTimeout(500);
  await p.click('.vr-filter[data-filter="all"]'); await p.waitForTimeout(200);
  /* The reviewer keeps ONE card open at a time, so each is opened and read in turn. */
  const vcards = [];
  for (const id of ['modern2', 'legacy1', 'done3', 'vid4']) {
    await p.click(`.vr-card[data-id="${id}"] [data-act="toggle"]`); await p.waitForTimeout(120);
    vcards.push(await p.evaluate((id) => { const c = document.querySelector(`.vr-card[data-id="${id}"]`); return { id, video: !!c.querySelector('[data-act="video"]'), existing: /ver_old/.test(c.textContent) && !!c.querySelector('[data-act="connect"]') }; }, id));
  }
  await p.click('.vr-card[data-id="modern2"] [data-act="toggle"]'); await p.waitForTimeout(120);
  ok('E2  the action appears on open requests with an applicant uid (pending, under_review) — not on a legacy or decided one',
     JSON.stringify(vcards.filter((c) => c.video).map((c) => c.id).sort()) === JSON.stringify(['modern2', 'vid4']), vcards);
  ok('A1  an existing video verification renders on the request with a Connect console link', vcards.find((c) => c.id === 'vid4')?.existing === true, vcards);
  await p.evaluate(() => { window.__V3.calls = []; window.__V3.writes = []; });
  await p.click('.vr-card[data-id="modern2"] [data-act="video"]'); await p.waitForTimeout(200);
  f = await p.evaluate(() => document.querySelector('.vr-card[data-id="modern2"] [data-v="reason"]')?.value);
  ok('P4  the reviewer\'s form defaults a professional tier to identity_verification', f === 'identity_verification', f);
  await p.click('.vr-card[data-id="modern2"] [data-v="go"]'); await p.waitForTimeout(500);
  st = await p.evaluate(() => ({ call: window.__V3.calls.find((c) => c.op === 'connectRequestVerification'), writes: window.__V3.writes, out: document.querySelector('.vr-card[data-id="modern2"] [data-v="out"]').textContent }));
  ok('P5  subject prefilled from the request (applicantUid) and the request id carried in the notes',
     st.call && st.call.data.subjectUid === 'uid_off' && /verificationRequests\/modern2/.test(st.call.data.notes) && /REF-2/.test(st.call.data.notes), st.call && st.call.data);
  ok('A2  the returned id is ATTACHED to the request (videoVerificationId) and the card says so',
     st.writes.length === 1 && st.writes[0].path === 'verificationRequests/modern2' && /^ver_\d+$/.test(st.writes[0].patch.videoVerificationId) && /Attached to this request/.test(st.out), st.writes);
  ok('H4  …and the media state is honest for an offline subject', /no route yet/.test(st.out) && /evidence, not a verdict/i.test(st.out), st.out);
  await p.click('.vr-card[data-id="modern2"] [data-v="out"] [data-act="connect"]'); await p.waitForTimeout(300);
  ok('A3  "Connect console" routes to Communications → Connect', (await shownPanel(p)) === 'comms' && (await p.evaluate(() => document.querySelector('#panel-comms .tab-bar .tab-btn.active')?.dataset.tab)) === 'connect');

  console.log('\n  [E — never on a ticket]');
  await p.evaluate(() => SokoniAOS.navigate('support')); await p.waitForTimeout(400);
  ok('E3  the Support list carries no video action', !(await p.evaluate(() => /video verification/i.test((document.getElementById('supportBody') || {}).textContent || ''))));
  ok('E4  no page errors', r.errors.length === 0, r.errors);
  await r.ctx.close();

  console.log('\n  [P — one caller]');
  const cv = fs.readFileSync(path.join(ROOT, 'sokoni-connect-verify.js'), 'utf8');
  const aos = fs.readFileSync(path.join(ROOT, 'sokoni-aos.js'), 'utf8');
  const rev = fs.readFileSync(path.join(ROOT, 'sokoni-verification-review.js'), 'utf8');
  ok('P6  connectRequestVerification is called from sokoni-connect-verify.js only; AdminOS and the reviewer go through SokoniConnectVerify.request',
     (cv.match(/connectRequestVerification/g) || []).length >= 1 && !/connectRequestVerification/.test(aos) && !/connectRequestVerification/.test(rev) && /SokoniConnectVerify\.request|V\.request\(/.test(aos) && /V\.request\(/.test(rev));

  console.log('\n  [negative control]');
  const cut = aos.replace('function _videoEligible(a) { return !!(a && a.uid && _VIDEO_STATUSES.has(a.status)); }', 'function _videoEligible(a) { return true; }');
  if (cut === aos) { console.error('PROBE INVALID — sabotage target not found'); await browser.close(); process.exit(2); }
  const n = await openPage(browser, { hash: '#applications/queue', overrides: { '/sokoni-aos.js': cut } });
  if (n.booted) {
    await n.page.evaluate(() => { document.getElementById('appsStatus').value = ''; SokoniAOS.loadApplications(); });
    await n.page.waitForSelector('.aos-card', { timeout: 10000 }).catch(() => {});
    const nc = await n.page.evaluate(() => !!document.querySelector('#app-app_done button[onclick*="videoVerification"]'));
    ok('NEGATIVE: with the eligibility guard widened, a decided application DOES show the action (E1 is live)', nc);
  } else ok('NEGATIVE booted', false);
  await n.ctx.close();

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR — ' + e.message); process.exit(2); });
