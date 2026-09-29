/* ══════════════════════════════════════════════════════════════════════════════
   INTEGRATION CONTROL CENTER — console consumption                     (RC-UI)
   scripts/test-integrations-console.js

   The console now renders the backend's authoritative answer instead of having
   none. What this suite is really protecting is the BOUNDARY:

       the browser renders truth; it does not calculate it

   The original defect was a surface with no signal. The obvious way to "fix"
   that is to let the page work things out for itself — infer health from a
   configured credential, treat an accepted request as a delivery, hide the
   rails it has no answer for. Each of those would restore the appearance of
   health while recreating the divergence, so each is asserted against here.

   TWO BACKEND ANSWERS, KEPT APART
     credentialState   RC-1 / Secret Manager — is the credential provisioned
     health            RC-3 / probe evidence  — did the provider actually answer
   A configured credential must never render as a working provider.

   HOW THIS RUNS
   The shipped module is loaded into a minimal DOM and mounted with an injected
   status reader, so what is asserted is the HTML it actually produces.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d ? '   [' + d + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (d ? '   [' + d + ']' : '')); }
};
const head = t => console.log('\n' + t);

const SRC = fs.readFileSync(path.join(ROOT, 'sokoni-integrations.js'), 'utf8');
const CAT = fs.readFileSync(path.join(ROOT, 'sokoni-integration-catalogue.js'), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* ── A minimal DOM, enough for the module to render into ─────────────────── */
function makeEl (id) {
  const el = {
    id, innerHTML: '', style: {}, className: '',
    appendChild () {}, addEventListener () {}, setAttribute () {}, removeAttribute () {},
    querySelector: () => null, querySelectorAll: () => [],
  };
  return el;
}
/* A Firestore stub that SUCCEEDS and returns nothing. Without it the registry
   read fails, the console correctly renders "could not be read", and the
   empty-registry branch — the one RC-2 is about — is never exercised. An empty
   collection and an unreadable one are different states, and this suite has to
   be able to produce both. */
function makeFirebase (docsByCollection) {
  const by = docsByCollection || {};
  return {
    firestore: function () {
      return { collection: function (name) {
        return { limit: function () { return { get: function () {
          const rows = by[name] || [];
          return Promise.resolve({
            forEach: function (fn) { rows.forEach(function (r, i) {
              fn({ data: function () { return r; }, id: r.id || ('d' + i) });
            }); },
          });
        } }; } };
      } };
    },
  };
}

function makeWindow () {
  const head_ = makeEl('head');
  const doc = {
    head: head_, body: makeEl('body'),
    getElementById: () => null,
    createElement: (t) => makeEl(t),
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener () {},
  };
  return { document: doc, addEventListener () {}, setTimeout, clearTimeout, console };
}

/* Build a backend status response with the shape RC-1/RC-3 actually return. */
function record (over) {
  return Object.assign({
    id: 'sendgrid', name: 'SendGrid — Transactional Email', vendor: 'SendGrid',
    category: 'messaging', lifecycle: 'live', direction: 'outbound',
    credentials: [{ name: 'SENDGRID_API_KEY', present: true },
                  { name: 'SENDGRID_WEBHOOK_KEY', present: true }],
    credentialState: 'configured',
    health: 'unknown',
    healthNote: 'No probe has run for this integration; provider health is not measured.',
    stages: null, stageSupport: null, evidence: 'none', probedAt: null,
    capabilities: ['view', 'test', 'view-credential-names'],
    checkedAt: '2026-09-20T11:00:00.000Z',
  }, over || {});
}

function mountWith (statusResponse, opts) {
  const win = makeWindow();
  const ctx = vm.createContext(win);
  ctx.window = win;
  if (opts && opts.firestore) ctx.firebase = win.firebase = opts.firestore;
  vm.runInContext(CAT, ctx);                     /* real catalogue */
  vm.runInContext(SRC, ctx);                     /* the shipped module */
  const host = makeEl('host');
  const api = win.SokoniIntegrations;
  api.mount(host, Object.assign({
    getIntegrationStatus: () => Promise.resolve(statusResponse),
  }, opts || {}));
  return { api, host, win };
}
const settle = () => new Promise(r => setImmediate(() => setImmediate(r)));

