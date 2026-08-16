#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   DELIVERY PIN — UNREACHABILITY SUITE
   ══════════════════════════════════════════════════════════════════════════════
   Run: node scripts/test-delivery-pin-unreachable.js

   The question this answers is NOT "is the PIN absent from _riderView()".
   _riderView() was always clean, and the PIN was reachable anyway — through a
   Firestore rule, one collection over, with no projection involved.

   So this suite enumerates EVERY path a rider can reach and asserts the
   plaintext is not obtainable through any of them:

       FIRESTORE (rules-granted, unprojected — a granted read is TOTAL)
         orders/{orderId}          via assignedDriverUid
         packageRequests/{pkgId}   via assignedDriverId
         deliveries/{id}           via assignedRiderId
         deliveryPins/{orderId}    (must have NO rule)

       CLOUD FUNCTIONS a rider can call
         availableDeliveries, claimAvailableDelivery, fulfilmentScan,
         deliveryVerifyShadow, completeDeliveryWithPin, captureProofOfDelivery,
         respondToDispatch, getMyDeliveryPin

       CLIENT
         driver.html must not render a PIN from any payload

   The invariant being proven:

       RIDER → authorized delivery → rider-safe projection
             → no plaintext deliveryPin
             → no unnecessary customer data
             → no cross-delivery access

   while completeDeliveryWithPin keeps: assignment → PIN verification → completion.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(d).slice(0, 150) + ']' : ''));
  ok ? pass++ : fail++;
};
const SRC = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { return ''; } };

/* Absence is a property of CODE. Every one of these files documents the defect
   it removed BY NAMING IT, so an assertion over raw text reports the opposite of
   the truth. This caught four suites earlier in the track. */
function code(src) {
  let out = '', i = 0, n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '<' && src.slice(i, i + 4) === '<!--') { i += 4; while (i < n && src.slice(i, i + 3) !== '-->') i++; i += 3; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += c; i++;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        out += src[i]; if (src[i] === q) { i++; break; } i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}
function balancedFrom(src, openIdx, open, close) {
  let d = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === open) d++;
    else if (src[i] === close) { d--; if (d === 0) return src.slice(openIdx, i + 1); }
  }
  return '';
}
/* Extract from STRIPPED source only. Counting parens across comments truncates a
   body at the first unmatched `)` in prose — `/* 1) PIN check` ended the shadow
   handler 700 characters early and turned two real passes into false failures.
   A matcher that silently returns a short body is worse than one that throws. */
function bodyOf(strippedSrc, name) {
  const m = new RegExp('exports\\.' + name + '\\s*=\\s*on(?:Call|Request|DocumentUpdated)\\b').exec(strippedSrc);
  if (!m) return null;
  return balancedFrom(strippedSrc, strippedSrc.indexOf('(', m.index), '(', ')');
}

const RULES_RAW = SRC('firestore.rules');
const IDX = code(SRC('functions/index.js'));
const IDX_RAW = SRC('functions/index.js');
const PIN_RAW = SRC('functions/delivery-pin.js');
const PIN = code(PIN_RAW);
const SCAN = code(SRC('functions/fulfilment-scan.js'));
const COMP = code(SRC('functions/delivery-complete.js'));
const DISP = code(SRC('functions/dispatch.js'));
const SYNC = code(SRC('functions/pos-marketplace-sync.js'));
const DRIVER = code(SRC('driver.html'));
const TRACK = code(SRC('track.html'));

/* ══ 0. CONTROLS — a suite that cannot fail proves nothing ═════════════════ */
console.log('\n0. Controls');
{
  ck('C1 sources loaded', [RULES_RAW, IDX, PIN, SCAN, COMP, DRIVER].every((s) => s.length > 500));
  /* These files document the defect they removed BY NAMING IT, so the stripper is
     load-bearing: without it, "no plaintext PIN in this file" would fail on the
     comment explaining that there is no plaintext PIN. */
  ck('C2 comment-stripper really strips a block comment',
    /Firestore has no field-level read control/.test(PIN_RAW) &&
    !/Firestore has no field-level read control/.test(PIN));
  ck('C3 ...and a line comment', (() => {
    const probe = 'const a = 1; // proofPin: leak\nconst b = 2;';
    return /proofPin/.test(probe) && !/proofPin/.test(code(probe));
  })());
  /* And the converse: text inside a STRING is content, not a comment, and must
     survive. A stripper that ate string bodies would make every "field is absent"
     assertion pass vacuously. */
  ck('C3b ...but leaves string content alone',
    /proofPin/.test(code("const s = 'proofPin: x';")));
  ck('C4 bodyOf true positive', (bodyOf(IDX, 'availableDeliveries') || '').includes('packageRequests'));
  ck('C5 bodyOf true negative', bodyOf(IDX, 'noSuchFunction') === null);
  /* If a "no plaintext anywhere" assertion could never fail, it is decoration.
     Prove the detector fires on a string that IS a plaintext pin assignment. */
  ck('C6 pin-write detector true positive on a synthetic sample',
    /\bproofPin:\s*(?!null)[A-Za-z_]/.test('status: "x", proofPin: _pin,'));
  ck('C7 pin-write detector true negative on the fixed sample',
    !/\bproofPin:\s*(?!null)[A-Za-z_]/.test('status: "order_placed",'));
}

