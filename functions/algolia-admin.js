/**
 * SOKONI Algolia Admin Functions
 *
 * algoliaSetupIndexes    — configure all 13 indexes (settings, replicas, synonyms, rules)
 * algoliaBackfill        — full re-index of one or all collections from Firestore
 * algoliaReindex         — alias for backfill of a single collection
 * algoliaHealthCheck     — verify all indexes are healthy, return stats
 * algoliaGetQueueStats   — queue depth, DLQ size, last processed
 * algoliaDeleteOrphans   — remove Algolia objects that no longer exist in Firestore
 *
 * All admin functions require admin custom claim.
 */

'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const { defineSecret }       = require('firebase-functions/params');
const admin                  = require('firebase-admin');

const { AlgoliaClient, COLLECTION_INDEX_MAP, _chunk } = require('./algolia-indexer');
const { enqueue }                                     = require('./algolia-queue');

const ALGOLIA_ADMIN_KEY = defineSecret('ALGOLIA_ADMIN_KEY');

/* ── Helpers ──────────────────────────────────────────────────────────── */

function _client() {
  const appId = process.env.ALGOLIA_APP_ID;
  const key   = ALGOLIA_ADMIN_KEY.value();
  if (!appId || !key || key === 'not_configured') return null;
  return new AlgoliaClient(appId, key);
}

function _db()  { return admin.firestore(); }
function _now() { return admin.firestore.FieldValue.serverTimestamp(); }

function _assertAdmin(request) {
  if (!request.auth?.token?.admin) throw new HttpsError('permission-denied', 'Admin only.');
}

/* ══════════════════════════════════════════════════════════════════════
   COMMON SEARCH SETTINGS — applied to all primary indexes.
   Individual INDEX_SETTINGS entries take precedence via Object.assign.
══════════════════════════════════════════════════════════════════════ */

const PRIMARY_INDEXES = new Set([
  'sokoni_products', 'sokoni_shops', 'sokoni_services', 'sokoni_events',
  'sokoni_properties', 'sokoni_vehicles', 'sokoni_jobs', 'sokoni_users',
  'sokoni_categories', 'sokoni_brands', 'sokoni_collections', 'sokoni_coupons',
]);

const _COMMON_SEARCH_SETTINGS = {
  /* Recall improvement: re-run query with all words optional when 0 results */
  removeWordsIfNoResults:             'allOptional',
  /* Enables AND, OR, NOT operators + quoted phrase matching */
  advancedSyntax:                     true,
  /* Language-aware tokenization, stemming, and word forms */
  queryLanguages:                     ['en'],
  indexLanguages:                     ['en'],
  /* Plurals: "shoes" hits "shoe" — critical for a shopping platform */
  ignorePlurals:                      true,
  /* Remove English stop words during indexing (reduces noise) */
  removeStopWords:                    ['en'],
  /* Facet payload caps — prevent memory spikes at 1M+ concurrent users */
  maxValuesPerFacet:                  100,
  maxFacetHits:                       20,
  /* Pagination depth — blocks scraping beyond page 42 (1000÷24) */
  paginationLimitedTo:                1000,
  /* Compresses integer arrays in index — reduces storage + improves cache hits */
  allowCompressionOfIntegerArray:     true,
  /* Prevents noisy highlight spans on every element of array fields */
  restrictHighlightAndSnippetArrays:  true,
  /* Preserve Swahili / French diacritics in tokenization */
  keepDiacriticsOnCharacters:         'àâäèêëîïôùûüÿ',
};

/* Per-index settings that extend or override _COMMON_SEARCH_SETTINGS */
const _INDEX_OVERRIDES = {
  sokoni_products: {
    /* Barcodes and SKUs must match exactly — no typo tolerance or prefix expansion */
    disableTypoToleranceOnAttributes: ['barcode', 'sku', 'code'],
    disablePrefixOnAttributes:        ['barcode', 'sku', 'code'],
    /* 50-char description snippet reduces payload ~80% vs sending full description */
    attributesToSnippet:              ['description:50'],
    /* Scoring signals must never reach the browser — restrict at index level */
    unretrievableAttributes:          ['_popularityScore', '_salesScore', '_clickScore', '_conversionScore', 'keywords', 'nameLower',
                                       'sellerEmail', 'sellerPhone', 'bankAccount', 'sellerIdNumber', 'kraPin'],
  },
  sokoni_shops: {
    attributesToSnippet:              ['description:40'],
    unretrievableAttributes:          ['_popularityScore', 'ownerEmail', 'ownerPhone', 'bankAccount', 'kraPin', 'businessRegNo'],
  },
  sokoni_services: {
    attributesToSnippet:              ['description:50'],
    unretrievableAttributes:          ['_popularityScore'],
  },
  sokoni_events: {
    attributesToSnippet:              ['description:50'],
    unretrievableAttributes:          ['_popularityScore'],
  },
  sokoni_properties: {
    attributesToSnippet:              ['description:50'],
    unretrievableAttributes:          ['_popularityScore'],
  },
  sokoni_vehicles: {
    attributesToSnippet:              ['description:40'],
    unretrievableAttributes:          ['_popularityScore'],
  },
  sokoni_jobs: {
    attributesToSnippet:              ['description:50'],
    unretrievableAttributes:          ['_popularityScore'],
  },
  sokoni_users: {
    attributesToSnippet:              ['bio:40'],
    /* unretrievableAttributes already declared in INDEX_SETTINGS below */
  },
  sokoni_brands: {
    unretrievableAttributes:          ['_popularityScore'],
  },
  sokoni_collections: {
    unretrievableAttributes:          ['_popularityScore'],
  },
  sokoni_coupons: {
    /* Coupon codes need exact match only — no typo correction or prefix expansion */
    disableTypoToleranceOnAttributes: ['code'],
    disablePrefixOnAttributes:        ['code'],
  },
};

/* ══════════════════════════════════════════════════════════════════════
   INDEX SETTINGS  — complete configuration for all 13 indexes
══════════════════════════════════════════════════════════════════════ */

