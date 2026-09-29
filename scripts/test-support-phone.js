#!/usr/bin/env node
/* ================================================================
   SOKONI — the support number has ONE source (Slice C5)
   scripts/test-support-phone.js

   WHAT IT HOLDS
     A  client and server agree: sokoni-company.js supportPhone equals
        functions/company-identity.js supportPhone (parity, not a fixture)
     B  support.html's Call Support card, WhatsApp card (prefilled text) and
        ticket follow-up, plus contact.html's WhatsApp tiles, Alternative line and
        footer icon, render the configured number as href AND text — in a real
        browser, with every external origin aborted
     C  FAIL CLOSED: served with supportPhone removed, the same controls lose
        their href, say "not configured", and no digit appears anywhere in them
        (the negative control that proves nothing is invented)
     D  no page in scope types the number — markup, script or comment (D3: the
        dynamic ticket follow-up too); other pages' placeholder-looking numbers
        are REPORTED, not asserted — they are outside the support-number scope
   Exit: 0 all passed · 1 a test failed · 2 the harness could not run
   ================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const HOST = 'sokoni-cert.test';
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '  -> ' + (typeof d === 'string' ? d : JSON.stringify(d)) : '')); } };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const companySrc = fs.readFileSync(path.join(ROOT, 'sokoni-company.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(ROOT, 'functions', 'company-identity.js'), 'utf8');
const clientPhone = (companySrc.match(/supportPhone:\s*'([^']+)'/) || [])[1];
const serverPhone = (serverSrc.match(/supportPhone:\s*'([^']+)'/) || [])[1];

async function render(browser, page, override) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true });
  await ctx.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== HOST) return route.abort();
    if (override && url.pathname === '/sokoni-company.js') return route.fulfill({ status: 200, contentType: MIME['.js'], body: override });
    const file = path.join(ROOT, decodeURIComponent(url.pathname).replace(/^\/+/, ''));
    if (!file.startsWith(ROOT)) return route.fulfill({ status: 403, body: '' });
    let buf; try { buf = fs.readFileSync(file); } catch (_) { return route.fulfill({ status: 404, body: '404' }); }
    return route.fulfill({ status: 200, contentType: MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', body: buf });
  });
  const p = await ctx.newPage();
  await p.goto('https://' + HOST + '/' + page, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await p.waitForTimeout(600);
  const out = await p.evaluate(() => [...document.querySelectorAll('[data-support-phone]')].map((el) => ({
    kind: el.getAttribute('data-support-phone'), href: el.getAttribute('href'), state: el.getAttribute('data-support-phone-state'),
    param: el.getAttribute('data-support-phone-text-param'), hasText: !!el.querySelector('[data-support-phone-text]'),
    text: (el.querySelector('[data-support-phone-text]') || {}).textContent || '', digitsInControl: /\d{6,}/.test(el.textContent) })));
  await ctx.close();
  return out;
}

(async () => {
  console.log('SUPPORT NUMBER — ONE SOURCE, FAIL CLOSED\n');
  console.log('  [A — parity]');
  ok('A1  sokoni-company.js and functions/company-identity.js carry the same supportPhone', !!clientPhone && clientPhone === serverPhone, { clientPhone, serverPhone });
  const sandbox = { window: {}, document: undefined }; vm.runInNewContext(companySrc, sandbox);
  const C = sandbox.window.SOKONI_COMPANY;
  const digits = clientPhone ? clientPhone.replace(/[^\d+]/g, '') : '';
  const wa = 'https://wa.me/' + digits.replace(/^\+/, '');
  ok('A2  the helper derives tel: and WhatsApp hrefs from that one value', C && C.supportPhoneHref('tel') === 'tel:' + digits && C.supportPhoneHref('wa') === wa, { tel: C && C.supportPhoneHref('tel'), wa: C && C.supportPhoneHref('wa') });

  console.log('\n  [B — the pages render the configured number]');
  const configured = (x) => x.state === 'configured'
    && (x.kind === 'tel' ? x.href === 'tel:' + digits : x.href === wa + (x.param ? '?text=' + encodeURIComponent(x.param) : ''))
    && (!x.hasText || x.text === clientPhone);
  const browser = await chromium.launch();
  const sup = await render(browser, 'support.html');
  ok('B1  support.html: Call Support (tel), WhatsApp card (wa + prefilled text) and ticket follow-up (wa) all resolve to the configured number',
     sup.length === 3 && sup.filter((x) => x.kind === 'tel').length === 1 && sup.filter((x) => x.param).length === 1 && sup.every(configured), sup);
  const con = await render(browser, 'contact.html');
  ok('B2  contact.html: two WhatsApp tiles, the Alternative line and the footer WhatsApp icon all resolve to the configured number, tiles showing it',
     con.length === 4 && con.filter((x) => x.kind === 'tel').length === 1 && con.filter((x) => x.hasText).length === 3 && con.every(configured), con);

  console.log('\n  [C — fail closed when nothing is configured]');
  const cut = companySrc.replace(/supportPhone:\s*'[^']+',/, "supportPhone: '',");
  if (cut === companySrc) { console.error('PROBE INVALID — supportPhone literal not found for the negative control'); await browser.close(); process.exit(2); }
  const closed = (x) => !x.href && x.state === 'unconfigured' && (!x.hasText || /not configured/.test(x.text)) && !x.digitsInControl;
  const supN = await render(browser, 'support.html', cut);
  const conN = await render(browser, 'contact.html', cut);
  ok('C1  support.html: all three controls lose their href, say "not configured", not a single digit invented', supN.length === 3 && supN.every(closed), supN);
  ok('C2  contact.html: all four controls fail closed the same way', conN.length === 4 && conN.every(closed), conN);
  await browser.close();

  console.log('\n  [D — no literal anywhere in scope; placeholders elsewhere reported]');
  const supHtml = fs.readFileSync(path.join(ROOT, 'support.html'), 'utf8');
  const conHtml = fs.readFileSync(path.join(ROOT, 'contact.html'), 'utf8');
  ok('D1  the fabricated placeholder number is gone from support.html', !/700\s?000\s?000/.test(supHtml));
  ok('D2  neither page carries the support number as a literal any more (markup, script or comment)', !/705\s?726\s?803/.test(supHtml) && !/705\s?726\s?803/.test(conHtml));
  ok('D3  the ticket-lookup follow-up link is built from SOKONI_COMPANY.supportPhoneHref and omits the link when null',
     /function followUpLink[\s\S]*supportPhoneHref\('wa'\)[\s\S]*if \(!href\) return '[^']*Contact tab/.test(supHtml));
  const others = [];
  for (const f of fs.readdirSync(ROOT).filter((x) => x.endsWith('.html'))) {
    const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of s.matchAll(/tel:([+0-9() -]{6,})/g)) { const d = m[1].replace(/[() -]/g, ''); if (d && d !== digits) others.push(f + ' ' + d); }
  }
  console.log('      REPORTED (outside the support-number scope, not asserted): ' + (others.length ? [...new Set(others)].join(' · ') : 'none'));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR — ' + e.message); process.exit(2); });
