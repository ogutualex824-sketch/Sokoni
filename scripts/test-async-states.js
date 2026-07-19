/* SokoniAsync — the guarantee under test is: a section is NEVER left blank.

   Every path must paint. That includes the two that caused real defects this
   session: a load that rejects, and a renderer that throws. */
'use strict';
const { webkit } = require('playwright');
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

srv.listen(0, async () => {
  const B = 'http://127.0.0.1:' + srv.address().port;
  const br = await webkit.launch();
  const page = await (await br.newContext()).newPage();
  await page.goto(B + '/offline.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.addScriptTag({ url: B + '/sokoni-async.js' });
  await page.waitForTimeout(400);

  const out = await page.evaluate(async () => {
    const A = window.SokoniAsync;
    if (!A) return { err: 'SokoniAsync missing' };
    const mk = () => { const d = document.createElement('div'); document.body.appendChild(d); return d; };
    const r = {};

    const okEl = mk();
    r.success = await A.loadSection(okEl, async () => [1,2,3], (d, n) => { n.innerHTML = '<b>' + d.length + ' items</b>'; });
    r.successHTML = okEl.innerHTML.length;

    const emptyEl = mk();
    r.empty = await A.loadSection(emptyEl, async () => [], () => {}, { empty: 'No vehicles registered' });
    r.emptyHTML = emptyEl.innerHTML;

    /* The vehicle-hub defect: load rejects. */
    const failEl = mk();
    r.failed = await A.loadSection(failEl, async () => { const e = new Error('The query requires an index'); e.code = 'failed-precondition'; throw e; }, () => {});
    r.failedHTML = failEl.innerHTML;

    /* Recoverable vs not. */
    const netEl = mk();
    r.network = await A.loadSection(netEl, async () => { const e = new Error('offline'); e.code = 'unavailable'; throw e; }, () => {}, { retryAttr: 'data-retry="1"' });
    r.networkHTML = netEl.innerHTML;

    /* A renderer that throws must still paint. */
    const throwEl = mk();
    r.rendererThrew = await A.loadSection(throwEl, async () => [1], () => { throw new Error('bad render'); });
    r.throwHTML = throwEl.innerHTML;

    r.recov = { unavailable: A.isRecoverable('unavailable'), denied: A.isRecoverable('permission-denied'),
                index: A.isRecoverable('failed-precondition') };
    r.missingTarget = await A.loadSection('does-not-exist', async () => [1], () => {});
    return r;
  });

  if (out.err) ck('module loads', false, out.err);
  else {
    console.log('\n── Every path paints ──');
    ck('success renders',            out.success.ok === true && out.successHTML > 0);
    ck('empty renders an empty state', out.empty.empty === true && /No vehicles registered/.test(out.emptyHTML));
    ck('LOAD FAILURE renders (the vehicle-hub defect)',
       out.failed.ok === false && out.failedHTML.length > 20, out.failed.code);
    ck('RENDERER THROWING still paints', out.rendererThrew.ok === false && out.throwHTML.length > 20);
    ck('no path leaves the element blank',
       [out.emptyHTML, out.failedHTML, out.networkHTML, out.throwHTML].every(h => h && h.length > 20));

    console.log('\n── Retry is offered only when retrying could work ──');
    ck('unavailable is recoverable',        out.recov.unavailable === true);
    ck('permission-denied is NOT',          out.recov.denied === false);
    ck('failed-precondition (index) is NOT', out.recov.index === false);
    ck('recoverable error offers Try again', /Try again/.test(out.networkHTML));
    ck('index error does NOT offer Try again', !/Try again/.test(out.failedHTML));

    console.log('\n── Safety ──');
    ck('missing target fails safe, no throw', out.missingTarget.ok === false && out.missingTarget.reason === 'no-target');
  }

  await br.close(); srv.close();
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
});
