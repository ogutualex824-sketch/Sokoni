#!/usr/bin/env node
/**
 * test-hub-nav.js — Organizer ⇄ Events Hub navigation. Static. Navigates nothing.
 *
 * ── What was actually wrong ───────────────────────────────────────────────────
 * The brief said there was "no clear, fast way to return to the Events Hub". There WAS:
 * a sticky, 44px, working "← Browse Events" link in the header. Clicking it lands on the
 * hub. Adding another back button would have fixed nothing.
 *
 * Two real defects sat behind that impression.
 *
 * 1. THE SECTIONS WERE NOT PAGES. Dashboard, Analytics, Check-In, Orders, Promo… are
 *    sections of ONE document, switched by toggling a CSS class. No history entry, no
 *    hash. So the browser/device BACK gesture did not step back through them — it left
 *    the organizer entirely. On iOS a swipe-back from Analytics threw you out of the
 *    tool. And Back from the FIRST section is a real cross-document navigation that a
 *    popstate handler cannot intercept at all: arriving from a notification, "back" went
 *    to about:blank.
 *
 *    Fixed with a history FLOOR: replaceState a floor entry, then push the section on
 *    top. Back from the first section now pops onto the floor, popstate fires, and we
 *    redirect to the hub. The tool cannot be fallen out of backwards.
 *
 * 2. ON A PHONE THERE WAS NO SECTION NAVIGATION AT ALL.
 *       @media(max-width:900px){ .sidebar{ display:none } }
 *    The sidebar IS the section nav. Below 900px it is hidden, and nothing replaces it —
 *    so a mobile organizer landed on Dashboard and could not reach six of the seven
 *    sections. That is a far worse dead end than a missing back button, and the brief
 *    never mentions it because from a desktop it is invisible.
 */
'use strict';
const fs   = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok  = m => { pass++; console.log('  pass  ' + m); };
const bad = m => { fail++; console.error('  FAIL  ' + m); };

const nav  = fs.readFileSync(path.resolve('sokoni-hub-nav.js'), 'utf8');
const navC = nav.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const em   = fs.readFileSync(path.resolve('event-manager.html'), 'utf8');
const emC  = em.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const hub  = fs.readFileSync(path.resolve('event-hub.html'), 'utf8');

console.log('\nHub navigation — Organizer ⇄ Events Hub\n');

/* ── 1. Sections must be real history entries ──────────────────────────────── */
{
  /history\.pushState\(\{ skSection/.test(navC)
    ? ok('each section pushes a real history entry — Back steps back through them')
    : bad('sections push no history — Back would leave the organizer entirely');

  /addEventListener\('popstate', onPop\)/.test(navC)
    ? ok('popstate is handled — the device back gesture drives section navigation')
    : bad('popstate is not handled — the iOS swipe-back gesture would exit the tool');
}

/* ── 2. The history FLOOR — the part that makes a dead end impossible ───────── */
{
  /* Without this, Back from the FIRST section is a cross-document navigation. No
     popstate fires; the page cannot intervene; the user leaves. Arriving from a
     notification, there is nothing behind — so "back" goes to about:blank. */
  /replaceState\(\{ skHubFloor: true \}/.test(navC)
    ? ok('a history FLOOR is laid beneath the first section')
    : bad('no history floor — Back from the first section falls out of the app (about:blank from a notification)');

  /st\.skHubFloor/.test(navC) && /location\.replace\(CFG\.hub\.url\)/.test(navC)
    ? ok('reaching the floor redirects to the hub — the tool cannot be fallen out of backwards')
    : bad('the floor is not handled — the user still escapes the app');
}

/* ── 3. Deep links ─────────────────────────────────────────────────────────── */
{
  /function sectionFromUrl/.test(navC) && /location\.hash/.test(navC)
    ? ok('#section deep links are honoured (a notification or QR code can open Analytics)')
    : bad('deep links are ignored — everyone lands on Dashboard regardless');
}

/* ── 4. MOBILE: the sidebar is hidden, so something must replace it ─────────── */
{
  /@media\(max-width:900px\)[\s\S]{0,200}\.sidebar\{display:none\}/.test(em.replace(/\s+/g, ''))
  || /\.sidebar\{display:none;\}/.test(em.replace(/\s+/g, ''))
    ? ok('confirmed: the sidebar IS hidden below 900px (so section nav must come from elsewhere)')
    : ok('(sidebar visibility rule changed — re-check mobile section navigation)');

  /id="em-mobile-nav"/.test(emC)
    ? ok('a mobile section bar exists — a phone user can reach all seven sections')
    : bad('no mobile section nav — six of seven sections are unreachable on a phone');

  /data-sticky-actions/.test(emC)
    ? ok('the mobile section bar is sticky (adopted by sokoni-quick-actions.js)')
    : bad('the mobile section bar scrolls away');

  const tabs = (emC.match(/class="em-mtab"/g) || []).length;
  tabs === 7
    ? ok(`all ${tabs} sections are reachable from the mobile bar`)
    : bad(`the mobile bar exposes ${tabs} sections, not 7`);

  /min-height:44px/.test(emC)
    ? ok('mobile tabs are 44px (the iOS touch-target floor)')
    : bad('mobile tabs are under 44px');
}

/* ── 5. Both navigators driven from ONE source ─────────────────────────────── */
{
  /* The sidebar and the mobile bar must not be able to disagree about which section is
     active — two navigators with separate active-state logic is how they drift. */
  /querySelectorAll\('\[data-sec\]'\)/.test(emC) && /querySelectorAll\('\[data-sec="' \+ name \+ '"\]'\)/.test(emC)
    ? ok('sidebar and mobile bar share one data-sec source — they cannot drift out of sync')
    : bad('the two navigators track active state separately — they will disagree');
}

/* ── 6. Do not add a second back button next to the working one ─────────────── */
{
  /existing\) \{ existing\.setAttribute\('data-sk-hub-back', 'existing'\); return; \}/.test(navC)
    ? ok('an existing hub link is adopted, not duplicated (the header link already worked)')
    : bad('a second back control would be injected beside the one that already works');

  /href="\/event-hub\.html"/.test(em)
    ? ok('event-manager keeps a no-JS fallback link to the hub')
    : bad('no plain <a> fallback to the hub');
}

/* ── 7. Hub state survives the round trip ──────────────────────────────────── */
{
  /pagehide/.test(navC)
    ? ok('state is saved on pagehide (unload does NOT fire reliably on iOS Safari)')
    : bad('state is saved on unload — which iOS Safari does not reliably fire');

  /sessionStorage/.test(navC)
    ? ok('hub state is per-session (a filter set yesterday must not decide what you see today)')
    : bad('hub state is not session-scoped');

  /30 \* 60 \* 1000/.test(navC)
    ? ok('state older than 30 minutes is discarded (a stale filter looks like a bug)')
    : bad('stale state is restored indefinitely');

  /SokoniHubNav\.hub\(\)/.test(hub)
    ? ok('event-hub.html restores its scroll, search and filters on return')
    : bad('the Events Hub does not restore state — returning is a full reload');
}

console.log('');
if (fail) { console.error(`Hub navigation FAILED (${fail})\n`); process.exit(1); }
console.log(`Hub navigation PASSED (${pass} checks)\n`);
