#!/usr/bin/env node
/* SHOP LOGO IDENTITY — the merchant's configured logo, responsive and stable.
 *
 * Slice B, Option 1: the LOGO half only. There is deliberately NO story ring here.
 *
 * WHY NO RING: stories are stored in localStorage["sokoniStories"] on the device that
 * posted them. A shopper's browser cannot see a merchant's stories at all, so a ring on
 * the customer surface could only ever be decorative — it would light up on the
 * merchant's own device and mislead everyone else. A meaningful ring needs a
 * server-backed story source first; that is mapped separately and is not this slice.
 *
 * WHAT THIS FIXES
 *   · the frame reserved no space, so the header jumped once the logo decoded
 *   · the size was a fixed 76px from a 360px phone to a 1440px desktop
 *   · alt="" marked the shop's identity image as decorative to a screen reader
 *   · a logo URL that 404s left a broken-image icon in the header
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0, unproven = 0;
function head (t) { console.log('\n' + t); }
function ck (label, cond, note) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (note ? '   [' + note + ']' : '')); }
}
function unk (label, why) { unproven++; console.log('  UNPROVEN  ' + label + '   [' + why + ']'); }

const CSS = read('minishop.css');
const JS = read('sokoni-minishop.js');
const HTML = read('minishop.html');

/* Isolate the rules under test so an assertion cannot pass on an unrelated block. */
function rule (sel) {
  const i = CSS.indexOf(sel);
  if (i < 0) return '';
  const open = CSS.indexOf('{', i);
  return open < 0 ? '' : CSS.slice(open, CSS.indexOf('}', open));
}

/* ── 1 · CONTROL ─────────────────────────────────────────────────────────────── */
head('1 · CONTROL — the elements under test exist');
ck('the markup has a logo, a frame and a placeholder',
   HTML.indexOf('ms-logo-frame') > -1 && HTML.indexOf('msLogo') > -1 && HTML.indexOf('msLogoPlaceholder') > -1);
ck('CONTROL the frame rule was isolated', rule('.ms-logo-frame').length > 10,
   'an empty slice would make the containment assertions vacuous');

/* ── 2 · NO LAYOUT SHIFT ────────────────────────────────────────────────────── */
head('2 · the space is reserved before the network answers');
{
  const f = rule('.ms-logo-frame');
  ck('the frame itself has a width', /width:\s*var\(--ms-logo-size\)/.test(f),
     'both children were sized and the frame was not, so it collapsed until the image decoded');
  ck('the frame itself has a height', /height:\s*var\(--ms-logo-size\)/.test(f));
  const img = rule('.ms-logo-img,');
  ck('the image fills the reserved frame rather than defining it',
     /width:\s*100%/.test(img) && /height:\s*100%/.test(img));
}

/* ── 3 · RESPONSIVE, WITHOUT DISTORTION ─────────────────────────────────────── */
head('3 · 360px to desktop');
{
  const tok = (CSS.match(/--ms-logo-size:\s*([^;]+);/) || [])[1] || '';
  ck('the size scales with the viewport', /clamp\(/.test(tok), tok.trim());
  const m = tok.match(/clamp\(\s*([0-9.]+)px\s*,\s*([0-9.]+)vw\s*,\s*([0-9.]+)px/);
  ck('CONTROL the clamp was parsed', !!m, tok.trim());
  if (m) {
    const min = Number(m[1]), vw = Number(m[2]), max = Number(m[3]);
    ck('at 360px it is comfortably tappable', Math.max(min, Math.min(360 * vw / 100, max)) >= 44,
       Math.round(Math.max(min, Math.min(360 * vw / 100, max))) + 'px');
    ck('it grows on a desktop viewport', Math.max(min, Math.min(1440 * vw / 100, max)) > min,
       Math.round(Math.max(min, Math.min(1440 * vw / 100, max))) + 'px');
    ck('NEGATIVE it never dominates a narrow screen',
       Math.max(min, Math.min(360 * vw / 100, max)) <= 360 * 0.3);
  }
  ck('a non-square logo is cropped, not stretched', /object-fit:\s*cover/.test(rule('.ms-logo-img,')),
     'contain would letterbox; fill would distort the merchant’s mark');
}

/* ── 4 · ONE SOURCE FOR THE LOGO ────────────────────────────────────────────── */
head('4 · the merchant’s configured logo is the identity image');
ck('the shop reads the configured logo', /shop\.logoUrl \|\| config\.logoUrl/.test(JS));
ck('NEGATIVE no second logo-setting mechanism was introduced',
   (JS.match(/logoUrl\s*=/g) || []).length <= 2,
   'Shop Details remains the only place a merchant sets it');

/* ── 5 · FALLBACKS TELL THE TRUTH ───────────────────────────────────────────── */
head('5 · missing and broken logos');
ck('initials show when no logo is set', /logoPlaceholder\.hidden = !!logoUrl/.test(JS));
ck('a broken logo URL falls back to initials', /logoEl\.onerror/.test(JS),
   'a 404 left a broken-image icon in the header');
ck('NEGATIVE a missing logo does not collapse the header',
   /width:\s*var\(--ms-logo-size\)/.test(rule('.ms-logo-frame')));

/* ── 6 · ACCESSIBILITY ──────────────────────────────────────────────────────── */
head('6 · the identity is announced');
ck('the logo carries the shop name', /logoEl\.alt = logoUrl \?/.test(JS),
   'alt="" marked the shop’s identity image as decorative');
ck('the initials fallback is announced as an image',
   /logoPlaceholder\.setAttribute\('role', 'img'\)/.test(JS) &&
   /aria-label/.test(JS));

/* ── 7 · NOTHING ELSE MOVED ─────────────────────────────────────────────────── */
head('7 · scope');
ck('NEGATIVE no story ring was added', CSS.indexOf('story-ring') === -1 && JS.indexOf('story-ring') === -1,
   'a ring here could only be decorative until stories are server-backed');
ck('NEGATIVE the story system was not touched',
   JS.indexOf('sokoniStories') === -1 && JS.indexOf('openStoryAt') === -1);
ck('the product cards still carry their controls',
   JS.indexOf('ms-add-btn') > -1 && JS.indexOf('ms-wishlist-btn') > -1,
   'cart and wishlist behaviour is untouched by this slice');

/* ── 8 · BOUNDARIES ─────────────────────────────────────────────────────────── */
head('8 · what this cannot prove');
unk('a merchant-set logo rendering on the live shop',
    'needs an authenticated merchant to save a logoUrl; the same gap as Slice A');

head('RESULT');
console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
process.exit(fail > 0 ? 1 : 0);
