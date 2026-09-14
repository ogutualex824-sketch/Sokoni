#!/usr/bin/env node
/* OB-5 — suspending a provider must not leave the onboarding projection saying "findable".
 *
 *   node scripts/test-provider-suspension-mirror.js
 *   COUNTERPROOF=1 node scripts/test-provider-suspension-mirror.js   # PRE-FIX source
 *
 * SDKs are stubbed and the REAL functions are invoked — projectProvider (via the lifecycle's
 * _internal), the account-status deactivate/reactivate pair, providerPublish and
 * providerGetPublicProfile — so assertions are on documents actually written.
 *
 * THE STATE THIS REMOVES
 * `providers/{uid}` is the canonical approval state. `providerProfiles/{uid}` is the
 * onboarding projection, and it is a SECOND customer-reachable surface: the only
 * providerProfiles-based discovery query is providerSearchProviders, which asks for
 * `status == 'active' AND searchable == true`.
 *
 * Suspension wrote only the canonical record. `application-lifecycle.js` contained ZERO
 * references to providerProfiles and `account-status.js` covered `providers` and `shops` but
 * not the projection — so the canonical state said suspended while the projection still said
 * findable, and the provider stayed listed.
 *
 * OB-1 already closed the reverse direction (suspended → providerPublish → active). This
 * closes the divergence.
 *
 * NEGATIVE CONTROLS: every one below exercises a handler that EXISTS in both runs. A control
 * that passes because a function is absent proves nothing, which is the trap OB-3's Part B
 * fell into — so the counter-proof here reverts the mirror writes only, leaving every handler
 * in place.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const FUNCTIONS_DIR = path.join(ROOT, 'functions');
const COUNTERPROOF = !!process.env.COUNTERPROOF;

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 140) + ']' : ''));
  ok ? pass++ : fail++;
};

const P = 'PROVIDER_uid_6f1';
const ADMIN = 'ADMIN_1';

const FieldValue = {
  serverTimestamp: () => ({ __s: 'ts' }),
  arrayUnion: (...v) => ({ __s: 'au', values: v }),
  arrayRemove: (...v) => ({ __s: 'ar', values: v }),
  increment: (by) => ({ __s: 'inc', by }),
  delete: () => ({ __s: 'DELETE' }),
};

let ENV;
const DB_PROXY = { collection: (c) => ENV.db.collection(c), batch: () => ENV.db.batch() };
function makeEnv({ docs = {} } = {}) {
  const data = { ...docs };
  const log = [];
  /* A FieldValue.delete() sentinel must actually remove the key, or "suspendedAt cleared on
     reinstatement" would assert against a sentinel object and pass while the field survives. */
  const apply = (p, doc, merge) => {
    const base = merge ? { ...(data[p] || {}) } : {};
    for (const [k, v] of Object.entries(doc)) {
      if (v && v.__s === 'DELETE') delete base[k]; else base[k] = v;
    }
    data[p] = base;
  };
  const mkDoc = (coll, id) => ({
    __path: `${coll}/${id}`,
    async get() { const p = `${coll}/${id}`; return { exists: !!data[p], id, data: () => data[p] }; },
    async set(doc, opts) { log.push({ op: 'set', coll, id, doc }); apply(`${coll}/${id}`, doc, opts && opts.merge); return this; },
    async update(doc) { log.push({ op: 'update', coll, id, doc }); apply(`${coll}/${id}`, doc, true); return this; },
    async delete() { log.push({ op: 'delete', coll, id }); delete data[`${coll}/${id}`]; },
  });
  const mkColl = (coll, preds = []) => {
    const self = {
      doc: (id) => mkDoc(coll, id),
      async add(doc) { log.push({ op: 'add', coll, doc }); return { id: 'gen' }; },
      where(f, o, v) { return mkColl(coll, preds.concat([[f, o, v]])); },
      limit() { return self; }, orderBy() { return self; },
      count() { return { get: async () => { const s = await self.get(); return { data: () => ({ count: s.size }) }; } }; },
      async get() {
        const match = (d) => preds.every(([f, o, v]) => {
          const a = d ? d[f] : undefined;
          if (o === '==') return a === v;
          if (o === 'in') return Array.isArray(v) && v.includes(a);
          return true;
        });
        const docs = Object.keys(data)
          .filter((p) => p.startsWith(coll + '/') && p.slice(coll.length + 1).indexOf('/') === -1)
          .filter((p) => match(data[p]))
          .map((p) => ({ id: p.slice(coll.length + 1), data: () => data[p], ref: mkDoc(coll, p.slice(coll.length + 1)) }));
        return { docs, size: docs.length, empty: !docs.length, forEach: (f) => docs.forEach(f) };
      },
    };
    return self;
  };
  const fs_ = { collection: mkColl, batch() { const o = []; return { set(r, d, p) { o.push([r, d, p]); }, update(r, d) { o.push([r, d, { merge: true }]); }, async commit() { for (const [r, d, p] of o) await r.set(d, p); } }; } };
  return { data, log, db: fs_,
    auth: { async getUser(u) { return { uid: u, customClaims: {} }; }, async setCustomUserClaims() {} } };
}

