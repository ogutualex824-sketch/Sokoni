#!/usr/bin/env node
/* ============================================================================
   Payout approvals view — EXECUTED behaviour + console wiring
   ============================================================================
   Run:  node scripts/test-admin-payout-approvals.js [path/to/sokoni-admin-payout-approvals.js]

   Modelled on scripts/test-admin-failures.js. Loads the module in a vm with a
   small fake DOM, mounts it with a fake `call`, and serialises the tree the way
   a browser would: text nodes are escaped, innerHTML is emitted RAW — so a
   module that routes a server string through innerHTML goes red.
   (Positive controls: point the optional argument at a copy whose h() helper
   uses innerHTML, or that shows "Approved" before the call resolves — red.)

   It proves, by execution:
     1. a malicious sellerUid / id renders as inert text
     2. a collection in `unreadable` reads "could not be read", never "nothing pending"
     3. not-found / unavailable / internal → "Payout approvals not available yet"
     4. empty → "No payouts awaiting approval"; permission-denied → "You do not have access"
     5. amountKES null → "—", never 0
     6. approve: confirmation is required; "Approved" appears ONLY after the call
        resolves; already:true → "Already approved"; self-approval and
        failed-precondition errors are shown with their meaning
   and statically that both consoles wire ONE module.
   No browser, no network, no Firebase.
   ========================================================================= */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const MODULE = path.resolve(process.argv[2] || path.join(ROOT, 'sokoni-admin-payout-approvals.js'));

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (!ok && detail ? '   [' + String(detail).slice(0, 160) + ']' : ''));
  ok ? pass++ : fail++;
};

/* ── fake DOM (same as test-admin-failures.js, plus focus + event payloads) ─ */
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
  fire(t, ev) { (this.listeners[t] || []).forEach((f) => f.call(this, Object.assign({ target: this }, ev || {}))); }
  focus() { this.focused = true; }
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
const byPa = (root, key) => find(root, (e) => e.attrs['data-pa'] === key)[0];
const allPa = (root, key) => find(root, (e) => e.attrs['data-pa'] === key);

function load() {
  const window = {};
  const sandbox = { window, document: { createElement: (t) => new El(t), createTextNode: (t) => new Text(t) }, console, Promise, Date, WeakMap, Object, Array, String, Number, parseInt, isFinite, Math, JSON, RegExp, Error };
  window.document = sandbox.document;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(MODULE, 'utf8'), sandbox, { filename: path.basename(MODULE) });
  return window.SokoniAdminPayoutApprovals;
}
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };

async function mountWith(callImpl) {
  const api = load();
  const host = new El('div');
  const calls = [];
  api.mount(host, { console: 'aos', call: (name, data) => { calls.push({ name, data }); return callImpl(name, data); } });
  await flush();
  return { api, host, calls, html: ser(host), status: (byPa(host, 'status') || {}).textContent || '' };
}

const MALICIOUS_UID = '<img src=x onerror="alert(1)">sellerXYZ';
const MALICIOUS_ID = '"><script>steal()</script>';
const ROW = (o) => Object.assign({ collection: 'deliveries', id: 'del_1', status: 'delivered', sellerUid: 'sellerUid12345', buyerUid: 'buyer1', amountKES: 1500, completedAt: '2026-10-01T06:00:00Z' }, o);
const deferred = () => { let res, rej; const p = new Promise((a, b) => { res = a; rej = b; }); return { p, res, rej }; };
const approvals = (r) => r.calls.filter((c) => c.name === 'adminApproveSellerPayout');

