/**
 * SOKONI Firestore Search — authoritative fallback search
 * Version: 1.0.0
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * Search on SOKONI is served by Algolia first. When Algolia is not answering —
 * no secured key (getAlgoliaSearchKey unavailable / degraded), an index that was
 * never backfilled, or a network failure — every query must still find the goods
 * that are sitting in Firestore. Before this module the fallback path had three
 * independent defects, and together they meant a freshly listed product was
 * unfindable:
 *
 *   1. search.html queried 13 collections with NO where() clause. Rules for
 *      services, providers, properties, propertyListings, vehicles, digitalJobs
 *      and healthProviders gate reads on `resource.data.status`, and Firestore
 *      rejects a *list* query it cannot prove is safe — so those queries were
 *      denied wholesale and swallowed by a catch. `applications` is owner/admin
 *      read-only and could never be listed by a buyer at all.
 *   2. Nothing searched sellers, so a store ("Kass Vapes") was unreachable by
 *      name no matter how it was spelled.
 *   3. sokoni-search-engine.js::_firestoreFallback used the compat SDK
 *      (`firebase.firestore()`) which is not loaded, and an exact-equality name
 *      range (`startAt(q).endAt(q)`) against the original-case `name` field, so
 *      "cool mint" could never match "Cool Mint".
 *
 * One implementation now serves both callers. It respects the platform
 * visibility contract (realtime.js): a listing is hidden only when it EXPLICITLY
 * says so — `isVisible === false`, or a status of archived/deleted/hidden/
 * removed. Absent status means visible, because most live products carry no
 * status field.
 *
 * READ BUDGET
 * ───────────
 * Indexed lookups run first (searchableTerms array-contains → nameLower prefix).
 * A bounded collection scan runs only when those come up short — products that
 * predate the indexProductCreate trigger have no searchableTerms at all, and
 * sellers were never indexed. Scans are capped per collection and cached for the
 * session, so the cost is paid at most once per collection per tab, not per
 * keystroke.
 *
 * Usage (ES module):
 *   import { firestoreSearch } from './sokoni-firestore-search.js';
 *   const rows = await firestoreSearch(db, 'cool mint', { tab: 'all', limit: 60 });
 *
 * Usage (classic script):
 *   const rows = await window.SokoniFirestoreSearch.search('kass vapes');
 *
 * @see [[Enterprise Search Platform]] · [[Commerce Lifecycle]]
 */

const FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

/* ── Visibility contract — mirrors realtime.js::_isVisibleProduct ─────────── */
const HIDDEN_STATUS = { archived: 1, deleted: 1, hidden: 1, removed: 1, banned: 1 };

function isVisibleDoc(d) {
  if (!d) return false;
  if (d.isVisible === false) return false;
  if (d.suspended === true) return false;
  if (d.status && HIDDEN_STATUS[String(d.status).toLowerCase()]) return false;
  return true;
}

/* ── Money formatting ─────────────────────────────────────────────────────── */
function kes(v, suffix) {
  if (v == null || v === '' || isNaN(Number(v))) return null;
  return 'KES ' + Number(v).toLocaleString() + (suffix || '');
}

/* ── Query tokenisation ───────────────────────────────────────────────────── */
/**
 * "Cool  Mint 50mg!" → ["cool", "mint", "50mg"]
 * Punctuation is dropped; single-character tokens are kept only when the whole
 * query is one character, so "a" still searches but "cool mint a" does not
 * degrade to matching every document containing the letter a.
 */
