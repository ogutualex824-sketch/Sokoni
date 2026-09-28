/* test-mechanics-directory.js — the mechanics directory shows real listings only, invents no reputation, and never
 * injects author-controlled fields as markup (step 4 of the C4 remediation: mechanics data integrity).
 *
 * Executes the REAL render/filter functions, extracted verbatim from mechanics.html and car-hub.html, against a DOM
 * stub, and inspects the HTML they produce. No browser, no network, no production.
 *
 *   node scripts/test-mechanics-directory.js                 # the fix — must PASS
 *   COUNTERPROOF=1 node scripts/test-mechanics-directory.js  # PRODUCTION hosting be7c676 — failures ARE the defects
 *
 * PROVES (mechanics.html = M*, car-hub.html = C*)
 *   M1  with demo data ENABLED and no real listings, the directory lists NOTHING (no invented garages)
 *   M2  a listing with no rating shows "No reviews yet" — no stars, no "5.0", no "1 yrs exp", no job count
 *   M3  an author-written rating/jobs is NOT shown (no server-derived reputation exists for mechanics)
 *   M4  author-controlled fields are escaped: no live <img onerror>, and the id never lands in inline JavaScript
 *   M5  a malformed listing (no name, services not an array) does not break the search filter
 *   M6  the header counts are exact (no "+")
 *   M7  declared years of experience still show as the business's own statement (control)
 *   C1  car-hub: no rating / job count on the card; a local registration carries no invented rating or years
 *   C2  car-hub: author-controlled fields escaped on the card, and in the booking modal
 */
'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const BASE = 'be7c676';
const CPM = !!process.env.COUNTERPROOF;
const read = (f) => (CPM ? cp.execFileSync('git', ['show', BASE + ':' + f], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6 }) : fs.readFileSync(path.join(ROOT, f), 'utf8'));
function extractFrom(src, head, optional) {
  const start = src.indexOf(head);
  if (start < 0) { if (optional) return ''; throw new Error('NOT FOUND: ' + head); }
  const open = src.indexOf(head.trim().endsWith('[') ? '[' : '{', start + head.length - 1);
  const oc = src[open], cc = oc === '[' ? ']' : '}';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === oc) depth++;
    else if (src[i] === cc) { depth--; if (depth === 0) return src.slice(start, i + 1) + (src[i + 1] === ';' ? ';' : ''); }
  }
  throw new Error('UNBALANCED: ' + head);
}
const lineOf = (src, head) => { const s = src.indexOf(head); return s < 0 ? '' : src.slice(s, src.indexOf('\n', s)); };

const XSS = { id: "x');alert(1);//", name: '<img src=x onerror=alert(1)>', area: '<svg onload=alert(2)>', bio: '<script>alert(3)</script>',
  services: ['<b onmouseover=alert(4)>svc</b>'], features: ['<i onclick=alert(5)>f</i>'], emoji: '<img src=y onerror=alert(6)>', location: 'nairobi', type: 'garage', phone: '0712"><x' };
const PLAIN = { id: 'MCH1', name: 'Otieno Garage', area: 'Kisumu', location: 'kisumu', type: 'garage', phone: '0712000000', services: ['Brakes'], features: [] };
/* the INJECTED payloads, unescaped — never "any tag": the page's own static markup (e.g. <i class="fab …">) is legit */
const liveMarkup = (h) => /<img src=x onerror|<svg onload|<script>alert|<b onmouseover|<i onclick|<img src=y onerror|0712"><x/.test(h);

/* ── mechanics.html ─────────────────────────────────────────────────────── */
function mechPage({ fsDocs = [], demo = false }) {
  const html = read('mechanics.html');
  const parts = [
    lineOf(html, 'var _demoAllowed='),
    extractFrom(html, 'const DEMO_MECHS = [', true),
    lineOf(html, 'const FEAT_LBL'), lineOf(html, 'const TYPE_LBL'),
    extractFrom(html, 'function safeHtml(str) {'),
    lineOf(html, 'function _mEsc(v)'),
    'let _all=[], _filtered=[], _activeCat="all"; let _fsCache=null;',
    extractFrom(html, 'async function loadMechs(){'),
    extractFrom(html, 'function applyFilters(){'),
    extractFrom(html, 'function renderGrid(){'),
  ];
  const els = {}; const el = (id) => (els[id] = els[id] || { value: '', textContent: '', innerHTML: '', style: {} });
  const ls = demo ? { sokoniDemoData: 'true' } : {};
  const localStorage = { getItem: (k) => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); } };
  const api = new Function('document', 'localStorage', 'location', '_loadFs', 'window',
    parts.join('\n') + '\nreturn { loadMechs, applyFilters, renderGrid, setAll: (a)=>{ _all=a; _filtered=a; }, get all(){ return _all; } };')(
    { getElementById: el, querySelector: () => null }, localStorage, { hostname: 'mysokoni.co.ke' }, async () => fsDocs, {});
  return { api, els };
}
async function mechRender(docs, opts = {}) {
  const p = mechPage({ fsDocs: docs, demo: opts.demo });
  await p.api.loadMechs();
  return { html: p.els.mechGrid ? p.els.mechGrid.innerHTML : '', all: p.api.all, els: p.els, api: p.api };
}