const INDEX_SETTINGS = {

  sokoni_products: {
    searchableAttributes: [
      'name',
      'description',
      'unordered(tags)',
      'unordered(keywords)',
      'unordered(categoryPath)',
      'brand',
      'seller.name',
      'unordered(sku)',
      'unordered(barcode)',
    ],
    attributesForFaceting: [
      'filterOnly(status)',
      'filterOnly(hub)',
      'filterOnly(seller.id)',
      'filterOnly(seller.verified)',
      'filterOnly(inStock)',
      'filterOnly(condition)',
      'searchable(category)',
      'searchable(subcategory)',
      'searchable(brand)',
      /* Hierarchical menu — 3-level nested navigation */
      'hierarchicalCategories.lvl0',
      'hierarchicalCategories.lvl1',
      'hierarchicalCategories.lvl2',
      'category',
      'subcategory',
      'brand',
      'condition',
      'deliveryOptions',
      'location.city',
      'location.county',
      'isFeatured',
      'isOnSale',
      'isBestseller',
      'isNew',
    ],
    customRanking: [
      'desc(isFeatured)',
      'desc(featuredLevel)',
      'desc(_popularityScore)',
      'desc(rating)',
      'desc(reviewCount)',
      'desc(orderCount)',
      'desc(updatedAt)',
    ],
    ranking: ['typo', 'geo', 'words', 'filters', 'proximity', 'attribute', 'exact', 'custom'],
    numericAttributesForFiltering: ['price', 'originalPrice', 'discountPercent', 'rating', 'reviewCount', 'orderCount', 'viewCount', 'createdAt', 'updatedAt', 'quantity'],
    typoTolerance:                 true,
    minWordSizefor1Typo:           4,
    minWordSizefor2Typos:          8,
    allowTyposOnNumericTokens:     false,
    ignorePlurals:                 true,
    removeStopWords:               ['en'],
    advancedSyntax:                true,
    queryLanguages:                ['en'],
    indexLanguages:                ['en'],
    distinct:                      false,
    attributeForDistinct:          'seller.id',
    hitsPerPage:                   24,
    paginationLimitedTo:           1000,
    unretrievableAttributes:       ['_popularityScore', '_salesScore', '_clickScore', '_conversionScore', 'keywords'],
    /* AI Ranking: Personalization + Dynamic Re-Ranking */
    enablePersonalization:         true,
    enableReRanking:               true,
    relevancyStrictness:           0,
    /* Virtual replicas share data — no extra storage vs standard replicas */
    replicas: [
      'virtual(sokoni_products_price_asc)',
      'virtual(sokoni_products_price_desc)',
      'virtual(sokoni_products_newest)',
      'virtual(sokoni_products_rating)',
      'virtual(sokoni_products_popular)',
      'virtual(sokoni_products_discount)',
    ],
  },

  /*
   * Virtual replica settings.
   * Keys use the ACTUAL index name (without the virtual() wrapper) because
   * Algolia creates replicas at path `sokoni_products_price_asc`, NOT at
   * `virtual(sokoni_products_price_asc)`. The virtual() syntax is only valid
   * inside the parent's `replicas` array — never as an index name in API calls.
   *
   * algoliaSetupIndexes skips these entries (keys prefixed _vr_) and instead
   * applies them via a dedicated virtual-replica loop with the correct name.
   */
  _vr_sokoni_products_price_asc:  { customRanking: ['asc(price)',            'desc(isFeatured)', 'desc(_popularityScore)'],                  ranking: ['filters', 'custom', 'typo', 'geo', 'words', 'proximity', 'attribute', 'exact'] },
  _vr_sokoni_products_price_desc: { customRanking: ['desc(price)',           'desc(isFeatured)', 'desc(_popularityScore)'],                  ranking: ['filters', 'custom', 'typo', 'geo', 'words', 'proximity', 'attribute', 'exact'] },
  _vr_sokoni_products_newest:     { customRanking: ['desc(createdAt)',       'desc(isFeatured)'],                                             ranking: ['filters', 'custom', 'typo', 'geo', 'words', 'proximity', 'attribute', 'exact'] },
  _vr_sokoni_products_rating:     { customRanking: ['desc(rating)',          'desc(reviewCount)', 'desc(isFeatured)'],                        ranking: ['filters', 'custom', 'typo', 'geo', 'words', 'proximity', 'attribute', 'exact'] },
  _vr_sokoni_products_popular:    { customRanking: ['desc(_popularityScore)', 'desc(orderCount)'],                                            ranking: ['filters', 'custom', 'typo', 'geo', 'words', 'proximity', 'attribute', 'exact'] },
  _vr_sokoni_products_discount:   { customRanking: ['desc(discountPercent)', 'desc(_popularityScore)', 'desc(isFeatured)'],                   ranking: ['filters', 'custom', 'typo', 'geo', 'words', 'proximity', 'attribute', 'exact'] },

  sokoni_shops: {
    searchableAttributes: ['name', 'description', 'unordered(tags)', 'category'],
    attributesForFaceting: [
      'filterOnly(status)',
      'searchable(category)',
      'location.city',
      'location.county',
      'verified',
      'deliveryOptions',
    ],
    customRanking: ['desc(isFeatured)', 'desc(featuredLevel)', 'desc(_popularityScore)', 'desc(rating)', 'desc(orderCount)'],
    typoTolerance:        true,
    ignorePlurals:        true,
    enablePersonalization: true,
    enableReRanking:       true,
    relevancyStrictness:   0,
    hitsPerPage:           20,
  },

  sokoni_services: {
    searchableAttributes: ['name', 'description', 'unordered(tags)', 'category', 'provider.name'],
    attributesForFaceting: [
      'filterOnly(status)',
      'searchable(category)',
      'searchable(subcategory)',
      'location.city',
      'location.county',
      'remote',
      'priceType',
    ],
    numericAttributesForFiltering: ['price', 'priceMax', 'rating', 'orderCount', 'createdAt'],
    customRanking: ['desc(isFeatured)', 'desc(featuredLevel)', 'desc(_popularityScore)', 'desc(rating)'],
    typoTolerance:         true,
    ignorePlurals:         true,
    enablePersonalization: true,
    enableReRanking:       true,
    relevancyStrictness:   0,
    hitsPerPage:           20,
    replicas: ['sokoni_services_price_asc', 'sokoni_services_newest'],
  },

  sokoni_services_price_asc: { customRanking: ['asc(price)', 'desc(isFeatured)'] },
  sokoni_services_newest:    { customRanking: ['desc(createdAt)', 'desc(isFeatured)'] },

  sokoni_events: {
    searchableAttributes: ['title', 'description', 'unordered(tags)', 'category', 'organizer.name', 'location.venue'],
    attributesForFaceting: [
      'filterOnly(status)',
      'searchable(category)',
      'location.city',
      'location.county',
      'isFree',
      'isOnline',
    ],
    numericAttributesForFiltering: ['price', 'startDate', 'endDate', 'attendeeCount', 'createdAt'],
    customRanking: ['asc(startDate)', 'desc(isFeatured)', 'desc(_popularityScore)'],
    typoTolerance:         true,
    ignorePlurals:         true,
    enablePersonalization: true,
    enableReRanking:       true,
    relevancyStrictness:   0,
    hitsPerPage:           20,
    replicas: ['sokoni_events_soonest', 'sokoni_events_popular'],
  },

  sokoni_events_soonest: { customRanking: ['asc(startDate)', 'desc(isFeatured)'] },
  sokoni_events_popular: { customRanking: ['desc(_popularityScore)', 'desc(attendeeCount)'] },

  sokoni_properties: {
    searchableAttributes: ['title', 'description', 'unordered(tags)', 'type', 'location.area', 'location.suburb', 'agent.name'],
    attributesForFaceting: [
      'filterOnly(status)',
      'searchable(type)',
      'listingType',
      'furnished',
      'location.city',
      'location.county',
      'location.area',
      'amenities',
    ],
    numericAttributesForFiltering: ['price', 'bedrooms', 'bathrooms', 'sizeSqm', 'createdAt', 'updatedAt'],
    customRanking: ['desc(isFeatured)', 'desc(featuredLevel)', 'desc(_popularityScore)', 'desc(viewCount)'],
    typoTolerance: true,
    hitsPerPage:   20,
    replicas:      ['sokoni_properties_price_asc', 'sokoni_properties_price_desc', 'sokoni_properties_newest'],
  },

  sokoni_properties_price_asc:  { customRanking: ['asc(price)',    'desc(isFeatured)'] },
  sokoni_properties_price_desc: { customRanking: ['desc(price)',   'desc(isFeatured)'] },
  sokoni_properties_newest:     { customRanking: ['desc(createdAt)', 'desc(isFeatured)'] },

  sokoni_vehicles: {
    searchableAttributes: ['title', 'make', 'model', 'unordered(features)', 'unordered(tags)', 'fuelType', 'transmission', 'color', 'trim'],
    attributesForFaceting: [
      'filterOnly(status)',
      'make',
      'type',
      'listingType',
      'condition',
      'fuelType',
      'transmission',
      'bodyType',
      'driveType',
      'color',
      'location.city',
      'location.county',
      'seller.dealer',
    ],
    numericAttributesForFiltering: ['price', 'year', 'mileage', 'engineCC', 'seats', 'doors', 'createdAt', 'updatedAt'],
    customRanking: ['desc(isFeatured)', 'desc(featuredLevel)', 'desc(_popularityScore)', 'desc(viewCount)'],
    typoTolerance: true,
    hitsPerPage:   20,
    replicas:      ['sokoni_vehicles_price_asc', 'sokoni_vehicles_price_desc', 'sokoni_vehicles_newest', 'sokoni_vehicles_year_desc'],
  },

  sokoni_vehicles_price_asc:  { customRanking: ['asc(price)',    'desc(isFeatured)'] },
  sokoni_vehicles_price_desc: { customRanking: ['desc(price)',   'desc(isFeatured)'] },
  sokoni_vehicles_newest:     { customRanking: ['desc(createdAt)', 'desc(isFeatured)'] },
  sokoni_vehicles_year_desc:  { customRanking: ['desc(year)',    'desc(isFeatured)'] },

  sokoni_jobs: {
    searchableAttributes: ['title', 'company', 'description', 'unordered(skills)', 'unordered(tags)', 'category'],
    attributesForFaceting: [
      'filterOnly(status)',
      'searchable(category)',
      'jobType',
      'remote',
      'experience',
      'education',
      'location.city',
      'location.county',
    ],
    numericAttributesForFiltering: ['salary.min', 'salary.max', 'deadline', 'createdAt', 'applicationCount'],
    customRanking: ['desc(isFeatured)', 'desc(featuredLevel)', 'asc(deadline)', 'desc(_popularityScore)'],
    typoTolerance:         true,
    ignorePlurals:         true,
    enablePersonalization: true,
    enableReRanking:       true,
    relevancyStrictness:   0,
    hitsPerPage:           20,
    replicas: ['sokoni_jobs_newest', 'sokoni_jobs_deadline'],
  },

  sokoni_jobs_newest:   { customRanking: ['desc(createdAt)', 'desc(isFeatured)'] },
  sokoni_jobs_deadline: { customRanking: ['asc(deadline)',   'desc(isFeatured)'] },

  sokoni_users: {
    searchableAttributes: ['displayName', 'username', 'bio', 'unordered(skills)', 'unordered(tags)'],
    attributesForFaceting: [
      'filterOnly(status)',
      'role',
      'verified',
      'location.city',
      'location.county',
    ],
    numericAttributesForFiltering: ['rating', 'reviewCount', 'followerCount', 'joinedAt'],
    customRanking: ['desc(verified)', 'desc(_popularityScore)', 'desc(rating)'],
    typoTolerance: true,
    hitsPerPage:   20,
    unretrievableAttributes: [
      '_popularityScore',
      'email', 'phone', 'phoneNumber', 'mobile',
      'bankAccount', 'bankCode', 'accountNumber',
      'idNumber', 'nationalId', 'kraPin', 'passportNumber',
      'dateOfBirth', 'birthDate',
      'fcmToken', 'pushToken', 'deviceTokens',
      'passwordHash', 'salt',
    ],
  },

  sokoni_categories: {
    searchableAttributes: ['name', 'description'],
    attributesForFaceting: ['hub', 'filterOnly(active)', 'parentId'],
    customRanking: ['asc(order)', 'desc(productCount)'],
    typoTolerance: true,
    hitsPerPage:   50,
  },

  sokoni_brands: {
    searchableAttributes: ['name', 'description', 'unordered(tags)', 'category'],
    attributesForFaceting: ['filterOnly(active)', 'category', 'verified', 'featured'],
    customRanking: ['desc(featured)', 'desc(popular)', 'desc(_popularityScore)'],
    typoTolerance: true,
    hitsPerPage:   30,
  },

  sokoni_collections: {
    searchableAttributes: ['name', 'description', 'unordered(tags)', 'curator.name'],
    attributesForFaceting: ['filterOnly(status)', 'hub', 'featured', 'official'],
    customRanking: ['desc(featured)', 'desc(official)', 'desc(_popularityScore)', 'desc(followCount)'],
    typoTolerance: true,
    hitsPerPage:   24,
  },

  sokoni_coupons: {
    searchableAttributes: ['code', 'name', 'description'],
    attributesForFaceting: ['filterOnly(active)', 'discountType', 'applicableTo', 'freeShipping'],
    numericAttributesForFiltering: ['discountValue', 'minOrderValue', 'validFrom', 'validTo'],
    customRanking: ['desc(featured)', 'desc(discountValue)', 'asc(validTo)'],
    typoTolerance: false,
    hitsPerPage:   20,
  },
};

