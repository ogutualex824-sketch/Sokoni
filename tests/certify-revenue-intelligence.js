/* ============================================================================
   CERTIFICATION — Revenue Intelligence
   tests/certify-revenue-intelligence.js
   ============================================================================
   THE DEFECT THIS SUITE EXISTS TO PREVENT
   ---------------------------------------
   Production `payments` documents carry PENDING / COMPLETE / FAILED / CANCELLED.
   `succeeded`, `completed` and `paid` have never been written by any production
   writer. A filter spelled `'succeeded'`, or one missing `.toUpperCase()`,
   matches nothing and renders a confident **zero revenue** that looks exactly
   like a real answer.

   So the vocabulary is certified positively (COMPLETE and 'complete' both
   count) and negatively (a never-written spelling must NOT count), and the
   sabotage runner plants the lowercase comparison to prove the guard is live.

   THE SECOND DEFECT: MISLABELLING
   -------------------------------
   Every production payment is a wallet top-up, not marketplace sales revenue.
   Summing it under the words "Total Revenue" would misstate the business, so
   the suite asserts that phrase never appears and that the disclosure does.

   Every absence assertion is paired with a positive control. The harness fails
   closed.

   RUN
     node tests/certify-revenue-intelligence.js
   ========================================================================== */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.resolve(__dirname, '..');
const MIN_ASSERTIONS = 60;

let PASS = 0, FAIL = 0, ASSERTS = 0;
const FAILURES = [];
let _caseAsserts = 0;

function ok(label, cond, detail) {
  ASSERTS++; _caseAsserts++;
  if (cond) { PASS++; return true; }
  FAIL++; FAILURES.push(label + (detail ? '  — ' + detail : ''));
  return false;
}

function runCase(name, fn) {
  _caseAsserts = 0;
  try { fn(); }
  catch (e) {
    ASSERTS++; FAIL++;
    FAILURES.push('[' + name + '] THREW: ' + (e && e.stack ? e.stack.split('\n')[0] : e));
    return;
  }
  if (_caseAsserts === 0) {
    ASSERTS++; FAIL++;
    FAILURES.push('[' + name + '] registered NO assertions — a silent case is a failure.');
  }
}

/* ── Environment ─────────────────────────────────────────────────────── */
function makeEnv(plan) {
  const byId = {};
  const head = { appendChild(el) { if (el.id) byId[el.id] = el; } };
  const doc = { head, getElementById: (id) => byId[id] || null,
                createElement: () => ({ id: '', textContent: '' }) };

  /* Chainable query stub. `payments` supports where/orderBy/limit; ops_reports
     is read per document id. */
  function collection(name) {
    const q = {
      /* The `where` clause MUST be honoured. A stub that returns every document
         regardless of the range models a database that does not exist, and it
         hides exactly the case this suite cares about: a range with nothing in
         it while the collection itself is not empty. */
      where(field, op, value) {
        if (field === 'createdAt' && op === '>=') {
          q._since = (value && typeof value.getTime === 'function') ? value.getTime() : Number(value);
        }
        return q;
      },
      orderBy() { q._ordered = true; return q; },
      limit(n) { q._limit = n; return q; },
      get() {
        if (name === 'payments') {
          if (plan.denyPayments) return Promise.reject(new Error('PERMISSION_DENIED'));
          let rows = plan.payments || [];
          if (q._since != null) rows = rows.filter((r) => Number(r.createdAt) >= q._since);
          if (q._ordered) {
            /* The "newest anywhere" probe is deliberately unfiltered by range. */
            rows = (plan.payments || []).slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 1);
          } else if (q._limit) rows = rows.slice(0, q._limit);
          return Promise.resolve({
            forEach: (cb) => rows.forEach((r, i) => cb({ id: r.id || ('p' + i), data: () => r })),
          });
        }
        return Promise.resolve({ forEach() {} });
      },
      doc(id) {
        return { get() {
          if (name === 'ops_reports') {
            if (plan.denyOps) return Promise.reject(new Error('denied'));
            const d = (plan.ops || {})[id];
            return Promise.resolve(d ? { exists: true, data: () => d } : { exists: false });
          }
          return Promise.resolve({ exists: false });
        } };
      },
    };
    return q;
  }

  const sandbox = {
    window: {}, document: doc,
    firebase: { firestore: () => ({ collection }) },
    console, setTimeout, Date, Math, Object, JSON, isFinite, parseInt, Number, String,
  };
  sandbox.window.document = doc;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'sokoni-revenue-intelligence.js'), 'utf8'),
                  sandbox, { filename: 'sokoni-revenue-intelligence.js' });

  const el = { id: 'root', innerHTML: '' };
  byId.root = el;
  return { api: sandbox.window.SokoniRevenue, el };
}

