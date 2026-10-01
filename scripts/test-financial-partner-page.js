#!/usr/bin/env node
'use strict';
/* ============================================================================
   financial-partner-dashboard — static page contract (no browser)
     1  self-updates (sw-register.js), auth-guarded, loads firebase.js
     2  no inline event handlers; talks only to financialPartnerDispatch; no localStorage
     3  every server value concatenated into HTML goes through esc()/shown()/when()/label()
     4  unknown counts render '—' (shown() never turns null into 0); esc() neutralises markup
     5  sidebar is built from the server's config.modules, not a hard-coded list
   node scripts/test-financial-partner-page.js
   ============================================================================ */
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'financial-partner-dashboard.html'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'financial-partner-dashboard.js'), 'utf8');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 400) : '')); } };

ck('1 page self-updates, is auth-guarded and loads firebase.js',
  /<script src="\/sw-register\.js" defer><\/script>/.test(html) && /data-require-auth="true"/.test(html) && /src="auth-guard\.js"/.test(html) && /src="firebase\.js"/.test(html));
ck('1b does NOT load sokoni-role-authority.js (its guardPage would bounce managers/officers, who hold no claim)',
  !/<script[^>]+sokoni-role-authority\.js/.test(html));
ck('1c profile form sends ONLY the listing EDITABLE_KEYS + workspace extras',
  /op: 'updateProfile', description: d\.description, services: picked, county: d\.county, website: d\.website, businessPhone: d\.businessPhone, businessEmail: d\.businessEmail, hours: d\.hours, branches: lines\(d\.branches\) \}/.test(js));
ck('2a no inline on* handlers in page or generated markup', !/\son[a-z]+\s*=/i.test(html) && !/\son[a-z]+=\\?["']/i.test(js));
const callables = [...js.matchAll(/sokoniCallable\('([^']+)'\)/g)].map((m) => m[1]);
ck('2b only financialPartnerDispatch is called', callables.length > 0 && callables.every((c) => c === 'financialPartnerDispatch'), callables);
const code = js.replace(/\/\*[\s\S]*?\*\//g, '');
ck('2c no localStorage / sessionStorage', !/localStorage|sessionStorage/.test(code));

/* 3 — for every  ' + <expr> + '  segment: strip safe wrapper calls and string literals; what remains may
   use a data field only as a condition (===, !==, .length, .indexOf, truthiness before ?). */
const SAFE_CALL = /\b(esc|shown|when|label|regPill|memberTr)\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)/g;
const offenders = [];
for (const m of code.matchAll(/'\s*\+\s*([^;]+?)\s*\+\s*'/g)) {
  const raw = m[1].trim();
  if (raw.startsWith("'")) continue;            /* two adjacent literals paired by the regex */
  let e = raw.replace(SAFE_CALL, 'SAFE').replace(/'(?:[^'\\]|\\.)*'/g, 'LIT');
  e = e.replace(/[\w.\[\]]+\s*(===|!==)\s*[\w.]+/g, 'COND')
       .replace(/[\w.]+\.(length|indexOf\([^)]*\))/g, 'COND')
       .replace(/\b(isOwner|canManage)\(\)/g, 'COND')
       .replace(/[\w.!]+\s*\?/g, 'COND ?')
       .replace(/\.(map|filter|slice|join)\(/g, '(');
  const reads = (e.match(/\b[A-Za-z_]\w*\.[A-Za-z_]\w*\b/g) || []).filter((x) => !/^(SAFE|LIT|COND)\b/.test(x));
  /* whole-row builders whose items are themselves built with esc() — checked separately below */
  if (/^(cards|r\.rows|S\.members|c\.regulators|c\.productKinds|visible|bad|r\.promotions|r\.requests)\b/.test(raw) || /^Object\.keys\(PLACEMENTS\)/.test(raw)) continue;
  if (reads.length) offenders.push(raw.slice(0, 140));
}
ck('3 every concatenated server value is escaped (or only used as a condition)', offenders.length === 0, offenders.slice(0, 8));
const mapBodies = [...code.matchAll(/\.map\(function \((\w+)\) \{([\s\S]*?)\}\)\.join\(''\)/g)];
const navWhitelisted = code.includes('c.modules.filter(function (m) { return Object.prototype.hasOwnProperty.call(ICONS, m); })');
const unsafeMaps = mapBodies.filter(([, v, body]) => !(navWhitelisted && body.includes('data-nav="\' + m + \'"')) &&new RegExp("'\\s*\\+\\s*" + v + "(\\.\\w+)?\\s*\\+\\s*'").test(body)).map((x) => x[0].slice(0, 120));
ck('3b list builders never concatenate a raw row value', mapBodies.length > 3 && unsafeMaps.length === 0, unsafeMaps);

/* 4 — run the real helpers */
const ctx = {};
const shownSrc = js.match(/var shown = (function \(n\) \{[\s\S]*?\});/)[1];
const escSrc = js.match(/var esc = (function \(v\) \{[\s\S]*?\}\); \});/)[1];
vm.runInNewContext('var shown=' + shownSrc + '; var esc=' + escSrc + ';' +
  'out=[shown(null),shown(undefined),shown(0),shown(1234),shown(NaN)]; e=esc(\'<img src=x onerror="a">\\\'&\');', ctx);
ck('4 shown(): null/undefined/NaN → —, a real 0 → 0', ctx.out[0] === '—' && ctx.out[1] === '—' && ctx.out[2] === '0' && ctx.out[4] === '—', ctx.out);
ck('4b esc() neutralises markup and quotes', !/[<>"']/.test(ctx.e) && /&lt;img/.test(ctx.e), ctx.e);
ck('5 sidebar filters S.ws.config.modules (server-driven)', /c\.modules\.filter\(/.test(js) && /data-nav="' \+ m \+ '"/.test(js));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
