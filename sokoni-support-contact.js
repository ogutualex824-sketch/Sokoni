/* ============================================================================
   SOKONI Support contact — sokoni-support-contact.js   v1.0.0
   ============================================================================
   THE ONE in-platform path from a user to SOKONI support.

   WHAT THIS REPLACES, AND WHY IT MATTERS
   --------------------------------------
   `support.html` collected a name, a phone number, a category, a priority and
   a description, then called `SokoniLaunch.submitTicket`, which does this:

       _save('support_tickets', ticket);      // localStorage
       return 'TKT' + Date.now().toString(36).toUpperCase();

   The ticket never left the device. The page then showed, unconditionally:

       "Ticket Submitted! We've received your issue and will respond within
        24 hours."

   That sentence was not true. Nobody received it, nothing was reviewed, and
   the "Track Ticket" tab read the same localStorage back — so a user whose
   browser data was cleared was told their ticket did not exist. The only real
   escape hatch offered was WhatsApp.

   So this module does one thing: it puts the ticket on the server, and it does
   not say "submitted" until the server says so.

   THE RULES IT KEEPS
   ------------------
   · NO SUCCESS BEFORE THE SERVER CONFIRMS. The id shown is the id Firestore
     generated, never one this file invented.
   · A FAILURE IS REPORTED AS A FAILURE, with what the user can do next. It is
     never dressed up as a submission.
   · NO SECOND STORE. `supportTickets` is the canonical collection and the
     ticket id IS the `support` business anchor, so the case joins the unified
     communication timeline with no extra plumbing.
   · localStorage is a CONVENIENCE CACHE of a real server id — never the record.
     Losing it loses a shortcut, not a ticket.
   · Sign-in is required, because a ticket with no account cannot be answered,
     cannot be anchored, and cannot appear in anyone's timeline.

   NOT A FOURTH SUPPORT PAGE. `contact.html` and `help.html` link here; this
   module is mounted by the surfaces that already exist.
   ========================================================================= */
