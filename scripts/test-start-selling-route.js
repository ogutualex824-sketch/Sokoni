#!/usr/bin/env node
/* "Start Selling" must reach "What are you offering?" — navigation regression test.
 *
 *   node scripts/test-start-selling-route.js
 *
 * No browser, no credentials: this asserts on the shipped markup and on the
 * Hosting config that decides how the destination resolves.
 *
 * THE FLOW
 *   Start Selling  →  /offer  (offer.html, "What Are You Offering?")
 *                        ├── Products  → seller.html
 *                        └── Services  → the Register My Business form (hub-register.js), category preselected
 *
 * THE REGRESSION
 * Seven acquisition CTAs pointed straight at `seller.html` — the seller
 * DASHBOARD — so a merchant who had not chosen products-or-services yet was
 * dropped into a back-office instead of the one page that asks the question.
 * `sell.html` still pointed at `/offer`, which is why the flow worked from one
 * entry point and not from the others.
 *
 * WHY A SOURCE-LEVEL TEST
 * These are static hrefs in markup and in innerHTML template strings; the
 * destination is decidable from the source, and a source test fails in CI
 * without a deploy. Every detector below is proven by a mutation that restores
 * the bad destination — see PART C.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 140) + ']' : ''));
  ok ? pass++ : fail++;
};

/* The canonical destination, in both spellings Hosting serves (cleanUrls). */
const CANONICAL = ['offer.html', '/offer', 'offer'];

/* Files carrying a generic "Start Selling" CTA. Generic = the visitor has not
   yet said whether they sell products or offer services, so the chooser is the
   only correct destination. */
const GENERIC_CTA_FILES = [
  'index.html', 'community.html', 'marketing.html',
  'script.js', 'category.js', 'sokoni-spotlight.js', 'sell.html',
];

/* Deliberately NOT generic — each has already answered the question, so each
   keeps its own destination. Listed, not silently skipped: if one of these ever
   becomes the front door, it has to be moved into the list above on purpose. */
const SCOPED_EXCEPTIONS = {
  'index.html:Start Selling Products': 'product-scoped → onboarding-seller.html',
  'seller-terms.html': 'reached only from the seller terms → /onboarding-seller',
  'digital-esoko.html': 'a separate product (digital goods) → digital-esoko-seller.html',
  'pos.html / pos-onboard.html / pos-checkout.html / pos-hardware-wizard.html':
    'in-app POS shift + hardware wizard — "Start Selling" opens the till, not onboarding',
};

/* Extract every anchor whose visible text contains "Start Selling", with its
   href — in markup and in innerHTML template strings alike. */
