/* Seller board verification. Auth-gated, so this exercises the render path with
   injected orders rather than a real session — the point is proving that raw
   lifecycle values cannot reach the DOM and that actions match server rules. */
'use strict';
const { webkit, devices } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = '.';
const T = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.json':'application/json' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  if (!path.extname(p)) p += '.html';
  fs.readFile(path.join(ROOT, p), (e, d) => {
    if (e) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': T[path.extname(p)] || 'application/octet-stream' });
    res.end(d);
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
const check = (l, ok, d) => { console.log('  ' + (ok?'PASS  ':'FAIL  ') + l + (d?'   ['+d+']':'')); ok?pass++:fail++; };

/* Orders spanning every vocabulary, including ones only the timeline engine writes. */
const ORDERS = [
  { id:'A1', orderNo:'SKN-001', total:2336, recipientName:'Ann Momanyi', status:'paid',                               createdAt:Date.now()-5*60000 },
  { id:'A2', orderNo:'SKN-002', total:900,  recipientName:'Delia Baraka', status:'paid', timelineStage:'preparing',   createdAt:Date.now()-20*60000 },
  { id:'A3', orderNo:'SKN-003', total:1500, recipientName:'Isaac K',      status:'paid', deliveryStatus:'driver_assigned', createdAt:Date.now()-40*60000 },
  { id:'A4', orderNo:'SKN-004', total:4200, recipientName:'Fahim M',      status:'paid', timelineStage:'halfway',     createdAt:Date.now()-90*60000 },
  { id:'A5', orderNo:'SKN-005', total:300,  recipientName:'Grace W',      status:'refunded',                          createdAt:Date.now()-200*60000 },
  { id:'A6', orderNo:'SKN-006', total:750,  recipientName:'Unknown Co',   status:'teleported',                        createdAt:Date.now()-10*60000 },
  { id:'A7', orderNo:'SKN-007', total:1200, recipientName:'Stale Order',  status:'pending',                           createdAt:Date.now()-300*60000, updatedAt:Date.now()-300*60000 },
];

/* Every raw value a merchant must never see. */
const RAW = ['driver_assigned','rider_assigned','driver_accepted','offered','exhausted',
             'picking_up','preparing','halfway','teleported','refunded','timelineStage','deliveryStatus'];

server.listen(0, async () => {
  const BASE = 'http://127.0.0.1:' + server.address().port;
  const browser = await webkit.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  const errs = [];
  /* WebKit emits this on any page with observed layout (shared-header). Benign,
     and present on /services and /product too — filtered by exact message so a
     real error is never hidden. */
  const BENIGN = /ResizeObserver loop completed/;
  page.on('pageerror', e => { const m = String(e.message); if (!BENIGN.test(m)) errs.push(m.slice(0,140)); });

  /* Stub Firebase before the page's module loads, so load() takes the injected path. */
  await page.addInitScript((orders) => {
    window.__ORDERS = orders;
    window.firebaseApp  = { __stub:true };
    window.firebaseAuth = { currentUser:{ uid:'SELLER1' }, onAuthStateChanged:(cb)=>cb({uid:'SELLER1'}) };
    window.firebaseDB   = { __stub:true };
  }, ORDERS);

  await page.goto(BASE + '/seller-fulfilment.html', { waitUntil:'domcontentloaded', timeout:30000 });
  await page.waitForTimeout(3000);

  /* The real query needs Firestore; drive the render path directly with the
     module the page already loaded, so we test the same code. */
  const out = await page.evaluate((orders) => {
    const L = window.SokoniLifecycle;
    if (!L) return { err:'lifecycle missing' };
    const stages = orders.map(o => L.resolveStage(o));
    return {
      lifecycleLoaded: true,
      stages,
      labels: stages.map(s => L.label(s)),
      columns: L.boardColumns().map(c => c.label),
      actions: stages.map(s => L.sellerActions(s).map(a => a.label)),
      unknownCount: stages.filter(s => s === L.UNKNOWN).length,
      stalled: orders.map(o => L.isStalled(L.resolveStage(o), o.updatedAt || o.createdAt)),
    };
  }, ORDERS);

  console.log('\n── Page loads ──');
  check('no page errors', errs.length === 0, errs[0] || 'none');
  check('lifecycle module available', out.lifecycleLoaded === true, out.err || '');

  console.log('\n── Stage resolution across all vocabularies ──');
  const want = ['accepted','packing','assigned','in_transit','returned','unknown','pending'];
  out.stages.forEach((s, i) => check('order ' + ORDERS[i].orderNo + ' -> ' + s, s === want[i], want[i]));

  console.log('\n── No raw value reaches the merchant ──');
  const shown = JSON.stringify({ labels: out.labels, columns: out.columns, actions: out.actions });
  for (const r of RAW) check('"' + r + '" never rendered', !shown.includes(r));
  check('unknown renders as "Unknown"', out.labels[5] === 'Unknown', out.labels[5]);

  console.log('\n── Actions match server rules ──');
  check('pending offers Accepted',        out.actions[6].includes('Accepted'));
  check('accepted offers Packing',        out.actions[0].includes('Packing'));
  check('assigned offers NO seller action', out.actions[2].length === 0, JSON.stringify(out.actions[2]));
  check('in_transit offers NO seller action', out.actions[3].length === 0, JSON.stringify(out.actions[3]));
  check('returned offers NO seller action',   out.actions[4].length === 0, JSON.stringify(out.actions[4]));
  check('unknown offers NO action',           out.actions[5].length === 0, JSON.stringify(out.actions[5]));
  check('no action is ever "Delivered"',  !out.actions.some(a => a.includes('Delivered')));

  console.log('\n── Board shape + diagnostics ──');
  check('9 workflow columns', out.columns.length === 9, String(out.columns.length));
  check('Returned is not a workflow column', !out.columns.includes('Returned'));
  check('unknown orders counted for diagnostics', out.unknownCount === 1, String(out.unknownCount));
  check('300-min-old pending flagged stalled', out.stalled[6] === true);
  check('5-min-old order not stalled',         out.stalled[0] === false);

  /* ── RBAC: the board must not render a merchant workspace to a non-seller.
     Firestore rules already guarantee no data leaks; this asserts the page also
     refuses to imply the viewer has a seller account. ────────────────────── */
  console.log('\n── RBAC ──');
  const roleCase = async (label, cachedUser, expectSeller) => {
    const c2 = await browser.newContext({ ...devices['iPhone 13'] });
    const p2 = await c2.newPage();
    await p2.addInitScript((u) => {
      window.firebaseApp  = { __stub: true };
      window.firebaseDB   = { __stub: true };
      window.firebaseAuth = { currentUser: { uid: 'U1' }, onAuthStateChanged: (cb) => cb({ uid: 'U1' }) };
      if (u) localStorage.setItem('sokoniUser', JSON.stringify(u));
    }, cachedUser);
    await p2.goto(BASE + '/seller-fulfilment.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await p2.waitForTimeout(2500);
    const txt = await p2.evaluate(() => document.body.innerText);
    const refused = /This workspace is for sellers/i.test(txt);
    check(label, refused === !expectSeller, refused ? 'refused' : 'allowed');
    await c2.close();
  };
  await roleCase('buyer is refused',            { roles: ['buyer'], registeredAs: { user: true } }, false);
  await roleCase('rider is refused',            { roles: ['driver'] },                              false);
  await roleCase('no cached profile is refused', null,                                              false);
  await roleCase('registeredAs.seller allowed', { registeredAs: { seller: true } },                 true);
  await roleCase('roles[] seller allowed',      { roles: ['buyer', 'seller'] },                     true);

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  /* REPORT FIRST, THEN TEAR DOWN — teardown must never decide the verdict.
     Measured in the gate: suites printed every assertion PASS and were then SIGKILLed
     at their budget because close() never returned, so a finished result was recorded
     as TIMEOUT -- a non-blocking verdict -- and its coverage vanished silently. */
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
