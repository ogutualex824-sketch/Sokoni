/* ══════════════════════════════════════════════════════════════════════════════
   MERCHANT V2 — MODULE MOUNT GATE
   ══════════════════════════════════════════════════════════════════════════════
   The capability gate proved STATICALLY that v2 has native renderers for the nine
   routes v1 blanks. That proof read source. This one boots the shell with its
   modules present and asks the same question v1 already failed at runtime:

     click the route -> does anything actually render?

   The v1 runtime run produced, for sell / inventory / staff / messages / disputes:

       PASS  correct module mounted (native)      [native-sell]
       FAIL  native module rendered real content
       FAIL  no route/console error   [native route "sell" has no renderer]

   A panel that mounts and stays empty is the defect. So "mounted" is not the
   assertion here — rendered content is, and the console must be clean of route
   errors while it happens.

   WHAT THIS RUN CAN AND CANNOT SEE. It is unauthenticated and offline: there is
   no signed-in merchant and no Firestore. A module that renders an honest
   "sign in" or empty state IS passing — that is real content, and rendering a
   neutral state rather than a fabricated figure is what CLAUDE.md requires. What
   this CANNOT prove is that a module renders a real merchant's real data; that
   needs the seller certification run, and is not claimed here.

   Run: node scripts/test-merchant-v2-modules.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const { webkit } = require('playwright');
const http = require('http');
const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TYPES = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css',
                '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png' };

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

/* Offline/unauthenticated noise. Route errors are deliberately NOT in here — a
   "no renderer" message must never be filtered away, since it is the defect. */
const NOISE = /Access-Control-Allow-Origin|appcheck|App Check|firebase|FirebaseError|net::|ERR_|installations|gstatic|googleapis|401|403|Failed to load resource/i;

(async () => {
  console.log('\nMERCHANT V2 — MODULE MOUNT GATE');
  console.log('='.repeat(78));

  const missing = [];
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    let file = path.join(ROOT, p);
    if (!fs.existsSync(file) && fs.existsSync(file + '.html')) file += '.html';
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      if (/\.js$/.test(p)) missing.push(p);      /* a script the shell asked for and we do not have */
      res.writeHead(404); return res.end('nope');
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'text/plain' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const BASE = 'http://127.0.0.1:' + server.address().port;

  const browser = await webkit.launch();
  const page = await browser.newPage({ viewport: { width: 393, height: 852 } });

  const routeErrors = [], pageErrors = [];
  page.on('console', m => { if (m.type() === 'error' && !NOISE.test(m.text())) routeErrors.push(m.text()); });
  page.on('pageerror', e => { if (!NOISE.test(String(e))) pageErrors.push(String(e)); });

  /* Never actually leave the shell. */
  await page.route('**/*', route => {
    const r = route.request();
    if (r.isNavigationRequest() && r.frame() === page.mainFrame() && !r.url().startsWith(BASE + '/merchant-v2')) return route.abort();
    return route.continue();
  });

  console.log('\n1. Every script the shell asks for is present');
  await page.goto(BASE + '/merchant-v2', { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(3000);
  const ownMissing = missing.filter(p => /sokoni-merchant-/.test(p));
  check('no merchant module 404s', ownMissing.length === 0, ownMissing.join(',') || 'all present');
  check('no uncaught page error', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | ') || 'clean');

  console.log('\n2. Every global the MODULES table names is defined');
  const globals = await page.evaluate(() => {
    const names = ['SokoniMerchantSell','SokoniMerchantInventoryUI','SokoniMerchantTeam',
                   'SokoniMerchantMarketing','SokoniMerchantDisputesUI','SokoniMerchantMessagesUI',
                   'SokoniMerchantCustomersUI','SokoniMerchantStoreUI','SokoniMerchantTaxUI'];
    const out = {};
    names.forEach(n => { out[n] = typeof window[n]; });
    out.__data  = typeof window.SokoniMerchantData;
    out.__stock = typeof window.SokoniMerchantStock;
    return out;
  });
  Object.keys(globals).forEach(k => {
    check('global defined: ' + k.replace('__', ''), globals[k] === 'object' || globals[k] === 'function', globals[k]);
  });

  console.log('\n3. The nine negotiated routes RENDER, they do not just mount');
  /* PANEL IDENTITY MATTERS, and getting it wrong produces a convincing false pass.
     v2 names each native panel `#panel-<id>` and marks the visible one with `.show`
     — it does NOT use v1's `.mpanel` class. An earlier version of this gate selected
     `.mpanel.show` with a loose `[class*="panel"]` fallback, matched `#panel-dashboard`
     for every route, and reported nine identical passes of 362 chars. So: address the
     route's OWN panel by id, require it to be the shown one, and cross-check that the
     routes do not all render the same thing. */
  const ROUTES = ['sell','inventory','staff','messages','disputes','customers','shop','marketing','kra-tax'];
  const seen = {};
  for (const id of ROUTES) {
    routeErrors.length = 0;
    await page.evaluate(r => window.__mgo(r), id);
    await page.waitForTimeout(1400);

    const state = await page.evaluate(rid => {
      const p = document.getElementById('panel-' + rid);
      if (!p) return { found: false };
      const txt = (p.innerText || '').trim();
      const shownId = (document.querySelector('.panel.show') || {}).id || null;
      return { found: true, shown: p.classList.contains('show'), shownId,
               chars: txt.length, nodes: p.querySelectorAll('*').length,
               head: txt.slice(0, 70).replace(/\s+/g, ' ') };
    }, id);

    check(id + ": its OWN panel #panel-" + id + ' is the one showing',
          state.found && state.shown, state.found ? 'showing=' + state.shownId : 'panel absent');
    /* The v1 failure mode exactly: panel present, nothing inside it. */
    check(id + ': rendered real content (not an empty panel)',
          state.found && state.chars > 20 && state.nodes > 3,
          state.found ? state.chars + ' chars / ' + state.nodes + ' nodes — "' + state.head + '"' : 'no panel');
    check(id + ': no "has no renderer" route error',
          !routeErrors.some(e => /no renderer/i.test(e)),
          routeErrors.slice(0, 1).join('') || 'clean');
    seen[id] = state.found ? state.chars + ':' + state.nodes + ':' + state.head : 'none';
  }

  /* Distinctness control. Nine surfaces rendering byte-identical content is the
     signature of a mis-aimed selector, not of nine working modules. */
  const distinct = new Set(Object.values(seen));
  check('the nine surfaces render DISTINCT content (selector is not mis-aimed)',
        distinct.size >= ROUTES.length - 1,
        distinct.size + ' distinct of ' + ROUTES.length);

  await browser.close();
  await new Promise(r => server.close(r));

  console.log('\n' + '='.repeat(78));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('='.repeat(78) + '\n');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nHARNESS ERROR:', e && e.message); process.exit(1); });
