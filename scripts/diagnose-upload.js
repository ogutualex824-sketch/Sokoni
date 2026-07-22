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
    /* Classified separately from the pass/fail pipeline: "consistency failed" is
       not actionable, but "SELLER_KEY_MISMATCH" names the owning subsystem. */
    consistency: { status: 'NOT_REACHED', reason: null, stored: null, actual: null, drift: null, detail: null },
    ownership: { authUid: null, canonicalMerchantId: null, sellerUidOnProducts: null, sellerIdOnProducts: null, resolvedKey: null, allQueriesAgree: null },
    server:  {},
    pipeline: {
      auth:            'NOT_REACHED',
      counterRead:     'NOT_REACHED',
      callable:        'NOT_REACHED',
      consistency:     'NOT_REACHED',
      firestoreWrite:  'NOT_REACHED',
    },
    /* Each measurement is stamped so a concurrent upload during the run is
       detectable — otherwise two counts taken seconds apart look like drift. */
    timestamps: {
      started:     new Date().toISOString(),
      tokenIssued: null,
      counterRead: null,
      actualCount: null,
      writeProbe:  null,
      finished:    null,
    },
    error: null,
    firstFailingStage: null,
    verdict: null,
  };

  /* Ordered most-specific first: a seller-key mismatch explains a drift, so
     reporting the drift instead would send the engineer to the wrong subsystem. */
  const REASONS = {
    SELLER_KEY_MISMATCH:   'products are split across sellerUid and sellerId — the two halves of the system disagree about ownership',
    STATUS_FILTER_MISMATCH:'the stored count matches only ACTIVE products while the collection holds more — one component filters by status, the other does not',
    COUNTER_DRIFT:         'stored counter and actual product count diverge',
    TOKEN_STALE:           'the ID token predates a likely plan change and still carries old claims',
    QUERY_MISMATCH:        'the diagnostic query returned a different shape than expected',
    STALE_CACHE:           'client-cached values disagree with the server',
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
    report.timestamps.tokenIssued = tok.issuedAtTime;
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
    report.timestamps.counterRead = new Date().toISOString();
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
    report.timestamps.actualCount = new Date().toISOString();

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
    }

    /* ── Classify ───────────────────────────────────────────────────────────
       Most-specific cause first. A seller-key mismatch or a status-filter
       mismatch both PRODUCE a drift, so reporting COUNTER_DRIFT when either is
       present would send the on-call engineer to rebuild counters when the real
       fault is a query keyed on the wrong field. */
    const c = report.consistency;
    c.stored = report.counter.stored;
    c.actual = report.counter.actual;
    c.drift  = report.counter.drift;

    const activeCount = report.counter.byStatus.active || 0;
    const altCount    = report.counter.actualBySellerId;

    if (typeof altCount === 'number' && altCount !== report.counter.actual) {
      c.status = 'FAIL'; c.reason = 'SELLER_KEY_MISMATCH';
      c.detail = `sellerUid=${report.counter.actual}, sellerId=${altCount}`;
    } else if (c.stored !== null && c.drift !== 0 && c.stored === activeCount) {
      c.status = 'FAIL'; c.reason = 'STATUS_FILTER_MISMATCH';
      c.detail = `stored ${c.stored} equals ACTIVE-only count; collection holds ${c.actual}`;
    } else if (c.stored !== null && c.drift !== 0) {
      c.status = 'FAIL'; c.reason = 'COUNTER_DRIFT';
      c.detail = `stored ${c.stored} vs actual ${c.actual} (drift ${c.drift > 0 ? '+' : ''}${c.drift})`;
    } else if (report.claims.tokenIssued &&
               (Date.now() - new Date(report.claims.tokenIssued).getTime()) > 60 * 60 * 1000) {
      /* Not a failure on its own — surfaced because a token older than an hour
         may predate a plan change, which presents as "I upgraded, nothing changed". */
      c.status = 'WARN'; c.reason = 'TOKEN_STALE';
      c.detail = 'token older than 1h — refresh with getIdToken(true) and re-run';
    } else {
      c.status = 'PASS';
    }

    row('classification', c.reason ? c.reason + ' — ' + REASONS[c.reason] : 'in sync');
    if (c.detail) row('detail', c.detail);

    mark('consistency', c.status === 'FAIL' ? 'FAIL' : 'PASS',
         c.status === 'FAIL' ? { code: c.reason, message: c.detail } : null);
  } catch (e) {
    mark('consistency', 'FAIL', e);
    row('product query', 'FAILED: ' + e.message);
  }

  /* ── 4b. Ownership resolution ────────────────────────────────────────────
     Counts only reveal drift; they cannot say WHY two subsystems disagree.
     This asks the question directly: which identifier does each part of the
     platform believe owns this merchant's products?

     If product creation stamps sellerUid = auth.uid while authorization counts
     by sellerId = merchant document id, every subsystem is individually correct
     by its own query and they still disagree on how many products exist. That
     is invisible in a count and obvious here. */
  head('OWNERSHIP');
  try {
    const own = {
      authUid:             uid,
      canonicalMerchantId: null,
      sellerUidOnProducts: null,
      sellerIdOnProducts:  null,
      resolvedKey:         null,
      allQueriesAgree:     null,
    };

    try { own.canonicalMerchantId = localStorage.getItem('sokoni_merchant_id') || null; } catch (_) {}

    /* Read the identifiers actually written onto this seller's product
       documents, rather than assuming which field the writer used. */
    const sample = await db.collection('products').where('sellerUid', '==', uid).limit(5).get();
    const uids = new Set(), ids = new Set();
    sample.forEach((d) => {
      const v = d.data();
      if (v.sellerUid) uids.add(v.sellerUid);
      if (v.sellerId)  ids.add(v.sellerId);
    });
    own.sellerUidOnProducts = [...uids];
    own.sellerIdOnProducts  = [...ids];

    /* Agreement means every identifier the platform might key on resolves to
       the same value. A merchant id that differs from auth.uid is not itself a
       bug — it is only a bug when one query uses one and another uses the other. */
    const distinct = new Set([
      uid,
      ...uids,
      ...ids,
      own.canonicalMerchantId,
    ].filter(Boolean));
    own.allQueriesAgree = distinct.size <= 1;
    own.resolvedKey = own.allQueriesAgree ? uid : '(ambiguous)';

    row('auth.uid', own.authUid);
    row('canonical merchantId', own.canonicalMerchantId || '(none stored)');
    row('sellerUid on products', JSON.stringify(own.sellerUidOnProducts));
    row('sellerId on products', JSON.stringify(own.sellerIdOnProducts));
    row('all identifiers agree', own.allQueriesAgree);
    if (!own.allQueriesAgree) {
      row('distinct identifiers', JSON.stringify([...distinct]));
      console.warn('  OWNERSHIP DRIFT — subsystems keyed on different identifiers ' +
                   'will each count a different number of products.');
      if (report.consistency.status !== 'FAIL') {
        report.consistency.status = 'FAIL';
        report.consistency.reason = 'SELLER_KEY_MISMATCH';
        report.consistency.detail = 'identifiers differ: ' + JSON.stringify([...distinct]);
        mark('consistency', 'FAIL', { code: 'SELLER_KEY_MISMATCH', message: report.consistency.detail });
      }
    }
    report.ownership = own;
  } catch (e) {
    row('ownership', 'CHECK FAILED: ' + e.message);
    report.ownership = { error: e.message };
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
    report.timestamps.writeProbe = new Date().toISOString();
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
  report.timestamps.finished = new Date().toISOString();
  console.log('  ' + report.verdict);
  console.log('\n  Copy the artifact:  copy(JSON.stringify(report, null, 2))');
  return report;
};

console.log('%c sokoniDiagnoseUpload() ready — run: const report = await sokoniDiagnoseUpload() ',
            'background:#71ff00;color:#000;font-weight:bold');
