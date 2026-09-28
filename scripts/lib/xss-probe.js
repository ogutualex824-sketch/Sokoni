'use strict';
/* xss-probe.js — shared harness for stored-XSS render tests.
 *
 * A test extracts a page's REAL render function (extractFrom / lineOf), feeds it author-controlled data built from
 * HOSTILE values, and hands the produced HTML strings to probe(). probe() parses each string with a REAL browser
 * parser (Chromium, JavaScript DISABLED — nothing executes) and reports every place a payload reached an EXECUTABLE
 * context:
 *   - an on* event-handler attribute whose DECODED value calls the marker (entity-encoded quotes inside a JS string
 *     decode back to quotes — the browser, not a regex, decides);
 *   - a <script> element containing the marker;
 *   - a javascript: URL in href / src / action / formaction;
 *   - an element or attribute that exists only because a payload injected it (<img data-xss>, onmouseover=…).
 * The page's own legitimate handlers never contain the marker, so they never count.
 *
 * The marker is the global call `__xss(n)`; `n` identifies which field leaked.
 */
const fs = require('fs'), path = require('path'), cp = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
/* Hostile values. Every one carries the marker, so a leak is attributable to its field number. */
const H = (n) => `x" onmouseover="__xss(${n})" data-a="<img data-xss src=x onerror=__xss(${n})>');__xss(${n});//\\'`;
const HURL = (n) => `javascript:__xss(${n})`;

function reader(base, cpm) {
  return (f) => (cpm ? cp.execFileSync('git', ['show', base + ':' + f], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6 })
                     : fs.readFileSync(path.join(ROOT, f), 'utf8'));
}
/* Balanced-brace extraction of `head … { … }` (or `[ … ]`) from source. */
function extractFrom(src, head, optional) {
  const start = src.indexOf(head);
  if (start < 0) { if (optional) return ''; throw new Error('NOT FOUND: ' + head); }
  const open = src.indexOf(head.trim().endsWith('[') ? '[' : '{', start + head.length - 1);
  const oc = src[open], cc = oc === '[' ? ']' : '}';
  let depth = 0, q = null, esc = false, tmplDepth = [];
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (q === '`' && c === '$' && src[i + 1] === '{') { tmplDepth.push(depth); q = null; depth++; i++; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 1; continue; }
    if (c === '/') {   /* a regex literal (e.g. /'/g) must not open a "string": it follows an operator or opener */
      let k = i - 1; while (k > 0 && /\s/.test(src[k])) k--;
      if (/[(,=:[!&|?{};+\-*%<>~^]/.test(src[k]) || /\breturn$/.test(src.slice(Math.max(0, k - 6), k + 1))) {
        let cls = false;
        for (i++; i < src.length; i++) {
          if (src[i] === '\\') { i++; continue; }
          if (src[i] === '[') cls = true; else if (src[i] === ']') cls = false;
          else if (src[i] === '/' && !cls) break;
          else if (src[i] === '\n') break;
        }
        continue;
      }
    }
    /* `{`/`}` are always counted: a template `${ … }` hole closes on a `}` even when extracting a `[ … ]` literal. */
    if (c === oc || c === '{') { depth++; continue; }
    if (c === cc || c === '}') {
      depth--;
      if (tmplDepth.length && depth === tmplDepth[tmplDepth.length - 1]) { tmplDepth.pop(); q = '`'; continue; }
      if (depth === 0) return src.slice(start, i + 1) + (src[i + 1] === ';' ? ';' : '');
    }
  }
  throw new Error('UNBALANCED: ' + head);
}
/* The template literal that starts at the first backtick after `anchor` (with ${ } holes, nested templates). */
function tplAt(src, anchor) {
  const a = src.indexOf(anchor);
  if (a < 0) throw new Error('NOT FOUND: ' + anchor);
  /* search from the anchor's START: an anchor may contain the template's own opening backtick */
  const s = src.indexOf('`', a);
  const stack = ['`'];   // '`' = inside a template string, '{' = inside a ${ } hole
  let q = null;
  for (let i = s + 1; i < src.length; i++) {
    const c = src[i], top = stack[stack.length - 1];
    if (top === '`') {
      if (c === '\\') { i++; continue; }
      if (c === '$' && src[i + 1] === '{') { stack.push('{'); i++; continue; }
      if (c === '`') { stack.pop(); if (!stack.length) return src.slice(s, i + 1); }
      continue;
    }
    if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
    if (c === '/') {
      let k = i - 1; while (k > s && /\s/.test(src[k])) k--;
      if (/[(,=:[!&|?{};+\-*%<>~^]/.test(src[k])) {
        let cls = false;
        for (i++; i < src.length; i++) {
          if (src[i] === '\\') { i++; continue; }
          if (src[i] === '[') cls = true; else if (src[i] === ']') cls = false;
          else if ((src[i] === '/' && !cls) || src[i] === '\n') break;
        }
        continue;
      }
    }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '`') { stack.push('`'); continue; }
    if (c === '{') { stack.push('{'); continue; }
    if (c === '}') { stack.pop(); continue; }
  }
  throw new Error('UNBALANCED TEMPLATE after: ' + anchor);
}
/* An inert stand-in for any helper the test does not supply: callable, property-accessible, renders as ''. */
const STUB = new Proxy(function () {}, {
  apply: () => '', construct: () => ({}),
  get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'length' ? 0 : k === Symbol.iterator ? function* () {} : STUB),
});
/* Evaluate `code` (sloppy mode, `with` scope): names in `scope` win, then real globals, then STUB. */
function runWith(code, scope) {
  const env = new Proxy(scope, {
    has: (t, k) => typeof k === 'string' && k !== '__code',
    get: (t, k) => (k in t ? t[k] : k in globalThis ? globalThis[k] : k === Symbol.unscopables ? undefined : STUB),
    set: (t, k, v) => { t[k] = v; return true; },
  });
  return new Function('__env', 'with (__env) { return (' + code + '); }')(env);
}
const lineOf = (src, head) => { const s = src.indexOf(head); if (s < 0) throw new Error('NOT FOUND: ' + head); return src.slice(s, src.indexOf('\n', s)); };

/* Minimal element stub for getElementById-style renderers. */
function domStub() {
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, value: '', textContent: '', innerHTML: '', style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, getAttribute() { return null; }, addEventListener() {}, appendChild() {}, querySelector() { return null; }, querySelectorAll() { return []; } });
  return { els, el, document: { getElementById: el, querySelector: () => null, querySelectorAll: () => [], createElement: () => el('_new' + Math.random()), addEventListener() {}, body: el('body') } };
}

