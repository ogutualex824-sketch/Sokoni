/* ══════════════════════════════════════════════════════════════════════════
   SOKONI — Merchant workspace diagnostics

   WHY THIS EXISTS
   The merchant workspace cannot be certified from this environment. Certifying
   Workstreams 1-5 requires being signed in as +254705726803, and that account
   authenticates by phone OTP — an SMS to a physical handset. There is no test
   credential, App Check blocks REST, and headless WebKit cannot complete the
   flow. So the honest split is: the operator runs the pages on their phone, and
   this module makes that run produce evidence instead of impressions.

   It is READ-ONLY BY CONSTRUCTION. It issues no writes, creates no documents,
   and changes no ownership. Every Firestore call it makes is a count or a
   fetch, so running it can never alter what it is measuring.

   THE SPECIFIC QUESTION IT ANSWERS
   Repository reading predicts one high-impact divergence, and the whole point
   of the product census below is to prove or disprove it on a real device:

     seller.js:814  displaySellerProducts() reads localStorage 'sellerProducts'
     sokoni-sync.js:255  which is hydrated ONLY from userSync/{uid}/products
     — never from the canonical 'products' collection

   The storefront, checkout and marketplace read canonical `products`. The
   merchant dashboard reads a private per-user mirror. If the KASS VAPES
   products were placed in `products` directly — which is what an ownership
   migration does — the dashboard shows nothing while the storefront shows
   three items, and both are behaving exactly as written.

   PRODUCTS_CANONICAL vs PRODUCTS_MIRROR below is therefore the single most
   diagnostic line this module prints. If they disagree, that is the defect.
   ══════════════════════════════════════════════════════════════════════════ */
