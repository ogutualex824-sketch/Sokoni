/* Banking Hub — every tile must DO something.

   The property under test is deliberately not "the handler didn't throw". An
   earlier probe reported all 20 tiles ok on that basis while 8 of 8 changed
   nothing at all: no DOM delta, active tab frozen, zero panes in the document.
   "Ran to completion" and "worked" are different measurements, and only the
   second one matters to a merchant. Every assertion here compares before/after. */
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
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : ''));
  ok ? pass++ : fail++;
};

const DEVICES = ['iPhone SE', 'iPhone 13', 'iPhone 14 Pro Max'];

srv.listen(0, async () => {
  const B = 'http://127.0.0.1:' + srv.address().port;
  const br = await webkit.launch();
  const page = await (await br.newContext({ ...devices['iPhone 13'] })).newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));

  await page.goto(B + '/banking.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(6500);      /* past the /banking.html -> /banking canonicalisation */
  const landed = new URL(page.url()).pathname;
  ck('measured the right page', /banking/.test(landed), landed);

  const out = await page.evaluate(async () => {
    const r = { clicks: [], fns: {}, search: {}, modal: {} };

    ['showTab', 'filterBankCards', 'openApplyModal'].forEach((n) => { r.fns[n] = typeof window[n]; });

    const snap = () => ({
      tab: (document.querySelector('.bk-tab.active') || {}).id || null,
      panes: [...document.querySelectorAll('.bk-pane.active')].map((p) => p.id),
      len: document.body.innerHTML.length,
    });

    /* Every tab the page exposes, not a sample. */
    const names = [...document.querySelectorAll('.bk-tab')].map((t) => t.id.replace('tab-', ''));
    for (const n of names) {
      const btn = document.getElementById('tab-' + n);
      const before = snap();
      btn.click();
      await new Promise((s) => setTimeout(s, 200));
      const after = snap();
      r.clicks.push({
        n,
        tabMoved: after.tab === 'tab-' + n,
        paneShown: after.panes.length === 1 && after.panes[0] === 'pane-' + n,
        changed: before.tab !== after.tab || before.len !== after.len ||
                 before.panes.join() !== after.panes.join(),
      });
    }

    /* exactly one pane visible at a time */
    r.singlePane = document.querySelectorAll('.bk-pane.active').length === 1;

    /* search */
    const input = document.getElementById('bkSearch');
    const total = document.querySelectorAll('.qa-tile').length;
    input.value = 'sacco';
    window.filterBankCards();
    const afterFilter = [...document.querySelectorAll('.qa-tile')].filter((t) => t.style.display !== 'none').length;
    input.value = 'zzzznomatch';
    window.filterBankCards();
    const none = [...document.querySelectorAll('.qa-tile')].filter((t) => t.style.display !== 'none').length;
    const emptyEl = document.getElementById('bkSearchEmpty');
    r.search = {
      total, afterFilter, none,
      emptyShown: !!(emptyEl && emptyEl.style.display !== 'none' && emptyEl.textContent),
    };
    input.value = '';
    window.filterBankCards();
    r.search.restored = [...document.querySelectorAll('.qa-tile')].filter((t) => t.style.display !== 'none').length;

    /* apply modal */
    window.openApplyModal('Emergency Loan', 'Any Bank');
    const m = document.getElementById('bkApplyModal');
    r.modal.opened = !!m;
    r.modal.hasUssd = !!(m && /\*234#/.test(m.textContent));
    r.modal.isDialog = !!(m && m.getAttribute('role') === 'dialog');
    r.modal.tapTargets = m ? [...m.querySelectorAll('a,button')]
      .filter((b) => b.getBoundingClientRect().height < 40).length : -1;
    /* opening twice must not stack two modals */
    window.openApplyModal('Emergency Loan', 'Any Bank');
    r.modal.noStack = document.querySelectorAll('#bkApplyModal').length === 1;
    const closeBtn = m && m.querySelector('button');
    if (closeBtn) closeBtn.click();
    r.modal.closes = !document.getElementById('bkApplyModal');

    return r;
  });

  console.log('\n── Functions exist ──');
  ck('showTab defined',         out.fns.showTab === 'function');
  ck('filterBankCards defined', out.fns.filterBankCards === 'function');
  ck('openApplyModal defined',  out.fns.openApplyModal === 'function');

  console.log('\n── Every tab does something (' + out.clicks.length + ' tabs) ──');
  const dead = out.clicks.filter((c) => !c.changed);
  const noTab = out.clicks.filter((c) => !c.tabMoved);
  const noPane = out.clicks.filter((c) => !c.paneShown);
  ck('no tab is inert',          dead.length === 0,   dead.map((d) => d.n).join(', '));
  ck('active tab always moves',  noTab.length === 0,  noTab.map((d) => d.n).join(', '));
  ck('matching pane is shown',   noPane.length === 0, noPane.map((d) => d.n).join(', '));
  ck('exactly one pane visible', out.singlePane === true);

  console.log('\n── Search ──');
  ck('filters the tiles',        out.search.afterFilter > 0 && out.search.afterFilter < out.search.total,
     out.search.afterFilter + '/' + out.search.total);
  ck('no-match hides all',       out.search.none === 0);
  ck('explains a no-match',      out.search.emptyShown === true);
  ck('clearing restores all',    out.search.restored === out.search.total);

  console.log('\n── Compare & Apply ──');
  ck('modal opens',              out.modal.opened === true);
  ck('carries real USSD codes',  out.modal.hasUssd === true);
  ck('is a dialog',              out.modal.isDialog === true);
  ck('no tap target under 40px', out.modal.tapTargets === 0, String(out.modal.tapTargets));
  ck('does not stack',           out.modal.noStack === true);
  ck('closes',                   out.modal.closes === true);

  console.log('\n── Responsive ──');
  for (const d of DEVICES) {
    const p2 = await (await br.newContext({ ...devices[d] })).newPage();
    await p2.goto(B + '/banking.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await p2.waitForTimeout(6500);
    const m = await p2.evaluate(() => {
      document.querySelectorAll('.bk-tab')[3].click();
      return {
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        small: [...document.querySelectorAll('.qa-tile,.bk-tab')]
          .filter((b) => { const r = b.getBoundingClientRect(); return r.height > 0 && r.height < 40; }).length,
      };
    });
    ck(d + ' — no horizontal scroll', m.overflow === false);
    ck(d + ' — no tap target under 40px', m.small === 0, String(m.small));
    await p2.close();
  }

  /* "ResizeObserver loop completed with undelivered notifications" is a benign
     WebKit notice, and it is PRE-EXISTING: it appears identically on unmodified
     HEAD with no clicks at all (verified by stashing the patch and re-running).
     Asserting zero errors would fail on a defect this sprint did not introduce;
     ignoring errors wholesale would hide one it did. So it is excluded by name
     and everything else still has to be zero.

     The second exclusion is a harness artifact rather than a page defect:
     clicking tabs makes sokoni-observability.js POST to the live recordMetric
     Cloud Function, and this suite serves from 127.0.0.1, which that function's
     CORS policy does not allow. It cannot occur from the production origin. It
     is absent from the load-only run, which is why it does not appear on HEAD. */
  const KNOWN = /ResizeObserver loop completed with undelivered notifications|recordMetric.*access control/;
  const introduced = errs.filter((e) => !KNOWN.test(e));
  ck('no page errors introduced', introduced.length === 0, introduced[0] || '');
  if (errs.length !== introduced.length) {
    console.log('        (1 pre-existing ResizeObserver notice ignored — present on HEAD too)');
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  /* REPORT FIRST, THEN TEAR DOWN — teardown must never decide the verdict.
     Measured in the gate: suites printed every assertion PASS and were then SIGKILLed
     at their budget because close() never returned, so a finished result was recorded
     as TIMEOUT -- a non-blocking verdict -- and its coverage vanished silently. */
  await Promise.race([
    (async () => { try { await br.close(); } catch (_) {} })(),
    new Promise((r) => setTimeout(r, 8000)),
  ]);
  try { srv.close(); } catch (_) {}
  process.exit(fail ? 1 : 0);
});
