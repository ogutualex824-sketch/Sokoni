#!/usr/bin/env node
/* Merchant Store — the client layer and the identity boundary (2D-2 Stage 2).
 *
 *   node scripts/test-merchant-store.js
 *
 * FIXTURE: SELLER_A (account) owns SHOP_B. SHOP_C belongs to someone else.
 *
 * The properties this suite holds:
 *
 *   1. The shopId is LEARNED from getMyMinishop, never taken from the shell,
 *      the URL, or defaulted to the uid. An account with no shop gets an honest
 *      answer, not a screen scoped to a guess.
 *   2. The follower count has ONE source. The layer never counts followers and
 *      never caches the number — a second computation would be a second
 *      authority, which Store Stage 1B just removed.
 *   3. claimMinishopHandle is sent NO shopId, because it resolves the shop
 *      itself and passing one would invite a caller to name another shop.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MD = require(path.join(ROOT, 'sokoni-merchant-data.js'));
const ST = require(path.join(ROOT, 'sokoni-merchant-store.js'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 140) + ']' : ''));
  ok ? pass++ : fail++;
};

const SELLER_A = 'SELLER_A_uid_7f3';
const SHOP_B = 'SHOP_B_shop_91c';
const SHOP_C = 'SHOP_C_shop_42x';
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

(async () => {

/* ═══ A — the shopId is learned, never assumed ═══ */
console.log('\nPART A — the server says which shop this is\n');
{
  const calls = [];
  const id = await ST.loadIdentity({ callIdentity: async (p) => { calls.push(p); return { data: {
    shopId: SHOP_B, handle: 'bshop', hasHandle: true, url: 'https://mysokoni.co.ke/shop/bshop',
    config: { tagline: 'Best in town' } } }; } });
  ck('A1  identity comes from getMyMinishop', id.ok && id.shopId === SHOP_B);
  ck('A2  ...and the call sends NOTHING — no shopId to influence', JSON.stringify(calls[0]) === '{}', JSON.stringify(calls[0]));
  ck('A3  the handle and url come with it', id.handle === 'bshop' && id.hasShop === true);

  const none = await ST.loadIdentity({ callIdentity: async () => ({ data: { shopId: null, handle: null, config: null, url: null } }) });
  ck('A4  an account with no shop reports hasShop:false', none.ok && none.hasShop === false && none.shopId === null);
  ck('A5  ...and the shopId is NOT defaulted to anything', none.shopId === null);

  const layer = CODE('sokoni-merchant-store.js');
  const ui = CODE('sokoni-merchant-store-ui.js');
  ck('A6  neither module reads activeShopId', !/activeShopId/.test(layer + ui));
  ck('A7  neither module reads the URL for a shop', !/location\.search|URLSearchParams|location\.hash/.test(layer + ui));
  ck('A8  neither module falls back to the uid as a shop',
    !/shopId\s*=\s*(uid|sellerUid)|shopId\s*\|\|\s*(uid|sellerUid)/.test(layer + ui));

  const shell = CODE('merchant.html');
  ck('A9  the shell passes NO shopId into the Store surface',
    !/SokoniMerchantStoreUI\.mount\([^)]*shopId/.test(shell.replace(/\s+/g, ' ')));
}

/* ═══ B — the handle claim carries no shopId ═══ */
console.log('\nPART B — claimMinishopHandle resolves its own shop\n');
{
  const claim = ST.buildHandleClaim({ handle: '  My-Shop  ' });
  ck('B1  the payload is the handle ALONE', Object.keys(claim).join(',') === 'handle', JSON.stringify(claim));
  ck('B2  ...normalised to lowercase and trimmed', claim.handle === 'my-shop');
  ck('B3  no shopId is sent, so no caller can name another shop', claim.shopId === undefined);

  const bad = (h) => ST.handleProblem(h);
  ck('B4  an empty handle is refused', !!bad(''));
  ck('B5  a two-character handle is refused', !!bad('ab'));
  ck('B6  a 31-character handle is refused', !!bad('x'.repeat(31)));
  ck('B7  spaces are refused', !!bad('my shop'));
  ck('B8  capitals normalise rather than fail', bad('MyShop') === null);
  ck('B9  a valid handle passes', bad('my-shop_2') === null);
}

