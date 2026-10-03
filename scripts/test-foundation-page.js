#!/usr/bin/env node
'use strict';
/* ============================================================================
   SOKONI Foundation page + Banking Hub — static contract (no browser)
     F1  foundation.html self-updates and loads security.js, firebase.js (module), foundation.js
     F2  no inline on* handlers in foundation.html or in markup foundation.js generates
     F3  only the contract callables are called, through ONE transport; payment reuses SokoniIntaSend
     F4  no localStorage; sessionStorage is used only for the donation requestId
     F5  no hard-coded amounts / totals / testimonials in the page
     F6  the thank-you copy is reachable ONLY behind status === 'completed'
     F7  every server value concatenated into HTML goes through esc() (or a safe builder)
     F8  helpers behave: esc neutralises; amount never substituted; unknown money = '—'
     B1  banking.html no longer loads sokoni-banking-pro.js; fake tool panes/tiles/bell gone
     B2  Banking Hub never prints verified / licensed / CBK-approved for partners
     B3  category -> institution-type mapping and empty-state apply links
   node scripts/test-foundation-page.js
   ============================================================================ */
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const html = read('foundation.html');
const js = read('foundation.js');
const bkHtml = read('banking.html');
const bkJs = read('banking-hub.js');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 400) : '')); } };
const stripHtmlComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '');
/* A small JS scanner: drops comments, and rewrites every string literal (single OR double quoted)
   as a single-quoted literal whose content has no quote characters, and every regex literal as
   /RE/. Naive quote-pairing regexes were measured to fail open here: an apostrophe inside a
   double-quoted string ("isn't available") shifted the pairing and hid an injected
   '<span>Verified</span>' and an unescaped r.title (sabotage S1/S3). */
