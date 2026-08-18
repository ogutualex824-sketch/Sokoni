#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   PRODUCTION-ORIGIN FIRESTORE TIMING
   ------------------------------------------------------------------------------
   Answers one question: is the ~30s ceiling measured on 127.0.0.1 a property of
   SOKONI's data layer, or of the test harness?

   The loopback run produced a uniform ~30.0s across EVERY operation — both product
   query forms and a single-document getDoc — with fromCache=false throughout. A
   uniform ceiling across unrelated operations is the signature of a timeout-and-retry
   in the transport, not of query cost, and it coincided with a
   `400 Firestore WebChannel Listen/channel`. That is a hypothesis about the harness,
   and it cannot be tested from the harness.

   So this runs against the REAL ORIGIN. No local server. Nothing is served from disk.

   READ-ONLY. Three reads and a discarded warm-up. It writes nothing, and it does not
   change or recommend changing which field the product query uses — that decision was
   already shown to rest on an artifact, where whichever query ran first absorbed
   channel setup.

   fromCache=true INVALIDATES the run. A cache hit never left the browser, so it
   measures nothing about the backend; a fast number from cache is worse than no
   number, because it looks like an answer.

   REQUIRED (never defaulted, never echoed):
     MERCHANT_EMAIL / MERCHANT_PASSWORD    an approved merchant
   OPTIONAL:
     APPCHECK_DEBUG_TOKEN                  if set, attestation uses the debug path and
                                           the report SAYS SO. Without it the page
                                           attests the way a real device does.

     node scripts/diag-production-origin-timing.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const { webkit } = require('playwright');

const ORIGIN = 'https://mysokoni.co.ke';
const EMAIL    = process.env.MERCHANT_EMAIL || '';
const PASSWORD = process.env.MERCHANT_PASSWORD || '';
const TOKEN    = process.env.APPCHECK_DEBUG_TOKEN || '';

/* Loopback baseline, for the comparison this exists to make. */
const LOOPBACK = { shopId: 30014, sellerUid: 30010, singleDoc: 29979 };

const PLACEHOLDER = (v) => !v || /^<.*>$/.test(v) || /^(YOUR|THE)[_-]/i.test(v) ||
                           /^(password|changeme|xxx+)$/i.test(v);

const die = (why, extra) => {
  console.log('\n' + '='.repeat(70));
  console.log('  ABORTED — NO MEASUREMENT TAKEN');
  console.log('='.repeat(70));
  console.log('  ' + why);
  if (extra) extra.forEach((l) => console.log('  ' + l));
  console.log('\n  A partial run here would produce numbers that look like evidence.');
  console.log('='.repeat(70) + '\n');
  process.exit(1);
};

if (PLACEHOLDER(EMAIL) || PLACEHOLDER(PASSWORD)) {
  die('Missing ' + [PLACEHOLDER(EMAIL) && 'MERCHANT_EMAIL',
                    PLACEHOLDER(PASSWORD) && 'MERCHANT_PASSWORD'].filter(Boolean).join(' and '),
    ['', 'PowerShell:',
     '  $env:MERCHANT_EMAIL    = "<approved merchant>"',
     '  $env:MERCHANT_PASSWORD = Read-Host "password"    # run that line alone',
     '  node scripts/diag-production-origin-timing.js']);
}

