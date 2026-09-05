'use strict';
/**
 * CERT — Slice J2: the Supply route.
 *
 * THE INVARIANT
 *   Supply is registered ONCE, in the single route authority, and every navigation surface
 *   derives it from there. No projection holds its own list.
 *
 * METHOD
 *   The real registry is EXECUTED and its own projections are asked for the route — the
 *   sidebar/more list, the desktop rail, the mobile drawer, the bottom nav and the command
 *   palette are queried through the registry's public API rather than inspected as text.
 *
 * TWO VERSIONS ARE CHECKED ON PURPOSE
 *   The repository copy (what this slice commits) and the working copy (which additionally
 *   carries another workstream's uncommitted MORE_GROUPS work). Both must validate clean and
 *   both must expose Supply, because a route that only works against one of them would break
 *   the moment either landed.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0, sabotage = 0, sabotageOk = 0;
const failures = [];
const check = (n, c) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; failures.push(n); console.log('  FAIL  ' + n); } };
const sab   = (n, c) => { sabotage++; if (c) { sabotageOk++; pass++; console.log('  PASS    (sabotage: ' + n + ')'); } else { fail++; failures.push('SABOTAGE ' + n); console.log('  FAIL    (sabotage: ' + n + ')'); } };

console.log('\nCERT — Slice J2: Supply route registration\n');

function loadRegistry(src, label) {
  const sb = { console: { log() {}, warn() {}, error() {} } };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(src, sb, { filename: label });
  return sb.window.SokoniMerchantRoutes;
}

/* The version this slice commits — read from the INDEX, not the working tree, because the
   working tree also carries another workstream's uncommitted changes. */
const stagedSrc = execSync('git show :sokoni-merchant-routes.js', { cwd: ROOT, encoding: 'utf8', maxBuffer: 8e6 });
const workSrc   = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-routes.js'), 'utf8');
const SHELL     = fs.readFileSync(path.join(ROOT, 'merchant-v2.html'), 'utf8');

const VERSIONS = [['staged (this commit)', stagedSrc], ['working (with their WIP)', workSrc]];

/* ══════════════════════════════════════════════════════════
   §1 registration + validation, in BOTH versions
══════════════════════════════════════════════════════════ */
console.log('§1 registration');
for (const [label, src] of VERSIONS) {
  const C = loadRegistry(src, label);
  const errs = C.validate();
  check(label + ': the registry validates clean', Array.isArray(errs) && errs.length === 0);
  const r = C.get('supply');
  check(label + ': supply is registered', !!r);
  check(label + ': tier is "more", NOT primary', r && r.tier === 'more');
  check(label + ': kind is native', r && r.kind === 'native');
  check(label + ': the founder sidebar is untouched at 18', C.primary().length === 18);
  check(label + ': supply is NOT in the primary sidebar',
    !C.primary().some((x) => x.id === 'supply'));
}

/* ══════════════════════════════════════════════════════════
   §2 every projection derives it from the registry
══════════════════════════════════════════════════════════ */
console.log('\n§2 projections');
{
  const C = loadRegistry(stagedSrc, 'staged');
  const r = C.get('supply');

  check('more() — the drawer / rail source — includes supply',
    C.more().some((x) => x.id === 'supply'));
  check('the route declares mobile:true (mobile drawer)', r.mobile === true);
  check('the route declares desktop:true (desktop rail)', r.desktop === true);
  check('it carries an activeKey so a surface can mark itself current', r.activeKey === 'supply');

  /* The bottom nav is a projection of the PRIMARY tier only — a `more` route must NOT
     appear there, and that is the correct outcome, not an omission. */
  const bottom = typeof C.bottomNav === 'function' ? C.bottomNav() : C.primary();
  check('bottom navigation does not carry a more-tier route',
    !bottom.some((x) => x.id === 'supply'));

  /* The command palette is documented as a projection of the whole registry. */
  const all = typeof C.all === 'function' ? C.all() : C.primary().concat(C.more());
  check('the command palette source includes supply', all.some((x) => x.id === 'supply'));
  check('supply appears exactly ONCE across primary + more',
    C.primary().concat(C.more()).filter((x) => x.id === 'supply').length === 1);
  sab('the detector would catch a duplicate registration',
    [{ id: 'supply' }, { id: 'supply' }].filter((x) => x.id === 'supply').length !== 1);
}

