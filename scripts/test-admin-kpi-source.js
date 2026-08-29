'use strict';
/* Admin dashboard KPI source fix — the tiles must read the canonical execRes
   (adminGetExecutiveDashboard) not `m` (adminGetPlatformOverview, wrong shape),
   and no-source tiles must show a neutral state, never a fabricated 0/99.9%. */
const fs = require('fs'); const path = require('path');
const s = fs.readFileSync(path.join(__dirname, '..', 'sokoni-aos.js'), 'utf8');
const blk = (s.match(/const ex = execRes\.value[\s\S]*?kpiPlatformUptime[^\n]*\n/) || [''])[0];
let pass = 0, fail = 0;
const ok = n => { pass++; console.log('  [PASS] ' + n); };
const no = n => { fail++; console.log('  [FAIL] ' + n); };
(/const ex = execRes\.value/.test(blk)) ? ok('tiles source from execRes (adminGetExecutiveDashboard)') : no('not sourced from execRes');
(/kpiActiveProviders[^\n]*ex\.activeProviders/.test(blk)) ? ok('kpiActiveProviders ← ex.activeProviders') : no('providers not repointed');
(/kpiActiveSellers[^\n]*ex\.merchants/.test(blk)) ? ok('kpiActiveSellers ← ex.merchants (active businesses)') : no('sellers not repointed');
(/kpiCommission[^\n]*ex\.commissionToday/.test(blk)) ? ok('kpiCommission ← ex.commissionToday') : no('commission not repointed');
(/kpiActiveSubs[^\n]*ex\.activeSubscriptions/.test(blk)) ? ok('kpiActiveSubs ← ex.activeSubscriptions') : no('subs not repointed');
(!/m\.(activeSellers|activeProviders|activeRiders|commissionEarned|failedPayments|refundRequests|activeSubscriptions|inventoryAlerts|mrr|uptimePct)/.test(blk)) ? ok('no stale m.* reads remain in the KPI block') : no('stale m.* reads remain');
/* no-source tiles → neutral NA, never 0 or 99.9 */
const naTiles = ['kpiActiveRiders','kpiFailedPayments','kpiRefundRequests','kpiInventoryAlerts','kpiMRR','kpiPlatformUptime'];
const allNA = naTiles.every(t => new RegExp(t + '[^\n]*NA').test(blk));
allNA ? ok('no-source tiles (riders/failed/refunds/inventory/mrr/uptime) show neutral NA') : no('a no-source tile not neutral');
(!/99\.9/.test(blk)) ? ok('the fabricated 99.9% uptime default is gone') : no('99.9% still present');
console.log('\n' + (fail === 0 ? `admin-kpi-source: PASS ${pass}/${pass}` : `admin-kpi-source: ${fail} FAIL`));
process.exit(fail ? 1 : 0);
