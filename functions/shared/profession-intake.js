'use strict';
/**
 * SOKONI — provider-onboarding.html JOB TITLE → the ONE intake's business id  (Tech Hub slice 4N, 2026-10-03, sokoni-b2)
 * ===================================================================================================================
 * provider-onboarding.html offers job titles ("Network Engineer", "Electrician", …). business-category.FROM_PROFESSION
 * already classifies them, but the capability engine reads BUSINESS IDS (hub-register CATS / service-capabilities
 * FROM_BUSINESS_ID), so an approved "Network Engineer" got a category and no dashboard capability. This maps each title to
 * the EXISTING intake id that names the same thing — nothing is invented: every value must be a key of
 * business-category.FROM_BUSINESS_ID (scripts/test-provider-onboarding-intake.js asserts it). A title with no exact id
 * maps to null and is classified by FROM_PROFESSION / AdminOS as before.
 *
 * Mapping is a REQUEST label on the application. It grants nothing; AdminOS approval does.
 */
const PROFESSION_TO_BUSINESS_ID = Object.freeze({
  /* Home Services */
  electrician: 'electrical', plumber: 'plumbing', carpenter: 'carpentry', painter: 'painting', cleaner: 'cleaning',
  gardener: 'landscaping', 'pest control': 'pest-control', 'appliance repair': 'ac-repair', hvac: 'ac-repair', mover: 'moving',
  /* Security */
  'security guard': 'security-guard', 'cctv installation': 'cctv', 'access control': 'cctv',
  /* Technology */
  'software developer': 'software', 'web designer': 'web-developer', 'it support': 'it-support', 'network engineer': 'networking',
  /* Creative & Media */
  photographer: 'photographer', videographer: 'videographer', 'graphic designer': 'graphic-design', 'content creator': 'content-creator',
  dj: 'dj', mc: 'mc',
  /* Business / Legal / Education / Fashion / Construction / Events / Logistics / Freelance */
  accountant: 'accounting', lawyer: 'lawyer', notary: 'notary', tutor: 'tutor', tailor: 'tailor', architect: 'architect',
  'event planner': 'event-planner', caterer: 'catering', courier: 'courier', 'data entry': 'data-entry', salon: 'salon',
});

const _norm = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ');

/** The intake business id for a job title, or null when no existing id names it exactly. */
function businessIdForProfession(title) {
  const k = _norm(title);
  return Object.prototype.hasOwnProperty.call(PROFESSION_TO_BUSINESS_ID, k) ? PROFESSION_TO_BUSINESS_ID[k] : null;
}

module.exports = { PROFESSION_TO_BUSINESS_ID, businessIdForProfession };