export function tokenize(raw) {
  const clean = String(raw || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (!clean) return [];
  const all = clean.split(/\s+/).filter(Boolean);
  const kept = all.filter(t => t.length >= 2);
  return (kept.length ? kept : all).slice(0, 6);
}

/* ── Collection specs ─────────────────────────────────────────────────────────
   `guard` returns the where() constraints a list query MUST carry for
   firestore.rules to allow it. Omitting them is not a performance question —
   the read is denied outright. Keep these in sync with firestore.rules.
   `indexed` marks collections carrying searchableTerms + nameLower (written by
   the indexProductCreate / indexProviderCreate triggers).
──────────────────────────────────────────────────────────────────────────── */
const SPECS = [
  {
    col: 'products', tab: 'products', icon: '🛍️', indexed: true, scan: 400,
    /* sellerName/businessName are what make a shop-name query ("kass vapes")
       return that shop's goods. They matter more than usual here because the
       `sellers` collection is empty in production and `shops` has no read rule,
       so the product document is currently the only searchable carrier of a
       store's name. */
    /* The variant attributes are searched too, so "black", "XL" or "256GB"
       finds the products carrying them. They cost nothing extra: the scan
       already fetched the documents, and haystack() skips a field that is
       missing, null or empty. */
    fields: ['name', 'title', 'category', 'subcategory', 'brand', 'description', 'tags', 'location', 'county', 'sellerName', 'storeName', 'businessName',
             'colors', 'sizes', 'storage', 'weights', 'volumes', 'materials'],
    title: d => d.name || d.title || '',
    subtitle: d => d.category || d.sellerName || d.storeName || '',
    location: d => d.location || d.city || d.county || '',
    price: d => kes(d.price),
    thumb: d => d.image || d.thumbnail || (Array.isArray(d.images) ? d.images[0] : null) || null,
    link: (d, id) => 'product.html?id=' + encodeURIComponent(id),
  },
  {
    /* Stores. `shops/{uid}` has no rule in firestore.rules, so a list query
       there is denied — sellers/{uid} is the readable copy store.html falls
       back to, and the one that carries the shop name buyers type. */
    col: 'sellers', tab: 'businesses', icon: '🏪', scan: 300,
    fields: ['name', 'storeName', 'shopName', 'businessName', 'category', 'tagline', 'bio', 'about', 'description', 'address', 'location', 'sellerType', 'handle'],
    title: d => d.name || d.storeName || d.shopName || d.businessName || '',
    subtitle: d => d.category || d.sellerType || 'Store',
    location: d => d.address || d.location || d.city || '',
    price: () => null,
    thumb: d => d.logo || d.logoUrl || d.banner || d.bannerUrl || null,
    link: (d, id) => 'store.html?id=' + encodeURIComponent(id),
  },
  {
    col: 'services', tab: 'services', icon: '🔧', scan: 200,
    guard: w => [w('status', 'in', ['active', 'published'])],
    fields: ['name', 'title', 'category', 'description', 'tags', 'location', 'city', 'providerName'],
    title: d => d.name || d.title || '',
    subtitle: d => d.category || d.providerName || 'Service',
    location: d => d.location || d.city || '',
    price: d => kes(d.price),
    thumb: d => d.image || d.thumbnail || null,
    link: (d, id) => 'services.html?id=' + encodeURIComponent(id),
  },
  {
    col: 'digitalJobs', tab: 'jobs', icon: '💼', scan: 200,
    guard: w => [w('status', 'in', ['active', 'published'])],
    fields: ['title', 'name', 'category', 'description', 'skills', 'location', 'company', 'posterName'],
    title: d => d.title || d.name || '',
    subtitle: d => d.category || d.company || d.posterName || 'Job',
    location: d => d.location || (d.remote ? 'Remote' : ''),
    price: d => kes(d.budget != null ? d.budget : d.salary),
    thumb: () => null,
    link: (d, id) => 'opportunity.html?id=' + encodeURIComponent(id),
  },
  {
    col: 'properties', tab: 'properties', icon: '🏠', scan: 200,
    guard: w => [w('status', 'in', ['active', 'published'])],
    fields: ['title', 'name', 'type', 'description', 'location', 'city', 'county', 'agentName'],
    title: d => d.title || d.name || '',
    subtitle: d => [d.type, d.bedrooms ? d.bedrooms + ' bed' : null].filter(Boolean).join(' · ') || 'Property',
    location: d => d.location || d.city || '',
    price: d => kes(d.price),
    thumb: d => d.image || (Array.isArray(d.images) ? d.images[0] : null) || null,
    link: (d, id) => 'property.html?id=' + encodeURIComponent(id),
  },
  {
    col: 'propertyListings', tab: 'properties', icon: '🏡', scan: 200,
    guard: w => [w('status', '==', 'active')],
    fields: ['title', 'name', 'type', 'description', 'location', 'city', 'county'],
    title: d => d.title || d.name || '',
    subtitle: d => [d.type, d.bedrooms ? d.bedrooms + ' bed' : null, d.bathrooms ? d.bathrooms + ' bath' : null].filter(Boolean).join(' · ') || 'Property',
    location: d => d.location || d.city || '',
    price: d => kes(d.price, d.period ? '/' + d.period : ''),
    thumb: d => d.image || (Array.isArray(d.images) ? d.images[0] : null) || null,
    link: (d, id) => 'property.html?id=' + encodeURIComponent(id),
  },
  {
    col: 'bnbListings', tab: 'properties', icon: '🛏️', scan: 200,
    fields: ['name', 'title', 'type', 'description', 'location', 'city', 'amenities'],
    title: d => d.name || d.title || '',
    subtitle: d => [d.type || 'BnB', d.guests ? d.guests + ' guests' : null].filter(Boolean).join(' · '),
    location: d => d.location || d.city || '',
    price: d => kes(d.pricePerNight != null ? d.pricePerNight : d.price, '/night'),
    thumb: d => d.image || (Array.isArray(d.images) ? d.images[0] : null) || null,
    link: (d, id) => 'bnb.html?id=' + encodeURIComponent(id),
  },
  {
    col: 'vehicles', tab: 'vehicles', icon: '🚗', scan: 200,
    guard: w => [w('status', 'in', ['active', 'published'])],
    fields: ['name', 'title', 'make', 'model', 'bodyType', 'fuelType', 'description', 'location', 'condition'],
    title: d => d.name || d.title || [d.make, d.model].filter(Boolean).join(' ') || '',
    subtitle: d => [d.make, d.model, d.year].filter(Boolean).join(' · ') || 'Vehicle',
    location: d => d.location || d.city || '',
    price: d => kes(d.price),
    thumb: d => d.image || (Array.isArray(d.images) ? d.images[0] : null) || null,
    link: (d, id) => 'car-hub.html?tab=browse&id=' + encodeURIComponent(id),
  },
  {
    col: 'entEvents', tab: 'events', icon: '🎉', scan: 200,
    fields: ['title', 'name', 'category', 'type', 'description', 'venue', 'location', 'city', 'organizer'],
    title: d => d.title || d.name || '',
    subtitle: d => [d.category || d.type, d.venue].filter(Boolean).join(' · ') || 'Event',
    location: d => d.location || d.venue || d.city || '',
    price: d => (d.ticketPrice != null ? kes(d.ticketPrice) : (d.free || d.isFree ? 'Free' : null)),
    thumb: d => d.image || d.poster || null,
    link: (d, id) => 'entertainment.html?event=' + encodeURIComponent(id),
  },
  {
    col: 'entVenues', tab: 'businesses', icon: '🎭', scan: 150,
    fields: ['name', 'type', 'category', 'description', 'location', 'city'],
    title: d => d.name || '',
    subtitle: d => d.type || d.category || 'Venue',
    location: d => d.location || d.city || '',
    price: d => (d.capacity ? 'Capacity: ' + d.capacity : null),
    thumb: d => d.image || null,
    link: (d, id) => 'entertainment.html?venue=' + encodeURIComponent(id),
  },
  {
    col: 'mechanics', tab: 'businesses', icon: '🔧', scan: 150,
    fields: ['name', 'type', 'spec', 'services', 'description', 'location', 'city'],
    title: d => d.name || '',
    subtitle: d => d.type || d.spec || 'Auto Service',
    location: d => d.location || d.city || '',
    price: () => null,
    thumb: d => d.image || null,
    link: () => 'car-hub.html?tab=mechanics',
  },
  {
    col: 'providers', tab: 'professionals', icon: '👷', indexed: true, scan: 200,
    guard: w => [w('status', 'in', ['active', 'approved'])],
    fields: ['name', 'businessName', 'category', 'skills', 'description', 'bio', 'location', 'city'],
    title: d => d.name || d.businessName || '',
    subtitle: d => d.category || 'Professional',
    location: d => d.location || d.city || '',
    price: d => kes(d.rate),
    thumb: d => d.photo || d.image || null,
    /* provider.html is the provider's OWN dashboard and reads only ?tab= and
       ?cat= — it never read the id this link passed it, so every provider
       result opened the setup wizard instead of the provider. The public
       profile is provider-profile.html, which reads ?uid=. */
    link: (d, id) => 'provider-profile.html?uid=' + encodeURIComponent(d.uid || id),
  },
  {
    col: 'healthProviders', tab: 'professionals', icon: '🏥', scan: 150,
    guard: w => [w('status', '==', 'active')],
    fields: ['name', 'title', 'specialty', 'category', 'description', 'location', 'city'],
    title: d => d.name || d.title || '',
    subtitle: d => d.specialty || d.category || 'Healthcare',
    location: d => d.location || d.city || '',
    price: d => kes(d.consultationFee),
    thumb: d => d.photo || d.image || null,
    link: (d, id) => 'healthcare.html?provider=' + encodeURIComponent(id),
  },
  {
    col: 'lawyers', tab: 'professionals', icon: '⚖️', scan: 150,
    fields: ['name', 'specialty', 'practice', 'firm', 'description', 'location', 'city'],
    title: d => d.name || '',
    subtitle: d => d.specialty || d.practice || 'Legal Professional',
    location: d => d.location || d.city || '',
    price: d => kes(d.hourlyRate, '/hr'),
    thumb: d => d.photo || d.image || null,
    link: (d, id) => 'legal-hub.html?lawyer=' + encodeURIComponent(id),
  },
];

/* ── Session scan cache — one bounded read per collection, reused ─────────── */
const SCAN_TTL_MS = 10 * 60 * 1000;
const _scanCache = new Map(); /* col → { at, docs } */

/* ── Persistent catalogue cache ───────────────────────────────────────────────
   The session cache alone still makes the FIRST search of every page load pay
   for a full round of collection reads — measured at ~1.7s cold, on top of a
   page load. Persisting the scan means a returning visitor searches against
   data already in memory: results render before the network is consulted, and
   a background revalidation keeps the copy honest (stale-while-revalidate).

   Only the fields the matcher and the result card actually use are stored, so
   the payload stays small enough for localStorage and no image blobs or
   internal arrays are ever written. */
/* v2: KEEP gained the variant attributes. A v1 payload was slimmed without
   them, so serving it would make variant queries silently miss until the entry
   aged out. The version bump discards those entries on first read instead. */
const LS_KEY  = 'sokoni_fs_catalogue_v2';
const LS_TTL  = 30 * 60 * 1000;   /* serve from disk for half an hour … */
const LS_SOFT = 3 * 60 * 1000;    /* … but revalidate in the background after 3 */
const LS_MAX_DESC = 240;

const KEEP = ['name', 'title', 'category', 'subcategory', 'brand', 'tags', 'location',
  'county', 'city', 'price', 'pricePerNight', 'ticketPrice', 'budget', 'salary', 'rate',
  'consultationFee', 'hourlyRate', 'capacity', 'period', 'image', 'thumbnail', 'images',
  'logo', 'logoUrl', 'banner', 'bannerUrl', 'photo', 'poster', 'sellerName', 'storeName',
  'businessName', 'shopName', 'providerName', 'specialty', 'practice', 'type', 'spec',
  'make', 'model', 'year', 'bedrooms', 'bathrooms', 'guests', 'venue', 'organizer',
  'status', 'isVisible', 'suspended', 'verified', 'isVerified', 'isFeatured', 'sellerType',
  'tagline', 'bio', 'about', 'address', 'handle', 'skills', 'company', 'posterName', 'remote',
  'free', 'isFree', 'services', 'amenities', 'condition', 'fuelType', 'bodyType', 'firm',
  /* Variant attributes: needed both to match a variant query offline and to
     render the card summary from the cached copy. Short string arrays — a
     handful of bytes each, so the localStorage payload stays small. */
  'colors', 'sizes', 'storage', 'weights', 'volumes', 'materials'];

function slim(d) {
  const out = { _id: d._id };
  for (const k of KEEP) if (d[k] !== undefined) out[k] = d[k];
  if (typeof d.description === 'string') out.description = d.description.slice(0, LS_MAX_DESC);
  if (Array.isArray(d.images)) out.images = d.images.slice(0, 1);
  return out;
}

function lsRead() {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || Date.now() - parsed.at > LS_TTL) return null;
    return parsed;
  } catch (_) { return null; }
}

