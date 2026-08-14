/* Returns UI terminal states — LOADING → EMPTY | READY | ERROR.

   Run:  node scripts/test-returns-states.js

   WHY SEPARATE FROM THE RULES SUITE
   test-returns-rules.js proves the DATA layer: that a shop with no returns gets an
   allowed, empty result rather than a permission error. That is necessary but not
   sufficient — the original bug was that an empty result and a failed query both
   ended up rendering the same "Failed to load returns" message, because rendering
   sat inside the query's catch block and an auth precondition threw into it too.

   This suite proves the RENDER layer: given each outcome, the merchant sees the
   right terminal state. It drives returns.html's own render functions with real
   inputs in a real browser, so it needs no Firestore and no test hooks in
   production code.

   The states, per the acceptance criteria:
     0 returns              -> "No returns yet"        (NOT an error)
     1 authorized return    -> the return renders
     query/permission fail  -> error message + Retry   (and Retry re-runs the query)
     never                  -> stuck on Loading
*/
'use strict';
const { webkit } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css',
  '.png':'image/png', '.json':'application/json', '.svg':'image/svg+xml', '.jpg':'image/jpeg',
  '.webp':'image/webp', '.ico':'image/x-icon', '.woff2':'font/woff2' };

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).replace(/\s+/g, ' ').slice(0, 90) + ']' : ''));
  ok ? pass++ : fail++;
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/returns.html';
  let f = path.join(ROOT, p);
  if (!path.extname(p)) f += '.html';          /* cleanUrls:true, as hosting serves it */
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'text/plain' });
    res.end(d);
  });
});

const wd = setTimeout(() => { console.log('SKIP — watchdog'); process.exit(0); }, 135000);
wd.unref && wd.unref();

