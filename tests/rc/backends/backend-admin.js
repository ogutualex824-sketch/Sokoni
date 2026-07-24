/* ============================================================================
   ADMIN BACKEND — firebase-admin against a real project OR the emulator suite.

   ONE adapter serves both authenticated paths, because the Admin SDK talks to
   the emulator or to production identically — only env vars differ:
     • Production/staging : Application Default Credentials (gcloud ADC) or a
                            service-account key in GOOGLE_APPLICATION_CREDENTIALS.
     • Emulator           : FIREBASE_AUTH_EMULATOR_HOST + FIRESTORE_EMULATOR_HOST
                            set, which makes the SDK skip real credentials.
   The runner decides which by setting env before constructing this.

   Privileged claims (manager/admin) are refused unless allowPrivileged is true,
   regardless of backend — a guard that matters most on production.
   ========================================================================== */

'use strict';

const path = require('path');
const { BackendInterface, BlockedError } = require('./backend-interface');

const ADMIN_PATH = path.join(__dirname, '..', '..', '..', 'functions', 'node_modules', 'firebase-admin');

class AdminBackend extends BackendInterface {
  constructor(opts = {}) {
    super(opts);
    this.name = opts.emulator ? 'emulator(admin)' : 'production(admin)';
    this.projectId = opts.projectId || 'sokoni-aeb26';
    this.allowPrivileged = !!opts.allowPrivileged;
    this._base = opts.baseUrl || (opts.emulator ? 'http://127.0.0.1:5000' : 'https://mysokoni.co.ke');
    this._uidByEmail = {};
  }

  async init() {
    // Fail fast with a precise, actionable reason rather than a deep SDK stack.
    let admin;
    try { admin = require(ADMIN_PATH); }
    catch { throw new BlockedError('firebase-admin not found under functions/node_modules'); }
    this.admin = admin;
    try {
      admin.initializeApp({ projectId: this.projectId });
      // Cheap round-trip that forces a token fetch, so credential problems
      // surface here (as BLOCKED) instead of mid-suite.
      await admin.auth().listUsers(1);
    } catch (e) {
      const m = String(e.message || e);
      if (/invalid_client|invalid_grant|could not load the default cred|failed to fetch/i.test(m)) {
        throw new BlockedError(
          'Admin credentials unavailable. For production run: `gcloud auth ' +
          'application-default login` (current ADC returns invalid_client). ' +
          'For emulator run: start the suite with FIRESTORE_EMULATOR_HOST set.');
      }
      throw new BlockedError('Admin init failed: ' + m.slice(0, 160));
    }
    this.db = admin.firestore();
    this.auth = admin.auth();
  }

  supports() { return { auth: true, firestore: true, functions: !!this.opts.functions, ui: true }; }
  baseUrl()  { return this._base; }

  async ensureUser(identity) {
    if (identity.privileged && !this.allowPrivileged) {
      throw new BlockedError(
        `Refusing to set privileged claims for ${identity.email} without ` +
        `--allow-privileged (would create a ${JSON.stringify(identity.claims)} ` +
        `account on ${this.projectId}).`);
    }
    let user;
    try { user = await this.auth.getUserByEmail(identity.email); }
    catch {
      user = await this.auth.createUser({
        email: identity.email, password: identity.password,
        displayName: identity.displayName, emailVerified: true,
      });
    }
    if (identity.claims && Object.keys(identity.claims).length) {
      await this.auth.setCustomUserClaims(user.uid, identity.claims);
    }
    this._uidByEmail[identity.email] = user.uid;
    return user.uid;
  }

  /* Read custom claims back from Auth. Creating a user and AUTHORIZING it are
     different things; a suite asserts the claim landed rather than assuming
     setCustomUserClaims silently succeeded. */
  async verifyClaims(uid, expected = {}) {
    const rec = await this.auth.getUser(uid);
    const actual = rec.customClaims || {};
    const ok = Object.entries(expected).every(([k, v]) => actual[k] === v);
    return { ok, actual };
  }

  async authContext(uid) {
    // A custom token the browser exchanges via signInWithCustomToken — lets the
    // real app run as this user without typing the password into a form.
    const token = await this.auth.createCustomToken(uid);
    return { kind: 'customToken', token, uid };
  }

  _ref(p) { return this.db.doc(p); }

  async setDoc(p, data)    { await this._ref(p).set(data, { merge: true }); return true; }
  async getDoc(p)          { const s = await this._ref(p).get(); return s.exists ? s.data() : null; }
  async deleteDoc(p)       { await this._ref(p).delete(); return true; }
  async queryCol(col, wheres = []) {
    let q = this.db.collection(col);
    for (const [f, op, v] of wheres) q = q.where(f, op, v);
    const s = await q.get();
    return s.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  async callFunction(name, data, asUid) {
    // Callable functions over HTTP need a real ID token + App Check; that is a
    // separate build. For now this backend drives functions THROUGH the UI
    // (which carries auth+appcheck) rather than calling them raw.
    throw new BlockedError(
      `Direct callable invocation (${name}) not wired yet — exercise it via the ` +
      `UI journey instead, or run against the Functions emulator.`);
  }

  async cleanup() {
    // Remove only RC-tagged docs. Never a blanket delete.
    for (const col of ['products', 'orders']) {
      let docs = [];
      try { docs = await this.queryCol(col, [['_rcSeed', '==', true]]); } catch { /* rules/permission */ }
      for (const d of docs) { try { await this.deleteDoc(`${col}/${d.id}`); } catch {} }
    }
  }
}

module.exports = AdminBackend;