function lsWrite(col, docs) {
  try {
    if (typeof localStorage === 'undefined') return;
    const cur = lsRead() || { at: Date.now(), cols: {} };
    cur.cols[col] = docs.map(slim);
    cur.at = Date.now();
    localStorage.setItem(LS_KEY, JSON.stringify(cur));
  } catch (_) {
    /* Quota or private-mode failure is not worth surfacing — the session cache
       still applies, and the next load simply pays the read cost again. */
  }
}

let _sdkPromise = null;
/**
 * The Firestore SDK is resolved lazily and can be supplied by the caller
 * (opts.sdk). That seam is what lets scripts/test-firestore-search.js exercise
 * the matching rules against a stub without a network or a live project.
 */
function loadSdk(injected) {
  if (injected) return Promise.resolve(injected);
  if (!_sdkPromise) _sdkPromise = import(FIREBASE_SDK);
  return _sdkPromise;
}

/* ── Query expansion: Kenyan bilingual search ─────────────────────────────────
   A buyer types "simu", "viatu", "mtumba", "gari" as readily as the English
   word, and the catalogue is written in a mix of both. Expanding the query is
   cheaper and far more predictable than translating the catalogue: each token
   is matched against itself OR any of its known equivalents. Bidirectional, so
   an English query finds a Swahili listing and vice versa. */
