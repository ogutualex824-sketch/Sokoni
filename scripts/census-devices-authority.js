#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   DEVICES / POS AUTHORITY CENSUS — Stage 1, read-only
   ══════════════════════════════════════════════════════════════════════════════
   Run:  node scripts/census-devices-authority.js
         node scripts/census-devices-authority.js --md > docs/MERCHANT_DEVICES_AUTHORITY.md

   No UI changes. No repairs. No backfill. No deployment.

   FIXTURE
       SELLER_A ── SHOP_B ── DEVICE_B
       SHOP_C   ── DEVICE_C          (someone else's)

   The question is not "does POS device setup work" — it does. The question is
   whether it decides anything. A census that assumed the POS device path was
   the merchant authority because it already functions would have repeated the
   `posLookupCustomer` mistake exactly.

   The decisive property is computed, not asserted in prose: for every device
   callable, this script extracts the FULL function body by brace matching and
   reports whether any ownership token appears in it at all. A body with none
   cannot be scoping anything, whatever its name suggests.

   NEGATIVE CONTROLS abort the run.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MD = process.argv.includes('--md');
const out = [];
const line = (s = '') => out.push(s);
let hardFail = 0;
const must = (l, ok, d) => { if (!ok) { hardFail++; console.error('CONTROL FAILED: ' + l + (d ? ' — ' + d : '')); } };

const read = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { return ''; } };

/* Brace/paren matching. A fixed-line window bled into neighbouring functions in
   the 2D-2 census and would do so again here: device-manager.js declares eight
   callables back to back, several under 800 characters. */
function balancedFrom(src, openIdx, open, close) {
  let d = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === open) d++;
    else if (src[i] === close) { d--; if (d === 0) return src.slice(openIdx, i + 1); }
  }
  return '';
}
function bodyOf(src, name) {
  const re = new RegExp('exports\\.' + name + '\\s*=\\s*on(?:Call|Request)\\b');
  const m = re.exec(src);
  if (!m) return null;
  return balancedFrom(src, src.indexOf('(', m.index), '(', ')');
}

/* Any spelling that could constitute an ownership decision. Deliberately
   generous: the finding is that these bodies contain NONE of them, and a
   generous matcher makes that finding harder to reach, not easier. */
const OWNERSHIP_RE = /permission-denied|ownerId|adminUids|posStaff|_isAdmin|isAdmin|_requireAdmin|_assertAdmin|sellerUid|\.uid !==|uid !== |userData\.merchantId|resource\.data/;

const DM = read('functions/device-manager.js');
const BB = read('functions/business-bootstrap.js');
const DE = read('functions/device-engine.js');
const PP = read('functions/pos-printer.js');
const PPER = read('functions/pos-peripherals.js');
const PTL = read('functions/pos-terminal-live.js');
const AOS = read('functions/admin-os.js');
const RULES = read('firestore.rules');
const SHELL = read('merchant.html');
const ROUTES = read('sokoni-merchant-routes.js');

must('device-manager.js readable', DM.length > 5000);
must('business-bootstrap.js readable', BB.length > 5000);
must('device-engine.js readable', DE.length > 2000);
must('rules readable', RULES.length > 5000);

must('bodyOf true positive', (bodyOf(DM, 'registerDevice') || '').includes('merchantId'));
must('bodyOf true negative', bodyOf(DM, 'thisIsNotAFunction') === null);
must('bodyOf does not bleed into the next declaration',
  !(bodyOf(DM, 'lockDevice') || '').includes('unlockDevice'));
must('ownership detector true positive (registerDevice really checks)',
  OWNERSHIP_RE.test(bodyOf(DM, 'registerDevice') || ''));
must('ownership detector true negative (lockDevice really does not)',
  !OWNERSHIP_RE.test(bodyOf(DM, 'lockDevice') || ''));

/* ══ The POS device fleet: posDevices ═══════════════════════════════════════ */
/* `owns` below is a SCREEN, not a verdict: it reports whether an ownership
   token appears anywhere in the body. A token is not a decision —
   `validateDeviceAccess` matches on `posStaff` and still authorises nothing,
   because that query is by `branchId` + `pinHash` and never names the claimed
   merchant. Each match is therefore hand-verified into `decides`, and the
   controls below assert the screen is a strict superset of the decisions. */
