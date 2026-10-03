#!/usr/bin/env node
'use strict';
/* ============================================================================
   Profile + Wallet — owner 2026-10-03: keep production as it is; Profile → identities (Business, Services …)
   → the rest; the role switcher unchanged; the wallet opens INSIDE the profile instantly (no reload, no
   splash); Back returns to the profile without a reload; Home buttons: wallet → index.html, BOS wallet → wallet.
   node scripts/test-profile-wallet-instant.js
   ============================================================================ */
const fs = require('fs'), path = require('path'), cp = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const FILES = process.env.SOK_FILES_ROOT || ROOT;  /* counterproof: point at another tree's files */
const rd = (f) => fs.readFileSync(path.join(FILES, f), 'utf8');
const live = (f) => cp.execSync('git show 72dca56:' + f, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString();
let pass = 0, fail = 0;
const ck = (id, l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + id + ' ' + l); } else { fail++; console.log('  FAIL  ' + id + ' ' + l + (d !== undefined ? '  -> ' + String(d).slice(0, 200) : '')); } };
const P = rd('profile.html'), W = rd('wallet.html'), G = rd('auth-guard.js'), S = rd('sfos-wallet.html');

/* ordering */
const iSw = P.indexOf('id="upRoleSwitcher"'), iId = P.indexOf('id="upAnalyticsCard"'), iTen = P.indexOf('id="tenantProfileCard"'), iTabs = P.indexOf('id="upTabs"'), iHdr = P.indexOf('class="up-header-card"');
ck('O1', 'order: profile header → role switcher → identities (Business, Services, Super Admin) → tenancy → tabs', iHdr > -1 && iHdr < iSw && iSw < iId && iId < iTen && iTen < iTabs, [iHdr, iSw, iId, iTen, iTabs].join(','));
ck('O2', 'the identities card exists exactly once and keeps its ids (JS that reveals it still finds it)', (P.match(/id="upAnalyticsCard"/g) || []).length === 1 && /id="upIdBusiness"/.test(P) && /id="upIdServices"/.test(P) && /id="superAdminLink"/.test(P));
const swBlock = (s) => { s = s.replace(/\r/g, ''); const a = s.indexOf('<div class="up-role-switcher" id="upRoleSwitcher">'); return s.slice(a, s.indexOf('</div>\n', s.indexOf('id="rsBtns"', a) + 1)); };
ck('O3', 'the role switcher markup is byte-for-byte as in production', swBlock(P) === swBlock(live('profile.html')));
/* everything else unchanged: removing the moved block + the added host must give back production */
const strip = (s) => s.replace(/\r/g, '').replace(/<style id="skProfileWalletCss">[\s\S]*?<\/style>\n/, '').replace(/<script>\n\/\* In-profile wallet host[\s\S]*?<\/script>\n/, '')
  .replace(/\n?\s*<!-- YOUR IDENTITIES[\s\S]*?<a href="super-admin\.html" id="superAdminLink"[\s\S]*?<\/a>\n\s*<\/div>\n\s*<\/div>\n/, '\n')
  /* the WhatsApp consent switch (2026-10-03, scripts/test-profile-whatsapp-consent.js): its row, loader line, script */
  .replace(/\n\s*<!-- WhatsApp consent \(2026-10-03\)[\s\S]*?onchange="skWaConsentSet\(this\)">\n\s*<\/div>/, '')
  .replace(/\n  try\{ skWaConsentLoad\(\); \}catch\(_\)\{\}/, '')
  .replace(/<script>\n\/\* WhatsApp consent \(2026-10-03\)[\s\S]*?<\/script>\n/, '')
  .replace(/\s+/g, ' ');
ck('O4', 'apart from the moved card, the wallet host and the WhatsApp consent switch, profile.html is identical to production', strip(P) === strip(live('profile.html')));

/* in-profile wallet */
ck('W1', 'every same-origin wallet link on the profile opens the in-profile wallet (one delegated handler; no navigation)',
  /closest\('a\[href\]'\)/.test(P) && P.includes('!/^\\/wallet(\\.html)?$/.test(u.pathname)') && /ev\.preventDefault\(\);\s*show\(true\);/.test(P));
ck('W2', 'pre-warmed while idle so it opens instantly; slide switch ≤ 180 ms; reduced-motion honoured',
  /requestIdleCallback/.test(P) && /idle\(warm\)/.test(P) && /transition:transform \.18s/.test(P) && /prefers-reduced-motion/.test(P));
ck('W3', 'phone Back closes it without leaving the profile (history state + popstate); profile balance refreshes on close',
  /history\.pushState\(\{ skWallet: 1 \}/.test(P) && /addEventListener\('popstate'/.test(P) && /loadWallet\(\)/.test(P));
ck('W4', 'wallet Back button closes the in-profile wallet (no reload), else history.back to profile',
  /window\.parent\.SokoniProfileWallet\.close\(\);return false;/.test(W) && /history\.back\(\);return false;/.test(W));
ck('W5', 'embedded wallet: no splash (data-no-splash) and no duplicate bottom nav', /embed=profile/.test(W) && /setAttribute\('data-no-splash','true'\)/.test(W) && /sk-in-profile/.test(W));
ck('W6', 'auth-guard treats the profile as a host (an embedded wallet never bounces to login)', /\(\^\|\\\/\)profile\(\\\.html\)\?\$/.test(G));
ck('W7', 'splash.js never draws inside a frame', /window\.self !== window\.top\) return;/.test(rd('splash.js')));

/* home buttons */
ck('H1', 'wallet logo → index.html (whole window); wallet Home → index.html from its home panel', /href="index\.html" target="_top"/.test(W) && /window\.top\.location\.href='index\.html'/.test(W) && /W2\.showPanel\('panHome'\);return;/.test(W));
ck('H2', 'BOS (Financial OS) wallet Home → back to the wallet (history when it came from there)', /location\.href='wallet\.html'/.test(S) && /history\.back\(\);return;/.test(S) && /_navTo\('sfos_home','sfosNavHome'\);return;/.test(S));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
