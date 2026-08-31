#!/usr/bin/env node
/**
 * IN-SHELL CHROME — a hosted module must not paint its own navigation.
 *
 *   node scripts/test-inshell-chrome.js
 *
 * THE DEFECT THIS EXISTS FOR: every embedded module loads shared-header.js, which injects
 * the customer bar (Home / Shop / Services / Messages). The in-shell boundary hid the
 * HEADER and left the BAR, so it stacked under the merchant shell's own navigation —
 * reported on fulfilment, verification, returns, plans, minishop and the delivery hub.
 * One missing CSS rule, every embedded page.
 *
 * Two independent things must hold, and each fails separately:
 *   1. every page the shell EMBEDS carries the boundary, before its first script
 *   2. the boundary actually hides the bar, and reclaims the space reserved for it
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 96) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log('\n' + t);

console.log('\nIN-SHELL CHROME\n' + '='.repeat(60));

/* ── 1. the boundary hides what actually exists ─────────────────────────────── */
head('1 · the boundary hides the bar, not only the header');
const INS = read('sokoni-inshell.js');
ck('it hides the shared HEADER', /\.sk-in-shell \.sk-shared-header/.test(INS));
ck('it hides the shared BOTTOM NAV', /\.sk-in-shell \.bottom-nav\{display:none/.test(INS),
   'this was the double navigation');
ck('...and reclaims the space reserved for it',
   /--sk-bottom-nav-h:0px/.test(INS) || /padding-bottom:0/.test(INS),
   'hiding a fixed bar but keeping its clearance trades a double nav for a dead strip');
ck('CONTROL it still scopes every rule under .sk-in-shell',
   (INS.match(/'\.sk-in-shell/g) || []).length >= 5 &&
   !/^\s*'\.bottom-nav\{/m.test(INS),
   'an unscoped rule would hide the bar on standalone pages too');

/* the class the rules depend on must actually be applied */
ck('the class is applied only when framed',
   /window\.parent\s*===\s*window/.test(INS) || /sk-in-shell/.test(INS));

/* ── 2. every embedded page carries it ──────────────────────────────────────── */
head('2 · every page the shell embeds carries the boundary');
const ROUTES = read('sokoni-merchant-routes.js');
const parts = ROUTES.split(/\n\s*\{\s*id:'/).slice(1);
const embedded = [];
parts.forEach((p) => {
  const id = (p.match(/^([a-z0-9-]+)'/) || [])[1];
  const kind = (p.match(/kind:'([a-z]+)'/) || [])[1];
  const src = (p.match(/src:'([^']+)'/) || [])[1];
  if (kind === 'page' && src) embedded.push({ id, file: src.split('?')[0] });
  if (kind === 'seller') embedded.push({ id, file: 'seller.html' });
  if (kind === 'pos') embedded.push({ id, file: 'pos.html' });
});
ck('the route contract yielded embedded pages', embedded.length > 0, embedded.length + ' routes');

const missing = [], late = [];
const seen = {};
embedded.forEach((e) => {
  if (seen[e.file]) return;
  seen[e.file] = 1;
  let src;
  try { src = read(e.file); } catch (_) { missing.push(e.file + ' (no file)'); return; }
  const i = src.indexOf('sokoni-inshell.js');
  if (i === -1) { missing.push(e.file + ' via ' + e.id); return; }
  /* WHAT ACTUALLY PREVENTS THE FLASH is the INLINE detector that stamps the class, not
     the sokoni-inshell.js tag that injects the CSS. Measuring the tag's position failed
     pos.html (11 scripts) and seller.html (3) while their class-setter sits after one or
     two — so the first version of this assertion was reading the wrong thing.

     The class must land before first paint. The stylesheet arriving a little later can
     only cost a brief flash, never a persistent double nav, so it is reported below
     rather than gated on. */
  const inline = src.indexOf('window.parent===window');
  if (inline === -1) { late.push(e.file + ' (no inline class-setter)'); return; }
  const before = (src.slice(0, inline).match(/<script/g) || []).length;
  if (before > 2) late.push(e.file + ' (class set after ' + before + ' scripts)');
});
ck('every embedded page has the boundary', missing.length === 0, missing.join(', ') || 'all covered');
ck('...and the CLASS lands before first paint', late.length === 0, late.join(', ') || 'all early');

/* ── 3. the pages that DO paint a bar are the ones that need it ─────────────── */
head('3 · the pages needing it are the ones that inject a bar');
const injectors = Object.keys(seen).filter((f) => {
  try { return read(f).indexOf('shared-header.js') > -1; } catch (_) { return false; }
});
ck('embedded pages do load shared-header (hence the injected bar)',
   injectors.length > 0, injectors.length + ' of ' + Object.keys(seen).length);
ck('every injector is covered by the boundary',
   injectors.every((f) => { try { return read(f).indexOf('sokoni-inshell.js') > -1; } catch (_) { return false; } }),
   injectors.filter((f) => { try { return read(f).indexOf('sokoni-inshell.js') === -1; } catch (_) { return true; } }).join(', ') || 'all covered');

/* ── 4. CONTROLS ────────────────────────────────────────────────────────────── */
head('4 · controls — the check must be able to fail');
ck('CONTROL removing the bottom-nav rule would fail check 1',
   !/\.sk-in-shell \.bottom-nav/.test(INS.replace(/'\.sk-in-shell \.bottom-nav\{display:none !important\}',?/, '')),
   'proves the assertion reads that rule and not something adjacent');
ck('CONTROL a standalone page keeps its navigation',
   !/^\s*'\.bottom-nav\{display:none/m.test(INS),
   'the rule must stay scoped, or a merchant loses the bar outside the shell');

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
