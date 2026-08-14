'use strict';
/**
 * SOKONI — Canonical role vocabulary  (Roles Phase 1)
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * Until now an applicant's role was DERIVED, never declared. `resolveRole()` in
 * application-lifecycle.js pooled nine free-text fields — role, type, category,
 * hub, professionalType, businessType, serviceType … — and keyword-matched them,
 * falling through to `provider` when nothing matched. That had three consequences
 * the platform is still carrying:
 *
 *   · `mechanic` was a keyword INSIDE the provider pattern, so every garage that
 *     ever applied became a generic provider;
 *   · `health` and `legal` resolved to their own registries but collapsed to the
 *     `provider` role key on the account;
 *   · `landlord` and `tenant` had no path at all — a landlord application landed
 *     on `provider` by default and nothing said so.
 *
 * An intake vocabulary cannot be fixed by guessing harder. The applicant, or the
 * surface acting for them, must SAY which role is being requested. This module is
 * the single definition of what may be said.
 *
 * ── What this module is NOT ─────────────────────────────────────────────────
 * It does not decide registries, claims, activeRole or workspaces. Approval
 * remains the only authority that grants anything (Phase 2). This is vocabulary
 * only: it answers "is this a role we recognise, and what is it called".
 */

/* The canonical set. Anything not in here is not a role, and an application
   naming something else is quarantined for a human rather than guessed at. */
const CANONICAL_ROLES = Object.freeze([
  'buyer',      /* implicit baseline — every account has it */
  'seller',
  'provider',   /* generic services; NO LONGER the dumping ground for the rest */
  'mechanic',
  'rider',
  'health',
  'legal',
  'landlord',
  'tenant',     /* RENTAL tenant. Unrelated to the `tenants/` collection, which is
                   inventory multi-tenancy (isTenantMember / sellerId claim). */
  'admin',
  'staff',
]);

const _CANON = new Set(CANONICAL_ROLES);

/* Legacy spellings that MEAN a canonical role. Kept because production documents,
   custom claims and `users.roles` arrays already contain them — normalising is how
   an old application keeps working, not a courtesy.
   `driver` is the wizard's own word and `rider` is the account role key that
   grantAccountRole already writes, so the two have to agree here. */
const ALIASES = Object.freeze({
  merchant:   'seller',
  vendor:     'seller',
  shop:       'seller',
  driver:     'rider',
  delivery:   'rider',
  courier:    'rider',
  boda:       'rider',
  healthcare: 'health',
  medical:    'health',
  lawyer:     'legal',
  advocate:   'legal',
  user:       'buyer',
  customer:   'buyer',
  garage:     'mechanic',
});

/** Canonical name for a declared role, or null if it is not one.
 *  Case and surrounding whitespace are forgiving; meaning is not. */
function normalizeRole(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (!v) return null;
  if (_CANON.has(v)) return v;
  return ALIASES[v] || null;
}

/** Is this already a canonical role name? */
function isCanonicalRole(value) {
  return typeof value === 'string' && _CANON.has(value.trim().toLowerCase());
}

/* Roles whose registry/profile is established in Phase 2. Recorded here so the
   gap is visible in code rather than remembered: an approval for one of these is
   accepted and recorded, but its dedicated registry does not exist yet.
   mechanics/{docId} DOES exist and is self-registered via claimsOwner() — Phase 1
   deliberately does not gate it, so existing mechanics keep working. */
const REGISTRY_PENDING = Object.freeze(['mechanic', 'landlord', 'tenant']);

module.exports = {
  CANONICAL_ROLES,
  ALIASES,
  REGISTRY_PENDING,
  normalizeRole,
  isCanonicalRole,
};
