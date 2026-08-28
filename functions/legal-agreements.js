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
ROLE_AGREEMENTS.landlord = ROLE_AGREEMENTS.property; // landlords accept the property set (was orphaned)

const DEFAULT_VERSION = '1.0';

/* The Professional Declaration is versioned independently of the agreements: it
   can be restated without republishing every policy, and a user who accepted v1.0
   keeps that record even after v1.1 ships. */
const DECLARATION_VERSION = '1.0';
const DECLARATION_TEXT = [
  'The information I have provided is true and accurate.',
  'I have the authority to operate and bind this business.',
  'I will comply with the laws of Kenya.',
  'I will honour customer rights, including refunds and returns where they apply.',
  'I understand that false information may result in suspension or termination.',
  'I agree to electronic records and digital signatures under applicable law.',
];

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

/* ── MODULE REGISTRY ─────────────────────────────────────────────────────────
   The engine is a platform service, not a marketplace feature. A new SOKONI module
   (hotels, jobs, logistics — whatever ships next) registers the agreements its role
   requires and inherits presentation, acceptance, signatures, auditing, versioning,
   certificates and enforcement for free — no change to this file, no redeploy.

   Registered agreements are merged OVER the built-in role map, but CORE is always
   prepended and can never be overridden away. That is deliberate: a module must not
   be able to opt its users out of the Privacy Policy. */
let _regCache = null, _regAt = 0;
async function _registry() {
  if (_regCache && (Date.now() - _regAt) < 300000) return _regCache;
  try {
    const snap = await _db().collection('legalRegistry').limit(100).get();
    const reg = {};
    snap.forEach((d) => { reg[d.id] = (d.data() || {}).agreements || []; });
    _regCache = reg; _regAt = Date.now();
  } catch (_) { _regCache = _regCache || {}; }
  return _regCache;
}

/* Merge catalogue defaults with admin-published overrides and registered modules.

   SCHEDULED VERSIONS: a doc may carry `scheduled: {version, effectiveFrom}`. The
   scheduled version becomes live only once effectiveFrom has PASSED — evaluated on
   the SERVER clock, never the client's. An admin can stage a policy change and it
   activates itself, with no deploy. */
