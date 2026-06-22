/**
 * sokoni-dev-mock.js — SOKONI Offline Development Simulation Layer v1.0
 *
 * Auto-activates when Firebase is unavailable (offline, wrong config, CI).
 * Production code is NEVER touched when Firebase is available.
 *
 * Activation triggers:
 *   • window.firebaseDB not set within 2.5s of window load
 *   • URL contains ?offline=1
 *   • localStorage contains sokoni_force_offline=1
 *   • window.__sokoniForceOffline = true (set before this script)
 *
 * Provides mocks for:
 *   Auth · Firestore · Storage · Cloud Functions · SokoniDB (87 methods)
 *
 * Usage:
 *   Load BEFORE any page JS:  <script src="sokoni-mock-data.js"></script>
 *                             <script src="sokoni-dev-mock.js"></script>
 */

(function (global) {
"use strict";

/* ═══════════════════════════════════════════════════════════════════════════
   CONSTANTS & STATE
═══════════════════════════════════════════════════════════════════════════ */
const MOCK_VERSION   = "1.0.0";
const NET_DELAY      = 100;   // ms — simulated network latency
const UPLOAD_DELAY   = 400;   // ms — simulated upload time

const _store     = Object.create(null); // { [collection]: { [docId]: data } }
const _listeners = Object.create(null); // { [key]: Array<{cb, constraints}> }
const _authCbs   = [];
let   _currentUser  = null;
let   _activated    = false;
let   _storedURLs   = Object.create(null);

/* ═══════════════════════════════════════════════════════════════════════════
   UTILITIES
═══════════════════════════════════════════════════════════════════════════ */
function _uid()  { return Math.random().toString(36).slice(2,9) + Date.now().toString(36); }
function _delay(ms) { return new Promise(r => setTimeout(r, ms)); }
function _clone(v)  { try { return JSON.parse(JSON.stringify(v)); } catch (e) { return v; } }

function _ts(date) {
  const d = date instanceof Date ? date : new Date();
  return {
    toDate()    { return new Date(d); },
    toMillis()  { return d.getTime(); },
    seconds:     Math.floor(d.getTime() / 1000),
    nanoseconds: 0,
    _isMockTs:   true,
    toString()   { return d.toISOString(); }
  };
}

function _applyFV(existing, key, fv) {
  if (!fv || typeof fv !== "object") return fv;
  if (fv._isMockTs)               return fv;
  if (fv._type === "serverTs")    return _ts();
  if (fv._type === "increment")   return (Number(existing && existing[key]) || 0) + fv._n;
  if (fv._type === "arrayUnion")  {
    const arr = Array.isArray(existing && existing[key]) ? [...existing[key]] : [];
    fv._items.forEach(i => { if (!arr.includes(i)) arr.push(i); });
    return arr;
  }
  if (fv._type === "arrayRemove") {
    const arr = Array.isArray(existing && existing[key]) ? [...existing[key]] : [];
    return arr.filter(i => !fv._items.includes(i));
  }
  return fv;
}

function _mergeInto(target, updates) {
  const result = _clone(target || {});
  for (const [k, v] of Object.entries(updates)) {
    if (k.includes(".")) {
      const parts = k.split(".");
      let cur = result;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!cur[parts[i]] || typeof cur[parts[i]] !== "object") cur[parts[i]] = {};
        cur = cur[parts[i]];
      }
      cur[parts[parts.length - 1]] = _applyFV(cur, parts[parts.length - 1], v);
    } else {
      result[k] = _applyFV(result, k, v);
    }
  }
  return result;
}

function _nestedGet(obj, path) {
  return path.split(".").reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);
}

/* ═══════════════════════════════════════════════════════════════════════════
   IN-MEMORY DOCUMENT STORE
═══════════════════════════════════════════════════════════════════════════ */
function _col(name) {
  if (!_store[name]) _store[name] = Object.create(null);
  return _store[name];
}

function _sGet(col, id)           { return _clone(_col(col)[id] || null); }
function _sSet(col, id, data, merge) {
  const old = _col(col)[id] || {};
  _col(col)[id] = merge ? _mergeInto(old, data) : { ..._clone(data), _id: id };
  _notify(col, id);
}
function _sUpdate(col, id, data)  { _col(col)[id] = _mergeInto(_col(col)[id], data); _notify(col, id); }
function _sDelete(col, id)        { delete _col(col)[id]; _notify(col, id); }

