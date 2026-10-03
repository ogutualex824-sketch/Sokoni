#!/usr/bin/env node
/**
 * J3 — Jobs search field mapping (module-stubbed, NO network, NO Firebase).
 *
 *   node scripts/test-jobs-search-mapping.js            baseline + every mutant
 *   JOBS_SEARCH_MUTANT=<name> node scripts/test-jobs-search-mapping.js
 *                                                        one mutated tree (child mode)
 *
 * What is proven (rows are named; see ROWS below):
 *   - an active canonical job is indexed with canonical field names (both engines)
 *   - a status change to 'closed' REMOVES it (enqueues a delete), even when the
 *     job was already expired-but-still-indexed
 *   - an expired job is never indexed
 *   - employerUid never reaches any index record or KASS result
 *   - digitalGigs / digitalJobs no longer feed sokoni_jobs (trigger AND processor)
 *   - a 'freelance-gig' job is indexed
 *   - the Algolia replicas rank on canonical fields
 *   - KASS search_jobs reads canonical fields and drops expired jobs
 *
 * Mutants are applied as source edits to a COPY of the modules in a temp dir —
 * production code carries no test switches. Each mutant must fail every row it
 * names, or the harness fails (a mutant that survives is a blind spot).
 *
 * Firebase modules are replaced by in-memory stubs; Typesense/Algolia clients
 * are stubbed at the prototype. Exits non-zero on any failure.
 */

'use strict';

const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const Module = require('module');
const { spawnSync } = require('child_process');

const FUNCTIONS_DIR = path.join(__dirname, '..', 'functions');

/* Files the harness loads (require chain) or reads (static checks). */
const FILES = [
  'jobs-search-eligibility.js', 'typesense-sync.js', 'typesense-queue.js', 'typesense-client.js',
  'algolia-sync.js', 'algolia-queue.js', 'algolia-indexer.js', 'algolia-sanitize.js', 'search-terms.js',
  'algolia-admin.js', 'index.js',
];

/* ── Mutants: { file, find, replace, expect: [row names that MUST fail] } ── */
const MUTANTS = {
  'closed-not-skipped': {
    edits: [
      { file: 'typesense-sync.js', find: "  if (collection === 'jobs') return !isPubliclySearchableJob(data);\n", replace: '' },
      { file: 'typesense-sync.js', find: "  if (collection === 'jobs' && isSkipped) return 'delete';\n", replace: '' },
    ],
    expect: ['ts.closed.removed', 'ts.expired.notIndexed'],
  },
  'employer-uid-leak': {
    edits: [{ file: 'typesense-client.js',
      find: "      id,\n      title:          _str(data.title),\n      companyName,",
      replace: "      id,\n      employerUid: data.employerUid,\n      title:          _str(data.title),\n      companyName," }],
    expect: ['ts.employerUid.absent'],
  },
  'gigs-still-mapped': {
    edits: [{ file: 'typesense-client.js',
      find: "  jobs:             { collection: 'sokoni_jobs',          transformer: TRANSFORMERS.jobs          },",
      replace: "  jobs:             { collection: 'sokoni_jobs',          transformer: TRANSFORMERS.jobs          },\n  digitalGigs:      { collection: 'sokoni_jobs',          transformer: TRANSFORMERS.digitalJobs   }," }],
    expect: ['ts.digitalGigs.notQueued', 'ts.processor.excludesLegacyItem'],
  },
  'expiry-ignored': {
    edits: [{ file: 'jobs-search-eligibility.js', find: '  return exp > nowMs;\n', replace: '  return true;\n' }],
    expect: ['ts.expired.notIndexed', 'alg.expired.notIndexed', 'kass.expired.excluded'],
  },
  'kass-legacy-fields': {
    edits: [{ file: 'jobs-search-eligibility.js',
      find: "    companyName: typeof d.companyName === 'string' ? d.companyName : '',",
      replace: "    companyName: d.company," }],
    expect: ['kass.canonical'],
  },
  'replica-legacy-fields': {
    edits: [{ file: 'algolia-admin.js',
      find: "  sokoni_jobs_newest:   { customRanking: ['desc(postedAt)',  'desc(featured)'] },",
      replace: "  sokoni_jobs_newest:   { customRanking: ['desc(createdAt)', 'desc(isFeatured)'] }," }],
    expect: ['alg.replicas.canonical'],
  },
  'processor-first-entry-lookup': {
    edits: [{ file: 'typesense-queue.js',
      find: '    const entry = COLLECTION_MAP[item.collection];\n    if (!entry || entry.collection !== tsCollection',
      replace: '    const entry = Object.values(COLLECTION_MAP).find(m => m.collection === tsCollection);\n    if (!entry || entry.collection !== tsCollection' }],
    expect: ['ts.processor.excludesLegacyItem'],
  },
};

