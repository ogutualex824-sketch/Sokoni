/* Test fixture served IN PLACE OF /firebase.js during recertification.
   Production admin pages authenticate through an ES module:
       import { auth } from "./firebase.js"
   A window.firebase compat stub cannot satisfy that — the page silently
   redirects to login and the harness measures the LOGIN page instead. This
   fixture is fulfilled at the network layer; the product file is never modified.
   The claims placeholder below is substituted by the harness. */
const claims = __CLAIMS__;
const user = {
  uid: "rc", email: "rc@sokoni.test", displayName: "RC",
  getIdTokenResult: async () => ({ claims, token: "stub" }),
  getIdToken: async () => "stub-token",
};
export const auth = {
  currentUser: user,
  onAuthStateChanged(cb) { try { cb(user); } catch (e) {} return () => {}; },
  signOut: async () => {},
};
const q = {
  collection: () => q, doc: () => q, where: () => q, orderBy: () => q, limit: () => q,
  get: async () => ({ empty: true, size: 0, docs: [], forEach() {} }),
  onSnapshot: () => () => {}, add: async () => ({ id: "x" }),
  set: async () => {}, update: async () => {},
};
export const db = q;
export const storage = {};
export const functions = { httpsCallable: () => async () => ({ data: {} }) };
export const app = { name: "[DEFAULT]" };
window.firebaseAuth = auth;
window.firebaseDb = q;
window.firebase = { auth: () => auth, firestore: () => q, functions: () => functions,
  initializeApp: () => app, apps: [], app: () => app };
window.firebase.firestore.FieldValue = { serverTimestamp: () => "ts", increment: (n) => n };
window.firebase.firestore.Timestamp = { now: () => new Date(0), fromDate: (d) => d };
export default app;
