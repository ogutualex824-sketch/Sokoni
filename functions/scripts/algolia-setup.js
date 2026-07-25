'use strict';
/**
 * One-off Algolia setup script.
 * Run: node functions/scripts/algolia-setup.js
 * Applies settings, synonyms, and query rules to all 8 production indexes.
 */

const https = require('https');

const APP_ID    = process.env.ALGOLIA_APP_ID  || 'F2XND3V1FW';
const ADMIN_KEY = process.env.ALGOLIA_ADMIN_KEY;
if (!ADMIN_KEY) {
  console.error('ERROR: ALGOLIA_ADMIN_KEY environment variable is required.');
  console.error('  Set it: export ALGOLIA_ADMIN_KEY=<your-admin-key>');
  console.error('  Get it from Firebase Secret Manager: firebase functions:secrets:access ALGOLIA_ADMIN_KEY');
  process.exit(1);
}

const INDEXES = [
  'sokoni_products',
  'sokoni_shops',
  'sokoni_services',
  'sokoni_jobs',
  'sokoni_vehicles',
  'sokoni_properties',
  'sokoni_events',
  'global_search',
];

const INDEX_SETTINGS = {
  sokoni_products: {
    searchableAttributes: [
      'unordered(name)',
      'unordered(brand)',
      'unordered(category)',
      'unordered(description)',
      'unordered(sku)',
      'unordered(tags)',
      'sellerName',
    ],
    attributesForFaceting: [
      'filterOnly(sellerId)',
      'filterOnly(isActive)',
      'category',
      'brand',
      'condition',
      'inStock',
      'hub',
    ],
    customRanking: [
      'desc(isFeatured)',
      'desc(seller.verified)',
      'desc(_popularityScore)',
      'desc(_salesScore)',
      'desc(rating)',
      'desc(inStock)',
    ],
    attributesToRetrieve: ['*'],
    attributesToHighlight: ['name', 'brand', 'category'],
    minWordSizefor1Typo: 4,
    minWordSizefor2Typos: 8,
    typoTolerance: true,
    ignorePlurals: true,
    removeStopWords: ['en'],
    queryLanguages: ['en'],
  },
  sokoni_shops: {
    searchableAttributes: [
      'unordered(name)',
      'unordered(description)',
      'unordered(category)',
      'county',
      'town',
    ],
    attributesForFaceting: [
      'filterOnly(ownerId)',
      'filterOnly(isActive)',
      'category',
      'verified',
      'county',
    ],
    customRanking: [
      'desc(verified)',
      'desc(rating)',
      'desc(_popularityScore)',
    ],
    queryLanguages: ['en', 'sw'],
  },
  sokoni_services: {
    searchableAttributes: [
      'unordered(name)',
      'unordered(description)',
      'unordered(category)',
      'providerName',
      'county',
    ],
    attributesForFaceting: [
      'filterOnly(providerId)',
      'filterOnly(isActive)',
      'category',
      'county',
      'priceType',
    ],
    customRanking: [
      'desc(isFeatured)',
      'desc(rating)',
      'desc(_popularityScore)',
    ],
    queryLanguages: ['en', 'sw'],
  },
  sokoni_jobs: {
    searchableAttributes: [
      'unordered(title)',
      'unordered(description)',
      'unordered(company)',
      'unordered(skills)',
      'location',
      'category',
    ],
    attributesForFaceting: [
      'filterOnly(employerId)',
      'filterOnly(isActive)',
      'category',
      'jobType',
      'county',
      'salaryType',
    ],
    customRanking: [
      'desc(isFeatured)',
      'desc(_freshnessScore)',
      'desc(_popularityScore)',
    ],
    queryLanguages: ['en', 'sw'],
  },
  sokoni_vehicles: {
    searchableAttributes: [
      'unordered(make)',
      'unordered(model)',
      'unordered(description)',
      'year',
      'county',
    ],
    attributesForFaceting: [
      'filterOnly(sellerId)',
      'filterOnly(isActive)',
      'make',
      'condition',
      'fuelType',
      'transmission',
      'county',
    ],
    customRanking: [
      'desc(isFeatured)',
      'desc(seller.verified)',
      'desc(_popularityScore)',
    ],
    queryLanguages: ['en', 'sw'],
  },
  sokoni_properties: {
    searchableAttributes: [
      'unordered(title)',
      'unordered(description)',
      'unordered(type)',
      'county',
      'town',
      'area',
    ],
    attributesForFaceting: [
      'filterOnly(agentId)',
      'filterOnly(isActive)',
      'type',
      'listingType',
      'county',
      'bedrooms',
      'bathrooms',
    ],
    customRanking: [
      'desc(isFeatured)',
      'desc(_popularityScore)',
      'desc(_freshnessScore)',
    ],
    queryLanguages: ['en', 'sw'],
  },
  sokoni_events: {
    searchableAttributes: [
      'unordered(title)',
      'unordered(description)',
      'unordered(category)',
      'venue',
      'county',
      'organizer',
    ],
    attributesForFaceting: [
      'filterOnly(organizerId)',
      'filterOnly(isActive)',
      'category',
      'county',
      'isFree',
    ],
    customRanking: [
      'desc(isFeatured)',
      'desc(_freshnessScore)',
      'desc(_popularityScore)',
    ],
    queryLanguages: ['en', 'sw'],
  },
  global_search: {
    searchableAttributes: [
      'unordered(title)',
      'unordered(subtitle)',
      'unordered(keywords)',
      'type',
    ],
    attributesForFaceting: [
      'type',
      'filterOnly(isActive)',
    ],
    customRanking: [
      'desc(isFeatured)',
      'desc(_popularityScore)',
      'desc(_freshnessScore)',
    ],
    queryLanguages: ['en', 'sw'],
  },
};

