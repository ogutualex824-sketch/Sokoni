'use strict';

/**
 * SOKONI MiniShop Config Schema v1.0 — the single definition of a shop's
 * storefront configuration.
 *
 * WHY THIS FILE EXISTS
 *
 * MiniShop config was being written in two shapes to two stores, and read in a
 * third shape, so a seller's branding never reached their shop. Measured
 * 2026-07-26:
 *
 *   minishop-admin.html (built-in controller)
 *     writes shops/{shopId}.minishopConfig
 *     as coverImage / logoImage / phone / email / flat social keys
 *
 *   sokoni-minishop.js (canonical controller) -> saveMinishopConfig
 *     writes minishopConfig/{shopId}
 *     as coverUrl / logoUrl / contactPhone / contactEmail / socialLinks{}
 *
 *   the public storefront READS minishopConfig/{shopId}
 *     as coverUrl / logoUrl / contactPhone / brandColor / tagline / ...
 *
 * Two controllers are bound to the same form, so which schema a save produced
 * depended on whether sokoni-minishop.js had loaded. On top of that, seven keys
 * the storefront actually renders — brandColor, category, deliveryPolicy,
 * fontFamily, location, responseTime, tagline — were absent from the CF
 * allowlist, so even the "correct" path dropped them silently on every save.
 *
 * THE CONTRACT
 *
 * The storefront's read set is canonical: it is what customers actually see, so
 * it is the shape everything else must agree with. Writers may send legacy
 * names; `normalize()` folds them in. Readers must go through `resolve()`,
 * which merges the canonical store over the legacy one so shops whose data was
 * only ever written by the old controller still render.
 *
 * Do not add a field to a reader or a writer without adding it here first.
 */

/**
 * Current shape of a persisted config document.
 *
 *   v1 — unversioned. Either of the two pre-convergence schemas; distinguished
 *        only by which keys are present. Handled by the aliases below.
 *   v2 — canonical. Stamped by `forWrite()` on every save from e4dd740 onward.
 *
 * A document with no `schemaVersion` is v1 by definition. Readers do not branch
 * on this yet — v1 and v2 differ only by key names, which `normalize()` already
 * reconciles — so it is recorded now to make a genuinely breaking change later
 * (restructuring a field rather than renaming it) possible without guessing at
 * a document's age. Do not add version branching until a change actually needs
 * it; speculative branches rot.
 */
const SCHEMA_VERSION = 2;

/**
 * Fields that must NEVER be accepted from a client payload, whatever else
 * changes here.
 *
 * `normalize()` is an allowlist by construction, so these are already excluded
 * — this set exists so the guarantee is explicit, greppable, and testable
 * rather than an emergent property someone could undo by widening the
 * allowlist. `assertNoProtected()` enforces it, and the tests assert each name
 * individually. Add to this list whenever a sensitive field is added to
 * `shops/{id}`, not after it leaks.
 */
const PROTECTED_FIELDS = new Set([
  'sellerUid', 'ownerId', 'uid',                      // ownership
  'bankDetails', 'taxPin', 'kraPin', 'payoutAccount', // financial identity
  'balance', 'walletId', 'commissionRate',            // money
  'verified', 'isVerified', 'trustScore', 'status',   // platform-granted standing
  'totalProducts', 'followerCount',                   // server-maintained counters
  'createdAt', 'updatedAt', 'minishopClaimedAt',      // server timestamps
  'minishopHandle', 'handle', 'shopId',               // identity / routing
  'minishopConfig',                                   // the legacy blob itself
]);

/** Canonical fields, and how each is sanitised. */
const STRING_FIELDS = {
  announcement:   200,
  description:    1000,
  tagline:        200,
  location:       120,
  category:       60,
  contactPhone:   20,
  contactEmail:   100,
  coverUrl:       500,
  logoUrl:        500,
  brandColor:     32,
  fontFamily:     60,
  responseTime:   60,
  deliveryPolicy: 500,
  policies:       1000,
  theme:          40,
};

const ARRAY_FIELDS = {
  tags:               { max: 10, itemMax: 30 },
  featuredProductIds: { max: 6,  itemMax: 128 },
  deliveryAreas:      { max: 20, itemMax: 100 },
  languages:          { max: 5,  itemMax: 20 },
  paymentMethods:     { max: 10, itemMax: 50 },
};

/** Free-form objects kept as-is apart from their own nested handling. */
const OBJECT_FIELDS = ['hours', 'socialLinks'];

const SOCIAL_KEYS = ['whatsapp', 'instagram', 'facebook', 'tiktok', 'twitter', 'youtube', 'website'];

/**
 * Legacy key -> canonical key.
 *
 * These are the names minishop-admin.html's built-in controller writes. They
 * are accepted on input and never written back out.
 */
const ALIASES = {
  coverImage:  'coverUrl',
  logoImage:   'logoUrl',
  phone:       'contactPhone',
  email:       'contactEmail',
  accentColor: 'brandColor',
};

const CANONICAL_FIELDS = new Set([
  ...Object.keys(STRING_FIELDS),
  ...Object.keys(ARRAY_FIELDS),
  ...OBJECT_FIELDS,
]);

