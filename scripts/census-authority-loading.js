/* CENSUS — which pages render a role switcher WITHOUT loading the authority.
   ==========================================================================
   Run:  node scripts/census-authority-loading.js
         node scripts/census-authority-loading.js --json > docs/authority-loading.json

   READ-ONLY.

   MEASURED ON PRODUCTION /cart:
     SokoniRoleAuthority   undefined
     SokoniPermissions     undefined
     ls_activeRole         "buyer"
     dropdownMarked        "Buyer"

   The switcher was not wrong — it fell back to the localStorage mirror exactly as
   designed, because the authority modules were never loaded on that page. Every
   role-state fix in this release assumed the authority is present; where it is not,
   the mirror silently becomes the authority again.

   shared-header.js injects the role switcher on any page that is not in EXCLUDED and
   does not set data-no-header. So the question is: which of those pages load
   sokoni-role-authority.js and sokoni-permissions.js, and which do not.

   CLASSES
     FULL        header + role-authority + permissions
     NO-PERMS    header + role-authority, no permissions   (no admin entries)
     MIRROR-ONLY header, NEITHER module                    <- /cart is here
     NO-HEADER   excluded or data-no-header                (own controls)

   MIRROR-ONLY is the defect class: a switcher is rendered, and nothing canonical
   can answer it.

   CONTROLS
   * /cart must land in MIRROR-ONLY, or the census disagrees with the live browser.
   * A page known to load both must land in FULL.
   * The scanner must not classify itself.
   ==========================================================================*/
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const JSON_OUT = process.argv.includes('--json');
let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  if (!JSON_OUT) console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

/* shared-header's own exclusion list, kept in step with the file it mirrors. */
const EXCLUDED = ['pos', 'seller', 'login', 'signup', 'register', 'success', 'offline',
  'profile', 'ecc', 'wap', 'gip', 'platform', 'sasos-admin', 'pos-kiosk', 'superadmin',
  'monitor', 'moderation', 'verification-admin'];

function pages() {
  return fs.readdirSync(ROOT)
    .filter((f) => /\.html$/.test(f))
    .sort();
}

const rows = [];
for (const f of pages()) {
  let s = ''; try { s = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { continue; }
  const header = /shared-header\.js/.test(s);
  if (!header) continue;                       /* no header, no injected switcher */

  const key = f.replace(/\.html$/, '');
  const noHeader = /data-no-header\s*=\s*["']true["']/.test(s) || EXCLUDED.includes(key);
  const ra = /sokoni-role-authority\.js/.test(s);
  const perms = /sokoni-permissions\.js/.test(s);

  let cls;
  if (noHeader) cls = 'NO-HEADER';
  else if (ra && perms) cls = 'FULL';
  else if (ra) cls = 'NO-PERMS';
  else cls = 'MIRROR-ONLY';

  rows.push({ page: f, header, noHeader, roleAuthority: ra, permissions: perms, verdict: cls });
}

const by = (v) => rows.filter((r) => r.verdict === v);

if (!JSON_OUT) console.log('\n  AUTHORITY LOADING CENSUS\n\n  ── controls');
const cart = rows.find((r) => r.page === 'cart.html');
ck('/cart is MIRROR-ONLY, matching the live browser reading',
  !!cart && cart.verdict === 'MIRROR-ONLY',
  cart ? cart.verdict : 'cart.html not found or has no header');
/* Since the bootstrap landed, MIRROR-ONLY describes the static TAGS, not the
   runtime: shared-header injects the modules itself. Assert that, or this census
   would keep reporting 175 defects that no longer exist at runtime. */
const hdr = fs.readFileSync(path.join(ROOT, 'shared-header.js'), 'utf8');
ck('shared-header self-bootstraps the authority for MIRROR-ONLY pages',
  /_ensureRoleAuthority/.test(hdr) && /sokoni-role-authority.js/.test(hdr),
  'so MIRROR-ONLY is a TAG classification, not a runtime one');
const full = by('FULL')[0];
ck('at least one page loads BOTH modules', !!full, full ? full.page : 'none');
ck('the scanner does not classify itself', !rows.some((r) => /census/.test(r.page)), '');

if (JSON_OUT) {
  console.log(JSON.stringify({ generated: 'census-authority-loading', total: rows.length,
    tally: rows.reduce((a, r) => { a[r.verdict] = (a[r.verdict] || 0) + 1; return a; }, {}),
    rows }, null, 2));
  process.exit(fail ? 1 : 0);
}

console.log('\n  ── ' + rows.length + ' pages load shared-header.js');
for (const k of ['FULL', 'NO-PERMS', 'MIRROR-ONLY', 'NO-HEADER']) {
  console.log('  ' + k.padEnd(14) + by(k).length);
}

const mirror = by('MIRROR-ONLY');
console.log('\n  ── MIRROR-ONLY: a switcher is rendered and NOTHING canonical can answer it  ('
  + mirror.length + ')');
for (const r of mirror.slice(0, 30)) console.log('    ' + r.page);
if (mirror.length > 30) console.log('    … and ' + (mirror.length - 30) + ' more');

const noPerms = by('NO-PERMS');
console.log('\n  ── NO-PERMS: workspace roles resolve, but no Admin/Super Admin entry can render  ('
  + noPerms.length + ')');
for (const r of noPerms.slice(0, 20)) console.log('    ' + r.page);
if (noPerms.length > 20) console.log('    … and ' + (noPerms.length - 20) + ' more');

console.log('\n  ── FULL  (' + by('FULL').length + ')');
console.log('    ' + by('FULL').map((r) => r.page).join('  ').slice(0, 400));

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
console.log('\n  Static. It says which pages CAN answer a role question, not what any of them');
console.log('  currently displays. MIRROR-ONLY is where every role fix in this release');
console.log('  silently degrades to the localStorage mirror it was meant to replace.\n');
process.exit(fail ? 1 : 0);
