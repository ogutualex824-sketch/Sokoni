#!/usr/bin/env node
/* Merchant Customers — the client layer and the binding boundary (2D-2 step 6).
 *
 *   node scripts/test-merchant-customers.js
 *
 * FIXTURE: SELLER_A (account) !== SHOP_B; SHOP_C belongs to somebody else.
 *
 * The three properties this suite holds:
 *
 *   1. Three unsafe authorities are NOT BOUND — absent from the binding, not
 *      fetched and hidden. posLookupCustomer searches posCustomers platform-wide
 *      with no merchant filter; posGetCustomerInsights trusts a client
 *      merchantId; getCustomerGrowthMetrics is gated on a claim nothing mints.
 *   2. The list is scoped by the RULES, not by this code, and posCustomers is
 *      never used.
 *   3. The POS `merchants/{merchantId}` record is never created, faked or
 *      substituted to make a legacy CRM callable succeed.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MD = require(path.join(ROOT, 'sokoni-merchant-data.js'));
const MC = require(path.join(ROOT, 'sokoni-merchant-customers.js'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 140) + ']' : ''));
  ok ? pass++ : fail++;
};

const SELLER_A = 'SELLER_A_uid_7f3';
const SHOP_B = 'SHOP_B_shop_91c';
const SHOP_C = 'SHOP_C_shop_42x';
const scopeOf = (uid, shop) => MD.resolveScope({ uid, activeShopId: shop });
const SCOPE = scopeOf(SELLER_A, SHOP_B);
const SRC = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
function code(src) {
  let out = '', i = 0, n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += c; i++;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        out += src[i]; if (src[i] === q) { i++; break; } i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}
const CODE = (f) => code(SRC(f));

const ROWS = [
  { uid: 'c1', merchantId: SELLER_A, name: 'Ann Ali', phone: '+254700000001', email: 'ann@example.com',
    segment: 'vip', clv: 82000, orderCount: 14, totalSpend: 61000, avgOrderValue: 4357,
    churnRiskLevel: 'low', loyaltyPoints: 340, loyaltyTier: 'gold', preferredCategories: ['Phones'] },
  { uid: 'c2', merchantId: SELLER_A, name: 'Bob Bee', phone: '+254700000002', email: 'bob@example.com',
    segment: 'first_time', clv: 900, orderCount: 1, totalSpend: 900 },
  { uid: 'c3', merchantId: SELLER_A, name: 'Unprofiled Person' },
];

(async () => {

/* ═══ A — the three unsafe authorities are NOT BOUND ═══ */
console.log('\nPART A — not bound, not hidden\n');
{
  const FORBIDDEN = ['posLookupCustomer', 'posGetCustomerInsights', 'getCustomerGrowthMetrics'];
  const merchantPath = CODE('merchant.html') + CODE('sokoni-merchant-customers.js') + CODE('sokoni-merchant-customers-ui.js');
  const leaked = FORBIDDEN.filter((n) => new RegExp("['\"]" + n + "['\"]").test(merchantPath));
  ck('A1  none of the three unsafe authorities is bound in the merchant path',
    leaked.length === 0, leaked.join(','));
  ck('A2  the client layer names ONLY the two owner-asserted callables',
    Object.values(MC.CALLABLES).sort().join(',') === 'getCRMDashboard,getCustomerProfile',
    Object.values(MC.CALLABLES).join(','));

  /* Not-bound is stronger than not-displayed. Prove the surface has no code path
     that could call them even if a value were wanted. */
  const ui = CODE('sokoni-merchant-customers-ui.js');
  ck('A3  the surface has no callable slot for an insights or growth API',
    !/callInsights|callGrowth|callLookup/.test(ui));

  /* Control: the detector must be able to catch a real binding. */
  ck('A4  the detector catches a real binding (control)',
    /['"]posLookupCustomer['"]/.test("callLookup: _callable('posLookupCustomer')"));
}

/* ═══ B — the list is scoped by the RULES ═══ */
console.log('\nPART B — the rules scope it, not this code\n');
{
  const q = MC.profileQuery(SCOPE);
  ck('B1  the list reads crmCustomerProfiles', q.collection === 'crmCustomerProfiles');
  ck('B2  ...filtered by merchantId, which the rules compare to auth.uid',
    q.where[0][0] === 'merchantId' && q.where[0][2] === SELLER_A);
  ck('B3  the merchant id in this domain IS the account uid', MC.merchantIdFor(SCOPE) === SELLER_A);
  ck('B4  ...and is never the shop id', MC.merchantIdFor(SCOPE) !== SHOP_B);

  let threw = false;
  try { MC.merchantIdFor(scopeOf(null, SHOP_B)); } catch (_) { threw = true; }
  ck('B5  no signed-in account means no query', threw);

  const layer = CODE('sokoni-merchant-customers.js');
  const ui = CODE('sokoni-merchant-customers-ui.js');
  ck('B6  posCustomers is never read', !/posCustomers/.test(layer + ui));
  ck('B7  no Firestore write of any kind',
    !/\b(deleteDoc|setDoc|updateDoc|addDoc|writeBatch|runTransaction)\s*\(/.test(layer + ui));

  /* The rule that makes this safe, asserted against the shipped ruleset. */
  const rules = SRC('firestore.rules');
  const block = rules.slice(rules.indexOf('match /crmCustomerProfiles/{uid}'),
    rules.indexOf('match /crmCustomerProfiles/{uid}') + 420);
  ck('B8  rules scope the read to the merchant', /resource\.data\.merchantId == request\.auth\.uid/.test(block));
  ck('B9  rules refuse client writes outright', /allow write: if false/.test(block));

  const denied = await MC.listCustomers({ scope: SCOPE,
    db: { queryProfiles: async () => { const e = new Error('Missing or insufficient permissions.'); e.code = 'permission-denied'; throw e; } } });
  ck('B10 a rules refusal is reported, not rendered as "no customers"',
    denied.ok === false && denied.customers === undefined && /permissions/.test(denied.error));
}

/* ═══ C — search cannot reach another merchant ═══ */
console.log('\nPART C — search is over already-scoped rows\n');
{
  /* An adapter that HONOURS the filter, so a wrong scope returns the wrong rows
     rather than silently returning everything. */
  const scopedDb = {
    queryProfiles: async (spec) => {
      const all = ROWS.concat([{ uid: 'x9', merchantId: 'OTHER_MERCHANT', name: 'Someone Else', phone: '+254799999999' }]);
      const [f, , v] = spec.where[0];
      return all.filter((r) => String(r[f]) === String(v));
    },
  };
  const listed = await MC.listCustomers({ scope: SCOPE, db: scopedDb });
  ck('C1  only this merchant\'s rows come back', listed.ok && listed.count === 3);
  ck('C2  ...another merchant\'s customer is absent',
    !listed.customers.some((c) => c.name === 'Someone Else'));

  const hits = MC.searchCustomers(listed.customers, 'ann');
  ck('C3  search matches on name', hits.length === 1 && hits[0].uid === 'c1');
  ck('C4  search matches on phone', MC.searchCustomers(listed.customers, '0000002')[0].uid === 'c2');
  ck('C5  search matches on email', MC.searchCustomers(listed.customers, 'bob@')[0].uid === 'c2');
  ck('C6  an empty term returns everything', MC.searchCustomers(listed.customers, '').length === 3);
  ck('C7  search can only ever see rows the rules returned — a foreign phone matches nothing',
    MC.searchCustomers(listed.customers, '+254799999999').length === 0);
}

/* ═══ D — no fabricated figures ═══ */
console.log('\nPART D — unknown is a dash, never zero\n');
{
  const p = MC.projectCustomer(ROWS[2]);      /* the unprofiled customer */
  ck('D1  an unprofiled customer has null spend, not 0', p.totalSpend === null);
  ck('D2  ...null order count', p.orderCount === null);
  ck('D3  ...null CLV', p.clv === null);
  ck('D4  and they render as a dash', MC.formatKES(p.totalSpend) === '—' && MC.formatCount(p.orderCount) === '—');
  ck('D5  a REAL zero renders as zero', MC.formatKES(0) === 'KES 0' && MC.formatCount(0) === '0');
  ck('D6  a real value renders as currency', /^KES\s?61[,  ]?000$/.test(MC.formatKES(61000)), MC.formatKES(61000));
  ck('D7  a missing date is a dash', MC.dateLabel(null) === '—');

  /* The summary must come from getCRMDashboard, never derived from the page. */
  const ui = CODE('sokoni-merchant-customers-ui.js');
  ck('D8  the surface computes no total from the loaded list',
    !/customers\.reduce|\.reduce\(function/.test(ui),
    'a total over a 500-row page is not a total');
  ck('D9  ...it renders only figures the dashboard actually returned',
    /typeof d\.totalCustomers === 'number'/.test(ui));
}

/* ═══ E — the POS merchants record is never faked ═══ */
console.log('\nPART E — the identity line\n');
{
  const layer = CODE('sokoni-merchant-customers.js');
  const ui = CODE('sokoni-merchant-customers-ui.js');
  const shell = CODE('merchant.html');

  ck('E1  nothing writes or creates a merchants/ document',
    !/collection\(\s*['"]merchants['"]/.test(layer + ui + shell));
  ck('E2  ...and no merchants id is synthesised anywhere',
    !/merchants\//.test(layer + ui));

  /* The refusal is CLASSIFIED so the surface can explain it. */
  const refused = await MC.getProfile({ scope: SCOPE, uid: 'c1',
    callProfile: async () => { const e = new Error('Merchant not found.'); e.code = 'not-found'; throw e; } });
  ck('E3  a missing POS merchant record is classified, not passed through raw',
    refused.ok === false && refused.reason === 'no_pos_merchant_record', refused.reason);

  const other = await MC.getProfile({ scope: SCOPE, uid: 'c1',
    callProfile: async () => { const e = new Error('Access denied.'); e.code = 'permission-denied'; throw e; } });
  ck('E4  a genuine refusal is classified differently', other.reason === 'refused');

  ck('E5  the surface EXPLAINS the missing record rather than erroring',
    /POS merchant record/i.test(SRC('sokoni-merchant-customers-ui.js')));
  /* Asserted on both halves rather than the whole sentence: the notice is built
     from concatenated string literals, so the phrase is split by `' + '` in the
     source and a single-phrase regex fails on correct code. */
  const uiSrc = SRC('sokoni-merchant-customers-ui.js');
  ck('E6  ...and says the list is still complete and correct',
    /list below is/i.test(uiSrc) && /complete and correct/i.test(uiSrc));
  ck('E7  ...and does not degrade the list when the summary refuses',
    !/dashReason[\s\S]{0,200}customers = \[\]/.test(SRC('sokoni-merchant-customers-ui.js')));

  /* And the profile still shows the stored row when the live call refuses. */
  const okProfile = await MC.getProfile({ scope: SCOPE, uid: 'c1',
    callProfile: async () => ({ data: ROWS[0] }) });
  ck('E8  a successful profile projects the same shape as a row',
    okProfile.ok && okProfile.profile.uid === 'c1' && okProfile.profile.totalSpend === 61000);
}

/* ═══ F — nothing local, nothing removed ═══ */
console.log('\nPART F — merchant path and routing\n');
{
  const layer = CODE('sokoni-merchant-customers.js');
  const ui = CODE('sokoni-merchant-customers-ui.js');
  ck('F1  no localStorage in either module', !/localStorage/.test(layer + ui));
  ck('F2  no inline on* handler built from data',
    !/\son(click|input|change|submit)\s*=\s*(\\?["'])/.test(layer + ui));

  const C = require(path.join(ROOT, 'sokoni-merchant-routes.js'));
  ck('F3  the route contract still validates', C.validate().length === 0, C.validate().join(' | '));
  ck('F4  Customers is a NATIVE route', C.get('customers').kind === 'native');
  ck('F5  ...so no seller.html iframe is required', !C.get('customers').sec && !C.get('customers').src);

  const EXPECTED = ['dashboard','plan','sell','products','inventory','pos','orders','analytics','revenue',
    'payments','deliveries','returns','receipts','staff','messages','disputes','settings','marketing','customers'];
  ck('F6  every merchant destination is still present',
    EXPECTED.every((id) => !!C.get(id)), EXPECTED.filter((id) => !C.get(id)).join(','));
  ck('F7  POS and every native surface built so far are untouched',
    C.get('pos').kind === 'pos' && ['sell','inventory','staff','marketing','disputes','messages']
      .every((id) => C.get(id).kind === 'native'));

  const shell = SRC('merchant.html');
  ck('F8  the shell loads both new modules',
    /sokoni-merchant-customers\.js/.test(shell) && /sokoni-merchant-customers-ui\.js/.test(shell));
  ck('F9  the shell has a renderer for Customers', /id === 'customers'\) renderCustomers\(\)/.test(shell));
  ck('F10 the shell binds ONLY the two owner-asserted callables',
    /callProfile:\s*_callable\('getCustomerProfile'\)/.test(shell) &&
    /callDashboard:\s*_callable\('getCRMDashboard'\)/.test(shell));
  ck('F11 ...and exposes the rules-gated read adapter', /queryProfiles: function/.test(shell));
}

console.log('\n' + '='.repeat(70));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error(e); process.exit(1); });
