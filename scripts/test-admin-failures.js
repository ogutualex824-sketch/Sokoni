#!/usr/bin/env node
/* ============================================================================
   Failures view — EXECUTED behaviour + console wiring
   ============================================================================
   Run:  node scripts/test-admin-failures.js [path/to/sokoni-admin-failures.js]

   Loads sokoni-admin-failures.js in a vm with a small fake DOM, mounts it with a
   fake `call`, and serialises the resulting tree to HTML the way a browser
   would: text nodes are escaped, but anything assigned to innerHTML is emitted
   RAW. A module that ever routes a client-written field through innerHTML
   therefore produces live markup in the serialisation, and the escaping check
   fails. (Positive control: point the optional argument at a copy whose h()
   helper uses innerHTML instead of textContent — this suite must go red.)

   It proves, by execution:
     1. a malicious message renders as inert text (no <img>/<script> element)
     2. severity counts render the server's bySeverity figures
     3. not-found / unavailable / internal → "Failure log not available yet",
        never "No failures"; counts are "—", never 0
     4. a successful empty result → "No client failures reported in the last N hours"
     5. permission-denied → "You do not have access"
     6. the token is stripped from a reported URL
   and statically that both consoles wire ONE module: nav button with
   .nav-label, #panel-failures, router registration, no per-console copy.
   No browser, no network, no Firebase.
   ========================================================================= */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const MODULE = path.resolve(process.argv[2] || path.join(ROOT, 'sokoni-admin-failures.js'));

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (!ok && detail ? '   [' + String(detail).slice(0, 160) + ']' : ''));
  ok ? pass++ : fail++;
};

/* ── fake DOM ─────────────────────────────────────────────────────────────── */
const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => escText(s).replace(/"/g, '&quot;');
class Text { constructor(t) { this.nodeType = 3; this.data = String(t); } }
class El {
  constructor(tag) { this.nodeType = 1; this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.listeners = {}; this.raw = null; this.disabled = false; this.value = ''; }
  appendChild(c) { this.children.push(c); return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'value') this.value = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  fire(t) { (this.listeners[t] || []).forEach((f) => f.call(this, { target: this })); }
  set className(v) { this.attrs.class = String(v); } get className() { return this.attrs.class || ''; }
  set hidden(v) { if (v) this.attrs.hidden = ''; else delete this.attrs.hidden; } get hidden() { return 'hidden' in this.attrs; }
  set textContent(v) { this.children = v === '' || v == null ? [] : [new Text(v)]; this.raw = null; }
  get textContent() { return this.raw != null ? this.raw : this.children.map((c) => c.nodeType === 3 ? c.data : c.textContent).join(''); }
  set innerHTML(v) { this.children = []; this.raw = String(v); }
  get innerHTML() { return this.raw != null ? this.raw : this.children.map(ser).join(''); }
}
function ser(n) {
  if (n.nodeType === 3) return escText(n.data);
  const a = Object.keys(n.attrs).map((k) => ' ' + k + '="' + escAttr(n.attrs[k]) + '"').join('');
  const t = n.tagName.toLowerCase();
  return '<' + t + a + '>' + (n.raw != null ? n.raw : n.children.map(ser).join('')) + '</' + t + '>';
}
function find(n, pred, out = []) { if (n.nodeType === 1) { if (pred(n)) out.push(n); n.children.forEach((c) => find(c, pred, out)); } return out; }
const byFail = (root, key) => find(root, (e) => e.attrs['data-fail'] === key)[0];

function load() {
  const window = {};
  const sandbox = { window, document: { createElement: (t) => new El(t), createTextNode: (t) => new Text(t) }, console, Promise, Date, WeakMap, Object, Array, String, Number, parseInt, isFinite, Math, JSON, RegExp, Error };
  window.document = sandbox.document;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(MODULE, 'utf8'), sandbox, { filename: path.basename(MODULE) });
  return window.SokoniAdminFailures;
}
const flush = () => new Promise((r) => setImmediate(r));

async function mountWith(callImpl) {
  const api = load();
  const host = new El('div');
  const calls = [];
  api.mount(host, { console: 'aos', call: (name, data) => { calls.push({ name, data }); return callImpl(name, data); } });
  await flush(); await flush();
  return { api, host, calls, html: ser(host), status: (byFail(host, 'status') || {}).textContent || '' };
}

const MALICIOUS = '<img src=x onerror="alert(1)"><script>steal()</script>';

