/* ================================================================
   Shared fixture for the admin-console browser certifications.
   scripts/lib/adminos-probe-lib.js

   Consumers (all hermetic — repo served from disk, every other origin aborted):
     scripts/test-admin-layouts.js          layout at 390 / 768 / 1280, both consoles
     scripts/test-adminos-sidebar-a11y.js   AdminOS scroll region, drawer, keyboard
     scripts/test-adminos-nav-coverage.js   built => reachable, child routing, deep links
     scripts/test-adminos-shell-final.js    one primary path, header, five widths

   Ported from feat/integrations-control-center 5750f8f and adapted: that line
   served scripts/fixtures/firebase-stub-module.js and stubbed sokoni-admin-guard.js;
   this line has neither. Here /firebase.js is answered by firebaseStub() — a compat
   shim whose auth() is a fixture admin (claims {admin:true, superAdmin:true}), whose
   firestore() answers every read ASYNCHRONOUSLY with an empty snapshot, and whose
   callables resolve {data:{}} — and compatInit() seeds the storage the REAL gates
   read (sokoni-admin-entry.js -> sokoni-permissions.js requireAdminContext), so the
   real admission code runs and admits the fixture. Nothing here proves
   authorization: rules and callables are the boundary and are untouched.

   ONE fixture, four consumers: a difference between suites can only be a
   difference in the product, never in the harness.
   ================================================================ */
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const MAIN_CHECKOUT = 'C:/Users/USER1/OneDrive/Desktop/SOKONI';

/* Playwright lives in the main checkout's node_modules; a worktree has none. */
function playwright() {
  const candidates = [path.join(ROOT, 'node_modules', 'playwright')];
  if (process.env.SK_PLAYWRIGHT_ROOT) candidates.push(path.join(process.env.SK_PLAYWRIGHT_ROOT, 'node_modules', 'playwright'));
  candidates.push(path.join(MAIN_CHECKOUT, 'node_modules', 'playwright'));
  for (const c of candidates) { try { return require(c); } catch (_) { /* next */ } }
  throw new Error('playwright not found; tried ' + candidates.join(', ') + ' (set SK_PLAYWRIGHT_ROOT)');
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
};