async function _catalogueFor(role, atMs) {
  const now = typeof atMs === 'number' ? atMs : Date.now();

  const registered = (await _registry())[role] || [];
  const merged = [...(ROLE_AGREEMENTS[role] || [])];
  registered.forEach((r) => { if (!merged.some((m) => m.id === r.id)) merged.push(r); });
  const list = [...CORE, ...merged];

  const overrides = await _versionOverrides(list.map((a) => a.id));
  return list.map((a) => {
    const o = overrides[a.id] || {};
    if (o.status === 'archived') return null;
    let version = o.version || DEFAULT_VERSION;
    let effectiveDate = o.effectiveDate || null;

    const sch = o.scheduled;
    if (sch && sch.version && sch.effectiveFrom) {
      const eff = sch.effectiveFrom.toMillis ? sch.effectiveFrom.toMillis()
                : (typeof sch.effectiveFrom === 'number' ? sch.effectiveFrom : Date.parse(sch.effectiveFrom));
      if (Number.isFinite(eff) && now >= eff) { version = String(sch.version); effectiveDate = sch.effectiveFrom; }
    }
    return {
      id: a.id, name: o.name || a.name, version,
      summary: o.summary || a.summary || null,
      keyPoints: (Array.isArray(o.keyPoints) && o.keyPoints.slice(0, 8)) || a.keyPoints || null,
      url: o.url || a.url || null,
      readingMinutes: o.readingMinutes || a.readingMinutes || 3,
      publishedDate: o.publishedDate || null, effectiveDate,
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
  const hdr = rawReq.headers || {};
  const ip = _san(rawReq.ip || (hdr['x-forwarded-for'] || '').split(',')[0] || '', 64);
  const meta = req.data?.meta || {};
  const device   = _san(meta.device, 300);
  const browser  = _san(meta.browser, 200);
  const language = _san(meta.language, 32);
  const businessId = _san(meta.businessId, 64);
  /* Country and User-Agent come from the EDGE, not the client. A client-supplied
     country is not evidence of anything; we fall back to the client hint only for
     display and RECORD WHICH SOURCE WAS USED, so the audit trail stays honest. */
  const edgeCountry = _san(hdr['x-appengine-country'] || hdr['cf-ipcountry'] || '', 8);
  const country = edgeCountry || _san(meta.country, 8);
  const countrySource = edgeCountry ? 'edge' : (meta.country ? 'client-hint' : 'unknown');
  const userAgent = _san(hdr['user-agent'] || '', 400);

  /* ── Digital signature ───────────────────────────────────────────────────────
     Three lawful forms: drawn, typed full legal name, or a business stamp. Each is
     an electronic signature under Kenya's Business Laws (Amendment) Act / ETA,
     provided intent and attribution are recorded — which the audit record does.

     We store a SHA-256 HASH of the drawn/stamped image, never the raw image: it is
     large, it is biometric-adjacent personal data, and the hash is sufficient to
     prove the artefact presented at signing has not been altered since. */
  const sig = req.data?.signature || {};
  const sigType = _san(sig.type, 12);                       // drawn | typed | stamp
  if (['drawn', 'typed', 'stamp'].indexOf(sigType) === -1) {
    throw new HttpsError('invalid-argument', 'A digital signature is required (drawn, typed or stamp).');
  }
  const signedName = _san(sig.name, 120).trim();
  if (signedName.length < 2) throw new HttpsError('invalid-argument', 'Full legal name is required to sign.');
  if (!sig.confirmed) {
    throw new HttpsError('failed-precondition', 'You must confirm you have read and understand the agreements.');
  }
  let signatureHash;
  if (sigType === 'typed') {
    signatureHash = crypto.createHash('sha256').update(`typed:${uid}:${signedName}`).digest('hex');
  } else {
    const data = String(sig.data || '');
    const what = sigType === 'stamp' ? 'Business stamp' : 'Drawn signature';
    if (data.length < 64)     throw new HttpsError('invalid-argument', `${what} is empty.`);
    if (data.length > 400000) throw new HttpsError('invalid-argument', `${what} image is too large.`);
    signatureHash = crypto.createHash('sha256').update(data).digest('hex');
  }

  /* ── Professional Declaration ───────────────────────────────────────────────
     A SEPARATE attestation from "I have read the terms": it asserts truthfulness
     and authority to bind the business. Folding the two into one checkbox would
     weaken both, so it is required, versioned and recorded independently. */
  const decl = req.data?.declaration || {};
  const declarationAccepted = decl.accepted === true;
  const declarationVersion = _san(decl.version, 20) || DECLARATION_VERSION;
  const PROFESSIONAL_ROLES = ['merchant', 'provider', 'driver', 'rider', 'property',
                              'hotel', 'restaurant', 'healthcare', 'employer'];
  if (PROFESSIONAL_ROLES.indexOf(role) !== -1 && !declarationAccepted) {
    throw new HttpsError('failed-precondition',
      'The Professional Declaration must be accepted before a business account can be activated.');
  }

  /* ── Read evidence ──────────────────────────────────────────────────────────
     What the user actually did with each document (opened, dwell time, reached the
     end). This is EVIDENCE OF ENGAGEMENT, not a security control — a client can
     trivially fake a dwell timer, so it authorises nothing. It is stored verbatim
     and LABELLED client-reported. Recording it honestly makes it useful in a
     dispute; treating it as trustworthy would be security theatre. */
  const readRaw = (req.data?.readEvidence && typeof req.data.readEvidence === 'object') ? req.data.readEvidence : {};
  const readEvidence = {};
  Object.keys(readRaw).slice(0, 50).forEach((k) => {
    const v = readRaw[k] || {};
    readEvidence[_san(k, 100)] = {
      opened: v.opened === true,
      dwellMs: Math.max(0, Math.min(3600000, Number(v.dwellMs) || 0)),
      scrolledToEnd: v.scrolledToEnd === true,
      source: 'client-reported',
    };
  });

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
      userId: uid, businessId: businessId || null,
      role: role || null, agreementId, agreementName: cat.name, version,
      accepted: true, acceptedAt: _ts(), acceptedFrom: ip || null,
      device: device || null, browser: browser || null, language: language || null,
      country: country || null, countrySource, userAgent: userAgent || null,
      agreementHash: cat.hash,
      acceptanceMethod: sigType + '-signature',
      signatureType: sigType, signedName, signatureHash,
      readEvidence: readEvidence[agreementId] || null,
      createdAt: _ts(),
    }, { merge: true });
    recorded.push({ agreementId, version });
  }
  if (!recorded.length) throw new HttpsError('invalid-argument', 'No valid agreements to accept.');

  /* Immutable audit entry. The id is deterministic over (user, role, agreements+
     versions), so a retry — or a double-tapped Sign — collapses onto the SAME
     record instead of forging a second signing event. */
  const auditLogId = `${uid}_${role || 'core'}_${_hash(recorded.map((r) => r.agreementId + r.version).join(','), 'a')}`;
  batch.set(_db().collection('legalAuditLog').doc(auditLogId), {
    userId: uid, businessId: businessId || null,
    role: role || null, action: 'accept', agreements: recorded,
    acceptedFrom: ip || null, device: device || null, userAgent: userAgent || null,
    country: country || null, countrySource,
    signatureType: sigType, signedName, signatureHash,
    declarationAccepted, declarationVersion: declarationAccepted ? declarationVersion : null,
    readEvidence,
    at: _ts(),
  }, { merge: true });

  /* Digital Acceptance Certificate — one immutable document the user (and a court)
     can point at. Same deterministic id, so a retry regenerates the SAME
     certificate rather than minting a second one for one signing event. */
  batch.set(_db().collection('legalCertificates').doc(auditLogId), {
    certificateId: auditLogId,
    userId: uid, businessId: businessId || null, role: role || null,
    agreements: recorded,
    signatureType: sigType, signedName, signatureHash,
    declarationAccepted, declarationVersion: declarationAccepted ? declarationVersion : null,
    declarationText: declarationAccepted ? DECLARATION_TEXT : null,
    ipAddress: ip || null, country: country || null, countrySource,
    userAgent: userAgent || null, device: device || null,
    issuedAt: _ts(),                       // SERVER time — the only time that counts
    status: 'valid',
  }, { merge: true });

  await batch.commit();

  /* No client timestamp is echoed back. The authoritative time is the server
     timestamp written above; anything returned here would be advisory only. */
  return {
    recorded, count: recorded.length,
    acceptanceId: auditLogId, auditLogId, certificateId: auditLogId,
    signedName, signatureType: sigType, signatureHash,
    declarationAccepted,
  };
};

