/* Hermetic loader for functions/admin-os.js (2026-10-04).
 * Patches Module._load so admin-os.js gets an in-memory Firestore (scripts/lib/fake-firestore.js) and minimal
 * firebase-functions / firebase-admin stand-ins. Works under NODE_OPTIONS=--require=block-admin.js (which makes the
 * real admin SDK unloadable): this patch is installed on top and intercepts first. Nothing here can reach a network.
 *   const H = loadAdminOs({ modulePath? });  H.setDb(fakeDb(...));  await H.aos._h.adminOrdersSummary(req)
 */
'use strict';
const Module = require('module');
const path = require('path');
const { FAKE_FIELD_VALUE, FAKE_AGGREGATE_FIELD, FAKE_FIELD_PATH } = require('./fake-firestore');

class HttpsError extends Error {
  constructor(code, message, details) { super(message); this.code = code; this.details = details; this.httpErrorCode = { status: 0 }; }
}

function loadAdminOs(opts) {
  const o = opts || {};
  const modulePath = o.modulePath || path.join(__dirname, '..', '..', 'functions', 'admin-os.js');
  let DB = null;
  const firestoreStub = {
    getFirestore: () => { if (!DB) throw new Error('harness: no fake DB set'); return DB; },
    FieldValue: FAKE_FIELD_VALUE,
    AggregateField: FAKE_AGGREGATE_FIELD,
    FieldPath: FAKE_FIELD_PATH,
    Timestamp: { fromDate: (d) => ({ __ts: d.getTime() }), fromMillis: (ms) => ({ __ts: ms }), now: () => ({ __ts: Date.now() }) },
  };
  const stubs = {
    'firebase-functions/v2/https': { onCall: (_opts, fn) => fn, HttpsError },
    'firebase-admin/firestore': firestoreStub,
    'firebase-admin/auth': { getAuth: () => ({ getUser: async () => ({}) }) },
    'firebase-admin': { apps: [1], initializeApp() {}, firestore: Object.assign(() => DB, { FieldValue: FAKE_FIELD_VALUE }), auth: () => ({ getUser: async () => ({}) }) },
  };
  const prev = Module._load;
  Module._load = function (req, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(stubs, req)) return stubs[req];
    return prev.apply(this, arguments);
  };
  delete require.cache[require.resolve(modulePath)];
  const aos = require(modulePath);
  return { aos, HttpsError, setDb: (db) => { DB = db; }, getDb: () => DB };
}
module.exports = { loadAdminOs, HttpsError };
