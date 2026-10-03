#!/usr/bin/env node
/* test-admin-approval-notify.js — admin approvals notify the applicant through a REAL path,
 * and the UI says "sent"/"Notified" ONLY when a notify() channel reported exactly 'sent'.
 *
 * Owner requirement (2026-10-01): approving a lawyer, a law firm, a healthcare facility or a
 * property listing must notify the applicant through a real notification path; the UI may say
 * "sent" only when the transport accepted it, otherwise "pending" or "Delivery failed".
 *
 * Proves, without touching production (no network, no emulator):
 *   E  notifyStatusText / notifyErrorText / notifyStatusTone — the ONLY producer of "Notified" —
 *      EXECUTED on fixtures extracted from admin.html (not a copy).
 *   F  the real admin.html handlers EXECUTED in a VM with stub callables:
 *        lawyer / firm / healthcare approve+reject → applicationDecide {applicationId, decision};
 *        property approve/reject → bnbListings decision, THEN notifySend {uid: hostUid, type,
 *        dedupeKey 'bnb:<id>:<status>'}; the rendered status is what the callable returned.
 *   S  static: handler → callable chains, no local-only approval writes, no wa.me, no toast
 *      literal claiming the applicant was notified/sent outside the status function.
 *   N  negative controls: {inapp:'queued'} is not "sent"; a sabotaged status function
 *      (treats any non-failed value as sent) is caught by E; an injected
 *      toast('Applicant notified') is caught by the S detector.
 *
 * Run: node scripts/test-admin-approval-notify.js
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ck = (label, ok, got) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : '   [got ' + JSON.stringify(got) + ']')); ok ? pass++ : fail++; };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');

const html = read('admin.html');
const LINES = html.split('\n');

/* Extract a TOP-LEVEL function's source by name. Top-level functions in admin.html close
   with a bare "}" at column 0; single-line ones close on their own line. Fails closed: an
   unknown name throws, it never returns an empty stub. */
function fnSrc(name) {
  const re = new RegExp('^(async\\s+)?function\\s+' + name.replace(/\$/g, '\\$') + '\\s*\\(');
  const i = LINES.findIndex((l) => re.test(l));
  if (i < 0) throw new Error('function not found in admin.html: ' + name);
  const first = LINES[i];
  const opens = (first.match(/\{/g) || []).length, closes = (first.match(/\}/g) || []).length;
  if (opens > 0 && opens === closes && /\}\s*$/.test(first)) return first;
  for (let j = i + 1; j < LINES.length; j++) if (LINES[j] === '}') return LINES.slice(i, j + 1).join('\n');
  throw new Error('unterminated function: ' + name);
}
function blockSrc(open, close) {
  const a = html.indexOf(open), b = html.indexOf(close, a);
  if (a < 0 || b < 0) throw new Error('block markers not found: ' + open);
  /* start at the beginning of the marker's comment line, end after the closing marker line */
  return html.slice(html.lastIndexOf('\n', a) + 1, html.indexOf('\n', b));
}

const STATUS_BLOCK = blockSrc('/* <notify-status>', '/* </notify-status>');
const loadStatus = (src) => { const c = vm.createContext({}); vm.runInContext(src, c, { filename: 'notify-status' }); return c; };

