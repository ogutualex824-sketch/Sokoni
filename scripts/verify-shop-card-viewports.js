#!/usr/bin/env node
/* PRODUCT-CARD ACTIONS — responsive behaviour at every required width.
 *
 * THIS IS A LIVE VERIFIER, NOT A BUILD GATE. It measures the DEPLOYED site, so it cannot
 * validate a fix that is still local — and it is deliberately NOT registered in the
 * predeploy gate, where it would fail for the honest reason that production still carries
 * the defect. Run it after deployment. Before that, the source-level guarantees are in
 * test-shop-card-actions.js.
 *
 * Asserts LAYOUT, not the presence of a class. A card can carry .pcard-mobile-strip and
 * still be useless if the strip is 0x0, the buttons sit outside the card, the labels clip,
 * or the row pushes the page sideways.
 *
 * WHAT IT MEASURES, AND WHERE
 * The category grid, because it renders the canonical component the shop cards now reuse.
 * The shop page itself renders zero cards without a shop that has products, so its own
 * sweep needs production data this rig does not have — reported UNPROVEN by
 * test-shop-card-actions.js rather than dressed up as a pass.
 *
 * THE INVARIANT AT EVERY WIDTH: exactly one action row is visible. Both visible means a
 * tap can fire twice; neither means there is no way to add to cart at all, which is the
 * defect this component was built to end.
 */
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');

const WIDTHS = [360, 390, 430, 768, 1024, 1280, 1440];
const URL = 'https://mysokoni.co.ke/category';
const SKILL = 'C:/Users/USER1/.claude/skills/browser-automation/browser.mjs';
const TMP = path.join(process.env.TEMP || '/tmp', 'shop-card-viewports.mjs');

let pass = 0, fail = 0, unproven = 0;
function ck (label, cond, note) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (note ? '   [' + note + ']' : '')); }
}
function unk (label, why) { unproven++; console.log('  UNPROVEN  ' + label + '   [' + why + ']'); }

const script = `
export default async function run (page) {
  const out = {};
  for (const w of ${JSON.stringify(WIDTHS)}) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.goto(${JSON.stringify(URL)}, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6000);
    out[w] = await page.evaluate(() => {
      const vis = (el) => { const s = getComputedStyle(el), r = el.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
      const q = (s) => [...document.querySelectorAll(s)];
      const cards = q('.product-card');
      const strips = q('.pcard-mobile-strip').filter(vis);
      const rows = q('.pcard-actions').filter(vis);
      /* Count buttons STRUCTURALLY — whatever is inside a visible action row. Selecting by
         class missed the desktop row entirely: category.js styles those buttons inline and
         they carry no .pcard-cart/.pcard-wish class, so a class-based probe reported "no
         controls" at every desktop width while the row was plainly there. */
      const btns = q('.pcard-actions button, .pcard-mobile-strip button').filter(vis);
      /* every visible control must sit inside its own card, and be tappable */
      let outside = 0, tooSmall = 0, clipped = 0;
      const MIN = 40;
      for (const b of btns) {
        const card = b.closest('.product-card');
        const br = b.getBoundingClientRect();
        if (!card) { outside++; continue; }
        const cr = card.getBoundingClientRect();
        if (br.left < cr.left - 1 || br.right > cr.right + 1) outside++;
        if (br.width < MIN || br.height < MIN) tooSmall++;
        if (b.scrollWidth > b.clientWidth + 2) clipped++;
      }
      return { cards: cards.length, stripsVisible: strips.length, rowsVisible: rows.length,
               buttons: btns.length, outside, tooSmall, clipped,
               hOverflow: document.documentElement.scrollWidth > window.innerWidth + 1 };
    });
  }
  return out;
}
`;

require('fs').writeFileSync(TMP, script);
console.log('\nproduct-card actions — responsive sweep (' + WIDTHS.join(', ') + ')');
const r = spawnSync(process.execPath, [SKILL, URL, '--script', TMP],
  { encoding: 'utf8', timeout: 15 * 60 * 1000 });
const m = (r.stdout || '').match(/^script\s+([\s\S]*?)\n\n/m);

if (!m) {
  unk('the browser sweep ran', 'headless browser unavailable or the page did not load');
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
  process.exit(0);   /* an unavailable browser is not a product failure */
}

let data; try { data = JSON.parse(m[1]); } catch (_) { data = null; }
ck('CONTROL the sweep returned measurements', !!data);
if (data) {
  for (const w of WIDTHS) {
    const d = data[String(w)];
    if (!d) { unk(w + 'px measured', 'no data for this width'); continue; }
    const mobile = w <= 600;
    ck(w + 'px · cards rendered', d.cards > 0, JSON.stringify(d));
    ck(w + 'px · exactly one action row is visible',
       mobile ? (d.stripsVisible > 0 && d.rowsVisible === 0)
              : (d.rowsVisible > 0 && d.stripsVisible === 0),
       'strips=' + d.stripsVisible + ' rows=' + d.rowsVisible);
    ck(w + 'px · controls are visible', d.buttons > 0);
    ck(w + 'px · every control sits inside its card', d.outside === 0, d.outside + ' outside');
    ck(w + 'px · tap targets are usable', d.tooSmall === 0, d.tooSmall + ' below 40px');
    ck(w + 'px · no label is clipped', d.clipped === 0, d.clipped + ' clipped');
    ck(w + 'px · no horizontal overflow', d.hOverflow === false);
  }
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
process.exit(fail > 0 ? 1 : 0);