/* ── Kenyan marketplace synonyms — bilingual EN + Swahili ──────────────── */
const GLOBAL_SYNONYMS = [
  /* Standard two-way synonyms (both directions) */
  { objectID: 'syn_phone',       type: 'synonym', synonyms: ['phone', 'mobile', 'simu', 'smartphone', 'handset', 'mfumo'] },
  { objectID: 'syn_laptop',      type: 'synonym', synonyms: ['laptop', 'computer', 'kompyuta', 'notebook', 'pc', 'macbook'] },
  { objectID: 'syn_shoes',       type: 'synonym', synonyms: ['shoes', 'viatu', 'sneakers', 'boots', 'sandals', 'slippers', 'footwear'] },
  { objectID: 'syn_clothes',     type: 'synonym', synonyms: ['clothes', 'nguo', 'clothing', 'fashion', 'outfit', 'wear', 'garment', 'attire'] },
  { objectID: 'syn_food',        type: 'synonym', synonyms: ['food', 'chakula', 'groceries', 'meals', 'restaurant', 'vikombe', 'bidhaa'] },
  { objectID: 'syn_job',         type: 'synonym', synonyms: ['job', 'kazi', 'work', 'employment', 'career', 'vacancy', 'nafasi ya kazi', 'ajira'] },
  { objectID: 'syn_house',       type: 'synonym', synonyms: ['house', 'nyumba', 'home', 'apartment', 'flat', 'bedsitter', 'studio', 'condo'] },
  { objectID: 'syn_car',         type: 'synonym', synonyms: ['car', 'gari', 'vehicle', 'auto', 'automobile', 'motokaa'] },
  { objectID: 'syn_doctor',      type: 'synonym', synonyms: ['doctor', 'daktari', 'physician', 'medic', 'medical', 'tabibu'] },
  { objectID: 'syn_lawyer',      type: 'synonym', synonyms: ['lawyer', 'advocate', 'attorney', 'legal', 'mwanasheria', 'wakili'] },
  { objectID: 'syn_land',        type: 'synonym', synonyms: ['land', 'ardhi', 'plot', 'acre', 'farm', 'shamba', 'parcel'] },
  { objectID: 'syn_matatu',      type: 'synonym', synonyms: ['matatu', 'transport', 'bus', 'commute', 'usafiri'] },
  { objectID: 'syn_boda',        type: 'synonym', synonyms: ['boda', 'bodaboda', 'motorcycle', 'bike', 'motorbike', 'pikipiki'] },
  { objectID: 'syn_mpesa',       type: 'synonym', synonyms: ['mpesa', 'm-pesa', 'mobile money', 'lipa', 'payment', 'malipo'] },
  { objectID: 'syn_nairobi',     type: 'synonym', synonyms: ['nairobi', 'nbi', '254', 'kenya', 'cbd'] },
  { objectID: 'syn_delivery',    type: 'synonym', synonyms: ['delivery', 'shipping', 'courier', 'send', 'deliver', 'uwasilishaji'] },
  { objectID: 'syn_buy',         type: 'synonym', synonyms: ['buy', 'purchase', 'order', 'nunua', 'agiza', 'shop'] },
  { objectID: 'syn_sell',        type: 'synonym', synonyms: ['sell', 'uza', 'list', 'offer', 'advertise'] },
  { objectID: 'syn_cheap',       type: 'synonym', synonyms: ['cheap', 'affordable', 'bei nafuu', 'budget', 'low price', 'inexpensive'] },
  { objectID: 'syn_free',        type: 'synonym', synonyms: ['free', 'bila malipo', 'complimentary', 'no charge', 'gratis'] },
  { objectID: 'syn_organic',     type: 'synonym', synonyms: ['organic', 'natural', 'asili', 'fresh', 'unprocessed'] },
  { objectID: 'syn_electronics', type: 'synonym', synonyms: ['electronics', 'gadgets', 'tech', 'teknolojia', 'devices'] },
  { objectID: 'syn_furniture',   type: 'synonym', synonyms: ['furniture', 'samani', 'fanicha', 'sofa', 'bed', 'table', 'chair'] },
  { objectID: 'syn_salon',       type: 'synonym', synonyms: ['salon', 'barber', 'hair', 'beauty', 'nywele', 'kinyozi'] },
  { objectID: 'syn_event',       type: 'synonym', synonyms: ['event', 'tukio', 'show', 'concert', 'festival', 'party', 'gathering'] },
  { objectID: 'syn_security',    type: 'synonym', synonyms: ['security', 'usalama', 'guard', 'cctv', 'alarm', 'surveillance'] },
  { objectID: 'syn_cleaning',    type: 'synonym', synonyms: ['cleaning', 'usafi', 'laundry', 'dobi', 'maid', 'househelp'] },
  { objectID: 'syn_school',      type: 'synonym', synonyms: ['school', 'shule', 'college', 'university', 'chuo', 'education', 'elimu', 'tutoring'] },
  { objectID: 'syn_hospital',    type: 'synonym', synonyms: ['hospital', 'hospitali', 'clinic', 'kliniki', 'pharmacy', 'duka la dawa'] },
  { objectID: 'syn_hotel',       type: 'synonym', synonyms: ['hotel', 'hoteli', 'lodge', 'hostel', 'accommodation', 'airbnb', 'bnb'] },
  { objectID: 'syn_gym',         type: 'synonym', synonyms: ['gym', 'fitness', 'mazoezi', 'workout', 'sports', 'michezo'] },
  /* One-way synonyms: query word → stored word (not reverse) */
  { objectID: 'syn_ow_iphone',   type: 'oneWaySynonym', input: 'iphone',   synonyms: ['apple', 'ios'] },
  { objectID: 'syn_ow_samsung',  type: 'oneWaySynonym', input: 'samsung',  synonyms: ['galaxy', 'android'] },
  { objectID: 'syn_ow_toyota',   type: 'oneWaySynonym', input: 'toyota',   synonyms: ['corolla', 'rav4', 'prado', 'landcruiser', 'hilux'] },
  { objectID: 'syn_ow_hb',       type: 'oneWaySynonym', input: 'harambee', synonyms: ['contribution', 'fundraise', 'changa'] },
  { objectID: 'syn_ow_mama',     type: 'oneWaySynonym', input: 'mama mboga', synonyms: ['groceries', 'vegetables', 'mboga'] },
];

