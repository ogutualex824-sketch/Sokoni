#!/usr/bin/env node
/* MARKETING HUB MK3 (web) — marketing-hub.html + sokoni-marketing-hub.js executed in a VM with a stubbed DOM/firebase.
 * Proves: no seeded agencies / invented stats; the directory renders ONLY what marketingDirectory returned; the wizard's
 * three application types send marketingApply with no status/approval field; "submitted" only after the server answered;
 * quote → SokoniLeads.ask (leadCreate engine), book → SokoniBookService.open; hub-register marketing rows → the wizard.
 *   node scripts/test-marketing-hub-web.js            SABOTAGE=1 → every mutation must turn its named row FAIL */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), cp = require('child_process'), os = require('os');
const ROOT = path.join(__dirname, '..');

if (process.env.SABOTAGE) {
  const M = [
    ['W2', 'sokoni-marketing-hub.js', "var items = (r && r.items) || [];", "var items = ((r && r.items) || []).concat([{ uid: 'fake', name: 'Seeded Agency', categories: [], reviewCount: 120, rating: 4.9, jobsCompleted: 500 }]);"],
    ['W4', 'sokoni-marketing-hub.js', "await call('marketingApply', { marketingType: w.type,", "await call('marketingApply', { status: 'approved', marketingType: w.type,"],
    ['W5b', 'sokoni-marketing-hub.js', "      S.wiz = { step: 0, type: '', cats: [] };\n      await loadMine();", "      S.wiz = { step: 0, type: '', cats: [] };"],
    ['W5', 'sokoni-marketing-hub.js', '      wizErr(errText(e));', "      S.me = { application: { status: 'pending', requestedCategories: w.cats } }; renderMine();"],
    ['W6', 'sokoni-marketing-hub.js', "else if (max === 1) w.cats = [d.pick]; else if (w.cats.length < max) w.cats.push(d.pick);", "else if (true) w.cats.push(d.pick);"],
    ['W7', 'sokoni-marketing-hub.js', "G.SokoniLeads.ask({ providerId: d.quote,", "G.SokoniLeads.ask({ providerId: 'x' + d.quote,"],
    ['W9', 'hub-register.js', "if (MARKETING_APPLY_IDS.indexOf(cat) >= 0) { window.location.href = 'marketing-hub.html#become'; return; }", ''],
    ['W3', 'sokoni-marketing-hub.js', "var rating = m.reviewCount > 0 && typeof m.rating === 'number' ?", "var rating = true ?"],
  ];
  let caught = 0;
  for (const [row, file, a, b] of M) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mhw-'));
    ['marketing-hub.html', 'sokoni-marketing-hub.js', 'sokoni-marketing-taxonomy.js', 'hub-register.js'].forEach((f) => fs.copyFileSync(path.join(ROOT, f), path.join(d, f)));
    const t = path.join(d, file), s = fs.readFileSync(t, 'utf8').replace(/\r\n/g, '\n');
    if (s.split(a).length !== 2) { console.log('  BROKEN ' + row + ' anchor in ' + file); continue; }
    fs.writeFileSync(t, s.replace(a, () => b));
    let out = ''; try { out = cp.execFileSync(process.execPath, [__filename], { env: Object.assign({}, process.env, { SABOTAGE: '', WEB_DIR: d }), encoding: 'utf8' }); } catch (e) { out = String(e.stdout || ''); }
    const hit = new RegExp('FAIL ' + row + ' ').test(out);
    console.log('  ' + (hit ? 'CAUGHT' : 'MISSED') + ' ' + row + '  (' + file + ')'); if (hit) caught++;
    fs.rmSync(d, { recursive: true, force: true });
  }
  console.log('\nSABOTAGE: ' + caught + '/' + M.length + ' caught');
  process.exit(caught === M.length ? 0 : 1);
}

const DIR = process.env.WEB_DIR || ROOT;
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 300) + ']')); ok ? pass++ : fail++; };
const html = fs.readFileSync(path.join(DIR, 'marketing-hub.html'), 'utf8');
const js = fs.readFileSync(path.join(DIR, 'sokoni-marketing-hub.js'), 'utf8');
console.log('\nMarketing Hub MK3 — web\n');

/* ── static ── */
ck('W1', !/sokoni-marketing\.js/.test(html) && !/120\+|1,200\+|4\.8★/.test(html) && !/hub-register\.js/.test(html)
  && /sokoni-marketing-taxonomy\.js/.test(html) && /sokoni-leads\.js/.test(html) && /sokoni-book-service\.js/.test(html) && /shared-header\.js/.test(html)
  && !/onclick=/.test(html) && !/localStorage/.test(js),
  'page loads no seeded agency data, shows no invented stats, no generic HubRegister, no inline handlers; self-updates via shared-header');

