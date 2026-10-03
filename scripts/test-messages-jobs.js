#!/usr/bin/env node
/* JOBS J4 — job-application conversations (sokoni-f3 contract; owner HARD SECURITY GATE). Executes the REAL messages.js
 * createConversation + sendMessage in-process. Parties ALWAYS come from jobApplications/{jobId}_{seekerUid}
 * (seekerUid / employerUid set by the server in applyForJob) — never from the request, never from a stored list alone.
 * Each protection has a deliberate break that must turn its NAMED row red.
 *   node scripts/test-messages-jobs.js        BASE=<ref> (pre-J4 must FAIL) */
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), cp = require('child_process');
const ROOT = path.join(__dirname, '..');
const NM = process.env.SOKONI_NODE_MODULES || 'C:/Users/USER1/OneDrive/Desktop/SOKONI/functions/node_modules';

if (process.argv[2] === '--child') {
  const FN = process.argv[3];
  const H = require('./lib/inmem-firestore').install({ admins: ['admin1'] });
  const { call } = require('./lib/inmem-firestore');
  const { DOCS } = H;
  const M = require(path.join(FN, 'messages.js'))._h;
  const now = Date.now();
  const app = (jobId, seeker, employer, extra) => DOCS.set('jobApplications/' + jobId + '_' + seeker, Object.assign({ jobId, seekerUid: seeker, employerUid: employer, status: 'reviewing', updatedAt: now }, extra || {}));
  ['seekA', 'seekB', 'seekC', 'empA', 'empB', 'stranger'].forEach((u) => DOCS.set('users/' + u, { displayName: u }));
  app('job1', 'seekA', 'empA'); app('job2', 'seekB', 'empB'); app('job3', 'seekC', 'empB');
  app('job4', 'seekA', 'empA', { status: 'rejected', updatedAt: now - 31 * 86400000 });
  app('job5', 'seekA', 'empA', { status: 'withdrawn', updatedAt: now - 5 * 86400000 });
  const open = (uid, txId, extra) => call(M.createConversation, uid, Object.assign({ transactionType: 'job_application', transactionId: txId }, extra || {}));
  const send = (uid, convId, text) => call(M.sendMessage, uid, { conversationId: convId, type: 'text', text: text || 'hello' });
  const conv = (txId) => DOCS.get('conversations/job_application_' + txId) || null;
  (async () => {
    const out = {};
    /* (1) applicant A tries B's application FIRST (before B opens it), then B opens it, then A tries to send */
    const a1 = await open('seekA', 'job2_seekB');
    const created1 = !!conv('job2_seekB');
    const b1 = await open('seekB', 'job2_seekB');
    const a1s = await send('seekA', 'job_application_job2_seekB');
    out.R1 = { a1: a1.code || 'ok', created1, b1: b1.ok ? 'ok' : b1.code, a1s: a1s.code || 'ok' };
    /* (2) employer A tries employer B's candidate conversation (job3: seekC ↔ empB) */
    const e2 = await open('empA', 'job3_seekC');
    const created2 = !!conv('job3_seekC');
    await open('empB', 'job3_seekC');
    const e2s = await send('empA', 'job_application_job3_seekC');
    out.R2 = { e2: e2.code || 'ok', created2, e2s: e2s.code || 'ok' };
    /* (3) a user tries to set the applicant in the request */
    const r3 = await open('empA', 'job1_seekA', { participantUids: ['empA', 'seekB'], seekerUid: 'seekB' });
    out.R3 = { ok: !!r3.ok, parts: (conv('job1_seekA') || {}).participants || null };
    /* (4) a user tries to set the employer in the request (fresh application) */
    app('job6', 'seekA', 'empA');
    const r4 = await open('seekA', 'job6_seekA', { participantUids: ['seekA', 'empB'], employerUid: 'empB' });
    out.R4 = { ok: !!r4.ok, parts: (conv('job6_seekA') || {}).participants || null };
    /* (5) a conversation attached to a DIFFERENT application: the stored list is forged to include seekA, but the send
       re-derives the parties from job2's application and refuses */
    const c5 = conv('job2_seekB');
    if (c5) DOCS.set('conversations/job_application_job2_seekB', Object.assign({}, c5, { participants: (c5.participants || []).concat(['seekA']) }));
    const r5 = await send('seekA', 'job_application_job2_seekB');
    out.R5 = { code: r5.code || 'ok' };
    /* (6) a third party cannot create a conversation; nothing is written */
    app('job7', 'seekC', 'empB');
    const r6 = await open('stranger', 'job7_seekC');
    out.R6 = { code: r6.code || 'ok', created: !!conv('job7_seekC') };
    /* window: terminal > 30 days → read-only for new messages; terminal ≤ 30 days → still allowed */
    await open('seekA', 'job4_seekA'); await open('seekA', 'job5_seekA');
    const w1 = await send('seekA', 'job_application_job4_seekA');
    const w2 = await send('empA', 'job_application_job5_seekA');
    out.W = { old: w1.code || 'ok', oldDet: w1.det && w1.det.code, recent: w2.ok ? 'ok' : w2.code, history: !!conv('job4_seekA') };
    /* positive control: the two real parties can message */
    const p1 = await send('seekA', 'job_application_job1_seekA'), p2 = await send('empA', 'job_application_job1_seekA');
    out.P = { p1: p1.ok ? 'ok' : p1.code, p2: p2.ok ? 'ok' : p2.code };
    console.log('RESULT_JSON ' + JSON.stringify(out));
  })().catch((e) => { console.error(e && e.stack || e); process.exit(2); });
  return;
}

