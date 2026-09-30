#!/usr/bin/env node
/* test-legal-commission-link.js — the legal hub's "pay my commission via WhatsApp" hand-off is gone;
   the control raises a SOKONI Support ticket carrying the reference. Static + Chromium (hermetic). */
'use strict';
const fs = require('fs'), path = require('path'), http = require('http');
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0; const ck = (l, ok, got) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok ? '' : '   [got ' + JSON.stringify(got) + ']')); ok ? pass++ : fail++; };
(async () => {
  const s = fs.readFileSync(path.join(ROOT, 'legal-hub.html'), 'utf8');
  ck('L1  no WhatsApp "pay my commission" link', !/pay%20my%20SOKONI%20commission/.test(s), null);
  ck('L2  a Support control with topic=payment stands in its place', /support\.html\?topic=payment&ref=/.test(s) && /Settle via SOKONI Support/.test(s), null);
  const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));
  const srv = http.createServer((rq, rs) => { const u = decodeURIComponent(rq.url.split('?')[0]); let fp = path.join(ROOT, u === '/' ? 'index.html' : u); if (!fs.existsSync(fp) && fs.existsSync(fp + '.html')) fp += '.html'; if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { rs.writeHead(404); rs.end(); return; } rs.writeHead(200, { 'Content-Type': fp.endsWith('.html') ? 'text/html' : fp.endsWith('.js') ? 'application/javascript' : fp.endsWith('.css') ? 'text/css' : 'application/octet-stream' }); fs.createReadStream(fp).pipe(rs); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const base = 'http://127.0.0.1:' + srv.address().port;
  const b = await chromium.launch(); const p = await b.newPage();
  await p.route('**/*', (route) => route.request().url().startsWith(base) ? route.continue() : route.abort());
  await p.goto(base + '/legal-hub.html', { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(2500);
  await p.evaluate(() => { const f = document.getElementById('caseTotalFee'); const r = document.getElementById('caseRef'); if (r) r.value = 'LGL42'; if (f) { f.value = '50000'; f.dispatchEvent(new Event('input')); } });
  const href = await p.evaluate(() => { const a = Array.from(document.querySelectorAll('a')).find((x) => /Settle via SOKONI Support/.test(x.textContent)); let to = null; const orig = location.href; const proto = Object.getOwnPropertyDescriptor(window, 'location'); a.onclick = new Function('event', a.getAttribute('onclick').replace(/location\.href=/g, 'window.__to=')); a.click(); return window.__to || null; });
  ck('L3  clicking it routes to support.html?topic=payment with the SOK reference and the amounts prefilled', !!href && /support\.html\?topic=payment&ref=SOK-LGL42/.test(href) && /Owed/.test(decodeURIComponent(href)) && /2%2C500|2,500/.test(href), href);
  await b.close(); srv.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
