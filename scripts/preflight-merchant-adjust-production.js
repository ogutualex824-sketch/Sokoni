/* Pre-flight for verify-merchant-adjust-production.js — everything the harness
   depends on EXCEPT the credentials. Run so an operator's token is not spent
   discovering a harness bug. */
const { webkit } = require('playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
const ROOT = require('path').resolve(__dirname, '..');
const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png' };
let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : '')); ok ? pass++ : fail++; };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  let f = path.join(ROOT, p);
  if (!fs.existsSync(f) && fs.existsSync(f + '.html')) f += '.html';
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'text/plain' });
  fs.createReadStream(f).pipe(res);
});
server.listen(0, '127.0.0.1', async () => {
  const BASE = 'http://127.0.0.1:' + server.address().port;
  console.log('\nPRE-FLIGHT — harness dependencies (no credentials needed)');
  console.log('='.repeat(70));
  const b = await webkit.launch();
  const ctx = await b.newContext();
  await ctx.addInitScript(({ t }) => {
    try { localStorage.setItem('SOKONI_APPCHECK_DEBUG_TOKEN', t); self.FIREBASE_APPCHECK_DEBUG_TOKEN = t;
          localStorage.setItem('loggedIn', 'true'); } catch (_) {}
  }, { t: '00000000-0000-4000-8000-000000000000' });
  const page = await ctx.newPage();
  await page.goto(BASE + '/merchant-v2', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(5000);

  const r = await page.evaluate(async () => {
    const out = {};
    try {
      const app = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js');
      out.sdkLoads = true;
      out.appCount = app.getApps().length;
      out.projectId = out.appCount ? (app.getApp().options || {}).projectId : null;
      const fn = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js');
      out.fnSdk = typeof fn.httpsCallable === 'function' && typeof fn.getFunctions === 'function';
      if (out.appCount) {
        const c = fn.httpsCallable(fn.getFunctions(app.getApp()), 'merchantAdjustStock');
        out.callableBuilt = typeof c === 'function';
        out.region = (fn.getFunctions(app.getApp()) || {}).region || 'default';
      }
      const fsm = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      out.firestoreSdk = typeof fsm.getFirestore === 'function' && typeof fsm.query === 'function'
                       && typeof fsm.where === 'function' && typeof fsm.limit === 'function';
      const auth = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
      out.authSdk = typeof auth.signInWithEmailAndPassword === 'function';
      out.debugTokenSeen = localStorage.getItem('SOKONI_APPCHECK_DEBUG_TOKEN') ? true : false;
    } catch (e) { out.err = (e && e.message || '').slice(0, 160); }
    return out;
  });

  ck('the harness page serves and loads', !r.err, r.err || 'ok');
  ck('firebase-app SDK imports', !!r.sdkLoads);
  ck('a Firebase app is initialised on the page', r.appCount > 0, 'apps=' + r.appCount + ' project=' + r.projectId);
  ck('project is sokoni-aeb26 (production)', r.projectId === 'sokoni-aeb26', String(r.projectId));
  ck('firebase-functions SDK imports', !!r.fnSdk);
  ck('a merchantAdjustStock callable can be constructed', !!r.callableBuilt, 'region=' + r.region);
  ck('firebase-firestore SDK + query/where/limit available', !!r.firestoreSdk);
  ck('firebase-auth signInWithEmailAndPassword available', !!r.authSdk);
  ck('the injected App Check debug token is visible to the page', !!r.debugTokenSeen);

  await b.close(); server.close();
  console.log('\n' + '='.repeat(70));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('='.repeat(70) + '\n');
  process.exit(fail ? 1 : 0);
});
