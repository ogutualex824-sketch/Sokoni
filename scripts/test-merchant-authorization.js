#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   ORDINARY-MERCHANT AUTHORIZATION — what an approved seller may NOT reach
   ------------------------------------------------------------------------------
   The containment gate proves the Merchant shell holds together. It cannot prove
   authorization, because the account it runs as carries admin:true and
   superAdmin:true — every permission check it passes is passed for the wrong
   reason. It says so itself and reports NOT EVALUATED.

   This suite exists to close that gap, and it is worthless unless the identity is
   ORDINARY. So the identity is checked FIRST and the run is refused outright if the
   account is elevated. A superAdmin sailing through these assertions would produce a
   green certificate that means nothing.

   READ-ONLY, DELIBERATELY. Every assertion below is a read. Proving a merchant
   cannot WRITE somewhere would mean attempting a write against production, and a
   test that mutates production to prove it cannot mutate production is not a test
   worth having. Write-path authorization needs the emulator with the real ruleset,
   which is a separate piece of work and is named as such in the report.

   BOTH DIRECTIONS. Denials alone would pass for an account that can read nothing at
   all — a broken or unapproved seller would look perfectly secure. So the positive
   controls run too: the merchant must still reach their own shop and their own
   products. Security that also removes legitimate access is a different defect, not
   a success.

     APPCHECK_DEBUG_TOKEN     see docs/APPCHECK_DEBUG_TOKEN_LEDGER.md
     MERCHANT_STD_EMAIL       an APPROVED seller with NO admin/superAdmin claim
     MERCHANT_STD_PASSWORD

   Deliberately NOT the same variables the containment gate uses. Sharing them would
   make it far too easy to point this suite at the superAdmin account by accident and
   collect a meaningless pass.

     node scripts/test-merchant-authorization.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const { webkit } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TOKEN    = process.env.APPCHECK_DEBUG_TOKEN || '';
const EMAIL    = process.env.MERCHANT_STD_EMAIL || '';
const PASSWORD = process.env.MERCHANT_STD_PASSWORD || '';

const PLACEHOLDER = (v) => !v || /^<.*>$/.test(v) || /^(YOUR|THE)[_-]/i.test(v) ||
                           /^(password|changeme|xxx+)$/i.test(v);

const skip = (why, extra) => {
  console.log('\n' + '='.repeat(74));
  console.log('  SKIPPED — NOT A PASS. AUTHORIZATION REMAINS UNPROVEN.');
  console.log('='.repeat(74));
  console.log('  ' + why);
  if (extra) extra.forEach((l) => console.log('  ' + l));
  console.log('\n  PowerShell:');
  console.log('    $env:APPCHECK_DEBUG_TOKEN  = "<value>"   # docs/APPCHECK_DEBUG_TOKEN_LEDGER.md');
  console.log('    $env:MERCHANT_STD_EMAIL    = "<approved seller, NOT an admin>"');
  console.log('    $env:MERCHANT_STD_PASSWORD = Read-Host "password"   # run that line alone');
  console.log('    node scripts/test-merchant-authorization.js');
  console.log('='.repeat(74) + '\n');
  process.exit(0);
};

if (PLACEHOLDER(TOKEN) || PLACEHOLDER(EMAIL) || PLACEHOLDER(PASSWORD)) {
  skip('Missing: ' + [PLACEHOLDER(TOKEN) && 'APPCHECK_DEBUG_TOKEN',
                      PLACEHOLDER(EMAIL) && 'MERCHANT_STD_EMAIL',
                      PLACEHOLDER(PASSWORD) && 'MERCHANT_STD_PASSWORD'].filter(Boolean).join(', '),
    ['', 'This suite never degrades into a weaker run. Without an ordinary approved',
         'seller there is nothing here that could be certified.']);
}

const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css',
  '.png':'image/png', '.json':'application/json', '.svg':'image/svg+xml',
  '.jpg':'image/jpeg', '.webp':'image/webp', '.ico':'image/x-icon', '.woff2':'font/woff2' };

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
  console.log('    ' + (ok ? 'PASS  ' : 'FAIL  ') + label +
              (detail ? '   [' + String(detail).replace(/\s+/g,' ').slice(0,100) + ']' : ''));
  if (ok) pass++; else { fail++; failures.push(label + (detail ? '  → ' + detail : '')); }
  return ok;
};
const head = (t) => console.log('\n── ' + t + ' ──');

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  let f = path.join(ROOT, p);
  if (!path.extname(p)) f += '.html';
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'text/plain' });
    res.end(d);
  });
});

