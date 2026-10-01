#!/usr/bin/env node
/* ============================================================================
   Partner registrations view — EXECUTED behaviour + console wiring
   Run:  node scripts/test-admin-partner-registrations.js [path/to/module]
   Same fake-DOM method as test-admin-payout-approvals.js: text nodes are escaped, innerHTML is emitted
   RAW, so a server string routed through innerHTML goes red.
     1  malicious registration fields render as inert text
     2  not deployed → "not available yet" (never "none waiting"); denied → "no access"; empty stated
     3  Accept / Not accepted: result shown ONLY after the server's ok:true; rejecting needs a note;
        server errors keep the row actionable
     4  wording never claims a licence is "verified"
     5  both consoles wire ONE module through their own transport
   ========================================================================= */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
const MODULE = path.resolve(process.argv[2] || path.join(ROOT, 'sokoni-admin-partner-registrations.js'));
let pass = 0, fail = 0;
const ck = (label, ok, detail) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (!ok && detail ? '   [' + String(detail).slice(0, 200) + ']' : '')); ok ? pass++ : fail++; };

const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => escText(s).replace(/"/g, '&quot;');
class Text { constructor(t) { this.nodeType = 3; this.data = String(t); } }
class El {
  constructor(tag) { this.nodeType = 1; this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.listeners = {}; this.raw = null; this.disabled = false; this.value = ''; }
  appendChild(c) { this.children.push(c); return c; }
  insertBefore(c, ref) { const i = this.children.indexOf(ref); if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'value') this.value = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  fire(t, ev) { (this.listeners[t] || []).forEach((f) => f.call(this, Object.assign({ target: this }, ev || {}))); }
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
const byPr = (root, key) => find(root, (e) => e.attrs['data-pr'] === key)[0];
const allPr = (root, key) => find(root, (e) => e.attrs['data-pr'] === key);
function load() {
  const window = {};
  const sandbox = { window, document: { createElement: (t) => new El(t), createTextNode: (t) => new Text(t) }, console, Promise, Date, WeakMap, Object, Array, String, Number, parseInt, isFinite, Math, JSON, RegExp, Error };
  window.document = sandbox.document;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(MODULE, 'utf8'), sandbox, { filename: path.basename(MODULE) });
  return window.SokoniAdminPartnerRegistrations;
}
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };
async function mountWith(impl) {
  const api = load(), host = new El('div'), calls = [];
  api.mount(host, { console: 'aos', call: (name, data) => { calls.push({ name, data }); return impl(name, data); } });
  await flush();
  return { host, calls, html: () => ser(host), status: () => (byPr(host, 'status') || {}).textContent || '' };
}
const ROW = (o) => Object.assign({ partnerUid: 'saccoA', regulator: 'SASRA', registeredName: 'Sacco A Ltd', registrationNumber: 'SASRA/DT/123', kraPin: 'P051234567Z', validUntil: '2027-12-31', status: 'under_review', submittedAt: 1790000000000, reviewNote: null }, o);
const deferred = () => { let res, rej; const p = new Promise((a, b) => { res = a; rej = b; }); return { p, res, rej }; };

