#!/usr/bin/env node
/* run-chain-browser-certs.js — runs every browser (Chromium) certification the 2026-09-30 hosting
 * chain depends on, ONE AT A TIME (concurrent Chromium suites time out page.goto on this machine:
 * contention, not product), and prints a single ledger. Exit 0 only when every suite passes.
 * A suite that crashes or times out is reported as CRASH / TIMEOUT, never as a pass.
 *   node scripts/run-chain-browser-certs.js            (all)
 *   node scripts/run-chain-browser-certs.js name1 name2 (subset, by script basename)
 */
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const SUITES = [
  ['test-header-candidate', []],
  ['test-parcel-page', []],
  ['test-slice-b-support-whatsapp', ['--static']],
  ['test-mv2-3-delivery-hub', []],
  ['test-mv2-2a-supply', []],
  ['test-merchant-route-gate', []],
  ['test-compact-premium-cards', []],
  ['test-cart-browser-certification', []],
  ['test-home-picked-for-you', []],
  ['test-home-hub-card-buttons', []],
  ['test-admin-layouts', []],
  ['test-adminos-sidebar-a11y', []],
  ['test-adminos-nav-coverage', []],
  ['test-adminos-shell-final', []],
  ['test-adminos-head-defer', []],
  ['test-bnb-mobile-layout', []],
  ['test-messages-premium', []],
  ['test-bottom-nav-rendered', []],
  ['test-uploader-mobile-scroll', []],
  ['test-merchant-v2-modules', []],
  ['test-merchant-profile-menu', []],
  ['test-merchant-shop-profile-browser', []],
];
const only = process.argv.slice(2);
const rows = [];
for (const [name, args] of SUITES) {
  if (only.length && !only.includes(name)) continue;
  const file = path.join(ROOT, 'scripts', name + '.js');
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [file, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 15 * 60 * 1000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NODE_PATH: process.env.NODE_PATH || path.join(ROOT, 'node_modules') } });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/(\d+) passed, (\d+) failed[^\n]*/g);
  const last = m ? m[m.length - 1] : null;
  let verdict;
  if (r.error && r.error.code === 'ETIMEDOUT') verdict = 'TIMEOUT';
  else if (r.status === null) verdict = 'KILLED';
  else if (!last && r.status !== 0) verdict = 'CRASH (exit ' + r.status + ')';
  else if (!last) verdict = r.status === 0 ? 'exit 0 (no count line)' : 'CRASH';
  else verdict = last + (r.status === 0 ? '' : '  [exit ' + r.status + ']');
  const ok = r.status === 0 && (!last || /\b0 failed/.test(last));
  rows.push({ name, verdict, ok, secs: Math.round((Date.now() - t0) / 1000), tail: ok ? '' : out.split('\n').filter((l) => /FAIL|Error|CRASH/.test(l)).slice(0, 6).join('\n      ') });
  console.log((ok ? 'OK   ' : 'BAD  ') + name.padEnd(36) + verdict + '  (' + rows[rows.length - 1].secs + 's)');
  if (!ok && rows[rows.length - 1].tail) console.log('      ' + rows[rows.length - 1].tail);
}
const bad = rows.filter((r) => !r.ok);
console.log('\n' + (rows.length - bad.length) + ' suites green, ' + bad.length + ' not green');
process.exit(bad.length ? 1 : 0);
