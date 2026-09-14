#!/usr/bin/env node
/* ============================================================================
   Platform section pre-scan — architectural reconnaissance, READ ONLY
   ============================================================================
   Platform is the last and largest section (15 surfaces) and the auth-architecture
   scan flagged it as carrying the highest concentration of unusual authentication.
   This maps it BEFORE anything is wired, so ordinary responsive defects are not
   mixed with legitimate authentication-environment blocks in one giant batch.

   MODIFIES NOTHING. If a critical security defect equivalent to J1 (fail-open) or
   J2 (storage-only authorization) is found, it is REPORTED, not fixed here.

   WHAT WE HAVE LEARNED, ENCODED HERE

   1. The blocking condition is the OVERLAY, not the auth loader. monitor.html
      module-imports Firebase and certified 7/7 because nothing covered the page.
      Module scope is context, never the predictor.
   2. App Check presence does not discriminate. legal-admin and enterprise-ops
      load it and PASS; enterprise-certification and franchise load it and BLOCK.
   3. A destination can look safe and still be wrong for the state that produced
      it — signed-out and insufficient-authority need DIFFERENT destinations.
      Branch semantics are reported alongside destinations.
   4. Static signals predict. Runtime decides. Every prediction here is a
      hypothesis to be overturned by certification.

   Usage: node scripts/prescan-platform.js [--section platform] [--json out.json]
   Exit:  0 always — reconnaissance, not a gate.
   ========================================================================= */
'use strict';
const fs   = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const argv    = process.argv.slice(2);
const arg     = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const SECTION = arg('--section', 'platform');
const OUT     = arg('--json', null);

global.window = {}; global.location = { pathname: '/admin-os.html' };
require(path.join(ROOT, 'sokoni-admin-nav.js'));
const NAV = global.window.SokoniAdminNav;

const pages = NAV.pages.filter(p => p.section === SECTION);

