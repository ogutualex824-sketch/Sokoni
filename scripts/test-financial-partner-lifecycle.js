/* test-financial-partner-lifecycle.js — financial_partner applications list a partner in financialProviders/{uid}
 *
 * Drives the REAL applicationLifecycle trigger (functions/application-lifecycle.js → decisionAuthority →
 * applyDecision → projectFinancialPartner → functions/financial-partner-listing.js) over an in-memory Firestore and
 * Auth. No network, no production. Harness shape copied from test-k13b-lifecycle-authority.js.
 *
 *   node scripts/test-financial-partner-lifecycle.js
 *
 * Rows are sokoni-4d's Banking Hub spec (2026-10-01) plus edge controls.
 */
'use strict';
const path = require('path'), Module = require('module');
const ROOT = path.resolve(__dirname, '..');

const data = {}; const WRITES = []; let seq = 0;
function applyPatch(cur, patch) {
  const out = Object.assign({}, cur || {});
  for (const [k, v] of Object.entries(patch)) {
    if (v && v.__op === 'delete') delete out[k];
    else if (v && v.__op === 'union') out[k] = [...new Set([...(out[k] || []), ...v.vals])];
    else if (v && v.__op === 'remove') out[k] = (out[k] || []).filter((x) => !v.vals.includes(x));
    else out[k] = v;
  }
  return out;
}
const write = (p, patch, merge) => { WRITES.push(p); data[p] = merge ? applyPatch(data[p], patch) : applyPatch({}, patch); };
const snapOf = (p) => ({ exists: p in data, id: p.split('/').pop(), ref: ref(p), data: () => (p in data ? JSON.parse(JSON.stringify(data[p])) : undefined) });
function ref(p) { return { id: p.split('/').pop(), path: p, get: async () => snapOf(p), set: async (v, o) => write(p, v, o && o.merge), update: async (v) => write(p, v, true), collection: (c) => col(p + '/' + c) }; }
function col(c, filters = [], lim = null) {
  return {
    doc: (id) => ref(c + '/' + (id || ('auto' + (++seq)))),
    add: async (v) => { const r = ref(c + '/auto' + (++seq)); await r.set(v); return r; },
    where: (f, op, v) => col(c, filters.concat([[f, op, v]]), lim),
    limit: (n) => col(c, filters, n),
    get: async () => {
      let docs = Object.keys(data).filter((p) => p.startsWith(c + '/') && p.split('/').length === c.split('/').length + 1);
      for (const [f, op, v] of filters) docs = docs.filter((p) => (op === '==' ? data[p][f] === v : op === 'in' ? v.includes(data[p][f]) : false));
      if (lim != null) docs = docs.slice(0, lim);
      const s = docs.map(snapOf); return { empty: !s.length, size: s.length, docs: s };
    },
  };
}
const db = { collection: (c) => col(c), doc: ref, batch: () => { const ops = []; return { set: (r, v, o) => ops.push(() => r.set(v, o)), update: (r, v) => ops.push(() => r.update(v)), delete: (r) => ops.push(() => { delete data[r.path]; }), commit: async () => { for (const o of ops) await o(); } }; } };
const FieldValue = { serverTimestamp: () => 'TS', delete: () => ({ __op: 'delete' }), arrayUnion: (...vals) => ({ __op: 'union', vals }), arrayRemove: (...vals) => ({ __op: 'remove', vals }), increment: (n) => n };
const CLAIMS = { admin1: { admin: true }, plainUser: {} };
const auth = { getUser: async (u) => { if (!(u in CLAIMS) && !/^u_/.test(u)) throw new Error('no user'); return { uid: u, customClaims: CLAIMS[u] || {} }; }, setCustomUserClaims: async (u, c) => { CLAIMS[u] = c; } };

const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue };
  if (id === 'firebase-admin/auth') return { getAuth: () => auth };
  if (id === 'firebase-admin') return { apps: [{}], initializeApp() {}, firestore: Object.assign(() => db, { FieldValue }), auth: () => auth };
  if (id === 'firebase-functions/logger') return { info() {}, warn() {}, error() {}, debug() {} };
  if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => h, HttpsError: class extends Error { constructor(c, m, d) { super(m); this.code = c; this.details = d; } } };
  if (id === 'firebase-functions/v2/firestore') return { onDocumentWritten: (_o, h) => h };
  if (id === './search-terms') return { buildSearchTerms: () => [] };
  if (id === './business-bootstrap') return { _ensureBusinessForOwner: async () => ({}) };
  if (id === './notify') return { notify: async () => ({}) };
  return orig.apply(this, arguments);
};
const L = require(path.join(ROOT, 'functions', 'application-lifecycle.js'));
const FPL = require(path.join(ROOT, 'functions', 'financial-partner-listing.js'));
const VOCAB = require(path.join(ROOT, 'functions', 'role-vocabulary.js'));
const IV = (L._internal && L._internal.INTAKE_VERSION) || 1;

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + JSON.stringify(d).slice(0, 170) + ']' : '')); ok ? pass++ : fail++; };

