#!/usr/bin/env node
/* ============================================================================
   Updates centre — static + DOM-shim certification (node only, no browser)
   scripts/test-admin-updates-static.js

   What it proves without a browser:
     A. Both consoles carry the entry in their existing nav contract, a panel,
        the stylesheet and the module (loaded before the router), and route it
        (AdminOS loader + deep link; Super Admin SA.nav branch + #hash).
     B. The module has no second data path: no Firestore, no localStorage as a
        source, no innerHTML; /version.json is the only fetch; the release log
        and the install counts come ONLY from two admin callables
        (adminReleaseLog, adminGetAppInstallStats) through the console's own
        transport; no public release-log.json exists or is referenced (owner
        decision A).
     C. Rendered through a minimal DOM shim with a fixture version.json and
        STUBBED callables: not-computed-yet / not deployed / refused -> every
        metric "—" + "Not measured yet" + a reason; the log shows "not available
        yet", never an empty list; a computed aggregate renders its figures with
        "since" and "computed" (a canonical 0 is a 0; a null is "—"); paging
        follows the server cursor; "Live now" only for the entry that records a
        deployment of the live commit.
     D. NEGATIVE CONTROLS: a fabricated "0" injected into an unmeasured metric
        is caught by the same predicate; a stale-proof claim (deployed, other
        commit) is not promoted to "Live now".
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
ok('AdminOS: loader mounts the SHARED module into #updatesBody', /SokoniAdminUpdates\.mount\(body, \{ console: "aos",/.test(aosJs));
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
ok('Super Admin: SA.nav routes updates -> loadUpdates -> shared module', /else if\(section==='updates'\)this\.loadUpdates\(\);/.test(saHtml) && /SokoniAdminUpdates\.mount\(body,\{console:'sa',/.test(saHtml));
ok('Super Admin: #updates hash opens it, validated against a native sidebar button', /#saNav button\.nav-item\[data-section=/.test(saHtml) && /\/\^\[a-z\]\+\$\/\.test\(_h\)/.test(saHtml));
ok('Super Admin: module script + stylesheet included once each', count(saHtml, 'src="sokoni-admin-updates.js"') === 1 && count(saHtml, 'href="sokoni-admin-updates.css"') === 1);
ok('Super Admin: module loads before the inline SA script that calls it', saHtml.indexOf('src="sokoni-admin-updates.js"') < saHtml.indexOf('const SA={'));
ok('Super Admin keeps every native panel it had', ['overview', 'users', 'applications', 'financial', 'config', 'emergency', 'audit', 'broadcast', 'secrets'].every((s) => saHtml.includes(`data-section="${s}"`) && saHtml.includes(`id="panel-${s}"`)));

/* ── B. one data path ──────────────────────────────────────────────────── */
console.log('\n[B — the module has no second data path; the log is admin-only]');
const code = modJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
ok('no Firestore access', !/firestore/i.test(code));
ok('the only firebase reference is the fallback callable transport (firebase.functions().httpsCallable)', (code.match(/firebase\./g) || []).length === 2 && /window\.firebase\.functions\(\)\.httpsCallable\(name\)/.test(code));
ok('no localStorage / sessionStorage / indexedDB', !/localStorage|sessionStorage|indexedDB/.test(code));
ok('no innerHTML / insertAdjacentHTML / document.write (textContent only)', !/innerHTML|insertAdjacentHTML|document\.write/.test(code));
ok('every fetch goes through fetchJson (cache-busted, no-store)', count(code, 'fetch(') === 1 && /cb=' \+ Date\.now\(\)/.test(code) && /cache: 'no-store'/.test(code));
ok('fetches /version.json ONLY — no /release-log.json anywhere in the module', /fetchJson\('\/version\.json'\)/.test(code) && (code.match(/fetchJson\('/g) || []).length === 1 && !/release-log\.json/.test(code));
ok('reads the log and the counts through exactly two admin callables', /self\.call\('adminReleaseLog', q\)/.test(code) && /self\.call\('adminGetAppInstallStats', \{\}\)/.test(code) && (code.match(/self\.call\('/g) || []).length === 2);
ok('decision A: NO release-log.json at the hosting root', !fs.existsSync(path.join(ROOT, 'release-log.json')));
ok('decision A: nothing references a public /release-log.json (both consoles + module)', ![aosHtml, saHtml, aosJs, modJs].some((s) => /['"(]\/?release-log\.json/.test(s)));
ok('AdminOS hands the module its canonical _call transport', /SokoniAdminUpdates\.mount\(body, \{ console: "aos", call: \(name, data\) => _call\(name, data\) \}\)/.test(aosJs));
ok('Super Admin hands the module its own functions instance', /SokoniAdminUpdates\.mount\(body,\{console:'sa',call:\(name,data\)=>fns\.httpsCallable\(name\)\(data\|\|\{\}\)\.then\(r=>r&&r\.data\)\}\)/.test(saHtml));
ok('module parses', (() => { try { new vm.Script(modJs); return true; } catch (e) { return false; } })());

/* ── C. DOM shim render ────────────────────────────────────────────────── */
console.log('\n[C — render through a DOM shim with stubbed callables]');
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
const STATS_COMPUTED = { state: 'computed', computedAt: '2026-10-01T06:00:00.000Z', since: '2026-10-01T03:12:00.000Z', devices: 12, total: 0, standalone: 4, active7: 9, active30: 12, onLive: null, behind: null, liveCacheVersion: null, liveError: 'version.json HTTP 503' };
const NOT_FOUND = { code: 'functions/not-found', message: 'NOT_FOUND' };

/* A stub of the adminReleaseLog contract: server-side filter + opaque cursor. */
function logServer(log) {
  return (q) => {
    const st = (e) => (q.liveCommit && e.claim === 'deployed' && e.commits.some((c) => q.liveCommit.indexOf(c) === 0) ? 'live' : e.claim === 'deployed' ? 'deployed' : e.claim === 'not-deployed' ? 'not-deployed' : 'committed');
    const hits = log.entries.filter((e) => (q.type === 'all' || e.type === q.type) && (q.status === 'all' || st(e) === q.status) && (!q.q || e.title.toLowerCase().includes(q.q)));
    const off = q.cursor ? parseInt(q.cursor.slice(2), 10) : 0;
    const page = hits.slice(off, off + q.limit);
    return { schema: 1, source: log.source, sourceSha256: log.sourceSha256, entryCount: log.entries.length, total: hits.length, entries: page, nextCursor: off + page.length < hits.length ? 'o:' + (off + page.length) : null };
  };
}

async function renderWith({ version, log, stats, logErr, statsErr, versionStatus = 200 }) {
  const { document, Node } = makeDom();
  const fetched = [];
  const calls = [];
  const win = {
    document,
    navigator: {},
    matchMedia: () => ({ matches: false }),
    fetch: async (url) => {
      fetched.push(url);
      const body = /version\.json/.test(url) ? version : null;
      const status = /version\.json/.test(url) ? versionStatus : 404;
      return { ok: status === 200 && !!body, status, json: async () => JSON.parse(JSON.stringify(body)) };
    },
    WeakMap, Promise, Date, Math, JSON, String, Array, Object, Number, parseInt, isNaN, isFinite, setTimeout, clearTimeout,
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(modJs, win);
  const host = new Node('div');
  const call = async (name, data) => {
    calls.push({ name, data: JSON.parse(JSON.stringify(data)) });
    await new Promise((r) => setImmediate(r));
    if (name === 'adminReleaseLog') { if (logErr) throw logErr; return logServer(log)(data); }
    if (name === 'adminGetAppInstallStats') { if (statsErr) throw statsErr; return stats; }
    throw { code: 'functions/not-found' };
  };
  win.SokoniAdminUpdates.mount(host, { console: 'aos', call });
  const tick = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
  await tick();
  return { host, fetched, calls, api: win.SokoniAdminUpdates, tick };
}

const cls = (n, c) => (' ' + (n.className || '') + ' ').includes(' ' + c + ' ');
const metricsOf = (host) => host.all((n) => n.attrs && n.attrs['data-metric']).map((m) => ({
  key: m.attrs['data-metric'],
  measured: m.attrs['data-measured'],
  value: (m.all((n) => cls(n, 'sk-upd-metric-value'))[0] || { textContent: null }).textContent.trim(),
  state: (m.all((n) => cls(n, 'sk-upd-metric-state'))[0] || { textContent: null }).textContent,
  why: (m.all((n) => cls(n, 'sk-upd-metric-why'))[0] || { textContent: '' }).textContent,
}));
/* The predicate the browser cert uses too: an UNMEASURED metric must be the
   neutral dash, carry no digit, say "Not measured yet" and give a reason. */
function metricViolations(host) {
  const ms = metricsOf(host);
  const bad = [];
  ms.filter((m) => m.measured !== 'true').forEach((m) => {
    if (m.value !== '—') bad.push({ metric: m.key, value: m.value });
    if (/\d/.test(m.value || '')) bad.push({ metric: m.key, digit: m.value });
    if (m.state !== 'Not measured yet') bad.push({ metric: m.key, state: m.state });
    if (!m.why || m.why.length < 20) bad.push({ metric: m.key, reason: 'missing' });
  });
  return { count: ms.length, unmeasured: ms.filter((m) => m.measured !== 'true').length, bad };
}
const entriesOf = (host) => host.all((n) => n.attrs && n.attrs['data-status'] && n.tagName === 'LI');

(async () => {
  /* C1 — functions deployed, aggregate not computed yet */
  const r = await renderWith({ version: FIX_VERSION, log: FIX_LOG, stats: { state: 'not-computed-yet' } });
  const text = r.host.textContent;
  const mv = metricViolations(r.host);
  ok(`not-computed-yet: every install metric (${mv.count}) renders "—" + "Not measured yet" + a reason, never a number`, mv.count >= 7 && mv.unmeasured === mv.count && mv.bad.length === 0, mv.bad);
  ok('not-computed-yet: the reason says the first count has not run', metricsOf(r.host).filter((m) => m.key !== 'androidApp').every((m) => /first count has not run yet/.test(m.why)));
  ok('the section notice says "Not measured yet" and why', /Not measured yet\. The install counter is live, but its first count has not run yet/.test(text));
  ok('the only fetch is /version.json, cache-busted', r.fetched.length === 1 && /^\/version\.json\?cb=\d+$/.test(r.fetched[0]), r.fetched);
  const logCall = r.calls.find((c) => c.name === 'adminReleaseLog');
  ok('adminReleaseLog asked for one page of 40 with the LIVE commit for status proof', logCall && logCall.data.limit === 40 && logCall.data.liveCommit === FIX_VERSION.commit && !logCall.data.cursor, logCall);
  const fact = (k) => { const n = r.host.all((x) => x.attrs && x.attrs['data-fact'] === k)[0]; return n ? n.textContent : null; };
  ok('Live now: commit from version.json', /abc1234/.test(fact('commit') || ''), fact('commit'));
  ok('Live now: branch from version.json', /hosting\/fixture/.test(fact('branch') || ''));
  ok('Live now: cache version from version.json', /v649/.test(fact('cacheVersion') || ''));
  ok('Live now: build time rendered (EAT)', /EAT/.test(fact('buildTime') || ''), fact('buildTime'));
  ok('This browser: no controller -> neutral "cannot be read", not "up to date"', /cannot be read/.test(fact('verdict') || '') && !/Up to date/.test(fact('verdict') || ''), fact('verdict'));
  const dates = entriesOf(r.host).map((e) => e.attrs['data-date']);
  ok('release log renders newest first', JSON.stringify(dates) === JSON.stringify(['2026-10-01', '2026-09-30', '2026-09-29', '2026-09-01']), dates);
  const st = Object.fromEntries(entriesOf(r.host).map((e) => [e.attrs['data-date'], e.attrs['data-status']]));
  ok('"Live now" ONLY for the entry that deployed the live commit', st['2026-09-30'] === 'live' && Object.values(st).filter((s) => s === 'live').length === 1, st);
  ok('NEGATIVE: an older DEPLOYED claim is the changelog’s claim, not "live"', st['2026-09-29'] === 'deployed', st);
  ok('an entry with no claim is "Committed"', st['2026-09-01'] === 'committed' && st['2026-10-01'] === 'not-deployed', st);

  /* NEGATIVE CONTROL: fabricate a count and prove the predicate catches it. */
  const firstVal = r.host.all((n) => cls(n, 'sk-upd-metric-value'))[0];
  firstVal.textContent = '0';
  const mv2 = metricViolations(r.host);
  ok('NEGATIVE: an injected "0" in an unmeasured install metric is caught', mv2.bad.some((b) => b.value === '0'), mv2.bad);

  /* C2 — functions NOT deployed: both callables not-found */
  const r2 = await renderWith({ version: FIX_VERSION, logErr: NOT_FOUND, statsErr: NOT_FOUND });
  const t2 = r2.host.textContent;
  ok('log callable not deployed -> "Release log is served to admins by the server — not available yet"', /Release log is served to admins by the server — not available yet \(functions\/not-found\)/.test(t2));
  ok('log callable not deployed -> NO entries and no "no entries" line (never an empty list as if there were no releases)', entriesOf(r2.host).length === 0 && !/No entries match|has no entries/.test(t2));
  const mv3 = metricViolations(r2.host);
  ok('stats callable not deployed -> every metric neutral with the "not available" reason', mv3.bad.length === 0 && metricsOf(r2.host).filter((m) => m.key !== 'androidApp').every((m) => /not available on the server yet/.test(m.why)), mv3.bad);
  const r2b = await renderWith({ version: FIX_VERSION, logErr: { code: 'functions/permission-denied' }, statsErr: { code: 'functions/permission-denied' } });
  ok('a refusal (permission-denied) is reported as a refusal, not as "not available yet", and lists nothing', /did not return the release log \(functions\/permission-denied\)/.test(r2b.host.textContent) && entriesOf(r2b.host).length === 0 && metricViolations(r2b.host).bad.length === 0);

  /* C3 — computed aggregate */
  const r3 = await renderWith({ version: FIX_VERSION, log: FIX_LOG, stats: STATS_COMPUTED });
  const m3 = Object.fromEntries(metricsOf(r3.host).map((m) => [m.key, m]));
  ok('computed: figures render from the aggregate (devices 12, active7 9, standalone 4)', m3.devices.value === '12' && m3.active7.value === '9' && m3.standalone.value === '4' && m3.devices.measured === 'true' && m3.devices.state === 'Measured');
  ok('computed: a canonical 0 from the server renders as 0 (measured), not as unknown', m3.installs.value === '0' && m3.installs.measured === 'true');
  ok('computed: each figure carries "Since <date>" and "Computed <stamp>"', ['devices', 'installs', 'active30'].every((k) => /Since 01 Oct 2026/.test(m3[k].why) && /Computed 01 Oct 2026/.test(m3[k].why)), m3.devices.why);
  ok('computed: onLive/behind null -> "—" + Not measured yet + the liveError reason (never 0)', ['onLatest', 'behind'].every((k) => m3[k].value === '—' && m3[k].state === 'Not measured yet' && /version\.json HTTP 503/.test(m3[k].why)));
  ok('computed: Play Store downloads stay unmeasured (no canonical source)', m3.androidApp.value === '—' && m3.androidApp.measured === 'false');
  ok('computed: the unmeasured metrics still pass the neutral predicate', metricViolations(r3.host).bad.length === 0);
  ok('computed: the notice states the counting start and that nothing earlier is estimated', /Counting since 01 Oct 2026.*nothing before it is counted or estimated/.test(r3.host.textContent));

  /* C4 — paging through the cursor */
  const big = { schema: 1, source: 'CHANGELOG.md', sourceSha256: 'e'.repeat(64), entryCount: 45, entries: [] };
  for (let i = 0; i < 45; i++) big.entries.push({ id: 'p' + i, date: '2026-09-' + String(30 - Math.floor(i / 2)).padStart(2, '0'), title: 'entry ' + i, type: 'feat', claim: null, commits: [], summary: '', files: [], filesMore: 0 });
  const r4 = await renderWith({ version: FIX_VERSION, log: big, stats: { state: 'not-computed-yet' } });
  const more = r4.host.all((n) => n.attrs && n.attrs['data-upd'] === 'more')[0];
  ok('page 1: 40 entries, "Show 5 more (5 remaining)"', entriesOf(r4.host).length === 40 && more && !more.hidden && more.textContent === 'Show 5 more (5 remaining)', more && more.textContent);
  more.listeners.click[0].call(more);
  await r4.tick();
  const logCalls = r4.calls.filter((c) => c.name === 'adminReleaseLog');
  ok('Show more sends the server cursor and appends', logCalls.length === 2 && logCalls[1].data.cursor === 'o:40' && entriesOf(r4.host).length === 45 && more.hidden, logCalls.map((c) => c.data.cursor));

  /* C5 — version.json unreadable -> neutral, nothing promoted to live */
  const r5 = await renderWith({ version: FIX_VERSION, log: FIX_LOG, stats: { state: 'not-computed-yet' }, versionStatus: 503 });
  const t5 = r5.host.textContent;
  ok('version.json unreadable -> explicit error, facts render "—"', /Could not read \/version\.json \(HTTP 503\)/.test(t5));
  const st5 = entriesOf(r5.host).map((e) => e.attrs['data-status']);
  ok('version.json unreadable -> no entry is claimed "Live now", and no liveCommit is sent', !st5.includes('live') && r5.calls.every((c) => !c.data.liveCommit), st5);

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
