#!/usr/bin/env node
/* MARKETING HUB MK5b (AdminOS) — sokoni-aos-marketing.js executed in a VM with a selector-keyed DOM stub (no jsdom here;
 * the real browser run is NOT done — memory floor). Proves: reads go through marketingDispatch; the decision goes through
 * applicationDecide ONLY, with approvedCategories = exactly the ticked boxes; approve-with-nothing and reasonless
 * revoke/reject are refused before any call; a server refusal is shown and nothing claims success; revoked is terminal;
 * money / reviews / audit link to the canonical AdminOS sections; the module writes no Firestore.
 *   node scripts/test-aos-marketing.js            SABOTAGE=1 → every mutation must turn its named row FAIL */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), cp = require('child_process'), os = require('os');
const ROOT = path.join(__dirname, '..');

if (process.env.SABOTAGE) {
  const M = [
    ['P3', 'sokoni-aos-marketing.js', "Object.assign({ applicationId: id, decision, reason }, decision === 'approve' ? { approvedCategories: cats } : {})", "Object.assign({ applicationId: id, decision, reason }, decision === 'approve' ? { approvedCategories: (body.dataset.req || '').split(',') } : {})"],
    ['P3b', 'sokoni-aos-marketing.js', "      if (decision === 'approve' && !cats.length) { msg('Tick at least one service to approve.', true); return; }", ''],
    ['P4', 'sokoni-aos-marketing.js', "if ((decision === 'revoke' || decision === 'request_info' || decision === 'reject') && reason.trim().length < 5)", 'if (false)'],
    ['P5', 'sokoni-aos-marketing.js', "        msg((e && e.message) || 'The server refused this decision.', true);", "        msg('Decision recorded by the server (audited).');"],
    ['P2b', 'sokoni-aos-marketing.js', "+ '<h4>Decide</h4>' + (terminal ?", "+ '<h4>Decide</h4>' + (false ?"],
    ['P1', 'sokoni-aos-marketing.js', "'<tr><td>' + esc(i.name) + '<div class=\"aos-muted\">'", "'<tr><td>' + i.name + '<div class=\"aos-muted\">'"],
  ];
  let caught = 0;
  for (const [row, file, a, b] of M) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aosm-'));
    ['sokoni-aos-marketing.js', 'sokoni-marketing-taxonomy.js', 'admin-os.html', 'sokoni-aos.js'].forEach((f) => fs.copyFileSync(path.join(ROOT, f), path.join(d, f)));
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
const src = fs.readFileSync(path.join(DIR, 'sokoni-aos-marketing.js'), 'utf8');
console.log('\nAdminOS › Marketing (MK5b)\n');

/* ── selector-keyed DOM stub ── */
function el(name) { return { name, innerHTML: '', textContent: '', value: '', checked: false, disabled: false, style: {}, dataset: {}, listeners: {},
  setAttribute() {}, addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }, querySelector: () => null, querySelectorAll: () => [] }; }
const host = el('host'), body = el('body'), msgEl = el('msg');
let reasonEl = el('reason'), boxes = [];
body.querySelector = (s) => (s === '[data-reason]' ? reasonEl : null);
body.querySelectorAll = (s) => (s === '[data-cats] input[name="cat"]' ? boxes : s === '[data-decide]' ? decideBtns : []);
host.querySelector = (s) => (s === '[data-body]' ? body : s === '[data-msg]' ? msgEl : null);
host.querySelectorAll = () => [];
let decideBtns = [el('b1'), el('b2')];
const calls = []; let refuse = null; const navs = [];
const OVERVIEW = { ok: true, items: [{ id: 'marketing_u1', uid: 'u1', name: 'Achieng <img src=x onerror=1>', status: 'pending', reviewStage: 'verified', marketingType: 'agency', requestedCategories: ['branding', 'seo'], county: 'Nairobi', receivedAtMs: 1 }], counts: { byStatus: { pending: 1 }, byType: { agency: 1 }, byCategory: {}, listed: 0 } };
let APP = { ok: true, application: { id: 'marketing_u1', uid: 'u1', status: 'pending', reviewStage: 'verified', marketingType: 'agency', name: 'Achieng', description: 'Brand work', county: 'Nairobi', phone: '+254712345678', email: '', portfolio: ['https://x.example/p'], agency: { registrationNumber: 'PVT-1', teamSize: 8, kraPin: '' }, requestedCategories: ['branding', 'seo'], approvedCategories: [], declinedCategories: [], resubmissions: 0 },
  decisionRecord: null, history: [{ action: 'application_mark_verified', by: 'admin1', atMs: 2 }], marketer: null };
const call = async (name, data) => {
  calls.push(Object.assign({ fn: name }, data));
  if (name === 'applicationDecide') { if (refuse) throw refuse; return { ok: true }; }
  if (name !== 'marketingDispatch') throw new Error('unexpected callable ' + name);
  if (data.op === 'marketingAdminOverview') return OVERVIEW;
  if (data.op === 'marketingAdminApplication') return APP;
  return { ok: true, items: [] };
};
const G = { window: null, Date, Number, String, Array, Object, JSON, Promise };
G.window = G;
const ctx = vm.createContext(G);
vm.runInContext(fs.readFileSync(path.join(DIR, 'sokoni-marketing-taxonomy.js'), 'utf8'), ctx);
vm.runInContext(src, ctx);
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
const click = async (dataset) => { const b = Object.assign(el('btn'), { dataset }); const t = { closest: () => b }; for (const f of host.listeners.click || []) f({ target: t }); await flush(); };

