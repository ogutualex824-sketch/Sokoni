/* ============================================================================
   SOKONI — Financial Partner Workspace (2026-10-01)
   ----------------------------------------------------------------------------
   The dashboard an APPROVED financial partner lands on: banks, SACCOs, chamas, microfinance,
   insurers, forex bureaus and accountants. One callable, `financialPartnerDispatch`, with an `op`.

   AUTHORITY
   * Who is a partner is decided ELSEWHERE: the approval lifecycle (sokoni-27's financial_partner
     slice) writes financialProviders/{uid} with listingStatus. This module only READS that doc and
     never writes it — one writer per document. A partner is served only while listingStatus is
     'approved'; suspension or removal there closes this workspace on the next call.
   * Everything this module writes lives under financialPartners/{partnerUid}/**, the staff index
     financialPartnerStaff/{staffUid} and financialEnquiries/{id}. Client SDK access to all three is
     DENIED by rules (no match = deny); the callable is the only door.
   * Registration (licence) details are SELF-DECLARED until an administrator reviews them. The
     partner can move them to 'under_review' only; 'verified' / 'rejected' are admin-only.

   ROLES (inside one partner)
     owner   — the approved account itself: everything
     manager — everything except team and registration
     officer — members (list / add / edit, never delete) and enquiries

   DATA MINIMISATION: a member/client record holds name, phone, member number, joined date, status
   and a short note. No national ID, no date of birth, no balances. The partner must attest that the
   member consented to being recorded; the attestation is stored with the record.

   COUNTS: real Firestore count() aggregates. A count that cannot be read is returned as null so the
   page renders '—', never 0.
   ============================================================================ */
'use strict';
const crypto = require('crypto');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();
const db = () => admin.firestore();
const lim = require('./shared/durable-limit');
const FPL = require('./financial-partner-listing');
const COM = require('./commercial-entitlements');   /* the ONE price/plan configuration */
/* ── Public trust markers (owner decision 2026-10-01) ─────────────────────────────────────────
   "Registration reviewed by SOKONI" ⇐ ONLY an admin-approved registration review (never self-declared fields,
   never payment). A licence is a SEPARATE fact: shown as verified only when an admin recorded an independent
   check against the issuing authority's register, with the source; a past expiry shows as expired. Both are
   exposed ONLY while the listing is approved (callers already require that). */
const REVIEW_BADGE = Object.freeze({ label: 'Registration reviewed by SOKONI',
  tooltip: 'SOKONI has reviewed the registration information submitted to the platform. This marker is not a government licence, professional certification, or regulatory approval.' });
const regApproved = (r) => !!r && (r.status === 'approved' || r.status === 'verified');   /* 'verified' = legacy name */
function licencePublic(l, nowMs = Date.now()) {
  if (!l || l.verificationStatus !== 'verified_against_register') return null;
  const exp = l.expiryDate ? Date.parse(l.expiryDate + 'T23:59:59Z') : null;
  const expired = exp != null && exp < nowMs;
  return { status: expired ? 'expired' : 'verified_against_register', licenceType: l.licenceType || null, issuingAuthority: l.issuingAuthority,
    expiryDate: l.expiryDate || null, checkedAt: ms(l.verifiedAt), source: l.verificationSource };
}
function trustMarkers(w) {
  const reg = (w && w.registration) || {};
  return { registrationReviewed: regApproved(reg), reviewBadge: regApproved(reg) ? REVIEW_BADGE : null, licenceVerification: licencePublic(w && w.licence) };
}
async function planOf(partnerUid) {
  try { const e = await db().collection('entitlements').doc(partnerUid + '__partner').get(); return COM.effectivePlan(e.exists ? e.data() : null); }
  catch (_) { return COM.effectivePlan(null); }
}   /* the ONE validator for financialProviders/{uid} */

const OPTS = { region: 'us-central1', enforceAppCheck: true, timeoutSeconds: 60, memory: '256MiB', minInstances: 0 };

/* ── Category model: the server decides which tools each kind of institution gets ───────────
   Keyed by the ONE institution-type enum, financial-partner-listing.js INSTITUTION_TYPES (sokoni-27,
   written by the approval lifecycle). A type added there without a row here gets the generic set. */
const FULL = ['overview', 'registration', 'members', 'products', 'enquiries', 'promote', 'team', 'profile'];
const CATEGORIES = {
  BANK: { label: 'Bank', regulators: ['Central Bank of Kenya (CBK)'], modules: FULL, memberLabel: 'Clients', productLabel: 'Products',
    productKinds: ['account', 'savings', 'loan', 'mortgage', 'card', 'business_banking', 'other'] },
  SACCO: { label: 'SACCO', regulators: ['SASRA', 'Commissioner for Co-operative Development'], modules: FULL, memberLabel: 'Members', productLabel: 'Products',
    productKinds: ['savings', 'loan', 'share_capital', 'fixed_deposit', 'other'] },
  CHAMA: { label: 'Chama', regulators: ['Registrar of Societies', 'State Department for Social Protection', 'Not yet registered'], modules: FULL, memberLabel: 'Members', productLabel: 'Plans',
    productKinds: ['contribution_plan', 'merry_go_round', 'investment', 'table_banking', 'welfare', 'other'] },
  MICROFINANCE: { label: 'Microfinance', regulators: ['Central Bank of Kenya (CBK) — MFB', 'Central Bank of Kenya (CBK) — DCP'], modules: FULL, memberLabel: 'Clients', productLabel: 'Products',
    productKinds: ['loan', 'group_loan', 'savings', 'asset_finance', 'other'] },
  INSURER: { label: 'Insurer', regulators: ['Insurance Regulatory Authority (IRA)'], modules: FULL, memberLabel: 'Policyholders', productLabel: 'Policies',
    productKinds: ['motor', 'health', 'life', 'property', 'travel', 'business', 'other'] },
  FOREX: { label: 'Forex bureau', regulators: ['Central Bank of Kenya (CBK)'], modules: ['overview', 'registration', 'products', 'enquiries', 'promote', 'team', 'profile'], memberLabel: 'Clients', productLabel: 'Rates',
    productKinds: ['rate'] },
  ACCOUNTANT: { label: 'Accountant', regulators: ['ICPAK', 'KRA (tax agent)'], modules: FULL, memberLabel: 'Clients', productLabel: 'Services',
    productKinds: ['bookkeeping', 'tax_filing', 'audit', 'payroll', 'advisory', 'other'] },
  FINANCIAL_ADVISER: { label: 'Financial adviser', regulators: ['Capital Markets Authority (CMA)', 'Insurance Regulatory Authority (IRA)', 'Not regulated'], modules: FULL, memberLabel: 'Clients', productLabel: 'Services',
    productKinds: ['financial_planning', 'investment_advice', 'retirement_planning', 'insurance_advice', 'other'] },
  INVESTMENT: { label: 'Investment firm', regulators: ['Capital Markets Authority (CMA)', 'Retirement Benefits Authority (RBA)'], modules: FULL, memberLabel: 'Clients', productLabel: 'Products',
    productKinds: ['money_market_fund', 'unit_trust', 'bond', 'equity', 'pension', 'other'] },
  /* Digital credit providers need a CBK licence; the listing never implies one (licenceVerified stays false). */
  DIGITAL_LENDER: { label: 'Digital lender', regulators: ['Central Bank of Kenya (CBK) — Digital Credit Provider', 'Not yet licensed'], modules: FULL, memberLabel: 'Borrowers', productLabel: 'Loan products',
    productKinds: ['personal_loan', 'business_loan', 'salary_advance', 'asset_finance', 'other'] },
  PAYMENT_PROVIDER: { label: 'Payment / M-Pesa business services', regulators: ['Central Bank of Kenya (CBK) — Payment Service Provider', 'Safaricom M-PESA agent / aggregator', 'Other'], modules: FULL, memberLabel: 'Merchants', productLabel: 'Services',
    productKinds: ['paybill_setup', 'till_setup', 'payment_gateway', 'bulk_payments', 'agent_services', 'other'] },
  BUSINESS_FINANCE: { label: 'Business loans / merchant finance', regulators: ['Central Bank of Kenya (CBK)', 'Capital Markets Authority (CMA)', 'Not regulated'], modules: FULL, memberLabel: 'Clients', productLabel: 'Finance products',
    productKinds: ['working_capital', 'invoice_finance', 'asset_finance', 'merchant_cash_advance', 'trade_finance', 'other'] },
  OTHER: { label: 'Financial services', regulators: ['Other regulator', 'Not regulated'], modules: FULL, memberLabel: 'Clients', productLabel: 'Services',
    productKinds: ['service', 'other'] },
};
const ROLE_OPS = {
  owner: '*',
  manager: ['getWorkspace', 'updateProfile', 'listMembers', 'addMember', 'importMembers', 'updateMember', 'deleteMember',
    'listProducts', 'saveProduct', 'listEnquiries', 'updateEnquiry', 'listTeam', 'requestPromotion', 'listMyPromotions', 'getCommercial'],
  officer: ['getWorkspace', 'listMembers', 'addMember', 'updateMember', 'listEnquiries', 'updateEnquiry'],
};

