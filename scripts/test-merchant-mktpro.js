#!/usr/bin/env node
/* MARKETING HUB MK6 — the marketer workspace in merchant-v2 (provider session). Executes sokoni-merchant-mktpro.js in a VM
 * with a selector-keyed DOM stub + recorded server calls (no browser — memory floor), and the REAL route registry.
 * Proves: the module re-asks the server and paints NOTHING operational for a non-marketer; services/rates mount the ONE
 * rate-card editor filtered to the SERVER's approved categories (no own pricing form); quotes go to leadSendQuote in
 * integer cents; campaigns start from an ACCEPTED quote via workCreate; the registry gates the group on 'marketing' and the
 * routes on the provider session (merchant / no-capability → refused).
 *   node scripts/test-merchant-mktpro.js            SABOTAGE=1 → every mutation must turn its named row FAIL */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), cp = require('child_process'), os = require('os');
const ROOT = path.join(__dirname, '..');

if (process.env.SABOTAGE) {
  const M = [
    ['K1', 'sokoni-merchant-mktpro.js', "      if (!(m && m.listed && (m.categories || []).length)) {", '      if (false) {'],
    ['K3', 'merchant-v2.html', "      filter: { categories: (S.workspace && Array.isArray(S.workspace.marketingCategories)) ? S.workspace.marketingCategories.slice() : [] },", "      filter: {},"],
    ['K8', 'sokoni-merchant-mktpro.js', "    const canEdit = () => !!(ctx.editable && ctx.editable() === true);", '    const canEdit = () => true;'],
    ['K4', 'sokoni-merchant-mktpro.js', "        const qm = f.querySelector('[data-quote-msg]'), unitRateCents = toCents(f.elements.amount.value);", "        const qm = f.querySelector('[data-quote-msg]'), unitRateCents = f.elements.amount.value;"],
    ['K4b', 'sokoni-merchant-mktpro.js', "    const PRE_QUOTE = ['created', 'viewed', 'qualified', 'quote_requested', 'clarification_requested'];", "    const PRE_QUOTE = ['created', 'viewed', 'qualified', 'quote_requested', 'clarification_requested', 'quote_declined'];"],
    ['K6', 'sokoni-merchant-routes.js', "    { key:'mktpro', label:'Marketing services', requires:'marketing',", "    { key:'mktpro', label:'Marketing services',"],
    ['K6b', 'sokoni-merchant-routes.js', "    { id:'mkt-earnings', name:'Earnings', icon:'💰', tier:'more',\n      kind:'native',\n      role:['seller','merchant'], ctx:[CTX.SELLER_UID],\n      sessions:['provider'],", "    { id:'mkt-earnings', name:'Earnings', icon:'💰', tier:'more',\n      kind:'native',\n      role:['seller','merchant'], ctx:[CTX.SELLER_UID],\n      sessions:['provider','merchant'],"],
  ];
  let caught = 0;
  for (const [row, file, a, b] of M) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mkp-'));
    ['sokoni-merchant-mktpro.js', 'sokoni-merchant-routes.js', 'sokoni-marketing-taxonomy.js', 'merchant-v2.html'].forEach((f) => fs.copyFileSync(path.join(ROOT, f), path.join(d, f)));
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
console.log('\nmerchant-v2 › Marketing services (MK6)\n');

function el(name) { return { name, innerHTML: '', textContent: '', className: '', value: '', checked: false, disabled: false, dataset: {}, style: {}, listeners: {},
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }, removeEventListener() {}, querySelector: () => null, querySelectorAll: () => [] }; }
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };

function harness(answers) {
  const calls = [];
  const G = { Promise, Object, String, Number, Math, JSON, Array, encodeURIComponent };
  G.window = G;
  const ctx0 = vm.createContext(G);
  vm.runInContext(fs.readFileSync(path.join(DIR, 'sokoni-marketing-taxonomy.js'), 'utf8'), ctx0);
  vm.runInContext(fs.readFileSync(path.join(DIR, 'sokoni-merchant-mktpro.js'), 'utf8'), ctx0);
  const call = async (name, payload) => { calls.push(Object.assign({ fn: name }, payload)); const k = name + ':' + payload.op; if (answers[k] instanceof Error) throw answers[k]; return typeof answers[k] === 'function' ? answers[k](payload) : (answers[k] || {}); };
  return { G, calls, mount: (view, extra) => { const host = el('host'); const ui = G.SokoniMerchantMktPro.mount(host, Object.assign({ view, uid: () => 'mk', call, editable: () => true, readOnlyReason: () => null, callable: (n) => (p) => call(n, p).then((d) => ({ data: d })), hasRoute: () => true, go: () => {}, onToast: () => {} }, extra || {})); return { host, ui }; } };
}
const APPROVED = { 'marketingDispatch:marketingMyStatus': { ok: true, application: { status: 'approved', reviewStage: 'approved', declinedCategories: ['seo'] }, marketer: { status: 'active', listed: true, marketingType: 'agency', categories: ['branding', 'logo-design'] } } };