/* ═══ C — SELLER_A/SHOP_B allowed, SHOP_C denied ═══ */
console.log('\nPART C — the server decides, and refusals surface\n');
{
  const calls = [];
  const okSave = await ST.saveConfig({ shopId: SHOP_B, config: { tagline: 'New' },
    callSave: async (p) => { calls.push(p); return { data: { success: true } }; } });
  ck('C1  a save carries the resolved shopId', okSave.ok && calls[0].shopId === SHOP_B);
  ck('C2  ...and only the canonical config fields', Object.keys(calls[0].config).join(',') === 'tagline');

  const denied = await ST.saveConfig({ shopId: SHOP_C, config: { tagline: 'x' },
    callSave: async () => { const e = new Error('You do not own this shop.'); e.code = 'permission-denied'; throw e; } });
  ck('C3  SHOP_C is refused, in the server\'s words',
    denied.ok === false && /do not own this shop/.test(denied.error));
  ck('C4  ...with the server code', denied.code === 'permission-denied');

  const analytics = await ST.loadAnalytics({ shopId: SHOP_C,
    callAnalytics: async () => { const e = new Error('You do not own this shop.'); e.code = 'permission-denied'; throw e; } });
  ck('C5  analytics for another shop are refused', analytics.ok === false);
  ck('C6  ...and no figures come back', analytics.followerCount === undefined);

  const down = await ST.loadIdentity({ callIdentity: async () => { throw new Error('offline'); } });
  ck('C7  a failed identity read is a failure, not "no shop"',
    down.ok === false && down.hasShop === undefined);
}

/* ═══ D — one follower count, from the authority ═══ */
console.log('\nPART D — the count is read, never computed\n');
{
  const a = await ST.loadAnalytics({ shopId: SHOP_B,
    callAnalytics: async () => ({ data: { shopId: SHOP_B, followerCount: 7, analytics: { views: 120, visits: 45 } } }) });
  ck('D1  the follower count comes from getMinishopAnalytics', a.ok && a.followerCount === 7);
  ck('D2  a genuine zero is preserved as 0',
    (await ST.loadAnalytics({ shopId: SHOP_B, callAnalytics: async () => ({ data: { followerCount: 0, analytics: {} } }) })).followerCount === 0);
  ck('D3  a MISSING count is null, not 0',
    (await ST.loadAnalytics({ shopId: SHOP_B, callAnalytics: async () => ({ data: { analytics: {} } }) })).followerCount === null);
  ck('D4  ...and renders as a dash', ST.formatCount(null) === '—');
  ck('D5  a real zero renders as zero', ST.formatCount(0) === '0');

  const layer = CODE('sokoni-merchant-store.js');
  const ui = CODE('sokoni-merchant-store-ui.js');
  ck('D6  the layer never reads the follower relationship itself',
    !/shopFollowers/.test(layer + ui));
  ck('D7  ...and never calls followShop', !/followShop/.test(layer + ui));
  ck('D8  no second count is computed anywhere',
    !/followerCount\s*(\+\+|\+=|=\s*\w+\.length)/.test(layer + ui));
}