/* ── Query Rules — Kenyan marketplace merchandising ────────────────────── */
const PRODUCT_RULES = [
  {
    objectID:    'rule_sale',
    description: 'Sale search → filter to on-sale items',
    conditions:  [{ pattern: 'sale', anchoring: 'contains' }, { pattern: 'offer', anchoring: 'contains' }, { pattern: 'discount', anchoring: 'contains' }, { pattern: 'bei nafuu', anchoring: 'contains' }],
    consequence: { params: { filters: 'isOnSale:true' }, userData: { banner: { type: 'sale' } } },
    enabled:     true,
  },
  {
    objectID:    'rule_new_arrivals',
    description: 'New arrivals search → filter to new items',
    conditions:  [{ pattern: 'new arrivals', anchoring: 'contains' }, { pattern: 'just arrived', anchoring: 'contains' }, { pattern: 'mpya', anchoring: 'contains' }],
    consequence: { params: { filters: 'isNew:true' } },
    enabled:     true,
  },
  {
    objectID:    'rule_bestsellers',
    description: 'Bestseller queries → filter bestsellers',
    conditions:  [{ pattern: 'bestseller', anchoring: 'contains' }, { pattern: 'popular', anchoring: 'contains' }, { pattern: 'trending', anchoring: 'contains' }],
    consequence: { params: { filters: 'isBestseller:true', hitsPerPage: 12 } },
    enabled:     true,
  },
  {
    objectID:    'rule_budget',
    description: 'Budget queries → sort by price ascending',
    conditions:  [{ pattern: 'budget', anchoring: 'contains' }, { pattern: 'cheapest', anchoring: 'contains' }, { pattern: 'affordable', anchoring: 'contains' }],
    consequence: { params: { optionalFilters: ['isOnSale:true'] } },
    enabled:     true,
  },
  {
    objectID:    'rule_free_shipping',
    description: 'Free delivery queries → filter to free-shipping items',
    conditions:  [{ pattern: 'free delivery', anchoring: 'contains' }, { pattern: 'free shipping', anchoring: 'contains' }],
    consequence: { params: { filters: 'deliveryOptions:free' } },
    enabled:     true,
  },
  {
    objectID:    'rule_in_stock',
    description: 'In stock queries → ensure in-stock filter',
    conditions:  [{ pattern: 'in stock', anchoring: 'contains' }, { pattern: 'available', anchoring: 'contains' }],
    consequence: { params: { filters: 'inStock:true' } },
    enabled:     true,
  },
];

