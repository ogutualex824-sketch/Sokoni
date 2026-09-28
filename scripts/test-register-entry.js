/* test-register-entry.js — every PRE-APPROVAL "register as a provider" entry reaches the ONE canonical intake.
 *
 *   node scripts/test-register-entry.js                 # the fix — must PASS
 *   COUNTERPROOF=1 node scripts/test-register-entry.js  # 4e9607b (before) — failures ARE the defects
 *
 * PROVES
 *   E1  hub-register.js (executed in a sandbox) opens the Register My Business form from the URL:
 *       #register=dj → preselects dj; #register=<unknown> → opens blank; #register → blank; other hashes → nothing;
 *       and a later hashchange opens it too
 *   E2  the pre-approval entries no longer send registrants to provider-onboarding.html (which files no application
 *       AdminOS can decide): Entertainment "Are you a performer?", Creator Studio's bookings CTA, the cleaners' empty
 *       state, the directory empty state, and profile.html's "My services" when no provider exists yet
 *   E3  every #register=<id> link in the site uses a REAL hub-register id, and lands on a page that loads the form
 *   E4  control: POST-approval profile editing (provider-dashboard "Edit storefront") still goes to
 *       provider-onboarding.html — that page is the storefront editor, not an intake
 */
'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const CPM = !!process.env.COUNTERPROOF;
const read = (f) => (CPM ? cp.execFileSync('git', ['show', '4e9607b:' + f], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6 }) : fs.readFileSync(path.join(ROOT, f), 'utf8'));
let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + JSON.stringify(d).slice(0, 170) + ']' : '')); ok ? pass++ : fail++; };
console.log('\nSOURCE: ' + (CPM ? '4e9607b (before) — failures below ARE the defects' : 'working tree (fix)'));

/* E1 — execute hub-register.js with a stub DOM; spy on HubRegister.open */
const HR = read('hub-register.js');
function runHash(hash, later) {
  const listeners = {}; const calls = [];
  const on = (t, f) => { (listeners[t] = listeners[t] || []).push(f); };
  const window = { location: { hash }, addEventListener: on };
  const document = { readyState: 'loading', addEventListener: on, getElementById: () => null, body: { style: {} }, head: { appendChild() {} }, createElement: () => ({ style: {} }) };
  window.document = document;
  vm.runInNewContext(HR, { window, document, console: { log() {}, warn() {}, error() {} }, localStorage: { getItem: () => null, setItem() {} } });
  if (window.HubRegister) window.HubRegister.open = (cfg) => calls.push(cfg);
  (listeners.DOMContentLoaded || []).forEach((f) => f());
  if (later) { window.location.hash = later; (listeners.hashchange || []).forEach((f) => f()); }
  return calls;
}
const a = runHash('#register=dj'), b = runHash('#register=not-a-business'), c = runHash('#register'), d = runHash('#pricing'), e = runHash('', '#register=cleaning');
ck('E1  the form opens from the URL (#register=dj preselects; unknown/blank open blank; other hashes nothing; hashchange too)',
  a.length === 1 && a[0].category === 'dj' && b.length === 1 && !b[0].category && c.length === 1 && !c[0].category && d.length === 0 && e.length === 1 && e[0].category === 'cleaning',
  { dj: a, unknown: b, bare: c, other: d.length, hashchange: e });

/* E2 — the pre-approval entries */
const SITES = [
  ['entertainment.html', /<a class="tile" href="([^"]+)"><span class="ic">🎤<\/span><h3>Are you a performer\?/],
  ['creator-studio.html', /apply as an Entertainment provider\.<\/p><div class="row"><a class="btn ghost" href="([^"]+)"/],
  ['cleaning.html', /<a href="([^"]+)" style="color:#00d4ff;font-weight:700;">Register as a cleaner/],
  ['sokoni-providers.js', /\+ '<a href="([^"]+)" style="display:inline-block;padding:10px 20px;'/],
  ['profile.html', /link\.setAttribute\('href', exists\?'provider-dashboard\.html#services':'([^']+)'\)/],
  ['profile.html', /btn\.setAttribute\('href', exists\?'provider-dashboard\.html':'([^']+)'\)/],
];
const targets = SITES.map(([f, re]) => { const m = read(f).match(re); return f + ' → ' + (m ? m[1] : 'NOT FOUND'); });
ck('E2  pre-approval entries no longer go to provider-onboarding.html', targets.every((t) => !/provider-onboarding|NOT FOUND/.test(t)), targets);

/* E3 — every #register=<id> link uses a real id and lands where the form is loaded */
const IDS = new Set([...HR.matchAll(/\{\s*id:'([^']+)'/g)].map((m) => m[1]));
const files = cp.execFileSync('git', ['ls-files', '*.html', '*.js'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter((f) => f && !/^(functions|scripts|docs|tests?)\//.test(f) && fs.existsSync(path.join(ROOT, f)));
const bad = [];
for (const f of files) {
  const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
  for (const m of s.matchAll(/href=\\?["'`]([^"'`]*)#register(?:=([a-z0-9-]+))?\\?["'`]/g)) {
    /* same-page link → this file must load the form; "/" is the home page */
    let page = m[1] ? m[1].replace(/^\//, '') : f;
    if (page === '' || page.endsWith('/')) page += 'index.html';
    const abs = path.join(ROOT, page);
    const loads = fs.existsSync(abs) && fs.statSync(abs).isFile() && /hub-register\.js/.test(fs.readFileSync(abs, 'utf8'));
    if ((m[2] && !IDS.has(m[2])) || !loads) bad.push(f + ':' + m[0].slice(0, 60) + (loads ? '' : ' (page does not load the form)'));
  }
}
ck('E3  every #register=<id> link uses a real id and lands on a page that loads the form', !CPM ? bad.length === 0 : false, CPM ? 'no URL entry exists' : bad);

ck('E4  control: post-approval "Edit storefront" still opens the storefront editor', /onclick="location\.href='provider-onboarding\.html'"><span class="sb-icon">🎨<\/span>Edit storefront/.test(read('provider-dashboard.html')));

console.log(`\n${pass} passed, ${fail} failed`);
if (CPM) console.log('(counter-proof: failures here ARE the defects; E4 is a control)');
process.exit(fail ? 1 : 0);