/* A complete, valid financial-partner application, plus the personal fields that must NEVER reach the public doc. */
const VALID = {
  requestedRole: 'financial_partner', category: 'BANK', categoryLabel: 'Bank',
  institutionName: 'Mfano Bank Limited', institutionType: 'BANK',
  services: ['BUSINESS_BANKING', 'LOANS', 'loans', 'NOT_A_SERVICE'],
  description: '<b>Business</b> accounts\nand loans for SMEs.',
  county: 'nairobi', website: 'https://mfano.example.co.ke/', businessEmail: 'Partners@Mfano.example.co.ke',
  businessPhone: '0712 345 678', licenceClaimed: 'CBK/123/2024',
  /* personal / internal: must stay on the application */
  fullName: 'Jane Applicant', nationalId: '12345678', kraPin: 'A123456789Z', email: 'jane@example.com',
  phone: '0799000000', agreementAcceptedAt: 'TS', internalNotes: 'x',
};
const put = (id, uid, extra) => { data['applications/' + id] = Object.assign({ uid, name: 'Jane Applicant', status: 'pending', location: 'Nairobi', intakeVersion: IV }, VALID, extra || {}); };
const decide = (id, status, by) => { data['applications/' + id].status = status; data['applications/' + id].decidedBy = by; data['applicationDecisions/' + id] = { applicationId: id, status, decidedBy: by, decidedAt: 'TS' }; };
const fire = async (id) => { try { await L.applicationLifecycle({ params: { appId: id }, data: { after: { exists: true, data: () => JSON.parse(JSON.stringify(data['applications/' + id])), ref: ref('applications/' + id) } } }); return null; } catch (e) { return e.message; } };
const listing = (uid) => data['financialProviders/' + uid];
const app = (id) => data['applications/' + id] || {};
const alerts = (kind) => Object.keys(data).filter((p) => p.startsWith('adminAlerts/') && data[p].kind === kind).map((p) => data[p]);

