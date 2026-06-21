/**
 * SOKONI Algolia Transform — Standalone utility module
 *
 * Provides transformation helpers that extend the algolia-indexer.js pipeline.
 * Re-exports core utilities so downstream modules have a single import point
 * and do not need to couple directly to algolia-indexer.
 *
 * All functions are pure (no I/O, no side effects) and deterministic.
 * Safe to call from Cloud Functions, queue processors, or unit tests.
 */

'use strict';

/* ── Re-export core utilities from algolia-indexer ────────────────────────── */

const {
  _str,
  _num,
  _arr,
  _unix,
  _geoPoint,
  _buildHierarchicalCategories,
} = require('./algolia-indexer');

/* ═══════════════════════════════════════════════════════════════════════════
   INTERNAL CONSTANTS
════════════════════════════════════════════════════════════════════════════ */

const STOPWORDS = new Set([
  'a','an','the','and','or','but','in','on','at','to','for','of','with',
  'by','from','is','are','was','were','be','been','have','has','had','do',
  'does','did','will','would','could','should','may','might','this','that',
  'these','those','it','its','i','we','you','he','she','they',
]);

const MAX_KEYWORDS   = 50;
const MAX_INPUT_LEN  = 5000;

/** Singleton type label and URL pattern lookup tables */
const TYPE_LABELS = {
  products:    'Product',
  stores:      'Store',
  services:    'Service',
  jobs:        'Job',
  vehicles:    'Vehicle',
  real_estate: 'Property',
  events:      'Event',
  brands:      'Brand',
  categories:  'Category',
  vendors:     'Vendor',
  sellers:     'Store',
  cars:        'Vehicle',
  properties:  'Property',
  providers:   'Service',
};

const URL_PATTERNS = {
  products:    '/products/',
  stores:      '/stores/',
  services:    '/services/',
  jobs:        '/jobs/',
  vehicles:    '/vehicles/',
  real_estate: '/properties/',
  events:      '/events/',
  brands:      '/brands/',
  categories:  '/categories/',
  vendors:     '/stores/',
  sellers:     '/stores/',
  cars:        '/vehicles/',
  properties:  '/properties/',
  providers:   '/services/',
};

/* ═══════════════════════════════════════════════════════════════════════════
   PUBLIC API
════════════════════════════════════════════════════════════════════════════ */

/**
 * Strip HTML tags and decode common HTML entities. Collapses whitespace.
 * Input and output capped at MAX_INPUT_LEN (5 000 chars).
 *
 * @param  {string} str - Raw HTML string
 * @returns {string}    - Plain text, trimmed
 */
function removeHtml(str) {
  if (!str || typeof str !== 'string') return '';

  let s = str.slice(0, MAX_INPUT_LEN);

  // Remove <script>…</script> and <style>…</style> blocks including content
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,  ' ');

  // Remove all remaining HTML tags
  s = s.replace(/<[^>]+>/g, ' ');

  // Decode common HTML entities
  s = s
    .replace(/&amp;/gi,  '&')
    .replace(/&lt;/gi,   '<')
    .replace(/&gt;/gi,   '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, code) => {
      const n = parseInt(code, 10);
      return n < 128 ? String.fromCharCode(n) : '';
    });

  // Collapse multiple spaces / newlines → single space
  s = s.replace(/[\s\r\n]+/g, ' ').trim();

  return s.slice(0, MAX_INPUT_LEN);
}

/**
 * Build a deduplicated keyword array from an object containing searchable fields.
 * Applies lowercase normalisation, stopword filtering, and length guards.
 *
 * @param  {object} obj - { name, description, category, subcategory, brand, tags,
 *                          city, skills, model, make }
 * @returns {string[]}  - Unique keyword tokens, max 50 entries
 */
function generateKeywords(obj) {
  if (!obj || typeof obj !== 'object') return [];

  const fields = [
    obj.name,
    obj.description,
    obj.category,
    obj.subcategory,
    obj.brand,
    obj.model,
    obj.make,
    obj.city,
    ..._arr(obj.tags),
    ..._arr(obj.skills),
  ];

  const tokens = new Set();

  for (const field of fields) {
    if (!field) continue;
    const text = typeof field === 'string' ? field : String(field);
    // Split on whitespace and punctuation (keep alphanumeric and hyphens)
    const parts = text.split(/[\s\p{P}]+/u);
    for (const part of parts) {
      const token = part.toLowerCase().trim();
      if (!token) continue;
      if (token.length < 2 || token.length > 30) continue;
      if (STOPWORDS.has(token)) continue;
      tokens.add(token);
      if (tokens.size >= MAX_KEYWORDS) break;
    }
    if (tokens.size >= MAX_KEYWORDS) break;
  }

  return Array.from(tokens).slice(0, MAX_KEYWORDS);
}

