#!/usr/bin/env node
/**
 * test-sheet.js — full-screen sheets (Notification Centre + the shared component).
 * Static analysis. Opens nothing.
 *
 * ── The bug this guards ───────────────────────────────────────────────────────
 * The Notification Centre could be OPENED and then could not be CLOSED.
 *
 * Not because the ✕ was missing. It was there. It was because the sheet sat at
 * --sk-z-drawer (600) while the global header sits at --sk-z-header (100001). The header
 * rendered ON TOP of the sheet — over its title, over "Mark all read", over its search,
 * and over its ✕. Measured: elementFromPoint at the centre of the close button returned
 * NAV#sk-top-nav.
 *
 * Every symptom reported — "header overlaps the global nav", "the X is tiny and partially
 * hidden", "controls overlap", "the search bars stack", "no reliable way to dismiss" — is
 * that ONE stacking mistake seen from five angles.
 *
 * The token scale was never wrong. --sk-z-drawer means "a side drawer WITHIN the page".
 * A sheet that COVERS the header is a modal and must out-rank it. The Notification Centre
 * picked the wrong tier and nothing in the system stopped it. That is what these checks
 * are: the thing that stops it.
 */
'use strict';
const fs   = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok  = m => { pass++; console.log('  pass  ' + m); };
const bad = m => { fail++; console.error('  FAIL  ' + m); };

const tokens = fs.readFileSync(path.resolve('sokoni-tokens.css'), 'utf8');
const sheet  = fs.readFileSync(path.resolve('sokoni-sheet.js'), 'utf8');
const nc     = fs.readFileSync(path.resolve('sokoni-notif-center.js'), 'utf8');
const hdr    = fs.readFileSync(path.resolve('shared-header.js'), 'utf8');

const num = (css, name) => {
  const m = new RegExp('--' + name + ':\\s*(\\d+)').exec(css);
  return m ? Number(m[1]) : null;
};

console.log('\nFull-screen sheets — can the user get out?\n');

/* ── 1. The tier must out-rank the header ──────────────────────────────────── */
{
  const zHeader = num(tokens, 'sk-z-header');
  const zSheet  = num(tokens, 'sk-z-sheet');
  const zDrawer = num(tokens, 'sk-z-drawer');

  zSheet !== null
    ? ok('--sk-z-sheet exists (a canonical tier for sheets that COVER the header)')
    : bad('--sk-z-sheet is not defined — sheets have no correct tier to pick');

  (zSheet && zHeader && zSheet > zHeader)
    ? ok(`--sk-z-sheet (${zSheet}) out-ranks --sk-z-header (${zHeader}) — the sheet cannot be covered by the header`)
    : bad(`--sk-z-sheet (${zSheet}) does NOT out-rank --sk-z-header (${zHeader}) — the header will render over the sheet's own ✕`);

  (zDrawer && zHeader && zDrawer < zHeader)
    ? ok(`--sk-z-drawer (${zDrawer}) stays BELOW the header — it is for in-page drawers, and that distinction is the whole point`)
    : bad('--sk-z-drawer is no longer below the header — the two tiers now mean the same thing');
}

/* ── 2. The Notification Centre must use it ────────────────────────────────── */
{
  !/#sk-nc-overlay\{[\s\S]{0,160}--sk-z-drawer/.test(nc)
    ? ok('the notification overlay no longer uses the in-page drawer tier')
    : bad('the notification overlay is still at --sk-z-drawer — the header will cover its ✕ again');

  /#sk-nc-overlay\{[\s\S]{0,200}--sk-z-sheet/.test(nc)
    ? ok('the notification overlay uses --sk-z-sheet (above the header)')
    : bad('the notification overlay does not use --sk-z-sheet');
}

