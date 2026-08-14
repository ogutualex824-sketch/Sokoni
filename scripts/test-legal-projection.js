#!/usr/bin/env node
/* Legal single lifecycle: approval → legalProviders authority + lawyers search  (Roles Phase 2)
 *
 *   node scripts/test-legal-projection.js
 *
 * WHY THIS EXISTS
 * `legal` used to sit in DELEGATED_ROLES, which meant approval wrote NOTHING:
 * the applicant got an account role, no profile, and no search presence. The
 * evidence that settled the design is in production — scripts/onboard-batch2.js
 * writes legalProviders AND lawyers for the same uid in one pass, commented
 * "legalProviders (shown on legal-hub) and lawyers (global search)". So the two
 * collections are not rival registries; they are authority and projection, and
 * approval simply never maintained them.
 *
 * This suite pins that contract by CALLING projectLegal against a fake
 * Firestore — not by matching source text, which cannot show that a re-approval
 * converges or that a legacy document survives.
 *
 *   1. approval writes both documents, keyed by the same uid;
 *   2. the projection is idempotent — re-approval never forks a second entity;
 *   3. a legacy/self-registered lawyers document is preserved, not replaced;
 *   4. registry-owned values (licence, specialisations, rating, history) are
 *      never blanked by an application that does not carry them;
 *   5. `rating` is seeded, because getLegalProviders orders by it and Firestore
 *      drops documents that lack the ordered field;
 *   6. revocation retracts both — and removes the firm from search;
 *   7. legalProviders is NEVER registered with Algolia or Typesense.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const LC = require(path.join(ROOT, 'functions', 'application-lifecycle.js'))._internal;
const { projectLegal } = LC;

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + d + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log('\n── ' + t + ' ──');

/* ── Fake Firestore ───────────────────────────────────────────────────────────
   Shallow-merges exactly like set({merge:true}) so "was this field preserved?"
   is answered by the store, not by an assumption about the store. */
function fakeDb(seed) {
  const store = JSON.parse(JSON.stringify(seed || {}));
  const writes = [];
  return {
    _store: store,
    _writes: writes,
    collection: (col) => ({
      doc: (id) => ({
        get: async () => {
          const d = store[col] && store[col][id];
          return { exists: !!d, data: () => (d ? JSON.parse(JSON.stringify(d)) : undefined) };
        },
        set: async (patch, opts) => {
          store[col] = store[col] || {};
          const plain = JSON.parse(JSON.stringify(patch, (k, v) =>
            (v && typeof v === 'object' && v._methodName) ? '<serverTimestamp>' : v));
          store[col][id] = (opts && opts.merge && store[col][id])
            ? Object.assign({}, store[col][id], plain)
            : plain;
          writes.push({ col, id, merge: !!(opts && opts.merge), keys: Object.keys(plain) });
        },
      }),
    }),
  };
}

const UID = 'ZrG4N8SETmS7NMEg0src1NYjBw23';
const APP = {
  applicationId: 'APP-LEGAL-1',
  name: 'T.M.M & Partners Advocates',
  firmName: 'T.M.M & Partners Advocates',
  description: 'Conveyancing and commercial litigation in Nairobi.',
  location: 'Nairobi', county: 'Nairobi', city: 'Nairobi',
  phoneNumber: '+254700000000', email: 'info@tmmadvocates.ke',
  specialization: 'conveyancing',
};

