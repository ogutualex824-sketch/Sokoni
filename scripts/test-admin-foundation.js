#!/usr/bin/env node
/* ============================================================================
   SOKONI Foundation workspace — EXECUTED behaviour + console wiring
   Run:  node scripts/test-admin-foundation.js [path/to/module]
   Same fake-DOM method as test-admin-payout-approvals.js / test-admin-partner-registrations.js:
   text nodes are escaped, innerHTML is emitted RAW, so a server string routed through innerHTML goes red.
     1  malicious server strings render as inert text (donations, support payments, stories)
     2  not deployed → "not available yet", evidence unreadable — never "none" / 0
     3  null counts / null balance → "—"; a real 0 stays 0
     4  an overview count opens the filtered list with the right call; tabs are lazy + keyboard accessible
     5  disbursement chain: right callable + payload per action, gated by status, result only after ok
     6  "Sent" never appears
     7  New support payment: requestId generated once per open and reused on a retried submit
     8  manual-rail copy; refund prefill from a completed donation
     9  stories: server refusal shown, notes required, Published vs Approved-not-published, consent
    10  story form: no uploader → text-only; uploader path + type checks; upload failure blocks save
    11  partner promotions; 12 reconciliation; 13 both consoles wire ONE module
   ========================================================================= */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), nodeCrypto = require('crypto');
const ROOT = path.join(__dirname, '..');
const MODULE = path.resolve(process.argv[2] || path.join(ROOT, 'sokoni-admin-foundation.js'));
let pass = 0, fail = 0;
const ck = (label, ok, detail) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (!ok && detail ? '   [' + String(detail).slice(0, 240) + ']' : '')); ok ? pass++ : fail++; };