(async () => {
  console.log('\nFINANCIAL PARTNER — application → financialProviders/{uid}\n');

  console.log('  [vocabulary]');
  ck('V1  financial_partner is a canonical role', VOCAB.isCanonicalRole('financial_partner') && VOCAB.normalizeRole(' Financial_Partner ') === 'financial_partner');
  ck('V2  CONTROL an unmapped role is not canonical', VOCAB.normalizeRole('banker') === null);

  console.log('\n  [approve]');
  put('f1', 'u_f1'); decide('f1', 'approved', 'admin1');
  const e1 = await fire('f1');
  const d1 = listing('u_f1') || {};
  ck('F1  a valid BANK application with a server decision IS listed, listingStatus approved', !e1 && d1.listingStatus === 'approved' && d1.institutionType === 'BANK', e1 || d1.listingStatus);
  ck('F1b the public doc carries EXACTLY the allowlisted keys present', Object.keys(d1).every((k) => FPL.PUBLIC_KEYS.includes(k)), Object.keys(d1).filter((k) => !FPL.PUBLIC_KEYS.includes(k)));
  const PERSONAL = ['fullName', 'nationalId', 'kraPin', 'email', 'phone', 'agreementAcceptedAt', 'internalNotes', 'requestedRole', 'category', 'categoryLabel', 'location', 'status', 'decidedBy'];
  ck('F9  no personal, agreement or internal field is on the public doc', PERSONAL.every((k) => !(k in d1)), PERSONAL.filter((k) => k in d1));
  ck('F1c services: unknown dropped, duplicates collapsed, case normalised', JSON.stringify(d1.services) === JSON.stringify(['BUSINESS_BANKING', 'LOANS']), d1.services);
  ck('F1d description is plain text, markup and newlines removed', d1.description === 'Business accounts and loans for SMEs.', d1.description);
  ck('F1e county canonicalised; phone E.164; email lower-cased; https website kept',
     d1.county === 'Nairobi' && d1.businessPhone === '+254712345678' && d1.businessEmail === 'partners@mfano.example.co.ke' && d1.website === 'https://mfano.example.co.ke/', d1);
  ck('F5  licenceClaimed stored as self-declared text, licenceVerified false, verifiedBy = admin review of the LISTING',
     d1.licenceClaimed === 'CBK/123/2024' && d1.licenceVerified === false && d1.verifiedBy === 'sokoni_admin_review', d1);
  ck('F1f the listing names its application and its uid', d1.applicationId === 'f1' && d1.uid === 'u_f1');
  const u1 = data['users/u_f1'] || {};
  ck('F10 ROLE_KEY maps financial_partner: users.roles + claim set on approve', (u1.roles || []).includes('financial_partner') && CLAIMS.u_f1 && CLAIMS.u_f1.financial_partner === true, { roles: u1.roles, claims: CLAIMS.u_f1 });
  ck('F14 a financial partner is NOT filed in the services directory', !data['providers/u_f1'] && !Object.keys(data).some((p) => p.startsWith('providers/') && data[p].ownerUid === 'u_f1'));
  ck('F1g the application records the projection as applied', app('f1').projectionStatus === 'applied', app('f1').projectionStatus);

  console.log('\n  [applicant-written verification is ignored]');
  put('f5', 'u_f5', { licenceVerified: true, verifiedBy: 'CBK', listingStatus: 'featured' }); decide('f5', 'approved', 'admin1');
  await fire('f5');
  const d5 = listing('u_f5') || {};
  ck('F5b applicant writes licenceVerified:true / verifiedBy:CBK / listingStatus:featured → ignored', d5.licenceVerified === false && d5.verifiedBy === 'sokoni_admin_review' && d5.listingStatus === 'approved', d5);

  console.log('\n  [refused, nothing provisioned]');
  put('f2', 'u_f2', { institutionType: 'CASINO', category: 'CASINO' }); decide('f2', 'approved', 'admin1');
  await fire('f2');
  ck('F2  unknown institutionType → NOT listed, reason recorded, no fallback to OTHER',
     !listing('u_f2') && app('f2').projectionStatus === 'blocked_invalid_profile' && /institutionType/.test(app('f2').projectionError || ''), app('f2').projectionError);
  ck('F2b ... and no role and no claim were granted', !(data['users/u_f2'] || {}).roles && !(CLAIMS.u_f2 && CLAIMS.u_f2.financial_partner), { user: data['users/u_f2'], claims: CLAIMS.u_f2 });
  ck('F2c ... and an admin alert names it', alerts('application_profile_invalid').some((a) => a.appId === 'f2'));
  put('f3', 'u_f3', { services: ['GAMBLING', 'crypto'] }); decide('f3', 'approved', 'admin1');
  await fire('f3');
  ck('F3  services all unknown → refused', !listing('u_f3') && app('f3').projectionStatus === 'blocked_invalid_profile' && /services/.test(app('f3').projectionError || ''), app('f3').projectionError);
  put('f12', 'u_f12', { institutionName: 'X' }); decide('f12', 'approved', 'admin1');
  await fire('f12');
  ck('F12 an institution name under 2 characters → refused', !listing('u_f12') && app('f12').projectionStatus === 'blocked_invalid_profile');

  console.log('\n  [invalid optional fields are dropped, never "fixed"]');
  put('f4', 'u_f4', { website: 'javascript:alert(1)', businessEmail: 'not-an-email', businessPhone: '12345', county: 'Atlantis' }); decide('f4', 'approved', 'admin1');
  await fire('f4');
  const d4 = listing('u_f4') || {};
  const r4 = (app('f4').projectionReceipt || []).find((w) => w && w.collection === 'financialProviders') || {};
  ck('F4  website javascript: → dropped; bad email / phone / county → dropped', d4.listingStatus === 'approved' && !('website' in d4) && !('businessEmail' in d4) && !('businessPhone' in d4) && !('county' in d4), d4);
  ck('F4b ... and the receipt names what was dropped for the reviewer', JSON.stringify((r4.dropped || []).slice().sort()) === JSON.stringify(['businessEmail', 'businessPhone', 'county', 'website']), r4);
  for (const bad of ['http://mfano.example.co.ke', 'data:text/html,hi', 'https://user:pw@mfano.example.co.ke', 'https://localhost', 'https://a b.com']) {
    ck('F4c website rejected: ' + bad, FPL._v.website(bad) === null);
  }

  console.log('\n  [K13: an applicant cannot approve themselves]');
  put('f6', 'u_f6', { status: 'approved', decidedBy: 'admin1' });
  await fire('f6');
  ck('F6  applicant-written status:approved + decidedBy with NO server record → NOT listed', !listing('u_f6') && !(CLAIMS.u_f6 && CLAIMS.u_f6.financial_partner), app('f6').projectionStatus);

  console.log('\n  [pending]');
  put('f10', 'u_f10');
  const w10 = WRITES.length; await fire('f10');
  ck('F10b a pending application lists nothing and grants no claim', !listing('u_f10') && !(CLAIMS.u_f10 && CLAIMS.u_f10.financial_partner) && !WRITES.slice(w10).includes('financialProviders/u_f10'));

  console.log('\n  [revoke, then re-approve]');
  decide('f1', 'suspended', 'admin1');
  await fire('f1');
  const d7 = listing('u_f1');
  ck('F7  revoke → listingStatus withdrawn, document KEPT', !!d7 && d7.listingStatus === 'withdrawn' && d7.name === 'Mfano Bank Limited', d7 && d7.listingStatus);
  ck('F7b ... and the claim and role are withdrawn', CLAIMS.u_f1.financial_partner === false && !((data['users/u_f1'] || {}).roles || []).includes('financial_partner'), CLAIMS.u_f1);
  decide('f1', 'approved', 'admin1');
  await fire('f1');
  const d8 = JSON.parse(JSON.stringify(listing('u_f1') || {}));
  ck('F8  re-approve → approved again', d8.listingStatus === 'approved' && CLAIMS.u_f1.financial_partner === true, d8.listingStatus);
  const w8 = WRITES.length; await fire('f1');
  ck('F8b a retried trigger for the same decision writes nothing (idempotent)', WRITES.length === w8 && JSON.stringify(listing('u_f1')) === JSON.stringify(d8), WRITES.slice(w8));
  /* A field that is valid on the first listing and invalid on the next approval must not linger (full replace). */
  decide('f1', 'suspended', 'admin1'); await fire('f1');
  data['applications/f1'].website = 'javascript:void(0)';
  decide('f1', 'approved', 'admin1'); await fire('f1');
  ck('F8c re-approval with a now-invalid website leaves NO stale website on the listing', (listing('u_f1') || {}).listingStatus === 'approved' && !('website' in (listing('u_f1') || {})), listing('u_f1'));
  put('f7n', 'u_f7n'); decide('f7n', 'rejected', 'admin1');
  await fire('f7n');
  ck('F7c rejecting an application that was never listed creates NO listing', !listing('u_f7n'));

  console.log('\n  [control: an unmapped role is quarantined]');
  put('f11', 'u_f11', { requestedRole: 'banker' }); decide('f11', 'approved', 'admin1');
  await fire('f11');
  ck('F11 requestedRole "banker" → blocked_unknown_role, nothing listed', app('f11').projectionStatus === 'blocked_unknown_role' && !listing('u_f11'), app('f11').projectionStatus);

  console.log('\n  [the shared validator]');
  const v = FPL.validateDescriptive({ services: ['TAX'], website: 'https://ok.example.com', name: 'ignored', institutionType: 'BANK', listingStatus: 'approved' });
  ck('S1  validateDescriptive returns only editable fields (never name / type / status)', v.ok && Object.keys(v.fields).every((k) => FPL.EDITABLE_KEYS.includes(k)), v.fields);
  ck('S2  every editable key is a public key', FPL.EDITABLE_KEYS.every((k) => FPL.PUBLIC_KEYS.includes(k)));
  ck('S3  47 counties', FPL.COUNTIES.length === 47 && new Set(FPL.COUNTIES).size === 47);
  ck('S4  the original ten types keep their positions (append-only)', JSON.stringify(FPL.INSTITUTION_TYPES.slice(0, 10)) === JSON.stringify(['BANK', 'SACCO', 'ACCOUNTANT', 'FINANCIAL_ADVISER', 'INSURER', 'MICROFINANCE', 'INVESTMENT', 'FOREX', 'CHAMA', 'OTHER']));
  ck('S5  DIGITAL_LENDER / PAYMENT_PROVIDER / BUSINESS_FINANCE are listable', ['DIGITAL_LENDER', 'PAYMENT_PROVIDER', 'BUSINESS_FINANCE'].every((t) => FPL.buildListing(Object.assign({}, VALID, { institutionType: t, services: ['DIGITAL_LOANS', 'MOBILE_MONEY'] }), 'u', 'a').ok));
  ck('S6  the original fourteen services keep their positions; DIGITAL_LOANS and MOBILE_MONEY appended', FPL.SERVICES.length === 16 && FPL.SERVICES[13] === 'MICROFINANCE' && FPL.SERVICES[14] === 'DIGITAL_LOANS' && FPL.SERVICES[15] === 'MOBILE_MONEY');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
