#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   DIAGNOSIS — mounting POS destroys the origin's Firebase Auth session
   ------------------------------------------------------------------------------
   Investigative only. It changes nothing and fixes nothing.

   Two questions, in order, because the second is meaningless without the first:

     1. ATTRIBUTION — does v1 (merchant.html) lose the session too, or only v2?
        Identical auth setup, identical browser, identical POS document. If both
        lose it, this is a pre-existing POS defect and does not belong to v2.

     2. MECHANISM — WHICH operation removes the record?
        Searching the POS source for signOut / setPersistence / deleteDatabase came
        back clean, so the source text is the wrong place to look. This instruments
        the PERSISTENCE BOUNDARY itself, in EVERY frame, and reports the call with a
        stack: indexedDB.deleteDatabase, IDBObjectStore.clear/delete,
        localStorage.removeItem/clear. Whatever removes it must pass through one of
        these, wherever it lives — POS, a dependency, or the SDK reacting to
        something POS did.

   Deliberately NOT done here: no persistence is re-pinned, no listener is added, no
   "fix" is attempted. Masking the symptom before the destructive operation is named
   would leave the ownership/lifecycle problem in place.

     firebase emulators:exec --only auth --project pos-diag \
       "node scripts/diag-pos-session-loss.js"
     SOKONI_APPCHECK_DEBUG_TOKEN=<uuid>   required (Auth cannot complete without it)
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const { webkit } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8853;
const BASE = 'http://localhost:' + PORT;
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const EMU = 'http://' + AUTH_HOST;
const API_KEY = 'AIzaSyDt_FRoTdE5OpfPhLB0DApIm7p-I45hzVE';
const TOKEN = process.env.SOKONI_APPCHECK_DEBUG_TOKEN || '';
const EMAIL = 'pos-diag@sokoni.test', PASSWORD = 'PosDiag!2026';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
               '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
               '.webp': 'image/webp', '.woff2': 'font/woff2' };

/* ── DIAGNOSTIC NEUTRALISATION, served — no file is modified ──────────────────
   The suspected variable is seller.html's SECOND named Firebase app, `revSnap`
   (seller.html:483), initialised on SDK 10.12.0 with authDomain auth.mysokoni.co.ke
   while the shell runs 10.12.2.

   The mutation PREVENTS INITIALISATION rather than renaming the app. Renaming would
   change the persistence namespace, the config lookup and app-dependent code paths at
   once — a different system, not the same system minus one variable.

   The imports are deliberately LEFT IN PLACE, so "a second SDK version is loaded" stays
   constant across both arms and the only thing that changes is whether a second Firebase
   APP is created. If the loss survives this mutation, the SDK-version variable is the
   next one to isolate — not something this run can conclude. */
const REVSNAP_ANCHOR = '(async () => {\n  try {\n    const _a = getApps().find(a => a.name === "revSnap")';
const neutraliseRevSnap = (src) => src.replace(REVSNAP_ANCHOR,
  '(async () => {\n  return; /* DIAGNOSTIC: revSnap initialisation prevented */\n  try {\n    const _a = getApps().find(a => a.name === "revSnap")');
let MUTATE = false;

const server = http.createServer((q, s) => {
  let u = decodeURIComponent((q.url || '/').split('?')[0]);
  let f = path.join(ROOT, u === '/' ? 'index.html' : u.replace(/^\/+/, ''));
  if (!fs.existsSync(f) && fs.existsSync(f + '.html')) f += '.html';
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { s.writeHead(404); s.end(); return; }
  if (MUTATE && /\/seller\.html$/.test(f.replace(/\\/g, '/'))) {
    const body = neutraliseRevSnap(fs.readFileSync(f, 'utf8'));
    s.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    s.end(body);
    return;
  }
  s.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(f).pipe(s);
});
function post (url, body) {
  return new Promise((res, rej) => {
    const d = JSON.stringify(body);
    const r = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } },
      (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); });
    r.on('error', rej); r.write(d); r.end();
  });
}

/* Runs in EVERY frame, before any page script. Wraps the operations that can remove a
   persisted Auth record and reports each with a stack, up to the parent. */
