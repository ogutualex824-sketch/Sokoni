/* Owner requirement (2026-10-04): "deliberately remove the rule restriction once during testing — the security test must
   fail." Builds two mutant rule files from RULES_FILE and runs zz-test-account-state-rules.js against each; each mutant
   MUST make its named rows fail. Needs the Firestore emulator (FIRESTORE_PORT) — RAM-gated like every emulator suite.
     M1 field lock removed  (accountStateUnchanged / accountStateCreateOk → true)   → AS-1 / AS-1b / AS-2 / AS-3 / AS-5 must FAIL
     M2 session check removed (accountNotSuspended → true)                          → AS-7 / AS-7b / AS-8 / AS-9 must FAIL
     M4 (break D1) role out of noSelfGrant; rolesUnchanged → true          → AS-12 / AS-13 must FAIL (AS-11/14 still held by noAdminFields)
     M5 (break D12) D1 + role out of noAdminFields                          → AS-11 / 12 / 13 / 14 must FAIL
     M3 (break C) only the 'banned' value removed from the predicate                → AS-7b must FAIL */
'use strict';
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const base = process.env.RULES_FILE || 'firestore.rules.hotfix-jobs';
const src = fs.readFileSync(path.resolve(__dirname, '..', base), 'utf8');
const swap = (s, fn) => { const i = s.indexOf('function ' + fn + '() {'); if (i < 0) throw new Error('anchor ' + fn); const j = s.indexOf('\n  }', i); return s.slice(0, i) + 'function ' + fn + '() {\n  return true;' + s.slice(j); };
const M = { M1: { rules: swap(swap(src, 'accountStateUnchanged'), 'accountStateCreateOk'), must: ['AS-1', 'AS-1b', 'AS-2', 'AS-3', 'AS-3b', 'AS-3c', 'AS-5'] },
            M2: { rules: swap(src, 'accountNotSuspended'), must: ['AS-7', 'AS-7b', 'AS-8', 'AS-9'] },
            /* break C (owner): remove ONLY the legacy 'banned' value from the predicate → the legacy-banned row must fail */
            /* break D (2f, owner attack list 'role = super_admin'): the ROLE guard removed — 'role' out of noSelfGrant and rolesUnchanged → true */
            /* break D1 (2f): the role guard on noPrivilegeEscalation removed — 'role' out of noSelfGrant, rolesUnchanged → true.
               The ADMIN branch (AS-12) and roles[] (AS-13) must fail. AS-11 / AS-14 are expected to SURVIVE: noAdminFields still lists
               'role' on create and the owner branch — defence in depth, proven by D12. */
            M4: { rules: (() => { let r = src; const n = r.split("'permissions','role',").length - 1; if (n !== 2) throw new Error('anchor role x' + n); r = r.split("'permissions','role',").join("'permissions',"); return swap(r, 'rolesUnchanged'); })(), must: ['AS-12', 'AS-13'] },
            /* break D12: D1 + 'role' out of noAdminFields → all four role rows must fail */
            M5: { rules: (() => { let r = src; for (const [a, k] of [["'permissions','role',", 2], ["'role','approved','approvedAt','approvedBy',", 2]]) { const n = r.split(a).length - 1; if (n !== k) throw new Error('anchor ' + a + ' x' + n); r = r.split(a).join(a.replace("'role',", '')); } return swap(r, 'rolesUnchanged'); })(), must: ['AS-11', 'AS-12', 'AS-13', 'AS-14'] },
            M3: { rules: (() => { const a = "in ['suspended', 'banned']"; if (src.split(a).length !== 2) throw new Error('anchor banned'); return src.replace(a, "in ['suspended']"); })(), must: ['AS-7b'] } };
let bad = 0;
for (const [name, m] of Object.entries(M)) {
  const tmp = 'zz-mutant-' + name + '.rules'; fs.writeFileSync(path.resolve(__dirname, '..', tmp), m.rules);
  const r = spawnSync(process.execPath, [path.join(__dirname, 'zz-test-account-state-rules.js')], { env: Object.assign({}, process.env, { RULES_FILE: tmp }), encoding: 'utf8' });
  fs.unlinkSync(path.resolve(__dirname, '..', tmp));
  const out = (r.stdout || '') + (r.stderr || '');
  if (/HARNESS ERROR/.test(out)) { console.log('  ' + name + ' HARNESS ERROR — no verdict'); bad++; continue; }
  const missed = m.must.filter((id) => !new RegExp('FAIL\\s+' + id.replace('-', '\\-') + '(?![\\w-])').test(out));
  console.log('  ' + name + (missed.length ? ' NOT CAUGHT by ' + missed.join(', ') : ' caught by ' + m.must.join(', ')));
  if (missed.length) bad++;
}
process.exit(bad ? 1 : 0);
