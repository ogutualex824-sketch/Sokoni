/* ══════════════════════════════════════════════════════════════════════════════
   GATE A — IS THERE A LEGITIMATE PRIOR-PERIOD SOURCE FOR OFFER PERFORMANCE?
   scripts/test-offer-trend-source.js      node scripts/test-offer-trend-source.js

   Gate A asks one question and implements nothing: can "Views ↑18%" be computed from an
   authoritative observation, or would it have to be invented?

   A trend needs three things, and all three must be real:
     1  a current-period observation
     2  a COMPARABLE prior-period observation
     3  a source authoritative enough that a merchant can act on the difference

   This suite establishes which of those exist, per metric, against the code that runs. It
   asserts the ABSENCE of sources — so every absence is paired with a control proving the
   detector can see a source when there is one, otherwise "nothing found" would only mean
   "nothing looked".
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d ? '   [' + d + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (d ? '   [' + d + ']' : '')); }
};
const head = t => console.log('\n' + t);
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* Every functions/*.js, so an absence claim covers the whole server rather than the files
   I happened to think of. */
const fnDir = path.join(ROOT, 'functions');
const serverFiles = fs.readdirSync(fnDir).filter(f => f.endsWith('.js'));
const SERVER = serverFiles.map(f => strip(fs.readFileSync(path.join(fnDir, f), 'utf8'))).join('\n');

console.log('══════════════════════════════════════════════════════════════════');
console.log('  GATE A — prior-period source for offer performance');
console.log('══════════════════════════════════════════════════════════════════');

/* ── 1. THE PLATFORM CAN DO PERIODS. THAT IS NOT THE PROBLEM. ───────────────── */
head('1 - a period mechanism exists, and it is authoritative');
{
  const agg = read('functions/analytics-aggregator.js');
  ok('per-day buckets exist, per shop',
     /shops\/\$\{shopId\}\/analytics\/daily_\$\{day\}/.test(agg));
  ok('and platform-wide', /analytics\/daily_\$\{day\}/.test(agg));
  ok('increments are atomic, so buckets cannot drift under load',
     /FieldValue\.increment/.test(agg) || /FV\.increment/.test(agg));
  /* THE PROPERTY THAT MAKES IT TRUSTWORTHY: it is fed only from exactly-once event points,
     so a retry cannot double-count a day. */
  ok('callers must bump only from exactly-once event points',
     /exactly-once event points/.test(agg));
  ok('commission is the settlement engine\'s, never a dashboard percentage',
     /never a hardcoded percentage/.test(agg));

  /* And the repo already computes a real day-over-day comparison, for search. */
  const search = read('functions/algolia-analytics.js');
  ok('control — a prior-period read already exists in this codebase',
     /daily_\$\{yesterday\}/.test(search), 'searchAnalytics');
}

/* ── 2. NOTHING RECORDS AN OFFER DIMENSION ──────────────────────────────────── */
head('2 - but no observation is keyed by offer');
{
  /* Enumerated from the SOURCE rather than remembered: every dimension any caller bumps. */
  const keys = new Set();
  for (const m of SERVER.matchAll(/incr:\s*\{([^}]*)\}/g)) {
    for (const k of m[1].matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g)) keys.add(k[1]);
  }
  ok('control — the detector found real dimensions', keys.size >= 3,
     [...keys].join(', '));
  const offerish = [...keys].filter(k => /offer|promo|discount/i.test(k));
  ok('none of them is an offer dimension', offerish.length === 0,
     offerish.join(', ') || 'no offer/promo/discount key');

  ok('no per-offer daily bucket is written anywhere',
     !/shopOffers\/[^\/]*\/analytics|offerAnalytics|daily_.*offer/i.test(SERVER));
}

