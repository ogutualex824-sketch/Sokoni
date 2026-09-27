#!/usr/bin/env node
/* ============================================================================
   MERCHANT LAUNCH GATE
   ============================================================================
   One question: can a real person go from stranger to selling, without an
   operator repairing their account by hand?

       browser -> find SOKONI -> account -> apply -> legal acceptance
       -> admin approval -> business -> store -> storefront -> dashboard
       -> free product allowance -> POS/Till -> test receipt
       -> customer buys -> IntaSend -> shop wallet

   THREE VERDICTS, NEVER TWO
     PASS        proven here, by execution or by reading the shipped source
     FAIL        proven broken here
     UNVERIFIED  this harness cannot decide it — and says what would

   UNVERIFIED IS NOT PASS. A launch gate that reports "could not check" as green
   is worse than no gate: it converts an unknown into a false assurance at the
   exact moment someone is deciding whether to put merchants in front of it.
   Every UNVERIFIED line carries the evidence that would settle it.

   Usage:
     node scripts/merchant-launch-gate.js           structural + behavioural
     node scripts/merchant-launch-gate.js --live    also probe production over HTTP
   ========================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const Module = require('module');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const LIVE = process.argv.includes('--live');

const R = [];
const add = (area, check, status, detail) => R.push({ area, check, status, detail: detail || '' });
const PASS = (a, c, d) => add(a, c, 'PASS', d);
const FAIL = (a, c, d) => add(a, c, 'FAIL', d);
const UNV  = (a, c, d) => add(a, c, 'UNVERIFIED', d);
const verdict = (a, c, ok, okD, badD) => (ok ? PASS(a, c, okD) : FAIL(a, c, badD));

const read = (p) => { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (_) { return null; } };
const exists = (p) => fs.existsSync(path.join(ROOT, p));

/* ── live HTTP, only with --live ─────────────────────────────────────────── */
function getLive(urlPath) {
  return new Promise((resolve) => {
    const u = 'https://mysokoni.co.ke' + urlPath + (urlPath.includes('?') ? '&' : '?') + 'cb=' + Date.now();
    const req = https.get(u, { timeout: 15000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body, location: res.headers.location }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
  });
}

/* ── load the server modules once, with the CF runtime stubbed ───────────── */
const DOCS = new Map();
const FieldValue = {
  serverTimestamp: () => 'TS', increment: (n) => ({ __inc: n }),
  delete: () => ({ __del: true }), arrayUnion: (...v) => ({ __au: v }),
};
class HttpsError extends Error { constructor(c, m, d) { super(m); this.code = c; this.details = d; } }

function mkDb(store) {
  const mk = (name, filters) => ({
    doc(id) {
      const key = name + '/' + id;
      return {
        _key: key, id,
        async get() { const d = store.get(key); return { exists: !!d, id, data: () => (d ? Object.assign({}, d) : undefined) }; },
        async set(v) { store.set(key, Object.assign({}, store.get(key) || {}, v)); },
        async create(v) { if (store.has(key)) { const e = new Error('EXISTS'); e.code = 6; throw e; } store.set(key, Object.assign({}, v)); },
        async update(v) { store.set(key, Object.assign({}, store.get(key) || {}, v)); },
      };
    },
    where(f, _o, v) { return mk(name, filters.concat([[f, v]])); },
    orderBy() { return this; }, limit() { return this; },
    async get() {
      const rows = [];
      for (const [k, v] of store.entries()) {
        if (k.indexOf(name + '/') !== 0) continue;
        if (filters.every(([f, val]) => v[f] === val)) rows.push({ id: k.slice(name.length + 1), data: () => v });
      }
      return { docs: rows, empty: rows.length === 0, forEach(cb) { rows.forEach(cb); } };
    },
  });
  return {
    collection: (n) => mk(n, []),
    batch() { const w = []; return { set: (r, v) => w.push([r._key, v]), update: (r, v) => w.push([r._key, v]),
      async commit() { for (const [k, v] of w) store.set(k, Object.assign({}, store.get(k) || {}, v)); } }; },
    async runTransaction(fn) {
      const w = [];
      const t = { async get(r) { return r.get(); }, set: (r, v) => w.push([r._key, v]),
                  update: (r, v) => w.push([r._key, v]), create: (r, v) => w.push([r._key, v]) };
      const out = await fn(t);
      for (const [k, v] of w) store.set(k, Object.assign({}, store.get(k) || {}, v));
      return out;
    },
  };
}
const DB = mkDb(DOCS);

const MODS = {};
{
  const orig = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === 'firebase-admin/firestore') return { getFirestore: () => DB, FieldValue, Timestamp: { now: () => ({ toMillis: () => Date.now() }) } };
    if (id === 'firebase-admin') return { apps: [1], initializeApp: () => {}, auth: () => ({ setCustomUserClaims: async () => {}, getUser: async () => ({ customClaims: {} }) }), firestore: Object.assign(() => DB, { FieldValue, Timestamp: { now: () => ({ toMillis: () => Date.now() }) } }) };
    if (id === 'firebase-admin/auth') return { getAuth: () => ({ setCustomUserClaims: async () => {}, getUser: async () => ({ customClaims: {} }) }) };
    if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => h, HttpsError };
    if (id === 'firebase-functions/v2/scheduler') return { onSchedule: (_o, h) => h };
    if (id === 'firebase-functions/v2/firestore') return { onDocumentWritten: (_o, h) => h, onDocumentCreated: (_o, h) => h, onDocumentUpdated: (_o, h) => h };
    if (id === 'firebase-functions/logger') return { info() {}, warn() {}, error() {}, debug() {} };
    if (id === 'firebase-functions/params') return { defineSecret: (n) => ({ name: n, value: () => 'x' }) };
    if (id === './pos-audit') return { writeAudit: () => {} };
    if (id === './notify' || id === './search-terms') return { notify: async () => {}, buildSearchTerms: () => [], searchTerms: () => [] };
    return orig.apply(this, arguments);
  };
  const tryLoad = (name, rel) => { try { MODS[name] = require(path.join(FN, rel)); } catch (e) { MODS[name] = { __err: e.message }; } };
  tryLoad('identity', 'merchant-identity.js');
  tryLoad('zf', 'pos-zero-friction.js');
  tryLoad('retail', 'pos-retail-engine.js');
  tryLoad('rail', 'pos-commission-rail.js');
  tryLoad('bwallet', 'business-wallet.js');
  tryLoad('shopEmp', 'shop-employees.js');
  tryLoad('subBilling', 'sub-billing.js');
  tryLoad('commission', 'commission-config.js');
  tryLoad('settleEngine', 'settlement-engine.js');
  tryLoad('orderSettle', 'order-settlement.js');
  Module.prototype.require = orig;
}

