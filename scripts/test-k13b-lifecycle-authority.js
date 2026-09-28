/* test-k13b-lifecycle-authority.js — K13-B: the applicationLifecycle TRIGGER projects only an authoritative decision.
 *
 * Drives the REAL applicationLifecycle trigger handler (functions/application-lifecycle.js → decisionAuthority →
 * applyDecision → projectProvider) with change events over an in-memory Firestore. No network, no production.
 *
 *   node scripts/test-k13b-lifecycle-authority.js                 # the K13-B fix — must PASS
 *   COUNTERPROOF=1 node scripts/test-k13b-lifecycle-authority.js  # the RECONSTRUCTED production source (055e509,
 *                                                                   byte-equal to archive c52e2338) — its FAILURES are
 *                                                                   the K13-B defects
 *
 * PROVES (the owner's K13-B acceptance boundary)
 *   C1  a legitimate decision (server record + admin decider) IS projected (positive control)
 *   C2  K13: status:'approved' + decidedBy:<a real admin uid>, NO server record → NOT projected, refusal recorded
 *   C3  the decider is the applicant (an admin deciding their own application), even WITH a record → NOT projected
 *   C4  a server record says rejected, the application was rewritten to approved → NOT projected
 *   C5  the application names a different admin than the server record → NOT projected
 *   C6  a non-admin decider → NOT projected (unchanged behaviour)
 *   C7  an already-applied legitimate legacy decision returns WITHOUT re-projection and without any write
 *   C8  a pending application → nothing happens
 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process'), Module = require('module');
const ROOT = path.resolve(__dirname, '..');
const COUNTERPROOF = !!process.env.COUNTERPROOF;
const RECON = '055e509';

const data = {}; const WRITES = []; let seq = 0;
function applyPatch(cur, patch) {
  const out = Object.assign({}, cur || {});
  for (const [k, v] of Object.entries(patch)) {
    if (v && v.__op === 'delete') delete out[k];
    else if (v && v.__op === 'union') out[k] = [...new Set([...(out[k] || []), ...v.vals])];
    else if (v && v.__op === 'remove') out[k] = (out[k] || []).filter((x) => !v.vals.includes(x));
    else out[k] = v;
  }
  return out;
}
const write = (p, patch, merge) => { WRITES.push(p); data[p] = merge ? applyPatch(data[p], patch) : applyPatch({}, patch); };
const snapOf = (p) => ({ exists: p in data, id: p.split('/').pop(), ref: ref(p), data: () => (p in data ? JSON.parse(JSON.stringify(data[p])) : undefined) });
function ref(p) { return { id: p.split('/').pop(), path: p, get: async () => snapOf(p), set: async (v, o) => write(p, v, o && o.merge), update: async (v) => write(p, v, true), collection: (c) => col(p + '/' + c) }; }
function col(c, filters = [], lim = null) {
  return {
    doc: (id) => ref(c + '/' + (id || ('auto' + (++seq)))),
    add: async (v) => { const r = ref(c + '/auto' + (++seq)); await r.set(v); return r; },
    where: (f, op, v) => col(c, filters.concat([[f, op, v]]), lim),
    limit: (n) => col(c, filters, n),
    get: async () => {
      let docs = Object.keys(data).filter((p) => p.startsWith(c + '/') && p.split('/').length === c.split('/').length + 1);
      for (const [f, op, v] of filters) docs = docs.filter((p) => (op === '==' ? data[p][f] === v : op === 'in' ? v.includes(data[p][f]) : false));
      if (lim != null) docs = docs.slice(0, lim);
      const s = docs.map(snapOf); return { empty: !s.length, size: s.length, docs: s };
    },
  };
}
const db = { collection: (c) => col(c), doc: ref, batch: () => { const ops = []; return { set: (r, v, o) => ops.push(() => r.set(v, o)), update: (r, v) => ops.push(() => r.update(v)), delete: (r) => ops.push(() => { delete data[r.path]; }), commit: async () => { for (const o of ops) await o(); } }; } };
const FieldValue = { serverTimestamp: () => 'TS', delete: () => ({ __op: 'delete' }), arrayUnion: (...vals) => ({ __op: 'union', vals }), arrayRemove: (...vals) => ({ __op: 'remove', vals }), increment: (n) => n };
const CLAIMS = { admin1: { admin: true }, admin2: { admin: true }, adminSelf: { admin: true }, plainUser: {} };
const auth = { getUser: async (u) => { if (!(u in CLAIMS) && !/^u_/.test(u)) { const e = new Error('no user'); throw e; } return { uid: u, customClaims: CLAIMS[u] || {} }; }, setCustomUserClaims: async (u, c) => { CLAIMS[u] = c; } };

let file = path.join(ROOT, 'functions', 'application-lifecycle.js');
if (COUNTERPROOF) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k13b-'));
  file = path.join(dir, 'application-lifecycle.js');
  fs.writeFileSync(file, cp.execFileSync('git', ['show', `${RECON}:functions/application-lifecycle.js`], { cwd: ROOT, encoding: 'utf8' }));
  for (const sib of ['role-vocabulary', 'role-authority']) {
    const p = path.join(ROOT, 'functions', sib + '.js');
    if (fs.existsSync(p)) fs.writeFileSync(path.join(dir, sib + '.js'), `module.exports = require(${JSON.stringify(p)});`);
  }
}
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue };
  if (id === 'firebase-admin/auth') return { getAuth: () => auth };
  if (id === 'firebase-admin') return { apps: [{}], initializeApp() {}, firestore: Object.assign(() => db, { FieldValue }), auth: () => auth };
  if (id === 'firebase-functions/logger') return { info() {}, warn() {}, error() {}, debug() {} };
  if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => h, HttpsError: class extends Error { constructor(c, m, d) { super(m); this.code = c; this.details = d; } } };
  if (id === 'firebase-functions/v2/firestore') return { onDocumentWritten: (_o, h) => h };
  if (id === './search-terms') return { buildSearchTerms: () => [] };
  if (id === './business-bootstrap') return { _ensureBusinessForOwner: async () => ({}) };
  if (id === './notify') return { notify: async () => ({}) };
  return orig.apply(this, arguments);
};
const L = require(file);
const IV = (L._internal && L._internal.INTAKE_VERSION) || 1;

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + JSON.stringify(d).slice(0, 150) + ']' : '')); ok ? pass++ : fail++; };
const put = (id, uid, extra) => { data['applications/' + id] = Object.assign({ uid, type: 'provider', role: 'provider', name: 'Applicant ' + uid, status: 'pending', phone: '0712000000', location: 'Nairobi', intakeVersion: IV }, extra || {}); };
const fire = async (id) => { try { await L.applicationLifecycle({ params: { appId: id }, data: { after: { exists: true, data: () => JSON.parse(JSON.stringify(data['applications/' + id])), ref: ref('applications/' + id) } } }); return null; } catch (e) { return e.message; } };
const projected = (uid) => (data['providers/' + uid] || {}).status === 'active';
const record = (id, status, decidedBy) => { data['applicationDecisions/' + id] = { applicationId: id, status, decidedBy, decidedAt: 'TS' }; };

(async () => {
  console.log('\nSOURCE: ' + (COUNTERPROOF ? `RECONSTRUCTED production (${RECON}) — failures below ARE the K13-B defects` : 'K13-B fix (working tree)'));
  put('c1', 'u_c1', { status: 'approved', decidedBy: 'admin1' }); record('c1', 'approved', 'admin1');
  const e1 = await fire('c1');
  ck('C1  a legitimate decision (server record + admin decider) IS projected', !e1 && projected('u_c1'), e1 || (data['providers/u_c1'] || {}).status);
  put('c2', 'u_c2', { status: 'approved', decidedBy: 'admin1' });
  await fire('c2');
  ck('C2  K13: approved + decidedBy:<real admin uid> with NO server record → NOT projected, refusal recorded',
    !projected('u_c2') && data['applications/c2'].projectionStatus === 'blocked_unauthorised_decision', data['applications/c2'].projectionStatus);
  put('c3', 'adminSelf', { status: 'approved', decidedBy: 'adminSelf' }); record('c3', 'approved', 'adminSelf');
  await fire('c3');
  ck('C3  an admin deciding their OWN application (even with a record) → NOT projected', !projected('adminSelf'));
  put('c4', 'u_c4', { status: 'approved', decidedBy: 'admin1' }); record('c4', 'rejected', 'admin1');
  await fire('c4');
  ck('C4  the record says rejected, the application was rewritten to approved → NOT projected', !projected('u_c4'));
  put('c5', 'u_c5', { status: 'approved', decidedBy: 'admin1' }); record('c5', 'approved', 'admin2');
  await fire('c5');
  ck('C5  the application names a different admin than the server record → NOT projected', !projected('u_c5'));
  put('c6', 'u_c6', { status: 'approved', decidedBy: 'plainUser' }); record('c6', 'approved', 'plainUser');
  await fire('c6');
  ck('C6  a non-admin decider → NOT projected (unchanged behaviour)', !projected('u_c6'));
  put('c7', 'u_c7', { status: 'approved', decidedBy: 'reindex', decisionAppliedFor: 'approved', projectionStatus: 'applied' });
  const w0 = WRITES.length; await fire('c7');
  ck('C7  an already-applied legacy decision returns WITHOUT re-projection and without any write', WRITES.length === w0 && !data['providers/u_c7'], WRITES.slice(w0));
  put('c8', 'u_c8', { status: 'pending' });
  const w8 = WRITES.length; await fire('c8');
  ck('C8  a pending application → nothing happens', WRITES.length === w8 && !data['providers/u_c8']);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (COUNTERPROOF) console.log('(counter-proof: failures here ARE the K13-B defects)');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
