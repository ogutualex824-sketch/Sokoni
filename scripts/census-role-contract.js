/* CENSUS — the platform-wide role contract.
   ==========================================================================
   Run:  node scripts/census-role-contract.js
         node scripts/census-role-contract.js --json > docs/role-contract-matrix.json
         node scripts/census-role-contract.js --page cart.html

   READ-ONLY. No page is changed. This exists so the size of the problem is known
   before anything is touched — the Driver/Buyer symptom was one page, and patching
   outward from a symptom is how 150 files get edited on a hunch.

   WHAT IT ASKS OF EVERY PAGE
     route          the file
     auth           does it require authentication at all
     guard          does it gate, and through which mechanism
     role source    does it read the AUTHORITY or a MIRROR
     workspace      which workspace its role literals imply
     verdict        one of the classes below

   THE CLASSES
     PASS             asks the authority, or is legitimately public
     UNGUARDED        makes a role decision with no gate behind it
     MIRROR-AUTHORITY decides from users.role / users.roles / localStorage /
                      registeredAs / detail.role / token.role
     DUPLICATE-AUTH   asks the authority AND a mirror — two answers available
     LEGACY-VOCAB     uses `driver` as a workspace name (canonical is `rider`)
     PUBLIC           no role vocabulary at all
     UNKNOWN          cannot be determined statically

   UNKNOWN IS A REAL ANSWER and is never folded into a worse-sounding class. This
   release has already produced two false findings from treating an absence as a
   defect — a 404 body read as "markers removed", and a VOID harness that reported
   every role denied from profile.html. A page nobody can classify is a page nobody
   should edit.

   WHAT IT CANNOT SEE
   Runtime. A page can read a mirror for DISPLAY and still gate correctly, and this
   scanner cannot always tell display from decision. So MIRROR-AUTHORITY means "reads
   a mirror in a role-shaped expression", not "is exploitable". Every finding needs
   the same before-proof discipline as the rest of this release.

   CONTROLS
   * Must FIND a page known to read a mirror.
   * Must NOT flag a page that only asks the authority.
   * Comments are not code.
   * The scanner must not classify itself.
   ==========================================================================*/
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const JSON_OUT = process.argv.includes('--json');
/* indexOf returns -1 when the flag is absent, and argv[-1 + 1] is argv[0] — the node
   binary — so the census ran as "--page C:\Program Files\nodejs\node.exe". Guard the
   lookup instead of trusting the offset. */
const _pi = process.argv.indexOf('--page');
const ONE = (process.argv.find((a) => a.startsWith('--page=')) || '').split('=')[1]
         || (_pi >= 0 ? (process.argv[_pi + 1] || '') : '');
const SELF = path.relative(ROOT, __filename).replace(/\\/g, '/');
const SKIP = /(^|[\\/])(node_modules|\.git|docs|scripts|tests|functions)([\\/]|$)/;

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  if (!JSON_OUT) console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

const strip = (s) => s
  .replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length))
  .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
  .replace(/^[ \t]*\/\/.*$/gm, (m) => ' '.repeat(m.length));

function pages() {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const rel = path.relative(ROOT, path.join(d, e.name)).replace(/\\/g, '/');
      if (SKIP.test(rel) || rel === SELF) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (/\.html$/.test(e.name)) out.push(p);
    }
  }(ROOT));
  return out.sort();
}

/* ── the vocabulary ───────────────────────────────────────────────────────── */
const CANON = ['buyer', 'seller', 'rider', 'provider', 'mechanic', 'health',
               'legal', 'landlord', 'tenant'];

