'use strict';
/**
 * SOKONI — Approval remediation read model (REAPPLICATION_REQUIRED)  — PURE, no Firestore, no Auth.
 * ================================================================================================
 * Derives ONE server-side approval state per account from the same evidence the remediation census used
 * (docs/APPROVAL_REMEDIATION_CENSUS.md). It is a DERIVATION, never a stored field: no client can write it, and no
 * server path persists it — surfaces and authorities call `deriveApprovalState` and act on the result.
 *
 * STATES   BUYER_ONLY · VALID_APPROVAL · INVALID_LEGACY_APPROVAL · NO_APPROVAL · PENDING_APPROVAL · REFUSED
 * TRANSITION  INVALID_LEGACY_APPROVAL | NO_APPROVAL  →  REAPPLICATION_REQUIRED   (and only those)
 *
 * VALIDITY TEST (the deployed trigger's, made explicit)
 *   an application is a valid approval iff status approved AND decidedBy is a resolvable Auth account holding admin or
 *   superAdmin AND decidedBy !== applicant uid (self-approval is never approval) AND the application's role approves the
 *   kind of registry record present (a driver application does not approve a seller record);
 *   OR providers.approvalDecision = { decision: 'approve', source: 'admin_decision' } (the admin approval authority).
 *
 * OWNERSHIP  an identity claimed by the cleanup manifest is owned by the cleanup slice: the derived state is still
 *   reported, but `transition` is withheld (`ownership: 'cleanup'`) until that slice releases or transfers it.
 *
 * APPLICATION PATH  continue_existing (one pending) · select_among_pending (several pending — the surface lists them, the
 *   applicant chooses; nothing is auto-selected and no fourth application is created) · redecide_existing (an approved
 *   artefact whose decision fails the test — Kasindi model: acknowledge, then a fresh decision with priorDecisions
 *   preservation) · fresh (no reusable application).
 *
 * Inputs are plain objects (already read by the caller):
 *   { uid, claims:[], roles:[], provider, seller, businesses:[], shops:[], applications:[{id,...}],
 *     isAdminAccount(uid)→bool, cleanupIds:Set<'collection/id'>, agreementVersion }
 */
const LIVE = ['active', 'approved', 'verified'];
const UNDECIDED = ['pending', 'pending_review', 'pending_verification', 'submitted', 'info_requested', 'under_review', 'in_review', ''];
const REJECTED = ['rejected', 'declined', 'denied'];
const PROVIDERISH_ROLES = ['provider', 'seller', 'merchant', 'business', 'landlord', 'organizer', 'creator', 'venue'];
const PROVIDERISH_CLAIMS = ['provider', 'seller', 'merchant', 'landlord', 'organizer', 'creator'];
const KIND_OF_ROLE = { provider: ['provider'], health: ['provider'], legal: ['provider'], event_organizer: ['provider'], seller: ['seller', 'business', 'shop'], merchant: ['seller', 'business', 'shop'], business: ['seller', 'business', 'shop'], hotel: ['business'], driver: ['driver'], rider: ['driver'], landlord: ['landlord'], property: ['landlord'] };
const lower = (s) => String(s || '').toLowerCase();
/* the applicant may withdraw a pending application (status 'withdrawn' — non-decisive, owner-writable); intake
   normalisation may leave statusCanonical at 'pending', so a withdrawal is read from the raw status first */
const statusOf = (a) => (lower(a && a.status) === 'withdrawn' ? 'withdrawn' : lower((a && (a.statusCanonical || a.status)) || ''));
const STATES = Object.freeze({ BUYER_ONLY: 'BUYER_ONLY', VALID: 'VALID_APPROVAL', INVALID_LEGACY: 'INVALID_LEGACY_APPROVAL', NONE: 'NO_APPROVAL', PENDING: 'PENDING_APPROVAL', REFUSED: 'REFUSED' });
const TRANSITION = 'REAPPLICATION_REQUIRED';

/** Self-approval guard: true when the decider IS the applicant. Authorities call this BEFORE any mutation. */
function isSelfDecision(deciderUid, applicantUid) {
  return !!deciderUid && !!applicantUid && String(deciderUid) === String(applicantUid);
}

