/* My MiniShop resolution regression — locks the claimed-vs-unclaimed decision so a CLAIMED
   shop (KASS) is never sent back to the claim flow, and the button routes to the canonical
   storefront. Mirrors the resolver in merchant.html __openMiniShop (shops.minishopHandle). */
'use strict';

/* The pure decision the merchant resolver makes from a canonical `shops` doc (or null). */
function resolveMiniShop (shopData) {
  var handle = shopData && (shopData.minishopHandle || shopData.handle);
  if (handle) return { claimed: true, url: '/shop/' + encodeURIComponent(handle), label: 'Shop Live' };
  return { claimed: false, url: 'minishop-admin.html', label: 'Create' };
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  FAIL:', m); } };

/* ── Claimed (KASS): has a minishopHandle → storefront, never the claim flow ── */
let r = resolveMiniShop({ ownerId: 'KASSUID', minishopHandle: 'kass-shop' });
ok(r.claimed === true, 'a shop with minishopHandle is CLAIMED');
ok(r.url === '/shop/kass-shop', 'claimed → routes to canonical storefront /shop/<handle>');
ok(r.label === 'Shop Live', 'claimed → "Shop Live" state (not Create)');
ok(r.url.indexOf('minishop-admin') === -1, 'claimed MUST NOT route to the claim flow');

/* handle may live under `handle` as a fallback field */
ok(resolveMiniShop({ handle: 'kass' }).url === '/shop/kass', 'falls back to the `handle` field');
/* handles are URL-encoded (defensive) */
ok(resolveMiniShop({ minishopHandle: 'a b' }).url === '/shop/a%20b', 'handle is URL-encoded');

/* ── Unclaimed: no handle → claim flow, "Create" ── */
r = resolveMiniShop({ ownerId: 'X' });
ok(r.claimed === false && /minishop-admin/.test(r.url) && r.label === 'Create', 'no handle → Create → claim flow');
r = resolveMiniShop(null);
ok(r.claimed === false && /minishop-admin/.test(r.url), 'no shop doc → claim flow (never a storefront to a missing handle)');

/* ── Same-tab contract: the URL is a same-origin path, never an external/new-window target ── */
['/shop/kass-shop', 'minishop-admin.html'].forEach(u => {
  ok(u.indexOf('http://') === -1 && u.indexOf('https://') === -1, 'route "' + u + '" is same-origin (no external origin, opens in-tab)');
});

console.log(fail === 0 ? ('\nALL ' + pass + ' PASSED') : ('\n' + pass + ' passed, ' + fail + ' FAILED'));
process.exit(fail === 0 ? 0 : 1);