/* Strip comments — prose describing a pattern is not the pattern. */
const code = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function analyse(page) {
  const raw = fs.readFileSync(path.join(ROOT, page), 'utf8');
  const src = code(raw);
  const R = { page };

  /* ── 1. authorization tier actually enforced ─────────────────────────── */
  const tiers = [];
  if (/claims\s*\??\s*[.[]\s*['"]?superAdmin/.test(src) || /token\.superAdmin/.test(src)) tiers.push('superAdmin');
  if (/claims\s*\??\s*[.[]\s*['"]?admin/.test(src)      || /token\.admin/.test(src))      tiers.push('admin');
  if (/claims\s*\??\s*[.[]\s*['"]?moderator/.test(src))                                   tiers.push('moderator');
  const roleNum = /Number\s*\(\s*[\w.]*role\s*\)|parseInt\s*\(\s*[\w.]*role|role\s*>=\s*\d/.test(src);
  R.tierEnforced   = tiers.length ? tiers.join('|') : 'NONE FOUND';
  R.tierRegistry   = (NAV.lookup(page) || {}).authority || '?';
  R.tierMismatch   = R.tierEnforced !== 'NONE FOUND' && !R.tierEnforced.includes(R.tierRegistry);
  R.numericRole    = roleNum;

  /* ── 2. page-owned blocking overlays ─────────────────────────────────── */
  R.overlays = [];
  const idRe = /id\s*=\s*["']([\w-]*(?:auth|gate|lock|overlay|loading|verify|guard|splash)[\w-]*)["']/gi;
  let m;
  const ids = new Set();
  while ((m = idRe.exec(raw))) { if (!/^sk-adm-/.test(m[1]) && m[1] !== 'sokoniAdminGuard') ids.add(m[1]); }
  ids.forEach(id => {
    const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const zM  = raw.match(new RegExp('#' + esc + '\\s*\\{[^}]*z-index\\s*:\\s*(\\d+)', 'i'));
    const disp= raw.match(new RegExp('#' + esc + '\\s*\\{[^}]*display\\s*:\\s*(flex|block|grid)', 'i'));
    const hide= new RegExp('getElementById\\(\\s*["\']' + esc + '["\']\\s*\\)[^;\\n]{0,60}display\\s*=', 'i').test(src);
    const fixed=new RegExp('#' + esc + '\\s*\\{[^}]*position\\s*:\\s*fixed', 'i').test(raw);
    if (zM || disp || hide) {
      R.overlays.push({ sel: '#' + id, z: zM ? +zM[1] : null, fixed,
        defaultVisible: !!disp, dismissedByPage: hide });
    }
  });
  R.blockingOverlay = R.overlays.some(o => o.dismissedByPage && (o.defaultVisible || o.fixed));

  /* ── 3. authentication architecture ──────────────────────────────────── */
  R.moduleFirebase = /import[^;]*from\s*["']https:\/\/www\.gstatic\.com\/firebasejs/.test(src) ||
                     /import\s*\(\s*["'`]https:\/\/www\.gstatic\.com\/firebasejs/.test(src);
  R.namedApp       = /initializeApp\s*\([^;)]*,\s*["'][^"']+["']\s*\)/.test(src);
  R.ownAuth        = /getAuth\s*\(\s*[A-Za-z_$][\w$]*\s*\)/.test(src) || /\.auth\s*\(\s*[A-Za-z_$][\w$]*\s*\)/.test(src);
  R.compatShim     = /firebase\.(initializeApp|auth|firestore)\s*\(/.test(src);
  R.appCheck       = /appcheck|AppCheck/i.test(raw);
  R.recaptcha      = /recaptcha/i.test(raw);

  /* ── 4. workspace injectors present ──────────────────────────────────── */
  R.injectors = [];
  if (/shared-header\.js/.test(raw))     R.injectors.push('shared-header');
  if (/sokoni-nav-engine\.js/.test(raw)) R.injectors.push('nav-engine');
  if (/splash\.js/.test(raw))            R.injectors.push('splash');
  if (/security\.js/.test(raw))          R.injectors.push('security(consent)');
  R.wired = /sokoni-admin-shell\.js/.test(raw);

  /* ── 5. denial paths — destination AND branch semantics ──────────────── */
  R.denials = [];
  const lines = src.split('\n');
  lines.forEach((L, i) => {
    const nav = L.match(/(?:window\.)?location\s*(?:\.\s*(?:href|replace)\s*(?:=|\()|\s*=)\s*(['"`])([^'"`]*)\1/);
    if (!nav) return;
    const dest = nav[2];
    const ctx  = lines.slice(Math.max(0, i - 3), i + 1).join(' ');
    if (/sign\s*out|signOut|logout/i.test(ctx)) return;              /* not a denial */
    /* Branch is decided by THIS LINE first. A context window bleeds across
       adjacent branches: in the standard idiom
           if (!user) { ...login... }
           getIdTokenResult().then(t => { if (!t.claims.admin) { ...denial... } })
       the claims redirect sits 2 lines below the `!user` test, so a context-only
       reading mislabels it "signed-out" and reports a phantom branch mismatch.
       That produced 5 false positives on the first run. Context is consulted
       ONLY when the line itself carries no branch marker. */
    let branch = 'unknown';
    if (/claims|token\s*\.\s*(admin|superAdmin|moderator)/.test(L))            branch = 'insufficient-authority';
    else if (/if\s*\(\s*!\s*(user|u|fbUser|currentUser)\b/.test(L))            branch = 'signed-out';
    else if (/catch/.test(L))                                                  branch = 'verification-failure';
    else if (/if\s*\(\s*!\s*(user|u)\b/.test(ctx) && !/claims/.test(ctx))       branch = 'signed-out';
    else if (/claims|token\.(admin|superAdmin)/.test(ctx))                      branch = 'insufficient-authority';
    else if (/catch/.test(ctx))                                                branch = 'verification-failure';
    if (branch === 'unknown') return;
    const bare = dest.split('?')[0].replace(/^\.?\//, '');
    let verdict = 'ok';
    if (/^(index(\.html)?|seller(\.html)?)?$/.test(bare) && !/login/.test(bare)) verdict = 'MARKETPLACE/OTHER WORKSPACE';
    else if (/^login/.test(bare) && !/[?&](next|redirect)=/.test(dest)) verdict = 'login without next';
    else if (branch === 'insufficient-authority' && /^login/.test(bare)) verdict = 'BRANCH MISMATCH: signed-in sent to login';
    else if (branch === 'signed-out' && /error=insufficient/.test(dest)) verdict = 'BRANCH MISMATCH: signed-out sent to denial';
    R.denials.push({ line: i + 1, branch, dest: dest.slice(0, 46), verdict });
  });
  R.denialIssues = R.denials.filter(d => d.verdict !== 'ok').length;

  /* ── 6. page-owned chrome ────────────────────────────────────────────── */
  R.ownChrome = [];
  if (/<header[\s>]/.test(raw))                                    R.ownChrome.push('header');
  if (/class\s*=\s*["'][^"']*sidebar/.test(raw) || /<aside[\s>]/.test(raw)) R.ownChrome.push('sidebar');
  if (/id\s*=\s*["']hamburger["']|hamburger/i.test(raw))           R.ownChrome.push('hamburger');
  if (/position\s*:\s*fixed[^}]*top\s*:\s*0/.test(raw) || /top\s*:\s*0[^}]*position\s*:\s*fixed/.test(raw)) R.ownChrome.push('fixed@top:0');
  if (/position\s*:\s*sticky/.test(raw))                           R.ownChrome.push('sticky');

  /* ── 7. second factors ───────────────────────────────────────────────── */
  R.secondFactor = [];
  if (/\b3026\b/.test(src))                                        R.secondFactor.push('passcode-3026');
  if (/\bPIN\b|sokoniAdminPin/i.test(src))                         R.secondFactor.push('PIN');
  if (/sessionStorage\.(get|set)Item\s*\(\s*['"][^'"]*(Sess|Auth)/i.test(src)) R.secondFactor.push('session-token');

  /* ── 8. expected certification state ─────────────────────────────────── */
  if (R.blockingOverlay && (R.moduleFirebase || R.secondFactor.length || R.recaptcha)) {
    R.expect = 'LIKELY BLOCKED'; R.why = 'page-owned blocking overlay + an auth flow the harness may not complete';
  } else if (R.blockingOverlay) {
    R.expect = 'AT-RISK';        R.why = 'page-owned blocking overlay dismissed only by its own success path';
  } else if (R.ownChrome.includes('fixed@top:0') && R.ownChrome.includes('hamburger')) {
    R.expect = 'AT-RISK';        R.why = 'page-owned fixed chrome + hamburger may collide with the shell (enterprise-ops pattern)';
  } else if (R.tierMismatch || R.denialIssues) {
    R.expect = 'AT-RISK';        R.why = 'tier mismatch or denial-path issue to resolve while wiring';
  } else {
    R.expect = 'NORMAL';         R.why = 'no blocking overlay; standard wiring expected';
  }
  return R;
}

const rows = pages.map(p => analyse(p.page));

console.log('PLATFORM PRE-SCAN — ' + rows.length + ' surfaces.  READ ONLY, nothing modified.\n');

console.log('PAGE'.padEnd(28), 'TIER(enforced/registry)'.padEnd(26), 'OVERLAY', 'CHROME'.padEnd(8), 'EXPECT');
console.log('-'.repeat(104));
const order = { 'LIKELY BLOCKED': 0, 'AT-RISK': 1, NORMAL: 2 };
rows.sort((a, b) => (order[a.expect] - order[b.expect]) || a.page.localeCompare(b.page));
rows.forEach(r => console.log(
  r.page.padEnd(28),
  (r.tierEnforced + ' / ' + r.tierRegistry).padEnd(26),
  (r.blockingOverlay ? 'YES' : ' - ').padEnd(7),
  (r.ownChrome.length ? String(r.ownChrome.length) : '-').padEnd(8),
  r.expect));

const grp = {};
rows.forEach(r => { (grp[r.expect] = grp[r.expect] || []).push(r); });

for (const k of ['LIKELY BLOCKED', 'AT-RISK', 'NORMAL']) {
  if (!grp[k]) continue;
  console.log('\n=== ' + k + ' (' + grp[k].length + ') ===');
  grp[k].forEach(r => {
    console.log('  ' + r.page);
    console.log('      why      : ' + r.why);
    if (r.overlays.length) console.log('      overlays : ' + r.overlays.map(o => o.sel + (o.z ? ' z=' + o.z : '') +
      (o.defaultVisible ? ' visible' : '') + (o.dismissedByPage ? ' self-dismissed' : '')).join(', '));
    console.log('      auth     : ' + [r.moduleFirebase && 'module-import', r.namedApp && 'named-app', r.ownAuth && 'own-auth',
      r.compatShim && 'compat', r.appCheck && 'appcheck', r.recaptcha && 'recaptcha'].filter(Boolean).join(', '));
    if (r.secondFactor.length) console.log('      2FA      : ' + r.secondFactor.join(', '));
    if (r.ownChrome.length)    console.log('      chrome   : ' + r.ownChrome.join(', '));
    console.log('      injectors: ' + (r.injectors.join(', ') || 'none') + (r.wired ? '  [already wired]' : ''));
    if (r.numericRole)  console.log('      NOTE     : numeric role comparison present — see security-center Number(role)||0');
    if (r.tierMismatch) console.log('      NOTE     : enforced tier does not include the registry tier');
    r.denials.filter(d => d.verdict !== 'ok').forEach(d =>
      console.log('      DENIAL   : line ' + d.line + ' [' + d.branch + '] -> ' + d.dest + '   ** ' + d.verdict + ' **'));
  });
}

const issues = rows.reduce((n, r) => n + r.denialIssues, 0);
console.log('\nSummary: ' + (grp['LIKELY BLOCKED'] || []).length + ' likely blocked, ' +
            (grp['AT-RISK'] || []).length + ' at-risk, ' + (grp.NORMAL || []).length + ' normal; ' +
            issues + ' denial-path issue(s) to resolve while wiring.');
console.log('Predictions are hypotheses. Runtime certification is the verdict — monitor.html');
console.log('was predicted BLOCKED and certified 7/7.');

if (OUT) { fs.writeFileSync(OUT, JSON.stringify(rows, null, 2)); console.log('\nwrote ' + OUT); }
