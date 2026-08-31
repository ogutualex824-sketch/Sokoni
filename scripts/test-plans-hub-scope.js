#!/usr/bin/env node
/**
 * PLAN PAGE — HUB SCOPE.
 *
 *   node scripts/test-plans-hub-scope.js
 *
 * plans.html calls subGetPlans({}) with NO hubType, so it receives the WHOLE platform
 * catalogue. On the public price list that is correct. Embedded in the merchant shell it
 * is the shopkeeper's own Plan screen, and it was offering them Pharmacy, Hotel, Driver,
 * Recruiter and Buyer plans they cannot hold.
 *
 * The fixture is the catalogue PRODUCTION actually returned, not one written here, so
 * this measures the real shape (31 plans / 12 hubs) rather than an assumed one.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 92) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log(String.fromCharCode(10) + t);

const LIVE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures-live-plans.json'), 'utf8')).result.plans;
const HTML = fs.readFileSync(path.join(ROOT, 'plans.html'), 'utf8');

/* Extract the real buildHubTabs from the page rather than restating it here. */
function grab (name) {
  const i = HTML.indexOf('function ' + name + '(');
  if (i === -1) return null;
  let d = 0, started = false;
  for (let j = i; j < HTML.length; j++) {
    const c = HTML[j];
    if (c === '{') { d++; started = true; }
    else if (c === '}') { d--; if (started && d === 0) return HTML.slice(i, j + 1); }
  }
  return null;
}
const SRC = grab('buildHubTabs');

function run (inShell) {
  const tabs = { innerHTML: '', style: {} };
  const sandbox = {
    allPlans: LIVE, currentHub: 'seller', IN_SHELL: inShell,
    HUB_LABELS: {}, esc: (x) => String(x), Set, console,
    document: { getElementById: () => tabs },
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC + '; buildHubTabs();', sandbox);
  const count = (tabs.innerHTML.match(/hub-tab/g) || []).length;
  return { tabs, count, hub: sandbox.currentHub };
}

console.log(String.fromCharCode(10) + 'PLAN PAGE — HUB SCOPE' + String.fromCharCode(10) + '='.repeat(58));

head('1 · the fixture is production, not an assumption');
ck('the live catalogue was captured', LIVE.length > 0, LIVE.length + ' plans');
const hubs = [...new Set(LIVE.map((p) => p.hubType))];
ck('it spans many hubs', hubs.length > 5, hubs.length + ' hubs: ' + hubs.join(', '));
ck('buildHubTabs was extracted from the page', !!SRC, SRC ? SRC.length + ' chars' : 'NOT FOUND');

head('2 · in the merchant shell — only what a seller can hold');
const A = run(true);
ck('the tab bar is narrowed', A.count < hubs.length, A.count + ' tabs, was ' + hubs.length);
ck('no Pharmacy / Hotel / Driver / Recruiter tab',
   A.tabs.innerHTML.indexOf('pharmacy') === -1 && A.tabs.innerHTML.indexOf('hotel') === -1 &&
   A.tabs.innerHTML.indexOf('driver') === -1 && A.tabs.innerHTML.indexOf('recruiter') === -1);
ck('the seller stays on the seller catalogue', A.hub === 'seller', A.hub);

head('3 · standalone — the public price list is untouched');
const B = run(false);
ck('every hub is still offered', B.count === hubs.length, B.count + ' of ' + hubs.length);
ck('...including the ones hidden in-shell',
   B.tabs.innerHTML.indexOf('pharmacy') > -1 && B.tabs.innerHTML.indexOf('recruiter') > -1);
ck('CONTROL the two modes actually differ', A.count !== B.count, A.count + ' vs ' + B.count);

head('4 · the selected hub can never fall outside what is shown');
/* renderPlans filters allPlans by currentHub. If scoping removed that hub the page
   would print "No plans available for this hub" over a full catalogue. */
(function () {
  const tabs = { innerHTML: '', style: {} };
  const sandbox = {
    allPlans: LIVE, currentHub: 'pharmacy', IN_SHELL: true,
    HUB_LABELS: {}, esc: (x) => String(x), Set, console,
    document: { getElementById: () => tabs },
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC + '; buildHubTabs();', sandbox);
  ck('a hub that scoping removed is reset to one that remains',
     sandbox.currentHub === 'seller' || sandbox.currentHub === 'enterprise', sandbox.currentHub);
  ck('...and the reset hub really has plans',
     LIVE.some((p) => p.hubType === sandbox.currentHub));
})();

head('5 · a single tab is a label, not a choice');
(function () {
  const only = LIVE.filter((p) => p.hubType === 'seller');
  const tabs = { innerHTML: 'x', style: {} };
  const sandbox = {
    allPlans: only, currentHub: 'seller', IN_SHELL: true,
    HUB_LABELS: {}, esc: (x) => String(x), Set, console,
    document: { getElementById: () => tabs },
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC + '; buildHubTabs();', sandbox);
  ck('one hub ⇒ the tab bar is hidden, not left as a lone dead tab',
     tabs.style.display === 'none' && tabs.innerHTML === '', JSON.stringify(tabs.style));
})();

head('6 · prices are read, never authored here');
ck('the page contains no hard-coded plan price',
   HTML.indexOf('99900') === -1 && HTML.indexOf('249900') === -1 && HTML.indexOf('749900') === -1,
   'pricing is server authority; a figure typed into the page would diverge silently');
ck('CONTROL those figures DO exist in the catalogue that owns them',
   fs.readFileSync(path.join(ROOT, 'functions/sub-billing.js'), 'utf8').indexOf('249900') > -1,
   'or the previous assertion would pass by looking for nothing');

console.log(String.fromCharCode(10) + '  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
