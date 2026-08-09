#!/usr/bin/env node
/* ============================================================================
   Admin localStorage audit — business authority must live in Firestore
   ============================================================================
   Three panes in a row turned out to be reading or writing business state from
   localStorage, and each failed the same way: localStorage is per-origin AND
   per-device, so what one administrator saw was never what another saw, and what
   a customer wrote was never visible to either.

     Orders     — a legacy pipeline whose dispute button wrote localStorage only,
                  losing the write entirely.
     Users      — sokoniAllUsers had one reader and one writer and nothing ever
                  populated it, so the pane said "No users found" permanently
                  while 61 accounts sat in Firestore.
     Properties — approving a listing changed nothing any host or guest could see.

   This enumerates every key an admin page touches and classifies it. UI state is
   legitimate and stays. Business state is not and must move.

   Usage:
     node scripts/audit-admin-localstorage.js            report
     node scripts/audit-admin-localstorage.js --ci       fail on unclassified or REPLACE
   ========================================================================= */

'use strict';

const fs   = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const CI   = process.argv.includes('--ci');

/* Pages that administer the platform. A key is only in scope if one of these
   touches it — a customer page caching its own draft is not this audit's
   business. */
const ADMIN_PAGES = [
  'admin.html', 'super-admin.html', 'moderation.html', 'trust-safety.html',
  'verification-admin.html', 'commission-admin.html', 'admin-messages.html',
];

/* ── Allowlist: genuinely client-only state ────────────────────────────────
   Each entry needs a reason. "It looks like UI" is not a reason; the test is
   whether losing this key, or another device holding a different value, could
   change a business outcome. If it could, it does not belong here. */
const KEEP = {
  'sokoniAdminUnlocked':   'session flag for the local console lock — per-device by design',
  'sokoniAdminSessionTs':  'lock timeout stamp — per-device by design',
  'sokoniAdminPinHash':    'local console lock credential — see ADMIN_CREDENTIAL_RISK_REPORT.md',
  'sokoniAdminPatternHash':'local console lock credential',
  'sokoniAdminPwHash':     'local console lock credential',
  'sokoniTheme':           'UI preference',
  'admLight':              'UI preference — light/dark toggle',
  'sokoniSidebarCollapsed':'UI preference',
  'sokoniGaId':            'analytics measurement id, mirrored for the admin form',
  'sokoniPrivacyAccepted': 'consent decision — must be per-device; see the consent gate',
  'sokoniPrivacyRejected': 'consent decision — must be per-device',
  '_sokoniBetaMode':       'per-device beta widget opt-in',
  'sokoniUser':            'cached auth identity for display; authority is the ID token',
  'admDarkMode':           'UI preference — light/dark toggle',
  'sokoniDemoSeeded':      'per-device flag: has demo data been seeded here',
  'sokoniDemoData':        'per-device demo payload, gated behind _demoAllowed',
};

/* Keys already migrated, kept so a regression is reported as a regression rather
   than appearing as a brand-new finding. */
const MIGRATED = {
  'sokoniOrders':      'migrated 2026-08-01 — Firestore orders is authoritative',
  'sokoniAllUsers':    'migrated 2026-08-01 — Firestore users is authoritative',
  'sokoniBnBListings': 'migrated 2026-08-01 — Firestore bnbListings is authoritative',
  'sokoniBnBBookings': 'migrated 2026-08-01 — Firestore bnbBookings is authoritative',
};

