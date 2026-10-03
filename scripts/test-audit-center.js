#!/usr/bin/env node
/* AUDIT CENTER — sokoni-audit-center.js (the ONE audit view for AdminOS + Super Admin), executed in a VM with a DOM stub
 * (no browser — memory floor) + static checks on admin-os.html / super-admin.html / sokoni-aos.js.
 * Proves: heterogeneous server records normalise without invention; every figure is a count of the LOADED records and says
 * so (no trends, no platform totals); severity / IP / device / environment appear only when recorded (an unrecorded value
 * is "—" and its column is not drawn); a failed load is neutral, never "0"; filters + chips + paging; the detail panel's
 * Overview / Changes / Raw Data; everything escaped; CSV formula-injection guarded; both pages mount the view with their
 * own server-authorised feeds; the sidebar / nav / <head> are byte-identical to HEAD.
 *   node scripts/test-audit-center.js            SABOTAGE=1 → every mutation must turn its named row FAIL */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), cp = require('child_process'), os = require('os');
const ROOT = path.join(__dirname, '..');

if (process.env.SABOTAGE) {
  const M = [
    ['A2', 'sokoni-audit-center.js', "    var sev = String(pick(r, ['severity', 'level', 'riskLevel']) || '').toLowerCase();", "    var sev = String(pick(r, ['severity', 'level', 'riskLevel']) || 'low').toLowerCase();"],
    ['A3', 'sokoni-audit-center.js', "        + card(1, 'High & critical', withSev ? String(hi) : '—',", "        + card(1, 'High & critical', String(hi),"],
    ['A4', 'sokoni-audit-center.js', "        bodyHtml = '<pre class=\"sac-pre\">' + esc(stringify(e.raw)) + '</pre>';", "        bodyHtml = '<pre class=\"sac-pre\">' + stringify(e.raw) + '</pre>';"],
    ['A6', 'sokoni-audit-center.js', "      if (S.state === 'error') return '<div class=\"sac-tablewrap\"><div class=\"sac-state\" role=\"alert\"><b>We couldn’t load the audit log just now.</b>", "      if (S.state === 'error') return '<div class=\"sac-tablewrap\"><div class=\"sac-state\" role=\"alert\"><b>0 events.</b>"],
    ['A7', 'sokoni-audit-center.js', "  function csvCell(v) { var s = String(v == null ? '' : v); if (/^[=+\\-@\\t\\r]/.test(s)) s = \"'\" + s;", "  function csvCell(v) { var s = String(v == null ? '' : v);"],
    ['A8', 'sokoni-audit-center.js', "      return { ip: has(function (e) { return e.ip || e.location; }),", "      return { ip: true || has(function (e) { return e.ip || e.location; }),"],
    ['A10', 'sokoni-aos.js', '    { key: "payment",  label: "Payment trail",   op: "getPaymentAuditTrail" },\n', ''],
  ];
  let caught = 0;
  for (const [row, file, a, b] of M) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sac-')); fs.mkdirSync(path.join(d, 'scripts'));
    ['sokoni-audit-center.js', 'sokoni-aos.js', 'admin-os.html', 'super-admin.html'].forEach((f) => fs.copyFileSync(path.join(ROOT, f), path.join(d, f)));
    const t = path.join(d, file), s = fs.readFileSync(t, 'utf8').replace(/\r\n/g, '\n');
    if (s.split(a).length !== 2) { console.log('  BROKEN ' + row + ' anchor'); fs.rmSync(d, { recursive: true, force: true }); continue; }
    fs.writeFileSync(t, s.replace(a, () => b));
    let out = ''; try { out = cp.execFileSync(process.execPath, [__filename], { env: Object.assign({}, process.env, { SABOTAGE: '', WEB_DIR: d, GIT_DIR_ROOT: ROOT }), encoding: 'utf8' }); } catch (e) { out = String(e.stdout || ''); }
    const hit = new RegExp('FAIL ' + row + ' ').test(out); console.log('  ' + (hit ? 'CAUGHT' : 'MISSED') + ' ' + row); if (hit) caught++;
    fs.rmSync(d, { recursive: true, force: true });
  }
  console.log('\nSABOTAGE: ' + caught + '/' + M.length + ' caught'); process.exit(caught === M.length ? 0 : 1);
}

const DIR = process.env.WEB_DIR || ROOT;
const GITROOT = process.env.GIT_DIR_ROOT || ROOT;
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 300) + ']')); ok ? pass++ : fail++; };
console.log('\nAudit Center (AdminOS + Super Admin)\n');

