#!/usr/bin/env node
/* merchantIdentity (Part 3) + getMyShopWorkspaces (Part 4) — Till Approval
 * Automation + Unified Dashboard Profile — pure-core certification of
 * functions/shop-employees.js's new capabilitiesForRole(role) and
 * _workspaceEntry(...).
 *
 * No Firestore, no network — resolveShopAccess/shopOwnerOf (pre-existing,
 * unmodified, already this codebase's corroborated authority) are not
 * re-certified here; only the NEW logic each slice adds is. The corroboration
 * scan inside getMyShopWorkspaces itself is I/O-bound (real Firestore reads)
 * and is certified by code-path tracing in docs/SWITCH_SHOP_WORKSPACES.md,
 * consistent with every I/O wrapper's methodology in this programme (Q5-Q8).
 * Negative control + sabotage control, per this session's standing rule.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SE = require('../functions/shop-employees');

let pass = 0, fail = 0;
function ok(label, cond, note) {
  if (cond) { pass++; }
  else { fail++; console.log('  FAIL  ' + label + (note ? '   [' + note + ']' : '')); }
}

console.log('');
console.log('  merchantIdentity (Part 3) + Switch Shop list entries (Part 4) — pure core certification');
console.log('');

console.log('  -- capabilitiesForRole --');
{
  ok('owner gets sell', SE.capabilitiesForRole('owner').includes('sell'));
  ok('admin gets sell', SE.capabilitiesForRole('admin').includes('sell'));
  ok('manager gets sell', SE.capabilitiesForRole('manager').includes('sell'));
  ok('cashier gets sell', SE.capabilitiesForRole('cashier').includes('sell'));
  ok('owner gets settings, cashier does not (least-privilege differs by role)',
    SE.capabilitiesForRole('owner').includes('settings') && !SE.capabilitiesForRole('cashier').includes('settings'));
  ok('support role gets an empty capability list (least privilege for an undefined-scope role)',
    Array.isArray(SE.capabilitiesForRole('support')) && SE.capabilitiesForRole('support').length === 0);
  ok('inventory role does not get sell (not a checkout role)', !SE.capabilitiesForRole('inventory').includes('sell'));

  // The security property that matters most: an unrecognised role must fail CLOSED.
  ok('unknown/malformed role -> empty array, NOT full access', SE.capabilitiesForRole('attacker-role').length === 0);
  ok('undefined role -> empty array', SE.capabilitiesForRole(undefined).length === 0);
  ok('null role -> empty array', SE.capabilitiesForRole(null).length === 0);
  ok('empty-string role -> empty array', SE.capabilitiesForRole('').length === 0);

  // Every returned list is a fresh reference — mutating one call's result must
  // never leak into the shared ROLE_CAPABILITIES table or a later call.
  const first = SE.capabilitiesForRole('cashier');
  first.push('forged-capability');
  const second = SE.capabilitiesForRole('cashier');
  ok('mutating a returned capability list does not contaminate the shared table', !second.includes('forged-capability'));
}

console.log('  -- _workspaceEntry (Part 4: Switch Shop / Choose Shop list entries) --');
{
  const active = SE._workspaceEntry('shop1', { name: 'Kass Traders', status: 'active' }, 'owner', 'owner');
  ok('normal entry: shopId passed through', active.shopId === 'shop1');
  ok('normal entry: shopName from shop data', active.shopName === 'Kass Traders');
  ok('normal entry: role/via passed through', active.role === 'owner' && active.via === 'owner');
  ok('normal entry: isActive true for a non-suspended shop', active.isActive === true);

  const suspended = SE._workspaceEntry('shop2', { name: 'Old Shop', status: 'suspended' }, 'owner', 'owner');
  ok('suspended shop -> isActive false', suspended.isActive === false);

  const noName = SE._workspaceEntry('shop3', { status: 'active' }, 'cashier', 'employee');
  ok('missing shop name falls back to "My Shop", never blank', noName.shopName === 'My Shop');

  const xss = SE._workspaceEntry('shop4', { name: '<script>evil</script>Shop', status: 'active' }, 'owner', 'owner');
  ok('shop name is sanitised (no raw angle brackets survive)', !/[<>]/.test(xss.shopName));

  const noShopData = SE._workspaceEntry('shop5', null, 'employee', 'employee');
  ok('missing shop data entirely -> does not throw, isActive defaults true (absence is not the same as suspended)',
    noShopData.isActive === true && noShopData.shopName === 'My Shop');
}

console.log('  -- negative control (must fail; proves the harness can detect failure) --');
{
  const before = fail;
  ok('deliberately false assertion', 1 === 2);
  ok('control recorded exactly one failure', fail === before + 1);
  fail--;
}

console.log('  -- sabotage control (fail-closed default for an unknown role must be CAUGHT) --');
{
  const realSrc = fs.readFileSync(path.join(__dirname, '..', 'functions', 'shop-employees.js'), 'utf8');

  const sabotagedSrc = realSrc.replace(
    'return (ROLE_CAPABILITIES[role] || []).slice();',
    'return (ROLE_CAPABILITIES[role] || ROLE_CAPABILITIES.owner).slice(); // SABOTAGED: fail-open'
  );
  if (sabotagedSrc === realSrc) {
    throw new Error('SABOTAGE CONTROL SETUP FAILED — the fail-closed line to weaken was not found; ' +
      'the control cannot prove anything and the run must be blocked.');
  }

  /* Written INSIDE functions/, not os.tmpdir() — shop-employees.js requires
     firebase-functions/firebase-admin, which only resolve via
     functions/node_modules. sokoni-qr-authority.js/payment-attribution.js's
     earlier sabotage controls this session had no such dependency, so
     os.tmpdir() worked there; it does not here. */
  const tmpFile = path.join(__dirname, '..', 'functions', `_tmp_sabotaged_shop_employees.${process.pid}.js`);
  fs.writeFileSync(tmpFile, sabotagedSrc);
  let sabotaged;
  try {
    sabotaged = require(tmpFile);
    ok('SABOTAGE: weakened code WRONGLY grants owner-level capabilities to an unknown role',
      sabotaged.capabilitiesForRole('bogus-role').includes('settings'));
    ok('control: the REAL (unmodified) module still fails closed for the same unknown role',
      SE.capabilitiesForRole('bogus-role').length === 0);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) { /* best-effort cleanup */ }
  }
}

console.log('');
console.log(`  ${pass} passed, ${fail} failed`);
console.log('');

if (fail > 0) {
  console.log('  BLOCKED — see FAIL lines above.');
  process.exit(1);
} else {
  console.log('  CERTIFIED — Parts 3-4 pure core (functions/shop-employees.js).');
  process.exit(0);
}
