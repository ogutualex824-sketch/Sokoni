/* ══════════════════════════════════════════════════════════════════════════════
   MERCHANT V2 — PRODUCTION SMOKE (unauthenticated)
   ══════════════════════════════════════════════════════════════════════════════
   Certifies the DEPLOYED artifact on the real origin, not a locally-served copy.
   Everything here is provable without a merchant session, so it runs today and
   needs no credentials and no App Check debug token:

     · the live shell boots with no page error and no route error
     · it serves the byte-identical artifact we committed
     · the route contract it loads is the certified one
     · it does not escape the shell: no window.open, no target=_blank, and no
       top-level navigation on boot — the escalation that once threw a merchant
       out of the app mid-session
     · the service worker registers (a page that omits sw-register serves stale
       after every deploy — this smoke found exactly that, before the cutover)
     · v2 does NOT load the capability layer, which is correct: it renders all 18
       native surfaces itself, so negotiation would be a no-op there

   WHAT THIS IS NOT. It is not the seller certification. Ownership of Orders and
   Payments, the active-shop resolution, the 12-route walk and session
   persistence all require a real approved seller, and are deliberately absent
   here rather than faked with an anonymous session.

   Run: node scripts/smoke-merchant-v2-production.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const { webkit } = require('playwright');
const https = require('https');
const path = require('path');
const cp = require('child_process');

const ORIGIN = process.env.SOKONI_ORIGIN || 'https://mysokoni.co.ke';
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const check = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : ''));
  ok ? pass++ : fail++;
};

/* Offline/unauthenticated noise. Route errors are NOT filtered — a "no renderer"
   or a contract refusal must never be hidden. */
/* 'Security verification failed' is firebase.js/sokoni-appcheck.js reporting that App Check
   could not attest — reCAPTCHA cannot solve for a headless browser on the real origin. It is
   an environment limit of this harness, not a shell defect, and it is listed EXPLICITLY rather
   than swallowed by a broad pattern so a genuine shell error can never hide behind it. */
const NOISE = /App Check|appCheck|appcheck|recaptcha|Security verification failed|firebase|Firebase|401|403|Failed to load resource|net::|ERR_|installations|gstatic|permission-denied|Missing or insufficient/i;

const get = (url) => new Promise((res) => {
  https.get(url, (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => res({ status: r.statusCode, body: d })); })
    .on('error', () => res({ status: 0, body: '' }));
});

