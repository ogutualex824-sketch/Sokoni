#!/usr/bin/env node
/* test-profile-command-prompt.js — the profile page has ONE command prompt, and it is fully visible and usable on
 * every device class. The profile page carries no AI assistant.
 *
 *   node scripts/test-profile-command-prompt.js                 # working tree — must PASS
 *   COUNTERPROOF=1 node scripts/test-profile-command-prompt.js  # profile.html + sokoni-command-palette.js @ 4e9607b
 *
 * Real code, real browsers (Chromium + WebKit), served from a fake origin (Playwright route; no network, no Firebase):
 *   - every <style> block of the REAL profile.html;
 *   - the REAL palette section of profile.html (NLP table → Ctrl+K binding), sliced verbatim;
 *   - the REAL global sokoni-command-palette.js (the header's palette, which also binds Ctrl+K);
 *   - a fixed header at the platform's header z-index (100002) and a measured --sk-header-h, like shared-header.js.
 *
 * PROVES
 *   P1  Ctrl+K opens exactly ONE command prompt, and it is the page's workspace palette — the same one the page's
 *       ⌘ button opens (the global palette hands off to it)
 *   P2  the header button (SokoniCP.open) opens the same single prompt
 *   P3  the search field is fully on screen and a tap at its centre hits it (not the header)
 *   P4  the whole prompt box fits the viewport (the list scrolls instead of running off the bottom)
 *   P5  on touch devices the search field is >= 16px (iOS Safari zooms into smaller focused fields)
 *   A1  profile.html loads no AI chat widget and offers no "Ask KASS" command
 */
'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const BASE = '4e9607b', CPM = !!process.env.COUNTERPROOF;
const read = (f) => (CPM ? cp.execFileSync('git', ['show', BASE + ':' + f], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6 }) : fs.readFileSync(path.join(ROOT, f), 'utf8'));
let pass = 0, fail = 0;
const ck = (n, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '   ' + JSON.stringify(d).slice(0, 400) : '')); } };

const PROFILE = read('profile.html'), GLOBAL_CP = read('sokoni-command-palette.js');
const STYLES = (PROFILE.match(/<style[^>]*>[\s\S]*?<\/style>/gi) || []).join('\n');
const S0 = PROFILE.indexOf('  var NLP = [');
const S1 = PROFILE.indexOf('8. WORKSPACE MEMORY — switchTab chain');
if (S0 < 0 || S1 < 0) { console.log('CRASH: palette section anchors not found'); process.exit(2); }
const SECTION = PROFILE.slice(S0, PROFILE.lastIndexOf('/*', S1));

