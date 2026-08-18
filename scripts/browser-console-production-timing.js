/* ══════════════════════════════════════════════════════════════════════════════
   PRODUCTION TIMING — paste into DevTools on https://mysokoni.co.ke/merchant
   ------------------------------------------------------------------------------
   NOT a node script. The headless runner
   (scripts/diag-production-origin-timing.js) aborted at App Check with
   state=rejected: reCAPTCHA will not attest a headless browser, so every read it
   could have taken would have been an empty cache hit. It refused to measure, which
   was correct — an unattested number would have looked exactly like evidence.

   A real signed-in browser already holds a genuine attestation, so it is the
   faithful instrument here, not a workaround.

   HOW TO RUN
     1. Sign in at https://mysokoni.co.ke
     2. Navigate to https://mysokoni.co.ke/merchant  (needed for the canonical shop)
     3. Open DevTools → Console
     4. Paste this whole file, press Enter
     5. Paste the printed result back

   READ-ONLY. Three reads and a discarded warm-up. Writes nothing. Changes no query
   authority — the loopback ceiling hit a single-document getDoc too, so it was never
   query cost, and the field the product query uses is not in question.

   ABORTS rather than reporting: no attestation, no session, no shop, or any
   fromCache=true. A cache hit never left the browser; a fast number from cache is
   worse than no number.
   ══════════════════════════════════════════════════════════════════════════════ */
(async () => {
  const L = (s) => console.log(s);
  const stop = (why, extra) => {
    L('\n%c ABORTED — NO MEASUREMENT TAKEN ', 'background:#b00;color:#fff;font-weight:bold');
    L('  ' + why);
    if (extra) L('  ' + extra);
  };

  L('%c PRODUCTION ORIGIN TIMING ', 'background:#050505;color:#71ff00;font-weight:bold');
  L('  origin=' + location.origin);

  /* ── preconditions ─────────────────────────────────────────────────────── */
  if (location.origin !== 'https://mysokoni.co.ke') {
    return stop('Wrong origin: ' + location.origin,
                'This measurement is only meaningful on https://mysokoni.co.ke');
  }

  const ac = window.__sokoniAppCheckState;
  L('  appCheck=' + (ac === 'exchanged' ? 'PASS' : 'FAIL') + '  (' + ac + ')');
  if (ac !== 'exchanged') {
    return stop('App Check is "' + ac + '", not "exchanged".',
                'Unattested reads resolve as empty cache hits that do not throw.');
  }
  /* A debug token would mean this is not the path a real device takes. */
  let dbg = null; try { dbg = localStorage.getItem('SOKONI_APPCHECK_DEBUG_TOKEN'); } catch (e) {}
  if (dbg) L('  %cNOTE: a debug token is pinned in this browser — attestation is NOT the reCAPTCHA path', 'color:#e80');

  const user = (window.firebaseAuth && window.firebaseAuth.currentUser) || null;
  L('  auth=' + (user ? 'PASS' : 'FAIL'));
  if (!user) return stop('No signed-in user.', 'Sign in at https://mysokoni.co.ke first.');

  const [{ getApp }, F] = await Promise.all([
    import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'),
  ]);
  const db = F.getFirestore(getApp());
  const uid = user.uid;

  let shopId = (window.SokoniShell || {}).activeShopId || null;
  if (!shopId) {
    try {
      const s = await F.getDoc(F.doc(db, 'users', uid));
      shopId = s.exists() ? (s.data() || {}).activeShopId || null : null;
    } catch (e) {}
  }
  L('  canonicalShop=' + (shopId ? 'PASS  (' + shopId + ')' : 'FAIL'));
  if (!shopId) return stop('No canonical shop resolved.', 'Open https://mysokoni.co.ke/merchant and wait for it to settle.');

  /* ── measurement ───────────────────────────────────────────────────────── */
  let t = performance.now();
  try { await F.getDocs(F.query(F.collection(db, 'products'), F.limit(1))); } catch (e) {}
  const warmup = Math.round(performance.now() - t);
  L('\n  warmup=' + warmup + 'ms  (DISCARDED — channel setup, not a measurement)');

  const q = async (field, value) => {
    const t0 = performance.now();
    try {
      const s = await F.getDocs(F.query(F.collection(db, 'products'),
        F.where(field, '==', String(value)), F.limit(500)));
      return { ms: Math.round(performance.now() - t0), n: s.size, fromCache: s.metadata.fromCache };
    } catch (e) { return { ms: Math.round(performance.now() - t0), err: e.code || String(e) }; }
  };

  const byShop   = await q('shopId', shopId);
  const bySeller = await q('sellerUid', uid);

  const t2 = performance.now();
  let single;
  try {
    const d = await F.getDoc(F.doc(db, 'shops', String(shopId)));
    single = { ms: Math.round(performance.now() - t2), exists: d.exists(), fromCache: d.metadata.fromCache };
  } catch (e) { single = { ms: Math.round(performance.now() - t2), err: e.code || String(e) }; }

  const show = (label, r, tail) => L('  ' + label + '=' + (r.err ? 'ERROR ' + r.err
    : r.ms + 'ms ' + tail(r) + ' fromCache=' + r.fromCache));
  show('shopId',        byShop,   (r) => 'n=' + r.n);
  show('sellerUid',     bySeller, (r) => 'n=' + r.n);
  show('singleShopDoc', single,   (r) => 'exists=' + r.exists);

  /* ── classification ────────────────────────────────────────────────────── */
  const reads = [byShop, bySeller, single];
  const anyErr = reads.some((r) => r.err);
  const cached = reads.some((r) => r.fromCache === true);
  const slowest = Math.max(...reads.filter((r) => !r.err).map((r) => r.ms), 0);

  L('\n  loopback baseline: shopId=30014ms  sellerUid=30010ms  singleDoc=29979ms');
  L('  production slowest: ' + slowest + 'ms');

  let v, d;
  if (anyErr)        { v = 'INVALID — a read errored';   d = 'Resolve the error before concluding anything.'; }
  else if (cached)   { v = 'INVALID — fromCache=true';   d = 'That read never reached the backend. It measures nothing.'; }
  else if (slowest >= 20000) { v = 'PRODUCTION PERFORMANCE BLOCKER';
    d = 'The ceiling survives on the real origin. Investigate the production transport path. '
      + 'Do NOT change query authority — it hits a single-document getDoc too.'; }
  else if (slowest < 2000)   { v = 'LOOPBACK ARTIFACT — production is healthy';
    d = 'The ~30s ceiling does not exist here, so it was the test transport. Returns\' '
      + 'WebChannel 400 is confirmed ENV. No Merchant data-layer change is warranted.'; }
  else { v = 'INCONCLUSIVE'; d = 'Between healthy and the loopback ceiling. Re-run on a stable network.'; }

  L('\n  classification=' + v);
  L('  ' + d);
  L('\n  READ-ONLY: nothing written, no query authority changed.');
})();