const PROPERTY_RULES = [
  {
    objectID:    'rule_for_rent',
    description: 'For rent → filter listing type',
    conditions:  [{ pattern: 'for rent', anchoring: 'contains' }, { pattern: 'to rent', anchoring: 'contains' }, { pattern: 'kupanga', anchoring: 'contains' }],
    consequence: { params: { filters: 'listingType:rent' } },
    enabled:     true,
  },
  {
    objectID:    'rule_for_sale',
    description: 'For sale → filter listing type',
    conditions:  [{ pattern: 'for sale', anchoring: 'contains' }, { pattern: 'to buy', anchoring: 'contains' }, { pattern: 'kuuza', anchoring: 'contains' }],
    consequence: { params: { filters: 'listingType:sale' } },
    enabled:     true,
  },
  {
    objectID:    'rule_furnished',
    description: 'Furnished search → filter furnished properties',
    conditions:  [{ pattern: 'furnished', anchoring: 'contains' }, { pattern: 'fully furnished', anchoring: 'contains' }],
    consequence: { params: { filters: 'furnished:true' } },
    enabled:     true,
  },
];

const EVENT_RULES = [
  {
    objectID:    'rule_free_events',
    description: 'Free events search → filter to free events',
    conditions:  [{ pattern: 'free events', anchoring: 'contains' }, { pattern: 'free admission', anchoring: 'contains' }],
    consequence: { params: { filters: 'isFree:true' } },
    enabled:     true,
  },
  {
    objectID:    'rule_online_events',
    description: 'Online events search',
    conditions:  [{ pattern: 'online', anchoring: 'contains' }, { pattern: 'virtual', anchoring: 'contains' }, { pattern: 'webinar', anchoring: 'contains' }],
    consequence: { params: { filters: 'isOnline:true' } },
    enabled:     true,
  },
];

const JOB_RULES = [
  {
    objectID:    'rule_remote_jobs',
    description: 'Remote job queries → filter remote',
    conditions:  [{ pattern: 'remote', anchoring: 'contains' }, { pattern: 'work from home', anchoring: 'contains' }, { pattern: 'wfh', anchoring: 'contains' }],
    consequence: { params: { filters: 'remote:true' } },
    enabled:     true,
  },
  {
    objectID:    'rule_urgent_jobs',
    description: 'Urgent job vacancies',
    conditions:  [{ pattern: 'urgent', anchoring: 'contains' }, { pattern: 'immediate', anchoring: 'contains' }],
    consequence: { params: { hitsPerPage: 10 }, userData: { badge: 'urgent' } },
    enabled:     true,
  },
];

const VEHICLE_RULES = [
  {
    objectID:    'rule_electric',
    description: 'Electric vehicle search',
    conditions:  [{ pattern: 'electric', anchoring: 'contains' }, { pattern: 'ev', anchoring: 'contains' }, { pattern: 'hybrid', anchoring: 'contains' }],
    consequence: { params: { optionalFilters: ['fuelType:electric', 'fuelType:hybrid'] } },
    enabled:     true,
  },
];

/* ── Shop rules ────────────────────────────────────────────────────────── */
const SHOP_RULES = [
  {
    objectID:    'rule_verified_shops',
    description: 'Verified / trusted shop queries → boost verified flag',
    conditions:  [{ pattern: 'verified', anchoring: 'contains' }, { pattern: 'trusted', anchoring: 'contains' }, { pattern: 'official', anchoring: 'contains' }],
    consequence: { params: { optionalFilters: ['verified:true<score=5>'] } },
    enabled:     true,
  },
  {
    objectID:    'rule_delivery_shops',
    description: 'Delivery-capable shop queries → filter to shops that deliver',
    conditions:  [{ pattern: 'delivery', anchoring: 'contains' }, { pattern: 'delivers', anchoring: 'contains' }, { pattern: 'delivers to', anchoring: 'contains' }],
    consequence: { params: { filters: 'deliveryOptions:delivery' } },
    enabled:     true,
  },
];

/* ── Service rules ─────────────────────────────────────────────────────── */
const SERVICE_RULES = [
  {
    objectID:    'rule_remote_services',
    description: 'Online / remote service queries → filter remote flag',
    conditions:  [{ pattern: 'online', anchoring: 'contains' }, { pattern: 'remote', anchoring: 'contains' }, { pattern: 'virtual', anchoring: 'contains' }, { pattern: 'video call', anchoring: 'contains' }],
    consequence: { params: { filters: 'remote:true' } },
    enabled:     true,
  },
  {
    objectID:    'rule_emergency_services',
    description: 'Urgent / emergency service queries → surface fastest responders',
    conditions:  [{ pattern: 'emergency', anchoring: 'contains' }, { pattern: 'urgent', anchoring: 'contains' }, { pattern: 'immediately', anchoring: 'contains' }],
    consequence: { params: { hitsPerPage: 6 }, userData: { badge: 'urgent' } },
    enabled:     true,
  },
];

/* ── Redirect rules (global — applied to sokoni_products) ─────────────── */
/*
 * Consequence userData.redirect is read by sokoni-search-engine.js and
 * emits a 'redirect' event; the page handler navigates the user.
 * These rules handle navigational queries that should not return product hits.
 */
const REDIRECT_RULES = [
  {
    objectID:    'redirect_help',
    description: 'Help / support / contact navigational queries → help page',
    conditions:  [
      { pattern: 'help',    anchoring: 'is' },
      { pattern: 'support', anchoring: 'is' },
      { pattern: 'contact', anchoring: 'is' },
    ],
    consequence: { params: { query: '' }, userData: { redirect: '/help.html' } },
    enabled:     true,
  },
  {
    objectID:    'redirect_sell',
    description: 'Seller registration navigational queries → seller page',
    conditions:  [
      { pattern: 'sell on sokoni',    anchoring: 'contains' },
      { pattern: 'become a seller',   anchoring: 'contains' },
      { pattern: 'register seller',   anchoring: 'contains' },
      { pattern: 'start selling',     anchoring: 'contains' },
    ],
    consequence: { params: { query: '' }, userData: { redirect: '/seller.html' } },
    enabled:     true,
  },
  {
    objectID:    'redirect_driver',
    description: 'Driver / rider registration queries → driver page',
    conditions:  [
      { pattern: 'become a driver',    anchoring: 'contains' },
      { pattern: 'join as driver',     anchoring: 'contains' },
      { pattern: 'driver registration', anchoring: 'contains' },
      { pattern: 'ride for sokoni',    anchoring: 'contains' },
    ],
    consequence: { params: { query: '' }, userData: { redirect: '/driver.html' } },
    enabled:     true,
  },
  {
    objectID:    'redirect_mpesa',
    description: 'Payment method queries → checkout / help',
    conditions:  [
      { pattern: 'how to pay',     anchoring: 'contains' },
      { pattern: 'payment methods', anchoring: 'contains' },
      { pattern: 'malipo',          anchoring: 'contains' },
    ],
    consequence: { params: { query: '' }, userData: { redirect: '/help.html#payments' } },
    enabled:     true,
  },
];

/* ── Context-aware rules — fire only when ruleContext matches ──────────── */
/*
 * Browser engine (sokoni-search-engine.js) injects ruleContexts based on
 * the current page URL/hub. These rules boost or filter per context.
 */