/* ── a tiny DOM ── */
function mkEl(id) {
  const el = { id, innerHTML: '', textContent: '', hidden: false, value: '', disabled: false, dataset: {}, style: {}, classList: { add() {}, remove() {}, contains: () => false },
    listeners: {}, addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }, insertAdjacentHTML(_, h) { this.innerHTML += h; }, querySelector: () => mkEl('q'), remove() {}, scrollIntoView() {} };
  return el;
}
const ELS = {};
['mhGroups', 'mhServices', 'mhList', 'mhListInfo', 'mhMine', 'mhWizard', 'mhSearch', 'mhType', 'become', 'mwName', 'mwDesc', 'mwCounty', 'mwPhone', 'mwYears', 'mwPort', 'mwReg', 'mwTeam', 'mwKra', 'mwErr', 'mwNext'].forEach((i) => { ELS[i] = mkEl(i); });
const calls = [], opened = { leads: [], book: [] };
let dirItems = [{ uid: 'm1', name: 'Achieng <b>Creative</b>', marketingType: 'agency', categories: ['branding', 'seo'], city: 'Nairobi', description: 'Brand work', rating: null, reviewCount: 0, jobsCompleted: 0 }];
let myStatus = { ok: true, application: null, marketer: null };
let applyFail = null;
const doc = { readyState: 'complete', getElementById: (i) => ELS[i] || null, body: { appendChild() {} }, createElement: () => mkEl('new'), listeners: {}, addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); } };
const G = {
  document: doc, location: { search: '', pathname: '/marketing-hub.html', href: '' }, URLSearchParams,
  setTimeout: (f) => { f(); return 1; }, clearTimeout() {},
  firebase: {
    functions: () => ({ httpsCallable: (name) => async (data) => {
      calls.push(Object.assign({ fn: name }, data));
      if (data.op === 'marketingDirectory') return { data: { ok: true, items: dirItems, total: dirItems.length } };
      if (data.op === 'marketingMyStatus') return { data: myStatus };
      if (data.op === 'marketingApply') { if (applyFail) throw applyFail; myStatus = { ok: true, application: { status: 'pending', marketingType: data.marketingType, requestedCategories: data.categories } }; return { data: { ok: true } }; }
      return { data: { ok: true } };
    } }),
    auth: () => ({ currentUser: { uid: 'u1' }, onAuthStateChanged: (f) => { f({ uid: 'u1' }); return () => {}; } }),
  },
  SokoniLeads: { ask: (o) => opened.leads.push(o) }, SokoniBookService: { open: (o) => opened.book.push(o) },
};
G.window = G;
const ctx = vm.createContext(G);
vm.runInContext(fs.readFileSync(path.join(DIR, 'sokoni-marketing-taxonomy.js'), 'utf8'), ctx);
vm.runInContext(js, ctx);
const flush = () => new Promise((r) => setImmediate(r));
const click = async (dataset, opts) => {
  const t = Object.assign(mkEl('btn'), { dataset, classList: { contains: (c) => !!(opts && opts.cls === c) } });
  t.closest = (sel) => (sel === 'button,a' ? t : (opts && opts.within && sel === opts.within) ? {} : null);
  for (const f of doc.listeners.click || []) await f({ target: t, preventDefault() {} });
  await flush(); await flush();
};

