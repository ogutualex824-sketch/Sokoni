'use strict';
/* ════════════════════════════════════════════════════════════════════════════════════════════
   GATE C CERTIFICATION — checkout consumes the AUTHORITATIVE server quote.

   WHAT MAKES THIS DIFFERENT FROM A GREP.
   The Gate C census found a path that never called a guard. A suite that proves `_dqa` is
   *mentioned* in `functions/index.js`, or that `assertNoClientPricing` *exists*, would have passed
   against the defective code just as happily — the guards existed all along; nothing reached them.

   So this suite LOADS THE REAL `functions/index.js` and EXECUTES the real `createCheckoutSession`
   and `requestDeliveryQuote` handlers. `admin.firestore()` is replaced, before that load, with an
   in-memory store that records every path it is asked for. Reachability is then a fact about an
   execution trace — "this run read `deliveryQuotes/<id>`" — not an inference from source text.

   NOTHING TOUCHES PRODUCTION. The stub is installed before `firebase-admin` is handed to any
   module, so every `db.collection(...)` in the loaded graph resolves to the fake. A read of a
   path the fake does not know about returns "not found"; it never falls through to a network.

   SABOTAGE IS IN-PROCESS, NEVER ON DISK.
   Server guards are neutralised by rebinding the exported property the live call site uses
   (`_dqEndpoint.assertNoCheckoutPricing(...)` is a property lookup at call time, so rebinding it
   sabotages the RUNNING path). Browser guards are sabotaged by editing a STRING copy of
   `checkout.html`. No file is ever written, so a killed run cannot strand a mutation for the next
   suite to adopt as its baseline.

   Run:  node scripts/certify-gate-c-checkout-quote.js
   ════════════════════════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');

process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-gate-c-cert';

/* ── A suite must never hang: a hang exits 0 with no summary and reads as a pass. ───────────── */
const WATCHDOG = setTimeout(() => {
  process.stdout.write('\n  ✖ WATCHDOG — the suite did not finish in 180s. Failing closed.\n');
  process.exit(2);
}, 180000);

/* ── Bookkeeping ───────────────────────────────────────────────────────────────────────────── */
let PASS = 0, FAIL = 0, BLOCKED = 0;
const FAILURES = [];
const RESIDUALS = [];

const ok = (id, msg) => { PASS++; console.log('  ✔ ' + id.padEnd(6) + msg); return true; };
const bad = (id, msg, extra) => {
  FAIL++; FAILURES.push(id + ' — ' + msg);
  console.log('  ✖ ' + id.padEnd(6) + msg + (extra ? '\n           ' + String(extra).slice(0, 300) : ''));
  return false;
};
const blocked = (id, msg) => {
  BLOCKED++; FAILURES.push(id + ' — BLOCKED: ' + msg);
  console.log('  ⚠ ' + id.padEnd(6) + 'BLOCKED: ' + msg);
  return false;
};
const check = (id, cond, msg, extra) => (cond ? ok(id, msg) : bad(id, msg, extra));
const section = (t) => console.log('\n' + t + '\n' + '─'.repeat(Math.max(t.length, 78)));

/* Suppress the loaded functions' own logging for the duration of a handler call — firebase
   `logger` writes structured JSON straight to stdout and would bury the report. */
async function quiet(fn) {
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  try { return await fn(); }
  finally { process.stdout.write = so; process.stderr.write = se; }
}

/* ── The in-memory store ───────────────────────────────────────────────────────────────────── */
function makeStore() {
  const data = new Map();
  let reads = [];
  let writes = [];
  const key = (c, d) => c + '/' + d;
  const snapOf = (c, d) => {
    const v = data.get(key(c, d));
    return { id: d, exists: v !== undefined, ref: { path: key(c, d) }, data: () => (v === undefined ? undefined : Object.assign({}, v)) };
  };
  const collection = (c) => ({
    doc: (d) => ({
      id: String(d),
      get: async () => { reads.push(key(c, d)); return snapOf(c, d); },
      set: async (obj) => { writes.push(key(c, d)); data.set(key(c, d), Object.assign({}, obj)); },
      create: async (obj) => {
        if (data.has(key(c, d))) { const e = new Error('ALREADY_EXISTS: ' + key(c, d)); e.code = 6; throw e; }
        writes.push(key(c, d)); data.set(key(c, d), Object.assign({}, obj));
      },
      update: async (obj) => { writes.push(key(c, d)); data.set(key(c, d), Object.assign({}, data.get(key(c, d)) || {}, obj)); },
      delete: async () => { writes.push(key(c, d)); data.delete(key(c, d)); },
    }),
    where: function (_f, _op, val) {
      const self = {
        where: () => self, limit: () => self, orderBy: () => self,
        get: async () => {
          const ids = Array.isArray(val) ? val : [val];
          const docs = ids.filter((id) => data.has(key(c, id))).map((id) => { reads.push(key(c, id)); return snapOf(c, id); });
          return { empty: docs.length === 0, size: docs.length, docs, forEach: (f) => docs.forEach(f) };
        },
      };
      return self;
    },
  });
  return {
    collection,
    runTransaction: async () => { throw new Error('FAKE_STORE: runTransaction not expected on this path'); },
    /* test-side controls */
    _put: (c, d, o) => data.set(key(c, d), Object.assign({}, o)),
    _patch: (c, d, o) => data.set(key(c, d), Object.assign({}, data.get(key(c, d)) || {}, o)),
    _get: (c, d) => (data.has(key(c, d)) ? Object.assign({}, data.get(key(c, d))) : null),
    _del: (c, d) => data.delete(key(c, d)),
    _trace: () => ({ reads: reads.slice(), writes: writes.slice() }),
    _clearTrace: () => { reads = []; writes = []; },
  };
}

const STORE = makeStore();