const SYNONYMS = {
  simu: ['phone', 'smartphone', 'mobile'], phone: ['simu'],
  kompyuta: ['laptop', 'computer'], tarakilishi: ['laptop', 'computer'],
  laptop: ['kompyuta'], computer: ['kompyuta'],
  nguo: ['clothes', 'clothing', 'fashion', 'wear'], clothes: ['nguo'], clothing: ['nguo'],
  viatu: ['shoes', 'sneakers', 'footwear'], shoes: ['viatu'], sneakers: ['viatu'],
  mtumba: ['secondhand', 'second-hand', 'used', 'thrift'], secondhand: ['mtumba'], used: ['mtumba'],
  dawa: ['medicine', 'drug', 'pharmacy'], medicine: ['dawa'], pharmacy: ['dawa'],
  gari: ['car', 'vehicle'], car: ['gari'], vehicle: ['gari'],
  pikipiki: ['motorbike', 'motorcycle', 'boda'], boda: ['motorbike', 'motorcycle', 'pikipiki'],
  motorbike: ['pikipiki', 'boda'], motorcycle: ['pikipiki', 'boda'],
  nyumba: ['house', 'home', 'apartment'], house: ['nyumba'], apartment: ['nyumba'],
  kazi: ['job', 'work', 'vacancy'], job: ['kazi'], vacancy: ['kazi'],
  chakula: ['food', 'meal'], food: ['chakula'],
  fundi: ['technician', 'repair', 'artisan', 'mechanic'], mechanic: ['fundi'],
  daktari: ['doctor', 'clinic'], doctor: ['daktari'],
  wakili: ['lawyer', 'advocate'], lawyer: ['wakili'], advocate: ['wakili'],
  duka: ['shop', 'store'], shop: ['duka'], store: ['duka'],
  bei: ['price'], rahisi: ['cheap', 'affordable'],
};