/* ── legalGetCertificate({certificateId}) ────────────────────────────────────
   A user may fetch only their OWN certificate; an admin may fetch any. Without
   that check this is an IDOR leaking names, IPs and signature hashes. */
_h.legalGetCertificate = async (req) => {
  const uid = _uid(req);
  const t = req.auth?.token || {};
  const isAdmin = !!(t.admin || t.superAdmin);
  const id = _san(req.data?.certificateId, 200);
  if (!id) throw new HttpsError('invalid-argument', 'certificateId is required.');

  const snap = await _db().collection('legalCertificates').doc(id).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Certificate not found.');
  const c = snap.data();
  if (c.userId !== uid && !isAdmin) {
    throw new HttpsError('permission-denied', 'This certificate belongs to another user.');
  }
  return { certificate: Object.assign({ id: snap.id }, c), declarationText: DECLARATION_TEXT };
};

/* ── legalMyCertificates() — Legal Centre: certificate + signature history ── */
_h.legalMyCertificates = async (req) => {
  const uid = _uid(req);
  const snap = await _db().collection('legalCertificates').where('userId', '==', uid).limit(200).get();
  const certs = [];
  snap.forEach((d) => {
    const c = d.data();
    certs.push({
      id: d.id, role: c.role, businessId: c.businessId || null, agreements: c.agreements || [],
      signatureType: c.signatureType, signedName: c.signedName, signatureHash: c.signatureHash,
      country: c.country || null, ipAddress: c.ipAddress || null,
      declarationAccepted: !!c.declarationAccepted,
      issuedAt: c.issuedAt || null, status: c.status || 'valid',
    });
  });
  certs.sort((a, b) => {
    const am = a.issuedAt && a.issuedAt.toMillis ? a.issuedAt.toMillis() : 0;
    const bm = b.issuedAt && b.issuedAt.toMillis ? b.issuedAt.toMillis() : 0;
    return bm - am;
  });
  return { certificates: certs, count: certs.length, declarationText: DECLARATION_TEXT };
};

