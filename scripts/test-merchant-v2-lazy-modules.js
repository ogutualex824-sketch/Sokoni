/* ═══════════════════════════════════════════════════════════════════════════════════════════════
   v2 SURFACE MODULES LOAD ON DEMAND — network-certified
   (ported from 0bd20bc, 2026-08-20; extended 2026-10-01 to every native section + intent pre-load + Sell warm-up)
   ═══════════════════════════════════════════════════════════════════════════════════════════════
   merchant-v2 used to parse ~825 KB of section-module script at every start. Sections now load when their route
   is first opened (MODULE_SCRIPTS, keyed by route, dependency order).

   Certified on NETWORK COUNTS — a request either happened or it did not. THE HARNESS VALIDATES ITSELF before
   asserting anything: a probe that 404s every request reports a beautiful zero and means nothing.

   Data-saver is simulated for the boot checks (navigator.connection.saveData = true), which is exactly the
   condition under which the shell skips the idle Sell warm-up; a separate boot without it certifies that the
   warm-up fetches the till's files and NOTHING else.

     node scripts/test-merchant-v2-lazy-modules.js
   ═══════════════════════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : '')); ok ? pass++ : fail++; };
const un = (l, d) => { console.log('  UNPROVEN  ' + l + (d ? '   [' + d + ']' : '')); unproven++; };
const head = (t) => console.log('\n' + t);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.mjs': 'text/javascript', '.svg': 'image/svg+xml' };

console.log('\nv2 SURFACE MODULES — LOAD ON DEMAND');
console.log('='.repeat(76));

head('1 - the registry is the authority');
const html = fs.readFileSync(path.join(ROOT, 'merchant-v2.html'), 'utf8');
const code = html.replace(/<!--[\s\S]*?-->/g, ' ');
const REG = (function () { const m = /var MODULE_SCRIPTS = (\{[\s\S]*?\});/.exec(code); try { return m ? (new Function('return (' + m[1] + ');'))() : null; } catch (_) { return null; } }());
ck('MODULE_SCRIPTS exists alongside MODULES and parses', !!REG && /var MODULES = \{/.test(code), REG ? Object.keys(REG).length + ' routes' : 'missing');
const LAZY_FILES = REG ? [...new Set(Object.values(REG).flat())] : [];
const esc = (f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MODULE_RE = new RegExp('(' + LAZY_FILES.map(esc).join('|') + ')(\\?|$)');
ck('renderModule still drives every surface', /if \(MODULES\[id\]\) return renderModule/.test(code));
ck('no second routing system was introduced', (code.match(/function go \(/g) || []).length === 1);
ck('the eager tags for on-demand files are gone', LAZY_FILES.length > 0 && LAZY_FILES.every((f) => !new RegExp('<script[^>]*src="' + esc(f) + '"').test(code)));
ck('the route contract and shared authorities are STILL eager',
   ['sokoni-merchant-routes.js', 'sokoni-merchant-data.js', 'sokoni-receipt.js', 'sokoni-cash.js', 'sokoni-authority.js', 'sokoni-analytics-engine.js']
     .every((f) => new RegExp('<script[^>]*src="' + esc(f) + '"').test(code)));
ck('shopKey rebinding is preserved', /cur\.shopKey === key/.test(code) && /_scopeKey\(_scope\(\)\)/.test(code));
ck('a failed module load states the failure, never an empty panel', /could not load/.test(code) && /It is NOT empty/.test(code));
ck('the Sell warm-up respects save-data / 2G', /c\.saveData === true \|\| \/\(\^\|-\)2g\$\/\.test/.test(code));

(async () => {
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch (e) { un('every network control', 'playwright unavailable'); return done(); }
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent((req.url || '/').split('?')[0]);
    const file = path.join(ROOT, p.replace(/^\/+/, ''));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'text/plain' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch();
  const PROBE = (saveData) => `try{
    localStorage.setItem('loggedIn','true');
    localStorage.setItem('sokoniUser', JSON.stringify({uid:'zzz_lazy'}));
    localStorage.setItem('sokoniPrivacyAccepted','1');
  }catch(e){}
  ${saveData ? "try{Object.defineProperty(navigator,'connection',{configurable:true,get:function(){return {saveData:true,effectiveType:'4g'};}});}catch(e){}" : ''}`;

  async function boot(viewport, saveData) {
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    await page.addInitScript(PROBE(saveData));
    const mods = []; const all = []; let scripts = 0;
    page.on('request', (r) => {
      const u = r.url();
      if (/\.js(\?|$)/.test(u)) { scripts++; all.push(u.replace(/^.*\//, '').split('?')[0]); }
      const m = u.match(MODULE_RE);
      if (m) mods.push(m[1]);
    });
    await page.goto(BASE + '/merchant-v2.html', { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(3000);
    const chars = await page.evaluate('document.body.innerText.trim().length');
    return { ctx, page, mods, all, chars, scripts: () => scripts };
  }

  head('2 - HARNESS SELF-CHECK (a dead probe reports a perfect zero)');
  const s = await boot({ width: 390, height: 844 }, true);
  ck('the page actually executed', s.chars > 200, s.chars + ' rendered chars');
  ck('scripts were really fetched', s.scripts() >= 5, s.scripts() + ' script requests');
  if (s.chars < 200 || s.scripts() < 5) {
    console.error('\n  Harness invalid — refusing to report control results.\n');
    await browser.close(); await new Promise((r) => server.close(r)); return done();
  }

  head('3 - MOBILE boot (save-data) fetches ZERO on-demand section files');
  ck('on-demand section requests at boot = 0', s.mods.length === 0, s.mods.length ? s.mods.join(', ') : '0');

  head('4 - each route loads exactly its own files, once');
  for (const id of ['sell', 'products', 'customers', 'wallet']) {
    const need = REG[id] || [];
    const before = s.mods.length;
    await s.page.evaluate('window.__mgo && window.__mgo("' + id + '")').catch(() => {});
    await s.page.waitForTimeout(2500);
    const fetched = s.mods.slice(before);
    ck('  ' + id + ': its files were fetched', need.length > 0 && need.every((n) => fetched.indexOf(n) > -1), fetched.join(', ') || 'none');
    ck('  ' + id + ': nothing from another section was pulled in', fetched.every((f) => need.indexOf(f) > -1), fetched.join(', ') || 'none');
  }

  head('5 - revisiting a route re-fetches NOTHING');
  const beforeRevisit = s.mods.length;
  await s.page.evaluate('window.__mgo && window.__mgo("dashboard")').catch(() => {});
  await s.page.waitForTimeout(600);
  await s.page.evaluate('window.__mgo && window.__mgo("sell")').catch(() => {});
  await s.page.waitForTimeout(2000);
  ck('no additional section requests on return', s.mods.length === beforeRevisit, (s.mods.length - beforeRevisit) + ' extra');

  head('6 - opening sections never re-fetches the eager shared authorities');
  const shared = ['sokoni-merchant-data.js', 'sokoni-receipt.js', 'sokoni-cash.js'];
  ck('each shared authority was fetched exactly once', shared.every((f) => s.all.filter((x) => x === f).length === 1),
     shared.map((f) => f + '×' + s.all.filter((x) => x === f).length).join(', '));
  await s.ctx.close();

  head('7 - without save-data, the idle warm-up fetches the till and NOTHING else');
  const w = await boot({ width: 1280, height: 900 }, false);
  await w.page.waitForTimeout(6000);
  const sellFiles = REG.sell || [];
  ck('desktop: the page executed', w.chars > 200, w.chars + ' chars');
  ck('warm-up fetched every Sell file', sellFiles.every((f) => w.mods.indexOf(f) > -1), w.mods.join(', ') || 'none');
  ck('warm-up fetched no other section', w.mods.every((f) => sellFiles.indexOf(f) > -1), w.mods.join(', ') || 'none');
  const t0 = Date.now();
  await w.page.evaluate('window.__mgo && window.__mgo("sell")').catch(() => {});
  await w.page.waitForFunction('!!document.querySelector("[data-loading]") === false', null, { timeout: 4000 }).catch(() => {});
  ck('opening Sell after the warm-up adds no request', w.mods.filter((f) => sellFiles.indexOf(f) > -1).length === sellFiles.length, 'opened in ' + (Date.now() - t0) + ' ms');
  await w.ctx.close();

  head('8 - NEGATIVE CONTROL: the counter can reach non-zero');
  ck('a route DID drive section requests above zero', s.mods.length > 0, 'the boot zeros are therefore real, not a broken probe');

  await browser.close();
  await new Promise((r) => server.close(r));
  done();

  function done() {
    head('what this does NOT prove');
    un('the surfaces behave correctly once mounted', 'covered by their own suites');
    un('real-device network timing', 'desktop Chromium, no throttling — use the perf probe for timings');
    console.log('\n' + '='.repeat(76));
    console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
    console.log('='.repeat(76) + '\n');
    process.exit(fail ? 1 : 0);
  }
})().catch((e) => { console.error('\n  aborted: ' + (e && e.message) + '\n'); process.exit(1); });