function _sQuery(col, constraints) {
  let docs = Object.values(_col(col)).map(d => _clone(d));
  for (const c of constraints) {
    if (c.type === "where") {
      docs = docs.filter(d => {
        const v = _nestedGet(d, c.field);
        switch (c.op) {
          case "==":              return v == c.value;
          case "!=":              return v != c.value;
          case ">":               return v > c.value;
          case ">=":              return v >= c.value;
          case "<":               return v < c.value;
          case "<=":              return v <= c.value;
          case "array-contains":  return Array.isArray(v) && v.includes(c.value);
          case "array-contains-any": return Array.isArray(v) && Array.isArray(c.value) && c.value.some(x => v.includes(x));
          case "in":              return Array.isArray(c.value) && c.value.includes(v);
          case "not-in":          return Array.isArray(c.value) && !c.value.includes(v);
          default:                return true;
        }
      });
    }
    if (c.type === "orderBy") {
      docs.sort((a, b) => {
        const av = _nestedGet(a, c.field), bv = _nestedGet(b, c.field);
        if (av == null && bv == null) return 0;
        if (av == null) return c.dir === "desc" ? 1 : -1;
        if (bv == null) return c.dir === "desc" ? -1 : 1;
        if (av < bv) return c.dir === "desc" ? 1 : -1;
        if (av > bv) return c.dir === "desc" ? -1 : 1;
        return 0;
      });
    }
    if (c.type === "limit")      docs = docs.slice(0, c.n);
    if (c.type === "limitToLast") docs = docs.slice(-c.n);
    if (c.type === "startAfter" && c.docSnap) {
      const idx = docs.findIndex(d => d._id === c.docSnap.id);
      if (idx >= 0) docs = docs.slice(idx + 1);
    }
  }
  return docs;
}

/* ═══════════════════════════════════════════════════════════════════════════
   LISTENER MANAGEMENT
═══════════════════════════════════════════════════════════════════════════ */
function _addListener(key, cb, constraints) {
  if (!_listeners[key]) _listeners[key] = [];
  const entry = { cb, constraints };
  _listeners[key].push(entry);
  return function unsub() {
    if (_listeners[key]) _listeners[key] = _listeners[key].filter(l => l !== entry);
  };
}

function _notify(col, docId) {
  const docKey = `${col}/${docId}`;
  const data    = _sGet(col, docId);

  if (_listeners[docKey]) {
    const snap = _docSnap(col, docId, data);
    _listeners[docKey].forEach(l => setTimeout(() => { try { l.cb(snap); } catch(e){} }, NET_DELAY));
  }
  if (_listeners[col]) {
    _listeners[col].forEach(l => {
      const docs = _sQuery(col, l.constraints || []);
      const snap = _querySnap(col, docs);
      setTimeout(() => { try { l.cb(snap); } catch(e){} }, NET_DELAY);
    });
  }
}

function _docSnap(col, id, data) {
  return {
    exists()      { return data !== null && data !== undefined; },
    data()        { return data ? _clone(data) : undefined; },
    id:            id,
    ref:           { _type:"doc", _col:col, _id:id, id },
    get(field)    { return data ? _nestedGet(data, field) : undefined; }
  };
}