function expand(token) {
  const alts = SYNONYMS[token];
  return alts ? [token, ...alts] : [token];
}

/* ── Typo tolerance ───────────────────────────────────────────────────────────
   Bounded to a single edit and to tokens of four characters or more. That is
   deliberate: at three characters an edit distance of one turns "pod" into
   "pot", "pop" and "cod", which is noise, not tolerance. Bailing out as soon as
   two edits are seen keeps this linear in practice. */
function within1Edit(a, b) {
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (la > lb) i++;
    else if (lb > la) j++;
    else { i++; j++; }
  }
  return edits + (la - i) + (lb - j) <= 1;
}

/* ── Haystack + scoring ───────────────────────────────────────────────────── */
function haystack(spec, d) {
  const parts = [];
  for (const f of spec.fields) {
    const v = d[f];
    if (!v) continue;
    parts.push(Array.isArray(v) ? v.join(' ') : String(v));
  }
  /* searchableTerms already holds the trigger-generated word list; including it
     lets a match survive a field rename without a reindex. */
  if (Array.isArray(d.searchableTerms)) parts.push(d.searchableTerms.join(' '));
  return parts.join(' ').toLowerCase();
}

/* Word list for fuzzy comparison, computed once per document and memoised on
   the cached object. Recomputing it per keystroke is what would make typo
   tolerance expensive; doing it once per document makes it free. */
function words(entry) {
  if (!entry._words) {
    entry._words = entry.hay.split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 1);
  }
  return entry._words;
}

/**
 * Does this document satisfy one query token?
 * Exact substring first (the common case, and the cheapest), then synonyms,
 * then a single-edit fuzzy pass. Returns 2 for an exact hit and 1 for a
 * fuzzy-only hit so ranking can prefer the former.
 */
function tokenHit(entry, token) {
  const variants = expand(token);
  for (const v of variants) if (entry.hay.indexOf(v) !== -1) return 2;
  if (token.length < 4) return 0;
  for (const w of words(entry)) {
    for (const v of variants) {
      if (v.length >= 4 && within1Edit(w, v)) return 1;
    }
  }
  return 0;
}

/**
 * AND semantics: every token must be satisfied. "cool mint" must not return
 * every product containing "mint" — a two-word query is a narrowing, not a
 * widening. Returns 0 when any token misses, else the summed strength so a
 * result matched exactly outranks one matched through a typo.
 */
function matches(entry, tokens) {
  let strength = 0;
  for (const t of tokens) {
    const h = tokenHit(entry, t);
    if (!h) return 0;
    strength += h;
  }
  return strength;
}

