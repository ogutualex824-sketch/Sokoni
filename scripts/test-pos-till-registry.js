#!/usr/bin/env node
/**
 * POS TILL REGISTRY — saved is not connected, and setup happens once.
 *
 *   node scripts/test-pos-till-registry.js
 *
 * Two defects are being locked out here, and both were observed on a real till.
 *
 * 1 · "Devices says saved, Till Setup says no printer."
 *     They read different things. Devices read the durable list; Till Setup read a
 *     live postMessage broadcast. Neither was wrong; there was simply no canonical
 *     answer. The registry is now that answer, and it distinguishes the two states
 *     rather than collapsing them.
 *
 * 2 · "POS setup keeps coming back."
 *     Completion was one browser-global flag, so a shared till leaked one merchant's
 *     completion to the next, and anything that cleared storage sent a working till
 *     back through onboarding.
 *
 * THE ASSERTION THAT MATTERS MOST IS THE ONE THAT REFUSES TO GUESS: a saved printer
 * must NEVER report connected. Web Bluetooth cannot silently re-open a GATT link, so
 * a till claiming "connected" after a reload would be asserting a transport it does
 * not have — and the first thing the cashier would learn is a customer's receipt
 * failing to print.
 */
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const NL = String.fromCharCode(10);

/* A real localStorage would be the browser's; here it is a stand-in so the CONTRACT
   can be tested without one. The module only ever calls getItem/setItem/removeItem. */
