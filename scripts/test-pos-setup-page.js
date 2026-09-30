/* CERTIFICATION — the POS Setup page (owner, 2026-09-29).

   One scrolling page after sign-in: Business · Branch · Device · Payments · Receipt · Hardware · Diagnostics ·
   Commission. Drives the REAL page in a browser (WebKit iPhone 13 and Chromium desktop) with every server call
   stubbed by overriding the page's own CF / SPOS globals, so each state is exercised on purpose:

     L-*  layout: four steps, the sections in order, the chip bar, no overflow at 320 / 1280, no page errors
     C-*  chips: GREEN only from server answers — never from localStorage; informational sections never green
     B-*  business: a DROPDOWN of the server's businesses, each with its type; a FAILED lookup is an error, not
          "create your business"; an empty answer offers Create with the business-type selector
     R-*  branch: chips; one branch is auto-selected and confirmed; several need a choice
     D-*  device: registerDevice gets a platform the server accepts, a device name and a device type; a refusal
          stays NOT registered; the chip turns green only when the server lists this device
     P-*  payments: IntaSend only; SOKONI Till / QR shown as "activates with your business wallet", no QR drawn,
          nothing Daraja left on the page
     T-*  receipt: rendered by SokoniReceiptDoc (the premium receipt) with SAMPLE, KRA PIN, the SOKONI QR and an
          EQUAL KRA slot that says "eTIMS pending" — never a fabricated KRA code; test print opens the print dialog
          when no printer is connected, sends the premium document (useDoc) when one is, and never claims a print
          that did not happen; the print service builds the premium receipt on paper and rejects look-alike KRA URLs
          (every legacy caller unchanged)
     H-*  hardware wizard and diagnostics embedded as sections, their back links and duplicate commission card hidden
     M-*  commission: 5% POS / 15% online, 07:00 collection, outstanding "—" (never a fabricated 0)
     E-*  edit mode (?edit=1) keeps a set-up merchant on the page

   Pointed at a tree whose pos-setup.html is the old seven-step wizard, the L/C/B/D/P/T/H/M/E checks fail. */
'use strict';
const { webkit, chromium, devices } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.resolve(process.env.REPAIR_ROOT || path.join(__dirname, '..'));

const T = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.ico': 'image/x-icon', '.json': 'application/json' };
const srv = http.createServer((q, r) => {
  let p = decodeURIComponent(q.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  let fp = path.join(ROOT, p);
  if (!fs.existsSync(fp) && fs.existsSync(fp + '.html')) fp += '.html';
  fs.readFile(fp, (e, d) => {
    if (e) { r.writeHead(404); return r.end('nf'); }
    r.writeHead(200, { 'Content-Type': T[path.extname(fp)] || 'text/plain' }); r.end(d);
  });
});

let pass = 0, fail = 0;
const _wd = setTimeout(() => { console.log('\n  WATCHDOG — suite exceeded 280s'); process.exit(1); }, 280000);
if (_wd && _wd.unref) _wd.unref();
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 110) + ']' : '')); ok ? pass++ : fail++; };

/* Stubs installed in the page: every server call the setup page makes, answered on purpose. */
const STUBS = `
  window.__calls = [];
  window.__srv = window.__srv || {};
  const _ans = (name, data) => {
    window.__calls.push({ name, data: JSON.parse(JSON.stringify(data || {})) });
    const h = window.__srv[name];
    if (typeof h === 'function') return Promise.resolve().then(() => h(data)).then((d) => ({ data: d }));
    return Promise.reject(Object.assign(new Error('no stub for ' + name), { code: 'functions/unavailable' }));
  };
  window.CF = (name) => (data) => _ans(name, data);
  window.SPOS = (op) => (data) => _ans(op, data);
`;

