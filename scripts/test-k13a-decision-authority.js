/* test-k13a-decision-authority.js — K13-A: applicationDecide + applicationReconcile decision authority.
 *
 * Runs the REAL functions/application-lifecycle.js (applicationDecide, applicationReconcile, and through them the REAL
 * applyDecision → projectProvider) over an in-memory Firestore with the SDK stubbed. No network, no production.
 *
 *   node scripts/test-k13a-decision-authority.js                 # the K13-A fix — must PASS
 *   COUNTERPROOF=1 node scripts/test-k13a-decision-authority.js  # the DEPLOYED-identical source (ccf06e3, byte-equal to
 *                                                                  production archive b996425e) — its FAILURES are the
 *                                                                  K13-A defects
 *
 * PROVES (the owner's K13-A acceptance boundary)
 *   A1  a legitimate AdminOS decision still works — the provider is projected active (positive control)
 *   A2  the server decision record is written BEFORE the application is mutated
 *   A3  an administrator cannot decide their OWN application (separation of duties) — nothing written, nothing projected
 *   B1  K13b: applicant writes status:'approved' → admin runs reconcile {all:true} → NOT projected, refused
 *   B2  applicant writes status:'approved' + decidedBy:<a real admin uid> → reconcile → NOT projected
 *   B3  a legitimate decision whose projection was lost is re-projected by reconcile, attributed to the real decider
 *   B4  a legacy decision backed by an adminAudit approve row (no decision record) IS reconcilable
 *   B5  an operator-label approval (decidedBy:"reindex", no record, no audit) stays NON-reconcilable
 *   B6  a legacy SELF-decided approval (audit performedBy == applicant) is NOT reconcilable
 *   B7  a decision record says rejected, the applicant rewrote status to approved → NOT reconcilable
 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process'), Module = require('module');
const ROOT = path.resolve(__dirname, '..');
const COUNTERPROOF = !!process.env.COUNTERPROOF;
const BASE = 'ccf06e3';

/* ── in-memory Firestore: get/set(merge)/update/add, where(==|in).limit().get(), batch, arrayUnion/Remove, write log ── */
const data = {}; const WRITES = []; let seq = 0;
const isDel = (v) => v && v.__op === 'delete';
function applyPatch(cur, patch) {
  const out = Object.assign({}, cur || {});
  for (const [k, v] of Object.entries(patch)) {
    if (isDel(v)) delete out[k];
    else if (v && v.__op === 'union') out[k] = [...new Set([...(out[k] || []), ...v.vals])];
    else if (v && v.__op === 'remove') out[k] = (out[k] || []).filter((x) => !v.vals.includes(x));
    else out[k] = v;
  }
  return out;
}
const write = (p, patch, merge) => { WRITES.push(p); data[p] = merge ? applyPatch(data[p], patch) : applyPatch({}, patch); };
const snapOf = (p) => ({ exists: p in data, id: p.split('/').pop(), ref: ref(p), data: () => (p in data ? JSON.parse(JSON.stringify(data[p])) : undefined) });
function ref(p) {
  return { id: p.split('/').pop(), path: p, get: async () => snapOf(p), set: async (v, o) => write(p, v, o && o.merge),
    update: async (v) => { if (!(p in data)) throw new Error('NOT_FOUND ' + p); write(p, v, true); }, collection: (c) => col(p + '/' + c) };
}
function col(c, filters = [], lim = null) {
  const q = {
    doc: (id) => ref(c + '/' + (id || ('auto' + (++seq)))),
    add: async (v) => { const r = ref(c + '/auto' + (++seq)); await r.set(v); return r; },
    where: (f, op, v) => col(c, filters.concat([[f, op, v]]), lim),
    limit: (n) => col(c, filters, n),
    get: async () => {
      let docs = Object.keys(data).filter((p) => p.startsWith(c + '/') && p.split('/').length === c.split('/').length + 1);
      for (const [f, op, v] of filters) docs = docs.filter((p) => { const x = data[p][f]; return op === '==' ? x === v : op === 'in' ? v.includes(x) : false; });
      if (lim != null) docs = docs.slice(0, lim);
      const snaps = docs.map(snapOf);
      return { empty: !snaps.length, size: snaps.length, docs: snaps };
    },
  };
  return q;
}
const db = { collection: (c) => col(c), doc: ref, batch: () => { const ops = []; return { set: (r, v, o) => ops.push(() => r.set(v, o)), update: (r, v) => ops.push(() => r.update(v)), delete: (r) => ops.push(() => { delete data[r.path]; }), commit: async () => { for (const o of ops) await o(); } }; } };
const FieldValue = { serverTimestamp: () => 'TS', delete: () => ({ __op: 'delete' }), arrayUnion: (...vals) => ({ __op: 'union', vals }), arrayRemove: (...vals) => ({ __op: 'remove', vals }), increment: (n) => n };
const CLAIMS = { admin1: { admin: true }, admin2: { admin: true }, adminSelf: { admin: true } };
const auth = { getUser: async (u) => { if (!(u in CLAIMS) && !/^u_/.test(u)) { const e = new Error('no user'); e.code = 'auth/user-not-found'; throw e; } return { uid: u, customClaims: CLAIMS[u] || {} }; },
  setCustomUserClaims: async (u, c) => { CLAIMS[u] = c; } };

