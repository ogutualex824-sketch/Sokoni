#!/usr/bin/env node
/* ADMINOS SECURITY VIEW — sokoni-aos-security.js (the ONE Security view; Super Admin reaches it via admin-os.html#security),
 * executed in a VM with a DOM stub + stubbed sources (no browser — memory floor), plus static checks on the wiring and on
 * security-center.html / executive-dashboard.html (the invented scores / domains / compliance are gone).
 *   node scripts/test-aos-security.js            SABOTAGE=1 → every mutation must turn its named row FAIL */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), cp = require('child_process'), os = require('os');
const ROOT = path.join(__dirname, '..');

if (process.env.SABOTAGE) {
  const M = [
    ['X1', 'sokoni-aos-security.js', "      var measured = sc && Array.isArray(sc.dimensions) ? sc.dimensions.filter(function (d) { return d.basis === 'measured' && d.score != null; }) : [];", "      var measured = sc && Array.isArray(sc.dimensions) ? sc.dimensions.filter(function (d) { return d.score != null; }) : [];"],
    ['X2', 'sokoni-aos-security.js', "          : '<div class=\"sas-big\">' + (mfaPct == null ? '—' : mfaPct + '%') + '</div>", "          : '<div class=\"sas-big\">' + (mfaPct == null ? '0%' : mfaPct + '%') + '</div>"],
    ['X3', 'sokoni-aos-security.js', "  function unavailable(name) { return '<div class=\"sac-state\" style=\"padding:18px 8px\">Not available'", "  function unavailable(name) { return '<div class=\"sac-state\" style=\"padding:18px 8px\">0 items'"],
    ['X6', 'sokoni-aos-security.js', "    if (typeof host.__sasOff === 'function') host.__sasOff();", ''],
    ['X7', 'sokoni-aos-security.js', "        return '<li><span class=\"sas-ico\" aria-hidden=\"true\">⚠</span><div class=\"sas-li-main\"><b>' + esc(human(e.type || e.event || e.action)) + '</b>", "        return '<li><span class=\"sas-ico\" aria-hidden=\"true\">⚠</span><div class=\"sas-li-main\"><b>' + (e.type || e.event || e.action) + '</b>"],
    ['X10', 'security-center.html', "      const score = r.totalScore;", "      const score = r.totalScore || 86;"],
  ];
  let caught = 0;
  for (const [row, file, a, b] of M) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sas-')); fs.mkdirSync(path.join(d, 'scripts'));
    ['sokoni-aos-security.js', 'sokoni-audit-center.js', 'sokoni-aos.js', 'admin-os.html', 'super-admin.html', 'security-center.html', 'executive-dashboard.html'].forEach((f) => fs.copyFileSync(path.join(ROOT, f), path.join(d, f)));
    const t = path.join(d, file), s = fs.readFileSync(t, 'utf8').replace(/\r\n/g, '\n');
    if (s.split(a).length !== 2) { console.log('  BROKEN ' + row + ' anchor'); fs.rmSync(d, { recursive: true, force: true }); continue; }
    fs.writeFileSync(t, s.replace(a, () => b));
    let out = ''; try { out = cp.execFileSync(process.execPath, [__filename], { env: Object.assign({}, process.env, { SABOTAGE: '', WEB_DIR: d }), encoding: 'utf8' }); } catch (e) { out = String(e.stdout || ''); }
    const hit = new RegExp('FAIL ' + row + ' ').test(out); console.log('  ' + (hit ? 'CAUGHT' : 'MISSED') + ' ' + row); if (hit) caught++;
    fs.rmSync(d, { recursive: true, force: true });
  }
  console.log('\nSABOTAGE: ' + caught + '/' + M.length + ' caught'); process.exit(caught === M.length ? 0 : 1);
}

const DIR = process.env.WEB_DIR || ROOT;
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 300) + ']')); ok ? pass++ : fail++; };
console.log('\nAdminOS Security view\n');

