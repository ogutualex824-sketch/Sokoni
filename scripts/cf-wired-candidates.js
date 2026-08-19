/* ══════════════════════════════════════════════════════════════════════════════
   CF WIRED CANDIDATES — stage 3 of the selector
   ══════════════════════════════════════════════════════════════════════════════
   The pipeline is now three stages, and each may only DEFER or DISQUALIFY:

       select candidate -> structural exclusion -> semantic/security review
                        -> LIVE BEHAVIOUR REVIEW -> approve / defer / disqualify

   digital-hub passed the security review and was still deferred: no client
   callers, no traffic, and a documented defect in its paid path. Proving the
   dispatcher pattern against dormant code proves very little. This stage exists
   so that never happens again by accident.

   A module is WIRED when it has BOTH:
     * real callers   — a client file or another server module actually calls it
     * real traffic   — at least one operation above the traffic threshold

   The census threshold matters: run.googleapis.com/request_count counts Cloud
   Run internal deploy operations, so `hits <= 1` is NO evidence of traffic. The
   threshold is read from the census artefact, never hardcoded here.

   READ ONLY.
     node scripts/cf-wired-candidates.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');

const cls = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/cf-removal-classification.json'), 'utf8'));
const cen = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/cf-invocation-census.json'), 'utf8'));
const PROTECTED = new Set(cls.protectedAuthorities);
const THRESHOLD = Number(cen.coverage.trafficThreshold || 2);
const norm = (s) => String(s).toLowerCase().replace(/_/g, '-');
const hitsOf = (n) => Number(cen.counts[norm(n)] || 0);

/* Structural exclusions — identical to cf-slice-selector, kept in one shape. */
const DISQUALIFY = [
  { re: /secrets:\s*\[/, why: 'declares a secret — a dispatcher declares the UNION' },
  { re: /payment\.intasend\.com|sandbox\.intasend\.com|\/payouts\/|B2C|stkpush|daraja|mpesa/i,
    why: 'moves money or calls a payment provider' },
  { re: /must (?:be )?differ(?:ent)? from|approvedBy === uid|initiatedBy === uid/i,
    why: 'implements segregation of duties' },
];
const NAME_DISQUALIFY = /wallet|sfos|finos|commission|payment|payout|settle|subscri|sub-|billing|escrow|ledger|procurement|loyalty|entitle|product-limit|merchant-identity|impact|donat/i;

const byMod = {};
cls.records.forEach((r) => { (byMod[r.module] = byMod[r.module] || []).push(r); });

const rows = [];
for (const [mod, list] of Object.entries(byMod)) {
  if (list.length < 2) continue;
  let src = '';
  try { src = fs.readFileSync(path.join(FN, mod + '.js'), 'utf8'); } catch (_) { continue; }

  const reasons = [];
  if (list.some((r) => PROTECTED.has(r.name))) reasons.push('contains a protected authority');
  if (NAME_DISQUALIFY.test(mod)) reasons.push('named for money/subscription/authority');
  DISQUALIFY.forEach((d) => { if (d.re.test(src)) reasons.push(d.why); });
  if (reasons.length) continue;                       /* structurally excluded */

  const withTraffic = list.filter((r) => hitsOf(r.name) >= THRESHOLD);
  const totalHits = list.reduce((a, r) => a + hitsOf(r.name), 0);
  const clientRef = list.filter((r) => r.referencedByClient).length;
  const serverRef = list.filter((r) => r.referencedByServer).length;

  const wired = (clientRef > 0 || serverRef > 0) && withTraffic.length > 0;

  rows.push({
    mod, n: list.length, save: list.length - 1,
    clientRef, serverRef,
    opsWithTraffic: withTraffic.length, totalHits, wired,
  });
}

const wired = rows.filter((r) => r.wired).sort((a, b) => (b.save - a.save) || (b.totalHits - a.totalHits));
const dormant = rows.filter((r) => !r.wired).sort((a, b) => b.save - a.save);

console.log('\nCF WIRED CANDIDATES — stage 3 (live behaviour)');
console.log('='.repeat(86));
console.log('  traffic threshold : >= ' + THRESHOLD + ' requests   (hits <= 1 is deploy machinery)');
console.log('  window            : ' + cen.coverage.startTime + ' -> ' + cen.coverage.endTime);
console.log('  structurally eligible modules examined : ' + rows.length + '\n');

console.log('  WIRED — real callers AND real traffic');
console.log('  ' + 'MODULE'.padEnd(28) + 'onCall  saves  clientRef  serverRef  opsWithTraffic  requests');
console.log('  ' + '-'.repeat(82));
wired.slice(0, 18).forEach((r) => {
  console.log('  ' + r.mod.padEnd(28) + String(r.n).padStart(5) + String(r.save).padStart(7) +
    String(r.clientRef).padStart(11) + String(r.serverRef).padStart(11) +
    String(r.opsWithTraffic).padStart(15) + String(r.totalHits).padStart(10));
});

const wiredTotal = wired.reduce((a, r) => a + r.save, 0);
const dormantTotal = dormant.reduce((a, r) => a + r.save, 0);
console.log('');
console.log('  WIRED modules      : ' + wired.length + '   achievable saving ' + wiredTotal);
console.log('  DORMANT (deferred) : ' + dormant.length + '   nominal saving ' + dormantTotal +
            '  <- NOT counted as achievable');
console.log('  required reduction : 212');
console.log('');
console.log('  Both figures remain UPPER BOUNDS. A module is achievable only after it');
console.log('  survives the semantic/security contract review, which digital-hub passed');
console.log('  and was deferred anyway.');
console.log('='.repeat(86) + '\n');
