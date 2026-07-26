#!/usr/bin/env node
'use strict';

/**
 * End-to-end verification of the MiniShop public sharing chain.
 *
 *   node scripts/verify-minishop-share.js <handle> [--origin https://...]
 *
 * Checks everything a shared link depends on, in the order a WhatsApp crawler
 * hits it, and reports each step separately so a failure names its own cause:
 *
 *   1. the handle resolves at all
 *   2. getMinishopPublic returns the shop and a RESOLVED config
 *      (this is the step that proves the schema convergence works on live data)
 *   3. /shop/{handle} is served by the prerenderer, not the static shell
 *   4. the OG tags name THIS shop rather than the generic fallback
 *   5. the og:image is the shop's own image, and actually loads
 *   6. the storefront markup survived meta injection intact
 *
 * What it cannot check: how WhatsApp visually renders the card, and whether the
 * crawler has a stale copy cached. Those need a human with a phone. Everything
 * upstream of them is covered here.
 *
 * Exit code is non-zero if any REQUIRED check fails, so it can gate a release.
 */

const HANDLE = process.argv[2];
const originArg = process.argv.indexOf('--origin');
const ORIGIN = originArg > -1 ? process.argv[originArg + 1] : 'https://mysokoni.co.ke';
const CF = 'https://us-central1-sokoni-aeb26.cloudfunctions.net';

const FALLBACK_IMAGE = '/assets/logosokoni.png';
const GENERIC_TITLES = ['Shop on SOKONI', 'Shop not found — SOKONI', 'SOKONI'];

if (!HANDLE) {
  console.error('usage: node scripts/verify-minishop-share.js <handle> [--origin URL]');
  console.error('  e.g. node scripts/verify-minishop-share.js kass-shop');
  process.exit(2);
}

let required = 0, requiredPass = 0, warnings = 0;
const step = (n) => console.log('\n\x1b[1m' + n + '\x1b[0m');
const ok = (name, cond, detail) => {
  required++;
  if (cond) { requiredPass++; console.log('  \x1b[32m✓\x1b[0m', name); }
  else console.log('  \x1b[31m✗\x1b[0m', name, detail ? '\n      ' + detail : '');
};
const warn = (name, cond, detail) => {
  if (cond) console.log('  \x1b[32m✓\x1b[0m', name);
  else { warnings++; console.log('  \x1b[33m!\x1b[0m', name, detail ? '\n      ' + detail : ''); }
};

const meta = (html, prop) => {
  const re = new RegExp('<meta[^>]+(?:property|name)="' + prop + '"[^>]+content="([^"]*)"', 'i');
  const m = html.match(re);
  return m ? m[1] : null;
};

