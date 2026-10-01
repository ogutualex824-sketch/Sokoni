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
const FPL = require('./financial-partner-listing');   /* the ONE validator for financialProviders/{uid} */

const OPTS = { region: 'us-central1', enforceAppCheck: true, timeoutSeconds: 60, memory: '256MiB', minInstances: 0 };

/* ── Category model: the server decides which tools each kind of institution gets ───────────
   Keyed by the ONE institution-type enum, financial-partner-listing.js INSTITUTION_TYPES (sokoni-27,
   written by the approval lifecycle). A type added there without a row here gets the generic set. */
const FULL = ['overview', 'registration', 'members', 'products', 'enquiries', 'team', 'profile'];
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
  FOREX: { label: 'Forex bureau', regulators: ['Central Bank of Kenya (CBK)'], modules: ['overview', 'registration', 'products', 'enquiries', 'team', 'profile'], memberLabel: 'Clients', productLabel: 'Rates',
    productKinds: ['rate'] },
  ACCOUNTANT: { label: 'Accountant', regulators: ['ICPAK', 'KRA (tax agent)'], modules: FULL, memberLabel: 'Clients', productLabel: 'Services',
    productKinds: ['bookkeeping', 'tax_filing', 'audit', 'payroll', 'advisory', 'other'] },
  FINANCIAL_ADVISER: { label: 'Financial adviser', regulators: ['Capital Markets Authority (CMA)', 'Insurance Regulatory Authority (IRA)', 'Not regulated'], modules: FULL, memberLabel: 'Clients', productLabel: 'Services',
    productKinds: ['financial_planning', 'investment_advice', 'retirement_planning', 'insurance_advice', 'other'] },
  INVESTMENT: { label: 'Investment firm', regulators: ['Capital Markets Authority (CMA)', 'Retirement Benefits Authority (RBA)'], modules: FULL, memberLabel: 'Clients', productLabel: 'Products',
    productKinds: ['money_market_fund', 'unit_trust', 'bond', 'equity', 'pension', 'other'] },
  OTHER: { label: 'Financial services', regulators: ['Other regulator', 'Not regulated'], modules: FULL, memberLabel: 'Clients', productLabel: 'Services',
    productKinds: ['service', 'other'] },
};
const ROLE_OPS = {
  owner: '*',
  manager: ['getWorkspace', 'updateProfile', 'listMembers', 'addMember', 'importMembers', 'updateMember', 'deleteMember',
    'listProducts', 'saveProduct', 'listEnquiries', 'updateEnquiry', 'listTeam'],
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
    counts: { members, activeMembers, publishedProducts: products, newEnquiries },
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
  const regulator = oneOf(d.regulator, ctx.cfg.regulators, 'regulator');
  const unregistered = regulator === 'Not yet registered';
  const registration = {
    regulator,
    registeredName: str(d.registeredName, 120, 'Registered name', { required: true }),
    registrationNumber: unregistered ? null : str(d.registrationNumber, 40, 'Registration / licence number', { required: true, re: /^[A-Za-z0-9/.\- ]+$/ }),
    kraPin: str(d.kraPin, 11, 'KRA PIN', { re: /^[AP]\d{9}[A-Z]$/i }),
    validUntil: isoDate(d.validUntil, 'Valid until'),
    status: 'under_review',          /* never 'verified' from here — admin-only */
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
    if (n >= 100) bad('You can list up to 100 items. Archive one first.');
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
    /* Only an administrator's verdict is shown as verified; everything else is self-declared. */
    registration: reg.status === 'verified' ? { status: 'verified', regulator: reg.regulator, registrationNumber: reg.registrationNumber } : { status: 'self_declared', regulator: reg.regulator || null },
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
  const status = oneOf(d.status || 'under_review', ['under_review', 'verified', 'rejected'], 'status');
  const s = await db().collection('financialPartners').where('registration.status', '==', status).limit(100).get();
  return { rows: s.docs.map((doc) => { const r = doc.data().registration || {}; return { partnerUid: doc.id, regulator: r.regulator, registeredName: r.registeredName, registrationNumber: r.registrationNumber, kraPin: r.kraPin || null, validUntil: r.validUntil || null, status: r.status, submittedAt: ms(r.submittedAt), reviewNote: r.reviewNote || null }; }) };
}
async function adminReviewRegistration(req, d) {
  if (!ID_RE.test(d.partnerUid || '')) bad('Invalid partner.');
  const verdict = oneOf(d.verdict, ['verified', 'rejected'], 'verdict');
  const note = str(d.note, 500, 'Note', { required: verdict === 'rejected' });
  const ref = db().collection('financialPartners').doc(d.partnerUid);
  await db().runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const r = s.exists ? s.data().registration : null;
    if (!r || r.status !== 'under_review') throw new HttpsError('failed-precondition', 'Nothing is waiting for review on this partner.');
    tx.update(ref, { 'registration.status': verdict, 'registration.reviewedAt': ts(), 'registration.reviewedBy': req.auth.uid, 'registration.reviewNote': note });
  });
  await db().collection('adminActions').add({ type: 'financial_partner_registration_review', partnerUid: d.partnerUid, verdict, adminUid: req.auth.uid, at: ts() });
  logger.info('[financial-partner] registration reviewed', { partnerUid: d.partnerUid, verdict, adminUid: req.auth.uid });
  return { ok: true, status: verdict };
}

/* ── Dispatch ───────────────────────────────────────────────────────────────────────────────── */
const PARTNER_OPS = {
  getWorkspace, updateProfile, submitRegistration, listMembers, addMember, importMembers, updateMember, deleteMember,
  listProducts, saveProduct, listEnquiries, updateEnquiry, listTeam, addTeamMember, removeTeamMember,
};
const OWNER_ONLY = new Set(['submitRegistration', 'addTeamMember', 'removeTeamMember']);

async function handle(req) {
  const d = (req.data && typeof req.data === 'object') ? req.data : {};
  const op = d.op;
  if (typeof op !== 'string') bad('"op" is required.');
  if (op === 'publicProfile') return publicProfile(req, d);
  if (op === 'submitEnquiry') return submitEnquiry(req, d);
  if (op === 'adminListRegistrations' || op === 'adminReviewRegistration') {
    if (!isAdmin(req)) throw new HttpsError('permission-denied', 'Administrator access required.');
    return op === 'adminListRegistrations' ? adminListRegistrations(d) : adminReviewRegistration(req, d);
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
exports._test = { CATEGORIES, kePhone, memberId, handle };