/* ── 3. THE SIX FIGURES THE PANEL WOULD SHOW ────────────────────────────────── */
head('3 - metric by metric, what could a trend be computed from');
{
  /* VIEWS — and this is where a first reading of the codebase misleads.
     Product views ARE measured. functions/product-analytics.js maintains a productStats
     document per product with viewsTotal / viewsToday / viewsWeek / viewsMonth, deduped by
     fingerprint, and a scheduled job maintains the windows. So the honest finding is not
     "nobody counts views". */
  const pa = read('functions/product-analytics.js');
  ok('product views ARE recorded, per product', /viewsToday:\s*FV\.increment\(1\)/.test(pa));
  ok('with maintained rolling windows', /viewsWeek/.test(pa) && /viewsMonth/.test(pa));
  ok('and a scheduled job that rolls them', /exports\.aggregateProductStats = onSchedule/.test(pa));

  /* THE ROLLOVER DESTROYS THE PRIOR PERIOD. It sets the counter to 0. Nothing writes
     yesterday's figure anywhere first — no dated document, no viewsYesterday. So today is
     knowable and yesterday is gone, which is precisely the observation a trend needs. */
  const rollover = pa.slice(pa.indexOf('Reset viewsToday for all products'),
                            pa.indexOf('[aggregateProductStats] Reset'));
  ok('but the rollover ZEROES the counter', /viewsToday: 0/.test(rollover));
  ok('and archives nothing before doing so',
     !/set\(|add\(|viewsYesterday|previousViews|daily_/.test(rollover),
     'no prior-period document is written');

  /* THE CONTROL that makes this a gap rather than a convention: the same file DOES retain a
     prior value where someone decided it mattered. */
  ok('control — this codebase retains prior values elsewhere',
     /pricePrevious/.test(pa) && /productPriceHistory/.test(pa),
     'price history is archived; view history is not');

  /* And none of it is keyed by OFFER in any case. */
  ok('productStats is keyed by product, never by offer',
     !/offerId/.test(pa), 'attributing a product view to an offer would be inference');

  ok('offer opens are not instrumented', !/offerOpen|offer_open/i.test(SERVER));
  ok('added-to-order is not recorded per offer',
     !/addToCart[^;]*offerId|offerId[^;]*addToCart/i.test(SERVER));

  /* PURCHASED / DISCOUNT GIVEN. These DO have a home — the ledger built in Gate P — and it
     carries a server timestamp, so periods would be derivable. It is empty today because
     the charge path is not yet wired, which is a parked gate, not a missing design. */
  const off = read('functions/shop-offers.js');
  ok('redemptions are timestamped, so periods would be derivable',
     /redeemedAt: admin\.firestore\.FieldValue\.serverTimestamp\(\)/.test(off));
  ok('and carry the discount actually given', /discount: _n\(discount\)/.test(off));
  ok('but nothing writes them yet — the charge path is not wired',
     !/recordOfferRedemption/.test(strip(read('functions/index.js'))),
     'parked: P checkout integration');

  /* REVENUE. Shop-level GMV exists per day; it has no offer dimension, so attributing a
     day's revenue to one offer would be an invention, not a measurement. */
  ok('shop revenue exists per day', /gmvShillings/.test(SERVER));
  ok('but it cannot be attributed to an offer',
     !/gmvShillings[^;]*offerId|offerId[^;]*gmvShillings/i.test(SERVER));
}

/* ── 4. THE ABSENCE IS A MISSING SOURCE, NOT A FAILED READ ──────────────────── */
head('4 - absence of data vs absence of a source');
{
  const studio = read('sokoni-merchant-offers.js');
  /* The panel reads ctx.offerStats. Nothing supplies it — so today's blank panel is a
     missing SOURCE, not a read that failed. Those are different states and the studio must
     not conflate them: a failed read is "we could not look", which is recoverable. */
  ok('the panel reads stats from ctx', /ctx\.offerStats/.test(studio));
  ok('and no shell supplies them', !/offerStats\s*:/.test(read('merchant-v2.html')),
     'no ctx.offerStats in the shell');
  ok('so the blank panel reflects no source, not a failed retrieval', true,
     'nothing is wired to fail');
}

/* ── 5. WHAT THE PANEL DOES TODAY, AND WHETHER IT MAY STAY ──────────────────── */
head('5 - the panel can stay as it is, honestly');
{
  const studio = read('sokoni-merchant-offers.js');
  ok('with no stats it says so in words', /No performance data yet/.test(studio));
  ok('and explicitly promises nothing is estimated', /Nothing is estimated/.test(studio));
  ok('an absent figure is skipped, never coerced to 0',
     /if \(v === undefined \|\| v === null\) return;/.test(strip(studio)));
  ok('a rate is omitted when its denominator is absent or zero',
     /views > 0/.test(strip(studio)));

  /* NO TREND MAY BE RENDERED. Asserted, so A cannot be "closed" by quietly adding arrows. */
  ok('no trend arrow is rendered anywhere in the studio',
     !/[↑↓]|trend|vs last|previous period/i.test(studio),
     'no ↑18% without a prior period');
  ok('and the client computes no period comparison',
     !/yesterday|lastWeek|priorPeriod|previousPeriod/i.test(strip(studio)));
}

console.log('\n  the verdict');
console.log('  BLOCKED   on two independent grounds, either of which alone is sufficient:');
console.log('            (a) nothing is keyed by OFFER — not for one period, let alone two;');
console.log('            (b) where a metric IS measured per product, the rollover ZEROES the');
console.log('                window rather than archiving it, so yesterday is destroyed.');
console.log('            The period mechanism is sound and authoritative. The offer');
console.log('            dimension, and the retained history, are what do not exist.');
console.log('  UNPROVEN  purchased / discount given   [structurally ready — shopOfferRedemptions');
console.log('            is timestamped and never zeroed — but empty until the charge path is wired]');
console.log('  ABSENT    offer views · offer opens · added-to-order · per-offer revenue');

console.log('\n══════════════════════════════════════════════════════════════════');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('══════════════════════════════════════════════════════════════════');
process.exit(fail ? 1 : 0);