/* ── Validation helpers ─────────────────────────────────────────────────────────────────────── */
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const bad = (m) => { throw new HttpsError('invalid-argument', m); };
const str = (v, max, label, { required = false, re = null } = {}) => {
  if (v == null || v === '') { if (required) bad(label + ' is required.'); return null; }
  if (typeof v !== 'string') bad(label + ' must be text.');
  const s = v.replace(/[\u0000-\u001f\u007f<>]/g, '').trim();   /* no control chars, no markup */
  if (!s) { if (required) bad(label + ' is required.'); return null; }
  if (s.length > max) bad(label + ' is too long (max ' + max + ').');
  if (re && !re.test(s)) bad(label + ' has an invalid format.');
  return s;
};
const oneOf = (v, list, label) => { if (!list.includes(v)) bad('Invalid ' + label + '.'); return v; };
function kePhone(v) {
  const d = String(v || '').replace(/[\s()-]/g, '');
  let m;
  if ((m = /^(?:\+?254|0)([17]\d{8})$/.exec(d))) return '254' + m[1];
  bad('Enter a valid Kenyan phone number (07…, 01… or +254…).');
}
const isoDate = (v, label) => {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(Date.parse(v + 'T00:00:00Z'))) bad(label + ' must be a date (YYYY-MM-DD).');
  return v;
};
const num = (v, label, { min = 0, max = 1e9 } = {}) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) bad(label + ' is out of range.');
  return Math.round(n * 10000) / 10000;
};
const ms = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : (typeof v === 'number' ? v : null));
const ts = () => admin.firestore.FieldValue.serverTimestamp();
const memberId = (partnerUid, phone) => 'p_' + crypto.createHash('sha256').update(partnerUid + '|' + phone).digest('hex').slice(0, 28);
const isAdmin = (req) => { const t = (req.auth && req.auth.token) || {}; return !!req.auth && (t.admin === true || t.role === 'admin' || t.role === 'super_admin'); };

/* ── Who is calling, for which partner, with which role ─────────────────────────────────────── */
async function context(uid) {
  const store = db();
  let partnerUid = uid, role = 'owner';
  let prov = await store.collection('financialProviders').doc(uid).get();
  if (!prov.exists) {
    const staff = await store.collection('financialPartnerStaff').doc(uid).get();
    if (!staff.exists) throw new HttpsError('permission-denied', 'This workspace is for approved financial partners. Apply to be listed first.', { code: 'NOT_A_PARTNER' });
    const s = staff.data();
    partnerUid = s.partnerUid; role = s.role === 'manager' ? 'manager' : 'officer';
    prov = await store.collection('financialProviders').doc(partnerUid).get();
  }
  const p = prov.exists ? prov.data() : null;
  if (!p || p.listingStatus !== 'approved') {
    throw new HttpsError('permission-denied', 'This partner listing is not approved right now.', { code: 'PARTNER_NOT_APPROVED', listingStatus: p ? p.listingStatus || null : null });
  }
  const type = FPL._v.institutionType(p.institutionType);
  if (!type) throw new HttpsError('failed-precondition', 'This listing has no recognised institution type. Contact SOKONI support.', { code: 'UNKNOWN_CATEGORY' });
  const category = CATEGORIES[type] ? type : 'OTHER';
  return { uid, partnerUid, role, provider: p, category, cfg: CATEGORIES[category], ref: store.collection('financialPartners').doc(partnerUid) };
}
function allow(ctx, op) {
  const ops = ROLE_OPS[ctx.role];
  if (ops === '*' || ops.includes(op)) return;
  throw new HttpsError('permission-denied', 'Your role in this workspace cannot do that.', { code: 'ROLE_FORBIDDEN' });
}
const needModule = (ctx, m) => { if (!ctx.cfg.modules.includes(m)) throw new HttpsError('failed-precondition', 'Not available for ' + ctx.cfg.label + '.'); };
async function audit(ctx, op, target) {
  /* Ids and op names only — never member names or phone numbers. */
  try { await ctx.ref.collection('audit').add({ op, actorUid: ctx.uid, role: ctx.role, target: target || null, at: ts() }); }
  catch (e) { logger.warn('[financial-partner] audit write failed', { op, err: e.message }); }
}
async function count(q) { try { const s = await q.count().get(); return s.data().count; } catch (_) { return null; } }

