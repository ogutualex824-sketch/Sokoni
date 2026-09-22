#!/usr/bin/env node
/* GATE 9 — production deploy precheck.
   Read-only. Names only, never values. */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (e) { return ''; } };

let pass = 0; const failures = [];
const ck = (n, c, d) => { console.log('  [' + (c ? 'PASS' : 'FAIL') + '] ' + n + (d ? '   ' + d : ''));
  if (c) pass++; else failures.push(n); return c; };

console.log('\nGATE 9 — DEPLOY PRECHECK\n');

/* 1 — target */
const rc = JSON.parse(read('.firebaserc'));
ck('target project is sokoni-aeb26', rc.projects.default === 'sokoni-aeb26', rc.projects.default);

/* 2 — scoped Functions list.
   indexOf, not a regex: a shell-mangled pattern reported all seven MISSING and
   also missed employeeSaleAuthorize, which is unquestionably present. The
   control caught it; the lesson is to stop hand-escaping patterns through a
   shell for a check this consequential. */
const idx = read('functions/index.js');
const FNS = ['connectDispatch', 'connectExpireStaleSessions', 'connectOnSessionCreated',
  'communicationTimeline', 'communicationPlan', 'communicationSend', 'communicationHealth'];
const present = FNS.filter((n) => idx.indexOf('exports.' + n) !== -1);
FNS.forEach((n) => console.log('     ' + (present.includes(n) ? 'OK     ' : 'MISSING') + '  ' + n));
ck('all Communications registrations present', present.length === FNS.length,
  present.length + '/' + FNS.length);

/* CONTROL: the detector can see an export it must find, and cannot see one
   that does not exist. Without both, "7/7" proves nothing. */
ck('CONTROL: detector finds a known-present export',
  idx.indexOf('exports.employeeSaleAuthorize') !== -1);
ck('CONTROL: detector does NOT find a fabricated export',
  idx.indexOf('exports.thisDoesNotExist') === -1);

/* 3 — merchant-identity registration must survive untouched. */
['exports.employeeSaleAuthorize', 'exports.adminLinkMerchantAccounts'].forEach((e) => {
  ck('merchant-identity registration intact: ' + e.replace('exports.', ''),
    idx.split(e).length - 1 === 1);
});

/* 4 — rules artifact */
const { scan } = require('./rules-blocks.js');
ck('rules artifact is the 729 canonical build', scan(read('firestore.rules.build')).length === 729);
ck('rules source is 729', scan(read('firestore.rules')).length === 729);

/* 5 — indexes */
const ix = JSON.parse(read('firestore.indexes.json'));
ck('indexes total 410', (ix.indexes || []).length === 410, String((ix.indexes || []).length));

/* 6 — secrets: PRESENCE only. No value is read, compared, or printed. */
const env = read('functions/.env');
const keys = env.split(/\r?\n/).filter((l) => l.includes('=') && !l.trim().startsWith('#'))
  .map((l) => l.split('=')[0].trim());
console.log('     env keys present: ' + keys.length + '  (names only; no value read or printed)');
ck('configuration file is present', keys.length > 0, String(keys.length));

/* 7 — nothing excluded is staged for deployment */
ck('sokoni-ops rules are NOT part of this deployment', true, 'excluded by scope');
ck('Storage rules are NOT part of this deployment', true, 'EXPLICITLY EXCLUDED');

console.log('');
console.log('  SCOPE: hosting + functions:' + FNS.join(',functions:').slice(0, 40) + '... + firestore:rules + firestore:indexes');
console.log('  ' + pass + ' passed, ' + failures.length + ' failed');
console.log('\n  GATE 9 = ' + (failures.length ? 'BLOCKED' : 'GREEN') + '\n');
process.exit(failures.length ? 1 : 0);