let file = path.join(ROOT, 'functions', 'application-lifecycle.js');
if (COUNTERPROOF) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k13a-'));
  file = path.join(dir, 'application-lifecycle.js');
  fs.writeFileSync(file, cp.execFileSync('git', ['show', `${BASE}:functions/application-lifecycle.js`], { cwd: ROOT, encoding: 'utf8' }));
  fs.writeFileSync(path.join(dir, 'role-vocabulary.js'), `module.exports = require(${JSON.stringify(path.join(ROOT, 'functions', 'role-vocabulary.js'))});`);
}
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue };
  if (id === 'firebase-admin/auth') return { getAuth: () => auth };
  if (id === 'firebase-functions/logger') return { info() {}, warn() {}, error() {}, debug() {} };
  if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => h, HttpsError: class extends Error { constructor(c, m, d) { super(m); this.code = c; this.details = d; } } };
  if (id === 'firebase-functions/v2/firestore') return { onDocumentWritten: (_o, h) => h };
  if (id === './search-terms') return { buildSearchTerms: () => [] };
  if (id === './business-bootstrap') return { _ensureBusinessForOwner: async () => ({}) };
  if (id === './notify') return { notify: async () => ({}) };
  return orig.apply(this, arguments);
};
const L = require(file);

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + JSON.stringify(d).slice(0, 160) + ']' : '')); ok ? pass++ : fail++; };
const asAdmin = (uid, d) => ({ auth: { uid, token: { admin: true } }, data: d, rawRequest: { headers: {} } });
const code = async (p) => { try { return { r: await p }; } catch (e) { return { err: (e.details && e.details.code) || e.code || e.message }; } };
const app = (id, uid, extra) => { data['applications/' + id] = Object.assign({ uid, type: 'provider', role: 'provider', name: 'Applicant ' + uid, status: 'pending', phone: '0712000000', location: 'Nairobi', intakeVersion: 999 }, extra || {}); };
const projected = (uid) => (data['providers/' + uid] || {}).status === 'active';