(async () => {
  console.log(`Verifying MiniShop share chain for @${HANDLE}`);
  console.log(`Origin: ${ORIGIN}`);

  /* ── 1. Public data ────────────────────────────────────────────────────── */
  step('1. getMinishopPublic — data layer');
  let data = null;
  try {
    const res = await fetch(`${CF}/getMinishopPublic?handle=${encodeURIComponent(HANDLE)}`);
    ok('endpoint reachable', res.status !== 0, `status ${res.status}`);
    if (res.status === 404) {
      console.log(`\n  \x1b[31mHandle "@${HANDLE}" is not claimed.\x1b[0m Claim it in the MiniShop admin first.`);
      process.exit(1);
    }
    ok('returns 200', res.ok, `status ${res.status}`);
    data = await res.json();
  } catch (e) {
    ok('endpoint reachable', false, e.message);
    process.exit(1);
  }

  const shop = data.shop || {};
  const cfg  = data.config || {};
  const shopName = shop.name || shop.shopName || shop.businessName || '';

  ok('shop document returned', !!shop.id, JSON.stringify(shop).slice(0, 120));
  ok('shop has a name', !!shopName, 'name/shopName/businessName all empty');
  ok('legacy config blob is NOT echoed', !('minishopConfig' in shop),
     'shops.minishopConfig leaked into the public payload');
  ok('sensitive fields stripped',
     !('sellerUid' in shop) && !('bankDetails' in shop) && !('taxPin' in shop),
     Object.keys(shop).filter(k => ['sellerUid','bankDetails','taxPin'].includes(k)).join(', '));

  /* The convergence check: branding must come back under canonical names
     regardless of which store the seller's data actually lives in. */
  warn('config resolves a cover image', !!cfg.coverUrl, 'no coverUrl — seller may not have uploaded one');
  warn('config resolves a logo',        !!cfg.logoUrl,  'no logoUrl — seller may not have uploaded one');
  warn('config resolves a description/tagline', !!(cfg.description || cfg.tagline), 'neither set');
  ok('no legacy key names in resolved config',
     !('coverImage' in cfg) && !('logoImage' in cfg) && !('phone' in cfg) && !('accentColor' in cfg),
     Object.keys(cfg).filter(k => ['coverImage','logoImage','phone','accentColor'].includes(k)).join(', '));

  /* ── 2. Prerendered page ───────────────────────────────────────────────── */
  step('2. /shop/{handle} — prerenderer');
  let html = '', status = 0, cacheControl = '';
  try {
    const res = await fetch(`${ORIGIN}/shop/${encodeURIComponent(HANDLE)}`, {
      headers: { 'User-Agent': 'WhatsApp/2.23.20 (Mozilla/5.0)' },
      redirect: 'follow',
    });
    status = res.status;
    cacheControl = res.headers.get('cache-control') || '';
    html = await res.text();
  } catch (e) {
    ok('page reachable', false, e.message);
    process.exit(1);
  }

  ok('returns 200', status === 200, `status ${status}`);
  ok('served by the prerenderer, not the static shell',
     !!meta(html, 'og:url'), 'no og:url — the rewrite may be pointing at minishop.html again');
  ok('publicly cacheable', /public/.test(cacheControl), `Cache-Control: ${cacheControl || '(none)'}`);
  ok('storefront markup intact after meta injection',
     html.includes('sokoni-minishop.js') && html.includes('</html>'),
     'the template lost its scripts — injectMeta may have corrupted the head');
  ok('exactly one <title>', (html.match(/<title>/g) || []).length === 1,
     `found ${(html.match(/<title>/g) || []).length}`);

  /* ── 3. The card itself ────────────────────────────────────────────────── */
  step('3. Open Graph card — what a recipient actually sees');
  const ogTitle = meta(html, 'og:title');
  const ogDesc  = meta(html, 'og:description');
  const ogImage = meta(html, 'og:image');
  const ogUrl   = meta(html, 'og:url');

  console.log(`      title: ${ogTitle}`);
  console.log(`      desc : ${(ogDesc || '').slice(0, 78)}`);
  console.log(`      image: ${ogImage}`);
  console.log(`      url  : ${ogUrl}`);

  ok('og:title present', !!ogTitle);
  ok('og:title is NOT the generic fallback', !GENERIC_TITLES.includes((ogTitle || '').trim()),
     `"${ogTitle}" — the crawler would show the same card for every shop`);
  ok('og:title names this shop', !!shopName && (ogTitle || '').includes(shopName),
     `expected "${shopName}" inside "${ogTitle}"`);
  ok('og:description present and specific', !!ogDesc && ogDesc.length > 10);
  ok('og:url points at this shop', (ogUrl || '').endsWith('/shop/' + HANDLE), ogUrl);

  const usingFallbackImage = (ogImage || '').includes(FALLBACK_IMAGE);
  if (cfg.coverUrl || cfg.logoUrl) {
    ok('og:image is the shop\'s own image, not the SOKONI logo', !usingFallbackImage,
       'config has a cover/logo but the card still uses the fallback — resolve() is not reaching it');
  } else {
    warn('og:image falls back to the SOKONI logo', usingFallbackImage,
         'seller has uploaded neither cover nor logo, so this is expected');
  }

  /* An og:image that 404s renders as a blank card, which looks worse than the
     fallback logo — so the URL is followed, not just inspected. */
  if (ogImage) {
    try {
      const r = await fetch(ogImage, { method: 'GET', headers: { Range: 'bytes=0-0' } });
      const ct = r.headers.get('content-type') || '';
      ok('og:image actually loads', r.ok || r.status === 206, `status ${r.status}`);
      ok('og:image is an image', ct.startsWith('image/'), `content-type: ${ct}`);
    } catch (e) {
      ok('og:image actually loads', false, e.message);
    }
  }

  /* ── Summary ───────────────────────────────────────────────────────────── */
  const failed = required - requiredPass;
  console.log(`\n${requiredPass}/${required} required checks passed` +
              (warnings ? `, ${warnings} warning(s)` : ''));

  if (!failed) {
    console.log('\n\x1b[32mThe share chain is correct end to end.\x1b[0m');
    console.log('Remaining manual step: paste the link into WhatsApp and confirm the card renders.');
    console.log('If it shows a stale card, WhatsApp has cached it — try a fresh URL with ?v=2.');
  }
  process.exit(failed ? 1 : 0);
})();