/**
 * Returns a 0-100 freshness score based on document age.
 * Newer documents score higher. Prefers updatedAt over createdAt.
 *
 * @param  {*} createdAt - Firestore Timestamp, Unix seconds, or null
 * @param  {*} updatedAt - Firestore Timestamp, Unix seconds, or null
 * @returns {number}     - Integer freshness score 0-100
 */
function freshnessScore(createdAt, updatedAt) {
  // Resolve the best available timestamp to Unix seconds
  const ts = _unix(updatedAt) || _unix(createdAt);
  if (!ts) return 50; // unknown age → neutral

  const nowSec  = Math.floor(Date.now() / 1000);
  const ageDays = (nowSec - ts) / 86400;

  if (ageDays <= 7)   return 100;
  if (ageDays <= 30)  return 85;
  if (ageDays <= 90)  return 65;
  if (ageDays <= 180) return 40;
  if (ageDays <= 365) return 20;
  return 5;
}

/**
 * Deterministic 0-100 quality score based on content completeness.
 * Does NOT make any AI API calls — pure algorithmic scoring.
 *
 * @param  {object} data - Raw Firestore document data or transformed Algolia record
 * @returns {number}     - Integer quality score 0-100
 */
function aiQualityScore(data) {
  if (!data || typeof data !== 'object') return 0;

  let score           = 0;
  let componentsFound = 0;

  const name        = data.name || data.title || data.storeName || data.jobTitle || '';
  const description = data.description || '';
  const images      = data.images || [];
  const category    = data.category || '';
  const price       = data.price;
  const location    = data.city || data.location?.city || '';
  const rating      = data.rating;
  const tags        = _arr(data.tags);

  // name present and length > 5
  if (name && String(name).length > 5) {
    score += 15;
    componentsFound++;
  }

  // description present and length > 50
  if (description && String(description).length > 50) {
    score += 20;
    componentsFound++;

    // bonus for description > 200 chars
    if (String(description).length > 200) {
      score += 10;
    }
  }

  // at least 1 image
  const imageList = Array.isArray(images) ? images : [];
  if (imageList.length >= 1) {
    score += 15;
    componentsFound++;
  }

  // category present
  if (category && String(category).length > 0) {
    score += 10;
    componentsFound++;
  }

  // price present and > 0
  if (price !== null && price !== undefined && Number(price) > 0) {
    score += 10;
    componentsFound++;
  }

  // location / city present
  if (location && String(location).length > 0) {
    score += 10;
    componentsFound++;
  }

  // rating present and > 0
  if (rating !== null && rating !== undefined && Number(rating) > 0) {
    score += 5;
    componentsFound++;
  }

  // tags: at least 2
  if (tags.length >= 2) {
    score += 5;
    componentsFound++;
  }

  // All 9 base components present → guarantee minimum score of 80
  // (9 components: name, description, images, category, price, location, rating, tags
  //  + the description-length bonus counts as a separate signal for completeness)
  if (componentsFound >= 8) {
    score = Math.max(score, 80);
  }

  return Math.min(100, Math.round(score));
}

/**
 * Normalize Kenyan phone numbers to E.164 format (+254XXXXXXXXX).
 * Returns the original string unchanged if normalization is not possible.
 *
 * @param  {string} phone - Raw phone string in any common Kenyan format
 * @returns {string}      - E.164 (+254XXXXXXXXX) or original input
 */
function normalizePhone(phone) {
  if (!phone || typeof phone !== 'string') return phone || '';

  // Strip all non-digit characters except a leading +
  const hasLeadingPlus = phone.trimStart().startsWith('+');
  const digits = phone.replace(/\D/g, '');

  // +254XXXXXXXXX — already E.164 (13 chars total with +)
  if (hasLeadingPlus && digits.startsWith('254') && digits.length === 12) {
    return `+${digits}`;
  }

  // 0XXXXXXXXX — local format, 10 digits starting with 0
  if (digits.startsWith('0') && digits.length === 10) {
    return `+254${digits.slice(1)}`;
  }

  // 254XXXXXXXXX — without leading + but with country code, 12 digits
  if (digits.startsWith('254') && digits.length === 12) {
    return `+${digits}`;
  }

  // 9 digits — assume local number without leading 0
  if (digits.length === 9) {
    return `+254${digits}`;
  }

  // Cannot normalize — return original unchanged
  return phone;
}

/**
 * Normalize location fields from a Firestore document into a consistent structure.
 * Capitalizes first letter of each word in city and county fields.
 *
 * @param  {object} data - Raw Firestore document
 * @returns {{ city: string, county: string, country: string, area: string, _geoloc?: object }}
 */