const CONTEXT_RULES = [
  {
    objectID:    'ctx_homepage_featured',
    description: 'Homepage: boost featured and bestselling products',
    conditions:  [{ context: 'homepage' }],
    consequence: {
      params: { optionalFilters: ['isFeatured:true<score=5>', 'isBestseller:true<score=3>'] },
    },
    enabled: true,
  },
  {
    objectID:    'ctx_food_hub',
    description: 'Food hub: restrict to food category products',
    conditions:  [{ context: 'hub_food' }],
    consequence: { params: { filters: 'hub:food' } },
    enabled:     true,
  },
  {
    objectID:    'ctx_marketplace_hub',
    description: 'Marketplace hub: boost in-stock items',
    conditions:  [{ context: 'hub_marketplace' }],
    consequence: { params: { optionalFilters: ['inStock:true<score=2>'] } },
    enabled:     true,
  },
  {
    objectID:    'ctx_new_user',
    description: 'New / guest users: surface bestsellers + high-rated items',
    conditions:  [{ context: 'user_guest' }],
    consequence: {
      params: { optionalFilters: ['isBestseller:true<score=3>', 'isFeatured:true<score=2>'] },
    },
    enabled: true,
  },
];

const INDEX_RULES = {
  sokoni_products:   [...PRODUCT_RULES, ...REDIRECT_RULES, ...CONTEXT_RULES],
  sokoni_events:     EVENT_RULES,
  sokoni_properties: PROPERTY_RULES,
  sokoni_jobs:       JOB_RULES,
  sokoni_vehicles:   VEHICLE_RULES,
  sokoni_shops:      SHOP_RULES,
  sokoni_services:   SERVICE_RULES,
};

/* ══════════════════════════════════════════════════════════════════════
   algoliaSetupIndexes  — configure all indexes (admin onCall)
══════════════════════════════════════════════════════════════════════ */

const algoliaSetupIndexes = onCall(
  { secrets: [ALGOLIA_ADMIN_KEY], timeoutSeconds: 540 },
  async (request) => {
    _assertAdmin(request);
    const algolia = _client();
    if (!algolia) throw new HttpsError('failed-precondition', 'Algolia not configured.');

    const results = {};

    for (const [key, settings] of Object.entries(INDEX_SETTINGS)) {
      /*
       * Keys prefixed `_vr_` are virtual replica settings — the actual index
       * name is the key without the prefix (e.g. `sokoni_products_price_asc`).
       * These are processed separately after the parent indexes so Algolia has
       * already created the virtual replica indexes from the parent's `replicas`
       * array before we try to configure them.
       */
      if (key.startsWith('_vr_')) continue;

      /*
       * For primary indexes, merge _COMMON_SEARCH_SETTINGS first, then the
       * index-specific settings (which take precedence), then any per-index
       * overrides from _INDEX_OVERRIDES (highest precedence).
       * Replica indexes (e.g. sokoni_services_price_asc) only need their
       * custom-ranking overrides — common settings come from the parent.
       */
      const effectiveSettings = PRIMARY_INDEXES.has(key)
        ? Object.assign({}, _COMMON_SEARCH_SETTINGS, settings, _INDEX_OVERRIDES[key] || {})
        : settings;

      try {
        const res = await algolia.setIndexSettings(key, effectiveSettings);
        results[key] = { ok: true, taskID: res.taskID };
        console.log(`[AlgoliaAdmin] Configured ${key}`);
      } catch (err) {
        results[key] = { ok: false, error: err.message };
        console.error(`[AlgoliaAdmin] Failed to configure ${key}:`, err.message);
      }
    }

    /* Apply virtual replica settings using correct index names */
    for (const [key, settings] of Object.entries(INDEX_SETTINGS)) {
      if (!key.startsWith('_vr_')) continue;
      const replicaIndex = key.slice(4); // strip '_vr_' prefix → actual index name
      try {
        const res = await algolia.setIndexSettings(replicaIndex, settings);
        results[replicaIndex] = { ok: true, taskID: res.taskID, isVirtualReplica: true };
        console.log(`[AlgoliaAdmin] Configured virtual replica ${replicaIndex}`);
      } catch (err) {
        results[replicaIndex] = { ok: false, error: err.message, isVirtualReplica: true };
        console.error(`[AlgoliaAdmin] Failed to configure virtual replica ${replicaIndex}:`, err.message);
      }
    }

    /* Apply global synonyms to all primary commerce indexes */
    const synonymIndexes = ['sokoni_products', 'sokoni_shops', 'sokoni_services', 'sokoni_events', 'sokoni_jobs'];
    for (const idx of synonymIndexes) {
      try {
        await algolia.saveSynonyms(idx, GLOBAL_SYNONYMS, true);
        results[`_synonyms_${idx}`] = { ok: true, count: GLOBAL_SYNONYMS.length };
      } catch (err) {
        results[`_synonyms_${idx}`] = { ok: false, error: err.message };
      }
    }

    /* Apply merchandising rules to relevant indexes */
    for (const [indexName, rules] of Object.entries(INDEX_RULES)) {
      try {
        await algolia.saveRules(indexName, rules, true);
        results[`_rules_${indexName}`] = { ok: true, count: rules.length };
      } catch (err) {
        results[`_rules_${indexName}`] = { ok: false, error: err.message };
      }
    }

    await _db().collection('adminAuditLogs').add({
      action:    'algolia_setup_indexes',
      by:        request.auth.uid,
      results,
      createdAt: _now(),
    });

    return { ok: true, results };
  }
);

/* ══════════════════════════════════════════════════════════════════════
   algoliaBackfill  — full re-index of one or all collections
══════════════════════════════════════════════════════════════════════ */

const algoliaBackfill = onCall(
  { secrets: [ALGOLIA_ADMIN_KEY], timeoutSeconds: 540, memory: '1GiB' },
  async (request) => {
    _assertAdmin(request);
    if (!_client()) throw new HttpsError('failed-precondition', 'Algolia not configured.');

    const { collection: targetCol, pageSize = 500 } = request.data || {};
    const collections = targetCol
      ? [targetCol]
      : Object.keys(COLLECTION_INDEX_MAP).filter((v, i, a) => a.indexOf(v) === i);

    const db      = _db();
    const summary = {};

    for (const col of collections) {
      const mapping = COLLECTION_INDEX_MAP[col];
      if (!mapping) continue;

      let   queued    = 0;
      let   lastDoc   = null;
      let   hasMore   = true;

      while (hasMore) {
        /*
         * Using a simple cursor-paginated full scan rather than `not-in`
         * (which requires a composite index and has a 10-value cap).
         * Skip-guard logic mirrors algolia-sync.js _shouldSkip().
         */
        let q = db.collection(col).orderBy('__name__').limit(pageSize);
        if (lastDoc) q = q.startAfter(lastDoc);

        const snap = await q.get();
        if (snap.empty) { hasMore = false; break; }

        /* Enqueue only indexable docs — skip drafts, deleted, _noIndex */
        const indexable = snap.docs.filter(doc => {
          const d = doc.data();
          if (!d || d._noIndex === true) return false;
          if (d.status === 'draft' || d.status === 'deleted') return false;
          if (col === 'users' && (d.private === true || d.status === 'banned')) return false;
          return true;
        });

        await Promise.all(indexable.map(doc =>
          enqueue({
            collection: col,
            docId:      doc.id,
            operation:  'upsert',
            data:       doc.data(),
          })
        ));

        queued  += indexable.length;
        lastDoc  = snap.docs[snap.docs.length - 1];
        if (snap.size < pageSize) hasMore = false;
      }

      summary[col] = { queued, index: mapping.index };
      console.log(`[AlgoliaAdmin] Backfill queued ${queued} docs for ${col}`);
    }

    await _db().collection('adminAuditLogs').add({
      action: 'algolia_backfill',
      by:     request.auth.uid,
      targetCol: targetCol || 'all',
      summary,
      createdAt: _now(),
    });

    return { ok: true, summary };
  }
);