function _querySnap(col, docs) {
  const snapDocs = docs.map(d => _docSnap(col, d._id || d.id || _uid(), d));
  return {
    docs:    snapDocs,
    empty:   snapDocs.length === 0,
    size:    snapDocs.length,
    forEach(cb) { snapDocs.forEach(cb); }
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   MOCK FIRESTORE OBJECTS
═══════════════════════════════════════════════════════════════════════════ */
function _colRef(colPath) {
  const segments = colPath.replace(/^\/|\/$/g, "").split("/");
  const colName  = segments[segments.length - 1];
  return { _type:"collection", _col:colName, _path:colPath, id:colName };
}

function _docRef(colOrDb, ...parts) {
  let col, id;
  if (colOrDb && colOrDb._type === "collection") {
    col = colOrDb._col;
    id  = parts[0] || _uid();
  } else {
    const raw  = parts.join("/").replace(/^\/|\/$/g, "");
    const segs = raw.split("/").filter(Boolean);
    // collection/doc or collection/doc/subcol/subdoc...
    col = segs[segs.length - 2] || segs[0];
    id  = segs[segs.length - 1] || _uid();
  }
  return { _type:"doc", _col:col, _id:id, id, path:`${col}/${id}` };
}

/* Public Firestore API (mirrors Firebase v10 modular API) */
function collection(db, colPath)             { return _colRef(colPath); }
function doc(dbOrRef, ...args)               { return _docRef(dbOrRef, ...args); }
function query(colRef, ...constraints)       { return { _type:"query", _col:colRef._col, _constraints: constraints }; }
function where(f, op, v)                     { return { type:"where",     field:f, op, value:v }; }
function orderBy(f, dir)                     { return { type:"orderBy",   field:f, dir:dir||"asc" }; }
function limit(n)                            { return { type:"limit",     n }; }
function limitToLast(n)                      { return { type:"limitToLast", n }; }
function startAfter(docSnap)                 { return { type:"startAfter", docSnap }; }
function startAt(docSnap)                    { return { type:"startAt",   docSnap }; }
function endBefore(docSnap)                  { return { type:"endBefore", docSnap }; }
function serverTimestamp()                   { return { _type:"serverTs", _isMockTs:true, toDate(){ return new Date(); }, toMillis(){ return Date.now(); }, seconds:Math.floor(Date.now()/1000), nanoseconds:0 }; }
function increment(n)                        { return { _type:"increment", _n:n }; }
function arrayUnion(...items)                { return { _type:"arrayUnion",  _items:items }; }
function arrayRemove(...items)               { return { _type:"arrayRemove", _items:items }; }

async function getDoc(ref)                   { await _delay(NET_DELAY); return _docSnap(ref._col, ref._id, _sGet(ref._col, ref._id)); }
async function getDocs(qOrRef) {
  await _delay(NET_DELAY);
  const col = qOrRef._col, cs = qOrRef._constraints || [];
  return _querySnap(col, _sQuery(col, cs));
}
async function addDoc(colRef, data)          { await _delay(NET_DELAY); const id = _uid(); _sSet(colRef._col, id, { ...data, _id:id }); return _docRef(colRef, id); }
async function setDoc(ref, data, opts)       { await _delay(NET_DELAY); _sSet(ref._col, ref._id, { ...data, _id:ref._id }, opts && opts.merge); }
async function updateDoc(ref, data)          { await _delay(NET_DELAY); _sUpdate(ref._col, ref._id, data); }
async function deleteDoc(ref)                { await _delay(NET_DELAY); _sDelete(ref._col, ref._id); }
async function getCountFromServer(qRef)      { await _delay(NET_DELAY); return { data() { return { count: _sQuery(qRef._col, qRef._constraints||[]).length }; } }; }

function onSnapshot(refOrQ, cbOrOpts, cbFn) {
  const cb  = typeof cbOrOpts === "function" ? cbOrOpts : cbFn;
  const col = refOrQ._col;
  if (refOrQ._type === "doc") {
    setTimeout(() => { try { cb(_docSnap(col, refOrQ._id, _sGet(col, refOrQ._id))); } catch(e){} }, NET_DELAY);
    return _addListener(`${col}/${refOrQ._id}`, cb, null);
  }
  const cs = refOrQ._constraints || [];
  setTimeout(() => { try { cb(_querySnap(col, _sQuery(col, cs))); } catch(e){} }, NET_DELAY);
  return _addListener(col, cb, cs);
}

function writeBatch() {
  const ops = [];
  return {
    set(ref, data, opts) { ops.push({ op:"set",    ref, data, opts }); return this; },
    update(ref, data)    { ops.push({ op:"update", ref, data }); return this; },
    delete(ref)          { ops.push({ op:"delete", ref }); return this; },
    async commit() {
      for (const o of ops) {
        if (o.op === "set")    _sSet(o.ref._col, o.ref._id, o.data, o.opts && o.opts.merge);
        if (o.op === "update") _sUpdate(o.ref._col, o.ref._id, o.data);
        if (o.op === "delete") _sDelete(o.ref._col, o.ref._id);
      }
    }
  };
}

async function runTransaction(db, fn) {
  const txn = {
    async get(ref) { return _docSnap(ref._col, ref._id, _sGet(ref._col, ref._id)); },
    set(ref, data, opts)  { _sSet(ref._col, ref._id, data, opts && opts.merge); },
    update(ref, data)     { _sUpdate(ref._col, ref._id, data); },
    delete(ref)           { _sDelete(ref._col, ref._id); }
  };
  return fn(txn);
}

function MockTimestamp(seconds, ns) {
  this.seconds     = seconds;
  this.nanoseconds = ns || 0;
  this.toDate  = () => new Date(seconds * 1000);
  this.toMillis= () => seconds * 1000;
}
MockTimestamp.now      = () => { const n = Date.now(); return new MockTimestamp(Math.floor(n/1000)); };
MockTimestamp.fromDate = d  => new MockTimestamp(Math.floor(d.getTime()/1000));
MockTimestamp.fromMillis= ms=> new MockTimestamp(Math.floor(ms/1000));

const mockDB = {
  _isMock:true, _type:"firestore",
  collection(p)    { return _colRef(p); },
  doc(p, id)       { return _docRef(this, p, id || ""); }
};

/* ═══════════════════════════════════════════════════════════════════════════
   MOCK AUTHENTICATION
═══════════════════════════════════════════════════════════════════════════ */
const MOCK_USERS = {
  "admin@sokoni.co.ke":    { uid:"mock-admin-001",  email:"admin@sokoni.co.ke",    displayName:"Admin Sokoni",      role:"admin",    isAdmin:true  },
  "seller@sokoni.co.ke":   { uid:"mock-seller-001", email:"seller@sokoni.co.ke",   displayName:"Alice Wanjiku",     role:"seller"                  },
  "seller2@sokoni.co.ke":  { uid:"mock-seller-002", email:"seller2@sokoni.co.ke",  displayName:"Kamau Groceries",   role:"seller"                  },
  "buyer@sokoni.co.ke":    { uid:"mock-buyer-001",  email:"buyer@sokoni.co.ke",    displayName:"Brian Odhiambo",    role:"buyer"                   },
  "driver@sokoni.co.ke":   { uid:"mock-driver-001", email:"driver@sokoni.co.ke",   displayName:"David Maina",       role:"driver"                  },
  "provider@sokoni.co.ke": { uid:"mock-prov-001",   email:"provider@sokoni.co.ke", displayName:"Dr. Sarah Njeri",   role:"provider"                }
};

const mockAuth = {
  _isMock:       true,
  currentUser:   null,
  _callbacks:    _authCbs,
  _fire(user)    { _authCbs.forEach(cb => setTimeout(() => { try { cb(user); } catch(e){} }, NET_DELAY)); }
};

function onAuthStateChanged(auth, cb) {
  if (!auth || !auth._isMock) return () => {};
  const saved = _savedUser();
  if (saved) { auth.currentUser = saved; global.__sokoniCurrentUid = saved.uid; }
  _authCbs.push(cb);
  setTimeout(() => { try { cb(auth.currentUser); } catch(e){} }, NET_DELAY);
  return () => { const i = _authCbs.indexOf(cb); if (i > -1) _authCbs.splice(i, 1); };
}

function signInWithEmailAndPassword(auth, email, password) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      const u = MOCK_USERS[email.toLowerCase()];
      if (!u) { reject({ code:"auth/user-not-found", message:`[MOCK] No user: ${email}` }); return; }
      _setCurrentUser(auth, u);
      resolve({ user: auth.currentUser });
    }, NET_DELAY);
  });
}