(async () => {
  console.log('\nPARTNER REGISTRATIONS VIEW — executed behaviour (' + path.relative(ROOT, MODULE) + ')');

  /* 1 */
  {
    const r = await mountWith(() => Promise.resolve({ rows: [ROW({ registeredName: '<img src=x onerror="alert(1)">Evil', registrationNumber: '"><script>x()</script>' })] }));
    ck('1a lists via financialPartnerDispatch adminListRegistrations, status under_review', r.calls[0].name === 'financialPartnerDispatch' && r.calls[0].data.op === 'adminListRegistrations' && r.calls[0].data.status === 'under_review', JSON.stringify(r.calls[0]));
    ck('1b malicious name / number are inert text', !/<img\b/i.test(r.html()) && !/<script\b/i.test(r.html()) && /&lt;img src=x/.test(r.html()), r.html().slice(0, 300));
    ck('1c observed state, one Accept + one Not accepted per waiting row', r.host.attrs['data-pr-state'] === 'observed' && allPr(r.host, 'verify').length === 1 && allPr(r.host, 'reject').length === 1);
  }
  /* 2 */
  {
    const a = await mountWith(() => Promise.reject({ code: 'functions/not-found' }));
    const b = await mountWith(() => Promise.reject({ code: 'functions/permission-denied' }));
    const c = await mountWith(() => Promise.resolve({ rows: [] }));
    const d = await mountWith(() => Promise.resolve({ nope: 1 }));
    ck('2a not deployed → "not available yet", evidence unreadable (never "none waiting")', a.status() === 'Partner registrations not available yet' && byPr(a.host, 'evidence').attrs['data-evidence'] === 'unreadable', a.status());
    ck('2b denied → "You do not have access"', b.status() === 'You do not have access');
    ck('2c empty → "No registrations waiting for review", evidence empty', c.status() === 'No registrations waiting for review' && byPr(c.host, 'evidence').attrs['data-evidence'] === 'empty', c.status());
    ck('2d malformed response → error, not empty', d.host.attrs['data-pr-state'] === 'error');
  }
  /* 3 */
  {
    const dd = deferred();
    const r = await mountWith((name, data) => data.op === 'adminListRegistrations' ? Promise.resolve({ rows: [ROW()] }) : dd.p);
    const tr = find(r.host, (e) => e.attrs['data-pr-row'] === 'saccoA')[0];
    byPr(r.host, 'reject').fire('click');
    await flush();
    ck('3a rejecting without a note is refused locally — no call', r.calls.filter((c) => c.data.op === 'adminReviewRegistration').length === 0 && /note/.test(byPr(r.host, 'row-msg').textContent));
    byPr(r.host, 'verify').fire('click');
    await flush();
    const rev = r.calls.filter((c) => c.data.op === 'adminReviewRegistration');
    ck('3b Accept sends verdict verified for that partner; row in flight, nothing claimed yet', rev.length === 1 && rev[0].data.verdict === 'verified' && rev[0].data.partnerUid === 'saccoA' && tr.attrs['data-pr-result'] === 'in-flight' && byPr(r.host, 'row-msg').textContent === 'Saving…');
    dd.res({ ok: true, status: 'verified' });
    await flush();
    ck('3c "Accepted" only after ok:true; buttons gone', tr.attrs['data-pr-result'] === 'verified' && byPr(r.host, 'row-msg').textContent === 'Accepted' && byPr(r.host, 'verify').hidden);
    const r2 = await mountWith((name, data) => data.op === 'adminListRegistrations' ? Promise.resolve({ rows: [ROW()] }) : Promise.reject({ code: 'functions/failed-precondition' }));
    find(r2.host, (e) => e.tagName === 'TEXTAREA')[0].value = 'number not on SASRA register';
    byPr(r2.host, 'reject').fire('click');
    await flush();
    ck('3d server refusal shown with meaning; row stays actionable', /Already reviewed/.test(byPr(r2.host, 'row-msg').textContent) && !byPr(r2.host, 'verify').disabled, byPr(r2.host, 'row-msg').textContent);
    const r3 = await mountWith((name, data) => data.op === 'adminListRegistrations' ? Promise.resolve({ rows: [ROW()] }) : Promise.resolve({}));
    byPr(r3.host, 'verify').fire('click');
    await flush();
    ck('3e a reply without ok:true is NOT shown as accepted', byPr(r3.host, 'row-msg').textContent === 'The server did not confirm the review');
    const r4 = await mountWith(() => Promise.resolve({ rows: [ROW({ status: 'verified' })] }));
    ck('3f an already-decided row has no review buttons', allPr(r4.host, 'verify').length === 0);
  }
  /* 4 */
  const src = fs.readFileSync(MODULE, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const userStrings = (src.match(/'[^'\n]*'/g) || []).filter((s) => /[A-Z][a-z]/.test(s));
  ck('4 no user-facing string claims a licence is "Verified"', !userStrings.some((s) => /\bVerified\b|\bverify\b(?! )/i.test(s) && !/verdict|'verified'|data-pr/.test(s)), userStrings.filter((s) => /verif/i.test(s)).join(' | '));
  /* 5 */
  const aosHtml = fs.readFileSync(path.join(ROOT, 'admin-os.html'), 'utf8');
  const saHtml = fs.readFileSync(path.join(ROOT, 'super-admin.html'), 'utf8');
  const aosJs = fs.readFileSync(path.join(ROOT, 'sokoni-aos.js'), 'utf8');
  ck('5a AdminOS: nav button (inline onclick + nav-label), panel, script, router entry',
    /data-section="partner-registrations"[^>]*onclick="SokoniAOS\.navigate\('partner-registrations'\);_closeSidebar\(\)"><span class="nav-icon">[^<]*<\/span><span class="nav-label">Partner registrations<\/span>/.test(aosHtml)
    && /id="panel-partner-registrations"/.test(aosHtml) && /<script src="sokoni-admin-partner-registrations\.js"><\/script>/.test(aosHtml)
    && /"partner-registrations": \(\) => _loadPartnerRegistrations\(\)/.test(aosJs) && /SokoniAdminPartnerRegistrations\.mount\(body, \{ console: "aos", call: \(name, data\) => _call\(name, data\) \}\)/.test(aosJs));
  ck('5b Super Admin: nav button, panel, script, section switch, mount with its own transport',
    /onclick="SA\.nav\('partner-registrations'\);_closeSidebar\(\)"/.test(saHtml) && /id="panel-partner-registrations"/.test(saHtml)
    && /<script src="sokoni-admin-partner-registrations\.js"><\/script>/.test(saHtml) && /section==='partner-registrations'\)this\.loadPartnerRegistrations\(\)/.test(saHtml)
    && /SokoniAdminPartnerRegistrations\.mount\(body,\{console:'sa'/.test(saHtml));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
