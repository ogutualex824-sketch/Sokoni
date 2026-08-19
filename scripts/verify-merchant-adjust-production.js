/* ══════════════════════════════════════════════════════════════════════════════
   merchantAdjustStock — PRODUCTION RUNTIME VERIFICATION
   ══════════════════════════════════════════════════════════════════════════════
   "Deploy succeeded" is not proof. This makes a REAL authenticated request to the
   DEPLOYED callable, as a REAL approved seller, against PRODUCTION Firestore, and
   asserts what actually changed.

     real approved seller -> merchantAdjustStock -> App Check accepted
       -> sellerUid ownership accepted -> transaction -> stock changes
       -> inventoryVersion changes -> updatedAt changes -> sold UNCHANGED

   plus the refusals:  wrong owner DENIED · missing key DENIED · duplicate
   adjustmentId IDEMPOTENT.

   ── THIS WRITES TO PRODUCTION ──────────────────────────────────────────────
   It moves a real product's stock. It is SELF-REVERSING: +1 then -1 through the
   same authority, and it fails loudly if the final stock does not equal the
   starting stock. What it CANNOT undo is the audit trail — two `stockMovements`
   documents remain, by design, because a correction that left no record would
   defeat the point of the function. `inventoryVersion` also advances and does
   not come back down. Both are correct behaviour, not damage, but they are real
   and this says so before doing it.

   Nothing runs without --confirm.

   ── WHY A BROWSER ──────────────────────────────────────────────────────────
   The callable enforces App Check. Attestation cannot be produced from bare
   Node, so this uses the mechanism already proven for the authenticated
   certification runs: serve the repo on localhost, inject a registered App Check
   DEBUG token, and drive a real page that boots the production Firebase app.
   Mint the token, run, then REVOKE it and record both in
   docs/APPCHECK_DEBUG_TOKEN_LEDGER.md.

   ── REQUIRED ENV ───────────────────────────────────────────────────────────
     SOKONI_APPCHECK_DEBUG_TOKEN   registered debug token (uuid)
     SOKONI_SELLER_EMAIL           a REAL APPROVED seller
     SOKONI_SELLER_PASSWORD
     SOKONI_TEST_PRODUCT_ID        optional — otherwise one owned product is
                                   discovered by query

   Run: node scripts/verify-merchant-adjust-production.js --confirm
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const { webkit } = require('playwright');
const http = require('http');
const fs   = require('fs');
const path = require('path');

const ROOT  = path.resolve(__dirname, '..');
const TOKEN = process.env.SOKONI_APPCHECK_DEBUG_TOKEN || '';
const EMAIL = process.env.SOKONI_SELLER_EMAIL || '';
const PASS  = process.env.SOKONI_SELLER_PASSWORD || '';
const FIXED = process.env.SOKONI_TEST_PRODUCT_ID || '';
const MIME  = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css',
                '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png' };

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
  return ok;
};

console.log('\nmerchantAdjustStock — PRODUCTION RUNTIME VERIFICATION');
console.log('='.repeat(78));

/* ── Fail closed. Every one of these is required, and a missing one must stop the
      run rather than silently produce a green that proves nothing. ── */
const missing = [];
if (!TOKEN) missing.push('SOKONI_APPCHECK_DEBUG_TOKEN');
if (!EMAIL) missing.push('SOKONI_SELLER_EMAIL');
if (!PASS)  missing.push('SOKONI_SELLER_PASSWORD');
if (!process.argv.includes('--confirm')) missing.push('--confirm (this WRITES to production)');
if (missing.length) {
  console.error('\n  FAIL CLOSED — not run. Missing:\n');
  missing.forEach(m => console.error('    · ' + m));
  console.error('\n  App Check is enforced on this callable, so a registered debug token is');
  console.error('  required or every call is refused before it reaches the function.');
  console.error('  Mint one, run, then REVOKE it and record both in');
  console.error('  docs/APPCHECK_DEBUG_TOKEN_LEDGER.md.\n');
  process.exit(2);
}
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(TOKEN)) {
  console.error('\n  FAIL CLOSED — SOKONI_APPCHECK_DEBUG_TOKEN is not a uuid.\n');
  process.exit(2);
}