/** PRE-FIX: the four mirror writes removed, and NOTHING else.
    Every handler still exists and still runs in the counter-proof, so each negative control
    exercises the same code path it does in the real run — a control that passes because a
    function is absent proves nothing.

    Cuts are START..END INCLUSIVE against markers chosen from the real text. An end marker
    that stops short leaves a dangling brace and the mutant fails to COMPILE, which reports as
    "no failures detected" for a reason that has nothing to do with the defect. */
function prefixSources() {
  let al = fs.readFileSync(path.join(FUNCTIONS_DIR, 'application-lifecycle.js'), 'utf8');
  let ac = fs.readFileSync(path.join(FUNCTIONS_DIR, 'account-status.js'), 'utf8');
  const cut = (s, startMark, endMark, label) => {
    const i = s.indexOf(startMark);
    if (i < 0) throw new Error('start anchor not found: ' + label);
    const j = s.indexOf(endMark, i);
    if (j < 0) throw new Error('end anchor not found: ' + label);
    return s.slice(0, i) + s.slice(j + endMark.length);
  };
  al = cut(al,
    '    /* OB-5 — MIRROR THE RETRACTION',
    "      .catch(() => {});   /* a provider who never onboarded has no profile to delist */\n",
    'AL retraction');
  al = cut(al,
    '  /* OB-5 — the same mirror in the other direction.',
    "    .catch(() => {});\n",
    'AL approval');
  ac = cut(ac,
    '  /* OB-5 — the onboarding projection is a third',
    '    await profRef.set(patch, { merge: true });\n  }\n',
    'AC hide');
  ac = cut(ac,
    '  /* OB-5 — restore the projection to WHAT IT WAS',
    '      searchable: wasSearchable, deactivated: false, updatedAt: now, preDeactivationSearchable: del,\n    }, { merge: true });\n  }\n',
    'AC restore');
  /* Prove the reconstruction actually removed them — a silently-failed cut would leave the
     "pre-fix" source identical to the fixed one and the counter-proof would report success. */
  if (/OB-5/.test(al) || /OB-5/.test(ac)) throw new Error('prefix reconstruction left an OB-5 block behind');
  return { al, ac };
}