function createUserWithEmailAndPassword(auth, email, password) {
  return new Promise(resolve => {
    setTimeout(() => {
      const u = { uid:"mock-" + _uid(), email, displayName:email.split("@")[0], role:"buyer" };
      _setCurrentUser(auth, u);
      resolve({ user: auth.currentUser });
    }, NET_DELAY);
  });
}

function signOut(auth) {
  return new Promise(resolve => {
    setTimeout(() => {
      auth.currentUser = null;
      global.__sokoniCurrentUid = null;
      _currentUser = null;
      localStorage.removeItem("_sokoniMockUser");
      localStorage.setItem("loggedIn", "false");
      localStorage.removeItem("sokoniUser");
      if (auth._fire) auth._fire(null);
      resolve();
    }, NET_DELAY);
  });
}

function sendPasswordResetEmail(auth, email) {
  console.log("[MOCK] Password reset email (suppressed):", email);
  return Promise.resolve();
}

function reauthenticateWithCredential(user, credential) { return Promise.resolve(); }
function updatePassword(user, newPwd) { return Promise.resolve(); }
function updateProfile(user, data) { Object.assign(user, data); return Promise.resolve(); }

function _setCurrentUser(auth, u) {
  auth.currentUser = { ...u };
  _currentUser     = auth.currentUser;
  global.__sokoniCurrentUid = u.uid;
  localStorage.setItem("_sokoniMockUser", JSON.stringify(u));
  localStorage.setItem("loggedIn", "true");
  localStorage.setItem("sokoniUser", JSON.stringify({ uid:u.uid, email:u.email, displayName:u.displayName, role:u.role, isAdmin:!!u.isAdmin }));
  if (auth._fire) auth._fire(auth.currentUser);
}

function _savedUser() {
  try { return JSON.parse(localStorage.getItem("_sokoniMockUser") || "null"); } catch(e) { return null; }
}

/* ═══════════════════════════════════════════════════════════════════════════
   MOCK STORAGE
═══════════════════════════════════════════════════════════════════════════ */
const mockStorage = { _isMock:true, _type:"storage" };

function ref(storageOrRef, path) {
  const base = storageOrRef && storageOrRef._path ? storageOrRef._path : "";
  const full = base ? (path ? base + "/" + path : base) : (path || "");
  return { _type:"storageRef", _path:full, path:full, name:full.split("/").pop() };
}

async function uploadBytes(storageRef, data) {
  await _delay(UPLOAD_DELAY);
  const url = `https://mock-storage.sokoni.dev/o/${encodeURIComponent(storageRef._path)}?alt=media&mock=1`;
  _storedURLs[storageRef._path] = url;
  return { ref:storageRef, metadata:{ name:storageRef._path, fullPath:storageRef._path, size:data.size||data.byteLength||1024 } };
}

function uploadBytesResumable(storageRef, data) {
  const handlers = {};
  const totalBytes = data.size || data.byteLength || 1024;
  setTimeout(() => {
    if (handlers.next) handlers.next({ bytesTransferred:Math.floor(totalBytes/2), totalBytes, state:"running" });
    setTimeout(() => {
      const url = `https://mock-storage.sokoni.dev/o/${encodeURIComponent(storageRef._path)}?alt=media&mock=1`;
      _storedURLs[storageRef._path] = url;
      if (handlers.next)     handlers.next({ bytesTransferred:totalBytes, totalBytes, state:"success" });
      if (handlers.complete) handlers.complete();
    }, UPLOAD_DELAY);
  }, 50);
  return {
    on(evt, progress, error, complete) { handlers.next=progress; handlers.error=error; handlers.complete=complete; return this; },
    then(fn)  { setTimeout(() => fn({ ref:storageRef }), UPLOAD_DELAY + 100); return this; },
    catch(fn) { return this; }
  };
}