(async () => {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    let f = path.join(ROOT, p);
    if (!fs.existsSync(f) && fs.existsSync(f + '.html')) f += '.html';
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'text/plain' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const BASE = 'http://127.0.0.1:' + server.address().port;

  const browser = await webkit.launch();
  const ctx = await browser.newContext();
  await ctx.addInitScript(({ token }) => {
    try {
      localStorage.setItem('SOKONI_APPCHECK_DEBUG_TOKEN', token);
      self.FIREBASE_APPCHECK_DEBUG_TOKEN = token;
      localStorage.setItem('loggedIn', 'true');
    } catch (_) {}
  }, { token: TOKEN });
  const page = await ctx.newPage();

  console.log('\n1. Session');
  await page.goto(BASE + '/merchant-v2', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(4000);

  const auth = await page.evaluate(async ({ email, password }) => {
    try {
      const [{ getApps, getApp }, { getAuth, signInWithEmailAndPassword, onAuthStateChanged }] =
        await Promise.all([
          import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'),
          import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js'),
        ]);
      if (!getApps().length) return { ok: false, why: 'no Firebase app on the page' };
      const a = getAuth(getApp());
      if (!a.currentUser) await signInWithEmailAndPassword(a, email, password);
      const uid = a.currentUser ? a.currentUser.uid : await new Promise((res) => {
        const t = setTimeout(() => res(null), 15000);
        onAuthStateChanged(a, (u) => { if (u) { clearTimeout(t); res(u.uid); } });
      });
      return { ok: !!uid, uid };
    } catch (e) { return { ok: false, why: (e && (e.code || e.message)) || 'unknown' }; }
  }, { email: EMAIL, password: PASS });

  if (!check('signed in as a real seller against production Auth', auth.ok, auth.uid || auth.why)) {
    await browser.close(); await new Promise(r => server.close(r));
    console.log('\n  Cannot continue without a session.\n'); process.exit(1);
  }

  /* Helpers evaluated in the page: a callable, a product read, a query. */
  const api = async (fnName, payload) => page.evaluate(async ({ fnName, payload }) => {
    try {
      const [{ getApp }, fn] = await Promise.all([
        import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'),
        import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js'),
      ]);
      const r = await fn.httpsCallable(fn.getFunctions(getApp()), fnName)(payload);
      return { ok: true, data: r && r.data };
    } catch (e) { return { ok: false, code: e && e.code, msg: (e && e.message || '').slice(0, 160) }; }
  }, { fnName, payload });

  const readProduct = async (id) => page.evaluate(async (pid) => {
    const [{ getApp }, fs2] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'),
    ]);
    const s = await fs2.getDoc(fs2.doc(fs2.getFirestore(getApp()), 'products', pid));
    if (!s.exists()) return null;
    const d = s.data();
    return { id: s.id, stock: d.stock ?? null, inventoryVersion: d.inventoryVersion ?? null,
             sold: d.sold ?? null, sellerUid: d.sellerUid ?? null,
             shopId: d.shopId || d.merchantId || null,
             updatedAt: d.updatedAt && d.updatedAt.toMillis ? d.updatedAt.toMillis() : null,
             name: d.name || null };
  }, id);

  console.log('\n2. Target product (owned by this seller)');
  let target = null;
  if (FIXED) {
    target = await readProduct(FIXED);
    check('the named product exists', !!target, FIXED);
  } else {
    const found = await page.evaluate(async (uid) => {
      const [{ getApp }, fs2] = await Promise.all([
        import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'),
        import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'),
      ]);
      const db = fs2.getFirestore(getApp());
      const q = fs2.query(fs2.collection(db, 'products'), fs2.where('sellerUid', '==', uid), fs2.limit(5));
      const snap = await fs2.getDocs(q);
      const rows = [];
      snap.forEach(d => rows.push({ id: d.id, stock: d.data().stock ?? null, name: d.data().name || null }));
      return rows;
    }, auth.uid);
    const usable = found.find(r => typeof r.stock === 'number');
    check('found a product owned by this seller with a numeric stock',
          !!usable, usable ? usable.id + ' "' + (usable.name || '') + '" stock=' + usable.stock
                           : found.length + ' owned product(s), none with numeric stock');
    if (usable) target = await readProduct(usable.id);
  }
  if (!target) {
    await browser.close(); await new Promise(r => server.close(r));
    console.log('\n  No usable product — cannot verify.\n'); process.exit(1);
  }
  check('the product is owned by the signed-in seller', target.sellerUid === auth.uid,
        'sellerUid=' + target.sellerUid);

  const start = { ...target };
  const stamp = Date.now();
  const idUp = 'verify-up-' + stamp, idDown = 'verify-down-' + stamp;
  console.log('  before: stock=' + start.stock + ' inventoryVersion=' + start.inventoryVersion +
              ' sold=' + start.sold);

  console.log('\n3. The authorised correction (+1)');
  const up = await api('merchantAdjustStock', {
    productId: target.id, shopId: target.shopId || 'unknown', adjustmentId: idUp,
    delta: 1, reason: 'count_correction', note: 'production verification',
  });
  check('the DEPLOYED callable accepted the request', up.ok, up.ok ? 'ok' : up.code + ' ' + up.msg);
  if (up.ok) {
    check('App Check + ownership accepted (no permission-denied)', up.data && up.data.ok === true);
    check('server reports before/after', up.data && up.data.before === start.stock &&
          up.data.after === start.stock + 1, JSON.stringify(up.data));
  }

  const afterUp = await readProduct(target.id);
  check('stock changed by exactly +1', afterUp && afterUp.stock === start.stock + 1,
        start.stock + ' -> ' + (afterUp && afterUp.stock));
  check('inventoryVersion advanced', afterUp && afterUp.inventoryVersion === (start.inventoryVersion || 0) + 1,
        start.inventoryVersion + ' -> ' + (afterUp && afterUp.inventoryVersion));
  check('updatedAt changed', afterUp && afterUp.updatedAt !== start.updatedAt,
        String(afterUp && afterUp.updatedAt));
  check('sold UNCHANGED (a correction is not a sale)', afterUp && afterUp.sold === start.sold,
        String(start.sold) + ' -> ' + String(afterUp && afterUp.sold));

  console.log('\n4. Refusals');
  const dup = await api('merchantAdjustStock', {
    productId: target.id, shopId: target.shopId || 'unknown', adjustmentId: idUp,
    delta: 1, reason: 'count_correction',
  });
  check('duplicate adjustmentId is IDEMPOTENT', dup.ok && dup.data && dup.data.idempotent === true,
        dup.ok ? JSON.stringify(dup.data) : dup.code);
  const afterDup = await readProduct(target.id);
  check('...and stock moved only ONCE', afterDup && afterDup.stock === start.stock + 1,
        String(afterDup && afterDup.stock));

  const noKey = await api('merchantAdjustStock', {
    productId: target.id, shopId: target.shopId || 'unknown', delta: 1, reason: 'count_correction',
  });
  check('missing adjustmentId is DENIED', !noKey.ok && /invalid-argument/.test(noKey.code || ''),
        noKey.ok ? 'ACCEPTED — should not be' : noKey.code);

  const foreign = await page.evaluate(async (uid) => {
    const [{ getApp }, fs2] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'),
    ]);
    const db = fs2.getFirestore(getApp());
    const snap = await fs2.getDocs(fs2.query(fs2.collection(db, 'products'), fs2.limit(25)));
    let out = null;
    snap.forEach(d => { if (!out && d.data().sellerUid && d.data().sellerUid !== uid) out = { id: d.id, sellerUid: d.data().sellerUid }; });
    return out;
  }, auth.uid);
  if (foreign) {
    const other = await api('merchantAdjustStock', {
      productId: foreign.id, shopId: target.shopId || 'unknown',
      adjustmentId: 'verify-foreign-' + stamp, delta: 1, reason: 'count_correction',
    });
    check('another seller\'s product is DENIED',
          !other.ok && /permission-denied/.test(other.code || ''),
          other.ok ? 'ACCEPTED — OWNERSHIP HOLE' : other.code);
  } else {
    check('a foreign product was available to test ownership against', false,
          'none found in 25 — ownership refusal NOT exercised');
  }

  console.log('\n5. Reversal (leave production as we found it)');
  const down = await api('merchantAdjustStock', {
    productId: target.id, shopId: target.shopId || 'unknown', adjustmentId: idDown,
    delta: -1, reason: 'count_correction', note: 'production verification reversal',
  });
  check('the reversal was accepted', down.ok, down.ok ? 'ok' : down.code + ' ' + down.msg);
  const end = await readProduct(target.id);
  check('FINAL STOCK EQUALS THE STARTING STOCK', end && end.stock === start.stock,
        start.stock + ' -> ' + (end && end.stock));
  check('sold still unchanged end-to-end', end && end.sold === start.sold,
        String(start.sold) + ' -> ' + String(end && end.sold));

  console.log('\n  NOTE  two stockMovements documents remain by design (the audit trail), and');
  console.log('        inventoryVersion advanced ' + start.inventoryVersion + ' -> ' +
              (end && end.inventoryVersion) + ' and does not come back down.');
  console.log('  NOTE  employee self-claim is NOT exercised here: proving it would mean creating a');
  console.log('        shopEmployees document in production, which is the escalation artefact');
  console.log('        itself. The block is asserted statically (test-merchant-adjust-stock.js).');

  await browser.close();
  await new Promise(r => server.close(r));

  console.log('\n' + '='.repeat(78));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('  REVOKE the App Check debug token now and record it in the ledger.');
  console.log('='.repeat(78) + '\n');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nHARNESS ERROR:', e && e.message); process.exit(1); });