/* Alias */
const algoliaReindex = algoliaBackfill;

/* ══════════════════════════════════════════════════════════════════════
   algoliaHealthCheck  — verify all indexes, return stats
══════════════════════════════════════════════════════════════════════ */

const algoliaHealthCheck = onCall(
  { secrets: [ALGOLIA_ADMIN_KEY], timeoutSeconds: 60 },
  async (request) => {
    _assertAdmin(request);
    const algolia = _client();
    if (!algolia) throw new HttpsError('failed-precondition', 'Algolia not configured.');

    const primaryIndexes = [
      'sokoni_products', 'sokoni_shops', 'sokoni_services', 'sokoni_events',
      'sokoni_properties', 'sokoni_vehicles', 'sokoni_jobs', 'sokoni_users',
      'sokoni_categories', 'sokoni_brands', 'sokoni_collections', 'sokoni_coupons',
    ];

    const results = await Promise.allSettled(
      primaryIndexes.map(async name => {
        const stats = await algolia.getIndexStats(name);
        return {
          index:        name,
          entries:      stats.entries       || 0,
          dataSize:     stats.dataSize      || 0,
          fileSize:     stats.fileSize      || 0,
          lastBuildTime: stats.lastBuildTimeS || 0,
          pendingTask:  stats.toBeIndexedNb  || 0,
        };
      })
    );

    const health = {};
    primaryIndexes.forEach((name, i) => {
      const r = results[i];
      health[name] = r.status === 'fulfilled'
        ? { ok: true,  ...r.value }
        : { ok: false, error: r.reason?.message };
    });

    /* Queue stats */
    const db = _db();
    const [pending, failed, dlq] = await Promise.all([
      db.collection('algoliaQueue').where('status', '==', 'pending').count().get(),
      db.collection('algoliaQueue').where('status', '==', 'failed').count().get(),
      db.collection('algoliaQueue').where('status', '==', 'dlq').count().get(),
    ]);

    return {
      ok:      true,
      indexes: health,
      queue: {
        pending: pending.data().count,
        failed:  failed.data().count,
        dlq:     dlq.data().count,
      },
      checkedAt: new Date().toISOString(),
    };
  }
);

/* ══════════════════════════════════════════════════════════════════════
   algoliaGetQueueStats  — lightweight queue metrics (non-admin)
══════════════════════════════════════════════════════════════════════ */

const algoliaGetQueueStats = onCall(
  { secrets: [ALGOLIA_ADMIN_KEY], timeoutSeconds: 15 },
  async (request) => {
    _assertAdmin(request);
    const db = _db();
    const snap = await db.collection('platformMetrics').doc('algoliaQueue').get();
    return snap.exists ? snap.data() : { pending: 0, failed: 0, dlq: 0 };
  }
);

/* ══════════════════════════════════════════════════════════════════════
   algoliaDeleteOrphans  — scheduled weekly: removes stale index objects
══════════════════════════════════════════════════════════════════════ */

const algoliaDeleteOrphans = onSchedule(
  {
    schedule:       'every monday 02:00',
    timeoutSeconds: 540,
    memory:         '1GiB',
    secrets:        [ALGOLIA_ADMIN_KEY],
  },
  async () => {
    const algolia = _client();
    if (!algolia) return;

    const db = _db();
    const collectionMap = {
      sokoni_products:    'products',
      sokoni_shops:       'sellers',
      sokoni_services:    'providers',
      sokoni_events:      'events',
      sokoni_properties:  'properties',
      sokoni_vehicles:    'cars',
      sokoni_jobs:        'digitalJobs',
    };

    let totalDeleted = 0;

    for (const [indexName, fsCollection] of Object.entries(collectionMap)) {
      try {
        /* Browse Algolia index, batch-check existence in Firestore */
        let cursor;
        const orphans = [];

        do {
          const body = { hitsPerPage: 1000, attributesToRetrieve: ['objectID'] };
          if (cursor) body.cursor = cursor;
          const res = await algolia._request('POST', `/1/indexes/${indexName}/browse`, body);
          cursor = res.cursor;

          /* Check each objectID against Firestore in batches of 30 (Firestore in limit) */
          for (const chunk of _chunk(res.hits.map(h => h.objectID), 30)) {
            const fsSnap = await db.collection(fsCollection)
              .where(admin.firestore.FieldPath.documentId(), 'in', chunk)
              .select() // no fields — just ID check
              .get();
            const existingIds = new Set(fsSnap.docs.map(d => d.id));
            chunk.forEach(id => { if (!existingIds.has(id)) orphans.push(id); });
          }
        } while (cursor);

        if (orphans.length > 0) {
          await algolia.deleteObjects(indexName, orphans);
          totalDeleted += orphans.length;
          console.log(`[AlgoliaAdmin] Deleted ${orphans.length} orphans from ${indexName}`);
        }
      } catch (err) {
        console.error(`[AlgoliaAdmin] Orphan check failed for ${indexName}:`, err.message);
      }
    }

    await db.collection('adminAuditLogs').add({
      action:       'algolia_delete_orphans',
      totalDeleted,
      createdAt:    _now(),
    });
  }
);

/* ══════════════════════════════════════════════════════════════════════
   algoliaSetupRules  — deploy merchandising rules to all indexes
══════════════════════════════════════════════════════════════════════ */

const algoliaSetupRules = onCall(
  { secrets: [ALGOLIA_ADMIN_KEY], timeoutSeconds: 120 },
  async (request) => {
    _assertAdmin(request);
    const algolia = _client();
    if (!algolia) throw new HttpsError('failed-precondition', 'Algolia not configured.');

    const results = {};
    for (const [indexName, rules] of Object.entries(INDEX_RULES)) {
      try {
        await algolia.saveRules(indexName, rules, true);
        results[indexName] = { ok: true, count: rules.length };
        console.log(`[AlgoliaAdmin] Deployed ${rules.length} rules to ${indexName}`);
      } catch (err) {
        results[indexName] = { ok: false, error: err.message };
        console.error(`[AlgoliaAdmin] Rules failed for ${indexName}:`, err.message);
      }
    }

    await _db().collection('adminAuditLogs').add({
      action: 'algolia_setup_rules',
      by: request.auth.uid,
      results,
      createdAt: _now(),
    });

    return { ok: true, results };
  }
);

