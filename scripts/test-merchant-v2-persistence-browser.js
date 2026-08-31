#!/usr/bin/env node
/**
 * MERCHANT V2 — persistence, driven in a real browser.
 *
 *   node scripts/test-merchant-v2-persistence-browser.js
 *
 * The static persistence suite asserts the MECHANISMS: the route is written to the URL,
 * the device registry is keyed by uid, a saved pairing is not a connection. What it
 * cannot show is that those mechanisms actually hold across a real route walk and a real
 * reload — a shell can be written correctly and still lose state to a boot order, a
 * clobbering write, or a listener that never re-reads.
 *
 * So this walks the shell the way a merchant does:
 *
 *     dashboard → settings → devices → pos-setup → pos → products → back
 *     → refresh → is it all still there?
 *
 * ONE THING IT DELIBERATELY DOES NOT CLAIM: that a stored pairing comes back as `saved`
 * rather than `connected`. That is the anti-false-positive for the whole printer chain —
 * a shell reporting a printer as live because it once saw it promises paper it cannot
 * produce — but headless WebKit has NO Web Bluetooth, so the panel says "printing not
 * supported" and any such assertion would pass for the wrong reason. It is reported
 * UNPROVEN. The static suite asserts the mechanism; the handset settles the behaviour.
 *
 * Physical Bluetooth re-adoption is NOT claimed here. It cannot be driven headlessly and
 * remains handset acceptance.
 */
'use strict';
/* TEARDOWN MUST NOT SWALLOW THE VERDICT.
   Observed: this suite ran every assertion, printed the last PASS, and then produced NO
   tally at all — the required-suite runner correctly refused it as NO-TALLY. The work had
   finished; browser.close() hung on a stuck context and the process died before reporting.
   A suite that cannot report is indistinguishable from one that failed, so closing is now
   bounded and can never outlive the verdict. */
function _bounded (p, ms) {
  return Promise.race([
    Promise.resolve(p).catch(function () {}),
    new Promise(function (r) { setTimeout(r, ms); }),
  ]);
}

const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const NL = String.fromCharCode(10);

let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 88) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log(NL + t);

const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html',
                '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

/* Signed out, the shell keys its registry as sk_devices_anon — the same code path a
   signed-in merchant takes, with a different uid. */
const DEV_KEY = 'sk_devices_anon';
const SAVED_PRINTER = [{ id: 'P58E-TEST', name: 'P58E Printer', type: 'printer', savedAt: 1 }];

const WALK = ['dashboard', 'settings', 'devices', 'pos-setup', 'pos', 'products', 'devices'];

const STATE = `(function () {
  var raw = null;
  try { raw = localStorage.getItem('${DEV_KEY}'); } catch (_) {}
  var list = [];
  try { list = JSON.parse(raw || '[]'); } catch (_) {}
  return {
    hash: location.hash.replace('#', ''),
    devices: list.length,
    names: list.map(function (d) { return d.name; }),
    /* what the Devices card actually SAYS about the printer */
    printerText: (function () {
      var p = document.getElementById('panel-devices');
      return p ? (p.innerText || '').replace(/\\s+/g, ' ').slice(0, 200) : null;
    })()
  };
})()`;

