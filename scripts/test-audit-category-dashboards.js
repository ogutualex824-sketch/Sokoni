/* test-audit-category-dashboards.js — the category→dashboard matrix is proven against KNOWN answers, and it fails
 * CLOSED when it can no longer read its inputs.
 *
 *   node scripts/test-audit-category-dashboards.js
 *
 * PROVES
 *   K1  it parses the whole Register My Business list (≥ 100 categories) and the offer.html provider tiles
 *   K2  positive controls through the REAL approval path (resolveRole → C1 → ROUTE_OF):
 *         dj → artist_creator → provider-dashboard.html · hospital → a Healthcare category → provider-dashboard.html
 *         retail-shop → retail_store → merchant-v2.html · mechanic → auto_services · courier → delivery → driver.html
 *   K3  current truth (owner 2026-09-28): food + merchant categories resolve to SELLER (a shop is provisioned);
 *       hotel / property UNROUTED; "other" ADMIN_REVIEW; nothing is routed to merchant-v2 without a shop
 *   K4  every C1 category the modal can reach has a ROUTE_OF entry (no silent NO_ROUTE_ENTRY)
 *   K5  --gate exits non-zero while any gap remains (it is a gate, not a report that always passes)
 *   K6  fails CLOSED (exit 2) when the category list cannot be parsed
 */
'use strict';
const cp = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(__dirname, 'audit-category-dashboards.js');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + JSON.stringify(d).slice(0, 170) + ']' : '')); ok ? pass++ : fail++; };

const r = cp.spawnSync(process.execPath, [TOOL, '--json'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 16e6 });
if (r.status !== 0) { console.log('CRASH the tool did not run: ' + (r.stderr || r.stdout).slice(0, 300)); process.exit(2); }
const J = JSON.parse(r.stdout);
const row = (id) => J.rows.find((x) => x.id === id) || {};

ck('K1  parses the Register My Business list and the offer.html tiles', J.rows.length >= 100 && J.offer.providerTiles.length >= 20, { rows: J.rows.length, tiles: J.offer.providerTiles.length });
const HC = require(path.join(ROOT, 'functions/business-category.js')).HEALTHCARE;
ck('K2  positive controls through the real approval path',
  row('dj').c1 === 'artist_creator' && row('dj').route === 'provider-dashboard.html'
  && HC.includes(row('hospital').c1) && row('hospital').route === 'provider-dashboard.html'
  && row('retail-shop').c1 === 'retail_store' && row('retail-shop').route === 'merchant-v2.html'
  && row('mechanic').c1 === 'auto_services' && row('courier').c1 === 'delivery' && row('courier').route === 'driver.html',
  ['dj', 'hospital', 'retail-shop', 'mechanic', 'courier'].map((id) => id + '→' + row(id).c1 + '→' + row(id).route));
/* owner decisions 2026-09-28: food → merchant-v2 as a SELLER (so a shop is provisioned); hotel / property still
   unrouted; SACCO / forex / other are ADMIN REVIEW ONLY; no merchant-v2 category may land without a shop */
ck('K3  current truth: restaurant ROUTED as seller; hotel / property UNROUTED; "other" ADMIN_REVIEW; none ROUTED_NO_SHOP',
  row('restaurant').verdict === 'ROUTED' && row('restaurant').role === 'seller' && row('bakery').role === 'seller'
  && row('hotel').verdict === 'UNROUTED' && row('landlord').verdict === 'UNROUTED' && row('other').verdict === 'ADMIN_REVIEW'
  && J.summary.routedNoShop === 0 && row('supermarket').role === 'seller' && row('manufacturer').role === 'seller',
  ['restaurant', 'bakery', 'supermarket', 'manufacturer', 'hotel', 'landlord', 'other'].map((id) => id + ':' + row(id).role + '/' + row(id).verdict));
ck('K4  every reachable C1 category has a ROUTE_OF entry', J.summary.noRouteEntry === 0, J.summary.noRouteEntry);
const g = cp.spawnSync(process.execPath, [TOOL, '--gate'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 16e6 });
const gaps = J.summary.unrouted + J.summary.unclassified + J.summary.noRouteEntry + J.summary.offerTilesToLegacyIntake;
ck('K5  --gate is a gate: non-zero while gaps remain (' + gaps + ')', gaps > 0 ? g.status === 1 : g.status === 0, { status: g.status, gaps });

/* fail closed: run the tool against a copy of the repo tree where the CATS block is unreadable */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catmx-'));
fs.mkdirSync(path.join(tmp, 'scripts')); fs.mkdirSync(path.join(tmp, 'functions'));
fs.copyFileSync(TOOL, path.join(tmp, 'scripts', 'audit-category-dashboards.js'));
for (const f of ['business-category.js', 'business-workspace.js', 'healthcare-category.js', 'application-lifecycle.js']) fs.copyFileSync(path.join(ROOT, 'functions', f), path.join(tmp, 'functions', f));
fs.copyFileSync(path.join(ROOT, 'offer.html'), path.join(tmp, 'offer.html'));
fs.writeFileSync(path.join(tmp, 'hub-register.js'), '/* the list moved */\nvar CATEGORIES = [];\n');
const c = cp.spawnSync(process.execPath, [path.join(tmp, 'scripts', 'audit-category-dashboards.js')], { cwd: tmp, encoding: 'utf8' });
fs.rmSync(tmp, { recursive: true, force: true });
ck('K6  fails CLOSED (exit 2) when the category list cannot be parsed', c.status === 2 && /CANNOT RUN/.test(c.stderr), { status: c.status, err: (c.stderr || '').trim().slice(0, 80) });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
