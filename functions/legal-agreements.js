'use strict';
/**
 * SOKONI Legal Agreements & Digital Acceptance Framework — backend.
 *
 * Records legally-binding, versioned, auditable acceptance of the correct
 * agreements per role, and enforces it server-side. Append-only: acceptance
 * records are NEVER deleted; a new version produces a new record. Wired to the
 * onboarding wizard via legalDispatch (no new per-op Cloud Run services).
 *
 * Collections:
 *   legalAgreements/{agreementId}     — admin-published version metadata (overrides catalogue)
 *   legalAcceptances/{uid_agr_version}— immutable acceptance record (deterministic id → idempotent)
 */

const { HttpsError }               = require('firebase-functions/v2/https');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const crypto                       = require('crypto');

const _db  = () => getFirestore();
const _ts  = () => FieldValue.serverTimestamp();
const _san = (v, n = 200) => String(v == null ? '' : v).slice(0, n).replace(/[<>]/g, '');

function _uid(req) {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required.');
  return uid;
}
function _assertAdmin(req) {
  const t = req.auth?.token || {};
  if (!t.admin && !t.superAdmin) throw new HttpsError('permission-denied', 'Admin only.');
}

/* ── Agreement catalogue (default current versions; overridden by legalAgreements docs) ── */
const CORE = [
  { id: 'terms-of-service',     name: 'Terms of Service' },
  { id: 'privacy-policy',       name: 'Privacy Policy' },
  { id: 'cookie-policy',        name: 'Cookie Policy' },
  { id: 'community-standards',  name: 'Community Standards' },
  { id: 'acceptable-use',       name: 'Acceptable Use Policy' },
];

const ROLE_AGREEMENTS = {
  merchant: [
    { id: 'merchant-agreement',          name: 'Merchant Agreement' },
    { id: 'marketplace-seller-terms',    name: 'Marketplace Seller Terms' },
    { id: 'commission-agreement',        name: 'Commission Agreement' },
    { id: 'payment-settlement-terms',    name: 'Payment Settlement Terms' },
    { id: 'returns-refund-policy',       name: 'Returns & Refund Policy' },
    { id: 'prohibited-products-policy',  name: 'Prohibited Products Policy' },
    { id: 'tax-compliance-declaration',  name: 'Tax Compliance Declaration' },
    { id: 'data-processing-agreement',   name: 'Data Processing Agreement' },
  ],
  provider: [
    { id: 'service-provider-agreement',    name: 'Service Provider Agreement' },
    { id: 'professional-conduct-policy',   name: 'Professional Conduct Policy' },
    { id: 'booking-cancellation-policy',   name: 'Booking & Cancellation Policy' },
    { id: 'customer-protection-policy',    name: 'Customer Protection Policy' },
    { id: 'commission-agreement',          name: 'Commission Agreement' },
    { id: 'provider-payment-terms',        name: 'Payment Terms' },
    { id: 'service-quality-standards',     name: 'Service Quality Standards' },
    { id: 'identity-verification-consent', name: 'Identity Verification Consent' },
  ],
  driver: [
    { id: 'driver-agreement',    name: 'Driver Agreement' },
    { id: 'delivery-terms',      name: 'Delivery Terms' },
    { id: 'vehicle-requirements',name: 'Vehicle Requirements' },
    { id: 'safety-standards',    name: 'Safety Standards' },
    { id: 'insurance-declaration',name: 'Insurance Declaration' },
  ],
  property: [
    { id: 'property-listing-agreement', name: 'Property Listing Agreement' },
    { id: 'tenant-protection-policy',   name: 'Tenant Protection Policy' },
    { id: 'fair-housing-compliance',    name: 'Fair Housing Compliance' },
  ],
  hotel:      [{ id: 'hospitality-partner-agreement', name: 'Hospitality Partner Agreement' }],
  restaurant: [
    { id: 'restaurant-partner-agreement', name: 'Restaurant Partner Agreement' },
    { id: 'food-safety-declaration',      name: 'Food Safety Declaration' },
  ],
  healthcare: [
    { id: 'healthcare-provider-agreement', name: 'Healthcare Provider Agreement' },
    { id: 'medical-compliance-declaration',name: 'Medical Compliance Declaration' },
  ],
  employer: [
    { id: 'employer-agreement',    name: 'Employer Agreement' },
    { id: 'recruitment-standards', name: 'Recruitment Standards' },
  ],
};
ROLE_AGREEMENTS.rider = ROLE_AGREEMENTS.driver; // riders share the driver set

