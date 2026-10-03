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
     6  verdicts approved / needs_information / rejected, filters, Revoke review, Record licence check
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
    ck('1c observed state, one Approve + one Needs information + one Reject per waiting row', r.host.attrs['data-pr-state'] === 'observed' && allPr(r.host, 'approve').length === 1 && allPr(r.host, 'needs_information').length === 1 && allPr(r.host, 'reject').length === 1);
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
    byPr(r.host, 'approve').fire('click');
    await flush();
    const rev = r.calls.filter((c) => c.data.op === 'adminReviewRegistration');
    ck('3b Approve sends verdict approved (contract 2026-10-03) for that partner, no note; row in flight, nothing claimed yet', rev.length === 1 && rev[0].data.verdict === 'approved' && !('note' in rev[0].data) && rev[0].data.partnerUid === 'saccoA' && tr.attrs['data-pr-result'] === 'in-flight' && byPr(r.host, 'row-msg').textContent === 'Saving…');
    dd.res({ ok: true, status: 'approved' });
    await flush();
    ck('3c the badge outcome only after ok:true; buttons gone', tr.attrs['data-pr-result'] === 'approved' && byPr(r.host, 'row-msg').textContent === 'Approved — badge “Registration reviewed by SOKONI” granted' && byPr(r.host, 'approve').hidden, byPr(r.host, 'row-msg').textContent);
    const r2 = await mountWith((name, data) => data.op === 'adminListRegistrations' ? Promise.resolve({ rows: [ROW()] }) : Promise.reject({ code: 'functions/failed-precondition' }));
    find(r2.host, (e) => e.tagName === 'TEXTAREA')[0].value = 'number not on SASRA register';
    byPr(r2.host, 'reject').fire('click');
    await flush();
    ck('3d server refusal shown with meaning; row stays actionable', /Already reviewed/.test(byPr(r2.host, 'row-msg').textContent) && !byPr(r2.host, 'approve').disabled, byPr(r2.host, 'row-msg').textContent);
    const r3 = await mountWith((name, data) => data.op === 'adminListRegistrations' ? Promise.resolve({ rows: [ROW()] }) : Promise.resolve({}));
    byPr(r3.host, 'approve').fire('click');
    await flush();
    ck('3e a reply without ok:true is NOT shown as approved', byPr(r3.host, 'row-msg').textContent === 'The server did not confirm this');
    const r4 = await mountWith(() => Promise.resolve({ rows: [ROW({ status: 'approved' })] }));
    ck('3f an already-decided row has no review buttons', allPr(r4.host, 'approve').length === 0 && allPr(r4.host, 'reject').length === 0);
  }
  /* 6 — verdicts, filters, revoke, licence check (contract addendum 2026-10-03) */
  {
    const opts = (host) => find(byPr(host, 'filter'), (e) => e.tagName === 'OPTION').map((o) => o.attrs.value);
    const r0 = await mountWith(() => Promise.resolve({ rows: [] }));
    ck('6a filter options: under_review, approved, needs_information, rejected', opts(r0.host).join() === 'under_review,approved,needs_information,rejected', opts(r0.host).join());
    byPr(r0.host, 'filter').value = 'needs_information'; byPr(r0.host, 'filter').fire('change'); await flush();
    ck('6b changing the filter lists that status', r0.calls[r0.calls.length - 1].data.status === 'needs_information' && r0.status() === 'No registrations marked needs information', r0.status());
    let next = () => Promise.resolve({ ok: true, status: 'needs_information' });
    const r = await mountWith((name, data) => data.op === 'adminListRegistrations' ? Promise.resolve({ rows: [ROW()] }) : next(data));
    const reviews = () => r.calls.filter((c) => c.data.op === 'adminReviewRegistration');
    byPr(r.host, 'needs_information').fire('click'); await flush();
    ck('6c Needs information without a note → refused locally', reviews().length === 0 && /required unless you approve/.test(byPr(r.host, 'row-msg').textContent));
    byPr(r.host, 'note').value = 'Upload the SASRA licence page link';
    byPr(r.host, 'needs_information').fire('click'); await flush();
    ck('6d Needs information → {verdict:needs_information, note}; outcome after ok', reviews().length === 1 && reviews()[0].data.verdict === 'needs_information' && reviews()[0].data.note === 'Upload the SASRA licence page link' && byPr(r.host, 'row-msg').textContent === 'Asked the partner for more information');
    const rj = await mountWith((name, data) => data.op === 'adminListRegistrations' ? Promise.resolve({ rows: [ROW()] }) : Promise.resolve({ ok: true, status: 'rejected' }));
    byPr(rj.host, 'note').value = 'Number not on the register';
    byPr(rj.host, 'reject').fire('click'); await flush();
    const rjc = rj.calls[rj.calls.length - 1];
    ck('6e Reject → {verdict:rejected, note}', rjc.data.verdict === 'rejected' && rjc.data.note === 'Number not on the register' && byPr(rj.host, 'row-msg').textContent === 'Marked not accepted');

    let rv = () => Promise.resolve({ ok: true, status: 'rejected' });
    const ra = await mountWith((name, data) => data.op === 'adminListRegistrations' ? Promise.resolve({ rows: [ROW({ status: 'approved' }), ROW({ partnerUid: 'u2', status: 'under_review' })] }) : rv(data));
    const row = (id) => find(ra.host, (e) => e.attrs['data-pr-row'] === id)[0];
    ck('6f Revoke review only on an approved row', !!byPr(row('saccoA'), 'revoke') && !byPr(row('u2'), 'revoke'));
    let n = ra.calls.length;
    byPr(row('saccoA'), 'revoke').fire('click'); await flush();
    ck('6g Revoke without a note → refused locally', ra.calls.length === n && /reason/.test(byPr(row('saccoA'), 'row-msg').textContent));
    rv = () => Promise.reject({ code: 'functions/failed-precondition', message: 'There is no approved review to revoke.' });
    byPr(row('saccoA'), 'revoke-note').value = 'Registration lapsed';
    byPr(row('saccoA'), 'revoke').fire('click'); await flush();
    let c = ra.calls[ra.calls.length - 1];
    ck('6h Revoke → adminRevokeReview {partnerUid, note}; server refusal shown verbatim, still actionable', c.data.op === 'adminRevokeReview' && c.data.partnerUid === 'saccoA' && c.data.note === 'Registration lapsed' && byPr(row('saccoA'), 'row-msg').textContent === 'There is no approved review to revoke.' && !byPr(row('saccoA'), 'revoke').disabled, byPr(row('saccoA'), 'row-msg').textContent);
    rv = () => Promise.resolve({ ok: true, status: 'rejected' });
    byPr(row('saccoA'), 'revoke').fire('click'); await flush();
    ck('6i revoke outcome only after ok', byPr(row('saccoA'), 'row-msg').textContent === 'Review revoked — badge “Registration reviewed by SOKONI” removed' && row('saccoA').attrs['data-pr-result'] === 'revoked');

    let lc = () => Promise.resolve({ ok: true, verificationStatus: 'verified_against_register' });
    const rl = await mountWith((name, data) => data.op === 'adminListRegistrations' ? Promise.resolve({ rows: [ROW({ status: 'needs_information' })] }) : lc(data));
    const form = byPr(rl.host, 'licence-form');
    ck('6j every row offers "Record licence check" (collapsed); helper text verbatim', !!byPr(rl.host, 'licence-open') && form.hidden && byPr(rl.host, 'lc-help').textContent === 'Register URL or register name + reference — not an uploaded document');
    byPr(rl.host, 'licence-open').fire('click');
    const statusOpts = find(byPr(rl.host, 'lc-status'), (e) => e.tagName === 'OPTION').map((o) => o.attrs.value).join();
    ck('6k opens; verificationStatus options match the contract', !form.hidden && statusOpts === 'verified_against_register,not_found_on_register,mismatch,cleared', statusOpts);
    const lcCalls = () => rl.calls.filter((x) => x.data.op === 'adminRecordLicenceCheck');
    byPr(rl.host, 'lc-submit').fire('click'); await flush();
    ck('6l missing fields → refused locally', lcCalls().length === 0 && /Fill in the licence type/.test(byPr(rl.host, 'lc-msg').textContent));
    byPr(rl.host, 'lc-type').value = 'Deposit-taking SACCO'; byPr(rl.host, 'lc-number').value = 'SASRA/DT/123'; byPr(rl.host, 'lc-authority').value = 'SASRA';
    byPr(rl.host, 'lc-source').value = 'uploaded document from the partner';
    byPr(rl.host, 'lc-submit').fire('click'); await flush();
    ck('6m an "uploaded document" source is refused locally', lcCalls().length === 0 && /not a document/.test(byPr(rl.host, 'lc-msg').textContent));
    byPr(rl.host, 'lc-source').value = 'https://www.sasra.go.ke/licensed-saccos ref 2026-123';
    byPr(rl.host, 'lc-expiry').value = '2027-12-31';
    byPr(rl.host, 'lc-submit').fire('click'); await flush();
    c = lcCalls()[0];
    ck('6n → adminRecordLicenceCheck {partnerUid, verificationStatus, licenceType, licenceNumber, issuingAuthority, expiryDate, verificationSource}',
      c && c.data.partnerUid === 'saccoA' && c.data.verificationStatus === 'verified_against_register' && c.data.licenceType === 'Deposit-taking SACCO' && c.data.licenceNumber === 'SASRA/DT/123' && c.data.issuingAuthority === 'SASRA' && c.data.expiryDate === '2027-12-31' && /^https:\/\/www\.sasra/.test(c.data.verificationSource), JSON.stringify(c && c.data));
    ck('6o outcome after ok: "Licence check recorded — Found on the register — details match"', byPr(rl.host, 'lc-msg').textContent === 'Licence check recorded — Found on the register — details match', byPr(rl.host, 'lc-msg').textContent);
    const rc = await mountWith((name, data) => data.op === 'adminListRegistrations' ? Promise.resolve({ rows: [ROW({ status: 'rejected' })] }) : Promise.resolve({ ok: true, verificationStatus: 'cleared' }));
    byPr(rc.host, 'lc-status').value = 'cleared';
    byPr(rc.host, 'lc-submit').fire('click'); await flush();
    const cc = rc.calls[rc.calls.length - 1];
    ck('6p "cleared" sends only {partnerUid, verificationStatus:cleared}', cc.data.op === 'adminRecordLicenceCheck' && cc.data.verificationStatus === 'cleared' && Object.keys(cc.data).sort().join() === 'op,partnerUid,verificationStatus', JSON.stringify(cc.data));
    ck('6q wording: badge granted by Approve; licence checks separate', /Approve grants the public badge “Registration reviewed by SOKONI”/.test(rc.host.textContent) && /Licence checks are separate/.test(byPr(rc.host, 'licence-note').textContent));
    const rn = await mountWith(() => Promise.resolve({ rows: [ROW({ registeredName: 'x', partnerUid: 'p<"x' })] }));
    ck('6r licence form inputs are plain text controls (no server string in innerHTML)', !/<script/i.test(rn.html()));
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
