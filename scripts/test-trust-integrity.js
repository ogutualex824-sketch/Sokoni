#!/usr/bin/env node
'use strict';
/* ============================================================================
   Trust integrity — no fabricated metrics, ratings, reviews, verified claims or contacts
   ----------------------------------------------------------------------------
   CLAUDE.md "UI Data Integrity": no UI component may fabricate business metrics; unknown renders
   a neutral state, never an invented number. This suite pins the 2026-10-01 removals so they
   cannot quietly return, and executes the one remaining number writer.
     A  home page (index.html): the invented stats row, real institutions marked VERIFIED, the
        hardcoded "SOKONI VERIFIED" shops, count claims and the unlabelled earnings figure are gone
     B  script.js: no count floors (Math.max(n, 500/120)), no invented review fallback, no
        localStorage "reviews" presented as platform reviews; the stat writer (executed) renders
        only a real aggregate and never 0 / a floor / NaN
     C  hub pages + contacts (files listed in HUB_FILES): no fabricated testimonials, star strings,
        random metrics, placeholder phone numbers or the unrelated sokoni.co.ke domain
   node scripts/test-trust-integrity.js
   ============================================================================ */
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 300) : '')); } };
const src = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
/* strip HTML comments so explanatory comments that QUOTE the removed text don't count */
const noComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '');
const noJsComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1');

console.log('Trust integrity\n');
console.log('A. home page');
const idx = noComments(src('index.html'));
const gone = [
  ['A1 invented stats row (50K+ / 1,200+ / 500M+ / 4.9★)', /data-final="(50K\+|1,200\+|500M\+|4\.9★)"|>50K\+<|>1,200\+<|>500M\+</],
  ['A2 real institutions marked VERIFIED with invented reviews', /Nairobi Women's Hospital|Goodlife Pharmacy|Lancet Kenya|2,100 reviews|Dr\. Amina Hassan/],
  ['A3 hardcoded "SOKONI VERIFIED" featured shops with invented sales', /Kaspa Prints|4\.9 · 320 Sales|✓ SOKONI VERIFIED<\/div>/],
  ['A4 count claims ("Trusted by thousands", "Join 500+ sellers", "1,000+ products", "thousands of satisfied")', /Trusted by thousands|Join 500\+ sellers|1,000\+ products|thousands of satisfied buyers/],
  ['A5 unlabelled earnings figure (KES 800–2K/day) and "3× more buyer clicks"', /KES 800–2K\/day|3× more buyer clicks/],
];
for (const [label, re] of gone) ck(label + ' — absent', !re.test(idx), (idx.match(re) || [])[0]);
ck('A6 no element still animates a hardcoded data-count', !/class="sk-stat-num"[^>]*data-count=/.test(idx));
ck('A7 the real promoted-shops section (from seller boosts) is untouched', /id="featuredShopsSection"/.test(idx) && /id="featuredShopsGrid"/.test(idx));
ck('A8 the Healthcare and Sell entries still link to their hubs', /href="healthcare\.html" class="skh-see-all"/.test(idx) && /data-sk-merchant-entry href="seller\.html"/.test(idx));

console.log('\nB. script.js');
const sj = src('script.js');
const sjCode = noJsComments(sj);
ck('B1 no count floor Math.max(…, 500) / Math.max(…, 120)', !/Math\.max\([^)]*,\s*(500|120)\)/.test(sjCode), (sjCode.match(/Math\.max\([^)]*,\s*(500|120)\)/) || [])[0]);
ck('B2 no invented review fallback (FALLBACK_REVIEWS / "Brian K.")', !/FALLBACK_REVIEWS|"Brian K\."|Grace W\./.test(sjCode));
const lhr = (sjCode.match(/function loadHomepageReviews\(\)\{[\s\S]*?\n\}/) || [''])[0];
ck('B3 the homepage teaser no longer presents localStorage reviews as platform reviews', lhr && !/localStorage/.test(lhr) && !/reviewCard\(/.test(lhr), lhr.slice(0, 200));
ck('B4 no seller count computed over the loaded page', !/new Set\(products\.map\(p=>p\.sellerEmail\|\|p\.sellerName\)\)/.test(sjCode));
/* execute the one number writer */
const fnSrc = (sj.match(/function _sokoniRenderProductStat\(\) \{[\s\S]*?\n\}/) || [''])[0];
ck('B5 the product-stat writer exists (one writer)', !!fnSrc && sj.split('function _sokoniRenderProductStat(').length === 2);
if (fnSrc) {
  const run = (count, withEls = true) => {
    const els = { statProductCount: { textContent: '—' }, marketplaceStats: { style: { display: 'none' } } };
    const ctx = { window: { __sokoniProductCount: count }, document: { getElementById: (id) => (withEls ? els[id] || null : null) } };
    vm.createContext(ctx); vm.runInContext(fnSrc + '\n_sokoniRenderProductStat();', ctx);
    return { text: els.statProductCount.textContent, shown: els.marketplaceStats.style.display };
  };
  const r0 = run(undefined), rz = run(0), rn = run(NaN), r7 = run(7), rbig = run(1234);
  ck('B6 unknown count → stays hidden, shows "—" (never 0)', r0.shown === 'none' && r0.text === '—', r0);
  ck('B7 a zero/NaN count does not reveal the section', rz.shown === 'none' && rn.shown === 'none', { rz, rn });
  ck('B8 a real count renders exactly — no floor, no "+"', r7.text === '7' && r7.shown === 'flex' && !/\+/.test(rbig.text), { r7, rbig });
  let threw = null; try { run(5, false); } catch (e) { threw = e.message; }
  ck('B9 missing section on the page → no-op, no crash', threw === null, threw);
}

console.log('\nC. hub pages + contacts');
const HUB_FILES = ['healthcare.html', 'banking.html', 'cleaning.html', 'car-rental.html', 'marketing.html', 'trust.html',
  'b2b-seller-dashboard.html', 'support.html', 'onboarding-driver.html', 'invoice.html'];
for (const f of HUB_FILES) {
  if (!fs.existsSync(path.join(ROOT, f))) { ck('C? ' + f + ' exists', false); continue; }
  const h = noComments(src(f)), code = noJsComments(h);
  const hits = [];
  if (/\+?254\s?700\s?000\s?000|tel:\+254700000000/.test(h)) hits.push('placeholder phone');
  if (/(^|[^y])sokoni\.co\.ke/.test(h.replace(/mysokoni\.co\.ke/g, ''))) hits.push('sokoni.co.ke');
  if (/Math\.random\(\)\s*\*\s*\d+\)\s*\+\s*\d+/.test(code) && /txn|transaction|trust/i.test(f + code.slice(0, 0))) hits.push('random metric');
  if (/Sample providers data/.test(code)) hits.push('sample providers');
  if (/James M\. — Westlands Office/.test(h)) hits.push('invented testimonial');
  if (/18\+ Partner Banks|KES 500M\+ Loans|12,000\+ Businesses/.test(h)) hits.push('banking stats');
  ck('C ' + f + ' — no fabricated contact/metric/testimonial', hits.length === 0, hits);
}