(async () => {
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('  INTEGRATION CONTROL CENTER — console consumption');
  console.log('══════════════════════════════════════════════════════════════════');

  head('0 - controls');
  const base = { integrations: [record()], counts: { configured: 1 },
                 checkedAt: '2026-09-20T11:00:00.000Z', inventoryReadable: true };
  const m = mountWith(base);
  await settle();
  ok('the shipped module loads and mounts', !!m.api && typeof m.api.mount === 'function');
  ok('the real catalogue loaded alongside it', !!m.win.SokoniIntegrationCatalogue);
  ok('the backend response was stored', m.api._state().status.ok === true,
     String(m.api._state().status.ok));
  ok('control — it renders something', typeof m.host.innerHTML === 'string' && m.host.innerHTML.length > 200,
     m.host.innerHTML.length + ' chars');

  /* ── 1. THE BOUNDARY ────────────────────────────────────────────────────── */
  head('1 - the console renders truth, it does not calculate it');
  {
    const code = strip(SRC);
    /* The console must not re-derive either answer. These are the two specific
       inferences that would recreate the original divergence. */
    ok('no health is inferred from a credential state',
       !/health\s*=\s*[^;]*credentialState/.test(code));
    ok('no stage is promoted to delivered in the browser',
       !/stages\.delivered\s*=/.test(code));
    ok('the status record is stored verbatim, not merged',
       /_data\.status = \{ ok: true, byId: map/.test(code));
    ok('the module never reaches Secret Manager',
       !/secretmanager|accessSecretVersion/.test(code));
    /* ONE backend call, through the existing dispatcher — not a second path. */
    ok('it calls adminGetIntegrationStatus through adminOsDispatch',
       /adminOsDispatch/.test(code) && /adminGetIntegrationStatus/.test(code));
    ok('and does not define a second frontend registry',
       (code.match(/var INTEGRATIONS\s*=/g) || []).length === 0);
  }

  /* ── 2. THE TWO ANSWERS STAY APART ──────────────────────────────────────── */
  head('2 - configured is never rendered as working');
  {
    const cfg = mountWith({ integrations: [record()], counts: {}, inventoryReadable: true });
    await settle();
    cfg.api.tab('catalogue'); cfg.api.selectCatalogue('sendgrid');
    const html = cfg.host.innerHTML;
    ok('a configured integration shows Configured', /Configured/.test(html));
    /* THE CENTRAL ASSERTION. Credentials present, no probe run: the provider
       health must read "Not yet tested", never Connected. */
    ok('and its provider health reads Not yet tested', /Not yet tested/.test(html));
    ok('it does NOT claim Connected', !/>Connected</.test(html));
    ok('the two answers are labelled separately',
       /Configuration/.test(html) && /Provider health/.test(html));
  }

  /* ── 3. ACCEPTED IS NOT DELIVERED ───────────────────────────────────────── */
  head('3 - an accepted request is not a delivery');
  {
    const probed = mountWith({ integrations: [record({
      health: 'connected', healthNote: 'provider answered 200',
      stages: { configured: true, connected: true, accepted: true, delivered: null, received: null },
      stageSupport: { connected: 'supported', accepted: 'supported',
                      delivered: 'supported', received: 'supported' },
      evidence: 'provider_api', probedAt: '2026-09-20T11:05:00.000Z' })],
      counts: {}, inventoryReadable: true });
    await settle();
    probed.api.tab('catalogue'); probed.api.selectCatalogue('sendgrid');
    const html = probed.host.innerHTML;
    ok('Connected is shown once the provider answered', /Connected/.test(html));
    ok('Accepted: proven is shown', /Accepted: proven/.test(html));
    /* SendGrid CAN evidence delivery, the provider said 200, and the console
       must still say unknown — only the event webhook can say otherwise. */
    ok('Delivered reads unknown, NOT proven', /Delivered: unknown/.test(html));
    ok('Received reads unknown, NOT proven', /Received: unknown/.test(html));
    ok('the evidence source is shown', /provider_api/.test(html));
    ok('and the probe timestamp', /2026-09-20T11:05/.test(html));
  }

  /* ── 4. A STAGE A RAIL CANNOT EVIDENCE IS n/a ───────────────────────────── */
  head('4 - not-supported is not failure');
  {
    const alg = mountWith({ integrations: [record({
      id: 'algolia', name: 'Algolia — Search Index', vendor: 'Algolia', category: 'search',
      health: 'connected',
      stages: { configured: true, connected: true, accepted: true, delivered: null, received: null },
      stageSupport: { connected: 'supported', accepted: 'supported',
                      delivered: 'not-supported', received: 'not-supported' },
      evidence: 'provider_api' })], counts: {}, inventoryReadable: true });
    await settle();
    alg.api.tab('catalogue'); alg.api.selectCatalogue('algolia');
    const html = alg.host.innerHTML;
    ok('a rail with no delivery concept shows n/a', /Delivered: n\/a/.test(html));
    ok('not "failed"', !/Delivered: failed/.test(html));
    ok('and its health is still Connected', /Connected/.test(html));
  }

  /* ── 5. FAILURE STATES ARE DISTINGUISHABLE ──────────────────────────────── */
  head('5 - missing, failed, disabled and unknown look different');
  {
    async function show (over, id) {
      const v = mountWith({ integrations: [record(over)], counts: {}, inventoryReadable: true });
      await settle();
      v.api.tab('catalogue'); v.api.selectCatalogue(id || over.id || 'sendgrid');
      return v.host.innerHTML;
    }
    /* Capabilities come FROM the backend, and RC-1's _capabilities() never
       offers 'test' for a credential it reported missing. The fixture must
       reflect that contract — inventing a capability the backend cannot emit
       would be testing a record that does not exist. */
    const miss = await show({ credentialState: 'missing', health: 'missing',
      capabilities: ['view', 'view-credential-names'],
      credentials: [{ name: 'SENDGRID_API_KEY', present: false }] });
    ok('missing credentials render as Missing', /Missing/.test(miss));
    ok('and offer no provider test', /No provider test is offered/.test(miss));

    const failed = await show({ credentialState: 'configured', health: 'failed',
      healthNote: 'connect ECONNREFUSED',
      stages: { configured: true, connected: false, accepted: false, delivered: null, received: null },
      stageSupport: { connected: 'supported', accepted: 'supported',
                      delivered: 'supported', received: 'supported' } });
    ok('a refused provider renders as Failed', /Failed/.test(failed));
    ok('with the stage that failed shown', /Connected: failed/.test(failed));
    /* The distinction that matters: failed and missing are not the same word. */
    ok('failed is NOT rendered as missing credentials',
       !/Credentials missing/.test(failed));

    const disabled = await show({ id: 'sokoni-wallet', name: 'SOKONI Wallet & Settlement Engine',
      lifecycle: 'frozen', credentialState: 'disabled', health: 'disabled',
      capabilities: ['view'] }, 'sokoni-wallet');
    ok('a frozen rail renders as Disabled', /Disabled/.test(disabled));
    ok('and is not shown as failed', !/>Failed</.test(disabled));
  }

  /* ── 6. A FAILED READ IS NOT AN EMPTY ESTATE ────────────────────────────── */
  head('6 - an unreadable status says so');
  {
    const broken = mountWith(null, {
      getIntegrationStatus: () => Promise.reject(new Error('permission-denied')) });
    await settle();
    ok('a rejected call records a failed read', broken.api._state().status.ok === false,
       String(broken.api._state().status.ok));
    broken.api.tab('credentials');
    const html = broken.host.innerHTML;
    /* THE ORIGINAL DEFECT, INVERTED. An unreadable status must never be drawn
       as "nothing is configured" — that is what sent an operator looking for
       keys that were already there. */
    ok('the credentials tab says the state is NOT known',
       /must not be read as missing/.test(html));
    ok('and does not mark every secret missing', !/Not provisioned/.test(html));
    ok('secrets show Unknown instead', /Unknown/.test(html));
  }

  /* ── 7. CREDENTIAL NAMES ONLY, NEVER VALUES ─────────────────────────────── */
  head('7 - no credential value can reach the page');
  {
    const poisoned = mountWith({ integrations: [record({
      credentials: [{ name: 'SENDGRID_API_KEY', present: true }] })],
      counts: {}, inventoryReadable: true });
    await settle();
    poisoned.api.tab('credentials');
    const html = poisoned.host.innerHTML;
    ok('a secret NAME is shown', /SENDGRID_API_KEY/.test(html));
    ok('and its provisioning state', /Provisioned/.test(html));
    ok('no value-like literal is rendered',
       !/[A-Za-z0-9_\-]{32,}/.test(html.replace(/[A-Z_]{4,}/g, '')));
    /* A substring scan for ".value" matched six filter-input reads
       (this.value on the search and type selects) and nothing to do with
       credentials — it tested nothing. The real property is which FIELDS of a
       credential record this module reads. */
    const code = strip(SRC);
    const credFields = [...new Set((code.match(/\bcr\.[a-zA-Z]+/g) || []))].sort();
    ok('only name and present are read from a credential record',
       credFields.join(',') === 'cr.name,cr.present', credFields.join(','));
    ok('no credential field named value/secret/payload is read anywhere',
       !/\b(cr|credential)\.(value|secret|payload|raw)\b/.test(code));
  }

  /* ── 8. PAYMENTS BOUNDARY ───────────────────────────────────────────────── */
  head('8 - IntaSend safety boundary is preserved');
  {
    const pay = mountWith({ integrations: [record({
      id: 'intasend-collections', name: 'IntaSend — Collections (M-Pesa STK)',
      vendor: 'IntaSend', category: 'payments', credentialState: 'configured',
      health: 'unknown', healthNote: 'IntaSend exposes no read-only health endpoint SOKONI polls.',
      capabilities: ['view', 'view-credential-names'] })], counts: {}, inventoryReadable: true });
    await settle();
    pay.api.tab('catalogue'); pay.api.selectCatalogue('intasend-collections');
    const html = pay.host.innerHTML;
    ok('IntaSend is shown as configured', /Configured/.test(html));
    ok('but not claimed connected', !/>Connected</.test(html));
    ok('and offers no provider test', /No provider test is offered/.test(html));
    /* A word scan for charge/payout/transfer matched this module's OWN UI copy —
       the note promising that a test never initiates a payment. Prose is not
       capability. What actually bounds the console is which callables it can
       invoke: exactly one, read-only. */
    const code = strip(SRC);
    const called = [...new Set((code.match(/httpsCallable\(\s*'([^']+)'/g) || [])
      .map(x => x.replace(/.*'([^']+)'.*/, '$1')))];
    ok('it invokes exactly one callable', called.length === 1, called.join(','));
    ok('and that callable is the read-only status dispatcher',
       called[0] === 'adminOsDispatch', String(called[0]));
    /* An ALLOWLIST, not a record of what the console happens to call. Both ops
       are reads, and both had to prove it before joining this list:

         adminGetIntegrationStatus  lists secret NAMES; never touches the
                                    payload API, binds no secret
         adminGetGcpEvidence        GCP Admin API reads only. Its own suite
                                    (scripts/test-gcp-evidence.js) asserts no
                                    mutation verb on stripped source against a
                                    positive control, and its access token is
                                    scoped cloud-platform.read-only, so the
                                    credential cannot mutate even if code tried

       An op that cannot demonstrate that does not go here. The assertion below
       is still exact-set equality, so an unlisted op fails the suite. */
    const READ_ONLY_OPS = ['adminGetIntegrationStatus', 'adminGetGcpEvidence'];
    const ops = [...new Set((code.match(/op: '([^']+)'/g) || []))]
      .map(x => x.replace(/.*'([^']+)'.*/, '$1')).sort();
    ok('every op it sends is on the read-only allowlist',
       ops.join(',') === READ_ONLY_OPS.slice().sort().join(','), ops.join(','));
    /* A dynamic op would let a caller choose any of the 65, defeating the list
       above without tripping it. */
    ok('and every op is a string literal, never a variable',
       !/\bop:\s*(?!')[A-Za-z_$]/.test(code));
    ok('no Daraja surface exists in the console',
       !/daraja/i.test(code));
  }

  /* ── 9. RC-2 — THE REGISTRY IS A LOG, NOT AN INVENTORY ──────────────────── */
  head('9 - an empty registry never implies an unavailable service');
  {
    const reg = mountWith({ integrations: [record()], counts: {}, inventoryReadable: true },
      { firestore: makeFirebase({}) });   /* reads SUCCEED and return zero rows */
    await settle();
    reg.api.tab('registered');
    const html = reg.host.innerHTML;

    /* The registry cannot be an inventory: platformRegisterService needs an
       authenticated browser session, one page calls init(), and the sweep marks
       anything not heartbeating for five minutes stale. So the tab must not be
       presented as a list of what exists. */
    ok('the tab is named as a self-registration log',
       /Self-registration log/.test(html));
    ok('it is no longer labelled simply "Registered"',
       !/>Registered<span class="sic-pill"/.test(html));
    ok('an empty registry states it is NOT unavailability',
       /not<\/strong> an indication that any integration or service is unavailable/.test(html));
    ok('and points at the authoritative model instead',
       /authoritative model/.test(html));
    ok('the canonical-zero distinction is preserved',
       /canonical zero/.test(html) && /not a failed read/.test(html));

    /* THE THING THAT MUST NOT HAPPEN. Populating the registry from the
       catalogue would manufacture evidence and create exactly the staleable
       second source this workstream exists to remove. */
    const code = strip(SRC);
    ok('the console never writes to the registry',
       !/platformServices[^)]*\.(set|add|update)\(/.test(code));
    ok('and never seeds it from the catalogue',
       !/platformRegisterService/.test(code));
    ok('posWebhooks is kept separate from the service registry',
       /posWebhooks/.test(code) && !/posWebhooks[\s\S]{0,80}platformServices/.test(code));
  }

  /* ── 10. THE THREE KINDS RENDER DISTINCTLY ──────────────────────────────── */
  head('10 - unknown, observed-elsewhere and not-applicable look different');
  {
    async function healthOf (id, health, over) {
      const v = mountWith({ integrations: [record(Object.assign({ id, health,
        healthNote: 'note for ' + id }, over || {}))], counts: {}, inventoryReadable: true });
      await settle();
      v.api.tab('catalogue'); v.api.selectCatalogue(id);
      return v.host.innerHTML;
    }
    const unk = await healthOf('fcm', 'unknown');
    const els = await healthOf('hostpinnacle-dns', 'observed-elsewhere');
    const nap = await healthOf('odpc', 'not-applicable');

    ok('unknown renders as Not yet tested', /Not yet tested/.test(unk));
    ok('elsewhere renders as Observed elsewhere', /Observed elsewhere/.test(els));
    ok('not-applicable renders as Not applicable', /Not applicable/.test(nap));

    /* THEY MUST BE DISTINGUISHABLE FROM EACH OTHER. */
    ok('observed-elsewhere is not shown as Not yet tested', !/Not yet tested/.test(els));
    ok('not-applicable is not shown as Not yet tested', !/Not yet tested/.test(nap));
    ok('not-applicable is not shown as Observed elsewhere',
       !/Observed elsewhere<\/span>/.test(nap));

    /* AND NONE OF THEM MAY READ AS SUCCESS. A signal existing elsewhere is not
       evidence that the answer is good. */
    function badgeCls (html, label) {
      const m = new RegExp('class="sic-badge ([a-z]+)"><span class="sic-dot"></span>' + label)
        .exec(html);
      return m ? m[1] : null;
    }
    ok('Observed elsewhere is styled neutral, never success',
       badgeCls(els, 'Observed elsewhere') === 'unknown', badgeCls(els, 'Observed elsewhere'));
    ok('Not applicable is styled neutral, never success',
       badgeCls(nap, 'Not applicable') === 'unknown', badgeCls(nap, 'Not applicable'));
    ok('neither is rendered green', !/sic-badge healthy"><span class="sic-dot"><\/span>(Observed|Not applicable)/
       .test(els + nap));
    /* CONTROL — the badge locator can see a success badge when there is one. */
    const conn = await healthOf('sendgrid', 'connected');
    ok('CONTROL — a genuinely connected rail IS styled as success',
       badgeCls(conn, 'Connected') === 'healthy', badgeCls(conn, 'Connected'));

    /* The pointer that makes `elsewhere` actionable comes from the catalogue. */
    ok('an elsewhere rail tells the operator where to look',
       /Observed elsewhere:<\/strong> Records are changed in the HostPinnacle DNS panel/.test(els));
    ok('a not-applicable rail says why there is nothing to measure',
       /Not applicable:<\/strong> A legal obligation/.test(nap));
    ok('a measurable rail gets no such pointer',
       !/Observed elsewhere:<\/strong>|Not applicable:<\/strong>/.test(unk));
  }

  /* ── THE OPERATOR VOCABULARY ────────────────────────────────────────────
     The operator chip is DERIVED from the evidence chip. These assertions
     protect the derivation, because the failure mode is silent: a mapping that
     quietly promotes an unmeasured rail to green looks exactly like a working
     console until someone trusts it. */
  {
    const src = fs.readFileSync(path.join(ROOT, 'sokoni-integrations.js'), 'utf8');

    /* Read both tables out of the shipped source so the suite cannot drift
       from what actually ships. */
    const evKeys = (src.match(/var CHIP_META = \{[\s\S]*?\n  \};/) || [''])[0]
      .split('\n').map((l) => (l.match(/^\s{4}([a-z]+)\s*:/) || [])[1]).filter(Boolean);
    const mapBlock = (src.match(/var OPS_FROM_EVIDENCE = \{[\s\S]*?\n  \};/) || [''])[0];
    const mapped = {};
    mapBlock.split('\n').forEach((l) => {
      const m = l.match(/^\s{4}([a-z]+)\s*:\s*'([a-z]+)'/);
      if (m) mapped[m[1]] = m[2];
    });

    ok('CONTROL — both tables were located in the shipped source',
       evKeys.length >= 10 && Object.keys(mapped).length >= 10,
       'evidence=' + evKeys.length + ' mapped=' + Object.keys(mapped).length);

    /* No silent fall-through. A new evidence state must be mapped DELIBERATELY;
       a default would hand it whatever the default happens to flatter. */
    const unmapped = evKeys.filter((k) => !mapped[k]);
    ok('every evidence state has an explicit operator mapping',
       unmapped.length === 0, unmapped.join(',') || 'none');

    /* The three that must never collapse into INACTIVE. This is the whole
       reason the vocabulary has eight chips instead of seven. */
    ok('unprobed maps to NOT VERIFIED, never INACTIVE',
       mapped.unprobed === 'unverified', mapped.unprobed);
    ok('refused keeps its own chip, never INACTIVE',
       mapped.refused === 'refused', mapped.refused);
    ok('unreadable maps to NOT VERIFIED, never a health claim',
       mapped.unreadable === 'unverified', mapped.unreadable);

    /* Green is reserved for a CURRENT probe. */
    ok('live is the only evidence state that earns ACTIVE',
       mapped.live === 'active' &&
       Object.keys(mapped).filter((k) => mapped[k] === 'active').length === 1,
       JSON.stringify(mapped));
    ok('evidence-without-a-probe is PARTIAL, not promoted to green',
       mapped.active === 'partial', mapped.active);
    ok('stale is PARTIAL — an old success is not a current one',
       mapped.stale === 'partial', mapped.stale);
    ok('failed maps to ERROR', mapped.failed === 'error', mapped.failed);
    ok('a gated rail reads QUARANTINED', mapped.gated === 'quarantine', mapped.gated);
    ok('a missing credential is ACTION REQUIRED, not a failure',
       mapped.unconfigured === 'action', mapped.unconfigured);

    /* INVERTING CONTROL — the assertions above would also pass if nothing were
       mapped to INACTIVE because the table were empty. Prove the value is
       reachable in principle, i.e. that 'inactive' exists as a chip at all. */
    ok('CONTROL — INACTIVE exists as a chip even though nothing maps to it today',
       /inactive:\s*\{ label: 'INACTIVE'/.test(src), 'OPS_META.inactive');
    ok('CONTROL — TESTING is defined and deliberately unreachable',
       /testing:\s*\{ label: 'TESTING'/.test(src) &&
       !Object.keys(mapped).some((k) => mapped[k] === 'testing'), 'no evidence maps to testing');

    /* The header must count with the SAME derivation the cards use. A separate
       tally could disagree with the grid and the operator could not tell which
       to believe. */
    ok('the summary counts via _opsChip, not a second tally',
       /function _opsCounts[\s\S]{0,400}_opsChip\(i\)/.test(src), '_opsCounts uses _opsChip');

    /* Last verified must come from the status record, never from render time. */
    ok('last-verified reads probedAt/checkedAt, never Date.now() as the source',
       /function _lastVerified[\s\S]{0,300}probedAt[\s\S]{0,80}checkedAt/.test(src),
       '_lastVerified');
    ok('an unverified rail says so instead of showing a date',
       /Not recently verified/.test(src), 'honest empty state');

    /* The operator chip is ADDITIVE: the evidence chip must still render, or
       the certification suite downstream loses the span it reads. */
    /* Asserted on STRIPPED source. The explanatory comment inside this function
       is longer than any sane character window, and a window wide enough to
       clear it would start matching unrelated code. Strip the prose, then the
       distance is the code's distance. */
    const bare = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    ok('CONTROL — the comment stripper is not a no-op',
       bare.length < src.length, (src.length - bare.length) + ' chars removed');
    ok('the operator chip reuses _chipHtml rather than re-rendering the label',
       /function _opsChipHtml[\s\S]{0,300}_chipHtml\(entry\)/.test(bare), '_opsChipHtml');
  }

  /* ══════════════════════════════════════════════════════════════════════
     CONSOLE ADOPTION — the resolver's disagreement surface, rendered
     ══════════════════════════════════════════════════════════════════════
     The resolver proved the six states mechanically (ec43565). This asserts the
     console consumes them WITHOUT re-deciding anything: the queue is the
     resolver's `disagreements` array, rendered, and nothing here recomputes
     which states are urgent. */
  head('11 - console adoption: 60 technical, 2 operational, queue from the resolver');

  /* One record per catalogue id, so the response is the real shape and size
     rather than a hand-picked subset that could hide a rendering gap. */
  function fullStatus (overrides, disagreements) {
    const probe = mountWith({ integrations: [], counts: {} });
    const ids = probe.win.SokoniIntegrationCatalogue.integrations.map(i => i.id);
    const over = overrides || {};
    return {
      integrations: ids.map(id => Object.assign(record({
        id, name: id, credentials: [], credentialState: 'not-applicable',
        capabilities: ['view'],
        declaredProbeState: 'none', observedNotRunReason: null,
        evidenceDisagreement: null, notRunReason: null,
      }), over[id] || {})),
      counts: {}, checkedAt: '2026-09-29T00:00:00.000Z', inventoryReadable: true,
      evidenceReadable: true, evidenceError: null, evidenceDropped: [],
      disagreements: disagreements || [],
    };
  }

  {
    const m = mountWith(fullStatus());
    await settle();
    const html = m.host.innerHTML;
    const cat = m.win.SokoniIntegrationCatalogue;

    ok('the browser catalogue carries 60 technical entries',
       cat.integrations.length === 60, cat.integrations.length + '');
    ok('and 2 operational dependencies, in a SEPARATE collection',
       Array.isArray(cat.operationalDependencies) && cat.operationalDependencies.length === 2,
       (cat.operationalDependencies || []).length + '');

    /* Every technical id must appear; a missing card is indistinguishable from
       an integration that does not exist. */
    const missing = cat.integrations.filter(i => html.indexOf('>' + i.name + '<') === -1 &&
                                                 html.indexOf(i.id) === -1);
    ok('all 60 technical integrations render', missing.length === 0,
       missing.length ? 'missing: ' + missing.slice(0, 4).map(i => i.id).join(', ') : '60/60');

    ok('both operational dependencies render, in their own section',
       /sic-opdep/.test(html) &&
       cat.operationalDependencies.every(d => html.indexOf(d.name) > -1),
       'section + ' + cat.operationalDependencies.length + ' rows');

    ok('they render NOT PROBEABLE, not an evidence-model state',
       /data-sic-opdep-state="not-probeable"/.test(html) && /NOT PROBEABLE/.test(html),
       'NOT PROBEABLE');
    ok('...and say WHY — "No SOKONI probe path"',
       /No SOKONI probe path/.test(html), 'stated');
    ok('CONTROL — an operational id is NOT rendered as a technical card',
       cat.operationalDependencies.every(d =>
         html.indexOf('selectCatalogue(\'' + d.id + '\')') === -1),
       'no technical card for either');

    /* The boundary the whole model rests on: the UI having two sections must
       not put operational ids through the technical path. */
    const techIds = new Set(cat.integrations.map(i => i.id));
    ok('0 operational ids are in the technical collection',
       cat.operationalDependencies.every(d => !techIds.has(d.id)), 'disjoint');
    ok('lookup() refuses an operational id',
       cat.operationalDependencies.every(d => cat.lookup(d.id) === null), 'null for both');
  }

  head('12 - the disagreement queue is the resolver\'s, not the console\'s');

  {
    /* QUIET: the resolver ran and found nothing. No banner, and above all no
       reassuring claim. */
    const quiet = mountWith(fullStatus());
    await settle();
    ok('a quiet resolver renders NO queue banner',
       !/sic-dq\b/.test(quiet.host.innerHTML), 'absent');
    ok('CONTROL — the page still rendered (the absence is not an empty page)',
       quiet.host.innerHTML.length > 2000, quiet.host.innerHTML.length + ' chars');
  }

  {
    /* THE TRIPWIRE. A probe ran against a rail that must never be probed. */
    const trip = mountWith(fullStatus({}, [{
      id: 'intasend-collections', name: 'IntaSend Collections',
      state: 'safety-tripwire', severity: 'tripwire',
      declared: 'no_safe_probe', observed: 'successful-probe',
      note: 'A probe ran against a rail declared unsafe to probe. Investigate: probing this rail moves money.',
      probedAt: '2026-09-29T10:00:00.000Z',
    }]));
    await settle();
    const html = trip.host.innerHTML;
    ok('a safety tripwire renders, at tripwire severity',
       /sic-dq-trip/.test(html) && /TRIPWIRE/.test(html), 'rendered');
    ok('it names the integration and the state',
       /IntaSend Collections/.test(html) && /safety tripwire/i.test(html), 'named');
    ok('it says WHY it matters — money, not a generic warning',
       /moves money/.test(html), 'reason present');
    ok('it carries the declaration, the observation and when',
       /no_safe_probe/.test(html) && /successful-probe/.test(html) && /2026-09-29/.test(html),
       'declared + observed + probedAt');
  }

  {
    /* Worst first. A money tripwire must never sort below a stale label. */
    const both = mountWith(fullStatus({}, [
      { id: 'sendgrid', name: 'SendGrid', state: 'stale-declaration', severity: 'action',
        declared: 'requires_secret_binding', observed: 'successful-probe', note: 'stale', probedAt: null },
      { id: 'intasend-payouts', name: 'IntaSend Payouts', state: 'safety-tripwire', severity: 'tripwire',
        declared: 'no_safe_probe', observed: 'successful-probe', note: 'moves money', probedAt: null },
    ]));
    await settle();
    const html = both.host.innerHTML;
    ok('both actionable states render', /SendGrid/.test(html) && /IntaSend Payouts/.test(html), '2 rows');
    ok('the TRIPWIRE sorts above the action row',
       html.indexOf('IntaSend Payouts') < html.indexOf('SendGrid'), 'worst first');
    ok('the header counts them and flags the tripwire',
       /2 integrations disagree/.test(html) && /1 SAFETY TRIPWIRE/.test(html), 'counted');
  }

  {
    /* THE QUEUE IS TAKEN VERBATIM. If the console re-derived it, a record
       carrying an `ok` disagreement would leak into the queue. It must not:
       the resolver already decided, and this surface renders that decision. */
    const okStates = mountWith(fullStatus({
      'intasend-collections': { evidenceDisagreement: {
        state: 'expected-refusal', severity: 'ok', declared: 'no_safe_probe',
        observed: null, note: 'nothing has run' } },
      'firestore': { evidenceDisagreement: {
        state: 'verified-evidence', severity: 'ok', declared: 'runnable',
        observed: 'successful-probe', note: 'established' } },
    }, []));
    await settle();
    ok('records carrying an OK state do NOT create a queue',
       !/sic-dq\b/.test(okStates.host.innerHTML), 'no banner');
    /* Awaited, like every other mount here. Read synchronously it returns an
       unrendered host, and the control would fail for a reason that has
       nothing to do with the behaviour under test. */
    const oneAction = mountWith(fullStatus({}, [{ id: 'x', name: 'X', state: 'stale-declaration',
      severity: 'action', declared: 'requires_secret_binding', observed: 'successful-probe',
      note: 'n', probedAt: null }]));
    await settle();
    ok('CONTROL — the same page with one ACTION row does render one',
       /sic-dq\b/.test(oneAction.host.innerHTML), 'banner appears');
  }

  {
    /* An UNREADABLE status must not render as an all-clear. */
    const broken = mountWith(null);
    await settle();
    const html = broken.host.innerHTML;
    ok('a FAILED status read says the comparison could not be made',
       /could not be checked/i.test(html) || /sic-dq-unknown/.test(html), 'stated');
    ok('...and explicitly does NOT claim all-clear',
       /not an all-clear/i.test(html) || !/disagree/.test(html), 'no false reassurance');
  }

  head('13 - REFUSED BY DESIGN still renders from the legacy notRunReason');

  {
    const refused = mountWith(fullStatus({
      'sendgrid': { notRunReason: 'requires_secret_binding',
                    declaredProbeState: 'requires_secret_binding' },
    }));
    await settle();
    ok('the legacy field still drives REFUSED BY DESIGN',
       /REFUSED BY DESIGN/.test(refused.host.innerHTML), 'rendered');

    const notRefused = mountWith(fullStatus());
    await settle();
    ok('CONTROL — without notRunReason it does NOT render',
       !/REFUSED BY DESIGN/.test(notRefused.host.innerHTML), 'absent');

    ok('the console reads notRunReason, not the new fields, for that chip',
       /r\.notRunReason/.test(strip(SRC)), 'contract unchanged');
  }

  head('14 - the six states plus null stay distinguishable at UI level');

  {
    /* Not "each has a label" — that the SIX produce SIX distinct renderings,
       and that the two outside-the-matrix cases produce none. */
    const STATES = ['expected-refusal', 'safety-tripwire', 'declared-current',
                    'stale-declaration', 'binding-regression', 'verified-evidence'];
    const seen = {};
    for (const st of STATES) {
      const sev = st === 'safety-tripwire' ? 'tripwire'
                : (st === 'stale-declaration' || st === 'binding-regression') ? 'action' : 'ok';
      const q = sev === 'ok' ? [] : [{ id: 'sendgrid', name: 'SendGrid', state: st, severity: sev,
        declared: 'x', observed: 'y', note: 'n for ' + st, probedAt: null }];
      const m = mountWith(fullStatus({ 'sendgrid': { evidenceDisagreement: {
        state: st, severity: sev, declared: 'x', observed: 'y', note: 'n for ' + st } } }, q));
      await settle();
      seen[st] = { queued: sev !== 'ok', html: m.host.innerHTML };
    }
    ok('the three ACTIONABLE states reach the queue',
       ['safety-tripwire', 'stale-declaration', 'binding-regression']
         .every(s => /sic-dq\b/.test(seen[s].html)), '3/3');
    ok('the three OK states do NOT reach the queue',
       ['expected-refusal', 'declared-current', 'verified-evidence']
         .every(s => !/sic-dq\b/.test(seen[s].html)), '0/3 queued');
    ok('each queued state renders its own name, so they are not one alert',
       ['safety-tripwire', 'stale-declaration', 'binding-regression']
         .every(s => new RegExp(s.replace(/-/g, ' '), 'i').test(seen[s].html)), 'distinct');
    ok('the tripwire renders differently from the two actions',
       /sic-dq-trip/.test(seen['safety-tripwire'].html) &&
       !/sic-dq-trip/.test(seen['stale-declaration'].html), 'severity is visible');
    const nullCase = mountWith(fullStatus());
    await settle();
    ok('NULL — no state renders no queue row, and invents nothing',
       !/sic-dq\b/.test(nullCase.host.innerHTML), 'no seventh state');
  }

  {
    /* The console must not re-derive the queue from per-record fields. */
    const bare = strip(SRC);
    ok('the queue is read from the resolver array, not recomputed',
       /_disagreementQueue[\s\S]{0,900}st\.disagreements/.test(bare), 'verbatim');
    ok('CONTROL — the stripper removed the explanatory prose',
       bare.length < SRC.length, (SRC.length - bare.length) + ' chars removed');
    ok('nothing in the console computes a disagreement state itself',
       !/function _computeDisagreement|DISAGREEMENT_SEVERITY\s*=/.test(bare),
       'no second opinion');
  }

  console.log('\n  what this suite does NOT prove');
  console.log('  UNPROVEN  a real browser render. The module runs in a minimal DOM, so');
  console.log('            layout and CSS are not exercised here.');
  console.log('  SCOPE     the console consumes the backend answer; it does not probe, and');
  console.log('            RC-2 (the empty platformServices registry) is untouched.');

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('══════════════════════════════════════════════════════════════════');
  process.exit(fail ? 1 : 0);
})();