function score(titleLower, entry, tokens, full, strength) {
  let s = strength * 6;
  if (titleLower === full) s += 120;
  else if (titleLower.startsWith(full)) s += 90;
  else if (titleLower.indexOf(full) !== -1) s += 70;
  for (const t of tokens) {
    if (titleLower.indexOf(t) !== -1) s += 12;
    else if (entry.hay.indexOf(' ' + t) !== -1) s += 4;
  }
  /* Nudge listings that look alive above dormant ones on equal text relevance. */
  if (entry.doc.image || entry.doc.thumbnail) s += 3;
  if (entry.doc.isFeatured) s += 5;
  return s;
}

/* ── Firestore readers ────────────────────────────────────────────────────── */
async function runQuery(db, sdk, spec, constraints) {
  const { collection, query, getDocs } = sdk;
  const snap = await getDocs(query(collection(db, spec.col), ...constraints));
  const rows = [];
  snap.forEach(s => rows.push({ _id: s.id, ...s.data() }));
  return rows;
}

/**
 * Bounded collection scan, cached per session. Carries the rule-required guard
 * constraints so the read is permitted; without them Firestore denies the whole
 * list query and the collection silently disappears from results.
 */
async function fetchCollection(db, sdk, spec) {
  const { where, limit } = sdk;
  const constraints = (spec.guard ? spec.guard(where) : []).concat([limit(spec.scan || 200)]);
  try {
    const docs = await runQuery(db, sdk, spec, constraints);
    /* A successful empty result IS cacheable — the collection really is empty. */
    _scanCache.set(spec.col, { at: Date.now(), docs });
    lsWrite(spec.col, docs);
    return docs;
  } catch (err) {
    /* A FAILED read must never be cached. Caching it once cost every query for
       the rest of the session: warm() starts the moment the module loads, which
       can be before App Check has minted a token, so those first reads are
       denied — and caching that denial as "this collection is empty" made the
       whole catalogue vanish until the cache expired. Leave the slot untouched
       so the next call retries. */
    console.warn('[FirestoreSearch] scan ' + spec.col + ':', err && err.message);
    return null;
  }
}

/**
 * Three tiers, cheapest first: session memory → persisted copy (returned
 * immediately, refreshed in the background once it is a few minutes old) →
 * network. Only the last one costs the user any waiting.
 */
async function scanCollection(db, sdk, spec) {
  const cached = _scanCache.get(spec.col);
  if (cached && Date.now() - cached.at < SCAN_TTL_MS) return cached.docs;

  const disk = lsRead();
  const rows = disk && disk.cols && disk.cols[spec.col];
  if (rows) {
    _scanCache.set(spec.col, { at: Date.now(), docs: rows });
    if (Date.now() - disk.at > LS_SOFT) {
      /* Stale-while-revalidate: the user searches against what we already have
         while the fresh copy lands for the next query. */
      fetchCollection(db, sdk, spec).catch(() => {});
    }
    return rows;
  }

  /* One inline retry. The first read of a page load can land before App Check
     has minted a token and be denied; without this the search that triggered it
     would resolve to nothing and never re-run, so the buyer sees "no results"
     for a catalogue that arrives 200ms later. */
  const fetched = await fetchCollection(db, sdk, spec);
  if (fetched) return fetched;
  await new Promise(r => setTimeout(r, 700));
  return (await fetchCollection(db, sdk, spec)) || [];
}

/**
 * Preload the catalogue so the first search of a session has nothing to wait
 * for. Fire-and-forget from page load — it resolves into the same caches the
 * search path reads, and every collection is fetched in parallel, so the whole
 * warm-up costs about one round trip.
 *
 * Retries once on failure. Warming starts as early as the module loads, which
 * may be before App Check has a token; the first attempt then fails for every
 * collection, and without a retry the page would sit on nothing until a query
 * forced a fetch.
 */
export async function warm(db, opts = {}) {
  if (!db) return;
  const sdk   = await loadSdk(opts.sdk);
  const work  = SPECS.filter(s => !opts.tab || s.tab === opts.tab);
  const tries = opts.retries === undefined ? 2 : opts.retries;

  let pending = work;
  for (let attempt = 0; attempt < tries && pending.length; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 1500));
    const outcomes = await Promise.all(pending.map(async spec => {
      if (_scanCache.has(spec.col)) return null;               // already warm
      const docs = await fetchCollection(db, sdk, spec).catch(() => null);
      return docs === null ? spec : null;                      // null ⇒ failed, retry
    }));
    pending = outcomes.filter(Boolean);
  }
}