(async () => {
  /* K1: a non-marketer gets the honest gate and nothing else is called */
  let h = harness({ 'marketingDispatch:marketingMyStatus': { ok: true, application: { status: 'pending' }, marketer: null } });
  let m = h.mount('leads'); await flush();
  ck('K1', /open once SOKONI approves you/.test(m.host.innerHTML) && h.calls.length === 1 && h.calls[0].op === 'marketingMyStatus',
    'not approved (server says so) → honest "opens once SOKONI approves you"; NO service / lead / booking call is made', h.calls.map((c) => c.op));

  /* K2: overview from server reads, escaped */
  h = harness(Object.assign({}, APPROVED, { 'providerDispatch:providerGetEarnings': { gross: 100000, commission: 10000, net: 90000, pending: 50000, settled: 40000, count: 2 },
    'providerDispatch:providerListServices': { services: [{ id: 's1', name: '<b>Brand</b>', hub: 'marketing', category: 'branding', active: true }] } }));
  m = h.mount('overview'); await flush();
  ck('K2', /KES 500/.test(m.host.innerHTML) && /Branding/.test(m.host.innerHTML) && /Logo Design/.test(m.host.innerHTML) && /class="stat/.test(m.host.innerHTML),
    'overview: merchant-v2 stat tiles from providerGetEarnings + the approved services from the server', m.host.innerHTML.slice(0, 200));

  /* K3: mkt-services / mkt-rates mount sokoni-e3's ONE rate-card editor, filtered to the SERVER's approved categories, with the
     P0-F editable gate (no own form in this module) */
  const html0 = fs.readFileSync(path.join(DIR, 'merchant-v2.html'), 'utf8');
  const rcCtx = html0.slice(html0.indexOf('function _mktRateCtx ()'), html0.indexOf('function _mktCtx (view)'));
  ck('K3', /'mkt-services':\s+\{ global: 'SokoniMerchantRateCard', ctx: function \(\) \{ return _mktRateCtx\(\); \} \}/.test(html0)
    && /'mkt-rates':\s+\{ global: 'SokoniMerchantRateCard', ctx: function \(\) \{ return _mktRateCtx\(\); \} \}/.test(html0)
    && /S\.workspace\.marketingCategories\.slice\(\)/.test(rcCtx) && /editable: ok, readOnly: !ok/.test(rcCtx) && !/serviceKind/.test(rcCtx)
    && !/async function services|data-svc-form/.test(fs.readFileSync(path.join(DIR, 'sokoni-merchant-mktpro.js'), 'utf8')),
    'mkt-services / mkt-rates mount the ONE rate-card editor with the server-approved marketing categories (empty ⇒ nothing) and the P0-F editable gate; this module keeps no pricing form');

  /* K4: send quote → leadSendQuote, integer cents */
  h = harness(Object.assign({}, APPROVED, { 'providerDispatch:leadListForProvider': { leads: [{ id: 'L1', status: 'viewed', message: 'Need a logo' }] },
    'providerDispatch:providerListServices': { services: [{ id: 's1', name: 'Logo', hub: 'marketing', category: 'logo-design', active: true }] } }));
  m = h.mount('leads'); await flush();
  const form = { matches: (s) => s === '[data-quote-form]', dataset: { lead: 'L1' }, elements: { amount: { value: '12,500.50' }, serviceId: { value: 's1' }, description: { value: 'Logo + brand guide' }, validDays: { value: '7' } }, querySelector: () => el('qm') };
  for (const f of m.host.listeners.submit || []) await f({ target: form, preventDefault() {} });
  await flush();
  const q = h.calls.find((c) => c.op === 'leadSendQuote');
  ck('K4', /Need a logo/.test(m.host.innerHTML) && q && q.unitRateCents === 1250050 && q.quantity === 1 && !('amountCents' in q) && q.leadId === 'L1' && q.serviceId === 's1' && Number.isInteger(q.unitRateCents),
    'leads: a quote goes to the ONE lead engine (leadSendQuote) as LINES in integer cents (KES 12,500.50 → unit rate 1250050), no client total', q);
  /* K4b G7: only controls the server accepts — no quote on a declined quote; qualify / lost / withdraw by state; idle = decline / lost */
  {
    const acts = (l, view) => { const hh = harness(Object.assign({}, APPROVED, { 'providerDispatch:leadListForProvider': { leads: [Object.assign({ id: 'X', message: 'm' }, l)] }, 'providerDispatch:providerListServices': { services: [] } }));
      const mm = hh.mount(view || 'leads'); return flush().then(() => (mm.host.innerHTML.match(/data-lead-[a-z]+(?==)/g) || []).map((x) => x.slice(10)).sort().join()); };
    const v = await acts({ status: 'viewed' }), qs = await acts({ status: 'quote_sent' }, 'quotes'), qd = await acts({ status: 'quote_declined' }, 'quotes'), idle = await acts({ status: 'viewed', stage: 'expired' });
    ck('K4b', v === 'decline,lost,qualify,quote' && qs === 'lost,quote,withdraw' && qd === '' && idle === 'decline,lost',
      'G7 lead controls follow the server: viewed → quote / qualify / decline / lost; sent → re-quote / withdraw / lost; a declined quote offers nothing; an idle lead only decline / lost', { v, qs, qd, idle });
  }

  /* K5: campaign from an accepted quote */
  h = harness(Object.assign({}, APPROVED, { 'workDispatch:workListMine': { items: [] }, 'providerDispatch:leadListForProvider': { leads: [{ id: 'L9', status: 'quote_accepted', quote: { amountCents: 9000000, description: 'Q4 campaign' } }] },
    'workDispatch:workCreate': { ok: true, projectId: 'wp1' }, 'workDispatch:workGet': { project: { id: 'wp1', kind: 'campaign', status: 'draft', scope: { title: 'Q4', lines: [], milestones: [] }, totalCents: 9000000 } } }));
  m = h.mount('campaigns'); await flush();
  const btn = Object.assign(el('b'), { dataset: { workCreate: 'L9', kind: 'campaign' } });
  for (const f of m.host.listeners.click || []) await f({ target: { closest: () => btn } });
  await flush();
  const wc = h.calls.find((c) => c.op === 'workCreate');
  ck('K5b', wc && wc.skin === 'marketing' && wc.kind === 'campaign' && wc.originType === 'service_lead' && wc.leadId === 'L9' && !('customerUid' in wc) && !('totalCents' in wc),
    'a campaign starts from an ACCEPTED quote via workCreate (no client customer/total — the server derives both)', wc);

  /* K8: P0-F read-only — no action controls, and every mutating handler refuses without calling the server */
  h = harness(Object.assign({}, APPROVED, { 'providerDispatch:leadListForProvider': { leads: [{ id: 'L1', status: 'viewed', message: 'Need a logo' }] },
    'providerDispatch:providerListServices': { services: [{ id: 's1', name: 'Logo', hub: 'marketing', category: 'logo-design', active: true }] } }));
  m = h.mount('leads', { editable: () => false, readOnlyReason: () => 'Account frozen pending review' }); await flush();
  const roHtml = m.host.innerHTML;
  const bq = Object.assign(el('b'), { dataset: { leadDecline: 'L1' } });
  for (const f of m.host.listeners.click || []) await f({ target: { closest: () => bq } });
  const roForm = { matches: (x) => x === '[data-quote-form]', dataset: { lead: 'L1' }, elements: { amount: { value: '100' }, serviceId: { value: 's1' }, description: { value: '' }, validDays: { value: '7' } }, querySelector: () => el('qm') };
  for (const f of m.host.listeners.submit || []) await f({ target: roForm, preventDefault() {} });
  await flush();
  ck('K8', !/data-lead-quote|data-lead-decline|data-lead-view/.test(roHtml) && /Messages/.test(roHtml) && !h.calls.some((c) => ['leadDecline', 'leadSendQuote', 'leadMarkViewed'].indexOf(c.op) >= 0),
    'P0-F read-only: no Send quote / Decline / Mark opened controls, and a forged click or submit calls NO mutating op', { calls: h.calls.map((c) => c.op) });

  /* K6: registry */
  const G2 = { window: null }; G2.window = G2; vm.runInContext(fs.readFileSync(path.join(DIR, 'sokoni-merchant-routes.js'), 'utf8'), vm.createContext(G2));
  const R = G2.SokoniMerchantRoutes;
  const ids = ['mkt-overview', 'mkt-services', 'mkt-rates', 'mkt-leads', 'mkt-quotes', 'mkt-bookings', 'mkt-campaigns', 'mkt-projects', 'mkt-earnings', 'mkt-verification'];
  const yes = (c) => c === 'marketing', no = () => false;
  ck('K6', R.validate().length === 0 && ids.every((id) => R.mountRefusal(id, 'provider', yes) === null && R.mountRefusal(id, 'provider', no) === 'requires:marketing'),
    'registry valid; every mkt-* route mounts for a provider WITH the server marketing capability and is refused without it', ids.map((id) => R.mountRefusal(id, 'provider', no)));
  ck('K6b', ids.every((id) => /^session:/.test(String(R.mountRefusal(id, 'merchant', yes)))), 'a MERCHANT (shop) session never mounts the marketer workspace');
  const html = fs.readFileSync(path.join(DIR, 'merchant-v2.html'), 'utf8');
  ck('K7', /<script src="sokoni-merchant-mktpro\.js"><\/script>/.test(html) && /<script src="sokoni-marketing-taxonomy\.js"><\/script>/.test(html) && ids.every((id) => html.indexOf("'" + id + "':") >= 0) && /function _mktCtx \(view\)/.test(html),
    'merchant-v2 loads the module + taxonomy and maps every mkt-* route to it through _mktCtx');
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); console.log('\nRESULT: ' + pass + ' passed, ' + (fail + 1) + ' failed'); process.exit(1); });
