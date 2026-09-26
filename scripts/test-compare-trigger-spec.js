'use strict';
/**
 * CERTIFICATION of scripts/infra/compare-trigger-spec.js (recovery manifest assertion 6).
 * Same filters in a different order must PASS; every real contract change must FAIL.
 * Fixtures are the REAL onOrderStatusChange trigger, in the two orders production returned on
 * 2026-09-26 for the same unchanged resource.
 */
const { compareTriggerSpec } = require('./infra/compare-trigger-spec');

const BASE = {
  eventFilters: [
    { attribute: 'database', value: '(default)' },
    { attribute: 'namespace', value: '(default)' },
    { attribute: 'document', operator: 'match-path-pattern', value: 'orders/{orderId}' },
  ],
  eventType: 'google.cloud.firestore.document.v1.updated',
  pubsubTopic: 'projects/sokoni-aeb26/topics/eventarc-nam5-onorderstatuschange-334647-227',
  retryPolicy: 'RETRY_POLICY_DO_NOT_RETRY',
  serviceAccountEmail: '24799054989-compute@developer.gserviceaccount.com',
  trigger: 'projects/sokoni-aeb26/locations/nam5/triggers/onorderstatuschange-334647',
  triggerRegion: 'nam5',
};
const clone = (o) => JSON.parse(JSON.stringify(o));
const withFilters = (f) => Object.assign(clone(BASE), { eventFilters: f });
const F = BASE.eventFilters;

let pass = 0, fail = 0;
const expect = (want, name, pre, post) => {
  const r = compareTriggerSpec(pre, post);
  const good = r.ok === (want === 'PASS');
  if (good) pass++; else fail++;
  console.log(`  ${good ? 'PASS' : 'FAIL'} expect ${want}: ${name}${r.diffs.length ? '  [' + r.diffs.join(' | ') + ']' : ''}`);
};

console.log('\n[same contract -> PASS]');
expect('PASS', 'identical', BASE, clone(BASE));
expect('PASS', 'filters in the order production returned post-deploy (document, database, namespace)', BASE, withFilters([F[2], F[0], F[1]]));
expect('PASS', 'filters fully reversed', BASE, withFilters([F[2], F[1], F[0]]));
expect('PASS', 'key order inside a filter differs', BASE, withFilters([{ value: '(default)', attribute: 'database' }, F[1], F[2]]));
expect('PASS', 'top-level key order differs', BASE, Object.keys(BASE).reverse().reduce((a, k) => (a[k] = clone(BASE[k]), a), {}));
expect('PASS', 'HTTPS function: no eventTrigger on either side', undefined, undefined);

console.log('\n[different contract -> FAIL]');
expect('FAIL', 'document path changed (orders/{orderId} -> orders/{id})', BASE, withFilters([F[0], F[1], Object.assign({}, F[2], { value: 'orders/{id}' })]));
expect('FAIL', 'filter removed', BASE, withFilters([F[0], F[2]]));
expect('FAIL', 'filter added', BASE, withFilters([F[0], F[1], F[2], { attribute: 'type', value: 'x' }]));
expect('FAIL', 'filter DUPLICATED (multiset, not set)', BASE, withFilters([F[0], F[0], F[2]]));
expect('FAIL', 'operator dropped from the path filter', BASE, withFilters([F[0], F[1], { attribute: 'document', value: 'orders/{orderId}' }]));
expect('FAIL', 'database changed', BASE, withFilters([{ attribute: 'database', value: 'sokoni-ops' }, F[1], F[2]]));
expect('FAIL', 'eventType changed (updated -> written)', BASE, Object.assign(clone(BASE), { eventType: 'google.cloud.firestore.document.v1.written' }));
expect('FAIL', 'retryPolicy changed', BASE, Object.assign(clone(BASE), { retryPolicy: 'RETRY_POLICY_RETRY' }));
expect('FAIL', 'serviceAccountEmail changed', BASE, Object.assign(clone(BASE), { serviceAccountEmail: 'other@x.iam.gserviceaccount.com' }));
expect('FAIL', 'triggerRegion changed', BASE, Object.assign(clone(BASE), { triggerRegion: 'us-central1' }));
expect('FAIL', 'top-level field removed (pubsubTopic)', BASE, (() => { const x = clone(BASE); delete x.pubsubTopic; return x; })());
expect('FAIL', 'top-level field added', BASE, Object.assign(clone(BASE), { channel: 'projects/x/channels/y' }));
expect('FAIL', 'eventFilters removed entirely', BASE, (() => { const x = clone(BASE); delete x.eventFilters; return x; })());
expect('FAIL', 'eventTrigger removed (event fn became HTTPS)', BASE, undefined);
expect('FAIL', 'eventTrigger added (HTTPS fn became event)', undefined, BASE);
expect('FAIL', 'ANOTHER array reordered — only eventFilters is order-free', Object.assign(clone(BASE), { extra: [1, 2] }), Object.assign(clone(BASE), { extra: [2, 1] }));

console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
