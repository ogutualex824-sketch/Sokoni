#!/usr/bin/env node
/* ADMINOS AUTHORITY CORE PILOT on r2 — the LIVE-ONLY audit.read capability check (binding scope 05df4c9), ported VERBATIM
 * from the live adminOsDispatch archive (gen 1788271885523075). An explicit adminPermissions/{uid}.capabilities.audit.read
 * === false DENIES adminGetAuditLogs; no override (or true) leaves the coarse admin claim in charge; a non-admin is refused.
 *   node scripts/test-admin-audit-capability.js            SABOTAGE=1 → every mutation must turn its named row FAIL */
'use strict';
require('./lib/net-firewall').install();
const path = require('path'), fs = require('fs'), os = require('os'), cp = require('child_process');
const ROOT = path.join(__dirname, '..');
if (process.env.SABOTAGE) {
  const M = [
    ['C1', 'admin-os.js', "    return val !== false;                                            // explicit false narrows; grant/absent allows", '    return true;'],
    ['C1', 'admin-os.js', "  if (!(await _adminCapabilityAllows(db, req.auth.uid, 'audit.read'))) {", '  if (false) {'],
  ];
  let caught = 0;
  for (const [row, file, a, b] of M) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aac-')); const FN = path.join(d, 'functions'); fs.mkdirSync(path.join(FN, 'shared'), { recursive: true });
    for (const f of fs.readdirSync(path.join(ROOT, 'functions'))) { const p = path.join(ROOT, 'functions', f); if (f !== 'node_modules' && fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(FN, f)); }
    for (const f of fs.readdirSync(path.join(ROOT, 'functions', 'shared'))) { const p = path.join(ROOT, 'functions', 'shared', f); if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(FN, 'shared', f)); }
    const t = path.join(FN, file), s = fs.readFileSync(t, 'utf8').replace(/\r\n/g, '\n');
    if (s.split(a).length !== 2) { console.log('  BROKEN ' + row); fs.rmSync(d, { recursive: true, force: true }); continue; }
    fs.writeFileSync(t, s.replace(a, () => b));
    let out = ''; try { out = cp.execFileSync(process.execPath, [__filename], { env: Object.assign({}, process.env, { SABOTAGE: '', FN_DIR: FN }), encoding: 'utf8' }); } catch (e) { out = String(e.stdout || ''); }
    const hit = new RegExp('FAIL ' + row + ' ').test(out); console.log('  ' + (hit ? 'CAUGHT' : 'MISSED') + ' ' + row); if (hit) caught++;
    fs.rmSync(d, { recursive: true, force: true });
  }
  console.log('\nSABOTAGE: ' + caught + '/' + M.length + ' caught'); process.exit(caught === M.length ? 0 : 1);
}
const H = require('./lib/inmem-firestore').install({ admins: ['admin1', 'admin2'] });
const { call } = require('./lib/inmem-firestore');
const FN = process.env.FN_DIR || path.join(ROOT, 'functions');
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 240) + ']')); ok ? pass++ : fail++; };
console.log('\nAdminOS Authority Core pilot — audit.read capability (r2)\n');
(async () => {
  const AO = require(path.join(FN, 'admin-os.js'))._h;
  H.reset();
  H.DOCS.set('adminAudit/e1', { action: 'role_changed', createdAt: { toDate: () => new Date() } });
  H.DOCS.set('adminPermissions/admin2', { capabilities: { audit: { read: false } } });
  const allowed = await call(AO.adminGetAuditLogs, 'admin1', {}, { admin: true });
  const revoked = await call(AO.adminGetAuditLogs, 'admin2', {}, { admin: true });
  H.DOCS.set('adminPermissions/admin1', { capabilities: { audit: { read: true } } });
  const granted = await call(AO.adminGetAuditLogs, 'admin1', {}, { admin: true });
  const nonAdmin = await call(AO.adminGetAuditLogs, 'cust', {}, {});
  ck('C1', !!(allowed.ok && allowed.ok.logs.length === 1) && revoked.code === 'permission-denied' && /audit\.read capability revoked/.test(revoked.msg || '')
    && !!(granted.ok && granted.ok.logs.length === 1) && !nonAdmin.ok,
    'no override → the admin claim governs; an EXPLICIT audit.read:false denies that admin; true allows; a non-admin is refused', { allowed: !!allowed.ok, revoked: revoked.code, granted: !!granted.ok, nonAdmin: nonAdmin.code || nonAdmin.msg });
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