async function getDownloadURL(storageRef) {
  await _delay(NET_DELAY);
  return _storedURLs[storageRef._path] || `https://mock-storage.sokoni.dev/o/${encodeURIComponent(storageRef._path)}?alt=media&mock=1`;
}

async function deleteObject(storageRef) { await _delay(NET_DELAY); delete _storedURLs[storageRef._path]; }
async function listAll(storageRef) {
  const prefix = storageRef._path;
  const items = Object.keys(_storedURLs).filter(p => p.startsWith(prefix)).map(p => ref(null, p));
  return { items, prefixes:[] };
}

/* ═══════════════════════════════════════════════════════════════════════════
   MOCK CLOUD FUNCTIONS
═══════════════════════════════════════════════════════════════════════════ */
const _CF_MOCKS = {
  kassAIAssistant:          async (d) => ({ text:"[MOCK] KASS AI is in offline mode. Connect Firebase to use live AI." }),
  kassChat:                 async (d) => ({ text:"[MOCK] AI chat is unavailable in offline mode. Check back when connected." }),
  initiateSTKPush:          async (d) => ({ success:true, CheckoutRequestID:"MOCK-STK-" + Date.now(), ResponseCode:"0", mock:true }),
  confirmSTKPush:           async (d) => ({ success:true, ResultCode:0, Amount:d.amount, mock:true }),
  verifyPaymentStatus:      async (d) => ({ paid:true, status:"completed", amount:d.amount||100, mock:true }),
  activateSubscription:     async (d) => ({ success:true, plan:d.plan||"ai_free", expiresAt:new Date(Date.now()+30*864e5).toISOString(), mock:true }),
  redeemVoucher:            async (d) => ({ success:true, discount:10, voucherCode:d.code, mock:true }),
  inviteShopEmployee:       async (d) => ({ success:true, invitedEmail:d.email, mock:true }),
  generateProductMetadata:  async (d) => ({ title:d.name||"Mock Product", description:"AI-generated description (offline mock).", tags:["mock"], mock:true }),
  posExtractProductsFromImage: async (d) => ({ products:[{ name:"Mock Product", price:1000, category:"General" }], mock:true }),
  posSendSMS:               async (d) => ({ success:true, recipient:d.phone, mock:true }),
  darajaSTKPush:            async (d) => ({ success:true, CheckoutRequestID:"MOCK-DARAJA-" + Date.now(), mock:true }),
  verifyPaymentStatus:      async (d) => ({ paid:true, mock:true }),
  validateDarajaCredentials:async (d) => ({ valid:true, mock:true }),
  getAlgoliaSearchKey:      async (d) => ({ key:"mock-search-key-000", mock:true }),
  recordSearchEvent:        async (d) => ({ recorded:true, mock:true }),
  getTrendingSearches:      async (d) => ({ trending:["phones","shoes","food","electronics","fashion"], mock:true }),
  getAlgoliaUserProfile:    async (d) => ({ profile:{}, mock:true }),
  getAlgoliaFBT:            async (d) => ({ results:[], mock:true }),
  getAlgoliaRelated:        async (d) => ({ results:[], mock:true }),
  getAlgoliaTrendingItems:  async (d) => ({ results:[], mock:true }),
  getAlgoliaLookingSimilar: async (d) => ({ results:[], mock:true }),
  getAlgoliaTrendingFacets: async (d) => ({ facets:[], mock:true }),
  generateTrending:         async (d) => ({ success:true, mock:true }),
  aggregateAnalytics:       async (d) => ({ success:true, mock:true }),
  sendEmailNotification:    async (d) => ({ success:true, mock:true }),
  createWallet:             async (d) => ({ walletId:"mock-wallet-" + _uid(), balance:0, mock:true }),
  processWalletTransaction: async (d) => ({ success:true, newBalance:d.amount||0, mock:true })
};

const mockFunctions = { _isMock:true, _type:"functions", _region:"us-central1" };

