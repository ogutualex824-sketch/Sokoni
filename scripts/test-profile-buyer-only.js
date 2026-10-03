#!/usr/bin/env node
'use strict';
/* ============================================================================
   Profile = BUYER only (owner 2026-10-03). Business/services controls live in their dashboards; the profile
   keeps doorways to them ("Your SOKONI identities", "Business Management").
     B1  the floating Active Role card floats AND has an opaque background
     B2  business-only blocks never render on the profile (unconditional rule + every block tagged); the
         person's own blocks are NOT tagged
     B3  every local page the profile links to EXISTS (Go Online → driver-dashboard.html did not)
     B4  doorways follow HELD roles (a seller browsing as a buyer still gets back to the shop) — exercised
     B5  business links open canonical dashboards: merchant-v2 routes that exist, AdminOS (not legacy admin.html)
     B6  Edit profile has no M-Pesa Till field, and the save no longer sends tillNumber
     B7  Orders comes from real orders (no browser cache), capped 200+; Spent never shows an invented number
     B8  Recent Activity has ONE writer, says Loading / empty / failed honestly, escapes server text
     B9  My Hubs are buyer hubs only
   node scripts/test-profile-buyer-only.js   (SOK_FILES_ROOT=<dir> to run against another tree's files)
   ============================================================================ */
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = process.env.SOK_FILES_ROOT || path.resolve(__dirname, '..');
const P = fs.readFileSync(path.join(ROOT, 'profile.html'), 'utf8').replace(/\r/g, '');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + String(d).slice(0, 260) : '')); } };
const fnBody = (name) => { const i = P.indexOf('function ' + name + '('); if (i < 0) return ''; let d = 0, j = P.indexOf('{', i); for (let k = j; k < P.length; k++) { if (P[k] === '{') d++; else if (P[k] === '}' && --d === 0) return P.slice(i, k + 1); } return ''; };
const tagOf = (id) => { const m = P.match(new RegExp('<[a-z]+[^>]*\\bid="' + id + '"[^>]*>')); return m ? m[0] : ''; };
const cardOf = (valId) => { const i = P.indexOf('id="' + valId + '"'); return i < 0 ? '' : P.slice(P.lastIndexOf('<div class="', P.lastIndexOf('<div class="', i) - 1), i); };

/* B1 */
const sw = (P.match(/\.up-role-switcher\{([^}]*)\}/) || [, ''])[1];
const alpha = Number((sw.match(/background:rgba\(\s*\d+,\s*\d+,\s*\d+,\s*([\d.]+)\)/) || [, 0])[1]);
ck('B1 Active Role card floats (sticky) with an opaque background (alpha ≥ 0.9) and a shadow', /position:sticky/.test(sw) && alpha >= 0.9 && /box-shadow/.test(sw), sw);

/* B2 */
ck('B2a .sk-biz-only is hidden UNCONDITIONALLY (not only in a buyer view)', /(^|\n)\.sk-biz-only\{display:none !important;\}/.test(P));
const BIZ = ['pi7BizHealth', 'pi6ExecCmdsWrap', 'piQaRoleActions', 'pi7ModuleCards'];
const untagged = BIZ.filter((id) => !/\bsk-biz-only\b/.test(tagOf(id)))
  .concat(['cmdBusinesses', 'cmdWorkspaces', 'statListings', 'statRating'].filter((id) => !/sk-biz-only/.test(cardOf(id))));
ck('B2b every business block is tagged (health, executive commands incl. Go Online, POS/staff actions, module cards, businesses/workspaces, listings/rating)', untagged.length === 0, untagged);
const PERSONAL = ['upAnalyticsCard', 'upBizHub', 'piWalletSnap', 'piKassCard', 'upTimeline', 'upQuickLinks', 'upRoleSwitcher', 'statOrders', 'statSpent', 'upTabs'];
const wrongly = PERSONAL.filter((id) => /sk-biz-only/.test(tagOf(id)) || (id.startsWith('stat') && /sk-biz-only/.test(cardOf(id))));
ck('B2c the person\'s blocks stay (identities, Business Management doorways, wallet, KASS, activity, hubs, switcher, orders/spent, tabs)', wrongly.length === 0, wrongly);

