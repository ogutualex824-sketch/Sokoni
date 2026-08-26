#!/usr/bin/env node
/* ============================================================================
   Admin auth-architecture scan — predict the session-dependent set
   ============================================================================
   verification-admin.html certified BLOCKED because it initialises its OWN named
   Firebase app and gates on THAT instance. A stub that replaces window.firebase
   is never consulted, so the page's own auth sees no user and the overlay it
   would hide on success stays up.

   That is an architecture property, not a layout defect. This scan finds every
   admin surface with the same property BEFORE a batch is spent discovering it
   one page at a time.

   IT CLASSIFIES ONLY — it changes nothing. Finding a named Firebase app does NOT
   mean the page should be rewritten to use the shared guard. There may be good
   reasons for an isolated instance. The correct outcome per page is one of:
     - retain it, mark the page BLOCKED pending real-session verification
     - adapt the harness to support that legitimate auth architecture
     - consolidate ONLY if the duplicate instance is genuinely accidental
   Never change authentication architecture to make a responsive harness pass.

   CONTROL: verification-admin.html is a known positive. If it does not classify
   as BLOCKED, the detector is broken and the whole run is untrustworthy.

   Usage: node scripts/scan-admin-auth-architecture.js [--json out.json] [--all]
   Exit:  1 only if the control fails.
   ========================================================================= */
'use strict';
const fs   = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const OUT  = (() => { const i = argv.indexOf('--json'); return i >= 0 ? argv[i + 1] : null; })();
const ALL  = argv.includes('--all');

global.window = {}; global.location = { pathname: '/admin-os.html' };
require(path.join(ROOT, 'sokoni-admin-nav.js'));
const NAV = global.window.SokoniAdminNav;

const WIRED = (f) => /sokoni-admin-guard\.js/.test(fs.readFileSync(path.join(ROOT, f), 'utf8'));

