'use strict';
/**
 * SOKONI — WHICH providers/{uid} RECORDS MAY BE IN PUBLIC SEARCH  (Tech Hub slice 4K, 2026-10-03, sokoni-b2)
 * ===================================================================================================================
 * The ONE rule both search pipelines use (algolia-sync.js, typesense-sync.js) for the providers registry — the same rule
 * the public directory applies (sokoni-providers.js: status active | approved):
 *
 *   indexable  ⇔  status ∈ {active, approved}  AND  searchable !== false
 *
 * Why it exists: applicationLifecycle.projectProvider retracts a suspended / refused provider with
 * { status:'suspended', searchable:false } and its comment relied on "the existing update trigger" deleting it from the
 * index — but algolia-sync had NO providers rule (a suspended provider stayed searchable) and typesense-sync indexed
 * pending records and ignored searchable:false. A record that is not approved is never public.
 *
 * Pure: no I/O.
 */
const PUBLIC_STATUSES = Object.freeze(['active', 'approved']);

function isProviderIndexable(data) {
  if (!data || typeof data !== 'object') return false;
  const st = String(data.status == null ? '' : data.status).trim().toLowerCase();
  return PUBLIC_STATUSES.includes(st) && data.searchable !== false;
}

module.exports = { PUBLIC_STATUSES, isProviderIndexable };
