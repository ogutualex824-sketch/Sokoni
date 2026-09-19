/* ══════════════════════════════════════════════════════════════════════════════
   PROFILE TAB HISTORY — CERTIFICATION
   scripts/test-profile-tab-history.js

   THE DEFECT THIS PINS
   `switchTab()` toggled CSS classes and nothing else. The hash -> tab direction existed
   (`_openTabFromHash`, plus a `hashchange` listener), but the tab -> hash direction did
   not, so:

     * switching tabs created NO history entry;
     * on mobile, Back from any tab left the profile entirely instead of stepping back
       through the tabs;
     * the URL never reflected the visible tab, so a tab could not be linked or reloaded.

   HOW IT IS ASSERTED
   Behaviourally. A small model of the browser's hash/history contract drives the REAL
   `switchTab` and `_openTabFromHash`: assigning `location.hash` pushes an entry and fires
   `hashchange`; back()/forward() move the cursor and fire it too. The suite asserts where
   the user ends up, never that the source contains `location.hash` — the mechanism is the
   implementation's choice, the behaviour is the contract.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d ? '   [' + d + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (d ? '   [' + d + ']' : '')); }
};
const head = t => console.log('\n' + t);
const html = fs.readFileSync(path.join(ROOT, 'profile.html'), 'utf8');

function extractFn (src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) return null;
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

const SWITCH_SRC = extractFn(html, 'switchTab');
const HASH_SRC   = extractFn(html, '_openTabFromHash');
/* The tabs the page actually declares — read from the markup, not restated here. */
const TABS = [...html.matchAll(/data-tab="([a-z]+)"/g)].map(m => m[1]);
/* Likewise the default tab: taken from the page so the test cannot agree with itself
   about a value the page has since changed. */
const DEFAULT_TAB = (html.match(/var _DEFAULT_TAB = '([a-z]+)'/) || [])[1] || '';

/* ── A MODEL OF THE BROWSER ──────────────────────────────────────────────────
   Entries are hashes. Assigning a DIFFERENT hash pushes; assigning the same one is a
   no-op, exactly as a browser behaves. back()/forward() move the cursor. Each change
   fires the page's hashchange listener. */
function browser (initialHash) {
  const stack = [initialHash || ''];
  let i = 0;
  const listeners = [];
  const loc = {
    get hash () { return stack[i]; },
    set hash (v) {
      const next = v.charAt(0) === '#' ? v : '#' + v;
      if (stack[i] === next) return;          /* no entry, no event */
      stack.splice(i + 1);                    /* a new branch discards forward history */
      stack.push(next); i = stack.length - 1;
      listeners.forEach(fn => fn());
    },
  };
  return {
    loc,
    onHashChange: (fn) => listeners.push(fn),
    back () { if (i > 0) { i--; listeners.forEach(fn => fn()); } },
    forward () { if (i < stack.length - 1) { i++; listeners.forEach(fn => fn()); } },
    entries: () => stack.slice(),
    depth: () => stack.length,
    cursor: () => i,
  };
}

/* Build a page whose DOM reports which tab is active. */
function page (initialHash, initialActive) {
  const active = { tab: initialActive || 'overview' };
  const tabEls = TABS.map(t => ({ dataset: { tab: t },
    classList: { toggle (cls, on) { if (cls === 'active' && on) active.tab = t; } } }));
  const panelEls = TABS.map(t => ({ id: 'panel-' + t,
    classList: { toggle () {} } }));

  const b = browser(initialHash);
  const sandbox = {
    document: {
      querySelectorAll: (sel) => (sel === '.up-tab' ? tabEls : panelEls),
      getElementById: (id) => (TABS.indexOf(String(id).replace('panel-', '')) > -1 ? {} : null),
    },
    location: b.loc,
    _DEFAULT_TAB: DEFAULT_TAB,
    window: { addEventListener: () => {} },
  };
  /* eslint-disable no-new-func */
  const build = new Function('sandbox',
    'with (sandbox) {' + SWITCH_SRC + '\n' + HASH_SRC +
    '\n return { switchTab: switchTab, openFromHash: _openTabFromHash }; }');
  const api = build(sandbox);
  b.onHashChange(api.openFromHash);
  return { api, b, active };
}

console.log('══════════════════════════════════════════════════════════════════');
console.log('  PROFILE TAB HISTORY');
console.log('══════════════════════════════════════════════════════════════════');

head('0 - the shipped functions');
ok('control — switchTab extracted', !!SWITCH_SRC && SWITCH_SRC.length > 80);
ok('control — _openTabFromHash extracted', !!HASH_SRC);
ok('control — the page declares tabs', TABS.length > 5, TABS.length + ' tabs');
ok('control — orders and wallet are among them',
   TABS.indexOf('orders') > -1 && TABS.indexOf('wallet') > -1);
ok('control — the page declares a default tab', !!DEFAULT_TAB && TABS.indexOf(DEFAULT_TAB) > -1, DEFAULT_TAB);

/* ── 1. INITIAL LOAD ────────────────────────────────────────────────────────── */
head('1 - a bare load creates no artificial history');
{
  const { api, b, active } = page('', DEFAULT_TAB);
  api.openFromHash();                     /* what profile.html does at init */
  ok('history depth is still 1', b.depth() === 1, String(b.depth()));
  ok('the URL is untouched', b.loc.hash === '', JSON.stringify(b.loc.hash));
  ok('the default tab is shown', active.tab === DEFAULT_TAB, active.tab);
}