/* ── Ops ────────────────────────────────────────────────────────────────────────────────────── */
async function getWorkspace(ctx) {
  const ws = await ctx.ref.get();
  const w = ws.exists ? ws.data() : {};
  const [members, activeMembers, products, newEnquiries] = await Promise.all([
    ctx.cfg.modules.includes('members') ? count(ctx.ref.collection('members')) : null,
    ctx.cfg.modules.includes('members') ? count(ctx.ref.collection('members').where('status', '==', 'active')) : null,
    count(ctx.ref.collection('products').where('status', '==', 'published')),
    count(db().collection('financialEnquiries').where('partnerUid', '==', ctx.partnerUid).where('status', '==', 'new')),
  ]);
  const p = ctx.provider;
  const w0 = w.profile || {};
  return {
    partnerUid: ctx.partnerUid, role: ctx.role, category: ctx.category,
    config: { label: ctx.cfg.label, modules: ctx.cfg.modules, memberLabel: ctx.cfg.memberLabel, productLabel: ctx.cfg.productLabel, productKinds: ctx.cfg.productKinds, regulators: ctx.cfg.regulators,
      services: FPL.SERVICES, counties: FPL.COUNTIES, descriptionMax: 300 },
    listing: { name: p.name || null, institutionType: p.institutionType || null, listingStatus: p.listingStatus, licenceClaimed: p.licenceClaimed || null },
    /* The directory listing's editable subset lives on financialProviders (sokoni-27's doc, EDITABLE_KEYS);
       branches and hours are workspace-only extras kept on financialPartners/{uid}. */
    profile: {
      description: p.description || '', services: Array.isArray(p.services) ? p.services : [], county: p.county || null,
      website: p.website || null, businessEmail: p.businessEmail || null, businessPhone: p.businessPhone || null,
      branches: Array.isArray(w0.branches) ? w0.branches : [], hours: w0.hours || null,
    },
    registration: w.registration || { status: 'not_submitted' },
    markers: trustMarkers(w),
    counts: { members, activeMembers, publishedProducts: products, newEnquiries },
    plan: await planOf(ctx.partnerUid).then((e) => ({ planId: e.planId, name: e.name, active: e.active, expiresAt: e.expiresAt || null, capabilities: e.capabilities, limits: e.limits })),
    analytics: await planOf(ctx.partnerUid).then(async (e) => (COM.can(e, 'analytics') ? {
      enquiries30d: await count(db().collection('financialEnquiries').where('partnerUid', '==', ctx.partnerUid).where('createdAt', '>=', admin.firestore.Timestamp.fromMillis(Date.now() - 30 * 86400000))),
    } : null)),
  };
}

async function updateProfile(ctx, d) {
  /* Listing fields go through the SAME validator the approval projection uses (financial-partner-listing.js),
     so the two writers of financialProviders/{uid} cannot drift. An invalid optional field is REFUSED and
     named — never silently dropped from what the partner believes they saved. */
  const src = {};
  for (const k of FPL.EDITABLE_KEYS) src[k] = d[k];
  if (typeof d.description === 'string' && d.description.trim().length > 300) bad('About is too long (max 300).');
  const v = FPL.validateDescriptive(src);
  if (!v.ok) bad(FPL.REASONS[v.reason] || 'Invalid profile.');
  if (v.dropped.length) {
    const names = { county: 'County', website: 'Website (https://)', businessEmail: 'Contact email', businessPhone: 'Contact phone' };
    bad('Check these fields: ' + v.dropped.map((k) => names[k] || k).join(', ') + '.');
  }
  const patch = { updatedAt: ts() };
  for (const k of FPL.EDITABLE_KEYS) {
    patch[k] = Object.prototype.hasOwnProperty.call(v.fields, k) ? v.fields[k] : admin.firestore.FieldValue.delete();
  }
  patch.description = v.fields.description || '';
  const branches = Array.isArray(d.branches) ? d.branches.slice(0, 50).map((s, i) => str(s, 80, 'Branch ' + (i + 1))).filter(Boolean) : [];
  const hours = str(d.hours, 120, 'Opening hours');
  const provRef = db().collection('financialProviders').doc(ctx.partnerUid);
  await db().runTransaction(async (tx) => {
    const s = await tx.get(provRef);
    /* re-check inside the transaction: a withdrawal between context() and now wins */
    if (!s.exists || s.data().listingStatus !== 'approved') throw new HttpsError('permission-denied', 'This partner listing is not approved right now.', { code: 'PARTNER_NOT_APPROVED' });
    tx.update(provRef, patch);
    tx.set(ctx.ref, { partnerUid: ctx.partnerUid, profile: { branches, hours, updatedAt: ts(), updatedBy: ctx.uid } }, { merge: true });
  });
  await audit(ctx, 'updateProfile');
  return { ok: true };
}

async function submitRegistration(ctx, d) {
  const cur = ((await ctx.ref.get()).data() || {}).registration;
  if (cur && (cur.status === 'under_review' || regApproved(cur))) throw new HttpsError('failed-precondition', cur.status === 'under_review' ? 'Your registration is already being reviewed.' : 'Your registration was approved. Contact SOKONI support to change it.');
  const regulator = oneOf(d.regulator, ctx.cfg.regulators, 'regulator');
  const unregistered = regulator === 'Not yet registered';
  const registration = {
    regulator,
    registeredName: str(d.registeredName, 120, 'Registered name', { required: true }),
    registrationNumber: unregistered ? null : str(d.registrationNumber, 40, 'Registration / licence number', { required: true, re: /^[A-Za-z0-9/.\- ]+$/ }),
    kraPin: str(d.kraPin, 11, 'KRA PIN', { re: /^[AP]\d{9}[A-Z]$/i }),
    validUntil: isoDate(d.validUntil, 'Valid until'),
    licenceClaim: d.licenceNumber ? { licenceType: str(d.licenceType, 60, 'Licence type'), licenceNumber: str(d.licenceNumber, 40, 'Licence number', { re: /^[A-Za-z0-9/.\- ]+$/ }),
      issuingAuthority: str(d.issuingAuthority, 80, 'Issuing authority', { required: true }), expiryDate: isoDate(d.licenceExpiry, 'Licence expiry') } : null,
    status: 'under_review',          /* never 'approved' from here — admin-only */
    submittedAt: ts(), submittedBy: ctx.uid,
    reviewedAt: null, reviewedBy: null, reviewNote: null,
  };
  if (registration.kraPin) registration.kraPin = registration.kraPin.toUpperCase();
  await ctx.ref.set({ partnerUid: ctx.partnerUid, registration }, { merge: true });
  await audit(ctx, 'submitRegistration');
  return { ok: true, status: 'under_review' };
}

