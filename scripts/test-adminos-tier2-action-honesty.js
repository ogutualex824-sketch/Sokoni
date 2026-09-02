#!/usr/bin/env node
/* ADMINOS TIER 2 — ACTION HONESTY by FAILURE INJECTION.
 *
 * 13 targets / 17 call sites whose backends EXIST. Each previously discarded a rejected
 * callable with `.catch(e => _toast(...))` and then fired an unconditional success toast.
 *
 * The client CAN legitimately know the outcome here: a callable resolves on return and
 * rejects on throw. The answer arrived and was thrown away. So the property under test is
 * simply: A SUCCESS TOAST IS EMITTED ONLY AFTER THE CALLABLE RESOLVES.
 *
 * Each shipped function is EXECUTED in a sandbox — this is not source pattern-matching.
 * Three injections per site:
 *   1. the callable REJECTS  -> no success toast; the SERVER'S OWN message is shown
 *   2. the callable REJECTS with no message -> still no success; a non-empty error
 *   3. the callable RESOLVES -> the success toast MUST still fire
 * (3) is load-bearing: without it a function that simply crashed in the sandbox would
 * "pass" (1) and (2) vacuously.
 *
 * The 6 CONTENT targets (9 sites) are deliberately HELD and asserted UNCHANGED, so the
 * FIX/HOLD boundary is enforced by this suite rather than by care.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'sokoni-aos.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (label, cond, note) => {
  if (cond) pass++;
  else { fail++; console.log('  FAIL  ' + label + (note ? '   [' + note + ']' : '')); }
};

function fnBody(src, name) {
  const m = src.match(new RegExp('\\n  (?:async )?function ' + name + '\\s*\\('));
  if (!m) return null;
  const end = src.indexOf('\n  }', m.index);
  return end < 0 ? null : src.slice(m.index, end + 4);
}

const HELPER = fnBody(SRC, '_actionFailure');

/* ── a permissive DOM/host sandbox ─────────────────────────────────────────── */
function makeEnv(inject, toasts) {
  const el = () => ({
    value: 'v', textContent: '', innerHTML: '', checked: true, id: 'x',
    querySelectorAll: () => [], querySelector: () => el(),
    classList: { add() {}, remove() {}, toggle() { return false; } },
    setAttribute() {}, appendChild() {}, remove() {},
  });
  return {
    _call: inject,
    _toast: (msg, kind) => { toasts.push({ msg: String(msg), kind }); },
    _panelCache: {},
    _closeModal: () => {}, _loadUsers: () => {}, _loadSupport: () => {},
    _loadFraud: () => {}, _loadSecurity: () => {}, _loadContent: () => {},
    _commsTab: () => {}, _contentTab: () => {}, _financialTab: () => {},
    _titleCase: (s) => String(s), _esc: (s) => String(s), _fmt: (s) => String(s),
    prompt: () => 'x', confirm: () => true, alert: () => {},
    document: {
      getElementById: () => el(), querySelector: () => el(), querySelectorAll: () => [],
      createElement: () => el(), body: el(),
    },
    SK: { dialog: { confirm: async () => true, prompt: async () => 'x' } },
    window: { innerWidth: 1280 },
    firebase: { firestore: () => ({}) },
  };
}

/* The SUCCESS path calls panel-refresh helpers (_marketplaceTab, _loadX, ...) that are
   defined elsewhere in the module. Enumerating them is a losing game and a missing one
   would abort the run, so unknown identifiers resolve to a no-op through a `with` scope.
   `new Function` bodies are non-strict regardless of this file's 'use strict', so `with`
   is available. The stubs that MATTER (_call, _toast) are real and come from env. */
function run(name, inject) {
  const toasts = [];
  const body = fnBody(SRC, name);
  if (!body) return { error: 'NOT-EXTRACTED', toasts };
  const env = makeEnv(inject, toasts);
  const scope = new Proxy(env, {
    has: () => true,
    get: (t, k) => {
      if (k === Symbol.unscopables) return undefined;
      if (k in t) return t[k];
      /* `has: () => true` shadows EVERY identifier, real globals included — without this
         line `String` resolved to the no-op and String(x).trim() threw. Real globals must
         win before the fallback. */
      if (k in globalThis) return globalThis[k];
      return function () {};
    },
  });
  try {
    const factory = new Function('__s',
      'with (__s) {' + HELPER + '\n' + body + '\nreturn ' + name + ';}');
    return { fn: factory(scope), toasts };
  } catch (e) {
    return { error: 'SANDBOX: ' + e.message, toasts };
  }
}

