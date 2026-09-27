/* ============================================================================
   C2 — a subscription is platform revenue, not a 5% cut of someone else's sale
   scripts/test-subscription-commission-classification.js
   ============================================================================
   THE DEFECT THIS PROVES CLOSED

   RATES defines the intended treatment, and has all along:

       subscriptions: { pct: 100, fixedKES: 0,
                        _was: 'category only — full amount is platform revenue' }

   Plural. `subscriptions.html:362` — the ONLY sender — writes the SINGULAR
   "subscription", which matched neither RATES nor ALIASES, so resolveRate fell
   through to RATES.default and every subscription booked at 5%:

       KES 999 plan  ->  sokoniCut  KES  50      (should be 999)
                         providerNet KES 949      owed to NOBODY

   This is the same accident commission-config.js already documents about
   `product` ("5% by accident… mapping it deliberately is what makes the 5%
   intentional"), landing on the one category where it inverts the commercial
   meaning: SOKONI is the payee, not a commission-taker.

   WHAT IT IS NOT

   Not a payment loss. commissionLedger is not a settlement authority:
   `providerNet` is written once and never read (asserted below), and the
   collection/invoice modules key on billingModel/collectionStatus/sellerUid,
   none of which the webhook row carries. The wallet credit is separately
   refused by C1 (659a350). The established consequence is UNDER-REPORTED
   PLATFORM REVENUE in AdminOS, which reads commissionLedger.sokoniCut.

   ── WHY THIS SUITE DOES NOT REUSE C1's S1 ───────────────────────────────────
   After C2, sokoniCut === amount, so the webhook's _netCents === 0 and the
   `_netCents <= 0` branch would refuse the wallet credit even if C1's guard
   were broken. S1 can no longer discriminate. C1's authoritative evidence is
   its own certification at 659a350, run while the net was still ~95%. Case 5
   below asserts only the ORDERING that keeps C1 the authority.

   WHAT IS ASSERTED

     1  resolveRate('subscription') -> subscriptions, 100%, matched
     2  arithmetic: sokoniCut === amount, providerNet === 0, at several amounts
     3  REGRESSION: against the PRE-C2 config from git, EXACTLY ONE key's
        resolution changed. Every other category and alias is byte-identical.
     4  providerNet has no reader anywhere in functions/
     5  C1's guard is still the FIRST branch, so it — not the zero net —
        remains the reason a subscription is not credited
     6  the generated browser mirror agrees with the config

   Case 3 is the important one, and it derives its expectations from the
   previous commit rather than hardcoding rates. A literal rate in a test is a
   time bomb: it certifies the number someone typed, not the table.

   RUN  node scripts/test-subscription-commission-classification.js
   ========================================================================== */
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CFG  = path.join(ROOT, 'functions', 'commission-config.js');
const CC   = require(CFG);

let PASS = 0, FAIL = 0;
const FAILURES = [];
function ok(label, cond, detail) {
  if (cond) { PASS++; console.log('  PASS  ' + label); return true; }
  FAIL++; FAILURES.push(label + (detail ? '  — ' + detail : ''));
  console.log('  FAIL  ' + label + (detail ? '  — ' + detail : ''));
  return false;
}