function memberRow(doc) {
  const m = doc.data();
  return { id: doc.id, name: m.name, phone: m.phone, memberNo: m.memberNo || null, joinedOn: m.joinedOn || null, status: m.status, note: m.note || null, createdAt: ms(m.createdAt) };
}
async function listMembers(ctx, d) {
  needModule(ctx, 'members');
  const col = ctx.ref.collection('members');
  if (d.phone) { const s = await col.doc(memberId(ctx.partnerUid, kePhone(d.phone))).get(); return { rows: s.exists ? [memberRow(s)] : [], next: null }; }
  if (d.memberNo) { const s = await col.where('memberNo', '==', str(d.memberNo, 40, 'Member number')).limit(5).get(); return { rows: s.docs.map(memberRow), next: null }; }
  let q = col;
  if (d.status) q = q.where('status', '==', oneOf(d.status, ['active', 'suspended', 'exited'], 'status'));
  q = q.orderBy('createdAt', 'desc').limit(50);
  if (d.cursor) { if (!ID_RE.test(d.cursor)) bad('Invalid cursor.'); const c = await col.doc(d.cursor).get(); if (c.exists) q = q.startAfter(c); }
  const s = await q.get();
  return { rows: s.docs.map(memberRow), next: s.docs.length === 50 ? s.docs[s.docs.length - 1].id : null };
}
function memberFields(d) {
  if (d.consentAttested !== true) bad('Confirm the member agreed to be recorded on SOKONI.');
  return {
    name: str(d.name, 100, 'Name', { required: true }),
    phone: kePhone(d.phone),
    memberNo: str(d.memberNo, 40, 'Member number', { re: /^[A-Za-z0-9/.\- ]+$/ }),
    joinedOn: isoDate(d.joinedOn, 'Joined on'),
    note: str(d.note, 200, 'Note'),
  };
}
async function addMember(ctx, d) {
  needModule(ctx, 'members');
  const f = memberFields(d);
  const id = memberId(ctx.partnerUid, f.phone);
  try {
    /* create(), never get()+set(): the phone number is the one unique key per partner. */
    await ctx.ref.collection('members').doc(id).create({ ...f, status: 'active', consentAttested: true, consentAttestedBy: ctx.uid, createdAt: ts(), createdBy: ctx.uid, updatedAt: ts() });
  } catch (e) {
    if (e.code === 6 || /already exists/i.test(e.message || '')) throw new HttpsError('already-exists', 'Someone with that phone number is already on your register.', { code: 'DUPLICATE_MEMBER', id });
    throw e;
  }
  await audit(ctx, 'addMember', id);
  return { ok: true, id };
}
async function importMembers(ctx, d) {
  needModule(ctx, 'members');
  if (!Array.isArray(d.rows) || !d.rows.length) bad('No rows to import.');
  if (d.rows.length > 200) bad('Import at most 200 rows at a time.');
  if (d.consentAttested !== true) bad('Confirm every member agreed to be recorded on SOKONI.');
  const results = [];
  for (let i = 0; i < d.rows.length; i++) {
    const r = d.rows[i] || {};
    try {
      const f = memberFields({ ...r, consentAttested: true });
      const id = memberId(ctx.partnerUid, f.phone);
      await ctx.ref.collection('members').doc(id).create({ ...f, status: 'active', consentAttested: true, consentAttestedBy: ctx.uid, createdAt: ts(), createdBy: ctx.uid, updatedAt: ts(), importedAt: ts() });
      results.push({ row: i + 1, ok: true });
    } catch (e) {
      const dup = e.code === 6 || /already exists/i.test(e.message || '');
      results.push({ row: i + 1, ok: false, reason: dup ? 'Already on your register' : (e instanceof HttpsError ? e.message : 'Could not save') });
    }
  }
  const added = results.filter((r) => r.ok).length;
  await audit(ctx, 'importMembers', String(added) + '/' + d.rows.length);
  return { added, failed: results.length - added, results };
}
async function updateMember(ctx, d) {
  needModule(ctx, 'members');
  if (!ID_RE.test(d.id || '')) bad('Invalid member.');
  const ref = ctx.ref.collection('members').doc(d.id);
  const patch = { updatedAt: ts(), updatedBy: ctx.uid };
  if (d.name !== undefined) patch.name = str(d.name, 100, 'Name', { required: true });
  if (d.memberNo !== undefined) patch.memberNo = str(d.memberNo, 40, 'Member number', { re: /^[A-Za-z0-9/.\- ]+$/ });
  if (d.joinedOn !== undefined) patch.joinedOn = isoDate(d.joinedOn, 'Joined on');
  if (d.note !== undefined) patch.note = str(d.note, 200, 'Note');
  if (d.status !== undefined) patch.status = oneOf(d.status, ['active', 'suspended', 'exited'], 'status');
  /* the phone is the record's identity — changing it is remove + add, so history stays honest */
  await db().runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists) throw new HttpsError('not-found', 'That member is not on your register.');
    tx.update(ref, patch);
  });
  await audit(ctx, 'updateMember', d.id);
  return { ok: true };
}
async function deleteMember(ctx, d) {
  needModule(ctx, 'members');
  if (!ID_RE.test(d.id || '')) bad('Invalid member.');
  const ref = ctx.ref.collection('members').doc(d.id);
  const s = await ref.get();
  if (!s.exists) throw new HttpsError('not-found', 'That member is not on your register.');
  await ref.delete();   /* a member's right to erasure: the record goes; the audit keeps only the id */
  await audit(ctx, 'deleteMember', d.id);
  return { ok: true };
}

