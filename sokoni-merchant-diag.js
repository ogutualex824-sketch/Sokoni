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

  /* The account a census is about. Signing in with the email account instead is
     the single likeliest cause of a "missing workspace", and it presents as an
     empty dashboard rather than as an error — so it is checked explicitly and
     named, rather than left for someone to infer.

     OVERRIDABLE, because a hardcoded expectation becomes a FALSE finding the
     moment a different account is censused: a correct sign-in would be reported
     as "WRONG ACCOUNT — the workspace is missing", which is precisely the kind
     of confident-but-wrong output a diagnostic must never produce. Set
     window.SOKONI_DIAG_ACCOUNT (phone or email) before load to census another
     identity; leave it unset and the check degrades to informational. */
  const EXPECTED_PHONE = (typeof window !== 'undefined' && window.SOKONI_DIAG_ACCOUNT)
    ? String(window.SOKONI_DIAG_ACCOUNT)
    : '+254705726803';
  const ACCOUNT_DECLARED = !!(typeof window !== 'undefined' && window.SOKONI_DIAG_ACCOUNT);

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

    /* The wrong-account case, named explicitly — but only asserted when the
       operator has DECLARED which account this census is about. Otherwise the
       mismatch is stated as context, not as a defect. */
    if (phone !== EXPECTED_PHONE && email !== EXPECTED_PHONE && !ACCOUNT_DECLARED) {
      note('info', 'This is not the account the default expectation names.',
        'Default expectation is ' + EXPECTED_PHONE + '. Set window.SOKONI_DIAG_ACCOUNT to ' +
        'declare the account under census; until then no wrong-account claim is made.');
      console.log('  ACCOUNT         ' + (phone || email || '(unknown)') +
                  '  (no declared expectation — not treated as wrong)');
    } else if (phone !== EXPECTED_PHONE && email !== EXPECTED_PHONE) {
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

  /* ── identity chain census ─────────────────────────────────────────────
     READ-ONLY. Every call below is a getDoc — it creates nothing and repairs
     nothing, deliberately. Making the UI work by writing a missing role or a
     second shop document is how a competing identity model gets born; the
     point here is to find out which identity is CANONICAL, not to manufacture
     one that satisfies the page.

     Repository reading predicts three structural divergences, and this block
     exists to prove or disprove each on a real signed-in device:

     1. ROLE is read from at least nine different signals across the app —
        users/{uid}.roles[], users/{uid}.role, isSeller, registeredAs,
        sellerActive, storeName, claims.seller, claims.roles[], claims.role.
        profile.html:5521 reads roles[]; script.js:3489 accepts any of five;
        functions/analytics-engine.js:90 reads claims.role. A seller can
        therefore be present in one and absent in another indefinitely.

     2. ACTIVE SHOP has three sources with NO agreed precedence:
          window.SokoniShell.activeShopId   (in-memory, set by merchant.html)
          localStorage.activeShopId         (merchant.html:1956)
          claims.shopId                     (the signed value)
        pos-completeness.html:524 and pos-kds.html:261 both resolve
        `localStorage || claims.shopId` — the CACHE outranks the SIGNED claim.
        merchant.html:2177 already warns that activeShopId survives an account
        switch, which is exactly how a shop can appear under a stale identity.

     3. KEY SPACE. `shops` is addressed two ways:
          shops/{sellerUid}    account-status.js:59, etims.js:517
          shops/{activeShopId} analytics-engine.js:83, finance-os-sprint43.js:28
        and ownership is expressed three ways: doc-id == uid, ownerId == uid,
        sellerUid == uid (merchant.html:2004). Meanwhile the server keys
        analytics as shopId: sellerUid (functions/index.js:3169/3201/3382)
        while the client passes the BRANCH id as the shop dimension
        (sokoni-analytics-engine.js:77). If activeShopId is a branch id and the
        analytics key is a sellerUid, Shop and Analytics cannot converge — not
        because a number is wrong, but because they are keyed differently. */
  async function identityBlock(uid, claims, ls) {
    const out = { usersDoc: null, activeShopId: null, shopByUid: null, shopByActive: null,
                  cfgByUid: null, cfgByActive: null, roleSignals: {}, divergences: [] };
    const bad = (msg, detail) => { out.divergences.push(msg); note('error', msg, detail); };

    let fs, db;
    try { fs = await import(FS_URL); } catch (e) {
      note('error', 'Firestore SDK failed to load — identity chain not read.', e && e.message);
      return out;
    }
    db = window.firebaseDB;
    if (!db) { note('error', 'window.firebaseDB absent — identity chain not read.'); return out; }

    const getDoc = async (label, coll, id) => {
      if (!id) return null;
      const s = now();
      try {
        const snap = await fs.getDoc(fs.doc(db, coll, String(id)));
        state.queries.push({ label, ok: true, count: snap.exists() ? 1 : 0, ms: now() - s });
        return snap.exists() ? snap.data() : null;
      } catch (e) {
        const code = (e && e.code) || 'unknown';
        state.queries.push({ label, ok: false, code, ms: now() - s });
        note(code === 'permission-denied' ? 'error' : 'warn', label + ' failed (' + code + ')',
          'A denied read is NOT evidence of absence — it is an unanswered question.');
        return undefined;                                  /* undefined = unknown, null = absent */
      }
    };

    console.log('%c  ── IDENTITY CHAIN ──', 'color:#71ff00;font-weight:bold');

    /* ── users/{uid}: the canonical profile ── */
    const u = await getDoc('USERS_DOC', 'users', uid);
    out.usersDoc = u;
    if (u === null) {
      bad('users/' + uid + ' does not exist.',
        'Every seller surface resolves role from this document. Its absence is the ' +
        'identity defect itself, not a symptom of one.');
    } else if (u) {
      const rawRoles = Array.isArray(u.roles) ? u.roles : (u.roles ? [String(u.roles)] : []);
      const norm = rawRoles.map((r) => String(r).toLowerCase());
      console.log('  users.roles[]   ' + (JSON.stringify(rawRoles)) + '   (raw, undeduped)');
      console.log('  users.role      ' + (u.role || '(unset)'));
      console.log('  users.sellerUid ' + (u.sellerUid || '(unset)'));
      console.log('  users.storeName ' + (u.storeName || u.shopName || '(unset)'));

      /* "Two buyer roles" is visible ONLY in the raw array — a Set hides it. */
      const dupes = norm.filter((r, i) => norm.indexOf(r) !== i);
      if (dupes.length) {
        bad('users/{uid}.roles contains DUPLICATES: ' + JSON.stringify([...new Set(dupes)]),
          'A duplicated role is not cosmetic: role ladders that pick roles[0] or count ' +
          'entries behave differently from ones that test includes(). Reconcile the array ' +
          'to a set — do not add a role to compensate.');
      }

      /* sellerUid must be the identity itself, never a pointer to another account. */
      if (u.sellerUid && String(u.sellerUid) !== String(uid)) {
        bad('users/{uid}.sellerUid points at a DIFFERENT uid (' + u.sellerUid + ').',
          'Products, shops and analytics are keyed by sellerUid. If it is not this uid, ' +
          'every seller surface resolves someone else\'s scope.');
      }

      out.roleSignals = {
        'users.roles[]':   norm.includes('seller') || norm.includes('vendor'),
        'users.role':      String(u.role || '').toLowerCase() === 'seller',
        'users.isSeller':  !!u.isSeller,
        'claims.seller':   !!claims.seller,
        'claims.role':     String(claims.role || '').toLowerCase() === 'seller',
        'claims.roles[]':  Array.isArray(claims.roles) && claims.roles.includes('seller'),
        'localStorage':    !!(ls && ((Array.isArray(ls.roles) && ls.roles.indexOf('seller') > -1) || ls.isSeller)),
      };
      const agree = Object.values(out.roleSignals);
      console.log('  SELLER SIGNALS  ' + Object.entries(out.roleSignals)
        .map(([k, v]) => k + '=' + (v ? 'Y' : 'n')).join('  '));
      if (agree.some(Boolean) && !agree.every(Boolean)) {
        bad('The seller role DISAGREES across signals — the role is not missing, it is inconsistent.',
          'Restore it from whichever source is canonical (claims are the client authority per ' +
          'the Role Authority work); do not set the ones that are false, or the divergence ' +
          'simply becomes permanent.');
      }
    }

    /* ── active shop: three sources, no agreed precedence ── */
    const shell = (window.SokoniShell && window.SokoniShell.activeShopId) || null;
    let lsShop = null; try { lsShop = localStorage.getItem('activeShopId') || null; } catch (_) {}
    const claimShop = claims.shopId || null;
    out.activeShopId = shell || lsShop || claimShop;
    console.log('  activeShopId    shell=' + (shell || '-') +
                '  localStorage=' + (lsShop || '-') + '  claim=' + (claimShop || '-'));
    if (lsShop && claimShop && lsShop !== claimShop) {
      bad('localStorage.activeShopId (' + lsShop + ') disagrees with the SIGNED claim (' + claimShop + ').',
        'pos-completeness.html:524 and pos-kds.html:261 resolve `localStorage || claims.shopId`, ' +
        'so the cache WINS. merchant.html:2177 already warns this value survives an account ' +
        'switch. This is the stale-identity path.');
    }

    /* ── shops: two key spaces, three ownership fields ── */
    const owns = (s) => !!s && (String(s.sellerUid || '') === String(uid) ||
                                String(s.ownerId  || '') === String(uid));
    out.shopByUid    = await getDoc('SHOP_BY_UID',    'shops', uid);
    out.shopByActive = (out.activeShopId && out.activeShopId !== uid)
      ? await getDoc('SHOP_BY_ACTIVE', 'shops', out.activeShopId) : out.shopByUid;

    console.log('  shops/{uid}     ' + (out.shopByUid === undefined ? 'UNREADABLE'
      : out.shopByUid ? 'exists  owner=' + (out.shopByUid.sellerUid || out.shopByUid.ownerId || '(none)') +
        '  handle=' + (out.shopByUid.minishopHandle || '(unclaimed)') : 'absent'));
    if (out.activeShopId && out.activeShopId !== uid) {
      console.log('  shops/{active}  ' + (out.shopByActive === undefined ? 'UNREADABLE'
        : out.shopByActive ? 'exists  owner=' + (out.shopByActive.sellerUid || out.shopByActive.ownerId || '(none)')
          : 'absent'));
      if (out.shopByActive && !owns(out.shopByActive)) {
        bad('shops/' + out.activeShopId + ' is NOT owned by this uid.',
          'The active shop resolves to another identity. Do NOT create a new shop to make the ' +
          'page render — correct activeShopId to the shop this uid actually owns.');
      }
      if (out.shopByActive === null && out.shopByUid) {
        bad('activeShopId points at a shop document that does not exist, while shops/{uid} does.',
          'Two key spaces are in play: shops/{sellerUid} (account-status.js:59) vs ' +
          'shops/{activeShopId} (analytics-engine.js:83). activeShopId is a BRANCH id here.');
      }
    }

    /* ── minishopConfig: the populated / partially-populated split ── */
    out.cfgByUid = await getDoc('MSCFG_BY_UID', 'minishopConfig', uid);
    if (out.activeShopId && out.activeShopId !== uid) {
      out.cfgByActive = await getDoc('MSCFG_BY_ACTIVE', 'minishopConfig', out.activeShopId);
    }
    const fieldCount = (o) => (o && typeof o === 'object') ? Object.keys(o).length : 0;
    console.log('  minishopConfig  byUid=' + (out.cfgByUid === undefined ? 'UNREADABLE'
      : out.cfgByUid ? fieldCount(out.cfgByUid) + ' fields' : 'absent') +
      (out.activeShopId && out.activeShopId !== uid
        ? '  byActive=' + (out.cfgByActive === undefined ? 'UNREADABLE'
          : out.cfgByActive ? fieldCount(out.cfgByActive) + ' fields' : 'absent') : ''));
    if (out.shopByUid && out.cfgByUid === null && out.cfgByActive == null) {
      bad('shops/{uid} exists but minishopConfig has no document for this identity.',
        'The storefront reads minishopConfig; the dashboard reads shops. A shop that is ' +
        'populated on one side and absent on the other renders as "my shop exists but shows ' +
        'nothing" — and is a key-space split, not missing content.');
    }

    /* ── analytics scope: the key the SERVER aggregates under ── */
    console.log('  ANALYTICS KEY   server aggregates shopId=<sellerUid> ' +
                '(functions/index.js:3169/3201/3382); client passes branch=' + (shell || '-'));
    if (out.activeShopId && String(out.activeShopId) !== String(uid)) {
      note('warn', 'Analytics is keyed by sellerUid, but this session\'s shop scope is a branch id.',
        'Reconcile the SCOPE KEYS and let analytics re-derive from canonical commerce data. ' +
        'Never copy figures between profiles to make a dashboard agree — the next POS sale, ' +
        'refund or inventory change would silently contradict it.');
    }

    return out;
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
    let identity = null;
    if (auth) {
      workspaceBlock(auth.ls);
      /* Identity BEFORE products: a product census reported against the wrong
         scope reads as "no products" when the truth is "not my shop". */
      identity = await identityBlock(auth.user.uid, auth.claims || {}, auth.ls);
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

    window._md = { page: state.page, findings: state.findings, queries: state.queries, identity };
    return window._md;
  }

  if (document.readyState === 'complete') setTimeout(run, 400);
  else window.addEventListener('load', () => setTimeout(run, 400));

  return { run, state };
})();
