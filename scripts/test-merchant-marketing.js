#!/usr/bin/env node
/* Merchant Marketing — the client layer, the honesty rules, and the hardening (2D-2 step 3).
 *
 *   node scripts/test-merchant-marketing.js
 *
 * FIXTURE: SELLER_A (account) !== SHOP_B (shop); SHOP_C belongs to somebody else.
 *
 * The two properties this suite exists to hold:
 *
 *   1. Orders, revenue and ROI NEVER reach a screen. They are incremented by
 *      trackCampaignClick, an onRequest endpoint that needs no sign-in, so they
 *      are not business results. The data layer must strip them, so no future
 *      surface can pick them up by accident.
 *   2. Ads carry NO shopId. sokoAds has no shop scoping in the writer or either
 *      reader; adding one to the payload would manufacture the appearance of
 *      shop scoping with none of the behaviour.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MD = require(path.join(ROOT, 'sokoni-merchant-data.js'));
const MC = require(path.join(ROOT, 'sokoni-merchant-campaigns.js'));

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

/* Every "this must NOT appear" assertion runs against comment-stripped source.
   These modules document the defects they avoid by naming them — `localStorage`,
   `ownerUid`, `new Error` — and an assertion that failed on the mention would be
   telling the author to stop explaining the code. Absence is a property of the
   CODE. (Same lesson as the Team/Staff suite; the helper is duplicated rather
   than shared because a test helper shared between suites becomes a place where
   one suite's convenience silently weakens another's assertion.) */
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
const CODE = (f) => code(SRC(f));