const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => escText(s).replace(/"/g, '&quot;');
class Text { constructor(t) { this.nodeType = 3; this.data = String(t); } }
class El {
  constructor(tag) { this.nodeType = 1; this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.listeners = {}; this.raw = null; this.disabled = false; this.value = ''; this.checked = false; this.files = []; }
  appendChild(c) { this.children.push(c); return c; }
  insertBefore(c, ref) { const i = this.children.indexOf(ref); if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'value') this.value = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  fire(t, ev) { (this.listeners[t] || []).forEach((f) => f.call(this, Object.assign({ target: this, preventDefault() {} }, ev || {}))); }
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
/* Visible = no hidden ancestor (tabs keep hidden panels in the tree). */
function findVisible(n, pred, out = []) { if (n.nodeType === 1 && !n.hidden) { if (pred(n)) out.push(n); n.children.forEach((c) => findVisible(c, pred, out)); } return out; }
const byFd = (root, key) => findVisible(root, (e) => e.attrs['data-fd'] === key)[0];
const allFd = (root, key) => findVisible(root, (e) => e.attrs['data-fd'] === key);
const rowOf = (root, id) => find(root, (e) => e.attrs['data-fd-row'] === id)[0];
const tab = (root, key) => find(root, (e) => e.attrs['data-fd-tab'] === key)[0];

let uuidCount = 0;
function load(opts) {
  const window = {};
  window.crypto = (opts && opts.noCrypto) ? undefined : { randomUUID: () => { uuidCount++; return nodeCrypto.randomUUID(); }, getRandomValues: (a) => nodeCrypto.randomFillSync(a) };
  const sandbox = { window, document: { createElement: (t) => new El(t), createTextNode: (t) => new Text(t) }, console, Promise, Date, WeakMap, Object, Array, String, Number, parseInt, isFinite, Math, JSON, RegExp, Error, Uint8Array };
  window.document = sandbox.document;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(MODULE, 'utf8'), sandbox, { filename: path.basename(MODULE) });
  return window.SokoniAdminFoundation;
}
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
const RENDERED = [];
async function mountWith(impl, extra) {
  const api = load(extra), host = new El('div'), calls = [];
  const opts = Object.assign({ console: 'aos', call: (name, data) => { calls.push({ name, data: JSON.parse(JSON.stringify(data)) }); return impl(name, data); } }, extra || {});
  api.mount(host, opts);
  await flush();
  RENDERED.push(host);
  return { host, calls, html: () => ser(host), go: async (k) => { tab(host, k).fire('click'); await flush(); } };
}
const deferred = () => { let res, rej; const p = new Promise((a, b) => { res = a; rej = b; }); return { p, res, rej }; };
const SUMMARY = { balance: { balance: 12000, reserved: 2000, available: 10000, totalReceived: 15000, totalDisbursed: 3000, totalFees: 150 }, donations: { completed: 4, pledged: 2, failed: 1, review: 0, refunded: 0 }, disbursements: { pendingApproval: 1, pendingAuthorization: 1, processing: 0, awaitingConfirmation: 0, completed: 2, failed: 0 } };
const DIS = (o) => Object.assign({ id: 'd1', amount: 500, beneficiaryName: 'Mama Mboga Group', description: 'School fees', destinationType: 'MPESA', destination: { phone: '2547****678' }, status: 'pending_approval', createdAt: 1790000000000 }, o);
const DON = (o) => Object.assign({ id: 'p1', amount: 1000, gross: 1000, fee: 30, net: 970, programmeId: 'edu', purpose: 'EDUCATION', donor: 'A. Donor', receiptId: 'SKF-1', providerRef: 'IS123', status: 'completed', completedAt: 1790000000000 }, o);
const STORY = (o) => Object.assign({ id: 's1', kind: 'story', title: 'Water for Kibera', status: 'pending', displayName: 'Media House', programmeId: 'water', media: [], updatedAt: 1790000000000 }, o);
function router(map) { return (name, data) => { const k = name + (data && data.op ? ':' + data.op : '') + (data && data.view ? ':' + data.view : ''); const f = map[k] || map[name]; return f ? f(data) : Promise.reject({ code: 'functions/not-found' }); }; }

(async () => {
  console.log('\nSOKONI FOUNDATION VIEW — executed behaviour (' + path.relative(ROOT, MODULE) + ')');

  /* 1 — inert */
  {
    const EVIL = '<img src=x onerror="alert(1)">';
    const r = await mountWith(router({
      'impactAdminFoundationData:summary': () => Promise.resolve(SUMMARY),
      'foundationContentDispatch:adminCounts': () => Promise.resolve({ counts: { pending: 1 } }),
      'impactAdminFoundationData:donations': () => Promise.resolve({ rows: [DON({ donor: EVIL, programmeId: '"><script>x()</script>' })] }),
      'impactAdminFoundationData:disbursements': () => Promise.resolve({ rows: [DIS({ beneficiaryName: EVIL, description: '<script>y()</script>' })] }),
      'foundationContentDispatch:adminList': () => Promise.resolve({ rows: [STORY({ title: EVIL })] }),
    }));
    await r.go('donations'); await r.go('disbursements'); await r.go('stories');
    const html = r.html();
    ck('1a malicious donor / beneficiary / story title are inert text', !/<img\b/i.test(html) && !/<script\b/i.test(html) && /&lt;img src=x/.test(html), html.match(/<img|<script/i));
    ck('1b rows rendered from the server (donation, payment, story)', !!rowOf(r.host, 'p1') && !!rowOf(r.host, 'd1') && !!rowOf(r.host, 's1'));
  }

  /* 2 — not deployed */
  {
    const r = await mountWith(() => Promise.reject({ code: 'functions/not-found' }));
    ck('2a overview: "Foundation summary not available yet", evidence unreadable', byFd(r.host, 'ov-status').textContent === 'Foundation summary not available yet' && byFd(r.host, 'ov-evidence').attrs['data-evidence'] === 'unreadable', byFd(r.host, 'ov-status').textContent);
    ck('2b overview: no money tile and no count rendered as 0', !/>0</.test(r.html()) && !/KES 0\b/.test(r.html()));
    const out = {};
    for (const [k, p] of [['donations', 'don'], ['disbursements', 'dis'], ['stories', 'st'], ['promotions', 'pr']]) { await r.go(k); out[k] = byFd(r.host, p + '-status').textContent + '|' + byFd(r.host, p + '-evidence').attrs['data-evidence']; }
    ck('2c every list tab: "not available yet" + unreadable, never "No …"', Object.values(out).every((s) => /not available yet\|unreadable$/.test(s) && !/^No /.test(s)), JSON.stringify(out));
    const r2 = await mountWith((n) => Promise.reject({ code: n === 'impactAdminFoundationData' ? 'functions/internal' : 'functions/unavailable' }));
    ck('2d internal / unavailable also read as not deployed', /not available yet/.test(byFd(r2.host, 'ov-status').textContent) && /not available yet/.test(byFd(r2.host, 'ov-stories-status').textContent));
    const r3 = await mountWith(router({ 'impactAdminFoundationData:summary': () => Promise.reject({ code: 'functions/permission-denied' }), 'foundationContentDispatch:adminCounts': () => Promise.resolve({}) }));
    ck('2e permission-denied → "You do not have access"', byFd(r3.host, 'ov-status').textContent === 'You do not have access');
  }

  /* 3 — null → — */
  {
    const r = await mountWith(router({
      'impactAdminFoundationData:summary': () => Promise.resolve({ balance: null, donations: { completed: null, pledged: null, failed: null, review: null, refunded: null }, disbursements: { pendingApproval: null, pendingAuthorization: null, processing: null, awaitingConfirmation: null, completed: null, failed: null } }),
      'foundationContentDispatch:adminCounts': () => Promise.resolve({ counts: { pending: null, approved: 0 } }),
    }));
    const money = find(r.host, (e) => e.attrs['data-fd-money']).map((e) => e.children[1].textContent);
    const counts = find(r.host, (e) => /^(donations|disbursements):/.test(e.attrs['data-fd-count'] || '')).map((e) => e.children[1].textContent);
    ck('3a null balance → every money tile "—", evidence unreadable', money.length === 6 && money.every((t) => t === '—') && byFd(r.host, 'ov-evidence').attrs['data-evidence'] === 'unreadable', money.join(','));
    ck('3b null donation / disbursement counts → "—" (11 buttons)', counts.length === 11 && counts.every((t) => t === '—'), counts.join(','));
    const approved = find(r.host, (e) => e.attrs['data-fd-count'] === 'stories:approved')[0];
    const pending = find(r.host, (e) => e.attrs['data-fd-count'] === 'stories:pending')[0];
    ck('3c a real canonical 0 stays "0"; an unknown stays "—"', approved.children[1].textContent === '0' && pending.children[1].textContent === '—');
    const r2 = await mountWith(router({ 'impactAdminFoundationData:summary': () => Promise.resolve(SUMMARY), 'foundationContentDispatch:adminCounts': () => Promise.resolve({}) }));
    const avail = find(r2.host, (e) => e.attrs['data-fd-money'] === 'available')[0];
    ck('3d observed balance renders as KES from the server', /^KES 10,?000$/.test(avail.children[1].textContent) && byFd(r2.host, 'ov-evidence').attrs['data-evidence'] === 'observed', avail.children[1].textContent);
  }

  /* 4 — overview → filtered list; lazy tabs; keyboard */
  {
    const r = await mountWith(router({
      'impactAdminFoundationData:summary': () => Promise.resolve(SUMMARY),
      'foundationContentDispatch:adminCounts': () => Promise.resolve({ counts: { pending: 3 } }),
      'impactAdminFoundationData:donations': () => Promise.resolve({ rows: [], next: null }),
      'impactAdminFoundationData:disbursements': () => Promise.resolve({ rows: [] }),
      'foundationContentDispatch:adminList': () => Promise.resolve({ rows: [] }),
    }));
    ck('4a lazy: mount reads only summary + adminCounts', r.calls.length === 2 && r.calls.every((c) => c.data.view === 'summary' || c.data.op === 'adminCounts'), JSON.stringify(r.calls));
    find(r.host, (e) => e.attrs['data-fd-count'] === 'donations:failed')[0].fire('click');
    await flush();
    const last = r.calls[r.calls.length - 1];
    ck('4b "Failed" donation count opens Donations filtered to failed', last.name === 'impactAdminFoundationData' && last.data.view === 'donations' && last.data.status === 'failed' && r.host.attrs['data-fd-active'] === 'donations' && byFd(r.host, 'don-filter').value === 'failed' && tab(r.host, 'donations').attrs['aria-selected'] === 'true', JSON.stringify(last));
    ck('4c the preset tab loads ONCE (no duplicate unfiltered read)', r.calls.filter((c) => c.data.view === 'donations').length === 1);
    find(r.host, (e) => e.attrs['data-fd-count'] === 'disbursements:pending_authorization')[0];
    await r.go('overview');
    find(r.host, (e) => e.attrs['data-fd-count'] === 'disbursements:pending_authorization')[0].fire('click');
    await flush();
    const l2 = r.calls[r.calls.length - 1];
    ck('4d "Needs super-admin authorization" count opens Send support filtered', l2.data.view === 'disbursements' && l2.data.status === 'pending_authorization' && byFd(r.host, 'dis-filter').value === 'pending_authorization', JSON.stringify(l2));
    await r.go('overview');
    find(r.host, (e) => e.attrs['data-fd-count'] === 'stories:pending')[0].fire('click');
    await flush();
    const l3 = r.calls[r.calls.length - 1];
    ck('4e story count opens Stories filtered (adminList status pending)', l3.name === 'foundationContentDispatch' && l3.data.op === 'adminList' && l3.data.status === 'pending', JSON.stringify(l3));
    const strip = find(r.host, (e) => e.attrs.role === 'tablist')[0];
    const tabs = find(strip, (e) => e.attrs.role === 'tab');
    ck('4f tablist of 6 role=tab buttons, exactly one aria-selected=true with tabindex 0', tabs.length === 6 && tabs.filter((t) => t.attrs['aria-selected'] === 'true').length === 1 && tabs.filter((t) => t.attrs.tabindex === '0').length === 1 && tabs.every((t) => t.tagName === 'BUTTON'));
    tab(r.host, 'stories').fire('keydown', { key: 'ArrowRight' });
    await flush();
    ck('4g ArrowRight moves selection + focus to the next tab', r.host.attrs['data-fd-active'] === 'promotions' && tab(r.host, 'promotions').focused === true && tab(r.host, 'promotions').attrs['aria-selected'] === 'true');
    const r2 = await mountWith(router({ 'impactAdminFoundationData:summary': () => Promise.resolve(SUMMARY), 'foundationContentDispatch:adminCounts': () => Promise.resolve({}), 'impactAdminFoundationData:donations': () => Promise.resolve({ rows: [DON()], next: 'c1' }) }));
    await r2.go('donations');
    byFd(r2.host, 'don-more').fire('click'); await flush();
    const more = r2.calls.filter((c) => c.data.view === 'donations');
    ck('4h Load more sends the server cursor', more.length === 2 && more[1].data.cursor === 'c1', JSON.stringify(more));
  }

  /* 5 — disbursement chain */
  {
    const dd = deferred();
    const rowsAll = [DIS({ id: 'a', status: 'pending_approval' }), DIS({ id: 'b', status: 'pending_authorization' }), DIS({ id: 'c', status: 'processing', trackingId: 'TRK1' }),
      DIS({ id: 'm', status: 'processing', destinationType: 'BANK', rail: 'manual', destination: { bankName: 'KCB', accountNumber: '****1234' } }), DIS({ id: 'w', status: 'awaiting_confirmation', destinationType: 'TILL', rail: 'manual' }),
      DIS({ id: 'z', status: 'completed' })];
    let next = () => dd.p;
    const r = await mountWith(router({ 'impactAdminFoundationData:summary': () => Promise.resolve(SUMMARY), 'foundationContentDispatch:adminCounts': () => Promise.resolve({}), 'impactAdminFoundationData:disbursements': () => Promise.resolve({ rows: rowsAll }),
      impactApproveDisbursement: () => next(), impactAuthorizeDisbursement: () => next(), impactRefreshDisbursementStatus: () => next(), impactRecordManualDisbursement: () => next(), impactCancelDisbursement: () => next() }));
    await r.go('disbursements');
    const btn = (id, k) => byFd(rowOf(r.host, id), 'act-' + k);
    const msg = (id) => byFd(rowOf(r.host, id), 'row-msg').textContent;
    ck('5a actions gated by status (Approve only on a, Authorize only on b, Check on M-PESA c, Record on manual m, Confirm on w, none on completed z)',
      btn('a', 'approve') && !btn('a', 'authorize') && btn('b', 'authorize') && !btn('b', 'approve') && btn('c', 'check') && !btn('c', 'record') && btn('m', 'record') && !btn('m', 'check') && btn('w', 'confirm') && allFd(rowOf(r.host, 'z'), 'act-approve').length === 0 && find(rowOf(r.host, 'z'), (e) => /^act-/.test(e.attrs['data-fd'] || '')).length === 0);
    ck('5b Cancel offered only before authorization (a, b) — not on processing', !!btn('a', 'cancel') && !!btn('b', 'cancel') && !btn('c', 'cancel') && !btn('m', 'cancel'));
    btn('a', 'approve').fire('click'); await flush();
    let c = r.calls[r.calls.length - 1];
    ck('5c Approve → impactApproveDisbursement {disbursementId}; "Saving…", nothing claimed yet', c.name === 'impactApproveDisbursement' && c.data.disbursementId === 'a' && msg('a') === 'Saving…' && !/Done/.test(msg('a')), JSON.stringify(c));
    dd.res({ ok: true, status: 'pending_authorization' }); await flush();
    ck('5d result shown only after ok: "Done — now: Needs super-admin authorization"', msg('a') === 'Done — now: Needs super-admin authorization', msg('a'));
    next = () => Promise.resolve({ ok: true, status: 'processing' });
    ck('5e Authorize carries the super-admin-only note', /Super admin only/.test(rowOf(r.host, 'b').textContent));
    btn('b', 'authorize').fire('click'); await flush();
    c = r.calls[r.calls.length - 1];
    ck('5f Authorize → impactAuthorizeDisbursement {disbursementId:b}', c.name === 'impactAuthorizeDisbursement' && c.data.disbursementId === 'b' && msg('b') === 'Done — now: Processing — not yet confirmed', msg('b'));
    next = () => Promise.resolve({ ok: true, status: 'completed' });
    btn('c', 'check').fire('click'); await flush();
    c = r.calls[r.calls.length - 1];
    ck('5g Check status → impactRefreshDisbursementStatus; "Completed (confirmed)" only from the server', c.name === 'impactRefreshDisbursementStatus' && c.data.disbursementId === 'c' && msg('c') === 'Done — now: Completed (confirmed)', msg('c'));
    const before = r.calls.length;
    btn('m', 'record').fire('click'); await flush();
    ck('5h Record without a reference is refused locally — no call', r.calls.length === before && /reference/.test(msg('m')));
    byFd(rowOf(r.host, 'm'), 'provider-ref').value = 'FT26X1';
    next = () => Promise.resolve({ ok: true, status: 'awaiting_confirmation' });
    btn('m', 'record').fire('click'); await flush();
    c = r.calls[r.calls.length - 1];
    ck('5i Record → impactRecordManualDisbursement {action:record, providerReference}', c.name === 'impactRecordManualDisbursement' && c.data.action === 'record' && c.data.providerReference === 'FT26X1' && c.data.disbursementId === 'm' && msg('m') === 'Done — now: Recorded — awaiting second admin', JSON.stringify(c));
    next = () => Promise.reject({ code: 'functions/permission-denied', message: 'A different administrator must confirm a payment you recorded' });
    btn('w', 'confirm').fire('click'); await flush();
    c = r.calls[r.calls.length - 1];
    ck('5j Confirm → {action:confirm}; refusal shown with its meaning, button usable again', c.name === 'impactRecordManualDisbursement' && c.data.action === 'confirm' && msg('w') === 'A different administrator must confirm a payment you recorded' && !btn('w', 'confirm').disabled, msg('w'));
    const b2 = r.calls.length;
    btn('w', 'fail').fire('click'); await flush();
    ck('5k Mark failed needs a note — no call without one', r.calls.length === b2 && /note/.test(msg('w')));
    byFd(rowOf(r.host, 'w'), 'note').value = 'bank returned it';
    next = () => Promise.resolve({ ok: true, status: 'failed' });
    btn('w', 'fail').fire('click'); await flush();
    c = r.calls[r.calls.length - 1];
    ck('5l Mark failed → {action:fail, note}; "Failed — funds released"', c.data.action === 'fail' && c.data.note === 'bank returned it' && msg('w') === 'Done — now: Failed — funds released', JSON.stringify(c));
    const r2 = await mountWith(router({ 'impactAdminFoundationData:summary': () => Promise.resolve(SUMMARY), 'foundationContentDispatch:adminCounts': () => Promise.resolve({}), 'impactAdminFoundationData:disbursements': () => Promise.resolve({ rows: [DIS({ id: 'q' })] }), impactCancelDisbursement: () => Promise.resolve({ ok: true, status: 'cancelled' }), impactApproveDisbursement: () => Promise.resolve({}) }));
    await r2.go('disbursements');
    byFd(rowOf(r2.host, 'q'), 'act-approve').fire('click'); await flush();
    ck('5m a reply without ok:true is NOT shown as done', byFd(rowOf(r2.host, 'q'), 'row-msg').textContent === 'The server did not confirm this — nothing changed on screen');
    byFd(rowOf(r2.host, 'q'), 'note').value = 'duplicate request';
    byFd(rowOf(r2.host, 'q'), 'act-cancel').fire('click'); await flush();
    c = r2.calls[r2.calls.length - 1];
    ck('5n Cancel → impactCancelDisbursement {disbursementId, note}', c.name === 'impactCancelDisbursement' && c.data.disbursementId === 'q' && c.data.note === 'duplicate request' && byFd(rowOf(r2.host, 'q'), 'row-msg').textContent === 'Done — now: Cancelled', JSON.stringify(c));
  }

  /* 7/8 — New support payment form */
  {
    let mode = 'fail';
    const r = await mountWith(router({ 'impactAdminFoundationData:summary': () => Promise.resolve(SUMMARY), 'foundationContentDispatch:adminCounts': () => Promise.resolve({}),
      'impactAdminFoundationData:disbursements': () => Promise.resolve({ rows: [] }), 'impactAdminFoundationData:donations': () => Promise.resolve({ rows: [DON({ id: 'pp9', gross: 800, amount: 800 })] }),
      impactInitiateDisbursement: () => mode === 'fail' ? Promise.reject({ code: 'functions/unavailable' }) : mode === 'noack' ? Promise.resolve({}) : Promise.resolve({ ok: true, disbursementId: 'dNEW', status: 'pending_approval' }) }));
    await r.go('disbursements');
    byFd(r.host, 'dis-new').fire('click'); await flush();
    const formEl = () => byFd(r.host, 'dis-form');
    const rid1 = formEl().attrs['data-request-id'];
    ck('7a opening the form generates a uuid requestId once', /^[0-9a-f-]{36}$/.test(rid1));
    byFd(r.host, 'f-type').value = 'BANK'; byFd(r.host, 'f-type').fire('change');
    ck('8a BANK shows the manual-rail copy verbatim', byFd(r.host, 'f-rail-note') && byFd(r.host, 'f-rail-note').textContent === 'No automated rail — you pay outside SOKONI, record the reference, a second admin confirms.');
    ck('8b BANK asks for bank name, account name, account number', !!byFd(r.host, 'f-dest-bankName') && !!byFd(r.host, 'f-dest-accountName') && !!byFd(r.host, 'f-dest-accountNumber') && !byFd(r.host, 'f-dest-phone'));
    byFd(r.host, 'f-amount').value = '1500'; byFd(r.host, 'f-beneficiary').value = 'Kibera Water Group'; byFd(r.host, 'f-description').value = 'Borehole repair';
    byFd(r.host, 'f-dest-bankName').value = 'KCB'; byFd(r.host, 'f-dest-accountName').value = 'Kibera Water'; byFd(r.host, 'f-dest-accountNumber').value = '1234567890';
    byFd(r.host, 'f-grant').value = 'g1';
    byFd(r.host, 'f-submit').fire('click'); await flush();
    const init1 = r.calls.filter((c) => c.name === 'impactInitiateDisbursement');
    ck('7b payload: requestId, amount, beneficiary, description, BANK destination, grantId', init1.length === 1 && init1[0].data.requestId === rid1 && init1[0].data.amount === 1500 && init1[0].data.destinationType === 'BANK' && init1[0].data.destination.accountNumber === '1234567890' && init1[0].data.grantId === 'g1' && !('campaignId' in init1[0].data), JSON.stringify(init1[0] && init1[0].data));
    ck('7c not deployed → failure shown, no success, retry allowed', /not available yet/.test(byFd(r.host, 'f-msg').textContent) && !byFd(r.host, 'f-submit').disabled, byFd(r.host, 'f-msg').textContent);
    mode = 'noack';
    byFd(r.host, 'f-submit').fire('click'); await flush();
    mode = 'ok';
    byFd(r.host, 'f-submit').fire('click'); await flush();
    const init = r.calls.filter((c) => c.name === 'impactInitiateDisbursement');
    ck('7d every retried submit reuses the SAME requestId', init.length === 3 && init.every((c) => c.data.requestId === rid1), init.map((c) => c.data.requestId).join(','));
    ck('7e success only after ok: "Request created (dNEW) — Needs approval. Nothing has been paid."', byFd(r.host, 'f-msg').textContent === 'Request created (dNEW) — Needs approval. Nothing has been paid.', byFd(r.host, 'f-msg').textContent);
    byFd(r.host, 'dis-new').fire('click'); await flush();
    ck('7f a NEW form open gets a NEW requestId', formEl().attrs['data-request-id'] !== rid1 && /^[0-9a-f-]{36}$/.test(formEl().attrs['data-request-id']));
    ck('8c M-PESA (default) hides the manual-rail copy and asks for a phone', byFd(r.host, 'f-rail-note') === undefined && !!byFd(r.host, 'f-dest-phone'));
    await r.go('donations');
    byFd(rowOf(r.host, 'pp9'), 'act-refund').fire('click'); await flush();
    ck('8d Refund on a completed donation opens Send support with the refund label', r.host.attrs['data-fd-active'] === 'disbursements' && /^Refund request — needs approval \+ super-admin authorization/.test(byFd(r.host, 'f-refund-note').textContent) && byFd(r.host, 'f-amount').value === '800');
    byFd(r.host, 'f-amount').value = '900'; byFd(r.host, 'f-beneficiary').value = 'A. Donor'; byFd(r.host, 'f-description').value = 'Refund'; byFd(r.host, 'f-dest-phone').value = '254700000000';
    const nb = r.calls.length;
    byFd(r.host, 'f-submit').fire('click'); await flush();
    ck('8e refund above the gross is refused locally', r.calls.length === nb && /cannot exceed/.test(byFd(r.host, 'f-msg').textContent));
    byFd(r.host, 'f-amount').value = '800';
    byFd(r.host, 'f-submit').fire('click'); await flush();
    const rf = r.calls.filter((c) => c.name === 'impactInitiateDisbursement').pop();
    ck('8f refund submit carries refundOfPledgeId + MPESA phone', rf.name === 'impactInitiateDisbursement' && rf.data.refundOfPledgeId === 'pp9' && rf.data.amount === 800 && rf.data.destination.phone === '254700000000', JSON.stringify(rf.data));
    const r3 = await mountWith(router({ 'impactAdminFoundationData:summary': () => Promise.resolve(SUMMARY), 'foundationContentDispatch:adminCounts': () => Promise.resolve({}), 'impactAdminFoundationData:disbursements': () => Promise.resolve({ rows: [] }) }), { noCrypto: true });
    await r3.go('disbursements'); byFd(r3.host, 'dis-new').fire('click'); await flush();
    byFd(r3.host, 'f-amount').value = '10'; byFd(r3.host, 'f-beneficiary').value = 'x'; byFd(r3.host, 'f-description').value = 'y'; byFd(r3.host, 'f-dest-phone').value = '2547';
    byFd(r3.host, 'f-submit').fire('click'); await flush();
    ck('7g no secure randomness → refuses to submit rather than invent a requestId', r3.calls.every((c) => c.name !== 'impactInitiateDisbursement') && /secure request id/.test(byFd(r3.host, 'f-msg').textContent));
  }

  /* 9 — stories */
  {
    let decide = () => Promise.reject({ code: 'functions/permission-denied', message: 'Another administrator must approve a story you wrote' });
    const r = await mountWith(router({ 'impactAdminFoundationData:summary': () => Promise.resolve(SUMMARY), 'foundationContentDispatch:adminCounts': () => Promise.resolve({}),
      'foundationContentDispatch:adminList': () => Promise.resolve({ rows: [STORY(), STORY({ id: 's2', status: 'approved', publishAt: null }), STORY({ id: 's3', status: 'approved', publishAt: Date.now() - 1000 }),
        STORY({ id: 't1', kind: 'testimonial', status: 'pending', consent: { publish: true, showName: false, showMedia: true } }), STORY({ id: 'd1s', status: 'draft' }), STORY({ id: 'ar', status: 'archived' })] }),
      'foundationContentDispatch:adminDecide': (d) => decide(d), 'foundationContentDispatch:adminPublish': () => Promise.resolve({ ok: true, status: 'approved', published: true }),
      'foundationContentDispatch:adminSubmit': () => Promise.resolve({ ok: true, status: 'pending' }), 'foundationContentDispatch:adminUnpublish': () => Promise.resolve({ ok: true, status: 'approved' }) }));
    await r.go('stories');
    const msg = (id) => byFd(rowOf(r.host, id), 'row-msg').textContent;
    byFd(rowOf(r.host, 's1'), 'act-approve').fire('click'); await flush();
    const c = r.calls[r.calls.length - 1];
    ck('9a Approve → adminDecide {id, action:approve}', c.name === 'foundationContentDispatch' && c.data.op === 'adminDecide' && c.data.action === 'approve' && c.data.id === 's1', JSON.stringify(c));
    ck('9b server refusal shown: "Another administrator must approve a story you wrote"', msg('s1') === 'Another administrator must approve a story you wrote' && !byFd(rowOf(r.host, 's1'), 'act-approve').disabled, msg('s1'));
    const n0 = r.calls.length;
    byFd(rowOf(r.host, 's1'), 'act-reject').fire('click'); await flush();
    ck('9c Reject without a note refused locally', r.calls.length === n0 && /note/.test(msg('s1')));
    byFd(rowOf(r.host, 's1'), 'note').value = 'not our programme';
    decide = () => Promise.resolve({ ok: true, status: 'rejected' });
    byFd(rowOf(r.host, 's1'), 'act-request_changes').fire('click'); await flush();
    const c2 = r.calls[r.calls.length - 1];
    ck('9d Request changes sends the note', c2.data.action === 'request_changes' && c2.data.note === 'not our programme');
    const st = (id) => find(rowOf(r.host, id), (e) => e.attrs['data-label'] === 'Status')[0].textContent;
    ck('9e "Approved, not published" vs "Published" by state', st('s2') === 'Approved, not published' && st('s3') === 'Published', st('s2') + ' | ' + st('s3'));
    ck('9f actions by state: approved → Publish now + Schedule; published → Unpublish; draft → Submit; archived → Restore',
      !!byFd(rowOf(r.host, 's2'), 'act-publish') && !!byFd(rowOf(r.host, 's2'), 'act-schedule') && !byFd(rowOf(r.host, 's2'), 'act-unpublish') && !!byFd(rowOf(r.host, 's3'), 'act-unpublish') && !byFd(rowOf(r.host, 's3'), 'act-publish')
      && !!byFd(rowOf(r.host, 'd1s'), 'act-submit') && !!byFd(rowOf(r.host, 'ar'), 'act-restore') && !byFd(rowOf(r.host, 'ar'), 'act-archive'));
    ck('9g testimonial consent flags shown', /Publish: yes · show name: no · show media: yes/.test(rowOf(r.host, 't1').textContent));
    const n1 = r.calls.length;
    byFd(rowOf(r.host, 's2'), 'act-schedule').fire('click'); await flush();
    ck('9h Schedule without a time refused locally', r.calls.length === n1 && /date and time/.test(msg('s2')));
    const future = new Date(Date.now() + 86400000), pad = (x) => String(x).padStart(2, '0');
    byFd(rowOf(r.host, 's2'), 'publish-at').value = future.getFullYear() + '-' + pad(future.getMonth() + 1) + '-' + pad(future.getDate()) + 'T' + pad(future.getHours()) + ':' + pad(future.getMinutes());
    byFd(rowOf(r.host, 's2'), 'act-schedule').fire('click'); await flush();
    const c3 = r.calls[r.calls.length - 1];
    ck('9i Schedule → adminPublish {id, publishAt: ms in the future}', c3.data.op === 'adminPublish' && c3.data.id === 's2' && typeof c3.data.publishAt === 'number' && c3.data.publishAt > Date.now(), JSON.stringify(c3.data));
    byFd(rowOf(r.host, 's3'), 'act-unpublish').fire('click'); await flush();
    ck('9j Unpublish → adminUnpublish; result after ok', r.calls[r.calls.length - 1].data.op === 'adminUnpublish' && msg('s3') === 'Done — now: Approved, not published', msg('s3'));
  }

  /* 10 — story form */
  {
    const okSave = () => Promise.resolve({ ok: true, id: 'new1', status: 'pending' });
    const r = await mountWith(router({ 'impactAdminFoundationData:summary': () => Promise.resolve(SUMMARY), 'foundationContentDispatch:adminCounts': () => Promise.resolve({}), 'foundationContentDispatch:adminList': () => Promise.resolve({ rows: [] }), 'foundationContentDispatch:adminSaveStory': okSave }));
    await r.go('stories');
    byFd(r.host, 'st-new').fire('click'); await flush();
    ck('10a no storage SDK → "Media upload not available in this console yet", no file input', /^Media upload not available in this console yet/.test(byFd(r.host, 's-media-msg').textContent) && !byFd(r.host, 's-media'));
    byFd(r.host, 's-title').value = 'Clean water'; byFd(r.host, 's-body').value = 'Story text'; byFd(r.host, 's-dest-banking_hub').checked = true; byFd(r.host, 's-dest-foundation_home').checked = true;
    byFd(r.host, 's-submit').fire('click'); await flush();
    const sv = r.calls.filter((c) => c.data.op === 'adminSaveStory')[0];
    ck('10b text-only Save & submit → adminSaveStory {requestId, media:[], destinations, submit:true}', sv && /^[0-9a-f-]{36}$/.test(sv.data.requestId) && sv.data.media.length === 0 && sv.data.submit === true && sv.data.destinations.join() === 'foundation_home,banking_hub', JSON.stringify(sv && sv.data));
    ck('10c success text only after ok', byFd(r.host, 's-msg').textContent === 'Saved and submitted — another administrator must approve it');
    const uploads = []; let upFail = false;
    const r2 = await mountWith(router({ 'impactAdminFoundationData:summary': () => Promise.resolve(SUMMARY), 'foundationContentDispatch:adminCounts': () => Promise.resolve({}), 'foundationContentDispatch:adminList': () => Promise.resolve({ rows: [] }), 'foundationContentDispatch:adminSaveStory': okSave }),
      { upload: (p, f) => { uploads.push(p); return upFail ? Promise.reject({ code: 'storage/unauthorized' }) : Promise.resolve(p); } });
    await r2.go('stories'); byFd(r2.host, 'st-new').fire('click'); await flush();
    byFd(r2.host, 's-title').value = 'T'; byFd(r2.host, 's-body').value = 'B';
    byFd(r2.host, 's-media').files = [{ name: 'a.gif', type: 'image/gif', size: 10 }];
    byFd(r2.host, 's-draft').fire('click'); await flush();
    ck('10d unsupported type refused before upload', uploads.length === 0 && /Only JPEG, PNG, WebP/.test(byFd(r2.host, 's-msg').textContent));
    byFd(r2.host, 's-media').files = [{ type: 'video/mp4', size: 10 }, { type: 'video/webm', size: 10 }];
    byFd(r2.host, 's-draft').fire('click'); await flush();
    ck('10e two videos refused (max one)', uploads.length === 0 && byFd(r2.host, 's-msg').textContent === 'At most one video');
    byFd(r2.host, 's-media').files = [{ type: 'image/jpeg', size: 16 * 1024 * 1024 }];
    byFd(r2.host, 's-draft').fire('click'); await flush();
    ck('10f image over 15 MB refused', uploads.length === 0 && /15 MB/.test(byFd(r2.host, 's-msg').textContent));
    upFail = true;
    byFd(r2.host, 's-media').files = [{ type: 'image/jpeg', size: 1000 }, { type: 'video/quicktime', size: 1000 }];
    byFd(r2.host, 's-draft').fire('click'); await flush();
    ck('10g upload failure → clear message, adminSaveStory NOT called', r2.calls.every((c) => c.data.op !== 'adminSaveStory') && /^Media upload failed \(storage\/unauthorized\)\. Remove the files to save text-only/.test(byFd(r2.host, 's-msg').textContent), byFd(r2.host, 's-msg').textContent);
    upFail = false;
    byFd(r2.host, 's-draft').fire('click'); await flush();
    const sv2 = r2.calls.filter((c) => c.data.op === 'adminSaveStory')[0];
    ck('10h upload paths under foundation-media/admin/{random}.{ext}; saved as draft (no submit)', uploads.slice(-2).every((p) => /^foundation-media\/admin\/[0-9a-f]{24}\.(jpg|mov)$/.test(p)) && sv2 && sv2.data.media.length === 2 && /\.mov$/.test(sv2.data.media[1]) && !sv2.data.submit && byFd(r2.host, 's-msg').textContent === 'Saved as draft', uploads.join(','));
  }

  /* 11 — partner promotions */
  {
    const r = await mountWith(router({ 'impactAdminFoundationData:summary': () => Promise.resolve(SUMMARY), 'foundationContentDispatch:adminCounts': () => Promise.resolve({}),
      'financialPartnerDispatch:adminListPromotionRequests': () => Promise.resolve({ rows: [{ id: 'pr1', name: 'Sacco <b>A</b>', institutionType: 'SACCO', status: 'pending', requestedAt: 1790000000000 }] }),
      'financialPartnerDispatch:adminDecidePromotion': () => Promise.resolve({ ok: true }) }));
    await r.go('promotions');
    const list = r.calls.filter((c) => c.data.op === 'adminListPromotionRequests');
    ck('11a lists adminListPromotionRequests status pending; label verbatim', list.length === 1 && list[0].data.status === 'pending' && byFd(r.host, 'promo-label').textContent === 'Promotion ranks a listing; it never verifies it. No payment is taken.');
    const row = rowOf(r.host, 'pr1');
    byFd(row, 'promo-days').value = '91';
    const n = r.calls.length;
    byFd(row, 'act-grant').fire('click'); await flush();
    ck('11b days outside 1–90 refused locally', r.calls.length === n && /1 to 90/.test(byFd(row, 'row-msg').textContent));
    byFd(row, 'act-decline').fire('click'); await flush();
    ck('11c decline without a note refused locally', r.calls.length === n && /note/.test(byFd(row, 'row-msg').textContent));
    byFd(row, 'promo-days').value = '14';
    byFd(row, 'act-grant').fire('click'); await flush();
    const c = r.calls[r.calls.length - 1];
    ck('11d grant → adminDecidePromotion {id, verdict:granted, days:14}; result after ok', c.data.op === 'adminDecidePromotion' && c.data.id === 'pr1' && c.data.verdict === 'granted' && c.data.days === 14 && byFd(row, 'row-msg').textContent === 'Promotion granted', JSON.stringify(c.data));
  }

  /* 12 — reconciliation */
  {
    const r = await mountWith(router({ 'impactAdminFoundationData:summary': () => Promise.resolve(SUMMARY), 'foundationContentDispatch:adminCounts': () => Promise.resolve({}),
      impactGetFinancialReport: () => Promise.resolve({ entries: [{ type: 'donation', amount: 100, ref: 'DON_1' }, { type: 'donation', amount: 50, ref: 'DON_2' }, { type: 'disbursement', amount: -20, ref: 'D1' }] }) }));
    await r.go('reconciliation');
    ck('12a warning banner verbatim', byFd(r.host, 'rc-warning').textContent === 'Pre-fix checkout donations (before the pledge fix is deployed) were recorded as completed without payment — reconcile before trusting the balance.');
    ck('12b ledger grouped by type from impactGetFinancialReport', r.calls.some((c) => c.name === 'impactGetFinancialReport') && /donation — 2 entries shown/.test(r.html()) && /disbursement — 1 entry shown/.test(r.html()) && byFd(r.host, 'rc-evidence').attrs['data-evidence'] === 'observed');
    const r2 = await mountWith(router({ 'impactAdminFoundationData:summary': () => Promise.resolve(SUMMARY), 'foundationContentDispatch:adminCounts': () => Promise.resolve({}), impactGetFinancialReport: () => Promise.resolve({ weird: true }) }));
    await r2.go('reconciliation');
    ck('12c unknown report shape → unreadable, not empty', byFd(r2.host, 'rc-evidence').attrs['data-evidence'] === 'unreadable');
  }

  /* 6 — "Sent" never appears (rendered + source strings) */
  {
    const src = fs.readFileSync(MODULE, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const strings = src.match(/'[^'\n]*'/g) || [];
    const renderedSent = RENDERED.some((h) => /\bSent\b/.test(h.textContent) || /\bSent\b/.test(ser(h)));
    ck('6 the word "Sent" never appears — not rendered, not in any source string', !renderedSent && !strings.some((s) => /\bSent\b/.test(s)), strings.filter((s) => /\bSent\b/.test(s)).join('|'));
  }

  /* 13 — wiring */
  {
    const aosHtml = fs.readFileSync(path.join(ROOT, 'admin-os.html'), 'utf8');
    const saHtml = fs.readFileSync(path.join(ROOT, 'super-admin.html'), 'utf8');
    const aosJs = fs.readFileSync(path.join(ROOT, 'sokoni-aos.js'), 'utf8');
    ck('13a AdminOS: nav button (inline onclick + nav-label), panel, script, css, router entry, mount via _call',
      /data-section="foundation"[^>]*onclick="SokoniAOS\.navigate\('foundation'\);_closeSidebar\(\)"><span class="nav-icon">[^<]*<\/span><span class="nav-label">SOKONI Foundation<\/span>/.test(aosHtml)
      && /id="panel-foundation"/.test(aosHtml) && /<script src="sokoni-admin-foundation\.js"><\/script>/.test(aosHtml) && /<link rel="stylesheet" href="sokoni-admin-foundation\.css">/.test(aosHtml)
      && /foundation: +\(\) => _loadFoundation\(\)/.test(aosJs) && /SokoniAdminFoundation\.mount\(body, \{ console: "aos", call: \(name, data\) => _call\(name, data\) \}\)/.test(aosJs));
    ck('13b Super Admin: nav button, panel, script, css, section switch, mount with its own transport',
      /onclick="SA\.nav\('foundation'\);_closeSidebar\(\)"/.test(saHtml) && /<span class="nav-label">SOKONI Foundation<\/span>/.test(saHtml) && /id="panel-foundation"/.test(saHtml)
      && /<script src="sokoni-admin-foundation\.js"><\/script>/.test(saHtml) && /<link rel="stylesheet" href="sokoni-admin-foundation\.css">/.test(saHtml) && /section==='foundation'\)this\.loadFoundation\(\)/.test(saHtml)
      && /SokoniAdminFoundation\.mount\(body,\{console:'sa',call:\(name,data\)=>fns\.httpsCallable\(name\)/.test(saHtml));
    ck('13c the module never assigns innerHTML and never revives admin.html', !/innerHTML\s*=/.test(fs.readFileSync(MODULE, 'utf8')) && !/(^|[^-\w])admin\.html/.test(fs.readFileSync(MODULE, 'utf8')));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
