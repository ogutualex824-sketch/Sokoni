#!/usr/bin/env node
/* TECH HUB SLICE 4O (hosting) — AdminOS provider Suspend / Reinstate goes through applicationDecide (the existing,
 * audited authority) on the listing's sourceApplicationId; unknown ratings / job counts render "—", never 0.
 * Server half: feat/tech-taxonomy-on-13f74f3 @ 4ab4eb7 (test-provider-suspend-restore 8/0).
 *   node scripts/test-adminos-provider-lifecycle.js */
'use strict';
const fs = require('fs'), path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'sokoni-aos.js'), 'utf8');
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 220) + ']')); ok ? pass++ : fail++; };
console.log('\nAdminOS provider lifecycle (Tech Hub slice 4O)\n');

function fnSrc(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) return '';
  let d = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) return src.slice(i, j + 1); } }
  return '';
}
function rowCondition(src) {
  const body = fnSrc(src, '_loadServices');
  return /typeof p\.rating === "number"/.test(body) && /typeof p\.jobsCompleted === "number"/.test(body) && !/p\.rating\|\|0/.test(body) && !/p\.jobsCompleted\|\|0/.test(body);
}
ck('A-1', rowCondition(SRC), 'the providers table renders unknown rating / jobs as "—", not 0');

const btnSrc = fnSrc(SRC, '_providerLifecycleBtn');
let btn = null;
try { btn = new Function('_esc', btnSrc + '; return _providerLifecycleBtn;')((s) => String(s).replace(/[&<>"']/g, '')); } catch (_) { btn = null; }
if (!btn) ck('A-2', false, '_providerLifecycleBtn exists');
else {
  const act = btn({ status: 'active', sourceApplicationId: 'APP1', name: 'X' });
  const sus = btn({ status: 'suspended', sourceApplicationId: 'APP1', name: 'X' });
  const none = btn({ status: 'active', name: 'X' });
  const pend = btn({ status: 'pending', sourceApplicationId: 'APP1' });
  ck('A-2', /providerDecide\('APP1','suspend'/.test(act) && /providerDecide\('APP1','approve'/.test(sus) && !/providerDecide/.test(none) && pend === '',
    'active → Suspend, suspended → Reinstate, both on the governing application; no application → no action; pending → none', { act, sus, none, pend });
}
const dec = fnSrc(SRC, 'providerDecide');
ck('A-3', /_call\("applicationDecide", \{ applicationId, decision, reason/.test(dec) && /\["approve", "suspend"\]\.indexOf\(decision\) === -1/.test(dec)
  && /A reason is required to suspend/.test(dec) && !/'applicationDecide'/.test((SRC.match(/_ADMIN_OS_OPS = new Set\(\[[\s\S]*?\]\)/) || [''])[0]),
  'the action calls the applicationDecide callable (approve | suspend only, reason required to suspend); nothing is written client-side');
ck('A-4', /\n\s+providerDecide,/.test(SRC), 'SokoniAOS exposes providerDecide');

/* sabotage: the fabricated zero comes back */
{
  const bad = SRC.replace('${typeof p.rating === "number" ? p.rating.toFixed(1) + " ⭐" : "—"}', '${(p.rating||0).toFixed(1)} ⭐');
  const red = bad !== SRC && rowCondition(SRC) && !rowCondition(bad);
  console.log('\n  [sabotage] ' + (red ? 'CAUGHT' : 'MISSED') + '  "0.0 ⭐" for an unknown rating → row A-1 fails'); if (!red) fail++;
}
console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
console.log('NOT proven here: the AdminOS page in a browser (memory floor); the server half is executed in test-provider-suspend-restore.');
process.exit(fail ? 1 : 0);
