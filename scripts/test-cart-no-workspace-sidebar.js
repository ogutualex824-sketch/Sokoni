'use strict';
/* Shopping pages get the SHOPPER chrome for every role (owner, 2026-10-01: "fix cart page — it opens the sidebar of
   super admin … cart should only show cart"). Runs the REAL _role/_workspace from sokoni-nav-engine.js.
     node scripts/test-cart-no-workspace-sidebar.js
     BASE=72dca56 node scripts/test-cart-no-workspace-sidebar.js   (live must FAIL) */
const fs = require('fs'), path = require('path'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const src = process.env.BASE ? execSync('git show ' + process.env.BASE + ':sokoni-nav-engine.js', { cwd: ROOT, encoding: 'utf8' })
                             : fs.readFileSync(path.join(ROOT, 'sokoni-nav-engine.js'), 'utf8');
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok ? '' : '   [got ' + got + ']')); ok ? pass++ : fail++; };
const grab = (re) => (src.match(re) || [''])[0];
const body = [grab(/var _WS_MAP = \{[\s\S]*?\n  \};/), grab(/var _CONSUMER_PAGES = \[[\s\S]*?\];/),
  grab(/function _role\(\) \{[\s\S]*?\n  \}/), grab(/function _workspace\(\) \{[\s\S]*?\n  \}/)].join('\n');
const ws = (page, user) => {
  const ls = { getItem: () => (user ? JSON.stringify(user) : null) };
  try { return new Function('_page', 'localStorage', body + '\nreturn _workspace();')(page, ls); } catch (e) { return 'THREW ' + e.message; }
};
const SA = { roles: ['buyer', 'superAdmin'] }, AD = { roles: ['buyer', 'admin'] }, SE = { roles: ['buyer', 'seller'] }, BU = { roles: ['buyer'] };
console.log('\nShopping pages = shopper chrome   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
ck('C-1', ws('cart', SA) === 'buyer', 'a SUPER ADMIN on the cart gets the buyer layout (no Super Admin sidebar)', ws('cart', SA));
ck('C-2', ws('cart', AD) === 'buyer' && ws('cart', SE) === 'buyer', 'an admin or a seller on the cart gets the buyer layout too', ws('cart', AD) + '/' + ws('cart', SE));
ck('C-3', ['index', 'checkout', 'product', 'category', 'wishlist', 'my-orders', 'track'].every((p) => ws(p, SA) === 'buyer'), 'every core shopping page is the shopper\'s, whatever the role');
ck('C-4', ws('cart', BU) === 'buyer' && ws('cart', null) === 'buyer', 'buyers and signed-out visitors are unchanged');
/* "fix all" (owner 2026-10-01): the map is the authority — keys carry '.html', _page does not, and it never matched */
const DR = { roles: ['buyer', 'driver'] }, PR = { roles: ['buyer', 'provider'] };
ck('M-1', ws('super-admin', SA) === 'superAdmin' && ws('admin-os', AD) === 'admin' && ws('pos', SE) === 'seller',
  'mapped workspace pages now MATCH (super-admin → Super Admin, admin-os → Admin, pos → Seller)', [ws('super-admin', SA), ws('admin-os', AD), ws('pos', SE)].join('/'));
ck('M-2', ws('pos', SA) === 'seller' && ws('messages', SA) === 'seller', 'an operator on a SELLER page gets the seller workspace (the page decides, not the role)', ws('pos', SA));
ck('M-3', ws('help', SA) === 'buyer' && ws('help', SE) === 'buyer' && ws('help', AD) === 'buyer', 'an unmapped generic page shows NO console sidebar for seller / admin / super admin', ws('help', SA));
ck('M-4', ws('finance-expenses', SE) === 'seller' && ws('settlement-dashboard', SA) === 'superAdmin' && ws('legal-admin', AD) === 'admin' && ws('rider-dashboard', DR) === 'rider',
  'the operator pages that had NO entry are classified (finance-* seller, settlement Super Admin, legal-admin Admin, rider-dashboard Rider)');
ck('M-5', ws('seller-public', SA) === 'buyer' && ws('subscriptions', SE) === 'buyer' && ws('trust', AD) === 'buyer', 'public pages that only LOOK operator-ish are the shopper\'s');
ck('M-6', ws('driver', BU) === 'buyer' && ws('venue-booking', BU) === 'buyer' && ws('driver', DR) === 'driver' && ws('venue-booking', PR) === 'provider',
  'a SHOPPER on a driver/provider page no longer gets that console; the driver / provider still do');
ck('M-7', ws('super-admin', AD) === 'admin' && ws('super-admin', SE) === 'buyer' && ws('admin-os', BU) === 'buyer', 'entitlement still applies: an admin on a Super Admin page gets Admin; a seller or buyer gets nothing');
console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
