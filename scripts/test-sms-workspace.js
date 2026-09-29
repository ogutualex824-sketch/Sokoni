#!/usr/bin/env node
/* ================================================================
   SOKONI — SMS workspace (Slice C4): the rail's operational surface shows what it reports
   scripts/test-sms-workspace.js

   WHAT IT HOLDS
     R  #comms/sms survives a real reload and lands on the SMS tab
     W  the broadcast form is still there and still wired to sendSMSBlast (nothing lost)
     L  the lane statement is on the surface as CODE FACTS: outbound ✓, delivery reports ✓,
        inbound SMS ✗, voice/USSD ✗ — and no control offers voice, USSD or inbound
     E  the evidence card renders the server's smsStats answer verbatim: the sender is
        labelled a declaration; a null success rate renders "—"; a count at the read bound
        says so; failures by reason are listed
     U  when the callable FAILS the card says unreadable and shows NO figure (an unknown is
        not a zero) — a negative control that must be reachable
   HERMETIC (fixture layer by accessor hooks; other origins aborted). ONE Chromium.
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
  window.__C4 = { calls: [], mode: (window.__C4_MODE__ || 'observed') };
  let fnsRef = null;
  const wrappedFns = () => {
    const base = fnsRef ? fnsRef() : { httpsCallable: () => async () => ({ data: {} }) };
    return { httpsCallable: (name) => async (data) => {
      const op = name === 'adminOsDispatch' && data && data.op ? data.op : name;
      window.__C4.calls.push({ name, op, data });
      if (op === 'smsStats') {
        if (window.__C4.mode === 'fail') { const e = new Error('Admin access required.'); e.code = 'permission-denied'; throw e; }
        if (window.__C4.mode === 'norate') return { data: { ok: true, sender: '(shared shortcode — SOKONI pending approval)', queuePending: 0, deadLetter: 0, sent24h: 0, estimatedCostKES: 0, deliveryReports: 0, deliverySuccessRate: null, failuresByReason: {} } };
        return { data: { ok: true, sender: 'SOKONI', queuePending: 3, deadLetter: 1, sent24h: 500, estimatedCostKES: 400, deliveryReports: 42, deliverySuccessRate: 95.2, failuresByReason: { Rejected: 1, InsufficientBalance: 1 } } };
      }
      return base.httpsCallable(name)(data);
    } };
  };
  const install = (fb) => {
    if (!fb || typeof fb !== 'object' || fb.__c4Hooked) return fb;
    fnsRef = typeof fb.functions === 'function' ? fb.functions : fnsRef;
    Object.defineProperty(fb, 'functions', { configurable: true, enumerable: true, get: () => wrappedFns, set: (v) => { fnsRef = v; } });
    const origApp = fb.app; fb.app = () => Object.assign({}, (typeof origApp === 'function' ? origApp() : {}) || {}, { functions: () => wrappedFns() });
    Object.defineProperty(fb, '__c4Hooked', { value: true }); return fb;
  };
  let cur = install(window.firebase);
  Object.defineProperty(window, 'firebase', { configurable: true, get: () => cur, set: (v) => { cur = install(v); } });
}

async function openPage(browser, { hash = '', mode = 'observed' }) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
  await ctx.addInitScript(shared.compatInit);
  await ctx.addInitScript('window.__C4_MODE__ = ' + JSON.stringify(mode) + ';');
  await ctx.addInitScript(fixtureInit);
  await ctx.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== HOST) return route.abort();
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
  if (booted) { await page.waitForTimeout(400); await page.evaluate(() => ['sk-splash', 'sk-offline-bar'].forEach((id) => { const e = document.getElementById(id); if (e) e.remove(); })); }
  return { page, ctx, booted, errors };
}
const waitEvidence = (p) => p.waitForFunction(() => { const h = document.getElementById('smsEvidence'); return h && h.dataset.smsEvidence !== 'loading'; }, { timeout: 10000 }).catch(() => {});
const readCard = (p) => p.evaluate(() => {
  const h = document.getElementById('smsEvidence');
  const kv = {}; document.querySelectorAll('#smsEvidenceBody [data-sms-kv]').forEach((el) => { kv[el.dataset.smsKv] = el.textContent; });
  return { state: h && h.dataset.smsEvidence, kv, text: (h && h.textContent) || '', lanes: (document.getElementById('smsLanes') || {}).textContent || '',
           digits: ((document.getElementById('smsEvidenceBody') || {}).textContent || '').match(/\d+/g) || [] };
});

(async () => {
  const browser = await chromium.launch();
  console.log('SMS WORKSPACE — THE RAIL\'S SURFACE SHOWS WHAT IT REPORTS\n');
  console.log('  [R — the route]');
  const r = await openPage(browser, { hash: '#comms/sms' });
  if (!r.booted) { console.error('BLOCKED — AdminOS did not boot'); await browser.close(); process.exit(2); }
  const p = r.page;
  await waitEvidence(p);
  let st = await p.evaluate(() => ({ hash: location.hash, tab: document.querySelector('#panel-comms .tab-bar .tab-btn.active')?.dataset.tab, form: !!document.querySelector('#commsBody #smsBody') && !!document.querySelector('#commsBody #smsTarget') }));
  ok('R1  #comms/sms survives a real reload: Communications panel, SMS tab', st.hash === '#comms/sms' && st.tab === 'sms', st);

  console.log('\n  [W — nothing lost]');
  st = await p.evaluate(() => ({ form: !!document.querySelector('#commsBody #smsBody') && !!document.querySelector('#commsBody #smsTarget'),
    btn: [...document.querySelectorAll('#commsBody button')].some((b) => /Send SMS Broadcast/.test(b.textContent) && /sendSMSBlast/.test(b.getAttribute('onclick') || '')) }));
  ok('W1  the broadcast form is present and its button is still wired to SokoniAOS.sendSMSBlast', st.form && st.btn, st);

  console.log('\n  [L — lanes as code facts, no invented control]');
  let card = await readCard(p);
  ok('L1  the lane statement names all four lanes, two implemented and two not', /outbound SMS ✓/.test(card.lanes) && /delivery reports ✓/.test(card.lanes) && /inbound SMS ✗ not implemented/.test(card.lanes) && /voice \/ USSD ✗ not implemented/.test(card.lanes), card.lanes);
  const badControls = await p.evaluate(() => [...document.querySelectorAll('#commsBody button, #commsBody a, #commsBody select option')].filter((b) => /\b(voice|ussd|call|inbound)\b/i.test(b.textContent)).length);
  ok('L2  no control on the surface offers voice, USSD, a call or inbound SMS', badControls === 0, badControls);
  ok('L2c CONTROL: the surface does have a control (the broadcast button), so L2 saw the buttons', await p.evaluate(() => document.querySelectorAll('#commsBody button').length > 0));

  console.log('\n  [E — the evidence card is the server\'s answer]');
  ok('E1  smsStats was called exactly once, directly (it is not an adminOsDispatch op)', await p.evaluate(() => window.__C4.calls.filter((c) => c.op === 'smsStats').length === 1 && window.__C4.calls.find((c) => c.op === 'smsStats').name === 'smsStats'));
  ok('E2  state observed; sender shown and labelled a declaration', card.state === 'observed' && card.kv['Sender ID'] === 'SOKONI' && /declaration from the deploy configuration/.test(card.text), card.kv);
  ok('E3  figures are the server\'s values: pending 3, dead-letter 1, reports 42, rate 95.2%', card.kv['Queue pending'] === '3' && card.kv['Dead-letter'] === '1' && card.kv['Delivery reports received'] === '42' && card.kv['Delivery success rate'] === '95.2%', card.kv);
  ok('E4  a count AT the read bound says so (500 is not presented as a total)', /^500 \(at the read bound\)$/.test(card.kv['Sent (recent, bounded read)'] || ''), card.kv['Sent (recent, bounded read)']);
  ok('E5  failures by reason are listed from the server map', /Rejected × 1/.test(card.text) && /InsufficientBalance × 1/.test(card.text));
  await r.ctx.close();

  const r2 = await openPage(browser, { hash: '#comms/sms', mode: 'norate' });
  await waitEvidence(r2.page); card = await readCard(r2.page);
  ok('E6  a NULL success rate renders "—" with the reason, never 0%', card.kv['Delivery success rate'] === '—' && /No delivery report has been received/.test(card.text), card.kv['Delivery success rate']);
  ok('E6b a real server zero renders as 0 (a canonical zero is fine; only an unknown is not)', card.kv['Queue pending'] === '0' && card.kv['Delivery reports received'] === '0');
  await r2.ctx.close();

  console.log('\n  [U — unreadable is unreadable, not zero]');
  const r3 = await openPage(browser, { hash: '#comms/sms', mode: 'fail' });
  await waitEvidence(r3.page); card = await readCard(r3.page);
  ok('U1  a refused smsStats → state unreadable, the reason named, and NOT ONE figure on the card', card.state === 'unreadable' && /permission-denied/.test(card.text) && card.digits.length === 0 && Object.keys(card.kv).length === 0, { state: card.state, digits: card.digits });
  ok('U2  the broadcast form is unaffected by the evidence failure', await r3.page.evaluate(() => !!document.querySelector('#commsBody #smsBody')));
  await r3.ctx.close();

  console.log('\n  [X — static]');
  const aos = fs.readFileSync(path.join(ROOT, 'sokoni-aos.js'), 'utf8');
  const fn = aos.slice(aos.indexOf('async function _smsEvidence'), aos.indexOf('async function sendSMSBlast'));
  ok('X1  _smsEvidence reads one callable and writes nothing to Firestore', /_call\("smsStats"\)/.test(fn) && !/\.(add|set|update|delete)\(/.test(fn) && !/firestore\(\)/.test(fn));
  ok('X2  it never invents a figure: rendered numbers pass the server-value guard, and no literal "0" string is ever rendered', /typeof v === "number" && isFinite\(v\)/.test(fn) && !/"0"/.test(fn));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR — ' + (e && e.stack || e)); process.exit(2); });
