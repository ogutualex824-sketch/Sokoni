/* ============================================================================
   RC BACKEND ADAPTER — the contract every backend must satisfy

   A suite is written ONCE against this interface and runs unchanged on any
   backend (production-admin today, Firestore emulator once JDK 21 is present,
   a future staging project). The runner picks a backend by name; the suites
   never know which one they are on.

   Every method is async. A backend that genuinely cannot perform a capability
   must throw a BlockedError (below) rather than return a wrong answer — the
   runner turns a BlockedError into a BLOCKED step (not a FAIL), so "we could
   not test this here" is never silently reported as "this passed".
   ========================================================================== */

'use strict';

class BlockedError extends Error {
  constructor(reason) { super(reason); this.name = 'BlockedError'; this.blocked = true; }
}

/* Reference shape — real backends extend this and override. Calling any method
   here throws, so a half-implemented backend fails loudly instead of no-oping. */
class BackendInterface {
  constructor(opts = {}) { this.opts = opts; this.name = 'abstract'; }

  /* Lifecycle */
  async init()    { throw new Error(`${this.name}: init() not implemented`); }
  async cleanup() { throw new Error(`${this.name}: cleanup() not implemented`); }

  /* Identity — create/ensure a beta user with custom claims, return its uid.
     MUST refuse to set a claim marked privileged unless opts.allowPrivileged. */
  async ensureUser(/* identity */) { throw new Error(`${this.name}: ensureUser() not implemented`); }

  /* Read claims back — proves the identity was AUTHORIZED, not merely created. */
  async verifyClaims(/* uid, expected */) { throw new Error(`${this.name}: verifyClaims() not implemented`); }

  /* Return something a browser can use to BE this user (a custom token to
     exchange, or {email,password} for the real sign-in form). */
  async authContext(/* uid */) { throw new Error(`${this.name}: authContext() not implemented`); }

  /* Firestore primitives — path is "collection/doc" or "col/doc/col/doc". */
  async setDoc(/* path, data */) { throw new Error(`${this.name}: setDoc() not implemented`); }
  async getDoc(/* path */)       { throw new Error(`${this.name}: getDoc() not implemented`); }
  async deleteDoc(/* path */)    { throw new Error(`${this.name}: deleteDoc() not implemented`); }
  async queryCol(/* col, wheres */) { throw new Error(`${this.name}: queryCol() not implemented`); }

  /* Invoke a Cloud Function by name (the business logic under test). */
  async callFunction(/* name, data, asUid */) { throw new Error(`${this.name}: callFunction() not implemented`); }

  /* Base URL the harness should drive a browser against for this backend. */
  baseUrl() { throw new Error(`${this.name}: baseUrl() not implemented`); }

  /* Capability flags a suite can consult to self-skip cleanly. */
  supports() { return { auth: false, firestore: false, functions: false, ui: false }; }
}

module.exports = { BackendInterface, BlockedError };
