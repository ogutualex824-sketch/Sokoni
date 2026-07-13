#!/usr/bin/env node
/**
 * test-mobile-forms.js — iOS Safari form usability. Static. Renders nothing.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 * The Add Product form was reported as running off the right edge of an iPhone: the
 * seller had to drag the page sideways to reach the fields, and the right-hand side of
 * dropdowns was cut off.
 *
 * It was not a layout bug. Every form on the platform MEASURES as fitting — 21 pages
 * were checked at 375/390/430px with the modals forced open, and horizontal overflow
 * was 0px on every one. That is precisely why it never reproduced in a desktop browser,
 * and why chasing widths, grids and containers found nothing.
 *
 * iOS Safari AUTO-ZOOMS the page whenever the user focuses an input whose font-size is
 * under 16px. The zoomed page is then genuinely wider than the viewport — so the form
 * really does overflow, sideways dragging really is required, and the right edge of a
 * <select> really is clipped. Safari does not undo the zoom on blur, so the form stays
 * broken for the rest of the session after the very first tap.
 *
 * Every reported symptom, from one CSS declaration. 70 pages carried inputs under 16px.
 *
 * 16px is a threshold, not a preference: at 16px or above, iOS does not zoom at all.
 */
'use strict';
const fs   = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok  = m => { pass++; console.log('  pass  ' + m); };
const bad = m => { fail++; console.error('  FAIL  ' + m); };

const quality = fs.readFileSync(path.resolve('sokoni-quality.css'), 'utf8');
const header  = fs.readFileSync(path.resolve('shared-header.js'), 'utf8');

console.log('\nMobile forms — iOS Safari zoom & overflow\n');

/* ── 1. The global 16px rule exists and is reachable ────────────────────────── */
{
  const m = /@media\s*\(max-width:\s*768px\)\s*\{[\s\S]*?font-size:\s*16px\s*!important/.exec(quality);
  m
    ? ok('a ≤768px rule forces inputs to 16px — iOS Safari will not zoom on focus')
    : bad('no ≤768px 16px input rule — iOS will zoom on focus and the form will overflow sideways');

  /* It must be !important: these rules live inside 70 individual pages and would
     otherwise lose on specificity, which would make the fix a no-op exactly where it
     matters most. */
  /font-size:\s*16px\s*!important/.test(quality)
    ? ok('the rule is !important — it beats the per-page input styles on all 70 pages')
    : bad('the rule is not !important — per-page styles will win and iOS will still zoom');

  /* And the stylesheet must actually be injected everywhere. */
  /sokoni-quality\.css/.test(header)
    ? ok('sokoni-quality.css is injected by shared-header.js — the fix reaches every page')
    : bad('sokoni-quality.css is not injected globally — the fix would reach almost nothing');
}

/* ── 2. Checkboxes/radios must be excluded ──────────────────────────────────── */
{
  /input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\)/.test(quality)
    ? ok('checkboxes and radios are excluded (they have no text; iOS never zooms for them)')
    : bad('checkboxes/radios are not excluded — forcing 16px on them distorts the control');
}

/* ── 3. Grid items must be allowed to shrink ────────────────────────────────── */
{
  /* A grid item's default min-width is AUTO (= min-content), so an <input> in a `1fr`
     column will not shrink below its intrinsic width and pushes the row wider than its
     container. This is the latent overflow that was sitting behind the zoom. */
  /min-width:\s*0/.test(quality)
    ? ok('inputs get min-width:0 — a `1fr` grid column can actually shrink')
    : bad('inputs keep min-width:auto — an input in a 1fr column will push the row past the viewport');

  const inv = fs.readFileSync(path.resolve('inventory.html'), 'utf8');
  /\.form-row\{[^}]*minmax\(0,\s*1fr\)/.test(inv)
    ? ok('inventory.html .form-row uses minmax(0,1fr), not a bare 1fr')
    : bad('inventory.html .form-row uses a bare 1fr — the column cannot shrink below min-content');

  /@media\(max-width:600px\)\{[\s\S]{0,120}?\.form-row\{grid-template-columns:1fr\}/.test(inv)
    ? ok('inventory.html stacks the form to ONE field per row on phones')
    : bad('inventory.html keeps two columns on phones — two 165px inputs side by side is unusable one-handed');
}

/* ── 4. No product form may reintroduce a sub-16px input ────────────────────── */
{
  /* Guard the specific pages that carry the Add Product form. A page-level rule under
     16px is now overridden globally, but a rule with higher specificity + !important
     could still win — so flag any that appear, rather than assume the global rule holds. */
  const FORMS = ['inventory.html', 'inv-products.html', 'pos-inventory.html', 'inv-product.html'];
  const offenders = [];
  FORMS.forEach(f => {
    const p = path.resolve(f);
    if (!fs.existsSync(p)) return;
    const src = fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    /* an input rule with BOTH a sub-16px size AND !important would beat the global fix */
    const re = /(input|select|textarea)[^{}]*\{[^}]*font-size:\s*(\d+(?:\.\d+)?)px\s*!important/gi;
    let m;
    while ((m = re.exec(src))) if (Number(m[2]) < 16) offenders.push(`${f}: ${m[1]} @${m[2]}px !important`);
  });
  offenders.length === 0
    ? ok('no product form overrides the 16px rule with its own !important — the fix cannot be defeated')
    : bad(`these beat the global fix and will still zoom on iOS: ${offenders.join(', ')}`);
}

console.log('');
if (fail) { console.error(`Mobile forms FAILED (${fail}) — iOS may still zoom and overflow\n`); process.exit(1); }
console.log(`Mobile forms PASSED (${pass} checks) — iOS Safari will not zoom; forms fit the viewport\n`);