function startSellingLinks(src) {
  const out = [];
  const re = /<a\s+[^>]*href=(["'])([^"']+)\1[^>]*>([\s\S]{0,200}?)<\/a>/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const href = m[2];
    const text = m[3].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    if (/start selling/i.test(text)) out.push({ href, text });
  }
  return out;
}

const isCanonical = (href) => CANONICAL.includes(href.replace(/^\.\//, '').split('?')[0]);
/* "Start Selling Products" has already chosen products — scoped, not generic. */
const isScoped = (text) => /start selling\s+products/i.test(text);

/* ─────────────────────────────────────────────────────────────────────────────
   PART A — the destination exists and is the page it claims to be
   ────────────────────────────────────────────────────────────────────────── */
console.log('\nPART A — the "What are you offering?" destination\n');

const offer = fs.readFileSync(path.join(ROOT, 'offer.html'), 'utf8');

ck('A1  offer.html exists and IS the "What Are You Offering?" page',
  /<title>\s*What Are You Offering\?/i.test(offer));

ck('A2  it asks the question — both gates are present',
  /showScreen\('screen-product'\)/.test(offer) && /showScreen\('screen-service'\)/.test(offer));

ck('A3  the Products gate continues to the seller workspace',
  /href="seller\.html"/.test(offer));

/* The Services gate continues to the ONE canonical intake — the Register My Business form (hub-register.js) with the
   category preselected. It used to open the legacy provider.html?cat= intake, whose applications cannot be approved. */
ck('A4  the Service gate continues to the provider registration form (the canonical intake)',
  /data-reg-category="[a-z0-9-]*" onclick="return offerRegister\(/.test(offer) && /<script src="hub-register\.js"/.test(offer)
  && !/href="provider\.html\?cat=/.test(offer));

ck('A5  the chooser imposes no auth guard of its own (no bounce to login/home)',
  !/location\.(href|replace)\s*=\s*['"](login|index)/.test(offer));

/* An existing merchant must still have a direct way through. */
ck('A6  an existing merchant can skip the chooser ("Already have a dashboard?")',
  /Already have a dashboard\?/i.test(offer));

const fb = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
const hosting = Array.isArray(fb.hosting) ? fb.hosting[0] : fb.hosting;
ck('A7  cleanUrls is on, so /offer resolves to offer.html in production',
  hosting.cleanUrls === true, 'cleanUrls=' + hosting.cleanUrls);

ck('A8  offer.html is published (not in the Hosting ignore list)',
  !(hosting.ignore || []).some(p => p === 'offer.html' || p === '*.html'));

/* ─────────────────────────────────────────────────────────────────────────────
   PART B — every generic Start Selling CTA points at it
   ────────────────────────────────────────────────────────────────────────── */
console.log('\nPART B — Start Selling entry points\n');

function auditFile(file, src) {
  const bad = [];
  for (const link of startSellingLinks(src)) {
    if (isScoped(link.text)) continue;
    if (!isCanonical(link.href)) bad.push(`"${link.text}" → ${link.href}`);
  }
  return bad;
}

let totalLinks = 0;
for (const f of GENERIC_CTA_FILES) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const links = startSellingLinks(src).filter(l => !isScoped(l.text));
  totalLinks += links.length;
  const bad = auditFile(f, src);
  ck(`B1  ${f} → the chooser (${links.length} CTA${links.length === 1 ? '' : 's'})`,
    links.length > 0 && bad.length === 0, bad.join(' | '));
}

ck('B2  the front door is covered — at least 8 generic CTAs audited',
  totalLinks >= 8, totalLinks + ' links');

/* The dashboard must not be the front door anywhere we audit. */
ck('B3  no audited generic CTA lands on the seller dashboard',
  GENERIC_CTA_FILES.every(f =>
    auditFile(f, fs.readFileSync(path.join(ROOT, f), 'utf8'))
      .every(b => !/seller\.html/.test(b))));

console.log('\n  scoped exceptions (kept on purpose):');
for (const [k, why] of Object.entries(SCOPED_EXCEPTIONS)) console.log(`    ${k} — ${why}`);

/* ─────────────────────────────────────────────────────────────────────────────
   PART C — negative control: restore the bad destination, the test must fail
   ────────────────────────────────────────────────────────────────────────── */
console.log('\nPART C — mutation control\n');

const mutants = [
  {
    label: 'M1  index.html "Become a Seller" CTA back to seller.html',
    file: 'index.html',
    mutate: (s) => s.replace('<a href="offer.html" class="seller-visit-btn green-btn">',
      '<a href="seller.html" class="seller-visit-btn green-btn">'),
  },
  {
    label: 'M2  index.html footer CTA back to seller.html',
    file: 'index.html',
    mutate: (s) => s.replace('<a href="offer.html">➕ Start Selling</a>',
      '<a href="seller.html">➕ Start Selling</a>'),
  },
  {
    label: 'M3  empty-catalogue CTA (script.js) back to seller.html',
    file: 'script.js',
    mutate: (s) => s.replace('<a href="offer.html" style="padding:13px 28px',
      '<a href="seller.html" style="padding:13px 28px'),
  },
  {
    label: 'M4  spotlight "Become a Seller" card back to seller.html',
    file: 'sokoni-spotlight.js',
    mutate: (s) => s.replace("<a href=\"offer.html\" class=\"seller-visit-btn green-btn\">",
      "<a href=\"seller.html\" class=\"seller-visit-btn green-btn\">"),
  },
  {
    label: 'M5  a CTA pointed at onboarding-seller.html instead of the chooser',
    file: 'community.html',
    mutate: (s) => s.replace('<a href="offer.html" style="display:block', '<a href="onboarding-seller.html" style="display:block'),
  },
];

for (const mu of mutants) {
  const original = fs.readFileSync(path.join(ROOT, mu.file), 'utf8');
  const mutated = mu.mutate(original);
  if (mutated === original) { ck(mu.label + ' → mutation applied', false, 'no-op replace — the anchor moved'); continue; }
  const caught = auditFile(mu.file, mutated).length > 0;
  ck(mu.label + ' → detected', caught, caught ? '' : 'mutation produced NO violation');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
