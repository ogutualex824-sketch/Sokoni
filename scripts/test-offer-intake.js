/* test-offer-intake.js — "What Are You Offering?" (offer.html) registers through the ONE canonical intake.
 *
 *   node scripts/test-offer-intake.js                 # the fix — must PASS
 *   COUNTERPROOF=1 node scripts/test-offer-intake.js  # offer.html @ 4e9607b — failures ARE the defects
 *
 * PROVES
 *   O1  no tile opens the legacy provider.html intake (its applications carry no agreement acknowledgement and
 *       cannot be approved)
 *   O2  every provider tile (27) opens the Register My Business form with a preselect that is a REAL hub-register.js
 *       id (healthcare opens with no preselect — there is no single healthcare id)
 *   O3  hub-register.js is loaded on the page
 *   O4  offerRegister (executed) opens HubRegister with { category } and cancels the navigation; with the form not
 *       yet loaded it stays on the page — it never falls back to the legacy intake
 *   O5  every preselected category classifies through the REAL approval path (resolveRole → C1) — none UNCLASSIFIED
 *   O6  "Already have a dashboard?" goes to the business workspace, not the legacy provider.html
 *   O3b the page's other cards (banking hub, driver intake) never point at a legacy provider intake
 */
'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const CPM = !!process.env.COUNTERPROOF;
const html = CPM ? cp.execFileSync('git', ['show', '4e9607b:offer.html'], { cwd: ROOT, encoding: 'utf8' }) : fs.readFileSync(path.join(ROOT, 'offer.html'), 'utf8');
const hr = fs.readFileSync(path.join(ROOT, 'hub-register.js'), 'utf8');
const IDS = new Set([...hr.matchAll(/\{\s*id:'([^']+)'/g)].map((m) => m[1]));
let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + JSON.stringify(d).slice(0, 170) + ']' : '')); ok ? pass++ : fail++; };
console.log('\nSOURCE: offer.html @ ' + (CPM ? '4e9607b (before) — failures below ARE the defects' : 'working tree (fix)'));

const legacy = [...html.matchAll(/href="provider\.html\?cat=[a-z0-9-]+"/g)].length;
ck('O1  no tile opens the legacy provider.html intake', legacy === 0, legacy);
/* PROVIDER tiles = the cards that register a service business (legacy provider.html link, or the canonical form).
   The page's other cards (banking.html hub, onboarding-driver.html — the driver role's own intake) are not. */
const cards = [...html.matchAll(/<a [^>]*class="of-svc-card"[^>]*>/g)].map((m) => m[0]);
const tiles = cards.filter((t) => /data-reg-category=|href="provider\.html\?cat=/.test(t));
const others = cards.filter((t) => !tiles.includes(t)).map((t) => (t.match(/href="([^"]+)"/) || [])[1]);
const pre = tiles.map((t) => (t.match(/data-reg-category="([a-z0-9-]*)"/) || [])[1]);
const bad = pre.filter((c) => c === undefined || (c !== '' && !IDS.has(c)));
ck('O2  every provider tile (27) opens the form with a real hub-register id', tiles.length === 27 && bad.length === 0 && pre.filter((c) => c === '').length <= 1, { tiles: tiles.length, bad: bad.length, empty: pre.filter((c) => c === '').length });
ck('O3  hub-register.js is loaded on the page', /<script src="hub-register\.js"/.test(html));
ck('O3b the page\'s other cards go to their own surfaces, never a legacy provider intake', others.every((h) => h && !/^provider\.html/.test(h)), others);

const fnSrc = (html.match(/function offerRegister\(category\)\{[\s\S]*?\n\}/) || [])[0];
let o4 = false, o4d = null;
if (fnSrc) {
  const calls = [];
  /* a recording `location`: any navigation the function attempts is observed, never executed */
  const nav = []; const location = { set href(v) { nav.push(v); }, get href() { return ''; }, assign: (v) => nav.push(v), replace: (v) => nav.push(v) };
  const load = (win, hub) => new Function('window', 'HubRegister', 'location', fnSrc + '\nreturn offerRegister;')(win, hub, location);
  const withForm = load({ HubRegister: 1 }, { open: (c) => calls.push(c) });
  const without = load({}, undefined);
  let r1, r2, r3, err = null;
  try { r1 = withForm('plumbing'); r2 = withForm(''); r3 = without('plumbing'); } catch (e) { err = e.message; }
  o4 = !err && r1 === false && r2 === false && calls.length === 2 && calls[0].category === 'plumbing' && !('category' in calls[1]) && r3 === true && nav.length === 0;
  o4d = { r1, r2, r3, calls, nav, err };
}
ck('O4  offerRegister opens HubRegister with the category; without the form it stays on the page', o4, o4d || 'no offerRegister');

const J = JSON.parse(cp.execFileSync(process.execPath, [path.join(__dirname, 'audit-category-dashboards.js'), '--json'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 16e6 }));
const unclassified = pre.filter((c) => c).map((c) => J.rows.find((r) => r.id === c)).filter((r) => !r || !r.c1).map((r) => r && r.id);
ck('O5  every preselect classifies through the real approval path', pre.filter((c) => c).length >= 26 && unclassified.length === 0, unclassified);
ck('O6  "Already have a dashboard?" goes to the business workspace', /<a href="workspace\.html"[^>]*>Business workspace/.test(html) && !/<a href="provider\.html"/.test(html));

console.log(`\n${pass} passed, ${fail} failed`);
if (CPM) console.log('(counter-proof: failures here ARE the defects this slice removes)');
process.exit(fail ? 1 : 0);