/* Reading the AUTHORITY. */
const AUTHORITY = [
  /SokoniRoleAuthority\s*\.\s*(getActiveRole|isApproved|getApprovedRoles|guardWorkspace|guardPage|canAccessRoute)/,
  /SokoniPermissions\s*\.\s*(hasRole|hasAnyRole|requireAdminContext|guardCurrentPage|can)\s*\(/,
  /* SokoniAdminEntry.guard() delegates straight to requireAdminContext(), so it is
     an authority call and not merely a gate. Omitting it classified admin-os.html
     as MIRROR-AUTHORITY when its administrative decision is fully canonical. */
  /SokoniAdminEntry\s*\.\s*guard\s*\(/,
];

/* Reading a MIRROR *in a role-shaped expression*. A bare `u.role` assignment is not
   necessarily a decision, so each pattern requires a comparison, a membership test,
   or a branch — which is what makes it decision-shaped rather than display-shaped. */
const MIRRORS = [
  { name: 'users.role',       re: /\b(?:u|user|data|d|profile|snap|userData)\s*\.\s*role\s*(?:===?|!==?|\?|\|\||&&)/ },
  { name: 'users.roles[]',    re: /\b(?:u|user|data|d|profile|snap|userData)\s*\.\s*roles\s*\.\s*(?:includes|indexOf)\s*\(/ },
  { name: 'localStorage.role',re: /getItem\s*\(\s*["'`](?:userRole|role|sokoniRole)["'`]\s*\)/ },
  { name: 'registeredAs',     re: /registeredAs\s*(?:\.\s*\w+\s*(?:===?|&&|\|\||\?)|\[)/ },
  { name: 'detail.role',      re: /\bdetail\s*\.\s*role\s*(?:===?|!==?|\?|\|\||&&)/ },
  { name: 'token.role',       re: /\btoken\s*\.\s*role\s*(?:===?|!==?)/ },
  { name: 'isSeller/isProvider flag',
                              re: /\b(?:isSeller|isProvider|isDriver|isRider)\s*(?:===?\s*true|&&|\?)/ },
];

/* Gating mechanisms, in the order a reader would trust them. */
const GUARDS = [
  { name: 'authority.guardPage/guardWorkspace', re: /guard(?:Page|Workspace)\s*\(/ },
  { name: 'SokoniPermissions.guardCurrentPage', re: /guardCurrentPage\s*\(/ },
  { name: 'SokoniAdminEntry.guard',             re: /SokoniAdminEntry\s*\.\s*guard\s*\(/ },
  { name: 'requireAuth(role)',                  re: /requireAuth\s*\(\s*["'`]\w+["'`]/ },
  { name: 'data-require-auth',                  re: /data-require-auth\s*=\s*["']true["']/ },
  { name: 'requireAuth()',                      re: /requireAuth\s*\(\s*\)/ },
  { name: 'inline claim check',                 re: /getIdTokenResult\s*\(/ },
];

/* ── which local scripts is a page's guard allowed to live in? ────────────────
   admin-os.html classified PUBLIC because its guard is in sokoni-aos.js and this
   scanner read only the HTML — the same file-scoped mistake that once reported
   admin.html as having no role switcher.

   But following EVERY linked script is the opposite error: shared-header.js,
   sokoni-permissions.js and sokoni-role-authority.js are loaded by hundreds of
   pages and contain authority calls, so following them would mark the whole estate
   PASS. Those are the authority MODULES, not any page's gate.

   Self-calibrating rule: follow a local script only when few pages load it, i.e.
   when it is page-specific rather than platform-wide. The threshold is measured
   from the tree, not asserted. */
const _scriptUse = new Map();
function _localScripts(src) {
  const out = [];
  const re = /<script[^>]+src=["']([^"':]+?)["']/g;
  let m;
  while ((m = re.exec(src))) {
    const rel = m[1].replace(/^\.?\//, '').split('?')[0];
    if (/^https?:/.test(rel)) continue;
    out.push(rel);
  }
  return out;
}
for (const p of pages()) {
  let s = ''; try { s = fs.readFileSync(p, 'utf8'); } catch (_) { continue; }
  for (const rel of _localScripts(s)) {
    _scriptUse.set(rel, (_scriptUse.get(rel) || 0) + 1);
  }
}
const PAGE_SPECIFIC_MAX = 3;

function classify(file) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  let raw = ''; try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
  let src = strip(raw);

  /* Append the page's OWN scripts — those few pages load — so a guard that lives
     beside the page is seen, while the shared authority modules are not counted as
     if every page had implemented a gate. */
  const followed = [];
  for (const s of _localScripts(strip(raw))) {
    if ((_scriptUse.get(s) || 0) > PAGE_SPECIFIC_MAX) continue;
    try {
      src += '\n' + strip(fs.readFileSync(path.join(ROOT, s), 'utf8'));
      followed.push(s);
    } catch (_) { /* not a local file */ }
  }

  const authority = AUTHORITY.filter((re) => re.test(src)).length > 0;
  const mirrors = MIRRORS.filter((m) => m.re.test(src)).map((m) => m.name);
  const guards = GUARDS.filter((g) => g.re.test(src)).map((g) => g.name);

  /* Which workspace do its role literals imply? Reported, never enforced. */
  const mentions = CANON.filter((r) => new RegExp('["\'`]' + r + '["\'`]').test(src));
  const legacyDriver = /["'`]driver["'`]/.test(src);

  /* Does it use role vocabulary at all? */
  const roleShaped = authority || mirrors.length > 0 || guards.length > 0 || mentions.length > 0;

  let verdict;
  if (!roleShaped) verdict = 'PUBLIC';
  else if (authority && mirrors.length) verdict = 'DUPLICATE-AUTH';
  else if (mirrors.length && !authority) verdict = 'MIRROR-AUTHORITY';
  else if (authority) verdict = 'PASS';
  else if (mentions.length && !guards.length) verdict = 'UNGUARDED';
  else if (guards.length) verdict = 'PASS';
  else verdict = 'UNKNOWN';

  return {
    route: rel,
    auth: guards.length > 0,
    guards,
    authority,
    mirrors,
    workspaceHints: mentions,
    legacyDriverVocab: legacyDriver && !mentions.includes('rider'),
    followedScripts: followed,
    verdict,
  };
}

const all = pages().map(classify).filter(Boolean);

if (ONE) {
  const row = all.find((r) => r.route === ONE || r.route.endsWith('/' + ONE));
  console.log('\n  ' + (row ? JSON.stringify(row, null, 2) : 'no such page: ' + ONE) + '\n');
  process.exit(row ? 0 : 1);
}

/* ── controls ─────────────────────────────────────────────────────────────── */
if (!JSON_OUT) console.log('\n  ROLE CONTRACT MATRIX\n\n  ── controls');
const knownMirror = all.find((r) => /business-analytics\.html$/.test(r.route));
ck('finds a page known to read a mirror (business-analytics.html)',
  !!knownMirror && knownMirror.mirrors.length > 0,
  knownMirror ? knownMirror.mirrors.join(', ') || 'none found' : 'page missing');
const knownAuthority = all.find((r) => /admin-os\.html$|super-admin\.html$/.test(r.route));
/* The control is about whether the own-script guard was SEEN, not about which of
   the two authority-bearing verdicts it lands on. DUPLICATE-AUTH is the correct
   answer for a page that asks the authority AND also reads a mirror. */
ck('a page whose guard lives in its OWN script is seen (admin-os.html)',
  !!knownAuthority && knownAuthority.authority === true
  && knownAuthority.verdict !== 'PUBLIC' && knownAuthority.verdict !== 'UNGUARDED',
  knownAuthority ? knownAuthority.route + ' -> ' + knownAuthority.verdict
    + ' via ' + (knownAuthority.followedScripts||[]).join(',') : 'n/a');
ck('comments are not code',
  !MIRRORS[0].re.test(strip('/* if (u.role === "seller") */')), '');
ck('the scanner does not classify itself', !all.some((r) => r.route === SELF), '');

if (JSON_OUT) {
  console.log(JSON.stringify({ generated: 'census-role-contract', total: all.length,
    tally: all.reduce((a, r) => { a[r.verdict] = (a[r.verdict] || 0) + 1; return a; }, {}),
    rows: all }, null, 2));
  process.exit(fail ? 1 : 0);
}

/* ── the matrix ───────────────────────────────────────────────────────────── */
const tally = all.reduce((a, r) => { a[r.verdict] = (a[r.verdict] || 0) + 1; return a; }, {});
console.log('\n  ── ' + all.length + ' HTML pages');
for (const k of ['PASS', 'PUBLIC', 'MIRROR-AUTHORITY', 'DUPLICATE-AUTH', 'UNGUARDED', 'UNKNOWN']) {
  console.log('  ' + k.padEnd(20) + (tally[k] || 0));
}

const mirrorPages = all.filter((r) => r.verdict === 'MIRROR-AUTHORITY');
console.log('\n  ── MIRROR-AUTHORITY: decides from a mirror, never asks the authority  ('
  + mirrorPages.length + ')');
for (const r of mirrorPages.slice(0, 18)) {
  console.log('  ' + r.route.padEnd(34) + r.mirrors.join(', '));
}
if (mirrorPages.length > 18) console.log('  … and ' + (mirrorPages.length - 18) + ' more');

const dual = all.filter((r) => r.verdict === 'DUPLICATE-AUTH');
console.log('\n  ── DUPLICATE-AUTH: asks the authority AND a mirror  (' + dual.length + ')');
for (const r of dual.slice(0, 12)) {
  console.log('  ' + r.route.padEnd(34) + r.mirrors.join(', '));
}
if (dual.length > 12) console.log('  … and ' + (dual.length - 12) + ' more');

const legacy = all.filter((r) => r.legacyDriverVocab);
console.log('\n  ── legacy `driver` used as a workspace name, without `rider`  ('
  + legacy.length + ')');
console.log('  ' + legacy.slice(0, 10).map((r) => r.route).join('  '));
if (legacy.length > 10) console.log('  … and ' + (legacy.length - 10) + ' more');

const unguarded = all.filter((r) => r.verdict === 'UNGUARDED');
console.log('\n  ── UNGUARDED: role vocabulary, no gate  (' + unguarded.length + ')');
console.log('  ' + unguarded.slice(0, 10).map((r) => r.route).join('  '));
if (unguarded.length > 10) console.log('  … and ' + (unguarded.length - 10) + ' more');

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
console.log('\n  STATIC ONLY. MIRROR-AUTHORITY means "reads a mirror in a role-shaped');
console.log('  expression", NOT "is exploitable" — a page may read one for display and');
console.log('  still gate correctly. Each row needs its own before-proof, exactly as the');
console.log('  rest of this release did. UNKNOWN stays UNKNOWN.\n');
process.exit(fail ? 1 : 0);
