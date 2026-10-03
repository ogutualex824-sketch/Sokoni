#!/usr/bin/env node
/* SECURITY SCORECARD HONESTY — functions/security-audit.js _computeScorecard + getComplianceReport, shared/mfa-enrollment.js,
 * executed in-process on an in-memory Firestore (firebase modules stubbed here; no emulator, no network).
 * Proves: MFA adoption is measured with the ONE enrolment predicate over the SAME population (privileged users' own
 * securityMFA docs; enrolment writes pending:false, never `enrolled`); static self-assessments are basis:'declared' and
 * never counted in totalScore; a failed check is 'unreadable' with score null (it used to ASSUME 5–7/10); no device-trust
 * data is 'no_data' (it used to assume 80%); totalScore is measured-only; the compliance report grades only measured
 * dimensions (declared / unverified are gaps, never pass) and is null — not 0 — when nothing is measurable.
 *   node scripts/test-security-scorecard.js            SABOTAGE=1 → every mutation must turn its named row FAIL */
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), cp = require('child_process'), Module = require('module');
const ROOT = path.join(__dirname, '..');

if (process.env.SABOTAGE) {
  const M = [
    ['S1', 'security-audit.js', "      const enrolledMFA = mfaDocs.filter((s) => s.exists && MFA.isEnrolled(s.data())).length;", "      const enrolledMFA = mfaDocs.filter((s) => s.exists && s.data().enrolled === true).length;"],
    ['S2', 'security-audit.js', "  const measured   = dimensions.filter((d) => d.basis === 'measured' && d.score != null);", "  const measured   = dimensions.filter((d) => d.score != null);"],
    ['S3', 'security-audit.js', "  const unreadable = (name, maxScore, what) => dim(name, null, maxScore, 'Could not ' + what + ' — not scored.', 'unreadable');", "  const unreadable = (name, maxScore, what) => dim(name, 5, maxScore, 'Could not ' + what + ' — assumed.', 'measured');"],
    ['S4', 'security-audit.js', "    if (rated.length === 0) {", "    if (false) {"],
    ['S5', 'security-audit.js', "      if (d.basis === 'declared') return 'declared';", ""],
    ['S7', 'security-audit.js', "  const fromClaim = t.superAdmin === true ? ROLE.super_admin : t.admin === true ? ROLE.admin : 0;", "  const fromClaim = 0;"],
    ['S6', 'shared/mfa-enrollment.js', "  return !!data && typeof data === 'object' && data.pending !== true;", "  return !!data && typeof data === 'object';"],
  ];
  let caught = 0;
  for (const [row, file, a, b] of M) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ssc-')); const FN = path.join(d, 'functions'); fs.mkdirSync(path.join(FN, 'shared'), { recursive: true });
    for (const f of fs.readdirSync(path.join(ROOT, 'functions'))) { const p = path.join(ROOT, 'functions', f); if (f !== 'node_modules' && fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(FN, f)); }
    for (const f of fs.readdirSync(path.join(ROOT, 'functions', 'shared'))) { const p = path.join(ROOT, 'functions', 'shared', f); if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(FN, 'shared', f)); }
    const t = path.join(FN, file), s = fs.readFileSync(t, 'utf8').replace(/\r\n/g, '\n');
    if (s.split(a).length !== 2) { console.log('  BROKEN ' + row); fs.rmSync(d, { recursive: true, force: true }); continue; }
    fs.writeFileSync(t, s.replace(a, () => b));
    let out = ''; try { out = cp.execFileSync(process.execPath, [__filename], { env: Object.assign({}, process.env, { SABOTAGE: '', FN_DIR: FN }), encoding: 'utf8' }); } catch (e) { out = String(e.stdout || ''); }
    const hit = new RegExp('FAIL ' + row + ' ').test(out); console.log('  ' + (hit ? 'CAUGHT' : 'MISSED') + ' ' + row); if (hit) caught++;
    fs.rmSync(d, { recursive: true, force: true });
  }
  console.log('\nSABOTAGE: ' + caught + '/' + M.length + ' caught'); process.exit(caught === M.length ? 0 : 1);
}