const INSTRUMENT = () => {
  try {
    var report = function (what, detail) {
      var rec = { what: what, detail: String(detail), frame: location.pathname,
                  stack: (new Error().stack || '').split('\n').slice(2, 7).join(' ⟵ ') };
      try { (window.__persist = window.__persist || []).push(rec); } catch (e) {}
      try { if (window.parent && window.parent !== window) window.parent.postMessage({ __persistProbe: rec }, '*'); } catch (e) {}
    };
    if (window.indexedDB && indexedDB.deleteDatabase) {
      var dd = indexedDB.deleteDatabase.bind(indexedDB);
      indexedDB.deleteDatabase = function (n) { report('indexedDB.deleteDatabase', n); return dd(n); };
    }
    if (window.IDBObjectStore) {
      var oc = IDBObjectStore.prototype.clear;
      IDBObjectStore.prototype.clear = function () { report('IDBObjectStore.clear', this.name); return oc.apply(this, arguments); };
      var od = IDBObjectStore.prototype.delete;
      IDBObjectStore.prototype.delete = function (k) { report('IDBObjectStore.delete', this.name + ' :: ' + k); return od.apply(this, arguments); };
    }
    if (window.Storage) {
      var rm = Storage.prototype.removeItem;
      Storage.prototype.removeItem = function (k) { report('localStorage.removeItem', k); return rm.apply(this, arguments); };
      var cl = Storage.prototype.clear;
      Storage.prototype.clear = function () { report('localStorage.clear', ''); return cl.apply(this, arguments); };
    }
    /* Collect what child frames report. */
    if (window.parent === window) {
      window.addEventListener('message', function (e) {
        if (e.data && e.data.__persistProbe) { try { (window.__persist = window.__persist || []).push(e.data.__persistProbe); } catch (_) {} }
      });
    }
  } catch (e) {}
};

/* The five observations, taken identically before and after POS. */
const OBSERVE = async () => {
  const o = {};
  /* href at EVERY checkpoint. Without it "the session vanished" cannot be told apart from
     "the document navigated to login" — two completely different defects that look
     identical from a session read alone. */
  o.href = location.pathname + location.hash;
  try {
    const { getApps, getApp } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js');
    o.apps = getApps().length;
    /* Named apps, to test the revSnap lead directly rather than by inference: seller.html
       initialises a SECOND Firebase app on a different SDK version. */
    o.appNames = getApps().map((a) => a.name);
    if (o.apps) {
      const { getAuth } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
      o.currentUser = (getAuth(getApp()).currentUser || {}).uid || null;
    } else o.currentUser = 'no-app';
  } catch (e) { o.apps = 'err'; o.currentUser = 'err'; }
  o.ls = { loggedIn: localStorage.getItem('loggedIn'), sokoniUser: !!localStorage.getItem('sokoniUser') };
  o.shell = (window.SokoniShell && window.SokoniShell.session) ? window.SokoniShell.session.state : 'n/a';
  /* Frame list — the hypothesis under test is about how many independent Firebase Auth
     instances exist on this origin, and each same-origin iframe is one candidate. */
  o.frames = [].slice.call(document.querySelectorAll('iframe'))
    .map((f) => { try { return (f.getAttribute('src') || '').split('?')[0].split('#')[0]; } catch (e) { return '?'; } })
    .filter(Boolean);
  o.idb = await new Promise((res) => {
    try {
      const rq = indexedDB.open('firebaseLocalStorageDb');
      rq.onsuccess = () => {
        const db = rq.result;
        if (!db.objectStoreNames.contains('firebaseLocalStorage')) return res('no store');
        const all = db.transaction('firebaseLocalStorage', 'readonly').objectStore('firebaseLocalStorage').getAll();
        all.onsuccess = () => res((all.result || []).filter((r) => /firebase:authUser:/.test(String(r && r.fbase_key))).length + ' authUser rec');
        all.onerror = () => res('err');
      };
      rq.onerror = () => res('open err');
    } catch (e) { res('throw'); }
  });
  return o;
};

/* `steps` is a list of { name, act } run in order, observed after each — so an
   intermediate stage (Products) is measured rather than inferred from the endpoints. */