/* A minimal static server over the repo, random port, 127.0.0.1 only. */
function startServer(root) {
  root = root || ROOT;
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent((req.url || '/').split('?')[0]);
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(root, rel.replace(/^\/+/, '')));
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('404'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const CLAIMS = { admin: true, superAdmin: true };

/* /firebase.js replacement. Loaded by the page as <script type="module">; this body
   has no imports, so it runs as a module too. Reads are EMPTY and ASYNC: a page must
   render its neutral/empty state, never a fabricated figure. */
function firebaseStub() {
  return `
(function(){
  var claims = ${JSON.stringify(CLAIMS)};
  var user = { uid: 'fixture-admin', email: 'fixture-admin@example.test', displayName: 'Fixture Admin',
    getIdTokenResult: function(){ return new Promise(function(r){ setTimeout(function(){ r({ claims: claims, token: 'fixture' }); }, 5); }); },
    getIdToken: function(){ return Promise.resolve('fixture-token'); } };
  var auth = { currentUser: user,
    onAuthStateChanged: function(cb){ setTimeout(function(){ try { cb(user); } catch(e){} }, 0); return function(){}; },
    onIdTokenChanged: function(cb){ setTimeout(function(){ try { cb(user); } catch(e){} }, 0); return function(){}; },
    signOut: function(){ return Promise.resolve(); }, setPersistence: function(){ return Promise.resolve(); } };
  function later(v){ return new Promise(function(r){ setTimeout(function(){ r(v); }, 8); }); }
  function docSnap(id){ return { id: id, exists: false, data: function(){ return undefined; }, get: function(){ return undefined; } }; }
  function qSnap(){ return { empty: true, size: 0, docs: [], forEach: function(){}, docChanges: function(){ return []; }, metadata: { fromCache: false, hasPendingWrites: false } }; }
  function refuse(){ var e = new Error('harness: no client writes'); e.code = 'permission-denied'; return Promise.reject(e); }
  function docRef(p){ return { id: String(p).split('/').pop(), path: p,
    get: function(){ return later(docSnap(this.id)); },
    onSnapshot: function(cb){ var s = docSnap(this.id); setTimeout(function(){ try { cb(s); } catch(e){} }, 8); return function(){}; },
    collection: function(c){ return colRef(p + '/' + c); }, set: refuse, update: refuse, delete: refuse }; }
  function colRef(p){ var q = { path: p, doc: function(id){ return docRef(p + '/' + (id || 'auto')); },
    where: function(){ return q; }, orderBy: function(){ return q; }, limit: function(){ return q; }, limitToLast: function(){ return q; },
    startAfter: function(){ return q; }, startAt: function(){ return q; }, endBefore: function(){ return q; }, endAt: function(){ return q; },
    get: function(){ return later(qSnap()); },
    onSnapshot: function(cb){ setTimeout(function(){ try { cb(qSnap()); } catch(e){} }, 8); return function(){}; },
    add: refuse }; return q; }
  var fsFn = function(){ return { collection: function(c){ return colRef(c); }, doc: function(p){ return docRef(p); },
    collectionGroup: function(c){ return colRef(c); },
    batch: function(){ return { set: function(){}, update: function(){}, delete: function(){}, commit: refuse }; },
    runTransaction: function(){ return refuse(); }, enablePersistence: function(){ return Promise.resolve(); } }; };
  fsFn.FieldValue = { serverTimestamp: function(){ return null; }, increment: function(n){ return n; }, arrayUnion: function(){ return []; }, arrayRemove: function(){ return []; }, delete: function(){ return null; } };
  fsFn.Timestamp = { now: function(){ return { toMillis: function(){ return Date.now(); }, toDate: function(){ return new Date(); } }; },
    fromMillis: function(m){ return { toMillis: function(){ return m; }, toDate: function(){ return new Date(m); } }; },
    fromDate: function(d){ return { toMillis: function(){ return +d; }, toDate: function(){ return d; } }; } };
  var authFn = function(){ return auth; }; authFn.Auth = { Persistence: { LOCAL: 'local' } };
  window.firebase = { apps: [{}], SDK_VERSION: 'harness', initializeApp: function(){ return {}; }, app: function(){ return { name: '[DEFAULT]' }; },
    auth: authFn, firestore: fsFn,
    functions: function(){ return { httpsCallable: function(){ return function(){ return later({ data: {} }); }; }, useEmulator: function(){} }; },
    storage: function(){ return { ref: function(){ return { child: function(){ return this; }, getDownloadURL: function(){ return Promise.resolve(''); } }; } }; },
    messaging: Object.assign(function(){ return { getToken: function(){ return Promise.resolve(null); }, onMessage: function(){} }; }, { isSupported: function(){ return false; } }) };
  window.firebaseAuth = auth;
  window.firebaseDB = { __harness: true };
  window.firebaseFunctions = { __harness: true };
  window.firebaseSDK = { onAuthStateChanged: auth.onAuthStateChanged, signOut: auth.signOut };
  window.__sokoniFirebaseReady = true;
  try { window.dispatchEvent(new Event('firebaseReady')); document.dispatchEvent(new Event('firebaseReady')); } catch(e){}
  try { window.dispatchEvent(new CustomEvent('sokoniFirebaseReady', { detail: { auth: auth } })); document.dispatchEvent(new CustomEvent('sokoniFirebaseReady', { detail: { auth: auth } })); } catch(e){}
})();
`;
}

/* Seeds what the REAL gates read, before any page script runs. Runs INSIDE the page
   (addInitScript). `ctx` is the administrative context sokoni-permissions.js
   requireAdminContext() compares against; 'superAdmin' satisfies both consoles. */
function compatInit(ctx) {
  const c = ctx || 'superAdmin';
  try {
    localStorage.setItem('loggedIn', 'true');
    localStorage.setItem('sokoniUser', JSON.stringify({ uid: 'fixture-admin', name: 'Fixture Admin', email: 'fixture-admin@example.test', roles: ['admin', 'superAdmin'], activeRole: 'buyer' }));
    sessionStorage.setItem('sokoniAdminContext', c);
    sessionStorage.removeItem('sokoniPermCache');
  } catch (_) {}
}

/* A route handler factory: serve the repo from disk under `host`, answer
   /firebase.js with the stub, abort every other origin. `overrides` maps a
   pathname to bytes to serve instead of the file on disk (served-markup sabotage
   for negative controls). */
function router({ host, overrides = {}, root } = {}) {
  root = root || ROOT;
  return (route) => {
    const url = new URL(route.request().url());
    if (host && url.hostname !== host) return route.abort();
    if (overrides[url.pathname] !== undefined)
      return route.fulfill({ status: 200, contentType: MIME[path.extname(url.pathname)] || 'text/plain', body: overrides[url.pathname] });
    if (/\/firebase\.js$/.test(url.pathname))
      return route.fulfill({ status: 200, contentType: 'text/javascript', body: firebaseStub() });
    const file = path.normalize(path.join(root, decodeURIComponent(url.pathname).replace(/^\/+/, '')));
    if (!file.startsWith(root)) return route.fulfill({ status: 403, body: '' });
    let buf; try { buf = fs.readFileSync(file); } catch (_) { return route.fulfill({ status: 404, body: '404' }); }
    return route.fulfill({ status: 200, contentType: MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', body: buf });
  };
}

module.exports = { ROOT, MIME, CLAIMS, playwright, startServer, firebaseStub, compatInit, router };