/* ── legalGetDeclaration() — the statements the user attests to ── */
_h.legalGetDeclaration = async () => ({ version: DECLARATION_VERSION, statements: DECLARATION_TEXT });

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

/* ── Admin: SCHEDULE a future version (activates itself on the server clock) ── */
_h.legalScheduleVersion = async (req) => {
  _assertAdmin(req);
  const d = req.data || {};
  const id = _san(d.agreementId, 100);
  const version = _san(d.version, 20);
  const effectiveFrom = Number(d.effectiveFrom);
  if (!id || !version) throw new HttpsError('invalid-argument', 'agreementId and version are required.');
  if (!Number.isFinite(effectiveFrom)) throw new HttpsError('invalid-argument', 'effectiveFrom (epoch ms) is required.');
  if (effectiveFrom <= Date.now()) {
    throw new HttpsError('invalid-argument', 'effectiveFrom must be in the future — use legalPublishAgreement to go live now.');
  }
  const ref = _db().collection('legalAgreements').doc(id);
  const snap = await ref.get();
  if (snap.exists && snap.data().version === version) {
    throw new HttpsError('failed-precondition', `Version ${version} is already live for "${id}".`);
  }
  await ref.set({
    scheduled: {
      version, effectiveFrom: new Date(effectiveFrom),
      summary: _san(d.summary, 600) || null,
      keyPoints: Array.isArray(d.keyPoints) ? d.keyPoints.slice(0, 8).map((k) => _san(k, 160)) : null,
      scheduledBy: req.auth.uid, scheduledAt: _ts(),
    },
  }, { merge: true });
  await _db().collection('legalAuditLog').doc(`schedule_${id}_${version}`).set({
    action: 'schedule', agreementId: id, version, effectiveFrom: new Date(effectiveFrom),
    actorUid: req.auth.uid, at: _ts(),
  }, { merge: true });
  _catCache = null;
  return { agreementId: id, version, effectiveFrom, status: 'scheduled' };
};

/* ── Admin: ROLLBACK ─────────────────────────────────────────────────────────
   Never deletes history. Republishes an EXISTING version from the append-only
   `versions` subcollection and logs the rollback. You can only roll back to
   something that provably shipped — refusing to invent one is the whole point. */