/* B3 */
const hrefs = new Set();
for (const m of P.matchAll(/href(?:=\s*"|:\s*')([a-z0-9][a-z0-9_-]*\.html)/gi)) hrefs.add(m[1]);
const missing = [...hrefs].filter((f) => !fs.existsSync(path.join(ROOT, f)));
ck('B3 every local page the profile links to exists (' + hrefs.size + ' pages)', missing.length === 0 && hrefs.size > 20, missing.join(', '));

/* B4 — run the real _renderBusinessHub against a tiny DOM */
const src = fnBody('_renderBusinessHub');
ck('B4a doorways (identities) follow HELD roles; the Business Management grid keeps the ACTING-role view (switch to Buyer clears it — test-business-hub-acting-role.js)',
  /heldSeller=_isSellerUser\(u\), heldProvider=_isProviderUser\(u\), heldRider=_isRiderUser\(u\)/.test(src) && /_idB\.style\.display = heldSeller/.test(src) && /var seller=_actingAs\('seller', u\)/.test(src));
function run (held, acting, admin) {
  const els = {}; const el = (id) => (els[id] = els[id] || { id, style: {}, innerHTML: '' });
  const ctx = { document: { getElementById: el }, escHtml: (x) => String(x),
    _isSellerUser: () => held.includes('seller'), _isProviderUser: () => held.includes('provider'), _isRiderUser: () => held.includes('rider'),
    _isAdminUser: () => !!admin, _bizRouteProvider: () => {}, _actingAs: (r) => held.includes(r) && acting === r };
  vm.createContext(ctx); vm.runInContext(src + '\n_renderBusinessHub({});', ctx);
  return els;
}
let e;
try { e = run(['seller'], 'buyer', false); } catch (x) { e = { err: x.message }; }
ck('B4b seller BROWSING AS BUYER: Business doorway still shown (way back to the shop); the business grid is not',
  e.upIdBusiness && e.upIdBusiness.style.display === 'flex' && e.upIdServices.style.display === 'none' && e.upIdRider.style.display === 'none' && e.upAnalyticsCard.style.display === '' && e.upBizHub.style.display === 'none', JSON.stringify(e).slice(0, 200));
try { e = run(['seller', 'provider', 'rider'], 'buyer', true); } catch (x) { e = { err: x.message }; }
ck('B4c seller + provider + rider + admin: ALL four doorways at once (no role hides another)', e.upIdBusiness && ['upIdBusiness', 'upIdServices', 'upIdRider', 'upIdAdmin'].every((k) => e[k].style.display === 'flex'), e.err);
try { e = run(['seller', 'provider'], 'seller', false); } catch (x) { e = { err: x.message }; }
ck('B4c2 acting as seller: Marketplace module with merchant-v2 links', e.upBizHubGrid && /Marketplace/.test(e.upBizHubGrid.innerHTML) && /merchant-v2\.html#products/.test(e.upBizHubGrid.innerHTML), e.err);
try { e = run([], 'buyer', false); } catch (x) { e = { err: x.message }; }
ck('B4d a plain buyer: no identities card, no Business Management', e.upAnalyticsCard && e.upAnalyticsCard.style.display === 'none' && e.upBizHub.style.display === 'none', e.err);

/* B5 */
const routes = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-routes.js'), 'utf8');
const used = [...src.matchAll(/merchant-v2\.html#([a-z-]+)/g)].map((m) => m[1]);
const badRoutes = used.filter((r) => !new RegExp("id:\\s*'" + r + "'").test(routes));
ck('B5a Business Management → merchant-v2 routes that exist (' + used.join(',') + ')', used.length >= 5 && badRoutes.length === 0, badRoutes);
ck('B5b no legacy admin.html / merchant.html#… links; AdminOS + merchant entry marker', !/href(?:=\s*"|:\s*')admin\.html/.test(P) && !/merchant\.html#/.test(P) && /admin-os\.html/.test(src) && /data-sk-merchant-entry/.test(src));

/* B6 */
ck('B6 Edit profile: no M-Pesa Till field, no read, and the save sends no tillNumber (a stored value is left alone)', !/ieTillInput|M-Pesa Till/.test(P) && !/tillNumber\s*:/.test(fnBody('saveInlineEdit')) && !/_user\.tillNumber\s*=/.test(P));

/* B7 */
const lo = fnBody('loadOrders'), ov = fnBody('loadOverview');
ck('B7a Orders/Spent never read the unscoped browser cache', !/localStorage\.getItem\('sokoniOrders'\)/.test(lo + ov));
ck('B7b Orders = real orders count (listener, 0 is a real answer), shown as 200+ at the query cap', /_count\(list\.length\)/.test(lo) && /n>=200 \? '200\+'/.test(lo) && !/if\(!fsOrders\|\|!fsOrders\.length\) return;/.test(lo));
ck('B7c Spent starts and stays "—" (no client-made total)', /id="statSpent">&#8212;</.test(P) && !/getElementById\('statSpent'\)\.textContent/.test(P));

/* B8 */
const tl = (P.match(/function _enhanceTimeline\(\) \{[\s\S]*?\n  \}\n/) || [''])[0];
ck('B8a ONE writer: the orders listener no longer redraws Recent Activity', !/buildTimeline\(/.test(P));
ck('B8b Loading / empty / failed are stated (no stale list left behind)', /Loading your activity…/.test(ov) && /if \(!events\.length\) \{\n\s*wrap\.innerHTML =/.test(tl) && /Couldn\\'t load your activity right now\./.test(tl));
ck('B8c server text escaped (title, subtitle, status)', /escHtml\(ev\.title \|\| ev\.description/.test(tl) && /escHtml\(ev\.subtitle \|\| when\)/.test(tl) && /escHtml\(String\(status\)/.test(tl));

/* B9 */
const hubs = (P.match(/function _renderAdaptiveHubs\(ov\) \{[\s\S]*?\n  \}\n/) || [''])[0];
const staticHubs = (P.match(/<div class="up-quick-links" id="upQuickLinks">[\s\S]*?<\/div>/) || [''])[0];
ck('B9 My Hubs: buyer hubs only (no store / driver / employer entries)', hubs && !/roles\.indexOf\('(seller|driver|employer|provider)'\)/.test(hubs) && !/merchant/.test(staticHubs));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