(async () => {
  console.log('\nSOURCE: ' + (COUNTERPROOF ? `DEPLOYED-identical (${BASE}) — failures below ARE the K13-A defects` : 'K13-A fix (working tree)'));
  /* INTAKE_VERSION: let the real module stamp it so buildIntakePatch is a no-op */
  const IV = (L._internal && L._internal.INTAKE_VERSION) || 1;
  const mk = (id, uid, extra) => app(id, uid, Object.assign({ intakeVersion: IV }, extra || {}));

  console.log('\nA. applicationDecide');
  mk('a1', 'u_a1');
  const w0 = WRITES.length;
  const r1 = await code(L.applicationDecide(asAdmin('admin1', { applicationId: 'a1', decision: 'approve' })));
  const w = WRITES.slice(w0);
  ck('A1  a legitimate AdminOS decision still works — the provider is projected active', !r1.err && projected('u_a1'), r1.err || (data['providers/u_a1'] || {}).status);
  const iRec = w.indexOf('applicationDecisions/a1'), iApp = w.indexOf('applications/a1');
  ck('A2  the server decision record is written BEFORE the application is mutated', iRec !== -1 && iApp !== -1 && iRec < iApp, { iRec, iApp });
  mk('a3', 'adminSelf');
  const r3 = await code(L.applicationDecide(asAdmin('adminSelf', { applicationId: 'a3', decision: 'approve' })));
  ck('A3  an administrator cannot decide their OWN application — refused, nothing written, nothing projected',
    r3.err === 'SELF_DECISION' && data['applications/a3'].status === 'pending' && !data['applicationDecisions/a3'] && !projected('adminSelf'), r3.err || 'NOT REFUSED');

  console.log('\nB. applicationReconcile');
  mk('b1', 'u_b1', { status: 'approved' });                                        /* applicant-written */
  const rb1 = await code(L.applicationReconcile(asAdmin('admin1', { all: true })));
  ck('B1  K13b: applicant writes approved → admin runs reconcile {all:true} → NOT projected', !projected('u_b1'),
    rb1.err || ((rb1.r && rb1.r.results) || []).filter((x) => x.appId === 'b1' || x.applicationId === 'b1'));
  mk('b2', 'u_b2', { status: 'approved', decidedBy: 'admin2' });                  /* K13 shape: a real admin uid */
  await code(L.applicationReconcile(asAdmin('admin1', { applicationId: 'b2' })));
  ck('B2  applicant writes approved + decidedBy:<real admin uid> → reconcile → NOT projected', !projected('u_b2'));
  mk('b3', 'u_b3');
  await code(L.applicationDecide(asAdmin('admin2', { applicationId: 'b3', decision: 'approve' })));
  delete data['providers/u_b3'];                                                   /* the projection is lost */
  const rb3 = await code(L.applicationReconcile(asAdmin('admin1', { applicationId: 'b3' })));
  ck('B3  a legitimate decision whose projection was lost IS re-projected by reconcile', !rb3.err && projected('u_b3'), rb3.err);
  mk('b4', 'u_b4', { status: 'approved', decidedBy: 'admin2' });
  await db.collection('adminAudit').add({ action: 'application_approve', applicationId: 'b4', targetUid: 'u_b4', performedBy: 'admin2' });
  await code(L.applicationReconcile(asAdmin('admin1', { applicationId: 'b4' })));
  ck('B4  a legacy decision backed by an adminAudit approve row (no decision record) IS reconcilable', projected('u_b4'));
  mk('b5', 'u_b5', { status: 'approved', decidedBy: 'reindex' });
  await code(L.applicationReconcile(asAdmin('admin1', { applicationId: 'b5' })));
  ck('B5  an operator-label approval (decidedBy:"reindex", no record, no audit) stays NON-reconcilable', !projected('u_b5'));
  mk('b6', 'u_b6', { status: 'approved', decidedBy: 'u_b6' });
  CLAIMS.u_b6 = { admin: true };                                                   /* the applicant IS an admin */
  await db.collection('adminAudit').add({ action: 'application_approve', applicationId: 'b6', targetUid: 'u_b6', performedBy: 'u_b6' });
  await code(L.applicationReconcile(asAdmin('admin1', { applicationId: 'b6' })));
  ck('B6  a legacy SELF-decided approval (audit performedBy == applicant) is NOT reconcilable', !projected('u_b6'));
  mk('b7', 'u_b7');
  await code(L.applicationDecide(asAdmin('admin2', { applicationId: 'b7', decision: 'reject' })));
  data['applications/b7'].status = 'approved';                                     /* the applicant rewrites it */
  await code(L.applicationReconcile(asAdmin('admin1', { applicationId: 'b7' })));
  ck('B7  record says rejected, applicant rewrote status to approved → NOT reconcilable', !projected('u_b7'));
  /* B8 — evidence EXISTS but names an operator label, not an administrator account. */
  mk('b8', 'u_b8', { status: 'approved', decidedBy: 'founder-decision-2026-08-01' });
  await db.collection('adminAudit').add({ action: 'application_approve', applicationId: 'b8', targetUid: 'u_b8', performedBy: 'founder-decision-2026-08-01' });
  await code(L.applicationReconcile(asAdmin('admin1', { applicationId: 'b8' })));
  ck('B8  an audit row whose performer is an OPERATOR LABEL (not an admin account) does not make it reconcilable', !projected('u_b8'));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (COUNTERPROOF) console.log('(counter-proof: failures here ARE the K13-A defects)');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
