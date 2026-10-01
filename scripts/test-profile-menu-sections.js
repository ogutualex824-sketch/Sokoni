#!/usr/bin/env node
/* test-profile-menu-sections.js — owner 2026-10-01: the profile dropdown shows ROLES and WORKSPACES
 * differently, never mixed. Static over sokoni-profile-menu.js (the ONE menu every dashboard mounts).
 *   S1  a "My roles" section exists and is ALWAYS rendered (no "more than one role" / personal-only gate)
 *   S2  every role row says which workspace it opens and marks the active one (Active badge, aria-current)
 *   S3  role rows still switch through _skSwitchRole and keep data-sk-workspace (proof addressing)
 *   S4  "Business workspaces" is a separate section, rendered only when the account has a business
 *   S5  the old mixed "Personal Account" row and the "Switch Role" pill strip are gone
 *   S6  every canonical role has a proper name + workspace (no raw "Health" / "Legal" fallbacks)
 *   N1-N2 negative controls
 */
'use strict';
const fs = require('fs'), path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'sokoni-profile-menu.js'), 'utf8');
let pass = 0, fail = 0;
const ck = (l, ok, g) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok ? '' : '   [' + JSON.stringify(g) + ']')); ok ? pass++ : fail++; };

const checks = (src) => {
  const strip = (src.match(/const workspaceStrip =([\s\S]*?)'<div class="sk-acct-separator"><\/div>';/) || [])[1] || '';
  const ws = (src.match(/const wsSection = ([\s\S]*?): '';/) || [])[1] || '';
  return {
    S1: /data-sk-section="roles"/.test(strip) && /My roles/.test(strip) && !/_wsRoles\.length > 1|isPersonalActive &&\s*_wsRoles/.test(src.slice(src.indexOf('const workspaceStrip'), src.indexOf('const workspaceStrip') + 400)),
    S2: /Opens ' \+ _hesc\(u\.w\)/.test(strip) && /sk-acct-active-badge">Active</.test(strip) && /aria-current="true"/.test(strip),
    S3: /data-sk-workspace="' \+ _hesc\(r\)/.test(strip) && /_skSwitchRole\(/.test(strip),
    S4: /workspaces\.length\s*\n?\s*\?/.test(ws) && /Business workspaces/.test(ws) && /data-sk-section="workspaces"/.test(ws),
    S5: !/Personal Account<\/div>/.test(src) && !/>Switch Role</.test(src),
    S6: ['buyer', 'seller', 'provider', 'rider', 'mechanic', 'health', 'legal', 'landlord', 'tenant'].every((r) => new RegExp('\\b' + r + ':\\s*\\{ i: \'[^\']+\', l: \'[^\']+\',\\s*w: \'[^\']+\' \\}').test(src)),
  };
};
const c = checks(SRC);
ck('S1 "My roles" is its own section and is ALWAYS rendered', c.S1);
ck('S2 each role row names the workspace it opens and marks the active one', c.S2);
ck('S3 role rows switch via _skSwitchRole and keep data-sk-workspace', c.S3);
ck('S4 "Business workspaces" is separate and only shown when the account has a business', c.S4);
ck('S5 the mixed "Personal Account" row and "Switch Role" pills are gone', c.S5);
ck('S6 every canonical role has a proper name and workspace', c.S6);
const bad1 = checks(SRC.replace('data-sk-section="roles"', 'data-sk-section="mixed"'));
ck('N1 negative control: a renamed roles section is caught', bad1.S1 === false);
const bad2 = checks(SRC.replace("health:   { i: '🩺', l: 'Healthcare',       w: 'Healthcare workspace' },", ''));
ck('N2 negative control: a role missing its name/workspace is caught', bad2.S6 === false);
console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
