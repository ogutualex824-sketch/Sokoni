/* ================================================================
   SOKONI — customer bottom navigation

   The bar was hand-copied into 81 HTML pages. Changing a tab meant editing 81
   files and hoping none drifted — the same mechanism that produced 46 spellings of
   a fulfilment stage and five of "the assigned rider". It is now defined once and
   injected into a marker.

   TWO definitions still exist and BOTH render: SokoniBottomNav.TABS in
   shared-header.js paints the ~81 pages that do not load the nav engine, and
   _CANONICAL_TABS in sokoni-nav-engine.js hydrates the 6 that do. A drift between
   them is a bar that changes shape after hydration, in front of the user. Their
   equality is the most important assertion in this file.

   Run: node scripts/test-customer-nav.js      (no emulator, no browser)
================================================================ */
'use strict';

const fs   = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label +
              (detail !== undefined ? '   [' + String(detail).slice(0, 76) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log('\n── ' + t + ' ──');

const header = fs.readFileSync(path.join(ROOT, 'shared-header.js'), 'utf8');
const engine = fs.readFileSync(path.join(ROOT, 'sokoni-nav-engine.js'), 'utf8');
const active = fs.readFileSync(path.join(ROOT, 'nav-active.js'), 'utf8');

console.log('\nCUSTOMER BOTTOM NAVIGATION');
console.log('='.repeat(70));

/* Parse both tab arrays out of source — reading them rather than restating them,
   so this suite cannot pass by agreeing with itself. */
function headerTabs() {
  const m = header.match(/var SOKONI_NAV = \[([\s\S]*?)\];/);
  if (!m) return null;
  return (m[1].match(/href:\s*'([^']*)'/g) || []).map((s) => s.replace(/href:\s*'|'/g, ''));
}
function headerLabels() {
  const m = header.match(/var SOKONI_NAV = \[([\s\S]*?)\];/);
  return m ? (m[1].match(/label:\s*'([^']*)'/g) || []).map((s) => s.replace(/label:\s*'|'/g, '')) : null;
}
function engineTabs() {
  const m = engine.match(/var _CANONICAL_TABS = \[([\s\S]*?)\];/);
  if (!m) return null;
  return (m[1].match(/h:\s*'([^']*)'/g) || []).map((s) => s.replace(/h:\s*'|'/g, ''));
}
function engineLabels() {
  const m = engine.match(/var _CANONICAL_TABS = \[([\s\S]*?)\];/);
  return m ? (m[1].match(/l:\s*'([^']*)'/g) || []).map((s) => s.replace(/l:\s*'|'/g, '')) : null;
}

/* ── 1 ───────────────────────────────────────────────────────────────────── */
head('1 · the agreed five tabs');
const EXPECT_LABELS = ['Home', 'Shop', 'Services', 'Messages', 'Track'];
const EXPECT_HREFS  = ['/', 'category.html?cat=all', 'services.html', 'messages.html', 'track.html'];
const hT = headerTabs(), hL = headerLabels(), eT = engineTabs(), eL = engineLabels();

ck('CONTROL — both arrays were parsed from source',
   Array.isArray(hT) && Array.isArray(eT) && hT.length === 5 && eT.length === 5,
   'header ' + (hT || []).length + ', engine ' + (eT || []).length);
ck('labels are Home · Shop · Services · Messages · Track',
   JSON.stringify(hL) === JSON.stringify(EXPECT_LABELS), (hL || []).join('·'));
ck('hrefs point at the agreed destinations',
   JSON.stringify(hT) === JSON.stringify(EXPECT_HREFS), (hT || []).join(' | '));
ck('Orders is no longer a tab', (hT || []).indexOf('my-orders.html') === -1);
ck('Profile is no longer a tab', (hT || []).indexOf('profile.html') === -1);

/* ── 2 ── THE ONE THAT MATTERS ───────────────────────────────────────────── */
head('2 · the two renderers agree');
/* One paints first, the other hydrates. A mismatch is a bar that changes under
   the user's thumb. */
ck('engine hrefs === header hrefs', JSON.stringify(eT) === JSON.stringify(hT),
   (eT || []).join(' | '));
ck('engine labels === header labels', JSON.stringify(eL) === JSON.stringify(hL),
   (eL || []).join('·'));

/* ── 3 ───────────────────────────────────────────────────────────────────── */
head('3 · one definition, injected by MARKER');
ck('the injector selects the marker, not a class',
   /querySelectorAll\('nav\[data-sokoni-nav\]'\)/.test(header));
/* Filling every .bottom-nav would have replaced the seller/analytics/admin bars
   with the customer one. */
ck('it does NOT fill every .bottom-nav',
   !/querySelectorAll\('\.bottom-nav'\)/.test(header) &&
   !/querySelectorAll\('nav\.bottom-nav'\)/.test(header));
ck('injection is idempotent — a second run cannot double the bar',
   /querySelector\('\.bnav-item'\)\) continue/.test(header));
