'use strict';
/* The server's tier rule (functions/shared/pos-price-tier.js) re-validates what the uploader checks in the browser
   (owner, 2026-10-01): the rules do not check tier values, so a product written directly must not be able to sell
   at an out-of-order, oversized, negative or string price. Pure; no Firestore.
     node scripts/test-pos-price-tier-rule.js */
const path = require('path');
const T = require(path.join(__dirname, '..', 'functions', 'shared', 'pos-price-tier.js'));
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok ? '' : '   [got ' + JSON.stringify(got) + ']')); ok ? pass++ : fail++; };
const r = (p, t) => { const x = T.resolveTierPrice(p, t); return x.ok ? x.price : x.reason; };
console.log('\nPOS price tier rule\n');
ck('V-1', r({ price: 100, shopPrice: 90, wholesalePrice: 80 }, 'shop') === 90 && r({ price: 100, shopPrice: 90, wholesalePrice: 80 }, 'wholesale') === 80, 'a well-ordered product sells each tier at its own price');
ck('V-2', r({ price: 100, shopPrice: 120 }, 'shop') === 'tier_not_configured', 'shop above online is refused (owner: shop sits between)', r({ price: 100, shopPrice: 120 }, 'shop'));
ck('V-3', r({ price: 100, wholesalePrice: 100 }, 'wholesale') === 'tier_not_configured', 'wholesale must be BELOW online', r({ price: 100, wholesalePrice: 100 }, 'wholesale'));
ck('V-4', r({ price: 100, shopPrice: 70, wholesalePrice: 80 }, 'shop') === 'tier_not_configured' && r({ price: 100, shopPrice: 70, wholesalePrice: 80 }, 'wholesale') === 'tier_not_configured', 'wholesale above shop: neither ambiguous tier sells');
ck('V-5', r({ price: 2e9, shopPrice: 1.5e9 }, 'shop') === 'tier_not_configured' && T.MAX_PRICE === 1e9, 'a tier above KES 1,000,000,000 (the writer\'s cap) is refused');
ck('V-6', r({ price: 100, shopPrice: '90' }, 'shop') === 'tier_not_configured', 'a STRING tier price is never authoritative');
ck('V-7', r({ price: 100, shopPrice: -5 }, 'shop') === 'tier_not_configured' && r({ price: 100, shopPrice: 0 }, 'shop') === 'tier_not_configured' && r({ price: 100, shopPrice: NaN }, 'shop') === 'tier_not_configured', 'negative / zero / NaN tiers are not configured (never free)');
ck('V-8', r({ price: 100 }, 'shop') === 'tier_not_configured' && r({ price: 100 }, 'wholesale') === 'tier_not_configured', 'an absent tier is NOT AVAILABLE, never 0 and never the online price');
ck('V-9', r({ price: 100, salePrice: 95 }, 'online') === 95 && r({ price: 100 }, undefined) === 100, 'ONLINE keeps the historical salePrice || price meaning (no existing sale changes)');
ck('V-10', r({ price: 100 }, 'Shop') === 'unsupported_tier' && r({ price: 100 }, 'vip') === 'unsupported_tier', 'tier names are exact: anything else is unsupported');
ck('V-11', T.productBelongsTo({ shopId: 'S1' }, ['S1', null]) && !T.productBelongsTo({ shopId: 'S2', sellerUid: 'S1' }, ['S1']) && T.productBelongsTo({ sellerUid: 'S1' }, ['S1']) && !T.productBelongsTo({}, ['S1']) && !T.productBelongsTo({ shopId: 'S1' }, [null, undefined]), 'ownership: shopId decides; sellerUid only for legacy products; an ownerless product never matches');
console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