const wd = setTimeout(() => { console.log('\nWATCHDOG — exceeded 10 min'); process.exit(1); }, 600000);
wd.unref && wd.unref();

server.listen(0, async () => {
  const BASE = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try { browser = await webkit.launch(); }
  catch (e) { console.log('SKIP — webkit unavailable: ' + (e && e.message)); server.close(); process.exit(0); return; }

  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
  await ctx.addInitScript((t) => { try { localStorage.setItem('SOKONI_APPCHECK_DEBUG_TOKEN', t); } catch (e) {} }, TOKEN);
  const page = await ctx.newPage();

  console.log('\n' + '='.repeat(74));
  console.log('  ORDINARY-MERCHANT AUTHORIZATION  (read-only, PRODUCTION rules)');
  console.log('='.repeat(74));

  /* ── 1 · attestation ─────────────────────────────────────────────────────── */
  head('1 · App Check attested (precondition)');
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => null);
  await page.waitForFunction(() => typeof window.__sokoniAppCheckState === 'string', null, { timeout: 25000 }).catch(() => null);
  await page.waitForTimeout(3000);
  const ac = await page.evaluate(() => window.__sokoniAppCheckState);
  if (!ck('App Check exchanged', ac === 'exchanged', 'state=' + ac)) {
    console.log('\n  ABORTING — unattested reads return empty CACHE hits that do not throw.');
    console.log('  Every "denied" below would be indistinguishable from "never asked".\n');
    clearTimeout(wd); await browser.close(); server.close(); process.exit(1);
  }

  /* ── 2 · sign in ─────────────────────────────────────────────────────────── */
  head('2 · authenticated as the ordinary seller');
  const auth = await page.evaluate(async ({ email, password }) => {
    try {
      const [{ getApps, getApp }, A] = await Promise.all([
        import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'),
        import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js')]);
      if (!getApps().length) return { ok:false, why:'no Firebase app' };
      const cred = await A.signInWithEmailAndPassword(A.getAuth(getApp()), email, password);
      const tok = await cred.user.getIdTokenResult().catch(() => null);
      return { ok:true, uid: cred.user.uid, claims: tok ? tok.claims : {} };
    } catch (e) { return { ok:false, why:(e && (e.code || e.message)) || String(e) }; }
  }, { email: EMAIL, password: PASSWORD });

  if (!auth.ok) {
    console.log('    FAIL  signed in   [' + auth.why + ']');
    console.log('\n  ABORTING — no session.\n');
    clearTimeout(wd); await browser.close(); server.close(); process.exit(1);
  }
  ck('signed in against production', true, 'uid=' + auth.uid);

  /* ── 3 · THE IDENTITY MUST BE ORDINARY ───────────────────────────────────── */
  head('3 · the identity is fit to certify with');
  const c = auth.claims || {};
  const STD = ['iss','aud','auth_time','user_id','sub','iat','exp','email','email_verified',
               'firebase','phone_number','name','picture'];
  const custom = {};
  Object.keys(c).forEach((k) => { if (STD.indexOf(k) === -1) custom[k] = c[k]; });
  console.log('    NOTE  custom claims: ' + (Object.keys(custom).length ? JSON.stringify(custom) : '(none)'));

  const elevated = c.admin === true || c.superAdmin === true;
  const isSeller = c.seller === true ||
                   (Array.isArray(c.roles) && c.roles.some((r) => /seller|merchant/i.test(String(r))));

  /* Refused, not failed. An elevated account is not a defect — it is the WRONG
     SUBJECT, and every assertion below would be answered for the wrong reason. */
  if (elevated) {
    clearTimeout(wd); await browser.close(); server.close();
    skip('This account carries ' + (c.admin ? 'admin ' : '') + (c.superAdmin ? 'superAdmin ' : '') +
         '— it is NOT an ordinary merchant.',
      ['', 'Reading securityEvents or every user is CORRECT behaviour for it, so a pass',
           'here would certify nothing and a failure would be a false alarm.',
           '', 'Supply a plain approved seller: seller=true, and no admin/superAdmin claim.']);
  }
  ck('identity is NOT admin/superAdmin', !elevated);
  if (!ck('identity carries seller authority', isSeller,
          'seller=' + c.seller + ' roles=' + JSON.stringify(c.roles))) {
    clearTimeout(wd); await browser.close(); server.close();
    skip('This account is not an approved seller, so merchant authorization cannot be certified with it.');
  }

  /* ── 4 · the reads a merchant MUST NOT reach ─────────────────────────────── */
  head('4 · denied: platform-scoped data (read-only assertions)');
  const probe = await page.evaluate(async () => {
    const [{ getApp }, F] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js')]);
    const db = F.getFirestore(getApp());
    const uid = window.firebaseAuth.currentUser.uid;

    const listQ = async (coll) => {
      try {
        const s = await F.getDocs(F.query(F.collection(db, coll), F.limit(2)));
        return { denied:false, size:s.size, fromCache:s.metadata.fromCache };
      } catch (e) { return { denied:true, code:(e && e.code) || String(e) }; }
    };
    const getD = async (coll, id) => {
      try {
        const s = await F.getDoc(F.doc(db, coll, id));
        return { denied:false, exists:s.exists(), fromCache:s.metadata.fromCache };
      } catch (e) { return { denied:true, code:(e && e.code) || String(e) }; }
    };

    return {
      uid,
      users_list:        await listQ('users'),
      securityEvents:    await listQ('securityEvents'),
      commissionLedger:  await listQ('commissionLedger'),
      payoutRequests:    await listQ('payoutRequests'),
      own_user:          await getD('users', uid),
      own_shop:          await getD('shops', uid),
      own_products:      await (async () => {
        try {
          const s = await F.getDocs(F.query(F.collection(db, 'products'),
            F.where('sellerUid', '==', uid), F.limit(5)));
          return { denied:false, size:s.size, fromCache:s.metadata.fromCache };
        } catch (e) { return { denied:true, code:(e && e.code) || String(e) }; }
      })(),
    };
  });

  /* A cache hit is not an answer. Without a backend round trip "denied" and "never
     asked" are the same observation, which is how an unattested run manufactures a
     clean security report. */
  const real = (r) => r.denied || r.fromCache === false;

  [['users_list',       'every user'],
   ['securityEvents',   'securityEvents (isAdmin only)'],
   ['commissionLedger', 'commissionLedger (isAdmin only)'],
   ['payoutRequests',   'all payoutRequests (isAdmin, or own sellerUid only)'],
  ].forEach(([key, label]) => {
    const r = probe[key];
    ck('an ordinary merchant cannot list ' + label, r.denied === true,
       r.denied ? r.code : 'READ SUCCEEDED size=' + r.size + ' fromCache=' + r.fromCache);
    if (!r.denied) ck('  ↳ and the read actually reached the backend', real(r),
                      'fromCache=' + r.fromCache + ' — a cache hit proves nothing either way');
  });

  /* ── 5 · what the merchant MUST still reach ──────────────────────────────── */
  head('5 · allowed: the merchant\'s own data');
  ck('can read own user document', probe.own_user.denied === false,
     probe.own_user.denied ? probe.own_user.code : 'exists=' + probe.own_user.exists);
  ck('own user read reached the backend', real(probe.own_user), 'fromCache=' + probe.own_user.fromCache);
  ck('can read own shop document', probe.own_shop.denied === false,
     probe.own_shop.denied ? probe.own_shop.code : 'exists=' + probe.own_shop.exists);
  ck('can read own products', probe.own_products.denied === false,
     probe.own_products.denied ? probe.own_products.code : 'n=' + probe.own_products.size);

  /* ── report ──────────────────────────────────────────────────────────────── */
  console.log('\n' + '='.repeat(74));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('='.repeat(74));
  if (fail) { console.log('\n  FAILURES:'); failures.forEach((f) => console.log('    ✗ ' + f)); }
  console.log('\n  SCOPE: read-path authorization only, against production rules.');
  console.log('  WRITE-path authorization is NOT covered — proving a merchant cannot write');
  console.log('  somewhere would mean attempting writes against production. That belongs on');
  console.log('  the Firestore emulator with the real ruleset, and remains outstanding.\n');

  clearTimeout(wd);
  await browser.close(); server.close();
  process.exit(fail ? 1 : 0);
});
