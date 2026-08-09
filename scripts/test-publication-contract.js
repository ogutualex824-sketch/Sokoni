/* ============================================================================
   PUBLICATION CONTRACT v1.0 — parameterized acceptance suite.
   docs/PUBLICATION_CONTRACT.md is the spec; THIS is its executable gate.

   publicationContract(entityType) asserts the shared, entity-agnostic lifecycle
   logic every publishable entity must satisfy:
     • Create/Index      — a created doc yields searchableTerms incl. its name.
     • Discoverability    — a name/category token matches the indexed terms.
     • Edit / rename      — new terms appear AND stale-only terms disappear.
     • Lifecycle          — archive / hide / suspend removes it from search.
   Runs on the SHARED sources of truth — functions/search-terms.js buildSearchTerms
   (what the index* triggers write) and the sokoni-firestore-search.js visibility
   contract (what search filters on) — so a regression in either fails the gate.

   Security (owner-only writes, admin fields protected) is certified per collection
   by the rules-unit tests (see scripts/… businesses 5/5); this suite covers the
   indexing/visibility clauses that are common to every entity. Pure — no emulator,
   so it runs in CI + predeploy cheaply. A new content type is added by dropping one
   ENTITIES entry, not by writing a new test.
   ============================================================================ */
'use strict';
const { buildSearchTerms } = require('../functions/search-terms');

/* Mirrors sokoni-firestore-search.js::isVisibleDoc (the search visibility contract).
   Kept in lockstep — if that file's rule changes, update here and the suite proves
   archive/hide still removes the entity from search. */
const HIDDEN_STATUS = { archived: 1, deleted: 1, hidden: 1, removed: 1, banned: 1 };
function isVisibleDoc(d) {
  if (!d) return false;
  if (d.isVisible === false) return false;
  if (d.suspended === true) return false;
  if (d.status && HIDDEN_STATUS[String(d.status).toLowerCase()]) return false;
  return true;
}
/* Search match = every query token is present in the doc's indexed terms (the
   indexed-fallback path sokoni-firestore-search.js uses via searchableTerms). */
function searchMatches(doc, query) {
  const terms = buildSearchTerms(doc);
  return String(query).toLowerCase().split(/\s+/).filter(Boolean).every(t => terms.includes(t));
}

/* One entry per publishable entity. `newToken` must appear after the rename;
   `staleToken` must be present before and GONE after (proves stale-term removal). */
const ENTITIES = {
  products: {
    sample: { name: 'Blue Cotton Shirt', category: 'Fashion Apparel', price: 500 },
    rename: { name: 'Red Silk Dress', category: 'Formal Wear' },
    staleToken: 'cotton', newToken: 'silk',
  },
  providers: {
    sample: { name: 'Jane Plumbing', businessName: 'Jane Plumbing', category: 'Plumbing', skills: ['Pipe Fitting'] },
    /* A compliant rename updates EVERY name-carrying field (name + businessName)
       — the term generator reads both, so updating only one leaves stale terms. */
    rename: { name: 'Jane Electrical', businessName: 'Jane Electrical', category: 'Electrical', skills: ['Wiring'] },
    staleToken: 'plumbing', newToken: 'electrical',
  },
  businesses: {
    sample: { name: 'Kass Vapes', businessName: 'Kass Vapes', category: 'Vape Shop', city: 'Nairobi' },
    rename: { name: 'Kass Wellness', businessName: 'Kass Wellness', category: 'Health Store' },
    staleToken: 'vape', newToken: 'wellness',
  },
};

function publicationContract(entityType, ok) {
  const cfg = ENTITIES[entityType];
  const tag = `[${entityType}]`;

  /* 1. Create → Index */
  const created = cfg.sample;
  const terms = buildSearchTerms(created);
  const nameTok = created.name.toLowerCase().split(/\s+/)[0];
  ok(Array.isArray(terms) && terms.length > 0, `${tag} create → searchableTerms generated`);
  ok(terms.includes(nameTok), `${tag} create → name token "${nameTok}" indexed`);

  /* 2. Discoverability */
  ok(searchMatches(created, nameTok), `${tag} search by name token matches`);
  ok(searchMatches(created, cfg.staleToken), `${tag} search by "${cfg.staleToken}" matches before rename`);

  /* 3. Edit / rename — new in, stale out */
  const renamed = Object.assign({}, created, cfg.rename);
  const newTerms = buildSearchTerms(renamed);
  ok(newTerms.includes(cfg.newToken), `${tag} rename → new token "${cfg.newToken}" indexed`);
  ok(!newTerms.includes(cfg.staleToken), `${tag} rename → STALE token "${cfg.staleToken}" removed`);
  ok(!searchMatches(renamed, cfg.staleToken), `${tag} search by "${cfg.staleToken}" no longer matches after rename`);

  /* 4. Lifecycle — archive / hide / suspend removes from search */
  ok(isVisibleDoc(created) === true, `${tag} active doc is visible`);
  ok(isVisibleDoc(Object.assign({}, created, { status: 'archived' })) === false, `${tag} archive → removed from search`);
  ok(isVisibleDoc(Object.assign({}, created, { status: 'hidden' })) === false, `${tag} hide → removed from search`);
  ok(isVisibleDoc(Object.assign({}, created, { isVisible: false })) === false, `${tag} isVisible:false → removed`);
  ok(isVisibleDoc(Object.assign({}, created, { suspended: true })) === false, `${tag} suspended → removed`);
}

/* ── Runner ─────────────────────────────────────────────────────────────────── */
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  -', m); } else { fail++; console.error('  FAIL-', m); } };

console.log('=== Publication Contract v1.0 — acceptance suite ===');
for (const entity of Object.keys(ENTITIES)) {
  console.log('\n' + entity.toUpperCase());
  publicationContract(entity, ok);
}
console.log('\n=== ' + (fail === 0 ? 'ALL ' + pass + ' PASSED — products, providers, businesses CERTIFIED under Publication Contract v1.0' : pass + ' passed, ' + fail + ' FAILED') + ' ===');
process.exit(fail === 0 ? 0 : 1);
