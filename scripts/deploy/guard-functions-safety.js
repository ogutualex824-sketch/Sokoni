#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   FUNCTIONS SAFETY GUARD — a functions deploy must not silently remove the
   payment-path protections that are already live.
   ══════════════════════════════════════════════════════════════════════════════
   THE FAILURE THIS EXISTS TO PREVENT (observed 2026-08-28)

   darajaSTKPush, sendTestSTKPush and darajaSTKCallback were deployed from a
   branch carrying the MSISDN safety fix and the sandbox lane. Production hosting
   then moved forward on a DIFFERENT lineage that never contained those commits.
   For several hours, `firebase deploy --only functions` from the hosting lineage
   would have silently reverted:

     • MSISDN validation on the live customer STK path
     • the fail-CLOSED seller-phone ownership check (back to fail-OPEN)
     • the sandbox callback lane

   Nothing warned. guard-no-rollback compares the HOSTING tree against live
   hosting; it says nothing about functions. This closes that gap.

   WHY PROPERTIES AND NOT COMMIT ANCESTRY

   The obvious guard is "refuse unless commit X is an ancestor of HEAD". It does
   not work. Converging these fixes onto the live lineage was done by cherry-pick,
   which creates new SHAs — the code is present and correct while the original
   commits are NOT ancestors. An ancestry check would have failed on the very
   lineage that carries the fix, and would fail again after any rebase or squash.

   So this asserts what the code DOES. It survives cherry-pick, rebase, squash and
   re-authoring, and it fails only when a protection is genuinely gone.

   Guards are EXECUTED, not pattern-matched, wherever a behaviour can be run: a
   regex proved satisfiable even when `if (!normPhone)` was replaced with
   `if (false)`, because it only showed the throw was nearby.

     node scripts/deploy/guard-functions-safety.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8');
/* Comment-stripped view: an assertion that a construct is GONE must not be
   defeated by the comment that explains its removal. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let fail = 0;
const bad = (msg, detail) => {
  console.error('  BLOCKED  ' + msg + (detail !== undefined ? '   [' + detail + ']' : ''));
  fail++;
};
const ok = (msg, detail) => console.log('  ok       ' + msg + (detail !== undefined ? '   [' + detail + ']' : ''));

console.log('\nFunctions safety guard — payment-path protections\n');

/* ── 1. the canonical MSISDN normaliser, EXECUTED ─────────────────────────── */
const defs = (SRC.match(/^function _normalizeMsisdn/gm) || []).length;
if (defs !== 1) bad('_normalizeMsisdn must be defined exactly once', defs + ' definitions');
else {
  const seg = SRC.slice(SRC.indexOf('function _normalizeMsisdn(raw) {'));
  const body = seg.slice(0, seg.indexOf('\n}') + 2);
  let n;
  try { n = new Function(body + '\nreturn _normalizeMsisdn;')(); }
  catch (e) { bad('_normalizeMsisdn does not compile', e.message.slice(0, 60)); n = null; }
  if (n) {
    const cases = [
      ['0712345678', '254712345678'], ['+254712345678', '254712345678'],
      ['254712345678', '254712345678'], ['712345678', '254712345678'],
      ['00254712345678', '254712345678'], ['0112345678', '254112345678'],
      ['07123456789', null], ['071234567', null], ['', null],
      ['not-a-phone', null], ['0812345678', null], [null, null],
    ];
    const wrong = cases.filter(([i, w]) => n(i) !== w);
    if (wrong.length) bad('_normalizeMsisdn behaviour changed', wrong.map(([i]) => JSON.stringify(i)).join(', '));
    else ok('_normalizeMsisdn normalises and REFUSES correctly', cases.length + '/' + cases.length);
  }
}

/* ── 2. every STK site uses it ────────────────────────────────────────────── */
const uses = (SRC.split('_normalizeMsisdn(').length - 1) - 1;   /* minus the definition */
if (uses < 3) bad('all three STK sites must use the canonical normaliser', uses + ' call sites');
else ok('all STK sites use the canonical normaliser', uses + ' call sites');

