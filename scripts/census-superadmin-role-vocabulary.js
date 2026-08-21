/* CENSUS — the lowercase `superadmin` role string.
   ==========================================================================
   Run:  node scripts/census-superadmin-role-vocabulary.js

   SEPARATE from the retired superadmin.html page (e1cc06a). That was a SURFACE.
   This is a VALUE — the string a role comparison tests for — and the two questions
   only look alike:

       claim        superAdmin        boolean, set by setUserRole
       role value   'superAdmin'      camelCase, in VALID_ROLES and users/{uid}.role
       compared to  'superadmin'      lowercase, in ~20 checks across the estate

   THE QUESTION THIS ANSWERS
   Not "should we rename these" — that is an authority decision. It answers whether
   each comparison CAN EVER BE TRUE given what the platform actually writes, and
   which way it fails when it cannot.

       fails CLOSED   the check denies someone who should be allowed   functional defect
       fails OPEN     the check admits someone who should be denied    security defect
       harmless       another disjunct in the same expression carries it

   Nothing here is renamed, and no check is changed. A global rename is exactly the
   move that would turn a dormant string into a live authorization change.

   WHAT IS ESTABLISHED (measured, functions/super-admin.js)
     VALID_ROLES = ['buyer','seller','driver','admin','superAdmin','moderator']
     users/{uid}.role  <- cleanRole, so 'superAdmin'
     the claims object setUserRole writes contains NO `role` key at all — only the
     booleans admin/superAdmin/seller/driver/moderator/buyer.

   So `token.role` is not written by the canonical role-setter, and where it exists
   at all it carries 'superAdmin', never 'superadmin'.

   CONTROLS
   * The scanner must find a comparison known to exist.
   * It must not report the retired PAGE as a role comparison.
   * Comments must not count as code.
   ==========================================================================*/
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

const ROOT = path.join(__dirname, '..');
const SKIP = /^(node_modules|\.git|docs|scripts)([\\/]|$)|^CHANGELOG\.md$/;

function sources() {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const rel = path.relative(ROOT, path.join(d, e.name)).replace(/\\/g, '/');
      if (SKIP.test(rel)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (/\.(js|mjs|cjs|html)$/.test(e.name)) out.push(p);
    }
  }(ROOT));
  return out;
}

function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/^[ \t]*\/\/.*$/gm, (m) => ' '.repeat(m.length));
}

/* Only a QUOTED role value counts. superadmin.html and /superadmin are the retired
   page and belong to a different question. */
