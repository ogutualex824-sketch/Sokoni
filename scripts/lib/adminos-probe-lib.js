/* ================================================================
   Shared measurement library for the two admin runtime probes.

   Both admin.html and AdminOS MUST be measured by identical code. If each probe
   carried its own copy of "count the filters", any difference between the two
   ledgers could be a difference in the probes rather than in the product, and
   the parity matrix built on top would be worthless. One implementation, used
   by both, removes that whole class of error.

   Consumers:
     scripts/certify-adminos-runtime.js      (admin-os.html)
     scripts/certify-admin-html-runtime.js   (admin.html)
   ================================================================ */
'use strict';

const fs   = require('fs');
const http = require('http');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2',
};

/* A minimal static server. Deliberately not the http-server binary: spawning a
   .cmd shim on Windows is the kind of environment coupling that produces a
   uniform failure and an untrustworthy zero. */
function startServer(ROOT) {
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(req.url.split('?')[0]);
    if (rel === '/') rel = '/index.html';
    const file = path.join(ROOT, rel.replace(/^\/+/, ''));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      res.end(buf);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/* Serve the repo over an ARBITRARY hostname by fulfilling every request from
   disk. Needed because admin.html enables demo data on localhost/127.0.0.1:

       /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)

   A probe served from 127.0.0.1 measures invented rows. --host-resolver-rules
   was tried first and left the page on chromewebdata (the navigation never
   resolved), so DNS is removed from the problem entirely: no server, no
   resolution, just the filesystem answering whatever host we claim to be.

   Register this BEFORE the firebase.js fixture route — Playwright matches the
   most recently registered route first, so the fixture must be added last. */
async function serveFromDisk(ctx, ROOT, host) {
  await ctx.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (!/^https?:$/.test(url.protocol)) return route.continue();
    /* Only OUR host is served. Third-party origins (cdnjs, gstatic) are aborted
       rather than 404'd: a hermetic probe has no network, and letting them fall
       through to the disk handler produced a stream of 404 console errors that
       polluted the per-pane error signal. An earlier run reported a 404 while
       loading the AdminOS `content` section on exactly this basis — an artifact
       of the harness, not a product defect. Blocked externals are counted
       separately by the caller. */
    if (host && url.hostname !== host) return route.abort();
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.join(ROOT, rel.replace(/^\/+/, ''));
    if (!file.startsWith(ROOT)) return route.fulfill({ status: 403, body: '' });
    let buf;
    try { buf = fs.readFileSync(file); } catch (_) { return route.fulfill({ status: 404, body: '404' }); }
    return route.fulfill({
      status: 200,
      contentType: MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      body: buf,
    });
  });
}

const CLAIMS = { admin: true, superAdmin: true };

/* The shipped ES-module fixture with its inert functions export swapped for one
   that RECORDS every callable invocation, attributed by CALL STACK.

   Attribution by "which section was active" was tried first and was wrong:
   shared-header.js injects sokoni-zero-trust.js and sokoni-observability.js, so
   registerDevice and obsIngestTelemetry landed on whichever innocent pane
   happened to be open. Reading the originating script off the stack is
   machine-derived and needs no maintained allow-list of "ambient" op names. */
const STACK_SRC = `
const __src = () => {
  const st = (new Error()).stack || '';
  for (const L of st.split('\\n').slice(1)) {
    const m = L.match(/\\/([A-Za-z0-9_.-]+\\.js)/);
    if (m && m[1] !== 'firebase.js') return m[1];
  }
  return 'unknown';
};`;

const RECORDER = STACK_SRC + `
const __rec = (name, data) => {
  const op = (name === 'adminOsDispatch' && data && data.op) ? data.op : name;
  window.__AOS_OPS = window.__AOS_OPS || [];
  window.__AOS_OPS.push({ callable: name, op, src: __src(), section: window.__AOS_SECTION || 'boot' });
  return { data: {} };
};
export const functions = { httpsCallable: (name) => async (data) => __rec(name, data) };
`;

function instrumentedModule(ROOT) {
  const fixture = fs.readFileSync(path.join(ROOT, 'scripts', 'fixtures', 'firebase-stub-module.js'), 'utf8');
  const line = 'export const functions = { httpsCallable: () => async () => ({ data: {} }) };';
  if (!fixture.includes(line)) {
    console.error('PROBE INVALID — the auth fixture no longer contains the functions export this');
    console.error('               harness instruments. Refusing to run against an unknown fixture.');
    process.exit(1);
  }
  return fixture.replace(line, RECORDER).split('__CLAIMS__').join(JSON.stringify(CLAIMS));
}

/* window.firebase compat globals, installed before any page script. Admin pages
   read these synchronously; the module fixture serves the ES import. */
function compatInit() {
  window.__AOS_OPS = [];
  const claims = { admin: true, superAdmin: true };
  const u = { uid: 'rc', email: 'rc@sokoni.test', displayName: 'RC',
              getIdTokenResult: async () => ({ claims, token: 'stub' }),
              getIdToken: async () => 'stub' };
  const q = { collection: () => q, doc: () => q, where: () => q, orderBy: () => q, limit: () => q,
              get: async () => ({ empty: true, size: 0, docs: [], forEach() {} }),
              onSnapshot: () => () => {}, add: async () => ({ id: 'x' }),
              set: async () => {}, update: async () => {}, count: () => q };
  const src = () => {
    const st = (new Error()).stack || '';
    for (const L of st.split('\n').slice(1)) {
      const m = L.match(/\/([A-Za-z0-9_.-]+\.js)/);
      if (m && m[1] !== 'firebase.js') return m[1];
    }
    return 'unknown';
  };
  const rec = (name, data) => {
    const op = (name === 'adminOsDispatch' && data && data.op) ? data.op : name;
    window.__AOS_OPS.push({ callable: name, op, src: src(), section: window.__AOS_SECTION || 'boot' });
    return { data: {} };
  };
  window.firebaseAuth = { currentUser: u, onAuthStateChanged: (cb) => { try { cb(u); } catch (e) {} return () => {}; } };
  window.firebaseDb = q;
  window.firebase = {
    auth: () => ({ onAuthStateChanged: (cb) => { try { cb(u); } catch (e) {} return () => {}; }, currentUser: u }),
    firestore: () => q,
    functions: () => ({ httpsCallable: (name) => async (data) => rec(name, data) }),
    initializeApp: () => ({}), apps: [], app: () => ({}),
  };
  window.firebase.firestore.FieldValue = { serverTimestamp: () => 'ts', increment: (n) => n };
  window.firebase.firestore.Timestamp = { now: () => new Date(0), fromDate: (d) => d };
}