(async () => {
  const ok = G.SokoniAOSMarketing.mount({ host, call, navigate: (s) => navs.push(s) });
  await flush();
  ck('P1', ok === true && calls[0] && calls[0].fn === 'marketingDispatch' && calls[0].op === 'marketingAdminOverview' && /data-review="marketing_u1"/.test(body.innerHTML)
    && /Achieng &lt;img/.test(body.innerHTML) && !/<img src=x/.test(body.innerHTML) && /Branding/.test(body.innerHTML),
    'applications tab: reads via marketingDispatch, escapes applicant text, labels requested services, offers Review', body.innerHTML.slice(0, 200));

  await click({ review: 'marketing_u1' });
  const rv = body.innerHTML;
  ck('P2', calls.some((c) => c.op === 'marketingAdminApplication' && c.applicationId === 'marketing_u1') && (rv.match(/name="cat"/g) || []).length === 2 && /value="branding"/.test(rv) && /value="seo"/.test(rv)
    && /No server decision record yet/.test(rv) && /application_mark_verified/.test(rv) && /PVT-1/.test(rv) && /Approve ticked services/.test(rv),
    'review: one checkbox per REQUESTED service only, decision record + audit history + agency registration shown', rv.slice(0, 300));

  /* approve with nothing ticked → refused locally, no call */
  const before = calls.length;
  boxes = [Object.assign(el('c1'), { value: 'branding', checked: false }), Object.assign(el('c2'), { value: 'seo', checked: false })];
  await click({ decide: 'approve' });
  ck('P3b', calls.length === before && /Tick at least one/.test(msgEl.textContent), 'approve with nothing ticked is refused before any call', { calls: calls.length - before, msg: msgEl.textContent });
  boxes[0].checked = true; reasonEl.value = '';
  body.dataset.req = 'branding,seo';
  await click({ decide: 'approve' });
  const dec = calls.filter((c) => c.fn === 'applicationDecide').pop();
  ck('P3', dec && dec.decision === 'approve' && dec.applicationId === 'marketing_u1' && JSON.stringify(dec.approvedCategories) === JSON.stringify(['branding']) && /recorded by the server/.test(msgEl.textContent),
    'approve sends applicationDecide with approvedCategories = EXACTLY the ticked services (seo not approved)', dec);

  /* revoke needs a reason */
  const b2 = calls.length; reasonEl.value = 'no';
  await click({ decide: 'revoke' });
  const blocked = calls.length === b2;
  reasonEl.value = 'Fake portfolio confirmed';
  await click({ decide: 'revoke' });
  const rk = calls.filter((c) => c.fn === 'applicationDecide').pop();
  ck('P4', blocked && rk.decision === 'revoke' && rk.reason === 'Fake portfolio confirmed' && !('approvedCategories' in rk), 'revoke / reject / request-info need a reason (≥5 chars) before any call', rk);

  /* server refusal shown, never "recorded" */
  refuse = Object.assign(new Error('approvedCategories must be a subset of the requested categories.'), { code: 'invalid-argument' });
  msgEl.textContent = ''; boxes[1].checked = true;
  await click({ decide: 'approve' });
  ck('P5', /subset of the requested/.test(msgEl.textContent) && !/recorded/.test(msgEl.textContent) && decideBtns.every((b) => b.disabled === false),
    'a server refusal is shown verbatim, nothing claims success, buttons re-enabled', msgEl.textContent);
  refuse = null;

  /* revoked is terminal: no decide controls */
  APP = JSON.parse(JSON.stringify(APP)); APP.application.reviewStage = 'revoked'; APP.application.status = 'suspended';
  await click({ review: 'marketing_u1' });
  ck('P2b', /Revoked — terminal/.test(body.innerHTML) && !/data-decide=/.test(body.innerHTML) && !/name="cat"/.test(body.innerHTML), 'a REVOKED application shows no decision controls or category boxes (terminal)', body.innerHTML.slice(-300));

  await click({ tab: 'more' });
  const navBtns = (body.innerHTML.match(/data-nav="([a-z]+)"/g) || []).map((x) => x.slice(10, -1));
  await click({ nav: 'financial' });
  ck('P6', ['services', 'bookings', 'payments', 'financial', 'content', 'audit'].every((s) => navBtns.indexOf(s) >= 0) && navs[navs.length - 1] === 'financial',
    'leads, bookings, payments, receipts/wallets/commissions/settlements, reviews and audit open the CANONICAL AdminOS sections', navBtns);

  const html = fs.readFileSync(path.join(DIR, 'admin-os.html'), 'utf8'), aos = fs.readFileSync(path.join(DIR, 'sokoni-aos.js'), 'utf8');
  ck('P7', !/collection\(|\.set\(|\.update\(|\.add\(|firestore/.test(src) && /data-section="marketing"/.test(html) && /id="panel-marketing"/.test(html) && /id="marketingBody"/.test(html)
    && /sokoni-aos-marketing\.js/.test(html) && /sokoni-marketing-taxonomy\.js/.test(html) && /marketing:\s+\(\) => _loadMarketing\(\)/.test(aos) && /SokoniAOSMarketing\.mount\(\{ host: body, call: _call \}\)/.test(aos),
    'the module writes no Firestore; AdminOS has the nav item, panel, scripts and loader');
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); console.log('\nRESULT: ' + pass + ' passed, ' + (fail + 1) + ' failed'); process.exit(1); });
