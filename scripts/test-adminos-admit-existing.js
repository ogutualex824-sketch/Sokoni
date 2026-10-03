#!/usr/bin/env node
/**
 * test-adminos-admit-existing.js — AdminOS "Admit existing provider/seller" (owner 2026-10-03: Shave 'n' Trims, DJ Bambi).
 * The SHIPPED functions from sokoni-aos.js are EXECUTED in a sandbox (same extraction approach as
 * test-adminos-tier2-action-honesty.js), with controlled form fields.
 *   A1 calls applicationAdmitExistingProvider with {uid, role, category, reason} — the server is the authority
 *   A2 success text / toast ONLY when the server answers ok:true with an applicationId
 *   A3 a server refusal shows the server's reason, never a success toast
 *   A4 a response without ok:true is NOT treated as success
 *   A5 empty category / short reason never reach the server
 *   A6 the admin cancelling the confirm never reaches the server
 *   A7 replay + provisioned profile are reported from the server's own fields
 *   A8 the button appears for provider / seller accounts only
 *   SABOTAGE=1 → success shown regardless of ok → A3/A4 must FAIL
 */
'use strict';
const fs = require('fs'), path = require('path');
let SRC = fs.readFileSync(path.join(__dirname, '..', 'sokoni-aos.js'), 'utf8');
if (process.env.SABOTAGE === '1') SRC = SRC.split('r && r.ok === true && r.applicationId').join('r');
let pass = 0, fail = 0;
const ck = (id, ok, m, d) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + id + '  ' + m + (ok || d === undefined ? '' : '   [' + JSON.stringify(d).slice(0, 200) + ']')); ok ? pass++ : fail++; };

function fnBody(src, name) {
  const re = new RegExp('(async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = re.exec(src); if (!m) return null;
  let i = src.indexOf('{', m.index), d = 0;
  for (let j = i; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) return src.slice(m.index, j + 1); }
  return null;
}
const HELPER = fnBody(SRC, '_actionFailure');
const BODY = fnBody(SRC, 'submitAdmitExisting');
const VIEW = fnBody(SRC, 'viewUser');
if (!HELPER || !BODY || !VIEW) { console.error('HARNESS ERROR: functions not extracted — cannot prove anything'); process.exit(2); }

function run({ category, reason, confirm = true, server }) {
  const calls = [], toasts = [];
  const els = { admitCategory: { value: category }, admitReason: { value: reason }, admitResult: { textContent: '' }, admitSubmit: { disabled: false } };
  const env = {
    _call: async (name, data) => { calls.push({ name, data }); return server(); },
    _toast: (msg, kind) => toasts.push({ msg: String(msg), kind }),
    _panelCache: {},
    document: { getElementById: (id) => els[id] || null },
    SK: { dialog: { confirm: async () => confirm } },
  };
  const scope = new Proxy(env, { has: () => true, get: (t, k) => (k === Symbol.unscopables ? undefined : (k in t ? t[k] : (k in globalThis ? globalThis[k] : function () {}))) });
  const fn = new Function('__s', 'with (__s) {' + HELPER + '\n' + BODY + '\nreturn submitAdmitExisting;}')(scope);
  return { go: () => fn('13iuLZx63jN5evaNcUnx7bhDSfs1', 'provider'), calls, toasts, els };
}

(async () => {
  console.log('\nAdminOS — admit existing provider' + (process.env.SABOTAGE === '1' ? '  (SABOTAGE)' : '') + '\n');
  let t = run({ category: 'salon', reason: 'Live barber, onboarded by SOKONI', server: async () => ({ ok: true, applicationId: 'ADM_13iu', replay: false, providerProfileProvisioned: true }) });
  await t.go();
  ck('A1', t.calls.length === 1 && t.calls[0].name === 'applicationAdmitExistingProvider' && t.calls[0].data.uid === '13iuLZx63jN5evaNcUnx7bhDSfs1' && t.calls[0].data.role === 'provider' && t.calls[0].data.category === 'salon' && t.calls[0].data.reason.length >= 5, 'calls the server authority with uid, role, category, reason', t.calls);
  ck('A2', /Recorded: ADM_13iu/.test(t.els.admitResult.textContent) && t.toasts.some((x) => x.kind === 'success'), 'success shown on the server\'s ok:true', { text: t.els.admitResult.textContent, toasts: t.toasts });
  ck('A7', /dashboard profile created/.test(t.els.admitResult.textContent), 'provisioned profile reported from the server field', t.els.admitResult.textContent);

  t = run({ category: 'salon', reason: 'Live barber, onboarded by SOKONI', server: async () => { const e = new Error('An administrator cannot decide their own application.'); e.code = 'permission-denied'; throw e; } });
  await t.go();
  ck('A3', /Approval failed — An administrator cannot decide their own application/.test(t.els.admitResult.textContent) && !t.toasts.some((x) => x.kind === 'success'), 'a refusal shows the server\'s reason, no success toast', { text: t.els.admitResult.textContent, toasts: t.toasts });

  t = run({ category: 'salon', reason: 'Live barber, onboarded by SOKONI', server: async () => ({ ok: false, reason: 'HAS_APPLICATION' }) });
  await t.go();
  ck('A4', !/Recorded/.test(t.els.admitResult.textContent) && !t.toasts.some((x) => x.kind === 'success'), 'a response without ok:true is not success', { text: t.els.admitResult.textContent, toasts: t.toasts });

  t = run({ category: '', reason: 'Live barber, onboarded by SOKONI', server: async () => ({ ok: true, applicationId: 'x' }) });
  await t.go();
  const a5a = t.calls.length === 0;
  t = run({ category: 'salon', reason: 'ok', server: async () => ({ ok: true, applicationId: 'x' }) });
  await t.go();
  ck('A5', a5a && t.calls.length === 0 && /at least 5/.test(t.els.admitResult.textContent), 'empty category / short reason never reach the server');

  t = run({ category: 'salon', reason: 'Live barber, onboarded by SOKONI', confirm: false, server: async () => ({ ok: true, applicationId: 'x' }) });
  await t.go();
  ck('A6', t.calls.length === 0, 'cancelling the confirm never reaches the server', t.calls);

  t = run({ category: 'artist_creator', reason: 'Trading DJ with live bookings', server: async () => ({ ok: true, applicationId: 'ADM_AiJp', replay: true, providerProfileProvisioned: false }) });
  await t.go();
  const a7b = /already admitted/.test(t.els.admitResult.textContent) && !/dashboard profile created/.test(t.els.admitResult.textContent);
  ck('A7b', a7b, 'replay reported; no profile claim when the server did not provision', t.els.admitResult.textContent);

  ck('A8', /\(u\.role === "provider" \|\| u\.role === "seller"\) \?/.test(VIEW) && /admitExistingProvider\(/.test(VIEW), 'the action is offered for provider / seller accounts only');

  console.log('\n' + pass + ' passed, ' + fail + ' failed' + (process.env.SABOTAGE === '1' ? '   (SABOTAGE — failures EXPECTED)' : ''));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e.message); process.exit(2); });