/* ── Install the stub BEFORE anything is loaded ────────────────────────────────────────────── */
let admin, HttpsError, idx, dqEndpoint, dqa, vsa, APPROVED;
try {
  admin = require(require.resolve('firebase-admin', { paths: [FN] }));
  const realFirestore = admin.firestore;
  const stub = function () { return STORE; };
  /* Keep the statics — FieldValue / FieldPath / Timestamp are used by the loaded modules. */
  Object.getOwnPropertyNames(realFirestore).forEach((k) => {
    if (k === 'length' || k === 'name' || k === 'prototype') return;
    try { stub[k] = realFirestore[k]; } catch (_) { /* non-configurable */ }
  });
  /* `firestore` is a GETTER on FirebaseNamespace.prototype, so plain assignment throws in strict
     mode — and fails SILENTLY in sloppy mode, which is how a stub can look installed while every
     call still goes to the real backend. Define an own data property to shadow it, then prove the
     shadow took effect before anything is loaded. */
  Object.defineProperty(admin, 'firestore', { value: stub, configurable: true, writable: true });
  if (admin.firestore() !== STORE) throw new Error('the Firestore stub did not take effect — refusing to run against a real backend');
  if (typeof admin.firestore.FieldPath !== 'function' || typeof admin.firestore.FieldValue !== 'function') {
    throw new Error('the Firestore stub lost FieldPath/FieldValue');
  }

  HttpsError = require(require.resolve('firebase-functions/v2/https', { paths: [FN] })).HttpsError;
  dqa = require(path.join(FN, 'delivery-quote-authority.js'));
  vsa = require(path.join(FN, 'vehicle-selection-authority.js'));
  dqEndpoint = require(path.join(FN, 'delivery-quote-endpoint.js'));
  APPROVED = require(path.join(ROOT, 'scripts', 'write-delivery-pricing-policy.js')).APPROVED;
  idx = require(path.join(FN, 'index.js'));
} catch (e) {
  console.log('\n  ✖ SETUP — could not load the production modules: ' + (e && e.message));
  console.log((e && e.stack || '').split('\n').slice(0, 8).join('\n'));
  clearTimeout(WATCHDOG);
  process.exit(2);
}

/* ── Fixtures ──────────────────────────────────────────────────────────────────────────────── */
const BUYER = 'buyer-uid-gate-c';
const OTHER = 'other-uid-gate-c';
const SELLER = 'seller-uid-gate-c';
const PRODUCT = 'prod-gate-c-1';
const UNIT_PRICE = 1200;

const POLICY_IN_FORCE = Object.assign({}, APPROVED, {
  effectiveFrom: new Date(Date.now() - 86400000).toISOString(),
});

function seed() {
  STORE._put('platformConfig', 'deliveryPricing', JSON.parse(JSON.stringify(POLICY_IN_FORCE)));
  STORE._put('products', PRODUCT, { name: 'Gate C Test Item', price: UNIT_PRICE, sellerUid: SELLER, stock: 100 });
  STORE._put('shops', SELLER, { open: true });
}
seed();

const REQ = (uid, data) => ({
  data,
  auth: { uid, token: { uid, firebase: { sign_in_provider: 'password' } } },
  rawRequest: { headers: {}, ip: '127.0.0.1' },
  acceptsStreaming: false,
});

const CART = [{ productId: PRODUCT, qty: 1 }];
/* The default trip is the one the BROWSER now sends: a described shipment and NO vehicle class.
   Asserting a class here would test a payload the page no longer produces. */
const TRIP = (over) => Object.assign({
  distanceKm: 6,
  estimatedMinutes: 22,
  shipment: { totalWeightKg: 3, packageCount: 1 },
}, over || {});

/* Derived from the canonical vocabulary and the APPROVED policy — NOT from the authority under
   test — so "smallest suitable" is checked against an independent computation. */
const vehicleClasses = require(path.join(FN, 'vehicle-classes.js'));
function smallestPricedClassFor(kg) {
  return Object.keys(vehicleClasses.CLASSES)
    .filter((c) => vehicleClasses.isDispatchEligibleClass(c))
    .filter((c) => Object.keys(APPROVED.economics.vehicleClasses).some((k) => vehicleClasses.canonicalise(k) === c))
    .map((c) => ({ c, cap: vehicleClasses.capacityOf(c) }))
    .filter((x) => x.cap && x.cap.maxWeightKg >= kg)
    .sort((a, b) => a.cap.maxWeightKg - b.cap.maxWeightKg)
    .map((x) => x.c)[0] || null;
}

const issue = (uid, over) => quiet(() => idx.requestDeliveryQuote.run(REQ(uid || BUYER, TRIP(over))));
const checkout = (data, uid) => quiet(() => idx.createCheckoutSession.run(REQ(uid || BUYER, data)));

/* Did it REFUSE, or did it CRASH? A TypeError is not a refusal. */
async function refuses(id, fn, matcher, what) {
  let threw = null, ret;
  try { ret = await fn(); } catch (e) { threw = e; }
  if (!threw) {
    return bad(id, what + ' — NOT refused', 'returned: ' + JSON.stringify(ret && ret.serverTotal !== undefined ? { serverTotal: ret.serverTotal } : ret).slice(0, 200));
  }
  if (threw instanceof TypeError || threw instanceof ReferenceError || threw instanceof SyntaxError) {
    return bad(id, what + ' — CRASHED rather than refused', threw.name + ': ' + threw.message);
  }
  const text = (threw.message || '') + ' ' + (threw.reason || '') + ' ' + JSON.stringify(threw.details || {});
  if (!matcher.test(text)) return bad(id, what + ' — refused for the WRONG reason', text.slice(0, 240));
  return ok(id, what + ' → ' + (threw.message || threw.reason || '').slice(0, 86));
}

/* Did it SUCCEED? A control that fails means the guard refuses everybody. */
async function succeeds(id, fn, what) {
  try { const r = await fn(); return { pass: ok(id, what), value: r }; }
  catch (e) { return { pass: bad(id, what + ' — refused a LEGITIMATE request', (e && (e.message || e.reason)) || String(e)), value: null }; }
}

/* ════════════════════════════════════════════════════════════════════════════════════════════
   SOURCE READERS — used only for the browser layer, which cannot be executed here.
   Every assertion runs on COMMENT-STRIPPED text: the Gate C comments quote the very patterns
   being searched for, so an unstripped check would match its own documentation.
   ════════════════════════════════════════════════════════════════════════════════════════════ */
