/* ============================================================================
   CERTIFICATION — Integrations Control Center
   tests/certify-integrations-console.js
   ============================================================================
   Certifies sokoni-integrations.js, sokoni-integration-catalogue.js and the two
   consoles that mount them (admin-os.html, super-admin.html).

   HOW THIS SUITE IS BUILT, AND WHY
   --------------------------------
   The module's entire output is a string assigned to `root.innerHTML`. So the
   suite runs the REAL module against a minimal DOM and a scripted Firestore,
   then asserts on what it actually rendered. Nothing is asserted by reading the
   source file — a check that greps source can pass on a comment describing the
   behaviour rather than the behaviour itself.

   EVERY ABSENCE ASSERTION IS PAIRED WITH A POSITIVE CONTROL
   ----------------------------------------------------------
   "The secret does not appear" is worthless on its own: it passes identically
   when the row never rendered, when the matcher is wrong, and when the module
   threw. So each absence check is paired with a presence check that MUST hold
   in the same render — proving the matcher can see that row at all. A positive
   control that fails turns its partner absence check into a FAIL, not a pass.

   THE HARNESS FAILS CLOSED
   ------------------------
   A throw inside a case is a FAIL, never a skip. A case that registers no
   assertions is a FAIL. The run aborts non-zero unless the expected minimum
   number of assertions actually executed, so a suite that silently stops
   running cannot report success.

   RUN
     node tests/certify-integrations-console.js
   ========================================================================== */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.resolve(__dirname, '..');

/* Raise this whenever cases are added. A suite that stops early then fails
   loudly instead of printing a green summary over half a run. */
const MIN_ASSERTIONS = 60;

/* ── Tiny result recorder ────────────────────────────────────────────── */
let PASS = 0, FAIL = 0, ASSERTS = 0;
const FAILURES = [];
let _caseAsserts = 0;

function ok(label, cond, detail) {
  ASSERTS++; _caseAsserts++;
  if (cond) { PASS++; return true; }
  FAIL++;
  FAILURES.push(label + (detail ? '  — ' + detail : ''));
  return false;
}

function runCase(name, fn) {
  _caseAsserts = 0;
  try {
    fn();
  } catch (e) {
    ASSERTS++; FAIL++;
    FAILURES.push('[' + name + '] THREW: ' + (e && e.stack ? e.stack.split('\n')[0] : e));
    return;
  }
  if (_caseAsserts === 0) {
    ASSERTS++; FAIL++;
    FAILURES.push('[' + name + '] registered NO assertions — a silent case is a failure, not a pass.');
  }
}

/* ── Minimal DOM ─────────────────────────────────────────────────────
   Only what the module touches. Deliberately NOT a browser: if the module
   ever reaches for something else, this throws and the case fails, which is
   the correct outcome for an untested code path. */
function makeDom() {
  const byId = {};
  const head = { children: [], appendChild(el) { this.children.push(el); if (el.id) byId[el.id] = el; } };
  const doc = {
    head,
    getElementById: (id) => byId[id] || null,
    createElement: () => ({ id: '', textContent: '' }),
  };
  return {
    doc,
    /** Register a mount point the module can find and write into. */
    mountPoint(id) {
      const el = { id, innerHTML: '' };
      byId[id] = el;
      return el;
    },
  };
}

/** A scripted Firestore: each collection either resolves docs or rejects.
    The snapshot carries `size` and `docs` as well as `forEach`, because the
    activity analytics read those. `orderBy` is honoured so the "most recent
    write" path is exercised for real rather than stubbed, and a collection
    marked `noOrder` rejects an ordered query — which is how a missing index or
    a missing field behaves in production. */
function makeFirestore(plan) {
  function snap(rows) {
    const wrapped = rows.map((d) => ({ id: d.id, data: () => d }));
    return {
      size: wrapped.length, empty: wrapped.length === 0, docs: wrapped,
      forEach: (cb) => wrapped.forEach(cb),
    };
  }
  function ref(name, order, lim) {
    return {
      orderBy: (field, dir) => ref(name, { field, dir: dir || 'asc' }, lim),
      limit:   (n) => ref(name, order, n),
      get() {
        const p = plan[name];
        if (!p) return Promise.resolve(snap([]));
        if (p.deny) return Promise.reject(new Error(p.deny));
        let rows = (p.docs || []).slice();
        if (order) {
          if (p.noOrder) return Promise.reject(new Error('The query requires an index.'));
          rows = rows.filter((d) => d[order.field] !== undefined)
                     .sort((a, b) => {
                       const x = a[order.field], y = b[order.field];
                       return order.dir === 'desc' ? (x < y ? 1 : x > y ? -1 : 0)
                                                   : (x > y ? 1 : x < y ? -1 : 0);
                     });
        }
        if (lim) rows = rows.slice(0, lim);
        return Promise.resolve(snap(rows));
      },
    };
  }
  return { firestore: () => ({ collection: (n) => ref(n, null, null) }) };
}

/* ── Load the two modules into one sandbox ───────────────────────────── */
function loadConsole(plan) {
  const dom = makeDom();
  const sandbox = {
    window: {},
    document: dom.doc,
    firebase: makeFirestore(plan),
    console,
    setTimeout,
    URL,
    Date,
    Math,
    Object,
    JSON,
  };
  sandbox.window.document = dom.doc;
  vm.createContext(sandbox);

  for (const f of ['sokoni-integration-catalogue.js', 'sokoni-integrations.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
  }
  return { sandbox, dom, api: sandbox.window.SokoniIntegrations, cat: sandbox.window.SokoniIntegrationCatalogue };
}

/** Mount, wait for the async load to settle, and return the rendered HTML. */
function render(plan, steps) {
  const { api, dom } = loadConsole(plan);
  const el = dom.mountPoint('root');
  api.mount(el);
  /* mount() kicks off four promises; two microtask drains settle them. */
  return Promise.resolve().then(() => new Promise((r) => setTimeout(r, 0))).then(() => {
    if (steps) steps(api);
    return el.innerHTML;
  });
}

/** Mount with injected options, then run `steps` and let the on-demand
    analytics settle before reading the DOM. Selecting a card starts reads that
    resolve over several microtasks; draining them here is what makes the
    assertions run against the MEASURED render rather than the "running" one. */
function renderWith(plan, opts, steps) {
  const { api, dom } = loadConsole(plan);
  const el = dom.mountPoint('root');
  api.mount(el, opts);
  const drain = () => new Promise((r) => setTimeout(r, 0));
  return drain().then(drain).then(() => {
    if (steps) steps(api);
    return drain().then(drain).then(drain).then(() => el.innerHTML);
  });
}

/* ── Fixtures ────────────────────────────────────────────────────────── */
const NOW = Date.now();
const FRESH = NOW - 60 * 1000;          /* 1 min  — well inside the window */
const NEAR  = NOW - 4 * 60 * 1000;      /* 4 min  — inside a 5-min window  */
const STALE = NOW - 30 * 60 * 1000;     /* 30 min — outside it             */

const WEBHOOK_SECRET = 'whsec_CERT_CANARY_d41d8cd98f00b204e9800998ecf8427e';

const FULL = {
  platformServices: { docs: [
    { id: 'svc-live',   serviceId: 'svc-live',   name: 'Live Service',   type: 'platform',
      version: '1.2.0', uses: ['payments', 'ledger'], status: 'active' },
    { id: 'svc-stale',  serviceId: 'svc-stale',  name: 'Stale Service',  type: 'product', version: '0.9.0' },
    { id: 'svc-silent', serviceId: 'svc-silent', name: 'Silent Service', type: 'integration', version: '1.0.0' },
  ] },
  platformHealth: { docs: [
    { id: 'svc-live',  serviceId: 'svc-live',  status: 'healthy', lastHeartbeat: FRESH, latencyMs: 42, errorRate: 0 },
    { id: 'svc-stale', serviceId: 'svc-stale', status: 'healthy', lastHeartbeat: STALE },
    /* svc-silent has NO health document, on purpose. */
  ] },
  platformDependencies: { docs: [
    { id: 'svc-live→svc-stale', from: 'svc-live', to: 'svc-stale', registeredAt: FRESH },
    { id: 'svc-live→ghost',     from: 'svc-live', to: 'ghost',     registeredAt: FRESH },
  ] },
  posWebhooks: { docs: [
    { id: 'wh1', sellerId: 'seller-alpha', url: 'https://hooks.example.co.ke/sokoni',
      events: ['sale.completed'], active: true, failureCount: 0,
      secret: WEBHOOK_SECRET, createdAt: FRESH },
  ] },
};

const ALL_DENIED = {
  platformServices:     { deny: 'PERMISSION_DENIED' },
  platformHealth:       { deny: 'PERMISSION_DENIED' },
  platformDependencies: { deny: 'PERMISSION_DENIED' },
  posWebhooks:          { deny: 'PERMISSION_DENIED' },
};

const ALL_EMPTY = {
  platformServices:     { docs: [] },
  platformHealth:       { docs: [] },
  platformDependencies: { docs: [] },
  posWebhooks:          { docs: [] },
};

/* Pull the count out of a tab's pill. These counts go through a different code
   path from the stat tiles, so they need their own coverage — pre-flight
   sabotage found the tiles guarded and the pills not. */
/* Keyed on the tab's stable ID, not its display label. Keying on the label made
   this return null the moment the Registered tab was re-worded to
   "Self-registration log" (RC-2), which broke three assertions while the
   invariant they protect — a pill shows an em dash, never 0, when the read
   failed — was still perfectly true. A test should follow identity, not copy. */
function pillValue(html, tabId) {
  const m = new RegExp("tab\\('" + tabId + "'\\)\"[^>]*>.*?" +
                       '<span class="sic-pill">(.*?)<\\/span>').exec(html);
  return m ? m[1] : null;
}

/* ── The observed-state chip, scoped to ONE card ──────────────────────
   Scoped by the card's own selectCatalogue() handle and cut at the next card,
   so a neighbouring card's chip — or any prose elsewhere on the page — cannot
   satisfy an assertion about this one. Returns null when the card is absent,
   so a missing card cannot masquerade as a chip-less card. */
function cardChip (html, id) {
  const open = html.indexOf("selectCatalogue('" + id + "')");
  if (open === -1) return null;
  const next = html.indexOf('<button class="sic-ic"', open);
  const card = html.slice(open, next === -1 ? undefined : next);
  const m = /<span class="sic-chipstate [^"]*"[^>]*>([^<]*)<\/span>/.exec(card);
  return m ? m[1].trim() : null;
}

