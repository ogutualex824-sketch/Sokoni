/* Enforces docs/CANONICAL_COLLECTIONS.md as an engineering RULE, not just a doc.
 *
 * Each rule names a collection that is canonical for a specific DOMAIN, and the ONLY
 * files allowed to touch the *wrong* collection for that domain (the subsystem that
 * legitimately owns it, plus any explicitly-baselined legacy). A new file reaching for
 * the wrong collection fails the deploy gate — forcing either the canonical collection
 * or a conscious owner/baseline entry with a migration note.
 *
 * This is intentionally coarse (per-file presence). It exists to stop the stale-collection
 * class of bug (invisible data, empty admin panels) — not to police every line.
 *
 *   node scripts/test-canonical-collections.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const RULES = [
  {
    // Wallet withdrawals live in `payoutRequests`. `payouts` is the SEPARATE FinOS payout
    // store — legitimate only inside the FinOS subsystem. Anywhere else it's the bug that
    // made the admin payout queue read empty while real withdrawals sat in payoutRequests.
    collection: 'payouts',
    canonical: 'payoutRequests',
    domain: 'wallet withdrawals',
    owners: ['finos.js', 'finos-router.js', 'finos-utils.js', 'financial-os.js', 'automation-engine.js', 'email-triggers.js', 'settlement-engine.js'],
    baseline: ['admin-os.js'],   // legacy adminApprovePayouts — migrate to adminProcessPayout (payoutRequests)
  },
];

const dir = path.resolve('functions');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));

let pass = 0, fail = 0;
const t = (n, v) => { v ? (pass++, console.log('  PASS  ' + n)) : (fail++, console.log('  FAIL  ' + n)); };

console.log('\n=== canonical-collection domain rules (docs/CANONICAL_COLLECTIONS.md) ===');
for (const rule of RULES) {
  const re = new RegExp("collection\\(['\"]" + rule.collection + "['\"]\\)");
  const allowed = new Set([...rule.owners, ...rule.baseline]);
  const offenders = files.filter((f) => !allowed.has(f) && re.test(fs.readFileSync(path.join(dir, f), 'utf8')));
  t(`collection("${rule.collection}") only in owners/baseline — use ${rule.canonical} for ${rule.domain}`
    + (offenders.length ? `  ✗ NEW offender(s): ${offenders.join(', ')} → read ${rule.canonical} or add to owners with a migration note` : ''),
    offenders.length === 0);
}

console.log('\n=== the doc itself exists (the rule\'s source of truth) ===');
t('docs/CANONICAL_COLLECTIONS.md present', fs.existsSync(path.resolve('docs/CANONICAL_COLLECTIONS.md')));

console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' PASSED'));
process.exitCode = fail ? 1 : 0;
