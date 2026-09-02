#!/usr/bin/env node
/* MERCHANT-SET SHOP LOGO — the end of the chain, measured on the deployed site.
 *
 * THIS IS A LIVE VERIFIER, NOT A BUILD GATE, and it is deliberately NOT in the predeploy
 * chain: it needs a merchant to have actually saved a logo, which no build can arrange.
 * The source-level guarantees live in test-shop-logo-identity.js.
 *
 * WHY IT EXISTS
 * v626 certified the shop logo across seven viewports and every one of them showed the
 * INITIALS fallback, because kassshop has no logoUrl. So the fallback is certified and the
 * image path is not. Reading the source and seeing `shop.logoUrl || config.logoUrl` is not
 * evidence that a merchant's save arrives here — that inference is the one that sent a
 * whole slice into store.html, a page /shop/** never routes to.
 *
 * WHAT MAKES THIS DIFFERENT FROM 'THE IMG HAS A SRC'
 * A wrong URL still yields a src. The fallback then hides the failure by rendering
 * initials, which look correct. So this asserts naturalWidth > 0 — the browser decoded
 * actual pixels — and, when given an expected URL, that the src is the one the merchant
 * saved. Without both, a 404 logo and a working one are indistinguishable.
 *
 *   node scripts/verify-shop-logo-live.js [handle] [expectedLogoUrl]
 *   default handle: kassshop
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const HANDLE   = process.argv[2] || 'kassshop';
const EXPECTED = process.argv[3] || null;
const WIDTHS   = [360, 390, 430, 768, 1024, 1280, 1440];
const URL      = 'https://mysokoni.co.ke/shop/' + HANDLE;
const SKILL    = 'C:/Users/USER1/.claude/skills/browser-automation/browser.mjs';
const TMP      = path.join(process.env.TEMP || '/tmp', 'shop-logo-live.mjs');

let pass = 0, fail = 0, unproven = 0;
const ck  = (l, c, n) => {
  if (c) { pass++; console.log('  PASS      ' + l); }
  else { fail++; console.log('  FAIL      ' + l + (n ? '   [' + n + ']' : '')); }
};
const unk = (l, w) => { unproven++; console.log('  UNPROVEN  ' + l + '   [' + w + ']'); };

const script = [
  'export default async function run (page) {',
  '  const widths = ' + JSON.stringify(WIDTHS) + ';',
  '  const out = [];',
  '  for (const w of widths) {',
  '    await page.setViewportSize({ width: w, height: 900 });',
  '    await page.goto(' + JSON.stringify(URL) + ', { waitUntil: "networkidle" });',
  '    await page.waitForTimeout(1200);',
  '    out.push(await page.evaluate(() => {',
  '      const frame = document.querySelector(".ms-logo-frame");',
  '      if (!frame) return { missing: true };',
  '      const fr  = frame.getBoundingClientRect();',
  '      const img = frame.querySelector("img");',
  '      const ph  = frame.querySelector("[role=\'img\']");',
  '      const vis = (el) => { if (!el) return false; const s = getComputedStyle(el);',
  '        return s.display !== "none" && s.visibility !== "hidden" && el.getBoundingClientRect().width > 0; };',
  '      const shown = vis(img) ? "image" : (vis(ph) ? "initials" : "nothing");',
  '      const ir = img ? img.getBoundingClientRect() : null;',
  '      return {',
  '        w: Math.round(fr.width), h: Math.round(fr.height), shown,',
  '        square: Math.abs(fr.width - fr.height) <= 1,',
  '        inside: ir ? (ir.width <= fr.width + 1 && ir.height <= fr.height + 1) : true,',
  '        fit: img ? getComputedStyle(img).objectFit : null,',
  '        src: img ? (img.currentSrc || img.getAttribute("src") || "") : "",',
  '        natural: img ? img.naturalWidth : 0,',
  '        alt: img ? img.getAttribute("alt") : null,',
  '        phLabel: ph ? ph.getAttribute("aria-label") : null,',
  '        ring: document.querySelectorAll(".ms-story-ring, [data-story-ring]").length,',
  '        hover: document.documentElement.scrollWidth > document.documentElement.clientWidth',
  '      };',
  '    }));',
  '  }',
  '  return out;',
  '}'
].join('\n');

fs.writeFileSync(TMP, script);
const r = spawnSync(process.execPath, [SKILL, URL, '--script', TMP],
  { encoding: 'utf8', timeout: 420000, maxBuffer: 1024 * 1024 * 24 });
const raw = String((r.stdout || '') + (r.stderr || ''));
const m = raw.match(/\[\s*\{[\s\S]*\}\s*\]/);

console.log('');
console.log('  MERCHANT-SET SHOP LOGO — ' + URL);
console.log('  expected src: ' + (EXPECTED || '(not supplied — src identity cannot be checked)'));
console.log('');

if (!m) {
  console.log('  ENV — the browser run produced no measurement.');
  console.log(raw.split('\n').filter((l) => l.trim()).slice(-8).map((l) => '    ' + l).join('\n'));
  console.log('');
  console.log('  0 passed, 0 failed, 1 unproven');
  process.exit(1);
}

const rows = JSON.parse(m[0]);
rows.forEach((d, i) => {
  const w = WIDTHS[i];
  console.log('  ' + String(w).padStart(4) + 'px  ' + (d.missing ? 'frame ABSENT' :
    'frame ' + (d.w + 'x' + d.h).padEnd(9) + ' showing ' + String(d.shown).padEnd(9) +
    ' natural=' + d.natural + ' fit=' + d.fit + ' ring=' + d.ring));
});
console.log('');

const anyMissing = rows.some((d) => d.missing);
ck('the logo frame exists at every width', !anyMissing);
if (anyMissing) {
  console.log('');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(1);
}

/* A COLLAPSED FRAME MUST FAIL, NOT PASS BY ARITHMETIC.
   The first run of this verifier reported 0x0 at 1024px and still passed 'square'
   (|0-0| <= 1) and 'contained' (0 <= 0) — both vacuously true of an element that is not
   there. That is the healthy-looking failure this project keeps meeting: an assertion
   satisfied by absence. Size is therefore checked FIRST, and the geometry checks below
   only mean anything once it holds. */