const DEFAULT_VERSION = '1.0';

/* Deterministic content hash so a version's identity is verifiable in the record. */
function _hash(agreementId, version) {
  return crypto.createHash('sha256').update(`${agreementId}:${version}`).digest('hex').slice(0, 32);
}

/* Version-override cache — agreement versions change rarely; cache 5 min to avoid
   re-reading legalAgreements on every compliance check (performance requirement). */
let _catCache = null, _catAt = 0;
async function _versionOverrides(ids) {
  if (_catCache && (Date.now() - _catAt) < 300000) return _catCache;
  const overrides = {};
  const snaps = await Promise.all(ids.map((id) => _db().collection('legalAgreements').doc(id).get().catch(() => null)));
  snaps.forEach((s) => { if (s && s.exists) overrides[s.id] = s.data(); });
  _catCache = overrides; _catAt = Date.now();
  return overrides;
}

/* Merge catalogue defaults with any admin-published version overrides. */
async function _catalogueFor(role) {
  const list = [...CORE, ...(ROLE_AGREEMENTS[role] || [])];
  const overrides = await _versionOverrides(list.map((a) => a.id));
  return list.map((a) => {
    const o = overrides[a.id] || {};
    if (o.status === 'archived') return null;
    const version = o.version || DEFAULT_VERSION;
    return {
      id: a.id, name: o.name || a.name, version,
      publishedDate: o.publishedDate || null, effectiveDate: o.effectiveDate || null,
      hash: _hash(a.id, version), status: o.status || 'active',
    };
  }).filter(Boolean);
}

/* ── Server-side enforcement (dark-launched per role) ────────────────────────
   assertLegalCompliance(uid, role) is the reusable guard other modules call to
   protect sensitive ops (payouts, publish, go-online, …). Enforcement is OFF by
   default per role and flipped on via legalSetEnforcement once the acceptance UI
   is rolled out for that role — so existing users are never suddenly locked out
   (no breaking changes). When enabled, it throws failed-precondition listing the
   missing agreements. */
let _enfCache = null, _enfAt = 0;
async function _enforcementFlags() {
  if (_enfCache && (Date.now() - _enfAt) < 60000) return _enfCache; // 60s TTL
  try {
    const snap = await _db().collection('legalConfig').doc('enforcement').get();
    _enfCache = snap.exists ? (snap.data() || {}) : {};
  } catch (_) { _enfCache = _enfCache || {}; }
  _enfAt = Date.now();
  return _enfCache;
}

async function assertLegalCompliance(uid, role) {
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required.');
  const flags = await _enforcementFlags();
  if (!flags[role] && !flags.all) return { enforced: false, compliant: true }; // dark: allow
  const [required, accSnap] = await Promise.all([
    _catalogueFor(role),
    _db().collection('legalAcceptances').where('userId', '==', uid).limit(500).get(),
  ]);
  const accepted = {};
  accSnap.docs.forEach((d) => { const a = d.data(); if (a.accepted) accepted[a.agreementId] = a.version; });
  const missing = required.filter((a) => accepted[a.id] !== a.version);
  if (missing.length) {
    throw new HttpsError('failed-precondition',
      `Please accept the required agreements before continuing: ${missing.map((m) => m.name).join(', ')}.`);
  }
  return { enforced: true, compliant: true };
}

const _h = {};

/* ── legalGetAgreements({role}) — the agreements a role must accept, current versions ── */
_h.legalGetAgreements = async (req) => {
  _uid(req);
  const role = _san(req.data?.role || '', 40);
  const all = await _catalogueFor(role);
  return {
    role: role || null,
    core: all.filter((a) => CORE.some((c) => c.id === a.id)),
    roleSpecific: all.filter((a) => !CORE.some((c) => c.id === a.id)),
  };
};

