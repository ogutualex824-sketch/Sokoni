#!/usr/bin/env node
/* Healthcare Booking + IntaSend Payment Convergence — Gates 2 and 3 (ADR-015).
 *
 *   node scripts/test-healthcare-payment-convergence.js
 *   COUNTERPROOF=1 node scripts/test-healthcare-payment-convergence.js   # PRE-FIX source
 *
 * WHAT THIS GATE CLOSED
 * ---------------------
 * Gate 2 — healthcare took money through SokoniPay.bookNow (collect first, then let the
 *   legacy webhook `type:'booking'` branch credit the provider's wallet immediately) and
 *   through SokoniMpesa.pay → darajaSTKPush (STK against the SELLER'S OWN Daraja credentials,
 *   so the money never touched the platform). Both are gone; a chargeable healthcare provider
 *   is booked through the ONE canonical rail (SokoniBookService → bookingCreateService →
 *   createPaymentIntent → IntaSend → paid_held → Phase C settlement).
 *
 * Gate 3 — the client wrote status:"confirmed" on an appointment nobody had accepted, minted
 *   three invoices for money nobody collected, and its onFailure handler called _finalise()
 *   so a FAILED payment still produced a confirmed appointment and an invoice.
 *
 * Commission — healthcare service bookings settle at the approved 5% through the ONE engine
 *   (finos-utils.calculateCommission) over the ONE table (commission-config.RATES.healthcare).
 *   No second calculator: provider-hub.js selects INPUTS, it computes no rate.
 *
 * HOW IT IS TESTED
 * ----------------
 * Part A runs structural detectors over healthcare.html, every one scoped to an enclosing
 * function BODY by brace matching — never by character distance, which has rotted before.
 * Part B executes the REAL provider-ops._disburseHeldFunds, the REAL calculateCommission and
 * the REAL commission-config against a stubbed data layer, so the commission assertions are
 * on a number the production code actually produced.
 *
 * NEGATIVE CONTROLS: COUNTERPROOF=1 replays Part A against HEAD's healthcare.html and Part B
 * against HEAD's provider-ops.js — the SAME exported handler, the same fixture, so a control
 * cannot pass merely because a function is absent. HEAD's source is compiled against the REAL
 * functions directory (module.filename is the real path), so its sibling requires resolve
 * normally and it cannot fail to LOAD and be mistaken for "nothing detected".
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FUNCTIONS_DIR = path.join(ROOT, 'functions');
const COUNTERPROOF = !!process.env.COUNTERPROOF;

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 150) + ']' : ''));
  ok ? pass++ : fail++;
};

/* ── Read a file either from the worktree or from HEAD (the pre-fix control) ───────────── */
function source(relPath) {
  if (!COUNTERPROOF) return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  return execFileSync('git', ['show', 'HEAD:' + relPath.split(path.sep).join('/')],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/* ── Strip comments before asserting ──────────────────────────────────────────────────────
   Every detector below runs on STRIPPED source. Prose describing the removed rail names it —
   "SokoniMpesa.pay → darajaSTKPush", "_finalise('Pending Payment')" — so a detector run over
   raw text matches the comment that documents the fix and reports the vulnerability as still
   present. The reverse is worse and has happened here before: a comment satisfying a
   REQUIRED-substring check disarms the tripwire silently.

   JS comment removal tracks string and template literals, so `https://` inside a URL is never
   mistaken for a line comment and a `/*` inside a string never opens one. It is applied ONLY
   inside <script> blocks. Running that scanner over raw HTML desynchronises on the first prose
   apostrophe — "Gertrude's Children's Hospital" opens a quote that never legitimately closes,
   and everything up to the next stray apostrophe is swallowed, including comments the detector
   is meant to see. HTML comments are removed separately, where `<!-- -->` is unambiguous. */
function stripJs(src) {
  let out = '', i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], nx = src[i + 1];
    if (c === '/' && nx === '*') {
      const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; out += ' '; continue;
    }
    if (c === '/' && nx === '/') {
      while (i < n && src[i] !== '\n') i++; out += ' '; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += c; i++;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        out += src[i];
        if (src[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

function strip(src, isHtml) {
  if (!isHtml) return stripJs(src);
  const noHtmlComments = src.replace(/<!--[\s\S]*?-->/g, ' ');
  /* Strip JS comments inside each script block; leave the surrounding markup alone. */
  return noHtmlComments.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi,
    (_, open, code, close) => open + stripJs(code) + close);
}

/* ── Extract a function BODY by brace matching (structure, never a character budget) ───── */
function bodyOf(src, fnName) {
  const m = new RegExp('function\\s+' + fnName + '\\s*\\(').exec(src);
  if (!m) return null;
  const open = src.indexOf('{', m.index);
  if (open < 0) return null;
  let depth = 0, inS = null, esc = false;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (inS) { if (c === inS) inS = null; continue; }
    if (c === '"' || c === "'" || c === '`') { inS = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return null;
}

/* ════════════════════════════════════════════════════════════════════════════════════════
   PART A — the client rail (healthcare.html)
   ════════════════════════════════════════════════════════════════════════════════════════ */
function partA() {
  console.log('\nA. Client rail — healthcare.html' + (COUNTERPROOF ? '  (HEAD, pre-fix)' : ''));
  const html = strip(source('healthcare.html'), true);

  /* Anchors first: a detector that cannot find its subject proves nothing, so every
     body-scoped check below is gated on the function actually existing in BOTH runs. */
  const openAppt   = bodyOf(html, 'openAppt');
  const submitAppt = bodyOf(html, 'submitAppt');
  const startTC    = bodyOf(html, 'startTCWith');
  ck('A0a  openAppt() located',   !!openAppt,   openAppt ? openAppt.length + ' chars' : 'NOT FOUND');
  ck('A0b  submitAppt() located', !!submitAppt, submitAppt ? submitAppt.length + ' chars' : 'NOT FOUND');
  ck('A0c  startTCWith() located', !!startTC,   startTC ? startTC.length + ' chars' : 'NOT FOUND');
  if (!openAppt || !submitAppt || !startTC) {
    ck('A**  anchors missing — Part A cannot run', false, 'refusing to report absence as success');
    return;
  }

  /* — Gate 3: the Daraja / seller-till rail — */
  ck('A1   submitAppt() makes no SokoniMpesa call', !/SokoniMpesa/.test(submitAppt));
  ck('A2   sokoni-mpesa.js is not loaded', !/<script[^>]+src=["']sokoni-mpesa\.js/.test(html));
  ck('A3   no darajaSTKPush anywhere on the page', !/darajaSTKPush/.test(html));

  /* — Gate 2: the legacy collect-first booking rail — */
  ck('A4   openAppt() does not call SokoniPay.bookNow',    !/SokoniPay\s*\.\s*bookNow/.test(openAppt));
  ck('A5   startTCWith() does not call SokoniPay.bookNow', !/SokoniPay\s*\.\s*bookNow/.test(startTC));
  ck('A6   no SokoniPay.bookNow anywhere on the page',     !/SokoniPay\s*\.\s*bookNow/.test(html));

  /* — Gate 2: the canonical rail is present and wired — */
  ck('A7   sokoni-book-service.js is loaded', /<script[^>]+src=["']sokoni-book-service\.js/.test(html));
  ck('A8   openAppt() delegates to SokoniBookService', /SokoniBookService\s*\.\s*open\s*\(/.test(openAppt));

  /* — Gate 3: fabricated financial records — */
  const invoices = (html.match(/SokoniInvoice\s*\.\s*generate\s*\(/g) || []).length;
  ck('A9   zero fabricated invoices on the page', invoices === 0, invoices + ' SokoniInvoice.generate call(s)');

  /* — Gate 3: the client cannot establish that a provider accepted — */
  ck('A10  submitAppt() does not write status:"confirmed"',
    !/status\s*:\s*["']confirmed["']/.test(submitAppt));

  /* — Gate 3: finalise-on-failure — */
  ck('A11  no _finalise() reachable from a payment failure handler',
    !/onFailure[\s\S]{0,400}?_finalise/.test(submitAppt) && !/_finalise\s*\(/.test(submitAppt));

  /* — The page still PARSES —
     Removing a payment call can orphan the branch around it. Deleting the medicine-order
     invoice left `if (...) <gone>; else (toast)` — a dangling else that broke the whole
     inline block, and with it every handler on the page. Structural detectors all still
     passed, because the text they look for was correctly absent. Parse, don't infer.

     The comparison is against HEAD rather than zero: one pre-existing block does not parse
     standalone under this crude extractor, and a baseline that reports a known condition as
     a new regression trains everyone to ignore it. */
  const raw = source('healthcare.html');
  const bad = [];
  let blocks = 0;
  raw.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (m, attrs, code) => {
    if (/\bsrc=/.test(attrs) || !code.trim()) return m;
    blocks++;
    const isModule = /type\s*=\s*["']module["']/.test(attrs);
    try {
      new (require('vm').Script)(isModule
        ? '(async()=>{' + code.replace(/^\s*import[^;]+;/gm, '') + '})()'
        : code);
    } catch (e) { bad.push('#' + blocks + ' ' + e.message); }
    return m;
  });
  ck('A12  every inline script block still parses (HEAD baseline: 1)',
    bad.length <= 1, blocks + ' blocks; failing: ' + (bad.join('; ') || 'none'));
}

/* ════════════════════════════════════════════════════════════════════════════════════════
   PART B — the money, executed
   ════════════════════════════════════════════════════════════════════════════════════════ */

/* A Firestore stub whose where() ACTUALLY FILTERS. A no-op where() has silently made a
   previous suite pass on the wrong documents, so equality filtering is implemented. */
function makeDb(seed) {
  const store = JSON.parse(JSON.stringify(seed || {}));          /* { 'coll/id': {...} } */
  const writes = [];
  const docSnap = (p) => ({
    id: p.split('/').pop(), exists: Object.hasOwn(store, p), ref: { id: p.split('/').pop(), path: p },
    data: () => (Object.hasOwn(store, p) ? store[p] : undefined),
  });
  function query(coll, filters) {
    return {
      where: (f, op, v) => query(coll, filters.concat([[f, op, v]])),
      limit: () => query(coll, filters),
      orderBy: () => query(coll, filters),
      get: async () => {
        const docs = Object.keys(store)
          .filter((p) => p.startsWith(coll + '/') && p.slice(coll.length + 1).indexOf('/') < 0)
          .filter((p) => filters.every(([f, op, v]) => {
            const val = store[p][f];
            if (op === '==') return val === v;
            if (op === 'in') return Array.isArray(v) && v.includes(val);
            throw new Error('stub where(): unsupported op ' + op);
          }))
          .map(docSnap);
        return { empty: docs.length === 0, size: docs.length, docs, forEach: (fn) => docs.forEach(fn) };
      },
    };
  }
  const db = {
    collection: (coll) => Object.assign(query(coll, []), {
      doc: (id) => {
        const p = coll + '/' + (id || 'auto_' + Math.random().toString(36).slice(2));
        return {
          id: p.split('/').pop(), path: p,
          collection: (sub) => db.collection(p + '/' + sub),
          get: async () => docSnap(p),
          set: async (d, o) => { writes.push(['set', p, d]); store[p] = o && o.merge ? Object.assign({}, store[p], d) : d; },
          update: async (d) => { writes.push(['update', p, d]); store[p] = Object.assign({}, store[p], d); },
        };
      },
    }),
    runTransaction: async (fn) => fn({
      get: async (ref) => docSnap(ref.path),
      set: (ref, d, o) => { writes.push(['set', ref.path, d]); store[ref.path] = o && o.merge ? Object.assign({}, store[ref.path], d) : d; },
      update: (ref, d) => { writes.push(['update', ref.path, d]); store[ref.path] = Object.assign({}, store[ref.path], d); },
    }),
  };
  return { db, store, writes };
}

/* Seeded, never null: provider-ops and finos-utils both touch firestore() while the module is
   still LOADING, so a null fixture throws before a single assertion runs — which reads as a
   FATAL rather than as the finding it is not. Each scenario swaps this for its own fixture. */
let CURRENT = { db: { collection: () => ({ doc: () => ({}) }) } };
let PLAN_RATE = 0.20;                               /* Free Trial — the provider's plan rate */

const FieldValue = {
  serverTimestamp: () => ({ __s: 'ts' }),
  increment: (by) => ({ __s: 'inc', by }),
  delete: () => ({ __s: 'del' }),
};
const Timestamp = {
  now: () => ({ toMillis: () => Date.now() }),
  fromMillis: (m) => ({ toMillis: () => m }),
};

/* The require hook STAYS INSTALLED for the whole run: provider-ops and finos-utils both
   require lazily inside their handlers, and tearing the hook down early has previously made
   a module load against an uninitialised firebase-admin and throw before any assertion. */
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'firebase-admin') {
    return { firestore: Object.assign(() => CURRENT.db, { Timestamp, FieldValue }), apps: [{}] };
  }
  if (request === 'firebase-admin/firestore') {
    return { getFirestore: () => CURRENT.db, FieldValue, Timestamp };
  }
  if (request === 'firebase-functions/v2/https') {
    return { HttpsError: class HttpsError extends Error { constructor(c, m) { super(m); this.code = c; } } };
  }
  if (request === 'firebase-functions/logger') {
    return { info() {}, warn() {}, error() {}, log() {}, debug() {} };
  }
  if (/subscription-core$/.test(request)) {
    return { getCommissionRate: async () => PLAN_RATE, resolveSubscription: async () => null };
  }
  if (/legal-agreements$/.test(request)) {
    return { assertLegalCompliance: async () => ({ compliant: true }), complianceFor: async () => ({ compliant: true }) };
  }
  return realLoad.apply(this, arguments);
};

/* Compile a module from arbitrary SOURCE but give it the REAL path, so every sibling
   require('./x') resolves against functions/ exactly as in production. This is what lets the
   counter-proof run HEAD's provider-ops.js without hand-listing shims for its siblings —
   the failure mode that once reported "nothing detected" for a mutant that never loaded. */
function loadSource(relPath, src) {
  const filename = path.join(ROOT, relPath);
  const m = new Module(filename, null);
  m.filename = filename;
  m.paths = Module._nodeModulePaths(path.dirname(filename));
  m._compile(src, filename);
  return m.exports;
}

function loadProviderOps() {
  const rel = path.join('functions', 'provider-ops.js');
  return loadSource(rel, source(rel));
}

async function partB() {
  console.log('\nB. Commission — the real engine, executed' + (COUNTERPROOF ? '  (HEAD, pre-fix)' : ''));

  const PROV = 'prov_health_1';
  const CUST = 'cust_1';

  /* KES 100.00 consultation. Deliberately small: 5% is KES 5, BELOW the KES 10 platform
     minimum, so this doubles as the proof that skipMinimum keeps the floor off a path that
     has never had one. */
  const GROSS = 10000;

  function fixture(hub) {
    return makeDb({
      'providerBookings/BK1': {
        providerId: PROV, customerUid: CUST, paymentStatus: 'paid_held',
        price: GROSS, fee: 0, deposit: GROSS, service: 'Consultation',
        startTs: Date.now() + 3600000,            /* < 24h away → late cancel forfeits deposit */
        ...(hub === undefined ? {} : { commissionHub: hub }),
      },
    });
  }

  const ops = loadProviderOps();
  ck('B0   provider-ops._disburseHeldFunds is exported in this run',
    typeof ops._disburseHeldFunds === 'function', typeof ops._disburseHeldFunds);
  if (typeof ops._disburseHeldFunds !== 'function') {
    ck('B**  handler missing — Part B cannot run', false, 'refusing to report absence as success');
    return;
  }

  /* Drive the REAL disbursement and read the commission off the providerPayouts write. */
  async function commissionFor(hub) {
    CURRENT = fixture(hub);
    const ref = CURRENT.db.collection('providerBookings').doc('BK1');
    await ops._disburseHeldFunds(CURRENT.store['providerBookings/BK1'], ref,
      { by: 'customer', isNoShow: true });
    const payout = CURRENT.store['providerPayouts/BK1'];
    return payout ? { gross: payout.gross, commission: payout.commission, net: payout.net } : null;
  }

  PLAN_RATE = 0.20;                                  /* Free Trial — the pre-convergence rate */

  const health = await commissionFor('healthcare');
  ck('B1   healthcare booking settles a commission at all', !!health, JSON.stringify(health));
  ck('B2   healthcare commission is the approved 5%',
    !!health && health.commission === 500, health ? health.commission + ' cents of ' + GROSS : 'no payout');
  ck('B3   healthcare is NOT charged the 20% plan rate',
    !!health && health.commission !== 2000, health ? health.commission + ' cents' : 'no payout');
  ck('B4   KES 10 platform floor is NOT applied to healthcare',
    !!health && health.commission < 1000, health ? health.commission + ' cents (floor would be 1000)' : 'no payout');

  const generic = await commissionFor('provider');
  ck('B5   a NON-healthcare booking still pays the plan rate (unchanged)',
    !!generic && generic.commission === 2000, generic ? generic.commission + ' cents of ' + GROSS : 'no payout');

  /* Back-compat: bookings created before this gate carry no commissionHub at all. They must
     price exactly as they did yesterday — an absent field must never fall to the cheaper rate. */
  const legacy = await commissionFor(undefined);
  ck('B6   a legacy booking with NO commissionHub pays the plan rate',
    !!legacy && legacy.commission === 2000, legacy ? legacy.commission + ' cents' : 'no payout');

  /* The rate must track the hub, not the plan: an Enterprise provider already pays 5% on the
     generic path, so pinning PLAN_RATE elsewhere proves healthcare is not coincidentally right. */
  PLAN_RATE = 0.07;                                                       /* Business plan 7% */
  const health7 = await commissionFor('healthcare');
  ck('B7   healthcare stays 5% when the plan rate is 7%',
    !!health7 && health7.commission === 500, health7 ? health7.commission + ' cents' : 'no payout');
  const generic7 = await commissionFor('provider');
  ck('B8   generic follows the plan rate to 7%',
    !!generic7 && generic7.commission === 700, generic7 ? generic7.commission + ' cents' : 'no payout');
  PLAN_RATE = 0.20;
}

/* ════════════════════════════════════════════════════════════════════════════════════════
   PART C — the hub is resolved from an authority the provider cannot set
   ════════════════════════════════════════════════════════════════════════════════════════ */
async function partC() {
  console.log('\nC. Hub authority — provider-hub.resolveProviderHub' + (COUNTERPROOF ? '  (HEAD, pre-fix)' : ''));

  const rel = path.join('functions', 'provider-hub.js');
  let hub = null, loadErr = null;
  try { hub = loadSource(rel, source(rel)); } catch (e) { loadErr = e.message; }

  if (!hub) {
    /* In COUNTERPROOF the module does not exist at HEAD. That is the finding, and it is
       reported as a FAILURE — an absent authority is the vulnerability, never a pass. */
    ck('C0   provider-hub.js exists and loads', false, loadErr || 'module absent at HEAD');
    return;
  }
  ck('C0   provider-hub.js exists and loads', true);

  const mk = (docs) => makeDb(docs).db;

  const decidedHealth = mk({ 'applications/a1': { uid: 'P', role: 'health', status: 'approved' } });
  ck('C1   a DECIDED health application → healthcare',
    (await hub.resolveProviderHub(decidedHealth, 'P')) === 'healthcare');

  const pendingHealth = mk({ 'applications/a1': { uid: 'P', role: 'health', status: 'pending' } });
  ck('C2   a PENDING health application → provider (cannot self-select a rate)',
    (await hub.resolveProviderHub(pendingHealth, 'P')) === 'provider');

  /* The self-serve discount this design exists to prevent: providers/{uid}.category is
     written from draft.profile.category through _san() only — SERVICE_CATEGORIES is served
     to the client, never used to validate what comes back — so it is provider-settable text.
     Pricing on it would let anyone type "Healthcare" and move from 20% to 5%. */
  const selfDeclared = mk({
    'providers/P': { uid: 'P', category: 'Healthcare', subcategory: 'Doctor', status: 'active' },
    'applications/a1': { uid: 'P', role: 'provider', status: 'approved' },
  });
  ck('C3   self-declared providers.category="Healthcare" → provider (no self-serve discount)',
    (await hub.resolveProviderHub(selfDeclared, 'P')) === 'provider');

  ck('C4   no application at all → provider',
    (await hub.resolveProviderHub(mk({}), 'P')) === 'provider');

  ck('C5   another provider\'s health application does not leak',
    (await hub.resolveProviderHub(
      mk({ 'applications/a1': { uid: 'SOMEONE_ELSE', role: 'health', status: 'approved' } }), 'P')) === 'provider');

  /* Fail-soft must fail to the HIGHER charge, never to the cheaper healthcare rate. */
  const throwing = { collection: () => ({ where: () => ({ limit: () => ({ get: async () => { throw new Error('unavailable'); } }) }) }) };
  ck('C6   an unreadable application → provider (fails to the higher rate)',
    (await hub.resolveProviderHub(throwing, 'P')) === 'provider');

  /* commissionArgsForHub — the selection itself. */
  const hArgs = hub.commissionArgsForHub('healthcare');
  ck('C7   healthcare args target the healthcare table', hArgs.category === 'healthcare' && hArgs.hubId === 'healthcare', JSON.stringify(hArgs));
  ck('C8   healthcare args omit subscriptionRole (plan rate must not outrank 5%)', hArgs.subscriptionRole === undefined);
  ck('C9   healthcare args pass skipMinimum (the floor never applied to bookings)', hArgs.skipMinimum === true);
  const gArgs = hub.commissionArgsForHub('provider');
  ck('C10  generic args are byte-identical to the pre-gate call',
    gArgs.category === 'services' && gArgs.hubId === 'provider' && gArgs.subscriptionRole === 'provider' && gArgs.skipMinimum === undefined,
    JSON.stringify(gArgs));
}

/* ════════════════════════════════════════════════════════════════════════════════════════
   PART D — the hub is SNAPSHOTTED at creation, and is not the client's field
   ════════════════════════════════════════════════════════════════════════════════════════ */
function partD() {
  console.log('\nD. Snapshot discipline — booking-service.js' + (COUNTERPROOF ? '  (HEAD, pre-fix)' : ''));
  const src = strip(source(path.join('functions', 'booking-service.js')));

  /* Scope to the booking document literal by brace matching from txn.set(bookingRef, { — a
     character budget would rot the moment anything is inserted above it. */
  const at = src.indexOf('txn.set(bookingRef, {');
  ck('D0   the booking document write is located', at >= 0);
  if (at < 0) { ck('D**  anchor missing — Part D cannot run', false, 'refusing to report absence as success'); return; }
  const open = src.indexOf('{', at + 'txn.set(bookingRef,'.length);
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const doc = src.slice(open, end + 1);

  ck('D1   commissionHub is stamped on the booking', /\bcommissionHub\b/.test(doc));
  ck('D2   it is resolved server-side, not read off the request',
    !/commissionHub\s*:\s*_san\s*\(\s*d\./.test(doc) && !/commissionHub\s*:\s*d\./.test(doc));
  ck('D3   the resolver runs before the transaction',
    /resolveProviderHub\s*\(/.test(src) && src.indexOf('resolveProviderHub') < src.indexOf('runTransaction'));
  ck('D4   the client-supplied hubType is still present and still descriptive',
    /hubType\s*:\s*_san\s*\(\s*d\.hubType/.test(doc));
}

/* ════════════════════════════════════════════════════════════════════════════════════════ */
(async () => {
  console.log('HEALTHCARE BOOKING + INTASEND PAYMENT CONVERGENCE — Gates 2 + 3 (ADR-015)');
  console.log(COUNTERPROOF
    ? 'MODE: COUNTERPROOF — HEAD (pre-fix). Failures below are the vulnerability being closed.'
    : 'MODE: verification — worktree.');
  try {
    partA();
    await partB();
    await partC();
    partD();
  } catch (e) {
    ck('FATAL', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e));
  } finally {
    Module._load = realLoad;
  }
  console.log('\n' + '─'.repeat(76));
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  if (COUNTERPROOF) {
    console.log(fail > 0
      ? `COUNTER-PROOF HOLDS — ${fail} check(s) fail against pre-fix source.`
      : 'COUNTER-PROOF FAILED — pre-fix source passed everything; the detectors prove nothing.');
    process.exit(fail > 0 ? 0 : 1);
  }
  process.exit(fail === 0 ? 0 : 1);
})();