const POS_FLEET = [
  { file: 'functions/device-manager.js', src: DM, name: 'registerDevice', takes: 'deviceId + merchantId + branchId' },
  { file: 'functions/device-manager.js', src: DM, name: 'deviceHeartbeat', takes: 'deviceId' },
  { file: 'functions/device-manager.js', src: DM, name: 'lockDevice', takes: 'deviceId' },
  { file: 'functions/device-manager.js', src: DM, name: 'unlockDevice', takes: 'deviceId' },
  { file: 'functions/device-manager.js', src: DM, name: 'remoteLogout', takes: 'deviceId' },
  { file: 'functions/device-manager.js', src: DM, name: 'remoteUpdate', takes: 'deviceId + targetVersion' },
  { file: 'functions/device-manager.js', src: DM, name: 'decommissionDevice', takes: 'deviceId' },
  { file: 'functions/device-manager.js', src: DM, name: 'getDeviceList', takes: 'merchantId' },
  { file: 'functions/business-bootstrap.js', src: BB, name: 'bootstrapDevice', takes: 'merchantId + branchId + deviceId' },
  { file: 'functions/business-bootstrap.js', src: BB, name: 'validateDeviceAccess', takes: 'merchantId + branchId + pin' },
  { file: 'functions/admin-os.js', src: AOS, name: 'adminGetPosDevices', takes: 'nothing' },
];
/* Hand-verified: does the matched token actually decide who may act? */
const DECIDES = {
  registerDevice: 'partly — businesses/merchants ownership OR posStaff, but the staff branch is not tied to the claimed merchant',
  adminGetPosDevices: 'yes — admin only',
};
for (const c of POS_FLEET) {
  c.body = bodyOf(c.src, c.name);
  must('body extracted: ' + c.name, c.body !== null && c.body.length > 100);
  c.owns = OWNERSHIP_RE.test(c.body || '');
  c.decides = Object.prototype.hasOwnProperty.call(DECIDES, c.name) ? DECIDES[c.name] : null;
  c.len = (c.body || '').length;
}
must('the fleet screen discriminates',
  POS_FLEET.some((c) => c.owns) && POS_FLEET.some((c) => !c.owns),
  'a detector answering the same for every callable would prove nothing');
/* The screen must be a SUPERSET of the decisions: nothing may be credited with
   deciding that the screen did not even flag. */
must('every decision was flagged by the screen',
  POS_FLEET.filter((c) => c.decides).every((c) => c.owns));
/* ...and the screen must be a STRICT superset here, which is the point:
   validateDeviceAccess matched a token and decides nothing. */
must('the screen really does over-report (a token is not a decision)',
  POS_FLEET.some((c) => c.owns && !c.decides),
  'if the screen and the verdicts agreed exactly, the hand-verification step would be doing no work');

const unowned = POS_FLEET.filter((c) => !c.decides);

/* bootstrapDevice writes posDevices with client-supplied scope — the specific
   claim the report makes, so it is checked rather than described. */
const BOOT = bodyOf(BB, 'bootstrapDevice') || '';
const BOOT_WRITES_DEVICE = /collection\('posDevices'\)\.doc\(safeDeviceId\)/.test(BOOT);
const BOOT_SETS_ACTIVE = /status:\s*'active'/.test(BOOT);
const BOOT_MERGES = /\{\s*merge:\s*true\s*\}/.test(BOOT);
must('bootstrapDevice device-write detector true positive', BOOT_WRITES_DEVICE);
must('bootstrapDevice merge detector true positive', BOOT_MERGES);
const REG = bodyOf(DM, 'registerDevice') || '';
const REG_GUARDS_DECOMMISSION = /decommissioned/.test(REG);
must('registerDevice decommission-guard detector true positive', REG_GUARDS_DECOMMISSION);