let AL = null, AC = null, PO = null;
function load() {
  const orig = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === 'firebase-admin/firestore') return { getFirestore: () => ENV.db, FieldValue, Timestamp: { fromDate: (d) => +d } };
    if (id === 'firebase-admin/auth') return { getAuth: () => ENV.auth };
    /* account-status.js does `const db = admin.firestore()` at MODULE LOAD. A stub bound to
       whichever ENV existed then would silently ignore every later fixture, and each section
       would assert against the first section's data. This proxy resolves ENV on every call. */
    if (id === 'firebase-admin') return { firestore: Object.assign(() => DB_PROXY, { FieldValue }), auth: () => ({ setCustomUserClaims: async () => {}, getUser: async (u) => ({ uid: u, customClaims: {} }) }), apps: [{}] };
    if (id === 'firebase-functions/logger') return { info() {}, warn() {}, debug() {}, error() {} };
    if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => h, HttpsError: class extends Error { constructor(c, m) { super(m); this.code = c; } } };
    if (id === 'firebase-functions/v2/firestore') return { onDocumentWritten: (_o, h) => h };
    if (id === 'firebase-functions/v1') return { auth: { user: () => ({ onCreate: (h) => h, onDelete: (h) => h }) } };
    if (id === 'firebase-functions/params') return { defineSecret: (n) => ({ name: n, value: () => 's' }) };
    if (id === './notify') return { notify: async () => {} };
    if (id === './search-terms') return { buildSearchTerms: () => [], searchTerms: () => [] };
    if (id === './legal-agreements') return { assertLegalCompliance: async () => ({ compliant: true }), complianceFor: async () => ({ compliant: true, missing: [], required: [], accepted: {} }) };
    if (id === './availability') return { normalizeAvailabilityConfig: (_c, uid) => ({ uid }) };
    return orig.apply(this, arguments);
  };
  let alFile = path.join(FUNCTIONS_DIR, 'application-lifecycle.js');
  let acFile = path.join(FUNCTIONS_DIR, 'account-status.js');
  const poFile = path.join(FUNCTIONS_DIR, 'provider-onboarding.js');
  if (COUNTERPROOF) {
    const src = prefixSources();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob5-'));
    alFile = path.join(dir, 'application-lifecycle.js'); fs.writeFileSync(alFile, src.al);
    acFile = path.join(dir, 'account-status.js');        fs.writeFileSync(acFile, src.ac);
    /* Sibling shims derived FROM the sources, never hand-listed. */
    const sibs = new Set();
    for (const s of [src.al, src.ac]) for (const m of s.matchAll(/require\('\.\/([A-Za-z0-9_-]+)'\)/g)) sibs.add(m[1]);
    for (const sib of sibs) {
      if (sib === 'application-lifecycle' || sib === 'account-status') continue;
      fs.writeFileSync(path.join(dir, sib + '.js'),
        `module.exports = require(${JSON.stringify(path.join(FUNCTIONS_DIR, sib + '.js'))});`);
    }
  }
  for (const f of [alFile, acFile, poFile]) delete require.cache[require.resolve(f)];
  AL = require(alFile)._internal;
  AC = require(acFile);
  PO = require(poFile)._h;
}

const APPROVED = () => ({
  [`providers/${P}`]: { uid: P, providerId: 'PRV-A1', status: 'active', searchable: true,
                        isPublic: true, acceptsBookings: true, available: true, rating: 4.5, reviewCount: 9 },
  [`providerProfiles/${P}`]: { uid: P, providerId: 'PRV-A1', status: 'active', searchable: true,
                               plan: 'pro', name: 'Reliable Plumbing', bio: 'Twelve years.',
                               pricing: { fixed: { enabled: true, amount: 3000 } },
                               coverage: { city: 'Nairobi' },
                               draft: { profile: { name: 'Reliable Plumbing', category: 'plumbing' },
                                        coverage: { city: 'Nairobi' }, pricing: {}, availability: {} } },
});
const prof = () => ENV.data[`providerProfiles/${P}`] || {};
const reg  = () => ENV.data[`providers/${P}`] || {};
/* The REAL discovery query providerSearchProviders issues against the projection. */
const listedInSearch = async () => {
  const s = await ENV.db.collection('providerProfiles').where('status', '==', 'active').where('searchable', '==', true).get();
  return s.docs.some((d) => d.id === P);
};
const publicFetch = async () => {
  try { await PO.providerGetPublicProfile({ data: { providerId: 'PRV-A1' } }); return 'RETURNED'; }
  catch (e) { return e.code || 'threw'; }
};
const APP = (status) => ({ applicationId: P + '--a', uid: P, type: 'provider', role: 'provider',
  name: 'Reliable Plumbing', category: 'plumbing', phone: '0722543212', location: 'Nairobi',
  intakeVersion: 1, roleResolvedBy: 'declared', status });