/* ════════════════════════════ Firebase stubs ════════════════════════════ */

const DELETE = Symbol('FieldValue.delete');
const ms = v => (v && typeof v.toMillis === 'function') ? v.toMillis() : v;

function makeTimestamp(m) { return { toMillis: () => m, seconds: Math.floor(m / 1000), toDate: () => new Date(m) }; }

class FakeDoc {
  constructor(db, col, id) { this.db = db; this.col = col; this.id = id; this.path = `${col}/${id}`; }
  async get() { const d = this.db.store.get(this.path); return { exists: !!d, id: this.id, ref: this, data: () => (d ? { ...d } : undefined) }; }
  async set(data) { this.db.store.set(this.path, strip({ ...data })); }
  async update(patch) {
    const cur = this.db.store.get(this.path);
    if (!cur) throw new Error(`update on missing doc ${this.path}`);
    const next = { ...cur };
    for (const [k, v] of Object.entries(patch)) { if (v === DELETE) delete next[k]; else next[k] = v; }
    this.db.store.set(this.path, next);
  }
  async delete() { this.db.store.delete(this.path); }
}
function strip(o) { for (const k of Object.keys(o)) if (o[k] === DELETE || o[k] === undefined) delete o[k]; return o; }

class FakeQuery {
  constructor(db, col, filters = [], lim = Infinity) { this.db = db; this.col = col; this.filters = filters; this.lim = lim; }
  where(f, op, v) { return new FakeQuery(this.db, this.col, [...this.filters, [f, op, v]], this.lim); }
  orderBy() { return this; }
  limit(n) { return new FakeQuery(this.db, this.col, this.filters, n); }
  async get() {
    this.db.queries.push({ col: this.col, filters: this.filters });
    const docs = [];
    for (const [p, d] of this.db.store) {
      const [c, id] = p.split('/');
      if (c !== this.col) continue;
      const ok = this.filters.every(([f, op, v]) => {
        const x = ms(d[f]); const y = ms(v);
        if (op === '==') return x === y;
        if (op === '<=') return x <= y;
        if (op === 'in') return v.includes(d[f]);
        throw new Error(`op ${op}`);
      });
      if (ok) docs.push({ id, ref: new FakeDoc(this.db, c, id), data: () => ({ ...d }) });
    }
    const out = docs.slice(0, this.lim);
    return { empty: out.length === 0, size: out.length, docs: out };
  }
}
class FakeColl extends FakeQuery { doc(id) { return new FakeDoc(this.db, this.col, id); } }
class FakeDB {
  constructor() { this.store = new Map(); this.queries = []; }
  collection(c) { return new FakeColl(this, c); }
  batch() {
    const ops = [];
    return {
      update: (ref, patch) => ops.push(() => ref.update(patch)),
      set:    (ref, data)  => ops.push(() => ref.set(data)),
      delete: (ref)        => ops.push(() => ref.delete()),
      commit: async () => { for (const op of ops) await op(); },
    };
  }
  docData(p) { return this.store.get(p); }
}

let DB = new FakeDB();
const FieldValue = { delete: () => DELETE, serverTimestamp: () => Date.now(), increment: n => n };
const Timestamp  = { now: () => makeTimestamp(Date.now()), fromMillis: m => makeTimestamp(m) };

const fnWrap = (opts, handler) => Object.assign(async (...a) => handler(...a), { __opts: opts });
class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

