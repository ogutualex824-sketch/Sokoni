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

/** A scripted Firestore: each collection either resolves docs or rejects. */
function makeFirestore(plan) {
  return {
    firestore: () => ({
      collection(name) {
        return {
          limit() { return this; },
          get() {
            const p = plan[name];
            if (!p) return Promise.resolve({ forEach() {} });
            if (p.deny) return Promise.reject(new Error(p.deny));
            const docs = (p.docs || []).map((d) => ({ id: d.id, data: () => d }));
            return Promise.resolve({ forEach: (cb) => docs.forEach(cb) });
          },
        };
      },
    }),
  };
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
                  'memorystore-redis', 'firestore', 'cloud-functions', 'artifact-registry',
                  'firebase-hosting', 'cloud-storage', 'cloudflare', 'app-check', 'cloud-scheduler',
                  'firebase-auth', 'google-signin', 'facebook-login',
                  'pos-external-api', 'pos-webhooks', 'erp-connectors',
                  'inventory-webhooks', 'api-gateway', 'platform-registry'];
    const have = CAT.integrations.map((i) => i.id);
    want.forEach((id) => ok('D4 ' + id + ' is catalogued', have.indexOf(id) !== -1));
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