function productRow(doc) {
  const p = doc.data();
  return { id: doc.id, name: p.name, kind: p.kind, description: p.description || null, rateText: p.rateText || null, buy: p.buy ?? null, sell: p.sell ?? null, currency: p.currency || null, minAmount: p.minAmount ?? null, status: p.status, updatedAt: ms(p.updatedAt) };
}
async function listProducts(ctx) {
  const s = await ctx.ref.collection('products').orderBy('updatedAt', 'desc').limit(100).get();
  return { rows: s.docs.map(productRow) };
}
async function saveProduct(ctx, d) {
  const kind = oneOf(d.kind, ctx.cfg.productKinds, 'type');
  const isRate = kind === 'rate';
  const f = {
    name: str(d.name, 80, 'Name', { required: true }),
    kind,
    description: str(d.description, 600, 'Description'),
    rateText: isRate ? null : str(d.rateText, 60, 'Rate / price'),
    currency: isRate ? str(d.currency, 3, 'Currency', { required: true, re: /^[A-Z]{3}$/ }) : null,
    buy: isRate ? num(d.buy, 'Buy rate', { min: 0, max: 1e6 }) : null,
    sell: isRate ? num(d.sell, 'Sell rate', { min: 0, max: 1e6 }) : null,
    minAmount: isRate ? null : num(d.minAmount, 'Minimum amount', { min: 0, max: 1e9 }),
    status: oneOf(d.status || 'draft', ['draft', 'published', 'archived'], 'status'),
    updatedAt: ts(), updatedBy: ctx.uid,
  };
  if (isRate && (f.buy == null || f.sell == null)) bad('Enter both buy and sell rates.');
  const col = ctx.ref.collection('products');
  let id = d.id;
  if (id) {
    if (!ID_RE.test(id)) bad('Invalid product.');
    await db().runTransaction(async (tx) => {
      const s = await tx.get(col.doc(id));
      if (!s.exists) throw new HttpsError('not-found', 'That item no longer exists.');
      tx.update(col.doc(id), f);
    });
  } else {
    const n = await count(col);
    if (n == null) throw new HttpsError('unavailable', 'Could not check your catalogue size. Try again.');
    const lim = (await planOf(ctx.partnerUid)).limits || COM.BASE.limits;
    if (n >= lim.maxProducts) bad('Your plan allows ' + lim.maxProducts + ' items. Archive one or upgrade your plan.');
    const ref = col.doc();
    await ref.create({ ...f, createdAt: ts(), createdBy: ctx.uid });
    id = ref.id;
  }
  await audit(ctx, 'saveProduct', id);
  return { ok: true, id };
}

async function listEnquiries(ctx, d) {
  let q = db().collection('financialEnquiries').where('partnerUid', '==', ctx.partnerUid);
  if (d.status) q = q.where('status', '==', oneOf(d.status, ['new', 'contacted', 'closed'], 'status'));
  q = q.orderBy('createdAt', 'desc').limit(50);
  const s = await q.get();
  return { rows: s.docs.map((doc) => { const e = doc.data(); return { id: doc.id, name: e.name, phone: e.phone, topic: e.topic, message: e.message, status: e.status, createdAt: ms(e.createdAt) }; }) };
}
async function updateEnquiry(ctx, d) {
  if (!ID_RE.test(d.id || '')) bad('Invalid enquiry.');
  const status = oneOf(d.status, ['new', 'contacted', 'closed'], 'status');
  const ref = db().collection('financialEnquiries').doc(d.id);
  await db().runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists || s.data().partnerUid !== ctx.partnerUid) throw new HttpsError('not-found', 'Enquiry not found.');
    tx.update(ref, { status, updatedAt: ts(), updatedBy: ctx.uid });
  });
  await audit(ctx, 'updateEnquiry', d.id);
  return { ok: true };
}

async function listTeam(ctx) {
  const s = await ctx.ref.collection('team').limit(50).get();
  return { rows: s.docs.map((doc) => { const t = doc.data(); return { uid: doc.id, email: t.email, role: t.role, addedAt: ms(t.addedAt) }; }) };
}
async function addTeamMember(ctx, d, req) {
  const email = str(d.email, 120, 'Email', { required: true, re: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ }).toLowerCase();
  const role = oneOf(d.role, ['manager', 'officer'], 'role');
  await lim.limit(db(), admin, { bucket: 'fpTeamAdd', key: lim.sha(ctx.partnerUid).slice(0, 32), max: 20, windowSec: 86400 });
  let user;
  try { user = await admin.auth().getUserByEmail(email); } catch (_) { user = null; }
  if (!user) throw new HttpsError('not-found', 'Ask them to create a SOKONI account with that email first.', { code: 'NO_ACCOUNT' });
  if (user.uid === ctx.partnerUid) bad('That is the owner account.');
  const teamLimit = ((await planOf(ctx.partnerUid)).limits || COM.BASE.limits).maxTeam;
  const teamNow = await count(ctx.ref.collection('team'));
  if (teamNow == null) throw new HttpsError('unavailable', 'Could not check your team size. Try again.');
  if (teamNow >= teamLimit) bad('Your plan allows ' + teamLimit + ' team member' + (teamLimit === 1 ? '' : 's') + '. Upgrade your plan to add more.');
  const store = db();
  const staffRef = store.collection('financialPartnerStaff').doc(user.uid);
  await store.runTransaction(async (tx) => {
    const s = await tx.get(staffRef);
    const own = await tx.get(store.collection('financialProviders').doc(user.uid));
    if (own.exists) throw new HttpsError('failed-precondition', 'That account is itself a financial partner.');
    if (s.exists && s.data().partnerUid !== ctx.partnerUid) throw new HttpsError('already-exists', 'That person already works for another partner on SOKONI.');
    tx.set(staffRef, { partnerUid: ctx.partnerUid, role, addedBy: ctx.uid, addedAt: ts() });
    tx.set(ctx.ref.collection('team').doc(user.uid), { email, role, addedBy: ctx.uid, addedAt: ts() });
  });
  await audit(ctx, 'addTeamMember', user.uid);
  return { ok: true, uid: user.uid };
}
async function removeTeamMember(ctx, d) {
  if (!ID_RE.test(d.uid || '')) bad('Invalid team member.');
  const store = db();
  const staffRef = store.collection('financialPartnerStaff').doc(d.uid);
  await store.runTransaction(async (tx) => {
    const s = await tx.get(staffRef);
    if (!s.exists || s.data().partnerUid !== ctx.partnerUid) throw new HttpsError('not-found', 'Not on your team.');
    tx.delete(staffRef);
    tx.delete(ctx.ref.collection('team').doc(d.uid));
  });
  await audit(ctx, 'removeTeamMember', d.uid);
  return { ok: true };
}

/* ── Public & member-of-the-public ops (no partner context) ─────────────────────────────────── */
/* Banking Hub directory: approved listings only, bounded, server-side (does not depend on client rules).
   Promotion RANKS, never vouches: a listing an admin promoted is marked promoted:true and shown first, but it
   carries the same "Listed by SOKONI" label and licence wording as every other listing. */
