#!/usr/bin/env node
/* TECH HUB SLICE 4b (hosting) — the provider service editor's Tech fieldset, the Repairs view, the booking device step,
 * and vocabulary parity with the server authority (functions/shared/tech-service-profile.js on feat/tech-taxonomy-on-13f74f3).
 *   node scripts/test-tech-service-editor.js     TECH_FN=<functions tree root> to point at the server source
 * A minimal fake DOM is used (no jsdom in this repo). The real browser run is NOT done here — see the CHANGELOG. */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const TECH_FN = process.env.TECH_FN || 'C:/temp/sok-techfn';
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 240) + ']')); ok ? pass++ : fail++; };
console.log('\nTech service editor (Tech Hub slice 4b, hosting)\n');

/* ── a fake DOM just big enough for the editor ── */
function fakeDom() {
  const byId = {}, listeners = {};
  let inputs = [];
  const mk = (id, extra) => (byId[id] = Object.assign({ id, value: '', checked: false, style: {}, parentNode: null }, extra || {}));
  const form = { children: [], insertBefore(node, ref) { node.parentNode = form; this.children.push(node); }, removeChild(n) { this.children = this.children.filter((c) => c !== n); } };
  const fg = { parentNode: form, nextSibling: null };
  mk('svDesc', { closest: () => fg });
  const doc = {
    getElementById: (id) => byId[id] || null,
    createElement: () => {
      const el = { style: {}, parentNode: null, _html: '' };
      Object.defineProperty(el, 'innerHTML', { get() { return this._html; }, set(v) { this._html = v; inputs = []; const re = /<input([^>]*)>/g; let m;
        while ((m = re.exec(v))) { const a = m[1]; const id = (a.match(/id="([^"]+)"/) || [])[1]; const name = (a.match(/name="([^"]+)"/) || [])[1];
          const value = (a.match(/value="([^"]+)"/) || [])[1]; const node = { id, name, value: value || '', checked: false };
          if (id) byId[id] = node; inputs.push(node); }
        if (this.id) byId[this.id] = this; } });
      Object.defineProperty(el, 'id', { get() { return this._id; }, set(v) { this._id = v; byId[v] = this; } });
      return el;
    },
    querySelectorAll: (sel) => { const n = (sel.match(/name="([^"]+)"/) || [])[1]; return n ? inputs.filter((i) => i.name === n) : []; },
    addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
    dispatch: (t, detail) => (listeners[t] || []).forEach((f) => f({ detail })),
  };
  return { doc, byId, form, inputs: () => inputs };
}
function loadEditor(src) {
  const D = fakeDom();
  const win = { document: D.doc };
  const ctx = { window: win, document: D.doc, setTimeout, console };
  ctx.globalThis = ctx; win.window = win;
  vm.createContext(ctx); vm.runInContext(src, ctx);
  return { D, api: win.SokoniTechEditor };
}
const SRC = read('sokoni-tech-service-editor.js');

/* E1 networking: no device fields; only its granted modes */
{
  const { D, api } = loadEditor(SRC);
  api._internal.onWorkspace({ serviceCapabilities: ['NETWORKING', 'FIELD_SERVICE', 'ONSITE_SUPPORT', 'QUOTE_REQUEST'] });
  const box = D.byId.svTech;
  const modes = D.inputs().filter((i) => i.name === 'svTechMode').map((i) => i.value).sort().join();
  ck('E1', !!box && !D.inputs().some((i) => i.name === 'svTechDev') && modes === 'FIELD_SERVICE,ONSITE_SUPPORT',
    'a networking business sees only its GRANTED service modes and no device fields', { modes, dev: D.inputs().filter((i) => i.name === 'svTechDev').length });
}
/* E2 no Tech capability: no fieldset, nothing sent */
{
  const { D, api } = loadEditor(SRC);
  api._internal.onWorkspace({ serviceCapabilities: ['FOOD_MENU'] });
  ck('E2', !D.byId.svTech && api.read() === undefined, 'a business with no Tech capability gets no fieldset and sends no techProfile');
}
/* E3 device repair: fill → read round-trips */
{
  const { D, api } = loadEditor(SRC);
  api._internal.onWorkspace({ serviceCapabilities: ['DEVICE_REPAIR', 'WORKSHOP', 'PICKUP_DROP_OFF'] });
  const tp = { deviceTypes: ['phone', 'tablet'], repairTypes: ['screen'], brands: ['Samsung'], serviceModes: ['WORKSHOP'], models: ['A54', 'S23'], turnaroundHours: 24, serviceArea: 'CBD' };
  api.fill(tp);
  const out = api.read();
  ck('E3', out && out.deviceTypes.join() === 'phone,tablet' && out.repairTypes.join() === 'screen' && out.brands.join() === 'Samsung' && out.serviceModes.join() === 'WORKSHOP'
    && out.models.join() === 'A54,S23' && out.turnaroundHours === 24 && out.serviceArea === 'CBD' && !D.inputs().some((i) => i.name === 'svTechMode' && i.value === 'ONSITE_SUPPORT'),
    'a device-repair business: the stored profile fills the form and reads back unchanged; ungranted modes are not offered', out);
}
/* E4 the Repairs row escapes customer text and links to Bookings (no state change here) */
{
  const { api } = loadEditor(SRC);
  const row = api._internal.repairRow({ id: 'bk1', service: 'Screen', status: 'paid_held', customerName: '<b>x</b>', repairDetails: { deviceType: 'phone', brand: 'Samsung', problem: '<img src=x onerror=alert(1)>' } });
  ck('E4', !/<img|<b>/.test(row) && /data-tech-repair-open="bk1"/.test(row) && !/onclick=/.test(row), 'a repair row escapes customer text and only links to Bookings', row.slice(0, 200));
}

/* P — the dashboard and booking-flow wiring */
{
  const pd = read('provider-dashboard.html'), bw = read('sokoni-business-workspace.js'), bs = read('sokoni-book-service.js');
  ck('P1', /data-hc-module="repairs" hidden/.test(pd) && /id="panel-repairs"/.test(pd) && /src="sokoni-tech-service-editor\.js"/.test(pd)
    && /SokoniTechEditor\.read\(\)/.test(pd) && /SokoniTechEditor\.fill\(s\.techProfile\)/.test(pd),
    'provider-dashboard: Repairs starts hidden, the editor is loaded, the save sends and the edit fills techProfile');
  ck('P2', /querySelectorAll\('\[data-hc-module\]'\)/.test(bw) && /mods\[el\.getAttribute\('data-hc-module'\)\]/.test(bw) && /sokoni:workspace/.test(bw),
    'workspace client: [data-hc-module] is keyed by MODULE and the answer is shared (no second call)');
  ck('P3', /repairDetails: _ctx\.repairDetails \|\| undefined/.test(bs) && /function renderDevice\(/.test(bs) && !/amount:\s*_ctx/.test(bs),
    'booking flow: the device step sends repairDetails with the booking request, never an amount');
}

/* L — slice 4L: conversations open from the booking (transaction), never from a bare uid */
{
  const mh = read('messages.html'), ib = read('sokoni-inbox.js'), bs = read('sokoni-book-service.js');
  const { api } = loadEditor(SRC);
  const row = api._internal.repairRow({ id: 'bk9', service: 'Screen', status: 'pending', repairDetails: { deviceType: 'phone' } });
  const has = (src, str) => src.indexOf(str) > -1;
  ck('L1', has(mh, 'function _openFromTransaction(){') && has(mh, 'SokoniChat.createConversation(t,id,null,{})') && has(mh, 'if(!_openFromTransaction())_noticeFromUrl();')
    && has(mh, "['service_booking','service_lead','order','rfq','job_application','product_enquiry'].indexOf(t)===-1") && has(ib, "SokoniInbox.TX_TYPES = ['service_booking', 'service_lead', 'order', 'rfq', 'job_application', 'product_enquiry'];"),
    'messages.html opens ?tx=service_booking|service_lead|order|rfq&txId= through the server (createConversation), allow-listed types only (page + inbox agree)');
  ck('L2', has(ib, 'SokoniInbox.openForTransaction = function(type, id)') && has(row, 'data-tech-repair-msg="bk9"')
    && has(bs, "messages.html?tx=service_booking&txId=' + encodeURIComponent(_ctx.bookingId)"),
    'Repairs "Message customer" and the booking view "Message the provider" open the BOOKING conversation');
}

/* F — owner fee model 2026-10-03: the buyer pays the service price only; no provider-declared booking fee */
{
  const pd = read('provider-dashboard.html');
  ck('F1', !/id="svFee"/.test(pd) && pd.indexOf("fee:this._k2c(") === -1 && /Customers pay your service price only/.test(pd),
    'the service editor has no booking-fee field, the save sends no fee, and the commission note names no invented rate');
}

/* F2 — owner decision 2026-10-03: one flat service commission replaces the plan ladder — no per-plan rate is advertised */
{
  const po = read('provider-onboarding.html'), pd = read('provider-dashboard.html');
  ck('F2', !/c:'(20|15|10|7|5)%'/.test(po) && po.indexOf('${p.c} commission') === -1 && pd.indexOf('sub.commissionRate') === -1 && /one rate on every plan/.test(po) && /one rate on every plan/.test(pd),
    'onboarding plans and the dashboard plan card advertise no per-plan commission (no stale 20/15/10/7/5% ladder, no legacy plan rate)');
}

/* F3 — the rate shown comes from the ONE display source (generated snapshot), never a guess */
{
  const po = read('provider-onboarding.html');
  const helper = (po.match(/function _skCommissionLine\(\)\{[\s\S]*?\n\}/) || [''])[0];
  const run = (withSnapshot) => {
    const w = {};
    const c = { window: w, console, isFinite, Number };
    c.globalThis = c; vm.createContext(c);
    if (withSnapshot) vm.runInContext(read('sokoni-commission-rates.js'), c);
    c.SokoniCommission = w.SokoniCommission;
    vm.runInContext(helper + '; window.__line = _skCommissionLine();', c);
    return w.__line;
  };
  const withS = helper ? run(true) : '', without = helper ? run(false) : '';
  const snap = read('sokoni-commission-rates.js');
  const hash = require('crypto').createHash('sha1').update('blob ' + Buffer.byteLength(snap) + '\0' + snap).digest('hex');
  const TPL = '${_skCommissionLine()}';
  ck('F3', /SOKONI commission: 5% of each booking, the same on every plan/.test(withS) && !/\d/.test(without || '') && hash === '703005ebd2ac68eff1622986c2fdd133827248a1'
    && read('provider-dashboard.html').includes(TPL) && po.includes(TPL),
    'with the generated snapshot (byte-identical to 9cab901) the line shows its services rate; without it, no number', { withS, without, hash });
}

/* F4 — plans.html never advertises a plan commission rate or discount (owner 2026-10-03: one flat service commission) */
{
  const pl = read('plans.html');
  const line = (pl.match(/const featureKeys = [^\n]*/) || [''])[0];
  let keys = null;
  try { keys = new Function('features', line + '; return featureKeys;')({ services_limit: 20, leads_per_month: 30, commission_pct: 10, commission_discount_pct: 5, calendar: true }); } catch (_) { keys = null; }
  ck('F4', Array.isArray(keys) && !keys.some((k) => /^commission/.test(k)) && keys.includes('services_limit') && !/Commission discount/.test(pl),
    'a provider plan carrying legacy commission_pct / commission_discount_pct renders neither (features and limits only)', keys);
}

/* M — Tech 4M calling: booking-bound phone reveal through the server, never a number held by the page */
{
  const bs = read('sokoni-book-service.js');
  const { api } = loadEditor(SRC);
  const row = api._internal.repairRow({ id: 'bk7', service: 'Screen', status: 'confirmed', repairDetails: { deviceType: 'phone' } });
  ck('M1', row.includes('data-tech-repair-call="bk7"') && SRC.includes("op: 'providerContactCustomer'")
    && bs.includes("op: 'bookingContactProvider'") && /paymentStatus === 'paid_held' \|\| b\.paymentStatus === 'settled'[^\n]*_call\(\)/.test(bs) && !/tel:\+?2547\d{8}/.test(bs + SRC),
    'Repairs "Call customer" and the paid booking view "Call the provider" ask the server for the number (shown only once paid); no number is hard-coded');
}

/* C4 — Tech 4C delivery-mode views: bookings filtered by the server-stamped booking.serviceMode */
{
  const { api } = loadEditor(SRC);
  const I = api._internal, pd = read('provider-dashboard.html');
  const row = I.modeRow({ id: 'bk3', service: 'Router setup', status: 'confirmed', serviceMode: 'ONSITE_SUPPORT', customerName: '<b>x</b>', note: '<img src=x onerror=1>' });
  const pick = (key, mode) => (I.MODE_OF[key] || []).indexOf(mode) > -1;
  ck('C4', pick('siteVisits', 'ONSITE_SUPPORT') && pick('siteVisits', 'FIELD_SERVICE') && pick('remoteSupport', 'REMOTE_SUPPORT') && pick('pickupDropoff', 'PICKUP_DROP_OFF')
    && !pick('siteVisits', 'REMOTE_SUPPORT') && !/<img|<b>/.test(row) && row.includes('data-tech-repair-open="bk3"')
    && ['siteVisits', 'remoteSupport', 'pickupDropoff'].every((k) => new RegExp('data-hc-module="' + k + '" hidden').test(pd))
    && pd.includes("loadModeJobs('siteVisits','svList')") && pd.includes("loadModeJobs('pickupDropoff','pdList')"),
    'Site visits / Remote support / Pickup views filter by booking.serviceMode, escape customer text, start hidden and load on open');
}

/* MB1 — e3 Fitness Memberships wiring (d70eca5 exact diff): gated by module, panel present, mounts on open, module script loaded */
const mbWired = (pd) => /data-hc-module="memberships" hidden aria-hidden="true" onclick="P\.show\('memberships',this\)"/.test(pd)
  && pd.includes('id="panel-memberships"') && pd.includes('id="mbList"')
  && pd.includes("if(id==='memberships'&&window.SokoniFitnessMemberships)SokoniFitnessMemberships.mount(_q('mbList'));")
  && pd.includes('<script src="sokoni-fitness-memberships.js" defer></script>');
{
  const pd = read('provider-dashboard.html');
  ck('MB1', mbWired(pd), 'Memberships item starts hidden behind data-hc-module, panel + mount line + module script present');
  const ungated = pd.replace('data-hc-module="memberships" hidden aria-hidden="true"', 'data-hc-module="memberships"');
  const caught = ungated !== pd && !mbWired(ungated);
  console.log('  [sabotage] ' + (caught ? 'CAUGHT' : 'MISSED') + '  Memberships item shown without the module gate → MB1'); if (!caught) fail++;
}

/* T10 — vocabulary parity with the server authority */
{
  const serverFile = path.join(TECH_FN, 'functions', 'shared', 'tech-service-profile.js');
  let S = null; try { S = require(serverFile); } catch (_) { S = null; }
  if (!S) ck('T10', false, 'server vocabulary readable at ' + serverFile + ' (set TECH_FN) — BLOCKED is not a pass');
  else {
    const { api } = loadEditor(SRC);
    const I = api._internal;
    const bs = read('sokoni-book-service.js');
    const keysOf = (name) => { const m = bs.match(new RegExp('const ' + name + ' = \\{([\\s\\S]*?)\\};')); return m ? (m[1].match(/([A-Za-z_]+):/g) || []).map((k) => k.slice(0, -1)).sort().join() : ''; };
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    ck('T10', same(I.DEVICE_TYPES, S.DEVICE_TYPES) && same(I.REPAIR_TYPES, S.REPAIR_TYPES) && same(I.BRANDS, S.BRANDS) && same(I.MODE_CAPS, S.MODE_CAPS)
      && keysOf('DEVICE_LABEL') === Object.keys(S.DEVICE_TYPES).sort().join() && keysOf('REPAIR_LABEL') === Object.keys(S.REPAIR_TYPES).sort().join()
      && keysOf('MODE_LABEL') === S.MODE_CAPS.slice().sort().join(),
      'editor + booking-flow vocabularies are identical to the server validator');
  }
}

/* sabotage: an editor that offers every mode regardless of the grant */
{
  const bad = SRC.replace('var modes = function () { return MODE_CAPS.filter(function (c) { return caps.indexOf(c) > -1; }); };', 'var modes = function () { return MODE_CAPS.slice(); };');
  let caught = false;
  if (bad !== SRC) {
    const { D, api } = loadEditor(bad);
    api._internal.onWorkspace({ serviceCapabilities: ['NETWORKING', 'FIELD_SERVICE', 'ONSITE_SUPPORT'] });
    caught = D.inputs().filter((i) => i.name === 'svTechMode').length !== 2;
  }
  console.log('\n  [sabotage] ' + (caught ? 'CAUGHT' : 'MISSED') + '  editor offers ungranted modes'); if (!caught) fail++;
}
console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
console.log('NOT proven here: a real browser render of the dashboard and the booking modal (memory floor), and a live booking.');
process.exit(fail ? 1 : 0);