(function (global) {
  'use strict';

  /* Mirrors the categories support.html already offers. The server stores the
     category as free text, so this list is a menu, not an authority. */
  var CATEGORIES = ['payment', 'order', 'delivery', 'account', 'seller', 'ride',
    'verification', 'technical', 'other'];

  var PRIORITIES = ['low', 'medium', 'high'];

  /**
   * validate(input) -> { ok, reason }
   *
   * PURE, and exported so the rules are testable without a network. Refuses
   * rather than trimming into something the user did not write.
   */
  function validate(input) {
    var i = input || {};
    var subject = String(i.subject || '').trim();
    var message = String(i.message || '').trim();
    if (!subject) return { ok: false, reason: 'subject_required' };
    if (!message) return { ok: false, reason: 'message_required' };
    /* The server caps these; refusing here means the user is told before they
       lose the tail of what they wrote. */
    if (subject.length > 200) return { ok: false, reason: 'subject_too_long' };
    if (message.length > 2000) return { ok: false, reason: 'message_too_long' };
    var category = String(i.category || 'other');
    if (CATEGORIES.indexOf(category) === -1) return { ok: false, reason: 'unknown_category' };
    var priority = String(i.priority || 'medium');
    if (PRIORITIES.indexOf(priority) === -1) return { ok: false, reason: 'unknown_priority' };
    if (i.context !== undefined && i.context !== null && !contextFor(i.context)) return { ok: false, reason: 'invalid_context' };
    return { ok: true, reason: 'valid' };
  }

  /* Optional business context (Slice V2): which SOKONI record the case is about.
     Mirrors the server's closed key set and id alphabet so the user is told before
     the server refuses. A POINTER only — the server stores it, the workspace that
     follows it re-reads the record under its own authority. Returns null when
     nothing valid is present, or false when the shape is wrong. */
  var CONTEXT_KEYS = ['applicationId', 'requestId', 'verificationId'];
  var ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
  function contextFor(raw) {
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== 'object' || Array.isArray(raw)) return false;
    var out = {}, any = false;
    for (var k in raw) {
      if (!Object.prototype.hasOwnProperty.call(raw, k)) continue;
      if (CONTEXT_KEYS.indexOf(k) === -1) return false;
      var v = raw[k];
      if (v === undefined || v === null || v === '') continue;
      if (typeof v !== 'string' || !ID_RE.test(v)) return false;
      out[k] = v; any = true;
    }
    return any ? out : null;
  }

  /**
   * payloadFor(input) -> the exact object sent to the server.
   *
   * PURE, and named so a test can inspect what leaves the browser. It carries
   * NO recipient of any kind — a support case is addressed to SOKONI by virtue
   * of being a support case, and letting a client name who receives it would be
   * the same defect Connect exists to prevent.
   */
  function payloadFor(input) {
    var i = input || {};
    var p = {
      op: 'adminCreateSupportTicket',
      category: String(i.category || 'other'),
      subject: String(i.subject || '').trim().slice(0, 200),
      message: String(i.message || '').trim().slice(0, 2000),
      priority: String(i.priority || 'medium'),
    };
    var ctx = contextFor(i.context);
    if (ctx) p.context = ctx;           /* absent when there is none — the old payload, unchanged */
    return p;
  }

  function _fns() {
    if (!global.firebase || !global.firebase.functions) return null;
    try { return global.firebase.app().functions('us-central1'); } catch (e) { return null; }
  }

  function _signedIn() {
    try { return !!(global.firebase && global.firebase.auth && global.firebase.auth().currentUser); }
    catch (e) { return false; }
  }

  /**
   * describeFailure(e) -> string
   *
   * Says what actually happened and what the user can do. It never implies the
   * ticket was received.
   */
  function describeFailure(e) {
    var code = (e && e.code) || '';
    if (/unauthenticated/.test(code) || (e && e.message === 'auth/unauthenticated')) {
      return 'Please sign in first — we need an account to reply to.';
    }
    if (/permission-denied/.test(code)) {
      return 'That was refused. Please sign in and try again.';
    }
    if (/not-found|internal|unavailable/.test(code)) {
      return 'We could not reach SOKONI support just now. Your message was NOT sent — '
        + 'please try again, or use one of the contact options above.';
    }
    return 'Your message was NOT sent. ' + ((e && e.message) || 'Please try again.');
  }

  /**
   * submit(input) -> Promise<{ ok, ticketId, anchor } | rejects>
   *
   * Resolves ONLY when the server has created the ticket and returned its id.
   */
  function submit(input) {
    var v = validate(input);
    if (!v.ok) return Promise.reject(new Error(v.reason));
    if (!_signedIn()) return Promise.reject(new Error('auth/unauthenticated'));

    var fns = _fns();
    if (!fns) return Promise.reject(new Error('unavailable'));

    return fns.httpsCallable('adminOsDispatch')(payloadFor(input))
      .then(function (envelope) {
        var data = (envelope && envelope.data) || {};
        /* The SERVER's id. If it did not give one, this did not succeed, and
           saying otherwise would repeat the defect this module replaces. */
        if (!data.ticketId) throw new Error('no_ticket_id_returned');

        /* A convenience cache of a REAL id. Never the record. */
        try {
          global.localStorage.setItem('_sokoniLastTicket',
            JSON.stringify({ id: data.ticketId, ts: Date.now(), server: true }));
        } catch (e) { /* a blocked localStorage must not fail a submitted ticket */ }

        return {
          ok: true,
          ticketId: data.ticketId,
          /* The ticket id IS the support anchor. The case joins the unified
             communication timeline with no further plumbing. */
          anchor: { anchorType: 'support', anchorId: data.ticketId },
        };
      });
  }

  var CONTRACT = ['CATEGORIES', 'PRIORITIES', 'validate', 'payloadFor',
    'describeFailure', 'submit'];

  global.SokoniSupportContact = {
    CONTRACT: CONTRACT,
    CATEGORIES: CATEGORIES,
    PRIORITIES: PRIORITIES,
    CONTEXT_KEYS: CONTEXT_KEYS,
    contextFor: contextFor,
    validate: validate,
    payloadFor: payloadFor,
    describeFailure: describeFailure,
    submit: submit,
  };
})(typeof window !== 'undefined' ? window : globalThis);
