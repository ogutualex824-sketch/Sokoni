#!/usr/bin/env node
/**
 * test-safe-area.js — the iOS safe-area squeeze.
 *
 * style.css declares `* { box-sizing: border-box }` for the whole platform. Under
 * border-box, padding is taken OUT of a declared height, not added to it. So this:
 *
 *     .bottom-nav { height: 60px; padding-bottom: env(safe-area-inset-bottom); }
 *
 * does the opposite of what it looks like. On an iPhone with a 34px home-indicator inset
 * the bar stays 60px tall and its CONTENT is crushed into the remaining 26px — the tabs
 * lose more than half their height, drop under the 44px touch minimum, and the Safari home
 * bar sits over them. The author wrote the safe-area line intending to make room; it
 * removed room instead. It looks correct in every desktop browser, because env() is 0
 * there — which is exactly why it survives review.
 *
 * The fix is to add the inset to the height as well:
 *
 *     height: calc(60px + env(safe-area-inset-bottom, 0px));
 *
 * This gate fails on any rule that declares a flat pixel height alongside a bottom
 * safe-area padding.
 *
 * Run: node scripts/test-safe-area.js
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

let failures = 0;
const fail = (m) => { failures++; console.log('  \x1b[31m✘\x1b[0m ' + m); };
const pass = (m) => console.log('  \x1b[32m✔\x1b[0m ' + m);

console.log('\nSOKONI — iOS safe-area gate\n');

/* Confirm the premise: if the platform ever stops being border-box, this gate's reasoning
   changes and it should be revisited rather than silently kept. */
const style = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
if (/\*\s*\{[^}]*box-sizing\s*:\s*border-box/.test(style)) {
  pass('style.css sets `* { box-sizing: border-box }` — padding is subtracted from height');
} else {
  fail('style.css no longer sets a global border-box — revisit this gate\'s assumption');
}

const files = fs.readdirSync(ROOT).filter((f) => /\.(css|html)$/.test(f));
const offenders = [];

for (const f of files) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  for (const m of src.matchAll(/\{[^{}]*\}/g)) {
    const block = m[0];
    /* Only rules that reserve room for the home indicator. */
    if (!/padding-bottom\s*:\s*[^;]*env\(\s*safe-area-inset-bottom/.test(block)) continue;

    /* A flat pixel height is the bug. A calc() that already folds the inset in is the fix. */
    const h = block.match(/(?:^|[;{\s])height\s*:\s*(\d+)px\s*(?:;|})/);
    if (!h) continue;
    if (/height\s*:\s*calc\([^)]*env\(\s*safe-area-inset-bottom/.test(block)) continue;

    const line = src.slice(0, m.index).split('\n').length;
    const before = src.slice(Math.max(0, m.index - 200), m.index).trim().split('\n');
    const selector = (before[before.length - 1] || '').trim().replace(/\s*\{$/, '');
    offenders.push({ f, line, h: h[1], selector: selector.slice(0, 60) });
  }
}

if (offenders.length === 0) {
  pass(files.length + ' files — no bar declares a flat height alongside a safe-area padding');
} else {
  for (const o of offenders) {
    fail(o.f + ':' + o.line + '  `' + o.selector + '` has height:' + o.h + 'px AND a bottom ' +
         'safe-area padding — on an iPhone the inset is subtracted from the ' + o.h + 'px and the ' +
         'content is crushed. Use height: calc(' + o.h + 'px + env(safe-area-inset-bottom, 0px)).');
  }
}

console.log('');
if (failures) {
  console.log('\x1b[31mFAIL\x1b[0m — ' + failures + ' safe-area problem(s)\n');
  process.exit(1);
}
console.log('\x1b[32mPASS\x1b[0m — safe-area insets extend their bars instead of eating them\n');
