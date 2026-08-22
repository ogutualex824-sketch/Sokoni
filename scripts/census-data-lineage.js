/* CENSUS — data lineage for financial and identity metrics.  READ-ONLY.
   ==========================================================================
   Run:  node scripts/census-data-lineage.js
         node scripts/census-data-lineage.js --json > docs/data-lineage.json
         node scripts/census-data-lineage.js --page seller-analytics.html

   RELEASE B, first pass. It changes nothing and recommends nothing. It answers one
   mechanical question per page:

       Which files can execute here, and what do THEY read?

   ── WHY THE SCRIPT GRAPH, NOT A GREP ──────────────────────────────────────
   The role census got this wrong twice and both times the error looked like a
   finding. admin-os.html was recorded as "mounts nothing" because the call lives in
   sokoni-aos.js, one file away. sokoni-nav-engine was recorded as loading on 8
   pages because that is how many carry a static <script> tag — at runtime
   shared-header INJECTS it on every page it runs on, roughly 180.

   So a page's surface is not its own text. It is:

       its own <script src>  +  what shared-header injects  +  (recorded) inline code

   ── WHAT THIS TOOL WILL NOT DO ────────────────────────────────────────────
   It fills the columns it can establish mechanically and LEAVES THE REST EMPTY.
   CALCULATION and AUTHORITATIVE? are adjudications, not extractions; a tool that
   guessed them would produce a matrix that looks complete and cannot be trusted —
   which is the exact failure mode this whole programme exists to remove.

   Emitted per page: the executable graph, the collections and callables reachable
   from it, the localStorage keys it reads, and flagged literal candidates.
   Classification is applied only where the evidence is unambiguous.
==========================================================================*/
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const JSON_OUT = process.argv.includes('--json');
const ONE_PAGE = (() => {
  const i = process.argv.indexOf('--page');
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : null;
})();

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  if (!JSON_OUT) console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

/* ── shared-header's own exclusion list, and what it injects ───────────────
   Kept in step with the file it mirrors. Both spellings, because cleanUrls serves
   /messages and the lists are written with .html — the trap that made NO_SEARCH
   silently never match in production. */
const EXCLUDED = ['pos', 'seller', 'login', 'signup', 'register', 'success', 'offline',
  'profile', 'ecc', 'wap', 'gip', 'platform', 'sasos-admin', 'pos-kiosk',
  'monitor', 'moderation', 'verification-admin'];
const INJECTED = ['sw-register.js', 'sokoni-permissions.js', 'sokoni-role-authority.js',
  'sokoni-nav-engine.js'];

/* Canonical financial/identity stores. Naming one here is NOT a claim that a page
   using it is correct — only that the read reaches a real collection. */
const CANONICAL = ['orders', 'commissionLedger', 'walletTransactions', 'payoutRequests',
  'providerPayouts', 'subscriptions', 'posRetailSales', 'transactions', 'refunds',
  'users', 'sellerPerformance', 'products', 'inventory_products', 'posProducts',
  'ops_reports', 'funnelStats', 'feedback', 'healthSnapshots', 'productCounters'];

/* Naming a financial CONCEPT. Used for localStorage keys and for reading the report,
   never on its own to decide that a page displays money.

   TWO regexes on purpose. KES must stay CASE-SENSITIVE — case-insensitively it
   matches "Li-kes" in sokoniStoreLikes. The concept words must be CASE-INSENSITIVE,
   because splitting camelCase yields "Commission" with a capital C, and a single
   case-sensitive expression silently matched nothing at all: the finding list went
   from seven rows to zero and looked like good news. */
const MONEY_CURRENCY = /\bKES\b/;
const MONEY_WORDS = /\brevenue\b|\bcommissions?\b|\bpayouts?\b|\bearnings\b|\bbalance\b|\bgross\b|\bprofit\b|\bturnover\b|\bnet (?:revenue|amount|total|payout|earnings)\b|\bseller net\b/i;

/* Keys and identifiers are camelCase or snake_case; word boundaries do not exist
   inside them. sokoniCommissionLedger — the very key this list is meant to catch —
   was missed for that reason. Split on case and underscore first, then match.

   Bare "net" is deliberately NOT a money word: it matched spp_net_printers once the
   underscore became a space. It counts only in a compound that actually names money. */
function moneyish(s) {
  const words = String(s)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ');
  return MONEY_CURRENCY.test(words) || MONEY_WORDS.test(words);
}
const MONEY_HINT = { test: moneyish };

/* ── DISPLAYS a money figure ───────────────────────────────────────────────
   The first version tested MONEY_HINT against the whole page, which counted the word
   "revenue" in an about-page paragraph and a CSS class called .net-balance. It
   reported 276 of 330 pages as money surfaces and 141 of them as having no source —
   a finding list that large is the instrument, not the platform.

   This instead requires a money figure to be WRITTEN somewhere: a currency string or
   a currency format call landing in the DOM, or KES rendered next to a value in
   markup. Still imprecise, and deliberately reported as CANDIDATES. */