/* ═══ E — the storefront follow-state read is on the ONE relationship ═══ */
console.log('\nPART E — the storefront reads the authority\n');
{
  const ms = SRC('sokoni-minishop.js');
  ck('E1  the follow-state read uses the FLAT relationship document',
    /shopFollowers\/\$\{_state\.shopId\}_\$\{user\.uid\}/.test(ms));
  ck('E2  ...and the subcollection path is gone',
    !/shopFollowers\/\$\{_state\.shopId\}\/followers\//.test(ms));

  /* The path it now reads must be the one followShop writes. */
  const mods = SRC('functions/minishop.js');
  ck('E3  followShop writes exactly that document',
    /collection\('shopFollowers'\)\.doc\(`\$\{shopId\}_\$\{uid\}`\)/.test(mods));
  /* Asserted on the ACCESS EXPRESSION, not on a count of the word.
     The fix documents the path it replaced, so the file mentions shopFollowers
     three times while reaching it once — and a comment-stripper is the wrong
     tool here, because this file desynchronises one (a regex literal containing
     a quote is enough). Matching `.doc(...)` calls is exact and needs no
     tokenizer. */
  const docCalls = (ms.match(/\.doc\(`shopFollowers\/[^`]*`\)/g) || []);
  ck('E4  exactly one shopFollowers document is ever read',
    docCalls.length === 1, docCalls.join(' | '));
  ck('E5  ...and it is the flat relationship, not a subcollection',
    docCalls.length === 1 && /_\$\{user\.uid\}`\)$/.test(docCalls[0]) && docCalls[0].indexOf('/followers/') === -1,
    docCalls[0]);
}

/* ═══ F — config payloads ═══ */
console.log('\nPART F — only canonical fields, only what changed\n');
{
  const changed = ST.changedFields({ tagline: 'Old', location: 'Nairobi' }, { tagline: 'New', location: 'Nairobi' });
  ck('F1  only the changed field is sent', Object.keys(changed).join(',') === 'tagline');
  ck('F2  ...with its new value', changed.tagline === 'New');
  ck('F3  no change means no payload', Object.keys(ST.changedFields({ tagline: 'a' }, { tagline: 'a' })).length === 0);

  const bad = (fn) => { try { fn(); return false; } catch (_) { return true; } };
  ck('F4  a save with no resolved shopId is refused',
    bad(() => ST.buildConfig({ config: { tagline: 'x' } })));
  ck('F5  a save with no changes is refused',
    bad(() => ST.buildConfig({ shopId: SHOP_B, config: {} })));
  ck('F6  an over-length field is refused with the field named',
    bad(() => ST.buildConfig({ shopId: SHOP_B, config: { tagline: 'x'.repeat(201) } })));

  /* PROTECTED_FIELDS is the server's guarantee; the client must not even try. */
  const p = ST.buildConfig({ shopId: SHOP_B, config: { tagline: 'ok', sellerUid: 'HACK', followerCount: 999, verified: true } });
  ck('F7  ownership, standing and counters are never put in the payload',
    p.config.sellerUid === undefined && p.config.followerCount === undefined && p.config.verified === undefined,
    JSON.stringify(p.config));
  ck('F8  the server also refuses them — PROTECTED_FIELDS lists each',
    /'sellerUid', 'ownerId', 'uid'/.test(SRC('functions/minishop-config-schema.js')) &&
    /'totalProducts', 'followerCount'/.test(SRC('functions/minishop-config-schema.js')));
}

/* ═══ G — merchant path and routing ═══ */
console.log('\nPART G — native, nothing local, nothing removed\n');
{
  const layer = CODE('sokoni-merchant-store.js');
  const ui = CODE('sokoni-merchant-store-ui.js');
  ck('G1  no localStorage in either module', !/localStorage/.test(layer + ui));
  ck('G2  no Firestore access at all',
    !/\b(collection|doc|getDocs|setDoc|updateDoc|deleteDoc|addDoc)\s*\(/.test(layer + ui));
  ck('G3  no inline on* handler built from data',
    !/\son(click|input|change|submit)\s*=\s*(\\?["'])/.test(layer + ui));

  const C = require(path.join(ROOT, 'sokoni-merchant-routes.js'));
  ck('G4  the route contract still validates', C.validate().length === 0, C.validate().join(' | '));
  ck('G5  Shop Details is a NATIVE route', C.get('shop').kind === 'native');
  ck('G6  ...so no seller.html iframe is required', !C.get('shop').sec && !C.get('shop').src);
  ck('G7  #store still resolves to it (no bookmark broken)', C.resolve('store') === 'shop');

  const EXPECTED = ['dashboard','plan','sell','products','inventory','pos','orders','analytics','revenue',
    'payments','deliveries','returns','receipts','staff','messages','disputes','settings','marketing','customers','shop'];
  ck('G8  every merchant destination is still present',
    EXPECTED.every((id) => !!C.get(id)), EXPECTED.filter((id) => !C.get(id)).join(','));
  ck('G9  POS and every native surface built so far are untouched',
    C.get('pos').kind === 'pos' && ['sell','inventory','staff','marketing','disputes','messages','customers']
      .every((id) => C.get(id).kind === 'native'));
  ck('G10 the bottom nav still has exactly four entries', C.BOTTOM_NAV.length === 4);

  const shell = SRC('merchant.html');
  ck('G11 the shell loads both new modules',
    /sokoni-merchant-store\.js/.test(shell) && /sokoni-merchant-store-ui\.js/.test(shell));
  ck('G12 the shell has a renderer for Shop Details', /id === 'shop'\) renderStore\(\)/.test(shell));
  ck('G13 the shell binds the five SAFE authorities',
    /callIdentity:\s*_callable\('getMyMinishop'\)/.test(shell) &&
    /callSave:\s*_callable\('saveMinishopConfig'\)/.test(shell) &&
    /callClaim:\s*_callable\('claimMinishopHandle'\)/.test(shell) &&
    /callAnalytics:\s*_callable\('getMinishopAnalytics'\)/.test(shell) &&
    /callShare:\s*_callable\('generateMinishopShareCard'\)/.test(shell));
  ck('G14 ...and passes NO db adapter', !/SokoniMerchantStoreUI\.mount\([^)]*\bdb:/.test(shell.replace(/\s+/g, ' ')));
}

console.log('\n' + '='.repeat(70));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error(e); process.exit(1); });
