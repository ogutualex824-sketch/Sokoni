#!/usr/bin/env node
/* EDUCATION E1 (owner decisions 2026-10-03) — teacher / institution / enterprise through the ONE application framework.
 *   node scripts/test-education-applications.js        BASE=cbbce0c node scripts/test-education-applications.js (must FAIL)
 * Executes the REAL applyDecision / applicationDecide on an in-memory Firestore (harness from test-food-gate1-approval). */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 220) + ']')); ok ? pass++ : fail++; };

/* ── the lifecycle under test: this tree, or BASE's bytes in a temp copy of functions/ ── */
let FN = path.join(ROOT, 'functions');
if (process.env.BASE) {
  const tmp = fs.mkdtempSync(path.join(ROOT, 'functions', '.edubase-')); process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });
  for (const f of ['application-lifecycle.js', 'role-vocabulary.js', 'search-terms.js', 'business-category.js', 'healthcare-category.js']) {
    try { fs.writeFileSync(path.join(tmp, f), execSync('git show ' + process.env.BASE + ':functions/' + f, { cwd: ROOT, stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: 64 << 20 })); } catch (_) { /* absent at BASE */ }
  }
  FN = tmp;
}
const real = require(path.join(ROOT, 'functions', 'node_modules', 'firebase-admin', 'lib', 'firestore', 'index.js'));
const FieldValue = real.FieldValue;

/* ── fake Firestore ── */
function fakeDb(seed) {
  const store = JSON.parse(JSON.stringify(seed || {}));
  const kind = (v) => (v && typeof v === 'object' && v.constructor && /Transform|FieldValue/.test(v.constructor.name)) ? (v.methodName || v._methodName || v.constructor.name) : null;
  const apply = (cur, patch, merge) => {
    const out = merge && cur ? Object.assign({}, cur) : {};
    for (const [k, v] of Object.entries(patch)) {
      const m = kind(v);
      if (m && /delete/i.test(m)) { delete out[k]; continue; }
      if (m && /serverTimestamp/i.test(m)) { out[k] = '<ts>'; continue; }
      if (m && /arrayUnion/i.test(m)) { const el = v.elements || v._elements || []; out[k] = [...new Set([...(Array.isArray(out[k]) ? out[k] : []), ...el])]; continue; }
      if (m && /arrayRemove/i.test(m)) { const el = v.elements || v._elements || []; out[k] = (Array.isArray(out[k]) ? out[k] : []).filter((x) => !el.includes(x)); continue; }
      if (v && typeof v === 'object' && !Array.isArray(v)) { out[k] = apply(null, v, false); continue; }
      out[k] = v;
    }
    return out;
  };
  const docRef = (col, id) => ({
    id, parent: { id: col }, path: col + '/' + id,
    get: async () => { const d = store[col] && store[col][id]; return { id, exists: !!d, ref: docRef(col, id), data: () => (d ? JSON.parse(JSON.stringify(d)) : undefined) }; },
    set: async (patch, o) => { store[col] = store[col] || {}; store[col][id] = apply(store[col][id], patch, o && o.merge); },
    delete: async () => { if (store[col]) delete store[col][id]; },
  });
  const query = (col, filters, lim) => ({
    where: (f, op, v) => query(col, filters.concat([[f, op, v]]), lim),
    limit: (n) => query(col, filters, n),
    get: async () => {
      const rows = Object.entries(store[col] || {}).filter(([, d]) => filters.every(([f, , v]) => d[f] === v)).slice(0, lim || 1e9);
      const docs = rows.map(([id, d]) => ({ id, exists: true, ref: docRef(col, id), data: () => JSON.parse(JSON.stringify(d)) }));
      return { empty: !docs.length, size: docs.length, docs };
    },
  });
  let adds = 0;
  return {
    _store: store,
    collection: (col) => Object.assign(query(col, [], 0), { doc: (id) => docRef(col, id || ('auto' + (++adds))), add: async (d) => { const r = docRef(col, 'auto' + (++adds)); await r.set(d); return r; } }),
    batch: () => { const ops = []; return { set: (ref, p, o) => ops.push(() => ref.set(p, o)), commit: async () => { for (const op of ops) await op(); } }; },
    runTransaction: async (fn) => fn({ get: (r) => r.get(), set: (r, p, o) => r.set(p, o) }),
  };
}