/* ── 2. DEEP LINK ───────────────────────────────────────────────────────────── */
head('2 - a deep link opens that tab and adds nothing');
{
  const { api, b, active } = page('#orders', 'overview');
  api.openFromHash();
  ok('Orders opens', active.tab === 'orders', active.tab);
  ok('history depth is still 1', b.depth() === 1, String(b.depth()));
  ok('the URL still reads #orders', b.loc.hash === '#orders', b.loc.hash);
}

/* ── 3. THE BACK-STACK ──────────────────────────────────────────────────────── */
head('3 - Profile -> Orders -> Wallet -> Back -> Back');
{
  const { api, b, active } = page('', DEFAULT_TAB);
  api.openFromHash();

  api.switchTab('orders');
  ok('Orders is shown', active.tab === 'orders', active.tab);
  ok('and an entry was created', b.depth() === 2, 'depth ' + b.depth());
  ok('the URL reflects it', b.loc.hash === '#orders', b.loc.hash);

  api.switchTab('wallet');
  ok('Wallet is shown', active.tab === 'wallet', active.tab);
  ok('and a second entry was created', b.depth() === 3, 'depth ' + b.depth());

  b.back();
  ok('Back returns to Orders', active.tab === 'orders', active.tab);
  ok('and the URL follows', b.loc.hash === '#orders', b.loc.hash);

  b.back();
  ok('Back again returns to the original profile location', b.loc.hash === '',
     JSON.stringify(b.loc.hash));
  /* The gap that made Back look broken: an empty hash must restore the default tab, not
     leave the previous tab on screen while the URL says otherwise. */
  ok('and the default tab is restored', active.tab === DEFAULT_TAB, active.tab);
  ok('we are at the first entry', b.cursor() === 0, 'cursor ' + b.cursor());

  b.forward();
  ok('Forward returns to Orders', active.tab === 'orders' && b.loc.hash === '#orders',
     active.tab + ' ' + b.loc.hash);
  b.forward();
  ok('Forward again reaches Wallet', active.tab === 'wallet', active.tab);
}

/* ── 4. NO DUPLICATE ENTRIES ────────────────────────────────────────────────── */
head('4 - re-selecting the active tab is not a navigation');
{
  const { api, b } = page('', DEFAULT_TAB);
  api.openFromHash();
  api.switchTab('orders');
  const depth = b.depth();
  api.switchTab('orders');
  api.switchTab('orders');
  ok('three clicks on the same tab add one entry', b.depth() === depth,
     depth + ' -> ' + b.depth());
  b.back();
  ok('one Back leaves the tab area', b.loc.hash === '', JSON.stringify(b.loc.hash));
}

/* ── 5. NO LOOP ─────────────────────────────────────────────────────────────── */
head('5 - the hash listener cannot re-enter the writer');
{
  /* A naive implementation writes the hash, the listener fires, the listener calls
     switchTab, which writes the hash again... The model would show extra entries. */
  const { api, b, active } = page('', DEFAULT_TAB);
  api.openFromHash();
  api.switchTab('wallet');
  ok('exactly one entry per switch', b.depth() === 2, 'depth ' + b.depth());
  ok('and the tab is correct', active.tab === 'wallet', active.tab);
  api.switchTab('identity');
  ok('still one entry per switch', b.depth() === 3, 'depth ' + b.depth());
}

/* ── 6. EVERY DECLARED TAB PARTICIPATES ─────────────────────────────────────── */
head('6 - every tab in the markup is linkable and navigable');
{
  const { api, b, active } = page('', DEFAULT_TAB);
  api.openFromHash();
  let allOk = true, allLinkable = true;
  TABS.forEach(t => {
    api.switchTab(t);
    if (active.tab !== t) allOk = false;
    if (b.loc.hash !== '#' + t) allLinkable = false;
  });
  ok('switching to each declared tab works', allOk);
  ok('and each leaves a linkable URL', allLinkable);
  ok('the stack grew once per DISTINCT tab', b.depth() === TABS.length + 1,
     'depth ' + b.depth() + ' for ' + TABS.length + ' tabs');
  /* Walking all the way back returns to the bare profile URL. */
  for (let i = 0; i < TABS.length; i++) b.back();
  ok('walking Back through them returns to the bare profile URL', b.loc.hash === '',
     JSON.stringify(b.loc.hash));
  ok('showing the default tab', active.tab === DEFAULT_TAB, active.tab);
}

/* ── 7. THE HASH REMAINS THE RENDERING AUTHORITY ────────────────────────────── */
head('7 - the existing contract is preserved');
{
  const { api, b, active } = page('', DEFAULT_TAB);
  api.openFromHash();
  /* A hash set by anything else — another script, a link, the user editing the URL —
     still renders, because _openTabFromHash is what draws. */
  b.loc.hash = '#bookings';
  ok('an externally set hash renders that tab', active.tab === 'bookings', active.tab);
  /* An unknown hash must not blank the page. */
  const before = active.tab;
  b.loc.hash = '#not-a-tab';
  ok('an unknown hash leaves the current tab alone', active.tab === before, active.tab);
}

console.log('\n  what this suite does NOT prove');
console.log('  UNPROVEN  real browser history behaviour   [modelled, not driven in a browser]');
console.log('  OUT OF SCOPE  Profile <-> Wallet PAGE navigation is separate from these');
console.log('                in-page tabs and is not touched by this repair.');

console.log('\n══════════════════════════════════════════════════════════════════');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('══════════════════════════════════════════════════════════════════');
process.exit(fail ? 1 : 0);