/* ══════════════════════════════════════════════════════════════════════
   algoliaSetupPersonalization  — configure personalization strategy
══════════════════════════════════════════════════════════════════════ */

const algoliaSetupPersonalization = onCall(
  { secrets: [ALGOLIA_ADMIN_KEY], timeoutSeconds: 30 },
  async (request) => {
    _assertAdmin(request);
    const algolia = _client();
    if (!algolia) throw new HttpsError('failed-precondition', 'Algolia not configured.');

    const strategy = {
      eventsScoring: [
        /* Click signals — weak but high-frequency */
        { eventName: 'Product Clicked',                    eventType: 'click',      score: 1  },
        { eventName: 'Filter Clicked',                     eventType: 'click',      score: 1  },
        { eventName: 'Objects Viewed',                     eventType: 'view',       score: 1  },
        /* Recommend interaction — slightly stronger signal */
        { eventName: 'Recommend Product Clicked',          eventType: 'click',      score: 2  },
        /* Conversion signals — strongest personalization signal */
        { eventName: 'Product Added To Cart',              eventType: 'conversion', score: 5  },
        { eventName: 'Product Added To Cart After Search', eventType: 'conversion', score: 5  },
        { eventName: 'Product Purchased',                  eventType: 'conversion', score: 10 },
        { eventName: 'Product Purchased After Search',     eventType: 'conversion', score: 10 },
        { eventName: 'Recommend Product Purchased',        eventType: 'conversion', score: 10 },
      ],
      facetsScoring: [
        { facetName: 'hub',             score: 30 },
        { facetName: 'category',        score: 30 },
        { facetName: 'brand',           score: 25 },
        { facetName: 'subcategory',     score: 20 },
        { facetName: 'location.city',   score: 15 },
        { facetName: 'location.county', score: 10 },
        { facetName: 'condition',       score: 8  },
        { facetName: 'jobType',         score: 8  },
        { facetName: 'listingType',     score: 8  },
        { facetName: 'deliveryOptions', score: 5  },
      ],
      personalizationImpact: 75,
    };

    try {
      await algolia.setPersonalizationStrategy(strategy);
      await _db().collection('adminAuditLogs').add({
        action: 'algolia_setup_personalization',
        by: request.auth.uid,
        strategy,
        createdAt: _now(),
      });
      return { ok: true, strategy };
    } catch (err) {
      console.error('[AlgoliaAdmin] Personalization setup failed:', err.message);
      throw new HttpsError('internal', err.message);
    }
  }
);

/* ══════════════════════════════════════════════════════════════════════
   algoliaSetupDynamicReranking  — enable DRR on all primary indexes
══════════════════════════════════════════════════════════════════════ */

const algoliaSetupDynamicReranking = onCall(
  { secrets: [ALGOLIA_ADMIN_KEY], timeoutSeconds: 60 },
  async (request) => {
    _assertAdmin(request);
    const algolia = _client();
    if (!algolia) throw new HttpsError('failed-precondition', 'Algolia not configured.');

    const primaryIndexes = [
      'sokoni_products', 'sokoni_shops', 'sokoni_services', 'sokoni_events',
      'sokoni_properties', 'sokoni_vehicles', 'sokoni_jobs',
    ];

    const results = {};
    await Promise.allSettled(primaryIndexes.map(async idx => {
      try {
        await algolia.setDynamicRerankingConfig(idx, { enableReRanking: true, relevancyStrictness: 0 });
        results[idx] = { ok: true };
      } catch (err) {
        results[idx] = { ok: false, error: err.message };
      }
    }));

    await _db().collection('adminAuditLogs').add({
      action: 'algolia_setup_drr',
      by: request.auth.uid,
      results,
      createdAt: _now(),
    });

    return { ok: true, results };
  }
);

/* ══════════════════════════════════════════════════════════════════════
   algoliaCreateABTest  — create a new A/B test
══════════════════════════════════════════════════════════════════════ */

const algoliaCreateABTest = onCall(
  { secrets: [ALGOLIA_ADMIN_KEY], timeoutSeconds: 30 },
  async (request) => {
    _assertAdmin(request);
    const { name, indexA, indexB, trafficSplit = 50, durationDays = 14 } = request.data || {};
    if (!name || !indexA || !indexB) throw new HttpsError('invalid-argument', 'name, indexA, indexB are required.');

    const algolia = _client();
    if (!algolia) throw new HttpsError('failed-precondition', 'Algolia not configured.');

    const endAt = new Date(Date.now() + durationDays * 86_400_000).toISOString();

    const result = await algolia.createABTest({
      name,
      variants: [
        { index: indexA, trafficPercentage: 100 - trafficSplit, description: 'Control' },
        { index: indexB, trafficPercentage: trafficSplit,       description: 'Variant' },
      ],
      endAt,
    });

    await _db().collection('algoliaABTests').add({
      name, indexA, indexB, trafficSplit, durationDays,
      algoliaID: result.abTestID,
      status:    'running',
      startedAt: _now(),
      endsAt:    endAt,
      createdBy: request.auth.uid,
    });

    return { ok: true, abTestID: result.abTestID, endAt };
  }
);

/* ══════════════════════════════════════════════════════════════════════
   algoliaGetABTestResults  — retrieve A/B test results
══════════════════════════════════════════════════════════════════════ */

const algoliaGetABTestResults = onCall(
  { secrets: [ALGOLIA_ADMIN_KEY], timeoutSeconds: 15 },
  async (request) => {
    _assertAdmin(request);
    const { abTestID } = request.data || {};
    if (!abTestID) throw new HttpsError('invalid-argument', 'abTestID is required.');
    const algolia = _client();
    if (!algolia) throw new HttpsError('failed-precondition', 'Algolia not configured.');
    return algolia.getABTest(abTestID);
  }
);

/* ══════════════════════════════════════════════════════════════════════
   algoliaStopABTest  — stop a running A/B test
══════════════════════════════════════════════════════════════════════ */

const algoliaStopABTest = onCall(
  { secrets: [ALGOLIA_ADMIN_KEY], timeoutSeconds: 15 },
  async (request) => {
    _assertAdmin(request);
    const { abTestID } = request.data || {};
    if (!abTestID) throw new HttpsError('invalid-argument', 'abTestID is required.');
    const algolia = _client();
    if (!algolia) throw new HttpsError('failed-precondition', 'Algolia not configured.');
    const result = await algolia.stopABTest(abTestID);

    /* Update Firestore record */
    const snap = await _db().collection('algoliaABTests').where('algoliaID', '==', abTestID).limit(1).get();
    if (!snap.empty) {
      await snap.docs[0].ref.update({ status: 'stopped', stoppedAt: _now() });
    }

    return { ok: true, result };
  }
);

module.exports = {
  algoliaSetupIndexes,
  algoliaBackfill,
  algoliaReindex,
  algoliaHealthCheck,
  algoliaGetQueueStats,
  algoliaDeleteOrphans,
  algoliaSetupRules,
  algoliaSetupPersonalization,
  algoliaSetupDynamicReranking,
  algoliaCreateABTest,
  algoliaGetABTestResults,
  algoliaStopABTest,
  INDEX_SETTINGS,
  GLOBAL_SYNONYMS,
  INDEX_RULES,
};