/* ── load the lifecycle with firebase replaced ── */
let DB = fakeDb({});
const calls = { pos: [], notify: [], claims: {} };
const stub = (abs, exp) => { require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: exp }; };
const nm = (p) => require.resolve(p, { paths: [path.join(ROOT, 'functions')] });
stub(nm('firebase-admin/firestore'), { getFirestore: () => DB, FieldValue });
stub(nm('firebase-admin/auth'), { getAuth: () => ({ getUser: async (u) => ({ uid: u, customClaims: calls.claims[u] || (u === 'ADMIN1' ? { admin: true } : {}) }), setCustomUserClaims: async (u, c) => { calls.claims[u] = c; } }) });
stub(path.join(FN, 'business-bootstrap.js'), { _ensureBusinessForOwner: async (o) => { calls.pos.push(o); return { created: true, reason: 'provisioned', merchantId: 'SOK-TEST01' }; } });
stub(path.join(FN, 'notify.js'), { notify: async (n) => { calls.notify.push(n); return { ok: true }; } });
let LC = null;
try { LC = require(path.join(FN, 'application-lifecycle.js'))._internal; } catch (e) { console.log('CRASH loading lifecycle (no verdict): ' + e.message); process.exit(2); }
let MOD = null; try { MOD = require(path.join(FN, 'application-lifecycle.js')); } catch (_) {}
const UID = 'uEdu0001', ADMIN = 'ADMIN1';
const mk = (over) => Object.assign({ applicationId: 'APPE1', uid: UID, name: 'Bright Minds', category: 'tutor', categoryLabel: 'Tutor / Private Teacher', hub: 'education',
  requestedRole: 'provider', role: 'provider', roleResolvedBy: 'explicit', type: 'business', status: 'approved', statusCanonical: 'approved', decidedBy: ADMIN,
  phoneNumber: '+254700000009', location: 'Kisumu', details: { subjects: 'Mathematics, Physics' } }, over || {});
const seed = (app, extra) => Object.assign({ applications: { APPE1: app }, applicationDecisions: { APPE1: { status: app.status, decidedBy: ADMIN } } }, extra || {});
const S = () => DB._store;
const decide = async (app) => { DB = fakeDb(seed(app)); calls.notify.length = 0; calls.claims = {}; try { return await LC.applyDecision('APPE1', app, { decidedBy: ADMIN }); } catch (e) { return { crash: e.message }; } };
const provOf = () => Object.values(S().providers || {})[0] || null;