function normalizeLocation(data) {
  if (!data || typeof data !== 'object') {
    return { city: '', county: '', country: 'Kenya', area: '' };
  }

  const rawCity   = data.city   || data.town   || data.location?.city   || '';
  const rawCounty = data.county || data.district || data.region || data.location?.county || '';
  const rawArea   = data.area   || data.location?.area || '';
  const rawCountry = data.country || data.location?.country || 'Kenya';

  const _titleCase = (str) =>
    String(str)
      .toLowerCase()
      .replace(/\b\w/g, c => c.toUpperCase());

  const city    = rawCity    ? _titleCase(rawCity)    : '';
  const county  = rawCounty  ? _titleCase(rawCounty)  : '';
  const country = rawCountry ? _titleCase(rawCountry) : 'Kenya';
  const area    = rawArea    ? _titleCase(rawArea)    : '';

  // Resolve _geoloc from multiple common field shapes
  const geoSource = data._geoloc || data.geoPoint || data.location;
  const geoloc    = _geoPoint(geoSource);

  const result = { city, county, country, area };
  if (geoloc !== undefined) result._geoloc = geoloc;

  return result;
}

/**
 * Build a `global_search` index record from an already-transformed primary record.
 * The objectID uses `${collection}_${id}` to prevent cross-collection collisions.
 *
 * @param  {string} collection   - Firestore collection name (e.g. 'products')
 * @param  {string} id           - Document ID
 * @param  {object} primaryRecord - Output of a TRANSFORMER function
 * @returns {object}              - Algolia record shaped for global_search index
 */
function buildGlobalRecord(collection, id, primaryRecord) {
  if (!collection || !id || !primaryRecord) {
    throw new Error('[buildGlobalRecord] collection, id, and primaryRecord are required');
  }

  const typeLabel = TYPE_LABELS[collection] || _titleCaseSingle(collection);
  const urlBase   = URL_PATTERNS[collection] || `/${collection}/`;

  // Resolve title from whichever field the primary record uses
  const title = _str(
    primaryRecord.name
    || primaryRecord.title
    || primaryRecord.storeName
    || primaryRecord.jobTitle
    || ''
  );

  // First 300 chars of description
  const rawDesc    = _str(primaryRecord.description || '');
  const description = rawDesc.length > 300 ? rawDesc.slice(0, 299) + '…' : rawDesc;

  // Best available image
  const image = _str(
    primaryRecord.thumbnail
    || primaryRecord.logo
    || primaryRecord.image
    || (Array.isArray(primaryRecord.images) && primaryRecord.images.length > 0
        ? (primaryRecord.images[0]?.url || primaryRecord.images[0] || '')
        : '')
  );

  // Price formatting
  const price          = primaryRecord.price || null;
  const priceFormatted = price ? `KES ${Number(price).toLocaleString()}` : null;

  // Location resolution — handle both flat and nested forms
  const city    = _str(primaryRecord.location?.city   || primaryRecord.city   || '');
  const county  = _str(primaryRecord.location?.county || primaryRecord.county || '');
  const country = _str(primaryRecord.location?.country || primaryRecord.country || 'Kenya');

  // Verified — check both direct and seller-nested flag
  const verified = Boolean(
    primaryRecord.verified
    || primaryRecord.seller?.verified
    || primaryRecord.agent?.verified
    || primaryRecord.provider?.verified
  );

  return {
    objectID:        `${collection}_${id}`,
    type:            collection,
    typeLabel,
    title,
    description,
    image,
    url:             `${urlBase}${id}`,
    category:        _str(primaryRecord.category || ''),
    city,
    county,
    country,
    price,
    priceFormatted,
    rating:          primaryRecord.rating  || null,
    verified,
    _geoloc:         primaryRecord._geoloc || undefined,
    _popularityScore: _num(primaryRecord._popularityScore),
    _freshnessScore:  _num(primaryRecord._freshnessScore, 50),
    _qualityScore:    _num(primaryRecord._qualityScore,   50),
    createdAt:       primaryRecord.createdAt || 0,
    updatedAt:       primaryRecord.updatedAt || 0,
  };
}

/* ── Internal helpers ──────────────────────────────────────────────────────── */

function _titleCaseSingle(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

/* ═══════════════════════════════════════════════════════════════════════════
   EXPORTS
════════════════════════════════════════════════════════════════════════════ */

module.exports = {
  /* Re-exported from algolia-indexer */
  _str,
  _num,
  _arr,
  _unix,
  _geoPoint,
  _buildHierarchicalCategories,

  /* New utilities */
  removeHtml,
  generateKeywords,
  freshnessScore,
  aiQualityScore,
  normalizePhone,
  normalizeLocation,
  buildGlobalRecord,
};
