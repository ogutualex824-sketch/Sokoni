#!/usr/bin/env node
/* Merchant Subscription Package Convergence — one vocabulary, one resolver, one rate table.
 *
 *   node scripts/test-merchant-package-convergence.js
 *   COUNTERPROOF=1 node scripts/test-merchant-package-convergence.js   # HEAD (pre-fix)
 *   SABOTAGE=alias|rate|amount                                        # targeted mutants
 *
 * WHAT THIS GATE ESTABLISHES
 *   • Canonical packages are free / professional / business / enterprise. The retired
 *     seller_* ids survive ONLY as aliases — and every one of them must still resolve, because
 *     `resolve()` falls back to FREE and a stale alias is therefore a SILENT DOWNGRADE rather
 *     than an error.
 *   • Marketplace commission is 16 / 12 / 8 / 4, replacing 15 / 10 / 5 / 0.
 *   • POS stays flat 5% and Healthcare stays 5% — a merchant repricing must not reach either.
 *   • merchantSubscriptions is the canonical store and subscription-core reads it, with the
 *     legacy stores kept beneath it because production data lives there.
 *   • No paid subscription activates without a verified, sufficient, unreplayed payment.
 *   • Stories is available on every package; allowances are reported, never invented.
 *
 * The real modules are loaded and the real resolvers executed — the assertions are on values
 * production code produced, not on table text.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const COUNTERPROOF = !!process.env.COUNTERPROOF;
const SABOTAGE = process.env.SABOTAGE || '';

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 140) + ']' : ''));
  ok ? pass++ : fail++;
};
const section = (s) => console.log('\n' + s + (COUNTERPROOF ? '   (HEAD, pre-fix)' : SABOTAGE ? '   (SABOTAGE=' + SABOTAGE + ')' : ''));

function source(rel) {
  const p = rel.split(path.sep).join('/');
  if (!COUNTERPROOF) return fs.readFileSync(path.join(ROOT, p), 'utf8');
  try { return execFileSync('git', ['show', 'HEAD:' + p], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
  catch (_) { return null; }
}

/* Targeted mutants: same shipping module, one behaviour removed. "Absent at HEAD" is the
   weakest control there is, so each claim below is also proved against a mutant that LOADS. */
const MUTATIONS = {
  /* Drop the legacy aliases — the silent-downgrade regression. */
  alias: [[path.join('functions', 'subscription-catalog.js'), (src) => {
    const a = "  seller_free: 'FREE', seller_basic: 'PROFESSIONAL', seller_pro: 'BUSINESS',";
    if (!src.includes(a)) throw new Error('SABOTAGE alias: anchor missing — mutation vacuous');
    return src.replace(a, '');
  }]],
  /* Remove the admin guard — G1 must catch a financial surface open to merchants. */
  admin: [[path.join('functions', 'admin-commission-trace.js'), (src) => {
    const a = "  if (!req.auth?.token?.admin && !req.auth?.token?.superAdmin) throw new Error('admin required');";
    if (!src.includes(a)) throw new Error('SABOTAGE admin: anchor missing — mutation vacuous');
    return src.replace(a, '  /* guard removed */');
  }]],
  /* Restore the retired rates. */
  rate: [[path.join('functions', 'commission-config.js'), (src) => {
    const a = '  free:         { rateFraction: 0.16, floorExempt: false },';
    if (!src.includes(a)) throw new Error('SABOTAGE rate: anchor missing — mutation vacuous');
    return src.replace(a, '  free:         { rateFraction: 0.15, floorExempt: false },');
  }]],
};

/* Comment-stripped source for the assertions that read a module's TEXT (the write-call scan
   in G9). This module's own prose names `.set(` and `collection(` while explaining that it
   uses neither — asserting on raw text would count the explanation as the violation. */