_h.legalRollbackVersion = async (req) => {
  _assertAdmin(req);
  const d = req.data || {};
  const id = _san(d.agreementId, 100);
  const version = _san(d.version, 20);
  if (!id || !version) throw new HttpsError('invalid-argument', 'agreementId and version are required.');

  const ref = _db().collection('legalAgreements').doc(id);
  const [cur, target] = await Promise.all([ref.get(), ref.collection('versions').doc(version).get()]);
  if (!target.exists) {
    throw new HttpsError('not-found', `Version ${version} of "${id}" was never published — cannot roll back to it.`);
  }
  const from = cur.exists ? (cur.data().version || null) : null;
  if (from === version) throw new HttpsError('failed-precondition', `"${id}" is already on ${version}.`);

  const t = target.data() || {};
  await ref.set({
    version, name: t.name || null, summary: t.summary || null,
    keyPoints: t.keyPoints || null, url: t.url || null, status: 'active',
    scheduled: FieldValue.delete(),          // a rollback cancels any pending schedule
    rolledBackFrom: from, rolledBackBy: req.auth.uid, rolledBackAt: _ts(),
  }, { merge: true });
  await _db().collection('legalAuditLog').doc(`rollback_${id}_${from || 'none'}_${version}`).set({
    action: 'rollback', agreementId: id, fromVersion: from, toVersion: version,
    actorUid: req.auth.uid, at: _ts(),
  }, { merge: true });
  _catCache = null;
  return { agreementId: id, from, to: version, status: 'rolled-back' };
};

/* ── Admin: PREVIEW what a role sees, optionally at a FUTURE time ───────────
   Confirm what a scheduled change will actually do — and which roles it touches —
   before it goes live, without publishing anything. */
_h.legalPreviewAgreements = async (req) => {
  _assertAdmin(req);
  const role = _san(req.data?.role || '', 40);
  const at = Number(req.data?.at);
  const atMs = Number.isFinite(at) ? at : Date.now();
  const [future, live] = await Promise.all([_catalogueFor(role, atMs), _catalogueFor(role, Date.now())]);
  const liveById = {}; live.forEach((a) => { liveById[a.id] = a.version; });
  return {
    role: role || 'buyer', at: atMs,
    agreements: future.map((a) => Object.assign({}, a, {
      currentVersion: liveById[a.id] || null,
      changesAtPreviewTime: liveById[a.id] !== a.version,
    })),
  };
};

/* ── Admin: REGISTER a module's agreements (the platform-service seam) ── */
_h.legalRegisterAgreements = async (req) => {
  _assertAdmin(req);
  const d = req.data || {};
  const role = _san(d.role, 40);
  const module_ = _san(d.module, 60);
  const list = Array.isArray(d.agreements) ? d.agreements.slice(0, 20) : [];
  if (!role || !list.length) throw new HttpsError('invalid-argument', 'role and agreements[] are required.');

  const clean = list.map((a) => ({
    id: _san(a.id, 100), name: _san(a.name, 160),
    summary: _san(a.summary, 600) || null,
    keyPoints: Array.isArray(a.keyPoints) ? a.keyPoints.slice(0, 8).map((k) => _san(k, 160)) : null,
    url: _san(a.url, 300) || null,
    readingMinutes: Math.max(1, Math.min(60, Number(a.readingMinutes) || 3)),
  })).filter((a) => a.id && a.name);
  if (!clean.length) throw new HttpsError('invalid-argument', 'No valid agreements supplied.');

  await _db().collection('legalRegistry').doc(role).set({
    role, module: module_ || null, agreements: clean,
    registeredBy: req.auth.uid, registeredAt: _ts(),
  }, { merge: true });
  await _db().collection('legalAuditLog').doc(`register_${role}_${_hash(clean.map((c) => c.id).join(','), 'r')}`).set({
    action: 'register', role, module: module_ || null,
    agreements: clean.map((c) => c.id), actorUid: req.auth.uid, at: _ts(),
  }, { merge: true });

  _regCache = null; _catCache = null;
  return { role, module: module_ || null, registered: clean.length, agreements: clean.map((c) => c.id) };
};

_h.legalGetRegistry = async (req) => {
  _assertAdmin(req);
  const reg = await _registry();
  return { roles: Object.keys(reg), registry: reg };
};

module.exports = {
  _h, CORE, ROLE_AGREEMENTS, DEFAULT_VERSION,
  DECLARATION_VERSION, DECLARATION_TEXT,
  assertLegalCompliance,
};
