#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   COMMUNICATION RAILS IN THE INTEGRATION CONSOLE — lanes, not labels   (C3 / C4)
   scripts/test-integration-comms-lanes.js

   WHAT THIS PROTECTS
   ------------------
   A messaging provider is several lanes: what SOKONI sends, what the provider
   posts back, and what — if anything — a human can send INTO SOKONI through it.
   The catalogue must say which lanes exist, and the console must keep three
   different things apart on one card:

       CONFIGURATION          secret names, and whether each is provisioned
       OBSERVABLE CAPABILITY  the observed-state chip and the stage evidence
       OPERATIONAL WORKSPACE  where the rail is actually used (a link, in AdminOS)

   Configuration presence must never read as ACTIVE. An inbound lane with no
   safe probe must read UNKNOWN — never healthy, never REFUSED BY DESIGN (that
   is a declaration the platform did not make), and never a synthetic
   observation. `integrationProbeLatest` is not touched by any file this slice
   edits.

   HOW IT RUNS
   -----------
   Facts are derived from the PRODUCERS (functions/index.js exports, the module
   files, the executor and support tables, the status resolver), never from a
   fixture. The console is the shipped module, mounted in a minimal DOM with an
   injected status record; what is asserted is the HTML it produced. Every
   absence check has a positive control in the same run, and the negative
   controls mutate in-process copies only — nothing on disk is ever changed.
   Exit: 0 all passed · 1 a test failed · 2 the harness could not run
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d ? '   [' + d + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '   [' + (typeof d === 'string' ? d : JSON.stringify(d)) + ']' : '')); }
};
const head = (t) => console.log('\n' + t);
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

const CAT_SRC = read('sokoni-integration-catalogue.js');
const CON_SRC = read('sokoni-integrations.js');
const INDEX   = read('functions/index.js');
const ADMINOS = read('admin-os.html');
const registry = require(path.join(ROOT, 'functions/integration-registry.js'));
const execs    = require(path.join(ROOT, 'functions/integration-probe-executors.js'));
const probes   = require(path.join(ROOT, 'functions/integration-probes.js'));
const evidence = require(path.join(ROOT, 'functions/integration-evidence.js'));
const status   = require(path.join(ROOT, 'functions/integration-status.js'));

function loadCatalogue (src) {
  const shim = { window: {} };
  vm.createContext(shim);
  vm.runInContext(src || CAT_SRC, shim, { filename: 'sokoni-integration-catalogue.js' });
  return shim.window.SokoniIntegrationCatalogue;
}
const cat = loadCatalogue();
const exported = (name) => new RegExp('^exports\\.' + name + '\\s*=', 'm').test(INDEX);

/* ── minimal DOM + mount, the same shape test-integrations-console.js uses ── */
function makeEl (id) {
  return { id, innerHTML: '', style: {}, className: '', appendChild () {}, addEventListener () {},
           setAttribute () {}, removeAttribute () {}, querySelector: () => null, querySelectorAll: () => [] };
}
function makeWindow () {
  const doc = { head: makeEl('head'), body: makeEl('body'), getElementById: () => null,
                createElement: (t) => makeEl(t), querySelector: () => null, querySelectorAll: () => [], addEventListener () {} };
  return { document: doc, addEventListener () {}, setTimeout, clearTimeout, console };
}
function record (over) {
  return Object.assign({
    id: 'sendgrid', name: 'SendGrid — Transactional Email', vendor: 'Twilio SendGrid', category: 'messaging',
    lifecycle: 'live', direction: 'bidirectional',
    credentials: [{ name: 'SENDGRID_API_KEY', present: true }, { name: 'SENDGRID_WEBHOOK_KEY', present: true }],
    credentialState: 'configured', health: 'unknown',
    healthNote: 'No probe has run for this integration; provider health is not measured.',
    stages: null, stageSupport: null, evidence: 'none', probedAt: null, notRunReason: null,
    capabilities: ['view', 'view-credential-names'], checkedAt: '2026-09-29T10:00:00.000Z',
  }, over || {});
}
function mountWith (records) {
  const win = makeWindow(); const ctx = vm.createContext(win); ctx.window = win;
  vm.runInContext(CAT_SRC, ctx); vm.runInContext(CON_SRC, ctx);
  const host = makeEl('host');
  win.SokoniIntegrations.mount(host, { getIntegrationStatus: () => Promise.resolve({
    integrations: records, counts: {}, checkedAt: '2026-09-29T10:00:00.000Z', inventoryReadable: true }) });
  return { api: win.SokoniIntegrations, host, win };
}
const settle = () => new Promise((r) => setImmediate(() => setImmediate(r)));
async function detailHtml (m, id) { m.api.tab('catalogue'); m.api.selectCatalogue(id); await settle(); return m.host.innerHTML; }
/* The detail ASIDE only. The grid beside it legitimately shows ACTIVE for rails
   with an operational evidence source, so an absence check over the whole page
   would be testing other cards. */