/**
 * Indexed lookup for collections carrying searchableTerms/nameLower.
 * array-contains and the nameLower range both run on automatic single-field
 * indexes — no composite index is required, so this cannot fail on a cold
 * project. Returns [] when the collection was never indexed.
 *
 * Only valid for collections with no rule guard: pairing array-contains with a
 * status filter would need a composite index, and omitting the status filter on
 * a gated collection gets the query denied. Callers enforce that.
 */
async function indexedLookup(db, sdk, spec, tokens, full) {
  const { where, limit } = sdk;
  const out = new Map();

  /* Longest token first — the most selective term in the query. */
  const ordered = [...tokens].sort((a, b) => b.length - a.length).slice(0, 2);
  for (const tok of ordered) {
    try {
      const rows = await runQuery(db, sdk, spec,
        [where('searchableTerms', 'array-contains', tok), limit(100)]);
      rows.forEach(r => out.set(r._id, r));
    } catch (err) {
      console.warn('[FirestoreSearch] terms ' + spec.col + ':', err && err.message);
      break;
    }
  }

  if (full) {
    try {
      const rows = await runQuery(db, sdk, spec, [
        where('nameLower', '>=', full),
        where('nameLower', '<', full + ''),
        limit(50),
      ]);
      rows.forEach(r => out.set(r._id, r));
    } catch (_) { /* nameLower absent on legacy docs — scan covers them */ }
  }

  return [...out.values()];
}

/* ── Public API ───────────────────────────────────────────────────────────── */
function toRow(spec, entry, tokens, full, matchedCount, strength) {
  const d = entry.doc;
  const title = spec.title(d);
  if (!title) return null;
  return {
    id:        d._id,
    tab:       spec.tab,
    icon:      spec.icon,
    title,
    subtitle:  spec.subtitle(d) || '',
    location:  spec.location(d) || '',
    price:     spec.price ? spec.price(d) : null,
    link:      spec.link(d, d._id),
    thumbnail: spec.thumb ? spec.thumb(d) : null,
    verified:  Boolean(d.verified || d.isVerified),
    _source:   'firestore',
    _matched:  matchedCount,
    _score:    score(String(title).toLowerCase(), entry, tokens, full, strength),
  };
}

/**
 * @param {object} db      Firestore instance (modular SDK)
 * @param {string} rawQuery
 * @param {object} [opts]
 *        tab   {string} restrict to one search tab ('products', 'businesses', …)
 *        limit {number} max rows returned (default 60)
 *        sdk   {object} pre-resolved Firestore SDK — test seam, see loadSdk()
 * @returns {Promise<Array>} normalised rows: { id, tab, icon, title, subtitle,
 *          location, price, link, thumbnail, verified, _source }
 */
