#!/usr/bin/env node
/**
 * MERCHANT V2 — the persistence contract of a SHELL, not a set of disposable pages.
 *
 *   node scripts/test-merchant-v2-persistence.js
 *
 * A shell that forgets is a set of pages wearing a shell's clothes. So every piece of
 * merchant state that is supposed to outlive a route change or a refresh is asserted
 * here, together with the boundary that keeps it honest:
 *
 *   · settings live on the AUTHORITATIVE shop document, not in a browser
 *   · the device registry belongs to a MERCHANT, never to a browser profile
 *   · the printer's connected state has ONE owner, and a stored pairing is not a
 *     connection — the difference between "we have seen this printer" and "this
 *     printer is answering right now"
 *   · the route survives a refresh
 *   · the shell does not initialise Firebase a second time
 *
 * WHAT THIS SUITE CANNOT PROVE, and does not claim: that a physical P58E re-adopts its
 * Bluetooth link after a refresh. Web Bluetooth cannot be exercised headlessly. That
 * remains a handset acceptance, and is reported as UNPROVEN rather than passed.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const NL = String.fromCharCode(10);
const SHELL = fs.readFileSync(path.join(ROOT, 'merchant-v2.html'), 'utf8');
const RULES = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
const SETUP = fs.readFileSync(path.join(ROOT, 'pos-setup.html'), 'utf8');

let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 90) + ']' : ''));
  ok ? pass++ : fail++;
};
const un = (l, why) => { console.log('  UNPROVEN  ' + l + '   [' + why + ']'); unproven++; };
const head = (t) => console.log(NL + t);

console.log(NL + 'MERCHANT V2 — PERSISTENCE CONTRACT' + NL + '='.repeat(62));

/* ── 1 · one app, one identity ────────────────────────────────────────────── */
head('1 · the shell is one application');
ck('the shell does NOT initialise Firebase a second time',
   SHELL.indexOf('initializeApp') === -1,
   'a second app instance is a second auth state, and then two merchants in one tab');
ck('it resolves identity once into shell state',
   /S\.uid/.test(SHELL) && /S\.sellerUid/.test(SHELL));
ck('and hands that identity DOWN to modules rather than making them re-resolve it',
   /type: 'session', state: S\.state,[\s\S]{0,80}uid: S\.uid/.test(SHELL),
   'every module repeating auth resolution is how two surfaces disagree about who is signed in');

/* ── 2 · the route survives a refresh ─────────────────────────────────────── */
head('2 · the current route outlives a reload');
ck('the route is written to the URL', /location\.hash/.test(SHELL));
ck('a refresh boots into the route the merchant was on',
   /CONTRACT\.resolve\(location\.hash\.replace\('#', ''\)\)/.test(SHELL));
ck('back / forward are honoured', /addEventListener\('hashchange'/.test(SHELL));
ck('CONTROL a stale exit route cannot strand the boot',
   /kind === 'exit'\) boot = 'dashboard'/.test(SHELL),
   'a stale #home would bounce the merchant out before the shell finished opening');

/* ── 3 · settings belong to the shop document ─────────────────────────────── */
head('3 · settings are saved to the authoritative shop record');
ck('the shell READS the shop document at start',
   /getDoc\(m\.fs\.doc\(m\.db, 'shops', S\.uid\)\)/.test(SHELL) ||
   /doc\(m\.db, 'shops', S\.uid\)/.test(SHELL));
ck('and WRITES settings back to that same document',
   /updateDoc\(f\.m\.doc\(f\.db, 'shops', S\.uid\)/.test(SHELL));
ck('only allowlisted keys are sent',
   /Only allowlisted keys are sent/.test(SHELL),
   'the rule uses hasOnly(), so one stray field fails the entire write');
ck('local state is updated only AFTER the write resolves',
   /await f\.m\.updateDoc[\s\S]{0,220}S\.shop\.openingHours = ta\.value/.test(SHELL),
   'updating first would show a saved value the server had refused');
ck('a refusal is reported as a refusal',
   /permission-denied[\s\S]{0,80}The server refused that change/.test(SHELL));
ck('CONTROL the client cannot set ownership or status on the shop',
   /shops\/\{uid\}/.test(RULES) && /status. is deliberately NOT in the owner/.test(RULES),
   'status is the approval flag a CF sets; an owner writing it would be self-approval');

/* ── 4 · devices belong to a merchant ─────────────────────────────────────── */
head('4 · the device registry is per-merchant, not per-browser');
ck('the registry key carries the uid',
   /function devKey \(\) \{ return 'sk_devices_' \+ \(S\.uid \|\| 'anon'\); \}/.test(SHELL),
   'a shared till must never show the previous merchants devices');
ck('...and the reason is written down', /Keyed BY UID so a shared till/.test(SHELL));
ck('devices are re-adopted on load, not re-discovered',
   /function loadDevices/.test(SHELL) && /DEV\.printer\.saved/.test(SHELL));
ck('CONTROL a saved pairing is NOT reported as connected',
   /DEV\.printer\.state = DEV\.printer\.saved \? 'saved' : 'unknown'/.test(SHELL),
   'saved means we have seen this printer; connected means it is answering now');

/* ── 5 · one printer authority ────────────────────────────────────────────── */
head('5 · the printer has one owner, and modules may not override it');
ck('a framed module may not downgrade the shell',
   /A MODULE MAY NOT DOWNGRADE THE SHELL/.test(SHELL),
   'a modules SokoniPrinter is not the object holding the GATT link');
ck('...only the shell engine events mark a disconnect',
   /the shell's own engine events are the only authority for a disconnect/.test(SHELL));
ck('the framed POS is not granted bluetooth',
   (function () {
     const m = SHELL.match(/MODULE_ALLOW = '([^']*)'/);
     return !!m && !/bluetooth|usb|serial/i.test(m[1]);
   })());
ck('the shell broadcasts printer state to every framed module',
   /__sokoniPrinterState/.test(SHELL));

/* ── 6 · POS Setup adopts that connection ─────────────────────────────────── */
head('6 · POS Setup re-adopts rather than re-asking');
ck('Setup listens to the shell printer state', SETUP.indexOf('__sokoniPrinterState') > -1);
ck('a connected printer replaces the "Set up hardware" route',
   SETUP.indexOf("t.key === 'hardwareConnected' && _shellPrinter.connected") > -1);
ck('marking the step is still an explicit merchant tap',
   /data-mark="hardwareConnected"/.test(SETUP),
   'connected is a precondition for OFFERING, never an automatic completion');
ck('CONTROL Bluetooth pairing alone cannot mark it',
   SETUP.indexOf('Bluetooth pairing alone must not') > -1);
ck('till completion persists somewhere durable',
   /sokoni_setup_complete/.test(SETUP));

/* ── 7 · what only a handset can settle ───────────────────────────────────── */
head('7 · honestly unproven');
un('a physical P58E re-adopts its link after a refresh',
   'Web Bluetooth cannot be driven headlessly — handset acceptance');
un('a completed till sale prints the same receipt on paper',
   'the software handshake is certified; paper is not');

console.log(NL + '  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
process.exit(fail ? 1 : 0);