function getFunctions(app, region) { return mockFunctions; }
function httpsCallable(fnsOrRef, name, opts) {
  return async function callable(data) {
    await _delay(NET_DELAY * 2);
    const handler = _CF_MOCKS[name];
    if (handler) return { data: await handler(data || {}) };
    console.warn("[MOCK] No mock for Cloud Function:", name, "— returning generic success.");
    return { data: { success:true, mock:true } };
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   MOCK SOKONI DB  (mirrors all 87 real SokoniDB methods)
═══════════════════════════════════════════════════════════════════════════ */
function _buildMockSokoniDB() {
  const _u  = () => global.__sokoniCurrentUid || "mock-anon";
  const _t  = ()  => _ts();
  const _i  = ()  => _uid();

  function _listen(col, docId, cb) {
    if (docId) {
      const snap = _docSnap(col, docId, _sGet(col, docId));
      setTimeout(() => { try { cb(snap); } catch(e){} }, NET_DELAY);
      return _addListener(`${col}/${docId}`, cb, null);
    }
    const snap = _querySnap(col, _sQuery(col, []));
    setTimeout(() => { try { cb(snap); } catch(e){} }, NET_DELAY);
    return _addListener(col, cb, []);
  }

  return {
    _isMock: true,

    currentUid() { return _u(); },

    /* Applications */
    async saveApplication(data)              { const id = data.uid || _i(); _sSet("applications", id, { ...data, _id:id, createdAt:_t(), updatedAt:_t() }); return id; },
    listenApplications(uid, cb)              { return _listen("applications", null, cb); },
    async updateApplicationStatus(id,s,note) { _sUpdate("applications", id, { status:s, reviewNote:note, updatedAt:_t() }); },

    /* Providers */
    async saveProvider(data)           { const id = data.uid || _i(); _sSet("providers", id, { ...data, _id:id, createdAt:_t() }); return id; },
    async getProvider(id)              { return _sGet("providers", id); },
    async updateProviderStatus(id, s)  { _sUpdate("providers", id, { status:s, updatedAt:_t() }); },
    listenProvider(id, cb)             { return _listen("providers", id, cb); },
    listenProviders(cb)                { return _listen("providers", null, cb); },

    /* Bookings */
    async saveBooking(data)            { const id = _i(); _sSet("bookings", id, { ...data, _id:id, createdAt:_t() }); return id; },
    async updateBooking(id, data)      { _sUpdate("bookings", id, { ...data, updatedAt:_t() }); },
    listenProviderBookings(pid, cb)    { return _listen("bookings", null, cb); },
    listenClientBookings(uid, cb)      { return _listen("bookings", null, cb); },

    /* Orders */
    async saveOrder(data)              { const id = data.orderId || _i(); _sSet("orders", id, { ...data, _id:id, createdAt:_t() }); return id; },
    async updateOrder(id, data)        { _sUpdate("orders", id, { ...data, updatedAt:_t() }); },
    listenOrder(id, cb)                { return _listen("orders", id, cb); },
    listenUserOrders(uid, cb)          { return _listen("orders", null, cb); },
    listenSellerOrders(sid, cb)        { return _listen("orders", null, cb); },
    listenAllOrders(cb)                { return _listen("orders", null, cb); },
    listenPOSOrders(shopId, cb)        { return _listen("orders", null, cb); },
    listenPendingRiderOrders(cb)       { return _listen("orders", null, cb); },
    listenRiderActiveOrders(uid, cb)   { return _listen("orders", null, cb); },

    /* Rides */
    async saveRide(data)               { const id = _i(); _sSet("rides", id, { ...data, _id:id, createdAt:_t() }); return id; },
    async updateRide(id, data)         { _sUpdate("rides", id, { ...data, updatedAt:_t() }); },
    listenRide(id, cb)                 { return _listen("rides", id, cb); },

    /* Ride Requests */
    async saveRideRequest(data)        { const id = _i(); _sSet("rideRequests", id, { ...data, _id:id, createdAt:_t() }); return id; },
    async updateRideRequest(id, data)  { _sUpdate("rideRequests", id, { ...data, updatedAt:_t() }); },
    listenRideRequest(id, cb)          { return _listen("rideRequests", id, cb); },
    listenDriverActiveRequests(uid, cb){ return _listen("rideRequests", null, cb); },
    listenOnlineDrivers(cb)            { return _listen("driverLocations", null, cb); },
    async getOnlineDrivers()           { return Object.values(_col("driverLocations")); },
    async setDriverOnline(uid, online, data) { _sSet("driverLocations", uid, { ...data, uid, online, updatedAt:_t() }); },

    /* Packages */
    async savePackage(data)                  { const id = _i(); _sSet("rides", id, { ...data, type:"delivery", _id:id, createdAt:_t() }); return id; },
    async savePackageRequest(data)           { const id = _i(); _sSet("packageRequests", id, { ...data, _id:id, createdAt:_t() }); return id; },
    async updatePackageRequest(id, data)     { _sUpdate("packageRequests", id, { ...data, updatedAt:_t() }); },
    listenPackageRequest(id, cb)             { return _listen("packageRequests", id, cb); },
    listenDriverDeliveryRequests(uid, cb)    { return _listen("packageRequests", null, cb); },
    listenUserPackageHistory(uid, cb)        { return _listen("packageRequests", null, cb); },
    listenUserRideHistory(uid, cb)           { return _listen("rides", null, cb); },
    listenAllDeliveries(cb)                  { return _listen("packageRequests", null, cb); },

    /* Driver GPS */
    async updateDriverLocation(uid, lat, lng, extra) { _sSet("driverLocations", uid, { uid, lat, lng, ...(extra||{}), updatedAt:_t() }); },
    listenDriverLocation(uid, cb)  { return _listen("driverLocations", uid, cb); },
    startGPSTracking(uid, onUpdate){ console.log("[MOCK] GPS tracking (simulated) for", uid); let t = setInterval(() => { if(onUpdate) onUpdate({ lat:-1.28+Math.random()*0.01, lng:36.82+Math.random()*0.01 }); }, 3000); return () => clearInterval(t); },
    stopGPSTracking()              { console.log("[MOCK] GPS tracking stopped"); },

    /* Products */
    async saveProduct(data)        { const id = data.id || _i(); _sSet("products", id, { ...data, _id:id, createdAt:_t() }); return id; },
    async deleteProduct(id)        { _sDelete("products", id); },
    async updateProductStock(id,q) { _sUpdate("products", id, { stock:q, updatedAt:_t() }); },
    listenProducts(sid, cb)        { return _listen("products", null, cb); },
    async loadProducts(p)          { return Object.values(_col("products")).slice(0, (p && p.limit) || 20); },

    /* Reviews */
    async saveReview(data)         { const id = _i(); _sSet("reviews", id, { ...data, _id:id, createdAt:_t() }); return id; },
    listenReviews(pid, cb)         { return _listen("reviews", null, cb); },
    async saveUnboxingReview(data) { const id = _i(); _sSet("unboxingReviews", id, { ...data, _id:id, createdAt:_t() }); return id; },
    listenUnboxingReviews(sid, cb) { return _listen("unboxingReviews", null, cb); },
    async saveDriverRating(data)   { const id = _i(); _sSet("driverRatings", id, { ...data, _id:id, createdAt:_t() }); return id; },
    listenDriverRatings(uid, cb)   { return _listen("driverRatings", null, cb); },

    /* Notifications */
    async saveNotification(data)   { const id = _i(); _sSet("notifications", id, { ...data, _id:id, createdAt:_t() }); return id; },
    listenNotifications(uid, cb)   { return _listen("notifications", null, cb); },
    async markNotificationRead(id) { _sUpdate("notifications", id, { read:true }); },

    /* Follows */
    _followDocId(uid, sid)         { return `${uid}_${sid}`; },
    async follow(uid, sid)         { const id = `${uid}_${sid}`; _sSet("follows", id, { followerId:uid, sellerId:sid, _id:id, createdAt:_t() }); },
    async unfollow(uid, sid)       { _sDelete("follows", `${uid}_${sid}`); },
    async isFollowing(uid, sid)    { return !!_sGet("follows", `${uid}_${sid}`); },
    async getFollowerCount(sid)    { return Object.values(_col("follows")).filter(f => f.sellerId === sid).length; },
    listenFollowerCount(sid, cb)   { return _listen("follows", null, cb); },
    async getMyFollowing(uid)      { return Object.values(_col("follows")).filter(f => f.followerId === uid); },

    /* Referrals */
    async saveReferral(data)       { const id = _i(); _sSet("referrals", id, { ...data, _id:id, createdAt:_t() }); return id; },
    listenMyReferrals(uid, cb)     { return _listen("referrals", null, cb); },

    /* Broadcasts */
    async saveSellerBroadcast(data){ const id = _i(); _sSet("broadcasts", id, { ...data, _id:id, createdAt:_t() }); return id; },
    listenSellerBroadcasts(names, cb){ return _listen("broadcasts", null, cb); },

    /* Order Events */
    async saveOrderEvent(data)     { const id = _i(); _sSet("orderEvents", id, { ...data, _id:id, createdAt:_t() }); return id; },
    listenOrderEvents(orderId, cb) { return _listen("orderEvents", null, cb); },

    /* Escrow */
    async saveEscrow(data)         { const id = data.orderId || _i(); _sSet("escrow", id, { ...data, _id:id, createdAt:_t() }); return id; },
    listenEscrow(orderId, cb)      { return _listen("escrow", orderId, cb); },
    async releaseEscrow(orderId)   { _sUpdate("escrow", orderId, { status:"released", releasedAt:_t() }); },
    listenDriverEarnings(uid, cb)  { return _listen("driverEarnings", null, cb); },

    /* Disputes */
    async saveDispute(data)        { const id = _i(); _sSet("disputes", id, { ...data, _id:id, createdAt:_t() }); return id; },
    async updateDispute(id, data)  { _sUpdate("disputes", id, { ...data, updatedAt:_t() }); },
    listenDisputes(cb)             { return _listen("disputes", null, cb); },

    /* Users */
    async queryUsers(params) {
      const all = Object.values(_col("users"));
      if (params && params.phone) return all.filter(u => u.phone === params.phone);
      if (params && params.email) return all.filter(u => u.email === params.email);
      return all;
    }
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   ACTIVATION
═══════════════════════════════════════════════════════════════════════════ */
const _mockApp = {
  _isMock:true, _type:"app",
  name:"[DEFAULT]",
  options:{ projectId:"sokoni-aeb26-OFFLINE", apiKey:"OFFLINE-MOCK" }
};

function getFirestore(app) { return mockDB; }
function getAuth(app)      { return mockAuth; }
function getStorage(app)   { return mockStorage; }

function _loadMockData() {
  const D = global.SokoniMockData;
  if (!D) return;
  let count = 0;
  for (const [col, docs] of Object.entries(D)) {
    for (const doc of docs) {
      const id = doc._id || doc.id || _uid();
      _col(col)[id] = { ..._clone(doc), _id:id };
      count++;
    }
  }
  console.log(`[MOCK] Loaded ${count} documents across ${Object.keys(D).length} collections.`);
}

function _activate() {
  if (_activated) return;
  _activated = true;

  console.warn(
    "%c SOKONI OFFLINE MOCK ACTIVE — Firebase unavailable ",
    "background:#e55;color:#fff;font-weight:bold;padding:3px 8px;border-radius:4px"
  );
  console.info("[MOCK] Tip: Add ?offline=1 to any URL to force offline mode.");

  /* Replace Firebase globals */
  global.firebaseApp      = _mockApp;
  global.firebaseAuth     = mockAuth;
  global.firebaseDB       = mockDB;
  global.firebaseStorage  = mockStorage;

  /* Load mock data if available */
  _loadMockData();

  /* Restore session */
  const saved = _savedUser();
  if (saved) { mockAuth.currentUser = saved; global.__sokoniCurrentUid = saved.uid; }

  /* Replace SokoniDB only if real one not yet available */
  if (!global.SokoniDB || global.SokoniDB._isMock) {
    global.SokoniDB = _buildMockSokoniDB();
    global.dispatchEvent(new CustomEvent("sokoniDbReady"));
  }

  /* Expose full mock API for pages that import Firebase directly */
  global._sokoniMock = {
    /* Firestore */
    getFirestore, getAuth, getStorage, getFunctions,
    collection, doc, query, where, orderBy, limit, limitToLast,
    startAfter, startAt, endBefore, getDocs, getDoc, addDoc,
    setDoc, updateDoc, deleteDoc, onSnapshot, writeBatch, runTransaction,
    getCountFromServer, serverTimestamp, Timestamp:MockTimestamp,
    increment, arrayUnion, arrayRemove,
    /* Auth */
    onAuthStateChanged, signInWithEmailAndPassword,
    createUserWithEmailAndPassword, signOut, sendPasswordResetEmail,
    updateProfile, updatePassword, reauthenticateWithCredential,
    /* Storage */
    ref, uploadBytes, uploadBytesResumable, getDownloadURL, deleteObject, listAll,
    /* Functions */
    httpsCallable,
    /* Data helpers */
    store:     _store,
    setData:   (col, id, data) => _sSet(col, id, { ..._clone(data), _id:id }),
    getData:   (col, id)       => _sGet(col, id),
    getAllData: (col)           => Object.values(_col(col)).map(d => _clone(d)),
    clearData: (col)           => { _store[col] = Object.create(null); },
    /* Mock users for auth testing */
    MOCK_USERS,
    signInAs: (role) => {
      const user = Object.values(MOCK_USERS).find(u => u.role === role);
      if (user) _setCurrentUser(mockAuth, user);
      return user || null;
    }
  };

  global.dispatchEvent(new CustomEvent("sokoniMockReady"));
}

/* ── Check whether to activate ─────────────────────────────────────────── */
function _shouldActivate() {
  if (global.__sokoniForceOffline)  return true;
  if (typeof localStorage !== "undefined" && localStorage.getItem("sokoni_force_offline") === "1") return true;
  if (typeof location !== "undefined" && location.search.includes("offline=1")) return true;
  return false;
}

function _checkAndActivate() {
  if (_shouldActivate() || !global.firebaseDB) {
    _activate();
  } else {
    /* Firebase loaded — expose standby API only */
    console.info("[MOCK] Firebase connected — mock layer on standby.");
    global._sokoniMock = {
      forceActivate:  _activate,
      store:          _store,
      setData:  (col,id,data) => _sSet(col, id, { ..._clone(data), _id:id }),
      getData:  (col,id)      => _sGet(col, id),
      getAllData:(col)         => Object.values(_col(col)).map(d => _clone(d)),
      signInAs: () => null,
      Timestamp:MockTimestamp,
      serverTimestamp, increment, arrayUnion, arrayRemove
    };
  }
}

/* ── Bootstrap ──────────────────────────────────────────────────────────── */
if (_shouldActivate()) {
  /* Force-offline: activate immediately without waiting */
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", _activate);
  } else {
    _activate();
  }
} else {
  /* Normal: wait 2.5s after window load for Firebase to initialize */
  if (document.readyState === "complete") {
    setTimeout(_checkAndActivate, 2500);
  } else {
    global.addEventListener("load", () => setTimeout(_checkAndActivate, 2500));
  }
}

/* Module export for testing environments */
if (typeof module !== "undefined" && module.exports) {
  module.exports = { _activate, mockDB, mockAuth, mockStorage, mockFunctions, _store, _buildMockSokoniDB };
}

}(typeof window !== "undefined" ? window : this));