ck('the tabs are exposed for this suite to read', /window\.SokoniBottomNav/.test(header));
ck('the engine exposes its array too', /TABS: _CANONICAL_TABS/.test(engine));

/* ── 4 ───────────────────────────────────────────────────────────────────── */
head('4 · every customer page uses the injector');
const files = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));
const placeholder = [], hardcoded = [], missingHeader = [];
files.forEach((f) => {
  const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
  if (/data-sokoni-nav/.test(s)) {
    placeholder.push(f);
    if (!/shared-header\.js/.test(s)) missingHeader.push(f);
  }
  /* A page still shipping <a class="bnav-item"> is still hand-maintained. */
  if (/<a[^>]*class="bnav-item"/.test(s)) hardcoded.push(f);
});
ck('CONTROL — HTML pages were scanned', files.length > 50, files.length + ' files');
ck('the injector is used by the customer surface', placeholder.length >= 80,
   placeholder.length + ' pages');
/* Without shared-header.js the marker is never filled and the page shows an EMPTY
   bar — worse than the old duplicated one. */
ck('every placeholder page loads shared-header.js', missingHeader.length === 0,
   missingHeader.slice(0, 4).join(',') || 'all load it');

/* The pages that still hardcode items must be NON-customer navs only. */
const CANON_OLD = ['/', 'category.html?cat=all', 'services.html', 'my-orders.html', 'profile.html'];
const strayCustomer = hardcoded.filter((f) => {
  const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const m = s.match(/<nav[^>]*>[\s\S]*?<\/nav>/i);
  if (!m) return false;
  const hrefs = (m[0].match(/href="([^"]*)"/g) || []).map((h) => h.slice(6, -1));
  return hrefs.length === 5 && hrefs.every((h, i) => h === CANON_OLD[i]);
});
ck('no page still ships the OLD five-item customer bar',
   strayCustomer.length === 0, strayCustomer.join(',') || 'none');

/* ── 5 ───────────────────────────────────────────────────────────────────── */
head('5 · the active-tab map knows the new destinations');
/* Both were mapped to profile.html when they were not tabs. Left unchanged, the
   new tabs would never highlight. */
ck('track.html activates itself', /'track\.html':\s*'track\.html'/.test(active));
ck('messages.html activates itself', /'messages\.html':\s*'messages\.html'/.test(active));
/* Orders and Profile are still real destinations; their pages must still resolve
   to SOME tab rather than being dropped from the map. */
ck('my-orders.html is still mapped', /'my-orders\.html':/.test(active));
ck('profile.html is still mapped', /'profile\.html':/.test(active));

head('6 · restructuring, not removal');
ck('Profile remains reachable from the header', /profile\.html/.test(header));
/* MEASURED, not assumed: profile.html carried ZERO links to my-orders.html, so the
   bottom-nav tab was Orders' ONLY entry point. "Restructuring, not removal" would
   have been removal in practice. It now lives in the header drawer, which every
   customer page loads — asserted there rather than on a page that never had it. */
ck('Orders remains reachable from the header drawer',
   /label:'My Orders',\s*href:'my-orders\.html'/.test(header));
ck('...and Track is reachable there too',
   /label:'Track',\s*href:'track\.html'/.test(header));
ck('the destinations exist', fs.existsSync(path.join(ROOT, 'messages.html')) &&
   fs.existsSync(path.join(ROOT, 'track.html')));
/* Track opens today's tracker and claims nothing more. */
ck('Track grants no location access of its own',
   !/geolocation|riderLocations|driverLocations/.test(header));