/* ── legalGetMyAcceptances() — everything this user has accepted (index-free) ── */
_h.legalGetMyAcceptances = async (req) => {
  const uid = _uid(req);
  const snap = await _db().collection('legalAcceptances').where('userId', '==', uid).limit(500).get();
  return { acceptances: snap.docs.map((d) => ({ id: d.id, ...d.data() })) };
};

/* ── legalCheckCompliance({role}) — ENFORCEMENT: which required agreements are missing/outdated ── */
_h.legalCheckCompliance = async (req) => {
  const uid  = _uid(req);
  const role = _san(req.data?.role || '', 40);
  const [required, accSnap] = await Promise.all([
    _catalogueFor(role),
    _db().collection('legalAcceptances').where('userId', '==', uid).limit(500).get(),
  ]);
  const accepted = {};
  accSnap.docs.forEach((d) => { const a = d.data(); if (a.accepted) accepted[a.agreementId] = a.version; });
  const missing = required.filter((a) => accepted[a.id] !== a.version).map((a) => ({
    agreementId: a.id, name: a.name, version: a.version,
    reason: accepted[a.id] ? 'outdated' : 'never',
  }));
  return { role: role || null, compliant: missing.length === 0, missing, requiredCount: required.length };
};

/* ── legalAccept({role, acceptances:[{agreementId,version}], meta}) — record acceptance ──
   Explicit action only; server captures IP + timestamp + hash. Idempotent per
   (user, agreement, version). Append-only. */
_h.legalAccept = async (req) => {
  const uid  = _uid(req);
  const role = _san(req.data?.role || '', 40);
  const items = Array.isArray(req.data?.acceptances) ? req.data.acceptances.slice(0, 50) : [];
  if (!items.length) throw new HttpsError('invalid-argument', 'No acceptances provided.');

  // Server-captured context (never client-trusted for IP).
  const rawReq = req.rawRequest || {};
  const ip = _san(rawReq.ip || (rawReq.headers && (rawReq.headers['x-forwarded-for'] || '').split(',')[0]) || '', 64);
  const meta = req.data?.meta || {};
  const device   = _san(meta.device, 300);
  const browser  = _san(meta.browser, 200);
  const language = _san(meta.language, 32);
  const country  = _san(meta.country, 8);

  // Validate against the real catalogue so a client can't fabricate agreement ids/versions.
  const catalogue = await _catalogueFor(role);
  const byId = {}; catalogue.forEach((a) => { byId[a.id] = a; });

  const batch = _db().batch();
  const recorded = [];
  for (const it of items) {
    const agreementId = _san(it.agreementId, 100);
    const cat = byId[agreementId];
    if (!cat) continue;                          // unknown/irrelevant agreement → skip
    const version = _san(it.version, 20) || cat.version;
    if (version !== cat.version) throw new HttpsError('failed-precondition',
      `Agreement "${agreementId}" must be accepted at current version ${cat.version}.`);
    const docId = `${uid}_${agreementId}_${version}`;
    batch.set(_db().collection('legalAcceptances').doc(docId), {
      userId: uid, role: role || null, agreementId, agreementName: cat.name, version,
      accepted: true, acceptedAt: _ts(), acceptedFrom: ip || null,
      device: device || null, browser: browser || null, language: language || null,
      country: country || null, agreementHash: cat.hash, acceptanceMethod: 'checkbox',
      createdAt: _ts(),
    }, { merge: true });
    recorded.push({ agreementId, version });
  }
  if (!recorded.length) throw new HttpsError('invalid-argument', 'No valid agreements to accept.');
  // Immutable audit-trail entry for the batch (append-only, never updated).
  batch.set(_db().collection('legalAuditLog').doc(`${uid}_${role || 'core'}_${_hash(recorded.map((r) => r.agreementId + r.version).join(','), 'a')}`), {
    userId: uid, role: role || null, action: 'accept', agreements: recorded,
    acceptedFrom: ip || null, device: device || null, at: _ts(),
  }, { merge: true });
  await batch.commit();
  return { recorded, count: recorded.length };
};