/**
 * Strip markup, trim, truncate. Non-strings become ''.
 *
 * Script and style blocks are removed *with their contents*. Stripping only the
 * tags — which is what the original helper did — turns `<script>alert(1)</script>`
 * into the literal text `alert(1)` and stores that as the shop's description.
 * It is not an injection risk, because every consumer escapes on output, but it
 * is not text the seller typed either.
 */
function _san(v, max) {
  if (typeof v !== 'string') return '';
  return v
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<[^>]*>/g, '')
    .trim()
    .slice(0, max);
}

/**
 * Convert an arbitrary caller payload into the canonical shape.
 *
 * Accepts both legacy and canonical names, folds flat social keys into
 * socialLinks, sanitises every value, and drops anything unrecognised. Only
 * keys actually present in `raw` appear in the result, so this stays safe to
 * use with a merge write.
 */
function normalize(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};

  /* Flat social keys (whatsapp, instagram, ...) are what the legacy controller
     writes at the top level; the storefront reads them nested. */
  const flatSocials = {};
  for (const k of SOCIAL_KEYS) {
    if (typeof raw[k] === 'string' && raw[k].trim()) flatSocials[k] = _san(raw[k], 200);
  }

  for (const [rawKey, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    const key = ALIASES[rawKey] || rawKey;
    if (!CANONICAL_FIELDS.has(key)) continue;

    if (key in STRING_FIELDS) {
      out[key] = _san(value, STRING_FIELDS[key]);
    } else if (key in ARRAY_FIELDS) {
      const spec = ARRAY_FIELDS[key];
      if (Array.isArray(value)) {
        out[key] = value.slice(0, spec.max).map(v => _san(v, spec.itemMax)).filter(Boolean);
      } else if (typeof value === 'string' && value.trim()) {
        /* The admin form submits deliveryAreas as a comma-separated string. */
        out[key] = value.split(',').map(v => _san(v, spec.itemMax)).filter(Boolean).slice(0, spec.max);
      }
    } else if (key === 'socialLinks') {
      const src = (value && typeof value === 'object') ? value : {};
      const links = {};
      for (const s of SOCIAL_KEYS) {
        if (typeof src[s] === 'string' && src[s].trim()) links[s] = _san(src[s], 200);
      }
      out.socialLinks = { ...links };
    } else if (key === 'hours' && value && typeof value === 'object') {
      out.hours = value;
    }
  }

  if (Object.keys(flatSocials).length) {
    out.socialLinks = { ...flatSocials, ...(out.socialLinks || {}) };
  }

  return out;
}

/**
 * Build the effective config a reader should use.
 *
 * Precedence: canonical store, then the legacy store, then bare fields on the
 * shop document. Later sources only fill gaps — a value written through the
 * proper path always wins.
 *
 * Every reader of MiniShop config must go through this. Reading only the
 * canonical store means shops configured before the schemas converged render
 * with no branding at all.
 */
function resolve(canonicalDoc, legacyDoc, shopDoc) {
  const layers = [
    normalize(canonicalDoc || {}),
    normalize(legacyDoc || {}),
    normalize(shopDoc || {}),
  ];

  const out = {};
  for (const layer of layers) {
    for (const [k, v] of Object.entries(layer)) {
      const empty = v === '' || v === null ||
        (Array.isArray(v) && v.length === 0) ||
        (k === 'socialLinks' && v && Object.keys(v).length === 0);
      if (empty) continue;
      if (k === 'socialLinks') {
        out.socialLinks = { ...v, ...(out.socialLinks || {}) };
      } else if (out[k] === undefined) {
        out[k] = v;
      }
    }
  }
  return out;
}

/**
 * Belt-and-braces check that no protected field survived normalisation.
 *
 * `normalize()` cannot emit one — it only copies canonical keys — so this
 * should never throw. It exists because the day someone widens the allowlist or
 * adds a passthrough branch, the failure would otherwise be silent and would
 * write a client-supplied `sellerUid` into the shop's config. Cheap insurance
 * on a path that already touches Firestore.
 */
function assertNoProtected(config) {
  for (const key of Object.keys(config || {})) {
    if (PROTECTED_FIELDS.has(key)) {
      throw new Error(`minishop-config-schema: protected field "${key}" escaped normalisation`);
    }
  }
  return config;
}

/**
 * Produce the object to persist: canonical fields plus the version stamp.
 *
 * Every writer must use this rather than `normalize()` directly, so that no
 * document is ever written without a version.
 */
function forWrite(raw) {
  const config = assertNoProtected(normalize(raw));
  return { ...config, schemaVersion: SCHEMA_VERSION };
}

/** Version of a stored document. Absent means v1 — written before convergence. */
function readVersion(doc) {
  const v = doc && doc.schemaVersion;
  return Number.isInteger(v) && v > 0 ? v : 1;
}

module.exports = {
  normalize,
  resolve,
  forWrite,
  readVersion,
  assertNoProtected,
  SCHEMA_VERSION,
  PROTECTED_FIELDS,
  CANONICAL_FIELDS,
  ALIASES,
  SOCIAL_KEYS,
  STRING_FIELDS,
  ARRAY_FIELDS,
};
