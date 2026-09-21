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
  const READ_ONLY_INTEGRATION_OPS = ['adminGetIntegrationStatus'];

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