/* ══════════════════════════════════════════════════════════
   §3 the gate: role + context
══════════════════════════════════════════════════════════ */
console.log('\n§3 role / context gate');
{
  const C = loadRegistry(stagedSrc, 'staged');
  const r = C.get('supply');
  check('the route requires a merchant/seller role',
    Array.isArray(r.role) && r.role.indexOf('seller') !== -1 && r.role.indexOf('merchant') !== -1);
  check('it declares SELLER_UID context', Array.isArray(r.ctx) && r.ctx.indexOf('sellerUid') !== -1);
  /* Supply is keyed on a BUSINESS resolved by merchantContext(), not on activeShopId.
     Declaring shopId would gate it on a value it never uses and imply the two spaces are
     interchangeable — the confusion Slice H exists to prevent. */
  check('it does NOT gate on shopId, which it never uses', r.ctx.indexOf('shopId') === -1);
  sab('the detector would catch a shopId gate', ['sellerUid', 'shopId'].indexOf('shopId') !== -1);
}

/* ══════════════════════════════════════════════════════════
   §4 the shell mounts it
══════════════════════════════════════════════════════════ */
console.log('\n§4 shell wiring');
check('the module script is loaded by the shell',
  /<script src="sokoni-merchant-supply\.js"><\/script>/.test(SHELL));
check('MODULES maps supply to its global',
  /supply:\s*\{ global: 'SokoniMerchantSupply'/.test(SHELL));
check('the module ctx supplies merchantContext', /merchantContext: merchantContext,/.test(SHELL));
check('the module ctx supplies the resolver for business selection',
  /resolveMerchantContext: resolveMerchantContext,/.test(SHELL));
check('the module ctx supplies the callable factory', /callable: _callable,/.test(SHELL));
check('supply is NOT handed the shop scope',
  !/supply:\s*\{ global: 'SokoniMerchantSupply'[\s\S]{0,400}scope: _scope\(\)/.test(SHELL));
sab('the detector would catch supply being handed _scope()',
  /supply:\s*\{ global: 'SokoniMerchantSupply'[\s\S]{0,400}scope: _scope\(\)/.test(
    "supply:     { global: 'SokoniMerchantSupply', ctx: function () { return { scope: _scope() }; } },"));
check('the mounted global matches what the module registers',
  /global\.SokoniMerchantSupply = \{ mount: mount/.test(
    fs.readFileSync(path.join(ROOT, 'sokoni-merchant-supply.js'), 'utf8')));

/* ══════════════════════════════════════════════════════════
   §5 scope discipline — J2 stayed tiny
══════════════════════════════════════════════════════════ */
console.log('\n§5 scope');
const stagedDiff = execSync('git diff --cached -- sokoni-merchant-routes.js', { cwd: ROOT, encoding: 'utf8', maxBuffer: 8e6 });
const added = stagedDiff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
const removed = stagedDiff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---'));
check('the staged route change REMOVES nothing', removed.length === 0);
/* Behavioural, not a keyword whitelist. An earlier version matched added lines against a
   list of expected words, which fails the moment a comment is reworded and proves nothing
   about what actually changed. Load HEAD and the staged version and compare route sets. */
const headSrc = execSync('git show HEAD:sokoni-merchant-routes.js', { cwd: ROOT, encoding: 'utf8', maxBuffer: 8e6 });
const Chead = loadRegistry(headSrc, 'HEAD');
const Cstaged = loadRegistry(stagedSrc, 'staged');
const idsOf = (C) => C.primary().concat(C.more()).map((r) => r.id).sort();
const beforeIds = idsOf(Chead), afterIds = idsOf(Cstaged);
const gained = afterIds.filter((id) => beforeIds.indexOf(id) === -1);
const lost   = beforeIds.filter((id) => afterIds.indexOf(id) === -1);
check('the staged change adds EXACTLY one route', gained.length === 1);
check('and that route is supply', gained[0] === 'supply');
check('and removes none', lost.length === 0);
sab('the detector would catch a second added route',
  ['supply', 'extra'].filter((id) => ['a'].indexOf(id) === -1).length !== 1);
check('no route was reordered or removed', !/^-\s+\{ id:/m.test(stagedDiff));
check('PRIMARY_ORDER is untouched by this slice', !/PRIMARY_ORDER = \[/.test(stagedDiff.replace(/^\+.*founder.*$/gm, '')));
check('the other workstream\'s MORE_GROUPS work is NOT staged', !/MORE_GROUPS = \[/.test(stagedDiff));
check('their uncommitted work is still present in the working tree', /MORE_GROUPS/.test(workSrc));

console.log('\n  ' + pass + '/' + (pass + fail) + ' checks passed  ·  ' + sabotageOk + '/' + sabotage + ' sabotage catches');
if (fail) { console.log('\n  ' + fail + ' FAILURE(S):'); failures.forEach((f) => console.log('    - ' + f)); process.exit(1); }
console.log('\n  PASS — Supply is registered once and every surface derives it from the registry.\n');