export async function firestoreSearch(db, rawQuery, opts = {}) {
  const full   = String(rawQuery || '').toLowerCase().trim();
  const tokens = tokenize(full);
  if (!db || !tokens.length) return [];

  const cap  = opts.limit || 60;
  const tab  = opts.tab && opts.tab !== 'all' ? opts.tab : null;
  const sdk  = await loadSdk(opts.sdk);
  const work = SPECS.filter(s => !tab || s.tab === tab);

  /* Fetch once, match twice — the relaxed pass below must not cost extra reads. */
  const candidates = await Promise.all(work.map(async spec => {
    const seen = new Map();

    /* Cached scan first. Products written before the indexProductCreate trigger
       existed carry no searchableTerms, and no non-product collection is indexed
       at all, so the scan is what makes those findable — and once it is cached
       the whole match runs locally. */
    const scanned = await scanCollection(db, sdk, spec);
    scanned.forEach(r => { if (!seen.has(r._id)) seen.set(r._id, r); });

    /* The indexed path costs up to three network round trips PER KEYSTROKE, so
       it only earns its place when the scan could not have seen the whole
       collection — i.e. when the scan came back full and there may be matching
       documents beyond its window. Below the cap the cached scan is the entire
       collection and the indexed lookup could not add a row to it. Measured:
       this is the difference between a ~750ms query and a local one.

       It also only applies to collections whose rules allow an unguarded list
       query: pairing array-contains with the rule-required status filter would
       demand a composite index this project does not carry. */
    const scanTruncated = scanned.length >= (spec.scan || 200);
    if (spec.indexed && !spec.guard && scanTruncated) {
      try {
        (await indexedLookup(db, sdk, spec, tokens, full)).forEach(r => {
          if (!seen.has(r._id)) seen.set(r._id, r);
        });
      } catch (err) {
        console.warn('[FirestoreSearch] indexed ' + spec.col + ':', err && err.message);
      }
    }

    const docs = [];
    for (const d of seen.values()) {
      if (!isVisibleDoc(d)) continue;
      /* The haystack and word list are memoised on the cached document, so a
         second keystroke re-matches without rebuilding either. */
      if (!d.__entry) {
        Object.defineProperty(d, '__entry', {
          value: { doc: d, hay: haystack(spec, d) }, enumerable: false, writable: true,
        });
      }
      docs.push(d.__entry);
    }
    return { spec, docs };
  }));

  /* Pass 1 — every token must be satisfied. "cool mint" is a narrowing of
     "mint". Tokens may be satisfied exactly, by a known synonym, or by a
     single-character typo; strength records which, so exact beats fuzzy. */
  const strict = [];
  for (const { spec, docs } of candidates) {
    for (const entry of docs) {
      const strength = matches(entry, tokens);
      if (!strength) continue;
      const row = toRow(spec, entry, tokens, full, tokens.length, strength);
      if (row) strict.push(row);
    }
  }
  if (strict.length) {
    return strict.sort((a, b) => b._score - a._score).slice(0, cap);
  }

  /* Pass 2 — nothing matched every token. Rather than answer "no results" for
     "kass shop" when the store is called "Kass Vapes", keep the rows that match
     at least one meaningful token and rank by how many they matched. Only runs
     when the strict pass is empty, so it can never dilute a good match. */
  const relaxed = [];
  const useful  = tokens.filter(t => t.length >= 3);
  const pool    = useful.length ? useful : tokens;
  for (const { spec, docs } of candidates) {
    for (const entry of docs) {
      let hits = 0, strength = 0;
      for (const t of pool) {
        const h = tokenHit(entry, t);
        if (h) { hits++; strength += h; }
      }
      if (!hits) continue;
      const row = toRow(spec, entry, pool, full, hits, strength);
      if (row) relaxed.push(row);
    }
  }

  return relaxed
    .sort((a, b) => (b._matched - a._matched) || (b._score - a._score))
    .slice(0, cap);
}

/**
 * Autocomplete suggestions, served from whatever is already cached.
 * Deliberately does NOT hit the network: a suggestion that arrives after the
 * user has finished typing is worse than none, so this returns instantly or
 * returns nothing and lets the caller fall back.
 */
export function suggest(prefix, limitN = 6) {
  const p = String(prefix || '').toLowerCase().trim();
  if (p.length < 2) return [];
  const disk = lsRead();
  const seen = new Set();
  const out  = [];

  const consider = (rows, spec) => {
    for (const d of rows || []) {
      if (!isVisibleDoc(d)) continue;
      const title = spec.title(d);
      if (!title) continue;
      const t = String(title).toLowerCase();
      if (t.indexOf(p) === -1 || seen.has(t)) continue;
      seen.add(t);
      out.push({
        id: d._id, title, tab: spec.tab,
        subtitle: spec.subtitle(d) || '', link: spec.link(d, d._id),
        price: spec.price ? spec.price(d) : null,
        thumbnail: spec.thumb ? spec.thumb(d) : null,
        _lead: t.startsWith(p) ? 1 : 0,
      });
      if (out.length >= limitN * 3) break;
    }
  };

  for (const spec of SPECS) {
    const mem = _scanCache.get(spec.col);
    consider(mem ? mem.docs : (disk && disk.cols && disk.cols[spec.col]), spec);
  }

  return out.sort((a, b) => b._lead - a._lead).slice(0, limitN);
}

/** Drop the cached collection scans — call after a write that must be findable. */
export function invalidateScanCache(col) {
  if (col) _scanCache.delete(col);
  else _scanCache.clear();
  try {
    if (typeof localStorage === 'undefined') return;
    if (!col) { localStorage.removeItem(LS_KEY); return; }
    const cur = lsRead();
    if (cur && cur.cols) { delete cur.cols[col]; localStorage.setItem(LS_KEY, JSON.stringify(cur)); }
  } catch (_) {}
}

/* Classic-script consumers (sokoni-search-engine.js, shared-header.js). */
if (typeof window !== 'undefined') {
  window.SokoniFirestoreSearch = {
    search: (q, opts) => firestoreSearch(window.firebaseDB, q, opts),
    searchWith: firestoreSearch,
    warm: (opts) => warm(window.firebaseDB, opts),
    suggest,
    invalidateScanCache,
    tokenize,
  };
}