(async () => {
  let browser;
  try { browser = await webkit.launch(); }
  catch (e) { die('webkit unavailable: ' + (e && e.message)); }

  const ctx = await browser.newContext({
    viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  if (TOKEN) {
    await ctx.addInitScript((t) => { try { localStorage.setItem('SOKONI_APPCHECK_DEBUG_TOKEN', t); } catch (e) {} }, TOKEN);
  }

  const page = await ctx.newPage();
  const wire = [];
  page.on('response', (r) => {
    const u = r.url();
    if (r.status() >= 400 && /googleapis|firestore|appcheck/i.test(u)) {
      wire.push(r.status() + ' ' + r.request().method() + ' ' + u.split('?')[0].slice(0, 96));
    }
  });

  console.log('\n' + '='.repeat(70));
  console.log('  PRODUCTION ORIGIN TIMING');
  console.log('='.repeat(70));
  console.log('  origin=' + ORIGIN);

  const nav = await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 60000 })
    .catch((e) => ({ __err: e && e.message }));
  if (!nav || nav.__err) { await browser.close(); die('could not load ' + ORIGIN + ': ' + (nav && nav.__err)); }

  await page.waitForFunction(() => typeof window.__sokoniAppCheckState === 'string', null, { timeout: 40000 }).catch(() => null);
  await page.waitForTimeout(4000);

  /* ── auth ─────────────────────────────────────────────────────────────────── */
  const auth = await page.evaluate(async ({ email, password }) => {
    try {
      const [{ getApps, getApp }, A] = await Promise.all([
        import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'),
        import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js')]);
      if (!getApps().length) return { ok:false, why:'no Firebase app on the page' };
      const cred = await A.signInWithEmailAndPassword(A.getAuth(getApp()), email, password);
      return { ok:true, uid: cred.user.uid };
    } catch (e) { return { ok:false, why:(e && (e.code || e.message)) || String(e) }; }
  }, { email: EMAIL, password: PASSWORD });
  console.log('  auth=' + (auth.ok ? 'PASS' : 'FAIL'));
  if (!auth.ok) { await browser.close(); die('authentication failed: ' + auth.why); }

  /* ── App Check ────────────────────────────────────────────────────────────── */
  const acState = await page.evaluate(() => window.__sokoniAppCheckState);
  const acOk = acState === 'exchanged';
  console.log('  appCheck=' + (acOk ? 'PASS' : 'FAIL') + '  (' + acState + ', ' +
              (TOKEN ? 'DEBUG TOKEN — not the reCAPTCHA path a real device uses' : 'production attestation') + ')');
  if (!acOk) {
    await browser.close();
    die('App Check did not attest (state=' + acState + ').',
        ['Unattested reads resolve as empty CACHE hits that do not throw, so every',
         'number below would describe a request that never left the browser.']);
  }

  /* ── canonical shop, via the shell the merchant actually uses ─────────────── */
  await page.goto(ORIGIN + '/merchant', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
  const shopOk = await page.waitForFunction(() => !!((window.SokoniShell || {}).activeShopId), null, { timeout: 90000 })
    .then(() => true).catch(() => false);
  const shopId = await page.evaluate(() => (window.SokoniShell || {}).activeShopId || null);
  console.log('  canonicalShop=' + (shopOk ? 'PASS' : 'FAIL') + (shopId ? '  (' + shopId + ')' : ''));
  if (!shopOk) { await browser.close(); die('canonical shop did not resolve — nothing to scope a query to.'); }

  /* ── measurement ──────────────────────────────────────────────────────────── */
  const m = await page.evaluate(async (shopId) => {
    const [{ getApp }, F] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js')]);
    const db = F.getFirestore(getApp());
    const uid = window.firebaseAuth.currentUser.uid;
    const out = {};

    /* Discarded: the first backend call carries connection setup, the App Check
       exchange and the WebChannel handshake. Measuring it as a query is how the
       loopback run first "proved" shopId was slow. */
    let t = performance.now();
    try { await F.getDocs(F.query(F.collection(db, 'products'), F.limit(1))); } catch (e) {}
    out.warmup = Math.round(performance.now() - t);

    const q = async (field, value) => {
      const t0 = performance.now();
      try {
        const s = await F.getDocs(F.query(F.collection(db, 'products'),
          F.where(field, '==', String(value)), F.limit(500)));
        return { ms: Math.round(performance.now() - t0), n: s.size, fromCache: s.metadata.fromCache };
      } catch (e) { return { ms: Math.round(performance.now() - t0), err: (e && e.code) || String(e) }; }
    };

    out.shopId    = await q('shopId', shopId);
    out.sellerUid = await q('sellerUid', uid);

    const t2 = performance.now();
    try {
      const d = await F.getDoc(F.doc(db, 'shops', String(shopId)));
      out.singleDoc = { ms: Math.round(performance.now() - t2), exists: d.exists(), fromCache: d.metadata.fromCache };
    } catch (e) { out.singleDoc = { ms: Math.round(performance.now() - t2), err: (e && e.code) || String(e) }; }
    return out;
  }, shopId);

  const line = (label, r, extra) => {
    if (r.err) return console.log('  ' + label + '=ERROR ' + r.err);
    console.log('  ' + label + '=' + r.ms + 'ms ' + extra(r) + ' fromCache=' + r.fromCache);
  };

  console.log('');
  console.log('  warmup=' + m.warmup + 'ms  (DISCARDED — channel setup, not a measurement)');
  line('shopId',        m.shopId,    (r) => 'n=' + r.n);
  line('sellerUid',     m.sellerUid, (r) => 'n=' + r.n);
  line('singleShopDoc', m.singleDoc, (r) => 'exists=' + r.exists);

  /* ── classification ───────────────────────────────────────────────────────── */
  const reads = [m.shopId, m.sellerUid, m.singleDoc];
  const anyErr    = reads.some((r) => r.err);
  const anyCached = reads.some((r) => r.fromCache === true);
  const slowest   = Math.max.apply(null, reads.filter((r) => !r.err).map((r) => r.ms).concat([0]));

  let verdict, detail;
  if (anyErr) {
    verdict = 'INVALID — a read errored';
    detail  = 'Fix the error before drawing any timing conclusion.';
  } else if (anyCached) {
    verdict = 'INVALID — fromCache=true';
    detail  = 'A cache hit never reached the backend. This measures nothing.';
  } else if (slowest >= 20000) {
    verdict = 'PRODUCTION PERFORMANCE BLOCKER';
    detail  = 'The ceiling survives off loopback. Investigate the production transport/backend '
            + 'path. Do NOT change query authority: it affects a single-document getDoc too, '
            + 'so it is not query cost.';
  } else if (slowest < 2000) {
    verdict = 'LOOPBACK ARTIFACT — production is healthy';
    detail  = 'The ~30s ceiling does not exist here, so it was the harness transport. '
            + 'Returns\' WebChannel 400 is confirmed ENV. No Merchant data-layer change is '
            + 'warranted.';
  } else {
    verdict = 'INCONCLUSIVE';
    detail  = 'Slower than healthy, far short of the loopback ceiling. Re-run on a stable '
            + 'network before deciding.';
  }

  console.log('\n  loopback baseline: shopId=' + LOOPBACK.shopId + 'ms  sellerUid=' +
              LOOPBACK.sellerUid + 'ms  singleDoc=' + LOOPBACK.singleDoc + 'ms');
  console.log('  production slowest: ' + slowest + 'ms');
  console.log('\n  classification=' + verdict);
  console.log('  ' + detail);
  if (wire.length) {
    console.log('\n  failing backend requests:');
    [...new Set(wire)].slice(0, 8).forEach((w) => console.log('    ' + w));
  }
  console.log('\n  READ-ONLY: nothing was written, no query authority changed.\n');

  await browser.close();
  process.exit(anyErr || anyCached ? 1 : 0);
})();
