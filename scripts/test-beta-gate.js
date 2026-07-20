/* Beta gate — the properties that matter are what it does NOT block.

   Browsing must stay open to everyone including crawlers, because product and
   store pages are the organic growth engine. Only committing actions are gated. */
'use strict';
const { webkit, devices } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');

const T = { '.html':'text/html', '.js':'application/javascript' };
const srv = http.createServer((q, r) => {
  let p = decodeURIComponent(q.url.split('?')[0]);
  if (p === '/') p = '/offline.html';
  fs.readFile(path.join('.', p), (e, d) => {
    if (e) { r.writeHead(404); return r.end('nf'); }
    r.writeHead(200, { 'Content-Type': T[path.extname(p)] || 'text/plain' }); r.end(d);
  });
});

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok?'PASS  ':'FAIL  ') + l + (d?'   ['+d+']':'')); ok?pass++:fail++; };

/* Fake an authenticated user carrying a given claim set. */
const withClaims = (claims) => ({ currentUser: claims === null ? null : {
  uid: 'U1', getIdTokenResult: async () => ({ claims }),
} });

srv.listen(0, async () => {
  const B = 'http://127.0.0.1:' + srv.address().port;
  const br = await webkit.launch();
  const page = await (await br.newContext({ ...devices['iPhone 13'] })).newPage();
  await page.goto(B + '/offline.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.addScriptTag({ url: B + '/sokoni-beta-gate.js' });
  await page.waitForTimeout(300);

  const out = await page.evaluate(async () => {
    const G = window.SokoniBetaGate;
    if (!G) return { err: 'gate missing' };
    const r = {};
    const set = (claims) => {
      window.firebaseAuth = claims === null ? { currentUser: null } : {
        currentUser: { uid: 'U1', getIdTokenResult: async () => ({ claims }) },
      };
    };
    const check = async (claims) => {
      set(claims); const s = await G.refresh();
      document.querySelectorAll('#sk-beta-sheet').forEach(n => n.remove());
      return s;
    };

    r.approved  = await check({ betaStatus: 'approved' });
    r.founder   = await check({ betaStatus: 'founder' });
    r.internal  = await check({ betaStatus: 'internal' });
    r.pending   = await check({ betaStatus: 'pending' });
    r.waitlist  = await check({ betaStatus: 'waitlisted' });
    r.suspended = await check({ betaStatus: 'suspended' });
    r.rejected  = await check({ betaStatus: 'rejected' });
    r.noClaim   = await check({});
    r.staff     = await check({ admin: true });
    r.staffNoBeta = await check({ superAdmin: true, betaStatus: 'pending' });
    /* An unreadable token must never read as approved. */
    window.firebaseAuth = { currentUser: { uid:'U1', getIdTokenResult: async () => { throw new Error('token unreadable'); } } };
    r.tokenError = await G.refresh();

    /* The sheet: does a blocked action explain itself and offer to keep browsing? */
    set({ betaStatus: 'pending' }); await G.refresh();
    const blocked = await G.gate('checkout');
    const sheet = document.getElementById('sk-beta-sheet');
    r.blockedReturn = blocked;
    r.sheetShown = !!sheet;
    r.sheetText = sheet ? sheet.innerText.replace(/\s+/g, ' ').slice(0, 160) : '';
    r.offersBrowse = sheet ? /Keep browsing/.test(sheet.innerText) : false;
    if (sheet) sheet.remove();

    /* Approved must pass through with no sheet. */
    set({ betaStatus: 'approved' }); await G.refresh();
    r.approvedPasses = await G.gate('checkout');
    r.noSheetWhenApproved = !document.getElementById('sk-beta-sheet');
    return r;
  });

  if (out.err) ck('module loads', false, out.err);
  else {
    console.log('\n── Admitted states ──');
    ['approved','founder','internal'].forEach(k => ck(k + ' is admitted', out[k].admitted === true, out[k].betaStatus));

    console.log('\n── Non-admitted states ──');
    ['pending','waitlist','suspended','rejected','noClaim'].forEach(k =>
      ck(k + ' is NOT admitted', out[k].admitted === false, out[k].betaStatus));

    console.log('\n── Staff are never locked out of their own platform ──');
    ck('admin claim is admitted',                 out.staff.admitted === true);
    ck('superAdmin admitted even while pending',  out.staffNoBeta.admitted === true, out.staffNoBeta.betaStatus);

    console.log('\n── Fails closed ──');
    ck('unreadable token is NOT admitted', out.tokenError.admitted === false);
    ck('unreadable token reports unknown, not approved', out.tokenError.betaStatus === 'unknown');

    console.log('\n── Blocked action explains itself ──');
    ck('gate() returns false when not admitted', out.blockedReturn === false);
    ck('a sheet is shown, not a silent failure',  out.sheetShown === true);
    ck('copy matches the state',                  /review/i.test(out.sheetText), out.sheetText.slice(0, 60));
    ck('browsing is always still offered',        out.offersBrowse === true);

    console.log('\n── Admitted users are never interrupted ──');
    ck('gate() returns true',        out.approvedPasses === true);
    ck('no sheet shown',             out.noSheetWhenApproved === true);
  }

  await br.close(); srv.close();
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
});