srv.listen(0, async () => {
  const B = 'http://127.0.0.1:' + srv.address().port;

  async function open(browserType, ctxOpts, url) {
    const br = await browserType.launch();
    const ctx = await br.newContext(ctxOpts);
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(B + (url || '/pos-setup.html'), { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);
    return { br, page, errs };
  }

  /* ── pass 1: iPhone 13 (WebKit) — the full behaviour ──────────────────────────────────────────── */
  const { br, page, errs } = await open(webkit, { ...devices['iPhone 13'] });
  /* This browser has no signed-in session, so the embedded consoles' own auth gates would navigate their frames to
     login.html. Blocking ONLY that navigation keeps each embedded page on its own document, so its embed guard, back
     links and commission card can be inspected for real. Nothing else is intercepted. */
  await page.route(/\/login(\.html)?(\?|$)/, (r) => r.abort());
  /* The embedded consoles load lazily, as soon as they come near the viewport — which can happen during any earlier
     section's scrolling. So their documents are watched from the start and each is inspected at ITS OWN
     DOMContentLoaded, the moment its embed guard (run while the page is parsed) has applied. A few seconds later this
     unauthenticated harness's frames are sent to login by each console's auth gate; inspecting then was racy. */
  const INSPECT = () => {
    const d = document, de = d.documentElement;
    const vis = (sel) => Array.from(d.querySelectorAll(sel)).some((e) => getComputedStyle(e).display !== 'none');
    const c = d.getElementById('cc-comm'); const card = c && c.closest('.cc-card');
    const panels = Array.from(d.querySelectorAll('.tab[data-panel]')).map((t) => t.dataset.panel);
    const adv = d.querySelector('.pos-header');
    return { url: location.pathname, embed: de.classList.contains('sk-setup-embed'), back: vis('.hw-header__back') || vis('.back-link'),
             backToPos: /Back to POS/.test(Array.from(d.querySelectorAll('a')).filter((a) => getComputedStyle(a).display !== 'none').map((a) => a.textContent).join(' ')),
             comm: card ? getComputedStyle(card).display : 'n/a',
             advancedShown: !!(adv && getComputedStyle(adv).display !== 'none') && d.body.classList.contains('sk-cc-advanced'),
             panels: panels.join(',') };
  };
  const embedSeen = {};
  const embedDone = new Promise((resolve) => {
    page.on('framenavigated', async (fr) => {
      const u = fr.url();
      /* The pages tidy their own address to drop ".html", so both spellings are accepted. */
      const key = /pos-hardware-wizard(\.html)?\?embed=setup/.test(u) ? 'hw' : /pos-printer-setup(\.html)?\?embed=setup/.test(u) ? 'dg' : null;
      if (!key || embedSeen[key]) return;
      embedSeen[key] = { pending: true };
      try { await fr.waitForLoadState('domcontentloaded'); await fr.waitForTimeout(150); embedSeen[key] = await fr.evaluate(INSPECT); }
      catch (e) { embedSeen[key] = { err: e.message }; }
      if (embedSeen.hw && !embedSeen.hw.pending && embedSeen.dg && !embedSeen.dg.pending) resolve();
    });
  });
  const hasSetup =await page.evaluate(() => typeof initSetupPage === 'function' && !!document.getElementById('chip-bar'));
  if (!hasSetup) {
    ck('L-1 the setup page exists (initSetupPage + chip bar)', false, 'not on this tree');
    console.log(`\n  ${pass} passed, ${fail + 30} failed`); await br.close(); srv.close(); process.exit(1);
  }
  await page.evaluate(STUBS);

  /* L — layout */
  const L = await page.evaluate(() => ({
    dots: document.querySelectorAll('.step-dot').length,
    oldSteps: ['step-5', 'step-6', 'step-7'].filter((id) => document.getElementById(id)).length,
    order: Array.from(document.querySelectorAll('#step-4 .setup-sec')).map((s) => s.id).join(','),
    chips: Array.from(document.querySelectorAll('#chip-bar .sc-chip')).map((c) => c.dataset.sec).join(','),
  }));
  ck('L-1 four steps (welcome, network, sign in, setup) — steps 5-7 are gone', L.dots === 4 && L.oldSteps === 0, L.dots + ' dots, old steps ' + L.oldSteps);
  ck('L-2 the sections, in order', L.order === 'sec-business,sec-branch,sec-device,sec-payments,sec-receipt,sec-hardware,sec-diagnostics,sec-commission,sec-finish', L.order);
  ck('L-3 one chip per section', L.chips === 'business,branch,device,payments,receipt,hardware,diagnostics,commission', L.chips);

  /* Enter the setup page as a signed-in merchant with two businesses, a set-up flag in localStorage and NO server
     confirmation yet — the chips must not be green. */
  await page.evaluate(() => {
    localStorage.setItem('sokoni_setup_complete', '1');
    localStorage.setItem('sokoni_merchant_id', 'BIZ1');
    window.__srv.getMyBusinesses = () => ({ businesses: [
      { merchantId: 'BIZ1', name: 'KASS SHOP', category: 'Retail Shop' },
      { merchantId: 'BIZ2', name: 'Mama Njeri Foods', category: 'Restaurant / Food' },
    ] });
    WIZ.user = { uid: 'u-owner', getIdTokenResult: async () => ({ claims: {} }) };
    goToStep(4);
  });
  await page.waitForTimeout(900);
  const C1 = await page.evaluate(() => Array.from(document.querySelectorAll('#chip-bar .sc-chip')).map((c) => c.dataset.sec + ':' + c.dataset.state));
  ck('C-1 no chip is green from localStorage alone (set-up flag present, no server answer)', !C1.some((x) => /:done$/.test(x)), C1.join(' '));
  ck('C-2 informational sections are never green', ['payments', 'diagnostics', 'commission'].every((k) => C1.includes(k + ':info')), C1.filter((x) => /payments|diagnostics|commission/.test(x)).join(' '));

  /* B — business dropdown */
  const B1 = await page.evaluate(() => {
    const sel = document.getElementById('biz-select');
    return sel ? Array.from(sel.options).map((o) => o.textContent.trim()) : null;
  });
  ck('B-1 a DROPDOWN of the server\'s businesses, each with its business type', !!B1 && B1.includes('KASS SHOP — Retail Shop') && B1.includes('Mama Njeri Foods — Restaurant / Food'), B1 && B1.join(' | '));

  await page.evaluate(() => {
    window.__srv.getBusinessConfig = () => ({ branches: [
      { id: 'BR-A', name: 'Nairobi CBD' }, { id: 'BR-B', name: 'Westlands' }, { id: 'BR-C', name: 'Kisumu' }] });
    window.__srv.getSetupStatus = () => ({ merchantId: 'BIZ1', hasBusiness: true, productionReady: false,
      checklist: { businessCreated: true, branchCreated: true, taxesConfigured: false, hardwareConnected: true } });
    window.__srv.getDeviceList = () => ({ devices: [] });
    const sel = document.getElementById('biz-select');
    sel.value = '0'; sel.dispatchEvent(new Event('change'));
  });
  await page.waitForTimeout(900);
  const R1 = await page.evaluate(() => ({
    type: (document.getElementById('biz-type-line') || {}).textContent || '',
    chips: document.querySelectorAll('#sec-branch .branch-card').length,
    cont: document.getElementById('btn-branch-continue').disabled,
    reg: document.getElementById('btn-dev-register').disabled,
    chip: Object.fromEntries(Array.from(document.querySelectorAll('#chip-bar .sc-chip')).map((c) => [c.dataset.sec, c.dataset.state])),
  }));
  ck('B-2 choosing a business shows its type and loads ITS branches', /Retail Shop/.test(R1.type) && R1.chips === 3, R1.type + ' · ' + R1.chips + ' branch chips');
  ck('R-1 several branches: branch chips, "Use this branch" disabled until one is chosen, device waits', R1.cont === true && R1.reg === true);
  ck('C-3 server-confirmed business turns its chip green; branch not chosen yet stays unconfirmed',
    R1.chip.business === 'done' && R1.chip.branch === 'pending', 'business ' + R1.chip.business + ', branch ' + R1.chip.branch);
  ck('C-4 an item the server reports missing is AMBER, one it confirms is GREEN (receipt/taxes vs hardware)',
    R1.chip.receipt === 'attention' && R1.chip.hardware === 'done', 'receipt ' + R1.chip.receipt + ', hardware ' + R1.chip.hardware);

  await page.evaluate(() => { selectBranch(1); document.getElementById('btn-branch-continue').click(); });
  await page.waitForTimeout(500);
  const R2 = await page.evaluate(() => ({
    reg: document.getElementById('btn-dev-register').disabled, label: document.getElementById('btn-dev-register').textContent,
    branch: document.getElementById('chip-branch').dataset.state, device: document.getElementById('chip-device').dataset.state,
  }));
  ck('R-2 a chosen branch is confirmed: branch chip green, "Register this device" enabled, device NOT green yet',
    R2.branch === 'done' && !R2.reg && /Register this device/.test(R2.label) && R2.device !== 'done', R2.branch + ' · ' + R2.label + ' · device ' + R2.device);

  /* D — device registration */
  await page.evaluate(() => {
    document.getElementById('dev-name').value = 'Front counter phone';
    window.__srv.bootstrapDevice = () => ({ products: [{}, {}], paymentMethods: [], loyalty: {}, business: { name: 'KASS SHOP', kraPin: 'P051234567X', phone: '0712000000' } });
    window.__srv.registerDevice = (d) => ({ ok: true });
    window.__srv.getDeviceList = () => ({ devices: [{ deviceId: localStorage.getItem('sokoni_device_id'), status: 'active', branchId: 'BR-B', deviceName: 'Front counter phone' }] });
    document.getElementById('btn-dev-register').click();
  });
  await page.waitForTimeout(3500);
  const D1 = await page.evaluate(() => {
    const reg = window.__calls.filter((c) => c.name === 'registerDevice').pop() || {};
    return { data: reg.data || {}, status: document.getElementById('dev-status').textContent,
             where: document.getElementById('dev-where').textContent, chip: document.getElementById('chip-device').dataset.state };
  });
  ck('D-1 registerDevice gets a platform the server ACCEPTS (never the raw navigator value)',
    ['web', 'android', 'ios', 'windows', 'linux'].includes(D1.data.platform), D1.data.platform);
  ck('D-2 …and the device name and type', D1.data.deviceName === 'Front counter phone' && ['pos_terminal', 'mobile_pos', 'tablet', 'kiosk'].includes(D1.data.deviceType), D1.data.deviceName + ' · ' + D1.data.deviceType);
  ck('D-3 the server lists this device → Registered, where, and the chip turns GREEN',
    /Registered as “Front counter phone”/.test(D1.status) && /KASS SHOP · Westlands/.test(D1.where) && D1.chip === 'done', D1.status + ' · ' + D1.where + ' · ' + D1.chip);

  await page.evaluate(() => { selectBranch(2); document.getElementById('btn-branch-continue').click(); });
  await page.waitForTimeout(400);
  const D2 = await page.evaluate(() => ({ label: document.getElementById('btn-dev-register').textContent, chip: document.getElementById('chip-device').dataset.state }));
  ck('D-4 choosing another branch offers to MOVE the device, and the device chip is no longer green until it moves',
    /Move this device to Kisumu/.test(D2.label) && D2.chip !== 'done', D2.label + ' · ' + D2.chip);

  await page.evaluate(() => {
    window.__srv.registerDevice = () => { throw Object.assign(new Error('platform must be one of…'), { code: 'functions/invalid-argument' }); };
    window.__srv.getDeviceList = () => ({ devices: [] });
    _devState = null;
    document.getElementById('btn-dev-register').click();
  });
  await page.waitForTimeout(3500);
  const D3 = await page.evaluate(() => ({ chip: document.getElementById('chip-device').dataset.state, status: document.getElementById('dev-status').textContent,
                                          label: document.getElementById('prov-label-1').textContent }));
  ck('D-5 a REFUSED registration stays not registered — never "ready (registration pending)", never green',
    D3.chip !== 'done' && /Not registered/.test(D3.status) && /not registered/i.test(D3.label) && !/pending/.test(D3.label), D3.status + ' · ' + D3.label + ' · ' + D3.chip);

  /* P — payments */
  const P1 = await page.evaluate(() => {
    const sec = document.getElementById('sec-payments');
    const html = document.body.innerHTML;
    return { tag: sec.querySelector('.sec-tag').textContent, badges: Array.from(sec.querySelectorAll('.pay-badge')).map((b) => b.textContent),
             drawnQr: sec.querySelectorAll('canvas,img').length, daraja: /Daraja|getPaymentDestination|pd-card-wrap|payment destination/i.test(html) };
  });
  ck('P-1 IntaSend is the payment provider shown', P1.tag === 'IntaSend', P1.tag);
  ck('P-2 SOKONI Till and SOKONI QR both "Activate with your business wallet", and NO QR is drawn',
    P1.badges.length === 2 && P1.badges.every((b) => /Activates with your business wallet/.test(b)) && P1.drawnQr === 0, P1.badges.join(' | ') + ' · drawn ' + P1.drawnQr);
  ck('P-3 nothing Daraja is left on the page (no payment-destination card, no callable)', P1.daraja === false);

  /* T — the premium receipt */
  await page.evaluate(() => _paintReceipt());
  const T1 = await page.evaluate(() => {
    const host = document.getElementById('rcpt-preview');
    const figs = Array.from(host.querySelectorAll('.rc-qr'));
    const boxes = figs.map((f) => f.querySelector('.rc-qr-box').getBoundingClientRect());
    const mm = host.getBoundingClientRect().width / (96 / 25.4);
    return { text: host.textContent, figs: figs.length, canvas: figs[0] ? figs[0].querySelectorAll('canvas').length : 0,
             kra: figs[1] ? figs[1].textContent : '', eq: boxes.length === 2 && Math.abs(boxes[0].width - boxes[1].width) < 1 && Math.abs(boxes[0].height - boxes[1].height) < 1,
             side: boxes.length === 2 && Math.abs(boxes[0].top - boxes[1].top) < 1 && boxes[0].right <= boxes[1].left,
             mm: Math.round(mm), paper: host.dataset.paper,
             docApi: !!(window.SokoniReceiptDoc && window.SokoniReceiptDoc.isKraEtimsUrl) };
  });
  ck('T-1 the preview IS the premium receipt (SokoniReceiptDoc): SAMPLE notice, SOKONI, the business, KRA PIN, payment',
    T1.docApi && /SAMPLE \/ TEST — NOT A SALES/.test(T1.text) && /KASS SHOP/.test(T1.text) && /KRA PIN: P051234567X/.test(T1.text) && /PAYMENT/.test(T1.text) && /Bravilex/.test(T1.text), T1.text.replace(/\s+/g, ' ').slice(0, 100));
  ck('T-2 two EQUAL codes SIDE BY SIDE (left SOKONI, right KRA "eTIMS pending") on a 58mm receipt',
    T1.figs === 2 && T1.canvas === 1 && /eTIMS pending/.test(T1.kra) && T1.eq && T1.side && T1.paper === '58mm' && T1.mm === 58,
    T1.figs + ' codes, equal ' + T1.eq + ', side by side ' + T1.side + ', ' + T1.mm + 'mm');
  const T2 = await page.evaluate(() => {
    const R = window.SokoniReceiptDoc;
    const real = R.render({ receiptId: 'R1', etims: { invoiceNo: 'KRA123', qrUrl: 'https://itax.kra.go.ke/v?i=1' } }, {});
    const fake = R.render({ receiptId: 'R2', etimsQrUrl: 'https://kra.go.ke.evil.example/v' }, {});
    const samp = R.render({ sample: true, receiptId: 'S', etims: { qrUrl: 'https://itax.kra.go.ke/v?i=2' } }, {});
    const cl = (d) => d.blocks.find((b) => b.type === 'closing').kraQr;
    return { real: cl(real), fake: cl(fake), samp: cl(samp), inv: real.blocks.find((b) => b.type === 'reference').lines.join('|') };
  });
  ck('T-3 a KRA code only from a real kra.go.ke eTIMS URL (with its invoice number); a look-alike host is "pending"',
    T2.real.url === 'https://itax.kra.go.ke/v?i=1' && /eTIMS Inv: KRA123/.test(T2.inv) && T2.fake.pending === true && T2.fake.url === null, JSON.stringify(T2.fake));
  ck('T-4 a SAMPLE never carries a KRA code, even if handed one', T2.samp.pending === true && T2.samp.url === null);

  await page.evaluate(() => {
    window.__printed = 0; window.print = () => { window.__printed++; };
    window.__prCalls = [];
    window._printerConnected = () => false;   /* the engine's connected is a read-only getter: stub the page's own check */
    if (window.PosPrintService) {
      window.PosPrintService.autoReconnect = async () => false;
      window.PosPrintService.printReceipt = async (o, c) => { window.__prCalls.push({ o, c }); return { status: 'success' }; };
    }
  });
  await page.evaluate(() => _testPrintSample());
  const T3 = await page.evaluate(() => ({ printed: window.__printed, calls: window.__prCalls.length, st: document.getElementById('rcpt-status').textContent }));
  ck('T-5 no printer connected → the device print dialog opens; nothing is sent and nothing claims "sent"',
    T3.printed === 1 && T3.calls === 0 && /print dialog/.test(T3.st) && !/sent to your printer/.test(T3.st), T3.st);
  await page.evaluate(() => {
    window.__printed = 0;
    window._printerConnected = () => true;
  });
  await page.evaluate(() => _testPrintSample());
  const T4 = await page.evaluate(() => { const c = window.__prCalls.pop() || { c: {} }; return { printed: window.__printed, useDoc: !!c.c.useDoc,
    sample: !!(c.c.doc && c.c.doc.sample), st: document.getElementById('rcpt-status').textContent }; });
  ck('T-6 a connected printer gets the PREMIUM sample document (useDoc, marked sample) and only then says "sent"',
    T4.useDoc && T4.sample && T4.printed === 0 && /Sample sent to your printer/.test(T4.st), T4.st);
  await page.evaluate(() => { window.__printed = 0; window.PosPrintService.printReceipt = async () => ({ status: 'queued_offline', queued: true }); });
  await page.evaluate(() => _testPrintSample());
  const T5 = await page.evaluate(() => ({ printed: window.__printed, st: document.getElementById('rcpt-status').textContent }));
  ck('T-7 a job that was only QUEUED is not reported as printed — the print dialog opens instead',
    T5.printed === 1 && !/Sample sent/.test(T5.st), T5.st);

  /* the print service on paper — premium document path, and the legacy path's KRA slot */
  const T6 = await page.evaluate(() => {
    const svc = window.PosPrintService; const R = window.SokoniReceiptDoc;
    if (!svc || typeof svc._buildDocReceipt !== 'function') return { err: 'no _buildDocReceipt' };
    const dec = (u8) => Array.from(u8).map((c) => (c >= 32 && c < 127) || c === 10 ? String.fromCharCode(c) : ' ').join('');
    /* the side-by-side image header: GS v 0 m xL xH yL yH — xL/xH is the width in BYTES (8 dots each) */
    const raster = (u8) => { for (let i = 0; i + 7 < u8.length; i++) {
      if (u8[i] === 0x1d && u8[i + 1] === 0x76 && u8[i + 2] === 0x30) return { dots: (u8[i + 4] | (u8[i + 5] << 8)) * 8, rows: u8[i + 6] | (u8[i + 7] << 8) }; }
      return null; };
    const doc = R.render(_sampleInput(), { sample: true });
    svc.till.update('default', { paperWidth: '58mm' });
    const p58 = svc._buildDocReceipt(doc, {});
    svc.till.update('default', { paperWidth: '80mm' });
    const p80 = svc._buildDocReceipt(doc, {});
    svc.till.update('default', { paperWidth: '58mm' });
    const legacyFake = dec(svc._buildSaleReceipt({ receiptNo: 'L1', total: 5, etimsQrUrl: 'https://kra.go.ke.evil.example/x' }, {}));
    const legacyReal = dec(svc._buildSaleReceipt({ receiptNo: 'L2', total: 5, etimsQrUrl: 'https://itax.kra.go.ke/v?i=9' }, {}));
    return { paper: dec(p58), r58: raster(p58), r80: raster(p80), legacyFake, legacyReal };
  });
  ck('T-8 on paper the premium document prints SAMPLE, the KRA PIN, and the two codes as ONE side-by-side image captioned mysokoni.co.ke | eTIMS pending',
    !T6.err && /SAMPLE \/ TEST - NOT A SALES/.test(T6.paper) && /KRA PIN: P051234567X/.test(T6.paper) && !!T6.r58 && /mysokoni\.co\.ke\s+eTIMS pending/.test(T6.paper), T6.err || JSON.stringify(T6.r58));
  ck('T-9 the legacy sale receipt draws the KRA code only for a real kra.go.ke URL (a look-alike is "eTIMS pending")',
    !T6.err && /eTIMS pending/.test(T6.legacyFake) && !/evil/.test(T6.legacyFake) && /KRA eTIMS/.test(T6.legacyReal) && !/eTIMS pending/.test(T6.legacyReal));
  ck('T-11 the side-by-side image FITS the paper: exactly 384 dots at 58mm, 576 at 80mm',
    !T6.err && T6.r58 && T6.r58.dots === 384 && T6.r80 && T6.r80.dots === 576, JSON.stringify(T6.r58) + ' / ' + JSON.stringify(T6.r80));

  /* any receipt size — the preview follows the till's own paper width, and choosing one saves it there */
  await page.evaluate(() => document.querySelector('.rcpt-size-btn[data-paper="80mm"]').click());
  const T7 = await page.evaluate(() => {
    const host = document.getElementById('rcpt-preview');
    const pre = host.querySelector('.rc-text');
    const longest = Math.max.apply(null, pre.textContent.split('\n').map((l) => l.length));
    return { paper: host.dataset.paper, mm: Math.round(host.getBoundingClientRect().width / (96 / 25.4)), cols: longest,
             saved: window.PosPrintService.till.get('default').paperWidth,
             pressed: document.querySelector('.rcpt-size-btn[data-paper="80mm"]').getAttribute('aria-pressed') };
  });
  ck('T-10 choosing 80mm: an 80mm receipt at 48 columns, and the till\'s paper width is saved as 80mm',
    T7.paper === '80mm' && T7.mm === 80 && T7.cols === 48 && T7.saved === '80mm' && T7.pressed === 'true', JSON.stringify(T7));
  await page.evaluate(() => document.querySelector('.rcpt-size-btn[data-paper="58mm"]').click());

  /* M — commission */
  const M1 = await page.evaluate(() => ({ pos: document.getElementById('comm-pos-rate').textContent, onl: document.getElementById('comm-online-rate').textContent,
    out: document.getElementById('comm-outstanding').textContent, txt: document.getElementById('sec-commission').textContent }));
  ck('M-1 5% of every POS / Till sale, 15% of online sales on every package', M1.pos === '5%' && M1.onl === '15%', M1.pos + ' / ' + M1.onl);
  ck('M-2 collected daily at 07:00 once the business wallet is live; outstanding shows "—", never a fabricated 0',
    /07:00/.test(M1.txt) && /business wallet/.test(M1.txt) && M1.out === '—', M1.out);

  /* H — embedded consoles.
     Each embedded document is inspected at ITS OWN DOMContentLoaded — the moment its embed guard (which runs while the
     page is parsed) has applied. This harness has no signed-in session, so a few seconds later each console's auth
     gate navigates its frame to login; inspecting after that measured the redirect, not the embed, and was racy. */
  await page.evaluate(() => document.getElementById('sec-hardware').scrollIntoView());
  await page.waitForTimeout(1500);
  await page.evaluate(() => document.getElementById('sec-diagnostics').scrollIntoView());
  await Promise.race([embedDone, page.waitForTimeout(15000)]);
  const H1 = await page.evaluate(() => ({ hwSrc: document.getElementById('frame-hardware').getAttribute('src') || '',
                                          dgSrc: document.getElementById('frame-diagnostics').getAttribute('src') || '' }));
  H1.hw = embedSeen.hw || { err: 'hardware frame never loaded' };
  H1.dg = embedSeen.dg || { err: 'diagnostics frame never loaded' };
  ck('H-1 the hardware wizard and the diagnostics console are SECTIONS of this page (embedded, loaded on scroll)',
    /pos-hardware-wizard\.html\?embed=setup/.test(H1.hwSrc) && /pos-printer-setup\.html\?embed=setup/.test(H1.dgSrc), H1.hwSrc + ' | ' + H1.dgSrc);
  ck('H-2 the diagnostics console renders EMBEDDED, with no back link and no "Back to POS"', H1.dg.embed && !H1.dg.back && !H1.dg.backToPos, JSON.stringify(H1.dg));
  ck('H-3 embedded, the console\'s own commission card is hidden — one commission statement per page', H1.dg.comm === 'none', H1.dg.comm);
  ck('H-4 the hardware wizard renders EMBEDDED, with its "Back to POS" hidden', H1.hw.embed && !H1.hw.back && !H1.hw.backToPos, JSON.stringify(H1.hw));
  /* Every tab the console itself declares — derived from its source, never a hand-kept list. */
  const ALL_TABS = Array.from(fs.readFileSync(path.join(ROOT, 'pos-printer-setup.html'), 'utf8')
    .matchAll(/class="tab[^"]*" data-panel="([^"]+)"/g)).map((m) => m[1]).join(',');
  ck('H-6 ALL the advanced diagnostics are there: embedded, the console opens its full advanced view with every tab',
    H1.dg.advancedShown === true && H1.dg.panels === ALL_TABS, (H1.dg.advancedShown ? 'advanced view' : 'summary view') + ' · ' + H1.dg.panels);
  /* What this browser cannot show: the consoles' SIGNED-IN content (devices, printers). That needs a real session. */
  console.log('  UNPROVEN  H-5 the embedded consoles\' signed-in content (paired devices, printer state) — needs a real merchant session');

  /* layout and errors on the phone */
  const ov = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  ck('L-4 no horizontal overflow on a phone', ov.sw <= ov.cw + 1, ov.sw + ' > ' + ov.cw);
  const realErrs = errs.filter((e) => !/Firebase|appCheck|App Check|recaptcha|network|Failed to fetch|auth\/|installations|gstatic|access control checks|^cancelled$/i.test(e));
  ck('L-5 no unexpected page errors (phone)', realErrs.length === 0, realErrs.join(' | '));
  await br.close();

  /* ── pass 2: failure and empty business answers (fresh page) ─────────────────────────────────── */
  {
    const { br: b2, page: p2 } = await open(webkit, { ...devices['iPhone 13'] });
    await p2.evaluate(STUBS);
    await p2.evaluate(() => {
      window.__srv.getMyBusinesses = () => { throw Object.assign(new Error('boom'), { code: 'functions/unavailable' }); };
      WIZ.user = { uid: 'u2', getIdTokenResult: async () => ({ claims: {} }) };
      goToStep(4);
    });
    await p2.waitForTimeout(1200);
    const F = await p2.evaluate(() => ({ err: document.getElementById('biz-error').classList.contains('visible') ? document.getElementById('biz-error').textContent : '',
                                         create: !!document.getElementById('cb-name') }));
    ck('B-3 a FAILED business lookup is shown as an error — not as "create your first business"', !!F.err && !F.create, F.err);
    await p2.evaluate(() => { window.__srv.getMyBusinesses = () => ({ businesses: [] }); initBizStep(); });
    await p2.waitForTimeout(900);
    const E = await p2.evaluate(() => ({ create: !!document.getElementById('cb-name'), cats: document.querySelectorAll('#cb-category option').length }));
    ck('B-4 an EMPTY answer offers Create business, with the business-type selector', E.create && E.cats >= 5, E.cats + ' types');
    await b2.close();
  }

  /* ── pass 3: desktop Chromium, edit mode ─────────────────────────────────────────────────────── */
  {
    const { br: b3, page: p3, errs: e3 } = await open(chromium, { viewport: { width: 1280, height: 900 } }, '/pos-setup.html?edit=1');
    const E1 = await p3.evaluate(() => ({ path: location.pathname, edit: /edit=1/.test(location.search) }));
    ck('E-1 edit mode keeps a set-up merchant ON the setup page (no bounce to POS)', /pos-setup/.test(E1.path) && E1.edit, E1.path);
    const ov3 = await p3.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    ck('L-6 no horizontal overflow on desktop', ov3.sw <= ov3.cw + 1, ov3.sw + ' > ' + ov3.cw);
    const re3 = e3.filter((e) => !/Firebase|appCheck|App Check|recaptcha|network|Failed to fetch|auth\/|installations|gstatic|access control checks|^cancelled$/i.test(e));
    ck('L-7 no unexpected page errors (desktop)', re3.length === 0, re3.join(' | '));
    await b3.close();
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  srv.close(); clearTimeout(_wd); process.exit(fail ? 1 : 0);
});