/* ── minimal in-memory Firestore (equality / 'in' filters; a collection can be told to THROW) ── */
const DOCS = new Map(); const THROW = new Set();
const snap = (k) => ({ id: k.split('/').pop(), exists: DOCS.has(k), data: () => DOCS.get(k) });
const docRef = (k) => ({ id: k.split('/').pop(), path: k, get: async () => snap(k), set: async (v) => DOCS.set(k, v) });
function coll(c, filters, lim) {
  return {
    doc: (id) => docRef(c + '/' + id),
    add: async (v) => { const k = c + '/auto' + DOCS.size; DOCS.set(k, v); return docRef(k); },
    where: (f, op, v) => coll(c, filters.concat([[f, op, v]]), lim),
    orderBy: () => coll(c, filters, lim), limit: (n) => coll(c, filters, n),
    count: () => ({ get: async () => ({ data: () => ({ count: 0 }) }) }),
    get: async () => {
      if (THROW.has(c)) throw new Error('PERMISSION_DENIED ' + c);
      const docs = [...DOCS.keys()].filter((k) => k.startsWith(c + '/') && k.split('/').length === c.split('/').length + 1)
        .filter((k) => filters.every(([f, op, v]) => { const x = (DOCS.get(k) || {})[f]; return op === 'in' ? v.includes(x) : op === '==' ? x === v : true; }))
        .slice(0, lim || 1e9).map(snap);
      return { docs, empty: !docs.length, size: docs.length };
    },
  };
}
const db = { collection: (c) => coll(c, [], 0), getAll: (...refs) => Promise.all(refs.map((r) => r.get())), batch: () => ({ set() {}, commit: async () => {} }) };
const FieldValue = { serverTimestamp: () => 'TS', increment: (n) => n, arrayUnion: (...a) => a, delete: () => null };
const fsNs = Object.assign(() => db, { FieldValue, Timestamp: { now: () => Date.now(), fromMillis: (m) => m, fromDate: (d) => +d } });
class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const origLoad = Module._load;
Module._load = function (req) {
  if (req === 'firebase-admin') return { firestore: fsNs, apps: [{}], initializeApp: () => ({}), auth: () => ({}) };
  if (req === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue, Timestamp: fsNs.Timestamp };
  if (req === 'firebase-functions/v2/https') return { onCall: (o, h) => (typeof o === 'function' ? o : h), HttpsError };
  if (req === 'firebase-functions/v2/scheduler') return { onSchedule: (o, h) => (typeof o === 'function' ? o : h) };
  if (req === 'firebase-functions/logger') return { info() {}, warn() {}, error() {}, debug() {} };
  if (req === 'firebase-functions/params') return { defineSecret: () => ({ value: () => '' }), defineString: () => ({ value: () => '' }) };
  return origLoad.apply(this, arguments);
};

const FN = process.env.FN_DIR || path.join(ROOT, 'functions');
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 360) + ']')); ok ? pass++ : fail++; };
console.log('\nSecurity scorecard — measured, declared, unreadable, no data\n');

