/* Branch resolution — five states, five UIs.

   The defect being fixed: a merchant who owns exactly one branch was shown
   "No active branches found" or bounced past the step, and a merchant with
   ZERO branches was shown an ERROR and blocked. Owning one branch is the
   normal case for a small business, not a fault.

   These tests drive initBranchStep directly with each state and assert which
   panel is visible and whether Continue is enabled. */
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
/* Shorter than this suite's runner budget (150000ms) ON PURPOSE. Without one, a hang is
   SIGKILLed by the runner and recorded as TIMEOUT -- not a defect verdict -- so the suite leaves
   the blocking set silently. Measured cost of this suite is far below the value chosen, so this
   fires only when the runner was going to kill it anyway. */
const _wd = setTimeout(() => { console.log('\n  WATCHDOG — suite exceeded 135s'); process.exit(1); }, 135000);
/* unref: the watchdog must never be the reason the process stays alive. A suite that
   finishes normally exits immediately; one that is genuinely stuck still has a live event
   loop, so the timer still fires and self-reports instead of being SIGKILLed silently. */
if (_wd && _wd.unref) _wd.unref();
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 60) + ']' : ''));
  ok ? pass++ : fail++;
};

srv.listen(0, async () => {
  const B = 'http://127.0.0.1:' + srv.address().port;
  const br = await webkit.launch();
  const page = await (await br.newContext({ ...devices['iPhone 13'] })).newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));

  await page.goto(B + '/pos-setup.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5500);

  const out = await page.evaluate(async () => {
    if (typeof initBranchStep !== 'function') return { err: 'initBranchStep missing' };
    const $ = (id) => document.getElementById(id);
    const vis = (id) => { const e = $(id); return !!e && e.style.display !== 'none'; };

    const run = async (branches) => {
      WIZ.selectedBiz = { id: 'BIZ1', name: 'KASS SHOP' };
      WIZ._bizBranches = branches;
      WIZ.selectedBranch = null;
      $('branch-error').classList.remove('visible');
      $('branch-error').textContent = '';
      await initBranchStep();
      return {
        single:   vis('branch-single'),
        empty:    vis('branch-empty'),
        listCount: $('branch-list').children.length,
        errorShown: $('branch-error').classList.contains('visible'),
        errorText: $('branch-error').textContent,
        continueEnabled: !$('btn-branch-continue').disabled,
        title: $('step5-title').textContent,
        selected: WIZ.selectedBranch ? (WIZ.selectedBranch.name || WIZ.selectedBranch.id) : null,
        singleName: $('branch-single-name').textContent,
      };
    };

    const r = {};
    r.zero = await run([]);
    r.one  = await run([{ id: 'b1', name: 'KASS SHOP - Nairobi CBD', address: 'Kimathi St' }]);
    r.many = await run([{ id: 'b1', name: 'CBD' }, { id: 'b2', name: 'Westlands' }, { id: 'b3', name: 'Karen' }]);

    /* Genuine backend failure — permission denied. */
    WIZ.selectedBiz = { id: 'BIZ1', name: 'KASS SHOP' };
    WIZ._bizBranches = null;
    const e = new Error('Access denied'); e.code = 'permission-denied';
    _branchFailure(e);
    r.denied = {
      errorShown: $('branch-error').classList.contains('visible'),
      text: $('branch-error').textContent,
      continueEnabled: !$('btn-branch-continue').disabled,
    };

    const e2 = new Error('backend down'); e2.code = 'unavailable';
    _branchFailure(e2);
    r.unavailable = { text: $('branch-error').textContent };

    return r;
  });

  if (out.err) { ck('initBranchStep exists', false, out.err); }
  else {
    console.log('\n── Case 1: ZERO branches — onboarding, not an error ──');
    ck('empty panel shown',            out.zero.empty === true);
    ck('NOT shown as an error',        out.zero.errorShown === false);
    ck('Continue disabled',            out.zero.continueEnabled === false);
    ck('title becomes "Add a Branch"', /Add a Branch/.test(out.zero.title), out.zero.title);
    ck('no selector rendered',         out.zero.listCount === 0);

    console.log('\n── Case 2: ONE branch — auto-selected, read-only, no extra click ──');
    ck('single panel shown',           out.one.single === true);
    ck('branch auto-selected',         out.one.selected === 'KASS SHOP - Nairobi CBD', out.one.selected);
    ck('Continue ENABLED immediately', out.one.continueEnabled === true);
    ck('title is "Branch", not "Select Branch"', out.one.title === 'Branch', out.one.title);
    ck('selector hidden',              out.one.listCount === 0);
    ck('no error',                     out.one.errorShown === false);
    ck('branch name displayed',        /Nairobi CBD/.test(out.one.singleName));

    console.log('\n── Case 3: MULTIPLE branches — selector, choose first ──');
    ck('selector rendered',            out.many.listCount === 3, out.many.listCount);
    ck('single panel hidden',          out.many.single === false);
    ck('Continue disabled until chosen', out.many.continueEnabled === false);
    ck('title is "Select Branch"',     /Select Branch/.test(out.many.title), out.many.title);

    console.log('\n── Genuine failures get their own message ──');
    ck('permission-denied explains access', /do not have access/i.test(out.denied.text));
    ck('permission-denied does NOT blame the network',
       /check your connection/i.test(out.denied.text) === false);
    ck('permission-denied disables Continue', out.denied.continueEnabled === false);
    ck('unavailable IS worth retrying',      /worth retrying/i.test(out.unavailable.text));
    /* This previously asserted the opposite — that "code: permission-denied"
       appeared in the visible message. That was removed deliberately: printing
       Firebase's error identifier into the error box is how a merchant came to
       read an internal code as a branch name. Diagnostics still capture the
       code via console.error and SokoniAsync.report; the merchant no longer
       sees it. Asserting the absence, so it cannot creep back. */
    ck('no internal identifier leaked to the merchant',
       /code:|permission-denied|unavailable|firestore/i.test(out.denied.text) === false,
       out.denied.text.slice(0, 60));

    console.log('\n── The original defect cannot recur ──');
    ck('one branch never blocks the merchant',
       out.one.continueEnabled === true && out.one.errorShown === false);
    ck('zero branches never shown as a failure',
       out.zero.errorShown === false && out.zero.empty === true);
  }

  const introduced = errs.filter((e) => !/ResizeObserver|recordMetric|access control/.test(e));
  ck('no page errors introduced', introduced.length === 0, introduced[0] || '');

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  /* REPORT FIRST, THEN TEAR DOWN — teardown must never decide the verdict.
     Measured in the gate: suites printed every assertion PASS and were then SIGKILLed
     at their budget because close() never returned, so a finished result was recorded
     as TIMEOUT -- a non-blocking verdict -- and its coverage vanished silently. */
  await Promise.race([
    (async () => { try { await br.close(); } catch (_) {} })(),
    new Promise((r) => setTimeout(r, 8000)),
  ]);
  /* A close that lost the race above is still RUNNING. Abandoning it leaks the browser:
     measured at 32 orphaned WebKit processes after one gate, which starves the renderers
     of later suites and crashes them. Kill what did not close. */
  try { const _p = br.process && br.process(); if (_p) _p.kill('SIGKILL'); } catch (_) {}
  try { srv.close(); } catch (_) {}
  process.exit(fail ? 1 : 0);
});
