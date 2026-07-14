/* ─────────────────────────────────────────────────────────────────────────────
   SOKONI — Authenticated Seller QA session (repeatable)

   Beats the auth wall the sanctioned way:
     · serves the real repo files on localhost (Firebase authorizes localhost, and
       sokoni-appcheck.js honours an App Check DEBUG TOKEN only on localhost);
     · pins a debug token registered against the real project;
     · signs in as a real QA seller account through Firebase Auth.

   Nothing in the product is modified, and production App Check still attests via
   reCAPTCHA v3 — the debug token does not work off localhost.
   ───────────────────────────────────────────────────────────────────────────── */
const { chromium, devices } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');

const ROOT = 'c:/Users/USER1/OneDrive/Desktop/SOKONI';
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json',
               '.png':'image/png', '.jpeg':'image/jpeg', '.jpg':'image/jpeg', '.svg':'image/svg+xml',
               '.webp':'image/webp', '.ico':'image/x-icon', '.woff2':'font/woff2' };

const EMAIL = 'qa.seller.test@mysokoni.co.ke';
const PASS  = 'SokoniQA!2026#test';
const PORT  = 8511;

function serve() {
  const srv = http.createServer((q, s) => {
    let p = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]));
    if (!path.extname(p)) p += '.html';
    fs.readFile(p, (e, d) => {
      if (e) { s.writeHead(404); return s.end('404'); }
      s.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream',
                         'Cache-Control': 'no-store' });
      s.end(d);
    });
  });
  return new Promise((r) => srv.listen(PORT, () => r(srv)));
}

/* Returns a Playwright context already signed in as the QA seller. */
async function signedInContext(browser, deviceOpts) {
  const token = fs.readFileSync(path.join(__dirname, 'appcheck-debug-token.txt'), 'utf8').trim();
  const c = await browser.newContext({ ...deviceOpts });
  await c.addInitScript((t) => {
    try { localStorage.setItem('SOKONI_APPCHECK_DEBUG_TOKEN', t); } catch (e) {}
    self.FIREBASE_APPCHECK_DEBUG_TOKEN = t;
  }, token);

  const p = await c.newPage();
  await p.goto(`http://localhost:${PORT}/login.html`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3500);

  /* The sign-in navigates the page away on success, which destroys the evaluate context.
     That rejection IS the success signal; confirm by reading auth state afterwards. */
  await p.evaluate(async ([email, pass]) => {
    const { signInWithEmailAndPassword, setPersistence, browserLocalPersistence } =
      await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
    /* The app defaults to SESSION persistence unless "Remember me" is ticked, and session
       persistence dies with the tab. Force LOCAL so the session survives navigation — this
       is what ticking "Remember me" does, not a change to the product. */
    try { await setPersistence(window.firebaseAuth, browserLocalPersistence); } catch (e) {}
    for (let i = 0; i < 4; i++) {
      try { await signInWithEmailAndPassword(window.firebaseAuth, email, pass); return; }
      catch (e) { await new Promise((r) => setTimeout(r, 3500)); }
    }
  }, [EMAIL, PASS]).catch(() => {});

  await p.waitForTimeout(3000);
  /* Keep the SAME page — the session lives in it. */
  c._qaPage = p;
  return c;
}

async function openSeller(context) {
  const p = context._qaPage || (await context.newPage());
  await p.goto(`http://localhost:${PORT}/seller.html`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(9000);
  return p;
}

module.exports = { serve, signedInContext, openSeller, PORT, EMAIL };

/* Run directly: prove the session reaches the dashboard. */
if (require.main === module) {
  (async () => {
    const srv = await serve();
    const b = await chromium.launch();
    const c = await signedInContext(b, devices['iPhone 13']);
    const p = await openSeller(c);

    const r = await p.evaluate(() => ({
      path: location.pathname,
      signedIn: !!(window.firebaseAuth && window.firebaseAuth.currentUser),
      email: window.firebaseAuth && window.firebaseAuth.currentUser
             ? window.firebaseAuth.currentUser.email : null,
      gate: !!document.getElementById('sokoni-auth-gate'),
      bodyText: (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    })).catch((e) => ({ err: e.message.split('\n')[0] }));

    console.log(JSON.stringify(r, null, 2));
    await p.screenshot({ path: path.join(__dirname, 'qa-seller.png') });
    console.log('screenshot -> qa-seller.png');
    await b.close(); srv.close(); process.exit(0);
  })();
}
