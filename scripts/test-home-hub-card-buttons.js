#!/usr/bin/env node
/* test-home-hub-card-buttons.js — homepage hub cards keep EVERY action button inside the card at every
 * width (owner: "Sokoni Eats desktop" — the Eats card clipped "🛵 Become Rider" on every desktop width).
 * Fix 72e289e, carried onto the chain as e4ec00c.
 *
 *   S1 static: the old clipping rule (nowrap + overflow:hidden on hub cards) is gone; the wrap rules are present
 *   B* browser (hermetic page harness: real index.html, Firebase shimmed, external origins stubbed) at
 *      1920 / 1440 / 1280 / 1024 / 768 / 390: for every hub card in .hubs-hscroll-wrap, every button's
 *      box lies inside the card's box (±1px), and "Become Rider" is visible and hit-testable
 *   N1 negative control: re-inject the pre-fix rule → at least one desktop width puts a button outside its card
 *   node scripts/test-home-hub-card-buttons.js [--static-only]
 */
'use strict';
const fs = require('fs'), Path = require('path');
const ROOT = Path.join(__dirname, '..');
let pass = 0, fail = 0;
const ck = (l, ok, got) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok ? '' : '   [got ' + JSON.stringify(got).slice(0, 400) + ']')); ok ? pass++ : fail++; };
const html = fs.readFileSync(Path.join(ROOT, 'index.html'), 'utf8');
const OLD_RULE = 'section[style*="padding:0 28px 32px"] a[style*="display:flex"]{\n    flex-wrap:nowrap;\n    overflow:hidden;\n  }';
ck('S1 old clipping rule absent; wrap rules present', !/a\[style\*="display:flex"\]\{\s*flex-wrap:nowrap;\s*overflow:hidden;/.test(html)
  && html.includes('.hubs-hscroll-wrap > a{flex-wrap:wrap;}')
  && html.includes('.hubs-hscroll-wrap > a > div[style*="flex-shrink:0"]{flex:0 1 auto !important;min-width:0;flex-wrap:wrap !important;}'), null);
if (process.argv.includes('--static-only')) { console.log('\n' + pass + ' passed, ' + fail + ' failed (static only; browser section not run)'); process.exit(fail ? 1 : 3); }

(async () => {
  const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
  const { makePageHarness } = require('./lib/page-harness.js');
  const db = makeFakeFirestore({ clock: () => Date.now() }).db;
  /* Pre-fix variant of index.html, served at its own path, for the negative control. */
  const pre = html.replace('/* ── Hub cards: action buttons stay INSIDE the card at every width ──', '/* NEGCTL */')
    .replace('.hubs-hscroll-wrap > a{flex-wrap:wrap;}', '')
    .replace('.hubs-hscroll-wrap > a > div[style*="flex:1"]{flex:1 1 160px !important;min-width:0;}', '')
    .replace('.hubs-hscroll-wrap > a > div[style*="flex-shrink:0"]{flex:0 1 auto !important;min-width:0;flex-wrap:wrap !important;}', '')
    .replace('</head>', '<style>@media(min-width:769px){' + OLD_RULE + '}.hubs-hscroll-wrap > a{flex-wrap:nowrap;overflow:hidden}.hubs-hscroll-wrap > a > div[style*="flex-shrink:0"]{flex-shrink:0;flex-wrap:nowrap}.hubs-hscroll-wrap > a > div[style*="flex-shrink:0"] button{white-space:nowrap}</style></head>');
  const H = makePageHarness({ db, root: ROOT, pages: { '/index-prefix.html': pre } });
  await H.start();
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  const measure = `(function(){
    const cards = Array.from(document.querySelectorAll('.hubs-hscroll-wrap > a')).filter(a => a.getBoundingClientRect().width > 0);
    const out = { cards: cards.length, outside: [], rider: null };
    for (const a of cards) {
      const r = a.getBoundingClientRect();
      for (const b of a.querySelectorAll('button')) {
        const q = b.getBoundingClientRect();
        if (q.width === 0) continue;
        if (q.left < r.left - 1 || q.right > r.right + 1 || q.top < r.top - 1 || q.bottom > r.bottom + 1) out.outside.push((b.textContent || '').trim().slice(0, 24) + ' @' + Math.round(q.right) + '>' + Math.round(r.right));
        if (/Become Rider/.test(b.textContent)) {
          const cx = q.left + q.width / 2, cy = q.top + q.height / 2;
          b.scrollIntoView({ block: 'center' });
          const q2 = b.getBoundingClientRect();
          const hit = document.elementFromPoint(q2.left + q2.width / 2, q2.top + q2.height / 2);
          out.rider = { inside: !(q.left < r.left - 1 || q.right > r.right + 1), hit: !!hit && (hit === b || b.contains(hit)) };
        }
      }
    }
    return out;
  })()`;
  const widths = [1920, 1440, 1280, 1024, 768, 390];
  try {
    for (const w of widths) {
      const page = await H.page(browser, { viewport: { width: w, height: 900 } });
      page.setDefaultTimeout(60000);
      await page.goto(H.BASE + '/index.html', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.hubs-hscroll-wrap > a', { state: 'attached' });
      await page.waitForTimeout(400);
      const m = await page.evaluate(measure);
      ck('B' + w + ' every hub-card button inside its card; Become Rider inside + tappable', m.cards > 0 && m.outside.length === 0 && m.rider && m.rider.inside && m.rider.hit, m);
      await page.__ctx.close();
    }
    let caught = false; const seen = [];
    for (const w of [1920, 1440, 1280, 1024]) {
      const page = await H.page(browser, { viewport: { width: w, height: 900 } });
      await page.goto(H.BASE + '/index-prefix.html', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.hubs-hscroll-wrap > a', { state: 'attached' });
      await page.waitForTimeout(400);
      const m = await page.evaluate(measure);
      seen.push(w + ':' + m.outside.length);
      if (m.outside.length > 0) caught = true;
      await page.__ctx.close();
    }
    ck('N1 negative control: the pre-fix rule puts a button outside its card at some desktop width', caught, seen);
  } finally { await browser.close(); H.stop(); }
  console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