ck('the frame has real size at every width — never 0x0',
   rows.every((d) => d.w > 0 && d.h > 0),
   rows.map((d, i) => WIDTHS[i] + ':' + d.w + 'x' + d.h).filter((s) => /:0x/.test(s)).join(' '));

/* Geometry was certified for the fallback at v626. It is re-asserted here because a real
   image is a different element, and can break what initials never exercised. */
ck('square at every width',         rows.every((d) => d.square && d.w > 0));
ck('contained inside the frame',    rows.every((d) => d.inside));
ck('scales 360 -> desktop',         rows[0].w < rows[rows.length - 1].w);
ck('no horizontal overflow',        rows.every((d) => !d.hover));
ck('no story ring (none is built)', rows.every((d) => d.ring === 0));
/* 'nothing' is neither the image nor the fallback: the shop has no visible identity at
   that width. It must be named, not folded into the initials verdict. */
ck('the shop shows an identity at every width — image or initials, never nothing',
   rows.every((d) => d.shown !== 'nothing'),
   rows.map((d, i) => WIDTHS[i] + ':' + d.shown).filter((s) => /nothing/.test(s)).join(' '));

const showing = rows.filter((d) => d.shown === 'image');

if (showing.length === 0) {
  unk('the merchant-set logo renders',
      'every width shows ' + rows[0].shown + ' — no logoUrl is set on /' + HANDLE);
  console.log('');
  console.log('  This is the honest verdict, not a failure: the fallback is correct and the');
  console.log('  image path is untested. Set a logo in Merchant v2 -> Shop Details -> Shop');
  console.log('  logo, save, then re-run with the URL you entered as argument 2.');
} else {
  ck('the image renders at EVERY width, not some', showing.length === rows.length,
     showing.length + '/' + rows.length);
  /* The check that separates a working logo from a 404 wearing initials. */
  ck('the browser decoded real pixels (naturalWidth > 0)',
     showing.every((d) => d.natural > 0),
     'a broken URL falls back to initials and looks correct');
  ck('object-fit: cover — no distortion', showing.every((d) => d.fit === 'cover'));
  ck('alt carries the shop name',
     showing.every((d) => d.alt && d.alt.trim().length > 0));
  if (EXPECTED) {
    ck('the served src is the URL the merchant saved',
       showing.every((d) => d.src === EXPECTED || d.src.indexOf(EXPECTED) > -1),
       'got ' + showing[0].src);
  } else {
    unk('the served src is the URL the merchant saved', 'no expected URL supplied');
  }
}

console.log('');
console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
process.exit(fail > 0 ? 1 : 0);
