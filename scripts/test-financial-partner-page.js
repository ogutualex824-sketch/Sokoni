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
ck('2b only financialPartnerDispatch + createPaymentIntent (inside payCall) are called',
  callables.length === 2 && callables.includes('financialPartnerDispatch') && callables.includes('createPaymentIntent') &&
  /function payCall\(data\) \{\s*return window\.waitForFirebaseReady\(\)\.then\(function \(\) \{\s*return window\.sokoniCallable\('createPaymentIntent'\)\(data\);/.test(js), callables);
const code = js.replace(/\/\*[\s\S]*?\*\//g, '');
ck('2c no localStorage / sessionStorage', !/localStorage|sessionStorage/.test(code));
ck('2d page loads the existing sokoni-intasend.js before the dashboard script',
  /<script src="sokoni-intasend\.js" defer><\/script>\s*<script src="financial-partner-dashboard\.js" defer><\/script>/.test(html));

/* 3 — for every  ' + <expr> + '  segment: strip safe wrapper calls and string literals; what remains may
   use a data field only as a condition (===, !==, .length, .indexOf, truthiness before ?). */
/* Plain-TEXT sinks are excluded from the HTML scan and asserted separately (3c): licenceLine() returns text that
   is always esc()'d at use; payStatus() writes textContent; window.confirm() is not markup. */
const textOnly = code.replace(/function licenceLine\(l\) \{[\s\S]*?\n  \}/, '').replace(/payStatus\([^;]*;/g, '').replace(/window\.confirm\([^;]*;/g, '').replace(/return paid\([^;]*;/g, '');
const SAFE_CALL = /\b(esc|shown|when|label|regPill|memberTr|reviewBadge|planBlock)\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)/g;
const offenders = [];
for (const m of textOnly.matchAll(/'\s*\+\s*([^;]+?)\s*\+\s*'/g)) {
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
  if (/^(cards|r\.rows|S\.members|c\.regulators|c\.productKinds|visible|bad|r\.promotions|r\.requests|plans|list|rows|caps)\b/.test(raw) || /^Object\.keys\(PLACEMENTS\)/.test(raw)) continue;
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

/* 3c — the plain-text sinks excluded above really are text */
ck('3c payStatus() (and paid(), which delegates to it) writes textContent only; licenceLine() output reaches markup only through esc()',
  /function payStatus\(text, kind\) \{[^}]*el\.textContent = text; \}/.test(code) &&
  /function paid\(text, btn, kind\) \{\s*S\.paying = false; busy\(btn, false\);\s*payStatus\(text, 'ok'\);/.test(code) &&
  [...code.matchAll(/licenceLine\(/g)].length === 2 && /var lic = licenceLine\(mk\.licenceVerification\);/.test(code) && /esc\(lic\)/.test(code) && !/\+ lic \+/.test(code));

/* 6 — Plan & billing + paid promotion */
ck('6 "Plan & billing" module: appended to the server modules, visible to owner/manager only',
  /\.concat\(\['plan'\]\)\.filter\(function \(m\) \{\s*if \(m === 'plan'\) return canManage\(\);/.test(code) && /plan: 'Plan & billing'/.test(code) && /plan: vPlan/.test(code));
ck('6b prices come only from the server catalogue (no KES figures / price literals in the client)',
  !/KES\s?\d/.test(code) && !/priceKES\s*[:=]\s*\d/.test(code) && /com\.catalogue\.promotions/.test(code) && /cat\.plans/.test(code));
ck('6c purchases go through createPaymentIntent with the contract payloads',
  /startPayment\('plan', \{ purpose: 'partner_subscription', planId: p\.planId \}/.test(code) &&
  /var req = \{ purpose: 'promotion_purchase', productId: q\.productId \}/.test(code) && /req\.days = days;/.test(code) && /payCall\(req\)/.test(code));
const stk = [...code.matchAll(/initiateSTKPush\(([^)]*)\)/g)].map((m) => m[1]);
ck('6d every initiateSTKPush call passes (phone, intent.amount, intent.ref, {category, serviceDesc}) — options object always',
  stk.length === 1 && /^phone, intent\.amount, intent\.ref, \{ category: kind === 'plan' \? 'partner_plan' : 'promotion', serviceDesc: desc \}$/.test(stk[0]), stk);
const confirmedAt = [...code.matchAll(/Payment confirmed/g)].length;
const paidCalls = [...code.matchAll(/\bpaid\(/g)].length;
const stkThen = (code.match(/return window\.SokoniIntaSend\.initiateSTKPush[\s\S]*?pollCommercial\(kind, intent\.ref, req, before, 0, btn\);/) || [''])[0];
ck('6e success ("Payment confirmed") ONLY via paid(), ONLY after getCommercial shows the plan active with a later expiry / the campaign (campaignId === ref) active',
  confirmedAt === 2 && paidCalls === 3 &&
  /if \(p\.active === true && p\.planId === req\.planId && typeof p\.expiresAt === 'number' && \(before\.planId !== req\.planId \|\| p\.expiresAt > before\.expiresAt\)\) \{\s*return paid\('Payment confirmed/.test(code) &&
  /var c = \(com\.campaigns \|\| \[\]\)\.filter\(function \(x\) \{ return x\.campaignId === ref; \}\)\[0\];\s*if \(c && c\.status === 'active'\) return paid\('Payment confirmed/.test(code) &&
  stkThen.length > 0 && !/paid\(|confirmed —/.test(stkThen), { confirmedAt, paidCalls });
ck('6f the confirmation poll is bounded and ends in an honest "Not confirmed yet" + Check again',
  /var PAY_POLL_EVERY = 4000, PAY_POLL_MAX = 30;/.test(code) && /if \(n \+ 1 >= PAY_POLL_MAX\)/.test(code) && /Not confirmed yet\./.test(code) && /data-act="payCheck"/.test(code));
ck("6g a campaign in 'review' says the payment is under SOKONI review — never success",
  /if \(c && c\.status === 'review'\) \{[\s\S]{0,120}payStatus\('Payment received — SOKONI is reviewing this payment\./.test(code) && /'Under review'/.test(code) && /'Stopped by SOKONI'/.test(code));
ck('6h non-self-serve plans (Enterprise) show "Contact SOKONI" and can never be bought here',
  /p\.selfServe !== true \? '<a class="btn" href="contact\.html">Contact SOKONI<\/a>'/.test(code) && /if \(!p \|\| p\.selfServe !== true\) return;/.test(code));
ck('6i Listing Boost days are capped 1–30 on the client (server re-validates)', /hi = Math\.min\(30, p\.maxDays \|\| 30\)/.test(code) && /days <= Math\.min\(30, q\.maxDays \|\| 30\)/.test(code));
ck('6j promotion copy: ranks + "Promoted", never verifies or endorses', /Promotion ranks your listing and is marked Promoted; it never verifies or endorses you\./.test(code));
ck('6k analytics card only when the server sends analytics (absent → no card, never 0)', /if \(w\.analytics && typeof w\.analytics === 'object'\) cards\.push\(\['Enquiries, last 30 days', w\.analytics\.enquiries30d\]\);/.test(code));
ck('6l plan-limit refusals are shown with the server\'s meaning', /function limitHint\(msg\) \{ return \/your plan allows\/i\.test\(msg\) \? msg \+ ' See Plan & billing\.' : msg; \}/.test(code) && /toast\(limitHint\(errMsg\(e\)\), true\)/.test(code));

/* 7 — Registration review + licence */
ck('7 licence fields are optional, labelled self-declared, and sent only with a licence number',
  ['licenceType', 'licenceNumber', 'issuingAuthority', 'licenceExpiry'].every((n) => new RegExp('name="' + n + '"').test(code)) &&
  /Self-declared until SOKONI checks the issuing authority\\'s register\./.test(code) &&
  /if \(d\.licenceNumber\) \{ req\.licenceType = d\.licenceType; req\.licenceNumber = d\.licenceNumber; req\.issuingAuthority = d\.issuingAuthority; req\.licenceExpiry = d\.licenceExpiry; \}/.test(code));
ck('7b resubmit form only for needs_information / rejected; reviewer note shown there; locked while under review or approved',
  /var resubmit = r\.status === 'needs_information' \|\| r\.status === 'rejected';/.test(code) && /var locked = r\.status === 'under_review' \|\| approved;/.test(code) &&
  /\(resubmit && r\.reviewNote \?/.test(code) && /\(locked \?/.test(code));
const ctx2 = {};
vm.runInNewContext('var esc=' + escSrc + '; var when=function(ms){return ms?"3 Oct 2026":"—";};' +
  grab(/(function reviewBadge\(mk\) \{[\s\S]*?\n  \})/) + grab(/(function licenceLine\(l\) \{[\s\S]*?\n  \})/) +
  'out={a:reviewBadge({registrationReviewed:false,reviewBadge:{tooltip:"x"}}),b:reviewBadge(null),c:reviewBadge({registrationReviewed:"true"}),' +
  'd:reviewBadge({registrationReviewed:true,reviewBadge:{label:"Registration reviewed by SOKONI",tooltip:"Not a <b>licence</b>"}}),' +
  'l1:licenceLine({status:"verified_against_register",issuingAuthority:"CBK",checkedAt:1}),l2:licenceLine({status:"expired",issuingAuthority:"CBK",expiryDate:"2026-01-31"}),l3:licenceLine(null),l4:licenceLine({status:"mismatch",issuingAuthority:"CBK"})};', ctx2);
function grab(re) { const m = js.match(re); if (!m) throw new Error('helper not found: ' + re); return m[1]; }
const o2 = ctx2.out;
ck('7c badge ONLY when markers.registrationReviewed === true (not truthy strings, not null)', o2.a === '' && o2.b === '' && o2.c === '', o2);
ck('7d badge text exact, tooltip via title + aria-describedby + visually-hidden text, tooltip escaped',
  /^<span class="pill ok" title="Not a &lt;b&gt;licence&lt;\/b&gt;" aria-describedby="rbTip">Registration reviewed by SOKONI<\/span><span class="vh" id="rbTip">Not a &lt;b&gt;licence&lt;\/b&gt;<\/span>$/.test(o2.d), o2.d);
ck('7e licence line: "checked against the <authority> register on <date>" / "Licence expired (<date>)" / nothing otherwise',
  o2.l1 === 'Licence checked against the CBK register on 3 Oct 2026' && o2.l2 === 'Licence expired (2026-01-31)' && o2.l3 === '' && o2.l4 === '', o2);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
