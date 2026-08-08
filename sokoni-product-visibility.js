/* ════════════════════════════════════════════════════════════════════════
   SOKONI product visibility — the ONE canonical "is this an ACTIVE product?"
   predicate. Active = shown in the catalogue, counted in active-product tiles,
   returned by Shop/POS/Inventory search. Archived/hidden = kept for historical
   order references but excluded from all active surfaces.

   Why this exists: the same predicate was inlined in seller.js (the active-count
   tile), sokoni-reconcile.js (convergence count) and functions/index.js
   (/api/catalogue). They drifted — the count tile used a raw server aggregate with
   NO status filter, so archiving 2 products left the count at 103. Centralising the
   rule here (and testing it) keeps active-count = active only, everywhere.

   CRITICAL: a product with NO `status` field is ACTIVE (absent = active). Most
   legacy KASS products have no status — filtering them out would hide 92 of 103
   real products (see functions/index.js catalogue note). So we exclude only the
   EXPLICIT hidden states, `isVisible===false`, and explicit delete flags.
   Mirror any change to the server predicate in functions/index.js.
   ════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  var HIDDEN = ['deleted', 'removed', 'hidden', 'draft', 'archived', 'banned', 'suspended', 'paused', 'inactive', 'rejected'];
  var _H = {}; HIDDEN.forEach(function (s) { _H[s] = 1; });

  function isActiveProduct (p) {
    if (!p) return false;
    if (_H[String(p.status || '').toLowerCase()]) return false;   /* explicit hidden state */
    if (p.isVisible === false) return false;
    if (p.visible === false) return false;
    if (p.isDeleted === true || p.deleted === true) return false;
    return true;                                                  /* absent status = active */
  }
  function isArchived (p) { return !isActiveProduct(p); }
  function activeOnly (list) { return (list || []).filter(isActiveProduct); }
  function countActive (list) { return activeOnly(list).length; }

  var api = { HIDDEN: HIDDEN.slice(), isActiveProduct: isActiveProduct, isArchived: isArchived, activeOnly: activeOnly, countActive: countActive };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SokoniProductVisibility = api;
})(typeof window !== 'undefined' ? window : this);