function normalise(src) {
  let out = '', i = 0, prev = '';
  const n = src.length;
  const regexAllowed = () => /[(,=:[!&|?{};+\-*%<>~^]$|^$|\breturn$|\btypeof$/.test(out.trimEnd());
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; out += ' '; continue; }
    if (c === '/' && d === '/') { const e = src.indexOf('\n', i); i = e < 0 ? n : e; continue; }
    if (c === "'" || c === '"') {
      let j = i + 1, body = '';
      while (j < n && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') { body += src[j + 1] === c ? '' : src[j] + src[j + 1]; j += 2; continue; } body += src[j]; j++; }
      out += "'" + body.replace(/['"]/g, '') + "'"; i = j + 1; continue;
    }
    if (c === '/' && regexAllowed()) {
      let j = i + 1, cls = false;
      while (j < n && src[j] !== '\n') { if (src[j] === '\\') { j += 2; continue; } if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; else if (src[j] === '/' && !cls) break; j++; }
      j++; while (/[a-z]/.test(src[j] || '')) j++;
      out += '/RE/'; i = j; continue;
    }
    out += c; prev = c; i++;
  }
  return out;
}
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const code = stripComments(js), bkCode = stripComments(bkJs);   /* structural assertions */
const codeN = normalise(js), bkCodeN = normalise(bkJs);         /* escaping + wording assertions */

/* F1 */
ck('F1 foundation.html self-updates (sw-register) and loads security.js, firebase.js (module), foundation.js',
  /<script src="\/sw-register\.js" defer><\/script>/.test(html) && /<script src="security\.js"><\/script>/.test(html) &&
  /<script type="module" src="firebase\.js"><\/script>/.test(html) && /<script src="foundation\.js" defer><\/script>/.test(html));

/* F2 */
ck('F2 no inline on* handlers in foundation.html or generated markup',
  !/\son[a-z]+\s*=/i.test(html) && !/\son[a-z]+=\\?["']/i.test(js) && !/javascript:/i.test(html + js));

/* F3 */
const CONTRACT = ['impactPledgeDonation', 'createPaymentIntent', 'impactGetMyPledge', 'impactGetPublicDashboard', 'impactGetCampaigns', 'foundationContentDispatch'];
const called = [...code.matchAll(/\bcall\('([^']+)'/g)].map((m) => m[1]);
const sokoniCallableUses = (code.match(/sokoniCallable\(/g) || []).length;
ck('F3 only contract callables are called', called.length >= 8 && called.every((c) => CONTRACT.includes(c)), [...new Set(called)]);
ck('F3b one transport: sokoniCallable appears once, called with the name variable', sokoniCallableUses === 1 && /window\.sokoniCallable\(name\)\(data \|\| \{\}\)/.test(code));
ck('F3c payment reuses the existing SokoniIntaSend.initiateSTKPush on the server intent ref; no hand-rolled HTTP',
  /window\.SokoniIntaSend\.initiateSTKPush\(phone, intent\.amount, intent\.ref,/.test(code) && !/\bfetch\(|XMLHttpRequest|cloudfunctions\.net/.test(code) &&
  /call\('createPaymentIntent', \{ purpose: 'donation', pledgeId: r\.pledgeId \}\)/.test(code));
const ops = [...code.matchAll(/op: '([A-Za-z]+)'/g)].map((m) => m[1]);
ck('F3d foundationContentDispatch ops are the public ones only', ops.length && ops.every((o) => ['listPublished', 'submitTestimonial', 'listMine', 'withdrawMine'].includes(o)), ops);

/* F4 */
const ssUses = [...code.matchAll(/sessionStorage\.(\w+)\(([^,)]*)/g)].map((m) => m[1] + '(' + m[2]);
ck('F4 no localStorage in foundation.js / foundation.html', !/localStorage/.test(code) && !/localStorage/.test(html));
ck('F4b sessionStorage only for REQ_KEY (the donation requestId)', ssUses.length >= 2 && ssUses.every((u) => /\(REQ_KEY$/.test(u)) &&
  /var REQ_KEY = 'sk_foundation_donation_request'/.test(code), ssUses);
ck('F4c requestId comes from crypto.randomUUID and is reused for the same pledge details',
  /window\.crypto\.randomUUID\(\)/.test(code) && /if \(!fresh && rec && rec\.sig === sig/.test(code));

/* F5 */
const page = stripHtmlComments(html).replace(/<style>[\s\S]*?<\/style>/, '');
const visible = page.replace(/<[^>]+>/g, ' ');
const kesFigures = (visible.match(/KES[  ]?\d[\d,]*/g) || []).filter((m) => m !== 'KES 10');
ck('F5 no KES figures in page text except the stated KES 10 minimum', kesFigures.length === 0, kesFigures);
ck('F5b transparency figures start as — (never 0)', ['trAvail', 'trRecv', 'trOut'].every((id) => new RegExp('id="' + id + '">—<').test(html)));
ck('F5c story grid and programme grid ship empty (no hard-coded testimonials or programmes)',
  /<div class="grid" id="storyGrid"><\/div>/.test(html) && /<div class="grid" id="trProgs"><\/div>/.test(html) && !/<article/.test(html));
ck('F5d quick picks are user choices only (data-amount within 10..100000), no totals/raised literals in JS',
  [...html.matchAll(/data-amount="(\d+)"/g)].every((m) => +m[1] >= 10 && +m[1] <= 100000) &&
  !/(raised|goal|totalReceived|available)\s*[:=]\s*\d/.test(code));
ck('F5e recentActivity (donor identities) is never rendered', !/\.recentActivity\b/.test(code));

/* F6 */
const thanks = [...code.matchAll(/Thank you — your donation/g)].length;
const doneCalls = [...code.matchAll(/\bdone\(/g)].length;   /* definition + the single call */
const fnDone = code.match(/function done\(r\) \{[\s\S]*?\n  \}/);
ck('F6 the donation thank-you exists exactly once, inside done()', thanks === 1 && fnDone && /Thank you — your donation/.test(fnDone[0]));
ck("F6b done() is called once, only when status === 'completed'", doneCalls === 2 && /if \(s === 'completed'\) return done\(r\);/.test(code));
ck("F6c 'review' / 'pledged' never reach done(); polling is bounded",
  /var POLL_EVERY = 3000, POLL_MAX = 40;/.test(code) && /if \(n \+ 1 >= POLL_MAX\)/.test(code) && !/review'\) return done|pledged'\) return done/.test(code));
ck('F6d no success text before the server answers the testimonial (r.ok checked first)',
  /if \(!r \|\| !r\.ok\) throw \{ code: 'internal' \};\s*setStatus\(\$\('tsStatus'\), 'Thank you — our team reviews every story before it appears\.'/.test(code));

/* F7 — every  ' + <expr> + '  segment: strip safe wrappers and literals; what remains may use a data
   field only as a condition. Same method as scripts/test-financial-partner-page.js. */
function concatOffenders(src, safeNames, skipRe) {
  const SAFE_CALL = new RegExp('\\b(' + safeNames.join('|') + ')\\((?:[^()]|\\((?:[^()]|\\([^()]*\\))*\\))*\\)', 'g');
  const out = [];
  for (const m of src.matchAll(/'\s*\+\s*([^;]+?)\s*\+\s*'/g)) {
    const raw = m[1].trim();
    /* no skip for raw that starts with a literal: LIT + r.title is still a raw read (sabotage S1) */
    if (skipRe && skipRe.test(raw)) continue;
    let e = raw.replace(SAFE_CALL, 'SAFE').replace(/'(?:[^'\\]|\\.)*'/g, 'LIT');
    e = e.replace(/[\w.\[\]]+\s*(===|!==)\s*[\w.']+/g, 'COND')
         .replace(/[\w.]+\.(length|indexOf\([^)]*\))/g, 'COND')
         .replace(/[\w.!()]+\s*\?/g, 'COND ?')
         .replace(/\.(map|filter|slice|join)\(/g, '(');
    const reads = (e.match(/\b[A-Za-z_]\w*\.[A-Za-z_]\w*\b/g) || []).filter((x) => !/^(SAFE|LIT|COND)\b/.test(x));
    if (reads.length) out.push(raw.slice(0, 140));
  }
  return out;
}
const fOff = concatOffenders(codeN, ['esc', 'safeUrl', 'mediaHtml', 'storyCard', 'encodeURIComponent', 'money'],
  /^(rows|camps|T\.files)\b/);
ck('F7 foundation.js: every concatenated server value is escaped', fOff.length === 0, fOff);
/* licenceLine() returns plain TEXT (escaped at every use — asserted in B4d), so it is not an HTML builder */
const bOff = concatOffenders(bkCodeN.replace(/function licenceLine\(l\) \{[\s\S]*?\n  \}/, ''), ['esc', 'safeUrl', 'list', 'emptyHtml', 'card', 'storyCard', 'encodeURIComponent', 'typeLabel', 'label', 'hoursText'],
  /^(rows|services|items)\b/);
ck('F7b banking-hub.js: every concatenated server value is escaped', bOff.length === 0, bOff);
ck('F7c no server URL reaches src/href/poster without safeUrl()',
  !/(src|href|poster)="' \+ (?!esc\((safeUrl|thumb|url|site)|encodeURIComponent)/.test(code + bkCode) &&
  /var url = safeUrl\(m\.url\), thumb = safeUrl\(m\.thumbUrl\);/.test(code));

/* F8 — run the real helpers */
const grab = (re, src) => { const m = src.match(re); if (!m) throw new Error('helper not found: ' + re); return m[1]; };
const ctx = {};
vm.runInNewContext(
  'var esc=' + grab(/var esc = (function \(v\) \{[\s\S]*?\n  \});/, js) + ';' +
  'var money=' + grab(/var money = (function \(n\) \{[^\n]*\});/, js) + ';' +
  'var MIN=10, MAX=100000;' + grab(/(function parseAmount\(raw\) \{[\s\S]*?\n  \})/, js) + ';' +
  'out={e:esc(\'<img src=x onerror="a">\\\'&\'), m:[money(null),money(undefined),money(NaN),money(0),money(1500)],' +
  'a:[parseAmount("9"),parseAmount("100001"),parseAmount("12.5"),parseAmount(""),parseAmount("1,000"),parseAmount("10"),parseAmount("100000"),parseAmount("-50")]};', ctx);
ck('F8 esc() neutralises markup and quotes', !/[<>"']/.test(ctx.out.e) && /&lt;img/.test(ctx.out.e), ctx.out.e);
ck('F8b money(): unknown → —, a real 0 → KES 0', ctx.out.m[0] === '—' && ctx.out.m[1] === '—' && ctx.out.m[2] === '—' && ctx.out.m[3] === 'KES 0', ctx.out.m);
const a = ctx.out.a;
ck('F8c amount is validated, never substituted (9/100001/12.5/""/-50 refused; 1,000→1000; bounds accepted)',
  a[0].err && a[0].value === undefined && a[1].err && a[2].err && a[3].err && a[7].err && a[4].value === 1000 && a[5].value === 10 && a[6].value === 100000, a);

/* F9 — transparency is VERIFIED-only (addendum 2026-10-03); run the real loadDashboard against fake answers */
ck('F9 labels: "Verified donations received" / "Verified donations available"; blanket "being reconciled" badge hidden by default',
  /Verified donations received<\/span><b id="trRecv">—</.test(html) && /Verified donations available<\/span><b id="trAvail">—</.test(html) &&
  /<p id="trBadgeWrap" hidden>/.test(html) && /<p class="muted" id="trRecon" hidden><\/p>/.test(html));
ck('F9b totalReceived (recorded, not proof of payment) is never rendered publicly', !/b\.totalReceived/.test(code));
async function dash(answer) {
  const els = {};
  const el = (id) => els[id] || (els[id] = { id, textContent: '', hidden: id === 'trBadgeWrap' || id === 'trRecon', innerHTML: '', addEventListener() {} });
  const c = { $: el, esc: (v) => String(v), money: null, call: () => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)), supportProgramme() {} };
  vm.createContext(c);
  vm.runInContext('money=' + grab(/var money = (function \(n\) \{[^\n]*\});/, js) + ';' + grab(/(function loadDashboard\(\) \{[\s\S]*?\n  \})/, js), c);
  c.loadDashboard();
  await new Promise((r) => setTimeout(r, 5));
  return { recv: el('trRecv').textContent, avail: el('trAvail').textContent, out: el('trOut').textContent, badge: el('trBadgeWrap').hidden, rec: el('trRecon').textContent, recHidden: el('trRecon').hidden };
}

/* F10 — processed story media */
const mctx = {};
vm.runInNewContext('var esc=' + grab(/var esc = (function \(v\) \{[\s\S]*?\n  \});/, js) + ';' +
  'var safeUrl=' + grab(/var safeUrl = (function \(u\) \{[^\n]*\});/, js) + ';' + grab(/(function mediaHtml\(m, title\) \{[\s\S]*?\n  \})/, js) +
  'out={v:mediaHtml({type:"video",contentType:"video/mp4",url:"https://x.test/v.mp4",thumbUrl:"https://x.test/p.webp"},"T"),' +
  'i:mediaHtml({type:"image",contentType:"image/webp",url:"https://x.test/i.webp",thumbUrl:"https://x.test/t.webp"},"T"),' +
  'bad:mediaHtml({type:"video",contentType:"video/mp4",url:"javascript:alert(1)"},"T"),' +
  'mis:mediaHtml({type:"image",contentType:"video/mp4",url:"https://x.test/v.mp4"},"T")};', mctx);
const mo = mctx.out;
ck('F10 video/mp4 renders <video preload="none" poster=thumbUrl><source type="video/mp4">; image/webp renders <img loading="lazy">; contentType wins over type; non-https refused',
  /^<video class="story-media" controls playsinline preload="none" poster="https:\/\/x\.test\/p\.webp" aria-label="Video: T"><source src="https:\/\/x\.test\/v\.mp4" type="video\/mp4"><\/video>$/.test(mo.v) &&
  /^<img class="story-media" loading="lazy" decoding="async" src="https:\/\/x\.test\/t\.webp"/.test(mo.i) && mo.bad === '' && /^<video/.test(mo.mis), mo);

/* F11 — ?pledge=<id> completes an EXISTING pledge (checkout's CHK_<orderId>) */
const fnLoadPledge = (code.match(/function loadPledge\(id\) \{[\s\S]*?\n  \}/) || [''])[0];
ck('F11 ?pledge is format-checked (PLG_|CHK_) and loaded via impactGetMyPledge({ pledgeId }) only when signed in',
  /var PLEDGE_RE = \/\^\(PLG\|CHK\)_\[A-Za-z0-9_-\]\{1,200\}\$\/;/.test(code) && /return p && PLEDGE_RE\.test\(p\) \? p : '';/.test(code) &&
  /call\('impactGetMyPledge', \{ pledgeId: id \}\)/.test(fnLoadPledge) && /if \(pid && !D\.existing\) \{ if \(currentUser\(\)\) loadPledge\(pid\); else pledgeSignIn\(\); \}/.test(code));
ck("F11b the wizard adopts the pledge ONLY when the server says status 'pledged' (own pledge; amount whole, 10..100000) — and never shows the thank-you there",
  /if \(r\.status !== 'pledged'\) \{[^\n]*return; \}/.test(fnLoadPledge) && fnLoadPledge.indexOf("r.status !== 'pledged'") < fnLoadPledge.indexOf('D.existing = {') &&
  /r\.amount < MIN \|\| r\.amount > MAX/.test(fnLoadPledge) && !/done\(|Thank you/.test(fnLoadPledge));
ck('F11c an existing pledge skips impactPledgeDonation and goes straight to createPaymentIntent({purpose:"donation", pledgeId}) → STK → poll',
  /if \(D\.existing\) \{[\s\S]{0,300}start = Promise\.resolve\(\{ pledgeId: D\.existing\.pledgeId, amount: D\.existing\.amount \}\);\s*\} else \{[\s\S]{0,400}start = call\('impactPledgeDonation', body\);\s*\}/.test(code) &&
  (code.match(/call\('impactPledgeDonation'/g) || []).length === 1 && /start\.then\(function \(r\) \{/.test(code));

/* B1 */
const bkLive = stripHtmlComments(bkHtml);
ck('B1 banking.html no longer loads sokoni-banking-pro.js and loads banking-hub.js',
  !/<script[^>]+sokoni-banking-pro\.js/.test(bkLive) && /<script src="banking-hub\.js" defer><\/script>/.test(bkLive));
const gone = ['wallet', 'dashboard', 'bnpl', 'merchant', 'invoices', 'payments', 'notifs', 'admin'];
const stillThere = gone.filter((n) => new RegExp("id=\"(tab|pane)-" + n + "\"|showTab\\('" + n + "'").test(bkLive));
ck('B1b fake tool tabs/panes/tiles removed (wallet, dashboard, bnpl, merchant, invoices, payments, notifs, admin) and no bell',
  stillThere.length === 0 && !/bkp-notif-bell"|bkp-notif-count/.test(bkLive.replace(/<style>[\s\S]*?<\/style>/g, '')), stillThere);
ck('B1c honest tiles: My Wallet + Payment History → wallet.html, Finance Dashboard → financial-os.html, Merchant Finance → loans',
  /href="wallet\.html">\s*<div class="qa-icon">💳<\/div><div class="qa-label">My Wallet/.test(bkLive) &&
  /href="wallet\.html">\s*<div class="qa-icon">🧾<\/div><div class="qa-label">Payment History/.test(bkLive) &&
  /href="financial-os\.html">\s*<div class="qa-icon">📊<\/div><div class="qa-label">Finance Dashboard/.test(bkLive) &&
  /showTab\('loans',this\)">\s*<div class="qa-icon">🏪<\/div><div class="qa-label">Merchant Finance/.test(bkLive) &&
  !/Buy Now Pay Later|>Invoices</.test(bkLive));
ck('B1d banking-hub.js keeps no localStorage', !/localStorage|sessionStorage/.test(bkCode));

/* B2 */
const FORBID = /\b(verified|licensed|licenced|cbk[\s-]*approved|regulator[\s-]*approved)\b/i;
const bkStrings = [...bkCodeN.matchAll(/'(?:[^'\\]|\\.)*'/g)].map((m) => m[0]).filter((s) => FORBID.test(s));
const bkVisible = bkLive.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<script>[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ');
ck('B2 banking-hub.js string literals never say verified / licensed / CBK-approved', bkStrings.length === 0, bkStrings);
ck('B2b banking.html visible text never says verified / licensed / CBK-approved', !FORBID.test(bkVisible), (bkVisible.match(FORBID) || [])[0]);
ck('B2c every partner card carries the fixed "Listed by SOKONI" badge; DIGITAL_LENDER carries the CBK-licence caution; Promoted only when promoted === true',
  /<span class="bkd-listed">Listed by SOKONI<\/span>/.test(bkCode) && /r\.institutionType === 'DIGITAL_LENDER' \? '<p class="bkd-warn">Check the lender\\'s CBK licence before borrowing\.<\/p>'/.test(bkCode) &&
  /r\.promoted === true \? '<span class="bkd-promo">Promoted<\/span>'/.test(bkCode));
ck('B2d partner website is https-only with rel=noopener', /var site = safeUrl\(r\.website\);/.test(bkCode) && /target="_blank" rel="noopener noreferrer"/.test(bkCode));
ck('B2e registration is labelled self-declared', /self-declared — not checked by SOKONI/.test(bkCode));

/* B3 */
const MAP = { loans: 'BUSINESS_FINANCE,BANK,MICROFINANCE,DIGITAL_LENDER', accounts: 'BANK', saccos: 'SACCO', insurance: 'INSURER',
  investments: 'INVESTMENT,FINANCIAL_ADVISER', mpesa: 'PAYMENT_PROVIDER', forex: 'FOREX', microfinance: 'MICROFINANCE',
  chamas: 'CHAMA', digital: 'DIGITAL_LENDER', advisers: 'ACCOUNTANT,FINANCIAL_ADVISER' };
const wrong = Object.keys(MAP).filter((k) => !new RegExp('id="pane-' + k + '"[^>]*data-types="' + MAP[k] + '"').test(bkLive) || !new RegExp('id="tab-' + k + '"').test(bkLive));
ck('B3 every category pane maps to the contract institution types and has a tab', wrong.length === 0, wrong);
ck('B3b Foundation tab + pane exist with Donate → foundation.html and Share your story',
  /id="tab-foundation"/.test(bkLive) && /id="pane-foundation"/.test(bkLive) && /href="foundation\.html#donate">💚 Donate</.test(bkLive) && /href="foundation\.html#share">Share your story</.test(bkLive));
ck('B3c empty state links business-apply.html?offer=financial&category=<TYPE>',
  /business-apply\.html\?offer=financial&amp;category=' \+ encodeURIComponent\(type\)/.test(bkCode) && /Apply to be listed/.test(bkCode));
ck('B3d directory loads lazily per pane (bk:pane event, loaded/loading guard) and failure is "not available", not "none"',
  /document\.addEventListener\('bk:pane'/.test(bkCode) && /if \(st\.loading \|\| \(st\.loaded && !more\)\) return;/.test(bkCode) &&
  /The directory isn't available right now/.test(bkCode) && /new CustomEvent\('bk:pane'/.test(bkHtml));
ck('B3e USSD banner is labelled external', /External — dial from your phone/.test(bkLive));

/* B4 — trust markers (contract addendum 2026-10-03), run against the real helpers */
const bctx = {};
vm.runInNewContext(
  'var esc=' + grab(/var esc = (function \(v\) \{[\s\S]*?\n  \});/, bkJs) + ';' +
  'var when=function(ms){return typeof ms==="number"&&ms>0?"3 Oct 2026":"—";};' +
  grab(/(function reviewedTag\(m, key\) \{[\s\S]*?\n  \})/, bkJs) + grab(/(function licenceLine\(l\) \{[\s\S]*?\n  \})/, bkJs) +
  'out={no:[reviewedTag({registrationReviewed:false,reviewBadge:{tooltip:"t"}},"a"),reviewedTag({registrationReviewed:"true"},"a"),reviewedTag(null,"a"),reviewedTag({featured:true,promoted:true},"a")],' +
  'yes:reviewedTag({registrationReviewed:true,reviewBadge:{label:"Registration reviewed by SOKONI",tooltip:"Not a <i>licence</i>"}},"c-u1\\"x"),' +
  'l:[licenceLine({status:"verified_against_register",issuingAuthority:"SASRA",checkedAt:5}),licenceLine({status:"expired",issuingAuthority:"SASRA",expiryDate:"2026-02-01"}),licenceLine({status:"not_found_on_register",issuingAuthority:"SASRA"}),licenceLine(null)]};', bctx);
const bo = bctx.out;
ck('B4 "Registration reviewed by SOKONI" ONLY when registrationReviewed === true (false / "true" / null / promoted-only → nothing)',
  bo.no.every((x) => x === ''), bo.no);
ck('B4b badge text exact; server tooltip on title + aria-describedby → visually-hidden text with a sanitised id; tooltip escaped',
  /^<span class="bkd-reviewed" title="Not a &lt;i&gt;licence&lt;\/i&gt;" aria-describedby="rv-c-u1x">Registration reviewed by SOKONI<\/span><span class="bkd-vh" id="rv-c-u1x">Not a &lt;i&gt;licence&lt;\/i&gt;<\/span>$/.test(bo.yes) &&
  /\.bkd-vh\{position:absolute;width:1px;height:1px;overflow:hidden/.test(bkHtml), bo.yes);
ck('B4c licence line: checked-against-register with date / expired with date / nothing for any other state',
  bo.l[0] === 'Licence checked against the SASRA register on 3 Oct 2026' && bo.l[1] === 'Licence expired (2026-02-01)' && bo.l[2] === '' && bo.l[3] === '', bo.l);
ck('B4d licenceLine() reaches markup only through esc(); cards and profile use the server markers (reviewedTag on r / mk), Featured only when featured === true',
  [...bkCode.matchAll(/licenceLine\(/g)].length === 3 && (bkCode.match(/esc\(lic\)/g) || []).length === 2 && !/\+ lic \+/.test(bkCode) &&
  /reviewedTag\(r, 'c-' \+ uid\)/.test(bkCode) && /reviewedTag\(mk, 'p-' \+ uid\)/.test(bkCode) &&
  /var mk = \(r && typeof r\.registrationReviewed === 'boolean'\) \? r : base;/.test(bkCode) &&
  /r\.featured === true \? '<span class="bkd-featured">Featured<\/span>'/.test(bkCode));
ck('B4e "Listed by SOKONI" kept on cards and profile; reviewed registration never described as a regulator approval',
  (bkCode.match(/<span class="bkd-listed">Listed by SOKONI<\/span>/g) || []).length === 2 && /not a regulator\\'s approval/.test(bkCode));

(async () => {
  const a1 = await dash({ balance: { verified: 12000, available: 9000, requiresReconciliation: 3500, totalReceived: 99999, totalDisbursed: 0 } });
  const a2 = await dash({ balance: { verified: 0, available: 0, requiresReconciliation: 0, totalReceived: 5000 } });
  const a3 = await dash({ balance: { available: 777, totalReceived: 99999, totalDisbursed: 100 } });
  const a4 = await dash(new Error('functions/not-found'));
  ck('F9c verified answer: received = verified, available = available; reconciliation line "Still being reconciled: KES n (not counted as received)" only when > 0',
    a1.recv === 'KES 12,000' && a1.avail === 'KES 9,000' && a1.out === 'KES 0' && a1.badge === true && a1.rec === 'Still being reconciled: KES 3,500 (not counted as received)' && a1.recHidden === false &&
    a2.recv === 'KES 0' && a2.avail === 'KES 0' && a2.recHidden === true && a2.rec === '', { a1, a2 });
  ck('F9d older answer without `verified`: received/available render — (never the unverified totals) and the "being reconciled" badge shows; failure → —',
    a3.recv === '—' && a3.avail === '—' && a3.badge === false && a3.recHidden === true && a4.recv === '—' && a4.avail === '—' && a4.out === '—', { a3, a4 });

  /* C — checkout donation honesty (2026-10-03) */
  const co = read('checkout.html');
  const upd = (co.match(/function updateTotals\(\)\{[\s\S]*?\n\}/) || [''])[0];
  ck('C1 the donation is NOT added to the order total (updateTotals never reads the toggle or the amount); server total still wins',
    upd.length > 500 && !/_impactAmt|coImpactToggle/.test(upd) && !/orderTotal\s*\+=\s*_impactAmt/.test(co) && /if \(_serverTotalOverride != null\) orderTotal = _serverTotalOverride;/.test(upd));
  ck('C2 copy says the donation is separate, after the order — never "added to your order total"',
    !/will be added to your order total|will be donated to SOKONI Impact|Add to your order to support/.test(co) &&
    (co.match(/After your order, you can complete a separate donation/g) || []).length === 2 && /you can complete a separate donation to SOKONI Foundation/.test(co));
  const cta = (co.match(/function _showDonationPledgeCta\(pledgeId, amt\) \{[\s\S]*?\n\}/) || [''])[0];
  ck('C3 impactCheckoutDonate payload unchanged; the "Complete your donation" link appears ONLY after the server confirms a CHK_ pledge with status pledged',
    /window\.httpsCallable\(window\.firebaseFunctions, 'impactCheckoutDonate'\)\(\{\s*amount: _impactAmt, orderId, destination: impactDest, type: 'checkout',\s*\}\)\.then\(\(res\) => \{/.test(co) &&
    /if \(!d \|\| d\.ok !== true \|\| d\.skipped \|\| d\.status !== 'pledged' \|\| !\/\^CHK_\[A-Za-z0-9_-\]\{1,128\}\$\/\.test\(pid\)\) return;\s*_showDonationPledgeCta\(pid,/.test(co) &&
    (co.match(/_showDonationPledgeCta\(/g) || []).length === 2);
  ck('C4 the link is foundation.html?pledge=<encoded id>, built with DOM APIs (textContent, no innerHTML)',
    /a\.href = 'foundation\.html\?pledge=' \+ encodeURIComponent\(pledgeId\) \+ '#donate';/.test(cta) && /Complete your KES ' \+ amt\.toLocaleString\(\) \+ ' donation'/.test(cta) &&
    !/innerHTML|insertAdjacentHTML/.test(cta) && /textContent/.test(cta));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
