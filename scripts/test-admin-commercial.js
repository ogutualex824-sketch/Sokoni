#!/usr/bin/env node
/* ============================================================================
   Partner plans & promotions view — EXECUTED behaviour + console wiring
   Run:  node scripts/test-admin-commercial.js [path/to/module]
   Same fake-DOM method as test-admin-foundation.js: text nodes are escaped, innerHTML is emitted RAW,
   so a server string routed through innerHTML goes red.
     1  malicious server strings render as inert text (all four tabs)
     2  not deployed → "not available yet", evidence unreadable — never "No …" / 0
     3  list payloads per tab (adminListCommercial view/status; adminListPromotionRequests status)
     4  amounts "KES n" or "—" (a real 0 stays KES 0); review reasons explained
     5  Stop campaign: only on active/review, reason required, payload, result only after ok, refusal shown
     6  promotion requests: days 1–90, decline note, payloads, result only after ok
     7  catalogue read-only: no price/plan editing controls; note verbatim
     8  tabs: lazy, role=tablist, keyboard
     9  both consoles wire ONE module; promotions are no longer in the Foundation module (one place)
   ========================================================================= */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
const MODULE = path.resolve(process.argv[2] || path.join(ROOT, 'sokoni-admin-commercial.js'));
let pass = 0, fail = 0;
const ck = (label, ok, detail) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (!ok && detail ? '   [' + String(detail).slice(0, 240) + ']' : '')); ok ? pass++ : fail++; };