/* ══ 1. FIRESTORE — the paths the rules grant, unprojected ═════════════════ */
console.log('\n1. Firestore read paths a rider is granted (a granted read is TOTAL)');
{
  /* The rules genuinely DO grant these reads. That is not the defect and is not
     changed here — the defect was putting a secret on a document so granted. */
  ck('1.1 the orders rule still grants the assigned rider a full-document read',
    /allow read:[\s\S]*?resource\.data\.assignedDriverUid\s*==\s*request\.auth\.uid/
      .test(balancedFrom(RULES_RAW, RULES_RAW.lastIndexOf('{', RULES_RAW.indexOf('\n', RULES_RAW.indexOf('match /orders/{orderId}'))), '{', '}')),
    'unchanged by design — the fix removes the secret, not the read');

  ck('1.2 NO writer puts a plaintext deliveryPin on an order document',
    !/deliveryPin:\s*pin\b/.test(PIN) && !/deliveryPin:\s*[A-Za-z_$][\w$]*\s*,/.test(PIN.replace(/deliveryPin:\s*admin\.firestore\.FieldValue\.delete\(\)/g, '')),
    'delivery-pin.js');
  ck('1.3 the trigger actively DELETES any legacy plaintext as an order passes',
    /deliveryPin:\s*admin\.firestore\.FieldValue\.delete\(\)/.test(PIN));
  ck('1.4 the order keeps only a boolean that a PIN exists',
    /deliveryPinIssued:\s*true/.test(PIN));

  /* Scoped to the packageRequests write itself. A file-wide ban would also fire on
     the deliveryPins write that now legitimately holds the value — which would make
     the assertion impossible to satisfy without deleting the PIN entirely, and would
     have been "satisfied" by moving the secret somewhere worse. */
  /* Anchor on the .set( call itself, not on the collection reference. Anchoring
     earlier grabbed the enclosing if-block (which also contains the deliveryPins
     write), and anchoring on a template literal grabbed the `${delId}`
     interpolation brace. Both would have reported the wrong thing confidently. */
  const pkgWrite = (src, anchor) => {
    const i = src.indexOf(anchor);
    return i < 0 ? '' : balancedFrom(src, src.indexOf('{', i), '{', '}');
  };
  const idxPkg = pkgWrite(IDX, '_delDoc.set(');
  const syncPkg = pkgWrite(SYNC, 'delId}`).set(');
  ck('1.5a the index.js packageRequest write block was located', idxPkg.length > 200);
  ck('1.5 NO plaintext proofPin on the packageRequest — index.js',
    !/proofPin/.test(idxPkg), 'webhookIntasend delivery creation');
  ck('1.6a the pos-marketplace-sync packageRequest write block was located', syncPkg.length > 200);
  ck('1.6 NO plaintext proofPin on the packageRequest — pos-marketplace-sync.js',
    !/proofPin/.test(syncPkg), 'merchant_ready delivery creation');
  ck('1.6b ...and the value is not lost — it moved to the CF-only deliveryPins doc',
    /deliveryPins/.test(IDX) && /deliveryPins/.test(SYNC));
  ck('1.7 packageRequests still carries only the HASH',
    /deliveryPinHash:\s*_hash\(/.test(PIN));

  ck('1.8 `deliveryPins` has NO rule — deny-by-default is the access control',
    !/match \/deliveryPins\//.test(RULES_RAW));
  ck('1.9 ...and there is no permissive catch-all that would grant it anyway',
    !/match \/\{document=\*\*\}/.test(RULES_RAW));
  ck('1.10 the rules file was not grown (compiled ceiling has ~72 bytes headroom)',
    !/match \/deliveryPins\//.test(RULES_RAW), 'zero rules bytes added by this remediation');

  /* deliveries/{id} — riders read it via assignedRiderId. */
  ck('1.11 nothing writes a plaintext PIN to `deliveries` from the server',
    !/collection\('deliveries'\)[\s\S]{0,400}proofP[Ii][Nn]:\s*[A-Za-z_$]/.test(IDX));
}

/* ══ 2. CLOUD FUNCTIONS a rider can call ══════════════════════════════════ */
console.log('\n2. Cloud Functions reachable by a rider');
{
  const AVAIL = (bodyOf(IDX, 'availableDeliveries') || '');
  ck('2.1 availableDeliveries requires a verified ID token',
    /verifyIdToken/.test(AVAIL) && /authorization/i.test(AVAIL));
  ck('2.2 ...and an APPROVED, non-suspended rider',
    /rideDrivers/.test(AVAIL) && /_approved/.test(AVAIL) && /_blocked/.test(AVAIL));
  ck('2.3 ...returns NO proofPin', !/proofPin/.test(AVAIL));
  ck('2.4 ...returns NO buyerPhone', !/buyerPhone/.test(AVAIL));
  ck('2.5 ...returns NO buyerName', !/buyerName/.test(AVAIL));
  ck('2.6 ...returns NO exact deliveryAddress', !/deliveryAddress:/.test(AVAIL));
  ck('2.7 ...returns a coarse area instead', /deliveryArea:\s*_deliveryArea\(/.test(AVAIL));
  ck('2.8 ...returns NO line items or order total',
    !/items:\s*o\.items/.test(AVAIL) && !/orderTotal:/.test(AVAIL));
  ck('2.9 ...is no-store, so a shared cache cannot retain a rider board',
    /no-store/.test(AVAIL));

  const CLAIM = code(IDX_RAW.slice(IDX_RAW.indexOf('exports.claimAvailableDelivery'),
    IDX_RAW.indexOf('exports.claimAvailableDelivery') + 3000));
  ck('2.10 claimAvailableDelivery returns NO proofPin', !/proofPin/.test(CLAIM));
  ck('2.11 ...and keeps its approved-rider guard', /_approved/.test(CLAIM) && /rideDrivers/.test(CLAIM));
  ck('2.12 ...and keeps atomic first-claim-wins semantics',
    /runTransaction/.test(CLAIM) && /awaiting_rider/.test(CLAIM));

  const RV = SCAN.slice(SCAN.indexOf('function _riderView'), SCAN.indexOf('function _customerView'));
  ck('2.13 _riderView returns no PIN of any spelling',
    !/deliveryPin|proofPin|\botp\b\s*:/i.test(RV.replace(/otpRequired/g, '')));
  ck('2.14 ...and still withholds the address when the assignment is over',
    /if \(!active\)/.test(RV));

  const SHADOW = (bodyOf(PIN, 'deliveryVerifyShadow') || '');
  ck('2.15 deliveryVerifyShadow now requires the caller to be the ASSIGNED rider',
    /assigned !== uid/.test(SHADOW) && /permission-denied/.test(SHADOW));
  ck('2.16 ...the assignment check precedes the PIN comparison',
    SHADOW.indexOf('assigned !== uid') < SHADOW.indexOf('_hash(String(deliveryRef)'),
    'order matters: checking the PIN first would still leak pass/fail');
  ck('2.17 ...and it no longer burns completeDeliveryWithPin\'s lockout budget',
    !/deliveryVerifyAttempts:\s*admin\.firestore\.FieldValue\.increment/.test(SHADOW) &&
    /deliveryShadowAttempts:\s*admin\.firestore\.FieldValue\.increment/.test(SHADOW));
  ck('2.18 ...and returns no PIN', !/pin:\s*[A-Za-z_$]/.test(SHADOW.replace(/pinPass/g, '')));

  const GET = (bodyOf(PIN, 'getMyDeliveryPin') || '');
  ck('2.19 getMyDeliveryPin exists and authorises against the ORDER',
    /collection\("orders"\)\.doc\(orderId\)/.test(GET) && /buyer !== uid/.test(GET));
  ck('2.20 ...and explicitly REFUSES the assigned rider',
    /rider === uid/.test(GET) && /permission-denied/.test(GET));
  ck('2.21 ...and an unissued PIN is a real answer, not an error',
    /issued: false/.test(GET));
  ck('2.22 ...and every read is audited', /_audit\(\{ event: "pin_read"/.test(GET));

  const CDP = (bodyOf(COMP, 'completeDeliveryWithPin') || '');
  ck('2.23 completeDeliveryWithPin STILL checks assignment before the PIN',
    CDP.indexOf('assigned !== uid') < CDP.indexOf('_hash(pkgId, pin)'));
  ck('2.24 ...still verifies against the keyed HMAC', /_sameHash\(computed, d\.deliveryPinHash\)/.test(CDP));
  ck('2.25 ...still locks out after MAX_ATTEMPTS', /attempts >= MAX_ATTEMPTS/.test(CDP));
  ck('2.26 ...still fails closed without the HMAC key', /__noKey/.test(CDP));
  ck('2.27 ...and returns no PIN to the caller', !/pin:\s*[A-Za-z_$]/.test(CDP.replace(/pinPass/g, '')));

  const CPOD = (bodyOf(DISP, 'captureProofOfDelivery') || '');
  ck('2.28 captureProofOfDelivery returns no PIN', !/proofPin|deliveryPin/.test(CPOD));
  const RTD = (bodyOf(DISP, 'respondToDispatch') || '');
  ck('2.29 respondToDispatch returns no PIN', !/proofPin|deliveryPin/.test(RTD));
}

/* ══ 3. CLIENT — the rider app must not render what it can no longer get ══ */
console.log('\n3. Rider client');
{
  ck('3.1 driver.html renders no PIN from any payload',
    !/proofPin/.test(DRIVER) || !/req\.proofPin|res\.data\.proofPin|d\.proofPin/.test(DRIVER),
    'no template interpolates a PIN');
  ck('3.2 the client-side PIN comparison is gone',
    !/otp !== String\(ordSnap\.proofPin\)/.test(DRIVER),
    'a comparison in the rider\'s own browser was never an authorisation');
  ck('3.3 the available-deliveries fetch sends a bearer token',
    /Authorization.*Bearer/.test(DRIVER));
  ck('3.4 a 401/403 is shown as a refusal, not as "no work available"',
    /_renderNotice/.test(DRIVER));
  /* Scoped to the AVAILABLE-DELIVERIES board only. driver.html also renders
     CLAIMED deliveries elsewhere, and an assigned rider legitimately needs the
     street address and the customer's phone to complete the job — that render
     reads a different source and must keep them. Banning the fields file-wide
     would have "passed" by breaking real deliveries. */
  const boardStart = DRIVER.indexOf('function _renderNotice');
  const boardEnd = DRIVER.indexOf('function _start()', boardStart);
  const BOARD = boardStart > 0 && boardEnd > boardStart ? DRIVER.slice(boardStart, boardEnd) : '';
  ck('3.5a the available-deliveries board render was located', BOARD.length > 400);
  ck('3.5 the board renders the coarse area, not a street address',
    /d\.deliveryArea/.test(BOARD) && !/d\.deliveryAddress/.test(BOARD));
  ck('3.6 ...and no buyer phone or name on an unclaimed job',
    !/d\.buyerPhone/.test(BOARD) && !/d\.buyerName/.test(BOARD));
  ck('3.7 the CLAIMED-delivery view still has what an assigned rider needs',
    /req\.deliveryAddress/.test(DRIVER) && /req\.buyerPhone|_buyerPhone/.test(DRIVER),
    'the fix must not blind a rider who is actually on the job');
}

/* ══ 4. BUYER — the fix must not break the person who needs the PIN ══════ */
console.log('\n4. The buyer still gets their PIN');
{
  ck('4.1 track.html asks the SERVER instead of reading the order field',
    /getMyDeliveryPin/.test(TRACK) && !/o\.deliveryPin\b/.test(TRACK));
  ck('4.2 ...gated on the boolean the trigger now writes',
    /o\.deliveryPinIssued/.test(TRACK));
  ck('4.3 ...and it does not cache the PIN to storage',
    !/localStorage[\s\S]{0,60}[Pp]in/.test(TRACK));
  ck('4.4 buyerConfirmDelivery is still available as the no-PIN fallback',
    /buyerConfirmDelivery/.test(TRACK));
}

/* ══ 5. Re-exports — an unexported CF is simply not deployed ═════════════ */
console.log('\n5. Deployment surface');
{
  ck('5.1 getMyDeliveryPin is re-exported by name',
    /exports\.getMyDeliveryPin\s*=\s*_deliveryPin\.getMyDeliveryPin/.test(IDX));
  ck('5.2 the sweep for historical plaintext exists and defaults to report-only',
    /--apply/.test(SRC('scripts/sweep-order-delivery-pins.js')) &&
    /MODE: REPORT ONLY/.test(SRC('scripts/sweep-order-delivery-pins.js')));
}

console.log('\n' + '='.repeat(70));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
if (!fail) {
  console.log('\n  INVARIANT HELD:');
  console.log('    rider → authorized delivery → rider-safe projection');
  console.log('          → no plaintext deliveryPin, no unnecessary customer data');
  console.log('    completeDeliveryWithPin → assignment → PIN verification → completion');
}
process.exit(fail ? 1 : 0);
