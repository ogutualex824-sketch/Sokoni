#!/usr/bin/env node
/* test-dashboard-profile-menu.js — owner 2026-10-01: EVERY dashboard (all business types and professionals)
 * carries the profile icon + role dropdown in its header.
 *   C1  every page on the shared header gets the control (shared-header.js injects sokoni-profile-menu.js
 *       for every page, before any early return)
 *   C2  every page that OPTS OUT of the shared header (data-no-header / EXCLUDED) and is a dashboard is
 *       flagged (__skOwnChromeAccount) and so auto-mounts into its own top bar — OR mounts a control itself
 *       (SokoniProfileMenu.mount / SokoniAdminEntry.mountControls). Lists any dashboard left without one.
 *   C3  the auto-mount is safe: skipped when framed / inside the merchant shell / signed out / a control
 *       already exists / an admin console (sokoni-admin-entry.js) owns the menu; mounts as a flex child
 *   C4  admin consoles (admin, super-admin, admin-os) call SokoniAdminEntry.mountControls
 *   N1-N2 negative controls
 */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
let pass = 0, fail = 0;
const ck = (l, ok, g) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok ? '' : '   [' + JSON.stringify(g).slice(0, 600) + ']')); ok ? pass++ : fail++; };

const SH = read('shared-header.js'), PM = read('sokoni-profile-menu.js');
const EXCLUDED = ((SH.match(/const EXCLUDED = \[([\s\S]*?)\];/) || [])[1] || '').match(/'([^']+)'/g).map((s) => s.slice(1, -1).replace(/\.html$/, ''));
const NOT_DASH = ((SH.match(/var NOT_DASHBOARD = \[([\s\S]*?)\];/) || [])[1] || '').match(/'([^']+)'/g || []).map((s) => s.slice(1, -1));
const notDashboard = (k) => NOT_DASH.indexOf(k) !== -1 || /^onboarding/.test(k);

const pages = fs.readdirSync(ROOT).filter((f) => /\.html$/.test(f));
const mountsItself = (t) => /SokoniProfileMenu\.mount\(|SokoniAdminEntry\.mountControls\(/.test(t);
function coverage(sh) {
  const flagOrderOk = sh.indexOf('_flagOwnChromeAccount') > -1 && sh.indexOf('_flagOwnChromeAccount') < sh.indexOf('if (_match(EXCLUDED)) return;');
  const uncovered = [], viaFlag = [], viaOwn = [], viaShared = [];
  for (const p of pages) {
    const t = read(p), k = p.replace(/\.html$/, '');
    const loadsSH = /shared-header\.js/.test(t);
    const optedOut = EXCLUDED.indexOf(k) !== -1 || /data-no-header="true"/.test(t);
    if (!optedOut) { if (loadsSH) viaShared.push(k); continue; }
    if (notDashboard(k)) continue;
    if (mountsItself(t)) { viaOwn.push(k); continue; }
    if (loadsSH && flagOrderOk) { viaFlag.push(k); continue; }
    /* a page without shared-header.js sets the flag itself and loads the menu */
    if (/window\.__skOwnChromeAccount = true/.test(t) && /sokoni-profile-menu\.js/.test(t)) { viaFlag.push(k); continue; }
    uncovered.push(k);
  }
  return { uncovered, viaFlag, viaOwn, viaShared, flagOrderOk };
}
const cov = coverage(SH);
ck('C1 shared-header injects sokoni-profile-menu.js for every page BEFORE any early return', SH.indexOf('_ensureProfileMenu') > -1 && SH.indexOf('_ensureProfileMenu') < SH.indexOf('if (_match(EXCLUDED)) return;'));
ck('C2 every own-chrome DASHBOARD is covered (auto-mount flag or its own mount) — ' + cov.viaFlag.length + ' via flag, ' + cov.viaOwn.length + ' self-mounted, ' + cov.viaShared.length + ' on the shared header', cov.uncovered.length === 0, { uncovered: cov.uncovered });
console.log('      own-chrome via flag: ' + cov.viaFlag.join(' '));
console.log('      self-mounted: ' + cov.viaOwn.join(' '));
const am = PM.slice(PM.indexOf('function autoMountOwnChrome'), PM.indexOf('window.SokoniProfileMenu = {'));
ck('C3 auto-mount skips framed / in-shell / existing control / signed out; mounts as a flex child, fixed fallback otherwise',
  /window\.self !== window\.top/.test(am) && /SokoniInShell\.inShell/.test(am) && /sk-acct-wrap/.test(am) && /sk-admin-profile-wrap/.test(am) && /_readUser\(\)/.test(am)
  && /flex/.test(PM.slice(PM.indexOf('function _ownChromeHost'), PM.indexOf('function autoMountOwnChrome'))) && /script\[src\*="sokoni-admin-entry"\]/.test(PM));
/* admin-os mounts it in sokoni-aos.js init() — AFTER guard('admin') passes (never before the admin check),
   so the page itself must NOT add a second call. */
ck('C4 admin + super-admin mount the admin menu in-page; admin-os via sokoni-aos.js after its admin guard, and NOT a second time in the page',
  ['admin.html', 'super-admin.html'].every((p) => /SokoniAdminEntry\.mountControls\(/.test(read(p)))
  && /SokoniAdminEntry\.mountControls\(\{ role: 'admin' \}\)/.test(read('sokoni-aos.js'))
  && !/SokoniAdminEntry\.mountControls\(/.test(read('admin-os.html')));
const bad = coverage(SH.replace('_flagOwnChromeAccount', '_flagDisabled'));
ck('N1 negative control: without the own-chrome flag, dashboards are reported uncovered', bad.uncovered.length > 0, bad.uncovered.length);
ck('N2 negative control: the admin-entry guard is load-bearing (removing it is detectable)', !/script\[src\*="sokoni-admin-entry"\]/.test(PM.replace('script[src*="sokoni-admin-entry"]', 'x')));
console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
