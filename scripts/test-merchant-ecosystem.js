/* ══════════════════════════════════════════════════════════════════════════════
   MERCHANT V2 → SOKONI POS ECOSYSTEM — the wiring gate
   ══════════════════════════════════════════════════════════════════════════════
   The ecosystem is wired by ADDING ROWS to sokoni-merchant-routes.js and nowhere
   else. This suite proves the three properties that makes true, each with an
   INVERTING CONTROL where the claim is an absence — "no duplicate authority" and
   "no route is broken" are both absence claims, and an absence proves nothing
   unless the detector is shown to be capable of finding the thing.

     1. THE ECOSYSTEM IS A PROJECTION, NOT A SECOND LIST.
        merchant-v2.html must not carry its own array of ecosystem destinations.

     2. EVERY ADMITTED ROUTE HAS A SERVER AUTHORITY BEHIND IT, and every excluded
        one has a STATED REASON. A page whose data is a per-device IndexedDB store
        may not sit in merchant navigation beside the canonical route for the same
        concept — that is the competing-database outcome the whole brief exists to
        prevent.

     3. NOTHING EXISTING WAS REMOVED. /pos in particular: the POS button moving to
        the till must not cost the merchant the unified SmartPOS application.

   Run: node scripts/test-merchant-ecosystem.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs   = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const R    = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

const C = require(path.join(ROOT, 'sokoni-merchant-routes.js'));

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + String(detail).slice(0, 110) + ']' : ''));
  ok ? pass++ : fail++;
};

/* ── 0. The contract still holds ─────────────────────────────────────────────── */
console.log('\n0. Contract self-validation');
const errs = C.validate();
check('contract validates clean', errs.length === 0, errs.length ? errs.join(' | ') : C.ROUTES.length + ' routes');

/* ── 1. The POS entry ────────────────────────────────────────────────────────── */
console.log('\n1. POS button -> the till, and /pos preserved');
const pos = C.get('pos');
check('pos route exists and is primary', !!pos && pos.tier === 'primary');
check('pos entry is pos-checkout', !!pos && /^pos-checkout\.html/.test(pos.entry || ''), pos && pos.entry);
check('pos entry is IN-SHELL, not an exit', !!pos && pos.kind !== 'exit', pos && pos.kind);
check('pos entry carries ?shell=merchant', !!pos && /\?shell=merchant/.test(pos.entry || ''), pos && pos.entry);

/* /pos IS NOT REMOVED — the brief's explicit instruction. */
const sp = C.get('smartpos');
check('/pos survives as its own route', !!sp, sp ? sp.kind + ':' + sp.tab : 'MISSING — /pos was dropped');
check('...and it mounts pos.html (declares no entry)', !!sp && !sp.entry && sp.kind === 'pos');
check('...and it is reachable from navigation', !!sp && (sp.tier === 'primary' || sp.tier === 'more'), sp && sp.tier);

/* The setup gate must still be unconditional — re-pointing the entry must not route a
   merchant past hardware setup. Asserted against the shell's real source. */
const shellSrc = R('merchant-v2.html');
/* Comments stripped FIRST, as the sibling route gate does: the rule is about what the
   shell EXECUTES, and a comment explaining why the till is not named here would
   otherwise fail the very check it explains. */
const shellCode = shellSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
const posBranch = shellCode.slice(shellCode.indexOf("if (m.kind === 'pos')"), shellCode.indexOf("if (m.kind === 'seller')"));
check('POS setup gate still precedes the mount', /posSetupComplete/.test(posBranch) && posBranch.indexOf('posSetupComplete') < posBranch.indexOf('m.entry'),
      posBranch.indexOf('posSetupComplete') + ' < ' + posBranch.indexOf('m.entry'));
check('the shell mounts the DECLARED entry, not a literal', /m\.entry\s*\|\|/.test(posBranch));
/* INVERTING CONTROL: the detector must be able to see a hardcoded till. If this branch
   ever names pos-checkout.html directly, the shell has re-declared what the contract owns. */
check('CONTROL — shell does not hardcode pos-checkout', !/pos-checkout\.html/.test(posBranch),
      /pos-checkout\.html/.test(posBranch) ? 'the shell names the till itself' : 'declared only in the contract');

/* ── 2. Projection, not a second list ────────────────────────────────────────── */
console.log('\n2. The ecosystem is a projection of the contract');
const eco = C.ecosystem();
check('ecosystem groups exist', eco.length > 0, eco.map(g => g.key).join(','));
const ecoRoutes = eco.reduce((a, g) => a.concat(g.routes), []);
check('every ecosystem entry is a registered route', ecoRoutes.every(r => !!r && !!C.get(r.id)), ecoRoutes.length + ' routes');
/* Each ecosystem group is a MORE_GROUPS group, so validate()'s total partition already
   guarantees no route is in two groups and none is orphaned. Assert the link explicitly
   so the guarantee cannot be lost by moving the groups elsewhere. */
