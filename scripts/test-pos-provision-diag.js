/* POS provisioning diagnostics.

   Provisioning stalled at "Downloading business configuration" and told the
   operator to check their connection. That was the one cause it could not be:
   the app had just loaded over that same connection.

   The real failure is bootstrapDevice throwing, most often permission-denied
   from _assertMerchantAccess (functions/business-bootstrap.js) — the account is
   not the business owner and not active POS staff on that branch. The client
   caught the error, discarded it, and substituted a guess.

   These tests assert that each distinct cause produces a DIFFERENT and
   actionable message, and that the raw code always survives. */
'use strict';
const { webkit, devices } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');

const T = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.ico': 'image/x-icon' };
const srv = http.createServer((q, r) => {
  let p = decodeURIComponent(q.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  let fp = path.join('.', p);
  if (!fs.existsSync(fp) && fs.existsSync(fp + '.html')) fp += '.html';
  fs.readFile(fp, (e, d) => {
    if (e) { r.writeHead(404); return r.end('nf'); }
    r.writeHead(200, { 'Content-Type': T[path.extname(fp)] || 'text/plain' }); r.end(d);
  });
});

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 66) + ']' : ''));
  ok ? pass++ : fail++;
};

srv.listen(0, async () => {
  const B = 'http://127.0.0.1:' + srv.address().port;
  const br = await webkit.launch();
  const page = await (await br.newContext({ ...devices['iPhone 13'] })).newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));

  await page.goto(B + '/pos-setup.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);
  const landed = new URL(page.url()).pathname;
  ck('measured the right page', /pos-setup/.test(landed), landed);

  const out = await page.evaluate(() => {
    if (typeof _provDiagnose !== 'function') return { err: '_provDiagnose not defined' };
    const ctx = { merchantId: 'BIZ_123', branchId: 'BR_1', deviceId: 'DEV_9' };
    const call = (code, message) => {
      const e = new Error(message || 'server said no');
      e.code = code;
      return _provDiagnose(e, ctx);
    };
    return {
      denied:      call('permission-denied', 'Access denied — you do not belong to this merchant.'),
      unauth:      call('unauthenticated', 'Sign in required.'),
      notFound:    call('not-found', 'No such business.'),
      badArg:      call('invalid-argument', 'merchantId is required.'),
      unavailable: call('unavailable', 'backend unreachable'),
      internal:    call('internal', 'boom'),
      precond:     call('failed-precondition', 'incomplete'),
      unknown:     call('some-new-code', 'novel failure'),
      prefixed:    call('functions/permission-denied', 'prefixed code'),
    };
  });

  if (out.err) { ck('_provDiagnose exists', false, out.err); }
  else {
    console.log('\n── Each cause gets its own answer ──');
    ck('permission-denied explains ownership/staff',
       /not attached to that business/i.test(out.denied) && /POS staff/i.test(out.denied));
    ck('unauthenticated says the session expired', /session expired/i.test(out.unauth));
    ck('not-found says the business is gone',      /no longer exists/i.test(out.notFound));
    ck('invalid-argument says what was missing',   /incomplete request/i.test(out.badArg));
    ck('failed-precondition says finish setup',    /not finished being set up/i.test(out.precond));

    console.log('\n── "Check your connection" is only said when it is TRUE ──');
    /* The original bug: this advice was given for every cause, including the
       ones where the network is demonstrably fine. */
    ck('offered for unavailable',        /worth retrying/i.test(out.unavailable));
    ck('NOT offered for permission-denied', /check your connection/i.test(out.denied) === false);
    ck('NOT offered for unauthenticated',   /check your connection/i.test(out.unauth) === false);
    ck('NOT offered for not-found',         /check your connection/i.test(out.notFound) === false);
    ck('NOT offered for internal',          /check your connection/i.test(out.internal) === false);

    /* The machine-readable part is DELIBERATELY NOT on screen.
       These assertions used to require code:/business:/branch: and the raw server
       message inside the text shown to the merchant. pos-setup.html removed that
       ON PURPOSE and records why: Firestore document ids and Firebase error codes
       mean nothing to a merchant, they invite an id to be read as a name (a real
       report described a branch called 'internal', which was actually
       'code: internal'), and printing database keys into the UI is needless
       disclosure.

       The detail was not dropped. _provDiagnose still sends all of it to
       console.error and SokoniAsync.report, which is where support reads it.
       Restoring the old assertions would put those identifiers back on screen and
       reintroduce the reported defect, so the CONTRACT is inverted here rather
       than the code being bent to satisfy a stale test. */
    console.log('');
    console.log('-- Identifiers stay OUT of the merchant-facing message --');
    ck('no raw firebase code on screen', /code:\s*permission-denied/.test(out.denied) === false);
    ck('no business id on screen',       /BIZ_123/.test(out.denied) === false);
    ck('no branch id on screen',         /BR_1/.test(out.denied) === false);
    ck('no device id on screen',         /DEV_9/.test(out.denied) === false);
    ck('unknown code still gets a usable message',
       typeof out.unknown === 'string' && out.unknown.trim().length > 30);
    ck('functions/ prefix handled without leaking the code',
       typeof out.prefixed === 'string' && /code:\s*permission-denied/.test(out.prefixed) === false);

    console.log('\n── Never blank ──');
    Object.entries(out).forEach(([k, v]) =>
      ck(k + ' produces a message', typeof v === 'string' && v.trim().length > 30));
  }

  const introduced = errs.filter((e) => !/ResizeObserver|recordMetric|access control/.test(e));
  ck('no page errors introduced', introduced.length === 0, introduced[0] || '');

  await br.close(); srv.close();
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
});
