#!/usr/bin/env node
/* Shared dashboard identity widget — pure-core certification (Part 5-7).
 *
 * No DOM, no Firebase, no network. Certifies sokoni-dashboard-profile-core.js
 * directly — the same methodology as sokoni-pay-q-core.js (Q8). The one
 * property that matters: a workspace switch can only ever be triggered for
 * an entry the SERVER marked active and that isn't already current.
 * Negative control + sabotage control, per this session's standing rule.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const Core = require('../sokoni-dashboard-profile-core.js');

let pass = 0, fail = 0;
function ok(label, cond, note) {
  if (cond) { pass++; }
  else { fail++; console.log('  FAIL  ' + label + (note ? '   [' + note + ']' : '')); }
}

console.log('');
console.log('  SHARED DASHBOARD IDENTITY WIDGET (Part 5-7) — pure core certification');
console.log('');

console.log('  -- shouldSwitchWorkspace --');
{
  ok('a different, active workspace -> switchable', Core.shouldSwitchWorkspace({ id: 'shop2', isActive: true, current: false }) === true);
  ok('the CURRENT workspace -> never re-triggers (no-op, not a redundant switch)',
    Core.shouldSwitchWorkspace({ id: 'shop1', isActive: true, current: true }) === false);
  ok('a server-marked INACTIVE workspace -> refused, even if not current',
    Core.shouldSwitchWorkspace({ id: 'shop3', isActive: false, current: false }) === false);
  ok('inactive AND current (edge case) -> still refused (current already wins, but both agree here)',
    Core.shouldSwitchWorkspace({ id: 'shop1', isActive: false, current: true }) === false);
  ok('missing entry entirely -> refused, does not throw', Core.shouldSwitchWorkspace(null) === false);
  ok('entry missing isActive field entirely -> treated as active (undefined !== false)',
    Core.shouldSwitchWorkspace({ id: 'shop4', current: false }) === true);
}

console.log('  -- workspaceItemState --');
{
  ok('current workspace -> Active badge, disabled (already there)',
    Core.workspaceItemState({ current: true }).badge === 'Active' && Core.workspaceItemState({ current: true }).disabled === true);
  ok('inactive workspace -> Disabled badge, disabled',
    Core.workspaceItemState({ isActive: false }).badge === 'Disabled' && Core.workspaceItemState({ isActive: false }).disabled === true);
  ok('normal switchable workspace -> no badge, not disabled',
    Core.workspaceItemState({ isActive: true, current: false }).badge === null && Core.workspaceItemState({ isActive: true, current: false }).disabled === false);
  ok('missing entry -> disabled, does not throw', Core.workspaceItemState(null).disabled === true);
}

console.log('  -- markCurrent --');
{
  const list = [{ id: 'shop1', name: 'A' }, { id: 'shop2', name: 'B' }, { id: 'shop3', name: 'C' }];
  const marked = Core.markCurrent(list, 'shop2');
  ok('exactly one entry marked current, matching the given activeShopId',
    marked.filter((w) => w.current).length === 1 && marked.find((w) => w.current).id === 'shop2');
  ok('original list is not mutated (each entry is a new object)', list[1].current === undefined);

  const noneActive = Core.markCurrent(list, 'shop-not-in-list');
  ok('an activeShopId matching nothing in the list -> zero entries marked current, not a crash',
    noneActive.filter((w) => w.current).length === 0);

  const noActiveId = Core.markCurrent(list, null);
  ok('no activeShopId at all -> zero entries marked current', noActiveId.filter((w) => w.current).length === 0);

  ok('markCurrent on an empty/missing list -> empty array, not a throw', Array.isArray(Core.markCurrent(null, 'x')) && Core.markCurrent(null, 'x').length === 0);
}

console.log('  -- negative control (must fail; proves the harness can detect failure) --');
{
  const before = fail;
  ok('deliberately false assertion', 1 === 2);
  ok('control recorded exactly one failure', fail === before + 1);
  fail--;
}

console.log('  -- sabotage control (allowing a switch onto a disabled workspace must be CAUGHT) --');
{
  const realSrc = fs.readFileSync(path.join(__dirname, '..', 'sokoni-dashboard-profile-core.js'), 'utf8');

  const sabotagedSrc = realSrc.replace(
    "if (w.isActive === false) return false;      /* server marked it inactive/disabled */",
    "// SABOTAGED: inactive check removed"
  );
  if (sabotagedSrc === realSrc) {
    throw new Error('SABOTAGE CONTROL SETUP FAILED — the inactive-check line to remove was not found; ' +
      'the control cannot prove anything and the run must be blocked.');
  }

  const tmpFile = path.join(__dirname, '..', `_tmp_sabotaged_dashboard_profile_core.${process.pid}.js`);
  fs.writeFileSync(tmpFile, sabotagedSrc);
  let sabotaged;
  try {
    sabotaged = require(tmpFile);
    ok('SABOTAGE: weakened code WRONGLY allows switching onto a server-disabled workspace',
      sabotaged.shouldSwitchWorkspace({ id: 'shopX', isActive: false, current: false }) === true);
    ok('control: the REAL (unmodified) module still refuses the same disabled workspace',
      Core.shouldSwitchWorkspace({ id: 'shopX', isActive: false, current: false }) === false);
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
  console.log('  CERTIFIED — Part 5-7 shared client-side pure core (sokoni-dashboard-profile-core.js).');
  process.exit(0);
}
