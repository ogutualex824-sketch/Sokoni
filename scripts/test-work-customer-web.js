#!/usr/bin/env node
/* WORK/JOB ENGINE — customer screens (my-projects.html + sokoni-work-customer.js) executed in a VM with a DOM stub and
 * recorded workDispatch calls (no browser — memory floor). Proves: acceptance sends ONLY the server scope version shown
 * (never a total); a changed proposal is reloaded, never accepted; request-changes needs a reason; an accepted project shows
 * the ACCEPTED snapshot, not the live scope; paying a milestone goes workPayMilestone → SokoniBookService.payExisting;
 * change requests are approved by the customer through workDecideChange.
 *   node scripts/test-work-customer-web.js            SABOTAGE=1 → every mutation must turn its named row FAIL */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), cp = require('child_process'), os = require('os');
const ROOT = path.join(__dirname, '..');

if (process.env.SABOTAGE) {
  const M = [
    ['C2', 'sokoni-work-customer.js', "return move('accepted', { expectedScopeVersion: Number(d.accept) });", "return move('accepted', { expectedScopeVersion: Number(d.accept), totalCents: current.totalCents });"],
    ['C3', 'sokoni-work-customer.js', "      if (code === 'WORK_SCOPE_CHANGED') {", "      if (false) {"],
    ['C4', 'sokoni-work-customer.js', "    if (reason.length < 5) {", '    if (false) {'],
    ['C5', 'sokoni-work-customer.js', "    const sc = acc || live;", '    const sc = live;'],
    ['C6', 'sokoni-work-customer.js', "G.SokoniBookService.payExisting({ bookingId: r.bookingId, serviceName: 'Milestone' });", "msg('Paid ✓');"],
  ];
  let caught = 0;
  for (const [row, file, a, b] of M) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wcw-'));
    ['sokoni-work-customer.js', 'my-projects.html'].forEach((f) => fs.copyFileSync(path.join(ROOT, f), path.join(d, f)));
    const t = path.join(d, file), s = fs.readFileSync(t, 'utf8').replace(/\r\n/g, '\n');
    if (s.split(a).length !== 2) { console.log('  BROKEN ' + row + ' anchor'); continue; }
    fs.writeFileSync(t, s.replace(a, () => b));
    let out = ''; try { out = cp.execFileSync(process.execPath, [__filename], { env: Object.assign({}, process.env, { SABOTAGE: '', WEB_DIR: d }), encoding: 'utf8' }); } catch (e) { out = String(e.stdout || ''); }
    const hit = new RegExp('FAIL ' + row + ' ').test(out);
    console.log('  ' + (hit ? 'CAUGHT' : 'MISSED') + ' ' + row); if (hit) caught++;
    fs.rmSync(d, { recursive: true, force: true });
  }
  console.log('\nSABOTAGE: ' + caught + '/' + M.length + ' caught');
  process.exit(caught === M.length ? 0 : 1);
}

const DIR = process.env.WEB_DIR || ROOT;
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 300) + ']')); ok ? pass++ : fail++; };
console.log('\nCampaign / project — customer screens\n');
function el(id) { return { id, innerHTML: '', textContent: '', className: '', dataset: {}, disabled: false, listeners: {}, addEventListener() {} }; }
const ELS = { wcBody: el('wcBody'), wcMsg: el('wcMsg') };
const calls = [], paid = [];
const LIVE_SCOPE = { title: 'Q4 campaign', lines: [{ lineId: 'l1', kind: 'other', description: 'Content <b>plan</b>', qty: 1, unit: 'item', rateCents: 5000000, amountCents: 5000000 }, { lineId: 'cr1-l1', kind: 'other', description: 'TikTok push (change)', qty: 1, unit: 'item', rateCents: 2000000, amountCents: 2000000 }],
  milestones: [{ id: 'm1', title: 'Month 1', amountCents: 5000000, status: 'planned' }, { id: 'm-cr1', title: 'TikTok push', amountCents: 2000000, status: 'planned' }], terms: 'Net 7', documents: ['https://docs.example/brief.pdf'] };
const PROPOSED = { id: 'P1', kind: 'campaign', status: 'proposed', scopeVersion: 4, totalCents: 5000000, scope: { title: 'Q4 campaign', lines: [LIVE_SCOPE.lines[0]], milestones: [LIVE_SCOPE.milestones[0]], terms: 'Net 7', documents: LIVE_SCOPE.documents }, changeRequests: [] };
const ACCEPTED = { id: 'P2', kind: 'campaign', status: 'active', scopeVersion: 4, totalCents: 7000000, scope: LIVE_SCOPE,
  acceptedScope: { scopeVersion: 4, totalCents: 5000000, snapshot: { title: 'Q4 campaign', lines: [LIVE_SCOPE.lines[0]], milestones: [LIVE_SCOPE.milestones[0]], terms: 'Net 7', documents: [] } },
  changeRequests: [{ crId: 'cr2', reason: 'Add a radio spot', deltaCents: 1000000, status: 'proposed' }] };
