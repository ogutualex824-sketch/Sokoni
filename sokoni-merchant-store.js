/* ════════════════════════════════════════════════════════════════════════════
   SOKONI Merchant Store — the client layer (2D-2 Store Stage 2)

   Built on the six authorities the Store census classified SAFE, and nothing
   else:

       getMyMinishop              shop identity — RESOLVED server-side from uid
       saveMinishopConfig         storefront configuration
       claimMinishopHandle        the handle — takes no shopId at all
       getMinishopAnalytics       analytics + the authoritative follower count
       generateMinishopShareCard  share URLs and text

   ── Identity: resolved, never assumed ───────────────────────────────────────
   `getMyMinishop` and `claimMinishopHandle` accept no shopId; they query
   `shops where sellerUid == uid` and return the document's own id. So the
   surface learns its shopId FROM THE SERVER and passes that same value back to
   the calls that need one — where `_assertShopOwner` verifies it again.

   A shopId is therefore never taken from `SokoniShell.activeShopId`, from the
   URL, or from anything a browser could edit. If the server says this account
   owns no shop, the answer is "no shop yet" — never a fallback to the uid.
   That fallback is precisely what made a correctly-provisioned merchant look
   broken in 2D-1, and it is not reintroduced here.

   ── The follower count has ONE source ───────────────────────────────────────
   `getMinishopAnalytics` returns `followerCount` read from `minishopConfig`,
   which Store Stage 1B made derivable only from the authoritative
   `shopFollowers/{shopId}_{uid}` relationship inside a transaction. This module
   does not count followers itself and does not cache the number — a second
   place that computes it would be a second authority, which is the defect
   Stage 1B just removed.

   ── No Firestore access ─────────────────────────────────────────────────────
   None. Every read and every write is a callable. `minishopConfig` and
   `shopHandles` are publicly readable, so a client read would have worked — and
   would have made the surface depend on a projection the server does not
   promise. `minishopAnalytics` could not be read from a client at all: its rule
   gates on `ownerUid`, a field nothing writes.
   ════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SokoniMerchantStore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CALLABLES = {
    identity: 'getMyMinishop',
    saveConfig: 'saveMinishopConfig',
    claimHandle: 'claimMinishopHandle',
    analytics: 'getMinishopAnalytics',
    shareCard: 'generateMinishopShareCard',
  };

  /* Mirrors STRING_FIELDS in functions/minishop-config-schema.js — the server
     owns the list and the caps; this is the subset a phone-sized storefront
     editor exposes, with the server's own limits so a refusal is rare and
     explicable rather than surprising. */
  /* EVERY FIELD HERE IS BACKED BY functions/minishop-config-schema.js. The maxima and
     item limits below are that schema's, not new ones — a client limit that disagrees
     with the server's would either reject text the server would accept or promise a save
     the server then truncates.

     CANONICAL NAMES ONLY. The schema aliases coverImage->coverUrl, logoImage->logoUrl and
     accentColor->brandColor for legacy inbound data. Sending a canonical name is what
     stops a merchant ending up with two competing values for one setting.

     NOT HERE, DELIBERATELY: the eight social handles seller.html collects
     (instagram/tiktok/whatsapp/facebook/twitter/youtube/linkedin/snapchat). They are NOT
     in the server schema, so rendering inputs for them would silently discard whatever a
     merchant typed. They need a schema change first — a Functions slice, not this one. */
  var TEXT_FIELDS = [
    /* ── Identity & branding ─────────────────────────────────────────────────── */
    { id: 'tagline',        label: 'Tagline',            max: 200,  hint: 'One line under your shop name', rows: 1, group: 'identity' },
    { id: 'description',    label: 'About the shop',     max: 1000, hint: 'What you sell and what makes it worth buying', rows: 4, group: 'identity' },
    { id: 'logoUrl',        label: 'Shop logo',          max: 500,  hint: 'Square image. This replaces the initials everywhere your shop appears.', rows: 1, group: 'identity', type: 'url', preview: 'logo' },
    { id: 'coverUrl',       label: 'Cover image',        max: 500,  hint: 'Wide banner across the top of your storefront', rows: 1, group: 'identity', type: 'url', preview: 'cover' },

    /* ── Appearance ──────────────────────────────────────────────────────────── */
    { id: 'brandColor',     label: 'Brand colour',       max: 32,   hint: 'Buttons and highlights on your storefront', rows: 1, group: 'appearance', type: 'color' },
    { id: 'theme',          label: 'Theme',              max: 40,   hint: '', rows: 1, group: 'appearance', type: 'select', options: ['', 'dark', 'light', 'midnight', 'classic'] },
    { id: 'fontFamily',     label: 'Typeface',           max: 60,   hint: '', rows: 1, group: 'appearance', type: 'select', options: ['', 'Inter', 'Poppins', 'Georgia', 'Roboto Slab', 'system-ui'] },

    /* ── Delivery & service ──────────────────────────────────────────────────── */
    { id: 'deliveryPolicy', label: 'Delivery',           max: 500,  hint: 'Where you deliver and what it costs', rows: 3, group: 'delivery' },
    { id: 'deliveryAreas',  label: 'Delivery areas',     max: 20,   itemMax: 100, hint: 'Add each area you cover', rows: 1, group: 'delivery', type: 'chips' },
    { id: 'responseTime',   label: 'Typical reply time', max: 60,   hint: 'e.g. within an hour', rows: 1, group: 'delivery' },

    /* ── Payments & policies ─────────────────────────────────────────────────── */
    { id: 'paymentMethods', label: 'Payment methods',    max: 10,   itemMax: 50,  hint: 'M-PESA, cash on delivery, card…', rows: 1, group: 'payments', type: 'chips' },
    { id: 'policies',       label: 'Returns & policies', max: 1000, hint: 'Returns, warranty, anything a buyer should know before paying', rows: 4, group: 'payments' },

    /* ── Contact ─────────────────────────────────────────────────────────────── */
    { id: 'contactPhone',   label: 'Contact phone',      max: 20,   hint: '', rows: 1, group: 'contact' },
    { id: 'contactEmail',   label: 'Contact email',      max: 100,  hint: '', rows: 1, group: 'contact', type: 'email' },
    { id: 'location',       label: 'Where you are',      max: 120,  hint: 'Area or town shoppers will recognise', rows: 1, group: 'contact' },

    /* ── Discovery ───────────────────────────────────────────────────────────── */
    { id: 'category',       label: 'Main category',      max: 60,   hint: '', rows: 1, group: 'discovery' },
    { id: 'tags',           label: 'Tags',               max: 10,   itemMax: 30,  hint: 'Words shoppers might search for', rows: 1, group: 'discovery', type: 'chips' },
    { id: 'languages',      label: 'Languages you serve', max: 5,   itemMax: 20,  hint: '', rows: 1, group: 'discovery', type: 'chips' },
    { id: 'announcement',   label: 'Announcement',       max: 200,  hint: 'Shown at the top of your storefront', rows: 2, group: 'discovery' },
  ];

  /* Order and titles for the grouped form. A field whose group is missing here still
     renders — under "More" — rather than disappearing silently. */
  var FIELD_GROUPS = [
    { id: 'identity',   title: 'Identity & branding', hint: 'How your shop introduces itself' },
    { id: 'appearance', title: 'Appearance',          hint: 'Colour, theme and type on your storefront' },
    { id: 'delivery',   title: 'Delivery & service',  hint: 'What a buyer can expect after paying' },
    { id: 'payments',   title: 'Payments & policies', hint: 'How you take money and what you promise' },
    { id: 'contact',    title: 'Contact',             hint: 'How shoppers reach you' },
    { id: 'discovery',  title: 'Discovery',           hint: 'How shoppers find you' },
    { id: 'more',       title: 'More',                hint: '' },
  ];

  var ARRAY_IDS = TEXT_FIELDS.filter(function (f) { return f.type === 'chips'; })
                             .map(function (f) { return f.id; });
  var TEXT_IDS = TEXT_FIELDS.map(function (f) { return f.id; });

  /* Handle rules, mirroring claimMinishopHandle so the screen can refuse early
     with the same wording rather than round-tripping every keystroke. The
     SERVER remains the authority — this only avoids obvious failures. */
  var HANDLE_MIN = 3, HANDLE_MAX = 30;
  function handleProblem(raw) {
    var h = String(raw == null ? '' : raw).toLowerCase().trim();
    if (!h) return 'Choose a handle.';
    if (h.length < HANDLE_MIN || h.length > HANDLE_MAX) return 'A handle is ' + HANDLE_MIN + '–' + HANDLE_MAX + ' characters.';
    if (!/^[a-z0-9_-]+$/.test(h)) return 'Use only lowercase letters, numbers, hyphens and underscores.';
    return null;
  }
  function normaliseHandle(raw) { return String(raw == null ? '' : raw).toLowerCase().trim(); }

  function _unwrap(res) { return (res && res.data) ? res.data : res; }

  async function _call(fn, payload, failMessage) {
    if (typeof fn !== 'function') throw new Error('merchant store: callable is required');
    try {
      var d = _unwrap(await fn(payload || {}));
      if (d && d.ok === false) return { ok: false, error: d.error || failMessage };
      return Object.assign({ ok: true }, d || {});
    } catch (e) {
      return { ok: false, error: (e && e.message) || failMessage, code: (e && e.code) || null };
    }
  }

  /* ── Identity ─────────────────────────────────────────────────────────────
     The ONE place a shopId enters this module, and it comes from the server. */
  async function loadIdentity(o) {
    var r = await _call(o.callIdentity, {}, 'Your shop could not be loaded.');
    if (!r.ok) return r;
    return {
      ok: true,
      shopId: r.shopId || null,
      handle: r.handle || null,
      hasHandle: r.hasHandle === true,
      url: r.url || null,
      config: r.config || null,
      /* An account with no shop is a real, common answer — not an error. */
      hasShop: !!r.shopId,
    };
  }

  /* ── Configuration ────────────────────────────────────────────────────────
     Only canonical text fields are sent. PROTECTED_FIELDS on the server refuses
     ownership, money, standing and counters outright, so a bug here cannot
     escalate — but sending only what the form owns keeps the payload honest. */
  function buildConfig(o) {
    if (!o.shopId) throw new Error('merchant store: a resolved shopId is required');
    var src = o.config || {};
    var config = {};
    TEXT_FIELDS.forEach(function (f) {
      if (!Object.prototype.hasOwnProperty.call(src, f.id)) return;
      var v = String(src[f.id] == null ? '' : src[f.id]);
      if (v.length > f.max) throw new Error(f.label + ' is too long — keep it under ' + f.max + ' characters.');
      config[f.id] = v;
    });
    if (!Object.keys(config).length) throw new Error('Nothing has changed.');
    return { shopId: String(o.shopId), config: config };
  }

  async function saveConfig(o) {
    return _call(o.callSave, buildConfig(o), 'Your changes could not be saved.');
  }

  /* ── Handle ───────────────────────────────────────────────────────────────
     Deliberately sends NO shopId: claimMinishopHandle resolves the shop itself,
     and passing one would invite a caller to name a different shop. */
  function buildHandleClaim(o) {
    var problem = handleProblem(o.handle);
    if (problem) throw new Error(problem);
    return { handle: normaliseHandle(o.handle) };
  }

  async function claimHandle(o) {
    return _call(o.callClaim, buildHandleClaim(o), 'That handle could not be claimed.');
  }

  /* ── Analytics + the follower count ───────────────────────────────────────
     One call, one source. Unknown figures stay null so the surface can render a
     dash rather than a fabricated zero. */
  async function loadAnalytics(o) {
    if (!o.shopId) throw new Error('merchant store: a resolved shopId is required');
    var r = await _call(o.callAnalytics, { shopId: String(o.shopId) }, 'Your shop figures could not be loaded.');
    if (!r.ok) return r;
    var a = r.analytics || {};
    var num = function (v) { return (typeof v === 'number' && isFinite(v)) ? v : null; };
    return {
      ok: true,
      shopId: r.shopId || o.shopId,
      /* followerCount comes from the authority; a genuine 0 is meaningful and
         is preserved as 0, while a missing figure stays null. */
      followerCount: (typeof r.followerCount === 'number') ? r.followerCount : null,
      views: num(a.views ?? a.viewCount),
      visits: num(a.visits),
      productClicks: num(a.productClicks ?? a.clicks),
      shares: num(a.shares),
    };
  }

  async function shareCard(o) {
    if (!o.shopId) throw new Error('merchant store: a resolved shopId is required');
    return _call(o.callShare, { shopId: String(o.shopId), type: 'shop' },
      'The share card could not be created.');
  }

  /* ── Display ──────────────────────────────────────────────────────────────
     Unknown is an em dash. A real zero is zero. */
  function formatCount(n) {
    if (n == null || (typeof n === 'number' && !isFinite(n))) return '—';
    return Number(n).toLocaleString('en-KE');
  }

  function storefrontUrl(handle, origin) {
    if (!handle) return null;
    return (origin || 'https://mysokoni.co.ke') + '/shop/' + handle;
  }

  /* Which text fields actually differ from what the server last returned — so a
     save sends changes rather than the whole form, and "Nothing has changed"
     is a real answer. */
  function changedFields(current, draft) {
    var out = {};
    TEXT_IDS.forEach(function (id) {
      /* ARRAY FIELDS COMPARE AS ARRAYS. String() on an array yields "a,b", so a chip
         containing a comma would read as two entries and ['a'] would compare equal to
         'a' — a real change silently dropped. Arrays compare element by element and are
         sent as arrays, which is what the schema's ARRAY_FIELDS expects. */
      if (ARRAY_IDS.indexOf(id) > -1) {
        var wasA = Array.isArray((current || {})[id]) ? (current || {})[id] : [];
        var nowA = Array.isArray((draft || {})[id]) ? (draft || {})[id] : [];
        var same = wasA.length === nowA.length &&
                   wasA.every(function (v, i) { return String(v) === String(nowA[i]); });
        if (!same) out[id] = nowA.slice();
        return;
      }
      var was = String((current || {})[id] == null ? '' : (current || {})[id]);
      var now = String((draft || {})[id] == null ? '' : (draft || {})[id]);
      if (was !== now) out[id] = now;
    });
    return out;
  }

  /* Client-side validation MIRRORS the schema rather than inventing rules. A field that
     fails here is never sent: the server would reject or truncate it, and a merchant
     deserves to know before pressing Save rather than after. */
  function validateField(f, value) {
    if (!f) return null;
    if (f.type === 'chips') {
      var arr = Array.isArray(value) ? value : [];
      if (arr.length > f.max) return 'At most ' + f.max + '.';
      if (arr.some(function (v) { return String(v).length > f.itemMax; }))
        return 'Each entry must be ' + f.itemMax + ' characters or fewer.';
      return null;
    }
    var s = String(value == null ? '' : value);
    if (s.length > f.max) return 'Too long — ' + s.length + ' of ' + f.max + '.';
    if (!s) return null;                       /* empty clears a field; that is allowed */
    if (f.type === 'url' && !/^https?:\/\/[^\s]+$/i.test(s)) return 'Must be a full http(s) address.';
    if (f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return 'Does not look like an email address.';
    if (f.type === 'color' && !/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s)) return 'Use a hex colour like #71ff00.';
    if (f.type === 'select' && (f.options || []).indexOf(s) === -1) return 'Choose one of the listed options.';
    return null;
  }

  function validateAll(draft) {
    var errs = {};
    TEXT_FIELDS.forEach(function (f) {
      var e = validateField(f, (draft || {})[f.id]);
      if (e) errs[f.id] = e;
    });
    return errs;
  }

  return {
    CALLABLES: CALLABLES,
    TEXT_FIELDS: TEXT_FIELDS,
    FIELD_GROUPS: FIELD_GROUPS,
    ARRAY_IDS: ARRAY_IDS,
    validateField: validateField,
    validateAll: validateAll,
    TEXT_IDS: TEXT_IDS,
    HANDLE_MIN: HANDLE_MIN,
    HANDLE_MAX: HANDLE_MAX,
    handleProblem: handleProblem,
    normaliseHandle: normaliseHandle,
    loadIdentity: loadIdentity,
    buildConfig: buildConfig,
    saveConfig: saveConfig,
    buildHandleClaim: buildHandleClaim,
    claimHandle: claimHandle,
    loadAnalytics: loadAnalytics,
    shareCard: shareCard,
    formatCount: formatCount,
    storefrontUrl: storefrontUrl,
    changedFields: changedFields,
  };
}));
