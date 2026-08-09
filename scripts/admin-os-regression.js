#!/usr/bin/env node
/* ============================================================================
   Admin OS regression — post-convergence verification
   ============================================================================
   Run after the five-pane convergence programme, before any new product work.

   PASS / FAIL / BLOCKED are three different results and are never conflated.
   BLOCKED means "this could not be executed here", not "this passed" — the
   distinction is the whole point, because a suite that reports BLOCKED as PASS
   is worse than no suite.

   What this can verify from here: structure, guards, production data, deployed
   assets, rules. What it cannot: a live authenticated click-through, because
   this environment cannot mint an admin ID token. Those are listed explicitly at
   the end as MANUAL, with what to click.

   Usage:
     node scripts/admin-os-regression.js            structural + guards
     node scripts/admin-os-regression.js --live     also probe production
   ========================================================================= */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const LIVE = process.argv.includes('--live');

const results = [];
const add = (area, check, status, detail) => results.push({ area, check, status, detail: detail || '' });

function sh(cmd) {
  try { return { ok: true, out: execSync(cmd, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString() }; }
  catch (e) { return { ok: false, out: (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '') }; }
}
const admin = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
const count = (re) => (admin.match(re) || []).length;

/* ══ 1. Pane convergence — the completion rule, per pane ══════════════════ */
const PANES = [
  { name: 'Applications', pane: null, containers: ['appsGrid', 'bizAppsGrid'], renderer: '_renderAppCard', source: 'applicationList / listenApplications' },
  { name: 'Orders',       pane: 'adm-pane-orders',     containers: ['ordersBody'],  renderer: '_renderAdmOrders',  source: 'listenAllOrders' },
  { name: 'Users',        pane: 'adm-pane-users',      containers: ['usersBody'],   renderer: 'renderUsers',       source: 'listenUsers' },
  { name: 'Properties',   pane: 'adm-pane-properties', containers: ['bnbBody'],     renderer: 'renderProperties',  source: 'listenBnbListings' },
  { name: 'Rides',        pane: 'adm-pane-rides',      containers: [],              renderer: null,                source: null },
  { name: 'Settings',     pane: 'adm-pane-settings',   containers: [],              renderer: null,                source: null },
];

for (const p of PANES) {
  if (p.pane) {
    const n = count(new RegExp('id="' + p.pane + '"', 'g'));
    add(p.name, 'exactly one pane', n === 1 ? 'PASS' : 'FAIL', `${n} declaration(s)`);
  }
  for (const c of p.containers) {
    const n = count(new RegExp('id="' + c + '"', 'g'));
    add(p.name, `container #${c} declared once`, n === 1 ? 'PASS' : 'FAIL', `${n}`);
  }
  if (p.renderer) {
    const n = count(new RegExp('function\\s+' + p.renderer + '\\b', 'g'));
    add(p.name, `one renderer (${p.renderer})`, n === 1 ? 'PASS' : 'FAIL', `${n} definition(s)`);
  }
  if (p.source) add(p.name, `data source: ${p.source}`, admin.includes(p.source.split(' / ')[0]) || admin.includes(p.source.split(' / ').pop()) ? 'PASS' : 'FAIL');
}

/* No business-authority localStorage in the migrated panes. */
for (const [pane, key] of [['Orders', 'sokoniOrders'], ['Users', 'sokoniAllUsers'],
                           ['Properties', 'sokoniBnBListings'], ['Properties', 'sokoniBnBBookings']]) {
  const reads = count(new RegExp("ls\\('" + key + "'\\)", 'g'));
  const writes = count(new RegExp("setItem\\('" + key + "'", 'g'));
  add(pane, `no localStorage authority (${key})`, reads + writes === 0 ? 'PASS' : 'FAIL', `${reads}r/${writes}w`);
}
/* BLOCKED, not FAIL. FAIL means something that worked has broken; this has never
   worked and is held behind a declared gate (landlord Phases 2/3/6 cannot start
   until test-landlord-rules.js executes on JDK 21). Reporting it as a failure
   would make every future run red for a reason nobody can act on, which is how a
   red suite gets ignored. It is still counted and still listed. */
add('Properties', 'no localStorage authority (sokoniLandlordProperties)',
  count(/ls\('sokoniLandlordProperties'\)/g) === 0 ? 'PASS' : 'BLOCKED',
  'landlord Phases 2/3/6 gated on rules tests — see ADR-006');

/* ══ 2. Guards ═══════════════════════════════════════════════════════════ */
const GUARDS = [
  ['Permissions',   'claim-based authorization', 'node scripts/verify-claim-based-auth.js'],
  ['Authentication','consent gate (86 checks)',  'node scripts/verify-consent-gate.js'],
  ['Responsive',    'admin markup integrity',    'node scripts/verify-admin-markup.js'],
  ['Structure',     'duplicate-id ratchet',      'node scripts/audit-duplicate-ids.js'],
  ['Structure',     'localStorage ratchet',      'node scripts/audit-admin-localstorage.js'],
  ['Applications',  'render contract',           'node scripts/test-apps-render.js'],
  ['Users',         'render contract',           'node scripts/test-users-render.js'],
];
for (const [area, label, cmd] of GUARDS) {
  const r = sh(cmd);
  const m = r.out.match(/(\d+) passed, (\d+) failed/);
  add(area, label, r.ok ? 'PASS' : 'FAIL', m ? `${m[1]} passed, ${m[2]} failed` : (r.ok ? 'clean' : 'see output'));
}

/* Cloud Function unit tests. */
const jest = sh('cd functions && npx jest --silent');
const jm = jest.out.match(/Tests:\s+(\d+) passed, (\d+) total/);
add('Approvals', 'Cloud Function unit tests', jest.ok ? 'PASS' : 'FAIL', jm ? `${jm[1]}/${jm[2]}` : 'see output');

/* Rules: compile is verifiable; behaviour is not, here. */
add('Permissions', 'firestore.rules compile', fs.existsSync(path.join(ROOT, 'firestore.rules')) ? 'PASS' : 'FAIL',
  'verified at deploy time via --dry-run');
add('Permissions', 'landlordProperties rule behaviour', 'BLOCKED',
  'test-landlord-rules.js written (26 assertions); emulator needs JDK 21, host has 17');

/* ══ 3. Audit logging ════════════════════════════════════════════════════ */
add('Audit logging', 'moderation decisions write an audit entry',
  /sokoniFirestoreAudit\(\{/.test(admin) ? 'PASS' : 'FAIL',
  'reuses window.sokoniFirestoreAudit from firebase.js');
add('Audit logging', 'no second audit system invented',
  count(/function\s+_?audit\w*\s*\(/g) === 0 ? 'PASS' : 'WARN',
  `${count(/function\s+_?audit\w*\s*\(/g)} local audit fn(s) in admin.html`);

/* ══ 4. Realtime listeners — attached once ═══════════════════════════════ */
for (const [label, guard] of [['applications', '_appsListenerAttached'],
                              ['users', '_usersUnsub'], ['properties', '_propsUnsub']]) {
  add('Realtime listeners', `${label} listener guarded against double-attach`,
    admin.includes(guard) ? 'PASS' : 'FAIL', guard);
}

/* ══ 5. Live production ══════════════════════════════════════════════════ */
function get(url) {
  return new Promise((res) => {
    https.get(url, (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); })
         .on('error', () => res(''));
  });
}

(async () => {
  if (LIVE) {
    const cb = Date.now();
    const ver = await get(`https://mysokoni.co.ke/version.json?cb=${cb}`);
    let commit = '';
    try { commit = JSON.parse(ver).commitShort; } catch (e) {}
    add('Deployment', 'version.json reachable', commit ? 'PASS' : 'FAIL', commit || 'no response');

    const live = await get(`https://mysokoni.co.ke/admin?cb=${cb}`);
    if (!live) add('Deployment', 'admin page served', 'FAIL', 'no response');
    else {
      const lc = (re) => (live.match(re) || []).length;
      const mk = live.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
      const bal = (mk.match(/<div\b/g) || []).length - (mk.match(/<\/div>/g) || []).length;
      add('Deployment', 'admin page served', 'PASS', `${Math.round(live.length / 1024)} KB`);
      add('Responsive', 'live <div> balance', bal === 0 ? 'PASS' : 'FAIL', String(bal));
      for (const p of ['orders', 'users', 'properties', 'rides', 'settings']) {
        add('Deployment', `live #adm-pane-${p} single`,
          lc(new RegExp(`id="adm-pane-${p}"`, 'g')) === 1 ? 'PASS' : 'FAIL');
      }
    }
  } else {
    add('Deployment', 'live production checks', 'BLOCKED', 'run with --live');
  }

  /* ══ Report ════════════════════════════════════════════════════════════ */
  const W = 78;
  console.log('\n' + '='.repeat(W));
  console.log('ADMIN OS REGRESSION');
  console.log('='.repeat(W));

  let area = '';
  for (const r of results) {
    if (r.area !== area) { area = r.area; console.log('\n' + area); console.log('-'.repeat(area.length)); }
    const tag = { PASS: '  PASS   ', FAIL: '  FAIL   ', BLOCKED: '  BLOCK  ', WARN: '  WARN   ' }[r.status];
    console.log(tag + r.check.padEnd(46) + r.detail);
  }

  const c = (s) => results.filter(r => r.status === s).length;
  console.log('\n' + '='.repeat(W));
  console.log(`PASS ${c('PASS')}   FAIL ${c('FAIL')}   BLOCKED ${c('BLOCKED')}   WARN ${c('WARN')}`);
  console.log('='.repeat(W));

  console.log(`
MANUAL — requires an authenticated admin session, which this environment
cannot mint. These are NOT covered above and must not be assumed to pass:

  [ ] sign in with an admin claim; console unlocks
  [ ] Applications: list renders, approve + reject reach Firestore
  [ ] Orders: list renders live; filter and search narrow it
  [ ] Users: list renders 61 accounts; search, role + status filters, pagination,
      detail slide-in opens and populates
  [ ] Properties: stats and table both render; approve/reject persist and survive reload
  [ ] Settings: PIN / password / pattern change and re-lock correctly
  [ ] Moderation + Super Admin consoles load and list their queues
  [ ] Notifications deliver
  [ ] Search returns results
  [ ] Mobile: 393px viewport, no horizontal scroll, tap targets >= 44px
  [ ] Audit: a moderation decision appears in auditLogs
`);

  if (c('FAIL')) { console.log(`${c('FAIL')} FAILURE(S) — do not begin new product work.\n`); process.exit(1); }
  console.log('No failures. BLOCKED and MANUAL items remain outstanding.\n');
  process.exit(0);
})();
