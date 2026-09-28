#!/usr/bin/env node
/* test-xss-probe-selftest.js — the stored-XSS probe must itself be proven before any suite relies on it.
 *
 * P1  raw text interpolation is flagged (positive control)
 * P2  raw attribute interpolation is flagged (positive control)
 * P3  an HTML-escaped value inside an inline JS string IS STILL flagged — entities decode back to quotes
 * P4  a javascript: href is flagged
 * P5  escaped text + escaped data-attribute + dataset handler is NOT flagged (negative control)
 * P6  the page's own legitimate handler (no marker) is NOT flagged
 * P7  extractFrom survives regex literals containing quotes and template holes containing braces
 */
'use strict';
const X = require('./lib/xss-probe');
const { ck, st } = X.makeCk();
const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
(async () => {
  const v = X.H(7);
  const [p1, p2, p3, p4, p5, p6] = await X.probe([
    `<div>${v}</div>`,
    `<div title="${v}">t</div>`,
    `<button onclick="go('${esc(v)}')">b</button>`,
    `<a href="${esc(X.HURL(8))}">l</a>`,
    `<div>${esc(v)}</div><button data-id="${esc(v)}" onclick="go(this.dataset.id)">b</button>`,
    `<button onclick="alert('Coming soon')">b</button>`,
  ]);
  ck('P1  raw text interpolation is flagged', p1.length > 0, p1);
  ck('P2  raw attribute interpolation is flagged', p2.some((h) => /handler/.test(h.ctx)), p2);
  ck('P3  escaped value inside an inline JS string is STILL flagged', p3.some((h) => /handler onclick/.test(h.ctx) && h.field === 7), p3);
  ck('P4  javascript: href is flagged', p4.some((h) => /javascript: href/.test(h.ctx)), p4);
  ck('P5  escaped text + data attribute + dataset handler is clean', p5.length === 0, p5);
  ck('P6  a legitimate handler without the marker is clean', p6.length === 0, p6);
  const src = "function f(a){ const r = a.replace(/'/g,\"&#39;\"); return `<b>${ {x:1}.x }</b>` + r; }\nfunction g(){ return 2; }";
  let ex = ''; try { ex = X.extractFrom(src, 'function f(a){'); } catch (e) { ex = 'ERR ' + e.message; }
  ck('P7  extractFrom handles regex literals with quotes and template holes with braces', ex.endsWith('+ r; }') && !ex.includes('function g'), ex);
  await X.close();
  console.log(`\n${st.pass} passed, ${st.fail} failed`);
  process.exit(st.fail ? 1 : 0);
})().catch(async (e) => { await X.close(); console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