/* ── a DOM stub just big enough for the module ── */
function makeDoc() {
  const head = { children: [], appendChild(c) { this.children.push(c); } };
  const doc = { head, body: { appendChild() {}, removeChild() {} }, activeElement: null,
    getElementById(id) { return head.children.find((c) => c.id === id) || null; },
    createElement(tag) { return { tag, id: '', textContent: '', click() { doc._clicked = this; } }; } };
  return doc;
}
function makeHost(doc) {
  return { innerHTML: '', ownerDocument: doc, L: {}, addEventListener(t, f) { (this.L[t] = this.L[t] || []).push(f); }, querySelector: () => null };
}
/* a fake event target: closest(sel) answers for [attr] selectors from a dataset-like map */
function target(attrs, extra) {
  const t = Object.assign({ getAttribute: (k) => (k in attrs ? attrs[k] : null), disabled: false }, extra || {});
  t.closest = (sel) => { const m = /^\[([a-z-]+)\]$/.exec(sel); return m && m[1] in attrs ? t : null; };
  return t;
}
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
function loadModule() { const G = { Date, Math, JSON, Object, Array, String, Number, Promise, isNaN, encodeURIComponent, setTimeout }; G.window = G; vm.runInContext(fs.readFileSync(path.join(DIR, 'sokoni-audit-center.js'), 'utf8'), vm.createContext(G)); return G.SokoniAuditCenter; }
async function mounted(feeds, opts) {
  const AC = loadModule(), doc = makeDoc(), host = makeHost(doc);
  const ctl = AC.mount(host, Object.assign({ feeds }, opts || {})); await flush();
  const fire = async (type, t) => { for (const f of host.L[type] || []) f({ target: t, preventDefault() {}, key: t.key }); await flush(); };
  return { AC, doc, host, ctl, fire };
}