(async () => {
  let SA;
  try { SA = require(path.join(FN, 'security-audit.js')); } catch (e) { ck('S0', false, 'security-audit.js loads', e.message); return done(); }
  const seed = () => {
    DOCS.clear(); THROW.clear();
    ['a1', 'a2', 'a3'].forEach((u, i) => DOCS.set('users/' + u, { role: i === 0 ? 'super_admin' : 'admin' }));
    DOCS.set('users/shopper', { role: 'buyer' });
    DOCS.set('securityMFA/a1', { pending: false, method: 'totp', uid: 'a1' });      /* enrolled (the write confirmTOTPEnrollment makes) */
    DOCS.set('securityMFA/a2', { pending: false, method: 'totp', uid: 'a2' });      /* enrolled */
    DOCS.set('securityMFA/a3', { pending: true, uid: 'a3' });                        /* started, not confirmed */
    DOCS.set('securityMFA/shopper', { pending: false, method: 'totp' });             /* enrolled, but NOT privileged */
  };
  const dimOf = (sc, n) => sc.dimensions.find((d) => d.name === n) || {};

  /* S1 MFA: one predicate, one population */
  seed();
  let sc = await SA._computeScorecard();
  const m = dimOf(sc, 'MFA Adoption');
  ck('S1', m.basis === 'measured' && m.score === 7 && sc.mfa && sc.mfa.enrolled === 2 && sc.mfa.privileged === 3 && sc.privileged.total === 3 && sc.privileged.byRole.admin === 2 && sc.privileged.byRole.super_admin === 1,
    'MFA adoption = privileged users whose OWN securityMFA doc is confirmed (pending:false): 2/3 — a pending enrolment and a non-privileged enrolment do not count', { m, mfa: sc.mfa });

  /* S2 declared dimensions are reported but never scored; totalScore = measured only */
  const declared = sc.dimensions.filter((d) => d.basis === 'declared').map((d) => d.name).sort();
  const meas = sc.dimensions.filter((d) => d.basis === 'measured' && d.score != null);
  const expect = Math.round(meas.reduce((t, d) => t + d.score, 0) / meas.reduce((t, d) => t + d.maxScore, 0) * 100);
  ck('S2', declared.join() === ['App Check Coverage', 'CORS / Security Headers', 'Data Encryption', 'Firestore Security Rules', 'Rate Limiting', 'Secret Manager'].sort().join()
    && sc.scoreBasis === 'measured_only' && sc.totalScore === expect && sc.coverage.declared === 6 && sc.coverage.total === sc.dimensions.length
    && sc.coverage.measured + sc.coverage.declared + sc.coverage.unreadable + sc.coverage.noData === sc.coverage.total,
    'the 6 static self-assessments are basis:declared and excluded; totalScore is computed over measured dimensions only; coverage adds up', { declared, totalScore: sc.totalScore, expect, coverage: sc.coverage });

  /* S3 a failed check is unreadable (null), never an assumed 5/10 */
  seed(); THROW.add('securityAlerts'); THROW.add('posAuditLog');
  sc = await SA._computeScorecard();
  const al = dimOf(sc, 'Open Security Alerts'), py = dimOf(sc, 'Payment Security');
  ck('S3', al.basis === 'unreadable' && al.score === null && py.basis === 'unreadable' && py.score === null && /not scored/.test(al.notes) && sc.coverage.unreadable >= 2,
    'a check whose query fails is basis:unreadable with score null (previously assumed 5/10 and 7/10) and is not in the total', { al, py });

  /* S4 device trust: no rated events → no_data (never an assumed 80%); rated events are measured */
  seed();
  sc = await SA._computeScorecard();
  const dt0 = dimOf(sc, 'Device Trust');
  DOCS.set('securityEvents/e1', { deviceTrusted: true, createdAt: 1 }); DOCS.set('securityEvents/e2', { deviceTrusted: false, createdAt: 2 }); DOCS.set('securityEvents/e3', { type: 'login', createdAt: 3 });
  sc = await SA._computeScorecard();
  const dt1 = dimOf(sc, 'Device Trust');
  ck('S4', dt0.basis === 'no_data' && dt0.score === null && dt1.basis === 'measured' && dt1.metrics.trusted === 1 && dt1.metrics.untrusted === 1 && dt1.metrics.unrated === 1 && dt1.score === 4,
    'no event records device trust → no_data, null (previously an assumed 80%); with events, only RATED ones count (1 trusted / 1 untrusted / 1 unrated)', { dt0, dt1 });

  /* S5 compliance report: only measured dimensions grade; declared / unverified are gaps, never pass */
  seed();
  const rep = await SA.getComplianceReport({ auth: { uid: 'a1', token: { role: 'super_admin' } }, data: { standard: 'general' } }).catch((e) => ({ err: e.message }));
  const byName = (n) => (rep.controls || []).find((c) => c.controlName === n) || {};
  ck('S5', !rep.err && byName('App Check Coverage').status === 'declared' && byName('Firestore Security Rules').status === 'declared' && byName('MFA Adoption').status === 'partial'
    && (rep.gaps || []).some((g) => /^DECLARED: .*App Check Coverage/.test(g)) && (rep.gaps || []).some((g) => /^UNVERIFIED: /.test(g))
    && typeof rep.complianceScore === 'number',
    'compliance controls grade only measured dimensions: static ones are "declared" (a gap, not a pass); unmeasured ones are "unverified"', rep.err || { controls: (rep.controls || []).map((c) => c.controlName + ':' + c.status), gaps: rep.gaps });

  /* S7 authority = the server-set boolean claims AdminOS mints ({admin:true} / {superAdmin:true}); no claim → refused */
  seed();
  const asAdmin = await SA.getSecurityScorecard({ auth: { uid: 'a2', token: { admin: true } }, data: {} }).catch((e) => ({ err: e.code }));
  const asNobody = await SA.getSecurityScorecard({ auth: { uid: 'shopper', token: {} }, data: {} }).catch((e) => ({ err: e.code }));
  const compAdmin = await SA.getComplianceReport({ auth: { uid: 'a2', token: { admin: true } }, data: {} }).catch((e) => ({ err: e.code }));
  const compSuper = await SA.getComplianceReport({ auth: { uid: 'a1', token: { superAdmin: true } }, data: {} }).catch((e) => ({ err: e.code }));
  ck('S7', Array.isArray(asAdmin.dimensions) && asNobody.err === 'permission-denied' && compAdmin.err === 'permission-denied' && Array.isArray(compSuper.controls),
    'an AdminOS admin ({admin:true}) gets the full scorecard; the super-admin-only compliance report needs {superAdmin:true}; no claim is refused', { admin: !!asAdmin.dimensions, nobody: asNobody.err, compAdmin: compAdmin.err, compSuper: !!compSuper.controls });

  /* S6 the ONE enrolment predicate + getMFAStatus uses it */
  const MFA = require(path.join(FN, 'shared', 'mfa-enrollment.js'));
  const SI = fs.readFileSync(path.join(FN, 'security-identity.js'), 'utf8'), PT = fs.readFileSync(path.join(FN, 'security-pentest.js'), 'utf8');
  ck('S6', MFA.isEnrolled({ pending: false, method: 'totp' }) === true && MFA.isEnrolled({ pending: true }) === false && MFA.isEnrolled(null) === false
    && /require\('\.\/shared\/mfa-enrollment'\)\.isEnrolled\(d\)/.test(SI) && /where\(MFA\.ENROLLED_FIELD, '==', MFA\.ENROLLED_VALUE\)/.test(PT) && !/where\('enrolled', '==', true\)/.test(PT + fs.readFileSync(path.join(FN, 'security-audit.js'), 'utf8')),
    'one enrolment predicate (exists && pending!==true) used by getMFAStatus, the scorecard and the pen-test row; nothing queries the never-written `enrolled` field');
  done();
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
function done() { console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0); }