/* Runs INSIDE the page. Identical measurement for both surfaces — this is the
   whole reason the library exists. `arg.id` is the pane/panel element id and
   `arg.section` is the key ops were recorded under. */
function measurePane(arg) {
  const el = document.getElementById(arg.id);
  const vis = (n) => {
    if (!n) return false;
    const r = n.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const active = !!el && (el.hidden === false || el.classList.contains('active')) && vis(el);
  const scope = el || document.createElement('div');

  const inputs = [...scope.querySelectorAll('input')];
  const searchInputs = inputs.filter((i) => {
    const t = (i.type || '').toLowerCase();
    const p = (i.placeholder || '') + ' ' + (i.id || '') + ' ' + (i.className || '');
    return t === 'search' || /search|find|query/i.test(p);
  }).length;

  const filters = scope.querySelectorAll('select').length;

  const pagination = !!scope.querySelector(
    '[id*="page" i],[class*="pagination" i],[class*="pager" i],[onclick*="Page" i],[onclick*="next" i]',
  );

  /* Action = a control wired to a handler. The handler NAME is what makes two
     surfaces comparable; a raw button count is not. */
  const actions = [...new Set(
    [...scope.querySelectorAll('[onclick]')]
      .map((b) => {
        const m = (b.getAttribute('onclick') || '').match(/([A-Za-z_$][\w$.]*)\s*\(/);
        return m ? m[1] : null;
      })
      .filter(Boolean),
  )];

  const exports = [...scope.querySelectorAll('button,a')]
    .filter((b) => /export|csv|download|\.xlsx/i.test(b.textContent + ' ' + (b.getAttribute('onclick') || ''))).length;

  const tables = scope.querySelectorAll('table').length;

  const ops = (window.__AOS_OPS || []).filter((o) => o.section === arg.section);
  const own = ops.filter((o) => o.src === 'sokoni-aos.js' || o.src === 'admin.html' || o.src === 'unknown');
  const ambient = ops.filter((o) => !(o.src === 'sokoni-aos.js' || o.src === 'admin.html' || o.src === 'unknown'));

  return {
    present: !!el,
    active,
    hasContent: !!el && el.textContent.trim().length > 0,
    textLength: el ? el.textContent.trim().length : 0,
    searchInputs, filters, pagination, exports, tables,
    actions,
    ops: [...new Set(own.map((o) => o.op))],
    ambientOps: [...new Set(ambient.map((o) => o.op + ' <- ' + o.src))],
  };
}

/* ── gstatic modular-SDK stubs ───────────────────────────────────────────────
   admin.html does NOT reach the backend the way AdminOS does. AdminOS calls
   firebase.functions() (the compat global). admin.html and admin-api.js both do:

       await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js')
       m.httpsCallable(fns, name)(data)

   A probe that aborts third-party origins therefore blocks admin.html's ONLY
   callable transport, and the walk reports zero backend operations for every
   pane — a uniform, entirely false result that would have been written up as
   "admin.html invokes no backend". These stubs fulfil those module URLs so the
   real transport is exercised and recorded. */
function gstaticStub(which) {
  const REC = `
const __push = (name, data) => {
  const op = (name === 'adminOsDispatch' && data && data.op) ? data.op : name;
  window.__AOS_OPS = window.__AOS_OPS || [];
  window.__AOS_OPS.push({ callable: name, op, src: 'admin.html', section: window.__AOS_SECTION || 'boot' });
  return { data: {} };
};`;
  if (/functions/.test(which)) {
    return REC + `
export const getFunctions = () => ({ __stub: 'functions' });
export const httpsCallable = (fns, name) => async (data) => __push(name, data);
export const connectFunctionsEmulator = () => {};
export default {};`;
  }
  if (/auth/.test(which)) {
    return `
export const getAuth = () => window.firebaseAuth;
export const onAuthStateChanged = (a, cb) => { try { cb(window.firebaseAuth.currentUser); } catch (e) {} return () => {}; };
export const signOut = async () => {};
export default {};`;
  }
  if (/firestore/.test(which)) {
    return `
const q = new Proxy(() => q, { get: () => q, apply: () => q });
export const getFirestore = () => q;
export const collection = () => q; export const doc = () => q;
export const query = () => q; export const where = () => q; export const orderBy = () => q; export const limit = () => q;
export const getDocs = async () => ({ empty: true, size: 0, docs: [], forEach() {} });
export const getDoc = async () => ({ exists: () => false, data: () => ({}) });
export const onSnapshot = () => () => {};
export const serverTimestamp = () => 'ts';
export default {};`;
  }
  return `
export const initializeApp = () => ({ name: '[DEFAULT]' });
export const getApp = () => ({ name: '[DEFAULT]' });
export const getApps = () => [];
export default {};`;
}

module.exports = { startServer, serveFromDisk, instrumentedModule, compatInit, measurePane, gstaticStub, CLAIMS };