const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => escText(s).replace(/"/g, '&quot;');
class Text { constructor(t) { this.nodeType = 3; this.data = String(t); } }
class El {
  constructor(tag) { this.nodeType = 1; this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.listeners = {}; this.raw = null; this.disabled = false; this.value = ''; this.checked = false; }
  appendChild(c) { this.children.push(c); return c; }
  insertBefore(c, ref) { const i = this.children.indexOf(ref); if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; }
  unshift(c) { this.children.unshift(c); }
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
function findVisible(n, pred, out = []) { if (n.nodeType === 1 && !n.hidden) { if (pred(n)) out.push(n); n.children.forEach((c) => findVisible(c, pred, out)); } return out; }
const byCm = (root, key) => findVisible(root, (e) => e.attrs['data-cm'] === key)[0];
const rowOf = (root, id) => find(root, (e) => e.attrs['data-cm-row'] === id)[0];
const tab = (root, key) => find(root, (e) => e.attrs['data-cm-tab'] === key)[0];
const cell = (row, label) => find(row, (e) => e.attrs['data-label'] === label)[0].textContent;

function load() {
  const window = {};
  const sandbox = { window, document: { createElement: (t) => new El(t), createTextNode: (t) => new Text(t) }, console, Promise, Date, WeakMap, Object, Array, String, Number, parseInt, isFinite, Math, JSON, RegExp, Error };
  window.document = sandbox.document;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(MODULE, 'utf8'), sandbox, { filename: path.basename(MODULE) });
  return window.SokoniAdminCommercial;
}
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
async function mountWith(impl) {
  const api = load(), host = new El('div'), calls = [];
  api.mount(host, { console: 'aos', call: (name, data) => { calls.push({ name, data: JSON.parse(JSON.stringify(data)) }); return impl(name, data); } });
  await flush();
  return { host, calls, html: () => ser(host), go: async (k) => { tab(host, k).fire('click'); await flush(); } };
}
const deferred = () => { let res, rej; const p = new Promise((a, b) => { res = a; rej = b; }); return { p, res, rej }; };
function router(map) { return (name, data) => { const k = name + ':' + data.op + (data.view ? ':' + data.view : ''); const f = map[k]; return f ? f(data) : Promise.reject({ code: 'functions/not-found' }); }; }
const ENT = (o) => Object.assign({ id: 'e1', ownerId: 'partnerA', planId: 'growth', status: 'active', amountKES: 4900, intentRef: 'PSUB_1', startAt: 1790000000000, endAt: 1792592000000 }, o);
const CAMP = (o) => Object.assign({ id: 'c1', ownerId: 'partnerA', productId: 'featured_7d', placement: 'directory_top', status: 'active', amountKES: 1500, reason: null, startAt: 1790000000000, endAt: 1790604800000 }, o);
const FUL = (o) => Object.assign({ id: 'f1', ownerId: 'partnerA', planId: 'growth', status: 'fulfilled', amountKES: 4900, intentRef: 'PSUB_1', startAt: 1790000000000, endAt: 1792592000000 }, o);
const PRQ = (o) => Object.assign({ id: 'pr1', partnerUid: 'partnerA', placement: 'directory_top', message: 'Please feature us', status: 'pending', createdAt: 1790000000000 }, o);

(async () => {
  console.log('\nPARTNER PLANS & PROMOTIONS VIEW — executed behaviour (' + path.relative(ROOT, MODULE) + ')');

  /* 1 — inert */
  {
    const EVIL = '<img src=x onerror="alert(1)">';
    const r = await mountWith(router({
      'financialPartnerDispatch:adminListCommercial:entitlements': () => Promise.resolve({ rows: [ENT({ ownerId: EVIL })] }),
      'financialPartnerDispatch:adminListCommercial:campaigns': () => Promise.resolve({ rows: [CAMP({ placement: '<script>x()</script>' })] }),
      'financialPartnerDispatch:adminListCommercial:fulfilments': () => Promise.resolve({ rows: [FUL({ reason: EVIL, status: 'review' })] }),
      'financialPartnerDispatch:adminListPromotionRequests': () => Promise.resolve({ rows: [PRQ({ message: EVIL })] }),
    }));
    await r.go('campaigns'); await r.go('fulfilments'); await r.go('promotions');
    const html = r.html();
    ck('1a malicious partner / placement / reason / message are inert text in all four tabs', !/<img\b/i.test(html) && !/<script\b/i.test(html) && (html.match(/&lt;img src=x/g) || []).length === 3, html.match(/<img|<script/i));
    ck('1b rows rendered from the server', !!rowOf(r.host, 'e1') && !!rowOf(r.host, 'c1') && !!rowOf(r.host, 'f1') && !!rowOf(r.host, 'pr1'));
  }

  /* 2 — not deployed */
  {
    const r = await mountWith(() => Promise.reject({ code: 'functions/not-found' }));
    const out = {};
    for (const k of ['entitlements', 'campaigns', 'fulfilments', 'promotions']) { if (k !== 'entitlements') await r.go(k); out[k] = byCm(r.host, k + '-status').textContent + '|' + byCm(r.host, k + '-evidence').attrs['data-evidence']; }
    ck('2a every tab: "… not available yet" + evidence unreadable, never "No …"', Object.values(out).every((s) => /not available yet\|unreadable$/.test(s) && !/^No /.test(s)), JSON.stringify(out));
    ck('2b nothing rendered as 0 / KES 0 while not deployed', !/KES 0\b/.test(r.html()) && !/>0</.test(r.html()));
    const r2 = await mountWith(() => Promise.reject({ code: 'functions/unavailable' }));
    const r3 = await mountWith(() => Promise.reject({ code: 'functions/internal' }));
    const r4 = await mountWith(() => Promise.reject({ code: 'functions/permission-denied' }));
    const r5 = await mountWith(() => Promise.resolve({ nope: true }));
    const r6 = await mountWith(() => Promise.resolve({ rows: [] }));
    ck('2c unavailable / internal also read as not deployed', /not available yet/.test(byCm(r2.host, 'entitlements-status').textContent) && /not available yet/.test(byCm(r3.host, 'entitlements-status').textContent));
    ck('2d denied → "You do not have access"; malformed → unreadable (not empty); empty → "No entitlements" + empty',
      byCm(r4.host, 'entitlements-status').textContent === 'You do not have access' && byCm(r5.host, 'entitlements-evidence').attrs['data-evidence'] === 'unreadable'
      && byCm(r6.host, 'entitlements-status').textContent === 'No entitlements' && byCm(r6.host, 'entitlements-evidence').attrs['data-evidence'] === 'empty');
  }

  /* 3 — payloads */
  {
    const r = await mountWith(() => Promise.resolve({ rows: [] }));
    ck('3a lazy: mount reads only entitlements, {op:adminListCommercial, view:entitlements} with no status', r.calls.length === 1 && r.calls[0].name === 'financialPartnerDispatch' && r.calls[0].data.op === 'adminListCommercial' && r.calls[0].data.view === 'entitlements' && !('status' in r.calls[0].data), JSON.stringify(r.calls));
    await r.go('campaigns');
    byCm(r.host, 'campaigns-filter').value = 'review'; byCm(r.host, 'campaigns-filter').fire('change'); await flush();
    let c = r.calls[r.calls.length - 1];
    ck('3b campaigns status filter → {view:campaigns, status:review}', c.data.view === 'campaigns' && c.data.status === 'review' && /^No campaigns — Under review$/.test(byCm(r.host, 'campaigns-status').textContent), JSON.stringify(c.data) + byCm(r.host, 'campaigns-status').textContent);
    await r.go('fulfilments');
    byCm(r.host, 'fulfilments-filter').value = 'fulfilled'; byCm(r.host, 'fulfilments-filter').fire('change'); await flush();
    c = r.calls[r.calls.length - 1];
    ck('3c fulfilments → {view:fulfilments, status:fulfilled}', c.data.view === 'fulfilments' && c.data.status === 'fulfilled');
    await r.go('promotions');
    c = r.calls[r.calls.length - 1];
    ck('3d promotion requests → {op:adminListPromotionRequests, status:pending} by default', c.data.op === 'adminListPromotionRequests' && c.data.status === 'pending' && !('view' in c.data), JSON.stringify(c.data));
    const n = r.calls.length;
    await r.go('campaigns');
    ck('3e returning to a loaded tab does not re-read it', r.calls.length === n);
  }

  /* 4 — amounts + reasons */
  {
    const r = await mountWith(router({ 'financialPartnerDispatch:adminListCommercial:entitlements': () => Promise.resolve({ rows: [ENT(), ENT({ id: 'e2', amountKES: null }), ENT({ id: 'e3', amountKES: 0 })] }),
      'financialPartnerDispatch:adminListCommercial:fulfilments': () => Promise.resolve({ rows: [FUL({ id: 'f2', status: 'review', reason: 'amount_mismatch', planId: null, productId: 'featured_7d' })] }) }));
    ck('4a amounts: "KES 4,900"; unknown → "—"; a real 0 → "KES 0"', /^KES 4,?900$/.test(cell(rowOf(r.host, 'e1'), 'Amount')) && cell(rowOf(r.host, 'e2'), 'Amount') === '—' && cell(rowOf(r.host, 'e3'), 'Amount') === 'KES 0', cell(rowOf(r.host, 'e1'), 'Amount'));
    await r.go('fulfilments');
    ck('4b review outcome explained ("payment received, SOKONI is checking it — Amount did not match the catalogue price"); product shown when no plan',
      cell(rowOf(r.host, 'f2'), 'Outcome') === 'Under review — payment received, SOKONI is checking it — Amount did not match the catalogue price' && cell(rowOf(r.host, 'f2'), 'Plan / product') === 'featured_7d', cell(rowOf(r.host, 'f2'), 'Outcome'));
  }

  /* 5 — Stop campaign */
  {
    const dd = deferred();
    let stop = () => dd.p;
    const r = await mountWith(router({ 'financialPartnerDispatch:adminListCommercial:entitlements': () => Promise.resolve({ rows: [] }),
      'financialPartnerDispatch:adminListCommercial:campaigns': () => Promise.resolve({ rows: [CAMP(), CAMP({ id: 'c2', status: 'review', reason: 'listing_not_approved' }), CAMP({ id: 'c3', status: 'stopped' })] }),
      'financialPartnerDispatch:adminStopCampaign': (d) => stop(d) }));
    await r.go('campaigns');
    const btn = (id) => byCm(rowOf(r.host, id), 'act-stop');
    const msg = (id) => byCm(rowOf(r.host, id), 'row-msg').textContent;
    ck('5a "Stop campaign" only on active and review campaigns', !!btn('c1') && !!btn('c2') && !btn('c3'));
    let n = r.calls.length;
    btn('c1').fire('click'); await flush();
    ck('5b Stop without a reason → refused locally, no call', r.calls.length === n && /reason/.test(msg('c1')));
    byCm(rowOf(r.host, 'c1'), 'stop-reason').value = 'Misleading creative';
    btn('c1').fire('click'); await flush();
    const c = r.calls[r.calls.length - 1];
    ck('5c Stop → {op:adminStopCampaign, campaignId, reason}; "Saving…" until the server answers', c.data.op === 'adminStopCampaign' && c.data.campaignId === 'c1' && c.data.reason === 'Misleading creative' && msg('c1') === 'Saving…' && !/stopped/i.test(msg('c1')), JSON.stringify(c.data));
    dd.res({ ok: true, status: 'stopped' }); await flush();
    ck('5d result only after ok, refund routed to the refund authority', msg('c1') === 'Campaign stopped — any refund goes through the refund authority (request → approval); history is kept.' && btn('c1') === undefined);
    stop = () => Promise.reject({ code: 'functions/failed-precondition', message: 'This campaign is not running.' });
    byCm(rowOf(r.host, 'c2'), 'stop-reason').value = 'x';
    btn('c2').fire('click'); await flush();
    ck('5e server refusal shown verbatim; row stays actionable', msg('c2') === 'This campaign is not running.' && !btn('c2').disabled, msg('c2'));
    stop = () => Promise.resolve({ status: 'stopped' });
    btn('c2').fire('click'); await flush();
    ck('5f a reply without ok:true is NOT shown as stopped', msg('c2') === 'The server did not confirm this — nothing changed on screen');
    stop = () => Promise.reject({ code: 'functions/not-found' });
    btn('c2').fire('click'); await flush();
    ck('5g not deployed → "Stop campaign is not available yet …"', /^Stop campaign is not available yet/.test(msg('c2')), msg('c2'));
  }

  /* 6 — promotion requests */
  {
    let decide = () => Promise.resolve({ ok: true, status: 'granted' });
    const r = await mountWith(router({ 'financialPartnerDispatch:adminListCommercial:entitlements': () => Promise.resolve({ rows: [] }),
      'financialPartnerDispatch:adminListPromotionRequests': (d) => Promise.resolve({ rows: d.status === 'pending' ? [PRQ(), PRQ({ id: 'pr2' })] : [PRQ({ id: 'pr9', status: 'granted' })] }),
      'financialPartnerDispatch:adminDecidePromotion': (d) => decide(d) }));
    await r.go('promotions');
    ck('6a label verbatim; requests listed (partner, placement, message)', byCm(r.host, 'promo-label').textContent === 'Promotion ranks a listing; it never verifies it. Granting a request takes no payment.' && cell(rowOf(r.host, 'pr1'), 'Message') === 'Please feature us' && cell(rowOf(r.host, 'pr1'), 'Placement') === 'directory_top');
    const row = rowOf(r.host, 'pr1'), n = r.calls.length;
    byCm(row, 'promo-days').value = '91';
    byCm(row, 'act-grant').fire('click'); await flush();
    ck('6b days outside 1–90 refused locally', r.calls.length === n && /1 to 90/.test(byCm(row, 'row-msg').textContent));
    byCm(row, 'act-decline').fire('click'); await flush();
    ck('6c decline without a note refused locally', r.calls.length === n && /note/.test(byCm(row, 'row-msg').textContent));
    byCm(row, 'promo-days').value = '14';
    byCm(row, 'act-grant').fire('click'); await flush();
    let c = r.calls[r.calls.length - 1];
    ck('6d grant → {op:adminDecidePromotion, id, verdict:granted, days:14}; result after ok', c.data.op === 'adminDecidePromotion' && c.data.id === 'pr1' && c.data.verdict === 'granted' && c.data.days === 14 && !('note' in c.data) && byCm(row, 'row-msg').textContent === 'Promotion granted', JSON.stringify(c.data));
    decide = () => Promise.resolve({ ok: true, status: 'declined' });
    byCm(rowOf(r.host, 'pr2'), 'note').value = 'Listing not approved yet';
    byCm(rowOf(r.host, 'pr2'), 'act-decline').fire('click'); await flush();
    c = r.calls[r.calls.length - 1];
    ck('6e decline → {verdict:declined, note}', c.data.verdict === 'declined' && c.data.note === 'Listing not approved yet' && !('days' in c.data) && byCm(rowOf(r.host, 'pr2'), 'row-msg').textContent === 'Declined');
    byCm(r.host, 'promotions-filter').value = 'granted'; byCm(r.host, 'promotions-filter').fire('change'); await flush();
    ck('6f filter granted → decided rows have no decision buttons', r.calls[r.calls.length - 1].data.status === 'granted' && !!rowOf(r.host, 'pr9') && !byCm(rowOf(r.host, 'pr9'), 'act-grant'));
  }

  /* 7 — read-only catalogue */
  {
    const r = await mountWith(() => Promise.resolve({ rows: [ENT()] }));
    for (const k of ['campaigns', 'fulfilments', 'promotions']) await r.go(k);
    ck('7a catalogue note verbatim (read-only; lives in commercial-entitlements.js; a plan never buys trust)', /^Plans, prices and promotion products are read-only here\. They are defined in the server catalogue \(functions\/commercial-entitlements\.js\)/.test(byCm(r.host, 'catalogue-note').textContent) && /A plan never buys trust/.test(byCm(r.host, 'catalogue-note').textContent));
    const src = fs.readFileSync(MODULE, 'utf8');
    ck('7b no price / plan editing: no catalogue write op, no price input', !/op:\s*'admin(Save|Set|Update|Edit)(Plan|Price|Catalogue|Product)/i.test(src) && !find(r.host, (e) => e.tagName === 'INPUT' && /price|amount/i.test(e.attrs['data-cm'] || '')).length);
    ck('7c the module never assigns innerHTML and never revives admin.html', !/innerHTML\s*=/.test(src) && !/(^|[^-\w])admin\.html/.test(src));
    const strings = (src.replace(/\/\*[\s\S]*?\*\//g, '').match(/'[^'\n]*'/g) || []).filter((s) => /[A-Z][a-z]/.test(s));
    ck('7d no user-facing string claims "verified" / "licensed" / "certified"', !strings.some((s) => /\b(verified|licensed|certified)\b/i.test(s) && !/never verifies/.test(s)), strings.filter((s) => /verif|licens|certif/i.test(s)).join(' | '));
  }

  /* 8 — tabs */
  {
    const r = await mountWith(() => Promise.resolve({ rows: [] }));
    const strip = find(r.host, (e) => e.attrs.role === 'tablist')[0];
    const tabs = find(strip, (e) => e.attrs.role === 'tab');
    ck('8a tablist: Entitlements, Campaigns, Fulfilments, Promotion requests; one selected', tabs.map((t) => t.textContent).join('|') === 'Entitlements|Campaigns|Fulfilments|Promotion requests' && tabs.filter((t) => t.attrs['aria-selected'] === 'true').length === 1 && tabs.filter((t) => t.attrs.tabindex === '0').length === 1);
    tab(r.host, 'entitlements').fire('keydown', { key: 'End' }); await flush();
    ck('8b End moves selection + focus to the last tab', r.host.attrs['data-cm-active'] === 'promotions' && tab(r.host, 'promotions').focused === true);
  }

  /* 9 — wiring */
  {
    const aosHtml = fs.readFileSync(path.join(ROOT, 'admin-os.html'), 'utf8');
    const saHtml = fs.readFileSync(path.join(ROOT, 'super-admin.html'), 'utf8');
    const aosJs = fs.readFileSync(path.join(ROOT, 'sokoni-aos.js'), 'utf8');
    ck('9a AdminOS: nav button (inline onclick + nav-label), panel, script, router entry, mount via _call',
      /data-section="commercial"[^>]*onclick="SokoniAOS\.navigate\('commercial'\);_closeSidebar\(\)"><span class="nav-icon">[^<]*<\/span><span class="nav-label">Partner plans &amp; promotions<\/span>/.test(aosHtml)
      && /id="panel-commercial"/.test(aosHtml) && /id="commercialBody"/.test(aosHtml) && /<script src="sokoni-admin-commercial\.js"><\/script>/.test(aosHtml)
      && /commercial: +\(\) => _loadCommercial\(\)/.test(aosJs) && /SokoniAdminCommercial\.mount\(body, \{ console: "aos", call: \(name, data\) => _call\(name, data\) \}\)/.test(aosJs));
    ck('9b Super Admin: nav button, panel, script, section switch, mount with its own transport',
      /onclick="SA\.nav\('commercial'\);_closeSidebar\(\)"/.test(saHtml) && /<span class="nav-label">Partner plans &amp; promotions<\/span>/.test(saHtml) && /id="panel-commercial"/.test(saHtml) && /id="saCommercialBody"/.test(saHtml)
      && /<script src="sokoni-admin-commercial\.js"><\/script>/.test(saHtml) && /section==='commercial'\)this\.loadCommercial\(\)/.test(saHtml)
      && /SokoniAdminCommercial\.mount\(body,\{console:'sa',call:\(name,data\)=>fns\.httpsCallable\(name\)/.test(saHtml));
    ck('9c the scripts load once each, after the Foundation module, in both consoles',
      (aosHtml.match(/<script src="sokoni-admin-commercial\.js"/g) || []).length === 1 && (saHtml.match(/<script src="sokoni-admin-commercial\.js"/g) || []).length === 1
      && aosHtml.indexOf('<script src="sokoni-admin-foundation.js') < aosHtml.indexOf('<script src="sokoni-admin-commercial.js') && saHtml.indexOf('<script src="sokoni-admin-foundation.js') < saHtml.indexOf('<script src="sokoni-admin-commercial.js'));
    const fd = fs.readFileSync(path.join(ROOT, 'sokoni-admin-foundation.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    ck('9d ONE place for promotion requests: the Foundation module no longer calls adminListPromotionRequests / adminDecidePromotion', !/adminListPromotionRequests|adminDecidePromotion/.test(fd));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
