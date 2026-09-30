/* ══════════════════════════════════════════════════════════════════════════════
   sokoni-merchant-shop-profile.js — merchant-v2 › Shop details › Details (2026-09-29)
   ══════════════════════════════════════════════════════════════════════════════
   The seller.html "Create My Shop" wizard, ported step for step into the merchant-v2 workspace and fixed where the
   original lost data. seller.html stays as the reference; this is the merchant surface (owner, 2026-09-28).

     1 Identity   banner · accent colour · logo · shop name · tagline · SOKONI category (read-only) · story · seller type
     2 Permits    KRA PIN · SBP licence · business registration — numbers, plus REAL private document uploads
                  (KRA, SBP, BRS, fire safety, public health → kyc-documents/{uid}, owner + admin read only)
     3 Setup      city / county · shop presence (online / hybrid / physical) · address · Google Maps link ·
                  opening hours (the ONE schedule — edited in Availability) · phone / WhatsApp · email · website ·
                  Instagram · TikTok · Facebook · X · YouTube · LinkedIn
     4 Delivery   delivery method · usual delivery time · delivery areas (the 15 standard areas + your own) ·
                  free-delivery threshold · packaging note · return & refund policy (+ custom wording)
     5 Go live    live preview (real data only) · readiness checklist · storefront link · storefront extras
                  (announcement, typical reply time) · save

   AUTHORITY
   · Saved ONLY through saveShopProfile (functions/kasshop.js) — the server owns the shop document, validates every
     value and rebuilds the public storefront's copy after each save, so /shop/{handle} shows exactly what was saved.
   · The shop's status and SOKONI category are NOT editable here: approval / AdminOS decide them
     (business-category.shopEligibility). The page shows them and says so.
   · Delivery FEES are not set here: SOKONI quotes delivery at checkout (the RES-1 server quote). Zones are where you
     deliver. The free-delivery threshold is saved but not promised to buyers until checkout applies it.
   · Opening hours have one editor — Availability (providerAvailability), which the storefront reads first. This step
     shows them and links there, rather than keeping a second, diverging timetable.
   · Storefront extras (announcement, reply time) live in minishopConfig and save through saveMinishopConfig.

   LIVE-AUTHORITY GATE (hosting-only port, 2026-09-30 — see NOT_YET below)
   · This file was ported from d83b2f3 WITHOUT that commit's server half. The LIVE saveShopProfile (its archive, read
     by its author) accepts the profile fields listed above EXCEPT `sellerType`, and its compliance record holds the
     three NUMBERS only (no `permits` document paths). It validates length only, and returns neither `invalid`,
     `status`, `sokoniCategory` nor `storefrontSynced`. A control whose value the server drops would pretend to save,
     so those two controls are rendered disabled with a "Not yet available" note and are NOT sent; unknown status /
     category render neutrally; the success message claims a storefront refresh only when the server reports one.
   · The URL / handle checks in validate() are CLIENT-SIDE defence in depth. Until the server half ships, the live
     server does not check values.

   Mount contract:  SokoniMerchantShopProfile.mount(host, ctx) → { refresh, destroy, state }
     ctx: { uid, origin, callGet, callSave, callConfig?, callSaveConfig?, upload({path, blob, contentType,
            cacheControl}) → Promise<url>, onOpenAvailability?, onToast? }
   Pure helpers for tests: SokoniMerchantShopProfile._h
   ══════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SokoniMerchantShopProfile = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CSS_ID = 'sokoni-merchant-shop-profile-css';

  /* ── The choices (the codes the server accepts — kasshop.CHOICES) ───────────── */
  var STEPS = [
    { id: 1, key: 'identity', label: 'Identity', icon: '🪪' },
    { id: 2, key: 'permits',  label: 'Permits',  icon: '📄' },
    { id: 3, key: 'setup',    label: 'Shop setup', icon: '🏪' },
    { id: 4, key: 'delivery', label: 'Delivery', icon: '🚚' },
    { id: 5, key: 'live',     label: 'Go live',  icon: '🚀' },
  ];
  var ACCENTS = [
    { hex: '#71ff00', name: 'SOKONI green' }, { hex: '#00c2ff', name: 'Ocean' }, { hex: '#ff6b35', name: 'Sunset' },
    { hex: '#ffc233', name: 'Gold' }, { hex: '#c77dff', name: 'Violet' }, { hex: '#ff4d8d', name: 'Rose' },
    { hex: '#2ee6a6', name: 'Mint' }, { hex: '#f4f4f4', name: 'Pearl' },
  ];
  var SELLER_TYPES = [
    ['longterm', '🏬', 'Established shop', 'A permanent business selling regularly'],
    ['shortterm', '⚡', 'Occasional seller', 'Seasonal, one-off or side-hustle sales'],
    ['service', '🛠️', 'Services + products', 'You sell services alongside goods'],
    ['wholesale', '📦', 'Wholesale', 'Bulk and trade buyers'],
  ];
  /* ── Live-authority gate ─────────────────────────────────────────────────────
     `sellerType` is not in the live saveShopProfile accepted list (silently ignored); `compliance.permits` is not in
     its compliance fields (this branch's functions/kasshop.js COMPLIANCE_FIELDS = kraPin, sbpNumber, brsNumber; the
     d83b2f3 server half adds `permits`). Both are gated: rendered disabled with NOT_YET_NOTE, never sent, never
     counted as a change. Flip a flag to false ONLY once the server half that accepts the field is deployed. */
  var NOT_YET = { sellerType: true, permitDocs: true };
  var NOT_YET_NOTE = 'Not yet available — the shop authority does not save this yet, so nothing chosen here is stored. It switches on with the next server update.';
  var CITIES = [['nairobi', 'Nairobi'], ['mombasa', 'Mombasa'], ['kisumu', 'Kisumu'], ['nakuru', 'Nakuru'],
    ['eldoret', 'Eldoret'], ['thika', 'Thika'], ['nyeri', 'Nyeri'], ['machakos', 'Machakos'], ['malindi', 'Malindi'],
    ['garissa', 'Garissa'], ['kisii', 'Kisii'], ['kericho', 'Kericho'], ['meru', 'Meru'], ['nanyuki', 'Nanyuki'],
    ['kakamega', 'Kakamega'], ['bungoma', 'Bungoma'], ['kitale', 'Kitale'], ['bomet', 'Bomet'], ['lamu', 'Lamu'],
    ['naivasha', 'Naivasha'], ['nationwide', 'Nationwide (online only)']];
  var PRESENCE = [
    ['online', '🌐', 'Online only', 'No walk-in location'],
    ['hybrid', '🏪', 'Online + shop', 'Buyers can also visit you'],
    ['physical', '📍', 'Physical shop', 'Mainly walk-in, listed online'],
  ];
  var DEL_METHODS = [
    ['sokoni', '🛵', 'SOKONI riders', 'SOKONI collects and delivers; the fee is quoted at checkout'],
    ['own', '🚗', 'My own riders', 'You deliver with your own team'],
    ['both', '🔁', 'Both', 'SOKONI riders or your own'],
    ['pickup', '🏬', 'Pickup only', 'Buyers collect from you'],
  ];
  var DEL_TIMES = [['30min', 'Within 30 minutes'], ['1hr', 'Within 1 hour'], ['2hr', 'Within 2 hours'],
    ['sameday', 'Same day'], ['nextday', 'Next day'], ['2-3days', '2–3 days'], ['1week', 'Within a week']];
  var ZONES = ['Nairobi CBD', 'Westlands', 'Kilimani', 'Karen', 'Parklands', 'Eastlands', 'Kasarani', 'Rongai',
    'Thika', 'Kiambu', 'Mombasa', 'Kisumu', 'Nakuru', 'Eldoret', 'Nationwide'];
  var RETURNS = [
    ['7day', '↩️', '7-day returns', 'Eligible items back within 7 days'],
    ['exchange', '🔄', 'Exchange only', 'Swap, but no refunds'],
    ['noreturn', '🚫', 'All sales final', 'No returns'],
    ['custom', '✍️', 'My own policy', 'Write it in your words'],
  ];
  var PERMITS = [
    { kind: 'kra', num: 'kraPin', title: 'KRA PIN', ph: 'A012345678B', hint: 'Your Kenya Revenue Authority PIN.', link: 'https://itax.kra.go.ke' },
    { kind: 'sbp', num: 'sbpNumber', title: 'Single Business Permit (SBP)', ph: 'e.g. NCC/SBP/2026/…', hint: 'Issued by your county.', link: 'https://ecitizen.go.ke' },
    { kind: 'brs', num: 'brsNumber', title: 'Business / company registration', ph: 'e.g. BN-ABC123 or PVT-…', hint: 'Business Registration Service number.', link: 'https://brs.go.ke' },
    { kind: 'fire', num: null, title: 'Fire safety certificate', hint: 'Upload the certificate — no number needed.' },
    { kind: 'health', num: null, title: 'Public health certificate', hint: 'Needed for food, beauty and health businesses.' },
  ];
  var PROFILE_KEYS = ['name', 'tagline', 'about', 'sellerType', 'logoUrl', 'bannerUrl', 'themeColor', 'city', 'shopType',
    'address', 'mapsLink', 'phone', 'email', 'website', 'instagram', 'tiktok', 'facebook', 'twitter', 'youtube',
    'linkedin', 'delMethod', 'delTime', 'freeDelivery', 'zones', 'packagingNote', 'returnPolicy', 'returnText'];
  var LABELS = { name: 'Shop name', tagline: 'Tagline', about: 'Shop story', sellerType: 'Seller type', logoUrl: 'Logo',
    bannerUrl: 'Banner', logo: 'Logo', banner: 'Banner', themeColor: 'Accent colour', city: 'City / county',
    shopType: 'Shop presence', address: 'Address', mapsLink: 'Google Maps link', phone: 'Phone / WhatsApp',
    email: 'Email', website: 'Website', instagram: 'Instagram', tiktok: 'TikTok', facebook: 'Facebook',
    twitter: 'X (Twitter)', youtube: 'YouTube', linkedin: 'LinkedIn', delMethod: 'Delivery method',
    delTime: 'Delivery time', freeDelivery: 'Free delivery above', zones: 'Delivery areas',
    packagingNote: 'Packaging note', returnPolicy: 'Return policy', returnText: 'Return policy wording',
    category: 'Category', status: 'Status', business: 'SOKONI category', verified: 'Verified badge' };
  var MAX = { name: 120, tagline: 160, about: 2000, address: 300, mapsLink: 400, phone: 32, email: 160, website: 200,
    instagram: 100, tiktok: 100, facebook: 100, twitter: 100, youtube: 100, linkedin: 100, packagingNote: 500,
    returnText: 1000, kraPin: 20, sbpNumber: 40, brsNumber: 40, announcement: 200, responseTime: 60 };

  /* ── Pure helpers ─────────────────────────────────────────────────────────── */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function str(v) { return typeof v === 'string' ? v : (v == null ? '' : String(v)); }
  function blankDraft() {
    var d = {}; PROFILE_KEYS.forEach(function (k) { d[k] = k === 'zones' ? [] : ''; });
    return d;
  }
  /** Server response → the editor's draft. Every field is restored (seller.html's reload lost seven of them). */
  function fromServer(res) {
    var p = (res && res.profile) || {};
    var d = blankDraft();
    PROFILE_KEYS.forEach(function (k) { if (k !== 'zones' && p[k] != null) d[k] = str(p[k]); });
    d.name = str(p.name || p.storeName);
    d.about = str(p.about || p.description);
    d.logoUrl = str(p.logoUrl || p.logo);
    d.bannerUrl = str(p.bannerUrl || p.banner);
    d.zones = Array.isArray(p.zones) ? p.zones.filter(function (z) { return typeof z === 'string' && z; }) : [];
    if (d.themeColor && !/^#[0-9a-fA-F]{6}$/.test(d.themeColor)) d.themeColor = '';   /* a legacy gradient: pick again */
    var c = (res && res.compliance) || {};
    var comp = { kraPin: str(c.kraPin), sbpNumber: str(c.sbpNumber), brsNumber: str(c.brsNumber), permits: {} };
    PERMITS.forEach(function (x) { comp.permits[x.kind] = str(c.permits && c.permits[x.kind]); });
    return { profile: d, compliance: comp };
  }
  function normPhone(v) { return str(v).replace(/[\s()-]/g, ''); }
  /* CLIENT-SIDE link safety (defence in depth — the live server truncates length and checks no values).
     A link must be http(s) with a host that has a dot, and carry no whitespace or quote/angle characters; a
     `javascript:` / `data:` / `vbscript:` value is refused before anything is sent. A social entry may be a bare
     handle (@yourshop, company/yourshop) or an http(s) profile link — any OTHER scheme is refused. */
  var SOCIAL_KEYS = ['instagram', 'tiktok', 'facebook', 'twitter', 'youtube', 'linkedin'];
  function safeLink(v) { v = str(v).trim(); return /^https?:\/\/[^\s\/"'<>\\]+\.[^\s"'<>\\]{2,}$/i.test(v); }
  function safeHandle(v) {
    v = str(v).trim();
    if (!v) return true;
    if (/[\s"'<>\\]/.test(v)) return false;
    if (/^[a-z][a-z0-9+.\-]*:/i.test(v)) return safeLink(v);   /* has a scheme → must be an http(s) link */
    return true;
  }
  /** Field problems the seller can fix before saving. The server re-checks everything. */
  function validate(d, comp) {
    var e = {};
    if (!str(d.name).trim()) e.name = 'Your shop needs a name.';
    else if (d.name.length > MAX.name) e.name = 'Keep it under ' + MAX.name + ' characters.';
    if (d.tagline.length > MAX.tagline) e.tagline = 'Keep it under ' + MAX.tagline + ' characters.';
    if (!normPhone(d.phone)) e.phone = 'A phone / WhatsApp number is required so buyers can reach you.';
    else if (!/^(\+?254|0)(7|1)\d{8}$/.test(normPhone(d.phone))) e.phone = 'Use a Kenyan mobile number, e.g. 0712 345 678.';
    if (d.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.email)) e.email = 'That email address does not look right.';
    if (d.website && !safeLink(d.website)) e.website = 'Start with https:// — e.g. https://myshop.co.ke (only a web address is accepted).';
    if (d.mapsLink && (!safeLink(d.mapsLink) || !/^https:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps|(www\.)?google\.[a-z.]+\/maps|maps\.google\.[a-z.]+)/i.test(d.mapsLink))) {
      e.mapsLink = 'Paste the share link from Google Maps (https://maps.app.goo.gl/…).';
    }
    SOCIAL_KEYS.forEach(function (k) {
      if (d[k] && !safeHandle(d[k])) e[k] = 'A handle (@yourshop) or an https:// profile link — nothing else.';
    });
    if ((d.shopType === 'hybrid' || d.shopType === 'physical') && !str(d.address).trim()) e.address = 'Buyers visit you — add your street or building.';
    if (d.freeDelivery && !/^\d{1,9}$/.test(str(d.freeDelivery).replace(/[,\s]/g, ''))) e.freeDelivery = 'Whole shillings only, e.g. 3000.';
    if (d.returnPolicy === 'custom' && !str(d.returnText).trim()) e.returnText = 'Write your return policy.';
    if (comp && comp.kraPin && !/^[AP]\d{9}[A-Z]$/i.test(comp.kraPin.trim())) e.kraPin = 'A KRA PIN is a letter, 9 digits and a letter — e.g. A012345678B.';
    return e;
  }
  var STEP_OF = { name: 1, tagline: 1, about: 1, kraPin: 2, phone: 3, email: 3, website: 3, mapsLink: 3, address: 3,
    instagram: 3, tiktok: 3, facebook: 3, twitter: 3, youtube: 3, linkedin: 3, freeDelivery: 4, returnText: 4 };
  /** The storefront checklist — each item is a fact about the saved draft, never an invented score. */
  function readiness(d) {
    return [
      { id: 'name', step: 1, ok: !!str(d.name).trim(), t: 'Shop name' },
      { id: 'tagline', step: 1, ok: !!str(d.tagline).trim(), t: 'Tagline' },
      { id: 'logo', step: 1, ok: !!d.logoUrl, t: 'Logo' },
      { id: 'banner', step: 1, ok: !!d.bannerUrl, t: 'Banner photo' },
      { id: 'about', step: 1, ok: str(d.about).trim().length >= 40, t: 'Shop story (40+ characters)' },
      { id: 'city', step: 3, ok: !!d.city, t: 'City / county' },
      { id: 'phone', step: 3, ok: !!normPhone(d.phone), t: 'Phone / WhatsApp' },
      { id: 'delivery', step: 4, ok: !!d.delMethod, t: 'Delivery method' },
      { id: 'zones', step: 4, ok: d.delMethod === 'pickup' || (d.zones || []).length > 0, t: 'Delivery areas' },
      { id: 'returns', step: 4, ok: !!d.returnPolicy, t: 'Return policy' },
    ];
  }
  /** The saveShopProfile payload: the whole draft (empty strings clear) + compliance when it changed. */
  function toPayload(d, comp, savedComp) {
    var profile = {};
    PROFILE_KEYS.forEach(function (k) {
      if (k === 'sellerType' && NOT_YET.sellerType) return;   /* gated: the live authority ignores it — never sent */
      if (k === 'zones') profile.zones = (d.zones || []).slice(0, 40);
      else if (k === 'phone') profile.phone = normPhone(d.phone);
      else if (k === 'freeDelivery') profile.freeDelivery = str(d.freeDelivery).replace(/[,\s]/g, '');
      else profile[k] = str(d[k]).trim();
    });
    var out = { profile: profile };
    if (comp && JSON.stringify(comp) !== JSON.stringify(savedComp || {})) {
      out.compliance = { kraPin: str(comp.kraPin).trim().toUpperCase(), sbpNumber: str(comp.sbpNumber).trim(), brsNumber: str(comp.brsNumber).trim() };
      if (!NOT_YET.permitDocs) out.compliance.permits = Object.assign({}, comp.permits);   /* gated: not in the live compliance fields */
    }
    return out;
  }
  function changedCount(a, b) {
    var n = 0;
    PROFILE_KEYS.forEach(function (k) {
      if (k === 'sellerType' && NOT_YET.sellerType) return;
      if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) n++;
    });
    return n;
  }
  function labelOf(list, code) { for (var i = 0; i < list.length; i++) if (list[i][0] === code) return list[i][2] || list[i][1]; return ''; }

  /* ── Styles (merchant-v2 tokens) ──────────────────────────────────────────── */
  var CSS = [
    '.msp{--msp-acc:var(--acc,#71ff00);color:var(--txt,#f4f4f4);padding-bottom:96px}',
    '.msp *{box-sizing:border-box}',
    '.msp-steps{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;padding:2px 2px 12px;margin:0 -2px}',
    '.msp-steps::-webkit-scrollbar{display:none}',
    '.msp-step{flex:1 0 auto;display:flex;align-items:center;gap:8px;min-height:44px;padding:8px 12px;border-radius:12px;',
      'border:1px solid var(--line,rgba(255,255,255,.09));background:rgba(255,255,255,.03);color:var(--txt2,#a8a8a8);',
      'font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap}',
    '.msp-step .n{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:50%;font-size:11px;',
      'background:rgba(255,255,255,.08);color:var(--txt2,#a8a8a8)}',
    '.msp-step.on{border-color:var(--msp-acc);background:rgba(113,255,0,.08);color:var(--txt,#f4f4f4)}',
    '.msp-step.on .n,.msp-step.done .n{background:var(--msp-acc);color:#050505}',
    '.msp-step:focus-visible,.msp-opt:focus-visible,.msp-chip:focus-visible,.msp-btn:focus-visible,.msp-dot:focus-visible,.msp-in:focus-visible{outline:2px solid var(--msp-acc);outline-offset:2px}',
    '.msp-bar{height:4px;border-radius:4px;background:rgba(255,255,255,.07);margin:0 0 16px;overflow:hidden}',
    '.msp-bar>i{display:block;height:100%;background:linear-gradient(90deg,var(--msp-acc),#b6ff6b);transition:width .3s}',
    '.msp-card{border:1px solid var(--line,rgba(255,255,255,.09));border-radius:16px;padding:16px;margin:0 0 14px;',
      'background:linear-gradient(180deg,rgba(255,255,255,.035),rgba(255,255,255,.015))}',
    '.msp-h{font-size:16px;font-weight:800;margin:0 0 4px}',
    '.msp-sub{font-size:12.5px;color:var(--txt2,#a8a8a8);line-height:1.55;margin:0 0 12px}',
    '.msp-lbl{display:block;font-size:12px;font-weight:700;color:var(--txt2,#a8a8a8);margin:14px 0 6px}',
    '.msp-lbl .req{color:var(--msp-acc)}',
    '.msp-in{display:block;width:100%;min-height:48px;padding:12px 14px;border-radius:12px;font-size:16px;',
      'border:1px solid var(--line,rgba(255,255,255,.09));background:rgba(255,255,255,.04);color:var(--txt,#f4f4f4)}',
    'textarea.msp-in{min-height:110px;resize:vertical;line-height:1.5}',
    '.msp-in.bad{border-color:#ff5252}',
    '.msp-err{font-size:12px;color:#ff8a8a;margin-top:6px}',
    '.msp-cnt{font-size:11px;color:var(--txt3,#6d6d6d);text-align:right;margin-top:4px}',
    '.msp-grid2{display:grid;gap:0 12px;grid-template-columns:1fr}',
    '@media (min-width:640px){.msp-grid2{grid-template-columns:1fr 1fr}}',
    '.msp-opts{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(min(170px,100%),1fr))}',
    '.msp-opt{display:flex;gap:10px;align-items:flex-start;text-align:left;min-height:64px;padding:12px;border-radius:14px;cursor:pointer;',
      'border:1px solid var(--line,rgba(255,255,255,.09));background:rgba(255,255,255,.03);color:var(--txt,#f4f4f4);font:inherit}',
    '.msp-opt .i{font-size:20px;line-height:1}',
    '.msp-opt b{display:block;font-size:13.5px}',
    '.msp-opt small{display:block;font-size:11.5px;color:var(--txt2,#a8a8a8);margin-top:2px;line-height:1.4}',
    '.msp-opt.on{border-color:var(--msp-acc);background:rgba(113,255,0,.09);box-shadow:0 0 0 1px var(--msp-acc) inset}',
    '.msp-chips{display:flex;flex-wrap:wrap;gap:8px}',
    '.msp-chip{min-height:40px;padding:8px 14px;border-radius:999px;cursor:pointer;font:inherit;font-size:13px;font-weight:700;',
      'border:1px solid var(--line,rgba(255,255,255,.09));background:rgba(255,255,255,.03);color:var(--txt2,#a8a8a8)}',
    '.msp-chip.on{border-color:var(--msp-acc);color:#050505;background:var(--msp-acc)}',
    '.msp-dots{display:flex;flex-wrap:wrap;gap:10px}',
    '.msp-dot{width:40px;height:40px;border-radius:50%;cursor:pointer;border:2px solid transparent;box-shadow:0 0 0 1px rgba(255,255,255,.15) inset}',
    '.msp-dot.on{border-color:#fff;transform:scale(1.08)}',
    '.msp-media{display:grid;gap:12px;grid-template-columns:1fr}',
    '.msp-banner{position:relative;height:150px;border-radius:14px;overflow:hidden;cursor:pointer;display:grid;place-items:center;',
      'border:1px dashed rgba(255,255,255,.18);color:var(--txt2,#a8a8a8);font-size:13px;font-weight:700;background-size:cover;background-position:center}',
    '.msp-logo{width:88px;height:88px;border-radius:22px;overflow:hidden;cursor:pointer;display:grid;place-items:center;font-size:30px;',
      'border:1px dashed rgba(255,255,255,.18);background:rgba(255,255,255,.04);flex:0 0 auto}',
    '.msp-logo img,.msp-banner img{width:100%;height:100%;object-fit:cover;display:block}',
    '.msp-row{display:flex;gap:14px;align-items:center;flex-wrap:wrap}',
    '.msp-btn{min-height:44px;padding:10px 16px;border-radius:12px;cursor:pointer;font:inherit;font-size:13.5px;font-weight:800;',
      'border:1px solid var(--line,rgba(255,255,255,.12));background:rgba(255,255,255,.05);color:var(--txt,#f4f4f4)}',
    '.msp-btn.solid{background:var(--msp-acc);border-color:var(--msp-acc);color:#050505}',
    '.msp-btn[disabled]{opacity:.45;cursor:not-allowed}',
    '.msp-note{border-radius:12px;padding:11px 13px;font-size:12.5px;line-height:1.55;margin:10px 0;',
      'background:rgba(255,255,255,.04);border:1px solid var(--line,rgba(255,255,255,.09));color:var(--txt2,#a8a8a8)}',
    '.msp-note.ok{background:rgba(113,255,0,.07);border-color:rgba(113,255,0,.3);color:#b6ff7a}',
    '.msp-note.warn{background:rgba(255,180,0,.07);border-color:rgba(255,180,0,.3);color:#ffd27a}',
    '.msp-note.bad{background:rgba(255,68,68,.07);border-color:rgba(255,68,68,.3);color:#ffb3b3}',
    '.msp-badge{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:800;letter-spacing:.3px;',
      'padding:5px 10px;border-radius:999px;background:rgba(255,255,255,.07);color:var(--txt2,#a8a8a8)}',
    '.msp-badge.ok{background:rgba(113,255,0,.14);color:#9dff4f}.msp-badge.warn{background:rgba(255,180,0,.14);color:#ffc74d}',
    '.msp-permit{display:grid;gap:8px;grid-template-columns:1fr;border-top:1px solid var(--line,rgba(255,255,255,.08));padding:12px 0}',
    '.msp-permit:first-of-type{border-top:0}',
    '.msp-permit-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}',
    '.msp-permit-head b{font-size:14px}',
    '.msp-prev{border-radius:18px;overflow:hidden;border:1px solid var(--line,rgba(255,255,255,.1));background:#0b0b0b}',
    '.msp-prev-cover{height:120px;background-size:cover;background-position:center}',
    '.msp-prev-body{padding:0 16px 16px;margin-top:-34px}',
    '.msp-prev-logo{width:68px;height:68px;border-radius:18px;border:3px solid #0b0b0b;background:#161616;overflow:hidden;display:grid;place-items:center;font-size:24px}',
    '.msp-prev-logo img{width:100%;height:100%;object-fit:cover}',
    '.msp-prev-name{font-size:18px;font-weight:900;margin:8px 0 2px;overflow-wrap:anywhere}',
    '.msp-prev-tag{font-size:13px;color:var(--txt2,#a8a8a8);overflow-wrap:anywhere}',
    '.msp-prev-badges{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}',
    '.msp-check{list-style:none;margin:0;padding:0;display:grid;gap:6px}',
    '.msp-check button{width:100%;display:flex;align-items:center;gap:10px;min-height:44px;padding:8px 12px;border-radius:12px;cursor:pointer;',
      'font:inherit;font-size:13px;text-align:left;border:1px solid var(--line,rgba(255,255,255,.08));background:rgba(255,255,255,.03);color:var(--txt,#f4f4f4)}',
    '.msp-check .ok{color:#9dff4f}.msp-check .no{color:#ffc74d}',
    '.msp-cta{position:sticky;bottom:0;z-index:5;display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap;',
      'padding:12px;margin:18px -2px 0;border-radius:16px;border:1px solid var(--line,rgba(255,255,255,.1));',
      'background:rgba(8,8,8,.92);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}',
    '.msp-cta .st{font-size:12.5px;color:var(--txt2,#a8a8a8);min-width:0;flex:1 1 160px}',
    '.msp-cta .btns{display:flex;gap:8px;flex:0 0 auto}',
    '.msp-link{display:flex;gap:8px}.msp-link input{flex:1 1 auto;min-width:0}',
    '.msp-hours{font-size:13px;line-height:1.7;color:var(--txt,#f4f4f4);overflow-wrap:anywhere}',
    '.msp-sk{height:14px;border-radius:8px;background:rgba(255,255,255,.06);margin:10px 0;animation:mspP 1.2s infinite}',
    '@keyframes mspP{50%{opacity:.5}}',
    '@media (prefers-reduced-motion:reduce){.msp-bar>i{transition:none}.msp-sk{animation:none}}',
  ].join('');
  function injectCSS(doc) {
    if (!doc || doc.getElementById(CSS_ID)) return;
    var s = doc.createElement('style'); s.id = CSS_ID; s.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(s);
  }

  /* ── Mount ────────────────────────────────────────────────────────────────── */
  function mount(host, ctx) {
    ctx = ctx || {};
    injectCSS(host.ownerDocument || (typeof document !== 'undefined' ? document : null));
    var S = {
      phase: 'loading', step: 1, error: null,
      saved: blankDraft(), draft: blankDraft(),
      comp: { kraPin: '', sbpNumber: '', brsNumber: '', permits: {} }, savedComp: null,
      extras: { announcement: '', responseTime: '' }, savedExtras: { announcement: '', responseTime: '' }, extrasReady: false,
      shopId: null, status: null, cat: null, handle: null, storefrontUrl: null, hours: null,
      errors: {}, busy: false, uploading: {}, result: null, customZone: '',
    };

    function toast(m) { if (typeof ctx.onToast === 'function') ctx.onToast(m); }

    function load() {
      /* Shop details belong to the OWNER: saveShopProfile resolves the shop from the caller's own uid, so a staff
         session would find none. Say that, instead of "no shop yet". */
      if (ctx.isOwner === false) { S.phase = 'not_owner'; paint(); return Promise.resolve(); }
      S.phase = 'loading'; S.error = null; paint();
      var get = typeof ctx.callGet === 'function' ? ctx.callGet({}) : Promise.reject(new Error('Shop profile is not available.'));
      return Promise.resolve(get).then(function (r) {
        var d = (r && r.data) || r || {};
        if (!d.exists) { S.phase = 'no_shop'; paint(); return; }
        var f = fromServer(d);
        S.saved = f.profile; S.draft = JSON.parse(JSON.stringify(f.profile));
        S.savedComp = f.compliance; S.comp = JSON.parse(JSON.stringify(f.compliance));
        S.shopId = d.shopId || null; S.status = d.status || null; S.cat = d.sokoniCategory || null;
        S.handle = d.handle || null; S.storefrontUrl = d.storefrontUrl || null;
        var sched = d.schedule && d.schedule.hours;
        var oh = d.profile && d.profile.openingHours;
        S.hours = sched || (oh && typeof oh === 'object' ? oh : null);
        S.phase = 'ready'; paint();
        loadExtras();
      }).catch(function (e) {
        S.phase = 'error'; S.error = (e && e.message) || 'Could not load your shop.'; paint();
      });
    }
    function loadExtras() {
      if (typeof ctx.callConfig !== 'function') return;
      Promise.resolve(ctx.callConfig({})).then(function (r) {
        var d = (r && r.data) || r || {};
        var c = d.config || {};
        S.savedExtras = { announcement: str(c.announcement), responseTime: str(c.responseTime) };
        S.extras = JSON.parse(JSON.stringify(S.savedExtras)); S.extrasReady = true;
        if (S.step === 5) paint();
      }).catch(function () { S.extrasReady = false; });
    }

    /* ── field renderers ── */
    function field(k, label, opts) {
      opts = opts || {};
      var v = opts.comp ? S.comp[k] : S.draft[k];
      var err = S.errors[k];
      var id = 'msp-f-' + k;
      var attrs = ' id="' + id + '" data-pf="' + k + '"' + (opts.comp ? ' data-comp="1"' : '') +
        (opts.type ? ' type="' + opts.type + '"' : '') + (opts.ph ? ' placeholder="' + esc(opts.ph) + '"' : '') +
        (opts.im ? ' inputmode="' + opts.im + '"' : '') + (opts.ac ? ' autocomplete="' + opts.ac + '"' : '') +
        (MAX[k] ? ' maxlength="' + MAX[k] + '"' : '') + (err ? ' aria-invalid="true" aria-describedby="' + id + '-e"' : '') +
        ' class="msp-in' + (err ? ' bad' : '') + '"';
      var input = opts.area
        ? '<textarea' + attrs + ' rows="' + (opts.rows || 4) + '">' + esc(v) + '</textarea>'
        : '<input' + attrs + ' value="' + esc(v) + '">';
      return '<label class="msp-lbl" for="' + id + '">' + esc(label) + (opts.req ? ' <span class="req">*</span>' : '') + '</label>' +
        (opts.hint ? '<div class="msp-sub" style="margin:-2px 0 8px">' + opts.hint + '</div>' : '') + input +
        (opts.count && MAX[k] ? '<div class="msp-cnt" id="' + id + '-c">' + str(v).length + ' / ' + MAX[k] + '</div>' : '') +
        (err ? '<div class="msp-err" id="' + id + '-e" role="alert">' + esc(err) + '</div>' : '');
    }
    function options(k, list, disabled) {
      return '<div class="msp-opts" role="radiogroup" aria-label="' + esc(LABELS[k] || k) + '"' + (disabled ? ' aria-disabled="true"' : '') + '>' + list.map(function (o) {
        var on = S.draft[k] === o[0];
        return '<button type="button" role="radio" aria-checked="' + on + '" class="msp-opt' + (on ? ' on' : '') + '" data-pchoose="' + k + '" data-v="' + esc(o[0]) + '"' + (disabled ? ' disabled aria-disabled="true"' : '') + '>' +
          '<span class="i" aria-hidden="true">' + o[1] + '</span><span><b>' + esc(o[2]) + '</b><small>' + esc(o[3]) + '</small></span></button>';
      }).join('') + '</div>';
    }
    /* The gate note beside a control the live authority does not save (see NOT_YET). */
    function notYetNote(k) { return '<p class="msp-sub msp-notyet" data-pnotyet="' + esc(k) + '" style="margin-top:6px">' + esc(NOT_YET_NOTE) + '</p>'; }
    function select(k, label, list, req) {
      var id = 'msp-f-' + k;
      return '<label class="msp-lbl" for="' + id + '">' + esc(label) + (req ? ' <span class="req">*</span>' : '') + '</label>' +
        '<select class="msp-in" id="' + id + '" data-pf="' + k + '"><option value="">Choose…</option>' + list.map(function (o) {
          return '<option value="' + esc(o[0]) + '"' + (S.draft[k] === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
        }).join('') + '</select>';
    }
    function coverStyle(d) {
      if (d.bannerUrl) return 'background-image:url(&quot;' + esc(d.bannerUrl) + '&quot;)';
      var c = d.themeColor || '#71ff00';
      return 'background:linear-gradient(135deg,' + esc(c) + '33,#0a1020 55%,' + esc(c) + '22)';
    }

    /* ── steps ── */
    function stepIdentity() {
      var d = S.draft;
      /* S.cat is null when the server did not report a category (the live getShopProfile never does): render that
         as unknown, not as "awaiting" — an unknown must never look like a state. */
      var cat = S.cat && S.cat.label
        ? '<span class="msp-badge ok">🏷️ ' + esc(S.cat.label) + '</span>'
        : '<span class="msp-badge" data-pcat="unknown">SOKONI category — not shown here yet</span>';
      return '<div class="msp-card"><div class="msp-h">Look &amp; feel</div>' +
        '<p class="msp-sub">Your banner and logo are the first thing buyers see on your storefront and in search.</p>' +
        '<div class="msp-banner" role="button" tabindex="0" data-pup="banner" aria-label="Upload banner photo" style="' + coverStyle(d) + '">' +
          (S.uploading.banner ? 'Uploading…' : (d.bannerUrl ? '' : '＋ Banner photo · 1200×400 recommended')) + '</div>' +
        '<div class="msp-row" style="margin-top:12px">' +
          '<div class="msp-logo" role="button" tabindex="0" data-pup="logo" aria-label="Upload logo">' +
            (S.uploading.logo ? '<span style="font-size:12px">…</span>' : (d.logoUrl ? '<img alt="" src="' + esc(d.logoUrl) + '">' : '🏪')) + '</div>' +
          '<div style="flex:1 1 200px;min-width:0"><div class="msp-lbl" style="margin-top:0">Accent colour</div><div class="msp-dots" role="radiogroup" aria-label="Accent colour">' +
            ACCENTS.map(function (a) {
              var on = d.themeColor === a.hex;
              return '<button type="button" role="radio" aria-checked="' + on + '" aria-label="' + esc(a.name) + '" class="msp-dot' + (on ? ' on' : '') + '" data-paccent="' + a.hex + '" style="background:' + a.hex + '"></button>';
            }).join('') + '</div></div>' +
        '</div>' +
        (d.bannerUrl || d.logoUrl ? '<div class="msp-row" style="margin-top:10px">' +
          (d.bannerUrl ? '<button type="button" class="msp-btn" data-pclear="bannerUrl">Remove banner</button>' : '') +
          (d.logoUrl ? '<button type="button" class="msp-btn" data-pclear="logoUrl">Remove logo</button>' : '') + '</div>' : '') +
        '<input type="file" accept="image/jpeg,image/png,image/webp" hidden data-pfile="banner"><input type="file" accept="image/jpeg,image/png,image/webp" hidden data-pfile="logo">' +
      '</div>' +
      '<div class="msp-card"><div class="msp-h">Who you are</div>' +
        field('name', 'Shop name', { req: true, count: true, ph: 'e.g. Mama Njeri Fresh Produce', ac: 'organization' }) +
        field('tagline', 'Tagline', { count: true, ph: 'One line that sells — e.g. Fresh from the farm, delivered today' }) +
        '<div class="msp-lbl">SOKONI category</div><div class="msp-row">' + cat + '</div>' +
        '<p class="msp-sub" style="margin-top:6px">SOKONI assigns your category when your business is approved — it decides where buyers find you. To change it, contact SOKONI support.</p>' +
        field('about', 'Your shop story', { area: true, rows: 5, count: true, ph: 'What you sell, where it comes from, and why buyers choose you.' }) +
        '<div class="msp-lbl">Seller type</div>' + options('sellerType', SELLER_TYPES, !!NOT_YET.sellerType) + (NOT_YET.sellerType ? notYetNote('sellerType') : '') +
      '</div>';
    }
    function stepPermits() {
      return '<div class="msp-card"><div class="msp-h">Permits &amp; registration</div>' +
        '<p class="msp-sub">Optional, but verified documents build buyer trust. Numbers and documents are private — only you and SOKONI administrators can see them; they never appear on your storefront.</p>' +
        PERMITS.map(function (p) {
          var path = S.comp.permits[p.kind];
          var badge = S.uploading[p.kind] ? '<span class="msp-badge">Uploading…</span>'
            : (path ? '<span class="msp-badge ok">✓ Document uploaded</span>' : '<span class="msp-badge">No document</span>');
          return '<div class="msp-permit"><div class="msp-permit-head"><b>' + esc(p.title) + '</b>' + badge + '</div>' +
            '<div class="msp-sub" style="margin:0">' + esc(p.hint) + (p.link ? ' <a href="' + p.link + '" target="_blank" rel="noopener" style="color:var(--msp-acc)">Get it ↗</a>' : '') + '</div>' +
            (p.num ? field(p.num, p.title + ' number', { comp: true, ph: p.ph }) : '') +
            (NOT_YET.permitDocs
              /* gated: the live compliance record has no `permits` field, so an upload would store a file the
                 authority never records. Disabled, with the note; the number fields above DO save. */
              ? '<div class="msp-row"><button type="button" class="msp-btn" data-ppermit="' + p.kind + '" disabled aria-disabled="true">Upload document</button></div>' + notYetNote('permit:' + p.kind)
              : '<div class="msp-row"><button type="button" class="msp-btn" data-ppermit="' + p.kind + '">' + (path ? 'Replace document' : 'Upload document') + '</button>' +
                (path ? '<button type="button" class="msp-btn" data-pclearpermit="' + p.kind + '">Remove</button>' : '') + '</div>' +
                '<input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" hidden data-ppermitfile="' + p.kind + '">') + '</div>';
        }).join('') + '</div>';
    }
    function hoursSummary() {
      var M = (typeof window !== 'undefined' && window.SokoniAvailabilityModel) || null;
      if (!S.hours) return '<p class="msp-sub">No opening hours yet — buyers see your shop as open whenever you are online.</p>';
      var txt = M && M.formatWeek ? M.formatWeek(S.hours) : '';
      return '<div class="msp-hours">' + (txt ? esc(txt).split(' · ').join('<br>') : 'Hours are set.') + '</div>';
    }
    function stepSetup() {
      var d = S.draft; var phys = d.shopType === 'hybrid' || d.shopType === 'physical';
      return '<div class="msp-card"><div class="msp-h">Where you trade</div>' +
        select('city', 'City / county', CITIES, true) +
        '<div class="msp-lbl">Shop presence</div>' + options('shopType', PRESENCE) +
        (phys ? '<div class="msp-grid2"><div>' + field('address', 'Street / building', { req: true, ph: 'e.g. Moi Avenue, Bazaar Plaza, 2nd floor', ac: 'street-address' }) + '</div><div>' +
          field('mapsLink', 'Google Maps link', { ph: 'https://maps.app.goo.gl/…', type: 'url', im: 'url', hint: 'In Google Maps: Share → Copy link.' }) + '</div></div>' : '') +
      '</div>' +
      '<div class="msp-card"><div class="msp-h">Opening hours</div>' + hoursSummary() +
        '<button type="button" class="msp-btn" data-phours="1" style="margin-top:8px">Edit opening hours →</button>' +
        '<p class="msp-sub" style="margin-top:8px">One timetable for your storefront, orders and SOKONI search — edited in Availability, with holidays and closures.</p></div>' +
      '<div class="msp-card"><div class="msp-h">How buyers reach you</div><div class="msp-grid2"><div>' +
        field('phone', 'Phone / WhatsApp', { req: true, type: 'tel', im: 'tel', ph: '0712 345 678', ac: 'tel' }) + '</div><div>' +
        field('email', 'Email', { type: 'email', im: 'email', ph: 'shop@example.co.ke', ac: 'email' }) + '</div></div>' +
        field('website', 'Website', { type: 'url', im: 'url', ph: 'https://myshop.co.ke', ac: 'url' }) +
        '<div class="msp-lbl">Social media <span style="font-weight:500">— your handle or profile link</span></div><div class="msp-grid2">' +
        [['instagram', '@yourshop'], ['tiktok', '@yourshop'], ['facebook', 'yourshop'], ['twitter', '@yourshop'], ['youtube', '@yourchannel'], ['linkedin', 'company/yourshop']]
          .map(function (x) { return '<div>' + field(x[0], LABELS[x[0]], { ph: x[1], ac: 'off' }) + '</div>'; }).join('') +
      '</div></div>';
    }
    function stepDelivery() {
      var d = S.draft;
      var custom = (d.zones || []).filter(function (z) { return ZONES.indexOf(z) === -1; });
      return '<div class="msp-card"><div class="msp-h">Delivery</div>' +
        '<p class="msp-sub">Delivery fees are quoted by SOKONI at checkout from the real distance — you do not set them here.</p>' +
        options('delMethod', DEL_METHODS) +
        (d.delMethod && d.delMethod !== 'pickup' ? select('delTime', 'Usual delivery time', DEL_TIMES) : '') +
      '</div>' +
      (d.delMethod !== 'pickup' ? '<div class="msp-card"><div class="msp-h">Where you deliver</div>' +
        '<p class="msp-sub">Buyers see these areas on your storefront.</p><div class="msp-chips" role="group" aria-label="Delivery areas">' +
        ZONES.concat(custom).map(function (z) {
          var on = (d.zones || []).indexOf(z) !== -1;
          return '<button type="button" aria-pressed="' + on + '" class="msp-chip' + (on ? ' on' : '') + '" data-pzone="' + esc(z) + '">' + esc(z) + '</button>';
        }).join('') + '</div>' +
        '<div class="msp-link" style="margin-top:12px"><input class="msp-in" id="msp-zone-new" data-pnewzone="1" maxlength="60" placeholder="Add another area, e.g. Ruiru" value="' + esc(S.customZone) + '" aria-label="Add a delivery area">' +
        '<button type="button" class="msp-btn" data-paddzone="1">Add</button></div></div>' : '') +
      '<div class="msp-card"><div class="msp-h">Extras</div>' +
        field('freeDelivery', 'Free delivery above (KES)', { im: 'numeric', ph: 'e.g. 3000',
          hint: 'Saved for your records. SOKONI checkout does not apply it yet, so it is not promised to buyers.' }) +
        field('packagingNote', 'Packaging note', { area: true, rows: 3, count: true, ph: 'e.g. Every order is sealed and gift-wrapped on request.' }) +
      '</div>' +
      '<div class="msp-card"><div class="msp-h">Returns &amp; refunds</div>' + options('returnPolicy', RETURNS) +
        (d.returnPolicy === 'custom' ? field('returnText', 'Your policy', { area: true, rows: 4, count: true, req: true }) : '') +
      '</div>';
    }
    function stepLive() {
      var d = S.draft; var items = readiness(d); var done = items.filter(function (i) { return i.ok; }).length;
      var listed = S.cat && S.cat.listed;
      var url = S.storefrontUrl ? (ctx.origin || '') + S.storefrontUrl : '';
      var del = labelOf(DEL_METHODS, d.delMethod);
      var city = labelOf(CITIES, d.city);
      return '<div class="msp-card"><div class="msp-h">Preview</div><p class="msp-sub">How your storefront header will look — built only from what you entered.</p>' +
        '<div class="msp-prev"><div class="msp-prev-cover" style="' + coverStyle(d) + '"></div><div class="msp-prev-body">' +
          '<div class="msp-prev-logo">' + (d.logoUrl ? '<img alt="" src="' + esc(d.logoUrl) + '">' : '🏪') + '</div>' +
          '<div class="msp-prev-name">' + esc(d.name || 'Your shop name') + '</div>' +
          '<div class="msp-prev-tag">' + esc(d.tagline || 'Your tagline') + '</div>' +
          '<div class="msp-prev-badges">' +
            (S.cat && S.cat.label ? '<span class="msp-badge">' + esc(S.cat.label) + '</span>' : '') +
            (city ? '<span class="msp-badge">📍 ' + esc(city) + '</span>' : '') +
            (del ? '<span class="msp-badge">' + esc(del) + '</span>' : '') +
          '</div></div></div></div>' +
      '<div class="msp-card"><div class="msp-h">Storefront readiness · ' + done + ' / ' + items.length + '</div>' +
        '<ul class="msp-check">' + items.map(function (i) {
          return '<li><button type="button" data-pgo="' + i.step + '"><span class="' + (i.ok ? 'ok' : 'no') + '" aria-hidden="true">' + (i.ok ? '✓' : '○') + '</span>' +
            esc(i.t) + '<span class="msp-sub" style="margin:0 0 0 auto">' + (i.ok ? 'Done' : 'Add →') + '</span></button></li>';
        }).join('') + '</ul></div>' +
      '<div class="msp-card"><div class="msp-h">Public listing</div>' +
        (listed ? '<div class="msp-note ok">Your shop is approved and listed — buyers can find it in SOKONI search.</div>'
          : (!S.status && !S.cat)
            /* the server reported neither status nor category (the live getShopProfile does not): unknown, not a state */
            ? '<div class="msp-note" data-plisting="unknown">Listing status is not reported here yet — whether buyers can find your shop is decided by SOKONI approval, not by this page.</div>'
          : '<div class="msp-note warn">' + esc(S.status === 'pending'
              ? 'Your shop is saved but not yet listed. It goes live once SOKONI approves your business application and assigns its category.'
              : (S.status === 'suspended' ? 'Your shop is suspended, so it is hidden from buyers. Contact SOKONI support.'
                : 'Your shop is not listed yet — SOKONI is assigning its category.')) + '</div>') +
        (url ? '<div class="msp-lbl">Your storefront link</div><div class="msp-link"><input class="msp-in" readonly value="' + esc(url) + '" aria-label="Storefront link">' +
          '<button type="button" class="msp-btn" data-pcopy="1">Copy</button><a class="msp-btn" style="display:grid;place-items:center;text-decoration:none" href="' + esc(url) + '" target="_blank" rel="noopener">Open ↗</a></div>'
          : '<p class="msp-sub">Your storefront link appears after your first save.</p>') +
      '</div>' +
      (typeof ctx.callSaveConfig === 'function' ? '<div class="msp-card"><div class="msp-h">Storefront extras</div>' +
        (S.extrasReady
          ? extraField('announcement', 'Announcement banner', 'e.g. 🎉 10% off all shoes this week') + extraField('responseTime', 'Typical reply time', 'e.g. within an hour') +
            '<button type="button" class="msp-btn" data-psaveextras="1"' + (S.busy ? ' disabled' : '') + '>Save extras</button>'
          : '<p class="msp-sub">Loading…</p>') + '</div>' : '');
    }
    function extraField(k, label, ph) {
      return '<label class="msp-lbl" for="msp-x-' + k + '">' + esc(label) + '</label><input class="msp-in" id="msp-x-' + k + '" data-px="' + k + '" maxlength="' + MAX[k] + '" placeholder="' + esc(ph) + '" value="' + esc(S.extras[k]) + '">';
    }

    function ctaHTML() {
      var n = changedCount(S.draft, S.saved) + (JSON.stringify(S.comp) !== JSON.stringify(S.savedComp) ? 1 : 0);
      var upl = Object.keys(S.uploading).some(function (k) { return S.uploading[k]; });
      var st = S.busy ? 'Saving on the server…' : (upl ? 'Uploading…' : (n ? n + ' unsaved change' + (n === 1 ? '' : 's') : 'All changes saved'));
      return '<div class="msp-cta"><div class="st" role="status" aria-live="polite">' + esc(st) + '</div><div class="btns">' +
        (S.step > 1 ? '<button type="button" class="msp-btn" data-pnav="-1">← Back</button>' : '') +
        (S.step < 5 ? '<button type="button" class="msp-btn" data-pnav="1">Next →</button>' : '') +
        '<button type="button" class="msp-btn solid" data-psave="1"' + (S.busy || upl || !n ? ' disabled' : '') + '>' + (S.busy ? 'Saving…' : 'Save shop') + '</button>' +
      '</div></div>';
    }
    function resultHTML() {
      var r = S.result; if (!r) return '';
      var h = '<div class="msp-note ' + (r.kind || 'ok') + '" role="status">' + esc(r.msg) + '</div>';
      return h;
    }

    function paint() {
      if (S.phase === 'loading') { host.innerHTML = '<div class="msp"><div class="msp-card"><div class="msp-sk" style="width:60%"></div><div class="msp-sk" style="width:85%"></div><div class="msp-sk" style="width:40%"></div></div></div>'; return; }
      if (S.phase === 'not_owner') {
        host.innerHTML = '<div class="msp"><div class="msp-card"><div class="msp-h">Owner only</div><p class="msp-sub">Only the shop owner can change shop details. Ask the owner to update them.</p></div></div>';
        return;
      }
      if (S.phase === 'no_shop') {
        host.innerHTML = '<div class="msp"><div class="msp-card"><div class="msp-h">No shop yet</div><p class="msp-sub">Your shop is created when SOKONI approves your business application. Once approved, set up every detail of your storefront here.</p></div></div>';
        return;
      }
      if (S.phase === 'error') {
        host.innerHTML = '<div class="msp"><div class="msp-note bad">Your shop details could not be loaded: ' + esc(S.error) + '</div><button type="button" class="msp-btn" data-preload="1">Try again</button></div>';
        return;
      }
      var body = S.step === 1 ? stepIdentity() : S.step === 2 ? stepPermits() : S.step === 3 ? stepSetup() : S.step === 4 ? stepDelivery() : stepLive();
      var doneSteps = { 1: !!(S.draft.name && S.draft.tagline), 2: !!(S.comp.kraPin || S.comp.permits.kra), 3: !!(S.draft.city && S.draft.phone), 4: !!(S.draft.delMethod && S.draft.returnPolicy), 5: false };
      host.innerHTML = '<div class="msp">' +
        '<nav class="msp-steps" aria-label="Shop details steps">' + STEPS.map(function (s) {
          return '<button type="button" class="msp-step' + (S.step === s.id ? ' on' : '') + (doneSteps[s.id] ? ' done' : '') + '"' + (S.step === s.id ? ' aria-current="step"' : '') +
            ' data-pgo="' + s.id + '"><span class="n">' + (doneSteps[s.id] && S.step !== s.id ? '✓' : s.id) + '</span>' + esc(s.label) + '</button>';
        }).join('') + '</nav>' +
        '<div class="msp-bar" aria-hidden="true"><i style="width:' + (S.step * 20) + '%"></i></div>' +
        resultHTML() + body + ctaHTML() + '</div>';
    }

    /* ── actions ── */
    function go(step) {
      S.step = Math.max(1, Math.min(5, step)); paint();
      var top = host.querySelector('.msp'); if (top && top.scrollIntoView) try { top.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (_) { /* old engines */ }
    }
    function upload(kind, file, isPermit) {
      if (!file) return;
      if (isPermit && NOT_YET.permitDocs) { S.result = { kind: 'warn', msg: NOT_YET_NOTE }; paint(); return; }   /* gated — never uploads */
      var okType = isPermit ? /^(image\/(jpeg|png|webp)|application\/pdf)$/ : /^image\/(jpeg|png|webp)$/;
      var max = isPermit ? 20 : 10;
      if (!okType.test(file.type || '')) { S.result = { kind: 'bad', msg: isPermit ? 'Upload a photo (JPG, PNG, WebP) or a PDF.' : 'Upload a JPG, PNG or WebP image.' }; paint(); return; }
      if (file.size >= max * 1024 * 1024) { S.result = { kind: 'bad', msg: 'That file is larger than ' + max + ' MB.' }; paint(); return; }
      if (typeof ctx.upload !== 'function' || !ctx.uid) { S.result = { kind: 'bad', msg: 'Uploads are not available just now.' }; paint(); return; }
      var ext = file.type === 'application/pdf' ? 'pdf' : (file.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
      var path = isPermit ? 'kyc-documents/' + ctx.uid + '/permit-' + kind + '-' + Date.now() + '.' + ext
        : 'seller-assets/' + ctx.uid + '/' + kind + '-' + Date.now() + '.' + ext;
      S.uploading[kind] = true; S.result = null; paint();
      Promise.resolve(ctx.upload({ path: path, blob: file, contentType: file.type, cacheControl: isPermit ? 'private,max-age=0' : 'public,max-age=31536000' }))
        .then(function (url) {
          if (isPermit) S.comp.permits[kind] = path;
          else if (kind === 'logo') S.draft.logoUrl = String(url || '');
          else S.draft.bannerUrl = String(url || '');
          S.result = { kind: 'ok', msg: (isPermit ? 'Document uploaded' : (kind === 'logo' ? 'Logo uploaded' : 'Banner uploaded')) + ' — press Save shop to publish it.' };
        })
        .catch(function (e) { S.result = { kind: 'bad', msg: 'Upload failed: ' + ((e && (e.code || e.message)) || 'unknown error') + '.' }; })
        .then(function () { S.uploading[kind] = false; paint(); });
    }
    function save() {
      S.errors = validate(S.draft, S.comp);
      var keys = Object.keys(S.errors);
      if (keys.length) {
        S.result = { kind: 'bad', msg: 'Fix ' + keys.length + ' thing' + (keys.length === 1 ? '' : 's') + ' before saving: ' + keys.map(function (k) { return LABELS[k] || k; }).join(', ') + '.' };
        S.step = Math.min.apply(null, keys.map(function (k) { return STEP_OF[k] || 5; })); paint(); return;
      }
      if (typeof ctx.callSave !== 'function') return;
      S.busy = true; S.result = null; paint();
      var payload = toPayload(S.draft, S.comp, S.savedComp);
      Promise.resolve(ctx.callSave(payload)).then(function (r) {
        var d = (r && r.data) || r || {};
        if (!d.success) throw new Error('The server did not confirm the save.');
        var bad = (d.invalid || []).map(function (k) { return LABELS[k] || k; });
        var ign = (d.ignored || []).map(function (k) { return LABELS[k] || k; });
        /* only what the server ACCEPTED becomes the saved state: reload the canonical profile */
        return Promise.resolve(ctx.callGet({})).then(function (g) {
          var gd = (g && g.data) || g || {};
          var f = fromServer(gd);
          S.saved = f.profile; S.draft = JSON.parse(JSON.stringify(f.profile));
          S.savedComp = f.compliance; S.comp = JSON.parse(JSON.stringify(f.compliance));
          S.status = gd.status || S.status; S.cat = gd.sokoniCategory || S.cat;
          S.handle = gd.handle || d.handle || S.handle; S.storefrontUrl = gd.storefrontUrl || d.storefrontUrl || S.storefrontUrl;
          var parts = ['Saved.'];
          /* Only a server REPORT of the storefront rebuild is relayed. The live saveShopProfile does not rebuild the
             storefront and reports nothing (storefrontSynced undefined) — say so, never "up to date". */
          if (d.storefrontSynced === true) parts.push('Your storefront is up to date.');
          else if (d.storefrontSynced === false) parts.push('Your storefront did not update — press Save shop again.');
          else parts.push('Storefront refresh: not confirmed by the server.');
          if (bad.length) parts.push('Not saved (check the format): ' + bad.join(', ') + '.');
          if (ign.length) parts.push('Set by SOKONI, not here: ' + ign.join(', ') + '.');
          S.result = { kind: bad.length || d.storefrontSynced === false ? 'warn' : 'ok', msg: parts.join(' ') };
          toast(d.storefrontSynced === false ? 'Saved — storefront not updated' : 'Shop saved');
        });
      }).catch(function (e) {
        S.result = { kind: 'bad', msg: 'Your shop was NOT saved — ' + ((e && e.message) || 'unknown error') + '. Nothing was changed.' };
      }).then(function () { S.busy = false; paint(); });
    }
    function saveExtras() {
      var diff = {};
      ['announcement', 'responseTime'].forEach(function (k) { if (S.extras[k] !== S.savedExtras[k]) diff[k] = S.extras[k]; });
      if (!Object.keys(diff).length) { S.result = { kind: 'ok', msg: 'No changes to your storefront extras.' }; paint(); return; }
      S.busy = true; paint();
      if (!S.shopId) { S.result = { kind: 'bad', msg: 'Your shop is still loading — try again in a moment.' }; paint(); return; }
      Promise.resolve(ctx.callSaveConfig({ shopId: S.shopId, config: diff })).then(function () {
        S.savedExtras = JSON.parse(JSON.stringify(S.extras));
        S.result = { kind: 'ok', msg: 'Storefront extras saved.' };
      }).catch(function (e) {
        S.result = { kind: 'bad', msg: 'Extras NOT saved — ' + ((e && e.message) || 'unknown error') + '.' };
      }).then(function () { S.busy = false; paint(); });
    }
    function addZone() {
      var z = S.customZone.replace(/[<>]/g, '').trim().slice(0, 60);
      if (!z) return;
      if ((S.draft.zones || []).indexOf(z) === -1) S.draft.zones = (S.draft.zones || []).concat([z]).slice(0, 40);
      S.customZone = ''; paint();
    }

    function onClick(ev) {
      var t = ev.target && ev.target.closest ? ev.target.closest('[data-pgo],[data-pnav],[data-psave],[data-pchoose],[data-paccent],[data-pup],[data-pclear],[data-ppermit],[data-pclearpermit],[data-pzone],[data-paddzone],[data-phours],[data-pcopy],[data-psaveextras],[data-preload]') : null;
      if (!t || !host.contains(t)) return;
      var a = t.dataset;
      if (a.pgo) return go(+a.pgo);
      if (a.pnav) return go(S.step + (+a.pnav));
      if (a.psave) return save();
      if (a.preload) return load();
      if (a.pchoose) {
        if (a.pchoose === 'sellerType' && NOT_YET.sellerType) return;   /* gated control: a click changes nothing */
        S.draft[a.pchoose] = S.draft[a.pchoose] === a.v && a.pchoose === 'sellerType' ? '' : a.v; delete S.errors[a.pchoose]; return paint();
      }
      if (a.paccent) { S.draft.themeColor = a.paccent; return paint(); }
      if (a.pup) { var fi = host.querySelector('[data-pfile="' + a.pup + '"]'); if (fi) fi.click(); return; }
      if (a.pclear) { S.draft[a.pclear] = ''; return paint(); }
      if (a.ppermit) { var pf = host.querySelector('[data-ppermitfile="' + a.ppermit + '"]'); if (pf) pf.click(); return; }
      if (a.pclearpermit) { S.comp.permits[a.pclearpermit] = ''; return paint(); }
      if (a.pzone) {
        var z = a.pzone, list = (S.draft.zones || []).slice(), i = list.indexOf(z);
        if (i === -1) list.push(z); else list.splice(i, 1);
        S.draft.zones = list; return paint();
      }
      if (a.paddzone) return addZone();
      if (a.phours) { if (typeof ctx.onOpenAvailability === 'function') ctx.onOpenAvailability(); return; }
      if (a.pcopy) {
        var url = (ctx.origin || '') + (S.storefrontUrl || '');
        try { navigator.clipboard.writeText(url).then(function () { toast('Storefront link copied'); }, function () { toast(url); }); } catch (_) { toast(url); }
        return;
      }
      if (a.psaveextras) return saveExtras();
    }
    function onKey(ev) {
      var t = ev.target;
      if ((ev.key === 'Enter' || ev.key === ' ') && t && t.dataset && t.dataset.pup) { ev.preventDefault(); var fi = host.querySelector('[data-pfile="' + t.dataset.pup + '"]'); if (fi) fi.click(); }
      if (ev.key === 'Enter' && t && t.dataset && t.dataset.pnewzone) { ev.preventDefault(); addZone(); }
    }
    function onInput(ev) {
      var el = ev.target; if (!el || !el.dataset) return;
      if (el.dataset.pnewzone) { S.customZone = el.value; return; }
      if (el.dataset.px) { S.extras[el.dataset.px] = el.value; return; }
      var k = el.dataset.pf; if (!k) return;
      if (el.dataset.comp) S.comp[k] = el.value; else S.draft[k] = el.value;
      /* update in place — a repaint on each keystroke would drop the mobile keyboard */
      var c = host.querySelector('#msp-f-' + k + '-c'); if (c && MAX[k]) c.textContent = el.value.length + ' / ' + MAX[k];
      var st = host.querySelector('.msp-cta .st'), sv = host.querySelector('[data-psave]');
      var n = changedCount(S.draft, S.saved) + (JSON.stringify(S.comp) !== JSON.stringify(S.savedComp) ? 1 : 0);
      if (st && !S.busy) st.textContent = n ? n + ' unsaved change' + (n === 1 ? '' : 's') : 'All changes saved';
      if (sv) sv.disabled = !!(S.busy || !n);
    }
    function onChange(ev) {
      var el = ev.target; if (!el || !el.dataset) return;
      if (el.dataset.pfile) { upload(el.dataset.pfile, el.files && el.files[0], false); el.value = ''; return; }
      if (el.dataset.ppermitfile) { upload(el.dataset.ppermitfile, el.files && el.files[0], true); el.value = ''; return; }
      if (el.tagName === 'SELECT' && el.dataset.pf) { S.draft[el.dataset.pf] = el.value; paint(); }
    }
    host.addEventListener('click', onClick);
    host.addEventListener('keydown', onKey);
    host.addEventListener('input', onInput);
    host.addEventListener('change', onChange);
    load();
    return {
      refresh: load,
      state: function () { return S; },
      destroy: function () {
        host.removeEventListener('click', onClick); host.removeEventListener('keydown', onKey);
        host.removeEventListener('input', onInput); host.removeEventListener('change', onChange);
      },
    };
  }

  return { mount: mount, CSS_ID: CSS_ID,
    _h: { fromServer: fromServer, validate: validate, readiness: readiness, toPayload: toPayload, changedCount: changedCount,
      safeLink: safeLink, safeHandle: safeHandle, NOT_YET: NOT_YET, NOT_YET_NOTE: NOT_YET_NOTE,
      PROFILE_KEYS: PROFILE_KEYS, PERMITS: PERMITS, ZONES: ZONES, STEPS: STEPS } };
}));