(async () => {
  console.log('\nPAYOUT APPROVALS VIEW — executed behaviour (' + path.relative(ROOT, MODULE) + ')');
  console.log('='.repeat(78));

  /* 1 + 5 — observed rows, escaping, null amount */
  {
    const r = await mountWith(() => Promise.resolve({
      pending: [ROW({ sellerUid: MALICIOUS_UID, id: MALICIOUS_ID }), ROW({ collection: 'orders', id: 'ord_9', status: 'completed', amountKES: null, completedAt: null })],
      count: 2, truncated: false, unreadable: [],
    }));
    ck('calls adminListPendingSellerPayouts with limit 100 and no collection', r.calls[0] && r.calls[0].name === 'adminListPendingSellerPayouts' && r.calls[0].data.limit === 100 && !('collection' in r.calls[0].data), JSON.stringify(r.calls));
    ck('malicious sellerUid is inert text — no live <img>', !/<img\b/i.test(r.html) && /&lt;img src=x onerror=/.test(r.html), r.html.slice(0, 300));
    ck('malicious item id is inert text — no live <script>, cannot break out of its cell', !/<script\b/i.test(r.html) && r.html.includes('"&gt;&lt;script&gt;steal()&lt;/script&gt;'));
    ck('state observed, evidence "observed", headline from server rows', r.host.attrs['data-pa-state'] === 'observed' && byPa(r.host, 'evidence').attrs['data-evidence'] === 'observed' && r.status === '2 payouts awaiting approval', r.status);
    const amounts = allPa(r.host, 'amount').map((e) => e.textContent);
    ck('amount 1500 → "KES 1,500"; null → "—" (never 0)', /^KES 1,?500$/.test(amounts[0]) && amounts[1] === '—' && !/KES 0\b/.test(r.html), amounts.join(' | '));
    ck('null completedAt renders "—"', find(r.host, (e) => e.tagName === 'TIME')[1].textContent === '—');
    ck('seller uid is shortened in the cell (full value only in title)', r.html.includes('>seller…<') && !r.html.includes('>sellerUid12345<') && find(r.host, (e) => e.tagName === 'TR' && e.attrs['data-pa-row']).length === 2);
    ck('one Approve button per row, table inside an overflow-x scroller', allPa(r.host, 'approve').length === 2 && byPa(r.host, 'table-wrap').className === 'sk-pa-scroll' && !byPa(r.host, 'table-wrap').hidden);
    ck('status text sits in a role=status aria-live region', byPa(r.host, 'status').attrs.role === 'status' && byPa(r.host, 'status').attrs['aria-live'] === 'polite');
    ck('note field is labelled and capped at 300', byPa(r.host, 'note').attrs.maxlength === '300' && find(r.host, (e) => e.tagName === 'LABEL' && e.children.includes(byPa(r.host, 'note'))).length === 1);
  }

  /* 2 — unreadable collections */
  {
    const r = await mountWith(() => Promise.resolve({ pending: [], count: 0, truncated: false, unreadable: ['orders'] }));
    ck('empty + one unreadable collection → NOT "No payouts awaiting approval"', r.status !== 'No payouts awaiting approval' && r.host.attrs['data-pa-state'] === 'partial', r.status);
    ck('  …the unreadable collection reads "Could not be read"', byPa(r.host, 'col-orders').textContent === 'Could not be read' && /could not be read/.test(byPa(r.host, 'detail').textContent));
    ck('  …readable collections say "Nothing awaiting approval"; overall evidence unreadable', byPa(r.host, 'col-deliveries').textContent === 'Nothing awaiting approval' && byPa(r.host, 'evidence').attrs['data-evidence'] === 'unreadable');
    const r2 = await mountWith(() => Promise.resolve({ pending: [], count: 0, truncated: false, unreadable: ['packageRequests', 'deliveries', 'orders'] }));
    ck('all collections unreadable → "Pending payouts could not be read"', r2.status === 'Pending payouts could not be read', r2.status);
    const r3 = await mountWith(() => Promise.resolve({ pending: [ROW()], count: 1, truncated: false, unreadable: ['packageRequests'] }));
    ck('rows + an unreadable collection → rows shown AND "could not be read" stated', r3.status === '1 payout awaiting approval' && byPa(r3.host, 'col-packageRequests').textContent === 'Could not be read' && !byPa(r3.host, 'detail').hidden);
  }

  /* 3 — not deployed */
  for (const code of ['functions/not-found', 'unavailable', 'functions/internal']) {
    const r = await mountWith(() => Promise.reject({ code }));
    ck('list error ' + code + ' → "Payout approvals not available yet"', r.status === 'Payout approvals not available yet' && !/No payouts awaiting approval/.test(r.html) && byPa(r.host, 'table-wrap').hidden && byPa(r.host, 'evidence').attrs['data-evidence'] === 'unreadable', r.status);
  }

  /* 4 — empty / filter / refresh / denied / malformed */
  {
    const r = await mountWith(() => Promise.resolve({ pending: [], count: 0, truncated: false, unreadable: [] }));
    ck('successful empty result → "No payouts awaiting approval" (evidence empty)', r.status === 'No payouts awaiting approval' && byPa(r.host, 'evidence').attrs['data-evidence'] === 'empty', r.status);
    const sel = byPa(r.host, 'collection'); sel.value = 'orders'; sel.fire('change'); await flush();
    ck('  …collection filter re-queries with {collection:"orders"}; others "Not in this filter"', r.calls[r.calls.length - 1].data.collection === 'orders' && byPa(r.host, 'col-deliveries').textContent === 'Not in this filter');
    const n = r.calls.length; byPa(r.host, 'refresh').fire('click'); await flush();
    ck('  …Refresh re-reads', r.calls.length === n + 1);
    const d = await mountWith(() => Promise.reject({ code: 'functions/permission-denied' }));
    ck('list permission-denied → "You do not have access"', d.status === 'You do not have access', d.status);
    const m = await mountWith(() => Promise.resolve({ nope: true }));
    ck('malformed response → unreadable, never empty', m.host.attrs['data-pa-state'] === 'error' && !/No payouts awaiting approval/.test(m.html));
  }

  /* 6 — approve flow */
  async function approveScenario(approveImpl) {
    const pend = deferred();
    const r = await mountWith((name, data) => name === 'adminListPendingSellerPayouts'
      ? Promise.resolve({ pending: [ROW()], count: 1, truncated: false, unreadable: [] })
      : (approveImpl ? approveImpl(data) : pend.p));
    const tr = find(r.host, (e) => e.tagName === 'TR' && e.attrs['data-pa-row'])[0];
    return { r, tr, pend, msg: () => byPa(tr, 'row-msg').textContent };
  }
  async function confirmWith(approveImpl) {
    const s = await approveScenario(approveImpl);
    byPa(s.tr, 'approve').fire('click'); byPa(s.tr, 'confirm').fire('click'); await flush();
    return s;
  }
  {
    const s = await approveScenario(null);
    const approve = byPa(s.tr, 'approve');
    approve.fire('click'); await flush();
    ck('Approve does NOT call the server — it opens a confirmation step', approvals(s.r).length === 0 && !byPa(s.tr, 'confirm-box').hidden && approve.hidden);
    byPa(s.tr, 'cancel').fire('click'); await flush();
    ck('Cancel closes the confirmation without calling', byPa(s.tr, 'confirm-box').hidden && !approve.hidden && approvals(s.r).length === 0);
    approve.fire('click'); byPa(s.tr, 'note').value = '  checked POD  '; byPa(s.tr, 'confirm').fire('click'); await flush();
    const ac = approvals(s.r);
    ck('Confirm calls adminApproveSellerPayout once with {collection,id,note(trimmed)}', ac.length === 1 && ac[0].data.collection === 'deliveries' && ac[0].data.id === 'del_1' && ac[0].data.note === 'checked POD', JSON.stringify(ac));
    ck('while in flight: confirm + Refresh disabled, NO success shown', byPa(s.tr, 'confirm').disabled === true && byPa(s.r.host, 'refresh').disabled === true && !/Approved/.test(s.msg()) && s.tr.attrs['data-pa-result'] === 'in-flight', s.msg());
    byPa(s.tr, 'confirm').fire('click'); await flush();
    ck('a second click while in flight sends no second approval', approvals(s.r).length === 1);
    s.pend.res({ ok: true, already: false }); await flush();
    ck('after the server resolves ok:true → "Approved", row marked, controls gone', s.msg() === 'Approved' && s.tr.attrs['data-pa-result'] === 'approved' && approve.hidden && byPa(s.tr, 'confirm-box').hidden && byPa(s.r.host, 'refresh').disabled === false, s.msg());
  }
  {
    const s = await confirmWith(() => Promise.resolve({ ok: true, already: true }));
    ck('already:true → "Already approved"', s.msg() === 'Already approved' && s.tr.attrs['data-pa-result'] === 'already', s.msg());
  }
  {
    const s = await confirmWith(() => Promise.resolve({ ok: false }));
    ck('a response without ok:true is NOT success', !/Approved/.test(s.msg()) && s.tr.attrs['data-pa-result'] === 'error', s.msg());
  }
  {
    const s = await confirmWith(() => Promise.reject({ code: 'functions/permission-denied', message: 'You cannot approve a payout to yourself.' }));
    ck('self-approval → "You cannot approve a payout to yourself"; Approve available again', s.msg() === 'You cannot approve a payout to yourself' && !byPa(s.tr, 'approve').hidden && s.tr.attrs['data-pa-result'] === 'error', s.msg());
  }
  {
    const s = await confirmWith(() => Promise.reject({ code: 'functions/permission-denied', message: 'Admin only.' }));
    ck('non-admin permission-denied → "You do not have permission to approve payouts"', s.msg() === 'You do not have permission to approve payouts', s.msg());
  }
  {
    const s = await confirmWith(() => Promise.reject({ code: 'failed-precondition' }));
    ck('failed-precondition → "Not delivered yet"', s.msg() === 'Not delivered yet', s.msg());
  }
  {
    const s = await confirmWith(() => Promise.reject({ code: 'functions/unavailable' }));
    ck('approve unavailable → "Payout approvals not available yet"', s.msg() === 'Payout approvals not available yet', s.msg());
  }

  /* ── static wiring ──────────────────────────────────────────────────────── */
  console.log('\nPAYOUT APPROVALS VIEW — console wiring (static)');
  console.log('='.repeat(78));
  const aos = fs.readFileSync(path.join(ROOT, 'admin-os.html'), 'utf8');
  const aosJs = fs.readFileSync(path.join(ROOT, 'sokoni-aos.js'), 'utf8');
  const sa = fs.readFileSync(path.join(ROOT, 'super-admin.html'), 'utf8');
  const AFTER_FAILURES = /data-section="failures"[^>]*>[\s\S]*?<\/button>\s*<button[^>]*data-section="payout-approvals"/;
  const aosBtn = (aos.match(/<button[^>]*data-section="payout-approvals"[^>]*>[\s\S]*?<\/button>/g) || []);
  ck('admin-os: exactly one Payout approvals button, icon then .nav-label, inline onclick',
    aosBtn.length === 1 && /<span class="nav-icon">[^<]*<\/span><span class="nav-label">Payout approvals<\/span>/.test(aosBtn[0]) && /onclick="SokoniAOS\.navigate\('payout-approvals'\);_closeSidebar\(\)"/.test(aosBtn[0]), aosBtn.join(' | '));
  const opsGroup = (aos.match(/<div class="nav-group-label">Operations<\/div>([\s\S]*?)<\/div>/) || [])[1] || '';
  ck('admin-os: placed DIRECTLY after the Failures button, in the Operations group', AFTER_FAILURES.test(opsGroup));
  ck('admin-os: one #panel-payout-approvals + module + stylesheet loaded before sokoni-aos.js',
    (aos.match(/id="panel-payout-approvals"/g) || []).length === 1 && aos.indexOf('<script src="sokoni-admin-payout-approvals.js"></script>') > 0 && aos.indexOf('<script src="sokoni-admin-payout-approvals.js"></script>') < aos.indexOf('<script src="sokoni-aos.js">') && /href="sokoni-admin-payout-approvals\.css"/.test(aos));
  ck('sokoni-aos.js: registered in the EXISTING _loadPanel router; mounts the shared module with _call',
    /failures:\s*\(\)\s*=>\s*_loadFailures\(\),\s*"payout-approvals":\s*\(\)\s*=>\s*_loadPayoutApprovals\(\)/.test(aosJs) && /SokoniAdminPayoutApprovals\.mount\(body,\s*\{\s*console:\s*"aos",\s*call:\s*\(name, data\)\s*=>\s*_call\(name, data\)/.test(aosJs));
  const saBtn = (sa.match(/<button[^>]*data-section="payout-approvals"[^>]*>[\s\S]*?<\/button>/g) || []);
  ck('super-admin: exactly one nav button with .nav-label, inline onclick SA.nav, after Failures',
    saBtn.length === 1 && /<span class="nav-label">Payout approvals<\/span>/.test(saBtn[0]) && /onclick="SA\.nav\('payout-approvals'\);_closeSidebar\(\)"/.test(saBtn[0]) && AFTER_FAILURES.test(sa), saBtn.join(' | '));
  ck('super-admin: native #panel-payout-approvals opened by SA.nav → loadPayoutApprovals',
    (sa.match(/id="panel-payout-approvals"/g) || []).length === 1 && /section==='payout-approvals'\)this\.loadPayoutApprovals\(\)/.test(sa) && /SokoniAdminPayoutApprovals\.mount\(body,\{console:'sa',call:\(name,data\)=>fns\.httpsCallable\(name\)/.test(sa)
    && /<script src="sokoni-admin-payout-approvals\.js"><\/script>/.test(sa) && /href="sokoni-admin-payout-approvals\.css"/.test(sa));
  ck('super-admin: no #hash-on-load handler added', !/location\.hash/.test(sa.split('loadPayoutApprovals(){')[1] || '') && !/this\.nav\(_ok\?/.test(sa));
  ck('ONE module: no console carries its own copy (callable names / table class only in the module)',
    [aos, sa, aosJs].every((src) => !/['"]adminApproveSellerPayout['"]/.test(src) && !/['"]adminListPendingSellerPayouts['"]/.test(src) && !/sk-pa-table/.test(src)));

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH (not a pass):', e); process.exit(2); });