/* Strip comments so a pattern described in prose is not counted as code. */
function code(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const PATTERNS = {
  /* initializeApp(cfg, "name") — the second argument is what creates a SEPARATE app */
  namedApp: [
    /initializeApp\s*\([^;)]*?,\s*["'][^"']+["']\s*\)/,
    /getApps\s*\(\)\s*\.\s*find\s*\(/,
  ],
  /* an Auth bound to something other than the default app */
  separateAuth: [
    /getAuth\s*\(\s*[A-Za-z_$][\w$]*\s*\)/,        // getAuth(app)
    /\.auth\s*\(\s*[A-Za-z_$][\w$]*\s*\)/,
  ],
  /* a Firestore bound to a named app */
  separateDb: [
    /getFirestore\s*\(\s*[A-Za-z_$][\w$]*\s*\)/,
    /\.firestore\s*\(\s*[A-Za-z_$][\w$]*\s*\)/,
  ],
  /* the page runs its own authorization decision */
  ownGate: [
    /onAuthStateChanged\s*\(/,
    /getIdTokenResult\s*\(/,
  ],
  /* a blocking overlay the page hides on ITS OWN success path */
  ownOverlay: [
    /id\s*=\s*["'][\w-]*(auth|gate|lock|verify)[\w-]*["']/i,
  ],
};

const hit = (src, list) => list.some((re) => re.test(src));

const pages = NAV.pages.map(p => p.page);
const rows = [];

for (const page of pages) {
  let raw = '';
  try { raw = fs.readFileSync(path.join(ROOT, page), 'utf8'); } catch (e) { continue; }
  const src = code(raw);

  const namedApp     = hit(src, PATTERNS.namedApp);
  const separateAuth = hit(src, PATTERNS.separateAuth);
  const separateDb   = hit(src, PATTERNS.separateDb);
  const ownGate      = hit(src, PATTERNS.ownGate);
  const wired        = WIRED(page);
  const consultsGuard = /SokoniAdminGuard/.test(src);

  /* Overlay ids the page owns, excluding the shell's own and known second factors. */
  const overlayIds = [...new Set((src.match(/id\s*=\s*["']([\w-]*(?:auth|gate|lock|verify)[\w-]*)["']/gi) || [])
    .map(m => (m.match(/["']([^"']+)["']/) || [, ''])[1])
    .filter(id => id && !/^sk-adm-/.test(id) && id !== 'sokoniAdminGuard'))];

  /* Does the page load Firebase as an ES MODULE it imports itself? That is what
     puts an auth instance beyond the harness's reach — replacing window.firebase
     does not touch a module-scoped `getAuth(app)`.

     A named app built on the COMPAT shim (firebase.initializeApp(cfg, 'name'))
     still goes through window.firebase, so the stub DOES influence it. That
     distinction is why security-center was a false positive on the first pass:
     it creates a named app but on the compat shim, and it has no default-visible
     blocking overlay, so it certified 6/7 rather than blocking. */
  const modularImport = /import\s*\(\s*["'`]https:\/\/www\.gstatic\.com\/firebasejs\/[^"'`]*firebase-app\.js/.test(src)
                     || /from\s*["']https:\/\/www\.gstatic\.com\/firebasejs\/[^"']*firebase-app\.js["']/.test(src);

  /* A blocking overlay must be VISIBLE BY DEFAULT for the page to be stuck: one
     the page hides on its own success path. An overlay that starts hidden cannot
     block anything. Approximated by looking for an explicit "hide it" statement
     against the same id — the page owns showing AND hiding it. */
  const selfDismissedOverlay = overlayIds.filter(id => {
    const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('getElementById\\(\\s*["\']' + esc + '["\']\\s*\\)\\s*\\.\\s*style\\s*\\.\\s*display\\s*=', 'i').test(src)
        || new RegExp('#' + esc + '[^{]*\\{[^}]*display\\s*:\\s*(flex|block|grid)', 'i').test(src);
  });

  /* Prediction.
     BLOCKED  = gate on an auth instance the harness CANNOT reach (module import),
                AND a page-owned overlay that only that instance dismisses.
     AT-RISK  = a separate instance exists but one of those conditions is unproven.
     OK       = the harness stub reaches this page's auth. */
  let predicted, why;
  if (modularImport && separateAuth && ownGate && selfDismissedOverlay.length) {
    predicted = 'BLOCKED';
    why = 'module-imported Firebase + own auth + own gate + self-dismissed overlay #' + selfDismissedOverlay[0];
  } else if (modularImport && separateAuth && ownGate) {
    predicted = 'AT-RISK'; why = 'module-imported auth + own gate, no self-dismissed overlay found';
  } else if (namedApp && separateAuth) {
    predicted = 'AT-RISK'; why = 'named app on the compat shim — stub still applies, but verify';
  } else if (namedApp || separateAuth) {
    predicted = 'AT-RISK'; why = 'separate instance present, gate not confirmed on it';
  } else {
    predicted = 'OK'; why = 'default app — harness stub applies';
  }

  rows.push({ page, namedApp, modularImport, separateAuth, separateDb, ownGate, wired,
              consultsGuard, overlayIds: overlayIds.slice(0, 3), predicted, why });
}

/* ── VALIDATION against every page whose real outcome is known ─────────────
   One control proves the detector fires. It does NOT prove the detector is
   right. These 24 pages have been certified, so the prediction can be scored
   against what actually happened — the first version claimed security-center
   would BLOCK when it had already certified 6/7. */
const KNOWN = {
  /* Batch 1 */
  'admin-os.html': 'OK', 'enterprise-ops.html': 'OK', 'ops-center.html': 'OK',
  'ops-dashboard.html': 'OK', 'admin-feedback.html': 'OK', 'beta-control.html': 'OK',
  'beta-dashboard.html': 'OK', 'reliability-center.html': 'OK', 'merchant-pipeline.html': 'OK',
  /* Batch 2 — Finance */
  'financial-os.html': 'OK', 'finos-admin.html': 'OK', 'fos-admin.html': 'OK',
  'revenue.html': 'OK', 'revenue-dashboard.html': 'OK', 'commission-admin.html': 'OK',
  'commission-engine.html': 'OK', 'settlement-dashboard.html': 'OK', 'sfos-monitor.html': 'OK',
  'etims-admin.html': 'OK',
  /* Batch 3 — Trust & Safety */
  'trust-safety.html': 'OK', 'moderation.html': 'OK', 'security-center.html': 'OK',
  'security-zero-trust-dashboard.html': 'OK',
  'verification-admin.html': 'BLOCKED',
};
const scored = rows.filter(r => KNOWN[r.page]).map(r => ({
  page: r.page, actual: KNOWN[r.page], predicted: r.predicted,
  /* AT-RISK is an "inspect me" bucket, not a claim — it is not counted wrong
     against an OK outcome, but a BLOCKED prediction on an OK page IS wrong. */
  wrong: (r.predicted === 'BLOCKED' && KNOWN[r.page] !== 'BLOCKED') ||
         (r.predicted !== 'BLOCKED' && KNOWN[r.page] === 'BLOCKED'),
}));
const wrong = scored.filter(s => s.wrong);

/* ── CONTROL ─────────────────────────────────────────────────────────────── */
const control = rows.find(r => r.page === 'verification-admin.html');
const controlOk = control && control.predicted === 'BLOCKED';
console.log('CONTROL — verification-admin.html predicted: ' +
            (control ? control.predicted : '(not found)') +
            (controlOk ? '  ✓ detector works' : '  ✗ DETECTOR BROKEN'));
if (!controlOk) {
  console.log('\nThe known-positive control did not classify as BLOCKED. Every other row in this');
  console.log('run is untrustworthy. Fix the detector before using these results.');
  process.exit(1);
}

console.log('VALIDATION — scored against ' + scored.length + ' pages with KNOWN certified outcomes: ' +
            (scored.length - wrong.length) + '/' + scored.length + ' correct');
if (wrong.length) {
  console.log('  MISPREDICTED:');
  wrong.forEach(w => console.log('    ' + w.page.padEnd(36) + 'predicted ' + w.predicted + ', actual ' + w.actual));
  console.log('  Predictions for UNCERTIFIED pages are only as good as this score — weigh accordingly.');
}

const show = ALL ? rows : rows.filter(r => !r.wired || r.predicted !== 'OK');
const byPred = {};
rows.forEach(r => { byPred[r.predicted] = (byPred[r.predicted] || 0) + 1; });

console.log('\n=== ALL ' + rows.length + ' REGISTRY SURFACES ===');
Object.entries(byPred).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log('  ' + k.padEnd(9) + v));

console.log('\n=== CLASSIFICATION (' + show.length + ' shown' + (ALL ? '' : '; --all for every page') + ') ===');
console.log('PAGE'.padEnd(36), 'APP'.padEnd(5), 'AUTH'.padEnd(6), 'DB'.padEnd(4), 'GATE'.padEnd(6), 'WIRED'.padEnd(7), 'PREDICTED');
console.log('-'.repeat(96));
const order = { BLOCKED: 0, 'AT-RISK': 1, OK: 2 };
show.sort((a, b) => (order[a.predicted] - order[b.predicted]) || a.page.localeCompare(b.page))
  .forEach(r => console.log(
    r.page.padEnd(36),
    (r.namedApp ? 'yes' : '-').padEnd(5),
    (r.separateAuth ? 'yes' : '-').padEnd(6),
    (r.separateDb ? 'yes' : '-').padEnd(4),
    (r.ownGate ? 'yes' : '-').padEnd(6),
    (r.wired ? 'yes' : '-').padEnd(7),
    r.predicted));

const blocked = rows.filter(r => r.predicted === 'BLOCKED');
const atRisk  = rows.filter(r => r.predicted === 'AT-RISK');

if (blocked.length) {
  console.log('\n=== PREDICTED BLOCKED — need a real authenticated session ===');
  blocked.forEach(r => console.log('  ' + r.page.padEnd(36) + r.why +
    (r.overlayIds.length ? '  [overlay: #' + r.overlayIds.join(', #') + ']' : '')));
}
if (atRisk.length) {
  console.log('\n=== AT-RISK — inspect before wiring ===');
  atRisk.forEach(r => console.log('  ' + r.page.padEnd(36) + r.why));
}

console.log('\nCLASSIFICATION ONLY — nothing was changed. Do NOT rewrite a page\'s auth');
console.log('architecture to satisfy the harness; decide per page why the instance exists.');

if (OUT) { fs.writeFileSync(OUT, JSON.stringify(rows, null, 2)); console.log('\nwrote ' + OUT); }