let _browser = null;
async function probe(htmlList) {
  const { chromium } = require('playwright');
  _browser = _browser || await chromium.launch();
  const ctx = await _browser.newContext({ javaScriptEnabled: false });
  const page = await ctx.newPage();
  const out = [];
  for (const html of htmlList) {
    await page.setContent('<!doctype html><body><div id="__r">' + html + '</div></body>');
    out.push(await page.evaluate(() => {
      const hits = [];
      const M = /__xss\((\d+)\)/;
      for (const e of document.querySelectorAll('#__r *')) {
        const tag = e.tagName.toLowerCase();
        if (tag === 'script' && M.test(e.textContent)) hits.push({ ctx: 'script', field: +e.textContent.match(M)[1] });
        if (e.hasAttribute('data-xss')) hits.push({ ctx: 'injected-element <' + tag + '>', field: 0 });
        for (const a of e.attributes) {
          const n = a.name.toLowerCase(), v = a.value;
          if (n.startsWith('on') && M.test(v)) hits.push({ ctx: 'handler ' + n + ' on <' + tag + '>', field: +v.match(M)[1] });
          if (['href', 'src', 'action', 'formaction', 'xlink:href'].includes(n) && /^\s*javascript:/i.test(v)) hits.push({ ctx: 'javascript: ' + n + ' on <' + tag + '>', field: +((v.match(M) || [0, 0])[1]) });
        }
      }
      return hits;
    }));
  }
  await ctx.close();
  return out;
}
async function close() { if (_browser) { await _browser.close(); _browser = null; } }

/* Result bookkeeping shared by the suites. */
function makeCk() {
  const st = { pass: 0, fail: 0 };
  const ck = (name, ok, detail) => {
    if (ok) { st.pass++; console.log('  PASS  ' + name); }
    else { st.fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '   ' + JSON.stringify(detail).slice(0, 400) : '')); }
  };
  return { st, ck };
}

module.exports = { ROOT, H, HURL, reader, extractFrom, tplAt, runWith, STUB, lineOf, domStub, probe, close, makeCk };
