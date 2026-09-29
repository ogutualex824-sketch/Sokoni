/* page-harness.js — serve the REAL pages of this repo to Chromium with the Firebase SDK replaced by a
 * thin shim over the transactional FAKE Firestore and the REAL Cloud Function handlers.
 *
 *   const H = makePageHarness({ db, root, callables })   // callables: { bookingDispatch: { op: handler } | (req)=>… }
 *   http: { getMinishopPublic: onRequestHandler }        // https://…cloudfunctions.net/<name> → the REAL handler
 *   await H.start(); const page = await H.page(browser, { user, viewport });   …   H.stop()
 *
 * What is REAL: every HTML/JS/CSS file served from `root`, every callable handler, the fake
 * Firestore's data. What is SHIMMED: the Firebase SDK itself (compat global + modular ES modules),
 * `/firebase.js` (the app bootstrap), App Check, and every non-local URL (fulfilled empty).
 *
 * Reads through the shim go to the fake Firestore with NO security rules (rules are proven by the
 * emulator suites); a page must therefore only be trusted here for what it RENDERS and CALLS.
 * No network, no production.
 */
'use strict';
const fs = require('fs');
const http = require('http');
const Path = require('path');

const wire = (v) => JSON.parse(JSON.stringify(v, (k, x) => (x && typeof x.toMillis === 'function' ? x.toMillis() : x)));

/* Every name any file imports from a gstatic Firebase module — an ES module must export each one. */
function importedNames(root) {
  const names = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.') || e.name === 'functions' || e.name === 'docs') continue;
      const p = Path.join(dir, e.name);
      if (e.isDirectory()) { if (dir === root && ['scripts', 'tests', 'assets'].includes(e.name)) continue; walk(p); continue; }
      if (!/\.(m?js|html)$/.test(e.name)) continue;
      const src = fs.readFileSync(p, 'utf8');
      const re = /import\s*\{([^}]*)\}\s*from\s*['"]https:\/\/www\.gstatic\.com\/firebasejs\/[^'"]+\/([a-z-]+\.js)['"]/g; let m;
      while ((m = re.exec(src))) {
        const set = (names[m[2]] = names[m[2]] || new Set());
        m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean).forEach((n) => set.add(n));
      }
    }
  };
  walk(root);
  return names;
}

const SHIM_CORE = `
window.__fsShim = (function(){
  const snap = (r) => r && r.exists ? { id: r.id, exists: () => true, data: () => r.data, get: (k) => (r.data || {})[k], ref: { id: r.id, path: r.path } } : { id: r && r.id, exists: () => false, data: () => undefined, get: () => undefined };
  const qsnap = (rows) => ({ empty: !rows.length, size: rows.length, docs: rows.map((r) => Object.assign(snap(r), { exists: true })), forEach(f) { rows.forEach((r) => f(Object.assign(snap(r), { exists: true }))); } });
  return {
    get: async (path) => snap(await window.__fs('get', path)),
    query: async (q) => qsnap(await window.__fs('query', q)),
    call: (name) => async (data) => { const r = await window.__srv(name, data || {}, window.__user && window.__user.uid); if (r.err) { const e = new Error(r.err.message); e.code = 'functions/' + r.err.code; e.details = r.err.details; throw e; } return { data: r.ok }; },
    snap, qsnap,
  };
})();`;