/** The title text carrying the derivation, for the same card. */
function cardChipWhy (html, id) {
  const open = html.indexOf("selectCatalogue('" + id + "')");
  if (open === -1) return null;
  const next = html.indexOf('<button class="sic-ic"', open);
  const card = html.slice(open, next === -1 ? undefined : next);
  const m = /<span class="sic-chipstate [^"]*" title="([^"]*)"/.exec(card);
  return m ? m[1] : null;
}

/* Pull the rendered VALUE of a GCP metric row, with markup stripped.
   A figure may be wrapped in a link button — that is a certified behaviour, not
   an accident — so matching on a bare `<strong>0` would fail on correct output.
   This extracts what the operator actually reads, which is what should be
   asserted on. Returns null when the row is absent, so a missing row cannot
   masquerade as an em dash. */
/* Slice the markup belonging to ONE database section. Both databases render
   rows with identical labels, so an unscoped lookup silently answers with
   whichever came first — which would have let an assertion about sokoni-ops
   pass or fail on (default)'s value. Scope first, then read. */
function dbSection (html, dbId) {
  const start = html.indexOf('<div class="sic-sect-l">' + dbId + '</div>');
  if (start === -1) return '';
  const next = html.indexOf('<div class="sic-sect-l">', start + 1);
  return html.slice(start, next === -1 ? undefined : next);
}

function metricValue (html, label) {
  const re = new RegExp('<span>' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
                        '<\\/span><strong>([\\s\\S]*?)<span class="sic-badge');
  const m = re.exec(html);
  if (!m) return null;
  return m[1].replace(/<[^>]*>/g, '').trim();
}

/* Pull the numeric value out of a named stat tile in the rendered markup. */
function statValue(html, label) {
  const i = html.indexOf('>' + label + '</div>');
  if (i === -1) return null;
  const m = /<div class="v">(.*?)<\/div>/.exec(html.slice(i));
  return m ? m[1] : null;
}

/* ══════════════════════════════════════════════════════════════════════
   MAIN
   ═════════════════════════════════════════════════════════════════════ */
(async function main() {

  /* ── A. Unknown is never rendered as zero ────────────────────────── */

  /* All renders are produced up front so each case body stays synchronous —
     an `async` case body would resolve after runCase() returned and its
     assertions would never be counted, which is exactly the silent-pass mode
     this harness refuses to have. */
  const denied = await render(ALL_DENIED, (api) => api.tab('registered'));
  const empty  = await render(ALL_EMPTY,  (api) => api.tab('registered'));
  const full   = await render(FULL,       (api) => api.tab('registered'));

  /* Registry readable, heartbeats denied. */
  const partialHtml = await render({
    platformServices:     FULL.platformServices,
    platformHealth:       { deny: 'PERMISSION_DENIED' },
    platformDependencies: FULL.platformDependencies,
    posWebhooks:          FULL.posWebhooks,
  }, (api) => api.tab('registered'));

  /* A heartbeat 4 minutes old — inside the 5-minute window, so healthy. */
  const nearHtml = await render({
    platformServices: { docs: [{ id: 'svc-near', serviceId: 'svc-near', name: 'Near Service',
                                 type: 'platform', version: '1.0.0' }] },
    platformHealth:   { docs: [{ id: 'svc-near', serviceId: 'svc-near', status: 'healthy',
                                 lastHeartbeat: NEAR }] },
    platformDependencies: { docs: [] },
    posWebhooks:          { docs: [] },
  }, (api) => api.tab('registered'));

  const webhookHtml = await render(FULL, (api) => api.tab('webhooks'));
  const credsHtml   = await render(FULL, (api) => api.tab('credentials'));
  const catHtml     = await render(FULL, (api) => api.tab('catalogue'));

  /* ── Observed-state chip fixtures ────────────────────────────────────
     ONE render carrying every state at once, on real catalogue entries, so the
     states can be told apart side by side rather than across separate runs.
     Each record is the shape resolveIntegrationStatus returns. */
  const rec = (id, o) => Object.assign({
    id, credentialState: 'configured', health: 'unknown', healthNote: '',
    stages: {}, stageSupport: {}, capabilities: ['view'], probedAt: '', checkedAt: '',
  }, o);

  const CHIP_STATUS = { integrations: [
    /* a probe ran and succeeded, recently */
    rec('firestore',  { health: 'connected', credentialState: 'not-applicable',
                        probedAt: new Date(FRESH).toISOString() }),
    /* connected, but the observation has aged out */
    rec('cloud-storage', { health: 'connected', credentialState: 'not-applicable',
                        probedAt: new Date(STALE).toISOString() }),
    /* reachable, a supported stage came back false */
    rec('typesense',  { health: 'degraded' }),
    /* a probe ran and the rail refused */
    rec('sendgrid',   { health: 'failed' }),
    /* a required credential is absent — NOT a failed call */
    rec('algolia',    { credentialState: 'missing' }),
    /* a probe exists and deliberately will not run. Needs notRunReason, which
       the status resolver does not yet send — see the note in the module. */
    rec('intasend-collections', { notRunReason: 'no_safe_probe' }),
    /* operational evidence exists (health.source), but nothing probes it */
    rec('platform-registry', {}),
    /* nothing at all */
    rec('cloudflare', { credentialState: 'not-applicable' }),
    /* deliberately closed */
    rec('pos-card-terminal', { credentialState: 'disabled' }),
  ], counts: {}, checkedAt: new Date(NOW).toISOString() };

  const chipHtml = await renderWith(FULL,
    { getIntegrationStatus: () => Promise.resolve(CHIP_STATUS) },
    (api) => api.tab('catalogue'));

  /* THE MUTATION: the same rails, evidence changed. The chip must follow the
     evidence rather than the catalogue, which is unchanged between the two. */
  const CHIP_MUTATED = { integrations: [
    /* was LIVE -> now failed */
    rec('firestore',  { health: 'failed', credentialState: 'not-applicable' }),
    /* was STALE -> now a fresh connection */
    rec('cloud-storage', { health: 'connected', credentialState: 'not-applicable',
                        probedAt: new Date(FRESH).toISOString() }),
    /* was NOT CONFIGURED -> credentials now present, still unprobed */
    rec('algolia',    { credentialState: 'configured' }),
  ], counts: {}, checkedAt: new Date(NOW).toISOString() };

  const chipMutatedHtml = await renderWith(FULL,
    { getIntegrationStatus: () => Promise.resolve(CHIP_MUTATED) },
    (api) => api.tab('catalogue'));

  /* The status read itself failing is a tenth state: we know NOTHING. */
  const chipUnreadableHtml = await renderWith(FULL,
    { getIntegrationStatus: () => Promise.reject(new Error('PERMISSION_DENIED')) },
    (api) => api.tab('catalogue'));

  /* ── Observed-activity fixtures ──────────────────────────────────────
     intasend-collections declares payments / orders / posPayments. Each is
     scripted to a DIFFERENT outcome so one render exercises every branch:
       payments     readable, under the cap, with a usable timestamp
       orders       readable, AT the cap, so "at least N" must appear
       posPayments  denied, so it must render as unreadable and never as 0 */
  const CAP = 50;
  const manyOrders = [];
  for (let i = 0; i < CAP; i++) manyOrders.push({ id: 'o' + i, createdAt: FRESH - i * 1000 });

  const ACTIVITY = Object.assign({}, FULL, {
    payments:    { docs: [{ id: 'p1', createdAt: FRESH }, { id: 'p2', createdAt: STALE }] },
    orders:      { docs: manyOrders },
    posPayments: { deny: 'PERMISSION_DENIED' },
  });

  const activityHtml = await renderWith(ACTIVITY, {}, (api) => {
    api.tab('catalogue');
    api.selectCatalogue('intasend-collections');
  });

  /* A collection that is readable but answers to NO timestamp field, and whose
     ordered query fails the way a missing index does. The "most recent write"
     must degrade to a stated reason, never to a fabricated time. */
  const NO_TIME = Object.assign({}, FULL, {
    payments:    { docs: [{ id: 'p1' }], noOrder: true },
    orders:      { docs: [] },
    posPayments: { docs: [] },
  });
  const noTimeHtml = await renderWith(NO_TIME, {}, (api) => {
    api.tab('catalogue');
    api.selectCatalogue('intasend-collections');
  });

  /* ── GCP control-plane fixtures ──────────────────────────────────────
     Shaped exactly as functions/gcp-evidence.js returns, and deliberately
     mixing outcomes in ONE render so the three confusable states appear side by
     side: an observed value, a MEASURED zero, an unreadable field, and a field
     nothing looked at. */
  const obs = (v, src) => ({ value: v, state: (v === 0 ? 'empty' : 'observed'),
    source: src || 'firestore', observedAt: new Date(NOW).toISOString(), reason: '' });
  const unread = (why) => ({ value: null, state: 'unreadable', source: 'firestore',
    observedAt: new Date(NOW).toISOString(), reason: why });
  const notAtt = (why) => ({ value: null, state: 'not-attempted', source: null,
    observedAt: null, reason: why });

  const GCP_EVIDENCE = {
    project: 'sokoni-aeb26',
    generatedAt: new Date(NOW).toISOString(),
    covers: ['firestore.databases', 'firestore.indexes', 'firestore.collections'],
    notCovered: ['cloud-run', 'artifact-registry', 'iam', 'monitoring', 'billing'],
    quota: obs(1000, 'serviceusage.quota'),
    ok: true, error: '',
    databases: {
      '(default)': {
        id: '(default)',
        region: obs('nam5'), type: obs('FIRESTORE_NATIVE'),
        deleteProtection: obs('DELETE_PROTECTION_ENABLED'),
        /* UNREADABLE — must show no number and name the error. */
        indexesDeployed: unread('PERMISSION_DENIED on firestore.indexes.list'),
        indexesReady:    unread('PERMISSION_DENIED on firestore.indexes.list'),
        indexStates:     unread('PERMISSION_DENIED on firestore.indexes.list'),
        indexesDeclared: obs(414), indexDrift: unread('deployed count unreadable'),
        rootCollections: obs(217),
      },
      'sokoni-ops': {
        id: 'sokoni-ops',
        region: obs('europe-west1'), type: obs('FIRESTORE_NATIVE'),
        deleteProtection: obs('DELETE_PROTECTION_DISABLED'),
        indexesDeployed: obs(54), indexesReady: obs(54), indexStates: obs({ READY: 54 }),
        /* NOT ATTEMPTED — must never become 0. */
        indexesDeclared: notAtt('The caller supplied no repository declaration count.'),
        indexDrift:      notAtt('Cannot reconcile without a declared count.'),
        /* THE MEASURED ZERO. */
        rootCollections: obs(0),
      },
    },
  };

  const gcpHtml = await renderWith(FULL, { getGcpEvidence: () => Promise.resolve(GCP_EVIDENCE) },
    (api) => api.tab('gcp'));

  /* ── The full cockpit envelope, as readGcpEvidence() returns it ──────
     Deliberately mixes a live domain, a DEAD domain and a measured zero in one
     render, because the cockpit's whole claim is that those stay distinguishable
     when shown side by side. */
  const GCP_FULL = {
    project: 'sokoni-aeb26',
    generatedAt: new Date(NOW).toISOString(),
    notCovered: ['cloud-logging-entries', 'cost-breakdown'],
    ok: true, error: '',
    domainsRead: obs(7), domainsFailed: obs(1),
    regions: obs(['europe-west1', 'us-central1', 'us-east1'], 'derived from observed resources'),
    projectInfo: { projectNumber: obs('24799054989'), state: obs('ACTIVE') },
    compute: {
      functions: { total: obs(1709), active: obs(1700), failed: obs(9),
                   deploying: obs(0), runtimes: obs({ nodejs22: 1709 }) },
      /* DEAD DOMAIN — must show em dashes and never zeros. */
      cloudRun: { services: unread('run API disabled'), ready: unread('run API disabled'),
                  revisionMismatch: unread('run API disabled'),
                  unboundedScaling: unread('run API disabled'),
                  pinnedMinimum: unread('run API disabled') },
      artifactRegistry: { repositories: obs(2),
        cleanupPolicies: obs({ 'firebase-functions-cleanup': 2, 'sokoni-recovery-protection': 2 }),
        enforcingRepos: obs(2) },
    },
    data: { firestore: { quota: obs(1000), databases: GCP_EVIDENCE.databases } },
    observability: {
      monitoring: { alertPolicies: obs(12), enabled: obs(12), withNotification: obs(9) },
      billing: { billingEnabled: obs(true), billingAccount: obs('billingAccounts/XXXX') },
    },
    security: {
      iam: { bindings: obs(31), principals: obs(18), serviceAccounts: obs(6),
             owners: obs(1), editors: obs(3), auditServices: obs(1),
             auditLogTypes: obs({ ADMIN_READ: 1, DATA_WRITE: 1 }) },
      secrets: { secrets: obs(24), withRotation: obs(0), withExpiry: notAtt('not read') },
    },
  };

  /* Inventories for the drill-downs, shaped as inventory() returns them. */
  const inv = (rows, total) => ({ value: rows, state: rows.length ? 'observed' : 'empty',
    source: 'gcp', observedAt: new Date(NOW).toISOString(), reason: '',
    total: total === undefined ? rows.length : total, cap: 250,
    truncated: (total === undefined ? rows.length : total) > 250 });

  GCP_FULL.apis = { enabled: obs(48), names: obs(['run.googleapis.com']) };
  GCP_FULL.activity = {
    events: obs(2), failures: obs(1), lastEventAt: obs('2026-09-21T09:21:00Z'),
    timeline: inv([
      { at: '2026-09-21T09:21:00Z', service: 'run.googleapis.com',
        method: 'Services.ReplaceService', resource: 'svc/processtypesensequeue', failed: false },
      { at: '2026-09-21T09:19:00Z', service: 'artifactregistry.googleapis.com',
        method: 'BatchDeleteVersions', resource: 'repo/x', failed: true },
    ]),
  };
  GCP_FULL.data.storage = { buckets: obs(3), locations: obs(['US']),
    publicAccessPrevention: obs(3), uniformAccess: obs(3), names: obs(['sokoni-media']) };
  GCP_FULL.compute.functions.scaling = obs({ 'max=80': 1700, unset: 9 });
  GCP_FULL.compute.functions.pinnedMinimum = obs(1);
  GCP_FULL.compute.functions.inventory = inv([
    { name: 'processTypesenseQueue', region: 'us-central1', state: 'ACTIVE', runtime: 'nodejs22',
      service: 'processtypesensequeue', revision: '00022-fon', memory: '512Mi', timeout: 540,
      minInstances: null, maxInstances: 80, serviceAccount: 'sa@x.iam.gserviceaccount.com',
      sourceContract: null },
    /* No contract row exists for this one. Its card must say nothing was
       CHECKED — not show a tick. Without this row the unchecked branch never
       renders and its guard is untested. */
    { name: 'uncontracted', region: 'us-east1', state: 'ACTIVE', runtime: 'nodejs22',
      service: null, revision: null, memory: '256Mi', timeout: 60,
      minInstances: null, maxInstances: null, serviceAccount: null, sourceContract: null },
  ], 1709);
  GCP_FULL.compute.cloudRun.inventory = inv([
    { name: 'profilegetpublicprofile', region: 'us-central1', ready: true,
      latestReadyRevision: '00007-xaz', latestCreatedRevision: '00007-xaz', revisionParity: true,
      minScale: 1, maxScale: 80, concurrency: 80, cpu: '1', memory: '512Mi', timeout: '540s',
      image: 'pkg.dev/x@sha256:133a75e9', serviceAccount: 'sa@x.iam.gserviceaccount.com' },
    /* An UNBOUNDED service: max is null, which must never render as 0. */
    { name: 'orphaned', region: 'us-east1', ready: true, latestReadyRevision: 'r8',
      latestCreatedRevision: 'r9', revisionParity: false, minScale: null, maxScale: null,
      concurrency: null, cpu: null, memory: null, timeout: null,
      image: 'pkg.dev/y@sha256:deadbeef', serviceAccount: null },
  ]);
  GCP_FULL.compute.artifactRegistry.inventory = inv([
    { name: 'gcf-artifacts', location: 'us-central1', format: 'DOCKER', enforcing: true,
      policies: [{ id: 'firebase-functions-cleanup', action: 'DELETE', olderThan: '86400s', tagState: 'ANY' },
                 { id: 'sokoni-recovery-protection', action: 'KEEP', keepCount: 10 }] },
  ]);
  GCP_FULL.compute.artifactRegistry.reposWithDeleteOnly = obs(1);
  GCP_FULL.compute.images = { images: obs(412),
    inventory: inv([{ name: 'x', repo: 'gcf-artifacts', digest: 'sha256:133a75e9',
      tags: ['latest'], uploadTime: '2026-09-21T04:21:47Z' }], 412) };
  GCP_FULL.compute.provenance = {
    servicesPinnedByDigest: obs(2), servicesPinnedByTag: obs(0),
    imageMissingFromRegistry: obs(1),
    missingInventory: inv([{ service: 'orphaned', region: 'us-east1', digest: 'sha256:deadbeef' }]),
  };
  GCP_FULL.security.iam.adminBindings = inv([
    { role: 'roles/owner',  memberCount: 1, members: ['user:founder@sokoni.co.ke'], conditional: false },
    { role: 'roles/editor', memberCount: 2,
      members: ['user:dev@sokoni.co.ke', 'serviceAccount:ci@x.iam.gserviceaccount.com'], conditional: false },
  ]);
  GCP_FULL.security.iam.bindingInventory = inv([
    { role: 'roles/viewer', memberCount: 1, members: ['user:audit@sokoni.co.ke'] },
  ]);
  GCP_FULL.security.iam.humanPrincipals = obs(['user:founder@sokoni.co.ke', 'user:dev@sokoni.co.ke']);
  GCP_FULL.security.iam.groupPrincipals = obs(['group:ops@sokoni.co.ke']);
  GCP_FULL.security.iam.auditCoverage = inv([
    { service: 'artifactregistry.googleapis.com', logTypes: ['ADMIN_READ', 'DATA_WRITE'], exemptedMembers: 0 },
  ]);

  const cockpitHtml = await renderWith(FULL,
    { getGcpEvidence: () => Promise.resolve(GCP_FULL) }, (api) => api.tab('gcp'));

  const drill = async (which) => renderWith(FULL,
    { getGcpEvidence: () => Promise.resolve(GCP_FULL) },
    (api) => { api.tab('gcp'); api.gcpDrill(which); });

  const runHtml    = await drill('run');
  const fnHtml     = await drill('functions');
  const artHtml    = await drill('artifacts');
  const adminsHtml = await drill('admins');
  const auditHtml  = await drill('audit');

  /* Telemetry, cost conditions, service-account usage and App Check. One
     fixture mixes a measured value, a MEASURED ZERO and a not-attempted, so the
     three appear side by side in one render. */
  GCP_FULL.observability.telemetry = {
    windowHours: 24,
    runRequests: obs(18422), run5xx: obs(0), runInstancePeak: obs(6),
    fnExecutions: obs(90411), fnErrors: obs(37),
    firestoreReads: obs(1204331), firestoreWrites: obs(88210), firestoreDeletes: obs(12),
  };
  GCP_FULL.observability.incidents = {
    openIncidents: notAtt('The incidents API is not exposed under the REST surface this reader uses.') };
  GCP_FULL.observability.budgets = { budgets: obs(3), withThresholds: obs(3),
    budgetNames: obs(['monthly']) };
  GCP_FULL.security.appCheck = { services: obs(9), enforced: obs(7), unenforced: obs(2),
    inventory: inv([{ service: 'firestore.googleapis.com', mode: 'ENFORCED' },
                    { service: 'identitytoolkit.googleapis.com', mode: 'UNENFORCED' }]) };
  GCP_FULL.security.serviceAccounts = {
    total: obs(6), withoutWorkload: obs(1),
    inventory: inv([
      { email: 'sa-a@x.iam.gserviceaccount.com', roles: ['roles/run.invoker'], roleCount: 1,
        runServices: 4, functions: 12, unusedByWorkloads: false, usageKnown: true },
      { email: 'orphan@x.iam.gserviceaccount.com', roles: ['roles/storage.admin'], roleCount: 1,
        runServices: 0, functions: 0, unusedByWorkloads: true, usageKnown: true },
      /* Usage UNKNOWN — a workload inventory could not be read. This row must
         render an em dash, not "no". Without it, removing the usageKnown guard
         changes nothing and the guard is untested. */
      { email: 'unknown@x.iam.gserviceaccount.com', roles: ['roles/viewer'], roleCount: 1,
        runServices: 0, functions: 0, unusedByWorkloads: true, usageKnown: false },
    ]),
  };
  GCP_FULL.cost = {
    pinnedInstances: obs(1),
    pinnedInventory: inv([{ service: 'adminosdispatch', region: 'us-central1', minScale: 1, maxScale: 10 }]),
    unboundedServices: obs(2),
    unboundedInventory: inv([{ service: 'unbounded', region: 'us-east1', maxScale: null }]),
    highMaxScale: obs(0), highMaxInventory: inv([]),
    servicesWithNoObservedTraffic: notAtt('Per-service traffic requires a per-service metric query.'),
    costBreakdown: notAtt('A cost breakdown requires the billing export dataset.'),
  };

  GCP_FULL.compute.contracts = {
    capturedAt: obs('2026-09-21T10:42:59.357Z'),
    adjudicated: obs(7), withoutContract: obs(1702),
    maxMismatch: obs(1), minUnpinned: obs(1), gcfDiscrepancy: obs(6),
    note: obs('The GCF layer reports minInstanceCount=undefined while BOTH the source and the ' +
              'serving revision say 1. The serving revision is authoritative.'),
    inventory: inv([
      { fn: 'processTypesenseQueue', region: 'us-central1', srcMin: null, srcMax: null,
        runMin: null, runMax: null, gcfMin: null, gcfMax: null,
        maxParity: true, minPinned: false, gcfDisagrees: false,
        verdict: 'OWNER DECISION REQUIRED' },
      { fn: 'kass', region: 'us-central1', srcMin: 1, srcMax: null,
        runMin: 1, runMax: 80, gcfMin: null, gcfMax: null,
        maxParity: false, minPinned: true, gcfDisagrees: true,
        verdict: 'OWNER DECISION REQUIRED' },
    ]),
  };

  GCP_FULL.security.secretCoverage = {
    declared: obs(31), provisioned: obs(24), missing: obs(2),
    missingNames: inv([{ secret: 'ALGOLIA_ADMIN_KEY' }, { secret: 'TYPESENSE_ADMIN_KEY' }]),
    unmatched: obs(1), unmatchedNames: inv([{ secret: 'LEGACY_THING' }]),
  };
  const contractHtml = await drill('contracts');
  const secretsHtml  = await drill('secrets');
  const dbHtml       = await drill('databases');
  /* Entity cards: one function, one service account. */
  const pick = async (kindDrill, kind, id) => renderWith(FULL,
    { getGcpEvidence: () => Promise.resolve(GCP_FULL) },
    (api) => { api.tab('gcp'); api.gcpDrill(kindDrill); api.gcpPick(kind, id); });
  const fnCardHtml = await pick('functions', 'function', 'processTypesenseQueue');
  const fnNoContractHtml = await pick('functions', 'function', 'uncontracted');
  const saCardHtml = await pick('serviceaccounts', 'sa', 'orphan@x.iam.gserviceaccount.com');
  const saUnknownHtml = await pick('serviceaccounts', 'sa', 'unknown@x.iam.gserviceaccount.com');

  const teleHtml = await drill('telemetry');
  const costHtml = await drill('cost');
  const saHtml   = await drill('serviceaccounts');
  const acHtml   = await drill('appcheck');
  /* The graph and the activity panel render on the base cockpit, not a drill. */
  const cockpit2 = await renderWith(FULL,
    { getGcpEvidence: () => Promise.resolve(GCP_FULL) }, (api) => api.tab('gcp'));

  /* One render carrying BOTH an empty inventory and an unreadable one, so the
     two can be told apart in the same output rather than across two runs. */
  const GCP_EMPTY_INV = JSON.parse(JSON.stringify(GCP_FULL));
  GCP_EMPTY_INV.compute.artifactRegistry.inventory = inv([]);
  GCP_EMPTY_INV.compute.provenance.missingInventory = inv([]);
  GCP_EMPTY_INV.compute.images.inventory = {
    value: null, state: 'unreadable', source: 'gcp',
    observedAt: new Date(NOW).toISOString(), reason: 'The images API refused the read.' };
  const emptyInvHtml = await renderWith(FULL,
    { getGcpEvidence: () => Promise.resolve(GCP_EMPTY_INV) },
    (api) => { api.tab('gcp'); api.gcpDrill('artifacts'); });

  /* The reader is not deployed — the state production is in today. */
  const gcpDownHtml = await renderWith(FULL, {
    getGcpEvidence: () => Promise.reject(new Error('Unknown admin-os operation: the reader is not deployed')),
  }, (api) => api.tab('gcp'));

  /* ── Database probe fixtures ─────────────────────────────────────────
     The named database is injected, so this exercises the real probe logic
     without a network and without the modular SDK. */
  function namedDb(result) {
    return () => ({
      collection: () => ({
        limit: () => ({
          get: () => result.deny
            ? Promise.reject(new Error(result.deny))
            : Promise.resolve({ size: result.size || 0, empty: !result.size,
                                docs: [], forEach() {} }),
        }),
        orderBy: () => ({ limit: () => ({ get: () => Promise.resolve({ size: 0, docs: [], forEach() {} }) }) }),
      }),
    });
  }

  const dbReachableHtml = await renderWith(FULL, { getNamedDb: namedDb({ size: 0 }) }, (api) => {
    api.tab('catalogue');
    api.selectCatalogue('firestore-sokoni-ops');
  });
  const dbDeniedHtml = await renderWith(FULL, { getNamedDb: namedDb({ deny: 'PERMISSION_DENIED' }) }, (api) => {
    api.tab('catalogue');
    api.selectCatalogue('firestore-sokoni-ops');
  });
  const dbDownHtml = await renderWith(FULL, { getNamedDb: namedDb({ deny: 'UNAVAILABLE: backend unreachable' }) }, (api) => {
    api.tab('catalogue');
    api.selectCatalogue('firestore-sokoni-ops');
  });

  /* A registry document carrying hostile content in a rendered field. */
  const xssHtml = await render({
    platformServices: { docs: [
      { id: 'svc-x', serviceId: 'svc-x', name: '<img src=x onerror=alert(1)>',
        type: 'platform', version: '1.0.0' },
      { id: 'svc-b', serviceId: 'svc-b', name: 'Benign Service', type: 'platform', version: '1.0.0' },
    ] },
    platformHealth:       { docs: [] },
    platformDependencies: { docs: [] },
    posWebhooks:          { docs: [] },
  }, (api) => api.tab('registered'));

  const CAT = loadConsole(ALL_EMPTY).cat;
  if (!CAT) throw new Error('the catalogue module did not expose SokoniIntegrationCatalogue');

  runCase('A1 denied reads never show a fabricated zero', () => {
    ['Healthy', 'Attention', 'Errors', 'Registered'].forEach((label) => {
      const v = statValue(denied, label);
      ok('A1 ' + label + ' is em dash when unreadable', v === '—',
         'got ' + JSON.stringify(v));
      ok('A1 ' + label + ' is not 0 when unreadable', v !== '0', 'got ' + JSON.stringify(v));
    });
    /* POSITIVE CONTROL — the same tiles DO render a real 0 when the read
       succeeded and genuinely returned nothing. Without this, A1 would also
       pass if the tiles never rendered at all. */
    ['Healthy', 'Attention', 'Errors', 'Registered'].forEach((label) => {
      ok('A1 control: ' + label + ' renders canonical 0 on an empty read',
         statValue(empty, label) === '0', 'got ' + JSON.stringify(statValue(empty, label)));
    });
  });

  runCase("A2 a partial outage degrades only what it touches", () => {
    /* Registry readable, heartbeats denied. */
    const html = partialHtml;
    ok('A2 Registered reflects the readable registry', statValue(html, 'Registered') === '3',
       'got ' + statValue(html, 'Registered'));
    ok('A2 Healthy is unknown, not zero', statValue(html, 'Healthy') === '—',
       'got ' + statValue(html, 'Healthy'));
    ok('A2 Errors is unknown, not zero', statValue(html, 'Errors') === '—',
       'got ' + statValue(html, 'Errors'));
    ok('A2 the outage is stated, not hidden', /Health heartbeats unavailable/.test(html));
  });

  runCase('A3 absence of a heartbeat is never reported as health', () => {
    ok('A3 the silent service is listed at all', /Silent Service/.test(full));       /* control */
    const row = full.slice(full.indexOf('Silent Service'));
    const cell = row.slice(0, row.indexOf('</tr>'));
    ok('A3 silent service reads "No heartbeat"', /No heartbeat/.test(cell));
    ok('A3 silent service is NOT marked healthy', !/sic-badge healthy/.test(cell));
  });

  runCase('A4 staleness is judged on the same threshold as the server', () => {
    const staleRow = full.slice(full.indexOf('Stale Service'));
    const staleCell = staleRow.slice(0, staleRow.indexOf('</tr>'));
    ok('A4 a 30-minute-old heartbeat is stale', /Stale/.test(staleCell));
    ok('A4 a stale heartbeat is not healthy', !/sic-badge healthy/.test(staleCell));

    /* POSITIVE CONTROL — a heartbeat INSIDE the window must read healthy, or
       "stale" would pass trivially by marking everything stale. */
    const liveRow = full.slice(full.indexOf('Live Service'));
    const liveCell = liveRow.slice(0, liveRow.indexOf('</tr>'));
    ok('A4 control: a fresh heartbeat reads Healthy', /sic-badge healthy/.test(liveCell));
  });

  runCase("A4b the 4-minute boundary case still reads healthy", () => {
    ok('A4b near-boundary heartbeat is healthy', /sic-badge healthy/.test(nearHtml));
    ok('A4b near-boundary heartbeat is not stale',
       !/Stale Service/.test(nearHtml) || !/sic-badge stale/.test(nearHtml));
  });

  runCase('A5 tab counts obey the same rule as the stat tiles', () => {
    /* A separate code path from _stats(), and one a sabotage run proved was
       uncovered. Counts shown on a tab are as much a claim as a KPI tile. */
    ['registered', 'dependencies', 'webhooks'].forEach((tab) => {
      /* A LOOKUP CONTROL FIRST. "is not 0" passes when the helper returns null,
         so a broken locator would satisfy it silently. Asserting the pill was
         found at all makes the two checks below mean something. */
      ok('A5 ' + tab + ' pill was located at all',
         pillValue(denied, tab) !== null, 'got ' + JSON.stringify(pillValue(denied, tab)));
      ok('A5 ' + tab + ' pill is em dash when unreadable',
         pillValue(denied, tab) === '—', 'got ' + JSON.stringify(pillValue(denied, tab)));
      ok('A5 ' + tab + ' pill is not 0 when unreadable',
         pillValue(denied, tab) !== '0');
    });
    /* POSITIVE CONTROL — the same pills carry real numbers when the reads
       succeed, so "em dash" is a rule and not a rendering failure. */
    ok('A5 control: Registered pill counts the real registry',
       pillValue(full, 'registered') === '3', 'got ' + pillValue(full, 'registered'));
    ok('A5 control: Dependencies pill counts the real edges',
       pillValue(full, 'dependencies') === '2', 'got ' + pillValue(full, 'dependencies'));
    ok('A5 control: an empty read still yields a canonical 0',
       pillValue(empty, 'registered') === '0', 'got ' + pillValue(empty, 'registered'));
  });

  /* ── B. A secret never reaches the DOM ───────────────────────────── */

  runCase('B1 webhook signing secrets are never rendered', () => {
    /* POSITIVE CONTROL FIRST — prove the row rendered and the matcher sees it.
       If this fails, the absence check below proves nothing. */
    const rowRendered = ok('B1 control: the webhook row rendered',
      /hooks\.example\.co\.ke/.test(webhookHtml));
    ok('B1 control: its merchant is shown', /seller-alpha/.test(webhookHtml));
    ok('B1 the signing secret is absent from the DOM',
       rowRendered && webhookHtml.indexOf(WEBHOOK_SECRET) === -1,
       rowRendered ? 'secret leaked' : 'control failed — absence proves nothing');
    ok('B1 no secret fragment leaked', webhookHtml.indexOf('whsec_') === -1);
  });

  runCase('B2 the credentials tab lists names, and holds no values', () => {
    ok('B2 a known secret NAME is listed', /INTASEND_PRIVATE_KEY/.test(credsHtml));   /* control */
    ok('B2 the redis secret name is listed', /REDIS_URL/.test(credsHtml));
    ok('B2 no catalogue entry carries a secret value', (() => {
      let leaked = false;
      CAT.integrations.forEach((i) => {
        ((i.evidence || {}).secrets || []).forEach((s) => {
          if (typeof s !== 'string' || /[=:]/.test(s) || s !== s.toUpperCase()) leaked = true;
        });
      });
      return !leaked;
    })(), 'a secrets entry looks like a value, not a name');
  });

  /* ── C. Hostile field values are escaped ─────────────────────────── */

  runCase('C1 a hostile service name cannot inject markup', () => {
    ok('C1 control: the benign service still renders', /Benign Service/.test(xssHtml));
    ok('C1 the injected tag is not live markup', xssHtml.indexOf('<img') === -1);
    /* The handler string survives as ESCAPED TEXT, which is correct and safe.
       What must not exist is the handler inside a real tag, so the check is
       anchored to tag context rather than to the substring. */
    ok('C1 no event handler appears inside a real tag', !/<[^>]*onerror/i.test(xssHtml));
    ok('C1 it is rendered as escaped text instead', /&lt;img/.test(xssHtml));
  });

  /* ── D. Catalogue integrity ──────────────────────────────────────── */

  runCase('D1 no direct Daraja or Safaricom payment rail is catalogued', () => {
    const ids = CAT.integrations.map((i) => i.id);
    /* POSITIVE CONTROL — the payment category is populated, so "no Daraja"
       is a real finding rather than an empty catalogue. */
    ok('D1 control: IntaSend collections is catalogued', ids.indexOf('intasend-collections') !== -1);
    ok('D1 control: IntaSend payouts is catalogued', ids.indexOf('intasend-payouts') !== -1);

    const banned = ['daraja', 'mpesa', 'm-pesa', 'c2b', 'safaricom'];
    CAT.integrations.forEach((i) => {
      banned.forEach((b) => {
        ok('D1 no rail id contains "' + b + '"', i.id.toLowerCase().indexOf(b) === -1, i.id);
      });
      ok('D1 no vendor is Safaricom', String(i.vendor).toLowerCase().indexOf('safaricom') === -1, i.id);
    });
  });

  runCase('D2 every entry satisfies the catalogue contract', () => {
    const VOCAB = ['live', 'inbound-only', 'sandbox', 'configured', 'quarantined', 'retired', 'frozen'];
    const cats  = CAT.categories.map((c) => c.id);
    const seen  = {};
    CAT.integrations.forEach((i) => {
      ok('D2 ' + i.id + ' has a unique id', !seen[i.id]); seen[i.id] = true;
      ok('D2 ' + i.id + ' has a name', !!i.name);
      ok('D2 ' + i.id + ' has a vendor', !!i.vendor);
      ok('D2 ' + i.id + ' has a summary', !!i.summary);
      ok('D2 ' + i.id + ' status is in the closed vocabulary',
         VOCAB.indexOf(i.status) !== -1, i.status);
      ok('D2 ' + i.id + ' is in a declared category', cats.indexOf(i.category) !== -1, i.category);
      ok('D2 ' + i.id + ' declares a health position', !!i.health && 'source' in i.health);
    });
  });

  runCase('D3 the catalogue carries no business metric', () => {
    /* A catalogue entry must never hold a number that could be read as a
       figure. Only structural arrays and strings are permitted. */
    const NUMERIC = [];
    CAT.integrations.forEach((i) => {
      Object.keys(i).forEach((k) => { if (typeof i[k] === 'number') NUMERIC.push(i.id + '.' + k); });
    });
    ok('D3 no entry field holds a number', NUMERIC.length === 0, NUMERIC.join(', '));
    /* POSITIVE CONTROL — the scan can see fields at all. */
    ok('D3 control: the scan reaches entry fields',
       Object.keys(CAT.integrations[0]).length > 3);
  });

  runCase('D4 every rail the platform actually runs is catalogued', () => {
    const want = ['intasend-collections', 'intasend-webhook', 'intasend-payouts',
                  'africastalking', 'sendgrid', 'smtp-fallback', 'fcm',
                  'algolia', 'typesense', 'etims', 'anthropic', 'vertex-gemini',
                  'memorystore-redis', 'firestore', 'firestore-sokoni-ops', 'firestore-indexes',
                  'cloud-functions', 'cloud-run', 'artifact-registry',
                  /* Infrastructure vendors that were missing entirely. Each is a real
                     external dependency with evidence in the repository, and the first
                     two sit on the delivery-critical path. */
                  'osm-tiles', 'osm-nominatim',
                  'hostpinnacle-dns', 'hostpinnacle-mail',
                  'secret-manager', 'cloud-monitoring',
                  'firebase-hosting', 'cloud-storage', 'cloudflare', 'app-check', 'cloud-scheduler',
                  'firebase-auth', 'google-signin', 'facebook-login',
                  /* Sign-in routes that were uncatalogued. Phone OTP and
                     email/password are first-class identity providers, and
                     reCAPTCHA gates both App Check and the OTP send. */
                  'phone-auth', 'email-password-auth', 'recaptcha',
                  'pos-external-api', 'pos-webhooks', 'erp-connectors',
                  'inventory-webhooks', 'api-gateway', 'platform-registry'];
    const have = CAT.integrations.map((i) => i.id);
    want.forEach((id) => ok('D4 ' + id + ' is catalogued', have.indexOf(id) !== -1));
  });

  /* SOKONI runs TWO Firestore databases with separate rules and separate
     indexes. A catalogue that carries one entry called "Cloud Firestore" tells
     an operator the platform has one database, which is false, and hides the
     fact that a deploy naming one does not carry the other. These two entries
     must stay distinct, and the second must not be promoted to "live" on the
     strength of its declaration alone — no runtime module opens a connection
     to it. Promote it when a reader exists and has been OBSERVED. */
  runCase('D6 both Firestore databases are catalogued, and kept distinct', () => {
    const def = CAT.lookup('firestore');
    const ops = CAT.lookup('firestore-sokoni-ops');
    ok('D6 the default database is catalogued', !!def);
    ok('D6 the sokoni-ops database is catalogued', !!ops);
    if (!def || !ops) return;

    ok('D6 they are two entries, not one', def.id !== ops.id);
    ok('D6 the default entry names which database it is', /\(default\)/.test(def.name), def.name);
    ok('D6 the sokoni-ops entry names which database it is', /sokoni-ops/.test(ops.name), ops.name);

    /* Each must point at its OWN rules file. Sharing one would misrepresent
       two separately-deployed rulesets as a single one. */
    const defMods = (def.evidence || {}).modules || [];
    const opsMods = (ops.evidence || {}).modules || [];
    ok('D6 the default entry cites the default ruleset',
       defMods.indexOf('firestore.rules') !== -1, defMods.join(', '));
    ok('D6 the sokoni-ops entry cites its own ruleset',
       opsMods.indexOf('firestore.rules.sokoni-ops') !== -1, opsMods.join(', '));
    ok('D6 the two entries do not share a ruleset',
       defMods.filter((m) => opsMods.indexOf(m) !== -1).length === 0);

    /* An unread database is "configured", never "live". */
    ok('D6 sokoni-ops is not claimed live while nothing reads it',
       ops.status === 'configured', ops.status);
    /* POSITIVE CONTROL — the status field is readable and a live rail does
       report "live", so the assertion above is a real finding rather than a
       check that can never fail. */
    ok('D6 control: a genuinely live rail reports live', def.status === 'live', def.status);
  });

  /* ── D7 / D8 — OBSERVED ACTIVITY ───────────────────────────────────
     The analytics exist to answer "is anything happening on this rail?" from
     canonical data. The danger they introduce is the one this whole console
     was built against: a number on screen that no read produced, or a measured
     number read as a health verdict. Both are certified against here. */
  runCase('D7 observed activity is measured, bounded and never fabricated', () => {
    /* POSITIVE CONTROL — the detail panel rendered and the section exists. */
    ok('D7 control: the activity section rendered', /Observed activity/.test(activityHtml));

    ok('D7 a readable collection reports its real count',
       /payments<\/span><strong>2 docs/.test(activityHtml));

    /* At the cap the true total is UNKNOWN. Rendering a bare "50" would assert
       a completeness the read never established. */
    ok('D7 a capped collection says "at least", not a bare total',
       /orders<\/span><strong>at least 50 docs/.test(activityHtml));
    ok('D7 the cap is disclosed to the reader',
       /capped at 50 documents per collection/.test(activityHtml));

    /* A denied read must be visibly different from a zero. */
    ok('D7 a denied collection renders as unreadable', /posPayments<\/span><strong>.*?Unreadable/s.test(activityHtml));
    ok('D7 a denied collection never renders as 0 docs',
       !/posPayments<\/span><strong>0 docs/.test(activityHtml));

    /* The timestamp came from the data, not from now(). */
    ok('D7 the most recent write is reported with the field it came from',
       /by createdAt/.test(activityHtml));

    /* THE INTERPRETATION GUARD. Activity is evidence about a collection, and a
       collection has many writers. If this wording is ever dropped, the panel
       starts reading as a health verdict for the rail. */
    ok('D7 the panel refuses to attribute activity to the rail',
       /not<\/em> proof that this rail produced it/.test(activityHtml));
    ok('D7 the panel says it is not a health verdict',
       /not<\/em> a health verdict for the rail/.test(activityHtml));
  });

  runCase('D7b an unmeasurable timestamp degrades, it does not invent one', () => {
    ok('D7b control: the activity section rendered', /Observed activity/.test(noTimeHtml));
    ok('D7b the collection count is still reported', /payments<\/span><strong>1 doc/.test(noTimeHtml));
    ok('D7b no readable timestamp is stated as such',
       /no readable timestamp field/.test(noTimeHtml));
    /* INVERTING CONTROL — the fixture that DOES have timestamps produced one,
       so "no timestamp" is a real finding rather than a path that never works. */
    ok('D7b control: the timestamped fixture did produce a time',
       /by createdAt/.test(activityHtml));
  });

  runCase('D8 the database probe distinguishes reachable, denied and unreachable', () => {
    ok('D8 control: the probe section rendered', /Database probe/.test(dbReachableHtml));
    ok('D8 the probed database is named', /sokoni-ops/.test(dbReachableHtml));

    ok('D8 a returning read is Reachable', /Observed<\/span><strong>.*?Reachable/s.test(dbReachableHtml));
    /* The single most important sentence on this panel. */
    ok('D8 an empty result is called a successful read',
       /empty result is a SUCCESSFUL read/.test(dbReachableHtml));
    ok('D8 reachable is not claimed to mean in use',
       /Reachable is not the same as in use/.test(dbReachableHtml));
    ok('D8 an empty probe is not claimed to prove the database is empty',
       /not evidence that the database is empty/.test(dbReachableHtml));

    ok('D8 a refused read is Permission denied, not an outage',
       /Observed<\/span><strong>.*?Permission denied/s.test(dbDeniedHtml));
    ok('D8 a refusal is explained as a rules outcome',
       /rules outcome, not an outage/.test(dbDeniedHtml));

    ok('D8 a failed read is Unreachable', /Observed<\/span><strong>.*?Unreachable/s.test(dbDownHtml));
    ok('D8 a failed read leaves the state UNKNOWN rather than bad',
       /state is UNKNOWN/.test(dbDownHtml));

    /* The three outcomes must be genuinely different renders — a probe that
       reported the same thing for all three would pass every check above. */
    ok('D8 the three outcomes render differently',
       dbReachableHtml !== dbDeniedHtml && dbDeniedHtml !== dbDownHtml);
  });

  /* ── D9 — DNS AUTHORITY ────────────────────────────────────────────
     The catalogue credited Cloudflare with "DNS for the production domain and
     the edge in front of it". No evidence supports that: docs/DNS-RECORDS.md
     names HostPinnacle, and every Cloudflare reference in the repository is
     cdnjs.cloudflare.com, a public asset CDN for Font Awesome.

     Crediting the wrong vendor for DNS is not cosmetic. An operator chasing a
     resolution or mail-delivery fault would go to a control panel SOKONI does
     not own, while the vendor that actually answers for the domain — and holds
     the mailboxes DMARC reports land in — was catalogued nowhere at all. */
  runCase('D9 the DNS provider is the one the evidence names', () => {
    const cf = CAT.lookup('cloudflare');
    const hp = CAT.lookup('hostpinnacle-dns');
    ok('D9 the real DNS provider is catalogued', !!hp);
    ok('D9 control: the Cloudflare entry still exists', !!cf);
    if (!cf || !hp) return;

    /* Cloudflare must not claim the domain's DNS or edge. */
    const cfText = [cf.name, cf.summary, cf.notes || ''].join(' ');
    ok('D9 Cloudflare is described as a CDN, not as DNS',
       /CDN/i.test(cf.name) && !/DNS & Edge/i.test(cf.name), cf.name);
    ok('D9 Cloudflare cites the cdnjs endpoint it actually uses',
       ((cf.evidence || {}).endpoints || []).some((e) => /cdnjs\.cloudflare\.com/.test(e)));

    /* POSITIVE CONTROL — the text was read and does mention DNS, in the
       correction. Without this, "Cloudflare does not claim DNS" could pass on
       an empty string. */
    ok('D9 control: the Cloudflare entry text was actually read',
       cfText.length > 200 && /DNS/.test(cfText));

    /* HostPinnacle must carry the domain, and cite the authoritative doc. */
    ok('D9 HostPinnacle is named as DNS', /DNS/i.test(hp.name), hp.name);
    ok('D9 HostPinnacle cites the authoritative DNS reference',
       ((hp.evidence || {}).modules || []).indexOf('docs/DNS-RECORDS.md') !== -1);
    ok('D9 the mail host is catalogued separately from the DNS entry',
       !!CAT.lookup('hostpinnacle-mail'));
  });

  /* ── D10 — DELIVERY-PATH THIRD PARTIES ─────────────────────────────
     Every map on the platform is drawn from a free public tile service with no
     contract and no SLA, on a delivery-critical path, and it was catalogued
     nowhere. A dependency nobody has written down cannot be reasoned about
     when it fails. */
  runCase('D10 the map dependencies are catalogued with their real provider', () => {
    const tiles = CAT.lookup('osm-tiles');
    const geo   = CAT.lookup('osm-nominatim');
    ok('D10 the tile provider is catalogued', !!tiles);
    ok('D10 the geocoder is catalogued as a separate service', !!geo);
    if (!tiles || !geo) return;

    ok('D10 tiles cite the OpenStreetMap endpoint',
       ((tiles.evidence || {}).endpoints || []).some((e) => /tile\.openstreetmap\.org/.test(e)));
    ok('D10 geocoding cites the Nominatim endpoint',
       ((geo.evidence || {}).endpoints || []).some((e) => /nominatim\.openstreetmap\.org/.test(e)));
    ok('D10 they are two entries, not one', tiles.id !== geo.id);
    /* The absence of a contract is the operationally important fact. */
    ok('D10 the tile entry records that it has no SLA',
       /no SLA|no contract/i.test(tiles.notes || ''), tiles.notes || '');
  });

  /* ── D11 — THE GCP CONTROL PLANE ───────────────────────────────────
     This panel exists to show infrastructure figures a browser cannot obtain,
     which means it is the single most dangerous surface on this console for
     inventing one. Three states must never be confused:

       measured zero   the server enumerated and found none. A FINDING
       unreadable      a read failed. No value
       not measured    nothing looked, or the reader is not deployed

     The first is valuable. The second and third rendered as "0" would be a lie
     that looks authoritative. */
  runCase('D11 the GCP panel separates a measured zero from an unmeasured one', () => {
    ok('D11 control: the GCP panel rendered', /Google Cloud Platform/.test(gcpHtml));
    ok('D11 the project is named', /sokoni-aeb26/.test(gcpHtml));

    /* A real observation renders its value AND its state. */
    ok('D11 an observed region is shown', /europe-west1/.test(gcpHtml));
    ok('D11 an observed figure is badged Observed', /Observed<\/span>/.test(gcpHtml));

    /* THE CENTRAL CASE. sokoni-ops genuinely has no root collections, and the
       server measured that. It must render 0, badged as measured, and say so. */
    const opsSec = dbSection(gcpHtml, 'sokoni-ops');
    const defSec = dbSection(gcpHtml, '(default)');
    ok('D11 control: both database sections rendered', !!opsSec && !!defSec);
    ok('D11 a measured zero renders as 0, not as an em dash',
       metricValue(opsSec, 'Root collections') === '0',
       JSON.stringify(metricValue(opsSec, 'Root collections')));
    /* INVERTING CONTROL — the OTHER database reports a real non-zero for the
       same field, so "it rendered 0" is a reading and not a constant. */
    ok('D11 control: the other database reports its real count',
       metricValue(defSec, 'Root collections') === '217',
       JSON.stringify(metricValue(defSec, 'Root collections')));
    ok('D11 a measured zero is badged as measured', /Measured zero/.test(gcpHtml));
    ok('D11 and the panel says the zero was measured',
       /This zero was measured/.test(gcpHtml));
    ok('D11 and explains a client could not have produced it',
       /client cannot enumerate collections/.test(gcpHtml));

    /* A failed read must NOT look like the measured zero above. */
    ok('D11 an unreadable figure is badged Unreadable', /Unreadable<\/span>/.test(gcpHtml));
    ok('D11 an unreadable figure names its error', /PERMISSION_DENIED/.test(gcpHtml));
    /* The (default) row's index read was refused. Its value must be the em
       dash — never a number, and in particular never a zero. */
    ok('D11 an unreadable figure shows an em dash, not a number',
       metricValue(defSec, 'Indexes deployed') === '—',
       JSON.stringify(metricValue(defSec, 'Indexes deployed')));
    ok('D11 control: the readable database DOES show its index count',
       metricValue(opsSec, 'Indexes deployed') === '54',
       JSON.stringify(metricValue(opsSec, 'Indexes deployed')));

    /* An unsupplied declaration is not-attempted, never zero drift. */
    ok('D11 an unmeasured field is badged Not measured', /Not measured<\/span>/.test(gcpHtml));

    /* The reader's own boundary must be visible. */
    ok('D11 the panel states what the reader does NOT cover',
       /Not covered by this reader/.test(gcpHtml));
    ok('D11 and names an uncovered domain', /iam/.test(gcpHtml));

    /* Figures are a way INTO the evidence. */
    ok('D11 a figure links to the entry that owns it',
       /sic-linkfig[\s\S]{0,200}selectCatalogue/.test(gcpHtml));
  });

  /* ── D13 — THE COCKPIT ─────────────────────────────────────────────
     Four control planes on one screen. The risk of a cockpit is that a dark
     instrument reads as a healthy one, so what is certified here is that a DEAD
     domain stays visibly dead while its neighbours report real figures. */
  runCase('D13 the cockpit shows four control planes and keeps a dead one dark', () => {
    ok('D13 control: the cockpit rendered', /Google Cloud Platform/.test(cockpitHtml));

    ['Compute', 'Data', 'Observability', 'Security'].forEach((s) => {
      ok('D13 the ' + s + ' section rendered', new RegExp('>' + s + '<').test(cockpitHtml));
    });

    /* Identity and derived coverage. */
    ok('D13 the project number is shown', metricValue(cockpitHtml, 'Project number') === '24799054989',
       JSON.stringify(metricValue(cockpitHtml, 'Project number')));
    ok('D13 region coverage is derived from observed resources',
       /europe-west1/.test(cockpitHtml) && /us-east1/.test(cockpitHtml));

    /* A LIVE domain reports real figures. */
    ok('D13 the function count is shown', metricValue(cockpitHtml, 'Deployed') === '1709',
       JSON.stringify(metricValue(cockpitHtml, 'Deployed')));
    ok('D13 IAM owners are shown', metricValue(cockpitHtml, 'Owners') === '1');
    ok('D13 alert policies are shown', metricValue(cockpitHtml, 'Alert policies') === '12');
    ok('D13 secrets are counted', metricValue(cockpitHtml, 'Secrets') === '24');
    ok('D13 the cleanup policies are visible',
       /firebase-functions-cleanup/.test(cockpitHtml) && /sokoni-recovery-protection/.test(cockpitHtml));

    /* THE CENTRAL CLAIM — a dead control plane stays dark. */
    ok('D13 a dead domain shows an em dash, not a zero',
       metricValue(cockpitHtml, 'Services') === '—',
       JSON.stringify(metricValue(cockpitHtml, 'Services')));
    ok('D13 and names its error', /run API disabled/.test(cockpitHtml));
    ok('D13 and the header warns part of the cockpit is dark',
       /Part of this cockpit is dark/.test(cockpitHtml));
    ok('D13 a dark instrument is not a finding about the resource',
       /NOT a finding that the resource is absent or healthy/.test(cockpitHtml));

    /* A measured zero survives inside the cockpit too. */
    ok('D13 a measured zero is still badged as measured',
       metricValue(cockpitHtml, 'With a rotation policy') === '0' &&
       /Measured zero/.test(cockpitHtml),
       JSON.stringify(metricValue(cockpitHtml, 'With a rotation policy')));
    /* And a not-attempted field is still NOT a zero. */
    ok('D13 an unread field is an em dash, not 0',
       metricValue(cockpitHtml, 'With an expiry') === '—',
       JSON.stringify(metricValue(cockpitHtml, 'With an expiry')));

    /* No manufactured judgement. */
    ok('D13 the panel refuses to compute a risk score',
       /No risk score is computed here/.test(cockpitHtml));
    ok('D13 audit coverage states what an absent config means',
       /absent audit config means/.test(cockpitHtml));
    ok('D13 secrets are named as names only',
       /cannot return a value/.test(cockpitHtml));
  });

  /* ── D14 — THE DRILL-DOWNS ─────────────────────────────────────────
     An evidence table is where an invented number would be least noticeable,
     because a table of real-looking rows reads as authority. What is certified
     is that a truncated list says so, an absent value stays absent, and the
     provenance join names the actual resource rather than summarising it. */
  runCase('D14 the Cloud Run drill-down shows the serving contract', () => {
    ok('D14 control: the drill-down opened', /Cloud Run<\/div>|Cloud Run.*✕/s.test(runHtml));
    ok('D14 the service is listed', /profilegetpublicprofile/.test(runHtml));
    ok('D14 the serving revision is shown', /00007-xaz/.test(runHtml));
    ok('D14 the image digest is shown', /sha256:133a75e9/.test(runHtml));
    ok('D14 the service account is shown', /sa@x\.iam\.gserviceaccount\.com/.test(runHtml));
    ok('D14 a revision mismatch is labelled', /MISMATCH/.test(runHtml));

    /* An UNBOUNDED maximum must render as an em dash, never as 0. */
    ok('D14 an absent max-instance limit is an em dash, not 0',
       !/<td class="sic-mono">0<\/td>/.test(runHtml));
    ok('D14 and the panel explains that a blank max means unbounded',
       /no explicit limit/.test(runHtml) && /unbounded, not zero/.test(runHtml));
    ok('D14 the function-to-image chain is named',
       /function → service → revision → image digest → registry/.test(runHtml));
  });

  runCase('D14b the Functions drill-down separates serving from source', () => {
    ok('D14b control: the inventory rendered', /processTypesenseQueue/.test(fnHtml));
    ok('D14b it names the Cloud Run service the function runs on',
       /processtypesensequeue/.test(fnHtml));
    ok('D14b the estate scaling breakdown is shown', /max=80/.test(fnHtml));

    /* THE HONESTY THAT MATTERS: the repository-side contract is not an API
       fact, and the panel says so rather than implying parity. */
    ok('D14b it states the source contract is not in this table',
       /Source contract is not in this table/.test(fnHtml));
    ok('D14b and distinguishes declared from serving',
       /only the\s*\n?\s*serving side is an API fact|only the serving side is an API fact/.test(fnHtml));

    /* A capped list must say so. */
    /* The SHAPE of the disclosure, not a pinned row count — adding a fixture
       row must not break a check about whether truncation is disclosed at all.
       The total is what matters and it is asserted exactly. */
    ok('D14b the cap is disclosed', /Showing \d+ of 1709/.test(fnHtml),
       (fnHtml.match(/Showing \d+ of \d+/) || ['no cap note'])[0]);
    ok('D14b and says the table is not the total',
       /this table is not/.test(fnHtml));
  });

  runCase('D14c Artifact Registry shows policies and the provenance join', () => {
    ok('D14c control: repositories rendered', /gcf-artifacts/.test(artHtml));
    /* The policy ACTION and its condition, not merely that a policy exists. */
    ok('D14c the DELETE policy shows its action and age condition',
       /firebase-functions-cleanup=DELETE\/86400s\/ANY/.test(artHtml));
    ok('D14c the KEEP policy shows its keep count',
       /sokoni-recovery-protection=KEEP\/keep10/.test(artHtml));
    ok('D14c a DELETE-without-KEEP repository is counted',
       metricValue(artHtml, 'Repositories with DELETE and no KEEP') === '1',
       JSON.stringify(metricValue(artHtml, 'Repositories with DELETE and no KEEP')));
    ok('D14c it explains that dry-run disables deletion rather than previewing it',
       /disables deletion rather than previewing it/.test(artHtml));

    /* The join. */
    ok('D14c a serving image missing from the registry is counted',
       metricValue(artHtml, 'Serving image MISSING from the registry') === '1');
    ok('D14c and the affected service is NAMED, not just counted',
       /orphaned/.test(artHtml) && /sha256:deadbeef/.test(artHtml));
    ok('D14c and it explains the consequence',
       /unable to create a new revision from its existing spec/.test(artHtml));
  });

  runCase('D14d the administrators panel shows real bindings, not a score', () => {
    ok('D14d control: the panel rendered', /Administrators/.test(adminsHtml));
    ok('D14d the owner is named', /founder@sokoni\.co\.ke/.test(adminsHtml));
    ok('D14d editors are shown', /roles\/editor/.test(adminsHtml));
    ok('D14d a machine principal is visible as such',
       /serviceAccount:ci@x\.iam\.gserviceaccount\.com/.test(adminsHtml));
    ok('D14d humans and groups are separated',
       /Human principals/.test(adminsHtml) && /Groups/.test(adminsHtml));
    ok('D14d and it says why that separation matters',
       /different revocation paths/.test(adminsHtml));

    /* THE REFUSAL — asserted BOTH ways. The stated position must be present,
       AND no score may appear anywhere. Checking only the sentence let a
       sabotage ADD "Risk score: LOW" beside it and still pass. */
    ok('D14d no risk score is computed', /No risk score is computed/.test(adminsHtml));
    ok('D14d and no score is rendered anywhere on the panel',
       !/risk score:/i.test(adminsHtml) && !/\bscore\s*[:=]/i.test(adminsHtml),
       (adminsHtml.match(/.{0,40}score.{0,40}/gi) || []).join(' | ').slice(0, 160));
    /* INVERTING CONTROL — the matcher DOES fire on a score-shaped string. */
    ok('D14d control: the score matcher catches a planted score',
       /risk score:/i.test('<p>Risk score: LOW</p>'));
    /* INVERTING CONTROL — the panel DOES render evidence, so the refusal is a
       real position and not an empty panel. */
    ok('D14d control: the panel is not empty of evidence',
       /roles\/owner/.test(adminsHtml) && /Principals/.test(adminsHtml));
  });

  runCase('D14e audit logging states what is NOT logged', () => {
    ok('D14e control: the panel rendered', /Audit logging/.test(auditHtml));
    ok('D14e per-service coverage is listed',
       /artifactregistry\.googleapis\.com/.test(auditHtml) && /ADMIN_READ/.test(auditHtml));
    /* The sentence that stops the dangerous misreading. */
    ok('D14e an absent service is stated to be Admin Activity only',
       /absent from this table has Admin Activity logging/.test(auditHtml));
    ok('D14e and that this does NOT mean Data Access is recorded',
       /does NOT mean Data Access is being recorded/.test(auditHtml));

    /* The timeline. */
    ok('D14e the activity timeline renders', /Services\.ReplaceService/.test(auditHtml));
    ok('D14e a failed audit event is labelled FAILED', /FAILED/.test(auditHtml));
    ok('D14e and the reader states it does not read Data Access entries',
       /does not read them/.test(auditHtml));
  });

  runCase('D14f an empty inventory is a measured zero, not a failed read', () => {
    /* A table with no rows and a table that could not be read look identical
       unless something insists they do not. This is the same distinction the
       whole console rests on, applied one level down, inside a table. */
    ok('D14f control: the empty-inventory drill-down rendered',
       /Artifact Registry/.test(emptyInvHtml));
    ok('D14f an empty table says it is a measured zero',
       /Measured zero.*The read returned no rows/s.test(emptyInvHtml));
    ok('D14f and calls it a finding, not a failed read',
       /a finding, not a failed read/.test(emptyInvHtml));
    ok('D14f an empty table is NOT labelled unreadable',
       !/Unreadable.*The read returned no rows/s.test(emptyInvHtml));

    /* INVERTING CONTROL — an actually unreadable inventory DOES say so, in the
       same render, so "not unreadable" above is a real finding. */
    ok('D14f control: a genuinely unreadable inventory is labelled unreadable',
       /<strong>Unreadable\.<\/strong>/.test(emptyInvHtml));
    ok('D14f and names why it could not be read',
       /images API refused/.test(emptyInvHtml));
  });

  runCase('D15 telemetry carries its window, and a quiet series is a measured zero', () => {
    ok('D15 control: the telemetry panel rendered', /Cloud Monitoring/.test(teleHtml));
    ok('D15 the window is stated in the panel', /last 24 hours/.test(teleHtml));
    ok('D15 and the panel says a window is part of the reading',
       /window is part of the reading/.test(teleHtml));

    ok('D15 requests are shown', metricValue(teleHtml, 'Requests') === '18422',
       JSON.stringify(metricValue(teleHtml, 'Requests')));
    ok('D15 5xx is a separate figure from requests',
       metricValue(teleHtml, '5xx responses') === '0');
    /* A quiet series is a MEASURED zero, badged as such. */
    ok('D15 a quiet series is badged as a measured zero', /Measured zero/.test(teleHtml));
    ok('D15 and the panel explains that is different from a failed read',
       /different fact from a failed read/.test(teleHtml));

    ok('D15 Firestore reads and writes are separate figures',
       metricValue(teleHtml, 'Document reads') === '1204331' &&
       metricValue(teleHtml, 'Document writes') === '88210');

    /* OPEN INCIDENTS is honestly not measured. */
    ok('D15 open incidents is an em dash, not zero',
       metricValue(teleHtml, 'Open incidents') === '—',
       JSON.stringify(metricValue(teleHtml, 'Open incidents')));
    ok('D15 and it says why', /not exposed under the REST surface/.test(teleHtml));
  });

  runCase('D16 cost shows conditions, never verdicts', () => {
    ok('D16 control: the cost panel rendered', /Billing &amp; cost|Billing & cost/.test(costHtml));
    ok('D16 budgets are shown', metricValue(costHtml, 'Budgets') === '3');
    ok('D16 a pinned minimum is surfaced with the service named',
       /adminosdispatch/.test(costHtml));
    ok('D16 an unbounded service is surfaced', /unbounded/.test(costHtml));

    /* THE POSITION. */
    ok('D16 the panel says these are conditions, not verdicts',
       /conditions, not verdicts/.test(costHtml));
    ok('D16 and that it does not know whether either is correct',
       /this reader does not know which/.test(costHtml));
    ok('D16 no risk score appears', !/risk score:/i.test(costHtml));

    /* The honest gaps stay em dashes. */
    ok('D16 per-service traffic is an em dash',
       metricValue(costHtml, 'Services with no observed traffic') === '—');
    ok('D16 the cost breakdown is an em dash',
       metricValue(costHtml, 'Cost breakdown by service') === '—');
    ok('D16 and the panel says they are not measured, not zero',
       /not measured<\/strong>, not zero/.test(costHtml));
    /* A measured zero in the SAME panel, so the two are distinguishable. */
    ok('D16 control: a measured zero also appears, badged differently',
       metricValue(costHtml, 'Services with a very high maximum') === '0');
  });

  runCase('D17 service-account usage is a join, and says when it cannot be known', () => {
    ok('D17 control: the panel rendered', /Service accounts/.test(saHtml));
    ok('D17 it explains the join', /which identities/.test(saHtml) && /run as/.test(saHtml));
    ok('D17 an in-use identity shows its workloads',
       /sa-a@x\.iam\.gserviceaccount\.com/.test(saHtml));
    ok('D17 an identity running nothing is flagged',
       /orphan@x\.iam\.gserviceaccount\.com/.test(saHtml));
    ok('D17 and it is described as access with no owner',
       /access and no owner/.test(saHtml));
    /* NOT scored, and honest about its own blind spot. */
    ok('D17 it is shown as a condition, not scored', /not scored/.test(saHtml));
    ok('D17 and it admits the reader may not see every consumer',
       /outside Cloud Run and Functions/.test(saHtml));
    ok('D17 the panel states an unreadable inventory renders an em dash, not "no"',
       /rather than "no"/.test(saHtml));
    /* AND IT ACTUALLY DOES. The sentence above is a claim; this is the row.
       The unknown-usage row must show an em dash in the "Runs nothing" column
       while the known rows show yes/no — three states, visibly distinct. */
    /* Cut each chunk at </tr>. Splitting on '<tr' alone leaves the LAST row
       running to the end of the document, so it swallows the closing note —
       which itself contains an em dash, and made this check pass on prose
       instead of on the cell. A row must be scoped to the row. */
    const saRows = saHtml.split('<tr')
      .filter((x) => /gserviceaccount/.test(x))
      .map((x) => x.split('</tr>')[0]);
    const unknownRow = saRows.find((x) => /unknown@x.iam/.test(x));
    const orphanRow  = saRows.find((x) => /orphan@x.iam/.test(x));
    ok('D17 control: both rows rendered', !!unknownRow && !!orphanRow);
    ok('D17 an unknown-usage row renders an em dash, never "no"',
       !!unknownRow && /—/.test(unknownRow) && !/>no</.test(unknownRow),
       unknownRow ? unknownRow.replace(/<[^>]*>/g, '|').slice(0, 90) : 'missing');
    ok('D17 control: a KNOWN unused row still says YES',
       !!orphanRow && />YES</.test(orphanRow));
  });

  runCase('D18 App Check distinguishes unenforced from broken', () => {
    ok('D18 control: the panel rendered', /App Check/.test(acHtml));
    ok('D18 enforced and unenforced are counted separately',
       metricValue(acHtml, 'Enforced') === '7' && metricValue(acHtml, 'Not enforced') === '2');
    ok('D18 the inventory names the mode per service', /UNENFORCED/.test(acHtml));
    ok('D18 and it says an unenforced service is not automatically a fault',
       /not automatically a fault/.test(acHtml));
    ok('D18 and to audit the endpoint rather than the count',
       /Audit the endpoint, not the count/.test(acHtml));
  });

  runCase('D19 the relationship graph is drawn from readings, not from a picture', () => {
    ok('D19 control: the graph rendered', /Infrastructure relationships/.test(cockpit2));
    ok('D19 it is an accessible svg',
       /role="img" aria-label="Infrastructure relationship graph"/.test(cockpit2));

    /* Nodes carry the figure that was READ. */
    ok('D19 the functions node carries its real count', /class="sg-v">1709</.test(cockpit2));
    ok('D19 the provenance node is present', /Missing from registry/.test(cockpit2));

    /* A node whose reading failed is DIMMED, not removed. */
    ok('D19 a dead node is marked dead rather than omitted',
       /class="sg-n dead"/.test(cockpit2));
    ok('D19 and the Cloud Run node is still present despite being unreadable',
       /Cloud Run services/.test(cockpit2));
    ok('D19 the panel explains why a dead node is not removed',
       /absent box would say/.test(cockpit2));
    ok('D19 and names the distinction it preserves',
       /the truth is &quot;not measured&quot;|the truth is "not measured"/.test(cockpit2));

    /* Nodes are navigable. */
    ok('D19 a node opens its evidence panel',
       /class="sg-n[^"]*"[\s\S]{0,200}gcpDrill/.test(cockpit2));
  });

  runCase('D20 the activity timeline is Admin Activity only', () => {
    ok('D20 control: the activity panel rendered', /Recent activity/.test(cockpit2));
    ok('D20 events read is shown',
       metricValue(cockpit2, 'Admin Activity events read') === '2',
       JSON.stringify(metricValue(cockpit2, 'Admin Activity events read')));
    ok('D20 failures are counted separately',
       metricValue(cockpit2, 'Of which failed') === '1');
    ok('D20 a failed operation is labelled', /FAILED/.test(cockpit2));
    ok('D20 the panel states Data Access entries are NOT read',
       /Data Access entries can carry/.test(cockpit2));
    ok('D20 and why', /not worth leaking a\s*\n?\s*request body|not worth leaking a request body/
       .test(cockpit2));
  });

  runCase('D21 the scaling contract separates source, serving and the GCF layer', () => {
    ok('D21 control: the panel rendered', /Scaling contract/.test(contractHtml));
    ok('D21 it states the two things being compared',
       /declares in the repository/.test(contractHtml) && /actually serving/.test(contractHtml));

    /* SILENCE IS NOT PARITY — the headline claim of this panel. */
    ok('D21 functions with no contract are counted separately',
       metricValue(contractHtml, 'No source contract supplied') === '1702',
       JSON.stringify(metricValue(contractHtml, 'No source contract supplied')));
    /* Asserted on the CLAIM itself, and separately on its reason. An `||`
       here let the sentence be replaced while a neighbouring clause kept the
       check green — which is exactly how a sabotage vector comes back INERT. */
    ok('D21 and the panel says they are NOT in parity',
       /no supplied contract is not/.test(contractHtml));
    ok('D21 and says nothing was compared for them',
       /Nothing was compared for it/.test(contractHtml));

    ok('D21 a source-vs-serving mismatch is surfaced',
       metricValue(contractHtml, 'Source and serving maximum DISAGREE') === '1');
    /* Scoped to the table CELL. The word DISAGREE also appears in the metric
       LABEL above the table, so an unscoped match is satisfied by the label
       even when every row has been made to read "ok" — the label is prose
       about the check, not the result of it. */
    ok('D21 and the row cell itself says DISAGREE',
       /<td class="sic-mono">DISAGREE<\/td>/.test(contractHtml));
    /* INVERTING CONTROL — the agreeing row renders "ok" in the same table, so
       the cell matcher is reading real per-row output. */
    ok('D21 control: an agreeing row renders ok in the same table',
       /<td class="sic-mono">ok<\/td>/.test(contractHtml));
    ok('D21 an unpinned minimum is labelled NOT PINNED', /NOT PINNED/.test(contractHtml));

    /* The GCF layer is carried, not resolved away. */
    ok('D21 the GCF column is shown alongside serving', /GCF min/.test(contractHtml));
    ok('D21 and the panel explains why parity is measured against serving',
       /serving revision is authoritative/.test(contractHtml));
    ok('D21 the verdict travels with the row', /OWNER DECISION REQUIRED/.test(contractHtml));

    /* unset ≠ zero. */
    ok('D21 the panel says a blank limit is unset, not zero',
       /is <strong>unset<\/strong>/.test(contractHtml) && /not zero/.test(contractHtml));
  });

  runCase('D22 Secret Manager shows names only, and says why', () => {
    ok('D22 control: the panel rendered', /Secret Manager/.test(secretsHtml));
    ok('D22 the secret count is shown', metricValue(secretsHtml, 'Secrets') === '24');
    /* The whole sentence, including WHICH API. "cannot return a payload" alone
       survives a mutation that removes the API name, and a claim without its
       basis is an assertion rather than evidence. */
    ok('D22 it states the API used cannot return a payload',
       /secrets\.list<\/span>, which returns metadata and/.test(secretsHtml) &&
       /cannot<\/em> return a payload/.test(secretsHtml));
    ok('D22 and that the access API is never called',
       /never called/.test(secretsHtml));
    ok('D22 and names the consequence of adding it',
       /what a compromise of this console is worth/.test(secretsHtml));

    /* The unread fields are em dashes with a reason, not zeros. */
    ok('D22 version counts and rotation are listed as NOT read', /Not read/.test(secretsHtml));
    ok('D22 and explicitly not zero', /They are not\s*\n?\s*zero|are not zero/.test(secretsHtml));
    /* No secret VALUE may appear. */
    ok('D22 no secret value is rendered', !/BEGIN (RSA )?PRIVATE KEY|sk_live|whsec_/.test(secretsHtml));

    /* DECLARED vs PROVISIONED — the question the Credentials tab cannot answer. */
    ok('D22 declared and provisioned are both shown',
       metricValue(secretsHtml, 'Secret names the rails declare') === '31' &&
       metricValue(secretsHtml, 'Secrets that exist') === '24');
    ok('D22 a declared-but-missing secret is counted',
       metricValue(secretsHtml, 'DECLARED but MISSING') === '2');
    ok('D22 and NAMED, not just counted',
       /ALGOLIA_ADMIN_KEY/.test(secretsHtml) && /TYPESENSE_ADMIN_KEY/.test(secretsHtml));
    ok('D22 and the consequence is stated', /fail when it runs/.test(secretsHtml));
    /* The other direction is NOT a fault. */
    ok('D22 an unmatched secret is listed', /LEGACY_THING/.test(secretsHtml));
    ok('D22 and explicitly called not a fault', /not a fault/.test(secretsHtml));
    ok('D22 and not something to delete', /not something ([\s\S]{0,20})to delete/.test(secretsHtml));
  });

  runCase('D23 the database explorer states what it did not read', () => {
    ok('D23 control: the panel rendered', /Firestore databases/.test(dbHtml));
    ok('D23 both databases appear', /\(default\)/.test(dbHtml) && /sokoni-ops/.test(dbHtml));
    ok('D23 the live quota is shown',
       metricValue(dbHtml, 'Composite-index quota (live)') === '1000');
    ok('D23 it warns that a deploy naming one does not carry the other',
       /does not carry the other/.test(dbHtml));

    /* The measured zero survives here too. */
    ok('D23 the measured zero is still badged as measured', /Measured zero/.test(dbHtml));

    /* And the honest gaps. */
    ok('D23 document counts, ruleset and query failures are listed as not read',
       /Document counts, the deployed ruleset and recent query or index/.test(dbHtml));
    ok('D23 and stated as not measured rather than zero',
       /not measured<\/strong>, not zero/.test(dbHtml));
  });

  runCase('D24 a function card shows source, serving and the checks between them', () => {
    ok('D24 control: the card rendered', /processTypesenseQueue/.test(fnCardHtml));
    ok('D24 the three sections are present',
       /Source contract/.test(fnCardHtml) && /Serving state/.test(fnCardHtml) &&
       />Contract</.test(fnCardHtml));

    /* unset is rendered as unset, NEVER as 0. */
    ok('D24 an unset limit says unset, not 0', /<em>unset<\/em>/.test(fnCardHtml));
    ok('D24 and no limit is rendered as a bare 0',
       !/minScale<\/span><strong>0</.test(fnCardHtml));

    /* The checks. A tick and a warning, and NEITHER for an unchecked item. */
    ok('D24 an agreeing maximum is ticked',
       /✓<\/span><strong>source and serving maximum agree/.test(fnCardHtml));
    ok('D24 an unpinned minimum is warned',
       /⚠<\/span><strong>minimum is NOT pinned/.test(fnCardHtml));
    ok('D24 the recorded verdict is shown', /OWNER DECISION REQUIRED/.test(fnCardHtml));

    /* A function with NO contract must show nothing CHECKED — not a tick.
       "Not checked" and "passed" are different claims. */
    ok('D24 control: the uncontracted card rendered', /uncontracted/.test(fnNoContractHtml));
    ok('D24 an unchecked contract shows no tick',
       !/✓/.test(fnNoContractHtml) && /No contract supplied/.test(fnNoContractHtml));
    ok('D24 and it says nothing was compared, not that it passed',
       /nothing was checked|nothing to compare/i.test(fnNoContractHtml));

    /* The observed peak is honestly absent rather than borrowed. */
    ok('D24 a per-function peak is not borrowed from the estate figure',
       /peak for THIS function needs a per-function metric/.test(fnCardHtml) &&
       /would be a different function/.test(fnCardHtml));

    /* The function names its Cloud Run service, and that is navigable. */
    ok('D24 it names the Cloud Run service', /processtypesensequeue/.test(fnCardHtml));
  });

  runCase('D25 a service-account card separates "runs nothing" from "not known"', () => {
    ok('D25 control: the card rendered', /orphan@x\.iam\.gserviceaccount\.com/.test(saCardHtml));
    ok('D25 its roles are listed', /roles\/storage\.admin/.test(saCardHtml));
    /* KNOWN to run nothing. */
    ok('D25 an identity known to run nothing says so',
       /Nothing in the inventory runs as this identity/.test(saCardHtml));
    ok('D25 and admits the reader may not see every consumer',
       /outside Cloud Run and Functions/.test(saCardHtml));

    /* UNKNOWN is a different sentence entirely. */
    ok('D25 control: the unknown-usage card rendered',
       /unknown@x\.iam\.gserviceaccount\.com/.test(saUnknownHtml));
    ok('D25 an identity whose usage is unknown says UNKNOWN, not nothing',
       /is <strong>unknown<\/strong>/.test(saUnknownHtml));
    ok('D25 and says that is not the same as nothing',
       /not the same as nothing/.test(saUnknownHtml));
    ok('D25 the two cards do not say the same thing',
       !/Nothing in the inventory runs as this identity/.test(saUnknownHtml));

    /* No score. */
    ok('D25 no risk indicator is derived', /No risk indicator is derived/.test(saCardHtml));
    ok('D25 and the unread fields are named', /Not read/.test(saCardHtml));
  });

  runCase('D12 when the reader is absent, nothing is invented', () => {
    ok('D12 control: the panel rendered', /Google Cloud/.test(gcpDownHtml));
    ok('D12 it states that no figure was obtained',
       /No infrastructure figure is shown, because none was obtained/.test(gcpDownHtml));
    ok('D12 it names the failure', /reader is not deployed|did not answer|not available/.test(gcpDownHtml));
    ok('D12 it explains why a browser cannot substitute',
       /no browser can obtain them/.test(gcpDownHtml));

    /* THE WHOLE POINT — an absent reader produces no numbers at all. */
    ok('D12 no index row is rendered at all',
       metricValue(gcpDownHtml, 'Indexes deployed') === null,
       JSON.stringify(metricValue(gcpDownHtml, 'Indexes deployed')));
    ok('D12 no collection row is rendered at all',
       metricValue(gcpDownHtml, 'Root collections') === null,
       JSON.stringify(metricValue(gcpDownHtml, 'Root collections')));
    ok('D12 no "Observed" badge is rendered', !/Observed<\/span>/.test(gcpDownHtml));
    ok('D12 no "Measured zero" badge is rendered', !/Measured zero/.test(gcpDownHtml));

    /* But the estate stays addressable. A missing reader must not hide GCP. */
    ok('D12 GCP services remain individually addressable',
       /Addressable now/.test(gcpDownHtml) && /selectCatalogue\('cloud-run'\)/.test(gcpDownHtml));

    /* INVERTING CONTROL — the same matchers DO find figures when the reader
       answered, so "no number rendered" is a real finding. */
    ok('D12 control: the healthy render DID contain a real index figure',
       metricValue(dbSection(gcpHtml, 'sokoni-ops'), 'Indexes READY') === '54',
       JSON.stringify(metricValue(dbSection(gcpHtml, 'sokoni-ops'), 'Indexes READY')));
  });

  /* ── F1–F4 — THE OBSERVED-STATE CHIP ───────────────────────────────
     The chip exists because a rail that was merely CATALOGUED looked identical
     to one a probe had actually reached. Every assertion below reads the chip
     out of the REAL card in the REAL rendered console, scoped by that card's
     own handle — never from the projection function and never from prose. */
  runCase('F1 every state renders its own chip, on the right card', () => {
    ok('F1 control: the catalogue grid rendered', /sic-ic/.test(chipHtml));
    /* CONTROL ON THE EXTRACTOR — a card that does not exist returns null, so a
       missing card can never be mistaken for a chip-less one. */
    ok('F1 control: the extractor returns null for an absent card',
       cardChip(chipHtml, 'no-such-integration') === null);

    const expect = {
      'firestore':            'LIVE',
      'cloud-storage':        'STALE',
      'typesense':            'DEGRADED',
      'sendgrid':             'FAILED',
      'algolia':              'NOT CONFIGURED',
      'intasend-collections': 'REFUSED BY DESIGN',
      'platform-registry':    'ACTIVE',
      'cloudflare':           'NOT PROBED',
      'pos-card-terminal':    'GATED',
    };
    Object.keys(expect).forEach((id) => {
      ok('F1 ' + id + ' renders ' + expect[id],
         cardChip(chipHtml, id) === expect[id],
         JSON.stringify(cardChip(chipHtml, id)));
    });

    /* The derivation is inspectable, not something to take on trust. */
    ok('F1 the chip carries WHY it was derived',
       /aged past the freshness window/.test(cardChipWhy(chipHtml, 'cloud-storage') || ''),
       cardChipWhy(chipHtml, 'cloud-storage'));
  });

  runCase('F2 the four confusable pairs are genuinely different', () => {
    /* These four are the reason the chip exists. Each pair must differ on a
       card, not merely in a lookup table. */
    ok('F2 NOT PROBED is not ACTIVE',
       cardChip(chipHtml, 'cloudflare') !== cardChip(chipHtml, 'platform-registry'));
    ok('F2 REFUSED BY DESIGN is not NOT PROBED',
       cardChip(chipHtml, 'intasend-collections') !== cardChip(chipHtml, 'cloudflare'));
    ok('F2 NOT CONFIGURED is not FAILED',
       cardChip(chipHtml, 'algolia') !== cardChip(chipHtml, 'sendgrid'));
    ok('F2 STALE is not LIVE',
       cardChip(chipHtml, 'cloud-storage') !== cardChip(chipHtml, 'firestore'));

    /* And none of the four collapses into the same WORD by accident. */
    const four = ['cloudflare', 'platform-registry', 'intasend-collections',
                  'algolia', 'sendgrid', 'cloud-storage', 'firestore']
      .map((id) => cardChip(chipHtml, id));
    ok('F2 control: all seven cards produced a chip', four.every((x) => !!x), four.join(','));
    ok('F2 the distinct states are distinct words',
       new Set(four).size === 7, four.join(','));

    /* NOT CONFIGURED must say it is a configuration fact, not a failed call —
       the distinction that makes it different from FAILED. */
    ok('F2 NOT CONFIGURED says nothing was attempted',
       /nothing was attempted/i.test(cardChipWhy(chipHtml, 'algolia') || ''),
       cardChipWhy(chipHtml, 'algolia'));
    /* NOT PROBED must say the absence is unmeasured, not measured-absent. */
    ok('F2 NOT PROBED says nothing was measured',
       /NOT the same as something having been measured/.test(
         cardChipWhy(chipHtml, 'cloudflare') || ''),
       cardChipWhy(chipHtml, 'cloudflare'));
  });

  runCase('F3 the chip follows the EVIDENCE, not the catalogue', () => {
    /* The catalogue is byte-identical between the two renders. Only the status
       record changed, so any chip that moved did so because of evidence. */
    ok('F3 LIVE becomes FAILED when the probe fails',
       cardChip(chipHtml, 'firestore') === 'LIVE' &&
       cardChip(chipMutatedHtml, 'firestore') === 'FAILED',
       cardChip(chipHtml, 'firestore') + ' -> ' + cardChip(chipMutatedHtml, 'firestore'));
    ok('F3 STALE becomes LIVE when the observation is fresh',
       cardChip(chipHtml, 'cloud-storage') === 'STALE' &&
       cardChip(chipMutatedHtml, 'cloud-storage') === 'LIVE',
       cardChip(chipHtml, 'cloud-storage') + ' -> ' + cardChip(chipMutatedHtml, 'cloud-storage'));
    ok('F3 NOT CONFIGURED becomes NOT PROBED once credentials exist',
       cardChip(chipHtml, 'algolia') === 'NOT CONFIGURED' &&
       cardChip(chipMutatedHtml, 'algolia') === 'NOT PROBED',
       cardChip(chipHtml, 'algolia') + ' -> ' + cardChip(chipMutatedHtml, 'algolia'));

    /* NEGATIVE CONTROL — a card whose evidence did NOT change must not move.
       Without this, a chip that simply re-rendered differently would pass. */
    ok('F3 control: a card with unchanged evidence keeps its chip',
       cardChip(chipMutatedHtml, 'pos-card-terminal') === 'GATED',
       cardChip(chipMutatedHtml, 'pos-card-terminal'));
  });

  runCase('F4 a failed status read is not a finding about any rail', () => {
    ok('F4 control: the grid still rendered', /sic-ic/.test(chipUnreadableHtml));
    /* Every card must say the EVIDENCE is unreadable — not that the rail is
       unprobed, which would be a claim we have no basis for. */
    ok('F4 a rail reads EVIDENCE UNREADABLE, not NOT PROBED',
       cardChip(chipUnreadableHtml, 'firestore') === 'EVIDENCE UNREADABLE',
       cardChip(chipUnreadableHtml, 'firestore'));
    ok('F4 and no card claims LIVE',
       !/>LIVE</.test(chipUnreadableHtml));
    ok('F4 and the reason says it is a failed read',
       /failed read, not a finding/.test(cardChipWhy(chipUnreadableHtml, 'firestore') || ''),
       cardChipWhy(chipUnreadableHtml, 'firestore'));
    /* INVERTING CONTROL — the readable render DID produce LIVE, so "no LIVE"
       above is a real finding rather than a chip that never renders. */
    ok('F4 control: the readable render did produce a LIVE chip',
       cardChip(chipHtml, 'firestore') === 'LIVE');
  });

  runCase('D5 the catalogue renders, and shows an honest live signal', () => {
    ok('D5 control: a catalogue card rendered', /IntaSend/.test(catHtml));
    ok('D5 an uninstrumented rail says so', /Not instrumented/.test(catHtml));
    ok('D5 the instrumented rail reports real endpoint state',
       /active endpoint/.test(catHtml));
  });

  /* ── E. Console wiring ───────────────────────────────────────────── */

  /** Strip HTML comments before asserting — otherwise a check can match the
      very comment that describes it. */
  const strip = (s) => s.replace(/<!--[\s\S]*?-->/g, '');

  const adminOs   = strip(fs.readFileSync(path.join(ROOT, 'admin-os.html'), 'utf8'));
  const superAdmin= strip(fs.readFileSync(path.join(ROOT, 'super-admin.html'), 'utf8'));
  const adminHtml = strip(fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8'));
  const aosEngine = fs.readFileSync(path.join(ROOT, 'sokoni-aos.js'), 'utf8')
                      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  runCase('E1 AdminOS mounts the console from its existing sidebar', () => {
    ok('E1 sidebar entry exists', /data-section="integrations"/.test(adminOs));
    ok('E1 it navigates through the console\'s own router',
       /SokoniAOS\.navigate\('integrations'\)/.test(adminOs));
    ok('E1 the panel exists', /id="panel-integrations"/.test(adminOs));
    ok('E1 exactly one mount point', (adminOs.match(/id="integrationsRoot"/g) || []).length === 1);
    ok('E1 the catalogue script is served', /sokoni-integration-catalogue\.js/.test(adminOs));
    ok('E1 the console script is served', /sokoni-integrations\.js/.test(adminOs));
    ok('E1 the loader is registered on the panel map (stripped code)',
       /integrations:\s*\(\)\s*=>\s*_loadIntegrations\(\)/.test(aosEngine));
    ok('E1 the loader mounts the module', /SokoniIntegrations\.mount\(root\)/.test(aosEngine));
  });

  runCase('E2 Super Admin mounts the same module from its existing sidebar', () => {
    ok('E2 sidebar entry exists', /data-section="integrations"/.test(superAdmin));
    ok('E2 it navigates through SA\'s own router',
       /SA\.nav\('integrations'\)/.test(superAdmin));
    ok('E2 the panel exists', /id="panel-integrations"/.test(superAdmin));
    ok('E2 exactly one mount point', (superAdmin.match(/id="integrationsRoot"/g) || []).length === 1);
    ok('E2 the lazy-load branch exists',
       /section==='integrations'\)this\.loadIntegrations\(\)/.test(superAdmin));
    ok('E2 the loader mounts the module', /SokoniIntegrations\.mount\(root\)/.test(superAdmin));
    ok('E2 the catalogue script is served', /sokoni-integration-catalogue\.js/.test(superAdmin));
    ok('E2 the console script is served', /sokoni-integrations\.js/.test(superAdmin));
  });

  runCase('E3 admin.html is deliberately not a consumer', () => {
    /* POSITIVE CONTROL — this file was read and does contain admin markup, so
       "no reference" is a real finding and not an empty string. */
    ok('E3 control: admin.html was actually read', adminHtml.length > 1000);
    ok('E3 admin.html does not mount the console',
       !/integrationsRoot/.test(adminHtml) && !/sokoni-integrations\.js/.test(adminHtml));
  });

  /* ── E4 — THE CONSOLE PERFORMS NO WRITES ───────────────────────────────
     The invariant is unchanged and absolute. What changed is how it is
     measured.

     This case used to forbid `httpsCallable` outright, as a proxy for "no
     writes". That proxy became wrong when the console began reading the
     authoritative integration status, which lives in Secret Manager and
     therefore cannot come from Firestore. A read is not a write, and the
     console had no way to obtain one.

     But the proxy was not merely stale, and it is NOT simply relaxed here.
     `adminOsDispatch` reaches 64 operations, 12 of them mutating
     (adminUpdateUserRole, adminUpdateFeatureFlag, adminUpdateOrderStatus and
     the rest). "The console calls no callable" really was a stronger guarantee
     than "the console calls adminOsDispatch". So the dispatcher is treated as
     TRANSPORT and the OPERATION IDENTITY is what is certified: the console may
     send exactly the read-only ops on the allowlist below, and nothing else.

     Two independent protections remain:
       direct    the four Firestore write verbs stay unconditionally forbidden
       callable  only adminOsDispatch, and only with an allowlisted read op

     Do not widen READ_ONLY_INTEGRATION_OPS to accommodate whatever the console
     happens to call. The console conforms to this list. */
  /* `adminGetGcpEvidence` was added DELIBERATELY, not to accommodate a call the
     console happened to make. It qualifies on the same terms as its neighbour:

       - it is a READ. functions/gcp-evidence.js contains no mutation verb, and
         scripts/test-gcp-evidence.js asserts that on stripped source against a
         positive control that catches a planted PATCH and .delete(
       - its access token is scoped cloud-platform.READ-ONLY, so the credential
         itself cannot mutate anything even if a future code path tried
       - it binds no secret and persists nothing. No collection is written, and
         no health record is stored

     This list still bounds the capability. It is not a place to record what the
     console calls — it is the set of operations the console is PERMITTED to
     call, and an op joins it only after the read-only property is proven. */
  const READ_ONLY_INTEGRATION_OPS = ['adminGetIntegrationStatus', 'adminGetGcpEvidence'];

  runCase('E4 the console performs no writes', () => {
    const src = fs.readFileSync(path.join(ROOT, 'sokoni-integrations.js'), 'utf8')
                  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    /* POSITIVE CONTROL — the stripper left real code behind. A stripper that
       blanked the file would make every absence check below pass vacuously. */
    ok('E4 control: stripped source still contains the reads',
       /\.collection\(/.test(src) && /\.get\(\)/.test(src));

    /* 1. DIRECT MUTATION — unconditionally forbidden, exactly as before. */
    ['.set(', '.update(', '.delete(', '.add('].forEach((w) => {
      ok('E4 no ' + w + ' in the console', src.indexOf(w) === -1);
    });

    /* 2. CALLABLE TRANSPORT — only the dispatcher, and only as a transport. */
    const callables = [...new Set((src.match(/httpsCallable\(\s*'([^']+)'/g) || [])
      .map((x) => x.replace(/.*'([^']+)'.*/, '$1')))];
    callables.forEach((c) => {
      ok('E4 callable is the dispatcher, not a direct function: ' + c,
         c === 'adminOsDispatch');
    });
    ok('E4 at most one callable transport is used', callables.length <= 1,
       callables.join(',') || 'none');

    /* 3. OPERATION IDENTITY — the part that actually bounds the capability.
       A dispatcher call is only as safe as the op it carries. */
    const opLiterals = [...new Set((src.match(/\bop:\s*'([^']+)'/g) || [])
      .map((x) => x.replace(/.*'([^']+)'.*/, '$1')))];
    opLiterals.forEach((o) => {
      ok('E4 op is on the read-only allowlist: ' + o,
         READ_ONLY_INTEGRATION_OPS.indexOf(o) !== -1);
    });

    /* 4. NO DYNAMIC OP. A computed op would let a caller choose any of the 64,
       which would defeat the allowlist above without tripping it. */
    ok('E4 every op sent is a string literal, never a variable',
       !/\bop:\s*(?!')[A-Za-z_$]/.test(src));

    /* 5. NO MUTATING OP NAME ANYWHERE in the console, allowlist or not. */
    ['adminUpdateUserRole', 'adminUpdatePlatformSettings', 'adminUpdateFeatureFlag',
     'adminCreateSupportTicket', 'adminUpdateOrderStatus', 'adminBanUser',
     'adminScheduleUserDeletion', 'adminMessageUser', 'adminRunIntegrationProbe']
      .forEach((o) => {
        ok('E4 mutating op absent from the console: ' + o, src.indexOf(o) === -1);
      });

    /* 6. INVERTING CONTROLS — every absence check above is worthless unless the
       same matchers can find what they are looking for. Each runs against a
       fixture that MUST trip it. */
    const mutFixture = "firebase.functions().httpsCallable('adminOsDispatch')" +
                       "({ op: 'adminUpdateUserRole' })";
    ok('E4 control: the op matcher catches a mutating op',
       (mutFixture.match(/\bop:\s*'([^']+)'/g) || [])
         .map((x) => x.replace(/.*'([^']+)'.*/, '$1'))
         .some((o) => READ_ONLY_INTEGRATION_OPS.indexOf(o) === -1));
    ok('E4 control: the callable matcher catches a second callable',
       (("httpsCallable('someOtherFunction')").match(/httpsCallable\(\s*'([^']+)'/g) || [])
         .map((x) => x.replace(/.*'([^']+)'.*/, '$1'))
         .some((c) => c !== 'adminOsDispatch'));
    ok('E4 control: the dynamic-op matcher catches a computed op',
       /\bop:\s*(?!')[A-Za-z_$]/.test("({ op: chosenOp })"));
    ok('E4 control: the write-verb matcher catches a write',
       "db.collection('x').doc('y').set({})".indexOf('.set(') !== -1);

    /* 7. THE LEGITIMATE PATH IS PRESENT — this is not a suite that would also
       pass against a console that had been stripped of its status read. */
    ok('E4 the console does read the authoritative status',
       /httpsCallable\(\s*'adminOsDispatch'\s*\)/.test(src) &&
       /op:\s*'adminGetIntegrationStatus'/.test(src));
  });

  /* ── Summary ─────────────────────────────────────────────────────── */
  const short = ASSERTS < MIN_ASSERTIONS;
  if (short) {
    FAIL++;
    FAILURES.push('Suite ran only ' + ASSERTS + ' assertions; at least ' + MIN_ASSERTIONS +
                  ' were expected. A short run is a FAILURE, not a pass.');
  }

  console.log('\n' + '='.repeat(66));
  console.log('  INTEGRATIONS CONTROL CENTER — CERTIFICATION');
  console.log('='.repeat(66));
  console.log('  assertions : ' + ASSERTS);
  console.log('  passed     : ' + PASS);
  console.log('  failed     : ' + FAIL);
  if (FAILURES.length) {
    console.log('\n  FAILURES');
    FAILURES.forEach((f) => console.log('   ✗ ' + f));
  }
  console.log('='.repeat(66));
  console.log(FAIL === 0 ? '  RESULT: CERTIFIED\n' : '  RESULT: NOT CERTIFIED\n');
  process.exit(FAIL === 0 ? 0 : 1);

})().catch((e) => {
  /* Fail closed: an unhandled rejection is a failed certification, never a
     silent zero-assertion exit that reads as success. */
  console.error('\n  ✗ HARNESS CRASHED — certification did not complete');
  console.error('  ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