/* ── car-hub.html ───────────────────────────────────────────────────────── */
function carPage(fsDocs, localRegs = {}) {
  const html = read('car-hub.html');
  const parts = [
    lineOf(html, '  var FEAT_LBL = {'), "var _mechSpecFilter='all', _mechFsCache=null, _mechFsState='ready';",
    extractFrom(html, 'function _stars(r){'),
    extractFrom(html, 'function _mechSource(){'),
    extractFrom(html, 'function _mechStr(v){'),
    extractFrom(html, 'function _mechEsc(v){', true),
    extractFrom(html, 'function _mechArr(v){'),
    extractFrom(html, 'function renderMechanicsGrid(){'),
    extractFrom(html, 'function openMechBooking(mechId){'),
  ];
  const els = {}; const el = (id) => (els[id] = els[id] || { value: '', checked: false, textContent: '', innerHTML: '', style: {} });
  const store = Object.assign({}, localRegs);
  const localStorage = { getItem: (k) => (k in store ? store[k] : null) };
  const modal = {};
  const src = parts.join('\n').replace("var _mechSpecFilter='all', _mechFsCache=null, _mechFsState='ready';", "var _mechSpecFilter='all', _mechFsCache=__docs, _mechFsState='ready';");
  const objKeys = (o) => Object.keys(o);
  const api = new Function('document', 'localStorage', 'Object', '__docs', 'openChpModal', 'showFleetMsg', '_loadMechanicsFs',
    src + '\nreturn { renderMechanicsGrid, openMechBooking, _mechSource };')(
    { getElementById: el, querySelectorAll: () => [] }, localStorage, Object.assign(Object.create(Object), Object, { keys: (o) => (o === localStorage ? objKeys(store) : objKeys(o)) }),
    fsDocs, (t, c) => { modal.title = t; modal.content = c; }, () => {}, async () => fsDocs);
  return { api, els, modal };
}

(async () => {
  let pass = 0, fail = 0;
  const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + JSON.stringify(d).slice(0, 170) + ']' : '')); ok ? pass++ : fail++; };
  console.log('\nSOURCE: ' + (CPM ? 'PRODUCTION hosting ' + BASE + ' — failures below ARE the defects' : 'fix (working tree)'));

  const m1 = await mechRender([], { demo: true });
  ck('M1  demo ENABLED + no real listings → nothing listed (no invented garages)', m1.all.length === 0, { listed: m1.all.length, names: m1.all.slice(0, 2).map((x) => x.name) });
  const m2 = await mechRender([PLAIN]);
  ck('M2  no rating → "No reviews yet"; no stars / "5.0" / "1 yrs exp" / job count', /No reviews yet/.test(m2.html) && !/★/.test(m2.html) && !/5\.0/.test(m2.html) && !/yrs exp/.test(m2.html) && !/\bjobs\b/.test(m2.html),
    { stars: /★/.test(m2.html), five: /5\.0/.test(m2.html), yrs: /yrs exp/.test(m2.html) });
  const m3 = await mechRender([Object.assign({}, PLAIN, { rating: 5, jobs: 999 })]);
  ck('M3  author-written rating / jobs are not shown', !/999/.test(m3.html) && !/★/.test(m3.html), { jobs999: /999/.test(m3.html), stars: /★/.test(m3.html) });
  const m4 = await mechRender([XSS]);
  const inlineId = /openBookMech\('x'\);alert/.test(m4.html) || /x'\);alert\(1\)/.test(m4.html);
  ck('M4  author fields escaped; the id never lands in inline JavaScript', !liveMarkup(m4.html) && !inlineId, { live: liveMarkup(m4.html), inlineId });
  let m5err = null;
  try { const p = mechPage({}); p.api.setAll([{ id: 'B1', services: 'not-an-array' }, PLAIN]); p.els.srchMech = { value: 'otieno' }; p.api.applyFilters(); } catch (e) { m5err = e.message; }
  ck('M5  a malformed listing does not break the search filter', m5err === null, m5err);
  const m6 = await mechRender([Object.assign({}, PLAIN, { verified: true }), Object.assign({}, PLAIN, { id: 'MCH2' })]);
  ck('M6  header counts are exact (no "+")', m6.els.statMechs.textContent === '1' && m6.els.statGarages.textContent === '2', { mechs: m6.els.statMechs.textContent, garages: m6.els.statGarages.textContent });
  const m7 = await mechRender([Object.assign({}, PLAIN, { years: 7 })]);
  ck('M7  declared years of experience still shown (control)', /7 yrs exp/.test(m7.html));

  const c = carPage([Object.assign({}, PLAIN, { rating: 5, jobs: 999 })], { sokoniMechReg_1: JSON.stringify({ name: 'Local Garage', phone: '0711000000', location: 'nairobi' }) });
  c.api.renderMechanicsGrid();
  const cardHtml = c.els.mechGrid.innerHTML;
  const local = c.api._mechSource().find((x) => x.id === 'sokoniMechReg_1');
  ck('C1  car-hub: no rating / job count on the card; local registration has no invented rating or years',
    !/999/.test(cardHtml) && !/★/.test(cardHtml) && !/5\.0/.test(cardHtml) && !!local && !('rating' in local) && !('years' in local) && !('jobs' in local),
    { jobs999: /999/.test(cardHtml), stars: /★/.test(cardHtml), local: local && { rating: local.rating, years: local.years } });
  const cx = carPage([XSS]);
  cx.api.renderMechanicsGrid();
  let modalErr = null; try { cx.api.openMechBooking(XSS.id); } catch (e) { modalErr = e.message; }
  const cInline = /openMechBooking\(\\?'x'\);alert/.test(cx.els.mechGrid.innerHTML);
  ck('C2  car-hub: card + booking modal escape author fields; no id in inline JavaScript',
    !liveMarkup(cx.els.mechGrid.innerHTML) && !cInline && modalErr === null && !liveMarkup(cx.modal.content || ''),
    { card: liveMarkup(cx.els.mechGrid.innerHTML), inline: cInline, modal: liveMarkup(cx.modal.content || ''), modalErr });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (CPM) console.log('(counter-proof: failures here ARE the defects this slice removes; M5 and M7 are controls where production also passes or throws)');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
