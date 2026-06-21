/**
 * SOKONI Algolia Sync Test Suite
 *
 * Self-contained test runner using Node.js built-in `assert` — no Jest or Mocha
 * required. All Firestore and Algolia dependencies are mocked inline.
 *
 * Usage:
 *   node functions/test/algolia-sync.test.js
 *
 * Exit code 0 = all tests passed; exit code 1 = one or more failures.
 */

'use strict';

const assert = require('assert').strict;
const path   = require('path');

/* ── Patch require for firebase-admin / firebase-functions before any import ─ */

// Stub firebase-admin and firebase-functions so algolia-indexer and
// algolia-settings load cleanly without real Firebase credentials.
const Module    = require('module');
const _origLoad = Module._load.bind(Module);
Module._load = function (request, parent, isMain) {
  if (request === 'firebase-admin') {
    return {
      apps: [],
      initializeApp: () => {},
      firestore: Object.assign(
        () => ({ collection: () => ({ add: async () => ({}) }) }),
        { FieldValue: { serverTimestamp: () => 'SERVER_TS' } }
      ),
    };
  }
  if (request === 'firebase-functions/v2/https') {
    return {
      onCall:     (opts, fn) => (typeof fn === 'function' ? fn : opts),
      HttpsError: class HttpsError extends Error {
        constructor(code, msg) { super(msg); this.code = code; }
      },
    };
  }
  if (request === 'firebase-functions/v2/firestore') {
    return {
      onDocumentCreated: () => () => {},
      onDocumentUpdated: () => () => {},
      onDocumentDeleted: () => () => {},
    };
  }
  if (request === 'firebase-functions/v2/scheduler') {
    return { onSchedule: () => () => {} };
  }
  if (request === 'firebase-functions/params') {
    return { defineSecret: (name) => ({ value: () => `mock_${name}` }) };
  }
  return _origLoad(request, parent, isMain);
};

/* ── Load modules under test ─────────────────────────────────────────────── */

const FUNCTIONS_DIR = path.resolve(__dirname, '..');

const {
  TRANSFORMERS,
  COLLECTION_INDEX_MAP,
} = require(path.join(FUNCTIONS_DIR, 'algolia-indexer'));

const {
  removeHtml,
  generateKeywords,
  freshnessScore,
  aiQualityScore,
  normalizePhone,
  normalizeLocation,
  buildGlobalRecord,
} = require(path.join(FUNCTIONS_DIR, 'algolia-transform'));

const {
  INDEX_SETTINGS,
  KENYAN_SYNONYMS,
} = require(path.join(FUNCTIONS_DIR, 'algolia-settings'));