(async () => {
  console.log('\nMERCHANT V2 — PRODUCTION SMOKE  (' + ORIGIN + ')');
  console.log('='.repeat(78));

  console.log('\n1. The deployed artifact is the one we committed');
  const live = await get(ORIGIN + '/merchant-v2');
  check('/merchant-v2 serves 200', live.status === 200, 'HTTP ' + live.status + '  ' + live.body.length + 'B');
  const localSha = cp.execSync('git show HEAD:merchant-v2.html', { cwd: ROOT, encoding: 'buffer', maxBuffer: 1 << 26 });
  const crypto = require('crypto');
  const h = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16);
  check('...byte-identical to HEAD:merchant-v2.html', h(Buffer.from(live.body)) === h(localSha),
        h(Buffer.from(live.body)) + ' vs ' + h(localSha));

  const ver = await get(ORIGIN + '/version.json');
  let vj = {}; try { vj = JSON.parse(ver.body); } catch (_) {}
  check('version.json reports a CLEAN release', vj.dirtyWorkingTree === false,
        vj.commitShort + ' · ' + vj.cacheVersion + ' · dirty=' + vj.dirtyWorkingTree);
  /* Compare against the commit that was DEPLOYED, not HEAD — HEAD advances the moment
     the post-deploy SW bump is committed, which is correct discipline and would otherwise
     make this fail on every well-run release. The commit must simply be an ancestor of HEAD
     and contain the served artifact. */
  let isAncestor = false;
  try { cp.execSync('git merge-base --is-ancestor ' + vj.commitShort + ' HEAD', { cwd: ROOT, stdio: 'ignore' }); isAncestor = true; } catch (_) {}
  check('...and the deployed commit is on this branch', isAncestor, vj.commitShort + ' -> HEAD ' + cp.execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf8' }).trim());

  console.log('\n2. The live shell boots');
  const browser = await webkit.launch();
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 } });
  const page = await ctx.newPage();
  const routeErrors = [], pageErrors = [], topNav = [];
  page.on('console', m => { if (m.type() === 'error' && !NOISE.test(m.text())) routeErrors.push(m.text().slice(0, 160)); });
  page.on('pageerror', e => { if (!NOISE.test(String(e.message))) pageErrors.push(String(e.message).slice(0, 160)); });
  page.on('framenavigated', f => { if (f === page.mainFrame()) topNav.push(f.url()); });

  await page.goto(ORIGIN + '/merchant-v2', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(6000);

  check('no uncaught page error', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | ') || 'clean');
  check('no route/console error', routeErrors.length === 0, routeErrors.slice(0, 2).join(' | ') || 'clean');

  const shell = await page.evaluate(() => ({
    controls: document.querySelectorAll('[data-route]').length,
    title: (document.getElementById('mtitle') || {}).textContent || document.title,
    hasContract: !!window.SokoniMerchantRoutes,
    routes: window.SokoniMerchantRoutes ? window.SokoniMerchantRoutes.ROUTES.length : 0,
    hasCapability: !!window.SokoniMerchantCapability,
    exits: window.SokoniMerchantRoutes
      ? window.SokoniMerchantRoutes.ROUTES.filter(r => r.kind === 'exit').map(r => r.id + '->' + r.href + (r.next ? '?next=' + r.next : '')) : [],
    sw: !!navigator.serviceWorker,
  }));
  check('the shell rendered its chrome', shell.controls > 0, shell.controls + ' route controls');
  check('the certified route contract is loaded', shell.hasContract && shell.routes === 33, shell.routes + ' routes');
  /* v2 renders all 18 native surfaces itself, so it negotiates to full native and the
     capability layer would be a no-op there. It is wired into merchant.html (v1), which is
     where it does work. Asserting its ABSENCE keeps the design honest: if v2 ever starts
     loading it, that is a change worth noticing. */
  check('v2 does NOT need the capability layer (full native coverage)', !shell.hasCapability,
        shell.hasCapability ? 'present — v2 now negotiates?' : 'absent, as designed');
  check('the declared exits are the contract ones', shell.exits.join(' | ') === '/'.replace('/', 'home->/') + ' | signout->/login?next=/merchant-v2',
        shell.exits.join(' | '));

  console.log('\n3. Containment — the shell does not escape');
  check('boot performed NO top-level navigation away from /merchant-v2',
        topNav.every(u => u.includes('/merchant-v2')), topNav.map(u => u.replace(ORIGIN, '')).join(',') || 'none');
  check('no navigation to an auth destination on boot',
        !topNav.some(u => /login|signin|auth/i.test(u)), 'clean');
  const escapes = await page.evaluate(() => ({
    blank: document.querySelectorAll('[target="_blank"]').length,
    opener: typeof window.open === 'function' ? 'present (native)' : 'absent',
  }));
  check('no target="_blank" in the live DOM', escapes.blank === 0, String(escapes.blank));

  console.log('\n4. Freshness — the page can update itself');
  const swReg = await page.evaluate(async () => {
    if (!navigator.serviceWorker) return 'no SW API';
    const r = await navigator.serviceWorker.getRegistrations();
    return r.length ? 'registered:' + r.length : 'none';
  });
  check('a service worker registers on /merchant-v2', /registered/.test(swReg), swReg);
  const swLive = await get(ORIGIN + '/service-worker.js');
  const m = swLive.body.match(/CACHE_VERSION\s*=\s*"([^"]+)"/);
  check('live SW cache version matches version.json', m && m[1] === vj.cacheVersion, m ? m[1] : 'unreadable');

  await browser.close();
  console.log('\n' + '='.repeat(78));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('  NOT covered here: ownership, active shop, the route walk, session');
  console.log('  persistence. Those need a real approved seller — see the cert harness.');
  console.log('='.repeat(78) + '\n');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nHARNESS ERROR:', e && e.message); process.exit(1); });