window.SokoniMerchantDiag = (() => {
  'use strict';

  const FS_URL = 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

  /* The account this sprint is about. Signing in with the email account instead
     is the single likeliest cause of a "missing workspace", and it presents as
     an empty dashboard rather than as an error — so it is checked explicitly
     and named, rather than left for someone to infer. */
  const EXPECTED_PHONE = '+254705726803';

  const t0 = (window.performance && performance.now) ? performance.now() : Date.now();
  const now = () => ((window.performance && performance.now) ? performance.now() : Date.now());
  const ms  = (v) => Math.round(v) + 'ms';

  const state = {
    page: (location.pathname.split('/').pop() || 'index').replace(/\.html$/, ''),
    findings: [],   /* every permission failure / mismatch, in order */
    queries:  [],   /* every Firestore read attempted, with outcome + timing */
  };

  const note = (level, msg, detail) => {
    state.findings.push({ level, msg, detail });
    return { level, msg, detail };
  };

  /* ── auth ──────────────────────────────────────────────────────────────
     Waits rather than sampling. Sampling at script-execution time reports
     "signed out" for a signed-in user roughly every load, which would make
     every other line in the report wrong. */
  function waitForAuth(timeoutMs = 12000) {
    return new Promise((resolve) => {
      const started = now();
      const tick = () => {
        const a = window.firebaseAuth;
        if (a && a.currentUser) return resolve({ user: a.currentUser, waited: now() - started });
        if (a && a._sk_authResolved) return resolve({ user: null, waited: now() - started });
        if (now() - started > timeoutMs) return resolve({ user: null, waited: now() - started, timedOut: true });
        setTimeout(tick, 120);
      };
      tick();
    });
  }

  async function authBlock() {
    const { user, waited, timedOut } = await waitForAuth();

    if (!user) {
      note('error', timedOut
        ? 'No authenticated user after 12s — auth never resolved.'
        : 'Signed out.');
      console.log('%c  AUTH            signed out' + (timedOut ? ' (timed out)' : ''), 'color:#ff6b6b');
      return null;
    }

    const providers = (user.providerData || []).map((p) => p.providerId);
    const phone = user.phoneNumber || null;
    const email = user.email || null;

    console.log('  AUTH            uid=' + user.uid);
    console.log('  PHONE           ' + (phone || '(none)'));
    console.log('  EMAIL           ' + (email || '(none)'));
    console.log('  PROVIDERS       ' + (providers.join(', ') || '(none)'));
    console.log('  AUTH RESOLVED   ' + ms(waited));

    /* The wrong-account case, named explicitly. */
    if (phone !== EXPECTED_PHONE) {
      if (email && !phone) {
        note('error', 'Signed in with the EMAIL account, not the phone account.',
          'The seller role and KASS VAPES products belong to the ' + EXPECTED_PHONE +
          ' UID. This account is a different Firebase Auth user with a different uid, ' +
          'so the merchant workspace is genuinely absent — not broken.');
        console.log('%c  ⚠ WRONG ACCOUNT — this is the email identity (' + email + ').\n' +
                    '    The workspace is missing because the seller role and products\n' +
                    '    live under a DIFFERENT uid (' + EXPECTED_PHONE + ').',
                    'color:#ffb020;font-weight:bold');
      } else {
        note('warn', 'Phone number is not the expected sprint account.',
          'expected ' + EXPECTED_PHONE + ', got ' + (phone || '(none)'));
        console.log('%c  ⚠ Expected ' + EXPECTED_PHONE + ', got ' + (phone || '(none)'),
                    'color:#ffb020;font-weight:bold');
      }
    }

    /* Claims are the server's view of role. localStorage is the client's view.
       They are read separately and compared, because the client role ladder
       (sokoni-nav-engine.js:39) reads localStorage and never consults claims —
       so the two can disagree indefinitely without anything reporting it. */
    let claims = {};
    try {
      const r = await user.getIdTokenResult();
      claims = r.claims || {};
    } catch (e) {
      note('error', 'Could not read ID token claims.', e && e.message);
      console.log('%c  CLAIMS          UNREADABLE — ' + (e && e.message), 'color:#ff6b6b');
    }

    const claimRoles = ['seller', 'admin', 'superAdmin', 'driver', 'rider', 'provider']
      .filter((k) => claims[k]);
    console.log('  CLAIMS          ' + (claimRoles.join(', ') || '(no role claims)') +
                (claims.betaStatus ? '  beta=' + claims.betaStatus : ''));

    let ls = null;
    try { ls = JSON.parse(localStorage.getItem('sokoniUser') || 'null'); } catch (_) {}
    const lsRoles = ls && Array.isArray(ls.roles) ? ls.roles : [];
    console.log('  LOCAL ROLES     ' + (lsRoles.join(', ') || '(none)') +
                (ls && ls.isSeller ? '  isSeller=true' : ''));
    console.log('  LOCAL NAME      ' + ((ls && (ls.storeName || ls.name)) || '(none)'));

    const clientSeller = lsRoles.indexOf('seller') > -1 || !!(ls && ls.isSeller);
    if (clientSeller !== !!claims.seller) {
      note('warn', 'Seller role disagrees between custom claims and localStorage.',
        'claim=' + !!claims.seller + ' local=' + clientSeller +
        ' — navigation and permissions read localStorage; Firestore rules read claims.');
      console.log('%c  ⚠ ROLE SPLIT    claim=' + !!claims.seller + '  local=' + clientSeller,
                  'color:#ffb020;font-weight:bold');
    }

    /* App Check: presence of the provider, not validity. Validity is only ever
       decided server-side, and claiming otherwise here would be a fabricated
       green light. A denied read below is the real signal. */
    console.log('  APP CHECK       ' + (window.firebaseAppCheck ? 'initialised (validity is server-side)'
                                                               : 'NOT initialised on this page'));
    if (!window.firebaseAppCheck) {
      note('warn', 'App Check not initialised on this page.',
        'Callables and Firestore reads may be rejected before rules are evaluated.');
    }

    return { user, claims, ls };
  }

  /* ── workspace ─────────────────────────────────────────────────────── */
  function workspaceBlock(ls) {
    const active = localStorage.getItem('sokoniActiveWorkspace') || null;
    console.log('  WORKSPACE       ' + (active || '(personal — no active business)'));
    console.log('  ACTIVE ROLE     ' + ((ls && ls.activeRole) || (ls && ls.role) || '(unset)'));

    let memberships = [];
    try { memberships = JSON.parse(localStorage.getItem('sokoniWorkspaces') || '[]'); } catch (_) {}
    console.log('  MEMBERSHIPS     ' + (memberships.length
      ? memberships.map((m) => (m.businessName || m.businessId) + ':' + (m.role || '?')).join(', ')
      : '(none)'));

    /* Merchant pages resolve identity from auth.currentUser.uid, never from the
       active workspace (verified across seller.html, inventory.html,
       seller-analytics.html). For a sole trader those are the same value, so
       this only bites staff — worth stating when it applies rather than
       asserting a bug that is not present for this account. */
    if (active && (!ls || !ls.uid || active !== ls.uid)) {
      note('info', 'A business workspace is active, but merchant pages query the personal uid.',
        'Harmless for a sole trader (same value). For staff operating under an ' +
        'employer, pages would query the wrong identity.');
    }
    return active;
  }

  /* ── product census — the decisive measurement ─────────────────────── */
  async function productBlock(uid) {
    const out = { canonical: null, mirror: null, local: null, names: [] };

    let fs;
    try { fs = await import(FS_URL); }
    catch (e) {
      note('error', 'Firestore SDK failed to load.', e && e.message);
      console.log('%c  PRODUCTS        SDK LOAD FAILED — ' + (e && e.message), 'color:#ff6b6b');
      return out;
    }
    const db = window.firebaseDB;
    if (!db) {
      note('error', 'window.firebaseDB is absent — no Firestore on this page.');
      console.log('%c  PRODUCTS        NO DB HANDLE', 'color:#ff6b6b');
      return out;
    }

    const run = async (label, build) => {
      const s = now();
      try {
        const snap = await fs.getDocs(build());
        const took = now() - s;
        state.queries.push({ label, ok: true, count: snap.size, ms: took });
        return snap;
      } catch (e) {
        const took = now() - s;
        const code = (e && e.code) || 'unknown';
        state.queries.push({ label, ok: false, code, ms: took, message: e && e.message });
        note(code === 'permission-denied' ? 'error' : 'warn',
          label + ' denied/failed (' + code + ')', e && e.message);
        console.log('%c  ' + label.padEnd(15) + ' FAILED ' + code + '  (' + ms(took) + ')',
                    'color:#ff6b6b');
        return null;
      }
    };

    /* What the storefront, marketplace and checkout see. */
    const canon = await run('PRODUCTS_CANON', () =>
      fs.query(fs.collection(db, 'products'), fs.where('sellerUid', '==', uid)));
    if (canon) {
      out.canonical = canon.size;
      canon.forEach((d) => {
        const v = d.data() || {};
        out.names.push({ id: d.id, title: v.title || v.name || '(untitled)', sellerName: v.sellerName || null });
      });
    }

    /* Legacy duplicate field written alongside sellerUid at seller.js:742. */
    const canonUid = await run('PRODUCTS_UID', () =>
      fs.query(fs.collection(db, 'products'), fs.where('uid', '==', uid)));

    /* What the merchant dashboard's list is actually fed from. */
    const mirror = await run('PRODUCTS_MIRROR', () =>
      fs.collection(db, 'userSync', uid, 'products'));
    if (mirror) out.mirror = mirror.size;

    let local = [];
    try { local = JSON.parse(localStorage.getItem('sellerProducts') || '[]'); } catch (_) {}
    out.local = local.length;

    console.log('  PRODUCTS_CANON  ' + (out.canonical == null ? 'denied' : out.canonical) +
                '   (products where sellerUid == you — storefront/marketplace)');
    console.log('  PRODUCTS_UID    ' + (canonUid ? canonUid.size : 'denied') +
                '   (products where uid == you — legacy duplicate field)');
    console.log('  PRODUCTS_MIRROR ' + (out.mirror == null ? 'denied' : out.mirror) +
                '   (userSync/' + uid.slice(0, 6) + '…/products — feeds the dashboard)');
    console.log('  PRODUCTS_LOCAL  ' + out.local +
                '   (localStorage sellerProducts — what the list renders)');

    if (out.canonical != null && out.mirror != null && out.canonical !== out.mirror) {
      note('error', 'Product sources disagree: canonical=' + out.canonical + ' mirror=' + out.mirror + '.',
        'The dashboard list (seller.js:814) renders localStorage, hydrated only from the ' +
        'mirror (sokoni-sync.js:255). Products added straight to the canonical collection — ' +
        'which is what an ownership migration does — never reach it.');
      console.log('%c  ✗ SOURCE DIVERGENCE — dashboard cannot show canonical products.\n' +
                  '    canonical=' + out.canonical + '  mirror=' + out.mirror + '  local=' + out.local,
                  'color:#ff6b6b;font-weight:bold');
    }

    /* sellerName is denormalised onto each product at creation (seller.js:673)
       and nothing backfills it. After a rename, old documents keep the old
       value — and store.html:471 matches a storefront by name equality. */
    const stale = out.names.filter((p) => p.sellerName && /^\+?\d[\d\s]{6,}$/.test(p.sellerName));
    if (stale.length) {
      note('error', stale.length + ' product(s) still carry a phone number as sellerName.',
        'seller.js:673 denormalises sellerName at creation and no code backfills it. ' +
        'store.html:471 matches storefronts by name equality, so these products can ' +
        'detach from the KASS VAPES storefront.');
      console.log('%c  ✗ STALE sellerName on ' + stale.length + ' product(s): ' +
                  stale.map((p) => p.sellerName).join(', '), 'color:#ff6b6b;font-weight:bold');
    }
    if (out.names.length) {
      console.log('  TITLES          ' + out.names.map((p) =>
        p.title + ' [' + (p.sellerName || 'no sellerName') + ']').join('  |  '));
    }

    return out;
  }

  /* ── orders ────────────────────────────────────────────────────────── */
  async function orderBlock(uid) {
    let fs;
    try { fs = await import(FS_URL); } catch (_) { return; }
    const db = window.firebaseDB;
    if (!db) return;

    const s = now();
    try {
      const snap = await fs.getDocs(fs.query(fs.collection(db, 'orders'),
        fs.where('sellerUid', '==', uid), fs.limit(50)));
      state.queries.push({ label: 'ORDERS_SCOPED', ok: true, count: snap.size, ms: now() - s });
      console.log('  ORDERS          ' + snap.size + ' (scoped by sellerUid)');
    } catch (e) {
      const code = (e && e.code) || 'unknown';
      state.queries.push({ label: 'ORDERS_SCOPED', ok: false, code, ms: now() - s });
      note('error', 'Scoped orders query failed (' + code + ')', e && e.message);
      console.log('%c  ORDERS          FAILED ' + code, 'color:#ff6b6b');
    }

    /* seller-analytics.html:396 and seller-revenue.html:491 fetch these
       collections UNSCOPED and filter client-side. firestore.rules:277 requires
       a sellerUid match, and Firestore evaluates rules against the query rather
       than the results — so the read is refused outright. Both pages catch and
       return [], which renders as "no data" rather than as an error. Reproduced
       here so the denial is visible instead of silent. */
    if (state.page === 'seller-analytics' || state.page === 'seller-revenue') {
      const s2 = now();
      try {
        await fs.getDocs(fs.query(fs.collection(db, 'orders'),
          fs.orderBy('createdAt', 'desc'), fs.limit(500)));
        state.queries.push({ label: 'ORDERS_UNSCOPED', ok: true, ms: now() - s2 });
        console.log('  ORDERS_UNSCOPED allowed (admin, or rules are looser than read)');
      } catch (e) {
        const code = (e && e.code) || 'unknown';
        state.queries.push({ label: 'ORDERS_UNSCOPED', ok: false, code, ms: now() - s2 });
        note('error', 'This page\'s own unscoped orders query is denied (' + code + ').',
          'seller-analytics.html:401 catches this and returns [], so the page renders ' +
          'empty instead of reporting a permission failure. Analytics is not "no sales" — ' +
          'it is "not allowed to ask".');
        console.log('%c  ✗ UNSCOPED ORDERS DENIED (' + code + ') — this page renders\n' +
                    '    empty rather than reporting it. Analytics figures are not real.',
                    'color:#ff6b6b;font-weight:bold');
      }
    }
  }

  /* ── render completion ─────────────────────────────────────────────── */
  function renderBlock() {
    const marks = [
      ['sellerProductsContainer', 'products list'],
      ['ordersList',              'orders list'],
      ['statsGrid',               'stats'],
    ];
    marks.forEach(([id, label]) => {
      const el = document.getElementById(id);
      if (!el) return;
      const filled = el.children.length > 0 || el.textContent.trim().length > 0;
      console.log('  RENDER          ' + label + ': ' + (filled ? 'painted' : 'EMPTY'));
      if (!filled) note('warn', label + ' rendered empty.', '#' + id + ' has no content after load.');
    });
  }

  /* ── run ───────────────────────────────────────────────────────────── */
  async function run() {
    console.groupCollapsed('%c[Merchant] ' + state.page + ' — diagnostics',
      'color:#71ff00;font-weight:bold');
    console.log('  PAGE            ' + location.pathname);
    console.log('  ONLINE          ' + navigator.onLine + '   viewport ' + innerWidth + 'x' + innerHeight);

    const auth = await authBlock();
    if (auth) {
      workspaceBlock(auth.ls);
      await productBlock(auth.user.uid);
      await orderBlock(auth.user.uid);
    }
    renderBlock();

    console.log('  QUERIES         ' + state.queries.length + ' issued');
    state.queries.forEach((q) => console.log('    ' + (q.ok ? 'ok    ' : 'FAIL  ') +
      q.label.padEnd(16) + (q.ok ? q.count + ' docs' : q.code) + '  ' + ms(q.ms)));
    console.log('  TOTAL           ' + ms(now() - t0));

    const errs  = state.findings.filter((f) => f.level === 'error');
    const warns = state.findings.filter((f) => f.level === 'warn');
    if (errs.length || warns.length) {
      console.log('%c  ── ' + errs.length + ' error(s), ' + warns.length + ' warning(s) ──',
        'color:' + (errs.length ? '#ff6b6b' : '#ffb020') + ';font-weight:bold');
      state.findings.forEach((f) => {
        if (f.level === 'info') return;
        console.log('%c  • ' + f.msg, 'color:' + (f.level === 'error' ? '#ff6b6b' : '#ffb020'));
        if (f.detail) console.log('      ' + f.detail);
      });
    } else {
      console.log('%c  ── no defects detected on this page ──', 'color:#71ff00');
    }
    console.groupEnd();

    window._md = { page: state.page, findings: state.findings, queries: state.queries };
    return window._md;
  }

  if (document.readyState === 'complete') setTimeout(run, 400);
  else window.addEventListener('load', () => setTimeout(run, 400));

  return { run, state };
})();
