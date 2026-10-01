#!/usr/bin/env node
/* test-adminos-ticket-badge-after-gate.js — the AdminOS sidebar ticket-badge listener must start only
 * AFTER the admin gate passes (found by sokoni-27, 2026-10-01: it ran at DOMContentLoaded before the
 * gate, so every non-admin load issued a supportTickets query the served rules refused).
 *   G1 admin-os.html issues no supportTickets query outside SokoniAOS
 *   G2 sokoni-aos.js starts the badge only inside _bootUI, which runs after guard('admin')
 *   G3 executed: _startTicketBadge is idempotent and hides the badge on a listener error (never a fake count)
 *   N1 negative control: re-inserting the inline listener makes G1 fail
 */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ck = (l, ok, got) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok ? '' : '   [got ' + JSON.stringify(got) + ']')); ok ? pass++ : fail++; };
const html = fs.readFileSync(path.join(ROOT, 'admin-os.html'), 'utf8');
const aos = fs.readFileSync(path.join(ROOT, 'sokoni-aos.js'), 'utf8');
const inlineQuery = (s) => /collection\(\s*["']supportTickets["']\s*\)/.test(s);
ck('G1 admin-os.html issues no supportTickets query of its own', !inlineQuery(html), null);
const boot = aos.slice(aos.indexOf('function _bootUI() {'), aos.indexOf('function _startTicketBadge'));
const gateIdx = aos.indexOf("await window.SokoniAdminEntry.guard('admin')"), bootCallIdx = aos.indexOf('_bootUI();', gateIdx);
ck('G2 the badge starts inside _bootUI, which is called after guard(\'admin\')', /_startTicketBadge\(\);/.test(boot) && gateIdx > 0 && bootCallIdx > gateIdx, { gateIdx, bootCallIdx });
{
  const a = aos.indexOf('let _ticketUnsub = null;');
  let i = aos.indexOf('function _startTicketBadge() {'), d = 0, j = aos.indexOf('{', i);
  for (; j < aos.length; j++) { if (aos[j] === '{') d++; else if (aos[j] === '}') { d--; if (d === 0) break; } }
  const fnSrc = aos.slice(a, j + 1);
  let subs = 0; let errCb = null; const badge = { textContent: '', hidden: false };
  const firebase = { firestore: () => ({ collection: () => ({ where: () => ({ onSnapshot: (ok, err) => { subs++; errCb = err; return () => {}; } }) }) }) };
  const document = { getElementById: () => badge };
  const window = { addEventListener() {} };
  const start = new Function('firebase', 'document', 'window', fnSrc + '\nreturn _startTicketBadge;')(firebase, document, window);
  start(); start();
  errCb && errCb(new Error('permission-denied'));
  ck('G3 idempotent (one listener) and a denied/failed listener hides the badge', subs === 1 && badge.hidden === true && badge.textContent === '', { subs, badge });
}
ck('N1 negative control: the old inline listener would fail G1', inlineQuery(html + '\nfirebase.firestore().collection("supportTickets").where("status","==","open")'), null);
console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