/* ── 3. The close button must be pressable ─────────────────────────────────── */
{
  /\.sk-nc-close\{[\s\S]{0,120}width:44px;height:44px/.test(nc)
    ? ok('the ✕ is 44×44 (it was 34×34 — mis-tapped even when it was NOT covered)')
    : bad('the ✕ is under 44px — the iOS touch-target floor');

  /\.sk-nc-close\{[\s\S]{0,200}flex:0 0 44px/.test(nc)
    ? ok('the ✕ cannot be squeezed by a long title (flex:0 0 44px)')
    : bad('a long title could shrink the one control that gets the user out');

  /\.sk-nc-close:focus-visible/.test(nc)
    ? ok('the ✕ has a visible focus ring (keyboard users can see where they are)')
    : bad('no visible focus on the ✕');
}

/* ── 4. Safe area ─────────────────────────────────────────────────────────── */
{
  /#sk-nc-head\{[\s\S]{0,240}env\(safe-area-inset-top/.test(nc)
    ? ok('the notification header respects the top safe area (notch / Dynamic Island)')
    : bad('the notification header ignores the top inset — the title and ✕ sit under the Dynamic Island');

  /env\(safe-area-inset-left/.test(nc) && /env\(safe-area-inset-right/.test(nc)
    ? ok('left/right insets respected (landscape, curved edges)')
    : bad('side insets ignored — content clips in landscape');

  /padding-top:env\(safe-area-inset-top/.test(sheet) &&
  /padding-bottom:env\(safe-area-inset-bottom/.test(sheet)
    ? ok('the shared sheet insets all four edges (nothing under the notch or the home indicator)')
    : bad('the shared sheet does not inset the safe area');
}

/* ── 5. FIVE ways out. One way out is one bug away from none. ──────────────── */
{
  const ways = [
    ['✕ button',      /getElementById\('sk-nc-close'\)/.test(nc)],
    ['Escape',        /e\.key === 'Escape'/.test(nc)],
    ['backdrop tap',  /backdrop\.addEventListener\('click', closePanel\)/.test(nc)],
    ['browser Back',  /addEventListener\('popstate', _onPop\)/.test(nc) && /history\.pushState\(\{ skNotifCenter/.test(nc)],
    ['swipe down',    /_onTouchMove/.test(nc)],
  ];
  const missing = ways.filter(w => !w[1]).map(w => w[0]);
  missing.length === 0
    ? ok('five independent ways out: ' + ways.map(w => w[0]).join(' · '))
    : bad('missing dismissal path(s): ' + missing.join(', ') +
          ' — on iOS the back GESTURE is the back button, so losing it strands phone users');
}

/* ── 6. Back must not navigate the user off the page ───────────────────────── */
{
  /if \(_pushedHistory && !fromPop\)/.test(nc)
    ? ok('the pushed history entry is consumed on close, and NOT re-popped when Back is what closed it')
    : bad('closing could call history.back() twice and navigate the user off the page entirely');
}

/* ── 7. No leaked listeners ────────────────────────────────────────────────── */
{
  /removeEventListener\('popstate', _onPop\)/.test(nc) &&
  /removeEventListener\('touchstart', _onTouchStart\)/.test(nc)
    ? ok('every listener added on open is removed on close (no leak across repeated opens)')
    : bad('listeners are added on open but not removed — a long PWA session accumulates them');

  !/addEventListener\(\s*['"]scroll['"]/.test(sheet)
    ? ok('the shared sheet adds no scroll listener (no jank, no thrash)')
    : bad('the shared sheet listens to scroll — that is how you create the jank you are trying to avoid');
}

/* ── 8. The shared component exists and is global ──────────────────────────── */
{
  /sokoni-sheet\.js/.test(hdr)
    ? ok('sokoni-sheet.js is injected platform-wide (every future overlay can inherit it)')
    : bad('the shared sheet component is not injected — future overlays will hand-roll it and pick the wrong tier again');

  /min-height:44px/.test(sheet) && /width:44px;height:44px/.test(sheet)
    ? ok('the shared sheet enforces 44px targets for BOTH its close and its actions')
    : bad('the shared sheet does not enforce 44px targets');

  /FOCUSABLE/.test(sheet) && /aria-modal/.test(sheet)
    ? ok('the shared sheet traps focus and is aria-modal (usable by keyboard and screen reader)')
    : bad('the shared sheet does not trap focus — you would tab into content behind it');
}

console.log('');
if (fail) { console.error(`Sheets FAILED (${fail}) — the user may be unable to close a panel\n`); process.exit(1); }
console.log(`Sheets PASSED (${pass} checks)\n`);