(async () => {

/* ═══ A — traffic only ═══ */
console.log('\nPART A — orders and ROI never reach a screen\n');
{
  const serverRow = {
    campaignId: 'c1', name: 'April sale', type: 'weekend-sale', status: 'active',
    campaignUrl: 'https://mysokoni.co.ke/shop/x?utm_campaign=april',
    clicks: 42, views: 120,
    /* everything below is what the server also returns */
    orders: 9, revenue: 45000, roi: '21.4%',
  };
  const p = MC.projectCampaign(serverRow);
  ck('A1  clicks survive', p.clicks === 42);
  ck('A2  views survive', p.views === 120);
  ck('A3  orders are STRIPPED', p.orders === undefined, JSON.stringify(p));
  ck('A4  revenue is STRIPPED', p.revenue === undefined);
  ck('A5  roi is STRIPPED', p.roi === undefined);

  const listed = await MC.listCampaigns({ scope: SCOPE,
    callList: async () => ({ data: { campaigns: [serverRow] } }) });
  ck('A6  the list path strips them too', listed.ok &&
    listed.campaigns[0].orders === undefined && listed.campaigns[0].roi === undefined);

  /* Decisive: the words must not exist as readable fields anywhere the surface
     could reach. A screen cannot render what it was never handed. */
  ck('A7  no stripped field survives serialisation of the whole list',
    !/\borders\b|\brevenue\b|\broi\b/.test(JSON.stringify(listed)), JSON.stringify(listed).slice(0, 120));

  ck('A8  an unknown count renders as a dash, not 0', MC.formatCount(null) === '—');
  ck('A9  a real zero renders as zero', MC.formatCount(0) === '0');

  const mkt = SRC('sokoni-merchant-marketing.js');
  ck('A10 the surface never mentions an ROI field', !/\.roi\b/.test(mkt));
  ck('A11 the surface labels the figures as traffic', /Traffic only/.test(mkt));
}

/* ═══ B — ads are account-scoped, and say so ═══ */
console.log('\nPART B — ads do not pretend to belong to a shop\n');
{
  const sc = MC.adScope();
  ck('B1  the scope is declared as account-level', sc.level === 'account');
  ck('B2  the label says so', /Account campaigns/.test(sc.label), sc.label);

  const ad = MC.buildAd({ title: 'Fresh stock', budgetKES: 2000 });
  ck('B3  the ad payload carries NO shopId', ad.shopId === undefined, JSON.stringify(ad));
  ck('B4  ...and no sellerUid either (the server takes it from auth)', ad.sellerUid === undefined);
  ck('B5  the budget is carried', ad.budgetKES === 2000);

  const bad = (fn) => { try { fn(); return false; } catch (_) { return true; } };
  ck('B6  a zero budget is refused', bad(() => MC.buildAd({ title: 'x', budgetKES: 0 })));
  ck('B7  a negative budget is refused', bad(() => MC.buildAd({ title: 'x', budgetKES: -500 })));
  ck('B8  a missing title is refused', bad(() => MC.buildAd({ title: '', budgetKES: 100 })));

  const mkt = SRC('sokoni-merchant-marketing.js');
  ck('B9  the Ads tab renders the account-scope note', /adScope\(\)/.test(mkt));
}

/* ═══ C — payloads carry the shop where the shop is the authority ═══ */
console.log('\nPART C — campaign and promotion payloads name the shop\n');
{
  const c = MC.buildCampaign({ scope: SCOPE, name: 'April sale', type: 'weekend-sale' });
  ck('C1  a campaign carries the shopId', c.shopId === SHOP_B);
  ck('C2  ...which is the SHOP, not the account', c.shopId !== SELLER_A);

  const p = MC.buildPromotion({ scope: SCOPE, title: 'Weekend 20%', type: 'flash_sale',
    discountType: 'percent', discountValue: 20, validUntil: '2026-12-01', code: 'week20' });
  ck('C3  a promotion carries the shopId', p.shopId === SHOP_B);
  ck('C4  the code is upper-cased', p.code === 'WEEK20');
  ck('C5  validUntil is sent as ISO', /^\d{4}-\d{2}-\d{2}T/.test(p.validUntil), p.validUntil);

  const other = MC.buildCampaign({ scope: scopeOf(SELLER_A, SHOP_C), name: 'Other shop sale', type: 'custom' });
  ck('C6  a different shop produces a different payload', other.shopId === SHOP_C);

  const bad = (fn) => { try { fn(); return false; } catch (_) { return true; } };
  ck('C7  an unresolved scope cannot produce a campaign',
    bad(() => MC.buildCampaign({ scope: scopeOf(SELLER_A, null), name: 'x', type: 'custom' })));
  ck('C8  a one-character name is refused', bad(() => MC.buildCampaign({ scope: SCOPE, name: 'x', type: 'custom' })));
  ck('C9  an unknown campaign type is refused', bad(() => MC.buildCampaign({ scope: SCOPE, name: 'ok', type: 'nope' })));
  ck('C10 a percentage over 100 is refused',
    bad(() => MC.buildPromotion({ scope: SCOPE, title: 'x', type: 'flash_sale', discountType: 'percent',
      discountValue: 140, validUntil: '2026-12-01' })));
  ck('C11 a promotion with no end date is refused',
    bad(() => MC.buildPromotion({ scope: SCOPE, title: 'x', type: 'flash_sale', discountType: 'percent', discountValue: 10 })));
}

/* ═══ D — the promotions list is honest about being partial ═══ */
console.log('\nPART D — the promotions list says what it is\n');
{
  const r = await MC.listPromotions({ scope: SCOPE,
    callPromos: async () => ({ data: { promotions: [{ promoId: 'p1', title: 'A', discountValue: 10 }] } }) });
  ck('D1  the list loads', r.ok && r.count === 1);
  ck('D2  ...and reports that it is ACTIVE-ONLY', r.activeOnly === true);

  const mkt = SRC('sokoni-merchant-marketing.js');
  ck('D3  the surface tells the merchant so', /active promotions only/i.test(mkt));
}

/* ═══ E — failure is failure ═══ */
console.log('\nPART E — the authority decides\n');
{
  const calls = [];
  const rec = (n, res) => async (p) => { calls.push({ n, p }); return res; };

  const created = await MC.createCampaign({ scope: SCOPE, name: 'April', type: 'custom',
    callCreate: rec('create', { data: { success: true, campaignId: 'c9', campaignUrl: 'https://x/y' } }) });
  ck('E1  a campaign is created through the server', created.ok && created.campaignId === 'c9');
  ck('E2  ...with the shop on the payload', calls[0].p.shopId === SHOP_B);

  const paused = await MC.setCampaignPaused({ campaignId: 'c9', pause: true,
    callPause: rec('pause', { data: { success: true, status: 'paused' } }) });
  ck('E3  pause goes through pauseMinishopCampaign', paused.ok && calls[1].p.pause === true);

  const denied = await MC.deleteCampaign({ campaignId: 'c9',
    callDelete: async () => { const e = new Error('Not your shop'); e.code = 'permission-denied'; throw e; } });
  ck('E4  a refusal is reported with the server\'s words', denied.ok === false && /Not your shop/.test(denied.error));
  ck('E5  ...and its code', denied.code === 'permission-denied');

  const down = await MC.listCampaigns({ scope: SCOPE, callList: async () => { throw new Error('offline'); } });
  ck('E6  a failed read is a failure, not an empty list',
    down.ok === false && down.campaigns === undefined);
}

/* ═══ F — the hardening ═══ */
console.log('\nPART F — delete and pause now authorise on the SHOP\n');
{
  const fn = CODE('functions/minishop-campaigns.js');
  const slice = (name, next) => fn.slice(fn.indexOf('exports.' + name), next ? fn.indexOf('exports.' + next) : undefined);

  const del = slice('deleteMinishopCampaign');
  const pause = slice('pauseMinishopCampaign', 'deleteMinishopCampaign');

  ck('F1  delete reads the campaign then asserts on its shop',
    /_assertShopOwner\(db, docSnap\.data\(\)\.shopId, uid\)/.test(del));
  ck('F2  pause reads the campaign then asserts on its shop',
    /_assertShopOwner\(db, docSnap\.data\(\)\.shopId, uid\)/.test(pause));
  ck('F3  neither authorises on the campaign CREATOR any more',
    !/docSnap\.data\(\)\.uid !== uid/.test(del) && !/docSnap\.data\(\)\.uid !== uid/.test(pause));
  ck('F4  the shared rule reads the shop document', /collection\('shops'\)\.doc\(shopId\)/.test(fn));
  ck('F5  ...and compares sellerUid, the field create/read already used',
    /shopSnap\.data\(\)\.sellerUid !== uid/.test(fn));
  ck('F6  create and read use the SAME helper (one rule per module)',
    (fn.match(/await _assertShopOwner\(db, shopId, uid\)/g) || []).length === 2);
  ck('F7  every refusal is an HttpsError, so a client can read the code',
    !/new Error\(/.test(fn), (fn.match(/new Error\([^)]*/g) || []).join(','));
  ck('F8  the wider ownerId/ownerUid divergence is NOT pulled in here',
    !/ownerUid|\.ownerId/.test(fn));

  /* Mutation control: the assertion must be removable, or F1/F2 prove nothing. */
  const mutated = del.replace(/await _assertShopOwner\(db, docSnap\.data\(\)\.shopId, uid\);/, '');
  ck('F9  the assertion is a real line that can be removed (control)', mutated !== del);
}

/* ═══ G — blocked capabilities are shown, not hidden ═══ */
console.log('\nPART G — the edge of what works is visible\n');
{
  const ids = MC.UNAVAILABLE.map((u) => u.id);
  ck('G1  bundles are declared unavailable', ids.indexOf('bundles') >= 0);
  ck('G2  A/B tests are declared unavailable', ids.indexOf('abtests') >= 0);
  ck('G3  engine coupon codes are declared unavailable', ids.indexOf('coupons_engine') >= 0);
  ck('G4  per-campaign conversions are declared unavailable', ids.indexOf('conversions') >= 0);
  ck('G5  every one carries a reason', MC.UNAVAILABLE.every((u) => u.why && u.why.length > 20));

  const mkt = SRC('sokoni-merchant-marketing.js');
  ck('G6  the surface renders them as "not available yet"', /Not available yet/.test(mkt));

  /* None of the eleven blocked engine callables may be reachable. */
  const ENGINE = ['createBundleDeal', 'getActiveBundleDeals', 'createFlashSale', 'getFlashSalePrice',
    'recordFlashSalePurchase', 'getCrossSellRecommendations', 'getUpsellRecommendations',
    'createMarketingCampaign', 'runABTest', 'recordABTestImpression', 'applyCouponCode'];
  const merchantPath = SRC('merchant.html') + SRC('sokoni-merchant-campaigns.js') + mkt;
  const leaked = ENGINE.filter((n) => new RegExp("['\"]" + n + "['\"]").test(merchantPath));
  ck('G7  no blocked engine callable is bound anywhere in the merchant path',
    leaked.length === 0, leaked.join(','));
  ck('G8  the client layer names only the eight SAFE authorities',
    Object.values(MC.CALLABLES).length === 8 &&
    Object.values(MC.CALLABLES).every((n) => !ENGINE.includes(n)),
    Object.values(MC.CALLABLES).join(','));
}

/* ═══ H — merchant-path invariants ═══ */
console.log('\nPART H — nothing local, nothing removed\n');
{
  const camp = CODE('sokoni-merchant-campaigns.js');
  const mkt = CODE('sokoni-merchant-marketing.js');
  ck('H1  no localStorage in either module', !/localStorage/.test(camp + mkt));
  /* The detector must be able to fail, or H1-H3 prove nothing. */
  ck('H0  the stripper keeps CODE while dropping prose (control)',
    /localStorage.setItem/.test(code('/* mentions localStorage */ localStorage.setItem("k","v");')) &&
    !/mentions/.test(code('/* mentions localStorage */ localStorage.setItem("k","v");')));
  ck('H2  no Firestore write primitive', !/\b(deleteDoc|setDoc|updateDoc|addDoc|writeBatch)\s*\(/.test(camp + mkt));
  ck('H3  no inline on* handler built from data',
    !/\son(click|input|change|submit)\s*=\s*(\\?["'])/.test(camp + mkt));

  const C = require(path.join(ROOT, 'sokoni-merchant-routes.js'));
  ck('H4  the route contract still validates', C.validate().length === 0, C.validate().join(' | '));
  ck('H5  Marketing is a NATIVE route', C.get('marketing').kind === 'native');
  ck('H6  ...so no seller.html iframe is required', !C.get('marketing').sec && !C.get('marketing').src);
  ck('H7  Marketing still requires a resolved shop', C.get('marketing').ctx.indexOf('shopId') >= 0);

  const EXPECTED = ['dashboard','plan','sell','products','inventory','pos','orders','analytics','revenue',
    'payments','deliveries','returns','receipts','staff','messages','disputes','settings','marketing'];
  ck('H8  every merchant destination is still present',
    EXPECTED.every((id) => !!C.get(id)), EXPECTED.filter((id) => !C.get(id)).join(','));
  ck('H9  POS, Sell, Inventory and Staff are untouched',
    C.get('pos').kind === 'pos' && C.get('sell').kind === 'native' &&
    C.get('inventory').kind === 'native' && C.get('staff').kind === 'native');

  const shell = SRC('merchant.html');
  ck('H10 the shell loads both new modules',
    /sokoni-merchant-campaigns\.js/.test(shell) && /sokoni-merchant-marketing\.js/.test(shell));
  ck('H11 the shell has a renderer for Marketing', /id === 'marketing'\) renderMarketing\(\)/.test(shell));
  ck('H12 the shell binds only SAFE authorities',
    /callList:\s*_callable\('getMinishopCampaigns'\)/.test(shell) &&
    /callDelete:\s*_callable\('deleteMinishopCampaign'\)/.test(shell) &&
    /callCreateAd:\s*_callable\('createAdCampaign'\)/.test(shell));
}

console.log('\n' + '='.repeat(70));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error(e); process.exit(1); });