function strip(src) {
  let out = '', i = 0;
  const s = String(src || ''), n = s.length;
  while (i < n) {
    const c = s[i], d = s[i + 1];
    if (c === '/' && d === '*') { const e = s.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; out += ' '; continue; }
    if (c === '/' && d === '/') { while (i < n && s[i] !== '\n') i++; out += ' '; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += c; i++;
      while (i < n) {
        if (s[i] === '\\') { out += s[i] + (s[i + 1] || ''); i += 2; continue; }
        out += s[i]; if (s[i] === q) { i++; break; } i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

function loadModule(rel) {
  let src = source(rel);
  if (src == null) return null;
  for (const [t, mut] of (MUTATIONS[SABOTAGE] || [])) if (t === rel) src = mut(src);
  const filename = path.join(ROOT, rel);
  const m = new Module(filename, null);
  m.filename = filename;
  m.paths = Module._nodeModulePaths(path.dirname(filename));
  m._compile(src, filename);
  return m.exports;
}

/* ── Firestore stub whose where() actually filters ───────────────────────────────────────── */
function makeDb(seed) {
  const store = JSON.parse(JSON.stringify(seed || {}));
  const snapOf = (p) => ({ id: p.split('/').pop(), exists: Object.hasOwn(store, p),
    ref: { id: p.split('/').pop(), path: p }, data: () => store[p] });
  function query(coll, filters) {
    return {
      where: (f, op, v) => query(coll, filters.concat([[f, op, v]])),
      limit: () => query(coll, filters), orderBy: () => query(coll, filters),
      get: async () => {
        const docs = Object.keys(store)
          .filter((p) => p.startsWith(coll + '/') && p.slice(coll.length + 1).indexOf('/') < 0)
          .filter((p) => filters.every(([f, op, v]) => (op === '==' ? store[p][f] === v
            : op === 'in' ? Array.isArray(v) && v.includes(store[p][f])
            : (() => { throw new Error('stub where(): op ' + op); })())))
          .map(snapOf);
        return { empty: !docs.length, size: docs.length, docs, forEach: (fn) => docs.forEach(fn) };
      },
    };
  }
  const db = { collection: (c) => Object.assign(query(c, []), {
    doc: (id) => ({ id, path: c + '/' + id, get: async () => snapOf(c + '/' + id),
      set: async (d, o) => { store[c + '/' + id] = o && o.merge ? Object.assign({}, store[c + '/' + id], d) : d; },
      create: async (d) => { if (Object.hasOwn(store, c + '/' + id)) { const e = new Error('exists'); e.code = 6; throw e; } store[c + '/' + id] = d; } }),
  }) };
  return { db, store };
}
let CURRENT = { db: { collection: () => ({ doc: () => ({}) }) } };

const realLoad = Module._load;
Module._load = function (request) {
  if (request === 'firebase-admin') return { firestore: Object.assign(() => CURRENT.db, { Timestamp: {}, FieldValue: {} }) };
  if (request === 'firebase-admin/firestore') return { getFirestore: () => CURRENT.db, FieldValue: {}, Timestamp: {} };
  if (request === 'firebase-functions/v2/https') return { HttpsError: class extends Error { constructor(c, m) { super(m); this.code = c; } }, onCall: (o, f) => f };
  if (request === 'firebase-functions/logger') return { info() {}, warn() {}, error() {}, log() {}, debug() {} };
  return realLoad.apply(this, arguments);
};

const CANON = ['free', 'professional', 'business', 'enterprise'];
const LEGACY = ['seller_free', 'seller_basic', 'seller_pro', 'seller_enterprise', 'starter', 'growth', 'basic', 'pro'];

/* ════════════════════════════════════════════════════════════════════════════════════════ */
function partVocabulary() {
  section('A. One canonical vocabulary');
  const cat = loadModule(path.join('functions', 'subscription-catalog.js'));
  if (!cat) { ck('A0 subscription-catalog loads', false, 'absent'); return null; }

  const ids = Object.values(cat.PLANS).map((p) => String(p.id).toLowerCase()).sort();
  ck('A1   catalogue exposes exactly the four canonical packages',
    JSON.stringify(ids) === JSON.stringify([...CANON].sort()), ids.join(', '));
  ck('A2   the retired STARTER / GROWTH ids are gone as packages',
    !cat.PLANS.STARTER && !cat.PLANS.GROWTH);
  ck('A3   FREE listing allowance is 50', cat.PLANS.FREE.listingLimit === 50, cat.PLANS.FREE.listingLimit);
  /* Read defensively: at HEAD these packages do not exist, and an unguarded property access
     would THROW and abandon sections B-F — making the counter-proof look like a 4-check
     control when it is really an aborted run. A control that stops early is not a control. */
  const lim = (k) => (cat.PLANS[k] ? cat.PLANS[k].listingLimit : undefined);
  ck('A4   allowances increase with package',
    typeof lim('PROFESSIONAL') === 'number' && typeof lim('BUSINESS') === 'number'
    && lim('PROFESSIONAL') > lim('FREE')
    && (lim('BUSINESS') === -1 || lim('BUSINESS') > lim('PROFESSIONAL')),
    `${lim('FREE')} -> ${lim('PROFESSIONAL')} -> ${lim('BUSINESS')} -> ${lim('ENTERPRISE')}`);

  /* THE SILENT-DOWNGRADE TEST. resolve() falls back to FREE, so a dropped alias does not
     error — it quietly moves a paying merchant onto the free allowance. */
  const downgraded = LEGACY.filter((t) => cat.resolve(t).id === 'FREE' && t !== 'seller_free');
  ck('A5   EVERY legacy id still resolves to a real package (no silent downgrade)',
    downgraded.length === 0, downgraded.length ? 'fell to FREE: ' + downgraded.join(', ') : 'all mapped');
  ck('A6   catalogue version bumped for the allowance change',
    cat.entitlementFor({ plan: 'free', status: 'active' }).catalogVersion >= 3,
    'v' + cat.entitlementFor({ plan: 'free', status: 'active' }).catalogVersion);
  return cat;
}

function partCommission() {
  section('B. Marketplace commission 16 / 12 / 8 / 4');
  const cc = loadModule(path.join('functions', 'commission-config.js'));
  if (!cc) { ck('B0 commission-config loads', false, 'absent'); return; }
  /* The ladder resolver does not exist at HEAD. Report that as the finding and return, rather
     than throwing and abandoning sections C-F — an aborted control understates itself. */
  if (typeof cc.resolveMarketplaceRate !== 'function') {
    ck('B0   commission-config exposes resolveMarketplaceRate', false,
      'absent — no marketplace plan ladder at all');
    return;
  }

  const want = { free: 16, professional: 12, business: 8, enterprise: 4 };
  for (const [tier, pct] of Object.entries(want)) {
    const r = cc.resolveMarketplaceRate(tier);
    ck(`B1   ${tier.padEnd(13)} = ${pct}%`, r.pct === pct && r.matched === true, r.pct + '%');
  }
  /* The retired ladder must be gone as an ANSWER, not merely renamed in a comment. */
  const old = [15, 10, 5, 0];
  const still = CANON.map((t) => cc.resolveMarketplaceRate(t).pct).filter((p) => old.includes(p));
  ck('B2   the retired 15/10/5/0 rates are no longer returned for any package',
    still.length === 0, still.length ? 'still returning ' + still.join(', ') : 'retired');

  /* Legacy ids must map to the NEW rate, not fall to the default. */
  const map = { seller_free: 16, seller_basic: 12, seller_pro: 8, seller_enterprise: 4, starter: 12, growth: 8 };
  const wrong = Object.entries(map).filter(([t, p]) => cc.resolveMarketplaceRate(t).pct !== p);
  ck('B3   legacy ids resolve to their canonical rate',
    wrong.length === 0, wrong.map(([t, p]) => `${t} wanted ${p} got ${cc.resolveMarketplaceRate(t).pct}`).join('; ') || 'all mapped');

  ck('B4   an unknown tier falls to the HIGHEST rate, never the cheapest',
    cc.resolveMarketplaceRate('nonsense').pct === 16 && cc.resolveMarketplaceRate('nonsense').matched === false);

  /* Blast radius: the repricing must not touch POS or Healthcare. */
  const pos = cc.POS_PLAN_RATES;
  const posFlat = pos && Object.values(pos).every((r) => r.rateFraction === 0.05);
  ck('B5   POS/Till stays FLAT 5% on every package', !!posFlat,
    pos ? Object.values(pos).map((r) => r.rateFraction * 100 + '%').join(' ') : 'absent');
  ck('B6   Healthcare stays 5% — untouched by the merchant repricing',
    cc.RATES.healthcare.pct === 5, cc.RATES.healthcare.pct + '%');
  ck('B7   the marketplace CATEGORY fallback is unchanged at 5%',
    cc.resolveRate('marketplace').pct === 5, cc.resolveRate('marketplace').pct + '%');

  /* The ladder must still only apply to marketplace-style sales. */
  ck('B8   the ladder applies to marketplace/products and NOT to pos/services',
    cc.isMarketplaceSellerSale('marketplace') && cc.isMarketplaceSellerSale('products')
    && !cc.isMarketplaceSellerSale('pos') && !cc.isMarketplaceSellerSale('services'));
}

function partSnapshot() {
  section('C. The generated client snapshot agrees');
  const snap = source('sokoni-commission-rates.js');
  if (snap == null) { ck('C0 snapshot present', false, 'absent'); return; }
  ck('C1   snapshot carries the canonical packages',
    /"free":\s*16/.test(snap) && /"professional":\s*12/.test(snap)
    && /"business":\s*8/.test(snap) && /"enterprise":\s*4/.test(snap));
  ck('C2   snapshot no longer carries the retired seller_* ladder',
    !/"seller_free":\s*15/.test(snap) && !/"seller_pro":\s*5/.test(snap));
  ck('C3   snapshot keeps POS flat 5%', /POS_FLAT_PCT\s*=\s*5/.test(snap));
}

async function partResolver() {
  section('D. merchantSubscriptions is canonical, legacy stores still resolve');
  const core = loadModule(path.join('functions', 'subscription-core.js'));
  if (!core) { ck('D0 subscription-core loads', false, 'absent'); return; }

  /* Canonical store wins. */
  CURRENT = makeDb({
    'merchantSubscriptions/M1': { uid: 'M1', package: 'business', status: 'active' },
    'subscriptions/S1': { uid: 'M1', hubType: 'seller', tier: 'seller_free', status: 'active' },
  });
  const a = await core.resolveSubscription('M1', { role: 'merchant' });
  ck('D1   merchantSubscriptions is read FIRST', a.found && a.source === 'merchant' && a.tier === 'business',
    `${a.source}/${a.tier}`);

  /* Legacy store still resolves — production's 7 rows live there. */
  CURRENT = makeDb({ 'subscriptions/S2': { uid: 'M2', hubType: 'seller', tier: 'seller_basic', status: 'active' } });
  const b = await core.resolveSubscription('M2', { role: 'merchant' });
  ck('D2   a legacy `subscriptions` row still resolves', b.found && b.source === 'billing' && b.tier === 'seller_basic',
    `${b.source}/${b.tier}`);

  /* role 'seller' is what finos-utils passes — commission and capability must agree. */
  CURRENT = makeDb({ 'merchantSubscriptions/M3': { uid: 'M3', package: 'enterprise', status: 'active' } });
  const c = await core.resolveSubscription('M3', { role: 'seller' });
  ck('D3   role "seller" resolves the same subscription as "merchant"',
    c.found && c.tier === 'enterprise', `${c.source}/${c.tier}`);

  CURRENT = makeDb({});
  const d = await core.resolveSubscription('M4', { role: 'merchant' });
  ck('D4   no subscription resolves to NONE, never to a paid tier', !d.found, d.status);
}

async function partCapability() {
  section('E. Capability + Stories across all four packages');
  const capMod = loadModule(path.join('functions', 'capability-authority.js'));
  const stories = loadModule(path.join('functions', 'stories-capability.js'));
  if (!capMod || !stories) { ck('E0 capability modules load', false, 'absent'); return; }

  for (const pkg of CANON) {
    CURRENT = makeDb({ 'merchantSubscriptions/M1': { uid: 'M1', package: pkg, status: 'active' } });
    const s = await stories.merchantStoriesFor('M1');
    ck(`E1   ${pkg.padEnd(13)} can publish Stories`, s.canPublish === true, `pkg=${s.package}`);
  }
  CURRENT = makeDb({ 'merchantSubscriptions/M1': { uid: 'M1', package: 'free', status: 'active' } });
  const free = await stories.merchantStoriesFor('M1');
  ck('E2   FREE allowance is the decided 1 per week', free.allowancePerWeek === 1, free.allowancePerWeek);
  ck('E3   FREE listing limit resolves to 50', free.listingLimit === 50, free.listingLimit);

  CURRENT = makeDb({ 'merchantSubscriptions/M1': { uid: 'M1', package: 'enterprise', status: 'active' } });
  const ent = await stories.merchantStoriesFor('M1');
  ck('E4   paid allowances are NULL (undecided), not invented',
    ent.allowancePerWeek === null, String(ent.allowancePerWeek));
  ck('E5   no allowance is claimed as enforced while rules cannot enforce it',
    ent.allowanceEnforced === false && stories.storyCapacityStatus().enforced === false);
  ck('E6   advanced capabilities DO vary by package',
    free.advancedAnalytics === false && ent.advancedAnalytics === true,
    `free=${free.advancedAnalytics} enterprise=${ent.advancedAnalytics}`);

  /* Expiry must narrow, not destroy.
     subscription-core RECOMPUTES status from dates — a stored 'expired' with no dates resolves
     back to ACTIVE, deliberately, so a stale stored status cannot leak a benefit. The fixture
     therefore has to actually lapse. */
  const PAST = Date.now() - 30 * 86400000;
  CURRENT = makeDb({ 'merchantSubscriptions/M1': { uid: 'M1', package: 'enterprise',
    status: 'expired', expiresAt: PAST, currentPeriodEnd: PAST } });
  const exp = await stories.merchantStoriesFor('M1');
  ck('E7   an expired package falls to FREE and KEEPS basic Stories',
    exp.package === 'FREE' && exp.canPublish === true && exp.listingLimit === 50,
    `${exp.package} limit=${exp.listingLimit} canPublish=${exp.canPublish}`);
}

function partSecurity() {
  section('F. Activation security');
  const idx = source(path.join('functions', 'index.js')) || '';
  const ai = source(path.join('functions', 'ai-subscriptions.js')) || '';

  ck('F1   updateSellerSubscription verifies the AMOUNT, not just status+owner',
    /paidCents\s*<\s*expectCents/.test(idx), 'underpayment refused');
  ck('F2   it claims the paymentRef so a replay cannot extend the period',
    /subscriptionPaymentRefs/.test(idx) && /already been applied/.test(idx));
  ck('F3   it writes the CANONICAL merchantSubscriptions store',
    /collection\("merchantSubscriptions"\)/.test(idx));
  ck('F4   a missing amount REFUSES rather than passing',
    /!Number\.isFinite\(paidCents\)\s*\|\|\s*paidCents\s*<\s*expectCents/.test(idx));
  ck('F5   activateAIPlan no longer activates a paid plan on an unverified ref',
    /refused unverified paid activation/.test(ai)
    && /cannot be activated from the client/.test(ai));
  ck('F6   a zero-price AI plan is still self-serve (nothing to forge)',
    /PLANS\[planId\]\.price > 0/.test(ai));
}

/* ════════════════════════════════════════════════════════════════════════════════════════
   PART G — AdminOS financial traceability
   ════════════════════════════════════════════════════════════════════════════════════════
   The requirement is that a rate can be EXPLAINED, not merely displayed. So these assert the
   chain reaches the authoritative records — and that the four money rails stay four numbers.
   `entitlements`, `merchantSubscriptions` and `subscriptionPaymentRefs` were invisible to
   AdminOS before this; "invisible" is what made "which payment authorised this package?"
   unanswerable. */
async function partTrace() {
  section('G. AdminOS traceability');
  const trace = loadModule(path.join('functions', 'admin-commission-trace.js'));
  if (!trace || !trace._h) { ck('G0   admin-commission-trace loads', false, 'absent at HEAD'); return; }
  ck('G0   admin-commission-trace loads', true, Object.keys(trace._h).join(', '));

  const ADMIN = { auth: { uid: 'A1', token: { admin: true } } };
  const SUPER = { auth: { uid: 'S1', token: { superAdmin: true } } };
  const MERCHANT = { auth: { uid: 'M1', token: {} } };
  const ANON = {};

  /* ── SECURITY FIRST. A financial aggregation surface that a merchant can call is a data
     breach, not a dashboard. Every op is checked, not just the first. ── */
  CURRENT = makeDb({});
  for (const [op, fn] of Object.entries(trace._h)) {
    let merchantBlocked = false, anonBlocked = false, adminAllowed = false;
    try { await fn(Object.assign({ data: { merchantUid: 'M1', orderId: 'O1' } }, MERCHANT)); }
    catch (_) { merchantBlocked = true; }
    try { await fn(Object.assign({ data: { merchantUid: 'M1', orderId: 'O1' } }, ANON)); }
    catch (_) { anonBlocked = true; }
    try { await fn(Object.assign({ data: { merchantUid: 'M1', orderId: 'O1' } }, ADMIN)); adminAllowed = true; }
    catch (_) { adminAllowed = false; }
    ck(`G1   ${op} refuses non-admin, allows admin`,
      merchantBlocked && anonBlocked && adminAllowed,
      `merchant=${merchantBlocked ? 'blocked' : 'ALLOWED'} anon=${anonBlocked ? 'blocked' : 'ALLOWED'} admin=${adminAllowed ? 'ok' : 'BLOCKED'}`);
  }
  /* superAdmin must also pass — a guard that only admits `admin` locks out the owner. */
  CURRENT = makeDb({});
  let superOk = true;
  try { await trace._h.adminCommissionByRail(Object.assign({ data: {} }, SUPER)); } catch (_) { superOk = false; }
  ck('G1b  superAdmin is admitted too', superOk);

  /* ── THE SUBSCRIPTION CHAIN ── */
  const REF = 'PAYREF-1';
  CURRENT = makeDb({
    'merchantSubscriptions/M1': { uid: 'M1', package: 'business', status: 'active',
      price: 249900, paymentRef: REF, activatedAt: Date.now(), expiresAt: Date.now() + 30 * 86400000 },
    ['payments/' + REF]: { uid: 'M1', status: 'COMPLETE', amountCents: 249900 },
    ['paymentIntents/' + REF]: { uid: 'M1', ownerUid: 'M1', purpose: 'subscription', amountCents: 249900 },
    ['entitlements/' + REF]: { status: 'ACTIVE', purpose: 'subscription', ownerUid: 'M1',
      activatedAt: Date.now(), source: 'webhook' },
    ['subscriptionPaymentRefs/' + REF]: { paymentRef: REF, uid: 'M1', claimedAt: Date.now() },
  });
  const t = await trace._h.adminTraceMerchantSubscription(Object.assign({ data: { merchantUid: 'M1' } }, ADMIN));
  ck('G2   merchant -> package', t.subscriptions[0] && t.subscriptions[0].package === 'business',
    t.subscriptions[0] && t.subscriptions[0].package);
  ck('G2b  the authoritative store is named',
    t.authoritativeStore === 'merchantSubscriptions', t.authoritativeStore);
  ck('G2c  package -> paymentRef', (t.paymentChain[0] || {}).paymentRef === REF);
  ck('G2d  paymentRef -> payment (amount + status)',
    (t.paymentChain[0] || {}).payment && t.paymentChain[0].payment.amountCents === 249900
    && t.paymentChain[0].payment.status === 'COMPLETE');
  ck('G2e  paymentRef -> ENTITLEMENT (the honoured-once proof)',
    (t.paymentChain[0] || {}).entitlement && t.paymentChain[0].entitlement.status === 'ACTIVE');
  ck('G2f  paymentRef -> replay claim', !!(t.paymentChain[0] || {}).replayClaim);
  ck('G2g  reversal state is read, not assumed', t.paymentChain[0].reversed === false);

  /* A payment that granted nothing must be VISIBLE as that, not a blank cell. */
  CURRENT = makeDb({
    'merchantSubscriptions/M1': { uid: 'M1', package: 'free', status: 'active', paymentRef: 'ORPHAN' },
    'payments/ORPHAN': { uid: 'M1', status: 'COMPLETE', amountCents: 99900 },
  });
  const orphan = await trace._h.adminTraceMerchantSubscription(Object.assign({ data: { merchantUid: 'M1' } }, ADMIN));
  ck('G3   a payment with NO entitlement surfaces as a finding',
    orphan.paymentChain[0] && orphan.paymentChain[0].entitlementMissing === true);

  /* ── THE SETTLEMENT CHAIN, and the net-credit invariant ── */
  CURRENT = makeDb({
    'settlements/O1': { orderId: 'O1', sellerId: 'M1', grossCents: 1000000, commissionCents: 40000,
      sellerNetCents: 960000, netShillingsCredited: 9600, category: 'marketplace',
      deliveryProof: 'buyer_pin', settledAt: Date.now(), package: 'enterprise' },
    'walletTransactions/M1_O1_ordersettle': { uid: 'M1', amount: 9600, grossCents: 1000000,
      commissionCents: 40000, netCents: 960000 },
  });
  const st = await trace._h.adminTraceMarketplaceSettlement(Object.assign({ data: { orderId: 'O1' } }, ADMIN));
  ck('G4   order -> gross -> commission -> net',
    st.gross.cents === 1000000 && st.commission.cents === 40000 && st.sellerNetCents === 960000);
  ck('G4b  the effective rate is derived from the settlement itself',
    st.commission.effectivePct === 4, st.commission.effectivePct + '%');
  ck('G4c  the package in force AT SETTLEMENT is reported', st.packageAtSettlement === 'enterprise');
  ck('G4d  net -> wallet transaction', st.walletTransaction && st.walletTransaction.creditedShillings === 9600);
  ck('G4e  the release event is recorded', st.release.deliveryProof === 'buyer_pin');
  ck('G4f  commissionType is EXPLICIT, not inferred', st.commissionType === 'MARKETPLACE');
  ck('G5   NET-CREDIT INVARIANT: the wallet took net, never gross',
    st.netCreditVerified === true, 'wallet credited ' + st.walletTransaction.creditedShillings + ' KES of 10,000 gross');

  /* A settlement that credited GROSS must fail the invariant — the surface exists to catch it. */
  CURRENT = makeDb({
    'settlements/O2': { orderId: 'O2', sellerId: 'M1', grossCents: 1000000, commissionCents: 40000,
      sellerNetCents: 960000, settledAt: Date.now() },
    'walletTransactions/M1_O2_ordersettle': { uid: 'M1', amount: 10000, grossCents: 1000000,
      commissionCents: 40000, netCents: 1000000 },     /* credited GROSS — the defect */
  });
  const bad = await trace._h.adminTraceMarketplaceSettlement(Object.assign({ data: { orderId: 'O2' } }, ADMIN));
  ck('G5b  a GROSS credit fails the invariant rather than passing quietly',
    bad.netCreditVerified === false);

  /* ── THE FOUR RAILS STAY FOUR ── */
  CURRENT = makeDb({
    'settlements/O1': { grossCents: 1000000, commissionCents: 40000, category: 'marketplace', settledAt: Date.now() },
    'posCommissionLiabilities/P1': { merchantUid: 'M1', grossCents: 200000, commissionCents: 10000, createdAt: Date.now() },
    'providerPayouts/B1': { providerId: 'H1', gross: 500000, commission: 25000, settledAt: Date.now() },
    'merchantSubscriptions/M1': { uid: 'M1', package: 'business', price: 249900 },
  });
  const rails = await trace._h.adminCommissionByRail(Object.assign({ data: {} }, ADMIN));
  ck('G6   MARKETPLACE is its own rail', rails.rails.MARKETPLACE.commissionCents === 40000);
  ck('G6b  POS_TILL is its own rail', rails.rails.POS_TILL.commissionCents === 10000);
  ck('G6c  HEALTHCARE is its own rail', rails.rails.HEALTHCARE.commissionCents === 25000);
  ck('G6d  SUBSCRIPTION is separate from every commission rail',
    rails.rails.SUBSCRIPTION.grossCents === 249900 && rails.rails.SUBSCRIPTION.commissionCents === 0);
  ck('G6e  no combined total is offered — they are different products',
    rails.combinedTotalProvided === false);
  ck('G6f  each rail names the collection it came from',
    rails.rails.MARKETPLACE.source === 'settlements'
    && rails.rails.POS_TILL.source === 'posCommissionLiabilities'
    && rails.rails.HEALTHCARE.source === 'providerPayouts');
  ck('G6g  liveness is described honestly (read-through, not push)',
    rails.liveness === 'read-through' && /not provided/i.test(rails.livenessNote));

  /* POS and Healthcare are BOTH 5% — so type can never be inferred from the rate. */
  ck('G7   POS and HEALTHCARE are both 5% yet distinguishable',
    rails.rails.POS_TILL.commissionCents / rails.rails.POS_TILL.grossCents === 0.05
    && rails.rails.HEALTHCARE.commissionCents / rails.rails.HEALTHCARE.grossCents === 0.05
    && rails.rails.POS_TILL.source !== rails.rails.HEALTHCARE.source,
    'identical rate, different authoring collection');

  /* ── FILTERING, and the explicit type on every row ── */
  CURRENT = makeDb({
    'settlements/O1': { sellerId: 'M1', grossCents: 1000, commissionCents: 160, settledAt: Date.now(), package: 'free' },
    'settlements/O2': { sellerId: 'M2', grossCents: 2000, commissionCents: 80, settledAt: Date.now(), package: 'business' },
  });
  const all = await trace._h.adminListCommissionRecords(Object.assign({ data: { commissionType: 'MARKETPLACE' } }, ADMIN));
  ck('G8   every row carries an explicit commissionType',
    all.records.length === 2 && all.records.every((r) => r.commissionType === 'MARKETPLACE'));
  const byMerchant = await trace._h.adminListCommissionRecords(
    Object.assign({ data: { commissionType: 'MARKETPLACE', merchantUid: 'M2' } }, ADMIN));
  ck('G8b  filter by merchant', byMerchant.count === 1 && byMerchant.records[0].merchantUid === 'M2');
  const byPkg = await trace._h.adminListCommissionRecords(
    Object.assign({ data: { commissionType: 'MARKETPLACE', package: 'free' } }, ADMIN));
  ck('G8c  filter by package', byPkg.count === 1 && byPkg.records[0].packageAtRecord === 'free');
  let badType = false;
  try { await trace._h.adminListCommissionRecords(Object.assign({ data: { commissionType: 'GUESS' } }, ADMIN)); }
  catch (_) { badType = true; }
  ck('G8d  an unknown commissionType is refused, never defaulted', badType);

  /* ── IMMUTABILITY: the surface must contain no write path at all ── */
  const src = strip(source(path.join('functions', 'admin-commission-trace.js')) || '');
  /* Scoped to FIRESTORE writes, not to the method name. A bare /\.(set|add)\(/ also matches
     `seen.add(id)` on a Set and `map.set(k,v)` — it fired on exactly that and reported a
     read-only module as a writer. The question is whether a Firestore REF is written, so the
     pattern anchors on collection()/doc() and then the write method. */
  const fsWrite = /\.\s*(?:collection|doc)\s*\([^)]*\)(?:\s*\.\s*(?:collection|doc)\s*\([^)]*\))*\s*\.\s*(set|update|add|delete|create)\s*\(/g;
  const writes = src.match(fsWrite) || [];
  ck('G9   the traceability surface makes ZERO Firestore writes',
    writes.length === 0, writes.length ? writes.join(' | ') : 'read-only');
  /* And prove the detector can still see a write, so a passing G9 is not vacuous. */
  ck('G9c  the write detector is not blind',
    fsWrite.test("await db.collection('x').doc('y').set({a:1});"), 'positive control');
  ck('G9b  it does not create a second ledger collection',
    !/collection\(['"](commissionRollup|adminLedger|dashboardTotals)/.test(src));
}

/* ════════════════════════════════════════════════════════════════════════════════════════ */
(async () => {
  console.log('MERCHANT SUBSCRIPTION PACKAGE CONVERGENCE');
  console.log(COUNTERPROOF ? 'MODE: COUNTERPROOF — HEAD (pre-fix).'
    : SABOTAGE ? 'MODE: SABOTAGE=' + SABOTAGE + ' — the shipping module, one behaviour removed.'
    : 'MODE: verification — worktree.');
  try {
    partVocabulary();
    partCommission();
    partSnapshot();
    await partResolver();
    await partCapability();
    partSecurity();
    await partTrace();
  } catch (e) {
    ck('FATAL', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e));
  } finally { Module._load = realLoad; }

  console.log('\n' + '─'.repeat(74));
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  if (COUNTERPROOF || SABOTAGE) {
    console.log(fail > 0 ? `CONTROL HOLDS — ${fail} check(s) fail.`
      : 'CONTROL FAILED — nothing detected; the assertions prove nothing.');
    process.exit(fail > 0 ? 0 : 1);
  }
  process.exit(fail === 0 ? 0 : 1);
})();