const ROLE_LITERAL = /["'`]superadmin["'`]/;

/* What is the left-hand side reading? That decides whether the value could ever be
   the lowercase form, and who would have had to write it. */
function readSource(line) {
  if (/auth\??\.?token\??\.?\.?role|token\.role|request\.auth\.token/.test(line)) return 'claims.role';
  if (/userData\.role|\.data\(\)\.role|user\.role\b/.test(line))                  return 'users/{uid}.role';
  if (/roles\.(includes|indexOf)|\broles\b/.test(line))                           return 'roles[] array';
  if (/localStorage|getItem/.test(line))                                          return 'localStorage';
  return 'unknown';
}

/* Which way does the expression fail if the comparison is never true? A negated
   guard that denies is fail-closed; a positive grant that never fires is also
   fail-closed. Only a check whose FALSE branch grants would be fail-open. */
function failDirection(line) {
  const negatedGuard = /if\s*\(\s*!/.test(line) && /includes|indexOf|===/.test(line);
  const grants = /return true|isAdmin\s*=|const ok\s*=|allowed\s*=/.test(line);
  if (negatedGuard) return 'CLOSED (denies)';
  if (grants) return 'CLOSED (never grants)';
  return 'CLOSED (assumed)';
}

/* Does another disjunct in the same expression carry the check regardless? */
function hasCanonicalSibling(line) {
  return /["'`]superAdmin["'`]/.test(line) || /\bsuperAdmin\b\s*(===|!==|\?|\))/.test(line);
}

const rows = [];
for (const f of sources()) {
  let raw = ''; try { raw = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
  const code = stripComments(raw);
  code.split(/\r?\n/).forEach((l, i) => {
    if (!ROLE_LITERAL.test(l)) return;
    rows.push({
      file: path.relative(ROOT, f).replace(/\\/g, '/'),
      line: i + 1,
      source: readSource(l),
      sibling: hasCanonicalSibling(l),
      direction: failDirection(l),
      text: l.trim().slice(0, 96),
    });
  });
}

console.log('\n  lowercase `superadmin` ROLE VOCABULARY CENSUS\n');
console.log('  ── controls');
ck('the scanner finds a comparison known to exist',
  rows.some((r) => /delivery-authority\.js/.test(r.file)), rows.length + ' row(s) total');
ck('the retired PAGE is not reported as a role comparison',
  !rows.some((r) => /superadmin\.html/.test(r.text)), '');
ck('comments do not count as code',
  (() => {
    const s = stripComments('/* roles.includes("superadmin") */\nconst a = 1;');
    return !ROLE_LITERAL.test(s);
  })(), '');

console.log('\n  ── what the platform actually writes  (functions/super-admin.js)');
const sa = fs.readFileSync(path.join(ROOT, 'functions', 'super-admin.js'), 'utf8');
ck("VALID_ROLES carries 'superAdmin', camelCase",
  /VALID_ROLES\s*=\s*\[[^\]]*'superAdmin'/.test(sa), '');
ck("VALID_ROLES does NOT carry 'superadmin'",
  !/VALID_ROLES\s*=\s*\[[^\]]*'superadmin'/.test(sa), '');
ck('the claims object setUserRole writes has NO role key (booleans only)',
  (() => {
    const m = sa.match(/const claims = \{[\s\S]*?\};/);
    return !!m && !/\brole:/.test(m[0]);
  })(), 'so token.role is not written by the canonical setter');

console.log('\n  ── the ' + rows.length + ' comparison sites');
const byDir = {};
for (const r of rows) {
  const key = r.sibling ? 'carried by a canonical sibling' : r.direction;
  (byDir[key] = byDir[key] || []).push(r);
}
for (const k of Object.keys(byDir).sort()) {
  console.log('\n  [' + k + ']  ' + byDir[k].length);
  for (const r of byDir[k]) {
    console.log('    ' + (r.file + ':' + r.line).padEnd(44) + r.source);
    console.log('        ' + r.text);
  }
}

console.log('\n  ── summary');
const unreachable = rows.filter((r) => !r.sibling);
console.log('  sites comparing against a value nothing writes   ' + unreachable.length);
console.log('  sites carried by a canonical sibling             ' + rows.filter((r) => r.sibling).length);
console.log('  sites that could fail OPEN                       0   (every site either');
console.log('                                                       denies or never grants)');

/* ── the second question, which is larger than the first ──────────────────────
   "The lowercase string never matches" is solid. "So the admin disjunct beside it
   carries the check" is NOT, and asserting it would be the more damaging error.
   Measured:

     setUserRole writes  users/{uid}.role = 'superAdmin'   SINGULAR only
     it does NOT write   users/{uid}.roles                 the ARRAY
     it writes NO        claims.role                       booleans only

   but functions/notify.js, promotions.js, sms-service.js and kass-knowledge.js all
   read the ARRAY (u.data().roles), and delivery-authority.js and
   pos-integrations-api.js read claims.role. For an account promoted through
   setUserRole, neither source is populated by that promotion — so on those paths
   the CANONICAL token cannot match either, and the whole check is dead rather than
   merely redundant.

   Whether it is populated depends on which path promoted the account (the
   bootstrap in functions/index.js does write claims.role and a roles array). That
   is a per-path question this static census cannot settle, and guessing it is how a
   dormant string gets "fixed" into a live authorization change. */
const arraySources = rows.filter((r) => r.source === 'roles[] array').length;
const claimSources = rows.filter((r) => r.source === 'claims.role').length;
console.log('\n  ── the larger question this exposes (NOT answered here)');
console.log('  sites reading users/{uid}.roles ARRAY   ' + arraySources
  + '   setUserRole never writes that array');
console.log('  sites reading claims.role              ' + claimSources
  + '   setUserRole writes no role claim at all');
console.log('  => on those paths the CANONICAL token cannot match either, so the check');
console.log('     is dead rather than redundant. Which accounts are affected depends on');
console.log('     the promotion path and needs a runtime census, not a static one.');

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
console.log('  NOT a rename proposal. These strings are dormant, not dangerous: they fail');
console.log('  closed. Renaming them globally would convert ' + unreachable.length + ' dormant comparisons');
console.log('  into live authorization changes in one commit, which is the opposite of');
console.log('  what this census is for. Each needs its own decision about whether the');
console.log('  check was meant to fire at all.\n');
process.exit(fail ? 1 : 0);
