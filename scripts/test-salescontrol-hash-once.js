#!/usr/bin/env node
/* test-salescontrol-hash-once.js — the #salescontrol deep link is a ONE-SHOT request.
 * Defect (found 2026-10-01 from an owner report "minus / Remove sends me to Sales Control"):
 * the merchant shell re-targets the cached POS frame to #salescontrol; pos.js opened the
 * overlay but left the hash, so any later popstate inside the POS (sheet back, Remove,
 * stepper history) reopened Sales Control.
 * Method: EXECUTE pos.js's real nav init() block (extracted from the file, not copied) against
 * a fake window/location/history, and drive the event sequence.
 *   H1 boot at #salescontrol opens once and consumes the hash to #pos
 *   H2 a later popstate never opens the overlay
 *   H3 a hashchange to #salescontrol (the shell's next sidebar click) opens once, consumed
 *   H4 popstate on a stale #salescontrol entry does not open; it is consumed
 *   H5 popstate to a known tab still restores the tab
 *   N1 negative control: the pre-fix handler (hash not consumed) reopens on popstate → H2 would fail
 */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ck = (l, ok, got) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok ? '' : '   [got ' + JSON.stringify(got) + ']')); ok ? pass++ : fail++; };

const src = fs.readFileSync(path.join(ROOT, 'pos.js'), 'utf8');
function extractInit(s) {
  const a = s.indexOf('/* Back/Forward: restore the view named in the URL');
  if (a < 0) throw new Error('init anchor missing');
  const start = s.lastIndexOf('init() {', a);
  let i = s.indexOf('{', start), depth = 0;
  for (; i < s.length; i++) { if (s[i] === '{') depth++; else if (s[i] === '}') { depth--; if (depth === 0) break; } }
  return s.slice(s.indexOf('{', start) + 1, i);
}
function harness(body) {
  const listeners = {}; const opened = []; const switched = []; const timers = [];
  const loc = { pathname: '/pos.html', search: '', hash: '' };
  const hist = { state: null, entries: 0, replaceState(st, t, url) { const h = url.indexOf('#'); loc.hash = h >= 0 ? url.slice(h) : ''; } };
  const win = { addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); }, PosSalesView: { open: () => opened.push(loc.hash) }, history: hist };
  const nav = { KNOWN: ['pos', 'finance', 'reports', 'customers', 'repair'] };
  const ui = { switchTab: (t) => switched.push(t) };
  const fn = new Function('window', 'location', 'history', 'nav', 'ui', 'setTimeout', body);
  return {
    boot(hash) { loc.hash = hash; fn(win, loc, hist, nav, ui, (f) => timers.push(f)); timers.splice(0).forEach((f) => f()); },
    fire(ev, hash) { if (hash !== undefined) loc.hash = hash; (listeners[ev] || []).forEach((f) => f()); },
    get hash() { return loc.hash; }, opened, switched,
  };
}

const body = extractInit(src);
{
  const h = harness(body);
  h.boot('#salescontrol');
  ck('H1  boot at #salescontrol opens the overlay once and consumes the hash to #pos', h.opened.length === 1 && h.hash === '#pos', { opened: h.opened, hash: h.hash });
  h.fire('popstate'); h.fire('popstate');
  ck('H2  later popstate events (sheet back / Remove) never reopen it', h.opened.length === 1, h.opened);
  h.fire('hashchange', '#salescontrol');
  ck('H3  the shell\'s next sidebar click (hashchange to #salescontrol) opens it again, consumed', h.opened.length === 2 && h.hash === '#pos', { opened: h.opened, hash: h.hash });
  h.fire('popstate', '#salescontrol');
  ck('H4  popstate onto a stale #salescontrol entry does not open; the hash is consumed', h.opened.length === 2 && h.hash === '#pos', { opened: h.opened, hash: h.hash });
  h.fire('popstate', '#finance');
  ck('H5  popstate to a known tab still restores that tab', h.switched.includes('finance'), h.switched);
}
{
  /* Negative control: the pre-fix handler shape, extracted the same way from the prior commit's text. */
  const pre = body.replace(/if \(t === 'salescontrol'\) \{ consumeSalesControlHash\(\); return; \}/, "if (t === 'salescontrol') { openSalesControlFromHash(); return; }")
                  .replace(/const openSalesControlFromHash = \(\) => \{\s*consumeSalesControlHash\(\);/, 'const openSalesControlFromHash = () => {');
  const h = harness(pre);
  h.boot('#salescontrol'); h.fire('popstate');
  ck('N1  negative control: without consuming, a popstate reopens Sales Control (the reported defect)', pre !== body && h.opened.length === 2, { changed: pre !== body, opened: h.opened.length });
}
console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