(async () => {
  console.log('\nC2 — subscription commission classification\n' + '='.repeat(66));

  /* ---- 1  the mapping itself ------------------------------------------- */
  {
    const r = CC.resolveRate('subscription');
    ok('1 singular "subscription" now resolves', r.matched === true,
       'matched=' + r.matched);
    ok('1 it resolves to the subscriptions category', r.category === 'subscriptions',
       'got ' + r.category);
    ok('1 at the rate the table already specified', r.pct === CC.RATES.subscriptions.pct,
       'got ' + r.pct + ' vs RATES ' + CC.RATES.subscriptions.pct);
    ok('1 case-insensitive, like every other alias',
       CC.resolveRate('SUBSCRIPTION').category === 'subscriptions');
  }

  /* ---- 2  the arithmetic the webhook performs --------------------------- */
  {
    /* Mirrors finos-utils: commissionCents = round(cents * rate / 100). The rate
       is READ from the table, never typed here. */
    const rate = CC.resolveRate('subscription').pct;
    let allFull = true, allZero = true;
    for (const kes of [999, 2499, 9990, 1, 150000]) {
      const cents      = kes * 100;
      const commission = Math.round(cents * rate / 100);
      const net        = cents - commission;
      if (commission !== cents) allFull = false;
      if (net !== 0) allZero = false;
    }
    ok('2 sokoniCut === the full amount, at every tested price', allFull);
    ok('2 providerNet === 0, at every tested price', allZero);
    ok('2 a KES 999 plan now books KES 999, not KES 50',
       Math.round(99900 * rate / 100) === 99900,
       'got KES ' + Math.round(99900 * rate / 100) / 100);
  }

  /* ---- 3  REGRESSION vs the PRE-C2 config, derived from git ------------- */
  {
    /* PINNED, not HEAD. The first version of this read `HEAD:` and went RED the
       instant C2 was committed — HEAD then WAS the C2 commit, so the "before"
       config already carried the alias and the positive control below correctly
       refused to certify against it. A moving baseline is not a baseline.

       659a350 is C2's parent (the C1 landing): the last commit in which
       "subscription" was unmapped. If it ever becomes unreachable — a shallow
       clone, a rewritten history — this exits 2 rather than reporting a pass it
       cannot support. */
    const BASELINE = '659a350';
    let before = null, loadErr = null;
    try {
      const prev = execFileSync('git', ['show', BASELINE + ':functions/commission-config.js'],
        { cwd: ROOT, encoding: 'utf8', maxBuffer: 32e6 });
      const tmp = path.join(os.tmpdir(), 'cc-pre-c2-' + process.pid + '.js');
      fs.writeFileSync(tmp, prev, 'utf8');
      before = require(tmp);
      fs.unlinkSync(tmp);
    } catch (e) { loadErr = e.message; }

    if (!before) {
      console.error('  REGRESSION CONTROL UNAVAILABLE — could not load baseline config: ' + loadErr);
      console.error('  Refusing to report a pass without it.');
      process.exit(2);
    }

    /* Positive control: the previous config must NOT already resolve the key,
       or this comparison proves nothing. */
    ok('3 control — PRE-C2 config did NOT resolve "subscription"',
       before.resolveRate('subscription').matched === false,
       'pre-C2 matched=' + before.resolveRate('subscription').matched);

    /* Every key either config knows about, plus the sender's literal. */
    const keys = new Set([
      ...Object.keys(before.RATES), ...Object.keys(CC.RATES),
      ...Object.keys(before.ALIASES), ...Object.keys(CC.ALIASES),
      'subscription', 'product', 'default', 'nonsense_unmapped_key',
    ]);

    const changed = [];
    for (const k of keys) {
      const a = before.resolveRate(k), b = CC.resolveRate(k);
      if (a.pct !== b.pct || a.category !== b.category || a.matched !== b.matched
          || a.fixedKES !== b.fixedKES) {
        changed.push(k + ': ' + a.category + '/' + a.pct + ' -> ' + b.category + '/' + b.pct);
      }
    }
    ok('3 EXACTLY ONE resolution changed across ' + keys.size + ' keys',
       changed.length === 1, changed.join(' | ') || 'none changed');
    ok('3 and it is "subscription"',
       changed.length === 1 && /^subscription:/.test(changed[0]), changed[0]);
    ok('3 marketplace/product rate untouched',
       CC.resolveRate('product').pct === before.resolveRate('product').pct);
    ok('3 an unmapped key still falls to default, unchanged',
       CC.resolveRate('nonsense_unmapped_key').matched === false
       && CC.resolveRate('nonsense_unmapped_key').pct === before.RATES.default.pct);
  }

  /* ---- 4  providerNet is written, never read ----------------------------
     A first draft grepped the raw source and FAILED on index.js:7685 and :7708 —
     both PROSE, inside the block comments that explain this very field. The
     certification machinery was reading its own documentation as evidence.

     So comments are stripped by SYNTAX before searching. The stripper tracks
     string and template states, because a quote containing "/*" would otherwise
     blank real code and turn "no readers" into a vacuous pass. Both controls
     below exist to catch exactly that: the write site must survive stripping,
     and a known comment occurrence must not. */
  {
    function stripComments(src) {
      let out = '', i = 0;
      const n = src.length;
      while (i < n) {
        const c = src[i], d = src[i + 1];
        if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
        if (c === '/' && d === '*') {
          i += 2;
          while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
          i += 2; continue;
        }
        if (c === '"' || c === "'" || c === '`') {
          const q = c; out += c; i++;
          while (i < n) {
            if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
            out += src[i];
            if (src[i] === q) { i++; break; }
            i++;
          }
          continue;
        }
        out += c; i++;
      }
      return out;
    }

    const fnDir = path.join(ROOT, 'functions');
    const files = fs.readdirSync(fnDir).filter((f) => f.endsWith('.js'));
    let writeSites = 0;
    const readers = [];
    let strippedIndex = '';

    for (const f of files) {
      const code = stripComments(fs.readFileSync(path.join(fnDir, f), 'utf8'));
      if (f === 'index.js') strippedIndex = code;
      code.split('\n').forEach((line, k) => {
        if (!/providerNet\b/.test(line)) return;
        if (/providerNet:\s+amount - sokoniCut/.test(line)) { writeSites++; return; }
        /* A READ is a property access on a document, or a destructure of one.
           provider-ops.js declares a LOCAL `providerNetC` — a different name,
           and \b keeps it out. */
        if (/\.providerNet\b|\bproviderNet\s*[,}]/.test(line)) {
          readers.push(f + ':' + (k + 1) + '  ' + line.trim());
        }
      });
    }

    ok('4 control — the write site SURVIVES comment stripping', writeSites === 1,
       'found ' + writeSites);
    ok('4 control — stripping removed the prose that fooled the first draft',
       strippedIndex.length > 0 && !/merchant's net was written to/.test(strippedIndex));
    ok('4 commissionLedger.providerNet has NO reader — it is accounting, not a debt',
       readers.length === 0, readers.join(' | '));
  }

  /* ---- 5  C1 remains the authority, not the zero net -------------------- */
  {
    const idx = fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8');
    const gi  = idx.indexOf('const _isSubscription =');
    const bi  = idx.indexOf('if (_isSubscription) {', gi);
    /* the zero-net branch is its own arm since CHANGELOG 214 (the no-earner case became an UNATTRIBUTED hold) */
    const zi  = idx.indexOf('} else if (_netCents <= 0) {', gi);
    ok('5 the C1 guard still exists', gi !== -1 && bi !== -1);
    ok('5 it still reads the server-authored purpose',
       gi !== -1 && idx.slice(gi, idx.indexOf(';', gi)).includes('attribution.purpose'));
    ok('5 it is evaluated BEFORE the zero-net branch — C1, not C2, is the reason',
       bi !== -1 && zi !== -1 && bi < zi, 'guard@' + bi + ' zeroNet@' + zi);
  }

  /* ---- 6  the generated browser mirror agrees --------------------------- */
  {
    const mirror = fs.readFileSync(path.join(ROOT, 'sokoni-commission-rates.js'), 'utf8');
    ok('6 mirror carries the new alias', /subscription["']?\s*:\s*["']subscriptions["']/.test(mirror));
    ok('6 mirror still declares itself generated',
       /GENERATED FILE\. DO NOT EDIT/.test(mirror));
  }

  /* ---- 7  harness negative control -------------------------------------- */
  console.log('  -- harness negative control (the next line MUST read FAIL) --');
  const before7 = FAIL;
  ok('7 deliberately false assertion', false, 'expected');
  if (FAIL !== before7 + 1) {
    console.error('\n  HARNESS CANNOT DETECT FAILURE — refusing to report a pass.');
    process.exit(2);
  }
  FAIL--; FAILURES.pop(); PASS++;
  console.log('  PASS  7 harness detects failure (control retracted)');

  console.log('='.repeat(66));
  console.log('  passed ' + PASS + '   failed ' + FAIL);
  if (FAILURES.length) FAILURES.forEach((f) => console.log('   x ' + f));
  console.log(FAIL === 0
    ? '\n  C2 SUBSCRIPTION COMMISSION CLASSIFICATION: GREEN'
    : '\n  C2 SUBSCRIPTION COMMISSION CLASSIFICATION: RED');
  console.log('  Proves CLASSIFICATION only. No payout path was changed, and');
  console.log('  historical mis-booked rows are NOT backfilled by this.\n');
  process.exit(FAIL === 0 ? 0 : 1);
})().catch((e) => {
  console.error('\n  HARNESS CRASHED — ' + (e && e.stack ? e.stack.split('\n')[0] : e));
  process.exit(2);
});
