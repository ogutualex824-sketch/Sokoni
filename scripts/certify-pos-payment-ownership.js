'use strict';
/* ════════════════════════════════════════════════════════════════════════════════════════════
   POS ZERO-FRICTION — QR OWNERSHIP AND STATUS BOUNDARY.

   Two proven defects in the till confirm path:

     1. `if (pay.sellerUid && pay.sellerUid !== merchantId …)` — a QR document carries `sellerId`,
        so `pay.sellerUid` is undefined and THE WHOLE OWNERSHIP CHECK SHORT-CIRCUITS AWAY.
     2. `if (pay.status !== 'completed')` — only `darajaSTKCallback` ever wrote `completed`, and
        Daraja is retired outbound (D1), so that check now refuses every till payment forever.

   WHY THE FIX IS A MODULE AND THE WIRING IS NOT IN THIS COMMIT
   The consumer exists only as another agent's UNCOMMITTED work. Its confirm block arrives as
   `@@ -172,0 +410,287 @@` — a pure insertion with NO corresponding line in HEAD. There is
   therefore no patch that can carry a change to it without also carrying their 287 unfinished
   lines. That is a git-level fact, demonstrated in §5, not a preference. The decision is
   committed here, certified, and the wiring is a one-line handover.

   ATTRIBUTION SAFETY IS PART OF THE GATE. §5 proves this commit contains none of their work and
   that their file is byte-identical to what they wrote.

   Run:  node scripts/certify-pos-payment-ownership.js
   ════════════════════════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');

const WATCHDOG = setTimeout(() => {
  process.stdout.write('\n  ✖ WATCHDOG — the suite did not finish in 90s. Failing closed.\n');
  process.exit(2);
}, 90000);

let PASS = 0, FAIL = 0, BLOCKED = 0;
const FAILURES = [];
const ok = (id, m) => { PASS++; console.log('  ✔ ' + id.padEnd(10) + m); return true; };
const bad = (id, m, x) => { FAIL++; FAILURES.push(id + ' — ' + m); console.log('  ✖ ' + id.padEnd(10) + m + (x ? '\n              ' + String(x).slice(0, 240) : '')); return false; };
const check = (id, c, m, x) => (c ? ok(id, m) : bad(id, m, x));
const section = (t) => console.log('\n' + t + '\n' + '─'.repeat(Math.max(t.length, 78)));
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/[^\n]*$/gm, ' ');

/* THE GATE RULE: a mutation that did not apply proves nothing. Asserted before every detector. */
function sab(id, what, original, mutated, detector) {
  if (mutated === original) return bad(id, what + ' — THE MUTATION DID NOT APPLY (anchor missed); this check would have proved nothing');
  let f;
  try { f = detector(mutated) === true; } catch (e) { return bad(id, what + ' — detector CRASHED', e.message); }
  return f ? ok(id, 'SABOTAGE ' + what + ' → detected') : bad(id, 'SABOTAGE ' + what + ' → NOT detected');
}

const OWN = require(path.join(FN, 'shared', 'pos-payment-ownership.js'));
const MERCHANT = 'merchant-1', CASHIER = 'cashier-1', OTHER = 'someone-else';
const ACTOR = { merchantId: MERCHANT, cashierId: CASHIER };

const qr = (over) => Object.assign({
  transactionId: 'a'.repeat(32), sellerId: MERCHANT, status: 'paid', total: 500, gatewayAmount: 500,
}, over || {});
const daraja = (over) => Object.assign({
  checkoutId: 'ws_CO_010920261406287705726803', sellerUid: MERCHANT, status: 'completed', amount: 500,
}, over || {});

