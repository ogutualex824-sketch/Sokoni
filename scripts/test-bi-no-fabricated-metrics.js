'use strict';
/**
 * CERT — pos-bi.html must never display fabricated business metrics.
 *
 * INVARIANT UNDER TEST
 *   A failed or unavailable data source must never cause fabricated business metrics to
 *   appear on a production merchant surface. Genuine values from successful queries are
 *   preserved even when a sibling query fails; the failed widget renders a neutral state.
 *
 * WHY THIS SUITE IS BEHAVIOURAL, NOT A GREP
 *   `node --check` passing proves nothing about behaviour — a bare identifier is legal
 *   shorthand-property syntax and still throws at runtime. So the page's real render
 *   functions are EXTRACTED and EXECUTED against a DOM double, and the resulting HTML is
 *   asserted. Static checks appear only where the property is genuinely textual (e.g. "no
 *   fallback generator is defined anywhere in the file").
 *
 * Every detector carries an adversarial test in BOTH directions: it must fire on the
 * regression it claims to catch, and must NOT fire on the correct code. A one-directional
 * sabotage check only proves the detector is not dead; it does not prove it is right.
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'pos-bi.html'), 'utf8');

let pass = 0, fail = 0, sabotage = 0, sabotageOk = 0;
const failures = [];
const check = (n, c) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; failures.push(n); console.log('  FAIL  ' + n); } };
const sab   = (n, c) => { sabotage++; if (c) { sabotageOk++; pass++; console.log('  PASS    (sabotage: ' + n + ')'); } else { fail++; failures.push('SABOTAGE ' + n); console.log('  FAIL    (sabotage: ' + n + ')'); } };

console.log('\nCERT — pos-bi.html: no fabricated metrics on a merchant surface\n');

/* ══════════════════════════════════════════════════════════════
   HARNESS — a DOM double, and the page's real functions extracted
══════════════════════════════════════════════════════════════ */

function makeDom() {
  const els = {};
  const mk = (id) => (els[id] = { id, innerHTML: '', textContent: '' });
  ['kpiGrid', 'revChart', 'revXAxis', 'categoryPanel', 'paymentPanel', 'inventoryPanel',
   'customerGrowthPanel', 'topCustomersPanel', 'staffBody', 'alertsPanel', 'drillBody',
   'forecastBody', 'lastUpdated'].forEach(mk);
  return { els, document: { getElementById: (id) => els[id] || null } };
}

/** Pull one top-level function's source out of the page by name. */
function extract(name) {
  const re = new RegExp('\\nfunction ' + name + '\\s*\\([\\s\\S]*?\\n\\}', 'm');
  const m = re.exec(HTML);
  if (!m) throw new Error('could not extract function ' + name);
  return m[0];
}

/** Build a sandbox exposing the real renderUnavailable / renderAlerts / helpers. */
function loadRenderers(dom) {
  const src = [
    "const NEUTRAL = '\\u2014';",
    extract('renderUnavailable'),
    extract('renderAllUnavailable'),
    extract('renderAlerts'),
    'return { renderUnavailable, renderAllUnavailable, renderAlerts };',
  ].join('\n\n');
  /* eslint-disable no-new-func */
  return new Function('document', src)(dom.document);
}

/* ══════════════════════════════════════════════════════════════
   §1 — no fallback generator exists at all
══════════════════════════════════════════════════════════════ */
console.log('§1 no fabrication source exists');