const firestoreFn = () => DB;
firestoreFn.FieldValue = FieldValue;
firestoreFn.Timestamp  = Timestamp;

const STUBS = {
  'firebase-functions/v2/firestore': {
    onDocumentCreated: fnWrap, onDocumentUpdated: fnWrap, onDocumentDeleted: fnWrap, onDocumentWritten: fnWrap,
  },
  'firebase-functions/v2/scheduler': { onSchedule: fnWrap },
  'firebase-functions/v2/https':     { onCall: fnWrap, onRequest: fnWrap, HttpsError },
  'firebase-functions/params':       { defineSecret: () => ({ value: () => 'test-key' }), defineString: () => ({ value: () => '' }) },
  'firebase-functions/logger':       { info() {}, warn() {}, error() {}, log() {}, debug() {} },
  'firebase-admin/firestore':        { getFirestore: () => DB, FieldValue, Timestamp },
  'firebase-admin':                  { apps: [1], initializeApp() {}, firestore: firestoreFn },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(STUBS, request)) return STUBS[request];
  if (/^firebase-(admin|functions)/.test(request)) throw new Error(`unstubbed firebase module: ${request}`);
  return realLoad.apply(this, arguments);
};

/* ═════════════════════════ Source tree (real or mutated) ═════════════════════════ */