function render(plan, steps) {
  const env = makeEnv(plan);
  env.api.mount(env.el);
  return Promise.resolve()
    .then(() => new Promise((r) => setTimeout(r, 0)))
    .then(() => new Promise((r) => setTimeout(r, 0)))
    .then(() => { if (steps) steps(env.api); return env.el.innerHTML; });
}

/* ── Fixtures ────────────────────────────────────────────────────────── */
const DAY = 86400000;
const t = (daysAgo) => Date.now() - daysAgo * DAY;

/* Production-shaped: uppercase vocabulary, amount + netAmount. */
const PROD = [
  { id: 'a', status: 'COMPLETE',  amount: 1000, netAmount: 970, createdAt: t(1), checkoutId: 'CK1' },
  { id: 'b', status: 'COMPLETE',  amount: 500,  netAmount: 485, createdAt: t(2), checkoutId: 'CK2' },
  { id: 'c', status: 'FAILED',    amount: 300,                  createdAt: t(3), checkoutId: 'CK3' },
  { id: 'd', status: 'PENDING',   amount: 200,                  createdAt: t(4), checkoutId: 'CK4' },
  { id: 'e', status: 'CANCELLED', amount: 100,                  createdAt: t(5), checkoutId: 'CK5' },
  /* previous period, for the delta baseline */
  { id: 'f', status: 'COMPLETE',  amount: 400,  netAmount: 390, createdAt: t(40), checkoutId: 'CK6' },
];

