#!/usr/bin/env node
/* ADMINOS TIER 1 — FAILURE INJECTION for the five dead controls.
 *
 * These five call Cloud Functions that exist NOWHERE in functions/ and return HTTP 404
 * from production (control: adminProcessPayout returns 401, a nonexistent name returns
 * 404 — so the discriminator is real):
 *
 *     adminCreateCampaign · adminUpdateCampaignStatus · adminDeleteCampaign
 *     adminSendEmailBlast · adminSendSMSBlast
 *
 * Each previously swallowed the failure and fired an unconditional success toast, so an
 * admin saw "Campaign created" / "SMS queued" for an operation that never ran.
 *
 * This does NOT pattern-match source. It EXECUTES each shipped function inside a sandbox
 * with an injected failing `_call`, and asserts on the toasts actually produced. The
 * missing backends are NOT rebuilt — only the honesty of the failure is corrected.
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

const HELPER = fnBody(SRC, '_opFailure');

/* ── the sandbox ───────────────────────────────────────────────────────────── */
function run(name, inject) {
  const toasts = [];
  const body = fnBody(SRC, name);
  if (!body) return { error: 'NOT-EXTRACTED', toasts };
  const env = {
    _call: inject,
    _toast: (msg, kind) => { toasts.push({ msg: String(msg), kind }); },
    _panelCache: {},
    _commsTab: () => {},
    _contentTab: () => {},
    prompt: () => 'x',
    document: {
      getElementById: () => ({ value: 'filled' }),
      querySelectorAll: () => [],
    },
    SK: { dialog: { confirm: async () => true } },
  };
  const keys = Object.keys(env);
  const factory = new Function(...keys, HELPER + '\n' + body + '\nreturn ' + name + ';');
  const fn = factory(...keys.map((k) => env[k]));
  return { fn, toasts };
}

const TARGETS = [
  { fn: 'sendEmailBlast',   op: 'adminSendEmailBlast',       success: 'Email blast queued' },
  { fn: 'sendSMSBlast',     op: 'adminSendSMSBlast',         success: 'SMS queued' },
  { fn: 'createCampaign',   op: 'adminCreateCampaign',       success: 'Campaign created' },
  { fn: 'activateCampaign', op: 'adminUpdateCampaignStatus', success: 'Campaign activated' },
  { fn: 'deleteCampaign',   op: 'adminDeleteCampaign',       success: 'Campaign deleted' },
];

/* the shape a missing Cloud Function actually produces through the callable SDK */
/* A real callable REJECTS a promise; it does not throw synchronously. Throwing sync
   means .catch() is never attached and the error escapes the pre-fix shape entirely —
   which is not what production does. */
const NOT_DEPLOYED = async () => { const e = new Error('internal'); e.code = 'internal'; throw e; };
const DENIED = async () => { const e = new Error('Missing permissions'); e.code = 'permission-denied'; throw e; };
const WORKS = async () => ({ ok: true });