/* ── 3. the fail-OPEN ownership guard must be gone ────────────────────────── */
if (/if \(sellerPhone && sellerPhone\.length === 12/.test(CODE)) {
  bad('the seller-phone ownership check has reverted to FAIL-OPEN');
} else ok('seller-phone ownership check is not the fail-open form');

/* ── 4. the guards themselves, EXECUTED ───────────────────────────────────── */
const runGuard = (marker, vars) => {
  const st = CODE.indexOf(marker);
  if (st < 0) return 'MISSING';
  const seg = CODE.slice(st);
  const end = seg.indexOf('}', seg.indexOf('throw new HttpsError'));
  if (end < 0) return 'MISSING';
  const block = seg.slice(0, end + 1);
  const ctx = Object.assign({
    _normalizeMsisdn: (r) => {
      let d = String(r === undefined || r === null ? '' : r).replace(/\D/g, '');
      if (d.startsWith('00')) d = d.slice(2);
      if (!d.startsWith('254')) {
        if (d.startsWith('0')) d = '254' + d.slice(1);
        else if (/^[17]\d{8}$/.test(d)) d = '254' + d;
      }
      return /^254[17]\d{8}$/.test(d) ? d : null;
    },
    HttpsError: function (code, msg) { this.code = code; this.message = msg; },
  }, vars);
  const names = Object.keys(ctx);
  try { new Function(...names, block)(...names.map((k) => ctx[k])); return 'ALLOWED'; }
  catch (e) { return e.code || ('THREW:' + e.message); }
};

const gPush = runGuard('const normPhone = _normalizeMsisdn(phone);', { phone: '07123456789' });
if (gPush !== 'invalid-argument') bad('darajaSTKPush must REFUSE a malformed number', gPush);
else ok('darajaSTKPush refuses a malformed number', gPush);

const gPushOk = runGuard('const normPhone = _normalizeMsisdn(phone);', { phone: '0712345678' });
if (gPushOk !== 'ALLOWED') bad('darajaSTKPush must ALLOW a valid number', gPushOk);
else ok('darajaSTKPush allows a valid number');

const gOwnNone = runGuard('const sellerPhone = _normalizeMsisdn(cfg.phone || cfg.ownerPhone);',
  { cfg: {}, phone: '254712345678' });
if (gOwnNone !== 'failed-precondition') bad('ownership check must FAIL CLOSED with no stored phone', gOwnNone);
else ok('ownership check fails closed when ownership cannot be established', gOwnNone);

const gOwnMatch = runGuard('const sellerPhone = _normalizeMsisdn(cfg.phone || cfg.ownerPhone);',
  { cfg: { phone: '0712345678' }, phone: '254712345678' });
if (gOwnMatch !== 'ALLOWED') bad('ownership check must ALLOW the registered phone', gOwnMatch);
else ok('ownership check allows the seller’s own registered phone');

/* ── 5. the sandbox lane: present, and INERT by default ───────────────────── */
if (!/const _DARAJA_SANDBOX_SELLER_UIDS/.test(CODE)) {
  bad('the sandbox callback lane allowlist is missing');
} else {
  const m = CODE.match(/const _DARAJA_SANDBOX_SELLER_UIDS = new Set\(([\s\S]*?)\);/);
  const decl = m ? m[1] : '';
  if (!/process\.env\.DARAJA_SANDBOX_SELLER_UIDS/.test(decl)) {
    bad('the sandbox allowlist must come from the environment, never a literal');
  } else {
    delete process.env.DARAJA_SANDBOX_SELLER_UIDS;
    const size = new Set(String(process.env.DARAJA_SANDBOX_SELLER_UIDS || '')
      .split(',').map((s) => s.trim()).filter(Boolean)).size;
    if (size !== 0) bad('the sandbox lane must be INERT when unconfigured', size + ' enrolled');
    else ok('sandbox lane present and INERT when unconfigured', '0 enrolled');
  }
  if (!/if \(!ipTrusted && _DARAJA_SANDBOX_SELLER_UIDS\.size === 0\)/.test(CODE)) {
    bad('the read-free early reject is missing — a public endpoint becomes a read amplifier');
  } else ok('untrusted callers are rejected WITHOUT a Firestore read when unconfigured');
  if (!/payData\.env !== "sandbox"/.test(CODE) || !/_DARAJA_SANDBOX_SELLER_UIDS\.has\(payData\.sellerUid\)/.test(CODE)) {
    bad('the lane must require BOTH env==="sandbox" AND allowlist membership (env is seller-forgeable)');
  } else ok('lane requires env AND enrolment — a forged sandbox claim is not enough');
}

/* ── 6. sandbox money must not book real paperwork ────────────────────────── */
if (!/if \(resultCode === 0 && !_isSandbox\)/.test(CODE)) {
  bad('the financial engine is no longer gated on !_isSandbox — sandbox money could book real paperwork');
} else ok('financial engine gated off for sandbox/test payments');
if (!/isTest:\s+_isSandbox/.test(CODE)) {
  bad('isTest is not propagated to sellerPayments — a KES 1 test will book a real commission');
} else ok('isTest propagated to the seller credit');

/* ── 7. document-id safety ────────────────────────────────────────────────── */
if (!/checkoutId\.includes\("\/"\)/.test(CODE)) {
  bad('checkoutId is not validated before .doc() — a caller-supplied id can address another path');
} else ok('checkoutId validated before use as a document path');

/* ── 8. production authorisation must not be hard-opened in source ────────── */
if (/productionAuthorized\s*[:=]\s*true/.test(CODE)) {
  bad('productionAuthorized is set true in source — that decision is external, never code');
} else ok('productionAuthorized is not opened in source');

console.log('');
if (fail) {
  console.error('FUNCTIONS SAFETY GUARD FAILED — ' + fail + ' protection(s) missing.\n' +
                'A deploy from this tree would remove live payment protections.\n' +
                'Do NOT bypass. Port the missing protection onto this lineage first;\n' +
                'see docs/STK_MSISDN_SAFETY.md and docs/SANDBOX_CALLBACK_LANE.md.\n');
  process.exit(1);
}
console.log('Functions safety guard PASSED — payment-path protections intact.\n');
process.exit(0);
