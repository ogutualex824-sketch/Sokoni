#!/usr/bin/env node
/* ================================================================
   SOKONI — Email workspace (Slice C2): outbound is real, inbound is not, and the UI says so
   scripts/test-email-workspace.js

   WHAT IT HOLDS
     R  #comms/email is the canonical email surface: it survives a real reload,
        mounts the ONE workspace module, and Super Admin links to it.
     I  the inbound/two-way state is NOT PROVISIONED — derived from the server's
        communicationHealth answer (human mailbox transport absent) plus stated
        code facts — and there is NO reply control anywhere on the surface.
     S  "Message a person": Plan runs BEFORE Send and sends nothing; Send goes to
        communicationSend with recipientUid/subject/body (+ anchor only when
        both parts are given); what is shown is the server's answer; a refusal
        is a refusal.
     L  "Sent mail" is emailLogs, rendered as delivery evidence (status,
        provider, opened/clicked/bounced), filterable by account; a failed read
        never looks like an empty log.
     E  the former Test Email and Email Blast controls are still present and
        still wired to SokoniAOS.sendTestEmail / sendEmailBlast (moved, not lost).
     H  "Email history" on an application card, a verification request and a
        ticket renders that account's emailLogs; a record without a uid says so.
   Static: the module writes nothing (no add/set/update), never names the
   email service, and the word "reply" does not appear as a control.
   A served-markup negative control rewrites the inbound card to "provisioned"
   and must turn the inbound check red.

   HERMETIC (fixture layer by accessor hooks; other origins aborted).
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
  const LOGS = [
    { id: 'm1', uid: 'uid_2', to: 'm@x', from: '"SOKONI Support" <support@mysokoni.co.ke>', subject: 'Your documents', status: 'sent', provider: 'sendgrid', sentAt: null, openedAt: { toDate: () => new Date(2026, 8, 29) } },
    { id: 'm2', uid: 'uid_2', to: 'm@x', from: 'noreply@mysokoni.co.ke', subject: 'Welcome', status: 'bounced', provider: 'sendgrid', sentAt: null, bouncedAt: { toDate: () => new Date(2026, 8, 28) } },
    { id: 'm3', uid: 'uid_9', to: 'z@x', from: 'orders@mysokoni.co.ke', subject: 'Order shipped', status: 'sent', provider: 'smtp', sentAt: null },
  ];
  const APPS = [{ id: 'app_1', name: 'One Co', status: 'pending', role: 'seller', uid: 'uid_2' }, { id: 'app_2', name: 'No Uid', status: 'pending', role: 'seller' }];
  const REQUESTS = [{ id: 'modern2', data: { fullName: 'Modern', verifyType: 'Verified Professional', status: 'pending', email: 'm@x', applicantUid: 'uid_2' } }];
  const TICKETS = [{ id: 't1', subject: 'Help', email: 'm@x', uid: 'uid_2', priority: 'high', status: 'open' }];
  window.__C2 = { calls: [], logFail: false };
  let fnsRef = null, fsRef = null;
  const wrappedFns = () => {
    const base = fnsRef ? fnsRef() : { httpsCallable: () => async () => ({ data: {} }) };
    return { httpsCallable: (name) => async (data) => {
      const op = (name === 'adminOsDispatch' || name === 'connectDispatch') && data && data.op ? data.op : name;
      window.__C2.calls.push({ name, op, data, t: Date.now() });
      if (op === 'communicationHealth') return { data: { rows: [
        { provider: 'sendgrid', provisioned: true, liveness: 'unobserved' }, { provider: 'smtp', provisioned: false, liveness: 'unobserved' },
        { provider: 'google_workspace', provisioned: false, liveness: 'unobserved' }, { provider: 'africas_talking', provisioned: true, liveness: 'unobserved' } ],
        chains: { email: ['sendgrid', 'smtp'] }, measures: 'provisioning and observed liveness', doesNotMeasure: 'delivery rate' } };
      if (op === 'communicationPlan') return { data: { recipientUid: data.recipientUid, plan: data.recipientUid === 'uid_unreachable' ? [] : ['push', 'email'], reachability: { present: false, hasPushTarget: true, hasEmail: true, hasPhone: false }, explain: 'push first, email fallback', sent: false } };
      if (op === 'communicationSend') { if (data.recipientUid === 'uid_refused') { const e = new Error('an anchor needs both anchorType and anchorId'); e.code = 'invalid-argument'; throw e; } return { data: { sent: true, plan: ['push', 'email'], explain: 'sent through the engine', dedupeKey: 'admin_msg:rc:' + data.recipientUid } }; }
      if (op === 'applicationList') return { data: { items: APPS, counts: { pending: 2 } } };
      if (op === 'adminGetSupportTickets') return { data: { tickets: TICKETS, items: TICKETS, count: 1 } };
      return base.httpsCallable(name)(data);
    } };
  };
  const wrappedFs = () => {
    const base = fsRef ? fsRef() : { collection: () => ({}) };
    return { collection: (name) => {
      if (name === 'emailLogs') { const q = { _uid: null, where(f, _o, v) { if (f === 'uid') q._uid = v; return q; }, orderBy() { return q; }, limit() { return q; },
        get: async () => { if (window.__C2.logFail) { const e = new Error('Missing or insufficient permissions.'); e.code = 'permission-denied'; throw e; }
          const rows = LOGS.filter((m) => !q._uid || m.uid === q._uid); return { forEach: (fn) => rows.forEach((m) => fn({ id: m.id, data: () => m })), empty: !rows.length, size: rows.length }; } }; return q; }
      if (name === 'supportTickets') return Object.assign({}, base.collection(name), { doc: (id) => ({ get: async () => { const t = TICKETS.find((x) => x.id === id); return { exists: !!t, data: () => t }; } }) });
      if (name === 'verificationRequests') return { orderBy() { return this; }, limit() { return this; }, where() { return this; },
        get: async () => ({ forEach: (fn) => REQUESTS.forEach((d) => fn({ id: d.id, data: () => d.data })), empty: false, size: REQUESTS.length, docs: [] }), doc: () => ({ update: async () => {}, get: async () => ({ exists: false }) }) };
      return base.collection(name);
    } };
  };
  const install = (fb) => {
    if (!fb || typeof fb !== 'object' || fb.__c2Hooked) return fb;
    fnsRef = typeof fb.functions === 'function' ? fb.functions : fnsRef; fsRef = typeof fb.firestore === 'function' ? fb.firestore : fsRef;
    Object.defineProperty(fb, 'functions', { configurable: true, enumerable: true, get: () => wrappedFns, set: (v) => { fnsRef = v; } });
    Object.defineProperty(fb, 'firestore', { configurable: true, enumerable: true, get: () => { if (fsRef && fsRef.FieldValue) wrappedFs.FieldValue = fsRef.FieldValue; if (fsRef && fsRef.Timestamp) wrappedFs.Timestamp = fsRef.Timestamp; return wrappedFs; }, set: (v) => { fsRef = v; } });
    const origApp = fb.app; fb.app = () => Object.assign({}, (typeof origApp === 'function' ? origApp() : {}) || {}, { functions: () => wrappedFns() });
    Object.defineProperty(fb, '__c2Hooked', { value: true }); return fb;
  };
  let cur = install(window.firebase);
  Object.defineProperty(window, 'firebase', { configurable: true, get: () => cur, set: (v) => { cur = install(v); } });
}

async function openPage(browser, { hash = '', overrides = {} }) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
  await ctx.addInitScript(shared.compatInit); await ctx.addInitScript(fixtureInit);
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
  const page = await ctx.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('about:blank');
  await page.goto('https://' + HOST + '/admin-os.html' + hash, { waitUntil: 'domcontentloaded', timeout: 30000 });
  let booted = true;
  try { await page.waitForFunction(() => !!(window.SokoniAOS && document.querySelector('#aosNav .nav-item.active')), { timeout: 20000 }); } catch (_) { booted = false; }
  if (booted) { await page.waitForTimeout(500); await page.evaluate(() => ['sk-splash', 'sk-offline-bar'].forEach((id) => { const e = document.getElementById(id); if (e) e.remove(); })); }
  return { page, ctx, booted, errors };
}

(async () => {
  const browser = await chromium.launch();
  console.log('EMAIL WORKSPACE — OUTBOUND IS REAL, INBOUND IS NOT, THE UI SAYS SO\n');
  console.log('  [R — the route]');
  const r = await openPage(browser, { hash: '#comms/email' });
  if (!r.booted) { console.error('BLOCKED — AdminOS did not boot'); await browser.close(); process.exit(2); }
  const p = r.page;
  await p.waitForSelector('#ewInbound', { timeout: 10000 }).catch(() => {});
  let st = await p.evaluate(() => ({ hash: location.hash, tab: document.querySelector('#panel-comms .tab-bar .tab-btn.active')?.dataset.tab, mounted: !!document.querySelector('#commsBody #ewComposer') && !!document.querySelector('#commsBody #ewInbound') }));
  ok('R1  #comms/email survives a real reload: Communications panel, Email tab, the ONE workspace mounted', st.hash === '#comms/email' && st.tab === 'email' && st.mounted, st);
  ok('R2  Super Admin links to the same surface', /href="admin-os\.html#comms\/email"/.test(fs.readFileSync(path.join(ROOT, 'super-admin.html'), 'utf8')));

  console.log('\n  [I — inbound is not provisioned, and nothing offers a reply]');
  st = await p.evaluate(() => { const c = document.getElementById('ewInbound'); return { state: c?.dataset.inbound, text: c?.textContent || '', workspaceRow: /Human mailbox transport[^]*?not provisioned/.test(c?.textContent || '') }; });
  ok('I1  the inbound card says NOT PROVISIONED, with the server\'s own "human mailbox transport: not provisioned"', st.state === 'not-provisioned' && /not provisioned/.test(st.text) && st.workspaceRow, st.text.slice(0, 120));
  ok('I2  …names the code facts (DMARC-only Inbound Parse, no thread store, no reply headers) as code facts', /reports\.mysokoni\.co\.ke/.test(st.text) && /not implemented/.test(st.text) && /code facts/.test(st.text));
  const replyControls = await p.evaluate(() => [...document.querySelectorAll('#commsBody button, #commsBody a, #commsBody input[type="submit"]')].filter((b) => /\breply\b/i.test(b.textContent + ' ' + (b.getAttribute('aria-label') || ''))).length);
  ok('I3  NO reply control exists anywhere on the surface', replyControls === 0, replyControls);

  console.log('\n  [S — message a person: plan, then send, through the engine]');
  await p.fill('#ewTo', 'uid_2'); await p.fill('#ewSubject', 'About your application'); await p.fill('#ewBody', 'We need one more document.');
  st = await p.evaluate(() => document.getElementById('ewSend').disabled);
  ok('S1  Send is disabled until a plan has been produced', st === true);
  await p.click('#ewPlan'); await p.waitForTimeout(300);
  st = await p.evaluate(() => ({ calls: window.__C2.calls.map((c) => c.op), planOut: document.getElementById('ewPlanOut').textContent, sendEnabled: !document.getElementById('ewSend').disabled }));
  ok('S2  Plan calls communicationPlan only (nothing sent) and shows the server\'s plan words', st.calls.includes('communicationPlan') && !st.calls.includes('communicationSend') && /push → email|push → email/.test(st.planOut) && /Nothing has been sent/.test(st.planOut) && st.sendEnabled, st);
  await p.click('#ewSend'); await p.waitForTimeout(400);
  st = await p.evaluate(() => ({ send: window.__C2.calls.find((c) => c.op === 'communicationSend'), plan: window.__C2.calls.find((c) => c.op === 'communicationPlan'), out: document.getElementById('ewSendOut').textContent }));
  ok('S3  Send goes to communicationSend with recipientUid/subject/body and NO anchor when none was given, after the plan', st.send && st.send.data.recipientUid === 'uid_2' && st.send.data.subject === 'About your application' && st.send.data.anchorType === undefined && st.plan.t <= st.send.t, st.send && st.send.data);
  ok('S4  …and shows only the server\'s answer', /Sent\./.test(st.out) && /sent through the engine/.test(st.out) && /admin_msg:rc:uid_2/.test(st.out), st.out);
  await p.fill('#ewTo', 'uid_unreachable'); await p.click('#ewPlan'); await p.waitForTimeout(300);
  st = await p.evaluate(() => ({ planOut: document.getElementById('ewPlanOut').textContent, sendDisabled: document.getElementById('ewSend').disabled }));
  ok('S5  an unreachable person: the plan says so and Send stays disabled', /nothing can reach/.test(st.planOut) && st.sendDisabled, st);
  await p.fill('#ewTo', 'uid_refused'); await p.click('#ewPlan'); await p.waitForTimeout(300); await p.click('#ewSend'); await p.waitForTimeout(300);
  st = await p.evaluate(() => document.getElementById('ewSendOut').textContent);
  ok('S6  a server refusal is shown as a refusal', /Not sent:|Refused/.test(st), st);
  await p.selectOption('#ewAnchorType', 'support'); await p.fill('#ewAnchorId', ''); await p.fill('#ewTo', 'uid_2'); await p.click('#ewPlan'); await p.waitForTimeout(300); await p.evaluate(() => { window.__C2.calls = []; }); await p.click('#ewSend'); await p.waitForTimeout(200);
  st = await p.evaluate(() => ({ out: document.getElementById('ewSendOut').textContent, sends: window.__C2.calls.filter((c) => c.op === 'communicationSend').length }));
  ok('S7  a half anchor is refused before any call', /both a type and an id/.test(st.out) && st.sends === 0, st);

  console.log('\n  [L — sent mail is delivery evidence]');
  await p.click('#ewLogAll'); await p.waitForTimeout(300);
  let rows = await p.evaluate(() => [...document.querySelectorAll('#ewLog tr[data-email]')].map((r) => r.textContent));
  ok('L1  the log renders emailLogs with status, provider and open/bounce evidence', rows.length === 3 && rows.some((t) => /bounced/.test(t) && /bounced 28 Sept|bounced 28/.test(t)) && rows.some((t) => /opened/.test(t)) && rows.some((t) => /smtp/.test(t)), rows);
  await p.fill('#ewLogUid', 'uid_2'); await p.click('#ewLogGo'); await p.waitForTimeout(300);
  rows = await p.evaluate(() => document.querySelectorAll('#ewLog tr[data-email]').length);
  ok('L2  filtering by account narrows to that account\'s mail', rows === 2, rows);
  await p.evaluate(() => { window.__C2.logFail = true; }); await p.click('#ewLogAll'); await p.waitForTimeout(300);
  st = await p.evaluate(() => document.getElementById('ewLog').textContent);
  ok('L3  a failed read never looks like an empty log', /Could not read emailLogs/.test(st) && !/No email in the log/.test(st), st.slice(0, 100));
  await p.evaluate(() => { window.__C2.logFail = false; });

  console.log('\n  [E — the former controls are moved, not lost]');
  st = await p.evaluate(() => ({ test: !!document.querySelector('#ewLegacy button[onclick*="sendTestEmail"]'), blast: !!document.querySelector('#ewLegacy button[onclick*="sendEmailBlast"]'), aos: typeof SokoniAOS.sendTestEmail === 'function' && typeof SokoniAOS.sendEmailBlast === 'function' }));
  ok('E1  Test Email and Email Blast are present and wired to their existing handlers', st.test && st.blast && st.aos, st);

  console.log('\n  [H — email history on the records]');
  await p.evaluate(() => { document.getElementById('appsStatus').value = ''; SokoniAOS.navigate('applications', 'queue'); SokoniAOS.loadApplications(); }); await p.waitForTimeout(400);
  st = await p.evaluate(() => ({ withUid: !!document.querySelector('#app-app_1 button[onclick*="emailHistory"]'), noUid: !!document.querySelector('#app-app_2 button[onclick*="emailHistory"]') }));
  ok('H1  an application card offers Email history only when the account uid is known', st.withUid && !st.noUid, st);
  await p.click('#app-app_1 button[onclick*="emailHistory"]'); await p.waitForTimeout(300);
  rows = await p.evaluate(() => document.querySelectorAll('#appMail-app_1 tr[data-email]').length);
  ok('H2  …and renders that account\'s emailLogs inline', rows === 2, rows);
  await p.evaluate(() => SokoniAOS.openVerificationRequest('modern2')); await p.waitForTimeout(400);
  await p.click('.vr-card[data-id="modern2"] [data-act="mail"]'); await p.waitForTimeout(300);
  rows = await p.evaluate(() => document.querySelectorAll('.vr-card[data-id="modern2"] .vr-mail tr[data-email]').length);
  ok('H3  a verification request renders its applicant\'s emailLogs', rows === 2, rows);
  await p.evaluate(() => SokoniAOS.openTicket('t1')); await p.waitForTimeout(400);
  await p.click('#modalBody button[onclick*="emailHistory"]'); await p.waitForTimeout(300);
  rows = await p.evaluate(() => document.querySelectorAll('#ticketMail-t1 tr[data-email]').length);
  ok('H4  a ticket detail renders the requester\'s emailLogs', rows === 2, rows);
  ok('H5  no page errors', r.errors.length === 0, r.errors);
  await r.ctx.close();

  console.log('\n  [static]');
  const mod = fs.readFileSync(path.join(ROOT, 'sokoni-email-workspace.js'), 'utf8');
  /* Code, not comments: the header cites functions/email-service.js by name. */
  const code = mod.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/LEGACY_HTML = `[\s\S]*?`;/, '');
  ok('X1  the workspace writes nothing and names no email service (read + callables only)', !/\.(add|set|update|delete)\(/.test(code) && !/email-service|sgMail|sendgrid\.com/.test(code));
  ok('X2  the word "reply" appears in the module only as the statement that there is no reply-from-here', (mod.match(/reply/gi) || []).length >= 1 && !/<button[^>]*>[^<]*reply/i.test(mod));

  console.log('\n  [negative control]');
  const cut = mod.replace('data-inbound="not-provisioned"', 'data-inbound="provisioned"').replace('<span class="status-badge st-warn">not provisioned</span>', '<span class="status-badge">provisioned</span>');
  if (cut === mod) { console.error('PROBE INVALID — sabotage target not found'); await browser.close(); process.exit(2); }
  const n = await openPage(browser, { hash: '#comms/email', overrides: { '/sokoni-email-workspace.js': cut } });
  if (n.booted) {
    await n.page.waitForSelector('#ewInbound', { timeout: 10000 }).catch(() => {});
    const s = await n.page.evaluate(() => document.getElementById('ewInbound')?.dataset.inbound);
    ok('NEGATIVE: an inbound card claiming "provisioned" is detected (I1 is live)', s === 'provisioned');
  } else ok('NEGATIVE booted', false);
  await n.ctx.close();

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR — ' + e.message); process.exit(2); });