/* ── E: the status function, executed ── */
function runE(S, tag) {
  const r = [];
  const t = (x) => S.notifyStatusText(x);
  r.push(['E1  channels.inapp "sent" → contains "Notified"', /Notified/.test(t({ ok: true, channels: { inapp: 'sent' } })), t({ ok: true, channels: { inapp: 'sent' } })]);
  r.push(['E2  channels.inapp "failed" → contains "failed", never "Notified"', /failed/i.test(t({ channels: { inapp: 'failed' } })) && !/Notified|sent\b/i.test(t({ channels: { inapp: 'failed' } })), t({ channels: { inapp: 'failed' } })]);
  const rec = { ok: true, applicationId: 'a1', status: 'approved', projected: true, receipt: { ok: true, uid: 'u1', role: 'legal', status: 'approved', writes: [{ collection: 'legalProviders', action: 'upsert' }] } };
  r.push(['E3  applicationDecide receipt WITHOUT a notification field (today\'s server) → "pending"', /pending/i.test(t(rec)) && !/Notified/.test(t(rec)), t(rec)]);
  r.push(['E4  null / undefined / string / number → "pending"', [null, undefined, 'sent', 42, {}].every((x) => /pending/i.test(t(x)) && !/Notified/.test(t(x))), [null, undefined, 'sent', 42, {}].map(t)]);
  const recN = { ok: true, receipt: { ok: true, notification: { ok: true, key: 'app_approved:a1', channels: { inapp: 'sent', push: 'failed:no_token' } } } };
  r.push(['E5  receipt.notification.channels (future server) is read: in-app sent → "Notified in-app", push failure stated', /^Notified in-app/.test(t(recN)) && /push delivery failed/.test(t(recN)), t(recN)]);
  r.push(['E6  bare channels map { push:"sent" } → "Notified by push"', t({ push: 'sent' }) === 'Notified by push', t({ push: 'sent' })]);
  r.push(['E7  deduped with no channels → "duplicate suppressed", not "Notified"', /duplicate suppressed/.test(t({ ok: true, deduped: true, key: 'k' })) && !/Notified/.test(t({ ok: true, deduped: true, key: 'k' })), t({ ok: true, deduped: true, key: 'k' })]);
  r.push(['E8  channels present but none reported (inapp muted by prefs) → "pending"', /pending/i.test(t({ channels: {} })), t({ channels: {} })]);
  r.push(['N1  NEGATIVE CONTROL: { inapp:"queued" } is NOT reported as sent/notified', !/Notified|\bsent\b/i.test(t({ inapp: 'queued' })) && /pending|not confirmed/i.test(t({ inapp: 'queued' })), t({ inapp: 'queued' })]);
  r.push(['N1b sms "queued" + email "queued" (accepted by a queue, not delivered) → not "Notified"', !/Notified/.test(t({ channels: { sms: 'queued', email: 'queued' } })), t({ channels: { sms: 'queued', email: 'queued' } })]);
  /* exhaustive: for every non-'sent' value on every channel, the text never claims delivery */
  const vals = ['queued', 'failed', 'failed:no_token', 'no_address', 'deduped', 'suppressed_by_preference', 'not_needed_push_delivered', 'SENT', 'sent ', 'processing', ''];
  const offenders = [];
  for (const k of ['inapp', 'push', 'sms', 'email']) for (const v of vals) { const s = t({ channels: { [k]: v } }); if (/Notified|\bsent\b/i.test(s)) offenders.push(k + '=' + JSON.stringify(v) + ' → ' + s); }
  r.push(['E9  no non-"sent" channel value on any channel ever yields "Notified"/"sent" (44 cases)', offenders.length === 0, offenders]);
  r.push(['E10 notifyErrorText: permission-denied → "isn\'t registered for notifications"; other codes → "Notification not sent: <code>"',
    /isn't registered for notifications/.test(S.notifyErrorText({ code: 'functions/permission-denied' })) && S.notifyErrorText({ code: 'functions/internal' }) === 'Notification not sent: internal' && /not sent/.test(S.notifyErrorText(null)),
    [S.notifyErrorText({ code: 'functions/permission-denied' }), S.notifyErrorText({ code: 'functions/internal' }), S.notifyErrorText(null)]]);
  r.push(['E11 tone: only a "Notified …" line is ok; pending is wait; failed/not sent is bad',
    S.notifyStatusTone('Notified in-app') === 'ok' && S.notifyStatusTone(t(null)) === 'wait' && S.notifyStatusTone('Delivery failed (in-app)') === 'bad' && S.notifyStatusTone(S.notifyErrorText({ code: 'x' })) === 'bad', null]);
  return r;
}
console.log('\n── E: notifyStatusText — executed from admin.html ──');
const S = loadStatus(STATUS_BLOCK);
for (const [l, ok, got] of runE(S)) ck(l, ok, got);

console.log('\n── N2: sabotage — a status function that treats any non-failed value as sent ──');
{
  const sab = STATUS_BLOCK.replace("if(v==='sent') sent.push(k);", "if(v.indexOf('failed')!==0) sent.push(k);");
  ck('N2a sabotage was applied (the marker line exists)', sab !== STATUS_BLOCK, null);
  const caught = runE(loadStatus(sab)).filter(([, ok]) => !ok).map(([l]) => l.slice(0, 4).trim());
  ck('N2b the E suite catches it (N1 / E9 go red)', caught.includes('N1') && caught.includes('E9'), caught);
}

