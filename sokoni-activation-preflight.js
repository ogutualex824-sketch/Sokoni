/* ══════════════════════════════════════════════════════════════════════════
   SOKONI — Merchant activation preflight

   PURPOSE
   "No future provisioning failure should require source-code tracing to
   determine why activation stopped." This runs the activation prerequisites in
   the same order the server does and reports the FIRST one that fails, with the
   evidence that proves it — on the device, in the merchant's hands.

   WHY A SEPARATE PASS RATHER THAN BETTER ERROR MESSAGES
   Better messages explain a failure once it happens. This finds the blocker
   before provisioning starts, and distinguishes causes that produce an
   identical symptom. Two examples already found by reading the code, which this
   can now confirm or refute at runtime instead of by argument:

     - functions/business-bootstrap.js:884 (_getMyBusinesses) FABRICATES a
       branch id — `${merchantId}-main` — whenever the business has no
       defaultBranchId. The picker then shows a branch that may not exist, and
       provisioning proceeds against it.
     - _assertMerchantAccess accepts four different ownership paths. When it
       denies, it does not say WHICH path was expected to match, so "you do not
       belong to this merchant" is true but not actionable.

   READ-ONLY. Calls the same callables provisioning calls, writes nothing, and
   registers no device. Running it cannot change activation state.
   ══════════════════════════════════════════════════════════════════════════ */