/** Validity of one application's decision under the authority test. */
function decisionValidity(app, applicantUid, isAdminAccount, presentKinds) {
  const status = statusOf(app);
  const by = typeof app.decidedBy === 'string' ? app.decidedBy.trim() : '';
  if (status !== 'approved') return { valid: false, why: 'not_approved', status };
  if (!by) return { valid: false, why: 'no_decidedBy', status };
  if (isSelfDecision(by, applicantUid)) return { valid: false, why: 'self_decision', status };
  if (/[:/ ]/.test(by) || !isAdminAccount(by)) return { valid: false, why: 'decider_not_admin_account', status };
  const kinds = KIND_OF_ROLE[lower(app.role)] || ['provider'];
  if (presentKinds.length && !kinds.some((k) => presentKinds.includes(k))) return { valid: false, why: 'approves_other_role', status, kinds };
  return { valid: true, why: 'admin_account', status };
}

function deriveApprovalState(input) {
  const uid = input.uid; const isAdminAccount = input.isAdminAccount || (() => false); const cleanupIds = input.cleanupIds || new Set();
  const claims = (input.claims || []).map(lower), roles = (input.roles || []).map(lower);
  const regs = [];
  if (input.provider) regs.push({ kind: 'provider', id: uid, d: input.provider });
  if (input.seller) regs.push({ kind: 'seller', id: uid, d: input.seller });
  (input.businesses || []).forEach((b) => regs.push({ kind: 'business', id: b.id || uid, d: b }));
  (input.shops || []).forEach((s) => regs.push({ kind: 'shop', id: s.id || uid, d: s }));
  const presentKinds = regs.map((r) => r.kind);
  const liveRegs = regs.filter((r) => LIVE.includes(lower(r.d.status)));
  const apps = (input.applications || []).map((a) => Object.assign({ validity: decisionValidity(a, uid, isAdminAccount, presentKinds) }, a));
  const validApp = apps.find((a) => a.validity.valid) || null;
  const invalidApproved = apps.filter((a) => a.validity.status === 'approved' && !a.validity.valid && a.validity.why !== 'approves_other_role');
  const otherRoleApproved = apps.filter((a) => a.validity.why === 'approves_other_role');
  const pending = apps.filter((a) => UNDECIDED.includes(statusOf(a)) && !a.decidedBy);
  const rejected = apps.filter((a) => REJECTED.includes(statusOf(a)));
  /* a NEGATIVE decision by a real admin account (reject / suspend through applicationDecide) is a decision too:
     the account is REFUSED for now, not "in need of reapplication" */
  const adminNegative = apps.filter((a) => ['suspended', ...REJECTED].includes(statusOf(a)) && typeof a.decidedBy === 'string' && a.decidedBy.trim() && !isSelfDecision(a.decidedBy, uid) && !/[:/ ]/.test(a.decidedBy) && isAdminAccount(a.decidedBy.trim()));
  const adminDecision = regs.map((r) => r.d.approvalDecision).find((d) => d && d.source === 'admin_decision') || null;
  const artefactRegs = regs.filter((r) => r.d.approvedAt || r.d.approved === true || r.d.adminApproved === true || r.d.approvedBy);
  const providerish = roles.some((r) => PROVIDERISH_ROLES.includes(r)) || claims.some((c) => PROVIDERISH_CLAIMS.includes(c));
  const reasons = [];
  let state, subtype;
  if (adminDecision && adminDecision.decision === 'refuse') { state = STATES.REFUSED; subtype = 'admin_decision_refuse'; reasons.push('providers.approvalDecision refuse by ' + adminDecision.decidedBy); }
  else if (!validApp && adminNegative.length && !liveRegs.some((r) => r.d.approvedAt)) { state = STATES.REFUSED; subtype = 'application_' + lower(adminNegative[0].statusCanonical || adminNegative[0].status) + '_by_admin'; reasons.push('application ' + adminNegative[0].id + ' ' + lower(adminNegative[0].status) + ' by admin account ' + adminNegative[0].decidedBy); }
  else if (validApp) { state = STATES.VALID; subtype = 'application_by_admin_account'; reasons.push('application ' + validApp.id + ' approved by admin account ' + validApp.decidedBy); }
  else if (adminDecision && adminDecision.decision === 'approve' && !isSelfDecision(adminDecision.decidedBy, uid)) { state = STATES.VALID; subtype = 'admin_decision_approve'; reasons.push('providers.approvalDecision approve by ' + adminDecision.decidedBy); }
  else if (invalidApproved.length || artefactRegs.length) { state = STATES.INVALID_LEGACY; subtype = 'approval_artefact_without_authority'; invalidApproved.forEach((a) => reasons.push('application ' + a.id + ' approved but ' + a.validity.why + ' (decidedBy ' + JSON.stringify(a.decidedBy) + ')')); artefactRegs.forEach((r) => reasons.push(r.kind + ' carries approval fields with no valid decision')); }
  else if (liveRegs.length) { state = STATES.NONE; subtype = 'live_status_only'; liveRegs.forEach((r) => reasons.push(r.kind + ' status ' + lower(r.d.status) + ' with no approval evidence')); }
  else if (pending.length) { state = STATES.PENDING; subtype = 'undecided_application'; reasons.push(pending.length + ' undecided application(s)'); }
  else if (rejected.length && !regs.length) { state = STATES.REFUSED; subtype = 'application_rejected'; reasons.push('application(s) rejected, no registry record'); }
  else if (!regs.length && !apps.length && !providerish) { state = STATES.BUYER_ONLY; subtype = 'buyer'; reasons.push('no registry record, no application, no provider/seller role or claim'); }
  else if (regs.length) { state = STATES.NONE; subtype = 'registry_stub_not_live'; reasons.push('registry record(s) present but not live'); }
  else { state = STATES.NONE; subtype = 'role_without_registry'; reasons.push('provider/seller role or claim without registry record or application'); }
  if (otherRoleApproved.length) reasons.push('approved application(s) for ANOTHER role only: ' + otherRoleApproved.map((a) => a.id + ' (' + lower(a.role) + ')').join(', '));
  const selfDecided = apps.filter((a) => isSelfDecision(a.decidedBy, uid)).map((a) => a.id);
  if (selfDecided.length) reasons.push('SELF-decided application(s): ' + selfDecided.join(', '));

  /* ownership */
  const claimed = [...cleanupIds].filter((id) => id.endsWith('/' + uid) || regs.some((r) => id === (r.kind === 'business' ? 'businesses' : r.kind + 's') + '/' + r.id));
  const ownership = claimed.length ? 'cleanup' : (state === STATES.INVALID_LEGACY || state === STATES.NONE ? 'remediation' : 'none');
  const transition = ownership === 'remediation' ? TRANSITION : null;

  /* application path — never invents, never auto-selects */
  let applicationPath;
  if (pending.length === 1) applicationPath = { mode: 'continue_existing', applicationId: pending[0].id };
  else if (pending.length > 1) applicationPath = { mode: 'select_among_pending', candidates: pending.map((a) => a.id), requiresSelection: true, note: 'the surface lists every pending application; the applicant continues ONE and withdraws the others; nothing is chosen for them and no new application is created' };
  else if (invalidApproved.length) applicationPath = { mode: 'redecide_existing', applicationId: invalidApproved[0].id, preserveDecision: true, note: 'acknowledge the current agreement on this application, then a fresh admin decision; the prior decision is appended to priorDecisions' };
  else applicationPath = { mode: 'fresh', note: 'no reusable application; submission through the existing intake schema' };

  const version = input.agreementVersion || null;
  const reusable = applicationPath.applicationId ? apps.find((a) => a.id === applicationPath.applicationId) : null;
  const agreement = { version, required: state !== STATES.BUYER_ONLY && state !== STATES.VALID && state !== STATES.REFUSED, satisfied: !!(reusable && reusable.agreementAccepted === true && reusable.agreementVersion === version), on: reusable ? reusable.id : null };
  const preserve = [...apps.filter((a) => a.decidedBy).map((a) => ({ record: 'applications/' + a.id, decidedBy: a.decidedBy, decidedAt: a.decidedAt || null })), ...regs.filter((r) => r.d.approvedAt).map((r) => ({ record: r.kind + '/' + r.id, approvedAt: r.d.approvedAt })), ...regs.filter((r) => r.d.approvalDecision).map((r) => ({ record: r.kind + '/' + r.id, approvalDecision: r.d.approvalDecision.decision, by: r.d.approvalDecision.decidedBy }))];
  const categoryStamp = (input.provider && input.provider.business && input.provider.business.category) ? { category: input.provider.business.category, source: input.provider.business.source, keep: true } : null;
  return { uid, state, subtype, reasons, transition, ownership, claimedBy: claimed, protected: state === STATES.VALID || state === STATES.BUYER_ONLY, applicationPath, agreement, preserve, selfDecided, categoryStamp, routedByShellNow: providerish || liveRegs.length > 0, publicNow: regs.some((r) => r.d.searchable === true || r.d.isPublic === true) };
}

module.exports = { STATES, TRANSITION, KIND_OF_ROLE, isSelfDecision, decisionValidity, deriveApprovalState };