(async () => {
  console.log('\nFAILURES VIEW — executed behaviour (' + path.relative(ROOT, MODULE) + ')');
  console.log('='.repeat(78));

  /* 1 + 2 + 6 — observed rows, malicious message, counts, token-free url */
  {
    const r = await mountWith(() => Promise.resolve({
      errors: [
        { id: 'err_1', at: '2026-10-01T06:00:00Z', severity: 'critical', surface: 'checkout', code: 'E_PAY', message: MALICIOUS, context: '<b>ctx</b>', uid: 'abcdefghijklmnop', email: 'a***@g***.com', anonymous: false, url: 'https://mysokoni.co.ke/checkout.html?token=SECRET123#frag', appVersion: 'v648', online: true },
        { id: 'err_2', at: '2026-10-01T05:00:00Z', severity: 'warning', surface: 'home"><svg onload=x>', code: 'W1', message: 'slow', anonymous: true },
      ],
      count: 2, truncated: true, bySeverity: { critical: 1, warning: 1 }, since: '2026-09-30T06:00:00Z', source: 'errorLog',
    }));
    ck('calls getErrorLog with the default window (24h, limit 100)', r.calls[0] && r.calls[0].name === 'getErrorLog' && r.calls[0].data.hours === 24 && r.calls[0].data.limit === 100, JSON.stringify(r.calls));
    ck('malicious message is escaped — no live <img>/<script> in the rendered tree', !/<img\b|<script\b|<svg\b|<b>ctx/i.test(r.html) && r.html.includes('&lt;img src=x onerror=') && r.html.includes('&lt;script&gt;steal()'), r.html.slice(0, 200));
    ck('malicious surface cannot break out of its cell', !/<svg/.test(r.html) && r.html.includes('home"&gt;&lt;svg onload=x&gt;'), r.html);
    ck('state is observed with evidence "observed"', r.host.attrs['data-fail-state'] === 'observed' && byFail(r.host, 'evidence').attrs['data-evidence'] === 'observed');
    ck('severity counts: critical 1, warning 1 (reported)', byFail(r.host, 'count-critical').textContent === '1' && byFail(r.host, 'count-warning').textContent === '1');
    ck('severity absent from a complete bySeverity is a canonical 0', byFail(r.host, 'count-error').textContent === '0' && byFail(r.host, 'count-info').textContent === '0');
    ck('table renders one row per failure, with a text severity badge', find(r.host, (e) => e.tagName === 'TR' && e.attrs['data-sev']).length === 2 && /Critical/.test(r.html) && /Warning/.test(r.html));
    ck('table sits inside an overflow-x scroller', byFail(r.host, 'table-wrap') && !byFail(r.host, 'table-wrap').hidden && byFail(r.host, 'table-wrap').className === 'sk-fail-scroll');
    ck('reported URL is token-free (query + hash stripped), shown as text not a link', !r.html.includes('SECRET123') && !r.html.includes('frag') && r.html.includes('https://mysokoni.co.ke/checkout.html') && !/<a\b/.test(r.html));
    ck('uid is shortened; anonymous is labelled', r.html.includes('abcdef…') && !r.html.includes('>abcdefghijklmnop<') && r.html.includes('anonymous'));
    ck('truncation note is shown', !byFail(r.host, 'truncated').hidden && /more failures in this window/.test(byFail(r.host, 'truncated').textContent));
    ck('status text sits in a role=status aria-live region', byFail(r.host, 'status').attrs.role === 'status' && byFail(r.host, 'status').attrs['aria-live'] === 'polite');
  }

  /* 3 — not deployed (three codes) */
  for (const code of ['functions/not-found', 'unavailable', 'functions/internal']) {
    const r = await mountWith(() => Promise.reject({ code }));
    ck('callable error ' + code + ' → "Failure log not available yet"', r.status === 'Failure log not available yet' && !/No client failures reported/.test(r.html), r.status);
    ck('  …counts are "—", never 0, and no table', ['critical', 'error', 'warning', 'info'].every((s) => byFail(r.host, 'count-' + s).textContent === '—') && byFail(r.host, 'table-wrap').hidden);
    ck('  …evidence is "unreadable" (never green)', byFail(r.host, 'evidence').attrs['data-evidence'] === 'unreadable');
  }

  /* 4 — empty */
  {
    const r = await mountWith(() => Promise.resolve({ errors: [], count: 0, truncated: false, bySeverity: {}, since: '2026-09-30T06:00:00Z', source: 'errorLog' }));
    ck('successful empty result → "No client failures reported in the last 24 hours"', /^No client failures reported in the last 24 hours/.test(r.status), r.status);
    ck('  …evidence is "empty" and counts are a canonical 0', byFail(r.host, 'evidence').attrs['data-evidence'] === 'empty' && byFail(r.host, 'count-critical').textContent === '0');
    /* window filter flows into the wording */
    const hrs = byFail(r.host, 'hours'); hrs.value = '168'; hrs.fire('change'); await flush(); await flush();
    ck('  …changing the window to 168h re-queries and says "last 168 hours"', r.calls[r.calls.length - 1].data.hours === 168 && /last 168 hours/.test(byFail(r.host, 'status').textContent));
    const sev = byFail(r.host, 'severity'); sev.value = 'critical'; sev.fire('change'); await flush(); await flush();
    ck('  …severity filter is sent and other severities show "—" (filtered out)', r.calls[r.calls.length - 1].data.severity === 'critical' && byFail(r.host, 'count-info').textContent === '—');
  }

  /* 5 — denied */
  {
    const r = await mountWith(() => Promise.reject({ code: 'functions/permission-denied' }));
    ck('permission-denied → "You do not have access"', r.status === 'You do not have access', r.status);
  }

  /* bySeverity that does not add up → unknown is "—", not 0 */
  {
    const r = await mountWith(() => Promise.resolve({ errors: [{ id: 'x', severity: 'error', message: 'm' }], count: 5, bySeverity: { error: 1 } }));
    ck('incomplete bySeverity: absent severity renders "—", not 0', byFail(r.host, 'count-error').textContent === '1' && byFail(r.host, 'count-critical').textContent === '—');
  }

  /* malformed response */
  {
    const r = await mountWith(() => Promise.resolve({ nope: true }));
    ck('malformed response → unreadable, not empty', r.host.attrs['data-fail-state'] === 'error' && !/No client failures/.test(r.html));
  }

  /* ── static wiring ──────────────────────────────────────────────────────── */
  console.log('\nFAILURES VIEW — console wiring (static)');
  console.log('='.repeat(78));
  const aos = fs.readFileSync(path.join(ROOT, 'admin-os.html'), 'utf8');
  const aosJs = fs.readFileSync(path.join(ROOT, 'sokoni-aos.js'), 'utf8');
  const sa = fs.readFileSync(path.join(ROOT, 'super-admin.html'), 'utf8');
  const aosBtn = (aos.match(/<button[^>]*data-section="failures"[^>]*>[\s\S]*?<\/button>/g) || []);
  ck('admin-os: exactly one Failures sidebar button, icon then .nav-label, inline onclick like every other nav button',
    aosBtn.length === 1 && /<span class="nav-icon">[^<]*<\/span><span class="nav-label">Failures<\/span>/.test(aosBtn[0]) && /onclick="SokoniAOS\.navigate\('failures'\);_closeSidebar\(\)"/.test(aosBtn[0]), aosBtn.join(' | '));
  const opsGroup = (aos.match(/<div class="nav-group-label">Operations<\/div>([\s\S]*?)<\/div>/) || [])[1] || '';
  ck('admin-os: Failures sits in the Operations group', /data-section="failures"/.test(opsGroup));
  ck('admin-os: one #panel-failures + module + stylesheet loaded before sokoni-aos.js',
    (aos.match(/id="panel-failures"/g) || []).length === 1 && /<script src="sokoni-admin-failures\.js"><\/script>\s*<script src="sokoni-aos\.js">/.test(aos) && /href="sokoni-admin-failures\.css"/.test(aos));
  ck('admin-os + super-admin: ONE wiring style — no delegated :not([onclick]) listener',
    !/:not\(\[onclick\]\)/.test(aos) && !/:not\(\[onclick\]\)/.test(sa));
  ck('sokoni-aos.js: failures registered in the EXISTING _loadPanel router and mounts the shared module with _call',
    /failures:\s*\(\)\s*=>\s*_loadFailures\(\)/.test(aosJs) && /SokoniAdminFailures\.mount\(body,\s*\{\s*console:\s*"aos",\s*call:\s*\(name, data\)\s*=>\s*_call\(name, data\)/.test(aosJs));
  const saBtn = (sa.match(/<button[^>]*data-section="failures"[^>]*>[\s\S]*?<\/button>/g) || []);
  ck('super-admin: exactly one Failures nav button with .nav-label, inline onclick SA.nav',
    saBtn.length === 1 && /<span class="nav-label">Failures<\/span>/.test(saBtn[0]) && /onclick="SA\.nav\('failures'\);_closeSidebar\(\)"/.test(saBtn[0]), saBtn.join(' | '));
  ck('super-admin: native #panel-failures opened by SA.nav(\'failures\') → loadFailures',
    (sa.match(/id="panel-failures"/g) || []).length === 1 && /section==='failures'\)this\.loadFailures\(\)/.test(sa) && /SokoniAdminFailures\.mount\(body,\{console:'sa',call:\(name,data\)=>fns\.httpsCallable\(name\)/.test(sa));
  ck('super-admin: no #hash-on-load handler was added by this slice', !/location\.hash/.test(sa.split('loadFailures(){')[1] || '') && !/this\.nav\(_ok\?/.test(sa));
  ck('ONE module: no console carries its own copy of the renderer', [aos, sa, aosJs].every((src) => !/['"]getErrorLog['"]/.test(src) && !/sk-fail-table/.test(src)));

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH (not a pass):', e); process.exit(2); });