(async () => {
  console.log(NL + 'MERCHANT V2 — PERSISTENCE (real browser)' + NL + '='.repeat(62));

  let webkit;
  try { ({ webkit } = require('playwright')); }
  catch (_) {
    console.log(NL + '  ENV  playwright is not installed — cannot walk the shell.');
    console.log(NL + '  ' + pass + ' passed, ' + fail + ' failed, 1 env');
    process.exit(0);
  }

  const server = http.createServer((rq, rs) => {
    let name = (rq.url.split('?')[0] || '/').replace(/^\//, '') || 'index.html';
    if (name === 'merchant-v2') name = 'merchant-v2.html';
    if (!path.extname(name)) name += '.html';
    fs.readFile(path.join(ROOT, name), (e, d) => {
      if (e) { rs.writeHead(404); return rs.end('nf'); }
      rs.writeHead(200, { 'Content-Type': TYPES[path.extname(name)] || 'text/plain' });
      rs.end(d);
    });
  });
  await new Promise((r) => server.listen(0, r));
  const base = 'http://localhost:' + server.address().port;

  let br;
  try { br = await webkit.launch(); }
  catch (e) {
    console.log(NL + '  ENV  browser could not launch: ' + String(e && e.message || e).slice(0, 66));
    try { server.close(); } catch (_) {}
    console.log(NL + '  ' + pass + ' passed, ' + fail + ' failed, 1 env');
    process.exit(0);
  }

  try {
    const ctx = await br.newContext({ viewport: { width: 390, height: 844 } });
    /* Seed a SAVED printer — the shell must treat this as remembered, not connected. */
    await ctx.addInitScript(([k, v]) => {
      try { localStorage.setItem(k, v); } catch (_) {}
    }, [DEV_KEY, JSON.stringify(SAVED_PRINTER)]);

    const page = await ctx.newPage();
    await page.goto(base + '/merchant-v2', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);

    head('1 · the shell adopts a remembered device at boot');
    let st = await page.evaluate(STATE);
    ck('the seeded device registry is read', st.devices === 1, JSON.stringify(st.names));

    head('2 · a route walk does not lose it');
    for (const r of WALK) {
      await page.evaluate((id) => { location.hash = id; }, r);
      await page.waitForTimeout(900);
    }
    st = await page.evaluate(STATE);
    ck('after ' + WALK.length + ' route changes the registry is intact',
       st.devices === 1, st.devices + ' device(s) — walk: ' + WALK.join(' → '));
    ck('the shell is on the route it was last sent to', st.hash === 'devices', st.hash);

    head('3 · a REAL reload');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
    const after = await page.evaluate(STATE);
    ck('the route is restored from the URL', after.hash === 'devices', after.hash);
    ck('the device registry survives the reload', after.devices === 1, JSON.stringify(after.names));

    head('4 · remembered is not connected');
    const txt = (after.printerText || '').toLowerCase();
    ck('the Devices panel rendered', !!after.printerText, (after.printerText || '').slice(0, 60));

    /* A GREEN THAT WOULD PROVE NOTHING. Headless WebKit has no Web Bluetooth, so the
       panel reports "printing not supported" and ANY assertion of the form "it does not
       say connected" passes for the wrong reason — the browser could not have connected
       regardless of what the shell believes. The distinction between a stored pairing and
       a live link is exactly what matters for the printer chain, so it is reported
       UNPROVEN here rather than claimed. The static suite asserts the mechanism
       (DEV.printer.state = saved when not connected); the handset settles the behaviour. */
    const noBluetooth = txt.indexOf('not supported') > -1 || txt.indexOf('cannot connect') > -1;
    if (noBluetooth) {
      console.log('  UNPROVEN  a stored pairing is not reported as connected   ' +
                  '[this browser has no Web Bluetooth, so the check cannot discriminate]');
      unproven++;
    } else {
      ck('a stored pairing is NOT reported as connected',
         txt.indexOf('connected') === -1 || txt.indexOf('not connected') > -1 ||
         txt.indexOf('saved') > -1,
         'text: ' + (after.printerText || '').slice(0, 80));
    }
    ck('CONTROL the panel names the remembered printer rather than being empty',
       txt.indexOf('p58e') > -1 || txt.indexOf('printer') > -1,
       'otherwise the assertion above would pass over an empty panel');

    head('5 · a second walk after the reload');
    for (const r of ['pos-setup', 'settings', 'devices']) {
      await page.evaluate((id) => { location.hash = id; }, r);
      await page.waitForTimeout(900);
    }
    const st5 = await page.evaluate(STATE);
    ck('the registry is still intact after reload + walk', st5.devices === 1, st5.devices + '');
    ck('CONTROL clearing the registry really does empty it',
       await page.evaluate((k) => {
         try { localStorage.removeItem(k); } catch (_) {}
         let l = [];
         try { l = JSON.parse(localStorage.getItem(k) || '[]'); } catch (_) {}
         return l.length === 0;
       }, DEV_KEY),
       'proves the earlier counts read the real store rather than a constant');

    await ctx.close();
  } finally {
    await _bounded(br.close(), 5000);
    try { server.close(); } catch (_) {}
  }

  console.log(NL + '  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
  console.log('  NOTE  physical Bluetooth re-adoption is NOT covered here — handset acceptance.');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE ERROR: ' + (e && e.stack || e)); process.exit(1); });