/* control fn, callable, claim fragment that must NOT appear on failure */
const TARGETS = [
  ['banUser',              'tsBanUser',                   'successfully'],
  ['changeRole',           'adminUpdateUserRole',         'Role updated'],
  ['updateProduct',        'adminUpdateProductStatus',    'Product status updated'],
  ['updateOrder',          'adminUpdateOrderStatus',      'Order updated'],
  ['moderateReview',       'adminModerateReview',         'Review '],
  ['resolveTicket',        'adminResolveSupportTicket',   'Ticket resolved'],
  ['replyTicket',          'adminResolveSupportTicket',   'Reply sent'],
  ['sendPushNotification', 'adminSendPushNotification',   'Notification sent'],
  ['toggleAIModule',       'adminUpdateFeatureFlag',      'nabled'],
  ['reindex',              'searchFullReindex',           'Reindex started'],
  ['repairSearch',         'searchRepairAll',             'Search repair started'],
  ['voidReceiptDialog',    'voidTrustReceipt',            'Receipt voided'],
  ['reviewReport',         'tsReviewReport',              'Report '],
  ['saveSettings',         'adminUpdatePlatformSettings', 'Settings saved'],
  ['updateFlag',           'adminUpdateFeatureFlag',      'nabled'],
  ['saveCommissionRules',  'adminUpdatePlatformSettings', 'Commission rules saved'],
  ['savePayoutSchedule',   'adminUpdatePlatformSettings', 'Payout schedule saved'],
];

/* the 9 sites deliberately HELD */
const HELD = [
  'adminUpsertCategory', 'adminSaveBanner', 'adminDeleteBanner',
  'adminUpsertFaq', 'adminDeleteFaq', 'adminSaveAnnouncement',
];

const SERVER_MSG = 'PERMISSION_DENIED: caller is not an admin';
const REJECTS  = async () => { const e = new Error(SERVER_MSG); e.code = 'permission-denied'; throw e; };
const SILENT   = async () => { throw {}; };                      /* no .message at all */
const RESOLVES = async () => ({ success: true });