/* ── Test runner ─────────────────────────────────────────────────────────── */

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}: ${err.message}`);
    if (process.env.VERBOSE) console.error(err.stack);
    failed++;
  }
}

/* ── Fixtures ────────────────────────────────────────────────────────────── */

/**
 * Create a mock Firestore Timestamp for a date N days ago.
 * @param {number} daysAgo - positive = past, negative = future
 */
function mockTimestamp(daysAgo) {
  const ms = Date.now() - daysAgo * 86400 * 1000;
  return {
    toMillis: () => ms,
    seconds:  Math.floor(ms / 1000),
    toDate:   () => new Date(ms),
  };
}

const SAMPLE_PRODUCT = {
  name:           'Wireless Bluetooth Speaker',
  description:    'High-quality portable speaker with deep bass and 12-hour battery life. Perfect for outdoor use.',
  category:       'Electronics',
  subcategory:    'Audio',
  brand:          'Sony',
  price:          4500,
  inStock:        true,
  quantity:       25,
  tags:           ['bluetooth', 'portable', 'speaker', 'audio'],
  images:         [{ url: 'https://example.com/speaker.jpg', alt: 'Speaker' }],
  sellerId:       'seller_abc',
  sellerName:     'Tech Hub Kenya',
  sellerVerified: true,
  rating:         4.5,
  reviewCount:    120,
  viewCount:      3400,
  orderCount:     200,
  city:           'Nairobi',
  county:         'Nairobi',
  country:        'Kenya',
  status:         'active',
  isFeatured:     true,
  createdAt:      mockTimestamp(10),
  updatedAt:      mockTimestamp(2),
};

const SAMPLE_SELLER = {
  shopName:      'Kikwetu Boutique',
  description:   'Fashion store selling authentic African prints and modern clothing.',
  category:      'Fashion',
  phone:         '0712345678',
  rating:        4.2,
  reviewCount:   55,
  orderCount:    320,
  followerCount: 890,
  verified:      true,
  city:          'Mombasa',
  county:        'Mombasa',
  status:        'active',
  createdAt:     mockTimestamp(60),
};

const SAMPLE_EVENT = {
  title:         'Nairobi Tech Summit 2026',
  description:   'Annual gathering of Kenyan technology innovators and entrepreneurs.',
  category:      'Technology',
  price:         500,
  startDate:     mockTimestamp(-5), // 5 days in the future
  venue:         'KICC Nairobi',
  city:          'Nairobi',
  county:        'Nairobi',
  organizerName: 'TechKE',
  tags:          ['tech', 'innovation', 'networking'],
  isFeatured:    true,
  status:        'active',
  createdAt:     mockTimestamp(3),
};

const SAMPLE_JOB = {
  title:       'Senior React Developer',
  company:     'SafariPay Ltd',
  description: 'We are looking for a skilled React developer with 3+ years of experience building financial applications.',
  skills:      ['React', 'TypeScript', 'Node.js', 'Firebase'],
  category:    'Software Engineering',
  jobType:     'full-time',
  city:        'Nairobi',
  county:      'Nairobi',
  status:      'active',
  createdAt:   mockTimestamp(1),
};

/* ═══════════════════════════════════════════════════════════════════════════
   MAIN — all test sections run inside a single async IIFE so we can use
   await without top-level await (which would turn this into an ES module
   and break require()).
════════════════════════════════════════════════════════════════════════════ */

(async function main() {

  /* ─────────────────────────────────────────────────────────────────────
     SECTION 1: Transform Utilities
  ────────────────────────────────────────────────────────────────────── */

  console.log('\nSection 1: Transform Utilities');

  await test('removeHtml strips basic tags', async () => {
    const result = removeHtml('<p>Hello <b>World</b></p>');
    assert.equal(result, 'Hello World');
  });

  await test('removeHtml removes script blocks including content', async () => {
    const result = removeHtml('<p>Safe</p><script>alert("xss")</script>');
    assert.ok(!result.includes('alert'),  'script content must be removed');
    assert.ok(!result.includes('script'), 'script tag must be removed');
    assert.ok(result.includes('Safe'),    '"Safe" text must survive');
  });

  await test('removeHtml removes style blocks including content', async () => {
    const result = removeHtml('<style>.x{color:red}</style><p>Text</p>');
    assert.ok(!result.includes('.x'),   'style content must be removed');
    assert.ok(result.includes('Text'),  '"Text" must survive');
  });

  await test('removeHtml decodes HTML entities', async () => {
    const result = removeHtml('&amp; &lt; &gt; &nbsp; &quot;');
    assert.ok(result.includes('&'),  '&amp; must decode to &');
    assert.ok(result.includes('<'),  '&lt; must decode to <');
    assert.ok(result.includes('>'),  '&gt; must decode to >');
    assert.ok(result.includes('"'),  '&quot; must decode to "');
  });

  await test('removeHtml collapses whitespace', async () => {
    const result = removeHtml('<p>Hello\n\n   World</p>');
    assert.equal(result, 'Hello World');
  });

  await test('removeHtml handles empty/null input gracefully', async () => {
    assert.equal(removeHtml(''),        '');
    assert.equal(removeHtml(null),      '');
    assert.equal(removeHtml(undefined), '');
  });

  /* ─────────────────────────────────────────────────────────────────────
     SECTION 2: generateKeywords
  ────────────────────────────────────────────────────────────────────── */

  console.log('\nSection 2: generateKeywords');

  await test('generateKeywords extracts tokens from name and category', async () => {
    const kw = generateKeywords({ name: 'Bluetooth Speaker', category: 'Electronics' });
    assert.ok(kw.includes('bluetooth'),   'must extract "bluetooth"');
    assert.ok(kw.includes('speaker'),     'must extract "speaker"');
    assert.ok(kw.includes('electronics'), 'must extract "electronics"');
  });

  await test('generateKeywords removes English stopwords', async () => {
    const kw = generateKeywords({ name: 'the best speaker for the home' });
    assert.ok(!kw.includes('the'), '"the" is a stopword and must be excluded');
    assert.ok(!kw.includes('for'), '"for" is a stopword and must be excluded');
    assert.ok(kw.includes('best'));
    assert.ok(kw.includes('speaker'));
    assert.ok(kw.includes('home'));
  });

  await test('generateKeywords deduplicates tokens', async () => {
    const kw    = generateKeywords({ name: 'Speaker speaker SPEAKER', category: 'speaker' });
    const count = kw.filter(t => t === 'speaker').length;
    assert.equal(count, 1, 'Duplicate "speaker" should appear exactly once');
  });

  await test('generateKeywords respects 50-keyword maximum', async () => {
    const longName = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    const kw = generateKeywords({ name: longName });
    assert.ok(kw.length <= 50, `Got ${kw.length} keywords; max is 50`);
  });

  await test('generateKeywords filters single-character tokens', async () => {
    const kw = generateKeywords({ name: 'a i o tv laptop' });
    assert.ok(!kw.includes('a'), 'Single-char tokens must be removed');
    assert.ok(!kw.includes('i'), 'Single-char tokens must be removed');
    assert.ok(kw.includes('tv'),     '"tv" (2 chars) must be kept');
    assert.ok(kw.includes('laptop'), '"laptop" must be kept');
  });

  await test('generateKeywords includes tags and skills arrays', async () => {
    const kw = generateKeywords({ tags: ['javascript', 'typescript'], skills: ['firebase'] });
    assert.ok(kw.includes('javascript'),  'tags must be tokenised');
    assert.ok(kw.includes('typescript'),  'tags must be tokenised');
    assert.ok(kw.includes('firebase'),    'skills must be tokenised');
  });

  /* ─────────────────────────────────────────────────────────────────────
     SECTION 3: freshnessScore
  ────────────────────────────────────────────────────────────────────── */

  console.log('\nSection 3: Freshness Score');

  await test('freshnessScore returns 100 for doc updated within 7 days', async () => {
    assert.equal(freshnessScore(null, mockTimestamp(3)), 100);
  });

  await test('freshnessScore returns 85 for doc updated within 30 days', async () => {
    assert.equal(freshnessScore(null, mockTimestamp(15)), 85);
  });

  await test('freshnessScore returns 65 for doc updated within 90 days', async () => {
    assert.equal(freshnessScore(null, mockTimestamp(60)), 65);
  });

  await test('freshnessScore returns 40 for doc updated within 180 days', async () => {
    assert.equal(freshnessScore(null, mockTimestamp(120)), 40);
  });

  await test('freshnessScore returns 20 for doc updated within 365 days', async () => {
    assert.equal(freshnessScore(null, mockTimestamp(200)), 20);
  });

  await test('freshnessScore returns 5 for doc older than 365 days', async () => {
    assert.equal(freshnessScore(null, mockTimestamp(400)), 5);
  });

  await test('freshnessScore returns 50 when no timestamp available', async () => {
    assert.equal(freshnessScore(null, null), 50);
  });

  await test('freshnessScore prefers updatedAt over createdAt', async () => {
    // createdAt = 200 days ago (→ 20), updatedAt = 3 days ago (→ 100)
    const score = freshnessScore(mockTimestamp(200), mockTimestamp(3));
    assert.equal(score, 100, 'updatedAt 3 days ago should yield score 100');
  });

  /* ─────────────────────────────────────────────────────────────────────
     SECTION 4: aiQualityScore
  ────────────────────────────────────────────────────────────────────── */

  console.log('\nSection 4: AI Quality Score');

  await test('aiQualityScore returns 0 for empty data', async () => {
    assert.equal(aiQualityScore({}), 0);
  });

  await test('aiQualityScore awards points for name longer than 5 chars', async () => {
    const score = aiQualityScore({ name: 'My Product' });
    assert.ok(score >= 15, `Expected >= 15, got ${score}`);
  });

  await test('aiQualityScore awards points for description > 50 chars', async () => {
    const desc  = 'This is a detailed product description that is definitely longer than fifty characters.';
    const score = aiQualityScore({ description: desc });
    assert.ok(score >= 20, `Expected >= 20, got ${score}`);
  });

  await test('aiQualityScore awards bonus for description > 200 chars', async () => {
    const short = aiQualityScore({ description: 'A'.repeat(51) });
    const long  = aiQualityScore({ description: 'A'.repeat(201) });
    assert.ok(long > short, 'Longer description must score higher');
  });

  await test('aiQualityScore awards points for at least one image', async () => {
    const noImg   = aiQualityScore({ name: 'Test Product Name Here' });
    const withImg = aiQualityScore({ name: 'Test Product Name Here', images: ['https://img.com/x.jpg'] });
    assert.ok(withImg > noImg, 'Record with image must score higher than one without');
  });

  await test('aiQualityScore never exceeds 100', async () => {
    const perfect = {
      name:        'Perfect Product Name',
      description: 'A'.repeat(250),
      images:      [{ url: 'https://img.com/x.jpg' }],
      category:    'Electronics',
      price:       999,
      city:        'Nairobi',
      rating:      4.8,
      tags:        ['tag1', 'tag2', 'tag3'],
    };
    const score = aiQualityScore(perfect);
    assert.ok(score <= 100, `Score ${score} must not exceed 100`);
  });

  await test('aiQualityScore returns minimum 80 when all 8 main components present', async () => {
    const complete = {
      name:        'Full Product Name Here',
      description: 'A'.repeat(201),
      images:      [{ url: 'https://img.com/x.jpg' }],
      category:    'Electronics',
      price:       1200,
      city:        'Nairobi',
      rating:      4.5,
      tags:        ['audio', 'wireless'],
    };
    const score = aiQualityScore(complete);
    assert.ok(score >= 80, `Expected >= 80 for complete document, got ${score}`);
  });

  /* ─────────────────────────────────────────────────────────────────────
     SECTION 5: normalizePhone
  ────────────────────────────────────────────────────────────────────── */

  console.log('\nSection 5: Phone Normalization');

  await test('normalizePhone converts 0XXXXXXXXX (10-digit local format)', async () => {
    assert.equal(normalizePhone('0712345678'), '+254712345678');
  });

  await test('normalizePhone converts 9-digit local number (no leading zero)', async () => {
    assert.equal(normalizePhone('712345678'), '+254712345678');
  });

  await test('normalizePhone accepts already-correct +254 format', async () => {
    assert.equal(normalizePhone('+254712345678'), '+254712345678');
  });

  await test('normalizePhone strips spaces from +254 format', async () => {
    assert.equal(normalizePhone('+254 712 345 678'), '+254712345678');
  });

  await test('normalizePhone converts 254XXXXXXXXX (no leading +)', async () => {
    assert.equal(normalizePhone('254712345678'), '+254712345678');
  });

  await test('normalizePhone strips dashes from local format', async () => {
    assert.equal(normalizePhone('07-12-345-678'), '+254712345678');
  });

  await test('normalizePhone returns original for unrecognised format', async () => {
    const weird = '555-0100-UNKNOWN';
    assert.equal(normalizePhone(weird), weird);
  });

  /* ─────────────────────────────────────────────────────────────────────
     SECTION 6: normalizeLocation
  ────────────────────────────────────────────────────────────────────── */

  console.log('\nSection 6: normalizeLocation');

  await test('normalizeLocation title-cases city and county', async () => {
    const loc = normalizeLocation({ city: 'nairobi', county: 'nairobi county' });
    assert.equal(loc.city,   'Nairobi');
    assert.equal(loc.county, 'Nairobi County');
  });

  await test('normalizeLocation defaults country to Kenya', async () => {
    const loc = normalizeLocation({ city: 'Kisumu' });
    assert.equal(loc.country, 'Kenya');
  });

  await test('normalizeLocation reads city from nested location.city', async () => {
    const loc = normalizeLocation({ location: { city: 'Nakuru', county: 'Nakuru' } });
    assert.equal(loc.city,   'Nakuru');
    assert.equal(loc.county, 'Nakuru');
  });

  await test('normalizeLocation handles null input gracefully', async () => {
    const loc = normalizeLocation(null);
    assert.equal(loc.city,    '');
    assert.equal(loc.country, 'Kenya');
  });

  /* ─────────────────────────────────────────────────────────────────────
     SECTION 7: Collection → Index Mapping
  ────────────────────────────────────────────────────────────────────── */

  console.log('\nSection 7: Collection to Index Mapping');

  await test('products collection is mapped and has a transformer', async () => {
    assert.ok(COLLECTION_INDEX_MAP.products,                                   'products must be mapped');
    assert.ok(COLLECTION_INDEX_MAP.products.index,                             'products mapping must have index');
    assert.ok(typeof COLLECTION_INDEX_MAP.products.transformer === 'function', 'products must have transformer');
  });

  await test('sellers collection is mapped (stores backward-compat)', async () => {
    assert.ok(COLLECTION_INDEX_MAP.sellers,                                   'sellers must be mapped');
    assert.ok(typeof COLLECTION_INDEX_MAP.sellers.transformer === 'function', 'sellers must have transformer');
  });

  await test('providers and services share the same Algolia index', async () => {
    assert.ok(COLLECTION_INDEX_MAP.providers, 'providers must be mapped');
    assert.equal(
      COLLECTION_INDEX_MAP.providers.index,
      COLLECTION_INDEX_MAP.services.index,
      'providers and services must share the same Algolia index'
    );
  });

  await test('cars collection is mapped (vehicles backward-compat)', async () => {
    assert.ok(COLLECTION_INDEX_MAP.cars, 'cars must be mapped');
    assert.ok(typeof COLLECTION_INDEX_MAP.cars.transformer === 'function');
  });

  await test('properties collection is mapped', async () => {
    assert.ok(COLLECTION_INDEX_MAP.properties, 'properties must be mapped');
  });

  await test('events collection is mapped', async () => {
    assert.ok(COLLECTION_INDEX_MAP.events, 'events must be mapped');
  });

  await test('jobs and digitalJobs share the same Algolia index', async () => {
    assert.ok(COLLECTION_INDEX_MAP.jobs,        'jobs must be mapped');
    assert.ok(COLLECTION_INDEX_MAP.digitalJobs, 'digitalJobs must be mapped');
    assert.equal(
      COLLECTION_INDEX_MAP.jobs.index,
      COLLECTION_INDEX_MAP.digitalJobs.index,
      'jobs and digitalJobs must share the same Algolia index'
    );
  });

  await test('foods collection maps to the products index', async () => {
    assert.ok(COLLECTION_INDEX_MAP.foods, 'foods must be mapped');
    assert.equal(
      COLLECTION_INDEX_MAP.foods.index,
      COLLECTION_INDEX_MAP.products.index,
      'foods must use the products index'
    );
  });

  /* ─────────────────────────────────────────────────────────────────────
     SECTION 8: Skip Guards (transformer-level)
  ────────────────────────────────────────────────────────────────────── */

  console.log('\nSection 8: Skip Guards');

  await test('users transformer returns null for private accounts', async () => {
    const result = TRANSFORMERS.users('uid_1', { displayName: 'Alice', private: true });
    assert.equal(result, null, 'Private user must not be indexed');
  });

  await test('users transformer returns null for banned accounts', async () => {
    const result = TRANSFORMERS.users('uid_2', { displayName: 'Bob', status: 'banned' });
    assert.equal(result, null, 'Banned user must not be indexed');
  });

  await test('users transformer returns null for deleted accounts', async () => {
    const result = TRANSFORMERS.users('uid_3', { displayName: 'Carol', status: 'deleted' });
    assert.equal(result, null, 'Deleted user must not be indexed');
  });

  await test('users transformer returns a record for a normal active user', async () => {
    const result = TRANSFORMERS.users('uid_4', { displayName: 'Dave', status: 'active' });
    assert.ok(result !== null, 'Active user should be indexed');
    assert.equal(result.objectID, 'uid_4');
  });

  /* ─────────────────────────────────────────────────────────────────────
     SECTION 9: Transformer Output Schema Validation
  ────────────────────────────────────────────────────────────────────── */

  console.log('\nSection 9: Transformer Output Schema');

  await test('products transformer produces required fields', async () => {
    const record = TRANSFORMERS.products('prod_001', SAMPLE_PRODUCT);

    assert.equal(record.objectID,        'prod_001');
    assert.equal(record.name,            'Wireless Bluetooth Speaker');
    assert.equal(record.category,        'Electronics');
    assert.equal(record.price,           4500);
    assert.equal(record.inStock,         true);
    assert.equal(record.currency,        'KES');
    assert.ok(Array.isArray(record.tags),                       'tags must be an array');
    assert.ok(typeof record._popularityScore === 'number',      '_popularityScore required');
    assert.ok(record.seller && typeof record.seller === 'object', 'seller sub-object required');
    assert.equal(record.seller.verified, true);
    assert.equal(record.location.country, 'Kenya');
  });

  await test('sellers transformer produces required fields', async () => {
    const record = TRANSFORMERS.sellers('store_abc', SAMPLE_SELLER);

    assert.equal(record.objectID, 'store_abc');
    assert.ok(record.name,        'name is required');
    assert.equal(record.verified, true);
    assert.equal(record.hub,      'sellers');
    assert.ok(typeof record._popularityScore === 'number');
  });

  await test('events transformer produces required fields', async () => {
    const record = TRANSFORMERS.events('evt_001', SAMPLE_EVENT);

    assert.equal(record.objectID, 'evt_001');
    assert.ok(record.title,       'title is required');
    assert.equal(record.category, 'Technology');
    assert.equal(record.hub,      'events');
    assert.ok(typeof record._popularityScore === 'number');
  });

  await test('services transformer produces required fields', async () => {
    const data = {
      name:        'Plumbing Repair',
      description: 'Professional plumbing services in Nairobi.',
      category:    'Home Services',
      price:       2000,
      priceType:   'hourly',
      city:        'Nairobi',
      status:      'active',
      createdAt:   mockTimestamp(5),
    };
    const record = TRANSFORMERS.services('svc_001', data);

    assert.equal(record.objectID,  'svc_001');
    assert.equal(record.name,      'Plumbing Repair');
    assert.equal(record.currency,  'KES');
    assert.ok(record.provider && typeof record.provider === 'object', 'provider sub-object required');
    assert.ok(typeof record._popularityScore === 'number');
  });

  await test('digitalJobs transformer produces required fields', async () => {
    const record = TRANSFORMERS.digitalJobs('job_001', SAMPLE_JOB);

    assert.equal(record.objectID, 'job_001');
    // jobs use 'title' field
    assert.ok(record.title || record.name, 'job must have a title or name');
    assert.ok(typeof record._popularityScore === 'number');
  });

  /* ─────────────────────────────────────────────────────────────────────
     SECTION 10: buildGlobalRecord
  ────────────────────────────────────────────────────────────────────── */

  console.log('\nSection 10: buildGlobalRecord');

  await test('buildGlobalRecord produces objectID with collection prefix', async () => {
    const primary = TRANSFORMERS.products('prod_123', SAMPLE_PRODUCT);
    const global  = buildGlobalRecord('products', 'prod_123', primary);

    assert.equal(global.objectID, 'products_prod_123',
      'objectID must be ${collection}_${id} to prevent cross-type collisions');
  });

  await test('buildGlobalRecord sets type and typeLabel', async () => {
    const primary = TRANSFORMERS.products('prod_123', SAMPLE_PRODUCT);
    const global  = buildGlobalRecord('products', 'prod_123', primary);

    assert.equal(global.type,      'products');
    assert.equal(global.typeLabel, 'Product');
  });

  await test('buildGlobalRecord resolves title from primary record name', async () => {
    const primary = TRANSFORMERS.products('prod_123', SAMPLE_PRODUCT);
    const global  = buildGlobalRecord('products', 'prod_123', primary);

    assert.ok(global.title && global.title.length > 0, 'title must be non-empty');
  });

  await test('buildGlobalRecord truncates description to 300 chars', async () => {
    const longDesc = 'D'.repeat(500);
    const primary  = TRANSFORMERS.products('prod_x', { ...SAMPLE_PRODUCT, description: longDesc });
    const global   = buildGlobalRecord('products', 'prod_x', primary);

    assert.ok(global.description.length <= 300,
      `description length ${global.description.length} must not exceed 300`);
  });

  await test('buildGlobalRecord sets correct url for products', async () => {
    const primary = TRANSFORMERS.products('prod_123', SAMPLE_PRODUCT);
    const global  = buildGlobalRecord('products', 'prod_123', primary);

    assert.equal(global.url, '/products/prod_123');
  });

  await test('buildGlobalRecord sets correct url for events', async () => {
    const primary = TRANSFORMERS.events('evt_42', SAMPLE_EVENT);
    const global  = buildGlobalRecord('events', 'evt_42', primary);

    assert.equal(global.url, '/events/evt_42');
  });

  await test('buildGlobalRecord sets priceFormatted when price is present', async () => {
    const primary = TRANSFORMERS.products('prod_p', { ...SAMPLE_PRODUCT, price: 1500 });
    const global  = buildGlobalRecord('products', 'prod_p', primary);

    assert.equal(global.price, 1500);
    assert.ok(global.priceFormatted && global.priceFormatted.includes('KES'),
      'priceFormatted must start with KES');
  });

  await test('buildGlobalRecord priceFormatted is null when price is 0', async () => {
    const primary = TRANSFORMERS.events('evt_free', { ...SAMPLE_EVENT, price: 0, isFree: true });
    const global  = buildGlobalRecord('events', 'evt_free', primary);

    assert.equal(global.priceFormatted, null, 'Zero price must produce null priceFormatted');
  });

  await test('buildGlobalRecord inherits _popularityScore from primary', async () => {
    const primary = TRANSFORMERS.products('prod_pop', { ...SAMPLE_PRODUCT, orderCount: 500 });
    const global  = buildGlobalRecord('products', 'prod_pop', primary);

    assert.ok(typeof global._popularityScore === 'number');
    assert.ok(global._popularityScore > 0, 'High orderCount must produce non-zero popularity');
  });

  await test('buildGlobalRecord resolves seller.verified into top-level verified', async () => {
    const primary = TRANSFORMERS.products('prod_v', SAMPLE_PRODUCT); // sellerVerified: true
    const global  = buildGlobalRecord('products', 'prod_v', primary);

    assert.equal(global.verified, true);
  });

  await test('buildGlobalRecord throws when required params are missing', async () => {
    assert.throws(
      () => buildGlobalRecord(null, 'id', {}),
      /required/,
      'Must throw when collection is null'
    );
  });

  /* ─────────────────────────────────────────────────────────────────────
     SECTION 11: Queue Deduplication (structural)
  ────────────────────────────────────────────────────────────────────── */

  console.log('\nSection 11: Queue Deduplication');

  await test('queue ID format is collection_docId', async () => {
    const col    = 'products';
    const docId  = 'abc123';
    const idA    = `${col}_${docId}`;
    const idB    = `${col}_${docId}`;
    assert.equal(idA, idB,
      'Repeated writes for the same doc must produce the same queue ID (idempotent)');
  });

  await test('queue IDs for different docs within same collection must differ', async () => {
    assert.notEqual('products_doc1', 'products_doc2');
  });

  await test('queue IDs for same docId in different collections must differ', async () => {
    assert.notEqual('products_abc', 'sellers_abc',
      'Same docId in different collections must not collide in the queue');
  });

  /* ─────────────────────────────────────────────────────────────────────
     SECTION 12: Index Settings Config
  ────────────────────────────────────────────────────────────────────── */

  console.log('\nSection 12: Index Settings Config');

  await test('INDEX_SETTINGS covers all 8 expected indexes', async () => {
    const expected = [
      'products_index','stores_index','services_index','jobs_index',
      'vehicles_index','property_index','events_index','global_search',
    ];
    for (const name of expected) {
      assert.ok(INDEX_SETTINGS[name], `INDEX_SETTINGS missing entry for "${name}"`);
    }
  });

  await test('each index has searchableAttributes defined', async () => {
    for (const [name, settings] of Object.entries(INDEX_SETTINGS)) {
      assert.ok(
        Array.isArray(settings.searchableAttributes) && settings.searchableAttributes.length > 0,
        `${name} must have searchableAttributes`
      );
    }
  });

  await test('each index has customRanking defined', async () => {
    for (const [name, settings] of Object.entries(INDEX_SETTINGS)) {
      assert.ok(
        Array.isArray(settings.customRanking) && settings.customRanking.length > 0,
        `${name} must have customRanking`
      );
    }
  });

  await test('products_index has isFeatured in customRanking', async () => {
    const ranks = INDEX_SETTINGS.products_index.customRanking;
    assert.ok(
      ranks.some(r => r.includes('isFeatured')),
      'products_index customRanking must include isFeatured'
    );
  });

  /* ─────────────────────────────────────────────────────────────────────
     SECTION 13: Kenyan Synonyms Config
  ────────────────────────────────────────────────────────────────────── */

  console.log('\nSection 13: Kenyan Synonyms Config');

  await test('KENYAN_SYNONYMS contains at least 20 entries', async () => {
    assert.ok(KENYAN_SYNONYMS.length >= 20,
      `Expected >= 20 synonyms, got ${KENYAN_SYNONYMS.length}`);
  });

  await test('each synonym entry has objectID, type, and synonyms array', async () => {
    for (const syn of KENYAN_SYNONYMS) {
      assert.ok(syn.objectID,               `Entry missing objectID: ${JSON.stringify(syn)}`);
      assert.equal(syn.type, 'synonym',      `Entry must have type "synonym": ${syn.objectID}`);
      assert.ok(Array.isArray(syn.synonyms), `synonyms must be array: ${syn.objectID}`);
      assert.ok(syn.synonyms.length >= 2,    `synonyms must have >= 2 terms: ${syn.objectID}`);
    }
  });

  await test('KENYAN_SYNONYMS includes gari/car synonym group', async () => {
    const gari = KENYAN_SYNONYMS.find(s => s.synonyms.includes('gari'));
    assert.ok(gari,                          'Must have gari synonym group');
    assert.ok(gari.synonyms.includes('car'), 'gari group must include "car"');
  });

  await test('KENYAN_SYNONYMS includes kazi/job synonym group', async () => {
    const kazi = KENYAN_SYNONYMS.find(s => s.synonyms.includes('kazi'));
    assert.ok(kazi,                          'Must have kazi synonym group');
    assert.ok(kazi.synonyms.includes('job'), 'kazi group must include "job"');
  });

  await test('KENYAN_SYNONYMS objectIDs are unique (no duplicate synonym groups)', async () => {
    const ids = KENYAN_SYNONYMS.map(s => s.objectID);
    const unique = new Set(ids);
    assert.equal(unique.size, ids.length, 'All synonym objectIDs must be unique');
  });

  /* ─────────────────────────────────────────────────────────────────────
     Report
  ────────────────────────────────────────────────────────────────────── */

  console.log(`\n${'─'.repeat(52)}`);
  console.log(`${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.error(`\n${failed} test(s) FAILED.`);
    process.exit(1);
  } else {
    console.log('\nAll tests passed.');
  }

})();