async function publicDirectory(req, d) {
  await lim.limit(db(), admin, { bucket: 'fpDirectory', key: lim.clientKey(req.rawRequest), max: 240, windowSec: 600 });
  const types = Array.isArray(d.types) ? [...new Set(d.types.map((t) => FPL._v.institutionType(t)).filter(Boolean))] : [];
  if (!types.length || types.length > 10) bad('Choose between 1 and 10 institution types.');
  let q = db().collection('financialProviders').where('listingStatus', '==', 'approved').where('institutionType', 'in', types).orderBy('name');
  if (d.cursor) { if (!ID_RE.test(d.cursor)) bad('Invalid cursor.'); const c = await db().collection('financialProviders').doc(d.cursor).get(); if (c.exists) q = q.startAfter(c); }
  const size = 24;
  const [snap, promo, paid] = await Promise.all([q.limit(size).get(),
    db().collection('financialPromotions').where('status', '==', 'active').limit(50).get().catch(() => null),
    db().collection('promotionCampaigns').where('status', '==', 'active').limit(100).get().catch(() => null)]);
  const nowMs = Date.now();
  const promoted = new Set(promo ? promo.docs.map((x) => x.data()).filter((x) => (ms(x.endsAt) || 0) > nowMs && (ms(x.startsAt) || 0) <= nowMs).map((x) => x.partnerUid) : []);
  const featured = new Set();
  if (paid) {
    const live = paid.docs.map((x) => x.data()).filter((c) => (ms(c.endAt) || 0) > nowMs && (ms(c.startAt) || 0) <= nowMs)
      .sort((a, b) => (ms(a.startAt) || 0) - (ms(b.startAt) || 0));
    const used = {};
    for (const c of live) {
      const cap = COM.PLACEMENT_CAPS[c.placement] || 0;
      used[c.placement] = (used[c.placement] || 0) + 1;
      if (used[c.placement] > cap) continue;   /* exposure is capped — never unlimited */
      if (c.placement === 'banking_hub_category') promoted.add(c.targetId);
      if (c.placement === 'banking_hub_featured') { featured.add(c.targetId); promoted.add(c.targetId); }
    }
  }
  const rows = snap.docs.map((doc) => { const x = doc.data(); return {
    partnerUid: doc.id, name: x.name || null, institutionType: x.institutionType, services: Array.isArray(x.services) ? x.services : [],
    county: x.county || null, website: x.website || null, description: x.description || null,
    label: 'Listed by SOKONI', licenceClaimed: x.licenceClaimed || null, promoted: promoted.has(doc.id), featured: featured.has(doc.id) }; });
  if (rows.length) {
    const wsDocs = await db().getAll(...rows.map((r) => db().collection('financialPartners').doc(r.partnerUid))).catch(() => null);
    rows.forEach((r, i) => { const w = wsDocs && wsDocs[i] && wsDocs[i].exists ? wsDocs[i].data() : null; Object.assign(r, trustMarkers(w)); });
  }
  rows.sort((a, b) => (Number(b.featured) - Number(a.featured)) || (Number(b.promoted) - Number(a.promoted)));
  return { rows, next: snap.docs.length === size ? snap.docs[snap.docs.length - 1].id : null, promotionsReadable: !!promo };
}

/* A partner may ASK to be promoted inside SOKONI (Banking Hub placement, search). No money moves here: an
   administrator decides, and a granted promotion is a dated, labelled placement (financialPromotions). Paid
   promotion needs a FULFILLABLE payment purpose and owner pricing — not built (documented). */
async function requestPromotion(ctx, d) {
  const placement = oneOf(d.placement, ['banking_hub_category', 'banking_hub_search', 'foundation_partners'], 'placement');
  const message = str(d.message, 300, 'Message');
  await lim.limit(db(), admin, { bucket: 'fpPromoReq', key: lim.sha(ctx.partnerUid).slice(0, 32), max: 3, windowSec: 7 * 86400 });
  const ref = db().collection('financialPromotionRequests').doc();
  await ref.create({ partnerUid: ctx.partnerUid, placement, message, status: 'pending', requestedBy: ctx.uid, createdAt: ts() });
  await audit(ctx, 'requestPromotion', ref.id);
  return { ok: true, id: ref.id, status: 'pending' };
}
async function getCommercial(ctx) {
  const [plan, camps] = await Promise.all([planOf(ctx.partnerUid), db().collection('promotionCampaigns').where('ownerId', '==', ctx.partnerUid).limit(20).get()]);
  return { catalogue: COM.catalogue(), plan, campaigns: camps.docs.map((x) => { const c = x.data(); return { campaignId: x.id, productId: c.productId, placement: c.placement, status: c.status, reviewReason: c.reviewReason || null, amountKES: c.amountKES, startAt: ms(c.startAt), endAt: ms(c.endAt) }; }) };
}
async function listMyPromotions(ctx) {
  const [reqs, live] = await Promise.all([
    db().collection('financialPromotionRequests').where('partnerUid', '==', ctx.partnerUid).limit(20).get(),
    db().collection('financialPromotions').where('partnerUid', '==', ctx.partnerUid).limit(20).get(),
  ]);
  return {
    requests: reqs.docs.map((x) => { const r = x.data(); return { id: x.id, placement: r.placement, status: r.status, note: r.note || null, createdAt: ms(r.createdAt) }; }),
    promotions: live.docs.map((x) => { const r = x.data(); return { id: x.id, placement: r.placement, status: r.status, startsAt: ms(r.startsAt), endsAt: ms(r.endsAt) }; }),
  };
}
async function adminListPromotionRequests(d) {
  const status = oneOf(d.status || 'pending', ['pending', 'granted', 'declined'], 'status');
  const s = await db().collection('financialPromotionRequests').where('status', '==', status).limit(100).get();
  return { rows: s.docs.map((x) => { const r = x.data(); return { id: x.id, partnerUid: r.partnerUid, placement: r.placement, message: r.message || null, status: r.status, createdAt: ms(r.createdAt) }; }) };
}
async function adminDecidePromotion(req, d) {
  if (!ID_RE.test(d.id || '')) bad('Invalid request.');
  const verdict = oneOf(d.verdict, ['granted', 'declined'], 'verdict');
  const days = verdict === 'granted' ? Number(d.days) : 0;
  if (verdict === 'granted' && !(Number.isInteger(days) && days >= 1 && days <= 90)) bad('Promote for 1 to 90 days.');
  const note = str(d.note, 300, 'Note');
  const store = db(), ref = store.collection('financialPromotionRequests').doc(d.id);
  let promoId = null;
  await store.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists || s.data().status !== 'pending') throw new HttpsError('failed-precondition', 'Already decided.');
    const r = s.data();
    const prov = await tx.get(store.collection('financialProviders').doc(r.partnerUid));
    if (verdict === 'granted' && (!prov.exists || prov.data().listingStatus !== 'approved')) throw new HttpsError('failed-precondition', 'Only an approved listing can be promoted.');
    tx.update(ref, { status: verdict, note, decidedBy: req.auth.uid, decidedAt: ts() });
    if (verdict === 'granted') {
      const pr = store.collection('financialPromotions').doc('PR_' + d.id);   /* one promotion per request */
      tx.create(pr, { partnerUid: r.partnerUid, placement: r.placement, status: 'active', paid: false, requestId: d.id,
        startsAt: admin.firestore.Timestamp.now(), endsAt: admin.firestore.Timestamp.fromMillis(Date.now() + days * 86400000), grantedBy: req.auth.uid, createdAt: ts() });
      promoId = pr.id;
    }
    tx.set(store.collection('adminActions').doc(), { type: 'financial_partner_promotion', requestId: d.id, partnerUid: r.partnerUid, verdict, days, adminUid: req.auth.uid, at: ts() });
  });
  return { ok: true, status: verdict, promotionId: promoId };
}