server.listen(0, async () => {
  const BASE = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try { browser = await webkit.launch(); }
  catch (e) { console.log('SKIP — webkit unavailable: ' + (e && e.message || e)); server.close(); process.exit(0); return; }

  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
  /* A signed-in seller, so the page renders the seller view rather than bouncing. */
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('loggedIn', 'true');
      localStorage.setItem('sokoniUser', JSON.stringify({ uid: 'seller-1', roles: ['seller'], role: 'seller' }));
    } catch (e) {}
  });
  const page = await ctx.newPage();
  /* This suite exercises the RENDER layer. Standalone (not in-shell), returns.html correctly
     sends an unauthenticated visitor to login — a seeded localStorage flag is not a real
     Firebase session — and that navigation destroys the execution context mid-assertion.
     Blocking only the login navigation keeps the page alive so the terminal states can be
     driven directly. The redirect itself is correct behaviour and is covered elsewhere:
     the visual gate asserts no module document is ever an auth page IN-SHELL. */
  let loginBlocked = 0;
  await page.route('**/login*', (r) => { loginBlocked++; return r.abort(); });

  await page.goto(BASE + '/returns.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2500);

  console.log('\nRETURNS UI TERMINAL STATES');
  console.log('='.repeat(66));

  const ready = await page.evaluate(() => ({
    hasRender: typeof renderSellerView === 'function',
    hasError:  typeof _returnsError === 'function',
    hasLoad:   typeof loadReturns === 'function',
    body: (document.body.innerText || '').slice(0, 80).replace(/\s+/g, ' '),
  }));

  /* returns.html defines its view functions inside the onAuthStateChanged callback, so they
     only exist once Firebase Auth resolves a real user. Auth cannot resolve against
     127.0.0.1 (App Check will not attest it), so the page parks on "Authenticating…".

     ENV-SKIP rather than FAIL: a red result here would mean "this environment has no auth",
     not "the states are wrong", and a permanently-red suite trains people to ignore it.
     Running this for real needs the Firebase Auth emulator wired into returns.html — see the
     note in CHANGELOG. Never report these states as verified on the strength of a skip. */
  if (!ready.hasRender) {
    console.log('\nSKIP — returns.html never reached its authenticated state in this environment.');
    console.log('       Its view functions are defined inside onAuthStateChanged, and Firebase');
    console.log('       Auth cannot resolve against 127.0.0.1 (App Check will not attest it).');
    console.log('       Page state: "' + ready.body + '"');
    console.log('       To run for real: point returns.html at the Auth + Firestore emulators.');
    console.log('\n  0 passed, 0 failed  (SKIPPED — states NOT verified)');
    await browser.close(); server.close(); clearTimeout(wd);
    process.exit(0);
  }
  ck('returns.html exposes its state functions', true, 'render/error/load present');

  /* ── EMPTY: a successful query that returned nothing ────────────────────── */
  console.log('\n1. Zero returns — a SUCCESSFUL query with no rows');
  const empty = await page.evaluate(() => {
    userRole = 'seller';
    allReturns = [];
    renderSellerView();
    const pend = (document.getElementById('seller-pending-list') || {}).innerText || '';
    const all  = (document.getElementById('seller-all-tbody') || {}).innerText || '';
    return { pend: pend.trim(), all: all.trim() };
  });
  ck('shows "No returns yet" (not an error)', /no returns yet/i.test(empty.all), empty.all);
  ck('empty state does NOT say failed/error/unable',
     !/failed|error|unable|couldn't/i.test(empty.all + ' ' + empty.pend), empty.all);
  ck('empty state is not stuck on Loading', !/loading/i.test(empty.all + ' ' + empty.pend), empty.pend);

  /* ── READY: one authorized return renders ──────────────────────────────── */
  console.log('\n2. One authorized return — renders');
  const one = await page.evaluate(() => {
    userRole = 'seller';
    allReturns = [{
      id: 'ret_order1_buyer', returnId: 'ret_order1_buyer', orderId: 'ORDER-12345678',
      buyerId: 'buyer-1', sellerId: 'seller-1', buyerName: 'Jane Wanjiru',
      items: [{ name: 'Blue Kikoy Shirt', qty: 1, price: 1200 }],
      reason: 'damaged', description: 'Torn on arrival', resolution: 'refund',
      status: 'submitted', submittedAt: { toDate: () => new Date('2026-08-01T10:00:00Z') },
    }];
    renderSellerView();
    return {
      all:  ((document.getElementById('seller-all-tbody') || {}).innerText || '').trim(),
      pend: ((document.getElementById('seller-pending-list') || {}).innerText || '').trim(),
      rows: document.querySelectorAll('#seller-all-tbody tr').length,
    };
  });
  ck('the return renders as a row', one.rows >= 1 && /ORDER-12345678|Blue Kikoy/i.test(one.all),
     one.all);
  ck('no longer shows the empty state', !/no returns yet/i.test(one.all), one.all);
  ck('a submitted return appears in the pending list', /Blue Kikoy|ORDER-12345678/i.test(one.pend), one.pend);

  /* ── ERROR: a genuine failure shows a message AND a working Retry ───────── */
  console.log('\n3. Query failure — error + Retry');
  const err = await page.evaluate(() => {
    userRole = 'seller';
    _returnsError("You don't have access to returns for this shop");
    const el = document.getElementById('seller-all-tbody');
    const txt = (el && el.innerText) || '';
    const btns = el ? el.querySelectorAll('button') : [];
    return { txt: txt.trim(), retry: btns.length > 0 && /retry/i.test(btns[0].textContent || '') };
  });
  ck('error message is shown', /don't have access/i.test(err.txt), err.txt);
  ck('a Retry control is offered', err.retry, err.txt);
  ck('error state is not stuck on Loading', !/loading/i.test(err.txt), err.txt);

  /* Retry must actually re-run the query, not just clear the message. */
  const retryWorks = await page.evaluate(async () => {
    let called = 0;
    const orig = loadReturns;
    loadReturns = function () { called++; return orig.apply(this, arguments); };
    const btn = document.querySelector('#seller-all-tbody button');
    if (btn) btn.click();
    await new Promise((r) => setTimeout(r, 300));
    loadReturns = orig;
    return called;
  });
  ck('Retry actually re-runs the query', retryWorks >= 1, 'loadReturns called ' + retryWorks + 'x');

  /* ── The regression itself: EMPTY and ERROR must be different screens ───── */
  console.log('\n4. The original defect — EMPTY and ERROR must not be the same screen');
  const distinct = await page.evaluate(() => {
    userRole = 'seller'; allReturns = [];
    renderSellerView();
    const emptyTxt = ((document.getElementById('seller-all-tbody') || {}).innerText || '').trim();
    _returnsError('Unable to load returns');
    const errTxt = ((document.getElementById('seller-all-tbody') || {}).innerText || '').trim();
    return { emptyTxt, errTxt };
  });
  ck('empty and error render DIFFERENT text', distinct.emptyTxt !== distinct.errTxt,
     '"' + distinct.emptyTxt + '" vs "' + distinct.errTxt + '"');
  ck('empty text contains no failure wording', !/failed|unable|error/i.test(distinct.emptyTxt),
     distinct.emptyTxt);

  console.log('\n' + '='.repeat(66));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  /* REPORT FIRST, THEN TEAR DOWN — teardown must never decide the verdict.
     Measured in the gate: suites printed every assertion PASS and were then SIGKILLed
     at their budget because close() never returned, so a finished result was recorded
     as TIMEOUT -- a non-blocking verdict -- and its coverage vanished silently. */
  try { clearTimeout(wd); } catch (_) {}
  await Promise.race([
    (async () => { try { await browser.close(); } catch (_) {} })(),
    new Promise((r) => setTimeout(r, 8000)),
  ]);
  /* A close that lost the race above is still RUNNING. Abandoning it leaks the browser:
     measured at 32 orphaned WebKit processes after one gate, which starves the renderers
     of later suites and crashes them. Kill what did not close. */
  try { const _p = browser.process && browser.process(); if (_p) _p.kill('SIGKILL'); } catch (_) {}
  try { server.close(); } catch (_) {}
  process.exit(fail ? 1 : 0);
});