let projects = { P1: PROPOSED, P2: ACCEPTED }, transitionErr = null;
const G = {
  document: { readyState: 'complete', getElementById: (i) => ELS[i] || null, querySelector: (s) => (s === '[data-changes-slot]' ? (ELS.slot = ELS.slot || el('slot')) : null), listeners: {}, addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); } },
  location: { search: '' }, URLSearchParams, setTimeout: (f) => { f(); return 1; }, confirm: () => true, Promise, Object, String, Number, Math, JSON, Array, encodeURIComponent,
  SokoniBookService: { payExisting: (o) => paid.push(o) },
  firebase: {
    auth: () => ({ onAuthStateChanged: (f) => { f({ uid: 'cust' }); return () => {}; } }),
    functions: () => ({ httpsCallable: () => async (data) => {
      calls.push(data);
      if (data.op === 'workListMine') return { data: { items: [{ id: 'P1', role: 'customer', status: 'proposed', title: 'Q4 <campaign>', totalCents: 5000000, kind: 'campaign' }, { id: 'X', role: 'provider', status: 'active', title: 'Mine as provider', kind: 'project' }] } };
      if (data.op === 'workGet') return { data: { project: projects[data.projectId] } };
      if (data.op === 'workTransition') { if (transitionErr) { const e = transitionErr; transitionErr = null; throw e; } return { data: { ok: true } }; }
      if (data.op === 'workPayMilestone') return { data: { ok: true, bookingId: 'wm_P2_m1_1' } };
      return { data: { ok: true } };
    } }),
  },
};
G.window = G;
vm.runInContext(fs.readFileSync(path.join(DIR, 'sokoni-work-customer.js'), 'utf8'), vm.createContext(G));
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
const click = async (dataset) => { const b = Object.assign(el('b'), { dataset }); for (const f of G.document.listeners.click || []) await f({ target: { closest: () => b } }); await flush(); };

(async () => {
  await flush();
  ck('C1', /Q4 &lt;campaign&gt;/.test(ELS.wcBody.innerHTML) && !/Mine as provider/.test(ELS.wcBody.innerHTML) && /data-open="P1"/.test(ELS.wcBody.innerHTML),
    'list: only projects where I am the CUSTOMER, escaped', ELS.wcBody.innerHTML.slice(0, 200));
  await click({ open: 'P1' });
  const ph = ELS.wcBody.innerHTML;
  await click({ accept: '4' });
  const acc = calls.filter((c) => c.op === 'workTransition').pop();
  ck('C2', /data-accept="4"/.test(ph) && /data-changes/.test(ph) && /data-move="cancelled"/.test(ph) && /Net 7/.test(ph) && /docs\.example/.test(ph)
    && acc && acc.to === 'accepted' && acc.expectedScopeVersion === 4 && !('totalCents' in acc) && !('price' in acc),
    'proposed: Accept / Request changes / Decline, terms + documents shown; acceptance sends ONLY the server scope version (no total)', acc);
  transitionErr = Object.assign(new Error('changed'), { details: { code: 'WORK_SCOPE_CHANGED' } });
  const before = calls.filter((c) => c.op === 'workGet').length;
  await click({ accept: '4' });
  ck('C3', /changed the proposal/.test(ELS.wcMsg.textContent) && calls.filter((c) => c.op === 'workGet').length === before + 1 && !/accepted — the terms/.test(ELS.wcMsg.textContent),
    'a proposal edited since it was opened is NOT accepted: the customer is told and the latest version is reloaded', ELS.wcMsg.textContent);
  await click({ changes: '' });
  const n0 = calls.filter((c) => c.op === 'workTransition').length;
  for (const f of G.document.listeners.submit || []) await f({ target: { matches: (s) => s === '[data-changes-form]', elements: { reason: { value: 'no' } } }, preventDefault() {} });
  const blocked = calls.filter((c) => c.op === 'workTransition').length === n0;
  for (const f of G.document.listeners.submit || []) await f({ target: { matches: (s) => s === '[data-changes-form]', elements: { reason: { value: 'Split month 2 please' } } }, preventDefault() {} });
  await flush();
  const rc = calls.filter((c) => c.op === 'workTransition').pop();
  ck('C4', blocked && rc.to === 'draft' && rc.reason === 'Split month 2 please', 'request changes needs a reason (≥5 chars) and sends it with to:draft', rc);
  await click({ open: 'P2' });
  const ah = ELS.wcBody.innerHTML;
  ck('C5', /accepted version 4/.test(ah) && /Content &lt;b&gt;plan&lt;\/b&gt;/.test(ah) && !/TikTok push \(change\)/.test(ah) && /Add a radio spot/.test(ah),
    'an accepted project shows the ACCEPTED snapshot as its pricing (a later change is not shown as accepted); pending changes listed separately', ah.slice(0, 300));
  await click({ pay: 'm1' });
  const pm = calls.find((c) => c.op === 'workPayMilestone');
  ck('C6', pm && pm.projectId === 'P2' && pm.milestoneId === 'm1' && !('amountCents' in pm) && paid.length === 1 && paid[0].bookingId === 'wm_P2_m1_1',
    'Pay milestone → workPayMilestone (no amount sent) → SokoniBookService.payExisting on the server-minted booking (canonical IntaSend path)', { pm, paid });
  await click({ crApprove: 'cr2' });
  const dc = calls.find((c) => c.op === 'workDecideChange');
  ck('C7', dc && dc.crId === 'cr2' && dc.decision === 'approve' && dc.projectId === 'P2', 'the customer approves a change request through workDecideChange', dc);
  const html = fs.readFileSync(path.join(DIR, 'my-projects.html'), 'utf8'), js = fs.readFileSync(path.join(DIR, 'sokoni-work-customer.js'), 'utf8');
  ck('C8', /shared-header\.js/.test(html) && /sokoni-book-service\.js/.test(html) && /sokoni-work-customer\.js/.test(html) && /sokoni-mv2-skin\.css/.test(html) && !/localStorage/.test(js) && !/onclick=/.test(html + js),
    'page self-updates (shared-header), uses the canonical booking/payment module and the merchant-v2 skin; no localStorage, no inline handlers');
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); console.log('\nRESULT: ' + pass + ' passed, ' + (fail + 1) + ' failed'); process.exit(1); });