const RENDERS_MONEY = [
  /(?:textContent|innerHTML|innerText)\s*=[^\n]{0,160}(?:KES|toLocaleString\(|toFixed\(\s*2)/,
  /KES\s*[$\{<]/,
  />\s*KES\s*[\d$\{]/,
  /format(?:Money|Currency|Price)\s*\(/i,
];
function rendersMoney(src) { return RENDERS_MONEY.some(re => re.test(src)); }

function read(f) { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { return ''; } }

/* Comments are stripped before signal extraction: a detector that matches prose
   reports the documentation of a defect as the defect. That has happened here —
   a retirement proof matched its own explanatory comment. */
function strip(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

function signals(src) {
  const s = strip(src);
  const grab = (re, g = 1) => {
    const out = new Set(); let m;
    while ((m = re.exec(s)) !== null) out.add(m[g]);
    return [...out];
  };
  return {
    /* BOTH SDK SPELLINGS. The first version required the name to be the FIRST
       argument — collection("orders") — and so missed every modular call,
       collection(db, "orders"), which is exactly what the analytics pages use.
       seller-analytics.html reads collection(db,'orders') on line 459 and the census
       reported it as reaching no canonical collection at all. A detector that cannot
       see the dominant call shape reports a platform-wide absence of sources.
       doc(db, "col", id) and collectionGroup are counted for the same reason. */
    collections: [...new Set([
      ...grab(/\bcollection\(\s*(?:[A-Za-z0-9_$.]+\s*,\s*)?["'`]([A-Za-z0-9_]+)["'`]/g),
      ...grab(/\bcollectionGroup\(\s*(?:[A-Za-z0-9_$.]+\s*,\s*)?["'`]([A-Za-z0-9_]+)["'`]/g),
      ...grab(/\bdoc\(\s*[A-Za-z0-9_$.]+\s*,\s*["'`]([A-Za-z0-9_]+)["'`]\s*,/g),
    ])],
    callables:   grab(/httpsCallable\(\s*[A-Za-z0-9_$]+\s*,\s*["'`]([A-Za-z0-9_]+)["'`]/g),
    localStorage: grab(/localStorage\.getItem\(\s*["'`]([^"'`]+)["'`]/g),
    /* A numeric literal on the same line as a money/percent word, inside an
       assignment to something that renders. Candidates only — a threshold constant
       and a fabricated figure look identical to a regex, so these are FLAGGED for
       adjudication, never classified automatically. */
    literalLines: s.split('\n').map((ln, i) => ({ ln: ln.trim(), n: i + 1 }))
      .filter(o => MONEY_HINT.test(o.ln)
                && /[=:]\s*-?\d[\d_,.]*\s*[;,)]/.test(o.ln)
                && !/\b(length|index|limit|timeout|max|min|width|height|z-?index)\b/i.test(o.ln))
      .slice(0, 6),
  };
}

/* ── page -> executable graph ─────────────────────────────────────────────── */
const pages = fs.readdirSync(ROOT).filter(f => /\.html$/.test(f)).sort();
const fileCache = new Map();
function sigOf(f) {
  if (!fileCache.has(f)) fileCache.set(f, signals(read(f)));
  return fileCache.get(f);
}

const rows = [];
for (const p of pages) {
  if (ONE_PAGE && p !== ONE_PAGE) continue;
  const html = read(p);
  if (!html) continue;

  const own = [...new Set(
    [...html.matchAll(/<script[^>]+src=["']\.?\/?([A-Za-z0-9._\-/]+\.js)["']/g)].map(m => m[1])
  )].filter(f => fs.existsSync(path.join(ROOT, f)));

  const key = p.replace(/\.html$/, '');
  const hasHeader = /shared-header\.js/.test(html);
  const noHeader = /data-no-header\s*=\s*["']true["']/.test(html) || EXCLUDED.includes(key);
  const injected = (hasHeader ? INJECTED : []).filter(f => fs.existsSync(path.join(ROOT, f)));

  const graph = [...new Set([...own, ...injected])];

  /* Inline code counts too — it is where fabricated figures have actually lived. */
  const inlineSig = signals(html);

  const agg = { collections: new Set(), callables: new Set(), localStorage: new Set(),
                literalSites: [] };
  for (const f of graph) {
    const s = sigOf(f);
    s.collections.forEach(c => agg.collections.add(c));
    s.callables.forEach(c => agg.callables.add(c));
    s.localStorage.forEach(c => agg.localStorage.add(c));
    if (s.literalLines.length) agg.literalSites.push({ file: f, hits: s.literalLines.length });
  }
  inlineSig.collections.forEach(c => agg.collections.add(c));
  inlineSig.callables.forEach(c => agg.callables.add(c));
  inlineSig.localStorage.forEach(c => agg.localStorage.add(c));
  if (inlineSig.literalLines.length) {
    agg.literalSites.push({ file: p + ' (inline)', hits: inlineSig.literalLines.length,
                            lines: inlineSig.literalLines });
  }

  /* THE PAGE'S OWN markup and inline code ONLY.
     Testing the whole graph made all 330 pages money surfaces, because shared-header
     renders a cart total and it is on nearly every page. That is a property of the
     MODULE, not evidence about this page's metrics — attributing a shared module's
     behaviour to every page that loads it is how a census manufactures a finding for
     every row at once. */
  const showsMoney = rendersMoney(html);
  const canonicalHit = [...agg.collections].filter(c => CANONICAL.includes(c));

  /* Classification ONLY where the evidence is unambiguous. Everything else is
     UNADJUDICATED — an honest empty cell, not a guess. */
  /* A page can legitimately compute a figure from data the USER supplied — a cart
     total from cart lines is derived, not invented. That is not the same as a page
     that renders money with nothing behind it, and the two must not share a label. */
  const readsClientStore = agg.localStorage.size > 0;
  let cls;
  if (!showsMoney) cls = 'n/a';
  else if (canonicalHit.length || agg.callables.size) cls = 'UNADJUDICATED';
  else if (readsClientStore) cls = 'CLIENT-DERIVED-CANDIDATE';
  else cls = 'NO-SOURCE-REACHABLE';

  rows.push({
    page: p, showsMoney, header: hasHeader, noHeader,
    graphSize: graph.length, graph,
    collections: [...agg.collections].sort(),
    canonical: canonicalHit.sort(),
    callables: [...agg.callables].sort(),
    localStorage: [...agg.localStorage].sort(),
    literalSites: agg.literalSites,
    classification: cls,
  });
}

/* ── CONTROLS ─────────────────────────────────────────────────────────────
   Without these the matrix is a list of confident-looking strings. */
if (!JSON_OUT) console.log('\n  DATA LINEAGE CENSUS  (read-only)\n\n  ── controls');

const cart = rows.find(r => r.page === 'cart.html');
ck('the graph includes what shared-header INJECTS, not just <script src>',
  !!cart && cart.graph.includes('sokoni-nav-engine.js'),
  cart ? cart.graphSize + ' files on cart.html' : 'cart.html not scanned');

const sellerAnalytics = rows.find(r => r.page === 'seller-analytics.html');
ck('a known money page reaches a CANONICAL collection (not merely any callable)',
  !!sellerAnalytics && sellerAnalytics.canonical.length > 0,
  sellerAnalytics
    ? 'canonical=' + JSON.stringify(sellerAnalytics.canonical)
      + ' callables=' + JSON.stringify(sellerAnalytics.callables)
    : 'not scanned');

/* POSITIVE CONTROL for the literal detector, against a defect already CONFIRMED by
   reading the source: _costEfficiency() returns hardcoded constants. If the detector
   cannot see a known fabrication, its silence elsewhere means nothing. */
const ph = signals(read('functions/platform-health.js'));
ck('the literal detector finds the KNOWN fabrication in _costEfficiency()',
  ph.literalLines.length > 0,
  ph.literalLines.length + ' candidate line(s) in functions/platform-health.js');

const about = rows.find(r => r.page === 'about.html');
ck('CONTROL a prose page is NOT counted as a money surface',
  !about || about.showsMoney === false,
  about ? 'about.html showsMoney=' + about.showsMoney : 'about.html not scanned');

ck('the scanner does not classify itself',
  !rows.some(r => /census|scripts\//.test(r.page)), '');

if (JSON_OUT) {
  console.log(JSON.stringify({ generated: 'census-data-lineage', total: rows.length, rows }, null, 2));
  process.exit(fail ? 1 : 0);
}

/* ── report ───────────────────────────────────────────────────────────────── */
const money = rows.filter(r => r.showsMoney);
console.log('\n  ── ' + rows.length + ' pages scanned, ' + money.length + ' display money or a percentage');
const tally = money.reduce((a, r) => { a[r.classification] = (a[r.classification] || 0) + 1; return a; }, {});
Object.keys(tally).sort().forEach(k => console.log('     ' + k.padEnd(22) + tally[k]));

const noSource = money.filter(r => r.classification === 'NO-SOURCE-REACHABLE');
console.log('\n  ── money shown with NO canonical collection and NO callable reachable  ('
  + noSource.length + ')');
console.log('     These are where a displayed figure cannot have come from a record.');
for (const r of noSource.slice(0, 25)) {
  console.log('     ' + r.page.padEnd(34) + r.classification
    + (r.literalSites.length ? '  literals in ' + r.literalSites.length + ' file(s)' : ''));
}
if (noSource.length > 25) console.log('     … and ' + (noSource.length - 25) + ' more');

const lsMetric = money.filter(r => r.localStorage.some(k => MONEY_HINT.test(k)));
console.log('\n  ── money pages reading a MONEY-NAMED localStorage key  (' + lsMetric.length + ')');
for (const r of lsMetric.slice(0, 15)) {
  console.log('     ' + r.page.padEnd(34)
    + JSON.stringify(r.localStorage.filter(k => MONEY_HINT.test(k))));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
console.log('\n  READ-ONLY. It reports what each page CAN reach, never what it displays or');
console.log('  whether that display is right. CALCULATION, AUTHORITATIVE? and WRITER are');
console.log('  adjudications and are deliberately left for a human to fill.\n');
process.exit(fail ? 1 : 0);