const SYNONYMS = [
  { objectID: 'syn_phone',      type: 'synonym', synonyms: ['phone','simu','smartphone','mobile'] },
  { objectID: 'syn_clothes',    type: 'synonym', synonyms: ['clothes','nguo','clothing','fashion','outfit'] },
  { objectID: 'syn_car',        type: 'synonym', synonyms: ['car','gari','vehicle','automobile'] },
  { objectID: 'syn_food',       type: 'synonym', synonyms: ['food','chakula','meal','restaurant'] },
  { objectID: 'syn_house',      type: 'synonym', synonyms: ['house','nyumba','home','property','apartment'] },
  { objectID: 'syn_job',        type: 'synonym', synonyms: ['job','kazi','work','employment','career'] },
  { objectID: 'syn_shop',       type: 'synonym', synonyms: ['shop','duka','store','market'] },
  { objectID: 'syn_cheap',      type: 'synonym', synonyms: ['cheap','bei nafuu','affordable','budget'] },
  { objectID: 'syn_new',        type: 'synonym', synonyms: ['new','mpya','brand new'] },
  { objectID: 'syn_second',     type: 'synonym', synonyms: ['second hand','used','mitumba','pre-owned'] },
  { objectID: 'syn_delivery',   type: 'synonym', synonyms: ['delivery','uwasilishaji','shipping','courier'] },
  { objectID: 'syn_laptop',     type: 'synonym', synonyms: ['laptop','computer','kompyuta','pc','notebook'] },
  { objectID: 'syn_tv',         type: 'synonym', synonyms: ['tv','television','runinga','screen'] },
  { objectID: 'syn_shoes',      type: 'synonym', synonyms: ['shoes','viatu','footwear','boots','sandals'] },
  { objectID: 'syn_baby',       type: 'synonym', synonyms: ['baby','mtoto','infant','toddler','kids'] },
  { objectID: 'syn_beauty',     type: 'synonym', synonyms: ['beauty','uzuri','cosmetics','skincare','makeup'] },
  { objectID: 'syn_event',      type: 'synonym', synonyms: ['event','tukio','party','concert','show'] },
  { objectID: 'syn_doctor',     type: 'synonym', synonyms: ['doctor','daktari','physician','medic','hospital'] },
  { objectID: 'syn_lawyer',     type: 'synonym', synonyms: ['lawyer','wakili','attorney','advocate','legal'] },
  { objectID: 'syn_agent',      type: 'synonym', synonyms: ['agent','broker','estate agent','realtor'] },
];

/* ── HTTP helper ─────────────────────────────────────────────────── */

function algoliaRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: `${APP_ID}-dsn.algolia.net`,
      path,
      method,
      headers: {
        'X-Algolia-Application-Id': APP_ID,
        'X-Algolia-API-Key': ADMIN_KEY,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/* ── Main ────────────────────────────────────────────────────────── */

async function main() {
  console.log('\n=== Algolia Setup ===\n');

  // 1. Validate indexes exist
  console.log('1. Validating indexes...');
  const list = await algoliaRequest('GET', '/1/indexes');
  if (list.status !== 200) {
    console.error('  ✗ Could not list indexes:', list.body);
    process.exit(1);
  }
  const existing = (list.body.items || []).map(i => i.name);
  console.log('  Existing indexes:', existing.join(', ') || '(none)');
  for (const idx of INDEXES) {
    if (existing.includes(idx)) console.log(`  ✓ ${idx}`);
    else console.log(`  ✗ MISSING: ${idx}`);
  }

  // 2. Apply settings
  console.log('\n2. Applying index settings...');
  for (const [idx, settings] of Object.entries(INDEX_SETTINGS)) {
    const res = await algoliaRequest('PUT', `/1/indexes/${idx}/settings`, settings);
    if (res.status === 200) console.log(`  ✓ ${idx}`);
    else console.log(`  ✗ ${idx}:`, res.body);
  }

  // 3. Apply synonyms (to all indexes)
  console.log('\n3. Applying synonyms to all indexes...');
  for (const idx of INDEXES) {
    const res = await algoliaRequest('POST', `/1/indexes/${idx}/synonyms/batch?replaceExistingSynonyms=false`, SYNONYMS);
    if (res.status === 200) console.log(`  ✓ ${idx}`);
    else console.log(`  ✗ ${idx}:`, res.body);
  }

  // 4. Apply query rules (products_index and stores_index only)
  console.log('\n4. Applying query rules...');
  const rules = [
    {
      objectID: 'boost_verified_sellers',
      conditions: [{ anchoring: 'is', pattern: '{facet:seller.verified}' }],
      consequence: { promote: [], filterPromotes: false, userData: { boostVerified: true } },
      description: 'Boost verified sellers',
    },
  ];
  for (const idx of ['sokoni_products', 'sokoni_shops']) {
    const res = await algoliaRequest('POST', `/1/indexes/${idx}/rules/batch`, rules);
    if (res.status === 200) console.log(`  ✓ ${idx}`);
    else console.log(`  ✗ ${idx}:`, res.body);
  }

  console.log('\n=== Setup complete ===\n');
}

main().catch(err => { console.error(err); process.exit(1); });
