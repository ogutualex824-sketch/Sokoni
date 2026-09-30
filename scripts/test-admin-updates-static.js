#!/usr/bin/env node
/* ============================================================================
   Updates centre — static + DOM-shim certification (node only, no browser)
   scripts/test-admin-updates-static.js

   What it proves without a browser:
     A. Both consoles carry the entry in their existing nav contract, a panel,
        the stylesheet and the module (loaded before the router), and route it
        (AdminOS loader + deep link; Super Admin SA.nav branch + #hash).
     B. The module has no second data path: no Firestore, no localStorage as a
        source, no innerHTML, every fetch cache-busted.
     C. Rendered through a minimal DOM shim with fixture version.json +
        release-log.json: every install metric renders the NEUTRAL state
        ("—" + "Not measured yet" + a reason) and never a number; the live facts
        come from version.json; the log renders newest first; "Live now" appears
        only for the entry that records a deployment of the live commit.
     D. NEGATIVE CONTROLS: a fabricated "0" injected into a metric is caught by
        the same predicate; a stale-proof claim (deployed, other commit) is not
        promoted to "Live now".
     E. CSS adds no palette: every hex is a var() fallback; phone 44px and
        reduced-motion rules exist.

   What it does NOT prove (queued browser cert: scripts/test-admin-updates-center.js):
   layout at 390/768/1280, overflow, keyboard focus order, real SW messaging.

   Run:  node scripts/test-admin-updates-static.js     Exit: 0 pass · 1 fail
   ========================================================================= */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n?/g, '\n');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
};

const aosHtml = read('admin-os.html');
const saHtml = read('super-admin.html');
const aosJs = read('sokoni-aos.js');
const modJs = read('sokoni-admin-updates.js');
const modCss = read('sokoni-admin-updates.css');
const count = (s, needle) => s.split(needle).length - 1;