check('ecosystem groups ARE more-groups (inherit the total partition)',
      eco.every(g => C.MORE_GROUPS.some(m => m.key === g.key)));
const stripped = shellCode;
check('shell reads CONTRACT.ecosystem()', /CONTRACT\.ecosystem\s*\(/.test(stripped));
/* INVERTING CONTROL for "no second list": the detector must fire on a real one. */
const FAKE = "var ECO_LIST = ['pos-bi','pos-ai'];";
const SECOND_LIST = /var\s+ECO[A-Z_]*\s*=\s*\[|var\s+ECOSYSTEM\w*\s*=\s*\[/;
check('CONTROL — the second-list detector fires on a planted list', SECOND_LIST.test(FAKE));
check('shell declares no private ecosystem array', !SECOND_LIST.test(stripped));

/* ── 3. Every admitted route is REAL and IN-SHELL ────────────────────────────── */
console.log('\n3. Admitted routes are real, in-shell and non-escaping');
ecoRoutes.forEach(r => {
  const target = r.src || r.entry || (r.kind === 'pos' ? 'pos.html' : null);
  if (!target) { check('target declared: ' + r.id, false, r.kind); return; }
  const file = String(target).split(/[?#]/)[0];
  check('file exists: ' + r.id + ' -> ' + file, fs.existsSync(path.join(ROOT, file)));
});
check('no ecosystem route is an exit', ecoRoutes.every(r => r.kind !== 'exit'),
      ecoRoutes.filter(r => r.kind === 'exit').map(r => r.id).join(',') || 'none');
check('no ecosystem route targets an external URL',
      ecoRoutes.every(r => !/^(https?:)?\/\//.test(r.src || r.entry || '')));
/* Identity survives the transition BECAUSE the shell stays mounted. A page route cannot
   navigate the tab; that is the property, and it is structural, not asserted per-route. */
check('every ecosystem route mounts in-shell (page|pos|native|seller)',
      ecoRoutes.every(r => ['page', 'pos', 'native', 'seller'].indexOf(r.kind) > -1));

/* ── 4. Classification — the exclusions hold ─────────────────────────────────── */
console.log('\n4. Classification: no duplicate authority is admitted');
const EX = C.EXCLUDED;
check('exclusions are declared', EX.length > 0, EX.length + ' classified out');
check('every exclusion states a reason', EX.every(x => x.reason && x.reason.length >= 40));
check('every named canonical counterpart is a real route',
      EX.every(x => !x.canonical || !!C.get(x.canonical)),
      EX.filter(x => x.canonical && !C.get(x.canonical)).map(x => x.route).join(',') || 'all resolve');

/* THE CORE ASSERTION. The three device-local POS pages must not be reachable from merchant
   navigation, because a canonical route already owns each concept. Measured, not assumed:
   the page's own source is read and its callable count checked, so the classification is
   re-derived here rather than trusted from the contract's prose. */
const DEVICE_LOCAL = [
  { page: 'pos-suppliers.html', engine: 'pos-suppliers.js', canonical: 'supply' },
  { page: 'pos-customers.html', engine: 'pos-customers.js', canonical: 'customers' },
  { page: 'pos-reports.html',   engine: 'pos-reports.js',   canonical: 'reports' },
];
const mounted = C.ROUTES.map(r => String(r.src || r.entry || '').split(/[?#]/)[0]).filter(Boolean);
DEVICE_LOCAL.forEach(d => {
  const src = R(d.page);
  const engine = R(d.engine);
  /* The premise, re-measured: zero server authorities, and an IndexedDB/offline store. */
  check('premise — ' + d.page + ' calls no server authority', !/httpsCallable/.test(src));
  check('premise — ' + d.engine + ' is device-local', /DB_NAME|IndexedDB|offline/i.test(engine));
  /* The conclusion. */
  check('NOT in merchant navigation: ' + d.page, mounted.indexOf(d.page) === -1,
        mounted.indexOf(d.page) > -1 ? 'a route mounts it' : 'excluded');
  check('...and its canonical owner IS: ' + d.canonical, !!C.get(d.canonical));
  check('...and the exclusion is recorded', EX.some(x => x.route === '/' + d.page.replace(/\.html$/, '')));
});
/* INVERTING CONTROL: the "not mounted" detector must be able to find a page that IS
   mounted, or every line above would pass against a detector that matches nothing. */
check('CONTROL — the mount detector finds a page that IS routed',
      mounted.indexOf('pos-bi.html') > -1, mounted.length + ' mounted targets');

/* Diagnostics and previews stay out — the brief asks for them classified, not exposed. */
['/pos-v2', '/checkout-2-preview', '/pos-certification', '/pos-completeness',
 '/pos-observability', '/pos-launch-report', '/pos-printer-hardware-test',
 '/pos-ios-print-test'].forEach(rt => {
  const x = EX.find(e => e.route === rt);
  check('classified: ' + rt, !!x && (x.class === 'diagnostic' || x.class === 'preview'), x && x.class);
  check('...not mounted', mounted.indexOf(rt.replace(/^\//, '') + '.html') === -1);
});

/* Untracked files must not be routed — the row would resolve here and 404 in a clean
   checkout. Asserted against git, not against the filesystem, because the filesystem is
   exactly what makes this mistake invisible. */
console.log('\n4b. No route depends on an uncommitted file');
let tracked = null;
try {
  tracked = require('child_process').execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map(s => s.trim().replace(/\\/g, '/')).filter(Boolean);
} catch (_) { tracked = null; }
if (!tracked) {
  check('git ls-files available', false, 'could not read the index — this check did NOT run');
} else {
  const untrackedTargets = mounted.filter(f => tracked.indexOf(f) === -1);
  check('every mounted target is committed', untrackedTargets.length === 0,
        untrackedTargets.join(',') || mounted.length + ' targets, all tracked');
  /* CONTROL: the detector must be able to see an untracked file. */
  check('CONTROL — the tracked-file detector rejects a known-absent path',
        tracked.indexOf('this-file-does-not-exist.html') === -1);
}

/* ── 5. Void is blocked, deliberately and visibly ────────────────────────────── */
console.log('\n5. Void / sales control');
const v = EX.find(x => x.route === 'void');
check('void is classified, not forgotten', !!v && v.class === 'blocked', v && v.class);
check('...and the reason names the disjoint collections', !!v && /posSales/.test(v.reason) && /posRetailSales/.test(v.reason));
check('no route surfaces a void control', !C.ROUTES.some(r => /void/i.test(r.id) || /void/i.test(r.name || '')));

/* ── 5b. AdminOS: the right file, and not from here ──────────────────────────── */
console.log('\n5b. AdminOS');
check('admin-os.html is the file that exists', fs.existsSync(path.join(ROOT, 'admin-os.html')));
/* The superseded console must not be reachable from any merchant destination. Asserted on
   the mounted targets, not on the prose, and matched on the exact filename so
   minishop-admin.html — the merchant's OWN MiniShop editor — is not caught by it. */
const adminMounts = mounted.filter(f => f === 'admin.html' || f === 'admin-os.html');
check('no merchant route mounts admin.html or admin-os.html', adminMounts.length === 0,
      adminMounts.join(',') || 'none');
/* CONTROL: the detector must be able to tell the two apart from the MiniShop editor, or
   "no admin mount" would be passing for the wrong reason. */
check('CONTROL — the admin detector does not fire on minishop-admin.html',
      ['minishop-admin.html'].filter(f => f === 'admin.html' || f === 'admin-os.html').length === 0 &&
      mounted.indexOf('minishop-admin.html') > -1,
      'minishop-admin.html IS mounted and is correctly not treated as an admin console');
const adminEx = EX.find(x => x.route === '/admin-os');
check('the AdminOS exclusion is recorded', !!adminEx);
check('...and it names admin-os.html as canonical', !!adminEx && /admin-os\.html/.test(adminEx.reason));
check('...and says admin.html is NOT it', !!adminEx && /NOT admin\.html/.test(adminEx.reason));

/* ── 6. Settings routes to authorities; it owns none ─────────────────────────── */
console.log('\n6. Settings is a router, not a store');
const set = C.get('settings');
check('settings declares its links', !!set && Array.isArray(set.links) && set.links.length > 0, set && set.links.length);
check('every settings link resolves to a real route', set.links.every(l => !!C.get(l)),
      set.links.filter(l => !C.get(l)).join(',') || 'all resolve');
const DOMAINS = ['shop', 'products', 'inventory', 'supply', 'payments', 'deliveries', 'kra-tax', 'staff', 'pos-setup', 'devices'];
DOMAINS.forEach(d => check('settings reaches: ' + d, set.links.indexOf(d) > -1));

/* ── 7. Commission — displayed from the single source, never computed ─────────── */
console.log('\n7. Commission is read, not re-derived');
check('shell loads the generated snapshot', /src=["']sokoni-commission-rates\.js["']/.test(shellSrc));
check('shell reads SokoniCommission', /SokoniCommission/.test(stripped));
const snap = R('sokoni-commission-rates.js');
check('the snapshot is generated from the single source', /functions\/commission-config\.js/.test(snap));
/* The rate is DERIVED here, never written as a literal in this test — a literal would be
   a second place the number lives, and it would pass while the real table moved. */
const POS_PCT = Number((snap.match(/var\s+POS_FLAT_PCT\s*=\s*(\d+(?:\.\d+)?)/) || [])[1]);
const MIN_KES = Number((snap.match(/var\s+MIN_COMMISSION_KES\s*=\s*(\d+(?:\.\d+)?)/) || [])[1]);
check('snapshot declares a till rate', Number.isFinite(POS_PCT), POS_PCT + '%');
check('snapshot declares a minimum', Number.isFinite(MIN_KES), 'KES ' + MIN_KES);
/* The shell must not contain a commission rate of its own. Searched as a literal beside a
   percent sign in the settings renderer — the shape a hardcoded rate actually takes. */
const setRenderer = stripped.slice(stripped.indexOf('function commissionSection'), stripped.indexOf('function ecosystemSection'));
check('commission section exists', setRenderer.length > 0);
check('...and names no rate literal', !new RegExp('[^\\w.]' + POS_PCT + '\\s*%').test(setRenderer),
      'derives every figure from SokoniCommission');
check('...and renders an honest gap when the table is absent', /Commission unavailable/.test(setRenderer));
/* THE MARKETPLACE RATE MUST COME FROM THE LANE, NOT THE CATEGORY. pct('marketplace')
   returns the category FALLBACK; the rate a seller is actually charged is resolved by the
   marketplace lane. Reading the category understated it, which is a screen that lies about
   money in the merchant's favour-looking direction and against the merchant's interest. */
check('marketplace figure reads the LANE (marketplacePct), not the category',
      /marketplacePct\s*\(/.test(setRenderer) && !/\bpct\s*\(\s*['"]marketplace/.test(setRenderer),
      'category fallback would under-quote the seller');
/* CONTROL: the detector must be able to see the category call it forbids, or "not present"
   would pass against a regex that can never match. */
check('CONTROL — the category-call detector fires on a plant',
      /\bpct\s*\(\s*['"]marketplace/.test("var x = C.pct('marketplace');"));
const MKT_PCT = Number((snap.match(/MARKETPLACE_PLAN_PCT\s*=\s*\{[^}]*?"free"\s*:\s*(\d+(?:\.\d+)?)/) || [])[1]);
check('snapshot declares a marketplace lane rate', Number.isFinite(MKT_PCT), MKT_PCT + '%');
check('...and the settings renderer names no marketplace literal either',
      !new RegExp('[^\\w.]' + MKT_PCT + '\\s*%').test(setRenderer),
      'derived from SokoniCommission');
/* CONTROL: the literal detector must fire on a planted literal. */
check('CONTROL — the rate-literal detector fires on a plant',
      new RegExp('[^\\w.]' + POS_PCT + '\\s*%').test('charges ' + POS_PCT + '% per sale'));

/* ── 8. Identity — one merchant context, resolved once ───────────────────────── */
console.log('\n8. One merchant identity');
const till = R('pos-checkout.html');
check('the till loads the in-shell boundary', /src=["']sokoni-inshell\.js["']/.test(till));
check('the till asks the shell for its scope', /SokoniInShell\.merchantScope\(\)/.test(till));
check('...and re-reads it at the moment of sale', /_resolveMerchantId\(\)/.test(till) &&
      till.indexOf('_resolveMerchantId()') < till.indexOf('idempotencyKey ='));
check('the till no longer self-navigates in-shell on a null user',
      /SokoniInShell\.inShell.*requireAuth|requireAuth\(u/.test(till.replace(/\n/g, ' ')));
const inshell = R('sokoni-inshell.js');
check('merchantScope reads the SHELL, not a local store', /parent\.SokoniShell/.test(inshell));
check('merchantScope returns null rather than inventing an id',
      /if\s*\(!shopId\)\s*return null|shopId\s*\)\s*return null/.test(inshell) || /if \(!shopId\) return null/.test(inshell));
check('merchantScope never defaults merchantId to shopId', !/merchantId:\s*[^,\n]*shopId/.test(inshell));
/* The shell exposes what merchantScope reads — a cross-file fact, asserted. */
check('the shell publishes session + merchantContext', /SokoniShell\.session\s*=/.test(shellSrc) &&
      /SokoniShell\.merchantContext\s*=/.test(shellSrc));

console.log('\n' + '='.repeat(70));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
