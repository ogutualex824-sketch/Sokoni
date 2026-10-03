/* Owner requirement (2026-10-04): "deliberately remove the rule restriction once during testing — the security test must
   fail." Builds two mutant rule files from RULES_FILE and runs zz-test-account-state-rules.js against each; each mutant
   MUST make its named rows fail. Needs the Firestore emulator (FIRESTORE_PORT) — RAM-gated like every emulator suite.
     M1 field lock removed  (accountStateUnchanged / accountStateCreateOk → true)   → AS-1 / AS-1b / AS-2 / AS-3 / AS-5 must FAIL
     M2 session check removed (accountNotSuspended → true)                          → AS-7 / AS-7b / AS-8 / AS-9 must FAIL */
'use strict';
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const base = process.env.RULES_FILE || 'firestore.rules.hotfix-jobs';
const src = fs.readFileSync(path.resolve(__dirname, '..', base), 'utf8');
const swap = (s, fn) => { const i = s.indexOf('function ' + fn + '() {'); if (i < 0) throw new Error('anchor ' + fn); const j = s.indexOf('\n  }', i); return s.slice(0, i) + 'function ' + fn + '() {\n  return true;' + s.slice(j); };
const M = { M1: { rules: swap(swap(src, 'accountStateUnchanged'), 'accountStateCreateOk'), must: ['AS-1', 'AS-1b', 'AS-2', 'AS-3', 'AS-5'] },
            M2: { rules: swap(src, 'accountNotSuspended'), must: ['AS-7', 'AS-7b', 'AS-8', 'AS-9'] } };
let bad = 0;
for (const [name, m] of Object.entries(M)) {
  const tmp = 'zz-mutant-' + name + '.rules'; fs.writeFileSync(path.resolve(__dirname, '..', tmp), m.rules);
  const r = spawnSync(process.execPath, [path.join(__dirname, 'zz-test-account-state-rules.js')], { env: Object.assign({}, process.env, { RULES_FILE: tmp }), encoding: 'utf8' });
  fs.unlinkSync(path.resolve(__dirname, '..', tmp));
  const out = (r.stdout || '') + (r.stderr || '');
  if (/HARNESS ERROR/.test(out)) { console.log('  ' + name + ' HARNESS ERROR — no verdict'); bad++; continue; }
  const missed = m.must.filter((id) => !new RegExp('FAIL\s+' + id.replace('-', '\-') + '\b').test(out));
  console.log('  ' + name + (missed.length ? ' NOT CAUGHT by ' + missed.join(', ') : ' caught by ' + m.must.join(', ')));
  if (missed.length) bad++;
}
process.exit(bad ? 1 : 0);