(async function main() {
  console.log('');
  console.log('  ADMINOS TIER 2 — action honesty (13 targets / 17 sites)');
  console.log('');
  ok('_actionFailure extracted from the shipped file', !!HELPER);

  for (const [fnName, callable, claimFrag] of TARGETS) {
    /* 1 · the callable rejects with a server message */
    {
      const r = run(fnName, REJECTS);
      ok(fnName + ' is runnable', !!r.fn, r.error);
      if (r.fn) {
        await r.fn('id-1', 'active');
        const succ = r.toasts.filter((t) => t.kind === 'success');
        const errs = r.toasts.filter((t) => t.kind === 'error');
        ok(fnName + ' [reject] emits NO success toast', succ.length === 0,
           succ.map((t) => t.msg).join(' | '));
        /* scope this to SUCCESS toasts: the error text legitimately contains words like
           "Review" ("Review moderation failed — ..."), so an unscoped substring test
           collides with the very message we want it to show. */
        ok(fnName + ' [reject] never shows its success wording',
           !r.toasts.some((t) => t.kind === 'success' && t.msg.indexOf(claimFrag) > -1));
        ok(fnName + ' [reject] surfaces the SERVER message verbatim',
           errs.some((t) => t.msg.indexOf(SERVER_MSG) > -1),
           errs.map((t) => t.msg).join(' | '));
        ok(fnName + ' [reject] names the failed operation',
           errs.some((t) => / failed — /.test(t.msg)), errs.map((t) => t.msg).join(' | '));
      }
    }
    /* 2 · the callable rejects with nothing useful */
    {
      const r = run(fnName, SILENT);
      if (r.fn) {
        await r.fn('id-1', 'active');
        const succ = r.toasts.filter((t) => t.kind === 'success');
        const errs = r.toasts.filter((t) => t.kind === 'error');
        ok(fnName + ' [empty reject] emits NO success toast', succ.length === 0);
        ok(fnName + ' [empty reject] still shows a non-empty error',
           errs.length > 0 && errs[0].msg.trim().length > 12, errs[0] && errs[0].msg);
      }
    }
    /* 3 · LOAD-BEARING: a resolved call must STILL report success */
    {
      const r = run(fnName, RESOLVES);
      if (r.fn) await r.fn('id-1', 'active');          /* the call itself — omitting it
                                                          made all 17 fail vacuously */
      ok(fnName + ' [resolve] still reports success',
         !!r.fn && r.toasts.some((t) => t.kind === 'success'),
         r.fn ? r.toasts.map((t) => t.kind + ':' + t.msg).join(' | ') : r.error);
    }
  }

  /* ── the HOLD boundary ─────────────────────────────────────────────────── */
  const inline = (SRC.match(/\.catch\(\s*e\s*=>\s*_toast/g) || []).length;
  ok('exactly 9 inline-catch sites remain (the HELD content set)', inline === 9, String(inline));
  HELD.forEach((t) => {
    ok(t + ' is still HELD (inline catch intact)',
       new RegExp('_call\\("' + t + '"[\\s\\S]{0,90}?\\.catch\\(\\s*e\\s*=>\\s*_toast').test(SRC));
  });

  /* the earlier slices must not have regressed */
  ok('TIER 1 _opFailure still present', SRC.indexOf('function _opFailure') > -1);
  ok('_writeFailure still present', SRC.indexOf('function _writeFailure') > -1);
  ok('finosRequestBankPayout still not invoked', !/_call\(\s*["']finosRequestBankPayout["']/.test(SRC));

  /* ══ CONTROLS ═══════════════════════════════════════════════════════════ */
  console.log('  CONTROLS');
  let controlsOk = true;
  {
    const before = fail;
    ok('__negative_control__ (expected to fail)', 1 === 2);
    const detected = fail === before + 1;
    fail = before;
    console.log('    ' + (detected ? 'PASS' : 'FAIL') + '  assertions can fail');
    if (!detected) controlsOk = false;
  }
  {
    /* the harness must OBSERVE a fabricated success in the pre-fix shape */
    const toasts = [];
    const env = makeEnv(REJECTS, toasts);
    const legacy =
      '  async function legacy() {\n' +
      '    await _call("x", {}).catch(e => _toast(e.message, "error"));\n' +
      '    _toast("Role updated", "success");\n' +
      '  }';
    const keys = Object.keys(env);
    const f = new Function(...keys, legacy + '\nreturn legacy;')(...keys.map((k) => env[k]));
    await f();
    const fabricated = toasts.some((t) => t.kind === 'success');
    console.log('    ' + (fabricated ? 'PASS' : 'FAIL') +
                '  the harness OBSERVES a fabricated success in the pre-fix shape');
    if (!fabricated) controlsOk = false;
  }
  {
    let threw = 0;
    await REJECTS().catch(() => { threw++; });
    await SILENT().catch(() => { threw++; });
    const resolved = await RESOLVES().then(() => true, () => false);
    console.log('    ' + (threw === 2 && resolved ? 'PASS' : 'FAIL') +
                '  injectors behave: 2 reject, 1 resolves');
    if (!(threw === 2 && resolved)) controlsOk = false;
  }
  {
    const found = TARGETS.filter(([n]) => !!fnBody(SRC, n)).length;
    console.log('    ' + (found === TARGETS.length ? 'PASS' : 'FAIL') +
                '  all target functions extracted (' + found + '/' + TARGETS.length + ')');
    if (found !== TARGETS.length) controlsOk = false;
  }

  console.log('');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('');
  console.log('  SCOPE: 13 targets / 17 sites corrected. 6 content targets / 9 sites HELD by');
  console.log('  decision and asserted unchanged above. adminSendPushNotification\'s "sent"');
  console.log('  WORDING is a separate authority question and was deliberately not touched.');
  if (!controlsOk) {
    console.log('');
    console.log('  BLOCKED — a control misbehaved; the result above cannot be trusted.');
    process.exit(1);
  }
  process.exit(fail > 0 ? 1 : 0);
})();