function makeDoc() { const head = { children: [], appendChild(c) { this.children.push(c); } }; return { head, body: { appendChild() {}, removeChild() {} }, getElementById: (id) => head.children.find((c) => c.id === id) || null, createElement: (tag) => ({ tag, id: '', textContent: '', click() {} }) }; }
function makeHost(doc) { return { innerHTML: '', ownerDocument: doc, L: {}, addEventListener(t, f) { (this.L[t] = this.L[t] || []).push(f); }, removeEventListener(t, f) { this.L[t] = (this.L[t] || []).filter((x) => x !== f); } }; }
function target(attrs) { const t = { getAttribute: (k) => (k in attrs ? attrs[k] : null), disabled: false }; t.closest = (sel) => { const m = /^\[([a-z-]+)\]$/.exec(sel); return m && m[1] in attrs ? t : null; }; return t; }
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
function load() {
  const G = { Date, Math, JSON, Object, Array, String, Number, Promise, isNaN, encodeURIComponent }; G.window = G;
  const ctx = vm.createContext(G);
  vm.runInContext(fs.readFileSync(path.join(DIR, 'sokoni-audit-center.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(DIR, 'sokoni-aos-security.js'), 'utf8'), ctx);
  return G;
}
/* a Firestore stub: collection(name).where/orderBy/limit.get() → docs; a name in `fail` rejects */
function fakeDb(data, fail) {
  const q = (name) => ({ where: () => q(name), orderBy: () => q(name), limit: () => q(name),
    get: async () => { if ((fail || []).includes(name)) throw Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' }); return { docs: (data[name] || []).map((x, i) => ({ id: x.id || name + i, data: () => x })) }; } });
  return { collection: q };
}
const SC = {
  totalScore: 72, grade: 'C (Fair)', scoreBasis: 'measured_only', coverage: { measured: 7, declared: 6, unreadable: 1, noData: 1, total: 15 },
  mfa: { enrolled: 2, privileged: 3, rate: 2 / 3 }, privileged: { total: 3, byRole: { admin: 2, super_admin: 1 }, truncated: false },
  criticalIssues: ['MFA adoption below 50% for privileged users.', '2 critical security alert(s) open.'],
  dimensions: [
    { name: 'App Check Coverage', score: 10, maxScore: 10, basis: 'declared', notes: 'static' },
    { name: 'MFA Adoption', score: 7, maxScore: 10, basis: 'measured', notes: '2/3', metrics: { enrolled: 2, privileged: 3 } },
    { name: 'Open Security Alerts', score: 2, maxScore: 10, basis: 'measured', notes: '3 open', metrics: { open: 3, critical: 2, high: 1, truncated: false } },
    { name: 'Active Incidents', score: 10, maxScore: 10, basis: 'measured', metrics: { open: 0 } },
    { name: 'Device Trust', score: 7, maxScore: 10, basis: 'measured', metrics: { trusted: 6, untrusted: 2, unrated: 2, sampled: 10 } },
    { name: 'Payment Security', score: null, maxScore: 10, basis: 'unreadable', notes: 'Could not sample payments — not scored.' },
  ],
};
const DATA = {
  activeSessions: [{ id: 'sess1', email: 'sarah@sokoni.test', uid: 'u1', ip: '104.18.12.45', device: 'Chrome on Windows', lastActive: Date.now() - 60000 }],
  securityEvents: [{ type: '<img src=x onerror=1>', email: 'mike@sokoni.test', ip: '172.16.8.23', severity: 'high', createdAt: Date.now() - 300000 }],
  securityAlerts: [{ id: 'al1', title: 'Unusual location', severity: 'high', createdAt: Date.now() - 9000 }, { id: 'al2', title: 'Impossible travel detected', severity: 'critical', email: 'sarah@sokoni.test', ip: '185.199.108.153', createdAt: Date.now() - 1000 }],
  approvalRequests: [{ id: 'ap1', type: 'role_change', requestedByEmail: 'ops@sokoni.test', createdAt: Date.now() }],
};
const AUDIT = [{ action: 'admin_role_granted', adminEmail: 'root@sokoni.test', targetId: 'u9', createdAt: new Date().toISOString() }, { action: 'banner_saved', adminEmail: 'root@sokoni.test' }];
async function mounted(opts) {
  const G = load(), doc = makeDoc(), host = makeHost(doc), calls = [], acts = [];
  const call = async (n, d) => { calls.push(n); if (opts.callFail && opts.callFail.includes(n)) throw new Error('internal'); return n === 'getSecurityScorecard' ? (opts.sc === undefined ? SC : opts.sc) : n === 'adminGetAuditLogs' ? { logs: AUDIT } : {}; };
  const actions = { revokeSession: (id) => acts.push(['revoke', id]), revokeAllSessions: () => acts.push(['revokeAll']), approveRequest: (id) => acts.push(['approve', id]), rejectRequest: (id) => acts.push(['reject', id]), openAudit: () => acts.push(['audit']) };
  const ctl = G.SokoniAOSSecurity.mount(host, { call, db: fakeDb(DATA, opts.dbFail), actions, links: [{ href: 'security-center.html', label: 'Security Center' }] });
  await flush();
  const click = async (attrs) => { for (const f of (host.L.click || []).slice()) f({ target: target(attrs) }); await flush(); };
  return { G, doc, host, ctl, calls, acts, actions, click, call };
}

(async () => {
  /* X1 posture: the server's measured-only score + coverage; declared dimensions never listed as scores */
  let m = await mounted({}); let h = m.host.innerHTML;
  ck('X1', /72<\/text>/.test(h) && /\/100 measured/.test(h) && /7 measured · 6 declared · 2 not measurable/.test(h) && !/App Check Coverage<\/span><b>/.test(h) && /MFA Adoption<\/span><b>7\/10/.test(h) && />C<\/span><\/h4>/.test(h),
    'posture tile = server totalScore (measured only) with coverage; a declared dimension is never listed as a score', h.slice(h.indexOf('Security posture'), h.indexOf('Security posture') + 500));
  /* X2 MFA / alerts / incidents tiles from server metrics; unknown → — */
  ck('X2a', /67%<\/div><div class="sas-sub">2 of 3 enrolled/.test(h) && />3<\/div><div class="sas-sub">2 critical · 1 high/.test(h) && />0<\/div><div class="sas-sub">open security incidents/.test(h),
    'MFA 67% (2 of 3 privileged), open alerts 3 (2 critical · 1 high), incidents a real 0 — all from the scorecard');
  const mNo = await mounted({ sc: { dimensions: [], coverage: null, totalScore: null } });
  ck('X2', /class="sas-big">—<\/div><div class="sas-sub">not measured/.test(mNo.host.innerHTML) && /—<\/text>/.test(mNo.host.innerHTML) && !/0%<\/div>/.test(mNo.host.innerHTML),
    'an unmeasured MFA / alert / posture value renders "—" ("not measured"), never 0', mNo.host.innerHTML.slice(0, 200));

  /* X3 a source that fails is "Not available", never an empty list or 0 */
  m = await mounted({ dbFail: ['activeSessions'], callFail: ['adminGetAuditLogs'] }); h = m.host.innerHTML;
  ck('X3', /Not available — permission-denied\. This is not an empty list\./.test(h) && /Not available — internal/.test(h) && !/No active sessions tracked/.test(h),
    'a refused read (sessions) or failed call (audit) says "Not available … not an empty list"', h.slice(h.indexOf('Active sessions'), h.indexOf('Active sessions') + 260));

  /* X4 alert in focus: critical first; navigation; remediation from server criticalIssues */
  m = await mounted({}); h = m.host.innerHTML;
  const focus1 = /Alert in focus[\s\S]*Impossible travel detected/.test(h) && /1 of 2/.test(h) && /185\.199\.108\.153/.test(h);
  await m.click({ 'data-sas-alertnav': '1' });
  ck('X4', focus1 && /Unusual location<\/h3>/.test(m.host.innerHTML) && /2 of 2/.test(m.host.innerHTML) && /MFA adoption below 50% for privileged users\./.test(h),
    'the alert in focus is the most severe open alert (critical first), navigable; remediation steps are the server criticalIssues');

  /* X5 actions are the HOST's handlers (confirm/act/toast/reload live there) — the view claims nothing */
  m = await mounted({});
  await m.click({ 'data-sas-revoke': 'sess1' }); await m.click({ 'data-sas-tab': 'approvals' }); await m.click({ 'data-sas-approve': 'ap1' }); await m.click({ 'data-sas-reject': 'ap1' });
  await m.click({ 'data-sas-tab': 'sessions' }); await m.click({ 'data-sas-act': 'revokeAll' }); await m.click({ 'data-sas-act': 'audit' });
  const loads = m.calls.filter((c) => c === 'getSecurityScorecard').length;
  ck('X5', JSON.stringify(m.acts) === JSON.stringify([['revoke', 'sess1'], ['approve', 'ap1'], ['reject', 'ap1'], ['revokeAll'], ['audit']]) && loads === 1,
    'revoke / approve / reject / revoke-all / audit call the host handlers once each; the view does not reload behind them', { acts: m.acts, loads });

  /* X6 remount on the same host (AdminOS re-runs its loader after each action) never doubles a click */
  m = await mounted({});
  m.G.SokoniAOSSecurity.mount(m.host, { call: m.call, db: fakeDb(DATA), actions: m.actions, links: [] }); await flush();
  m.acts.length = 0;
  await m.click({ 'data-sas-revoke': 'sess1' });
  ck('X6', m.acts.length === 1 && (m.host.L.click || []).length === 1, 'after a remount, one listener remains and one click acts once', { acts: m.acts.length, listeners: (m.host.L.click || []).length });

  /* X7 escaping */
  m = await mounted({}); h = m.host.innerHTML;
  ck('X7', !/<img src=x/.test(h) && /&lt;img src=x onerror=1&gt;/.test(h), 'event / alert / user text is escaped');

  /* X8 audit cues: a SELECTION of security-relevant admin actions, labelled as such */
  ck('X8', /Admin role granted/.test(h) && !/Banner saved/.test(h) && /mentions roles, permissions, MFA, keys or sessions/.test(h), 'audit cues keep only security-relevant admin actions and say how they were selected');

  /* X9 wiring: AdminOS mounts the ONE view with its existing handlers; Super Admin links to it (no second Security view) */
  const AOS = fs.readFileSync(path.join(DIR, 'sokoni-aos.js'), 'utf8'), AOH = fs.readFileSync(path.join(DIR, 'admin-os.html'), 'utf8'), SAH = fs.readFileSync(path.join(DIR, 'super-admin.html'), 'utf8');
  ck('X9', /SokoniAOSSecurity\.mount\(body/.test(AOS) && /actions: \{ revokeSession, revokeAllSessions, approveRequest, rejectRequest, openAudit/.test(AOS) && /<script src="sokoni-aos-security\.js"><\/script>\s*<script src="sokoni-aos\.js">/.test(AOH)
    && !/securityEventsBody|security-grid">/.test(AOS) && /href="admin-os\.html#security"/.test(SAH) && !/id="panel-security"/.test(SAH),
    'AdminOS mounts the ONE Security view with its existing handlers; Super Admin reaches it via admin-os.html#security and has no second Security panel');

  /* X10 the other security pages no longer invent numbers */
  const SC_ = fs.readFileSync(path.join(DIR, 'security-center.html'), 'utf8'), EX = fs.readFileSync(path.join(DIR, 'executive-dashboard.html'), 'utf8');
  ck('X10', !/\|\| *86|r\.overall|scorecard\.overall|buildStaticDomains|score: 85, status|mfaCoverage \|\| 0/.test(SC_) && /const score = r\.totalScore;/.test(SC_) && /Declared — not measured/.test(SC_)
    && !/sec\.overall|pct: 98 \}|v: 95 \}|Fallback static domains/.test(EX) && /sec\.totalScore == null \? null/.test(EX),
    'security-center.html and executive-dashboard.html show the measured score (— when unknown); the invented 86, static domains, fixed compliance % and subsystem % are gone');

  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  console.log('NOT proven here: a rendered browser check (memory floor) and live data through the deployed callables.');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); console.log('\nRESULT: ' + pass + ' passed, ' + (fail + 1) + ' failed'); process.exit(1); });