/* ── F: the real handlers, executed with stub callables ── */
console.log('\n── F: handlers executed — lawyer / firm / healthcare → applicationDecide; property → notifySend ──');
const FLOW_FNS = ['h', '_decideApp', '_decideAppById', '_decisionNoteHtml', '_decideServerApp',
  '_serverDecideButtons', 'approveLawyer', 'rejectLawyer', 'approveFirm', 'rejectFirm',
  '_isHcApplication', '_hcFacRows', 'approveHcFac', 'rejectHcFac', 'removeLocalHcFac',
  '_propByRef', '_decideProp', '_plainNotifyText', '_notifyPropHost', '_decidePropAndNotify', 'approveProp', 'rejectProp'];
const FLOW_SRC = STATUS_BLOCK + '\nvar _decisionNotes={};\n' + FLOW_FNS.map(fnSrc).join('\n');

function mkCtx(opts) {
  const calls = [], toasts = [], bnbWrites = [], ls = {};
  const replies = opts.replies || {};
  const c = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    D: opts.D || { apps: [], hcFacPending: [], bnbListings: [] },
    toast: (m, x) => toasts.push(String(m)),
    prompt: () => (opts.prompt === undefined ? 'Incomplete documents' : opts.prompt),
    renderLegal() {}, renderHealthcare() {}, renderProperties() {},
    localStorage: { setItem: (k, v) => { ls[k] = v; }, getItem: (k) => ls[k] || null },
    Date,
  };
  c.window = {
    sokoniCallable: (name) => async (payload) => {
      calls.push({ name, payload });
      const r = replies[name];
      if (typeof r === 'function') return r(payload);
      if (r instanceof Error) throw r;
      return { data: r === undefined ? {} : r };
    },
    SokoniDB: { updateBnbListingStatus: async (id, status, meta) => { if (opts.bnbFail) throw new Error('rules said no'); bnbWrites.push({ id, status, meta }); } },
    firebaseAuth: { currentUser: { uid: 'admin1' } },
    sokoniFirestoreAudit: () => {},
  };
  vm.createContext(c);
  vm.runInContext(FLOW_SRC, c, { filename: 'admin-flows' });
  return { c, calls, toasts, bnbWrites, ls };
}
const decideReply = (extra) => ({ ok: true, status: 'approved', projected: true, receipt: Object.assign({ ok: true, uid: 'u1', role: 'legal', status: 'approved', writes: [{ collection: 'legalProviders', action: 'upsert' }, { collection: 'lawyers', action: 'upsert' }] }, extra || {}) });

