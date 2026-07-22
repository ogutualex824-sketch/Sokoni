/* SOKONI upload authorization diagnostic.
 *
 * Paste into the browser console on the page where product upload fails, while
 * signed in as the affected seller. Requires no deployment.
 *
 * WHY THIS EXISTS
 * A repository search found no 3-product limit anywhere: every plan table says
 * 10 (functions/index.js:3683, sokoni-revenue.js:28), the gateway's
 * upload.maxTokens=3 bucket has no call sites, storage rules cap size not count,
 * and there is no AI-credit quota of 3. So the number is coming from runtime
 * state, not from source — a stale counter, a drifted document, or a rejection
 * that is not a quota at all.
 *
 * This walks the authorization chain in order and reports the FIRST stage that
 * says no, which is the one piece of evidence the investigation is missing.
 *
 *   await sokoniDiagnoseUpload()
 */
window.sokoniDiagnoseUpload = async function sokoniDiagnoseUpload() {
  const line = (k, v) => console.log('  ' + String(k).padEnd(28) + ' ' + v);
  const head = (t) => console.log('\n%c' + t, 'background:#71ff00;color:#000;font-weight:bold');
  const out  = { stages: [], firstDenial: null };

  const record = (stage, ok, detail) => {
    out.stages.push({ stage, ok, detail });
    if (!ok && !out.firstDenial) out.firstDenial = stage;
    line((ok ? 'PASS  ' : 'DENY  ') + stage, detail);
  };

  head(' SOKONI UPLOAD DIAGNOSTIC ');

  /* ── 1. Identity ─────────────────────────────────────────────────────── */
  let uid = null;
  try { uid = firebase.auth().currentUser?.uid || null; } catch (_) {}
  record('signed in', !!uid, uid || 'NOT SIGNED IN — every write will be denied');
  if (!uid) return out;

  /* Claims matter: admin bypasses several rules, so a test run as admin proves
     nothing about what a merchant experiences. */
  try {
    const tok = await firebase.auth().currentUser.getIdTokenResult();
    line('claims', JSON.stringify({
      admin: !!tok.claims.admin, superAdmin: !!tok.claims.superAdmin,
      posRole: tok.claims.posRole || null, seller: !!tok.claims.seller,
    }));
    if (tok.claims.admin || tok.claims.superAdmin) {
      console.warn('  NOTE: this account is admin — rules behave differently. ' +
                   'Re-run as the merchant account to reproduce their experience.');
    }
  } catch (e) { line('claims', 'unreadable: ' + e.message); }

  /* ── 2. What the server thinks the counter says ──────────────────────── */
  head(' COUNTER ');
  let counter = null;
  try {
    const snap = await firebase.firestore().collection('productCounters').doc(uid).get();
    counter = snap.exists ? snap.data() : null;
    if (!counter) {
      record('productCounters doc', true, 'ABSENT — rule fails open, so this is NOT the blocker');
    } else {
      line('count', counter.count);
      line('maxProducts', counter.maxProducts + (counter.maxProducts === -1 ? ' (unlimited)' : ''));
      line('status', counter.status || '(none)');
      const within = counter.maxProducts === -1 ||
                     typeof counter.maxProducts !== 'number' ||
                     typeof counter.count !== 'number' ||
                     counter.count < counter.maxProducts;
      record('within counter limit', within,
        within ? 'rule would ALLOW' : `count ${counter.count} >= max ${counter.maxProducts} — RULE DENIES HERE`);
    }
  } catch (e) {
    record('read productCounters', false, 'read denied or failed: ' + e.message);
  }

  /* ── 3. What the server says when asked directly ─────────────────────── */
  head(' SERVER DECISION ');
  try {
    const call = firebase.functions().httpsCallable('canPublishProduct');
    const r = (await call({})).data;
    line('allowed', r.allowed);
    line('count / limit', r.count + ' / ' + (r.unlimited ? 'unlimited' : r.limit));
    line('subscription status', r.status);
    if (r.upgrade) line('upgrade message', r.upgrade.message);
    record('canPublishProduct', !!r.allowed, r.allowed ? 'server would allow' : 'SERVER SAYS NO');
  } catch (e) {
    record('canPublishProduct', false, 'callable failed: ' + (e.code || '') + ' ' + e.message);
  }

  /* ── 4. Does the counter match reality? ──────────────────────────────── */
  head(' DRIFT CHECK ');
  try {
    const q = await firebase.firestore().collection('products')
      .where('sellerUid', '==', uid).get();
    const actual = q.size;
    line('actual products in Firestore', actual);
    if (counter && typeof counter.count === 'number') {
      const drift = actual - counter.count;
      record('counter matches reality', drift === 0,
        drift === 0 ? 'in sync' :
        `DRIFT ${drift > 0 ? '+' : ''}${drift} — counter says ${counter.count}, Firestore has ${actual}. ` +
        'Run recountMarketplaceProducts.');
    }
    /* Counting method matters: if some code counts only active products and the
       counter counts all of them, the two disagree and the limit fires early. */
    const byStatus = {};
    q.forEach(d => { const s = d.data().status || '(none)'; byStatus[s] = (byStatus[s] || 0) + 1; });
    line('by status', JSON.stringify(byStatus));
  } catch (e) {
    record('count products', false, 'query failed: ' + e.message);
  }

  /* ── 5. Attempt the write the merchant actually attempts ─────────────── */
  head(' LIVE WRITE PROBE ');
  console.log('  Writing a throwaway product to reproduce the real rejection,');
  console.log('  then deleting it. This is the only step that tests the rule itself.');
  let probeId = null;
  try {
    const ref = await firebase.firestore().collection('products').add({
      sellerUid: uid,
      name: '__diagnostic_probe__',
      price: 1,
      status: 'draft',
      createdAt: new Date().toISOString(),
    });
    probeId = ref.id;
    record('firestore create', true, 'ALLOWED — the rule is not blocking this account');
  } catch (e) {
    record('firestore create', false,
      (e.code || 'error') + ': ' + e.message +
      (String(e.code).includes('permission') ? '  <-- THE REJECTION IS HERE' : ''));
  }
  if (probeId) {
    try { await firebase.firestore().collection('products').doc(probeId).delete();
          line('probe cleaned up', probeId); }
    catch (e) { console.warn('  probe left behind (' + probeId + '): ' + e.message); }
  }

  head(' RESULT ');
  console.log(out.firstDenial
    ? '  FIRST DENIAL: ' + out.firstDenial
    : '  No stage denied. The rejection is upstream of Firestore — client validation, ' +
      'image/storage upload, or a callable. Capture the console error at the moment of failure.');
  return out;
};

console.log('%c sokoniDiagnoseUpload() ready — run: await sokoniDiagnoseUpload() ',
            'background:#71ff00;color:#000;font-weight:bold');