console.log('\nD. service hubs, rider dashboard, marketing, provider wizard');
for (const f of ['electrical.html', 'plumbing.html', 'phone-repair.html']) {
  const h = noComments(src(f));
  const hits = [];
  if (/\d\.\d★/.test(h)) hits.push('hero/card rating');
  if (/class="[^"]*testimonial/i.test(h)) hits.push('testimonial section');
  if (/verified:\s*true/.test(h)) hits.push('verified:true in data');
  ck('D ' + f + ' — no invented ratings, testimonials or verified flags', hits.length === 0, hits);
}
const rdRaw = src('rider-dashboard.html');
const rd = noJsComments(noComments(rdRaw));
ck('D rider dashboard: no default perfect 5.0 for an unrated rider; says "No ratings yet"',
  !/(avgRating|\.rating)\s*(\|\||\?\?)[^;\n]*(\|\||\?\?)\s*5(\.0)?\s*\)/.test(rd) && !/>5\.0</.test(rd) && /No ratings yet/.test(rdRaw));
const mk = noJsComments(noComments(src('marketing.html')));
ck('D marketing: no random activity feed / fake stats (only the referral-code generator uses Math.random)',
  (mk.match(/Math\.random\(\)/g) || []).length <= 1 && !/refreshFeed|\+1247|\+5840/.test(mk), (mk.match(/Math\.random\(\)/g) || []).length);
const po = src('provider-onboarding.html');
ck('D provider wizard: "Submitted for Review" when the server reports approved:false; "You\'re Live!" only otherwise',
  /r\.data&&r\.data\.approved===false/.test(po) && /Submitted for Review/.test(po) && /function sSuccess\(pid, pending\)/.test(po));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