/* ── Admin: publish a new agreement version ── */
_h.legalPublishAgreement = async (req) => {
  _assertAdmin(req);
  const d = req.data || {};
  const id = _san(d.agreementId, 100);
  const version = _san(d.version, 20);
  if (!id || !version) throw new HttpsError('invalid-argument', 'agreementId and version are required.');
  const ref = _db().collection('legalAgreements').doc(id);
  const prev = await ref.get();
  // Keep version history append-only.
  await ref.collection('versions').doc(version).set({
    version, name: _san(d.name, 200), text: _san(d.text, 100000) || null,
    publishedDate: _ts(), effectiveDate: d.effectiveDate || null, publishedBy: req.auth.uid,
  }, { merge: true });
  await ref.set({
    agreementId: id, name: _san(d.name, 200) || (prev.exists ? prev.data().name : id),
    version, status: 'active', publishedDate: _ts(), effectiveDate: d.effectiveDate || null,
    hash: _hash(id, version), updatedAt: _ts(),
  }, { merge: true });
  _catCache = null; // bust version cache so the new version is served immediately
  return { ok: true, agreementId: id, version };
};

/* ── Admin: archive an agreement ── */
_h.legalArchiveAgreement = async (req) => {
  _assertAdmin(req);
  const id = _san(req.data?.agreementId, 100);
  if (!id) throw new HttpsError('invalid-argument', 'agreementId is required.');
  await _db().collection('legalAgreements').doc(id).set({ status: 'archived', updatedAt: _ts() }, { merge: true });
  _catCache = null;
  return { ok: true, agreementId: id };
};

/* ── Admin: version history for an agreement ── */
_h.legalVersionHistory = async (req) => {
  _assertAdmin(req);
  const id = _san(req.data?.agreementId, 100);
  if (!id) throw new HttpsError('invalid-argument', 'agreementId is required.');
  const snap = await _db().collection('legalAgreements').doc(id).collection('versions').limit(100).get();
  return { agreementId: id, versions: snap.docs.map((v) => ({ id: v.id, ...v.data() })) };
};

/* ── Admin: acceptance search (index-free single-field filters) ── */
_h.legalSearchAcceptances = async (req) => {
  _assertAdmin(req);
  const d = req.data || {};
  let q = _db().collection('legalAcceptances');
  if (d.userId)      q = q.where('userId', '==', _san(d.userId, 128));
  else if (d.agreementId) q = q.where('agreementId', '==', _san(d.agreementId, 100));
  const snap = await q.limit(Math.min(Number(d.limit) || 200, 500)).get();
  let rows = snap.docs.map((x) => ({ id: x.id, ...x.data() }));
  if (d.role) rows = rows.filter((r) => r.role === _san(d.role, 40));
  if (d.version) rows = rows.filter((r) => r.version === _san(d.version, 20));
  return { acceptances: rows, count: rows.length };
};

/* ── Admin: acceptance statistics (bounded aggregate) ── */
_h.legalGetStats = async (req) => {
  _assertAdmin(req);
  const agreementId = _san(req.data?.agreementId, 100);
  let q = _db().collection('legalAcceptances');
  if (agreementId) q = q.where('agreementId', '==', agreementId);
  const snap = await q.limit(5000).get();
  const byAgreement = {}, byVersion = {}, byRole = {};
  snap.docs.forEach((x) => {
    const a = x.data();
    byAgreement[a.agreementId] = (byAgreement[a.agreementId] || 0) + 1;
    byVersion[`${a.agreementId}@${a.version}`] = (byVersion[`${a.agreementId}@${a.version}`] || 0) + 1;
    if (a.role) byRole[a.role] = (byRole[a.role] || 0) + 1;
  });
  return { total: snap.size, sampled: snap.size >= 5000, byAgreement, byVersion, byRole };
};

/* ── legalGetPendingUpdates({role}) — user's agreements needing (re-)acceptance ──
   Powers the "pending updates" prompt: outdated version OR never accepted. */
_h.legalGetPendingUpdates = async (req) => {
  const uid  = _uid(req);
  const role = _san(req.data?.role || '', 40);
  const [required, accSnap] = await Promise.all([
    _catalogueFor(role),
    _db().collection('legalAcceptances').where('userId', '==', uid).limit(500).get(),
  ]);
  const accepted = {};
  accSnap.docs.forEach((d) => { const a = d.data(); if (a.accepted) accepted[a.agreementId] = a.version; });
  const pending = required.filter((a) => accepted[a.id] !== a.version).map((a) => ({
    agreementId: a.id, name: a.name, currentVersion: a.version,
    acceptedVersion: accepted[a.id] || null,
    reason: accepted[a.id] ? 'version_updated' : 'never_accepted',
  }));
  return { role: role || null, hasPending: pending.length > 0, pending };
};