(async () => {
  /* F1 lawyer approve — today's server (no notification in receipt) */
  let x = mkCtx({ D: { apps: [{ _fsId: 'law1', name: 'Wanjiru Advocate', type: 'lawyer', status: 'pending' }] }, replies: { applicationDecide: decideReply() } });
  await x.c.approveLawyer('law1');
  ck('F1  approveLawyer → ONE applicationDecide {applicationId:"law1", decision:"approve"}', x.calls.length === 1 && x.calls[0].name === 'applicationDecide' && x.calls[0].payload.applicationId === 'law1' && x.calls[0].payload.decision === 'approve', x.calls);
  const n1 = x.c._decisionNotes.law1;
  ck('F2  …and reports "Approved · applicant notification pending (the server does not report delivery yet)"', n1 === 'Approved · Applicant notification pending (the server does not report delivery yet)', n1);
  ck('F3  …never claims Notified/sent anywhere (row note or toast)', !/Notified|\bsent\b/i.test(n1 + ' ' + x.toasts.join(' ')), { n1, toasts: x.toasts });
  ck('F4  …no localStorage write (no local-only approval)', Object.keys(x.ls).length === 0, x.ls);

  /* F5 receipt with a notification result (future server) */
  x = mkCtx({ D: { apps: [{ _fsId: 'firm1', name: 'Otieno & Co', type: 'law_firm' }] }, replies: { applicationDecide: decideReply({ notification: { ok: true, channels: { inapp: 'sent', push: 'failed:no_token' } } }) } });
  await x.c.approveFirm('firm1');
  ck('F5  approveFirm with receipt.notification.channels.inapp "sent" → "Approved · Notified in-app · push delivery failed"', x.c._decisionNotes.firm1 === 'Approved · Notified in-app · push delivery failed', x.c._decisionNotes.firm1);
  x = mkCtx({ D: { apps: [{ _fsId: 'firm2' }] }, replies: { applicationDecide: decideReply({ notification: { channels: { inapp: 'failed' } } }) } });
  await x.c.approveFirm('firm2');
  ck('F6  …inapp "failed" → "Delivery failed"', /^Approved · Delivery failed/.test(x.c._decisionNotes.firm2), x.c._decisionNotes.firm2);

  /* F7 reject routes through the server, states no notice was sent */
  x = mkCtx({ D: { apps: [{ _fsId: 'law2' }] }, replies: { applicationDecide: { ok: true, status: 'rejected', receipt: { ok: true, writes: [] } } } });
  await x.c.rejectLawyer('law2');
  ck('F7  rejectLawyer → applicationDecide {decision:"reject", reason}; row says "applicant not notified"', x.calls.length === 1 && x.calls[0].payload.decision === 'reject' && x.calls[0].payload.reason === 'Incomplete documents' && /not notified/.test(x.c._decisionNotes.law2), { calls: x.calls, note: x.c._decisionNotes.law2 });
  x = mkCtx({ D: { apps: [{ _fsId: 'firm3' }] }, prompt: null });
  await x.c.rejectFirm('firm3');
  ck('F8  rejectFirm cancelled at the prompt → NO call (a cancel is not a decision)', x.calls.length === 0, x.calls);

  /* F9 no Firestore application → no call, no local approval */
  x = mkCtx({});
  await x.c.approveLawyer('');
  ck('F9  approve with no server application id → no callable, "No server application — ask the applicant to resubmit"', x.calls.length === 0 && x.toasts.some((t) => /No server application — ask the applicant to resubmit/.test(t)), x.toasts);
  const btn = x.c._serverDecideButtons(null, 'approveLawyer', 'rejectLawyer');
  ck('F10 a row with no _fsId renders a DISABLED approve with the resubmit message and no approve onclick', /disabled/.test(btn) && /No server application — ask the applicant to resubmit/.test(btn) && !/onclick="approveLawyer/.test(btn), btn);

  /* F11 callable failure */
  x = mkCtx({ D: { apps: [{ _fsId: 'law3' }] }, replies: { applicationDecide: Object.assign(new Error('Administrator access required.'), { code: 'functions/permission-denied' }) } });
  await x.c.approveLawyer('law3');
  ck('F11 applicationDecide refused → row says "Approve failed … applicant not notified", status NOT flipped', /^Approve failed: Administrator access required\./.test(x.c._decisionNotes.law3) && /not notified/.test(x.c._decisionNotes.law3) && !/Notified/.test(x.c._decisionNotes.law3) && x.c.D.apps[0].status === undefined, x.c._decisionNotes.law3);

  /* F12 no_uid receipt */
  x = mkCtx({ D: { apps: [{ _fsId: 'hc9' }] }, replies: { applicationDecide: { ok: true, status: 'approved', receipt: { ok: false, reason: 'no_uid', appId: 'hc9' } } } });
  await x.c.approveHcFac('hc9');
  ck('F12 receipt.ok false / no_uid → "NOT provisioned … notification not possible"', /NOT provisioned \(no_uid\)/.test(x.c._decisionNotes.hc9) && /notification not possible/.test(x.c._decisionNotes.hc9), x.c._decisionNotes.hc9);

  /* F13 healthcare rows come from Firestore applications */
  x = mkCtx({ D: { apps: [{ _fsId: 'hc1', id: 'FAC1', requestedRole: 'health', name: 'Ruiru Clinic' }, { _fsId: 'lx', type: 'lawyer' }], hcFacPending: [{ id: 'FAC1', name: 'Ruiru Clinic' }, { id: 'FAC2', name: 'Local Only Dispensary', status: 'approved' }] }, replies: { applicationDecide: decideReply({ role: 'health', writes: [{ collection: 'healthProviders', action: 'delegated' }] }) } });
  const rows = x.c._hcFacRows();
  ck('F13 healthcare rows = Firestore health applications; a local FAC with no server match is kept with fsId null (not approvable)', rows.length === 2 && rows[0].fsId === 'hc1' && rows[1].fsId === null && rows[1].fac.id === 'FAC2', rows.map((r) => [r.fsId, r.fac.id]));
  await x.c.approveHcFac('hc1');
  ck('F14 approveHcFac → applicationDecide on the APPLICATIONS id (hc1), not the local FAC id', x.calls.length === 1 && x.calls[0].payload.applicationId === 'hc1' && x.calls[0].payload.decision === 'approve', x.calls);
  await x.c.rejectHcFac('hc1');
  ck('F15 rejectHcFac → applicationDecide {decision:"reject"}', x.calls.length === 2 && x.calls[1].payload.decision === 'reject', x.calls);
  x.c.removeLocalHcFac('FAC2');
  ck('F16 removing a local copy is housekeeping only: no callable, toast says no server record changed', x.calls.length === 2 && /no server record was changed/.test(x.toasts[x.toasts.length - 1]), x.toasts);

  /* F17 property approve → decision on the CLICKED listing, then notifySend */
  const listings = () => [{ _fsId: 'L0', name: 'Other', hostUid: 'h0' }, { _fsId: 'L1', name: '<b>Villa</b> "Kilifi"', hostUid: 'h1' }];
  x = mkCtx({ D: { bnbListings: listings() }, replies: { notifySend: { ok: true, key: 'bnb:L1:active', channels: { inapp: 'sent', push: 'failed:no_token' } } } });
  await x.c.approveProp('L1');
  const ns = x.calls.filter((c) => c.name === 'notifySend');
  ck('F17 approveProp("L1") decides L1 (by id — the filtered-index drift is gone), THEN calls notifySend once', x.bnbWrites.length === 1 && x.bnbWrites[0].id === 'L1' && x.bnbWrites[0].status === 'active' && ns.length === 1, { w: x.bnbWrites, calls: x.calls });
  const p = ns[0] && ns[0].payload || {};
  ck('F18 notifySend payload: uid = hostUid, type system_update, dedupeKey "bnb:L1:active", markup stripped from the body', p.uid === 'h1' && p.type === 'system_update' && p.dedupeKey === 'bnb:L1:active' && !/[<>"]/.test(p.body) && /Villa/.test(p.body), p);
  ck('F19 row reports the returned channels: "Property approved · Notified in-app · push delivery failed"', x.c._decisionNotes.L1 === 'Property approved · Notified in-app · push delivery failed', x.c._decisionNotes.L1);

  x = mkCtx({ D: { bnbListings: listings() }, replies: { notifySend: Object.assign(new Error('Cannot notify another user.'), { code: 'functions/permission-denied' }) } });
  await x.c.approveProp('L1');
  ck('F20 notifySend permission-denied → "Notification not sent — your admin account isn\'t registered for notifications"; approval KEPT', x.bnbWrites.length === 1 && x.c._decisionNotes.L1 === "Property approved · Notification not sent — your admin account isn't registered for notifications", x.c._decisionNotes.L1);
  x = mkCtx({ D: { bnbListings: listings() }, replies: { notifySend: Object.assign(new Error('x'), { code: 'functions/internal' }) } });
  await x.c.rejectProp('L1');
  ck('F21 rejectProp + callable error → "Notification not sent: internal"; dedupeKey "bnb:L1:rejected"', x.bnbWrites[0].status === 'rejected' && x.c._decisionNotes.L1 === 'Property rejected · Notification not sent: internal' && x.calls[0].payload.dedupeKey === 'bnb:L1:rejected', { n: x.c._decisionNotes.L1, c: x.calls });
  x = mkCtx({ D: { bnbListings: [{ _fsId: 'L5', name: 'No host' }] } });
  await x.c.approveProp('L5');
  ck('F22 no hostUid → "No applicant account — notification not possible", notifySend NOT called', x.calls.length === 0 && x.c._decisionNotes.L5 === 'Property approved · No applicant account — notification not possible', x.c._decisionNotes.L5);
  x = mkCtx({ D: { bnbListings: listings() }, bnbFail: true });
  await x.c.approveProp('L1');
  ck('F23 the decision write fails → NO notification is sent (never announce an unsaved decision)', x.calls.length === 0 && x.toasts.some((t) => /Could not save the decision/.test(t)), { calls: x.calls, toasts: x.toasts });
  x = mkCtx({ D: { bnbListings: listings() }, replies: { notifySend: { ok: true, deduped: true, key: 'bnb:L1:active' } } });
  await x.c.approveProp('L1');
  ck('F24 notifySend deduped → "duplicate suppressed", not "Notified"', /duplicate suppressed/.test(x.c._decisionNotes.L1) && !/Notified/.test(x.c._decisionNotes.L1), x.c._decisionNotes.L1);

  /* ── S: static ── */
  console.log('\n── S: static — chains, no local-only approvals, no fake "sent" ──');
  const src = (n) => fnSrc(n);
  ck('S1  approveLawyer / approveFirm / approveHcFac → _decideServerApp → _decideAppById → sokoniCallable("applicationDecide")',
    ['approveLawyer', 'approveFirm', 'approveHcFac', 'rejectLawyer', 'rejectFirm', 'rejectHcFac'].every((n) => /_decideServerApp\(/.test(src(n))) && /_decideAppById\(/.test(src('_decideServerApp')) && /sokoniCallable\('applicationDecide'\)/.test(src('_decideAppById')), null);
  ck('S2  approveProp / rejectProp → _decidePropAndNotify → _notifyPropHost → sokoniCallable("notifySend")',
    /_decidePropAndNotify\(/.test(src('approveProp')) && /_decidePropAndNotify\(/.test(src('rejectProp')) && /_notifyPropHost\(/.test(src('_decidePropAndNotify')) && /sokoniCallable\('notifySend'\)/.test(src('_notifyPropHost')), null);
  const notifyJs = read('functions/notify.js');
  const typesBlock = notifyJs.slice(notifyJs.indexOf('const TYPES = {'), notifyJs.indexOf('};', notifyJs.indexOf('const TYPES = {')));
  ck('S3  the notify TYPE used (system_update) is registered in functions/notify.js TYPES (an unknown type throws server-side)', /\n\s*system_update:\s*\{/.test(typesBlock) && /type: 'system_update'/.test(src('_notifyPropHost')), null);
  const OWNED = FLOW_FNS.filter((n) => n !== 'h').concat(['approveApp', 'rejectApp', 'renderLegal', 'renderHealthcare']);
  const ownedSrc = OWNED.map(src).join('\n');
  ck('S4  no local-only approval writes remain: no sokoniLawyerApp / sokoni_firm_registrations writes, no updateApplicationStatus, no client registeredAs.legal|healthcare',
    !/setItem\('sokoniLawyerApp'|setItem\('sokoni_firm_registrations'/.test(html) && !/updateApplicationStatus/.test(ownedSrc) && !/registeredAs\.(legal|healthcare)/.test(ownedSrc), null);
  ck('S5  no wa.me in any approval / notification flow', !/wa\.me/.test(ownedSrc + STATUS_BLOCK), null);
  const FAKE_TOAST = /toast\(\s*(['"`])(?:(?!\1).)*\b(notified|sent)\b/i;
  const offenders = OWNED.filter((n) => FAKE_TOAST.test(src(n)));
  ck('S6  no toast LITERAL in these flows says "notified"/"sent" — only notifyStatusText output may', offenders.length === 0, offenders);
  const notifiedLits = (html.match(/(['"])Notified /g) || []).length;
  const notifiedInBlock = (STATUS_BLOCK.match(/(['"])Notified /g) || []).length;
  ck('S7  the literal "Notified " exists ONLY inside the <notify-status> block', notifiedLits === notifiedInBlock && notifiedInBlock >= 1, { notifiedLits, notifiedInBlock });
  ck('S8  approveApp appends the notification status to its receipt toast', /notifyStatusText\(d\)/.test(src('approveApp')), null);
  ck('S9  healthcare local rows render a disabled Approve with the resubmit message', /disabled aria-disabled="true" title="No server application — ask the applicant to resubmit"/.test(src('renderHealthcare')), null);
  ck('S10 property buttons pass the listing id (data-id), not the filtered row index', /onclick="approveProp\(this\.dataset\.id\)"/.test(html) && !/approveProp\('\+i\+'\)/.test(html), null);
  ck('S11 N3 NEGATIVE CONTROL: the S6 detector catches an injected toast(\'Applicant notified\')', FAKE_TOAST.test("toast('✅ Applicant notified');") && FAKE_TOAST.test('toast("Notification sent")') && !FAKE_TOAST.test("toast(_decisionNotes[id])"), null);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR (fail closed):', e && e.stack || e); process.exit(2); });
