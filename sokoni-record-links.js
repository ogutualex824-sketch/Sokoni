/* ============================================================================
   SOKONI Record Links — sokoni-record-links.js                     (Slice C6)
   ============================================================================
   THE ONE vocabulary for linking to a platform record from another SOKONI app.

   A ticket, an application or a verification request lives in exactly one place:
   the AdminOS workspace that owns it. Every other surface — Super Admin, the
   Connect console, the customer support page, an email or a notification — links
   to that record by its STABLE ID. Nothing copies the record's state into a URL.

       admin-os.html#support?open=ticket:<id>
       admin-os.html#applications/queue?open=application:<id>
       admin-os.html#applications/verification?open=request:<id>
       support.html?ticket=<id>                 (the customer's own view)

   RULES
     • The route is the record's own route. `#support?open=application:x` is not
       a redirect; AdminOS drops the `open` and lands on Support.
     • An id is [A-Za-z0-9_-]{1,64} — Firestore auto-ids and nothing else. A
       malformed id builds NO link and opens NO record. This file never throws.
     • Consumed once: AdminOS rewrites the hash to the plain route after opening,
       so a reload or a shared bookmark of the plain route re-opens nothing.
     • Ids are CASE-SENSITIVE (Firestore). Never upper- or lower-case one.
   Loaded by admin-os.html, super-admin.html and support.html. A page without it
   builds no links and honours no `open` — an absent guard fails closed.
   ========================================================================== */
(function (global) {
  'use strict';

  var ID = /^[A-Za-z0-9_-]{1,64}$/;

  var KINDS = {
    ticket:      { section: 'support',      tab: null,           open: 'openTicket',              label: 'Ticket' },
    application: { section: 'applications', tab: 'queue',        open: 'openApplication',         label: 'Application' },
    request:     { section: 'applications', tab: 'verification', open: 'openVerificationRequest', label: 'Verification request' },
  };

  function isId(id) { return typeof id === 'string' && ID.test(id); }

  function route(kind) {
    var k = KINDS[kind];
    return k ? '#' + k.section + (k.tab ? '/' + k.tab : '') : null;
  }

  /** AdminOS link to one record, or null. */
  function link(kind, id) {
    if (!KINDS[kind] || !isId(id)) return null;
    return 'admin-os.html' + route(kind) + '?open=' + kind + ':' + id;
  }

  /** The `open=` part of a hash query, or null. `query` is the text after '?'. */
  function parseOpen(query) {
    var m = /(?:^|&)open=([a-z]+):([A-Za-z0-9_-]{1,64})(?:&|$)/.exec(String(query || ''));
    if (!m || !KINDS[m[1]]) return null;
    var k = KINDS[m[1]];
    return { kind: m[1], id: m[2], section: k.section, tab: k.tab, open: k.open };
  }

  /** The customer's own link to a ticket, or null. */
  function customerTicket(id) { return isId(id) ? 'support.html?ticket=' + id : null; }

  /** The ticket id named by a page's `location.search`, or null. */
  function ticketFromSearch(search) {
    var m = /(?:^\?|&)ticket=([A-Za-z0-9_-]{1,64})(?:&|$)/.exec(String(search || ''));
    return m ? m[1] : null;
  }

  global.SokoniRecordLinks = {
    KINDS: KINDS, isId: isId, route: route, link: link, parseOpen: parseOpen,
    customerTicket: customerTicket, ticketFromSearch: ticketFromSearch,
  };
})(typeof window !== 'undefined' ? window : this);