(async () => {

  /* ══ 1 · a fresh approval writes BOTH documents ══ */
  head('1 · approval writes the authority AND the search projection');
  const db1 = fakeDb();
  const r1 = await projectLegal(db1, APP, UID, true);
  const lp = db1._store.legalProviders && db1._store.legalProviders[UID];
  const lw = db1._store.lawyers && db1._store.lawyers[UID];

  ck('legalProviders/{uid} was written', !!lp);
  ck('lawyers/{uid} was written', !!lw);
  ck('both are keyed by the SAME uid', !!lp && !!lw && lp.uid === UID && lw.uid === UID);
  ck('the receipt reports both writes', Array.isArray(r1) && r1.length === 2,
     JSON.stringify((r1 || []).map((w) => w.collection + ':' + w.action)));
  ck('both report action=created', (r1 || []).every((w) => w.action === 'created'));

  /* ══ 2 · the authority carries what the legal hub reads ══ */
  head('2 · legalProviders is a usable authority record');
  ck('status is active', lp.status === 'active', lp.status);
  ck('approved:true is stamped', lp.approved === true);
  ck('providerId defaults to the uid', lp.providerId === UID);
  ck('specializations is an array', Array.isArray(lp.specializations), JSON.stringify(lp.specializations));
  ck('a declared specialisation from the registry vocabulary is honoured',
     lp.specializations.indexOf('conveyancing') > -1, JSON.stringify(lp.specializations));
  /* THE ORDERBY TRAP — getLegalProviders runs .orderBy('rating','desc'); a
     document without `rating` is omitted from the query entirely. */
  ck('rating is seeded (getLegalProviders orders by it)', lp.rating === 0, String(lp.rating));
  ck('ratingCount is seeded', lp.ratingCount === 0);
  ck('totalConsultations is seeded', lp.totalConsultations === 0);
  ck('licenceNumber is BLANK, never fabricated', lp.licenseNumber === '');
  ck('verified is false until a practising certificate is on file', lp.verified === false);
  ck('profilePending lists what the firm still owes', Array.isArray(lp.profilePending) && lp.profilePending.length > 0);

  /* ══ 3 · a free-text specialisation cannot be invented into the filter ══ */
  head('3 · only registry vocabulary reaches the filterable array');
  {
    const db = fakeDb();
    await projectLegal(db, { ...APP, specialization: 'Something Nobody Defined' }, UID, true);
    const p = db._store.legalProviders[UID];
    ck('an unrecognised specialisation falls back to "other"',
       JSON.stringify(p.specializations) === JSON.stringify(['other']), JSON.stringify(p.specializations));
    ck('...and is NOT written verbatim into the filter',
       p.specializations.every((s) => LC.LEGAL_SPECS.indexOf(s) > -1));
  }

  /* ══ 4 · the search projection is findable ══ */
  head('4 · lawyers is a usable search document');
  ck('searchable is true', lw.searchable === true);
  ck('searchIndexed is true', lw.searchIndexed === true);
  ck('searchableTerms is populated', Array.isArray(lw.searchableTerms) && lw.searchableTerms.length > 0,
     lw.searchableTerms && lw.searchableTerms.length + ' terms');
  ck('nameLower is stamped', lw.nameLower === APP.name.toLowerCase());
  ck('updatedAt is stamped', !!lw.updatedAt);
  /* The fields sokoni-firestore-search.js reads for this collection. */
  ['name', 'specialty', 'practice', 'firm', 'description', 'location', 'city'].forEach((f) => {
    ck('search client field `' + f + '` is present', f in lw, JSON.stringify(lw[f]).slice(0, 40));
  });
  ck('sellerUid is carried (legacy consumer field)', lw.sellerUid === UID);
  ck('id mirrors the uid', lw.id === UID);

  /* The terms a Kenyan client actually types. */
  const terms = lw.searchableTerms.map(String);
  ['wakili', 'advocate', 'lawyer', 'legal'].forEach((t) => {
    ck('search term "' + t + '" is indexed', terms.indexOf(t) > -1);
  });
  ck('the firm name is indexed', terms.some((t) => t.indexOf('partners') > -1 || t.indexOf('t.m.m') > -1));

  /* ══ 5 · ONE search surface ══ */
  head('5 · exactly one search surface exists for a legal entity');
  ck('the authority is NOT flagged searchable', lp.searchable === undefined,
     'legalProviders.searchable=' + lp.searchable);
  ck('the authority carries no searchableTerms', lp.searchableTerms === undefined);

  const SYNC = fs.readFileSync(path.join(ROOT, 'functions', 'algolia-sync.js'), 'utf8');
  const TS = fs.readFileSync(path.join(ROOT, 'functions', 'typesense-sync.js'), 'utf8');
  ck('legalProviders is NOT registered with Algolia', !/_makeTriggers\('legalProviders'\)/.test(SYNC));
  ck('legalProviders is NOT registered with Typesense', !/_makeTriggers\('legalProviders'\)/.test(TS));
  ck('lawyers remains registered with Algolia', /_makeTriggers\('lawyers'\)/.test(SYNC));
  ck('lawyers remains registered with Typesense', /_makeTriggers\('lawyers'\)/.test(TS));
  ck('exactly ONE lawyers Algolia registration — no duplicate added',
     (SYNC.match(/_makeTriggers\('lawyers'\)/g) || []).length === 1);

  /* ══ 6 · idempotency — the property that prevents duplicate legal entities ══ */
  head('6 · re-approval converges instead of forking a second entity');
  {
    const db = fakeDb();
    await projectLegal(db, APP, UID, true);
    const after1 = JSON.parse(JSON.stringify(db._store));
    const r2 = await projectLegal(db, APP, UID, true);
    const r3 = await projectLegal(db, APP, UID, true);

    ck('still exactly ONE legalProviders document',
       Object.keys(db._store.legalProviders).length === 1, Object.keys(db._store.legalProviders).join(','));
    ck('still exactly ONE lawyers document',
       Object.keys(db._store.lawyers).length === 1, Object.keys(db._store.lawyers).join(','));
    ck('the document id is still the uid', !!db._store.lawyers[UID]);
    ck('re-approval reports updated, not created',
       r2.every((w) => w.action === 'updated') && r3.every((w) => w.action === 'updated'),
       JSON.stringify(r2.map((w) => w.action)));

    /* Byte-stability: a repeated approval must not churn the record. Timestamps
       are sentinels in this fake, so a differing value here means a real field
       changed — which is what would make the index rewrite on every retry. */
    ck('the projection is stable across repeats (no field churn)',
       JSON.stringify(after1.lawyers[UID]) === JSON.stringify(db._store.lawyers[UID]));
    ck('...and the authority is stable too',
       JSON.stringify(after1.legalProviders[UID]) === JSON.stringify(db._store.legalProviders[UID]));
    ck('every write used merge (never a destructive overwrite)',
       db._writes.every((w) => w.merge));
  }

  /* ══ 7 · legacy / self-registered records survive ══ */
  head('7 · a legacy lawyers document is brought INTO sync, never replaced');
  {
    /* The real production shape: written by scripts/onboard-batch2.js, not by
       approval — no approvedAt, no applicationId, and fields the application
       does not carry. */
    const db = fakeDb({
      lawyers: { [UID]: {
        id: UID, uid: UID, sellerUid: UID,
        name: 'T.M.M & Partners Advocates', firm: 'T.M.M & Partners Advocates',
        specialty: 'Legal Services', practice: 'General Practice',
        category: 'legal', location: 'Nairobi', city: 'Nairobi',
        status: 'active', verified: false, searchable: true, searchIndexed: true,
        searchableTerms: ['tmm', 'advocates'],
        onboardedBy: 'scripts/onboard-batch2.js',
        createdAt: '2026-07-25T06:58:21.464Z',
      } },
      legalProviders: { [UID]: {
        providerId: UID, uid: UID,
        name: 'T.M.M & Partners Advocates', firmName: 'T.M.M & Partners Advocates',
        specializations: ['other'], licenseNumber: 'LSK/2019/4471',
        rating: 4.6, ratingCount: 12, totalConsultations: 31,
        consultationFee: 5000, currency: 'KES',
        status: 'active', verified: true,
        onboardedBy: 'scripts/onboard-batch2.js',
        createdAt: '2026-07-25T06:58:21.464Z',
      } },
    });

    const r = await projectLegal(db, APP, UID, true);
    const p = db._store.legalProviders[UID];
    const l = db._store.lawyers[UID];

    ck('the existing documents are UPDATED, not created',
       r.every((w) => w.action === 'updated'), JSON.stringify(r.map((w) => w.action)));
    ck('no second lawyers document appeared', Object.keys(db._store.lawyers).length === 1);

    /* Registry-owned values an application does not carry. */
    ck('a real licence number is NOT blanked', p.licenseNumber === 'LSK/2019/4471', p.licenseNumber);
    ck('an earned rating is NOT reset', p.rating === 4.6, String(p.rating));
    ck('ratingCount is NOT reset', p.ratingCount === 12, String(p.ratingCount));
    ck('consultation history is NOT reset', p.totalConsultations === 31, String(p.totalConsultations));
    ck('a set consultation fee is NOT zeroed', p.consultationFee === 5000, String(p.consultationFee));
    ck('an existing specialisation set is NOT overwritten',
       JSON.stringify(p.specializations) === JSON.stringify(['other']), JSON.stringify(p.specializations));
    ck('verified status is NOT downgraded', p.verified === true);
    ck('the original createdAt survives', p.createdAt === '2026-07-25T06:58:21.464Z');
    ck('provenance (onboardedBy) survives', p.onboardedBy === 'scripts/onboard-batch2.js');

    /* And the legacy search document is genuinely brought up to date. */
    ck('the legacy search record gains approval provenance', l.sourceApplicationId === 'APP-LEGAL-1');
    ck('its stale term list is refreshed',
       l.searchableTerms.length > 2, l.searchableTerms.length + ' terms');
    ck('its practice field is preserved (not clobbered by the specialty)',
       l.practice === 'General Practice', l.practice);
    ck('the legacy lawyers createdAt survives', l.createdAt === '2026-07-25T06:58:21.464Z');
    ck('the legacy record stays searchable', l.searchable === true && l.searchIndexed === true);
    ck('verified is carried across from the authority', l.verified === true);
  }

  /* ══ 8 · an approval-first firm, then a later re-approval ══ */
  head('8 · approval → later re-approval keeps ONE identity');
  {
    const db = fakeDb();
    await projectLegal(db, APP, UID, true);
    db._store.legalProviders[UID].rating = 4.9;            /* the firm earns reviews */
    db._store.legalProviders[UID].licenseNumber = 'LSK/2026/9001';
    await projectLegal(db, { ...APP, name: 'T.M.M & Partners LLP' }, UID, true);
    const p = db._store.legalProviders[UID];
    ck('the renamed firm is the SAME document', Object.keys(db._store.legalProviders).length === 1);
    ck('the new trading name is applied', p.name === 'T.M.M & Partners LLP', p.name);
    ck('the earned rating survives the rename', p.rating === 4.9, String(p.rating));
    ck('the supplied licence survives the rename', p.licenseNumber === 'LSK/2026/9001', p.licenseNumber);
    ck('the search projection follows the rename',
       db._store.lawyers[UID].nameLower === 't.m.m & partners llp', db._store.lawyers[UID].nameLower);
  }

  /* ══ 9 · revocation ══ */
  head('9 · revocation retracts BOTH, and removes the firm from search');
  {
    const db = fakeDb();
    await projectLegal(db, APP, UID, true);
    const r = await projectLegal(db, APP, UID, false);
    const p = db._store.legalProviders[UID];
    const l = db._store.lawyers[UID];

    ck('the authority is suspended', p.status === 'suspended', p.status);
    ck('the search record is suspended', l.status === 'suspended', l.status);
    /* searchable:false is what makes the existing algolia/typesense update
       trigger DELETE the document from the index — the retraction has to reach
       search, not just the directory. */
    ck('searchable is turned off (the index trigger deletes on this)', l.searchable === false);
    ck('searchIndexed is turned off', l.searchIndexed === false);
    ck('the firm is taken offline', p.isOnline === false);
    ck('NEITHER document is deleted', !!p && !!l);
    ck('the licence and history survive retraction for reinstatement',
       p.licenseNumber === '' && p.rating === 0 && 'totalConsultations' in p);
    ck('both retractions are reported', r.length === 2 && r.every((w) => w.action === 'retracted'),
       JSON.stringify(r.map((w) => w.action)));

    /* Reinstatement — the whole point of retracting instead of deleting. */
    const back = await projectLegal(db, APP, UID, true);
    ck('reinstatement updates the same documents', back.every((w) => w.action === 'updated'));
    ck('the firm is active again', db._store.legalProviders[UID].status === 'active');
    ck('...and searchable again', db._store.lawyers[UID].searchable === true);
  }

  /* ══ 10 · revoking a firm that was never projected ══ */
  head('10 · revoking an absent firm is a no-op, not a crash');
  {
    const db = fakeDb();
    const r = await projectLegal(db, APP, UID, false);
    ck('reported as noop_absent', r.every((w) => w.action === 'noop_absent'),
       JSON.stringify(r.map((w) => w.action)));
    ck('no empty tombstone document was created',
       !db._store.legalProviders && !db._store.lawyers);
  }

  /* ══ 11 · the delegate graduated ══ */
  head('11 · legal is no longer a silent delegate');
  ck('legal is NOT in DELEGATED_ROLES any more', !('legal' in LC.DELEGATED_ROLES),
     Object.keys(LC.DELEGATED_ROLES).join(','));
  ck('seller is still delegated (its own onboarding owns it)', LC.DELEGATED_ROLES.seller === 'sellers');
  ck('health is still delegated (its own registry owns it)', LC.DELEGATED_ROLES.health === 'healthProviders');
  ck('legal did NOT become a generic role profile', !('legal' in LC.ROLE_PROFILES));
  const SRC = fs.readFileSync(path.join(ROOT, 'functions', 'application-lifecycle.js'), 'utf8');
  ck('applyDecision routes legal to projectLegal', /role === 'legal'[\s\S]{0,220}projectLegal\(/.test(SRC));
  ck('the shared term generator is reused — no second transformation',
     /lawDoc\.searchableTerms = buildProviderTerms\(/.test(SRC));

  /* ══ 12 · unchanged neighbours ══ */
  head('12 · nothing else moved');
  ck('the operator onboarding script is untouched by this change',
     fs.readFileSync(path.join(ROOT, 'scripts', 'onboard-batch2.js'), 'utf8')
       .indexOf("patch('lawyers',TMM_UID") > -1);
  ck('legal-hub still reads legalProviders as its authority',
     /collection\(db, *'legalProviders'\)|'legalProviders'/.test(
       fs.readFileSync(path.join(ROOT, 'legal-hub.html'), 'utf8')));
  ck('the search client still reads lawyers',
     /col: 'lawyers'/.test(fs.readFileSync(path.join(ROOT, 'sokoni-firestore-search.js'), 'utf8')));
  /* DEMO_LAWYERS was removed 2026-07-19 (P0). Asserted so it cannot come back
     alongside a real projection and put fabricated advocates next to real ones. */
  const HUB = fs.readFileSync(path.join(ROOT, 'legal-hub.html'), 'utf8');
  ck('DEMO_LAWYERS is not reintroduced', !/const +DEMO_LAWYERS|DEMO_LAWYERS *=/.test(HUB));

  console.log('\n' + '='.repeat(70));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE CRASHED:', e && e.stack); process.exit(1); });