const DEVICES = [
  ['iPhone SE 375x667', 375, 667, true], ['iPhone 14 390x844', 390, 844, true], ['iPhone landscape 844x390', 844, 390, true],
  ['Android 360x640', 360, 640, true], ['Pixel 7 412x915', 412, 915, true], ['iPad 820x1180', 820, 1180, true],
  ['laptop 1366x768', 1366, 768, false], ['short laptop 1280x600', 1280, 600, false],
];
const HDR = 80;
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">${STYLES}
<style>#hdr{position:fixed;top:0;left:0;right:0;height:${HDR}px;background:#123;z-index:100002}</style></head>
<body><div id="hdr"><button id="sk-cp-btn" onclick="window.SokoniCP&&window.SokoniCP.open()">⌕</button></div>
<script>document.documentElement.style.setProperty('--sk-header-h','${HDR}px');</script>
<script>(function(){ 'use strict';
  function _el7(id){ return document.getElementById(id); }
  function _ov7(){ return null; }
  function _saveWsCtx(){}
  ${SECTION}
})();</script>
<script src="/sokoni-command-palette.js"></script></body></html>`;

async function state(pg) {
  return pg.evaluate(() => {
    const vis = (el) => { if (!el) return false; const cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.05 && el.getBoundingClientRect().height > 0; };
    const page = document.getElementById('pi7CmdOverlay'), glob = document.getElementById('sk-cp');
    const open = [];
    if (vis(page)) open.push('page');
    if (glob && glob.classList.contains('sk-cp-open') && vis(glob)) open.push('global');
    const inp = document.getElementById('pi7CmdInp'), box = page && page.querySelector('.pi7-cmd-box');
    let field = null;
    if (inp && vis(page)) {
      const r = inp.getBoundingClientRect(), br = box.getBoundingClientRect();
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      field = { top: Math.round(r.top), bottom: Math.round(r.bottom), boxTop: Math.round(br.top), boxBottom: Math.round(br.bottom), vh: innerHeight, vw: innerWidth,
        hit: !!at && (at === inp || inp.contains(at)), hitWhat: at ? (at.id || at.className || at.tagName) : null, font: parseFloat(getComputedStyle(inp).fontSize) };
    }
    return { open, field };
  });
}

(async () => {
  console.log('\nSOURCE: profile.html + sokoni-command-palette.js @ ' + (CPM ? BASE + ' (before) — failures below ARE the defects' : 'working tree (fix)'));
  ck('A1  profile.html loads no AI chat widget and offers no "Ask KASS" command',
    !/<script[^>]*src="[^"]*kass-widget\.js/.test(PROFILE) && !/piOpenKass/.test(PROFILE),
    { widget: /<script[^>]*src="[^"]*kass-widget\.js/.test(PROFILE), askKass: (PROFILE.match(/piOpenKass/g) || []).length });
  const pw = require('playwright');
  for (const engine of (process.env.ENGINES || 'chromium,webkit').split(',')) {
    const browser = await pw[engine].launch();
    try {
      for (const [name, w, h, touch] of DEVICES) {
        const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch, isMobile: engine === 'chromium' ? touch : false });
        const pg = await ctx.newPage();
        await pg.route('**/*', (route) => {
          const u = new URL(route.request().url());
          if (u.pathname === '/sokoni-command-palette.js') return route.fulfill({ status: 200, contentType: 'application/javascript', body: GLOBAL_CP });
          if (u.pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: html });
          return route.fulfill({ status: 404, body: '' });
        });
        await pg.goto('https://sokoni.test/');
        await pg.waitForFunction(() => !!window.SokoniCP && !!window.piCmdPalette, null, { timeout: 10000 });
        const tag = `[${engine} · ${name}]`;
        await pg.keyboard.press('Control+k'); await pg.waitForTimeout(350);
        const a = await state(pg);
        /* exactly one, and the SAME one the page's own ⌘ button (piCmdPalette) opens — the workspace palette */
        ck(`P1  Ctrl+K opens exactly one command prompt — the page's workspace palette ${tag}`, a.open.length === 1 && a.open[0] === 'page', a.open);
        await pg.keyboard.press('Escape'); await pg.evaluate(() => { if (window.piCmdClose) piCmdClose(); if (window.SokoniCP) SokoniCP.close(); }); await pg.waitForTimeout(250);
        await pg.evaluate(() => window.SokoniCP.open()); await pg.waitForTimeout(350);
        const b = await state(pg);
        ck(`P2  the header button opens the same single prompt ${tag}`, b.open.length === 1 && b.open[0] === (a.open[0] || 'page'), b.open);
        await pg.evaluate(() => { if (window.SokoniCP) SokoniCP.close(); if (window.piCmdPalette) piCmdPalette('search'); }); await pg.waitForTimeout(350);
        const c = await state(pg);
        const f = c.field;
        ck(`P3  search field fully on screen and tappable (not under the header) ${tag}`, !!f && f.top >= 0 && f.bottom <= f.vh && f.hit, f);
        ck(`P4  the prompt box fits the viewport ${tag}`, !!f && f.boxTop >= 0 && f.boxBottom <= f.vh, f && { boxTop: f.boxTop, boxBottom: f.boxBottom, vh: f.vh });
        if (touch) ck(`P5  touch: search field font >= 16px (no iOS focus zoom) ${tag}`, !!f && f.font >= 16, f && f.font);
        await ctx.close();
      }
    } finally { await browser.close(); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
