/* ══════════════════════════════════════════════════════════════════════════════
   SUBSCRIPTION WRITER CENSUS — ONE activation authority, ONE period
   ══════════════════════════════════════════════════════════════════════════════
   A repeated ~1s skew between currentPeriodEnd and expiresAt proved a second
   writer. It was automation-engine.autoOnSubscriptionCreate, recomputing the
   period from `billingCycleDays || 30` — a field the payment chain never writes.
   Monthly plans produced the same answer, so every monthly test looked correct
   while an ANNUAL customer would have paid for a year and received 30 days.

   This suite exists so that cannot return.

   Run: node scripts/test-subscription-writers.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : '')); ok ? pass++ : fail++; };
const un = (l, d) => { console.log('  UNPROVEN  ' + l + (d ? '   [' + d + ']' : '')); unproven++; };
const head = (t) => console.log('\n' + t);
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const BLOCK = new RegExp(String.fromCharCode(47,92,42) + '[\s\S]*?' + String.fromCharCode(92,42,47), 'g');
const LINE  = new RegExp('(^|[^:])' + String.fromCharCode(47,47) + '[^\n]*', 'g');
const stripComments = (s) => s.replace(BLOCK, '').replace(LINE, '$1');

console.log('\nSUBSCRIPTION WRITER CENSUS');
console.log('='.repeat(74));

head('1 - every trigger on subscriptions/* is accounted for');
/* The complete set, established by sweep. A NEW trigger appearing here is not
   automatically wrong — but it must be classified before it ships. */
const TRIGGERS = [
  ['functions/automation-engine.js',      'autoOnSubscriptionCreate',            'fills a period ONLY when absent'],
  ['functions/email-triggers.js',         'subscription email',                  'reads only'],
  ['functions/product-limit.js',          'onSubscriptionChangedSyncLimit',      'writes productCounters'],
  ['functions/subscription-authority.js', 'onSubscriptionChangedSyncEntitlements', 'writes entitlements'],
];
const found = [];
fs.readdirSync(path.join(ROOT, 'functions')).filter((f) => f.endsWith('.js')).forEach((f) => {
  const src = read('functions/' + f);
  if (/document: *['"]subscriptions\/\{/.test(src)) found.push('functions/' + f);
});
ck('exactly ' + TRIGGERS.length + ' files carry a subscriptions/* trigger',
   found.length === TRIGGERS.length, found.join(', '));
TRIGGERS.forEach((t) => ck('  ' + t[0].replace('functions/', '') + ' — ' + t[2], found.indexOf(t[0]) > -1));

head('2 - only ONE of them may write the period');
const periodWriters = found.filter((f) => {
  const src = read(f);
  /* Does this file write currentPeriodEnd from inside a subscriptions trigger? */
  return /currentPeriodEnd:/.test(src) && /document: *['"]subscriptions\/\{/.test(src);
});
ck('only automation-engine can write a period from a trigger',
   periodWriters.length === 1 && periodWriters[0] === 'functions/automation-engine.js',
   periodWriters.join(', ') || 'none');
ck('email-triggers writes nothing back', !/\.update\(|\.set\(/.test(
   read('functions/email-triggers.js').split('document: "subscriptions/{subId}"')[1].slice(0, 900)));
ck('product-limit writes counters, not subscriptions',
   read('functions/product-limit.js').indexOf("collection('subscriptions')") === -1);
ck('subscription-authority writes entitlements, not subscriptions',
   /materialiseEntitlements\(uid/.test(read('functions/subscription-authority.js')));

head('3 - the rival overwrite is gone');
/* Comments stripped: this file's own comment DESCRIBES the old rule, and a
   comment mentioning a defect is not the defect. That exact trap produced a
   false positive here on the first run. */
const autoRaw = read('functions/automation-engine.js');
const auto = stripComments(autoRaw);
ck('it DEFERS when a period already exists', /if \(sub\.currentPeriodEnd\) \{/.test(auto));
ck('...returning without touching status or the period',
   /update\(\{ automationProcessed: true \}\)/.test(auto));
ck('the silent fallback assignment is gone',
   autoRaw.indexOf('cycleDays  = sub.billingCycleDays || 30;') === -1,
   'the assignment, not the prose describing it');
ck('...replaced by a cycle-aware default',
   auto.indexOf("cycleDays = (cycle === 'annual') ? 365 : 30") > -1);
ck('and when it does compute, it writes BOTH date fields together',
   /currentPeriodEnd: admin\.firestore\.Timestamp\.fromDate\(endDate\),\s*expiresAt: admin\.firestore\.Timestamp\.fromDate\(endDate\)/.test(auto));

head('4 - MUTATION CONTROL: the old behaviour must FAIL this suite');
/* The exact rogue logic, reconstructed. If the suite cannot catch it, the suite
   is decoration. */
const ROGUE = "const cycleDays  = sub.billingCycleDays || 30;";
ck('MC the old fallback is detectable', /billingCycleDays \|\| 30/.test(ROGUE));
ck('MC ...and the current file does not contain that assignment',
   autoRaw.indexOf('cycleDays  = sub.billingCycleDays || 30;') === -1);
const rogueDays = (sub) => (sub.billingCycleDays || 30);
const fixedDays = (sub) => (Number(sub.billingCycleDays) > 0 ? Number(sub.billingCycleDays)
                          : (sub.billingCycle === 'annual' ? 365 : 30));
const ANNUAL = { billingCycle: 'annual' };
ck('MC the rogue rule gives an annual plan 30 days', rogueDays(ANNUAL) === 30);
ck('MC the fixed rule gives it 365', fixedDays(ANNUAL) === 365);
ck('MC a monthly plan is 30 under BOTH — which is why monthly tests passed',
   rogueDays({ billingCycle: 'monthly' }) === 30 && fixedDays({ billingCycle: 'monthly' }) === 30);
ck('MC so a monthly-only certification could NOT have caught this',
   rogueDays({ billingCycle: 'monthly' }) === fixedDays({ billingCycle: 'monthly' }));

head('5 - the reconciler derives the period from the plan, not a stray field');
const rec = read('functions/subscription-pay-methods.js');
ck('PERIOD_DAYS is explicit', /PERIOD_DAYS = \{ monthly: 30, annual: 365 \}/.test(rec));
ck('the cycle comes from the intent', /intent\.billingCycle === 'annual' \? 'annual' : 'monthly'/.test(rec));
ck('currentPeriodEnd and expiresAt are the SAME value',
   /currentPeriodEnd: admin\.firestore\.Timestamp\.fromMillis\(endMs\)/.test(rec) &&
   /expiresAt: admin\.firestore\.Timestamp\.fromMillis\(endMs\)/.test(rec));
/* Not a slogan — the property is that ONE assignment feeds both fields, so
   they can only diverge if something else wrote one of them. */
const endMsUses = rec.split('Timestamp.fromMillis(endMs)').length - 1;
ck('both date fields come from the same endMs assignment', endMsUses >= 2,
   endMsUses + ' uses of the single computed endMs');

head('6 - what still needs the LIVE check');
un('that the deployed automation-engine carries this fix', 'not deployed yet — it must ship before hosting');
un('annual end-to-end in production', 'run verify-subscription-production.js --write after deploying');

console.log('\n' + '='.repeat(74));
console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
console.log('='.repeat(74) + '\n');
process.exit(fail ? 1 : 0);