async function publicProfile(req, d) {
  await lim.limit(db(), admin, { bucket: 'fpPublic', key: lim.clientKey(req.rawRequest), max: 120, windowSec: 600 });
  if (!ID_RE.test(d.partnerUid || '')) bad('Invalid partner.');
  const store = db();
  const prov = await store.collection('financialProviders').doc(d.partnerUid).get();
  if (!prov.exists || prov.data().listingStatus !== 'approved') throw new HttpsError('not-found', 'This listing is not available.');
  const [ws, prods] = await Promise.all([
    store.collection('financialPartners').doc(d.partnerUid).get(),
    store.collection('financialPartners').doc(d.partnerUid).collection('products').where('status', '==', 'published').limit(100).get(),
  ]);
  const p = prov.data(), w = ws.exists ? ws.data() : {};
  const reg = w.registration || {};
  return {
    partnerUid: d.partnerUid, name: p.name || null, institutionType: p.institutionType || null, county: p.county || null,
    profile: { description: p.description || null, services: Array.isArray(p.services) ? p.services : [], county: p.county || null, website: p.website || null, businessEmail: p.businessEmail || null, businessPhone: p.businessPhone || null,
      branches: (w.profile && Array.isArray(w.profile.branches)) ? w.profile.branches : [], hours: (w.profile && w.profile.hours) || null },
    /* ALWAYS self-declared in public. An admin review is SOKONI checking paperwork, not a regulator
       (CBK/SASRA/IRA/CMA) confirming a licence; showing it publicly as 'verified' would misrepresent it.
       Whether to show a separate 'reviewed by SOKONI' marker is an OWNER decision (raised 2026-10-01). */
    registration: { status: regApproved(reg) ? 'reviewed' : 'self_declared', regulator: reg.regulator || null },
    ...trustMarkers(w),
    products: prods.docs.map(productRow),
  };
}
async function submitEnquiry(req, d) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in to contact a partner.');
  if (!ID_RE.test(d.partnerUid || '')) bad('Invalid partner.');
  if (d.partnerUid === req.auth.uid) bad('You cannot enquire with your own listing.');
  const f = {
    name: str(d.name, 100, 'Name', { required: true }),
    phone: kePhone(d.phone),
    topic: str(d.topic, 80, 'Topic', { required: true }),
    message: str(d.message, 1000, 'Message', { required: true }),
  };
  if (d.consent !== true) bad('Agree to share your contact details with this partner.');
  await lim.limit(db(), admin, { bucket: 'fpEnqUser', key: lim.sha(req.auth.uid).slice(0, 32), max: 10, windowSec: 86400 });
  await lim.limit(db(), admin, { bucket: 'fpEnqPair', key: lim.sha(req.auth.uid + '|' + d.partnerUid).slice(0, 32), max: 3, windowSec: 86400 });
  const prov = await db().collection('financialProviders').doc(d.partnerUid).get();
  if (!prov.exists || prov.data().listingStatus !== 'approved') throw new HttpsError('not-found', 'This listing is not available.');
  const ref = db().collection('financialEnquiries').doc();
  await ref.create({ ...f, partnerUid: d.partnerUid, uid: req.auth.uid, consent: true, status: 'new', createdAt: ts() });
  return { ok: true, id: ref.id };
}

/* ── Admin ops (AdminOS) ────────────────────────────────────────────────────────────────────── */
async function adminListRegistrations(d) {
  const status = oneOf(d.status || 'under_review', ['under_review', 'approved', 'verified', 'rejected', 'needs_information'], 'status');
  const s = await db().collection('financialPartners').where('registration.status', '==', status).limit(100).get();
  return { rows: s.docs.map((doc) => { const r = doc.data().registration || {}; return { partnerUid: doc.id, regulator: r.regulator, registeredName: r.registeredName, registrationNumber: r.registrationNumber, kraPin: r.kraPin || null, validUntil: r.validUntil || null, status: r.status, submittedAt: ms(r.submittedAt), reviewNote: r.reviewNote || null }; }) };
}
async function adminRecordLicenceCheck(req, d) {
  if (!ID_RE.test(d.partnerUid || '')) bad('Invalid partner.');
  const result = oneOf(d.verificationStatus, ['verified_against_register', 'not_found_on_register', 'mismatch', 'cleared'], 'result');
  const ref = db().collection('financialPartners').doc(d.partnerUid);
  let licence = null;
  if (result !== 'cleared') {
    licence = {
      licenceType: str(d.licenceType, 60, 'Licence type', { required: true }),
      licenceNumber: str(d.licenceNumber, 40, 'Licence number', { required: true, re: /^[A-Za-z0-9/.\- ]+$/ }),
      issuingAuthority: str(d.issuingAuthority, 80, 'Issuing authority', { required: true }),
      expiryDate: isoDate(d.expiryDate, 'Expiry date'),
      verificationStatus: result,
      /* WHERE it was checked — a register URL or named register + reference. Never "document uploaded". */
      verificationSource: str(d.verificationSource, 300, 'Verification source', { required: true }),
      verifiedAt: ts(), verifiedBy: req.auth.uid,
    };
    if (/upload|document|pdf|screenshot/i.test(licence.verificationSource) && !/https?:\/\//i.test(licence.verificationSource)) bad('Cite the register you checked (URL or register name + reference), not a document.');
  }
  await db().runTransaction(async (tx) => {
    const s0 = await tx.get(ref);
    if (!s0.exists) throw new HttpsError('not-found', 'Partner workspace not found.');
    tx.set(ref, { licence }, { merge: true });
    tx.set(db().collection('adminActions').doc(), { type: 'financial_partner_licence_check', partnerUid: d.partnerUid, result, authority: licence ? licence.issuingAuthority : null, adminUid: req.auth.uid, at: ts() });
  });
  return { ok: true, verificationStatus: result };
}
async function adminRevokeReview(req, d) {
  if (!ID_RE.test(d.partnerUid || '')) bad('Invalid partner.');
  const note = str(d.note, 500, 'Reason', { required: true });
  const ref = db().collection('financialPartners').doc(d.partnerUid);
  await db().runTransaction(async (tx) => {
    const s0 = await tx.get(ref);
    const r = s0.exists ? s0.data().registration : null;
    if (!regApproved(r)) throw new HttpsError('failed-precondition', 'There is no approved review to revoke.');
    tx.update(ref, { 'registration.status': 'rejected', 'registration.reviewNote': note, 'registration.revokedAt': ts(), 'registration.revokedBy': req.auth.uid });
    tx.set(db().collection('adminActions').doc(), { type: 'financial_partner_registration_review', partnerUid: d.partnerUid, verdict: 'revoked', badge: 'revoked', adminUid: req.auth.uid, at: ts() });
  });
  return { ok: true, status: 'rejected' };
}
async function adminReviewRegistration(req, d) {
  if (!ID_RE.test(d.partnerUid || '')) bad('Invalid partner.');
  const verdict0 = oneOf(d.verdict, ['approved', 'verified', 'rejected', 'needs_information'], 'verdict');
  const verdict = verdict0 === 'verified' ? 'approved' : verdict0;
  const note = str(d.note, 500, 'Note', { required: verdict !== 'approved' });
  const ref = db().collection('financialPartners').doc(d.partnerUid);
  await db().runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const r = s.exists ? s.data().registration : null;
    if (!r || r.status !== 'under_review') throw new HttpsError('failed-precondition', 'Nothing is waiting for review on this partner.');
    tx.update(ref, { 'registration.status': verdict, 'registration.reviewedAt': ts(), 'registration.reviewedBy': req.auth.uid, 'registration.reviewNote': note });
  });
  await db().collection('adminActions').add({ type: 'financial_partner_registration_review', partnerUid: d.partnerUid, verdict, badge: verdict === 'approved' ? 'granted' : 'not_granted', adminUid: req.auth.uid, at: ts() });
  logger.info('[financial-partner] registration reviewed', { partnerUid: d.partnerUid, verdict, adminUid: req.auth.uid });
  return { ok: true, status: verdict };
}