function stripComments(src) {
  let s = src.replace(/<!--[\s\S]*?-->/g, ' ');          /* HTML comments */
  s = s.replace(/\/\*[\s\S]*?\*\//g, ' ');                /* block comments */
  s = s.replace(/^[ \t]*\/\/[^\n]*$/gm, ' ');             /* whole-line // comments only —
                                                             a looser rule eats https:// URLs */
  return s;
}

const CHECKOUT_RAW = fs.readFileSync(path.join(ROOT, 'checkout.html'), 'utf8');
const CHECKOUT = stripComments(CHECKOUT_RAW);
const INDEX_RAW = fs.readFileSync(path.join(FN, 'index.js'), 'utf8');
const INDEX = stripComments(INDEX_RAW);

/* Slice one top-level function body out of the page's script, so "is it called?" can be asked of
   the caller rather than of the whole file. Returns null when the function cannot be isolated —
   never a silent `false`, which would read as a clean result. */
function fnBody(src, name) {
  const m = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(src);
  if (!m) return null;
  const rest = src.slice(m.index + m[0].length);
  const nxt = rest.search(/\n(?:async\s+)?function\s+\w+\s*\(/);
  return nxt < 0 ? rest : rest.slice(0, nxt);
}

/* Browser-layer detectors. Each takes source so a sabotaged copy can be run through the same
   function — the detector under test is literally the same code path. */
const D = {
  clientPricerCalled: (s) => /SokoniDeliveryPricing\s*\.\s*calculate/.test(s),
  clientPricerScript: (s) => /sokoni-delivery-pricing\.js/.test(s),
  fallbackFormula: (s) => /80\s*\+\s*[A-Za-z_$][\w$.]*\s*\*\s*15/.test(s),
  feeSentToServer: (s) => {
    const m = s.match(/createSession\s*\(\s*\{[\s\S]*?\}\s*\)/);
    return m ? /(^|[^\w.])deliveryFee\s*:/.test(m[0]) : null;
  },
  quoteIdSentToServer: (s) => {
    const m = s.match(/createSession\s*\(\s*\{[\s\S]*?\}\s*\)/);
    return m ? /(^|[^\w.])deliveryQuoteId\s*:/.test(m[0]) : null;
  },
  /* REACHABILITY, NOT EXISTENCE — in the browser layer too.
     "the string requestDeliveryQuote appears in checkout.html" is exactly the kind of check that
     would have passed against the defective page: the authority existed all along, nothing called
     it. So the chain is checked link by link: the helper really wraps the callable, `calcDelivery`
     really calls the helper, and the delivery inputs really call `calcDelivery`.
     (`[^)]*` would also not survive the nested `getFunctions(...)` in the real argument list.) */
  serverQuoteHelperDefined: (s) => /httpsCallable\s*\([\s\S]{0,160}?["']requestDeliveryQuote["']\s*\)/.test(s),
  serverQuoteCalledFromCalc: (s) => {
    const body = fnBody(s, 'calcDelivery');
    return body === null ? null : /await\s+_requestServerDeliveryQuote\s*\(/.test(body);
  },
  calcDeliveryWired: (s) => /(onchange|oninput)\s*=\s*"calcDelivery\(\)"/.test(s),
  feeAssignments: (s) => {
    const out = [];
    const re = /(^|[^\w.$])deliveryFee\s*=\s*([^;\n]+)/g;
    let m; while ((m = re.exec(s))) out.push(m[2].trim());
    return out;
  },
};

/* ════════════════════════════════════════════════════════════════════════════════════════════ */
async function main() {
  console.log('\n════════════════════════════════════════════════════════════════════════════════');
  console.log('  GATE C — CHECKOUT CONSUMES THE AUTHORITATIVE SERVER QUOTE');
  console.log('  Real handlers, executed. Firestore replaced in memory. Nothing deployed.');
  console.log('════════════════════════════════════════════════════════════════════════════════');

  /* ── 0. The harness itself ───────────────────────────────────────────────────────────────── */
  section('0  HARNESS — the instrument must be able to fail');
  check('H0-1', typeof idx.createCheckoutSession.run === 'function',
    'the REAL createCheckoutSession handler is invocable');
  check('H0-2', typeof idx.requestDeliveryQuote.run === 'function',
    'the REAL requestDeliveryQuote handler is invocable (it is exported from index.js)');
  {
    const probe = await quiet(() => STORE.collection('platformConfig').doc('deliveryPricing').get());
    check('H0-3', probe.exists && probe.data().policyVersion === 'v1',
      'the in-memory store answers reads — the approved v1 policy is seeded and in force');
    const miss = await quiet(() => STORE.collection('platformConfig').doc('nothing-here').get());
    check('H0-4', miss.exists === false,
      'CONTROL — an unknown path resolves to "not found", it does not fall through to a network');
  }
  check('H0-5', stripComments('a /* deliveryFee = 1 */ b').indexOf('deliveryFee') === -1
    && stripComments('let x = 1; // note\nlive();').indexOf('live()') !== -1,
    'CONTROL — the comment stripper removes comments and preserves live code');
  check('H0-6', /80\s*\+\s*[A-Za-z_$][\w$.]*\s*\*\s*15/.test('deliveryFee = Math.round(80 + zone.distanceKm * 15);'),
    'CONTROL — the fallback-formula detector can see the pattern when it is present');

  /* ── 1. REACHABILITY, by execution ───────────────────────────────────────────────────────── */
  section('1  REACHABILITY — does a normal checkout actually reach the Step 4 authority?');
  STORE._clearTrace();
  const q1 = await succeeds('R1-1', () => issue(), 'requestDeliveryQuote returns a quote for a normal trip');
  const quote1 = q1.value;
  if (!quote1) { blocked('R1', 'no quote issued — the rest of the suite cannot run honestly'); return finish(); }
  {
    const t = STORE._trace();
    check('R1-2', t.reads.includes('platformConfig/deliveryPricing'),
      'issuing READ the approved policy — the Step 4 authority was reached, not bypassed');
    check('R1-3', t.writes.includes('deliveryQuotes/' + quote1.quoteId),
      'issuing PERSISTED the quote to deliveryQuotes/' + String(quote1.quoteId).slice(0, 18) + '…');
    check('R1-4', quote1.pricingVersion === dqa.PRICING_VERSION,
      'the issued quote carries the authority\'s pricingVersion (' + dqa.PRICING_VERSION + ')');
  }

  STORE._clearTrace();
  const c1 = await succeeds('R1-5', () => checkout({ cartItems: CART, deliveryQuoteId: quote1.quoteId, fulfillmentType: 'delivery' }),
    'createCheckoutSession accepts the quote id and authorises a session');
  const sess1 = c1.value;
  if (!sess1) { blocked('R1-5', 'checkout did not complete on the legitimate path'); return finish(); }
  {
    const t = STORE._trace();
    check('R1-6', t.reads.includes('deliveryQuotes/' + quote1.quoteId),
      'CHECKOUT READ THE STORED QUOTE — the execution trace proves the path reaches the authority');
    check('R1-7', t.reads.includes('platformConfig/deliveryPricing'),
      'checkout re-read the commercial policy to revalidate the quote');
    check('R1-8', !t.reads.includes('deliveryQuotes/never-issued-control'),
      'CONTROL — the trace records only what was really read (an unissued id is absent from it)');
  }

  /* ── 2. THE QUOTE DETERMINES THE CHARGE ──────────────────────────────────────────────────── */
  section('2  DERIVATION — is the stored quote what actually sets the delivery charge?');
  const stored1 = STORE._get('deliveryQuotes', quote1.quoteId);
  const expect1 = Math.round(stored1.customerChargeMinor / 100);
  check('Q2-1', sess1.serverTotal === UNIT_PRICE + expect1,
    'serverTotal = goods ' + UNIT_PRICE + ' + stored quote ' + expect1 + ' = ' + (UNIT_PRICE + expect1)
    + '  (actual ' + sess1.serverTotal + ')');
  {
    const w = STORE._get('checkoutSessions', sess1.sessionId);
    check('Q2-2', w && w.deliveryFee === expect1,
      'the session record persists the authoritative fee (' + (w && w.deliveryFee) + '), not a client figure');
  }
  {
    /* The decisive test: move the authoritative figure and the charge must move WITH it.
       Equality on one sample could be coincidence; covariance cannot. */
    const q2 = (await succeeds('Q2-3', () => issue(BUYER, { distanceKm: 24, estimatedMinutes: 60 }),
      'a second, longer trip is quoted')).value;
    if (q2) {
      const s2 = (await succeeds('Q2-4', () => checkout({ cartItems: CART, deliveryQuoteId: q2.quoteId, fulfillmentType: 'delivery' }),
        'checkout runs against the second quote')).value;
      const stored2 = STORE._get('deliveryQuotes', q2.quoteId);
      const expect2 = Math.round(stored2.customerChargeMinor / 100);
      check('Q2-5', !!s2 && (s2.serverTotal - sess1.serverTotal) === (expect2 - expect1) && expect2 !== expect1,
        'the charge MOVES WITH the stored quote: Δcharge ' + (s2 ? s2.serverTotal - sess1.serverTotal : 'n/a')
        + ' = Δquote ' + (expect2 - expect1) + ' — derivation, not coincidence');
    }
  }
  {
    /* A record tampered with directly must not settle into a charge. */
    const q3 = (await issue()).quoteId;
    STORE._patch('deliveryQuotes', q3, { customerChargeMinor: STORE._get('deliveryQuotes', q3).customerChargeMinor + 50000 });
    await refuses('Q2-6', () => checkout({ cartItems: CART, deliveryQuoteId: q3, fulfillmentType: 'delivery' }),
      /delivery_quote_invalid/, 'a stored quote tampered to overcharge (conservation broken)');
  }
  {
    const qz = (await issue()).quoteId;
    await succeeds('Q2-7', () => checkout({ cartItems: CART, deliveryQuoteId: qz, fulfillmentType: 'delivery' }),
      'CONTROL — an untampered quote of the same shape still settles into a charge');
  }
  {
    const s = await succeeds('Q2-8', () => checkout({ cartItems: CART, fulfillmentType: 'pickup' }),
      'pickup needs no quote and is charged goods only');
    check('Q2-9', !!s.value && s.value.serverTotal === UNIT_PRICE,
      'pickup serverTotal = ' + (s.value && s.value.serverTotal) + ' (goods only, no delivery leg)');
  }

  /* ── 3. A FORGED CLIENT PRICE ────────────────────────────────────────────────────────────── */
  section('3  FORGED CLIENT PRICING — the browser may ask, it may not tell');
  {
    const q = (await issue()).quoteId;
    await refuses('P3-1', () => checkout({ cartItems: CART, deliveryQuoteId: q, fulfillmentType: 'delivery', deliveryFee: 5 }),
      /deliveryFee/, 'checkout payload carrying deliveryFee: 5');
    const before = STORE._trace().writes.filter((w) => w.startsWith('checkoutSessions/')).length;
    await quiet(async () => { try { await checkout({ cartItems: CART, deliveryQuoteId: q, fulfillmentType: 'delivery', deliveryFee: 5 }); } catch (_) {} });
    const after = STORE._trace().writes.filter((w) => w.startsWith('checkoutSessions/')).length;
    check('P3-2', after === before, 'the refusal is a REFUSAL, not a silent drop — no session was written');
  }
  for (const f of dqEndpoint.CHECKOUT_FORBIDDEN_PRICING) {
    const q = (await issue()).quoteId;
    const payload = { cartItems: CART, deliveryQuoteId: q, fulfillmentType: 'delivery' };
    payload[f] = 1;
    await refuses('P3-' + f, () => checkout(payload), new RegExp(f), 'checkout payload carrying ' + f);
  }
  {
    const q = (await issue()).quoteId;
    await succeeds('P3-C', () => checkout({ cartItems: CART, deliveryQuoteId: q, fulfillmentType: 'delivery' }),
      'CONTROL — the identical payload WITHOUT a pricing field is accepted (the guard does not refuse everybody)');
  }
  for (const f of dqa.CLIENT_FORBIDDEN_FIELDS) {
    const t = TRIP(); t[f] = 1;
    await refuses('P3q-' + f, () => quiet(() => idx.requestDeliveryQuote.run(REQ(BUYER, t))),
      new RegExp(f), 'quote request carrying ' + f);
  }

  /* ── 4. A FORGED QUOTE ID ────────────────────────────────────────────────────────────────── */
  section('4  FORGED / REPLAYED QUOTE IDS');
  await refuses('K4-1', () => checkout({ cartItems: CART, deliveryQuoteId: 'dq_forged_0000', fulfillmentType: 'delivery' }),
    /not_found/, 'an id that was never issued');
  await refuses('K4-2', () => checkout({ cartItems: CART, fulfillmentType: 'delivery' }),
    /quoteId is required/i, 'no quote id at all on a delivery order');
  await refuses('K4-3', () => checkout({ cartItems: CART, deliveryQuoteId: 12345, fulfillmentType: 'delivery' }),
    /quoteId is required/i, 'a non-string quote id');
  {
    const qOther = (await issue(OTHER)).quoteId;
    await refuses('K4-4', () => checkout({ cartItems: CART, deliveryQuoteId: qOther, fulfillmentType: 'delivery' }, BUYER),
      /not_yours/, 'another account\'s quote replayed by this buyer');
  }
  {
    const q = (await issue()).quoteId;
    STORE._patch('deliveryQuotes', q, { status: 'consumed' });
    await refuses('K4-5', () => checkout({ cartItems: CART, deliveryQuoteId: q, fulfillmentType: 'delivery' }),
      /already_used/, 'a quote that is no longer in the issued state');
  }
  {
    const q = (await issue()).quoteId;
    STORE._patch('deliveryQuotes', q, { expiresAtMs: Date.now() - 1000 });
    await refuses('K4-6', () => checkout({ cartItems: CART, deliveryQuoteId: q, fulfillmentType: 'delivery' }),
      /expired/, 'an expired quote (TTL ' + (dqEndpoint.QUOTE_TTL_MS / 60000) + ' min)');
  }
  {
    const q = (await issue()).quoteId;
    await succeeds('K4-C', () => checkout({ cartItems: CART, deliveryQuoteId: q, fulfillmentType: 'delivery' }),
      'CONTROL — a fresh, owned, unexpired quote is accepted');
  }

  /* ── 5. VERSION AND POLICY DRIFT ─────────────────────────────────────────────────────────── */
  section('5  STALE VERSION / DRIFTED POLICY — refused at checkout exactly as at settlement');
  {
    const q = (await issue()).quoteId;
    STORE._patch('deliveryQuotes', q, { pricingVersion: 'dq-0.9.0' });
    await refuses('V5-1', () => checkout({ cartItems: CART, deliveryQuoteId: q, fulfillmentType: 'delivery' }),
      /pricing_version_stale/, 'a quote pinned to a superseded pricingVersion');
  }
  {
    const q = (await issue()).quoteId;
    STORE._patch('platformConfig', 'deliveryPricing', { policyVersion: 'v2' });
    await refuses('V5-2', () => checkout({ cartItems: CART, deliveryQuoteId: q, fulfillmentType: 'delivery' }),
      /policy_changed/, 'the commercial policy was revised after the quote was issued');
    STORE._patch('platformConfig', 'deliveryPricing', { policyVersion: 'v1' });
  }
  {
    const q = (await issue()).quoteId;
    STORE._patch('platformConfig', 'deliveryPricing', { effectiveFrom: new Date(Date.now() + 86400000).toISOString() });
    await refuses('V5-3', () => checkout({ cartItems: CART, deliveryQuoteId: q, fulfillmentType: 'delivery' }),
      /pricing_unavailable/, 'a policy whose approved start date has not arrived');
    await refuses('V5-4', () => issue(), /not available/i, 'and issuing refuses on the same policy — both ends agree');
    STORE._patch('platformConfig', 'deliveryPricing', { effectiveFrom: POLICY_IN_FORCE.effectiveFrom });
  }
  {
    const q = (await issue()).quoteId;
    const saved = STORE._get('platformConfig', 'deliveryPricing');
    STORE._del('platformConfig', 'deliveryPricing');
    await refuses('V5-5', () => checkout({ cartItems: CART, deliveryQuoteId: q, fulfillmentType: 'delivery' }),
      /pricing_unavailable/, 'no policy at all — no price, rather than a default price');
    STORE._put('platformConfig', 'deliveryPricing', saved);
  }
  {
    const q = (await issue()).quoteId;
    await succeeds('V5-C', () => checkout({ cartItems: CART, deliveryQuoteId: q, fulfillmentType: 'delivery' }),
      'CONTROL — with the approved policy restored, checkout works again');
  }

  /* ── 6. VEHICLE SUITABILITY ──────────────────────────────────────────────────────────────── */
  section('6  VEHICLE — the caller may request a class; it is never simply honoured');
  check('W6-0', !/vehicleType\s*:/.test((CHECKOUT.match(/_requestServerDeliveryQuote\s*\(\s*\{[\s\S]*?\n\s*\}\s*\)/) || [''])[0]),
    'the browser sends NO vehicleType — it describes the shipment and lets the authority choose');
  await refuses('W6-1', () => issue(BUYER, { vehicleType: 'moto', shipment: { totalWeightKg: 300, packageCount: 1 } }),
    /too_small/, '300 kg requested on a motorcycle');
  await refuses('W6-2', () => issue(BUYER, { vehicleType: 'van', shipment: { totalWeightKg: 1, packageCount: 1 } }),
    /oversized/, 'a 1 kg parcel requested on a van (van economics on a letter)');
  {
    /* An uneconomised class is NOT refused — it is not honoured. The authority substitutes the
       smallest class it can actually price. What matters for the money is that no quote is ever
       issued against a class with no approved economics, so a caller cannot reach zero-energy
       figures by naming the one class SOKONI deliberately left unpriced. */
    const got = (await succeeds('W6-3', () => issue(BUYER, { vehicleType: 'bicycle', shipment: { totalWeightKg: 2, packageCount: 1 } }),
      'requesting bicycle — the class SOKONI left unpriced — does not fail the buyer')).value;
    const priced = Object.keys(APPROVED.economics.vehicleClasses);
    check('W6-3b', !!got && got.vehicleClass !== 'bicycle' && priced.indexOf(got.vehicleClass) >= 0,
      '…and is NOT honoured: priced as ' + (got && got.vehicleClass) + ', a class with approved economics — bicycle economics are unreachable');
  }
  await refuses('W6-4', () => issue(BUYER, { vehicleType: 'spaceship' }), /vehicle/, 'an unknown vehicle class');
  await refuses('W6-5', () => issue(BUYER, { shipment: { totalWeightKg: 9000, packageCount: 1 } }),
    /exceeds_all_capacities/, 'a load larger than the whole fleet');
  await refuses('W6-6', () => issue(BUYER, { vehicleType: undefined, shipment: { packageCount: 1 } }),
    /insufficient_data/, 'a shipment with no weight — refusal rather than a guess');
  await refuses('W6-7', () => issue(BUYER, { shipment: { totalWeightKg: 2, packageCount: 1, hazardous: true } }),
    /hazardous/, 'hazardous goods');
  for (const kg of [2, 12, 40, 120, 600]) {
    const want = smallestPricedClassFor(kg);
    const got = (await succeeds('W6-8@' + kg, () => issue(BUYER, { shipment: { totalWeightKg: kg, packageCount: 1 } }),
      kg + ' kg is quoted with no requested class')).value;
    check('W6-9@' + kg, !!got && got.vehicleClass === want && !!got.vehicleSelectionReason,
      kg + ' kg → ' + (got && got.vehicleClass) + ' (smallest PRICED class that fits, independently computed: ' + want + ')');
  }
  {
    /* Checkout has no vehicle input at all: the class travels on the stored quote. */
    const q = (await issue()).quoteId;
    const cls = STORE._get('deliveryQuotes', q).vehicleClass;
    const s = (await succeeds('W6-10', () => checkout({ cartItems: CART, deliveryQuoteId: q, fulfillmentType: 'delivery', vehicleType: 'truck' }),
      'a checkout payload asserting vehicleType: truck is accepted as noise')).value;
    const expect = Math.round(STORE._get('deliveryQuotes', q).customerChargeMinor / 100);
    check('W6-11', !!s && s.serverTotal === UNIT_PRICE + expect && cls !== 'truck',
      '…and changes NOTHING: the charge is still the ' + cls + ' quote (' + expect + '), because checkout never reads a vehicle');
  }

  /* ── 7. THE BROWSER LAYER ────────────────────────────────────────────────────────────────── */
  section('7  BROWSER — the client pricing engine and its fallback are gone from the money path');
  check('B7-1', D.clientPricerCalled(CHECKOUT) === false, 'SokoniDeliveryPricing.calculate() is not called');
  check('B7-2', D.clientPricerScript(CHECKOUT) === false, 'the sokoni-delivery-pricing.js script tag is gone');
  check('B7-3', D.fallbackFormula(CHECKOUT) === false, 'the KES 80 + 15/km fallback formula is gone');
  check('B7-4', D.feeSentToServer(CHECKOUT) === false, 'the createCheckoutSession payload carries NO deliveryFee');
  check('B7-5', D.quoteIdSentToServer(CHECKOUT) === true, 'the payload carries deliveryQuoteId instead');
  check('B7-6a', D.serverQuoteHelperDefined(CHECKOUT) === true, 'the page defines a helper that wraps the requestDeliveryQuote callable');
  check('B7-6b', D.serverQuoteCalledFromCalc(CHECKOUT) === true, '…calcDelivery() actually CALLS that helper (reachability, not existence)');
  check('B7-6c', D.calcDeliveryWired(CHECKOUT) === true, '…and the delivery inputs actually call calcDelivery()');
  {
    const rhs = D.feeAssignments(CHECKOUT);
    const allowed = rhs.filter((r) => /^0$/.test(r) || /^quote\.customerChargeKES$/.test(r));
    check('B7-7', rhs.length > 0 && allowed.length === rhs.length,
      'every assignment to deliveryFee is either 0 or the server quote — ' + JSON.stringify(rhs));
  }
  check('B7-8', /80\s*\+\s*zone\.distanceKm\s*\*\s*15/.test(CHECKOUT_RAW) && !D.fallbackFormula(CHECKOUT),
    'CONTROL — the formula survives in the RAW file only as commentary; stripping is what makes B7-3 meaningful');

  /* ── 8. THE SERVER SOURCE — no second way in ─────────────────────────────────────────────── */
  section('8  SERVER SOURCE — createCheckoutSession has no other route to a delivery fee');
  const HANDLER = (() => {
    const start = INDEX.indexOf('exports.createCheckoutSession');
    if (start < 0) return null;
    const end = INDEX.indexOf('exports.verifyIntasendPayment', start);
    return end > start ? INDEX.slice(start, end) : null;
  })();
  if (!HANDLER) { blocked('S8', 'could not isolate the createCheckoutSession body from index.js'); }
  else {
    check('S8-1', /const\s*\{[^}]*\}\s*=\s*request\.data/.test(HANDLER)
      && !/const\s*\{[^}]*\bdeliveryFee\b[^}]*\}\s*=\s*request\.data/.test(HANDLER),
      'deliveryFee is no longer destructured from request.data');
    check('S8-2', /const\s*\{[^}]*\bdeliveryQuoteId\b[^}]*\}\s*=\s*request\.data/.test(HANDLER),
      'deliveryQuoteId is');
    const assigns = (HANDLER.match(/safeDeliveryFee\s*=\s*[^;\n]+/g) || []).map((s) => s.split('=').slice(1).join('=').trim());
    const fromQuote = assigns.filter((a) => /_deliveryQuote\.customerChargeMinor/.test(a));
    const zeroed = assigns.filter((a) => /^0$/.test(a));
    check('S8-3', assigns.length > 0 && fromQuote.length === 1 && (zeroed.length + fromQuote.length) === assigns.length,
      'every assignment to safeDeliveryFee is either the literal 0 or the resolved quote — ' + JSON.stringify(assigns));
    check('S8-4', !/Math\.min\s*\(\s*5000/.test(HANDLER),
      'the old clamp(0…5000) — which bounded how wrong the browser could be, not whether it was authoritative — is gone');
    check('S8-5', HANDLER.indexOf('assertNoCheckoutPricing') < HANDLER.indexOf('cartItems must be a non-empty array'),
      'the pricing-field refusal runs before any other validation, so a forged fee cannot hide behind a second error');
    check('S8-6', /resolveQuoteForCheckout/.test(HANDLER), 'the handler resolves the stored quote');
  }

  /* ── 9. THE UNDER-CHARGE TOLERANCE ───────────────────────────────────────────────────────── */
  section('9  UNDER-CHARGE TOLERANCE — preserved, not replaced by a symmetric equality check');
  const guardCond = (() => {
    const ms = CHECKOUT.match(/if\s*\(\s*([^()]*_quoted[^()]*)\)\s*\{/g) || [];
    if (ms.length !== 1) return null;
    return ms[0].match(/if\s*\(\s*([^()]*_quoted[^()]*)\)\s*\{/)[1].trim();
  })();
  if (!guardCond) { blocked('U9', 'could not isolate exactly one _quoted guard in checkout.html'); }
  else {
    ok('U9-0', 'the live guard condition is: ' + guardCond);
    const stops = evalGuard(guardCond);
    if (!stops) blocked('U9', 'the guard condition could not be evaluated');
    else {
      check('U9-1', stops(1000, 900) === true, 'server charges MORE than quoted (1000 vs 900) → STOP and re-consent');
      check('U9-2', stops(900, 1000) === false, 'server charges LESS than quoted (900 vs 1000) → PROCEED — this is the tolerance');
      check('U9-3', stops(1000, 1000) === false, 'equal totals → proceed');
      check('U9-4', stops(1001, 1000) === false, 'one shilling more (rounding) → proceed, within tolerance');
      check('U9-5', stops(1002, 1000) === true, 'two shillings more → stop');
      check('U9-6', stops(500, 1000) === false, 'a large under-charge (promo, platform fee, Impact) → proceeds; a "totals must match" check would have broken this');
    }
  }

  /* ── 10. SABOTAGE — per guard, in process ────────────────────────────────────────────────── */
  section('10  SABOTAGE — neutralise each guard and prove the corresponding test goes RED');

  await sabotageServer('X10-1', 'assertNoCheckoutPricing (checkout refuses client pricing fields)',
    () => {
      const orig = dqEndpoint.assertNoCheckoutPricing;
      dqEndpoint.assertNoCheckoutPricing = () => {};
      return () => { dqEndpoint.assertNoCheckoutPricing = orig; };
    },
    async () => {
      const q = (await issue()).quoteId;
      return checkout({ cartItems: CART, deliveryQuoteId: q, fulfillmentType: 'delivery', deliveryFee: 5 });
    });

  await sabotageServer('X10-2', 'resolveQuoteForCheckout (forged quote ids are refused)',
    () => {
      const orig = dqEndpoint.resolveQuoteForCheckout;
      dqEndpoint.resolveQuoteForCheckout = async () => ({ quoteId: 'x', pricingVersion: dqa.PRICING_VERSION, customerChargeMinor: 100 });
      return () => { dqEndpoint.resolveQuoteForCheckout = orig; };
    },
    () => checkout({ cartItems: CART, deliveryQuoteId: 'dq_forged_0000', fulfillmentType: 'delivery' }));

  await sabotageServer('X10-3', 'assertSettleable (a tampered stored quote cannot be charged)',
    () => {
      const orig = dqa.assertSettleable;
      dqa.assertSettleable = () => ({ minorUnits: 0 });
      return () => { dqa.assertSettleable = orig; };
    },
    async () => {
      const q = (await issue()).quoteId;
      STORE._patch('deliveryQuotes', q, { customerChargeMinor: STORE._get('deliveryQuotes', q).customerChargeMinor + 50000 });
      return checkout({ cartItems: CART, deliveryQuoteId: q, fulfillmentType: 'delivery' });
    });

  await sabotageServer('X10-4', 'assertVehicleSuitable (a forged vehicle choice is validated)',
    () => {
      const orig = vsa.assertVehicleSuitable;
      vsa.assertVehicleSuitable = (requested, shipment) => ({
        vehicleClass: 'motorcycle', vehicleSelectionReason: 'sabotage', capacityBasis: 'sabotage',
        shipment: { packageCount: 1, pickupCount: 1, fragile: false },
      });
      return () => { vsa.assertVehicleSuitable = orig; };
    },
    () => issue(BUYER, { vehicleType: 'moto', shipment: { totalWeightKg: 300, packageCount: 1 } }));

  /* Browser guards cannot be executed here, so they are sabotaged as text and run back through
     the same detector functions the live assertions used. */
  sabotageText('X10-5', 're-adding deliveryFee to the checkout payload',
    CHECKOUT.replace(/deliveryQuoteId:\s*_deliveryQuoteId \|\| undefined,/, 'deliveryFee: deliveryFee,'),
    (s) => D.feeSentToServer(s) === true, 'detector B7-4 must flag it');
  sabotageText('X10-6', 're-adding the 80 + 15/km fallback',
    CHECKOUT.replace('deliveryFee = 0;', 'deliveryFee = Math.round(80 + zone.distanceKm * 15);'),
    (s) => D.fallbackFormula(s) === true, 'detector B7-3 must flag it');
  sabotageText('X10-7', 'restoring the client pricing engine call inside calcDelivery',
    CHECKOUT.replace(/const quote = await _requestServerDeliveryQuote\(/, 'const quote = SokoniDeliveryPricing.calculate('),
    (s) => D.clientPricerCalled(s) === true && D.serverQuoteCalledFromCalc(s) === false,
    'B7-1 flags the client engine AND B7-6b sees the server call is no longer reached — note that a '
    + 'mere existence check would still have read green, because the helper is left in the file');
  sabotageText('X10-8', 'dropping deliveryQuoteId from the payload',
    CHECKOUT.replace(/deliveryQuoteId:\s*_deliveryQuoteId \|\| undefined,/, ''),
    (s) => D.quoteIdSentToServer(s) === false, 'detector B7-5 must flag it');
  sabotageText('X10-10', 're-asserting a browser-chosen vehicleType in the quote request',
    CHECKOUT.replace('estimatedMinutes: zone.durationMin,', "estimatedMinutes: zone.durationMin,\n      vehicleType: 'moto',"),
    (s) => /vehicleType\s*:/.test((s.match(/_requestServerDeliveryQuote\s*\(\s*\{[\s\S]*?\n\s*\}\s*\)/) || [''])[0]),
    'detector W6-0 must flag it');
  {
    const sabotaged = CHECKOUT.replace('stkAmount > _quoted + 1', 'stkAmount !== _quoted');
    const ms = sabotaged.match(/if\s*\(\s*([^()]*_quoted[^()]*)\)\s*\{/);
    const f = ms ? evalGuard(ms[1].trim()) : null;
    check('X10-9', !!f && f(900, 1000) === true,
      'SABOTAGE — replacing the guard with a symmetric equality check makes the legitimate under-charge STOP; assertion U9-2 goes red');
  }

  /* Nothing was left neutralised. */
  {
    const q = (await issue()).quoteId;
    await refuses('X10-R', () => checkout({ cartItems: CART, deliveryQuoteId: q, fulfillmentType: 'delivery', deliveryFee: 5 }),
      /deliveryFee/, 'POST-SABOTAGE — every guard is restored and refuses again');
  }

  /* ── 11. RESIDUALS — found, proven, NOT fixed (outside the authorised Gate C scope) ───────── */
  section('11  RESIDUALS — proven, reported, deliberately NOT changed under this gate');
  {
    const hubCreatesFee = /SokoniDelivery\.createOrderDelivery/.test(CHECKOUT)
      && /deliveryFee:\s*result\.deliveryFee/.test(CHECKOUT);
    if (hubCreatesFee) {
      RESIDUALS.push(
        'checkout.html still calls SokoniDelivery.createOrderDelivery() AFTER payment and patches '
        + 'orders/{id}.deliveryFee with delivery-hub.js\'s own browser-computed figure (DRIVER_SHARE 0.88). '
        + 'It does NOT affect what the buyer is charged — that is now the server quote — but the order '
        + 'record and the created delivery carry a non-authoritative fee, and the delivery is created '
        + 'with NO pinned deliveryQuote, so dispatch settlement refuses it (fail-closed, not mispaid). '
        + 'Binding the created delivery to the quote is its own gate.');
      console.log('  ○ RES-1  the post-payment delivery-hub rail still writes its own deliveryFee (see summary)');
    } else {
      ok('RES-1', 'no post-payment client-priced delivery fee reaches the order record');
    }
  }

  return finish();
}

/* ── helpers ───────────────────────────────────────────────────────────────────────────────── */
function evalGuard(cond) {
  try { return new Function('stkAmount', '_quoted', 'return (' + cond + ');'); }
  catch (_) { return null; }
}

/* Neutralise a guard on the LIVE call path, re-run the hostile input, and require it to be
   accepted. If it is still refused, the guard was not what was doing the work — either the test
   passed for another reason, or a second layer is hiding it. Either way the sabotage is reported
   with the reason, never quietly passed. */
async function sabotageServer(id, what, patch, probe) {
  const restore = patch();
  let accepted = false, reason = '';
  try { const r = await probe(); accepted = true; reason = 'accepted (serverTotal=' + (r && r.serverTotal) + ')'; }
  catch (e) { accepted = false; reason = (e && (e.message || e.reason)) || String(e); }
  finally { restore(); }
  if (accepted) ok(id, 'removing ' + what + ' lets the hostile input through — the guard is load-bearing');
  else bad(id, 'removing ' + what + ' changed NOTHING — the guard may be decorative, or another layer is hiding it', 'still refused with: ' + reason);
}

function sabotageText(id, what, sabotagedSource, detector, expectation) {
  let flagged = false;
  try { flagged = detector(sabotagedSource) === true; } catch (e) { return bad(id, what + ' — detector CRASHED', e.message); }
  if (flagged) ok(id, 'SABOTAGE ' + what + ' → detected (' + expectation + ')');
  else bad(id, 'SABOTAGE ' + what + ' → NOT detected — ' + expectation);
}

function finish() {
  section('SUMMARY');
  console.log('  passed  : ' + PASS);
  console.log('  failed  : ' + FAIL);
  console.log('  blocked : ' + BLOCKED);
  if (RESIDUALS.length) {
    console.log('\n  RESIDUALS (proven, NOT fixed under this gate):');
    RESIDUALS.forEach((r, i) => console.log('   ' + (i + 1) + '. ' + r.replace(/(.{96})\s/g, '$1\n      ')));
  }
  if (FAILURES.length) {
    console.log('\n  FAILURES:');
    FAILURES.forEach((f) => console.log('   • ' + f));
  }
  const green = FAIL === 0 && BLOCKED === 0;
  console.log('\n  ' + (green ? '✅ GATE C: GREEN' : '❌ GATE C: NOT GREEN') + '  (blocked counts as not-green; a hang exits 2)');
  console.log('  Certification only. Nothing here deploys anything.\n');
  clearTimeout(WATCHDOG);
  process.exit(green ? 0 : 1);
}

main().catch((e) => {
  console.log('\n  ✖ SUITE CRASHED — a crash is not a pass.');
  console.log('    ' + (e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n    ') : String(e)));
  clearTimeout(WATCHDOG);
  process.exit(2);
});