const store = {};
global.localStorage = {
  getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
const R = require(path.join(ROOT, 'sokoni-till-registry.js'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 86) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log(NL + t);
const reset = () => { Object.keys(store).forEach((k) => delete store[k]); };

const UID = 'SELLER_A', OTHER = 'SELLER_B';
const P58E = { type: 'printer', id: 'BT:58:E1', name: 'P58E' };

console.log(NL + 'POS TILL REGISTRY' + NL + '='.repeat(60));

/* ── 1 · saved and connected are different facts ──────────────────────────── */
head('1 · saved is not connected');
reset();
ck('nothing paired ⇒ none', R.printer(UID).state === R.STATE.NONE);
ck('...and no device is claimed', R.printer(UID).saved === null);

R.save(UID, P58E);
const s = R.printer(UID);
ck('a paired printer is SAVED', s.state === R.STATE.SAVED, s.label);
ck('NEGATIVE ...and is NOT reported connected', s.connected === false,
   'a stored pairing is not a live transport');
ck('...and it says a reconnect is needed', s.needsReconnect === true);
ck('...while still naming the device', s.name === 'P58E');

const live = R.printer(UID, true, 'P58E');
ck('an explicit live signal makes it CONNECTED', live.state === R.STATE.CONNECTED);
ck('...and clears needsReconnect', live.needsReconnect === false);

ck('NEGATIVE a truthy-ish value is not a connection',
   R.printer(UID, 'yes').connected === false,
   'only a real boolean true counts — no coercion');
ck('NEGATIVE connected is never inferred with nothing paired',
   R.printer(OTHER).connected === false && R.printer(OTHER).state === R.STATE.NONE);
ck('CONTROL a live connection with NOTHING saved still reports connected',
   R.printer(OTHER, true, 'Borrowed').state === R.STATE.CONNECTED,
   'a cashier may pair a printer this session without it being in the list yet');

/* ── 2 · the registry is per-merchant ─────────────────────────────────────── */
head('2 · a shared till never leaks between merchants');
reset();
R.save(UID, P58E);
ck('the other merchant sees nothing', R.printer(OTHER).state === R.STATE.NONE,
   'the observed defect was a shared till showing the previous merchant hardware');
ck('the key carries the uid', R.key(UID) === 'sk_devices_SELLER_A');
ck('CONTROL signed out gets its own key, not a real uid',
   R.key(null) === 'sk_devices_anon' && R.key(null) !== R.key(UID));

/* ── 3 · pairing is idempotent ────────────────────────────────────────────── */
head('3 · re-pairing updates, it does not accumulate');
reset();
R.save(UID, P58E);
R.save(UID, { type: 'printer', id: 'BT:58:E1', name: 'P58E renamed' });
ck('the same device saved twice appears once', R.load(UID).length === 1,
   'duplicates would make "the" printer ambiguous');
ck('...with the newer name', R.printer(UID).name === 'P58E renamed');
R.save(UID, { type: 'scanner', id: 'USB:1', name: 'Scanner' });
ck('a different TYPE is kept alongside', R.load(UID).length === 2);
ck('...and does not disturb the printer', R.printer(UID).name === 'P58E renamed');
ck('remove takes exactly one device',
   R.remove(UID, 'scanner', 'USB:1').length === 1 && R.printer(UID).saved !== null);

/* ── 4 · setup completes ONCE ─────────────────────────────────────────────── */
head('4 · setup is an initialisation, not a recurring prerequisite');
reset();
ck('a new till is not set up', R.isSetupComplete(UID) === false);
R.markSetupComplete(UID, { branchId: 'BR1', tillId: 'T1' });
ck('completion persists', R.isSetupComplete(UID) === true);
ck('...and records what completed it', R.setupState(UID).branchId === 'BR1');

/* The behaviours that were re-opening the wizard on a working till. */
R.save(UID, { type: 'scanner', id: 'USB:2', name: 'Scanner 2' });
ck('CONTROL adding a device does NOT reset setup', R.isSetupComplete(UID) === true,
   'this is the recurring-setup defect');
R.remove(UID, 'printer', 'BT:58:E1');
ck('CONTROL removing the printer does NOT reset setup', R.isSetupComplete(UID) === true,
   'a disconnected or removed device is not an incomplete setup');
ck('CONTROL a printer being unpaired still leaves setup complete, but printer NONE',
   R.isSetupComplete(UID) === true && R.printer(UID).state === R.STATE.NONE,
   'the two facts are independent, and must stay independent');

ck('NEGATIVE the other merchant is still not set up', R.isSetupComplete(OTHER) === false,
   'completion is per-merchant, like the devices');
R.resetSetup(UID);
ck('only an explicit reset clears it', R.isSetupComplete(UID) === false);

/* ── 5 · the legacy flag is honoured, never re-written ────────────────────── */
head('5 · a till set up before this module is not sent back through the wizard');
reset();
store['sokoni_setup_complete'] = '1';
ck('the legacy flag still counts as complete', R.isSetupComplete(UID) === true);
ck('...and is reported AS legacy, not as this merchant record',
   R.setupState(UID).legacy === true,
   'it is browser-global, so it cannot prove WHICH merchant completed it');
R.markSetupComplete(UID, {});
ck('CONTROL a real completion supersedes it',
   R.setupState(UID).legacy === undefined && R.isSetupComplete(UID) === true);
reset();
R.markSetupComplete(UID, {});
ck('CONTROL the legacy flag is never written by this module',
   store['sokoni_setup_complete'] === undefined,
   'writing it would re-create the shared-till leak');

/* ── 6 · storage that fails must not take the till down ───────────────────── */
head('6 · unavailable storage degrades, it does not throw');
const realLS = global.localStorage;
global.localStorage = {
  getItem: () => { throw new Error('denied'); },
  setItem: () => { throw new Error('denied'); },
  removeItem: () => { throw new Error('denied'); },
};
let threw = false;
let st = null;
try { st = R.printer(UID); R.save(UID, P58E); R.isSetupComplete(UID); }
catch (_) { threw = true; }
ck('no throw when storage is unavailable', threw === false,
   'a private-mode browser must still boot the POS');
ck('...and it reports NONE rather than a guess', st && st.state === R.STATE.NONE);
global.localStorage = realLS;

reset();
store[R.key(UID)] = '{ this is not json';
ck('CONTROL corrupt storage reads as empty, not as a crash',
   R.load(UID).length === 0 && R.printer(UID).state === R.STATE.NONE);

console.log(NL + '  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
