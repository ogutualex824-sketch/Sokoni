/* SOKONI upload authorization diagnostic.
 *
 * Paste into the browser console on the page where product upload fails, while
 * signed in AS THE AFFECTED SELLER. Requires no deployment.
 *
 *   const report = await sokoniDiagnoseUpload();
 *   copy(JSON.stringify(report, null, 2));     // attach to the incident
 *
 * WHY THIS EXISTS
 * A repository search cannot explain the reported "stops at 3": all four plan
 * tables say 10 (functions/index.js:3683, sokoni-revenue.js:28, sub-billing.js,
 * product-limit.js), the gateway's upload.maxTokens=3 bucket has no call sites
 * across the 114 pages that load it, storage rules cap size rather than count,
 * and no image or AI-credit quota of 3 exists. The number is therefore runtime
 * state — drift, stale claims, or a rejection that is not a quota at all — and
 * only the running system can say which.
 *
 * The output is a structured artifact, not console prose, so it can be attached
 * to a bug report and compared between accounts.
 */
window.sokoniDiagnoseUpload = async function sokoniDiagnoseUpload() {
  const report = {
    uid: null,
    generatedAt: new Date().toISOString(),
    claims:  {},
    counter: { stored: null, actual: null, byStatus: {}, drift: null },
    server:  {},
    pipeline: {
      auth:            'NOT_REACHED',
      counterRead:     'NOT_REACHED',
      callable:        'NOT_REACHED',
      consistency:     'NOT_REACHED',
      firestoreWrite:  'NOT_REACHED',
    },
    error: null,
    firstFailingStage: null,
    verdict: null,
  };

  const mark = (stage, state, err) => {
    report.pipeline[stage] = state;
    if (state === 'FAIL' && !report.firstFailingStage) {
      report.firstFailingStage = stage;
      if (err) report.error = { code: err.code || 'unknown', message: err.message || String(err) };
    }
  };
  const head = (t) => console.log('\n%c ' + t + ' ', 'background:#71ff00;color:#000;font-weight:bold');
  const row  = (k, v) => console.log('  ' + String(k).padEnd(26) + ' ' + v);

  head('SOKONI UPLOAD DIAGNOSTIC');

  /* ── 1. Identity and claims ──────────────────────────────────────────────
     Claims are checked first because an admin bypasses rules a merchant does
     not. A clean run on an admin account proves nothing about the merchant. */
  try {
    const user = firebase.auth().currentUser;
    if (!user) throw new Error('not signed in');
    report.uid = user.uid;
    const tok = await user.getIdTokenResult();
    report.claims = {
      admin:      !!tok.claims.admin,
      superAdmin: !!tok.claims.superAdmin,
      seller:     !!tok.claims.seller,
      posRole:    tok.claims.posRole || null,
      tokenIssued: tok.issuedAtTime,
    };
    mark('auth', 'PASS');
    row('uid', report.uid);
    row('claims', JSON.stringify(report.claims));
    if (report.claims.admin || report.claims.superAdmin) {
      console.warn('  ADMIN ACCOUNT — rules behave differently. Re-run as the merchant.');
    }
    /* A token minted before a plan upgrade still carries the old claims until
       refreshed, which presents exactly as "I upgraded and nothing changed". */
    row('token age', Math.round((Date.now() - new Date(tok.issuedAtTime).getTime()) / 60000) + ' min');
  } catch (e) {
    mark('auth', 'FAIL', e);
    report.verdict = 'Not signed in — every write is denied before any quota applies.';
    console.error('  ' + report.verdict);
    return report;
  }

  const db  = firebase.firestore();
  const uid = report.uid;

  /* ── 2. Stored counter ───────────────────────────────────────────────── */
  head('COUNTER');
  try {
    const snap = await db.collection('productCounters').doc(uid).get();
    if (!snap.exists) {
      report.counter.stored = null;
      row('productCounters', 'ABSENT — rule fails open, so this is NOT the blocker');
    } else {
      const d = snap.data();
      report.counter.stored      = typeof d.count === 'number' ? d.count : null;
      report.counter.maxProducts = d.maxProducts;
      report.counter.status      = d.status || null;
      row('stored count', d.count);
      row('maxProducts', d.maxProducts + (d.maxProducts === -1 ? ' (unlimited)' : ''));
      row('status', d.status || '(none)');
    }
    mark('counterRead', 'PASS');
  } catch (e) {
    mark('counterRead', 'FAIL', e);
    row('productCounters', 'READ FAILED: ' + e.message);
  }

  /* ── 3. What the server decides when asked ───────────────────────────── */
  head('SERVER DECISION');
  try {
    const r = (await firebase.functions().httpsCallable('canPublishProduct')({})).data;
    report.server = r;
    row('allowed', r.allowed);
    row('count / limit', r.count + ' / ' + (r.unlimited ? 'unlimited' : r.limit));
    row('subscription status', r.status);
    if (r.upgrade) row('upgrade message', r.upgrade.message);
    mark('callable', r.allowed ? 'PASS' : 'FAIL',
         r.allowed ? null : { code: 'PRODUCT_LIMIT_REACHED', message: r.upgrade?.message || 'server denied' });
  } catch (e) {
    mark('callable', 'FAIL', e);
    row('canPublishProduct', 'CALL FAILED: ' + (e.code || '') + ' ' + e.message);
  }

  /* ── 4. Consistency: does the counter match reality? ──────────────────────
     Counted three ways deliberately. A limit that counts every document while
     another component counts only active ones is a known cause of a cap firing
     early, and the two numbers are indistinguishable until you print both. */
  head('CONSISTENCY');
  try {
    const q = await db.collection('products').where('sellerUid', '==', uid).get();
    report.counter.actual = q.size;

    const byStatus = {};
    q.forEach((doc) => {
      const s = doc.data().status || '(none)';
      byStatus[s] = (byStatus[s] || 0) + 1;
    });
    report.counter.byStatus = byStatus;

    row('actual (sellerUid query)', q.size);
    row('by status', JSON.stringify(byStatus));

    /* The upload path may key products off a different field. If this disagrees
       with the query above, the two halves of the system disagree about which
       products belong to this seller. */
    try {
      const alt = await db.collection('products').where('sellerId', '==', uid).get();
      report.counter.actualBySellerId = alt.size;
      row('actual (sellerId query)', alt.size + (alt.size !== q.size ? '   <-- FIELD MISMATCH' : ''));
    } catch (_) { /* index may not exist; not a failure */ }

    if (report.counter.stored !== null) {
      report.counter.drift = report.counter.actual - report.counter.stored;
      row('drift', report.counter.drift === 0
        ? 'in sync'
        : `${report.counter.drift > 0 ? '+' : ''}${report.counter.drift} — counter says ` +
          `${report.counter.stored}, Firestore has ${report.counter.actual}. Run recountMarketplaceProducts.`);
    }
    mark('consistency', report.counter.drift === 0 || report.counter.drift === null ? 'PASS' : 'FAIL',
         report.counter.drift ? { code: 'COUNTER_DRIFT', message: 'stored ' + report.counter.stored + ' vs actual ' + report.counter.actual } : null);
  } catch (e) {
    mark('consistency', 'FAIL', e);
    row('product query', 'FAILED: ' + e.message);
  }

  /* ── 5. Live write probe ─────────────────────────────────────────────────
     The only step that tests the DEPLOYED rule rather than reasoning about it.
     Namespaced and flagged so it is identifiable if cleanup ever fails, and
     cleaned up in a finally block so a later throw cannot orphan it — an
     orphaned probe would inflate the very counter being measured. */
  head('LIVE WRITE PROBE');
  let probeRef = null;
  try {
    probeRef = await db.collection('products').add({
      sellerUid:     uid,
      __diagnostic:  true,
      name:          '__SOKONI_DIAGNOSTIC_PROBE__',
      price:         1,
      status:        'draft',
      createdAt:     new Date().toISOString(),
    });
    mark('firestoreWrite', 'PASS');
    row('firestore create', 'ALLOWED — the rule is not blocking this account');
  } catch (e) {
    mark('firestoreWrite', 'FAIL', e);
    row('firestore create', (e.code || 'error') + ': ' + e.message);
  } finally {
    if (probeRef) {
      try {
        await probeRef.delete();
        row('probe cleaned up', probeRef.id);
      } catch (e) {
        console.error('  PROBE NOT DELETED — ' + probeRef.id + ' (' + e.message + ')');
        console.error('  Delete it manually: products/' + probeRef.id +
                      ' — it is flagged __diagnostic:true and will otherwise inflate the counter.');
        report.error = report.error || { code: 'PROBE_ORPHANED', message: probeRef.id };
      }
    }
  }

  /* ── Verdict ─────────────────────────────────────────────────────────── */
  head('VERDICT');
  if (!report.firstFailingStage) {
    report.verdict = 'No stage denied. The rejection is UPSTREAM of Firestore — client ' +
                     'validation, image/storage upload, or a callable. Capture the console ' +
                     'error at the exact moment of failure.';
  } else if (report.firstFailingStage === 'firestoreWrite') {
    report.verdict = 'Firestore rejected the write. If the code is permission-denied, the ' +
                     'deployed rule is the blocker and rolling back Stage 2 is justified.';
  } else if (report.firstFailingStage === 'consistency') {
    report.verdict = 'Counter drift — the stored count disagrees with the products that ' +
                     'exist. This is a data problem, not a rules problem. Run ' +
                     'recountMarketplaceProducts; do not roll back rules.';
  } else {
    report.verdict = 'First failure at ' + report.firstFailingStage + '. See report.error.';
  }
  console.log('  ' + report.verdict);
  console.log('\n  Copy the artifact:  copy(JSON.stringify(report, null, 2))');
  return report;
};

console.log('%c sokoniDiagnoseUpload() ready — run: const report = await sokoniDiagnoseUpload() ',
            'background:#71ff00;color:#000;font-weight:bold');
