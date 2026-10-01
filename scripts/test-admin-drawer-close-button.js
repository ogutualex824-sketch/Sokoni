#!/usr/bin/env node
/* test-admin-drawer-close-button.js — owner: "add a close button". On phones the AdminOS and Super Admin
 * drawer toggles CLOSE the drawer; they must LOOK like a close button (visible ✕, 44px target) and be
 * named "Close menu". Desktop keeps the « collapse control. Static + executed (the toggle functions run
 * in a VM against a fake DOM at phone and desktop widths).
 *   C1/C2 phone CSS: ✕ via ::after, 44px, no rotation   F1/F2 phone: toggle closes the drawer
 *   L1/L2 phone label "Close menu"; desktop label Collapse/Expand   N1 negative control: CSS removed → C1 fails
 */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ck = (l, ok, got) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok ? '' : '   [got ' + JSON.stringify(got).slice(0, 300) + ']')); ok ? pass++ : fail++; };
const aos = fs.readFileSync(path.join(ROOT, 'admin-os.html'), 'utf8');
const sa = fs.readFileSync(path.join(ROOT, 'super-admin.html'), 'utf8');
const phoneCss = (s, cls) => new RegExp('@media\\(max-width:768px\\)\\{\\.' + cls + '\\{width:44px;height:44px;font-size:0;transform:none!important[^}]*\\}\\.' + cls + '::after\\{content:"\\\\2715"').test(s);
ck('C1 AdminOS: on phones the toggle shows a ✕ at 44px, unrotated', phoneCss(aos, 'aos-sidebar-toggle'), null);
ck('C2 Super Admin: on phones the toggle shows a ✕ at 44px, unrotated', phoneCss(sa, 'sa-sidebar-toggle'), null);
ck('N1 negative control: without the rule, the check fails', !phoneCss(aos.replace(/@media\(max-width:768px\)\{\.aos-sidebar-toggle\{width:44px[^\n]*/, ''), 'aos-sidebar-toggle'), null);

/* Execute the real sidebar scripts at both widths. */
function run(src, ids, toggleFn, collapsedClass, mobile) {
  const els = {}; const mk = (id) => (els[id] = els[id] || { id, attrs: {}, title: '', classList: new Set(), setAttribute(k, v) { this.attrs[k] = String(v); }, removeAttribute(k) { delete this.attrs[k]; }, getAttribute(k) { return this.attrs[k]; }, focus() {}, querySelectorAll() { return []; } });
  ids.forEach(mk);
  for (const e of Object.values(els)) { const cl = e.classList; e.classList = { add: (c) => cl.add(c), remove: (c) => cl.delete(c), contains: (c) => cl.has(c), toggle: (c) => (cl.has(c) ? (cl.delete(c), false) : (cl.add(c), true)) }; }
  const body = { classList: (() => { const s = new Set(); return { add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c), toggle: (c) => (s.has(c) ? (s.delete(c), false) : (s.add(c), true)) }; })() };
  const document = { body, getElementById: (id) => els[id] || null, addEventListener() {}, querySelectorAll: () => [] };
  const window = { matchMedia: () => ({ matches: mobile, addEventListener() {} }), innerWidth: mobile ? 390 : 1280 };
  const localStorage = { getItem: () => null, setItem() {} };
  const fn = new Function('window', 'document', 'localStorage', src + '\n;return { toggle: ' + toggleFn + ', open: (typeof _openSidebar==="function"?_openSidebar:null), sync: _syncSidebarA11y };');
  const api = fn(window, document, localStorage);
  return { els, api, body };
}
function extract(s, startMarker) {
  const a = s.indexOf(startMarker); if (a < 0) return null;
  const end = s.indexOf('</script>', a);
  return s.slice(a, end).replace(/document\.addEventListener\("DOMContentLoaded",[\s\S]*$/, '');
}
{
  const src = extract(aos, 'var _MOBILE_Q = window.matchMedia');
  const p = run(src, ['aosSidebar', 'aosMenuBtn', 'aosSidebarToggle'], '_sidebarToggle', 'sidebar-collapsed', true);
  p.els.aosSidebar.classList.add('open'); p.api.toggle();
  ck('F1 AdminOS phone: the toggle closes the open drawer', !p.els.aosSidebar.classList.contains('open'), null);
  p.api.sync();
  ck('L1 AdminOS phone: toggle is named "Close menu"', p.els.aosSidebarToggle.attrs['aria-label'] === 'Close menu', p.els.aosSidebarToggle.attrs);
  const d = run(src, ['aosSidebar', 'aosMenuBtn', 'aosSidebarToggle'], '_sidebarToggle', 'sidebar-collapsed', false);
  d.api.sync();
  ck('L1b AdminOS desktop: toggle keeps Collapse/Expand', /^(Collapse|Expand) menu$/.test(d.els.aosSidebarToggle.attrs['aria-label']), d.els.aosSidebarToggle.attrs);
}
{
  const a = sa.indexOf('function _saSidebarToggle(){');
  const syncA = sa.lastIndexOf('function _syncSidebarA11y', a);
  const start = sa.lastIndexOf('<script>', syncA) + '<script>'.length;
  const src = sa.slice(start, sa.indexOf('</script>', a)).replace(/document\.addEventListener\("DOMContentLoaded",[\s\S]*$/, '');
  const ids = ['saSidebar', 'sidebar', 'saMenuBtn', 'mobileMenuBtn', 'saSidebarToggle'];
  const p = run(src, ids, '_saSidebarToggle', 'sa-collapsed', true);
  const side = p.els.saSidebar.classList ? p.els.saSidebar : p.els.sidebar;
  ['saSidebar', 'sidebar'].forEach((id) => p.els[id].classList.add('open'));
  p.api.toggle();
  ck('F2 Super Admin phone: the toggle closes the open drawer', ['saSidebar', 'sidebar'].some((id) => !p.els[id].classList.contains('open')), null);
  p.api.sync();
  ck('L2 Super Admin phone: toggle is named "Close menu"', p.els.saSidebarToggle.attrs['aria-label'] === 'Close menu', p.els.saSidebarToggle.attrs);
}
console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
