/* approval-fixture.js — fixtures that satisfy the approval AUTHORITY, not just the projection (FIXTURE != CONTRACT).
 *
 * Since the shell gate (business-workspace.js → shared/approval-remediation.js) an approved provider/seller is one whose
 * application was approved by a RESOLVABLE admin account that is not the applicant. A fixture with `approvedAt` alone is
 * INVALID_LEGACY_APPROVAL — exactly what the gate must refuse. Suites therefore seed the decision too:
 *
 *   const AF = require('./lib/approval-fixture');
 *   AF.stubAdminAuth(stub);                          // firebase-admin/auth: admin_* uids resolve with the admin claim
 *   await AF.seedApproved(db, uid, 'provider');      // applications/<uid>-app approved by admin_1
 */
'use strict';
const ADMIN_RE = /^admin/;
function stubAdminAuth(stub, extra) {
  const users = Object.assign({}, extra || {});
  stub('firebase-admin/auth', { getAuth: () => ({
    getUser: async (uid) => { if (users[uid]) return { uid, customClaims: users[uid] }; if (ADMIN_RE.test(uid)) return { uid, customClaims: { admin: true } }; return { uid, customClaims: {} }; },
    setCustomUserClaims: async () => { throw new Error('direct claim write in a fixture'); },
  }) });
}
async function seedApproved(db, uid, role, extra) {
  const id = String(uid) + '-app';
  await db.doc('applications/' + id).set(Object.assign({ applicationId: id, uid: String(uid), role: role || 'provider', status: 'approved', statusCanonical: 'approved', decidedBy: 'admin_1', decidedAt: '2026-09-01T09:00:00.000Z', decisionAppliedFor: 'approved', projectionStatus: 'applied', agreementAccepted: true, agreementVersion: '2026-09-07-lanes-mkt-ladder-pos-5pct' }, extra || {}));
  return id;
}
/* Patches the fake store so that any providers/{uid} or sellers/{uid} write carrying `approvedAt` also seeds the admin
   decision that produced it (applications/{uid}-app, approved by admin_1). Mirrors the producer: approvedAt is written by
   projectProvider/projectSeller ONLY as the projection of a decided application. Suites that seed by hand keep their
   shape; the authority sees the decision it would see in production. Idempotent; never touches other paths. */
function autoApproveOnWrite(db) {
  if (db.__approvalFixture) return;
  db.__approvalFixture = true;
  const origDoc = db.doc.bind(db), origColl = db.collection.bind(db);
  const seedFor = async (path, data) => {
    const m = /^(providers|sellers)\/([^/]+)$/.exec(path || '');
    if (!m || !data || data.approvedAt === undefined || data.approvedAt === null) return;
    const uid = m[2]; const role = m[1] === 'providers' ? 'provider' : 'seller';
    const ref = origDoc('applications/' + uid + '-app');
    if (!(await ref.get()).exists) await ref.set({ applicationId: uid + '-app', uid, role, status: 'approved', statusCanonical: 'approved', decidedBy: 'admin_1', decidedAt: '2026-09-01T09:00:00.000Z', decisionAppliedFor: 'approved', projectionStatus: 'applied', agreementAccepted: true, agreementVersion: '2026-09-07-lanes-mkt-ladder-pos-5pct' });
  };
  const wrapRef = (ref) => {
    if (!ref || ref.__wrapped) return ref;
    const set = ref.set; ref.set = async function (data, opts) { const r = await set.call(ref, data, opts); await seedFor(ref.path, data); return r; };
    ref.__wrapped = true; return ref;
  };
  db.doc = (p) => wrapRef(origDoc(p));
  db.collection = (c) => { const col = origColl(c); const d = col.doc; col.doc = (id) => wrapRef(d.call(col, id)); return col; };
}
module.exports = { stubAdminAuth, seedApproved, autoApproveOnWrite };