(async () => {

/* ══════════════════════════════════════════════════════════════════════════
   1 · DISCOVERY — can a merchant find and reach SOKONI at all?
   ══════════════════════════════════════════════════════════════════════════ */
const A1 = 'DISCOVERY';
if (!LIVE) {
  UNV(A1, 'mysokoni.co.ke serves the site', 're-run with --live to probe production over HTTP');
  UNV(A1, 'the seller intake page is reachable', 're-run with --live');
  UNV(A1, 'the application module is served (not 404)', 're-run with --live');
  UNV(A1, 'SOKONI is findable by search', 'search ranking is outside any harness — check manually');
} else {
  const home = await getLive('/');
  verdict(A1, 'mysokoni.co.ke serves the site', home.status === 200,
    'HTTP ' + home.status, 'HTTP ' + home.status + ' — merchants cannot reach the site');

  for (const [label, p] of [['sign-in', '/login'], ['seller intake', '/offer'],
                            ['onboarding wizard', '/onboarding-seller'], ['merchant hub', '/merchant-v2']]) {
    const r = await getLive(p);
    verdict(A1, 'the ' + label + ' page loads (' + p + ')', r.status === 200 || r.status === 301,
      'HTTP ' + r.status, 'HTTP ' + r.status);
  }

  /* This one 404'd in production on 2026-09-07 — the module the intake needs to file an
     application at all. Its absence is silent: the wizard reports "not submitted". */
  const mod = await getLive('/sokoni-merchant-application.js');
  verdict(A1, 'sokoni-merchant-application.js is SERVED', mod.status === 200,
    'HTTP 200', 'HTTP ' + mod.status + ' — no merchant can file an application');

  UNV(A1, 'SOKONI is findable by search', 'search ranking is outside any harness — check manually');
}

/* ══════════════════════════════════════════════════════════════════════════
   2 · APPLICATION — account, application, legal acceptance, admin decision
   ══════════════════════════════════════════════════════════════════════════ */
const A2 = 'APPLICATION';
{
  const MA = (() => { try { return require(path.join(ROOT, 'sokoni-merchant-application.js')); } catch (_) { return null; } })();
  verdict(A2, 'the application primitive exists', !!MA, 'sokoni-merchant-application.js', 'module missing');

  if (MA) {
    /* Behavioural: the document a real submission would produce. */
    const noAck = MA.buildDocument({ uid: 'U1', profile: { name: 'X' }, nowISO: 'N' });
    verdict(A2, 'legal acceptance is REQUIRED to submit', noAck.action === 'refused' && noAck.reason === 'agreement_required',
      'refused without acceptance', 'an application can be filed without accepting the terms');

    const ack = MA.buildDocument({ uid: 'U1', profile: { name: 'X' }, nowISO: 'N', agreementAccepted: true });
    verdict(A2, 'an accepted submission records what was agreed, and its version',
      ack.data && ack.data.agreementAccepted === true && !!ack.data.agreementVersion,
      ack.data && ack.data.agreementVersion, 'acceptance is not recorded');

    verdict(A2, 'submission grants nothing (no role, no shop, no claim)',
      ack.data && !('role' in ack.data) && !('approved' in ack.data),
      'request only', 'the submission carries authority fields');
  }

  /* The intake page must actually be able to call it — this was the orphaned-adapter bug. */
  const wiz = read('onboarding-seller.html');
  if (wiz) {
    const m = wiz.match(/SokoniMerchantApplication\s*\.\s*submit\s*\(\s*\{[\s\S]{0,900}?\}\s*\)/);
    verdict(A2, 'the intake page passes what submit() requires (fs adapter)',
      !!m && /(^|[\s,{])fs\s*:/.test(m[0]),
      'adapter passed', 'submit() throws — every submission fails with "not submitted"');
    verdict(A2, 'the intake page collects legal acceptance',
      /id="wizAgree"/.test(wiz) && /agreementAccepted\s*:/.test(wiz),
      'checkbox + passed through', 'no acceptance is collected');
  } else { FAIL(A2, 'the seller intake page exists', 'onboarding-seller.html missing'); }

  /* AdminOS must be able to SEE and DECIDE applications. */
  const aos = read('sokoni-aos.js'); const aosHtml = read('admin-os.html');
  verdict(A2, 'AdminOS has an Applications surface',
    !!aosHtml && /id="panel-applications"/.test(aosHtml) && !!aos && /applicationList/.test(aos),
    'panel + canonical read', 'an operator in AdminOS cannot see applications');
  verdict(A2, 'AdminOS decides through the server authority (applicationDecide)',
    !!aos && /applicationDecide/.test(aos), 'server-authoritative', 'decision is not server-side');

  const lifeSrc = read('functions/application-lifecycle.js');
  verdict(A2, 'ONLY an admin can approve', !!lifeSrc && /_requireAdmin\(req\)/.test(lifeSrc),
    '_requireAdmin on applicationDecide', 'approval is not admin-gated');
  verdict(A2, 'approval is refused without legal acceptance',
    !!lifeSrc && /agreementAccepted !== true/.test(lifeSrc),
    'failed-precondition without acceptance', 'a merchant can be approved onto unseen terms');
}

/* ══════════════════════════════════════════════════════════════════════════
   3 · PROVISIONING — approval must ESTABLISH the chain, not just flip a status
   ══════════════════════════════════════════════════════════════════════════ */
const A3 = 'PROVISIONING';
{
  const life = read('functions/application-lifecycle.js') || '';
  const chain = [
    ['business record', /collection\('businesses'\)/],
    ['store / shop',    /collection\('shops'\)/],
    ['seller registry (storefront)', /collection\('sellers'\)/],
    ['merchant permissions (role + claim)', /grantAccountRole/],
    ['active shop on the account', /activeShopId/],
    ['POS / Till', /mintSokoniTillCore/],
    ['business wallet', /ensureBusinessWallet/],
  ];
  for (const [what, re] of chain) {
    verdict(A3, 'approval provisions the ' + what, re.test(life),
      'written by projectSeller', 'NOT provisioned — an operator must repair this by hand');
  }

  /* Business != Store != UID must survive. */
  verdict(A3, 'Business / Store / UID stay distinct identities',
    /shopId = declared \|\| String\(uid\)/.test(life) && /shopIdSource/.test(life),
    'shopId recorded with its provenance', 'the identity model is being shortcut');

  /* The merchant must land on merchant-v2, not the legacy shell. */
  const entry = read('sokoni-merchant-entry.js') || '';
  const mUrl = (entry.match(/var MERCHANT_URL\s*=\s*'([^']+)'/) || [])[1];
  verdict(A3, 'an approved merchant lands in merchant-v2', mUrl === '/merchant-v2',
    mUrl, 'routes to ' + mUrl + ' — the legacy shell');

  /* Suspension must retract, or a suspended merchant stays discoverable. */
  verdict(A3, 'suspension retracts the storefront and the directory',
    /status: 'suspended'[\s\S]{0,400}?bizRef/.test(life) || /bizRef\.set\(\{ status: 'suspended'/.test(life),
    'shop + seller + directory retracted', 'a suspended merchant stays live somewhere');
}

/* ══════════════════════════════════════════════════════════════════════════
   4 · FREE BETA ALLOWANCE — 100 products, with nothing blocking them
   ══════════════════════════════════════════════════════════════════════════ */
const A4 = 'FREE BETA';
{
  /* THE AUTHORITY IS subscription-catalog.js, not sub-billing.js. An earlier version of this
     gate read sub-billing's `listings_limit` — which happens to agree today, and would have
     reported a stale number the moment it did not. scripts/verify-listing-limit-single-source.js
     names the catalogue as the one source; read that. */
  const catSrc = read('functions/subscription-catalog.js');
  let freeLimit = null;
  if (catSrc) {
    const m = catSrc.match(/FREE:\s*Object\.freeze\(\{[\s\S]{0,400}?listingLimit:\s*(-?\d+)/);
    if (m) freeLimit = Number(m[1]);
  }
  if (freeLimit === null) {
    UNV(A4, 'the free plan grants 100 product slots',
      'could not read FREE.listingLimit from functions/subscription-catalog.js');
  } else {
    verdict(A4, 'the free plan grants 100 product slots', freeLimit === 100 || freeLimit === -1,
      'subscription-catalog FREE.listingLimit=' + freeLimit,
      'subscription-catalog FREE.listingLimit=' + freeLimit + ' — the launch requirement is 100. ' +
      'One value, in the single source; product-limit.js propagates it to productCounters.');
  }

  /* The enforced limit must be FED from that authority, or the advertised allowance and the
     enforced one are unrelated numbers. Detected by reading the filesystem — an earlier
     version shelled out to `git grep ... || true`, which fails on Windows and returned empty,
     manufacturing a blocker out of its own failure. */
  const rules = read('firestore.rules') || '';
  const rulesUsesCounter = /withinProductLimit/.test(rules) && /productCounters/.test(rules);
  const writers = fs.readdirSync(FN)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => { const s = read('functions/' + f); return s && /maxProducts/.test(s); });
  if (rulesUsesCounter) {
    const fedFromCatalog = writers.some((f) => {
      const s = read('functions/' + f) || '';
      return /maxProducts/.test(s) && /(subscription-catalog|entitlementFor|listingLimit)/.test(s);
    });
    verdict(A4, 'the enforced limit is fed from the plan authority',
      writers.length > 0 && fedFromCatalog,
      'productCounters.maxProducts written by: ' + writers.join(', ') + ' (from the catalogue)',
      writers.length === 0
        ? 'rules enforce productCounters.maxProducts and nothing writes it'
        : 'written by ' + writers.join(', ') + ' but not from the catalogue — two unrelated numbers');
  } else {
    UNV(A4, 'the enforced product limit', 'withinProductLimit not found in firestore.rules');
  }

  verdict(A4, 'product creation is server-validated (rules bind sellerUid)',
    /match \/products\/\{productId\}[\s\S]{0,400}?sellerUid == request\.auth\.uid/.test(rules),
    'ownership enforced', 'products can be created for another seller');

  UNV(A4, 'no subscription or payment blocks the beta allowance',
    'needs a real free-plan account creating its 1st and 100th product against live rules');
  UNV(A4, 'product inventory is synchronised with the catalogue',
    'needs a live product write + inventory read');
}

/* ══════════════════════════════════════════════════════════════════════════
   5 · POS / TILL
   ══════════════════════════════════════════════════════════════════════════ */
const A5 = 'POS';
{
  for (const [label, key] of [['posCompleteCheckout', 'zf'], ['recordPOSSale', 'retail'],
                              ['the commission rail', 'rail'], ['the business wallet', 'bwallet']]) {
    const m = MODS[key];
    verdict(A5, label + ' loads', !!m && !m.__err, 'loadable', m && m.__err);
  }

  const zfSrc = read('functions/pos-zero-friction.js') || '';
  const reSrc = read('functions/pos-retail-engine.js') || '';

  verdict(A5, 'the merchant is PROVEN before a sale is written',
    /_merchantProven/.test(zfSrc) && /not authorised to record a sale for this shop/.test(zfSrc),
    'proven via resolveActor OR workspace membership', 'merchantId is taken on trust');

  /* P0 (owner 2026-09-27): both rails go through the ONE switch `enforceSaleGate`, which is OFF
     until a certified settlement path exists. The check is that no door escapes the switch. */
  verdict(A5, 'BOTH sale rails go through the one commission-gate switch',
    /enforceSaleGate\(/.test(zfSrc) && /enforceSaleGate\(/.test(reSrc) &&
      !/assertGateOpen\(/.test(zfSrc) && !/assertGateOpen\(/.test(reSrc),
    'checkout + recordPOSSale', 'a rail bypasses the switch — a merchant can switch callables');

  verdict(A5, 'BOTH sale rails record the commission liability',
    /recordSaleLiability/.test(zfSrc) && /recordSaleLiability/.test(reSrc),
    'the gate has something to read', 'the gate reads an empty ledger');

  /* Till identity and existence. */
  const life = read('functions/application-lifecycle.js') || '';
  verdict(A5, 'a Till is provisioned automatically and ACTIVE',
    /mintSokoniTillCore/.test(life) && /onExisting: 'return'/.test(life),
    'minted ACTIVE on approval, idempotent', 'no till is created');

  const till = read('functions/sokoni-till.js') || '';
  verdict(A5, 'till identity is one ACTIVE till per branch',
    /where\('status', '==', 'ACTIVE'\)/.test(till), 'enforced in the allocation txn', 'not enforced');

  /* A missing printer must not stop the till opening. */
  const posHtml = read('pos.html') || '';
  const printerHard = /<script[^>]+sokoni-pos-print-service\.js[^>]*>/.test(posHtml)
    && !/defer|async/.test((posHtml.match(/<script[^>]+sokoni-pos-print-service\.js[^>]*>/) || [''])[0]);
  verdict(A5, 'POS boots without a printer configured', !printerHard,
    'printer script is deferred / not boot-blocking',
    'the printer script loads synchronously at boot — no printer may block the till');

  UNV(A5, 'a cash sale completes end to end', 'needs a live till session against deployed functions');
  UNV(A5, 'an IntaSend sale completes end to end', 'needs a real STK push and webhook confirmation');
  UNV(A5, 'a discount is applied and authorised', 'needs a live manager session');
  UNV(A5, 'a refund returns stock and money', 'needs a live sale to refund');
  UNV(A5, 'the drawer balance reconciles', 'needs a live shift open/close');
  UNV(A5, 'a receipt prints or renders', 'needs a live sale + device');
}

/* ══════════════════════════════════════════════════════════════════════════
   6 · EMPLOYEES
   ══════════════════════════════════════════════════════════════════════════ */
const A6 = 'EMPLOYEES';
{
  const se = MODS.shopEmp;
  verdict(A6, 'the employee authority module loads', !!se && !se.__err, 'shop-employees.js', se && se.__err);
  if (se && !se.__err) {
    verdict(A6, 'merchant roles are a closed vocabulary',
      Array.isArray(se.SHOP_ROLES) && se.SHOP_ROLES.length > 0, se.SHOP_ROLES && se.SHOP_ROLES.join(', '),
      'roles are open-ended');
    verdict(A6, 'an employee record is keyed to ONE shop',
      typeof se.employeeDocId === 'function' && se.employeeDocId('S1', 'U1').indexOf('S1') === 0,
      'canonical key binds shop + uid', 'the key does not bind the shop');
  }

  const seSrc = read('functions/shop-employees.js') || '';
  verdict(A6, 'employee rows are corroborated, not merely read',
    /shopOwnerId/.test(seSrc) && /employeeDocId\(shopId, e\.uid\)/.test(seSrc),
    'canonical key + role + owner match', 'a forged shopEmployees row would be believed');

  /* firestore.rules lets any signed-in client create one — so corroboration is load-bearing. */
  const rules = read('firestore.rules') || '';
  if (/match \/shopEmployees\//.test(rules)) {
    const blk = (rules.match(/match \/shopEmployees\/\{[^}]*\}[\s\S]{0,400}?\n    \}/) || [''])[0];
    if (/allow create: if isAuthed\(\)/.test(blk)) {
      PASS(A6, 'corroboration is required (rules allow any signed-in create)',
        'server-side corroboration is what makes this safe');
    }
  }

  const aos = read('sokoni-aos.js') || '';
  verdict(A6, 'an operator can see a shop\'s staff and disputed rows',
    /adminGetShopDetail/.test(aos) && /disputed/.test(aos),
    'AdminOS shop detail', 'staff are not visible to an operator');

  UNV(A6, 'the owner can add an employee end to end', 'needs a live owner session + invite acceptance');
  UNV(A6, 'an employee is restricted to their own shop at runtime',
    'proven in source; needs a live cross-shop attempt to confirm');
}

/* ══════════════════════════════════════════════════════════════════════════
   7 · SELLING — publish, discover, buy, pay, settle, credit
   ══════════════════════════════════════════════════════════════════════════ */
const A7 = 'SELLING';
{
  const se = MODS.settleEngine, os = read('functions/order-settlement.js') || '';
  verdict(A7, 'the settlement engine loads', !!se && !se.__err, 'settlement-engine.js', se && se.__err);

  /* The money split, computed for real. */
  if (se && !se.__err && typeof se.computeSettlement === 'function') {
    try {
      const subCore = require(path.join(FN, 'subscription-core.js'));
      subCore.resolveSubscription = async () => ({ found: true, tier: 'seller_free', status: 'active', features: {} });
      subCore.isActive = () => true;
      const b = await se.computeSettlement(mkDb(new Map()), {
        grossCents: 1000000, category: 'marketplace', sellerId: 'S1', hubId: 'marketplace',
        deliveryFeeCents: 20000, riderId: 'R1',
      });
      verdict(A7, 'commission is deducted and the remainder credited to the merchant',
        b.commission.cents + b.sellerNetCents === 1000000 && b.sellerNetCents > 0,
        'KES ' + (b.commission.cents / 100) + ' commission, KES ' + (b.sellerNetCents / 100) + ' to the seller',
        'the split does not reconcile');
      const comm = (b.ledgerPlan || []).find((e) => e.type === 'commission');
      const earn = (b.ledgerPlan || []).find((e) => e.type === 'seller_earning');
      verdict(A7, 'commission reaches the platform account and the rest reaches the seller',
        !!comm && !!earn && /platform/.test(comm.creditAccount) && /seller:/.test(earn.creditAccount),
        comm && (comm.creditAccount + ' / ' + earn.creditAccount), 'the ledger credits the wrong accounts');
    } catch (e) { UNV(A7, 'the money split computes', 'engine threw: ' + e.message); }
  }

  verdict(A7, 'money is not released without proof of delivery',
    /awaiting_delivery_proof/.test(os) && /deliveryAuthorizedBy/.test(os),
    'settlement holds until the buyer PIN lands', 'the seller is paid on an unproven delivery');

  verdict(A7, 'the buyer PIN is issued with the order and never readable by the rider',
    /collection\("deliveryPins"\)/.test(read('functions/delivery-pin.js') || '')
      && /The assigned rider cannot read the delivery PIN/.test(read('functions/delivery-pin.js') || ''),
    'plaintext off the order, buyer-only read', 'the rider can read the PIN that authorises their own payout');

  const rules = read('firestore.rules') || '';
  verdict(A7, 'the delivery PIN store is client-unreadable', !/match \/deliveryPins\//.test(rules),
    'no rule = deny by default', 'a rule exists — check it does not expose the PIN');

  UNV(A7, 'a customer can discover a published product', 'needs a live search against production data');
  UNV(A7, 'an IntaSend payment succeeds', 'needs a real STK push and webhook — cannot be simulated here');
  UNV(A7, 'the shop wallet receives the correct credit', 'needs a live paid order to settle');
  UNV(A7, 'inventory decrements on purchase', 'needs a live order');
  UNV(A7, 'the order appears to the merchant', 'needs a live order');
}

/* ══════════════════════════════════════════════════════════════════════════
   DEPLOYABILITY — is this tree even shippable?
   ══════════════════════════════════════════════════════════════════════════ */
const A8 = 'DEPLOYABILITY';
{
  try {
    const head = execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
    let live = null;
    try { live = JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8')).commitShort; } catch (_) {}
    add(A8, 'working tree HEAD', 'PASS', head + (live ? '   (version.json says ' + live + ' — a build artifact, not HEAD)' : ''));

    /* The question that decides whether a hosting deploy is a rollback. */
    let behind = null;
    try { behind = execSync('git rev-list --count HEAD..d592d8f', { cwd: ROOT, encoding: 'utf8' }).trim(); } catch (_) {}
    if (behind !== null) {
      verdict(A8, 'HEAD contains everything live has', behind === '0',
        'nothing missing', 'live has ' + behind + ' commits this tree does not — deploying hosting from here DROPS them');
    }

    const dirty = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter(Boolean).length;
    verdict(A8, 'the working tree is clean enough to publish', dirty === 0,
      'clean', dirty + ' uncommitted paths — hosting publishes the WORKING TREE, so all of it goes live');
  } catch (e) { UNV(A8, 'git state', e.message); }

  verdict(A8, 'the functions dependency graph closes', exists('functions/merchant-identity.js'),
    'merchant-identity.js present', 'merchant-identity.js missing — pos-zero-friction cannot load');
}

/* ══════════════════════════════════════════════════════════════════════════
   REPORT
   ══════════════════════════════════════════════════════════════════════════ */
const W = { PASS: 0, FAIL: 0, UNVERIFIED: 0 };
let area = null;
console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
console.log('║  MERCHANT LAUNCH GATE' + (LIVE ? '  (--live)' : '  (offline — run --live for discovery)').padEnd(46) + '║');
console.log('╚══════════════════════════════════════════════════════════════════════╝');
for (const r of R) {
  if (r.area !== area) { area = r.area; console.log('\n' + area); }
  W[r.status]++;
  const tag = r.status === 'PASS' ? 'PASS      ' : r.status === 'FAIL' ? 'FAIL      ' : 'UNVERIFIED';
  console.log('  ' + tag + '  ' + r.check + (r.detail ? '\n                  ' + r.detail : ''));
}

console.log('\n──────────────────────────────────────────────────────────────────────');
console.log('  PASS ' + W.PASS + '   FAIL ' + W.FAIL + '   UNVERIFIED ' + W.UNVERIFIED);
console.log('  UNVERIFIED is NOT pass — each line above says what would settle it.');

const blockers = R.filter((r) => r.status === 'FAIL');
if (blockers.length) {
  console.log('\n  LAUNCH BLOCKERS (' + blockers.length + '), in dependency order:');
  for (const b of blockers) console.log('    · [' + b.area + '] ' + b.check + '\n        ' + b.detail);
}
console.log('');
process.exit(blockers.length ? 1 : 0);
})().catch((e) => { console.error('\ngate crashed:', e.stack, '\n'); process.exit(2); });