const COMPAT = `${SHIM_CORE}
(function(){
  const S = window.__fsShim;
  const user = () => window.__user ? Object.assign({ getIdToken: async () => 'harness', getIdTokenResult: async () => ({ claims: window.__user.claims || {} }) }, window.__user) : null;
  function colRef(path, cons) {
    cons = cons || [];
    const q = { doc: (id) => docRef(path + '/' + id), where: (f, op, v) => colRef(path, cons.concat([['w', f, op, v]])), orderBy: () => colRef(path, cons), limit: (n) => colRef(path, cons.concat([['l', n]])), startAfter: () => colRef(path, cons),
      get: () => S.query({ col: path, cons }), onSnapshot: (cb) => { S.query({ col: path, cons }).then(cb).catch(() => {}); return () => {}; }, add: async () => { throw Object.assign(new Error('client writes are not part of this harness'), { code: 'permission-denied' }); } };
    return q;
  }
  function docRef(path) { return { id: path.split('/').pop(), path, get: () => S.get(path), onSnapshot: (cb) => { S.get(path).then(cb).catch(() => {}); return () => {}; }, collection: (c) => colRef(path + '/' + c),
    set: async () => { throw Object.assign(new Error('client writes are not part of this harness'), { code: 'permission-denied' }); }, update: async () => { throw Object.assign(new Error('client writes are not part of this harness'), { code: 'permission-denied' }); } }; }
  const fsFn = () => ({ collection: (c) => colRef(c), doc: (p) => docRef(p), batch: () => ({ set(){}, update(){}, delete(){}, commit: async () => { throw new Error('harness: no client writes'); } }), enablePersistence: async () => {} });
  fsFn.FieldValue = { serverTimestamp: () => null, increment: (n) => n, arrayUnion: () => [], arrayRemove: () => [], delete: () => null };
  fsFn.Timestamp = { now: () => ({ toMillis: () => Date.now(), toDate: () => new Date() }), fromMillis: (m) => ({ toMillis: () => m, toDate: () => new Date(m) }) };
  const authObj = () => ({ get currentUser() { return user(); }, onAuthStateChanged(cb) { setTimeout(() => cb(user()), 0); return () => {}; }, onIdTokenChanged(cb) { setTimeout(() => cb(user()), 0); return () => {}; }, signOut: async () => {}, setPersistence: async () => {} });
  const authFn = () => authObj(); authFn.Auth = { Persistence: { LOCAL: 'local' } };
  window.firebase = { apps: [{}], SDK_VERSION: 'harness', initializeApp: () => ({}), app: () => ({ name: '[DEFAULT]' }), auth: authFn, firestore: fsFn,
    functions: () => ({ httpsCallable: (n) => S.call(n), useEmulator(){} }), appCheck: () => ({ activate(){}, getToken: async () => ({ token: 'harness' }) }),
    storage: () => ({ ref: () => ({ child(){ return this; }, getDownloadURL: async () => '' }) }), messaging: Object.assign(() => ({ getToken: async () => null, onMessage(){} }), { isSupported: () => false }), analytics: () => ({ logEvent(){} }) };
  window.firebaseDB = window.firebaseDB || { __db: true }; window.firebaseAuth = window.firebaseAuth || window.firebase.auth();
})();`;

/* What the real firebase.js publishes once it has run (a module — deferred): callables + auth-ready. */
const FIREBASE_JS_SIGNALS = `
;(function(){
  window.sokoniCallable = (n) => window.__fsShim.call(n);
  const detail = { user: window.__user || null };
  window.__sokoniAuthReady = true; window.__sokoniAuthReadyDetail = detail;
  window.waitForSokoniAuthReady = (cb) => { try { if (typeof cb === 'function') cb(detail); } catch (_) {} return Promise.resolve(detail); };
  window.__sokoniFirebaseReady = true;
  setTimeout(() => { window.dispatchEvent(new Event('firebaseReady')); document.dispatchEvent(new Event('firebaseReady')); document.dispatchEvent(new CustomEvent('sokoniAuthReady', { detail })); }, 0);
})();`;