/* ── Dispatch ───────────────────────────────────────────────────────────────────────────────── */
const PARTNER_OPS = {
  getWorkspace, updateProfile, submitRegistration, listMembers, addMember, importMembers, updateMember, deleteMember,
  listProducts, saveProduct, listEnquiries, updateEnquiry, listTeam, addTeamMember, removeTeamMember,
  requestPromotion, listMyPromotions, getCommercial,
};
const OWNER_ONLY = new Set(['submitRegistration', 'addTeamMember', 'removeTeamMember']);

async function handle(req) {
  const d = (req.data && typeof req.data === 'object') ? req.data : {};
  const op = d.op;
  if (typeof op !== 'string') bad('"op" is required.');
  if (op === 'publicProfile') return publicProfile(req, d);
  if (op === 'publicDirectory') return publicDirectory(req, d);
  if (op === 'adminListCommercial' || op === 'adminStopCampaign') {
    if (!isAdmin(req)) throw new HttpsError('permission-denied', 'Administrator access required.');
    if (op === 'adminListCommercial') {
      const view = oneOf(d.view, ['entitlements', 'campaigns', 'fulfilments'], 'view');
      const col = { entitlements: 'entitlements', campaigns: 'promotionCampaigns', fulfilments: 'commercialFulfilments' }[view];
      let q = db().collection(col);
      if (d.status) q = q.where(view === 'fulfilments' ? 'outcome' : 'status', '==', str(d.status, 30, 'status'));
      const snap = await q.limit(100).get();
      return { rows: snap.docs.map((x) => { const r = x.data(); return { id: x.id, ownerId: r.ownerId || null, planId: r.planId || null, productId: r.productId || null, placement: r.placement || null,
        status: r.status || r.outcome || null, reason: r.reviewReason || r.reason || null, amountKES: r.amountKES ?? null, intentRef: r.lastPaymentRef || r.paymentIntentId || r.intentRef || null,
        startAt: ms(r.startAt || r.startedAt || r.periodStart), endAt: ms(r.endAt || r.expiresAt || r.periodEnd) }; }) };
    }
    if (!ID_RE.test(d.campaignId || '')) bad('Invalid campaign.');
    const why = str(d.reason, 300, 'Reason', { required: true });
    const ref = db().collection('promotionCampaigns').doc(d.campaignId);
    await db().runTransaction(async (tx) => {
      const s0 = await tx.get(ref);
      if (!s0.exists || !['active', 'review'].includes(s0.data().status)) throw new HttpsError('failed-precondition', 'This campaign is not running.');
      tx.update(ref, { status: 'stopped', stoppedBy: req.auth.uid, stoppedAt: ts(), stopReason: why });
      tx.set(db().collection('adminActions').doc(), { type: 'promotion_campaign_stopped', campaignId: d.campaignId, adminUid: req.auth.uid, reason: why, at: ts() });
    });
    return { ok: true, status: 'stopped', note: 'Any refund goes through the refund authority (request → approval); history is kept.' };
  }
  if (op === 'adminListPromotionRequests' || op === 'adminDecidePromotion') {
    if (!isAdmin(req)) throw new HttpsError('permission-denied', 'Administrator access required.');
    return op === 'adminListPromotionRequests' ? adminListPromotionRequests(d) : adminDecidePromotion(req, d);
  }
  if (op === 'submitEnquiry') return submitEnquiry(req, d);
  if (['adminListRegistrations', 'adminReviewRegistration', 'adminRecordLicenceCheck', 'adminRevokeReview'].includes(op)) {
    if (!isAdmin(req)) throw new HttpsError('permission-denied', 'Administrator access required.');
    if (op === 'adminListRegistrations') return adminListRegistrations(d);
    if (op === 'adminRecordLicenceCheck') return adminRecordLicenceCheck(req, d);
    if (op === 'adminRevokeReview') return adminRevokeReview(req, d);
    return adminReviewRegistration(req, d);
  }
  const fn = PARTNER_OPS[op];
  if (!fn) bad('Unknown op.');
  if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in to open your workspace.');
  const ctx = await context(req.auth.uid);
  if (OWNER_ONLY.has(op) && ctx.role !== 'owner') throw new HttpsError('permission-denied', 'Only the account owner can do that.', { code: 'ROLE_FORBIDDEN' });
  allow(ctx, op);
  if (op !== 'getWorkspace' && !op.startsWith('list')) {
    await lim.limit(db(), admin, { bucket: 'fpWrite', key: lim.sha(req.auth.uid).slice(0, 32), max: 300, windowSec: 3600 });
  }
  return fn(ctx, d, req);
}

exports.financialPartnerDispatch = onCall(OPTS, async (req) => {
  try { return await handle(req); }
  catch (e) {
    if (e instanceof HttpsError) throw e;
    logger.error('[financial-partner] unexpected', { op: req.data && req.data.op, err: e.message });
    throw new HttpsError('internal', 'Something went wrong. Please try again.');
  }
});
exports._test = { REVIEW_BADGE, licencePublic, trustMarkers, CATEGORIES, kePhone, memberId, handle };
