#!/usr/bin/env node
/* Role switching: one authority, one destination map, no Profile fallback.
 *
 *   npm run test:role:switch
 *
 * WHAT BROKE
 * Home was the only page baking a static #sk-top-nav, so _inject() skipped _buildNav() and
 * Home shipped `<a href="profile.html" id="sk-nav-avatar">` with no #sk-acct-wrap. The account
 * popup — which carries the switcher — could not even be appended (`if (wrap) ...`), so
 * selecting a role from Home was really just an anchor navigating to Profile.
 *
 * Three further divergences made the switcher untrustworthy wherever it DID render:
 *   - the popup highlighted roles[0] (localStorage) while the line above it read the authority
 *   - SokoniWorkspace.switchTo wrote a workspace role (owner|cashier|...) into activeRole,
 *     whose vocabulary is the CANONICAL personal roles, and reset it to roles[0] for Personal
 *   - a successful switch routed nowhere
 *
 * THE INVARIANT
 * activeRole is acting CONTEXT. It never grants. hubFor() returns null for a role the account
 * does not hold, so routing can never become a way into a workspace. Section 7 is the negative
 * control: with the entitlement check removed, an unentitled role gets a destination.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 80) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log('\n-- ' + t + ' --');

const RA  = fs.readFileSync(path.join(ROOT, 'sokoni-role-authority.js'), 'utf8');
const SH  = fs.readFileSync(path.join(ROOT, 'shared-header.js'), 'utf8');
const WS  = fs.readFileSync(path.join(ROOT, 'sokoni-workspace.js'), 'utf8');
const IDX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const PRO = fs.readFileSync(path.join(ROOT, 'profile.html'), 'utf8');

/* Load the REAL WORKSPACE_HUBS + hubFor against a stubbed entitlement set. */
function loadHub(approved, mutate) {
  const a = RA.indexOf('  var WORKSPACE_HUBS = {');
  const b = RA.indexOf('\n  }', RA.indexOf('function hubFor(role)'));
  if (a < 0 || b < 0) throw new Error('hubFor slice markers moved');
  let src = RA.slice(a, b + 4);
  if (mutate) {
    const before = src;
    src = mutate(src);
    if (src === before) throw new Error('control mutation did not apply');
  }
  return new Function('_canonical', 'isApproved',
    src + '\nreturn { hubFor: hubFor, HUBS: WORKSPACE_HUBS };')(
    (r) => String(r || '').toLowerCase(),
    (r) => approved.indexOf(r) > -1);
}