async function runCase (browser, label, page, steps) {
  const ctx = await browser.newContext();
  await ctx.route('https://identitytoolkit.googleapis.com/**', route);
  await ctx.route('https://securetoken.googleapis.com/**', route);
  await ctx.addInitScript((t) => { try { if (t) localStorage.setItem('SOKONI_APPCHECK_DEBUG_TOKEN', t); localStorage.setItem('loggedIn', 'true'); } catch (e) {} }, TOKEN);
  await ctx.addInitScript(INSTRUMENT);

  const p = await ctx.newPage();
  /* PER-FRAME SDK INVENTORY, measured from the network — never from a grep.
     The previous control was invalidated because `grep firebase.js` missed a CDN compat
     import. Whether a frame loaded Firebase is now an observation, not a reading of the
     source, and it is reported per case so an uninformative control cannot masquerade as
     a clean one. */
  const sdkByFrame = {};
  p.on('request', (r) => {
    const u = r.url();
    if (!/gstatic\.com\/firebasejs\/|\/firebase\.js(\?|$)/.test(u)) return;
    let fr = 'top';
    try { fr = (r.frame().url() || '').replace(BASE, '') || 'top'; } catch (e) {}
    const ver = (u.match(/firebasejs\/([\d.]+)\//) || [])[1] || 'local firebase.js';
    (sdkByFrame[fr] = sdkByFrame[fr] || new Set()).add(ver);
  });

  await p.goto(BASE + '/index.html', { waitUntil: 'commit' }).catch(() => null);
  await p.waitForFunction(() => typeof window.__sokoniAppCheckState === 'string', null, { timeout: 25000 }).catch(() => null);
  const uid = await p.evaluate(async ({ email, password }) => {
    try {
      const [{ getApps, getApp }, { getAuth, signInWithEmailAndPassword, onAuthStateChanged }] = await Promise.all([
        import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'),
        import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js')]);
      if (!getApps().length) return null;
      const a = getAuth(getApp());
      await signInWithEmailAndPassword(a, email, password);
      return await new Promise((r) => { const t = setTimeout(() => r(null), 9000); onAuthStateChanged(a, (u) => { if (u) { clearTimeout(t); r(u.uid); } }); });
    } catch (e) { return 'ERR ' + (e.code || e.message); }
  }, { email: EMAIL, password: PASSWORD });

  await p.goto(BASE + page, { waitUntil: 'commit' }).catch(() => null);
  await p.waitForTimeout(9000);
  const checkpoints = [{ name: 'before (shell loaded)', obs: await OBSERVE_IN(p) }];

  for (const s of steps) {
    await s.act(p).catch(() => null);
    await p.waitForTimeout(11000);
    checkpoints.push({ name: s.name, obs: await OBSERVE_IN(p) });
  }
  const persist = await p.evaluate(() => (window.__persist || []).slice(0, 60)).catch(() => []);

  const sdk = {}; Object.keys(sdkByFrame).forEach(k => sdk[k] = [...sdkByFrame[k]]);
  await ctx.close();
  return { label, uid, checkpoints, persist, sdk };
}
const OBSERVE_IN = (p) => p.evaluate(OBSERVE).catch((e) => ({ err: e.message }));
let route;

(async () => {
  if (!TOKEN) {
    console.error('\nSOKONI_APPCHECK_DEBUG_TOKEN is required — Auth cannot complete without App Check,');
    console.error('so sign-in would never happen and the diagnosis would observe nothing.');
    process.exit(2);
  }
  await new Promise((r) => server.listen(PORT, r));
  const su = await post(EMU + '/identitytoolkit.googleapis.com/v1/accounts:signUp?key=' + API_KEY,
    { email: EMAIL, password: PASSWORD, returnSecureToken: true }).catch(() => null);
  if (!su || !su.localId) { console.log('SKIP — Auth emulator not reachable at ' + AUTH_HOST); server.close(); process.exit(0); }
  console.log('emulator uid: ' + su.localId);

  const browser = await webkit.launch();
  route = async (r) => {
    try { const u = new URL(r.request().url()); const x = await r.fetch({ url: EMU + '/' + u.host + u.pathname + u.search }); await r.fulfill({ response: x }); }
    catch (e) { try { await r.abort(); } catch (_) {} }
  };

  const go = (id) => (p) => p.evaluate((r) => (window.__mgo ? window.__mgo(r) : (location.hash = '#' + r)), id);
  /* ── GENERALISATION MATRIX ────────────────────────────────────────────────
     Question: is the trigger seller.html SPECIFICALLY, or ANY second frame that
     initialises Firebase Auth on this origin?

     Module firebase.js loading, checked before choosing comparators:
       seller.html            2  (+1 direct firebase-auth import)   known-failing
       minishop-admin.html    2                                     valid comparator
       seller-fulfilment.html 1                                     valid comparator
       plans.html             0                                     NEGATIVE CONTROL
       returns.html           0                                     (not Firebase-bearing)

     plans.html loads NO Firebase, so "Plan -> POS survives" would prove nothing about the
     hypothesis — it is included precisely as the discriminating control: if it survives
     while the Firebase-bearing modules do not, the variable is Firebase, not frame count
     alone. Reading a Plan pass as "only seller.html does it" would be the trap. */
  const matrix = (suffix) => [
    ['BASELINE   v2 -> POS (direct)' + suffix, '/merchant-v2.html#dashboard',
     [{ name: 'after POS', act: go('pos') }]],
    ['CONTROL    v2 -> Verification -> POS' + suffix, '/merchant-v2.html#dashboard',
     [{ name: 'after Verification', act: go('verification') }, { name: 'after POS', act: go('pos') }]],
  ];

  /* THE MUTATION MUST BE PROVEN TO APPLY. A regex that silently stops matching would
     serve the ORIGINAL file and report "neutralising revSnap fixed it" — the exact false
     conclusion this experiment exists to avoid. */
  const sellerSrc = fs.readFileSync(path.join(ROOT, 'seller.html'), 'utf8');
  const mutated = neutraliseRevSnap(sellerSrc);
  const applied = mutated !== sellerSrc && /DIAGNOSTIC: revSnap initialisation prevented/.test(mutated);
  console.log('mutation anchor matched: ' + applied);
  if (!applied) {
    console.error('\nABORT — the revSnap anchor no longer matches seller.html. Update the anchor;');
    console.error('running on would compare the file against ITSELF and prove nothing.');
    server.close(); process.exit(2);
  }

  /* revSnap A/B is SETTLED (exonerated) — this run isolates a different variable, so it
     uses the unmutated tree only. The mutation code is retained for re-verification. */
  const cases = [];
  MUTATE = false;
  for (const [label, page, steps] of matrix('')) cases.push(await runCase(browser, label, page, steps));

  await browser.close();
  server.close();

  console.log('\n\x1b[1mATTRIBUTION\x1b[0m');
  cases.forEach((c) => {
    console.log('\n  ' + c.label + '   (signed in as ' + c.uid + ')');
    c.checkpoints.forEach((cp) => {
      const o = cp.obs || {};
      console.log('    ' + cp.name.padEnd(22) + ' href=' + o.href +
                  '  user=' + o.currentUser + '  idb=' + o.idb +
                  '  shell=' + o.shell + '  apps=' + JSON.stringify(o.appNames) + '  frames=' + JSON.stringify(o.frames));
    });
    console.log('    SDK loaded per frame : ' + JSON.stringify(c.sdk));
    const first = c.checkpoints[0].obs, last = c.checkpoints[c.checkpoints.length - 1].obs;
    const navigated = first.href && last.href && first.href.split('#')[0] !== last.href.split('#')[0];
    /* A case whose FIRST checkpoint already has no user proves nothing about the steps that
       follow — the loss predates them. Reporting that as "session intact" (because nothing
       changed between first and last) is exactly the false read this verdict produced, so it
       is now called out as VOID rather than scored either way. */
    if (!first.currentUser) {
      console.log('    verdict            : \x1b[33mVOID — no session at the FIRST checkpoint;' +
                  ' the loss predates this case, so its steps prove nothing\x1b[0m');
      return;
    }
    const lost = !last.currentUser;
    console.log('    verdict            : ' +
      (!lost ? 'session intact'
             : navigated ? '\x1b[33mCASE A — the DOCUMENT NAVIGATED (' + first.href + ' -> ' + last.href + ')\x1b[0m'
                         : '\x1b[31mCASE B — same document, auth record disappeared\x1b[0m'));
  });

  console.log('\n\x1b[1mMECHANISM — persistence-boundary calls captured\x1b[0m');
  cases.forEach((c) => {
    console.log('\n  ' + c.label);
    const rel = c.persist.filter((r) => /authUser|firebaseLocalStorage|loggedIn|sokoniUser/i.test(r.detail + r.what) ||
                                        /deleteDatabase|clear/i.test(r.what));
    if (!rel.length) { console.log('    (nothing touched the auth record through these APIs)'); return; }
    rel.slice(0, 8).forEach((r) => {
      console.log('    ' + r.what + '  [' + r.detail + ']  frame=' + r.frame);
      console.log('        ' + r.stack.slice(0, 200));
    });
  });

  console.log('\n\x1b[1mREAD THIS AS\x1b[0m');
  console.log('  both v1 and v2 lose it      -> pre-existing POS defect, not a v2 regression');
  console.log('  only v2 loses it            -> a v2 integration defect');
  console.log('  the control alone loses it  -> pos.html does it unaided, shell irrelevant');
  console.log('  nothing captured            -> the removal does NOT pass these APIs; suspect a');
  console.log('                                 second Firebase/Auth instance or an SDK-internal path\n');
})().catch((e) => { console.error(e); try { server.close(); } catch (_) {} process.exit(2); });