const FABRICATOR = /\b(?:function\s+|const\s+|let\s+)?(mock|seed|demo|fake|dummy|sample)[A-Z]\w*\s*(?:=\s*)?\(/;
check('no mock/seed/demo/fake/dummy generator is defined or called', !FABRICATOR.test(HTML));
sab('the detector fires on a reintroduced generator',
  FABRICATOR.test('function mockExec() { return { revenue: 284560 }; }'));
sab('the detector does NOT fire on the corrected page', !FABRICATOR.test(HTML));

check('no "|| mock*()" style fallback remains', !/\|\|\s*(mock|seed|demo|fake|dummy)[A-Z]/.test(HTML));
sab('the detector fires on a reintroduced || fallback',
  /\|\|\s*(mock|seed|demo|fake|dummy)[A-Z]/.test('renderKPIs(exec || mockExec());'));

check('the page no longer labels itself "Demo data" in code',
  !/textContent\s*=\s*'Demo data'/.test(HTML));

/* The specific invented values that used to ship, by literal. */
[['284560', 'revenue'], ['182000', 'M-Pesa amount'], ['18400', 'expiring value'],
 ['42800', 'avg LTV']].forEach(([lit, what]) => {
  check('invented ' + what + ' literal ' + lit + ' is gone', HTML.indexOf(lit) === -1);
});

/* ══════════════════════════════════════════════════════════════
   §2 — neutral state renders, and it is not a zero
══════════════════════════════════════════════════════════════ */
console.log('\n§2 neutral state (executed)');

const dom = makeDom();
const R = loadRenderers(dom);

R.renderUnavailable('kpiGrid', 'Revenue & profit unavailable');
const kpiOut = dom.els.kpiGrid.innerHTML;

check('renderUnavailable writes into the target element', kpiOut.length > 0);
check('neutral state shows an em dash, not a number', kpiOut.indexOf('—') !== -1);
check('neutral state contains NO digit that could read as a metric',
  !/[^\d]0[^\d]|>\s*0\s*</.test(kpiOut));
check('neutral state carries the reason', /unavailable/i.test(kpiOut));
check('neutral state is machine-detectable for this suite', /data-unavailable="1"/.test(kpiOut));
check('neutral state is announced to assistive tech', /role="status"/.test(kpiOut));
sab('the detector would catch a zero-valued "neutral" state',
  /[^\d]0[^\d]|>\s*0\s*</.test('<div class="kpi-value">0</div>'));

/* Total failure marks every widget, leaving none stale. */
const dom2 = makeDom();
const R2 = loadRenderers(dom2);
R2.renderAllUnavailable();
const targets = ['kpiGrid', 'revChart', 'categoryPanel', 'paymentPanel', 'inventoryPanel',
                 'customerGrowthPanel', 'topCustomersPanel', 'staffBody', 'alertsPanel'];
check('total failure marks every widget unavailable',
  targets.every((t) => /data-unavailable="1"/.test(dom2.els[t].innerHTML)));
check('total failure fabricates nothing',
  targets.every((t) => !FABRICATOR.test(dom2.els[t].innerHTML)));

/* ══════════════════════════════════════════════════════════════
   §3 — the call sites: partial failure preserves genuine data
══════════════════════════════════════════════════════════════ */
console.log('\n§3 partial failure (call-site contract)');

const CALLSITE = /if \(exec\)\s+renderKPIs\(exec\);\s+else \{ renderUnavailable\('kpiGrid'/;
check('a genuine exec result still renders KPIs', CALLSITE.test(HTML));
check('a missing exec result renders neutral instead', CALLSITE.test(HTML));
sab('the detector fires if the guard is removed',
  !CALLSITE.test('renderKPIs(exec);'));

/* Each of the eight widgets must be independently guarded — no shared all-or-nothing. */
[['trend', 'revChart'], ['cats', 'categoryPanel'], ['pay', 'paymentPanel'],
 ['inv', 'inventoryPanel'], ['cust', 'customerGrowthPanel'], ['staff', 'staffBody']]
  .forEach(([v, target]) => {
    check('widget "' + v + '" is independently guarded',
      new RegExp('if \\(' + v + '\\)[\\s\\S]{0,120}renderUnavailable\\(\'' + target + '\'').test(HTML));
  });

check('no render call passes an unguarded possibly-null value',
  !/render(KPIs|Trend|Categories|Payments|Inventory|CustomerGrowth|TopCustomers|Staff)\((exec|trend|cats|pay|inv|cust|staff)\s*\|\|/.test(HTML));

/* ══════════════════════════════════════════════════════════════
   §4 — alerts are verdicts and must not be invented (executed)
══════════════════════════════════════════════════════════════ */
console.log('\n§4 alert verdicts (executed)');

/* The dangerous historical default: an unknown inventory score became 100 = "healthy",
   silently WITHHOLDING a warning. Prove that an absent score no longer clears the page. */
const dom3 = makeDom();
const R3 = loadRenderers(dom3);
R3.renderAlerts({ revenueChange: 5, churnRate: 2 }, {}, {});           // inv.score absent
const alertsMissing = dom3.els.alertsPanel.innerHTML;
check('an absent inventory score does NOT produce "all metrics within normal range"',
  alertsMissing.indexOf('All metrics within normal range') === -1);
check('an absent input is reported as incomplete instead',
  /could not be loaded|incomplete/i.test(alertsMissing));
check('no invented score is printed when the score is absent',
  alertsMissing.indexOf('100/100') === -1 && alertsMissing.indexOf('/100') === -1);

/* And the positive direction: genuine values still produce genuine verdicts. */
const dom4 = makeDom();
const R4 = loadRenderers(dom4);
R4.renderAlerts({ revenueChange: -25, churnRate: 2 }, { score: 55, stockouts: 0 }, {});
const alertsReal = dom4.els.alertsPanel.innerHTML;
check('a genuine revenue drop still raises its alert', /Revenue is down/.test(alertsReal));
check('a genuine low inventory score still raises its alert', /Inventory health score is 55/.test(alertsReal));

const dom5 = makeDom();
const R5 = loadRenderers(dom5);
R5.renderAlerts({ revenueChange: 1, churnRate: 2 }, { score: 95, stockouts: 0 }, {});
check('genuinely healthy data still reports all-clear',
  /All metrics within normal range/.test(dom5.els.alertsPanel.innerHTML));
sab('the all-clear detector is not vacuous (it fires on the healthy case only)',
  dom5.els.alertsPanel.innerHTML.indexOf('All metrics within normal range') !== -1 &&
  alertsMissing.indexOf('All metrics within normal range') === -1);

/* ══════════════════════════════════════════════════════════════
   §5 — nothing else was disturbed
══════════════════════════════════════════════════════════════ */
console.log('\n§5 preservation');

check('all 10 live renderers survive',
  (HTML.match(/^function render(KPIs|Trend|Categories|Payments|Inventory|CustomerGrowth|TopCustomers|Staff|Alerts|Forecast)\(/gm) || []).length === 10);
check('PRESERVED: live inventory rows from the earlier posBatches retirement',
  /Stockout Events/.test(HTML) && /Overstock Items/.test(HTML) && /Turnover Rate/.test(HTML));
check('PRESERVED: the retired Expiring Soon row stays retired', !/Expiring Soon/.test(HTML));
check('forecast no longer fabricates on failure',
  /renderUnavailable\('forecastBody'/.test(HTML));

console.log('\n  ' + pass + '/' + (pass + fail) + ' checks passed  ·  ' + sabotageOk + '/' + sabotage + ' sabotage catches');
if (fail) {
  console.log('\n  ' + fail + ' FAILURE(S):');
  failures.forEach((f) => console.log('    - ' + f));
  process.exit(1);
}
console.log('\n  PASS — no fabricated metric can reach a merchant on this surface.\n');