const CALL = /localStorage\s*\.\s*(getItem|setItem|removeItem)\s*\(\s*['"`]([^'"`]+)['"`]/g;
const LS_HELPER = /\bls\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;   /* admin.html's ls() wrapper */

const found = new Map();   /* key -> { pages:Set, reads:n, writes:n } */

function record(key, page, kind) {
  if (!found.has(key)) found.set(key, { pages: new Set(), reads: 0, writes: 0 });
  const e = found.get(key);
  e.pages.add(page);
  if (kind === 'read') e.reads++; else e.writes++;
}

for (const page of ADMIN_PAGES) {
  const fp = path.join(ROOT, page);
  if (!fs.existsSync(fp)) continue;
  const src = fs.readFileSync(fp, 'utf8');

  let m;
  CALL.lastIndex = 0;
  while ((m = CALL.exec(src))) {
    record(m[2], page, m[1] === 'getItem' ? 'read' : 'write');
  }
  LS_HELPER.lastIndex = 0;
  while ((m = LS_HELPER.exec(src))) record(m[1], page, 'read');
}

const rows = [...found.entries()].sort((a, b) => a[0].localeCompare(b[0]));

function classify(key) {
  if (KEEP[key])     return { action: 'KEEP',    reason: KEEP[key] };
  if (MIGRATED[key]) return { action: 'REMOVE',  reason: MIGRATED[key] };
  return { action: 'REPLACE', reason: 'unclassified — business authority until proven otherwise' };
}

console.log('\nAdmin localStorage inventory');
console.log('='.repeat(96));
console.log('key'.padEnd(30) + 'r/w'.padEnd(7) + 'action'.padEnd(10) + 'pages / reason');
console.log('-'.repeat(96));

let replace = 0, keep = 0, remove = 0;
for (const [key, e] of rows) {
  const c = classify(key);
  if (c.action === 'REPLACE') replace++; else if (c.action === 'KEEP') keep++; else remove++;
  console.log(
    key.slice(0, 29).padEnd(30) +
    (e.reads + '/' + e.writes).padEnd(7) +
    c.action.padEnd(10) +
    (c.action === 'REPLACE' ? [...e.pages].join(', ') : c.reason).slice(0, 48)
  );
}

console.log('-'.repeat(96));
console.log(`${rows.length} key(s):  ${keep} KEEP · ${replace} REPLACE · ${remove} REMOVE(migrated)\n`);

if (replace) {
  console.log('REPLACE means an admin page treats this key as business authority.');
  console.log('localStorage is per-origin AND per-device: what one administrator sees is');
  console.log('not what another sees, and what a customer writes reaches neither.\n');
}

/* ── Ratchet, then a wall ───────────────────────────────────────────────────
   There are 45 of these today. An absolute guard would fail every deploy until
   the whole backlog is cleared, and a gate that blocks everything gets disabled
   and then ignored — so the default mode fails only when the count RISES.

   --ci is the absolute form and is the end state: once the count reaches zero,
   switch predeploy to it and the door closes permanently. Until then the number
   may fall freely and may never rise. Never raise the baseline to make a failure
   go away; that is the one move that turns this into decoration. */
const BASELINE_FILE = path.join(__dirname, 'admin-localstorage-baseline.json');
let baseline = null;
try { baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')); } catch (e) {}

if (process.argv.includes('--update-baseline')) {
  fs.writeFileSync(BASELINE_FILE, JSON.stringify({ replace, keys: rows.map(r => r[0]) }, null, 2) + '\n');
  console.log('baseline written: ' + replace + ' REPLACE key(s)\n');
  process.exit(0);
}

if (CI) {
  if (replace) {
    console.log(`FAIL (--ci): ${replace} business-authority key(s) in admin pages.\n`);
    process.exit(1);
  }
  console.log('No business-authority localStorage in admin pages.\n');
  process.exit(0);
}

if (baseline && replace > baseline.replace) {
  const added = rows.map(r => r[0]).filter(k => !baseline.keys.includes(k) && classify(k).action === 'REPLACE');
  console.log(`REGRESSION: business-authority keys went ${baseline.replace} -> ${replace}`);
  if (added.length) console.log('  new: ' + added.join(', '));
  console.log('\n  A new admin page reading business state from localStorage is the exact');
  console.log('  class of defect this programme has been removing. Put it in Firestore.\n');
  process.exit(1);
}
if (baseline && replace < baseline.replace) {
  console.log(`improved: ${baseline.replace} -> ${replace}; run --update-baseline to lock it in\n`);
}
process.exit(0);