/* registerDevice's staff branch: does the posStaff query name the merchant? */
const STAFF_Q = (REG.match(/collection\('posStaff'\)[\s\S]{0,240}/) || [''])[0];
const STAFF_BY_BRANCH = /where\('branchId'/.test(STAFF_Q);
const STAFF_BY_MERCHANT = /where\('merchantId'/.test(STAFF_Q);
must('staff-query detector located the query', STAFF_BY_BRANCH);

/* ══ Rules ═════════════════════════════════════════════════════════════════ */
function ruleBlock(name) {
  const i = RULES.indexOf('match /' + name + '/');
  if (i < 0) return '';
  const eol = RULES.indexOf('\n', i);
  return balancedFrom(RULES, RULES.lastIndexOf('{', eol), '{', '}');
}
const POSDEV_RULE = ruleBlock('posDevices');
must('posDevices rule located', POSDEV_RULE.includes('allow read'));
const POSDEV_GATES_SELLERID = /isPosOwner\(\)|claimsPosOwner\(\)/.test(POSDEV_RULE);
must('posDevices rule gate detector true positive', POSDEV_GATES_SELLERID);
/* isPosOwner reads resource.data.sellerId — do the writers write it? */
const DEV_WRITERS_FIELDS = {
  'registerDevice': REG,
  'bootstrapDevice': BOOT,
};
const WRITER_SELLERID = Object.keys(DEV_WRITERS_FIELDS)
  .map((k) => ({ name: k, hasSellerId: /sellerId/.test(DEV_WRITERS_FIELDS[k]) }));

/* ══ The other two device families ═════════════════════════════════════════ */
const FAMILIES = [
  { key: 'posDevices', what: 'POS HARDWARE fleet — tills, terminals, printers attached to a branch',
    owner: 'functions/device-manager.js + business-bootstrap.js',
    idShape: 'posDevices/{client-supplied deviceId}',
    verdict: 'UNSAFE' },
  { key: 'userDevices', what: 'ACCOUNT SESSION devices — where a person is signed in',
    owner: 'functions/device-engine.js',
    idShape: 'userDevices/{uid}_{deviceId} — the uid is IN the key',
    verdict: 'SAFE' },
  { key: 'securityDevices/{userId}/devices', what: 'zero-trust device attestation',
    owner: 'functions/security-identity.js + security-zero-trust.js',
    idShape: 'securityDevices/{uid}/devices/{deviceId}',
    verdict: 'SAFE' },
];
/* Prove the userDevices claim rather than asserting it. */
const DE_LOGOUT = bodyOf(DE, 'deviceLogout') || '';
const DE_LIST = bodyOf(DE, 'deviceList') || '';
must('userDevices logout really checks the owner', /uid !== uid|\.uid !== uid/.test(DE_LOGOUT));
must('userDevices list really queries by the caller', /where\('uid', '==', uid\)/.test(DE_LIST));
const DE_REG = bodyOf(DE, 'deviceRegister') || '';
must('userDevices doc id really embeds the uid', /\$\{uid\}_\$\{deviceId/.test(DE_REG));

/* ══ Peripherals / printer / terminal ══════════════════════════════════════ */
const PERI = [
  { name: 'posRegisterPeripheral', src: PPER, file: 'functions/pos-peripherals.js',
    scope: 'client `merchantId`, CORROBORATED against users/{auth.uid}.merchantId',
    verdict: 'SAFE AFTER HARDENING',
    note: 'A real check — and a FOURTH merchant identity spelling (`users/{uid}.merchantId`), alongside `businesses/{id}.ownerId`, `merchants/{id}.ownerId` and `shops/{id}.sellerUid`.' },
  { name: 'getPrinterConfig', src: PP, file: 'functions/pos-printer.js',
    scope: 'posPrinterConfig/{auth.uid} — the uid IS the doc id',
    verdict: 'SAFE',
    note: 'Self-scoped and correct. But ACCOUNT-scoped: one printer configuration per account, not per device or per shop.' },
  { name: 'setPrinterConfig', src: PP, file: 'functions/pos-printer.js',
    scope: 'posPrinterConfig/{auth.uid}',
    verdict: 'SAFE',
    note: 'Same shape as the read.' },
  { name: 'posGetTerminalHealth', src: PTL, file: 'functions/pos-terminal-live.js',
    scope: 'client `terminalId`, auth only',
    verdict: 'CLIENT-SCOPE / UNSAFE',
    note: 'Queries peripherals and transactions by a terminalId the caller names. No merchant is established.' },
  { name: 'posInitiateTerminalPayment', src: PTL, file: 'functions/pos-terminal-live.js',
    scope: 'client `terminalId` + `orderId`, auth only',
    verdict: 'CLIENT-SCOPE / UNSAFE',
    note: 'Starts a card payment on a terminal the caller names. Money path.' },
];
for (const p of PERI) {
  p.body = bodyOf(p.src, p.name);
  must('peripheral body extracted: ' + p.name, p.body !== null);
  p.owns = OWNERSHIP_RE.test(p.body || '');
}
must('peripheral detector discriminates', PERI.some((p) => p.owns) && PERI.some((p) => !p.owns));

/* ══ What the merchant Devices screen does TODAY ═══════════════════════════ */
const RENDER_I = SHELL.indexOf('function renderDevices');
must('renderDevices located in the shell', RENDER_I > 0);
const RENDER_BODY = SHELL.slice(RENDER_I, SHELL.indexOf('function ', RENDER_I + 40));
const RENDER_CALLS_SERVER = /_callable\(/.test(RENDER_BODY);
const RENDER_IS_LOCAL = /PrinterState/.test(RENDER_BODY);
must('renderDevices detector true positive (it really reads PrinterState)', RENDER_IS_LOCAL);

/* ══ Client-side device-local state ════════════════════════════════════════ */
const LOCAL_KEYS = [];
for (const f of ['sokoni-device-hub.js', 'sokoni-printer-manager.js', 'pos-hardware-wizard.js',
  'sokoni-universal-printer.js', 'pos-sync.js', 'pos-health.js']) {
  const s = read(f);
  const m = s.match(/localStorage\.(?:getItem|setItem)\('([^']+)'/g) || [];
  m.forEach((x) => { const k = x.replace(/.*'([^']+)'.*/, '$1'); if (LOCAL_KEYS.indexOf(k) === -1) LOCAL_KEYS.push(k); });
}
must('local-key scan found keys', LOCAL_KEYS.length > 0);

/* ══════════════════════════════════════════════════════════════════════════
   REPORT
   ══════════════════════════════════════════════════════════════════════════ */
line(MD ? '# Merchant Devices / POS — Authority Census' : 'DEVICES / POS AUTHORITY CENSUS');
line('');
if (MD) {
  line('**Stage 1 — read-only.** No UI changes, no repairs, no backfill, no deployment.');
  line('');
  line('Generated by `scripts/census-devices-authority.js`. Every verdict was produced by');
  line('extracting the **full** function body and inspecting it. Re-run with:');
  line('');
  line('```');
  line('node scripts/census-devices-authority.js --md > docs/MERCHANT_DEVICES_AUTHORITY.md');
  line('```');
  line('');
  line('Fixture: `SELLER_A → SHOP_B → DEVICE_B`, and `SHOP_C → DEVICE_C` belonging to someone else.');
  line('');
  line('## Headline');
  line('');
  line('**POS device setup works, and it decides almost nothing.** Of the eleven callables that');
  line('read or write the POS device fleet, **' + unowned.length + ' authorise nobody** — and ' +
    POS_FLEET.filter((c) => !c.owns).length + ' of those contain no');
  line('ownership token of any kind: not a weak check, not the wrong check, none. The screen used');
  line('here is deliberately generous — it matches any of `permission-denied`, `ownerId`,');
  line('`adminUids`, `posStaff`, `isAdmin`, `sellerUid`, a `uid !==` comparison, or');
  line('`users/{uid}.merchantId` — which makes that result harder to reach, not easier.');
  line('');
  line('The gap between the two numbers is `validateDeviceAccess`, which matches a token and still');
  line('authorises nothing. That is why the table below reports the screen and the hand-verified');
  line('answer in separate columns.');
  line('');
  line('Exactly **one** merchant-facing callable in the fleet decides anything at all');
  line('(`registerDevice`), and it decides it against a record that does not name the merchant being');
  line('claimed.');
  line('');
  line('So the answer to *"can a device be attached to the wrong shop?"* is **yes, trivially**, and');
  line('the answer to *"is POS setup the merchant authority?"* is **no**.');
  line('');
}

/* ── Table 1: the fleet ─────────────────────────────────────────────────── */
line(MD ? '## The POS device fleet (`posDevices`)\n' : '-- posDevices fleet --');
if (MD) {
  line('| callable | takes from the client | ownership token present? | does it actually decide? |');
  line('|---|---|---|---|');
  for (const c of POS_FLEET) {
    line('| `' + c.name + '`<br><sub>' + c.file.replace('functions/', '') + '</sub> | ' + c.takes + ' | ' +
      (c.owns ? 'yes' : '**none**') + ' | ' + (c.decides ? c.decides : '**NO**') + ' |');
  }
  line('');
  line('The third column is a generous automated screen; the fourth is hand-verified. They');
  line('deliberately disagree in one place, and that disagreement is the reason the fourth column');
  line('exists: **`validateDeviceAccess` matches on `posStaff` and authorises nothing.** Its query is');
  line('`branchId` + `pinHash` + `status` — the client\'s `merchantId` is accepted and then never used');
  line('for authorisation. Given a correct staff PIN it returns the employee record for a branch the');
  line('caller has no relationship to. Rate-limited at 5 attempts per uid per 5 minutes, which bounds');
  line('a brute force without establishing who is asking.');
  line('');
  line('`adminGetPosDevices` is admin-only and correct. `registerDevice` is the only merchant-facing');
  line('callable in the fleet that decides anything — and it decides it against the wrong record.');
  line('');
} else {
  for (const c of POS_FLEET) line('   ' + (c.owns ? 'checks ' : 'NONE   ') + c.name);
}

/* ── The two structural defects ─────────────────────────────────────────── */
if (MD) {
  line('### 1. `bootstrapDevice` attaches any device to any merchant, and reactivates it');
  line('');
  line('`bootstrapDevice` takes `merchantId`, `branchId` and `deviceId` from the caller, performs no');
  line('ownership check, returns the merchant\'s full configuration bundle, and then writes:');
  line('');
  line('```js');
  line("db.collection('posDevices').doc(safeDeviceId).set({");
  line('  deviceId:   safeDeviceId,');
  line('  merchantId: safeMerchantId,   // client-supplied');
  line('  branchId:   safeBranchId,     // client-supplied');
  line('  cashierId:  uid,');
  line("  status:     'active',");
  line('}, { merge: true });');
  line('```');
  line('');
  line('Three consequences, all computed above rather than inferred:');
  line('');
  line('- device write present: **' + (BOOT_WRITES_DEVICE ? 'yes' : 'no') + '**');
  line('- writes `status: \'active\'`: **' + (BOOT_SETS_ACTIVE ? 'yes' : 'no') + '**');
  line('- uses `{ merge: true }`: **' + (BOOT_MERGES ? 'yes' : 'no') + '**');
  line('');
  line('So any authenticated account can (a) read any merchant\'s bootstrap bundle, (b) attach a new');
  line('device to any merchant, and (c) **re-point an existing device to a different merchant**,');
  line('because `merge: true` overwrites `merchantId` on a document that already exists.');
  line('');
  line('And (d): `registerDevice` explicitly refuses to re-register a decommissioned device');
  line('(decommission guard present: **' + (REG_GUARDS_DECOMMISSION ? 'yes' : 'no') + '**), while `bootstrapDevice` writes');
  line('`status: \'active\'` with no such check. **`bootstrapDevice` is a bypass of');
  line('`decommissionDevice`.** A device revoked by an administrator can bring itself back.');
  line('');
  line('### 2. `registerDevice`\'s staff branch proves the wrong thing');
  line('');
  line('`registerDevice` does corroborate — it accepts the caller if they own');
  line('`businesses/{merchantId}` or `merchants/{merchantId}`, **or** if they are active `posStaff`.');
  line('That last query is:');
  line('');
  line('- filtered by `branchId`: **' + (STAFF_BY_BRANCH ? 'yes' : 'no') + '**');
  line('- filtered by `merchantId`: **' + (STAFF_BY_MERCHANT ? 'yes' : 'no') + '**');
  line('');
  line('Both ids come from the caller. A user who is legitimately staff at their own branch can');
  line('therefore send **their own `branchId`** together with **a victim\'s `merchantId`**: the staff');
  line('query succeeds against their own record, `staffSnap` is not empty, and the device is');
  line('registered under the victim\'s merchant. The staff record proves membership of a branch and');
  line('is never checked to belong to the merchant being claimed.');
  line('');
  line('This is the same defect class as `orderAdvance` and `posLookupCustomer`: a real check that');
  line('validates something other than the thing being authorised.');
  line('');
  line('### 3. The `posDevices` rule gates on a field the writers do not write');
  line('');
  line('```');
  POSDEV_RULE.split('\n').forEach((l) => line(l.trim() ? '  ' + l.trim() : ''));
  line('```');
  line('');
  line('`isPosOwner()` is `resource.data.sellerId == request.auth.uid`. The writers:');
  line('');
  line('| writer | writes `sellerId`? |');
  line('|---|---|');
  for (const w of WRITER_SELLERID) line('| `' + w.name + '` | ' + (w.hasSellerId ? 'yes' : '**no**') + ' |');
  line('');
  line('Both write `merchantId`. So the client-side rule for `posDevices` denies the merchant their');
  line('own device list — the **sixth** instance of *rules gating on a field nothing writes*, after');
  line('`shopEmployees.sellerUid`, `disputes.sellerUid`, `posCustomers.sellerId`,');
  line('`minishopAnalytics.ownerUid` and `posReceipts.sellerId`.');
  line('');
}

/* ── Table 2: the three families ────────────────────────────────────────── */
line(MD ? '## Three device collections, three different things\n' : '\n-- families --');
if (MD) {
  line('The word "device" covers three unrelated registries. Conflating them is the first way a');
  line('Devices screen goes wrong.');
  line('');
  line('| collection | what it actually is | key shape | verdict |');
  line('|---|---|---|---|');
  for (const f of FAMILIES) {
    line('| `' + f.key + '`<br><sub>' + f.owner.replace(/functions\//g, '') + '</sub> | ' + f.what + ' | `' + f.idShape + '` | **' + f.verdict + '** |');
  }
  line('');
  line('`userDevices` is the model the POS fleet should have copied: the uid is **in the document');
  line('key**, the list query filters by the caller, and logout refuses another user\'s device.');
  line('Those three properties are asserted by this script\'s controls, not taken on trust.');
  line('');
  line('A merchant Devices screen is about `posDevices`. `userDevices` belongs on a security/account');
  line('screen and must not be mixed in — "sign out my other phone" and "decommission till 2" are');
  line('different sentences with different blast radii.');
  line('');
} else {
  for (const f of FAMILIES) line('   ' + f.verdict.padEnd(8) + f.key);
}

/* ── Table 3: peripherals ───────────────────────────────────────────────── */
line(MD ? '## Peripherals, printer and payment terminal\n' : '\n-- peripherals --');
if (MD) {
  line('| callable | scope decided by | verdict |');
  line('|---|---|---|');
  for (const p of PERI) line('| `' + p.name + '`<br><sub>' + p.file.replace('functions/', '') + '</sub> | ' + p.scope + ' | **' + p.verdict + '** |');
  line('');
  for (const p of PERI) line('- **`' + p.name + '`** — ' + p.note);
  line('');
} else {
  for (const p of PERI) line('   ' + p.verdict.padEnd(24) + p.name);
}

/* ── What exists today ──────────────────────────────────────────────────── */
line(MD ? '## What the merchant Devices screen does today\n' : '\n-- today --');
if (MD) {
  line('`merchant.html` already routes `devices` as `kind:\'native\'`, so there is no iframe to');
  line('remove. But the surface calls **no server authority at all**:');
  line('');
  line('- reads `PrinterState`: **' + (RENDER_IS_LOCAL ? 'yes' : 'no') + '**');
  line('- calls any Cloud Function: **' + (RENDER_CALLS_SERVER ? 'yes' : 'no') + '**');
  line('');
  line('It shows one live Web Bluetooth printer connection plus two "available in Cashier"');
  line('placeholders. The registered `posDevices` fleet — the tills a merchant actually owns — is');
  line('**invisible to its owner**, while being lockable and decommissionable by anyone.');
  line('');
  line('That is the honest starting position: not a legacy island to convert, but a screen with no');
  line('server side yet, sitting above a registry that cannot safely be exposed as it stands.');
  line('');
  line('### Device-local state (survives no audit, belongs to no merchant)');
  line('');
  LOCAL_KEYS.forEach((k) => line('- `' + k + '`'));
  line('');
  line('`_posBiometricCreds` is worth a separate look during hardening — biometric material in');
  line('`localStorage` is a different conversation from printer pairing, and it is out of scope for');
  line('a census.');
  line('');
}

/* ── Answers to the fifteen traced questions ────────────────────────────── */
line(MD ? '## The fifteen questions, answered\n' : '\n-- traced --');
const TRACED = [
  ['device registration', '`registerDevice` (corroborates, imperfectly) and `bootstrapDevice` (does not corroborate at all). Two writers, one authority\'s worth of checking between them.'],
  ['device ownership', 'Recorded as `merchantId` on the device document. Never verified on read or on any command.'],
  ['active device', 'No concept of an "active device" per merchant. `status:\'active\'` is a device-level flag any caller can set via `bootstrapDevice`.'],
  ['POS pairing', 'QR pairing IS token-gated — `_pairDevice` refuses on `b.pairingToken !== token`. This is the one part of the flow that holds. The token is regenerable by the owner.'],
  ['printer configuration', '`posPrinterConfig/{auth.uid}` — self-scoped and safe, but ACCOUNT-level: one printer config per account, not per device or per shop.'],
  ['receipt printer / P58E', 'Entirely client-side (Web Bluetooth GATT held at shell level so it survives navigation). No server record, so it cannot be shown on another device or audited.'],
  ['PDQ / terminal integration', '`posGetTerminalHealth` and `posInitiateTerminalPayment` take a client `terminalId` with auth only. The second is a money path.'],
  ['device removal / revocation', '`decommissionDevice` — no ownership check, and bypassed by `bootstrapDevice` writing `status:\'active\'` with merge.'],
  ['device status / heartbeat', '`deviceHeartbeat` — no ownership check. Any caller can write heartbeat state for any deviceId.'],
  ['branch / device relationships', '`branchId` is namespaced as `{merchantId}-main` at bootstrap, which is good — but it is accepted from the client and never checked against the claimed merchant.'],
  ['offline behaviour', 'Local caches (`bootstrapCache`, `syncQueue`, `pos-sync.js`). `syncQueue` rules are correctly `uid`-scoped; `bootstrapCache` is readable by any authenticated user.'],
  ['employee / device permissions', '`posStaff` membership is the staff path into `registerDevice`, and it is queried by `branchId` only — see defect 2.'],
  ['can a device be attached to the wrong shop?', '**Yes.** Two independent ways: `bootstrapDevice` (no check at all) and `registerDevice` (staff record not tied to the claimed merchant).'],
  ['are device identifiers client-trusted?', '**Yes, entirely.** `deviceId` is a client-generated UUID and is the document key. `registerDevice` validates it is a well-formed UUID v4 — which is a format check, not an ownership one.'],
  ['device-local state', 'Six keys listed above, none of them authoritative and none of them audited.'],
];
if (MD) {
  line('| traced | finding |');
  line('|---|---|');
  for (const [q, a] of TRACED) line('| ' + q + ' | ' + a + ' |');
  line('');
} else {
  for (const [q] of TRACED) line('   ' + q);
}

/* ── Classification ─────────────────────────────────────────────────────── */
line(MD ? '\n## Classification\n' : '\n-- classification --');
const ROWS = []
  .concat(POS_FLEET.map((c) => ({
    name: c.name,
    verdict: c.name === 'adminGetPosDevices' ? 'BLOCKED'
      : c.name === 'registerDevice' ? 'SAFE AFTER HARDENING'
        : 'CLIENT-SCOPE / UNSAFE',
  })))
  .concat(PERI.map((p) => ({ name: p.name, verdict: p.verdict })))
  .concat([
    { name: 'deviceRegister / deviceList / deviceLogout (userDevices)', verdict: 'SAFE' },
    { name: 'posDevices client read (rules)', verdict: 'NEW AUTHORITY REQUIRED' },
    { name: 'a merchant device fleet list', verdict: 'NEW AUTHORITY REQUIRED' },
  ]);
const byVerdict = {};
for (const r of ROWS) (byVerdict[r.verdict] = byVerdict[r.verdict] || []).push(r.name);
const ORDER = ['SAFE', 'SAFE AFTER HARDENING', 'CLIENT-SCOPE / UNSAFE', 'BLOCKED', 'NEW AUTHORITY REQUIRED', 'PUBLIC BY DESIGN'];
if (MD) {
  line('| classification | capabilities |');
  line('|---|---|');
  for (const v of ORDER) line('| **' + v + '** | ' + ((byVerdict[v] || []).map((n) => '`' + n + '`').join(', ') || '—') + ' |');
  line('');
  line('### Verdict for Stage 2');
  line('');
  line('**Devices is BLOCKED. Do not build the UI on the existing POS device authorities.**');
  line('');
  line('This is the case the instruction anticipated — POS setup works, and working is not the same');
  line('as deciding. A Devices screen built on `getDeviceList` + `lockDevice` + `decommissionDevice`');
  line('would put a supported merchant button on top of platform-wide device control.');
  line('');
  line('What CAN be built now, and is genuinely useful on its own:');
  line('');
  line('- **The local peripheral surface** — printer connect/test/forget, scanner and cash-drawer');
  line('  status. It touches no cross-tenant authority. This is what the screen already does, and it');
  line('  can be finished properly (P58E pairing state, reconnect, per-device naming) without any');
  line('  server change.');
  line('- **Printer configuration** via `getPrinterConfig`/`setPrinterConfig`, labelled');
  line('  **account-level** for the same reason Tax is — one config per account, not per device.');
  line('');
  line('What must wait for a new authority:');
  line('');
  line('- **The registered device fleet** (list, name, lock, unlock, decommission). Every one of');
  line('  those needs an owner check that does not exist, and the rule that would have scoped a');
  line('  client read gates on `sellerId`, which no writer writes.');
  line('- **Terminal / PDQ operations**, because the payment-initiating one is unscoped.');
  line('');
  line('### Findings for separate security stages');
  line('');
  line('| # | finding | severity |');
  line('|---|---|---|');
  line('| 1 | `bootstrapDevice` — no ownership check; returns any merchant\'s bootstrap bundle AND writes `posDevices` with client-supplied `merchantId`/`branchId`, `merge:true`, `status:\'active\'` | **critical** — cross-tenant config disclosure + device hijack + decommission bypass |');
  line('| 2 | `lockDevice`, `unlockDevice`, `remoteLogout`, `remoteUpdate`, `decommissionDevice`, `deviceHeartbeat` — auth only, client `deviceId` | **critical** — any account can disable any till on the platform |');
  line('| 3 | `getDeviceList` — auth only, client `merchantId` | **high** — cross-tenant device fleet disclosure |');
  line('| 4 | `registerDevice` — `posStaff` checked by `branchId`, never tied to the claimed `merchantId` | **high** — device attached to the wrong merchant |');
  line('| 5 | `posInitiateTerminalPayment` / `posGetTerminalHealth` — auth only, client `terminalId` | **high** — money path on a terminal the caller names |');
  line('| 6 | `posDevices` rule gates on `sellerId`; writers write `merchantId` | **medium** — sixth instance of the pattern |');
  line('| 7 | `validateDeviceAccess` — staff PIN checked against a client-supplied `branchId`, returning the employee record; the caller\'s relationship to that branch is never established | **high** — staff PIN oracle across branches |');
  line('');
  line('Finding 2 deserves a note on blast radius: `decommissionDevice` is not reversible by');
  line('`registerDevice`, which refuses decommissioned devices. An attacker can therefore take a');
  line('merchant\'s till out of service through the documented path, and the documented recovery path');
  line('refuses to bring it back.');
  line('');
  line('### Identity, recorded not fixed');
  line('');
  line('The device path introduces merchant identity spellings this track has not yet reconciled:');
  line('`businesses/{id}.ownerId`, `merchants/{id}.ownerId`/`adminUids`, and');
  line('`users/{uid}.merchantId` — none of which is `shops/{shopId}.sellerUid`. Per the standing');
  line('instruction, this census does not resurrect `merchants/{merchantId}` to make a legacy path');
  line('convenient, and does not "fix" the spellings on aesthetic grounds. Whether they are');
  line('writer-specific representations or a genuine authority conflict is a question for the');
  line('identity work, not for Devices.');
} else {
  for (const v of ORDER) if (byVerdict[v]) line('   ' + v + ': ' + byVerdict[v].length);
}

if (hardFail) {
  console.error('\nCENSUS ABORTED — ' + hardFail + ' control(s) failed. Output is NOT trustworthy.');
  process.exit(1);
}
console.log(out.join('\n'));