window.SokoniActivationPreflight = (() => {
  'use strict';

  const REGION = 'us-central1';

  const stage = (id, label) => ({ id, label, status: 'pending', detail: '', evidence: null });

  function _code(err) {
    return String((err && (err.code || err.name)) || 'unknown').replace(/^functions\//, '');
  }

  async function _callable(name) {
    const m = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js');
    const fns = m.getFunctions(window.firebaseApp, REGION);
    return m.httpsCallable(fns, name);
  }

  /* ── run ──────────────────────────────────────────────────────────────────
     opts.merchantId / opts.branchId are optional. When absent the preflight
     discovers them, which is itself one of the checks. */
  async function run(opts) {
    opts = opts || {};
    const started = Date.now();
    const stages = [
      stage('auth',     'Signed in'),
      stage('token',    'Permissions loaded'),
      stage('discover', 'Businesses found for this account'),
      stage('business', 'Business selected'),
      stage('branch',   'Branch exists'),
      stage('access',   'Authorised for this business'),
      stage('config',   'Business configuration downloads'),
    ];
    const S = (id) => stages.find((x) => x.id === id);
    const done = (id, status, detail, evidence) => {
      const s = S(id); s.status = status; s.detail = detail || '';
      if (evidence !== undefined) s.evidence = evidence;
    };
    /* Everything after the first blocker is 'skipped', not 'failed' — reporting
       five failures when one thing is wrong sends people fixing the wrong ones. */
    const skipRest = (fromId) => {
      let hit = false;
      stages.forEach((s) => {
        if (s.id === fromId) { hit = true; return; }
        if (hit && s.status === 'pending') { s.status = 'skipped'; s.detail = 'not reached'; }
      });
    };
    const finish = (blockedAt) => ({
      ok: !blockedAt, blockedAt: blockedAt || null, stages,
      ms: Date.now() - started,
    });

    /* 1. auth */
    const user = window.firebaseAuth && window.firebaseAuth.currentUser;
    if (!user) {
      done('auth', 'fail', 'No signed-in user. Sign in, then restart setup.');
      skipRest('auth');
      return finish('auth');
    }
    done('auth', 'pass', user.uid, {
      uid: user.uid, phone: user.phoneNumber || null, email: user.email || null,
      providers: (user.providerData || []).map((p) => p.providerId),
    });

    /* 2. claims — forced refresh, because a stale token is a common cause of a
       grant that "did not work". */
    let claims = {};
    try {
      const r = await user.getIdTokenResult(true);
      claims = r.claims || {};
      const age = r.issuedAtTime ? Math.round((Date.now() - new Date(r.issuedAtTime)) / 1000) : null;
      done('token', 'pass', 'refreshed' + (age !== null ? ' (' + age + 's old)' : ''), {
        admin: !!claims.admin, superAdmin: !!claims.superAdmin,
        merchantIds: claims.merchantIds || claims.merchantId || null,
      });
    } catch (e) {
      done('token', 'fail', 'Could not read permissions: ' + (e && e.message), { code: _code(e) });
      skipRest('token');
      return finish('token');
    }

    /* 3. discovery */
    let businesses = [];
    try {
      const fn = await _callable('smartPosDispatch');
      const res = await fn({ op: 'getMyBusinesses' }).catch(async () => {
        const direct = await _callable('getMyBusinesses');
        return direct({});
      });
      businesses = (res && res.data && res.data.businesses) || [];
      if (!businesses.length) {
        done('discover', 'fail',
          'This account owns no business. POS setup needs one you own, or staff ' +
          'membership on someone else\'s branch. Create a business first, or ask ' +
          'the owner to add you as POS staff.', { count: 0 });
        skipRest('discover');
        return finish('discover');
      }
      done('discover', 'pass', businesses.length + ' business(es)',
        businesses.map((b) => ({ merchantId: b.merchantId, name: b.name, branch: b.branch, role: b.role })));
    } catch (e) {
      done('discover', 'fail', 'Business lookup failed (' + _code(e) + '): ' + (e && e.message),
        { code: _code(e) });
      skipRest('discover');
      return finish('discover');
    }

    /* 4. selection */
    const chosen = opts.merchantId
      ? businesses.find((b) => b.merchantId === opts.merchantId) || { merchantId: opts.merchantId }
      : businesses[0];
    if (!chosen || !chosen.merchantId) {
      done('business', 'fail', 'No business selected.');
      skipRest('business');
      return finish('business');
    }
    done('business', 'pass', chosen.merchantId + (chosen.name ? ' — ' + chosen.name : ''), chosen);

    /* 5. branch — the fabricated-id check.
       _getMyBusinesses returns `${merchantId}-main` when the business has no
       defaultBranchId. That id may not correspond to a real branch, and
       provisioning would then run against something that does not exist. */
    const branchId = opts.branchId || chosen.branch;
    if (!branchId) {
      done('branch', 'fail', 'No branch on this business. Create a branch before provisioning.');
      skipRest('branch');
      return finish('branch');
    }
    const looksSynthesised = branchId === (chosen.merchantId + '-main');
    done('branch', looksSynthesised ? 'warn' : 'pass', branchId,
      { branchId, synthesised: looksSynthesised,
        note: looksSynthesised
          ? 'This id was generated as "<merchantId>-main" because the business has no ' +
            'defaultBranchId. If the branch document does not exist, configuration ' +
            'download will fail here even though authorisation succeeds.'
          : null });

    /* 6 + 7. access and config are the same call — bootstrapDevice fails at
       _assertMerchantAccess before it builds anything, so the error code
       separates them. */
    try {
      const fn = await _callable('bootstrapDevice');
      const res = await fn({ merchantId: chosen.merchantId, branchId });
      done('access', 'pass', 'authorised');
      const d = (res && res.data) || {};
      done('config', 'pass',
        (Array.isArray(d.products) ? d.products.length : 0) + ' products · ' +
        (Array.isArray(d.paymentMethods) ? d.paymentMethods.length : 0) + ' payment method(s)',
        { version: d.version || null,
          hasReceipt: !!d.receipt, hasTax: !!d.tax, hasLoyalty: !!(d.loyalty && d.loyalty.enabled) });
      return finish(null);
    } catch (e) {
      const code = _code(e);
      if (code === 'permission-denied') {
        done('access', 'fail',
          'Authorisation refused. The server accepts FOUR routes and none matched:\n' +
          '  1. platform admin claim — ' + (claims.admin || claims.superAdmin ? 'held' : 'not held') + '\n' +
          '  2. owner of businesses/' + chosen.merchantId + '\n' +
          '  3. active POS staff on branch ' + branchId + '\n' +
          '  4. owner or adminUid on merchants/' + chosen.merchantId + '\n' +
          'The business picker listed this business, which means route 2 or 4 matched ' +
          'during discovery — so the likely difference is the BRANCH, not the business.',
          { code, message: e && e.message, merchantId: chosen.merchantId, branchId,
            branchSynthesised: looksSynthesised });
        skipRest('access');
        return finish('access');
      }
      done('access', 'pass', 'authorisation passed; failure came later');
      done('config', 'fail',
        code === 'not-found'     ? 'Business or branch document does not exist.' :
        code === 'internal'      ? 'Server error while building configuration — not fixable from this device.' :
        code === 'unavailable'   ? 'Server did not respond. This one is worth retrying.' :
        code === 'unauthenticated' ? 'Session expired mid-check. Sign in again.' :
        'Configuration download failed (' + code + ').',
        { code, message: e && e.message, merchantId: chosen.merchantId, branchId });
      skipRest('config');
      return finish('config');
    }
  }

  /* ── report ─────────────────────────────────────────────────────────────── */
  function format(result) {
    const icon = { pass: '✓', fail: '✗', warn: '!', skipped: '·', pending: '·' };
    const lines = ['SOKONI activation preflight — ' + result.ms + 'ms', ''];
    result.stages.forEach((s) => {
      lines.push((icon[s.status] || '?') + ' ' + s.label + (s.detail ? ' — ' + s.detail : ''));
    });
    if (result.blockedAt) {
      const b = result.stages.find((x) => x.id === result.blockedAt);
      lines.push('', 'BLOCKED AT: ' + b.label);
      if (b.evidence) lines.push(JSON.stringify(b.evidence, null, 2));
    } else {
      lines.push('', 'All checks passed — provisioning should complete.');
    }
    return lines.join('\n');
  }

  async function runAndLog(opts) {
    const r = await run(opts);
    console.groupCollapsed('%c[Activation preflight] ' + (r.ok ? 'PASS' : 'BLOCKED at ' + r.blockedAt),
      'color:' + (r.ok ? '#71ff00' : '#ff6b6b') + ';font-weight:bold');
    console.log(format(r));
    console.groupEnd();
    window._preflight = r;
    return r;
  }

  return { run, runAndLog, format };
})();