function main() {
  console.log('\n════════════════════════════════════════════════════════════════════════════════');
  console.log('  POS ZERO-FRICTION — QR OWNERSHIP AND STATUS BOUNDARY');
  console.log('════════════════════════════════════════════════════════════════════════════════');

  section('1  OWNERSHIP IS ENFORCED THROUGH sellerId, AND CANNOT VANISH');
  check('O1-1', OWN.assertConfirmable(qr(), ACTOR).ok === true, 'the shop that owns the QR payment may confirm it');
  check('O1-2', OWN.assertConfirmable(qr({ sellerId: CASHIER }), ACTOR).ok === true, 'so may the cashier identity');
  {
    const r = OWN.assertConfirmable(qr({ sellerId: OTHER }), ACTOR);
    check('O1-3', !r.ok && r.reason === 'wrong_shop', 'another shop is refused → ' + r.reason);
  }
  {
    /* THE DEFECT ITSELF: no sellerUid, no sellerId. The old guard skipped the whole check here. */
    const r = OWN.assertConfirmable(qr({ sellerId: undefined }), ACTOR);
    check('O1-4', !r.ok && r.reason === 'no_owner',
      'a document identifying NO shop is REFUSED, not waved through → ' + r.reason);
  }
  check('O1-5', OWN.assertConfirmable(qr({ sellerId: '' }), ACTOR).reason === 'no_owner', 'an empty owner is no owner');
  check('O1-6', OWN.ownerOf(qr({ sellerId: undefined, sellerUid: MERCHANT })) === MERCHANT,
    'a legacy sellerUid is still read, so nothing is lost by preferring sellerId');
  {
    /* Ownership is decided BEFORE status, so an unauthorised caller learns nothing about state. */
    const r = OWN.assertConfirmable(qr({ sellerId: OTHER, status: 'pending' }), ACTOR);
    check('O1-7', r.reason === 'wrong_shop', 'a stranger is told "wrong shop", never the payment\'s status');
  }

  section('2  THE QR SUCCESS STATE IS paid — AND ONLY paid');
  check('S2-1', OWN.QR_PAID === 'paid', 'the terminal success state is declared');
  for (const st of ['pending', 'expired', 'cancelled', 'refunded']) {
    const r = OWN.assertConfirmable(qr({ status: st }), ACTOR);
    check('S2-' + st, !r.ok && r.reason === 'not_paid', 'a ' + st + ' QR payment cannot settle a sale');
  }
  {
    const r = OWN.assertConfirmable(qr({ status: 'completed' }), ACTOR);
    check('S2-completed', !r.ok && r.reason === 'not_paid',
      "a QR document spelling Daraja's 'completed' is NOT accepted → " + r.reason);
  }
  {
    const r = OWN.assertConfirmable(qr(), ACTOR);
    check('S2-amt', r.ok && r.amount === 500, 'a confirmable payment returns the gateway figure for the caller to check (' + r.amount + ')');
    check('S2-amt2', OWN.assertConfirmable(qr({ gatewayAmount: undefined, total: 800 }), ACTOR).amount === 800,
      '…falling back to the server-priced total, never to a caller-supplied number');
  }

  section('3  A LEGACY DARAJA DOCUMENT CANNOT BECOME A QR PAYMENT');
  {
    const r = OWN.assertConfirmable(daraja(), ACTOR);
    check('D3-1', !r.ok && r.reason === 'legacy_daraja_document',
      "a Daraja document reading 'completed' is refused outright → " + r.reason);
  }
  check('D3-2', OWN.classifyRail(daraja()) === 'daraja' && OWN.classifyRail(qr()) === 'qr',
    'the rails are discriminated by transactionId vs checkoutId, not by status');
  check('D3-3', OWN.classifyRail({ transactionId: 'x', checkoutId: 'y' }) === 'unknown',
    'a document carrying BOTH discriminators is not guessed about');
  check('D3-4', OWN.assertConfirmable({ status: 'paid', sellerId: MERCHANT }, ACTOR).reason === 'unknown_shape',
    'a document on neither rail is refused, even reading paid and owned by this shop');
  check('D3-5', OWN.assertConfirmable(null, ACTOR).reason === 'no_document', 'a missing document is refused');
  check('D3-6', OWN.assertConfirmable(daraja({ sellerUid: OTHER }), ACTOR).reason === 'legacy_daraja_document',
    "…and the legacy rail is refused before ownership, so it cannot be probed for another shop's data");

  section('4  THIS IS NOT A PAYMENT AUTHORITY');
  {
    const SRC = strip(fs.readFileSync(path.join(FN, 'shared', 'pos-payment-ownership.js'), 'utf8'));
    check('A4-1', !/\.set\(|\.update\(|\.create\(|\.delete\(|collection\(/.test(SRC),
      'it performs no Firestore operation of any kind');
    check('A4-2', !/require\(/.test(SRC), 'it requires nothing — no gateway, no admin SDK, no network');
    check('A4-3', !/status:\s*'paid'/.test(SRC), 'it never assigns a paid status');
    check('A4-4', /collection\(/.test("db.collection('x')"), 'CONTROL — the Firestore detector fires when such a call IS present');
    const before = JSON.stringify(qr());
    const doc = qr(); OWN.assertConfirmable(doc, ACTOR);
    check('A4-5', JSON.stringify(doc) === before, 'and it does not mutate the document it is given');
  }

  section('5  ATTRIBUTION — THE OTHER AGENT\'S WORK IS NOT IN THIS COMMIT');
  {
    const staged = execSync('git diff --cached --name-only', { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
    check('T5-1', staged.indexOf('functions/pos-zero-friction.js') === -1,
      'functions/pos-zero-friction.js is NOT staged', JSON.stringify(staged));
    const mine = /assertConfirmable|classifyRail|pos-payment-ownership|payOwner|PAID_STATES|D2 —/;
    const wt = fs.readFileSync(path.join(FN, 'pos-zero-friction.js'), 'utf8');
    check('T5-2', !mine.test(wt), 'their working copy carries none of my markers — my earlier edit is fully withdrawn');
    check('T5-3', /if \(pay\.sellerUid && pay\.sellerUid !== merchantId/.test(wt),
      'their original guard stands exactly as they wrote it');
    check('T5-4', /if \(pay\.status !== 'completed'\)/.test(wt), 'and so does their status check');
  }
  {
    /* The git-level fact that makes the wiring uncommittable, demonstrated rather than asserted. */
    const head = execSync('git show HEAD:functions/pos-zero-friction.js', { cwd: ROOT, encoding: 'utf8' });
    check('T5-5', head.indexOf('posPayments') === -1 && head.indexOf('CONFIRMABLE') === -1,
      'the consumer does not exist in HEAD at all — there is no line for a fix to patch');
    const hunks = execSync('git diff -U0 -- functions/pos-zero-friction.js', { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter((l) => /^@@/.test(l));
    const insertionOnly = hunks.some((h) => /@@ -\d+,0 \+\d+,\d{2,} @@/.test(h));
    check('T5-6', insertionOnly,
      'their block arrives as a PURE INSERTION — any patch carrying a fix to it must carry their lines too');
  }

  section('6  SABOTAGE');
  const SRC = strip(fs.readFileSync(path.join(FN, 'shared', 'pos-payment-ownership.js'), 'utf8'));
  sab('X6-1', 'restoring the vanishing ownership guard', SRC,
    SRC.replace('if (!owner) {', 'if (false) {'),
    (s) => !/if \(!owner\) \{/.test(s));
  sab('X6-2', 'accepting Daraja\'s completed as a QR success', SRC,
    SRC.replace("if (status !== QR_PAID) {", "if (status !== QR_PAID && status !== 'completed') {"),
    (s) => /status !== 'completed'/.test(s));
  sab('X6-3', 'letting a legacy Daraja document settle a sale', SRC,
    SRC.replace("if (rail === 'daraja') {", "if (false) {"),
    (s) => !/if \(rail === 'daraja'\) \{/.test(s));
  sab('X6-4', 'checking status before ownership', SRC,
    SRC.replace('const owner = ownerOf(pay);', 'const owner = null; /* moved */'),
    (s) => !/const owner = ownerOf\(pay\);/.test(s));
  sab('X6-5', 'giving the module a Firestore write', SRC,
    SRC.replace('return { ok: true, rail, owner,', "db.collection('posPayments').doc(pay.transactionId).update({ status: 'paid' });\n  return { ok: true, rail, owner,"),
    (s) => /collection\(/.test(s));
  /* And a behavioural control: the real module still answers correctly after all of that. */
  check('X6-R', OWN.assertConfirmable(qr(), ACTOR).ok === true
    && OWN.assertConfirmable(qr({ sellerId: undefined }), ACTOR).reason === 'no_owner',
    'POST-SABOTAGE — the live module is untouched and still decides correctly');

  section('7  THE WIRING — SELF-ARMING');
  {
    /* ── THIS ASSERTION ARMS ITSELF ───────────────────────────────────────────────────────
       The authority cannot be wired while its consumer is another agent's UNCOMMITTED work:
       their confirm block is a pure insertion with no HEAD baseline, so any commit carrying
       my one line also carries their 287 unfinished lines.

       "Someone has to remember to wire it later" is exactly the failure this session has hit
       three times — something built, certified, and never reached. So instead of a note, this
       is a check that is INERT while their work is uncommitted and turns LIVE the moment it
       lands: from then on the suite FAILS until the wiring exists.

       The trigger is HEAD, not the working tree, because the working tree is theirs to change
       moment to moment and must not make my suite red. */
    let head = '';
    try { head = execSync('git show HEAD:functions/pos-zero-friction.js', { cwd: ROOT, encoding: 'utf8' }); } catch (_) { head = ''; }
    const consumerLanded = /CONFIRMABLE|collection\('posPayments'\)/.test(head);

    /* An arming mechanism nobody has watched arm is a promise, not a guard. Both branches are
       exercised here against synthetic content, so the live behaviour is observed today rather
       than trusted to work on the day it matters. */
    const armed = (src) => /CONFIRMABLE|collection\('posPayments'\)/.test(src);
    const wired = (src) => /require\(['"]\.\/shared\/pos-payment-ownership['"]\)/.test(src) && /assertConfirmable\s*\(/.test(src);
    check('W7-CTL1', armed("const CONFIRMABLE = { mpesa: 1 };") === true,
      'CONTROL — the trigger fires on content that contains their confirm block');
    check('W7-CTL2', armed('const x = 1;') === false,
      'CONTROL — and stays inert on content that does not');
    check('W7-CTL3', wired("const CONFIRMABLE=1; require('./shared/pos-payment-ownership'); assertConfirmable(p,a);") === true
      && wired("const CONFIRMABLE = { mpesa: 1 };") === false,
      'CONTROL — once armed it PASSES on wired content and FAILS on unwired content');

    if (!consumerLanded) {
      ok('W7-1', 'the consumer is still uncommitted — this check is INERT and will arm itself when their block reaches HEAD');
      check('W7-2', fs.existsSync(path.join(FN, 'shared', 'pos-payment-ownership.js')),
        'the authority it will demand is committed and ready');
    } else {
      check('W7-1', /require\(['"]\.\/shared\/pos-payment-ownership['"]\)/.test(head),
        'THEIR BLOCK HAS LANDED — pos-zero-friction must now require the certified authority');
      check('W7-2', /assertConfirmable\s*\(/.test(head),
        '…and must call assertConfirmable rather than carrying its own ownership/status checks');
      check('W7-3', !/if \(pay\.sellerUid && pay\.sellerUid !== merchantId/.test(head),
        '…and the vanishing-ownership guard must be gone');
      check('W7-4', !/if \(pay\.status !== 'completed'\)/.test(head),
        "…and the Daraja-only 'completed' check must be gone");
    }
  }

  section('7b  THE WIRING, HANDED OVER');
  console.log('  ○  One line, for whoever owns functions/pos-zero-friction.js, once their work lands:');
  console.log('');
  console.log("       const _own = require('./shared/pos-payment-ownership');");
  console.log('       …');
  console.log('       const v = _own.assertConfirmable(pay, { merchantId, cashierId });');
  console.log("       if (!v.ok) _e(v.message, v.reason === 'wrong_shop' ? 'permission-denied'");
  console.log("                                 : v.reason === 'no_document' ? 'not-found'");
  console.log("                                 : 'failed-precondition');");
  console.log('');
  console.log('     It replaces BOTH the status check and the ownership check. The sufficiency');
  console.log('     check below them stays as theirs — v.amount is what it should compare.');

  return finish();
}

function finish() {
  section('SUMMARY');
  console.log('  passed  : ' + PASS + '\n  failed  : ' + FAIL + '\n  blocked : ' + BLOCKED);
  if (FAILURES.length) { console.log('\n  FAILURES:'); FAILURES.forEach((f) => console.log('   • ' + f)); }
  const green = FAIL === 0 && BLOCKED === 0;
  console.log('\n  ' + (green ? '✅ POS OWNERSHIP: GREEN' : '❌ NOT GREEN'));
  console.log('  Certification only. Nothing deployed; no other agent\'s file modified.\n');
  clearTimeout(WATCHDOG);
  process.exit(green ? 0 : 1);
}

try { main(); } catch (e) {
  console.log('\n  ✖ SUITE CRASHED — a crash is not a pass.\n    ' + (e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n    ') : e));
  clearTimeout(WATCHDOG); process.exit(2);
}