/* ── A. wiring ─────────────────────────────────────────────────────────── */
console.log('\n[A — both consoles: entry, panel, assets, routing]');
const aosBtn = /<button class="nav-item" data-section="updates" data-label="Updates" onclick="SokoniAOS\.navigate\('updates'\);_closeSidebar\(\)"><span class="nav-icon">[^<]+<\/span><span class="nav-label">Updates<\/span><\/button>/;
ok('AdminOS sidebar: one Updates item in the nav contract (.nav-label, navigate, drawer close)', aosBtn.test(aosHtml) && count(aosHtml, 'data-section="updates"') === 1);
const navBlock = aosHtml.slice(aosHtml.indexOf('<nav class="aos-nav" id="aosNav"'), aosHtml.indexOf('</nav>', aosHtml.indexOf('id="aosNav"')));
ok('AdminOS: the item sits inside <nav id="aosNav"> (where aria-current is managed)', navBlock.includes('data-section="updates"'));
ok('AdminOS: #panel-updates exists, hidden by default, with #updatesBody', /<div class="aos-panel" id="panel-updates" hidden>\s*<div id="updatesBody">/.test(aosHtml));
ok('AdminOS: loader registered (updates: () => _loadUpdates())', /updates:\s*\(\) => _loadUpdates\(\)/.test(aosJs) && /function _loadUpdates\(\)/.test(aosJs));
ok('AdminOS: loader mounts the SHARED module into #updatesBody', /SokoniAdminUpdates\.mount\(body, \{ console: "aos" \}\)/.test(aosJs));
ok('AdminOS: deep link #updates is accepted by the router (its own route regex, a parent nav item with no data-tab)', (() => {
  const src = aosJs.slice(aosJs.indexOf('function _parseRoute(hash)'));
  const m = /const m = \/(.+?)\/\.exec\(/.exec(src);
  if (!m) return false;
  const re = new RegExp(m[1]);
  return re.test('updates') && !/data-section="updates" data-tab=/.test(aosHtml);
})());
ok('AdminOS: module script loaded once, BEFORE sokoni-aos.js', count(aosHtml, 'src="sokoni-admin-updates.js"') === 1 && aosHtml.indexOf('sokoni-admin-updates.js') < aosHtml.indexOf('src="sokoni-aos.js"'));
ok('AdminOS: stylesheet linked once', count(aosHtml, 'href="sokoni-admin-updates.css"') === 1);

const saBtn = /<button class="nav-item" data-section="updates" data-label="Updates" type="button" onclick="SA\.nav\('updates'\);_closeSidebar\(\)">\s*<span class="nav-icon">[^<]+<\/span><span class="nav-label">Updates<\/span>\s*<\/button>/;
ok('Super Admin sidebar: one Updates item in the nav contract (button, .nav-label, SA.nav, drawer close)', saBtn.test(saHtml) && count(saHtml, 'data-section="updates"') === 1);
const saNav = saHtml.slice(saHtml.indexOf('id="saNav"'), saHtml.indexOf('</nav>', saHtml.indexOf('id="saNav"')));
ok('Super Admin: the item sits inside <nav id="saNav">', saNav.includes('data-section="updates"'));
ok('Super Admin: #panel-updates is a hidden .sa-panel with #saUpdatesBody', /<section class="sa-panel" id="panel-updates" hidden>\s*<div id="saUpdatesBody">/.test(saHtml));
ok('Super Admin: SA.nav routes updates -> loadUpdates -> shared module', /else if\(section==='updates'\)this\.loadUpdates\(\);/.test(saHtml) && /SokoniAdminUpdates\.mount\(body,\{console:'sa'\}\)/.test(saHtml));
ok('Super Admin: #updates hash opens it, validated against a native sidebar button', /#saNav button\.nav-item\[data-section=/.test(saHtml) && /\/\^\[a-z\]\+\$\/\.test\(_h\)/.test(saHtml));
ok('Super Admin: module script + stylesheet included once each', count(saHtml, 'src="sokoni-admin-updates.js"') === 1 && count(saHtml, 'href="sokoni-admin-updates.css"') === 1);
ok('Super Admin: module loads before the inline SA script that calls it', saHtml.indexOf('src="sokoni-admin-updates.js"') < saHtml.indexOf('const SA={'));
ok('Super Admin keeps every native panel it had', ['overview', 'users', 'applications', 'financial', 'config', 'emergency', 'audit', 'broadcast', 'secrets'].every((s) => saHtml.includes(`data-section="${s}"`) && saHtml.includes(`id="panel-${s}"`)));

/* ── B. one data path ──────────────────────────────────────────────────── */
console.log('\n[B — the module has no second data path]');
const code = modJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
ok('no Firestore / Functions / firebase access', !/firestore|httpsCallable|firebase\./i.test(code));
ok('no localStorage / sessionStorage / indexedDB', !/localStorage|sessionStorage|indexedDB/.test(code));
ok('no innerHTML / insertAdjacentHTML / document.write (textContent only)', !/innerHTML|insertAdjacentHTML|document\.write/.test(code));
ok('every fetch goes through fetchJson (cache-busted, no-store)', count(code, 'fetch(') === 1 && /cb=' \+ Date\.now\(\)/.test(code) && /cache: 'no-store'/.test(code));
ok('reads /version.json and /release-log.json only', /fetchJson\('\/version\.json'\)/.test(code) && /fetchJson\('\/release-log\.json'\)/.test(code) && (code.match(/fetchJson\('/g) || []).length === 2);
ok('module parses', (() => { try { new vm.Script(modJs); return true; } catch (e) { return false; } })());

/* ── C. DOM shim render ────────────────────────────────────────────────── */
console.log('\n[C — render through a DOM shim with fixtures]');
function makeDom() {
  const byId = new Map();
  class Node {
    constructor(tag) { this.tagName = tag ? tag.toUpperCase() : '#text'; this.children = []; this.attrs = {}; this._text = ''; this.listeners = {}; this.parent = null; this.hidden = false; this.className = ''; }
    appendChild(c) { c.parent = this; this.children.push(c); if (c.attrs && c.attrs.id) byId.set(c.attrs.id, c); (c.children || []).forEach(function reg(k) { if (k.attrs && k.attrs.id) byId.set(k.attrs.id, k); (k.children || []).forEach(reg); }); return c; }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'hidden') this.hidden = true; if (k === 'id') byId.set(String(v), this); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
    get textContent() { return this.tagName === '#text' ? this._text : this._text + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this._text = String(v); this.children = []; }
    querySelector() { return null; }
    focus() {}
    scrollIntoView() {}
    all(pred, out = []) { if (pred(this)) out.push(this); this.children.forEach((c) => c.all && c.all(pred, out)); return out; }
  }
  const document = {
    createElement: (t) => new Node(t),
    createTextNode: (t) => { const n = new Node(null); n._text = String(t); return n; },
    getElementById: (id) => byId.get(id) || null,
  };
  return { document, Node };
}

const FIX_VERSION = { commit: 'abc1234def5678abc1234def5678abc1234def56', commitShort: 'abc1234', branch: 'hosting/fixture', buildTime: '2026-09-30T17:48:20.016Z', cacheVersion: 'sokoni-20260930174816-v649', environment: 'production', dirtyWorkingTree: false };
const FIX_LOG = {
  schema: 1, source: 'CHANGELOG.md', sourceSha256: 'f'.repeat(64), entryCount: 4,
  entries: [
    { id: 'a', date: '2026-10-01', title: 'Newest committed entry', type: 'feat', claim: 'not-deployed', commits: [], summary: 's', files: ['x.js'], filesMore: 0 },
    { id: 'b', date: '2026-09-30', title: 'DEPLOYED abc1234 → v649', type: 'deploy', claim: 'deployed', commits: ['abc1234'], summary: '', files: [], filesMore: 0 },
    { id: 'c', date: '2026-09-29', title: 'DEPLOYED 9999fff → v600 (an older release)', type: 'deploy', claim: 'deployed', commits: ['9999fff'], summary: '', files: [], filesMore: 0 },
    { id: 'd', date: '2026-09-01', title: 'Plain entry', type: 'other', claim: null, commits: [], summary: '', files: [], filesMore: 0 },
  ],
};

async function renderWith({ version, log, versionStatus = 200 }) {
  const { document, Node } = makeDom();
  const fetched = [];
  const win = {
    document,
    navigator: {},
    matchMedia: () => ({ matches: false }),
    fetch: async (url) => {
      fetched.push(url);
      const body = /version\.json/.test(url) ? version : /release-log\.json/.test(url) ? log : null;
      const status = /version\.json/.test(url) ? versionStatus : (body ? 200 : 404);
      return { ok: status === 200 && !!body, status, json: async () => JSON.parse(JSON.stringify(body)) };
    },
    WeakMap, Promise, Date, Math, JSON, String, Array, Object, parseInt, isNaN, setTimeout, clearTimeout,
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(modJs, win);
  const host = new Node('div');
  win.SokoniAdminUpdates.mount(host, { console: 'aos' });
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  return { host, fetched, api: win.SokoniAdminUpdates };
}

const cls = (n, c) => (' ' + (n.className || '') + ' ').includes(' ' + c + ' ');
/* The predicate the browser cert uses too: an install metric value must be the
   neutral dash, and no install-metric text may carry a digit. */
function metricViolations(host) {
  const metrics = host.all((n) => n.attrs && n.attrs['data-metric']);
  const bad = [];
  metrics.forEach((m) => {
    const val = m.all((n) => cls(n, 'sk-upd-metric-value'))[0];
    const state = m.all((n) => cls(n, 'sk-upd-metric-state'))[0];
    const why = m.all((n) => cls(n, 'sk-upd-metric-why'))[0];
    const v = val ? val.textContent.trim() : null;
    if (v !== '—') bad.push({ metric: m.attrs['data-metric'], value: v });
    if (/\d/.test(v || '')) bad.push({ metric: m.attrs['data-metric'], digit: v });
    if (!state || state.textContent !== 'Not measured yet') bad.push({ metric: m.attrs['data-metric'], state: state && state.textContent });
    if (!why || why.textContent.length < 20) bad.push({ metric: m.attrs['data-metric'], reason: 'missing' });
  });
  return { count: metrics.length, bad };
}

(async () => {
  const r = await renderWith({ version: FIX_VERSION, log: FIX_LOG });
  const text = r.host.textContent;
  const mv = metricViolations(r.host);
  ok(`every install metric (${mv.count}) renders "—" + "Not measured yet" + a reason, never a number`, mv.count >= 3 && mv.bad.length === 0, mv.bad);
  ok('every metric declares source:null (no canonical source exists)', r.api.INSTALL_METRICS.every((m) => m.source === null));
  ok('the section says plainly it is not measured, and why', /Not measured yet\. SOKONI does not record installs/.test(text));
  ok('fetches are cache-busted', r.fetched.length === 2 && r.fetched.every((u) => /\?cb=\d+$/.test(u)), r.fetched);
  const fact = (k) => { const n = r.host.all((x) => x.attrs && x.attrs['data-fact'] === k)[0]; return n ? n.textContent : null; };
  ok('Live now: commit from version.json', /abc1234/.test(fact('commit') || ''), fact('commit'));
  ok('Live now: branch from version.json', /hosting\/fixture/.test(fact('branch') || ''));
  ok('Live now: cache version from version.json', /v649/.test(fact('cacheVersion') || ''));
  ok('Live now: build time rendered (EAT)', /EAT/.test(fact('buildTime') || ''), fact('buildTime'));
  ok('This browser: no controller -> neutral "cannot be read", not "up to date"', /cannot be read/.test(fact('verdict') || '') && !/Up to date/.test(fact('verdict') || ''), fact('verdict'));
  const entries = r.host.all((n) => n.attrs && n.attrs['data-status'] && n.tagName === 'LI');
  const dates = entries.map((e) => e.attrs['data-date']);
  ok('release log renders newest first', JSON.stringify(dates) === JSON.stringify(['2026-10-01', '2026-09-30', '2026-09-29', '2026-09-01']), dates);
  const st = Object.fromEntries(entries.map((e) => [e.attrs['data-date'], e.attrs['data-status']]));
  ok('"Live now" ONLY for the entry that deployed the live commit', st['2026-09-30'] === 'live' && Object.values(st).filter((s) => s === 'live').length === 1, st);
  ok('NEGATIVE: an older DEPLOYED claim is the changelog’s claim, not "live"', st['2026-09-29'] === 'deployed', st);
  ok('an entry with no claim is "Committed"', st['2026-09-01'] === 'committed' && st['2026-10-01'] === 'not-deployed', st);

  /* NEGATIVE CONTROL: fabricate a count and prove the predicate catches it. */
  const firstVal = r.host.all((n) => cls(n, 'sk-upd-metric-value'))[0];
  firstVal.textContent = '0';
  const mv2 = metricViolations(r.host);
  ok('NEGATIVE: an injected "0" in an install metric is caught', mv2.bad.some((b) => b.value === '0'), mv2.bad);

  /* version.json unreadable -> neutral, and nothing is promoted to live */
  const r2 = await renderWith({ version: FIX_VERSION, log: FIX_LOG, versionStatus: 503 });
  const t2 = r2.host.textContent;
  ok('version.json unreadable -> explicit error, facts render "—"', /Could not read \/version\.json \(HTTP 503\)/.test(t2));
  const st2 = r2.host.all((n) => n.attrs && n.attrs['data-status'] && n.tagName === 'LI').map((e) => e.attrs['data-status']);
  ok('version.json unreadable -> no entry is claimed "Live now"', !st2.includes('live'), st2);
  const r3 = await renderWith({ version: FIX_VERSION, log: null });
  ok('release-log.json missing -> explicit error, no entries invented', /Could not read \/release-log\.json/.test(r3.host.textContent) && r3.host.all((n) => n.attrs && n.attrs['data-status'] && n.tagName === 'LI').length === 0);

  /* ── E. CSS ──────────────────────────────────────────────────────────── */
  console.log('\n[E — styles reuse the host tokens]');
  const cssNoComments = modCss.replace(/\/\*[\s\S]*?\*\//g, '');
  const hexes = cssNoComments.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  const fallbackHexes = cssNoComments.match(/var\(--[\w-]+,(?:var\(--[\w-]+,)?#[0-9a-fA-F]{3,8}\)/g) || [];
  ok(`no new palette: every hex (${hexes.length}) is a var() fallback`, hexes.length === fallbackHexes.length, { hexes: hexes.length, fallbacks: fallbackHexes.length });
  ok('host tokens: AdminOS --aos-* first, Super Admin tokens as fallback', /--upd-accent:var\(--aos-accent,var\(--accent/.test(cssNoComments));
  ok('phones: 44px targets', /@media \(max-width:768px\)[\s\S]*min-height:44px/.test(cssNoComments));
  ok('reduced motion honoured', /prefers-reduced-motion:reduce/.test(cssNoComments));
  ok('every rule is scoped under .sk-upd (no global selector leaks)', cssNoComments.replace(/@media[^{]+\{/g, '').split('}').map((b) => b.split('{')[0].trim()).filter(Boolean).every((sel) => sel.split(',').every((s) => s.trim().startsWith('.sk-upd'))));

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