function prepareTree(mutantName) {
  if (!mutantName) return FUNCTIONS_DIR;
  const m = MUTANTS[mutantName];
  if (!m) throw new Error(`unknown mutant ${mutantName}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `j3-mutant-${mutantName}-`));
  for (const f of FILES) fs.copyFileSync(path.join(FUNCTIONS_DIR, f), path.join(dir, f));
  for (const e of m.edits) {
    const p = path.join(dir, e.file);
    const src = fs.readFileSync(p, 'utf8');
    const n = src.split(e.find).length - 1;
    if (n !== 1) throw new Error(`mutant ${mutantName}: anchor found ${n}x in ${e.file} (need exactly 1)`);
    fs.writeFileSync(p, src.replace(e.find, e.replace));
  }
  return dir;
}

/* ════════════════════════════════ Fixtures ════════════════════════════════ */

const NOW  = Date.now();
const DAY  = 86_400_000;
function job(over = {}) {
  return {
    title: 'Senior Accountant', companyName: 'Acme Kenya Ltd', category: 'finance', type: 'full-time',
    location: 'Nairobi', salaryMin: 80000, salaryMax: 120000, salaryCurrency: 'KES',
    status: 'active', featured: true,
    postedAt: makeTimestamp(NOW - DAY), expiresAt: makeTimestamp(NOW + 30 * DAY),
    employerUid: 'EMPLOYER_SECRET_UID_123', description: 'Lead the finance team.', requirements: 'CPA-K',
    ...over,
  };
}
const created = (docId, data) => ({ data: { data: () => data }, params: { docId } });
const updated = (docId, before, after) => ({ data: { before: { data: () => before }, after: { data: () => after } }, params: { docId } });
const noUid   = o => !JSON.stringify(o === undefined ? null : o).includes('EMPLOYER_SECRET_UID_123') &&
                     !JSON.stringify(o === undefined ? null : o).includes('employerUid');

/* ═════════════════════════════════ Runner ═════════════════════════════════ */

async function runSuite(dir) {
  const R = rel => require(path.join(dir, rel));
  const results = [];
  async function row(name, fn) {
    DB = new FakeDB();
    try { const ok = await fn(); results.push({ name, ok: ok === true, why: ok === true ? '' : String(ok) }); }
    catch (e) { results.push({ name, ok: false, why: `threw: ${e.message}` }); }
  }

  const tsClient  = R('typesense-client.js');
  const tsSync    = R('typesense-sync.js');
  const tsQueue   = R('typesense-queue.js');
  const algIdx    = R('algolia-indexer.js');
  const algSync   = R('algolia-sync.js');
  const algQueue  = R('algolia-queue.js');
  const elig      = R('jobs-search-eligibility.js');
  const tsJob     = tsClient.COLLECTION_MAP.jobs && tsClient.COLLECTION_MAP.jobs.transformer;
  const algJob    = algIdx.COLLECTION_INDEX_MAP.jobs && algIdx.COLLECTION_INDEX_MAP.jobs.transformer;

  /* ── Typesense ─────────────────────────────────────────────────────────── */
  await row('ts.active.canonical', () => {
    const d = tsJob('j1', job());
    if (!d) return 'null for an active job';
    const want = { title: 'Senior Accountant', companyName: 'Acme Kenya Ltd', type: 'full-time', featured: true,
      salaryMin: 80000, salaryMax: 120000, salaryCurrency: 'KES', status: 'active', locationText: 'Nairobi',
      company: 'Acme Kenya Ltd', jobType: 'full-time', isFeatured: true };
    for (const [k, v] of Object.entries(want)) if (d[k] !== v) return `${k}=${JSON.stringify(d[k])} want ${JSON.stringify(v)}`;
    if (d.postedAt !== Math.floor((NOW - DAY) / 1000)) return `postedAt=${d.postedAt}`;
    if (d.createdAt !== d.postedAt) return 'createdAt (default sort) not filled from postedAt';
    if (d.expiresAt !== Math.floor((NOW + 30 * DAY) / 1000) || d.deadline !== d.expiresAt) return 'expiresAt/deadline';
    if ('location' in d) return 'free-text location written into the geopoint field';
    return true;
  });
  await row('ts.active.enqueued', async () => {
    await tsSync.ts_jobs_onCreate(created('j1', job()));
    const q = DB.docData('typesenseQueue/jobs_j1');
    return (q && q.operation === 'upsert' && q.tsCollection === 'sokoni_jobs') || `queue=${JSON.stringify(q)}`;
  });
  await row('ts.closed.removed', async () => {
    await tsSync.ts_jobs_onUpdate(updated('j1', job(), job({ status: 'closed' })));
    const q = DB.docData('typesenseQueue/jobs_j1');
    return (q && q.operation === 'delete') || `queue=${JSON.stringify(q && q.operation)}`;
  });
  await row('ts.closed.removed.afterExpiry', async () => {
    const expired = job({ expiresAt: makeTimestamp(NOW - DAY) });
    await tsSync.ts_jobs_onUpdate(updated('j1', expired, { ...expired, status: 'closed' }));
    const q = DB.docData('typesenseQueue/jobs_j1');
    return (q && q.operation === 'delete') || `queue=${JSON.stringify(q && q.operation)}`;
  });
  await row('ts.expired.notIndexed', async () => {
    const expired = job({ expiresAt: makeTimestamp(NOW - 1000) });
    await tsSync.ts_jobs_onCreate(created('j2', expired));
    if (DB.docData('typesenseQueue/jobs_j2')) return 'expired job enqueued';
    if (tsJob('j2', expired) !== null) return 'transformer indexed an expired job';
    return true;
  });
  await row('ts.nonActive.notIndexed', async () => {
    for (const s of ['draft', 'pending_review', 'paused', 'archived', 'closed', 'suspended']) {
      if (tsJob('j3', job({ status: s })) !== null) return `status ${s} indexed`;
    }
    return true;
  });
  await row('ts.employerUid.absent', () => {
    const d = tsJob('j1', job());
    return (d && noUid(d)) || 'employerUid present in Typesense document';
  });
  await row('ts.digitalGigs.notQueued', async () => {
    const gig = { title: 'Logo design', status: 'active', company: 'x', budget: 999999 };
    await tsSync.ts_digitalGigs_onCreate(created('g1', gig));
    await tsSync.ts_digitalJobs_onCreate(created('g2', gig));
    if (DB.store.size) return `queue written: ${[...DB.store.keys()].join(',')}`;
    const feeders = Object.entries(tsClient.COLLECTION_MAP).filter(([, m]) => m && m.collection === 'sokoni_jobs').map(([k]) => k);
    return (feeders.length === 1 && feeders[0] === 'jobs') || `sokoni_jobs feeders: ${feeders.join(',')}`;
  });
  await row('ts.processor.excludesLegacyItem', async () => {
    const imported = [];
    const proto = tsClient.TypesenseClient.prototype;
    const saved = proto.importDocuments;
    proto.importDocuments = async (col, docs) => { imported.push({ col, docs }); return docs.map(() => ({ success: true })); };
    try {
      const base = { tsCollection: 'sokoni_jobs', operation: 'upsert', priority: 2, attempts: 0, status: 'pending', nextAttemptAt: NOW - 1000 };
      DB.store.set('typesenseQueue/jobs_j1',        { ...base, collection: 'jobs', docId: 'j1', data: job() });
      /* an item an OLDER live trigger build could still write */
      DB.store.set('typesenseQueue/digitalGigs_g1', { ...base, collection: 'digitalGigs', docId: 'g1', data: { title: 'Fake gig', status: 'active', company: 'Fake Co' } });
      await tsQueue.processTypesenseQueue();
    } finally { proto.importDocuments = saved; }
    const ids = imported.flatMap(c => c.docs.map(d => d.id));
    if (ids.length !== 1 || ids[0] !== 'j1') return `imported ids=${JSON.stringify(ids)}`;
    if (imported[0].docs[0].companyName !== 'Acme Kenya Ltd') return 'jobs item not transformed by the canonical mapper';
    const legacy = DB.docData('typesenseQueue/digitalGigs_g1');
    return (legacy && legacy.status === 'done') || `legacy item status=${legacy && legacy.status}`;
  });
  await row('ts.freelanceGig.indexed', async () => {
    const g = job({ type: 'freelance-gig', title: 'Logo design gig' });
    const d = tsJob('fg1', g);
    if (!d || d.type !== 'freelance-gig' || d.jobType !== 'freelance-gig') return `doc=${JSON.stringify(d && d.type)}`;
    await tsSync.ts_jobs_onCreate(created('fg1', g));
    const q = DB.docData('typesenseQueue/jobs_fg1');
    return (q && q.operation === 'upsert') || 'freelance-gig job not enqueued';
  });

  /* ── Algolia ───────────────────────────────────────────────────────────── */
  await row('alg.active.canonical', () => {
    const r = algJob('j1', job());
    if (!r) return 'null for an active job';
    const want = { objectID: 'j1', companyName: 'Acme Kenya Ltd', type: 'full-time', featured: true, location: 'Nairobi',
      salaryMin: 80000, salaryMax: 120000, salaryCurrency: 'KES', status: 'active' };
    for (const [k, v] of Object.entries(want)) if (r[k] !== v) return `${k}=${JSON.stringify(r[k])}`;
    if (r.postedAt !== Math.floor((NOW - DAY) / 1000) || r.expiresAt !== Math.floor((NOW + 30 * DAY) / 1000)) return 'postedAt/expiresAt';
    return true;
  });
  await row('alg.closed.removed', async () => {
    await algSync.algoliaSync_jobs_update(updated('j1', job(), job({ status: 'closed' })));
    const q = DB.docData('algoliaQueue/jobs_j1');
    const g = DB.docData('algoliaQueue/gs__jobs_j1');
    if (!q || q.operation !== 'delete') return `primary=${q && q.operation}`;
    return (g && g.operation === 'delete') || `global shadow=${g && g.operation}`;
  });
  await row('alg.expired.notIndexed', async () => {
    const expired = job({ expiresAt: makeTimestamp(NOW - 1000) });
    await algSync.algoliaSync_jobs_create(created('j2', expired));
    if (DB.store.size) return 'expired job enqueued';
    return algJob('j2', expired) === null || 'transformer indexed an expired job';
  });
  await row('alg.employerUid.absent', () => {
    const r = algJob('j1', job());
    const g = algIdx.COLLECTION_INDEX_MAP.gs__jobs.transformer('jobs_j1', job());
    if (!r || !noUid(r)) return 'employerUid in sokoni_jobs record';
    if (r.poster) return 'poster block present';
    return (g && noUid(g)) || 'employerUid in global_search shadow (or shadow null)';
  });
  await row('alg.digitalJobs.notQueued', async () => {
    await algSync.algoliaSync_digitalJobs_create(created('d1', { title: 'Fake', status: 'active' }));
    if (DB.store.size) return 'digitalJobs enqueued';
    const m = algIdx.COLLECTION_INDEX_MAP;
    return (!m.digitalJobs && !m.gs__digitalJobs) || 'digitalJobs still mapped';
  });
  await row('alg.processor.excludesLegacyItem', async () => {
    process.env.ALGOLIA_APP_ID = process.env.ALGOLIA_APP_ID || 'TESTAPP';
    const sent = [];
    const proto = algIdx.AlgoliaClient.prototype;
    const saved = { s: proto.saveObjects, p: proto.partialUpdateObjects, d: proto.deleteObjects };
    proto.saveObjects = async (idx, objs) => { sent.push(...objs.map(o => `${idx}:${o.objectID}`)); };
    proto.partialUpdateObjects = async (idx, objs) => { sent.push(...objs.map(o => `${idx}:${o.objectID}`)); };
    proto.deleteObjects = async () => {};
    try {
      const base = { operation: 'upsert', status: 'pending', attempts: 0, nextAttemptAt: makeTimestamp(NOW - 1000), beforeData: null };
      DB.store.set('algoliaQueue/jobs_j1',        { ...base, queueId: 'jobs_j1', collection: 'jobs', docId: 'j1', indexName: 'sokoni_jobs', data: job() });
      DB.store.set('algoliaQueue/digitalJobs_d1', { ...base, queueId: 'digitalJobs_d1', collection: 'digitalJobs', docId: 'd1', indexName: 'sokoni_jobs', data: { title: 'Fake', status: 'active' } });
      await algQueue.processAlgoliaQueue();
    } finally { proto.saveObjects = saved.s; proto.partialUpdateObjects = saved.p; proto.deleteObjects = saved.d; }
    if (sent.join() !== 'sokoni_jobs:j1') return `sent=${sent.join()}`;
    const legacy = DB.docData('algoliaQueue/digitalJobs_d1');
    return (legacy && legacy.status === 'done') || `legacy item status=${legacy && legacy.status}`;
  });
  await row('alg.replicas.canonical', () => {
    const src = fs.readFileSync(path.join(dir, 'algolia-admin.js'), 'utf8');
    const newest   = (src.match(/sokoni_jobs_newest:\s*\{\s*customRanking:\s*\[([^\]]*)\]/) || [])[1] || '';
    const deadline = (src.match(/sokoni_jobs_deadline:\s*\{\s*customRanking:\s*\[([^\]]*)\]/) || [])[1] || '';
    if (!/desc\(postedAt\)/.test(newest) || /createdAt|isFeatured/.test(newest)) return `newest=${newest}`;
    if (!/asc\(expiresAt\)/.test(deadline) || /deadline\)|isFeatured/.test(deadline)) return `deadline=${deadline}`;
    /* every ranking/filter attribute in the primary settings exists on the record */
    const block = (src.match(/sokoni_jobs: \{\n\s*searchableAttributes:[\s\S]*?replicas:/) || [])[0] || '';
    if (!block) return 'primary sokoni_jobs settings block not found';
    const rec = algJob('j1', job());
    const attrs = new Set();
    for (const m of block.matchAll(/'(?:(?:asc|desc|filterOnly|searchable|unordered)\()?([A-Za-z_.]+)\)?'/g)) attrs.add(m[1].split('.')[0]);
    attrs.delete('sokoni_jobs_newest'); attrs.delete('sokoni_jobs_deadline');
    const missing = [...attrs].filter(a => !(a in rec));
    return missing.length === 0 || `settings name fields absent from record: ${missing.join(',')}`;
  });
  await row('alg.freelanceGig.indexed', () => {
    const r = algJob('fg1', job({ type: 'freelance-gig' }));
    return (r && r.type === 'freelance-gig') || 'freelance-gig not indexed';
  });

  /* ── KASS search_jobs ──────────────────────────────────────────────────── */
  async function kass(input, docs) {
    for (const [id, d] of Object.entries(docs)) DB.store.set(`jobs/${id}`, d);
    const res = []; const act = [];
    const out = await elig.kassSearchJobs({ db: DB, input, ctx: { addResult: r => res.push(r), addAction: a => act.push(a) }, nowMs: NOW });
    return { out, res };
  }
  await row('kass.canonical', async () => {
    const { out, res } = await kass({}, { k1: job() });
    if (out.found !== 1) return `found=${out.found}`;
    const r = res[0]; const j = out.jobs[0];
    if (r.company !== 'Acme Kenya Ltd' || j.company !== 'Acme Kenya Ltd') return `company=${r.company}/${j.company}`;
    if (!/KES 80,000 – 120,000/.test(j.salary) || r.salary !== j.salary) return `salary=${j.salary}`;
    return (r.jobType === 'full-time' && j.type === 'full-time') || `type=${r.jobType}`;
  });
  await row('kass.expired.excluded', async () => {
    const { out } = await kass({}, { k1: job({ expiresAt: makeTimestamp(NOW - 1000) }), k2: job({ title: 'Live one' }) });
    return (out.found === 1 && out.jobs[0].title === 'Live one') || `found=${out.found}`;
  });
  await row('kass.freelance.normalised', async () => {
    await kass({ type: 'freelance' }, { k1: job({ type: 'freelance-gig' }) });
    const q = DB.queries.find(x => x.col === 'jobs');
    const f = q && q.filters.find(([k]) => k === 'type');
    return (f && f[2] === 'freelance-gig') || `type filter=${JSON.stringify(f)}`;
  });
  await row('kass.noEmployerUid', async () => {
    const { out, res } = await kass({}, { k1: job() });
    return (noUid(out) && noUid(res)) || 'employerUid in KASS output';
  });
  await row('kass.wired', () => {
    const src = fs.readFileSync(path.join(dir, 'index.js'), 'utf8');
    const i = src.indexOf('if (name === "search_jobs")');
    if (i < 0) return 'search_jobs handler not found';
    const block = src.slice(i, src.indexOf('\n    }\n', i));
    if (!/kassSearchJobs\(\{ db, input, ctx \}\)/.test(block)) return 'handler does not delegate to kassSearchJobs';
    return !/\.company\b|\.salary\b/.test(block) || 'legacy company/salary reads remain';
  });

  return results;
}

/* ═════════════════════════════════ Main ═════════════════════════════════ */

async function child(mutant) {
  const dir = prepareTree(mutant);
  const results = await runSuite(dir);
  process.stdout.write('@@RESULT@@' + JSON.stringify(results) + '\n');
}

async function main() {
  const mutant = process.env.JOBS_SEARCH_MUTANT;
  if (mutant) return child(mutant);

  /* Baseline (in-process) */
  const base = await runSuite(FUNCTIONS_DIR);
  let fails = 0;
  for (const r of base) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  — ' + r.why}`);
    if (!r.ok) fails++;
  }
  console.log(`\nbaseline: ${base.length - fails}/${base.length} pass, ${fails} fail`);

  /* Mutants (each in its own process, so module caches never mix) */
  let killed = 0;
  const names = Object.keys(MUTANTS);
  for (const name of names) {
    const r = spawnSync(process.execPath, [__filename], { env: { ...process.env, JOBS_SEARCH_MUTANT: name }, encoding: 'utf8' });
    const line = (r.stdout || '').split('\n').find(l => l.startsWith('@@RESULT@@'));
    if (!line) { console.log(`MUTANT ${name}: harness error (FAIL CLOSED)\n${r.stderr}`); continue; }
    const res = JSON.parse(line.slice('@@RESULT@@'.length));
    const failed = res.filter(x => !x.ok).map(x => x.name);
    const missed = MUTANTS[name].expect.filter(n => !failed.includes(n));
    const ok = missed.length === 0;
    if (ok) killed++;
    console.log(`MUTANT ${name}: ${ok ? 'KILLED' : 'SURVIVED'} — failed rows [${failed.join(', ')}]${ok ? '' : `; expected but passed: [${missed.join(', ')}]`}`);
  }
  console.log(`mutants: ${killed}/${names.length} killed`);

  if (fails || killed !== names.length) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