head('7 · the merchant bar is untouched');
/* mbnav is the MERCHANT nav inside merchant-v2 and must not be caught by any of
   this — a customer bar inside the merchant shell is a defect this repo has
   already paid for. */
ck('the injector never targets mbnav', !/mbnav/.test(header));
const routes = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-routes.js'), 'utf8');
ck('the merchant BOTTOM_NAV still declares its own slots',
   /BOTTOM_NAV\s*=\s*\[/.test(routes) && /id:'sell'/.test(routes));


/* ── 8 ───────────────────────────────────────────────────────────────────── */
head('8 · ONE destination for a conversation');
/* Messages lived in the header AND the bottom bar, so a tap on either reached the
   same wall by two routes — and any future divergence would be invisible. */
ck('the header no longer renders a Messages button',
   !/id="sk-msg-btn"/.test(header), 'sk-msg-btn absent');
ck('index.html no longer hardcodes one',
   !/id="sk-msg-btn"/.test(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')));
/* THE BELL STAYS. Notifications are the alert mechanism; Messages is the
   destination they open into. Removing the bell was never the ask. */
ck('the notification bell is untouched', /sk-notif-badge/.test(header));
ck('notifications.html is still reachable', /notifications\.html/.test(header));

head('9 · the unread badge moved, it was not dropped');
/* Deleting the element alone would have orphaned two writers at
   _setBadge('sk-msg-badge', ...) — the count would compute and land nowhere. */
ck('the Messages tab carries the badge', /badgeId: 'sk-msg-badge'/.test(header));
ck('the injector renders a badge when a tab declares one',
   /t\.badgeId/.test(header) && /class="sk-badge" id="' \+ t\.badgeId/.test(header));
ck('the existing counter still writes to that id',
   /_setBadge\('sk-msg-badge', count\)/.test(header));
ck('exactly ONE element can own that id now',
   (header.match(/id="sk-msg-badge"/g) || []).length === 0, 'no static copy left');
/* .sk-badge is position:absolute and needs a positioned host. */
ck('the bar positions the badge', /\.bnav-item \{ position: relative; \}/.test(header));

head('10 · one route vocabulary across every surface');
/* Anchored on the MARKUP, not the bare class name — `sk-acct-links` first appears
   in a CSS rule, so slicing from it captured styles and every assertion below ran
   against 698 characters of CSS. The control now asserts the slice contains a known
   menu entry, because a length check passed that quite happily. */
const _acctAt = header.indexOf("'<div class=\"sk-acct-links\">'");
const acct = _acctAt === -1 ? '' : header.slice(_acctAt, header.indexOf('sk-acct-link-danger', _acctAt));
ck('CONTROL — the account menu markup was isolated',
   acct.length > 300 && /My Profile/.test(acct), acct.length + ' chars');
/* Restating the links is how a menu ends up pointing at a route the bar no longer
   has. It reads the same array the bar renders. */
ck('the dropdown builds its shortcuts FROM the tab array',
   /window\.SokoniBottomNav && window\.SokoniBottomNav\.TABS/.test(acct));
ck('it does not restate the five hrefs', !/category\.html\?cat=all/.test(acct));
ck('the tabs exist before any consumer runs',
   header.indexOf('window.SokoniBottomNav =') < header.indexOf('_buildAcctPopup(user);'));
ck('a missing tab array omits the section rather than rendering dead links',
   /if \(!tabs\.length\) return '';/.test(acct));

head('11 · the dropdown speaks the same emoji language');
['👤 My Profile', '📦 My Orders', '🔔 Notifications', '⚙️ Settings',
 '🛡️ Account &amp; Security', '❓ Help &amp; Support'].forEach(function (e) {
  ck('menu carries ' + e.split(' ')[0] + ' ' + e.split(' ').slice(1).join(' '),
     acct.indexOf(e) !== -1);
});
ck('Sign Out is 🚪 and stays separated as an ACTION',
   /sk-acct-separator[\s\S]{0,200}🚪 Sign Out/.test(header));
/* The emoji are presentation only. */
ck('role-aware entries are preserved',
   /My Workspaces/.test(acct) && /Wallet/.test(acct));
ck('no Font Awesome glyphs remain in the account links',
   !/fas fa-/.test(acct), 'emoji only');


/* ── 12 ───────────────────────────────────────────────────────────────────── */
head('12 · the CSS template literal is still intact');
/* THIS BIT, and it was silent. A backtick inside the CSS block TERMINATES the
   template literal: the stylesheet truncated, shared-header stopped injecting on
   every standalone page, and `node --check` still passed because the remaining JS
   was valid. Only test-merchant-shell-boundary going 0 -> 3 caught it.

   The check is a parity one: an ODD number of backticks before the badge rules
   means they sit inside an unterminated literal. */
(function () {
  const marker = '.bnav-item .sk-badge';
  const at = header.indexOf(marker);
  ck('CONTROL — the badge rules are present', at !== -1);
  if (at === -1) return;
  const ticksBefore = (header.slice(0, at).match(/`/g) || []).length;
  ck('the badge rules sit INSIDE the CSS literal, which is still open',
     ticksBefore % 2 === 1, ticksBefore + ' backticks before them');
  /* And nothing between the block start and the rules closed it early. */
  const blockStart = header.lastIndexOf('`', at);
  const between = header.slice(blockStart + 1, at);
  ck('no stray backtick between the literal start and the rules',
     between.indexOf('`') === -1);
})();
/* The header must actually inject — the failure mode was its absence, not an error. */
ck('the header injector is still reachable', /sk-top-nav/.test(header));
ck('CSS-in-JS hazard is documented where it bit', /NO BACKTICKS IN THIS COMMENT/.test(header));


/* ── 13 ───────────────────────────────────────────────────────────────────── */
head('13 · pages that own their header still get the bar');
/* EXCLUDED governs the TOP-NAV chrome. Three pages in it — profile.html,
   seller.html, success.html — nevertheless shipped the standard customer bottom
   bar, so converting them to a placeholder while the fill lived inside _inject
   left them with an EMPTY bar: old markup gone, nothing to replace it. Found on
   the deployed preview, after a service-worker theory that was wrong. */
const excludedBlock = header.slice(header.indexOf('const EXCLUDED = ['),
                                   header.indexOf('];', header.indexOf('const EXCLUDED = [')));
ck('CONTROL — the EXCLUDED list was isolated', excludedBlock.length > 100);
const excludedKeys = [...excludedBlock.matchAll(/'([a-z0-9-]+)(?:\.html)?'/g)].map((m) => m[1]);
const stranded = files.filter((f) => {
  if (!/data-sokoni-nav/.test(fs.readFileSync(path.join(ROOT, f), 'utf8'))) return false;
  return excludedKeys.indexOf(f.replace(/\.html$/, '')) !== -1;
});
ck('CONTROL — pages exist that are BOTH excluded and converted', stranded.length > 0,
   stranded.join(',') || 'none — this check would be vacuous');
/* The fill must run BEFORE the early return, or those pages never get it. */
const fillAt = header.indexOf('_fillBottomNavEarly, { once: true }');
const returnAt = header.indexOf('if (_match(EXCLUDED)) return;');
ck('the bar is filled BEFORE the EXCLUDED early-return',
   fillAt !== -1 && returnAt !== -1 && fillAt < returnAt, fillAt + ' < ' + returnAt);
/* Marker-gating is what makes running earlier safe: pos/merchant/shell have no
   marker, so being reached sooner cannot give them a customer bar. */
ck('the early fill is still MARKER-gated, not class-gated',
   /_fillBottomNavEarly[\s\S]{0,240}querySelectorAll\('nav\[data-sokoni-nav\]'\)/.test(header));
ck('it is idempotent, so running twice cannot double the bar',
   /_fillBottomNavEarly[\s\S]{0,400}querySelector\('\.bnav-item'\)\) continue/.test(header));
/* ONE renderer. Two copies of the markup would drift the moment either changed. */
ck('only ONE place builds the item markup',
   (header.match(/bnav-emoji/g) || []).length === 1,
   (header.match(/bnav-emoji/g) || []).length + ' occurrence(s)');
ck('the in-inject path delegates rather than duplicating',
   /function _injectBottomNav\(\) \{ _fillBottomNavEarly\(\); \}/.test(header));

console.log('\n' + '='.repeat(70));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