(async () => {
  console.log('\nEducation E1 applications   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
  const T = LC.educationTypeOf || (() => undefined);
  ck('T-1', T(mk()) === 'teacher' && T(mk({ category: 'school' })) === 'institution' && T(mk({ category: 'online-course' })) === 'institution' && T(mk({ category: 'education-enterprise' })) === 'enterprise',
    'the TYPE comes from the intake category id: tutor → teacher; school / online-course → institution; education-enterprise → enterprise');
  ck('T-2', T(mk({ category: 'plumbing', educationType: 'enterprise' })) === null, 'a client-sent educationType is ignored (only the category id decides)');

  /* teacher */
  let r = await decide(mk());
  let p = provOf(), app = S().applications.APPE1, user = (S().users || {})[UID] || {};
  ck('A-1', r && r.ok === true && r.role === 'provider' && !!p, 'an approved TEACHER is provisioned as a provider', r);
  ck('A-2', p && p.education && p.education.type === 'teacher', 'the provider record carries education.type = teacher (the E2 dashboard reads it)', p && p.education);
  ck('A-3', app.educationType === 'teacher', 'the application records its education type', app.educationType);
  ck('A-4', (user.roles || []).includes('provider'), 'CONTROL: the teacher account gets the provider role');
  ck('A-5', /SOKONI Education/.test((calls.notify[0] || {}).body || ''), 'the approval notice speaks Education', (calls.notify[0] || {}).body);

  r = await decide(mk({ requestedRole: 'legal' }));
  ck('A-6', r && r.role === 'provider' && !(S().legalProviders || {})[UID], 'a tutor application cannot declare itself into another role (requestedRole legal is ignored)', r);

  /* institution */
  r = await decide(mk({ category: 'school', details: {} }));
  ck('B-1', r && r.ok === false && r.reason === 'incomplete' && !provOf() && !((S().users || {})[UID]), 'an INSTITUTION without a registration number is NOT provisioned (no provider, no role)', r);
  app = S().applications.APPE1;
  ck('B-2', app.projectionStatus === 'blocked_incomplete' && Array.isArray(app.missing) && /Registration/.test(app.missing.join()), 'the application says exactly what is missing', [app.projectionStatus, app.missing]);
  r = await decide(mk({ category: 'school', details: { registrationNo: 'MOE/123/2020' } }));
  ck('B-3', r && r.ok === true && provOf() && (provOf().education || {}).type === 'institution', 'with its registration number an institution is provisioned, typed institution', r);
  r = await decide(mk({ details: {} }));
  ck('B-4', r && r.ok === false && !provOf(), 'a TEACHER without subjects is not provisioned', r);

  /* enterprise */
  const ent = (d) => mk({ category: 'education-enterprise', requestedRole: 'buyer', role: 'buyer', name: 'Acme Ltd', details: d });
  r = await decide(ent({ companyRegNo: 'PVT-ABC123', kraPin: 'p051234567x', staffSeats: '40', trainingNeeds: 'Excel, customer care' }));
  const e = (S().educationEnterprises || {})[UID];
  user = (S().users || {})[UID] || {};
  ck('C-1', r && r.ok === true && e && e.status === 'active' && e.kraPin === 'P051234567X' && e.companyRegNo === 'PVT-ABC123' && e.staffSeats === 40,
    'an approved ENTERPRISE gets a verified educationEnterprises/{uid} buyer record (KRA PIN normalised)', e);
  ck('C-2', !provOf() && !(user.roles || []).length && !calls.claims[UID], 'an enterprise gets NO provider listing, NO account role and NO claim', [provOf(), user.roles, calls.claims[UID]]);
  ck('C-3', e && e._noIndex === true, 'the enterprise record is never indexed for search');
  r = await decide(ent({ companyRegNo: 'PVT-ABC123', kraPin: '12345' }));
  ck('C-4', r && r.ok === false && !(S().educationEnterprises || {})[UID] && /KRA PIN/.test((S().applications.APPE1.missing || []).join()), 'a malformed KRA PIN is refused, nothing provisioned', r);
  r = await decide(ent({ kraPin: 'P051234567X' }));
  ck('C-5', r && r.ok === false && !(S().educationEnterprises || {})[UID], 'an enterprise without a company registration number is refused', r);
  DB = fakeDb(seed(ent({ companyRegNo: 'X', kraPin: 'P051234567X' }), { educationEnterprises: { [UID]: { status: 'active', approved: true } } }));
  r = await LC.applyDecision('APPE1', Object.assign(ent({ companyRegNo: 'X', kraPin: 'P051234567X' }), { status: 'suspended', statusCanonical: 'suspended' }), { decidedBy: ADMIN });
  ck('C-6', (S().educationEnterprises || {})[UID].status === 'inactive' && !(((S().users || {})[UID] || {}).roles), 'suspending an enterprise retracts its record and touches no account role', S().educationEnterprises);

  /* applicationDecide refuses up front */
  const AD = MOD && MOD.applicationDecide;
  DB = fakeDb(seed(mk({ category: 'school', status: 'pending', statusCanonical: 'pending', decidedBy: null, details: {} })));
  let err = null; try { await AD.run({ auth: { uid: ADMIN, token: { admin: true } }, data: { applicationId: 'APPE1', decision: 'approve' } }); } catch (x) { err = x; }
  ck('D-1', err && err.code === 'failed-precondition' && err.details && err.details.reason === 'EDUCATION_APPLICATION_INCOMPLETE' && S().applications.APPE1.status === 'pending' && !(S().adminAudit),
    'applicationDecide REFUSES an incomplete education approval BEFORE writing anything (status stays pending)', err && [err.code, err.details, S().applications.APPE1.status]);
  err = null; try { await AD.run({ auth: { uid: ADMIN, token: { admin: true } }, data: { applicationId: 'APPE1', decision: 'request_info', reason: 'Send your MoE registration number' } }); } catch (x) { err = x; }
  ck('D-2', !err && S().applications.APPE1.status === 'info_requested', 'CONTROL: the reviewer can still REQUEST INFO (the change-request path)', err && err.message);

  /* controls: non-education unchanged */
  DB = fakeDb(seed(mk({ category: 'plumbing', hub: 'service', details: {} })));
  r = await LC.applyDecision('APPE1', mk({ category: 'plumbing', hub: 'service', details: {} }), { decidedBy: ADMIN });
  ck('N-1', r && r.ok === true && provOf() && !provOf().education && !S().applications.APPE1.educationType, 'CONTROL: a plumber is approved exactly as before (no education stamp, no document gate)', r);

  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