(async () => {
  head('0 - the destination map is the authority own, and admin is not in it');
  const all = loadHub(['buyer', 'seller', 'provider', 'rider', 'mechanic', 'health', 'legal', 'landlord', 'tenant']);
  ck('WORKSPACE_HUBS exported from sokoni-role-authority.js', /WORKSPACE_HUBS:\s+WORKSPACE_HUBS/.test(RA));
  ck('hubFor exported', /hubFor:\s+hubFor/.test(RA));
  ck('admin has NO acting-context destination', all.HUBS.admin === undefined && all.HUBS.superAdmin === undefined);
  ck('destinations are ones already in use (no invented URLs)',
     ['index.html', 'merchant.html', 'providers.html', 'driver.html', 'car-hub.html',
      'healthcare.html', 'legal-hub.html', 'landlord.html', 'property.html']
       .every((u) => PRO.includes(u)));

  head('1 - an approved role routes to its workspace');
  const multi = loadHub(['buyer', 'seller', 'rider']);
  ck('buyer  -> index.html', multi.hubFor('buyer') === 'index.html', multi.hubFor('buyer'));
  ck('seller -> merchant.html', multi.hubFor('seller') === 'merchant.html', multi.hubFor('seller'));
  ck('rider  -> driver.html', multi.hubFor('rider') === 'driver.html', multi.hubFor('rider'));
  ck('every approved role resolves a destination', ['buyer', 'seller', 'rider'].every((r) => !!multi.hubFor(r)));

  head('2 - routing NEVER grants: an unheld role has no destination');
  const buyerOnly = loadHub(['buyer']);
  ck('buyer-only: seller   -> null', buyerOnly.hubFor('seller') === null);
  ck('buyer-only: rider    -> null', buyerOnly.hubFor('rider') === null);
  ck('buyer-only: provider -> null', buyerOnly.hubFor('provider') === null);
  ck('buyer-only: admin    -> null', buyerOnly.hubFor('admin') === null);
  ck('buyer-only: its own role still routes', buyerOnly.hubFor('buyer') === 'index.html');

  head('3 - Home uses the shared account control, not an anchor');
  ck('index.html has #sk-acct-wrap', /id="sk-acct-wrap"/.test(IDX));
  ck('avatar is a BUTTON wired to the shared toggle',
     /<button[^>]*id="sk-nav-avatar"[\s\S]{0,200}_skToggleAcct\(event\)/.test(IDX));
  ck('no anchor avatar remains', !/<a[^>]*id="sk-nav-avatar"/.test(IDX));
  ck('Home defines no switcher of its own', !/_skSwitchRole\s*=/.test(IDX));
  ck('index.html is still the only static #sk-top-nav page', (IDX.match(/id="sk-top-nav"/g) || []).length === 1);

  head('4 - the switch routes, and never falls back to Profile');
  const sw = SH.slice(SH.indexOf('window._skSwitchRole = async function'), SH.indexOf('function _skMirrorRoleLocally'));
  ck('the switch consults RA.hubFor', /hubFor\(role\)/.test(sw));
  ck('no hardcoded profile destination in the switch', !/profile\.html/.test(sw));
  ck('skips navigation when already on the destination', /here\.toLowerCase\(\) !== hub\.toLowerCase\(\)/.test(sw));
  ck('still refuses a role the authority declined', /res\.ok !== true/.test(sw));
  ck('mirrors only AFTER the authority agreed',
     sw.indexOf('setActiveRole') < sw.indexOf('_skMirrorRoleLocally(role)'));

  head('5 - header and Profile read the same acting role');
  ck('_skActingRole resolver exists', /function _skActingRole\(fallback\)/.test(SH));
  ck('popup highlight no longer derives from roles[0]', !/const active\s+= roles\[0\]/.test(SH));
  ck('popup highlight uses the resolver', /const active\s+= _skActingRole\(/.test(SH));
  ck('the acting-as line uses the same resolver',
     /function _skActiveRoleLine\(active\) \{\s*var role = _skActingRole\(active\);/.test(SH));
  ck('Profile still consumes the event (df1459a intact)', /addEventListener\('sokoniActiveRoleChanged'/.test(PRO));
  ck('Profile Business Hub still acting-role gated', /_actingAs\('seller', u\)/.test(PRO));
  ck('My Store still entitlement-based', /function _isSellerUser\(u\)\{   return _hasRole\('seller', u\); \}/.test(PRO));

  head('6 - switching mutates no authority state');
  /* Strip comments first: the fix REPLACED the assignment with a comment that quotes the old
     line verbatim, so a raw-source detector fires on the explanation of the fix. Controlled
     below, so a comment-blind detector cannot pass by being blind to everything. */
  const WS_CODE = WS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ck('switchTo no longer writes activeRole', !/u\.activeRole\s*=/.test(WS_CODE));
  ck('control: the stripped detector still catches a real write',
     /u\.activeRole\s*=/.test(WS_CODE + '\nu.activeRole = ws.role;'));
  ck('control: stripping left switchTo intact', /function switchTo\(businessId\)/.test(WS_CODE));
  ck('workspace role still available on activeWorkspace', /u\.activeWorkspace\s*=/.test(WS));
  const mirror = SH.slice(SH.indexOf('function _skMirrorRoleLocally'), SH.indexOf('function _skMirrorRoleLocally') + 900);
  ck('mirror never writes claims', !/setCustomUserClaims|getIdToken/.test(mirror));
  ck('mirror never touches applications/sellers', !/applications|sellers/.test(mirror));
  ck('mirror does not ADD to roles[] (reorder only)', !/roles\.push\(/.test(mirror));
  ck('exactly one sokoniActiveRoleChanged dispatch platform-wide',
     (RA.match(/dispatchEvent\(new CustomEvent\('sokoniActiveRoleChanged'/g) || []).length === 1);

  head('7 - NEGATIVE CONTROL: without the entitlement check, routing grants');
  const neutered = loadHub(['buyer'], (s) => s.replace('if (!r || !isApproved(r)) return null;', 'if (!r) return null;'));
  ck('control: buyer-only now WRONGLY routes to merchant.html', neutered.hubFor('seller') === 'merchant.html');
  ck('control: buyer-only now WRONGLY routes to driver.html', neutered.hubFor('rider') === 'driver.html');
  ck('control: admin still has no destination (map, not the check)', neutered.hubFor('admin') === null);

  head('8 - the Add Role wizard can be scrolled');
  ck('#roleOptionsList is the scroll container', /#roleOptionsList\{[\s\S]{0,200}overflow-y:auto/.test(PRO));
  ck('it has a height ceiling', /#roleOptionsList\{[\s\S]{0,200}max-height:min\(60vh, 420px\)/.test(PRO));
  ck('scroll chaining contained', /#roleOptionsList\{[\s\S]{0,240}overscroll-behavior:contain/.test(PRO));
  ck('body scroll STILL locked on open',
     /function openRoleModal\(\)\{[\s\S]{0,240}document\.body\.style\.overflow = 'hidden'/.test(PRO));
  ck('close restores body overflow',
     /function closeRoleModal\(\)\{[\s\S]{0,240}document\.body\.style\.overflow = ''/.test(PRO));
  ck('the sheet itself is NOT capped (Cancel stays reachable)', !/\.up-role-sheet\{[^}]*max-height/.test(PRO));
  /* Compare positions INSIDE the modal markup. The first "up-modal-close" in profile.html is
     the CSS rule at line 574, which precedes every element — the raw-source form of this check
     was measuring the stylesheet, not the sheet. */
  const MODAL = PRO.slice(PRO.indexOf('<div class="up-role-modal"'), PRO.indexOf('<!-- Scripts -->'));
  ck('Cancel button sits outside the scroll container',
     MODAL.indexOf('up-modal-close') > MODAL.indexOf('id="roleOptionsList"') &&
     MODAL.indexOf('up-modal-close') > -1);
  ck('control: the modal slice is the markup, not the CSS',
     /<button type="button" class="up-modal-close"/.test(MODAL) && !/max-height/.test(MODAL));
  ck('all six ROLES render into the list', /ROLES\.map\(function\(rd\)\{/.test(PRO));

  console.log('\n' + '='.repeat(72));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE CRASHED:', e && e.stack); process.exit(1); });