function modularModule(file, names) {
  const own = {
    'firebase-app.js': `export const initializeApp = () => ({ name: '[DEFAULT]' }); export const getApps = () => [{ name: '[DEFAULT]' }]; export const getApp = () => ({ name: '[DEFAULT]' });`,
    'firebase-app-check.js': `export const initializeAppCheck = () => ({}); export function ReCaptchaV3Provider() {} export function ReCaptchaEnterpriseProvider() {} export const getToken = async () => ({ token: 'harness' });`,
    'firebase-auth.js': `const u = () => window.__user ? Object.assign({ getIdToken: async () => 'harness', getIdTokenResult: async () => ({ claims: window.__user.claims || {} }) }, window.__user) : null;
      export const getAuth = () => ({ get currentUser() { return u(); } });
      export function onAuthStateChanged(a, cb) { setTimeout(() => cb(u()), 0); return () => {}; }
      export function onIdTokenChanged(a, cb) { setTimeout(() => cb(u()), 0); return () => {}; }
      export const signOut = async () => {}; export const setPersistence = async () => {}; export const browserLocalPersistence = 'local';`,
    'firebase-functions.js': `export const getFunctions = () => ({}); export function httpsCallable(f, name) { return window.__fsShim.call(name); } export const connectFunctionsEmulator = () => {};`,
    'firebase-firestore.js': `const S = window.__fsShim;
      const segs = (a) => a.filter((x) => typeof x === 'string').join('/');
      export const getFirestore = () => ({ __db: true }); export const initializeFirestore = () => ({ __db: true });
      export function doc(base, ...rest) { const b = base && base.__col ? base.__col : (base && base.__path ? base.__path : ''); const p = [b, ...rest].filter(Boolean).join('/'); return { __path: p, id: p.split('/').pop(), path: p }; }
      export function collection(base, ...rest) { const b = base && base.__path ? base.__path : ''; const p = [b, ...rest].filter(Boolean).join('/'); return { __col: p, cons: [] }; }
      export function collectionGroup(db, id) { return { __col: id, group: true, cons: [] }; }
      export function query(q, ...cons) { return { __col: q.__col, cons: (q.cons || []).concat(cons.filter(Boolean)) }; }
      export const where = (f, op, v) => ['w', f, op, v]; export const limit = (n) => ['l', n]; export const orderBy = () => null; export const startAfter = () => null; export const limitToLast = (n) => ['l', n];
      export const getDoc = (r) => S.get(r.__path); export const getDocFromServer = getDoc; export const getDocFromCache = getDoc;
      export const getDocs = (q) => S.query({ col: q.__col, cons: q.cons || [] }); export const getDocsFromServer = getDocs; export const getDocsFromCache = getDocs;
      export function onSnapshot(r, a, b) { const cb = typeof a === 'function' ? a : (a && a.next) || b; (r.__path ? S.get(r.__path) : S.query({ col: r.__col, cons: r.cons || [] })).then((s) => cb && cb(s)).catch(() => {}); return () => {}; }
      const deny = async () => { throw Object.assign(new Error('client writes are not part of this harness'), { code: 'permission-denied' }); };
      export const setDoc = deny; export const updateDoc = deny; export const addDoc = deny; export const deleteDoc = deny;
      export const serverTimestamp = () => null; export const increment = (n) => n; export const arrayUnion = () => []; export const arrayRemove = () => []; export const deleteField = () => null;
      export const writeBatch = () => ({ set(){}, update(){}, delete(){}, commit: deny }); export const runTransaction = deny;
      export const enableIndexedDbPersistence = async () => {}; export const enableMultiTabIndexedDbPersistence = async () => {}; export const persistentLocalCache = () => ({}); export const persistentMultipleTabManager = () => ({}); export const memoryLocalCache = () => ({});
      export const Timestamp = { now: () => ({ toMillis: () => Date.now(), toDate: () => new Date() }), fromMillis: (m) => ({ toMillis: () => m, toDate: () => new Date(m) }), fromDate: (d) => ({ toMillis: () => +d, toDate: () => d }) };
      export const documentId = () => '__name__'; export const disableNetwork = async () => {}; export const enableNetwork = async () => {}; export const terminate = async () => {}; export const clearIndexedDbPersistence = async () => {}; export const waitForPendingWrites = async () => {};`,
  };
  let src = own[file] || '';
  const defined = new Set([...src.matchAll(/export\s+(?:const|function|async function|let|var)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
  for (const n of names || []) if (!defined.has(n)) { src += `\nexport function ${n}() { return {}; }`; defined.add(n); }
  return src;
}

/* A minimal express-like req/res for a v2 onRequest handler (its CORS wrapper waits on res 'finish'). */
function mockHttp(method, query) {
  let status = 200; const headers = {}; let body = ''; const listeners = {};
  const done = () => (listeners.finish || []).forEach((f) => f());
  const res = { statusCode: 200, on(ev, f) { (listeners[ev] = listeners[ev] || []).push(f); return res; }, once(ev, f) { return res.on(ev, f); }, emit() { return true; },
    status(s) { status = s; res.statusCode = s; return res; }, set(k, v) { headers[k] = v; return res; }, setHeader(k, v) { headers[k] = v; return res; }, getHeader(k) { return headers[k]; }, removeHeader(k) { delete headers[k]; }, vary() { return res; },
    json(o) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(wire(o)); done(); return res; }, send(b) { body = typeof b === 'string' ? b : JSON.stringify(b); done(); return res; }, end(b) { if (b) body = String(b); done(); return res; } };
  const hdr = { 'user-agent': 'harness', origin: 'http://127.0.0.1' };
  const req = { method: method || 'GET', query: query || {}, headers: hdr, get: (k) => hdr[String(k).toLowerCase()], header: (k) => hdr[String(k).toLowerCase()], ip: '127.0.0.1', body: {}, url: '/', path: '/' };
  return { req, res, result: () => ({ status, headers, body }) };
}

function makePageHarness(opts) {
  const db = opts.db; const root = Path.resolve(opts.root);
  const callables = opts.callables || {};
  const NAMES = importedNames(root);
  const calls = [];
  async function server(name, data, uid, claims) {
    const req = { auth: uid ? { uid, token: Object.assign({ email_verified: true }, claims || {}) } : null, rawRequest: { headers: {} }, data };
    try {
      calls.push(name + ':' + (data && data.op));
      const c = callables[name];
      const h = typeof c === 'function' ? c : c && c[data && data.op];
      if (!h) return { err: { code: 'not-found', message: `unknown ${name}${data && data.op ? ' op ' + data.op : ''}` } };
      return { ok: wire(await h(req)) };
    } catch (e) { return { err: { code: e.code || 'internal', message: e.message, details: e.details || null } }; }
  }
  async function fsOp(op, arg) {
    if (op === 'get') { const s = await db.doc(String(arg)).get(); return { id: s.id, path: String(arg), exists: s.exists, data: s.exists ? wire(s.data()) : null }; }
    let q = db.collection(arg.col); let lim = 500;
    for (const c of arg.cons || []) { if (!c) continue; if (c[0] === 'w') q = q.where(c[1], c[2], c[3]); else if (c[0] === 'l') lim = c[1]; }
    const s = await q.limit(lim).get();
    return s.docs.map((d) => ({ id: d.id, path: arg.col + '/' + d.id, exists: true, data: wire(d.data()) }));
  }
  const srv = http.createServer((rq, res) => {
    const p = decodeURIComponent(new URL(rq.url, 'http://x').pathname);
    if (p === '/firebase.js') { res.writeHead(200, { 'Content-Type': 'application/javascript' }); return res.end(COMPAT + FIREBASE_JS_SIGNALS + '\nexport const app = {}; export const db = {}; export const auth = window.firebase.auth(); export const functions = {}; export const storage = {};'); }
    if (opts.pages && opts.pages[p]) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(opts.pages[p]); }
    const file = Path.join(root, p === '/' ? 'index.html' : p.slice(1));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      const clean = Path.join(root, p.slice(1) + '.html');
      if (fs.existsSync(clean)) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(fs.readFileSync(clean)); }
      res.writeHead(404); return res.end('');
    }
    const type = /\.html$/.test(file) ? 'text/html; charset=utf-8' : /\.m?js$/.test(file) ? 'application/javascript; charset=utf-8' : /\.css$/.test(file) ? 'text/css' : /\.json$/.test(file) ? 'application/json' : /\.svg$/.test(file) ? 'image/svg+xml' : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type }); res.end(fs.readFileSync(file));
  });
  const H = {
    calls, BASE: null,
    start: () => new Promise((r) => srv.listen(0, '127.0.0.1', () => { H.BASE = 'http://127.0.0.1:' + srv.address().port; r(H); })),
    stop: () => srv.close(),
    async page(browser, o) {
      o = o || {};
      const ctx = await browser.newContext({ viewport: o.viewport || { width: 390, height: 844 }, permissions: o.permissions || [] });
      const user = o.user || null;
      await ctx.exposeBinding('__srv', (_s, name, data, uid) => server(name, data, uid, user && user.claims));
      await ctx.exposeBinding('__fs', (_s, op, arg) => fsOp(op, arg));
      await ctx.addInitScript(([u, st]) => { window.__user = u; try { localStorage.setItem('sokoniPrivacyRejected', String(Date.now())); Object.keys(st || {}).forEach((k) => localStorage.setItem(k, st[k])); } catch (_) {} }, [user, o.storage || null]);   /* o.storage: what a real sign-in leaves in localStorage */
      /* a LATER route wins: the catch-all first, then the SDK shims */
      await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.fulfill({ status: 200, contentType: /\.css(\?|$)/.test(route.request().url()) ? 'text/css' : 'application/javascript', body: '' }));
      /* HTTP (onRequest) functions: the page's fetch reaches the REAL handler with a minimal req/res */
      await ctx.route(/cloudfunctions\.net\/([A-Za-z0-9_]+)/, async (route) => {
        const u = new URL(route.request().url()); const name = u.pathname.split('/').pop();
        const h = (opts.http || {})[name];
        if (!h) return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
        const query = Object.fromEntries(u.searchParams.entries());
        const { req, res, result } = mockHttp(route.request().method(), query);
        try { await h(req, res); } catch (e) { res.status(500).json({ error: e.message }); }
        const r = result();
        return route.fulfill({ status: r.status, headers: Object.assign({ 'Access-Control-Allow-Origin': '*' }, r.headers), contentType: r.headers['Content-Type'] || 'application/json', body: r.body });
      });
      await ctx.route(/gstatic\.com\/firebasejs\/[^/]+\/([a-z-]+\.js)(\?.*)?$/, (route) => {
        const f = route.request().url().split('?')[0].split('/').pop();
        if (/-compat\.js$/.test(f)) return route.fulfill({ status: 200, contentType: 'application/javascript', body: f === 'firebase-app-compat.js' ? COMPAT : '' });
        return route.fulfill({ status: 200, contentType: 'application/javascript', body: SHIM_CORE + '\n' + modularModule(f, NAMES[f]) });
      });
      const page = await ctx.newPage();
      page.__errors = [];
      page.on('pageerror', (e) => page.__errors.push(String(e && e.message || e)));
      page.__ctx = ctx;
      return page;
    },
  };
  return H;
}

module.exports = { makePageHarness, mockHttp, wire };