(async function main() {
  console.log('');
  console.log('  ADMINOS TIER 1 — failure injection (5 dead controls)');
  console.log('');
  ok('_opFailure was extracted from the shipped file', !!HELPER);

  for (const t of TARGETS) {
    /* ── INJECT: the backend does not exist (the real production case) ──────── */
    {
      const r = run(t.fn, NOT_DEPLOYED);
      ok(t.fn + ' is extractable', !!r.fn, r.error);
      if (r.fn) {
        await r.fn('id-1');
        const succ = r.toasts.filter((x) => x.kind === 'success');
        const errs = r.toasts.filter((x) => x.kind === 'error');
        ok(t.fn + ' [404] fires NO success toast', succ.length === 0,
           succ.map((x) => x.msg).join(' | '));
        ok(t.fn + ' [404] fires an error toast', errs.length === 1, String(errs.length));
        ok(t.fn + ' [404] says the operation was NOT performed',
           errs.length === 1 && /was NOT performed/.test(errs[0].msg),
           errs[0] && errs[0].msg);
        ok(t.fn + ' [404] names it unavailable on the server',
           errs.length === 1 && /unavailable on the server/.test(errs[0].msg),
           errs[0] && errs[0].msg);
        ok(t.fn + ' [404] never claims the success wording',
           !r.toasts.some((x) => x.msg.indexOf(t.success) > -1));
      }
    }
    /* ── INJECT: a refusal, not an absence ─────────────────────────────────── */
    {
      const r = run(t.fn, DENIED);
      if (r.fn) {
        await r.fn('id-1');
        const succ = r.toasts.filter((x) => x.kind === 'success');
        const errs = r.toasts.filter((x) => x.kind === 'error');
        ok(t.fn + ' [denied] fires NO success toast', succ.length === 0);
        ok(t.fn + ' [denied] keeps the server message',
           errs.length === 1 && /Missing permissions/.test(errs[0].msg), errs[0] && errs[0].msg);
        ok(t.fn + ' [denied] still says NOT performed',
           errs.length === 1 && /was NOT performed/.test(errs[0].msg));
      }
    }
    /* ── CONTROL: when the call SUCCEEDS the success toast must still fire ──── */
    {
      const r = run(t.fn, WORKS);
      if (r.fn) {
        await r.fn('id-1');
        ok(t.fn + ' [success] still reports success (not broken by the fix)',
           r.toasts.some((x) => x.kind === 'success' && x.msg.indexOf(t.success) > -1),
           r.toasts.map((x) => x.kind + ':' + x.msg).join(' | '));
      }
    }
  }

  /* ── the boundary this suite guards ────────────────────────────────────────
     Originally this pinned adminSendPushNotification as an untouched TIER 2 marker.
     TIER 2 was later authorized and push notification is one of its 9 state/moderation
     targets, so that marker became stale and this suite correctly FAILED the gate at
     52/1. The live boundary is now the 6 CONTENT targets that remain deliberately HELD;
     pinning those keeps a real check here instead of deleting one. */
  const inlineCatches = (SRC.match(/\.catch\(\s*e\s*=>\s*_toast/g) || []).length;
  ok('exactly 9 inline-catch sites remain — the HELD content set', inlineCatches === 9,
     String(inlineCatches));
  ['adminUpsertCategory', 'adminSaveBanner', 'adminDeleteBanner',
   'adminUpsertFaq', 'adminDeleteFaq', 'adminSaveAnnouncement'].forEach(function (t) {
    ok(t + ' is still HELD',
       new RegExp('_call\\("' + t + '"[\\s\\S]{0,90}?\\.catch\\(\\s*e\\s*=>\\s*_toast').test(SRC));
  });
  ok('no new callable was invented',
     !/adminCreateCampaign\s*[:=]\s*(?:async\s*)?\(/.test(SRC));

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
    /* Run the PRE-FIX shape through the same harness. If the harness cannot catch a
       fabricated success, every result above is meaningless. */
    const toasts = [];
    const env = {
      _call: NOT_DEPLOYED,
      _toast: (m, k) => toasts.push({ msg: String(m), kind: k }),
      _panelCache: {}, _contentTab: () => {},
    };
    const legacy =
      '  async function legacySend() {\n' +
      '    await _call("adminSendSMSBlast", {}).catch(e => _toast(e.message, "error"));\n' +
      '    _toast("SMS queued for all", "success");\n' +
      '  }';
    const keys = Object.keys(env);
    const f = new Function(...keys, legacy + '\nreturn legacySend;')(...keys.map((k) => env[k]));
    await f();
    const fabricated = toasts.some((x) => x.kind === 'success');
    console.log('    ' + (fabricated ? 'PASS' : 'FAIL') +
                '  the harness OBSERVES a fabricated success in the pre-fix shape');
    if (!fabricated) controlsOk = false;
  }
  {
    /* the injectors must actually throw — a no-op injector would pass everything */
    let threw = 0;
    await NOT_DEPLOYED().catch(() => { threw++; });
    await DENIED().catch(() => { threw++; });
    console.log('    ' + (threw === 2 ? 'PASS' : 'FAIL') +
                '  both failure injectors actually throw (' + threw + '/2)');
    if (threw !== 2) controlsOk = false;
  }
  {
    const found = TARGETS.filter((t) => !!fnBody(SRC, t.fn)).length;
    console.log('    ' + (found === 5 ? 'PASS' : 'FAIL') +
                '  all 5 target functions were extracted (' + found + '/5)');
    if (found !== 5) controlsOk = false;
  }

  console.log('');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('');
  console.log('  SCOPE: honesty only. The five backends are still ABSENT and were NOT built.');
  console.log('  These controls now report failure truthfully; they do not work.');
  if (!controlsOk) {
    console.log('');
    console.log('  BLOCKED — a control misbehaved; the result above cannot be trusted.');
    process.exit(1);
  }
  process.exit(fail > 0 ? 1 : 0);
})();
