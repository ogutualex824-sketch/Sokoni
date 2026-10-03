#!/usr/bin/env node
/* test-profile-menu-sections.js — the account dropdown layout (owner 2026-10-01). Static over
 * sokoni-profile-menu.js, the ONE menu every dashboard mounts. Order when the icon is tapped:
 *   ✕ close (top-right) · head · 👤 My profile (primary) · My workspaces (shops owned + worked at, with
 *   branches; team workspaces) · Other roles (authority-only, not buyer/seller) · Administration · buttons
 *   L1  ✕ close button in the head, top-right, 44px, aria-label, closes the menu
 *   L2  👤 My profile is the first action after the head (before My workspaces)
 *   L3  My workspaces: shops OWNED from shops/{uid} (+ branches via businesses→branches) and shops WORKED
 *       AT from shopEmployees/{uid}→shops/{owner} — the authorities merchant-v2 enforces; never invented
 *   L4  unknown = "Loading your workspaces…" / "Could not load…", never a fabricated row; cached ≤5 min
 *   L5  an owner who also works elsewhere: the employer row is NOT a link (merchant-v2 opens the own shop)
 *   L6  employee branches shown (workspace activeBranchName / branches)
 *   L7  Other roles = authority roles minus buyer/seller; NO fallback row (forged mirror role cannot appear)
 *   L8  role rows: icon + proper name + "Opens <workspace>" + Active; switch via _skSwitchRole; data-sk-workspace
 *   L9  Buyer → profile.html in the switch; other roles → hubFor()
 *   L10 the old mixed "Personal Account" row and "Switch Role" pills are gone; no duplicate "My Profile" link
 *   N1-N4 negative controls
 */
'use strict';
const fs = require('fs'), path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'sokoni-profile-menu.js'), 'utf8');
let pass = 0, fail = 0;
const ck = (l, ok, g) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok ? '' : '   [' + JSON.stringify(g) + ']')); ok ? pass++ : fail++; };

function checks(src) {
  const pop = src.slice(src.indexOf('popup.innerHTML ='), src.indexOf("'<div class=\"sk-acct-links\">'", src.indexOf('popup.innerHTML =')));
  const strip = (src.match(/const workspaceStrip =([\s\S]*?)'<div class="sk-acct-separator"><\/div>';/) || [])[1] || '';
  const load = src.slice(src.indexOf('async function _loadMyShops'), src.indexOf('function _buildAcctPopup'));
  const fill = src.slice(src.indexOf('(function _fillMyShops()'), src.indexOf('(function _fillMyShops()') + 4000);
  const sw = src.slice(src.indexOf('window._skSwitchRole = async function'), src.indexOf('window._skSwitchRole = async function') + 6000);
  return {
    L1: /class="sk-acct-close" aria-label="Close menu" data-sk-close onclick="window\._skCloseAcct\(\)">✕</.test(pop) && /\.sk-acct-close \{ position: absolute; top: 6px; right: 6px; width: 44px; height: 44px;/.test(src),
    L2: pop.indexOf('sk-acct-profile-btn') > -1 && pop.indexOf('sk-acct-profile-btn') < pop.indexOf('wsSection +') && pop.indexOf('wsSection +') < pop.indexOf('workspaceStrip +'),
    L3: /F\.doc\(db, 'shops', uid\)/.test(load) && /F\.doc\(db, 'shopEmployees', uid\)/.test(load) && /F\.doc\(db, 'shops', ed\.shopOwnerId\)/.test(load)
        && /where\('ownerId', '==', uid\)/.test(load) && /collection\(db, 'branches'\), F\.where\('merchantId', 'in'/.test(load) && /My workspaces/.test(src),
    L4: /Loading your workspaces…/.test(src) && /Could not load your workspaces right now\./.test(fill) && /_MYWS_TTL = 5 \* 60 \* 1000/.test(src),
    L5: /if \(!v\.owned\) \{[\s\S]*?href="merchant-v2\.html"[\s\S]*?\} else \{[\s\S]*?aria-disabled="true"/.test(fill),
    L6: /ws\.activeBranchName/.test(src) && /sk-acct-branch/.test(src),
    L7: /const _myRoles = _wsRoles\.filter\(function \(r\) \{ return r !== 'buyer' && r !== 'seller'; \}\);/.test(src) && /Other roles/.test(strip) && !/_myRoles = [^;]*\[_acting/.test(src),
    L8: /Opens ' \+ _hesc\(u\.w\)/.test(strip) && /sk-acct-active-badge">Active</.test(strip) && /data-sk-workspace="' \+ _hesc\(r\)/.test(strip) && /_skSwitchRole\(/.test(strip),
    L9: /if \(hub && role === 'buyer'\) hub = 'profile\.html';/.test(sw) && /RA2\.hubFor\(role\)/.test(sw),
    L10: !/Personal Account<\/div>/.test(src) && !/>Switch Role</.test(src) && !/👤 My Profile<\/a>/.test(src),
  };
}
const c = checks(SRC);
const label = {
  L1: '✕ close button top-right (44px, aria-label, closes the menu)', L2: '👤 My profile is the first action, before My workspaces, then Other roles',
  L3: 'My workspaces reads shops/{uid} (+ branches) and shopEmployees/{uid} → shops/{owner} — never invented',
  L4: 'unknown shows Loading… / Could not load…, cached ≤ 5 min', L5: 'owner who also works elsewhere: employer row is not a link',
  L6: 'employee branches shown', L7: 'Other roles = authority roles minus buyer/seller, no fallback row',
  L8: 'role rows: name + Opens <workspace> + Active, switch via _skSwitchRole', L9: 'Buyer → profile.html, others → hubFor()',
  L10: 'old Personal Account row, Switch Role pills and duplicate My Profile link are gone',
};
Object.keys(label).forEach((k) => ck(k + ' ' + label[k], c[k]));
ck('N1 negative control: a menu without the close button is caught', checks(SRC.replace('data-sk-close onclick', 'data-x onclick')).L1 === false);
ck('N2 negative control: restoring the acting-role fallback is caught',
  checks(SRC.replace("const _myRoles = _wsRoles.filter(function (r) { return r !== 'buyer' && r !== 'seller'; });", "const _myRoles = _wsRoles.length ? _wsRoles : [_acting || 'buyer'];")).L7 === false);
ck('N3 negative control: reading the employment from workspaceMemberships instead is caught', checks(SRC.replace("F.doc(db, 'shopEmployees', uid)", "F.doc(db, 'workspaceMemberships', uid)")).L3 === false);
ck('N4 negative control: workspaces placed above Profile is caught', checks(SRC.replace("'<a class=\"sk-acct-profile-btn\"", "wsSection + '<a class=\"sk-acct-profile-btn\"")).L2 === false);
console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