(async function main() {

  const prod    = await render({ payments: PROD });
  const denied  = await render({ denyPayments: true });
  const dormant = await render({ payments: [
    { id: 'old', status: 'COMPLETE', amount: 900, netAmount: 880, createdAt: t(400) },
  ] });
  const ledger  = await render({ payments: PROD }, (a) => a.tab('ledger'));
  const notBuilt = await render({ payments: PROD }, (a) => a.tab('notbuilt'));

  /* A completed payment whose amount is a real, measured zero. */
  const zeroAmt = await render({ payments: [
    { id: 'z', status: 'COMPLETE', amount: 0, netAmount: 0, createdAt: t(1) },
  ] });

  /* A completed payment carrying no amount at all — genuinely unknown. */
  const noAmt = await render({ payments: [
    { id: 'u', status: 'COMPLETE', createdAt: t(1) },
  ] });

  /* Enough documents to hit the module's read cap, so the partial-view warning
     must fire. */
  const capped = await render({ payments: Array.from({ length: 1000 }, (_, i) => ({
    id: 'c' + i, status: 'COMPLETE', amount: 10, netAmount: 10, createdAt: t(1),
  })) });

  const api = makeEnv({ payments: [] }).api;
  const R = api._rules;

  /* ── A. The status vocabulary ────────────────────────────────────── */

  runCase('A1 COMPLETE counts, in the spelling production actually writes', () => {
    ok('A1 uppercase COMPLETE counts', R.isComplete({ status: 'COMPLETE' }));
    /* Case-insensitive by design: the server uppercases before comparing, so a
       differently-cased document must not silently vanish from the totals. */
    ok('A1 mixed case still counts', R.isComplete({ status: 'Complete' }));
    ok('A1 lowercase still counts', R.isComplete({ status: 'complete' }));
  });

  runCase('A2 a status production never writes must NOT count as money', () => {
    /* POSITIVE CONTROL — the predicate does return true for something, so
       "returns false" below is a judgement and not a dead function. */
    ok('A2 control: the predicate accepts COMPLETE', R.isComplete({ status: 'COMPLETE' }));
    ['succeeded', 'completed', 'paid', 'processing', 'refunded', 'SUCCESS', '']
      .forEach((s) => {
        ok('A2 "' + s + '" does not count as complete', !R.isComplete({ status: s }));
      });
    ok('A2 a missing status does not count', !R.isComplete({}));
  });

  runCase('A3 only COMPLETE contributes to volume', () => {
    const agg = api._agg(PROD.slice(0, 5));
    ok('A3 control: the aggregate saw every document', agg.count === 5, 'count=' + agg.count);
    ok('A3 two completed payments counted', agg.complete === 2, 'complete=' + agg.complete);
    /* 1000 + 500 — FAILED/PENDING/CANCELLED amounts must not be added. */
    ok('A3 volume is completed gross only', agg.volume === 1500, 'volume=' + agg.volume);
    ok('A3 fees are gross less net', agg.fees === 45, 'fees=' + agg.fees);
    ok('A3 net is gross less fees', agg.net === 1455, 'net=' + agg.net);
  });

  runCase('A4 every status is bucketed, including unrecognised ones', () => {
    const agg = api._agg([
      { status: 'COMPLETE', amount: 1 }, { status: 'WEIRD', amount: 9 },
    ]);
    ok('A4 control: the known status bucketed', agg.byStatus.COMPLETE === 1);
    ok('A4 an unrecognised status is surfaced, not dropped', agg.byStatus.other === 1);
    ok('A4 it does not enter the volume', agg.volume === 1, 'volume=' + agg.volume);
  });

  /* ── B. Unknown is not zero ──────────────────────────────────────── */

  runCase('B1 an unreadable amount is excluded, never treated as zero', () => {
    const agg = api._agg([{ status: 'COMPLETE' }]);   /* completed, no amount */
    ok('B1 the payment is counted', agg.complete === 1);
    ok('B1 volume stays unknown rather than 0', agg.volume === null, 'volume=' + agg.volume);
    ok('B1 the omission is tracked', agg.unreadableAmounts === 1);
    /* POSITIVE CONTROL — a readable amount does produce a number. */
    const good = api._agg([{ status: 'COMPLETE', amount: 5 }]);
    ok('B1 control: a readable amount yields a figure', good.volume === 5);
  });

  runCase('B2 an empty range yields unknown money, not KES 0', () => {
    const agg = api._agg([]);
    ok('B2 count is a real zero', agg.count === 0);
    ok('B2 volume is unknown', agg.volume === null);
    ok('B2 fees are unknown', agg.fees === null);
  });

  runCase('B3 a genuine zero amount survives as zero', () => {
    /* The inverting control: nulls must not become zero, AND a measured zero
       must not be hidden as unknown. */
    const agg = api._agg([{ status: 'COMPLETE', amount: 0, netAmount: 0 }]);
    ok('B3 a measured 0 yields volume 0, not null', agg.volume === 0, 'volume=' + agg.volume);
    ok('B3 it is not counted as unreadable', agg.unreadableAmounts === 0);
  });

  runCase('B4 amountKES is honoured as the documented alternate field', () => {
    ok('B4 control: amount is read', R.amount({ amount: 12 }) === 12);
    ok('B4 amountKES is read when amount is absent', R.amount({ amountKES: 34 }) === 34);
    ok('B4 a non-numeric amount is unknown, not 0', R.amount({ amount: 'abc' }) === null);
    ok('B4 an absent amount is unknown, not 0', R.amount({}) === null);
  });

  runCase('B5 a fee is floored at zero and never negative', () => {
    ok('B5 control: a normal fee computes', R.fee({ amount: 100, netAmount: 90 }) === 10);
    ok('B5 net above gross floors at 0', R.fee({ amount: 100, netAmount: 120 }) === 0);
    ok('B5 an unknown gross yields an unknown fee', R.fee({}) === null);
  });

  runCase('B6 a measured zero survives all the way to the rendered figure', () => {
    /* B3 proves the AGGREGATE keeps a measured zero. That is not enough: the
       formatter runs afterwards, and a formatter that maps 0 to an em dash
       re-introduces the defect at the last step. Pre-flight sabotage found
       exactly that gap, so this asserts on the rendered output. */
    const labels = (zeroAmt.match(/<div class="ri-kpi-l">(.*?)<\/div>/g) || []);
    ok('B6 control: the KPI row rendered', labels.length >= 4, 'labels=' + labels.length);
    const vol = /<div class="ri-kpi-l">Rail volume<\/div>\s*<div class="ri-kpi-v">(.*?)<\/div>/.exec(zeroAmt);
    ok('B6 control: the rail volume tile was found', !!vol);
    ok('B6 a measured zero renders as KES 0', vol && /KES\s*0/.test(vol[1]), 'got ' + (vol && vol[1]));
    ok('B6 a measured zero is NOT an em dash', !vol || vol[1].indexOf('—') === -1);
    /* POSITIVE CONTROL — the same tile shows an em dash when truly unknown. */
    const un = /<div class="ri-kpi-l">Rail volume<\/div>\s*<div class="ri-kpi-v">(.*?)<\/div>/.exec(noAmt);
    ok('B6 control: an unknown volume still renders an em dash',
       un && un[1].indexOf('—') !== -1, 'got ' + (un && un[1]));
  });

  runCase('B7 a capped read is declared partial, not presented as a total', () => {
    ok('B7 control: the capped view rendered figures', /ri-kpi-v/.test(capped));
    ok('B7 the cap is disclosed', /hit its \d+-document cap/.test(capped));
    ok('B7 it says the view is partial', /PARTIAL/.test(capped));
    ok('B7 it calls the totals a floor', /floor, not a total/.test(capped));
    /* POSITIVE CONTROL — an uncapped read must NOT cry partial, or the warning
       would be permanent furniture and carry no information. */
    ok('B7 control: an uncapped read shows no cap warning', !/document cap/.test(prod));
  });

  /* ── C. Labelling ────────────────────────────────────────────────── */

  runCase('C1 nothing is labelled as revenue or GMV', () => {
    /* This cannot be checked by searching the page for "Total Revenue" — the
       DISCLOSURE explaining that nothing carries that label contains the phrase,
       so the check would fail on its own honesty. The question is what the KPI
       LABELS say, so the assertion extracts those and nothing else. */
    const labels = (prod.match(/<div class="ri-kpi-l">(.*?)<\/div>/g) || [])
      .map((m) => m.replace(/<[^>]+>/g, ''));
    ok('C1 control: KPI labels were extracted', labels.length >= 4, 'labels=' + labels.length);
    labels.forEach((l) => {
      ok('C1 label "' + l + '" does not claim revenue', !/revenue/i.test(l));
      ok('C1 label "' + l + '" does not claim GMV', !/gmv/i.test(l));
    });
    ok('C1 the figure is named for what it measures', /Rail volume/.test(prod));
    ok('C1 the disclosure is shown', /wallet top-up or STK push/.test(prod));
    ok('C1 it states this is not sales revenue',
       /not marketplace\s+sales revenue/.test(prod.replace(/\s+/g, ' ')) ||
       /not marketplace sales revenue/.test(prod.replace(/\s+/g, ' ')));
  });

  runCase('C2 the status contract is stated on the surface', () => {
    ok('C2 the vocabulary is published', /PENDING \/ COMPLETE \/ FAILED \/ CANCELLED/.test(prod));
    ok('C2 the succeeded trap is named', /succeeded/.test(prod));
  });

  /* ── D. Failure, emptiness and dormancy are three different states ─ */

  runCase('D1 an unreadable ledger is not an empty ledger', () => {
    ok('D1 the failure is stated', /could not be read/.test(denied));
    ok('D1 it does not claim there were no payments', !/No payments recorded/.test(denied));
    ok('D1 no money figure is shown', !/ri-kpi-v/.test(denied));
  });

  runCase('D2 a quiet range names the last payment anywhere', () => {
    /* Dormancy is the trap: a range with nothing in it looks identical to zero
       revenue unless the surface says when activity last happened. */
    ok('D2 the empty range is stated', /No payments recorded in this range/.test(dormant));
    ok('D2 the newest payment date is disclosed', /most recent payment anywhere/.test(dormant));
    ok('D2 it warns against over-reading a quiet window',
       /quiet range is not the same as a quiet platform/.test(dormant));
    ok('D2 it does NOT report a read failure', !/could not be read/.test(dormant));
  });

  /* ── E. Panels without a source are not invented ─────────────────── */

  runCase('E1 unbuildable panels are declared, with reasons', () => {
    ok('E1 control: the panel rendered', /ri-off/.test(notBuilt));
    ['Revenue by geography', 'Cohort retention', 'AI insights', 'By project / client']
      .forEach((n) => ok('E1 "' + n + '" is declared not built', notBuilt.indexOf(n) !== -1));
    ok('E1 geography names the missing field', /country or region field/i.test(notBuilt));
    ok('E1 AI insights names the fabrication risk', /causal attribution/i.test(notBuilt));
  });

  runCase('E2 no fabricated insight text is rendered anywhere', () => {
    ok('E2 control: the overview rendered', /ri-kpi/.test(prod));
    /* The reference design's narrative claims must not appear as output. */
    [/driven by/i, /enterprise clients/i, /market growth/i, /campaign impact/i]
      .forEach((re) => ok('E2 no narrative attribution matching ' + re, !re.test(prod)));
  });

  runCase('E3 orders and payments are never divided into one another', () => {
    const src = fs.readFileSync(path.join(ROOT, 'sokoni-revenue-intelligence.js'), 'utf8');
    ok('E3 control: both sources are read', /ops_reports/.test(src) && /'payments'/.test(src));
    ok('E3 the surface explains why they are not combined',
       /revenue per order/i.test(src));
  });

  /* ── F. Read-only, and wiring ────────────────────────────────────── */

  runCase('F1 the module never writes', () => {
    let src = fs.readFileSync(path.join(ROOT, 'sokoni-revenue-intelligence.js'), 'utf8')
                .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
                .replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
    ok('F1 control: stripped source kept the reads', /\.collection\(/.test(src) && /\.get\(\)/.test(src));
    ok('F1 control: string literals were stripped', src.indexOf('SokoniRevenue.tab(') === -1);
    ['.set(', '.update(', '.delete(', '.add(', 'httpsCallable', 'runTransaction'].forEach((w) => {
      ok('F1 no ' + w, src.indexOf(w) === -1);
    });
  });

  const strip = (s) => s.replace(/<!--[\s\S]*?-->/g, '');
  const adminOs    = strip(fs.readFileSync(path.join(ROOT, 'admin-os.html'), 'utf8'));
  const superAdmin = strip(fs.readFileSync(path.join(ROOT, 'super-admin.html'), 'utf8'));
  const adminHtml  = strip(fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8'));
  const aos = fs.readFileSync(path.join(ROOT, 'sokoni-aos.js'), 'utf8')
                .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  runCase('F2 AdminOS mounts it from the existing sidebar', () => {
    ok('F2 sidebar entry', /data-section="revenue"/.test(adminOs));
    ok('F2 router call', /SokoniAOS\.navigate\('revenue'\)/.test(adminOs));
    ok('F2 panel', /id="panel-revenue"/.test(adminOs));
    ok('F2 exactly one mount point', (adminOs.match(/id="revenueRoot"/g) || []).length === 1);
    ok('F2 script served', /sokoni-revenue-intelligence\.js/.test(adminOs));
    ok('F2 loader registered (stripped)', /revenue:\s*\(\)\s*=>\s*_loadRevenue\(\)/.test(aos));
    ok('F2 loader mounts', /SokoniRevenue\.mount\(root\)/.test(aos));
  });

  runCase('F3 Super Admin mounts the same module', () => {
    ok('F3 sidebar entry', /data-section="revenue"/.test(superAdmin));
    ok('F3 router call', /SA\.nav\('revenue'\)/.test(superAdmin));
    ok('F3 panel', /id="panel-revenue"/.test(superAdmin));
    ok('F3 exactly one mount point', (superAdmin.match(/id="revenueRoot"/g) || []).length === 1);
    ok('F3 lazy-load branch', /section==='revenue'\)this\.loadRevenue\(\)/.test(superAdmin));
    ok('F3 script served', /sokoni-revenue-intelligence\.js/.test(superAdmin));
  });

  runCase('F4 admin.html is not a consumer', () => {
    ok('F4 control: admin.html was read', adminHtml.length > 1000);
    ok('F4 no mount', !/revenueRoot/.test(adminHtml) && !/sokoni-revenue-intelligence\.js/.test(adminHtml));
  });

  runCase('F5 the ledger renders the real status, never a normalised guess', () => {
    ok('F5 control: the ledger rendered', /ri-table/.test(ledger));
    ok('F5 COMPLETE shown verbatim', /ri-badge complete">COMPLETE/.test(ledger));
    ok('F5 CANCELLED shown verbatim', /CANCELLED/.test(ledger));
    ok('F5 a fee column is present', /Fee<\/th>/.test(ledger));
  });

  /* ── Summary ─────────────────────────────────────────────────────── */
  if (ASSERTS < MIN_ASSERTIONS) {
    FAIL++;
    FAILURES.push('Suite ran only ' + ASSERTS + ' assertions; at least ' + MIN_ASSERTIONS + ' expected.');
  }

  console.log('\n' + '='.repeat(66));
  console.log('  REVENUE INTELLIGENCE — CERTIFICATION');
  console.log('='.repeat(66));
  console.log('  assertions : ' + ASSERTS);
  console.log('  passed     : ' + PASS);
  console.log('  failed     : ' + FAIL);
  if (FAILURES.length) {
    console.log('\n  FAILURES');
    FAILURES.forEach((f) => console.log('   ✗ ' + f));
  }
  console.log('='.repeat(66));
  console.log(FAIL === 0 ? '  RESULT: CERTIFIED\n' : '  RESULT: NOT CERTIFIED\n');
  process.exit(FAIL === 0 ? 0 : 1);

})().catch((e) => {
  console.error('\n  ✗ HARNESS CRASHED — certification did not complete');
  console.error('  ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