(async () => {
  console.log('\nSOURCE: ' + (COUNTERPROOF ? 'PRE-FIX (mirror writes removed; all handlers present)' : 'current'));
  console.log('='.repeat(72));
  ENV = makeEnv({});   /* a db must exist before modules that capture it at load time */
  load();

  /* ═══ A — suspension reaches the projection ═══ */
  console.log('\nA. active → suspended');
  ENV = makeEnv({ docs: APPROVED() });
  ck('A0  precondition: listed in search before suspension', await listedInSearch() === true);
  await AL.projectProvider(ENV.db, APP('suspended'), P, false);
  ck('A1  the canonical record is suspended', reg().status === 'suspended', reg().status);
  ck('A2  the PROJECTION is delisted  <- the divergence', prof().searchable === false, String(prof().searchable));
  ck('A3  ...so the discovery query no longer returns them', await listedInSearch() === false);
  ck('A4  ...and the suspension is timestamped on the projection', !!prof().suspendedAt);

  /* ═══ B — content is preserved ═══ */
  console.log('\nB. suspension delists; it does not destroy');
  ck('B1  profile content survives (name, bio, pricing, coverage)',
    prof().name === 'Reliable Plumbing' && !!prof().bio && !!prof().pricing && !!prof().coverage);
  ck('B2  the draft survives, so a reinstated provider re-enters nothing', !!prof().draft);
  ck('B3  the onboarding status is NOT overwritten (a different state machine)',
    prof().status === 'active', prof().status);
  ck('B4  earned history is untouched', reg().rating === 4.5 && reg().reviewCount === 9);

  /* ═══ C — no public path serves a suspended provider ═══ */
  console.log('\nC. every providerProfiles-based public path');
  ck('C1  providerSearchProviders: not listed', await listedInSearch() === false);
  ck('C2  providerGetPublicProfile: refuses (it answers to the canonical record)',
    await publicFetch() !== 'RETURNED', await publicFetch());

  /* ═══ D — OB-1 still holds: republishing cannot undo it ═══ */
  console.log('\nD. suspension cannot be reversed by the provider');
  const r = await (async () => { try { return { ok: true, res: await PO.providerPublish({ auth: { uid: P, token: {} }, data: {} }) }; } catch (e) { return { ok: false, code: e.code, message: e.message }; } })();
  ck('D1  providerPublish still runs (drafting is legitimate)', r.ok, r.ok ? 'ok' : r.message);
  ck('D2  ...but the canonical record stays suspended  <- OB-1 intact', reg().status === 'suspended', reg().status);
  ck('D3  ...and the projection stays delisted', prof().searchable === false, String(prof().searchable));
  ck('D4  ...and they are still not publicly fetchable', await publicFetch() !== 'RETURNED');

  /* ═══ E — reinstatement restores both ═══ */
  console.log('\nE. reinstatement');
  await AL.projectProvider(ENV.db, APP('approved'), P, true);
  ck('E1  the canonical record is active again', reg().status === 'active', reg().status);
  ck('E2  the projection is discoverable again', prof().searchable === true, String(prof().searchable));
  ck('E3  ...the suspension stamp is cleared, not left stale', prof().suspendedAt === undefined, prof().suspendedAt);
  ck('E4  ...the discovery query returns them', await listedInSearch() === true);
  ck('E5  ...and they are publicly fetchable again', await publicFetch() === 'RETURNED');

  /* ═══ F — account deactivation, and the asymmetry that matters ═══ */
  console.log('\nF. account deactivation / reactivation');
  ENV = makeEnv({ docs: APPROVED() });
  const deactivate = async () => { try { await AC.accountDeactivate({ auth: { uid: P }, data: { confirm: true } }); return 'ok'; } catch (e) { return e.code || e.message; } };
  const reactivate = async () => { try { await AC.accountReactivate({ auth: { uid: P }, data: {} }); return 'ok'; } catch (e) { return e.code || e.message; } };
  ck('F1a deactivate runs', (await deactivate()) === 'ok');
  ck('F1  deactivation delists the projection', prof().searchable === false, String(prof().searchable));
  ck('F2  ...stashing the prior value rather than assuming it', prof().preDeactivationSearchable === true);
  ck('F3  ...and the canonical record is deactivated', reg().status === 'deactivated', reg().status);
  ck('F3b ...profile content survives deactivation', prof().name === 'Reliable Plumbing');
  ck('F4a reactivate runs', (await reactivate()) === 'ok');
  ck('F4  reactivation restores what was there', prof().searchable === true, String(prof().searchable));
  ck('F5  ...and clears the stash', prof().preDeactivationSearchable === undefined);

  /* The asymmetry: an UNAPPROVED provider must not become discoverable by being reactivated. */
  ENV = makeEnv({ docs: {
    [`providers/${P}`]: { uid: P, status: 'pending_approval', searchable: false },
    [`providerProfiles/${P}`]: { uid: P, status: 'active', searchable: false, name: 'Not Approved Yet' },
  } });
  await deactivate();
  await reactivate();
  ck('F6  an UNAPPROVED provider is NOT made searchable by reactivation', prof().searchable === false, String(prof().searchable));
  ck('F7  ...reactivation restores access, it does not grant approval', reg().status !== 'active', reg().status);
  /* ═══ G — the projection is not an authority ═══ */
  console.log('\nG. providerProfiles cannot manufacture an approved state');
  ENV = makeEnv({ docs: APPROVED() });
  await AL.projectProvider(ENV.db, APP('suspended'), P, false);
  /* A provider editing their own profile must not be able to relist themselves. The edit
     has to be a VALID one: asserting on a rejected call would prove only that the call was
     rejected, not that a legitimate edit leaves the projection delisted. */
  const upd = await (async () => {
    /* The real call shape is { section, data }. The hostile keys are inside `data`, where
       the handler's allow-list is what must ignore them. */
    try { await PO.providerUpdateProfile({ auth: { uid: P, token: {} }, data: { section: 'profile', data: { name: 'Renamed Plumbing', searchable: true, status: 'active', isPublic: true } } }); return 'ok'; }
    catch (e) { return e.code || 'threw'; }
  })();
  ck('G1  a legitimate profile edit succeeds', upd === 'ok', upd);
  ck('G1b ...and the edit actually applied', prof().name === 'Renamed Plumbing', prof().name);
  ck('G2  ...but searchable is NOT settable through it', prof().searchable === false, String(prof().searchable));
  ck('G2b ...nor is the onboarding status promotable to a public state by the provider',
    reg().searchable !== true, String(reg().searchable));
  ck('G3  ...and the canonical record is untouched by it', reg().status === 'suspended', reg().status);
  /* ═══ H — scope ═══ */
  console.log('\nH. scope');
  ENV = makeEnv({ docs: APPROVED() });
  await AL.projectProvider(ENV.db, APP('suspended'), P, false);
  await AL.projectProvider(ENV.db, APP('approved'), P, true);
  const touched = new Set(ENV.log.map((e) => e.coll).filter(Boolean));
  ck('H1  no healthProviders write', !touched.has('healthProviders'), [...touched].join(','));
  ck('H2  no healthcare / agreement / payment / booking / verification write',
    !['healthAppointments', 'healthRecords', 'healthPrescriptions', 'legalAcceptances',
      'payments', 'paymentIntents', 'providerBookings', 'providerVerification',
      'applications'].some((c) => touched.has(c)), [...touched].join(','));
  ck('H3  only providers and providerProfiles were written', [...touched].every((c) => ['providers', 'providerProfiles'].includes(c)), [...touched].join(','));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (COUNTERPROOF) console.log('(counter-proof: failures here ARE the divergence this gate removes)');
  console.log('');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
