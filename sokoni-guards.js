/**
 * SOKONI — Page Guards  v2.0
 *
 * Reads the data-require-auth and data-require-role attributes from <html>
 * and enforces them immediately when this script loads.
 *
 * Usage (add to <html> tag):
 *   <html data-require-auth="true">                   ← any logged-in user
 *   <html data-require-auth="true" data-require-role="seller">
 *
 * This file must be loaded AFTER sokoni-security.js and as early as possible
 * in <head> (before any UI renders).
 */
(function () {
  'use strict';

  /* Only admin.html requires authentication — all hubs/services are open */
  const PAGE_ROLES = {
    'admin.html': 'admin',
  };

  const page = window.location.pathname.split('/').pop() || 'index.html';

  /* Read inline data attrs if present */
  const html        = document.documentElement;
  const requireAuth = html.dataset.requireAuth === 'true';
  const requireRole = html.dataset.requireRole || null;

  /* Check both sources */
  const needsAuth  = requireAuth || (page in PAGE_ROLES);
  const neededRole = requireRole || PAGE_ROLES[page] || null;

  if (!needsAuth) return; /* public page — nothing to do */

  if (typeof window.SokoniSecurity === 'undefined') {
    console.error('[SOKONI] sokoni-security.js must load before sokoni-guards.js');
    sessionStorage.setItem('sokoniLoginRedirect', page);
    window.location.replace('login.html');
    return;
  }

  SokoniSecurity.requireAuth(neededRole || undefined);

})();
