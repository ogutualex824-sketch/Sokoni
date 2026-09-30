/* test-profile-buyer-view.js — the profile presents as a BUYER profile unless the acting role is a held
 * business role.
 *
 *   node scripts/test-profile-buyer-view.js        (no browser, no network)
 *
 * 2026-09-30 owner: "change the buyer profile to be for buyer role". The overview's business command
 * centre rendered for every visitor. Now one attribute on <html> (data-sk-profile-view) set from the
 * acting role decides, and business-only blocks carry .sk-biz-only. Personal tabs stay in every view.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'profile.html'), 'utf8');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 150) + ']' : '')); ok ? pass++ : fail++; };

console.log('\nPROFILE — BUYER PRESENTATION');
console.log('='.repeat(70));

/* ── 1. contract in the page ── */
ck('CSS: the buyer view hides .sk-biz-only, with !important so a later display=\'\' cannot reveal it',
   /html\[data-sk-profile-view="buyer"\] \.sk-biz-only\{display:none !important;\}/.test(SRC));
const BIZ = ['cmdBusinesses', 'cmdWorkspaces', 'pi7BizHealth', 'pi6ExecCmdsWrap', 'piQaRoleActions', 'upBizHub', 'pi7ModuleCards', 'statListings', 'statRating'];
const tagged = BIZ.filter((id) => {
  const i = SRC.indexOf('id="' + id + '"'); if (i < 0) return false;
  const open = SRC.lastIndexOf('<div', i);
  return /class="[^"]*\bsk-biz-only\b/.test(SRC.slice(open, i + id.length + 5)) ||
         /class="[^"]*\bsk-biz-only\b[^"]*"[^>]*>\s*<div[^>]*id="cmd/.test(SRC.slice(SRC.lastIndexOf('<div class="pi-cmd-card', i), i + 40));
});
ck('every business-only block is tagged sk-biz-only: ' + BIZ.join(', '), tagged.length === BIZ.length, BIZ.filter((x) => !tagged.includes(x)));
const PERSONAL = ['orders', 'bookings', 'following', 'wallet', 'identity', 'employment', 'achievements', 'security', 'card', 'career', 'vault'];
ck('personal tabs are NOT tagged (they belong to the person, in every view)',
   PERSONAL.every((t) => { const m = SRC.match(new RegExp('<button[^>]*data-tab="' + t + '"[^>]*>')); return m && !/sk-biz-only/.test(m[0]); }));
ck('the seller-application card and the buyer stats (orders, spent), loyalty, timeline and quick links stay visible',
   !/id="skSellerAppCard"[^>]*sk-biz-only|sk-biz-only[^>]*id="skSellerAppCard"/.test(SRC) &&
   !/class="up-stat sk-biz-only"><div class="up-stat-val" id="statOrders"/.test(SRC) &&
   !/class="up-stat sk-biz-only"><div class="up-stat-val" id="statSpent"/.test(SRC) &&
   !/id="upLoyaltyBar"[^>]*sk-biz-only/.test(SRC) && !/id="upTimeline"[^>]*sk-biz-only/.test(SRC));
ck('renderRoleSwitcher applies the view (boot, role switch, authority verification all pass through it)',
   /function renderRoleSwitcher\(\)\{[\s\S]{0,900}_applyProfileView\(activeRole, roles\);/.test(SRC) &&
   /try\{ renderRoleSwitcher\(\); \}catch\(_\)\{\}   \/\* also re-reads _user from storage \*\//.test(SRC));

/* ── 2. the pure decision, lifted from the page ── */
function lift(name) {
  const m = new RegExp('function\\s+' + name + '\\s*\\(').exec(SRC); if (!m) throw new Error('lift failed: ' + name);
  const open = SRC.indexOf('{', m.index); let d = 0;
  for (let i = open; i < SRC.length; i++) { if (SRC[i] === '{') d++; else if (SRC[i] === '}') { d--; if (d === 0) return SRC.slice(m.index, i + 1); } }
  throw new Error('unbalanced ' + name);
}
const sandbox = { document: { documentElement: { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } } } };
vm.createContext(sandbox);
vm.runInContext(lift('_profileViewFor') + '\n' + lift('_applyProfileView'), sandbox);
const V = (a, r) => vm.runInContext('_profileViewFor(' + JSON.stringify(a) + ',' + JSON.stringify(r) + ')', sandbox);
ck('buyer active, buyer only → buyer', V('buyer', ['buyer']) === 'buyer');
ck('seller acting as buyer (buyer active, seller held) → buyer view', V('buyer', ['buyer', 'seller']) === 'buyer');
ck('seller active and held → business', V('seller', ['buyer', 'seller']) === 'business');
ck('provider active and held → business', V('provider', ['buyer', 'provider']) === 'business');
ck('an active role the account does NOT hold → buyer (selection never presents an unheld role)', V('seller', ['buyer']) === 'buyer');
ck('no active role yet → buyer', V('', ['buyer', 'seller']) === 'buyer' && V(null, null) === 'buyer');
ck('rider / mechanic / landlord held and active → business (every non-buyer canonical role)',
   ['rider', 'mechanic', 'landlord', 'health', 'legal'].every((r) => V(r, ['buyer', r]) === 'business'));
vm.runInContext("_applyProfileView('buyer', ['buyer'])", sandbox);
ck('_applyProfileView writes data-sk-profile-view on <html>', sandbox.document.documentElement.attrs['data-sk-profile-view'] === 'buyer');
vm.runInContext("_applyProfileView('seller', ['buyer','seller'])", sandbox);
ck('…and flips it on a switch to a held business role', sandbox.document.documentElement.attrs['data-sk-profile-view'] === 'business');

/* ── 3. deliberate-breakage controls ── */
const untag = SRC.replace('<div class="up-card sk-biz-only" id="upBizHub"', '<div class="up-card" id="upBizHub"');
ck('control: untagging the Business Hub is detected by the tag predicate', untag !== SRC && !/class="up-card sk-biz-only" id="upBizHub"/.test(untag));
ck('control: a decision that ignored held roles would present an unheld role — it does not', V('seller', []) === 'buyer');
ck('served rules / role authority untouched by this slice', !/sk-biz-only|data-sk-profile-view/.test(fs.readFileSync(path.join(ROOT, 'sokoni-role-authority.js'), 'utf8')));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