(async () => {
  for (let i = 0; i < 10; i++) await flush();
  const dirCall = calls.find((c) => c.op === 'marketingDirectory');
  ck('W2', dirCall && dirCall.fn === 'marketingDispatch' && /Achieng &lt;b&gt;Creative&lt;\/b&gt;/.test(ELS.mhList.innerHTML) && (ELS.mhList.innerHTML.match(/class="mh-card"/g) || []).length === 1,
    'directory renders exactly what marketingDirectory returned (escaped), nothing seeded', ELS.mhList.innerHTML.slice(0, 200));
  ck('W3', /No reviews yet/.test(ELS.mhList.innerHTML) && /New on SOKONI/.test(ELS.mhList.innerHTML) && !/★/.test(ELS.mhList.innerHTML),
    'a marketer with no reviews shows "No reviews yet", never an invented rating');
  dirItems = []; await click({ group: 'digital' }, { within: '#mhGroups' });
  const c2 = calls.filter((c) => c.op === 'marketingDirectory').pop();
  ck('W8', c2.group === 'digital' && /No approved marketers here yet/.test(ELS.mhList.innerHTML) && /data-cat="seo"/.test(ELS.mhServices.innerHTML),
    'choosing a category filters on the SERVER (group sent); an empty result is an honest empty state with the apply link', c2);

  /* wizard */
  ck('W4a', /data-type="individual"/.test(ELS.mhWizard.innerHTML) && /data-type="agency"/.test(ELS.mhWizard.innerHTML) && /data-type="specialist"/.test(ELS.mhWizard.innerHTML),
    'the wizard offers the three SEPARATE application types');
  await click({ type: 'specialist' }, { within: '#mhWizard' }); await click({ wnext: '' });
  await click({ pick: 'seo' }); await click({ pick: 'branding' });
  const H = G.SokoniMarketingHub._internal;
  ck('W6', H.S.wiz.cats.length === 1 && H.S.wiz.cats[0] === 'branding', 'a specialist holds exactly one service (picking another replaces it)', H.S.wiz.cats);
  H.S.wiz.type = 'individual'; H.S.wiz.cats = ['seo', 'branding']; H.S.wiz.step = 1; H.renderWizard(); await click({ wnext: '' });
  Object.assign(ELS.mwName, { value: 'Achieng' }); Object.assign(ELS.mwDesc, { value: 'Brand identity and social campaigns for Nairobi SMEs.' });
  Object.assign(ELS.mwCounty, { value: 'Nairobi' }); Object.assign(ELS.mwPhone, { value: '0712 345 678' }); Object.assign(ELS.mwPort, { value: 'https://a.example/x\nhttps://b.example/y' });
  await click({ wnext: '' });
  ck('W4b', H.S.wiz.step === 3 && !calls.some((c) => c.op === 'marketingApply'), 'details validated, review step reached — nothing sent yet');
  applyFail = Object.assign(new Error('Your Marketing application is already under review.'), { code: 'already-exists' });
  await click({ wnext: '' });
  ck('W5', /already under review/.test(ELS.mwErr.textContent) && myStatus.application === null && ELS.mhMine.innerHTML === '', 'a server refusal is shown; NOTHING says submitted', ELS.mwErr.textContent);
  applyFail = null; await click({ wnext: '' });
  const ap = calls.filter((c) => c.op === 'marketingApply').pop();
  ck('W4', ap && ap.marketingType === 'individual' && JSON.stringify(ap.categories) === JSON.stringify(['seo', 'branding']) && ap.phone === '0712345678' && ap.portfolio.length === 2
    && !('status' in ap) && !('approvedCategories' in ap) && !('marketingApprovedCategories' in ap) && !('verified' in ap),
    'marketingApply carries type + categories + details and NO status / approval / verification field', ap);
  ck('W5b', /Under review/.test(ELS.mhMine.innerHTML) && ELS.mhWizard.innerHTML === '', 'only AFTER the server answered: "Under review" status replaces the wizard', ELS.mhMine.innerHTML.slice(0, 160));

  /* profile actions */
  await click({ quote: 'm1', name: 'Achieng' }); await click({ book: 'm1', name: 'Achieng' });
  ck('W7', opened.leads.length === 1 && opened.leads[0].providerId === 'm1' && opened.book.length === 1 && opened.book[0].providerId === 'm1',
    'Request a quote → SokoniLeads.ask (leadCreate engine); Book → SokoniBookService.open (canonical booking + IntaSend + hold)', opened);

  /* hub-register */
  const hr = fs.readFileSync(path.join(DIR, 'hub-register.js'), 'utf8');
  const HG = { location: { href: '', pathname: '/x', search: '' }, document: { getElementById: (i) => ({ value: { sreg_name: 'A', sreg_cat: 'social-media', sreg_phone: '0712345678', sreg_email: '', sreg_loc: 'Nairobi', sreg_desc: 'x' }[i] || '', textContent: '', style: {}, classList: { add() {}, remove() {} } }), addEventListener() {}, createElement: () => mkEl('e'), head: { appendChild() {} }, body: { appendChild() {}, style: {} } }, localStorage: { getItem: () => null } };
  HG.window = HG; HG.firebaseAuth = { currentUser: { uid: 'u1' } };
  let wrote = false; HG.firebase = { firestore: () => ({ collection: () => ({ add: () => { wrote = true; return Promise.resolve({ id: 'x' }); } }) }) };
  try { vm.runInContext(hr, vm.createContext(HG)); } catch (_) {}
  let openHref = '';
  try { HG.HubRegister.open({ hub: 'marketing' }); openHref = HG.location.href; HG.location.href = ''; } catch (_) {}
  const sub = /function _submit\(\) \{[\s\S]*?MARKETING_APPLY_IDS\.indexOf\(cat\) >= 0\) \{ window\.location\.href = 'marketing-hub\.html#become'; return; \}/.test(hr);
  ck('W9', openHref === 'marketing-hub.html#become' && sub && /'graphic-design', 'social-media', 'advertising', 'pr-firm', 'content-creator'/.test(hr) && !wrote,
    'HubRegister: opening the marketing hub, or submitting a marketing row, goes to the Marketing application — never the generic business application', { openHref, sub });
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); console.log('\nRESULT: ' + pass + ' passed, ' + (fail + 1) + ' failed'); process.exit(1); });