function aside (html) { const i = html.indexOf('<aside class="sic-card sic-detail"'); if (i < 0) return ''; return html.slice(i, html.indexOf('</aside>', i)); }

/* The lanes each rail is expected to declare, derived from the code the lane
   lives in. `endpoint` must be an export of functions/index.js; `module` must
   exist on disk. Nothing here is a fixture of what the catalogue says. */
const RAILS = [
  { id: 'sendgrid',              endpoint: 'emailWebhook',       modules: ['functions/email-service.js', 'functions/email-triggers.js'], workspace: 'admin-os.html#comms/email', tab: 'email',
    mustSay: [/outbound/i, /event/i, /inbound human mail not implemented/i], mustNotSay: [/two-way/i, /reply from/i, /inbox/i] },
  { id: 'sendgrid-inbound-parse', endpoint: 'dmarcReportWebhook', modules: ['functions/email-dmarc.js'], workspace: 'admin-os.html#comms/email', tab: 'email',
    mustSay: [/DMARC/, /not a mailbox/i, /not provisioned/i], mustNotSay: [/two-way/i, /reply from/i, /human mail is (?:now )?(?:provisioned|implemented)/i] },
];

(async () => {
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('  COMMUNICATION RAILS — lanes in the catalogue, three rows on the card');
  console.log('══════════════════════════════════════════════════════════════════');

  head('A - the catalogue states lanes that the code actually has');
  for (const r of RAILS) {
    const e = cat.lookup(r.id);
    ok(r.id + ': catalogued', !!e);
    if (!e) continue;
    const ev = e.evidence || {};
    ok(r.id + ': its endpoint ' + r.endpoint + ' is declared AND exported by functions/index.js',
       (ev.endpoints || []).indexOf(r.endpoint) > -1 && exported(r.endpoint));
    ok(r.id + ': every module it names exists on disk, and the lane modules are among them',
       (ev.modules || []).every(exists) && r.modules.every((mod) => (ev.modules || []).indexOf(mod) > -1),
       (ev.modules || []).filter((x) => !exists(x)).join(',') || 'all present');
    const text = [e.summary, e.notes, (e.health || {}).note].join(' ');
    ok(r.id + ': says what exists — ' + r.mustSay.map(String).join(' '), r.mustSay.every((re) => re.test(text)));
    ok(r.id + ': never claims a lane that does not exist — ' + r.mustNotSay.map(String).join(' '), r.mustNotSay.every((re) => !re.test(text)));
    ok(r.id + ': operational workspace route is ' + r.workspace, !!(e.workspace && e.workspace.route === r.workspace && e.workspace.label));
    ok(r.id + ': that route resolves — admin-os.html has the comms tab "' + r.tab + '"', new RegExp('commsTab\\(\'' + r.tab + '\'\\)').test(ADMINOS));
    ok(r.id + ': carries no number (the catalogue is identity, never a metric)', !/\b\d{2,}\b/.test([e.summary, e.notes].join(' ')));
  }
  const inbound = cat.lookup('sendgrid-inbound-parse');
  ok('the inbound lane is its own entry: inbound-only lifecycle, inbound direction, no secrets',
     !!inbound && inbound.status === 'inbound-only' && inbound.direction === 'inbound' && !((inbound.evidence || {}).secrets || []).length);
  ok('its collections are the ones functions/email-dmarc.js actually writes',
     (() => { const src = read('functions/email-dmarc.js'); const cols = (inbound.evidence.collections || []); return cols.length > 0 && cols.every((c) => src.indexOf('collection("' + c + '")') > -1); })());
  ok('the registry mirrors it with the same lifecycle, vendor and (empty) secrets',
     (() => { const r = registry.INTEGRATIONS.find((x) => x.id === inbound.id);
              return !!r && r.status === 'inbound-only' && r.vendor === inbound.vendor && r.requiredSecrets.length === 0; })());

  head('B - the evidence model: UNKNOWN is not REFUSED, and nothing is synthetic');
  ok('sendgrid-inbound-parse has NO executor (probeAvailability = none)', execs.probeAvailability('sendgrid-inbound-parse') === 'none');
  ok('… and NO stage-support row — a lane nothing SOKONI sends can reach cannot evidence "received"', probes.supportFor('sendgrid-inbound-parse').hasProbe === false);
  ok('… so its static not-run reason is null: unmeasured, not a refusal', evidence.staticNotRunReason('sendgrid-inbound-parse') === null);
  ok('sendgrid still declares requires_secret_binding (the declaration is unchanged)',
     execs.probeAvailability('sendgrid') === 'requires_secret_binding' && evidence.staticNotRunReason('sendgrid') === 'requires_secret_binding');
  const res = await status.resolveIntegrationStatus({ listSecretNames: async () => ['SENDGRID_API_KEY', 'SENDGRID_WEBHOOK_KEY'], evidenceStore: evidence.memoryStore() });
  const rec = (id) => res.integrations.find((i) => i.id === id);
  const ib = rec('sendgrid-inbound-parse'), sg = rec('sendgrid');
  ok('resolver: inbound lane → health unknown, notRunReason null, declaredProbeState none, no "test" control',
     !!ib && ib.health === 'unknown' && ib.notRunReason === null && ib.declaredProbeState === 'none' && ib.capabilities.indexOf('test') === -1,
     ib && { health: ib.health, notRunReason: ib.notRunReason, declared: ib.declaredProbeState, caps: ib.capabilities });
  ok('resolver: sendgrid with BOTH secrets present → credentialState configured, health STILL unknown, notRunReason requires_secret_binding',
     !!sg && sg.credentialState === 'configured' && sg.health === 'unknown' && sg.notRunReason === 'requires_secret_binding',
     sg && { cred: sg.credentialState, health: sg.health, reason: sg.notRunReason });
  ok('the two are DIFFERENT states on the same resolver (refused ≠ unknown)', !!ib && !!sg && (ib.notRunReason || 'null') !== (sg.notRunReason || 'null'));
  ok('inbound lane: credentialState not-applicable (no secret) — neither "configured" nor "missing"', !!ib && ib.credentialState === 'not-applicable');
  ok('integrationProbeLatest is untouched: the catalogue, registry and console never mention it; admin-os.js still owns the write',
     ['sokoni-integration-catalogue.js', 'functions/integration-registry.js', 'sokoni-integrations.js'].every((f) => read(f).indexOf('integrationProbeLatest') === -1)
     && /integrationProbeLatest/.test(read('functions/admin-os.js')));

  head('C - the console keeps configuration, capability and workspace apart on one card');
  const m = mountWith([record(), record({ id: 'sendgrid-inbound-parse', name: 'SendGrid Inbound Parse — DMARC reports only', lifecycle: 'inbound-only', direction: 'inbound', credentials: [], credentialState: 'not-applicable', capabilities: ['view'] })]);
  await settle();
  const sgHtml = await detailHtml(m, 'sendgrid');
  ok('sendgrid card: CONFIGURATION row — both secret names, values never', /SENDGRID_API_KEY/.test(sgHtml) && /SENDGRID_WEBHOOK_KEY/.test(sgHtml) && /Names only/.test(sgHtml));
  ok('sendgrid card: configured secrets + unknown health does NOT render LIVE or ACTIVE (configuration is not activity)', !/chipstate healthy/.test(aside(sgHtml)) && /Observed state/.test(aside(sgHtml)) && /NOT PROBED/.test(aside(sgHtml)));
  const refusedHtml = await (async () => { const m2 = mountWith([record({ notRunReason: 'requires_secret_binding' })]); await settle(); return detailHtml(m2, 'sendgrid'); })();
  ok('sendgrid card: CAPABILITY row — with the declared refusal the chip is REFUSED BY DESIGN, and LIVE/ACTIVE is absent', /REFUSED BY DESIGN/.test(aside(refusedHtml)) && !/chipstate healthy/.test(aside(refusedHtml)));
  ok('sendgrid card: WORKSPACE row — a link to admin-os.html#comms/email labelled Email workspace',
     /Operational workspace/.test(sgHtml) && /href="admin-os\.html#comms\/email" data-sic-workspace="sendgrid"/.test(sgHtml) && /Email workspace/.test(sgHtml));
  const ibHtml = await detailHtml(m, 'sendgrid-inbound-parse');
  ok('inbound card: chip is NOT PROBED (unknown), not REFUSED BY DESIGN, not LIVE/ACTIVE', /NOT PROBED/.test(aside(ibHtml)) && !/REFUSED BY DESIGN/.test(aside(ibHtml)) && !/chipstate healthy/.test(aside(ibHtml)));
  ok('CONTROL: the whole page DOES contain a healthy chip elsewhere — so the aside-scoped absence above is a real absence', /chipstate healthy/.test(ibHtml));
  ok('inbound card: lifecycle badge reads inbound-only and the "not a mailbox" sentence is on the card', /inbound-only/i.test(ibHtml) && /not a mailbox/i.test(ibHtml));
  ok('inbound card: links to the same Email workspace (inbound status)', /data-sic-workspace="sendgrid-inbound-parse"/.test(ibHtml) && /Email workspace \(inbound status\)/.test(ibHtml));
  ok('POSITIVE CONTROL: an entry with no workspace declared renders the card but no workspace row',
     await (async () => { const h = await detailHtml(m, 'smtp-fallback'); return !/Operational workspace/.test(h) && /SMTP/.test(h); })());
  ok('the grid renders both messaging entries as cards',
     (() => { m.api.tab('catalogue'); m.api.select(null); const h = m.host.innerHTML; return /SendGrid Inbound Parse/.test(h) && /SendGrid — Transactional Email/.test(h); })());

  head('D - negative controls (in-process copies; nothing on disk changes)');
  /* D1: a hostile workspace route must be dropped, not rendered. */
  {
    const m2 = mountWith([record()]); await settle();
    const real = m2.win.SokoniIntegrationCatalogue.lookup;
    const withRoute = (route) => function (id) { const e = real(id); if (!e) return e; const c = Object.assign({}, e); c.workspace = { route, label: 'x' }; return c; };
    m2.win.SokoniIntegrationCatalogue.lookup = withRoute('javascript:alert(1)');
    const h = await detailHtml(m2, 'sendgrid');
    ok('D1  a non-AdminOS workspace route renders NO link at all (card still renders)', !/Operational workspace/.test(h) && !/javascript:/.test(h) && /SendGrid/.test(h));
    m2.win.SokoniIntegrationCatalogue.lookup = withRoute('https://evil.example/admin-os.html#comms/email');
    const h2 = await detailHtml(m2, 'sendgrid');
    ok('D1b an external URL carrying the right-looking route is dropped too', !/Operational workspace/.test(h2) && !/evil\.example/.test(h2));
    m2.win.SokoniIntegrationCatalogue.lookup = withRoute('admin-os.html#comms/email');
    const h3 = await detailHtml(m2, 'sendgrid');
    ok('D1c CONTROL: the same injection with a lawful route DOES render — the matcher sees the row', /Operational workspace/.test(h3));
  }
  /* D2: a synthetic "received" capability on the inbound lane would flip check B — prove the check bites. */
  {
    probes.SUPPORT['sendgrid-inbound-parse'] = { connected: false, accepted: false, delivered: false, received: true };
    const flipped = probes.supportFor('sendgrid-inbound-parse').hasProbe === true;
    delete probes.SUPPORT['sendgrid-inbound-parse'];
    ok('D2  planting a stage-support row for the inbound lane is DETECTED by check B (and removed again)', flipped && probes.supportFor('sendgrid-inbound-parse').hasProbe === false);
  }
  /* D3: a catalogue copy that promotes the inbound lane to live/bidirectional fails check A. */
  {
    const bad = CAT_SRC.replace("status: 'inbound-only', direction: 'inbound',", "status: 'live', direction: 'bidirectional',");
    if (bad === CAT_SRC) { console.error('PROBE INVALID — inbound entry anchor not found'); process.exit(2); }
    const e2 = loadCatalogue(bad).lookup('sendgrid-inbound-parse');
    ok('D3  a catalogue that calls the inbound lane live/bidirectional is caught by the lifecycle check', !(e2.status === 'inbound-only' && e2.direction === 'inbound'));
  }
  ok('D4  registry and catalogue agree on the id set (same count, sendgrid-inbound-parse on both sides)',
     registry.INTEGRATIONS.length === cat.integrations.length && registry.INTEGRATIONS.some((r) => r.id === 'sendgrid-inbound-parse'));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR — ' + (e && e.stack || e)); process.exit(2); });