/* ── Admin: export acceptance records as CSV (audit) ── */
_h.legalExportAcceptances = async (req) => {
  _assertAdmin(req);
  const d = req.data || {};
  let q = _db().collection('legalAcceptances');
  if (d.agreementId) q = q.where('agreementId', '==', _san(d.agreementId, 100));
  else if (d.userId) q = q.where('userId', '==', _san(d.userId, 128));
  const snap = await q.limit(Math.min(Number(d.limit) || 5000, 10000)).get();
  const cols = ['userId', 'role', 'agreementId', 'agreementName', 'version', 'acceptedAt', 'acceptedFrom', 'country', 'language', 'agreementHash', 'acceptanceMethod'];
  const escCsv = (v) => { const s = String(v == null ? '' : v).replace(/"/g, '""'); return /[",\n]/.test(s) ? `"${s}"` : s; };
  const rows = [cols.join(',')];
  snap.docs.forEach((x) => {
    const a = x.data();
    const at = a.acceptedAt && a.acceptedAt._seconds ? new Date(a.acceptedAt._seconds * 1000).toISOString() : '';
    rows.push(cols.map((c) => escCsv(c === 'acceptedAt' ? at : a[c])).join(','));
  });
  return { csv: rows.join('\n'), count: snap.size, filename: `legal-acceptances-${d.agreementId || d.userId || 'all'}.csv` };
};

/* ── Admin: toggle server-side enforcement per role (dark-launch control) ── */
_h.legalSetEnforcement = async (req) => {
  _assertAdmin(req);
  const role = _san(req.data?.role || '', 40);
  const enabled = req.data?.enabled === true;
  if (!role) throw new HttpsError('invalid-argument', 'role is required (or "all").');
  await _db().collection('legalConfig').doc('enforcement').set({ [role]: enabled, updatedAt: _ts() }, { merge: true });
  _enfCache = null; _enfAt = 0; // force re-read
  return { ok: true, role, enabled };
};

/* ── Admin: compliance report (acceptance rate, pending, version adoption, by role) ── */
_h.legalComplianceReport = async (req) => {
  _assertAdmin(req);
  const snap = await _db().collection('legalAcceptances').limit(5000).get();
  const byAgreement = {}, byRole = {}, versionAdoption = {}, users = new Set();
  snap.docs.forEach((x) => {
    const a = x.data();
    users.add(a.userId);
    byAgreement[a.agreementId] = (byAgreement[a.agreementId] || 0) + 1;
    if (a.role) byRole[a.role] = (byRole[a.role] || 0) + 1;
    versionAdoption[`${a.agreementId}@${a.version}`] = (versionAdoption[`${a.agreementId}@${a.version}`] || 0) + 1;
  });
  const flags = await _enforcementFlags();
  // Latest-version adoption %: of everyone who accepted an agreement, how many are on its current version.
  const overrides = await _versionOverrides([...CORE, ...Object.values(ROLE_AGREEMENTS).flat()].map((a) => a.id));
  const latestVersionAdoption = {};
  Object.keys(byAgreement).forEach((id) => {
    const current = (overrides[id] && overrides[id].version) || DEFAULT_VERSION;
    const onCurrent = versionAdoption[`${id}@${current}`] || 0;
    const total = byAgreement[id];
    latestVersionAdoption[id] = { currentVersion: current, onCurrent, total,
      adoptionPct: total ? Math.round((onCurrent / total) * 100) : 0 };
  });
  return {
    totalAcceptanceRecords: snap.size, sampled: snap.size >= 5000,
    distinctUsers: users.size, byAgreement, byRole, versionAdoption,
    latestVersionAdoption, enforcement: flags,
  };
};

module.exports = { _h, CORE, ROLE_AGREEMENTS, DEFAULT_VERSION, assertLegalCompliance };
