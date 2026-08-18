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
  var TEXT_FIELDS = [
    { id: 'tagline',        label: 'Tagline',            max: 200,  hint: 'One line under your shop name', rows: 1 },
    { id: 'description',    label: 'About the shop',     max: 1000, hint: 'What you sell and what makes it worth buying', rows: 4 },
    { id: 'location',       label: 'Where you are',      max: 120,  hint: 'Area or town shoppers will recognise', rows: 1 },
    { id: 'category',       label: 'Main category',      max: 60,   hint: '', rows: 1 },
    { id: 'contactPhone',   label: 'Contact phone',      max: 20,   hint: '', rows: 1 },
    { id: 'contactEmail',   label: 'Contact email',      max: 100,  hint: '', rows: 1 },
    { id: 'responseTime',   label: 'Typical reply time', max: 60,   hint: 'e.g. within an hour', rows: 1 },
    { id: 'deliveryPolicy', label: 'Delivery',           max: 500,  hint: 'Where you deliver and what it costs', rows: 3 },
    { id: 'announcement',   label: 'Announcement',       max: 200,  hint: 'Shown at the top of your storefront', rows: 2 },
  ];
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
      var was = String((current || {})[id] == null ? '' : (current || {})[id]);
      var now = String((draft || {})[id] == null ? '' : (draft || {})[id]);
      if (was !== now) out[id] = now;
    });
    return out;
  }

  return {
    CALLABLES: CALLABLES,
    TEXT_FIELDS: TEXT_FIELDS,
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