const evaluate = (FN) => { const o = cp.spawnSync(process.execPath, [__filename, '--child', FN], { env: Object.assign({}, process.env, { NODE_PATH: NM }), encoding: 'utf8' });
  const line = (o.stdout || '').split('\n').find((l) => l.startsWith('RESULT_JSON ')); return line ? JSON.parse(line.slice(12)) : { crash: (o.stderr || o.stdout || '').slice(-600) }; };
const same = (a, b) => JSON.stringify((a || []).slice().sort()) === JSON.stringify((b || []).slice().sort());
const rows = (x) => ({
  'J1 applicant A can neither open nor write to applicant B\'s application conversation': !!x.R1 && x.R1.a1 === 'permission-denied' && !x.R1.created1 && x.R1.b1 === 'ok' && x.R1.a1s === 'permission-denied',
  'J2 employer A can neither open nor write to employer B\'s candidate conversation': !!x.R2 && x.R2.e2 === 'permission-denied' && !x.R2.created2 && x.R2.e2s === 'permission-denied',
  'J3 a seekerUid / participant list in the request is ignored — the applicant comes from the application doc': !!x.R3 && x.R3.ok && same(x.R3.parts, ['seekA', 'empA']),
  'J4 an employerUid in the request is ignored — the employer comes from the application doc': !!x.R4 && x.R4.ok && same(x.R4.parts, ['seekA', 'empA']),
  'J5 a conversation attached to a different application refuses a send, even with a forged participant list': !!x.R5 && x.R5.code === 'permission-denied',
  'J6 a third party cannot create a job-application conversation (nothing written)': !!x.R6 && x.R6.code === 'permission-denied' && x.R6.created === false,
  'J7 a terminal application (> 30 days) stays readable but takes no new messages; ≤ 30 days still allowed': !!x.W && x.W.old === 'failed-precondition' && x.W.recent === 'ok' && x.W.history,
  'J0 positive control: the applicant and the employer of that application can message': !!x.P && x.P.p1 === 'ok' && x.P.p2 === 'ok',
});
let pass = 0, fail = 0;
const ck = (id, ok, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + id + (ok ? '' : '   [got ' + JSON.stringify(got).slice(0, 300) + ']')); ok ? pass++ : fail++; };
console.log('\nJobs J4 — job-application conversations   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
let FN = path.join(ROOT, 'functions');
if (process.env.BASE) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-')); cp.execSync('git archive ' + process.env.BASE + ' functions | tar -x -C "' + d.split(path.sep).join('/') + '"', { cwd: ROOT, shell: 'bash' }); FN = path.join(d, 'functions'); }
const x = evaluate(FN);
if (x.crash) { console.log('CRASH (fail closed): ' + x.crash); process.exit(2); }
const R = rows(x);
for (const [k, v] of Object.entries(R)) ck(k, v, x);
if (Object.values(R).every(Boolean)) {
  console.log('\n  [mutations]');
  const MUT = [
    ['create party check removed', "  if (participantUids.indexOf(uid) === -1) {\n    throw new HttpsError('permission-denied', 'Not a party to this transaction');\n  }", '', ['J1', 'J2', 'J6']],
    ['participants taken from the request', '  const participantUids = _partiesOf(transactionType, txSnap.data());', '  const participantUids = Array.isArray(req.data.participantUids) ? req.data.participantUids : _partiesOf(transactionType, txSnap.data());', ['J3']],
    ['request fields merged over the application', '  const participantUids = _partiesOf(transactionType, txSnap.data());', '  const participantUids = _partiesOf(transactionType, Object.assign({}, txSnap.data(), req.data));', ['J4']],
    ['send-time re-derivation from the application removed', "      if (app.seekerUid !== req.auth.uid && app.employerUid !== req.auth.uid) {\n        throw new HttpsError('permission-denied', 'Not a party to this application');\n      }", '', ['J5']],
    ['30-day post-terminal window removed', "        if (!ms || Date.now() - ms > JOB_APP_REPLY_WINDOW_MS) {", '        if (false) {', ['J7']],
  ];
  for (const [name, a, b, rws] of MUT) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mjm-'));
    cp.execSync('cp -r "' + FN.split(path.sep).join('/') + '" "' + d.split(path.sep).join('/') + '/functions"', { shell: 'bash' });
    const f = path.join(d, 'functions', 'messages.js'); const s = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
    if (s.split(a).length !== 2) { console.log('  MISSED  ' + name + ' (anchor ' + (s.split(a).length - 1) + 'x — UNPROVEN)'); fail++; continue; }
    fs.writeFileSync(f, s.replace(a, () => b));
    const y = evaluate(path.join(d, 'functions'));
    const yr = y.crash ? {} : rows(y);
    rws.forEach((rid) => { const k = Object.keys(R).find((z) => z.startsWith(rid + ' ')); const red = !y.crash && yr[k] === false;
      console.log('  ' + (red ? 'CAUGHT' : 'MISSED') + '  ' + name + ' → ' + rid); if (!red) fail++; });
  }
} else console.log('\n  [mutations] skipped — the gate does not hold on this tree.');
console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