const NOW = Date.now();
const ADMIN = [   /* adminAudit-shaped (adminGetAuditLogs) — no severity / ip / device recorded */
  { id: 'a1', action: 'featured_shop_set', merchantUid: 'shopX', actor: 'uidAdmin1', createdAt: new Date(NOW - 60000).toISOString(), reason: 'Promo week' },
  { id: 'a2', action: 'application_decided', applicationId: 'marketing_mk', decidedBy: 'uidAdmin2', adminEmail: 'ops@sokoni.test', createdAt: new Date(NOW - 3600000).toISOString(),
    details: { before: { status: 'under_review' }, after: { status: 'approved', approvedCategories: ['branding'] } } },
  { id: 'a3', action: '<img src=x onerror=alert(1)>', targetId: '=HYPERLINK("x")', createdAt: new Date(NOW - 7200000).toISOString() },
];
const SECURITY = [   /* auditLog-shaped (Super Admin) — severity, ip, userAgent recorded */
  { id: 's1', action: 'role_changed', actorUid: 'uidSA', severity: 'critical', resource: 'users/emily', ip: '73.212.147.17', location: { city: 'Austin', country: 'US' },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15', environment: 'production', timestamp: { _seconds: Math.floor(NOW / 1000) - 120 } },
  { id: 's2', action: 'login_failed', actorUid: 'uidX', severity: 'high', resource: 'auth', timestamp: { _seconds: Math.floor(NOW / 1000) - 600 } },
];

(async () => {
  const AC0 = loadModule(), N = AC0._internal.normalize;
  /* A1 normalisation */
  const n1 = N(ADMIN[1], 'admin'), n2 = N(SECURITY[0], 'sec'), n3 = N(ADMIN[0], 'admin');
  ck('A1', n1.actor.email === 'ops@sokoni.test' && n1.resource === 'marketing_mk' && n1.after.status === 'approved' && n1.before.status === 'under_review'
    && n2.ip === '73.212.147.17' && n2.location === 'Austin, US' && n2.device.browser === 'Safari' && n2.device.os === 'macOS' && n2.severity === 'critical' && n2.environment === 'production' && n2.at === (Math.floor(NOW / 1000) - 120) * 1000
    && n3.resource === 'shopX' && n3.actor.uid === 'uidAdmin1' && n3.summary === 'Promo week',
    'heterogeneous records (adminAudit / auditLog shapes) normalise: actor, resource, before/after, IP, location, device, severity, environment, time', { n1: [n1.actor, n1.resource], n2: [n2.ip, n2.location, n2.device, n2.severity] });

  /* A2 nothing invented: a record without severity / ip / device / environment carries null */
  ck('A2', n3.severity === null && n3.ip === null && n3.device === null && n3.environment === null && N({}, 'x').actor.system === true,
    'an unrecorded severity / IP / device / environment stays null (never inferred from the action); no actor = system', { sev: n3.severity, ip: n3.ip });

  /* A3 / A8 AdminOS feed: figures are counts of what was loaded; no trends; unrecorded columns not drawn */
  let m = await mounted([{ key: 'admin', label: 'Admin actions', load: async () => ADMIN }]);
  let h = m.host.innerHTML;
  ck('A3', /Events loaded<\/small><b>3<\/b>/.test(h) && /High &amp; critical<\/small><b>—<\/b><em>severity not recorded by this feed/.test(h) && /Unique actors<\/small><b>2<\/b>/.test(h)
    && /Changes recorded<\/small><b>1<\/b>/.test(h) && /of the 3 loaded/.test(h) && !/vs last|%\s*vs|last 7 days/i.test(h),
    'summary cards count the LOADED records and say so; high/critical is "—" when the feed records no severity; no trends / platform totals', h.slice(0, 400));
  ck('A8', !/IP \/ Location<\/th>/.test(h) && !/Device \/ Browser<\/th>/.test(h) && !/Severity<\/th>/.test(h) && !/Environment<\/th>/.test(h),
    'a column no loaded record carries (IP, device, severity, environment) is not drawn at all');

  /* A4 escaping: table + raw JSON */
  ck('A4a', !/<img src=x/.test(h) && /&lt;img src=x/.test(h), 'an action / resource with markup is escaped in the table');
  await m.fire('click', target({ 'data-sac-row': String(m.ctl._state.rows.findIndex((e) => e.id === 'a3')) }));
  await m.fire('click', target({ 'data-sac-tab': 'raw' }));
  h = m.host.innerHTML;
  ck('A4', /Event detail/.test(h) && /&lt;img src=x onerror=alert\(1\)&gt;/.test(h) && !/<img src=x/.test(h), 'Raw Data shows the record as ESCAPED JSON (no markup executes)', h.slice(h.indexOf('sac-pre'), h.indexOf('sac-pre') + 200));

  /* A5 detail Overview + Changes */
  await m.fire('click', target({ 'data-sac-row': String(m.ctl._state.rows.findIndex((e) => e.id === 'a2')) }));
  const ov = m.host.innerHTML;
  await m.fire('click', target({ 'data-sac-tab': 'changes' }));
  const chg = m.host.innerHTML;
  await m.fire('click', target({ 'data-sac-act': 'byActor' }));
  ck('A5', /What happened\?/.test(ov) && /Application decided/.test(ov) && /<dt>IP address<\/dt><dd><span class="sac-dash">—<\/span>/.test(ov) && /Before<\/h4>/.test(chg) && /under_review/.test(chg) && /approvedCategories/.test(chg)
    && m.ctl._state.q === 'ops@sokoni.test' && /Search: ops@sokoni.test/.test(m.host.innerHTML) && /Read-only/.test(ov),
    'detail: Overview from recorded fields ("—" when absent), Changes = before/after, "Filter by this actor" applies a real filter + chip; read-only', { q: m.ctl._state.q });

  /* A9 filters + chips + clear + paging */
  m = await mounted([{ key: 'sec', label: 'High & critical events', load: async () => SECURITY.concat(Array.from({ length: 23 }, (_, i) => ({ id: 'p' + i, action: 'perm_' + i, actorUid: 'u' + i, severity: 'high', timestamp: { _seconds: Math.floor(NOW / 1000) - 1000 - i } }))) }]);
  h = m.host.innerHTML;
  const page1 = /Showing 1 to 10 of 25 matching · 25 loaded/.test(h) && /IP \/ Location<\/th>/.test(h) && /Severity<\/th>/.test(h) && /Environment<\/th>/.test(h);
  await m.fire('change', target({ 'data-sac': 'sev' }, { value: 'critical' }));
  const onlyCrit = /Showing 1 to 1 of 1 matching/.test(m.host.innerHTML) && /Severity: Critical/.test(m.host.innerHTML);
  await m.fire('click', target({ 'data-sac-chip': 'sev' }));
  await m.fire('click', target({ 'data-sac-page': '3' }));
  const p3 = /Showing 21 to 25 of 25/.test(m.host.innerHTML);
  await m.fire('input', target({ 'data-sac': 'q' }, { value: '73.212' }));
  const byIp = /of 1 matching/.test(m.host.innerHTML);
  await m.fire('click', target({ 'data-sac-act': 'clear' }));
  ck('A9', page1 && onlyCrit && p3 && byIp && /of 25 matching/.test(m.host.innerHTML) && /High &amp; critical<\/small><b>25<\/b>/.test(m.host.innerHTML),
    'recorded columns appear; severity filter + chip, chip removal, paging (21–25 of 25), IP search and Clear all', { page1, onlyCrit, p3, byIp });

  /* A6 a failed load is neutral — never "0 events" */
  m = await mounted([{ key: 'x', label: 'X', load: async () => { throw new Error('permission-denied'); } }]);
  h = m.host.innerHTML;
  ck('A6', /We couldn’t load the audit log just now/.test(h) && /not an empty log/.test(h) && /Try again/.test(h) && !/<b>0<\/b>/.test(h) && /<b>—<\/b>/.test(h) && /Export CSV<\/button>/.test(h) && /disabled/.test(h),
    'a failed load shows a neutral "could not load" state with retry; cards are "—", never 0; export disabled', h.slice(0, 300));

  /* A7 CSV formula-injection guard */
  m = await mounted([{ key: 'admin', label: 'Admin actions', load: async () => ADMIN }]);
  const csv = m.ctl.exportCsv();
  ck('A7', typeof csv === 'string' && csv.indexOf('"\'=HYPERLINK') >= 0 && csv.indexOf(',"=HYPERLINK') === -1 && /^time_iso,actor,/.test(csv) && csv.split('\n').length === 4,
    'CSV export: one row per filtered event; a cell starting with = + - @ is neutralised (formula injection)', csv && csv.slice(0, 200));

  /* A10 wiring: both pages mount the view with their own server-authorised feeds; old table code is gone */
  const AOS = fs.readFileSync(path.join(DIR, 'sokoni-aos.js'), 'utf8'), AOH = fs.readFileSync(path.join(DIR, 'admin-os.html'), 'utf8'), SAH = fs.readFileSync(path.join(DIR, 'super-admin.html'), 'utf8');
  const ops = ['adminGetAuditLogs', 'getPaymentAuditTrail', 'eccGetAuditLog', 'platformGetEventLog'];
  ck('A10', ops.every((o) => AOS.indexOf('op: "' + o + '"') >= 0) && /SokoniAuditCenter\.mount\(body/.test(AOS) && /<script src="sokoni-audit-center\.js"><\/script>\s*<script src="sokoni-aos\.js">/.test(AOH)
    && /id="panel-audit"[\s\S]{0,40}hidden>\s*<div id="auditBody">/.test(AOH)
    && /collection\('auditLog'\)\.where\('severity','in',\['high','critical'\]\)\.orderBy\('timestamp','desc'\)\.limit\(limit\)/.test(SAH) && /SokoniAuditCenter\.mount\(host/.test(SAH) && /<script src="sokoni-audit-center\.js"><\/script>/.test(SAH)
    && !/saAuditSevFilter|saAuditTable/.test(SAH),
    'AdminOS mounts the view with its 4 server feeds; Super Admin with its auditLog high+critical read; the old tables / filters are gone');

  /* A11 the sidebar / nav / <head> are untouched (another agent owns the sidebar) */
  const at = (rev, f) => { try { return cp.execSync('git show ' + rev + ':' + f, { cwd: GITROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).replace(/\r\n/g, '\n'); } catch (_) { return null; } };
  const block = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i); return i >= 0 && j > i ? s.slice(i, j) : null; };
  const headOf = (s) => block(s, '<head', '</head>');
  const navAOS = (s) => block(s, '<nav', '</nav>') || block(s, 'class="aos-sidebar', '</aside>');
  const navSA = (s) => block(s, '<nav', '</nav>') || block(s, 'class="sa-sidebar', '</aside>');
  const aosBase = at('HEAD', 'admin-os.html'), saBase = at('HEAD', 'super-admin.html');
  const norm = (s) => (s || '').replace(/\r\n/g, '\n');
  const okA = aosBase && headOf(norm(aosBase)) === headOf(norm(AOH)) && navAOS(norm(aosBase)) && navAOS(norm(aosBase)) === navAOS(norm(AOH));
  const okS = saBase && headOf(norm(saBase)) === headOf(norm(SAH)) && navSA(norm(saBase)) && navSA(norm(saBase)) === navSA(norm(SAH));
  ck('A11', !!(okA && okS), 'admin-os.html and super-admin.html: <head> and the sidebar/nav block are byte-identical to HEAD (only the audit panel changed)', { okA: !!okA, okS: !!okS });

  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  console.log('NOT proven here: a rendered browser check (memory floor) and live audit data through the deployed callables.');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); console.log('\nRESULT: ' + pass + ' passed, ' + (fail + 1) + ' failed'); process.exit(1); });
