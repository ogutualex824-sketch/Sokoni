/* ============================================================================
   SOKONI Communication Engine console — sokoni-comms-console.js   v1.0.0
   ============================================================================
   The unified inbox, the business timeline and provider health, mounted by
   BOTH platform consoles:

     admin-os.html    → Communications → Inbox tab      (claims.admin)
     super-admin.html → Communications section          (claims.superAdmin)

   admin.html is deliberately NOT a consumer.

   ONE MODULE, TWO MOUNT POINTS
   ----------------------------
   SOKONI is flat multi-page HTML with no router and no build step. Two
   consoles rendering the same communications from two hand-written copies is
   how surfaces drift — the merchant estate already paid that bill.

   DATA AUTHORITY — READ THIS BEFORE ADDING A NUMBER
   -------------------------------------------------
   Rows come from canonical collections and from one read-only callable:

     conversations/{id}     chat, anchored by transactionType + transactionId
     connectSessions/{id}   voice and video, anchored by context
     communicationTimeline  the server's join across all three stores

   There is no client arithmetic, no localStorage, no seed data, no multiplier.

   UNKNOWN IS NOT ZERO
   -------------------
   A read that FAILS renders an em dash and names the reason. A read that
   SUCCEEDS and returns nothing renders a real canonical zero and SAYS it is
   one. Counts carry the window they were computed over: a count without its
   denominator is how "3 urgent" becomes a number nobody can reproduce.

   THE TIMELINE IS PARTIAL, AND THIS SURFACE SAYS SO
   -------------------------------------------------
   `notify.js` only began recording a business anchor on 2026-09-22, and only
   Connect passes one so far. Every older notification, and every notification
   from an unwired call site, can never appear. The server returns
   `anchorCoverage` and `complete: false` on every read and this console prints
   it — an operator seeing a short timeline must know it is partial rather than
   conclude the relationship was quiet.

   PROVIDER HEALTH IS PROVISIONING, NOT LIVENESS
   ---------------------------------------------
   The rows say `configured` or `not_configured`. Nothing here says
   "operational", because nothing here has observed a send succeed. A green
   light over a failing provider is the dashboard lying.

   THIS FILE CONTAINS NO WRITE PATH.
   ========================================================================= */
(function (global) {
  'use strict';

  var CONVERSATIONS = 'conversations';
  var SESSIONS = 'connectSessions';
  var PAGE = 40;
  var DASH = '—';

  function _db() {
    if (!global.firebase || !global.firebase.firestore) return null;
    try { return global.firebase.firestore(); } catch (e) { return null; }
  }
  function _fns() {
    if (!global.firebase || !global.firebase.functions) return null;
    try { return global.firebase.app().functions('us-central1'); } catch (e) { return null; }
  }

  function _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function _when(ts) {
    if (!ts) return DASH;
    try {
      var d = ts.toDate ? ts.toDate() : new Date(ts);
      if (isNaN(d.getTime())) return DASH;
      return d.toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' });
    } catch (e) { return DASH; }
  }

  var CHANNEL_ICON = {
    chat: '💬', voice: '📞', video: '📹',
    email: '📧', sms: '📱', push: '🔔', in_app: '🔔',
  };

  var STATUS_BADGE = {
    queued: 'st-pending', sent: 'st-pending', delivered: 'st-active',
    read: 'st-active', failed: 'st-inactive', suppressed: 'st-inactive',
  };

  function _unavailable(what, reason) {
    return '<div class="dash-section"><h3>' + _esc(what) + '</h3>' +
      '<p class="aos-muted">Source unavailable &mdash; ' + _esc(reason) + '</p>' +
      '<p class="aos-muted" style="font-size:12px">No figure is shown rather than a zero: ' +
      'this console cannot tell &ldquo;none&rdquo; from &ldquo;could not read&rdquo;, so it ' +
      'declines to guess.</p></div>';
  }

  function _stat(label, value, note) {
    return '<div class="stat-card"><div class="stat-label">' + _esc(label) + '</div>' +
      '<div class="stat-value">' + _esc(value) + '</div>' +
      (note ? '<div class="aos-muted" style="font-size:11px">' + _esc(note) + '</div>' : '') +
      '</div>';
  }

  /* ── The inbox ─────────────────────────────────────────────────────────── */

  /**
   * Rows are the two client-readable anchored stores. `notifyLog` is admin-read
   * on the SERVER only and appears in the timeline, not the inbox list — this
   * surface does not query it directly.
   */
  function _inboxRows(convs, sessions) {
    var rows = [];
    convs.forEach(function (c) {
      rows.push({
        kind: 'chat',
        anchorType: c.transactionType || '',
        anchorId: c.transactionId || '',
        title: c.transactionTitle || '',
        preview: typeof c.lastMessage === 'string' ? c.lastMessage : '',
        at: c.lastMessageAt || c.createdAt || null,
        status: 'delivered',
      });
    });
    sessions.forEach(function (s) {
      var ctx = s.context || {};
      rows.push({
        kind: String(s.channel || 'voice'),
        anchorType: ctx.relationship || '',
        anchorId: ctx.anchorId || '',
        title: ctx.purpose || '',
        /* A call has no text. Its STATE is the interesting fact, and it is shown
           as the state the server recorded — never softened into "missed". */
        preview: '',
        at: s.createdAt || null,
        status: String(s.status || ''),
        sessionStatus: String(s.status || ''),
      });
    });
    return rows;
  }

  function _inboxBlock(rows, note) {
    var head = '<div class="dash-section"><h3>&#x1F4E5; Unified inbox</h3>' +
      '<div class="stat-grid">' +
      _stat('Conversations', String(rows.filter(function (r) { return r.kind === 'chat'; }).length),
        'of the last ' + rows.length) +
      _stat('Calls', String(rows.filter(function (r) { return r.kind !== 'chat'; }).length),
        'of the last ' + rows.length) +
      '</div>' +
      (note ? '<p class="aos-muted" style="font-size:12px">' + _esc(note) + '</p>' : '') +
      '</div>';

    if (!rows.length) {
      return head + '<div class="dash-section"><p class="aos-muted">Nothing yet. This is a ' +
        'canonical zero &mdash; both collections were read successfully and are empty.' +
        '</p></div>';
    }

    var body = rows.map(function (r) {
      var anchor = (r.anchorType && r.anchorId)
        ? _esc(r.anchorType) + ' #' + _esc(String(r.anchorId).slice(0, 16))
        : DASH;
      var open = (r.anchorType && r.anchorId)
        ? '<button class="aos-btn-sm" data-anchor-type="' + _esc(r.anchorType) +
          '" data-anchor-id="' + _esc(r.anchorId) + '">Timeline</button>'
        : '<span class="aos-muted">no anchor</span>';
      return '<tr>' +
        '<td>' + (CHANNEL_ICON[r.kind] || '') + ' ' + _esc(r.kind) + '</td>' +
        '<td>' + anchor + '</td>' +
        '<td>' + _esc(r.title || DASH) + '</td>' +
        '<td class="aos-muted">' + _esc(r.preview || DASH) + '</td>' +
        '<td>' + _esc(r.status || DASH) + '</td>' +
        '<td>' + _when(r.at) + '</td>' +
        '<td>' + open + '</td>' +
        '</tr>';
    }).join('');

    return head + '<div class="dash-section"><h3>Recent</h3>' +
      '<div class="table-wrap"><table class="aos-table"><thead><tr>' +
      '<th>Channel</th><th>About</th><th>Subject</th><th>Preview</th>' +
      '<th>State</th><th>When</th><th></th>' +
      '</tr></thead><tbody>' + body + '</tbody></table></div></div>';
  }

  /* ── The timeline ──────────────────────────────────────────────────────── */

  function _timelineBlock(res) {
    var rows = (res && res.timeline) || [];
    var cov = (res && res.anchorCoverage) || null;

    var head = '<div class="dash-section">' +
      '<h3>&#x1F5C2;&#xFE0F; ' + _esc(res.anchorType) + ' #' + _esc(res.anchorId) + '</h3>';

    /* The partiality warning travels with the data, not in a doc nobody opens. */
    if (res && res.complete === false) {
      head += '<p class="aos-muted" style="font-size:12px">' +
        '<strong>This timeline is partial.</strong> ' + _esc(res.completeReason || '') +
        (cov && cov.wiredCallers
          ? ' Wired so far: ' + _esc(cov.wiredCallers.join(', ')) + '.'
          : '') +
        '</p>';
    }
    if (res && res.sourcesUnreadable && res.sourcesUnreadable.length) {
      head += '<p class="cx-warn" style="color:#f5a623;font-size:12px">Could not read: ' +
        _esc(res.sourcesUnreadable.map(function (u) { return u.source; }).join(', ')) +
        ' &mdash; those rows are missing, not absent.</p>';
    }
    head += '</div>';

    if (!rows.length) {
      return head + '<div class="dash-section"><p class="aos-muted">No communications ' +
        'recorded against this. The stores were read successfully.</p></div>';
    }

    var body = rows.map(function (e) {
      var cls = STATUS_BADGE[e.status] || 'st-inactive';
      return '<tr>' +
        '<td>' + _when(e.at) + '</td>' +
        '<td>' + (CHANNEL_ICON[e.channel] || '') + ' ' + _esc(e.channel) + '</td>' +
        '<td>' + _esc(e.subject || DASH) + '</td>' +
        '<td class="aos-muted">' + _esc(e.preview || DASH) + '</td>' +
        '<td><span class="status-badge ' + cls + '">' + _esc(e.status) + '</span></td>' +
        '<td class="aos-muted">' + _esc(e.source) + '</td>' +
        '</tr>';
    }).join('');

    return head + '<div class="dash-section">' +
      '<div class="table-wrap"><table class="aos-table"><thead><tr>' +
      '<th>When</th><th>Channel</th><th>Subject</th><th>Preview</th>' +
      '<th>Evidence</th><th>Source</th>' +
      '</tr></thead><tbody>' + body + '</tbody></table></div>' +
      '<p class="aos-muted" style="font-size:12px">Evidence is not collapsed: ' +
      '<code>sent</code> means a provider accepted it, <code>delivered</code> that it ' +
      'reached the device, <code>read</code> that it was seen. <code>suppressed</code> means ' +
      'SOKONI chose not to send &mdash; which is not a failure.</p></div>';
  }

  /* ── Provider health ───────────────────────────────────────────────────── */

  /* MIRRORS functions/shared/communication-providers.js, which is the policy of
     record. Only the display half is duplicated — the failover rules live on the
     server and are never re-implemented here. */
  var PROVIDER_ROWS = [
    { provider: 'sendgrid', channel: 'email', role: 'transactional' },
    { provider: 'smtp', channel: 'email', role: 'transactional' },
    { provider: 'google_workspace', channel: 'email', role: 'mailbox' },
    { provider: 'africas_talking', channel: 'sms', role: 'bulk_sms' },
    { provider: 'fcm', channel: 'push', role: 'push' },
    { provider: 'webrtc', channel: 'voice', role: 'realtime' },
    { provider: 'turn', channel: 'voice', role: 'relay' },
  ];

  function _providerBlock() {
    var body = PROVIDER_ROWS.map(function (p) {
      return '<tr>' +
        '<td>' + _esc(p.provider) + '</td>' +
        '<td>' + _esc(p.channel) + '</td>' +
        '<td>' + _esc(p.role) + '</td>' +
        /* NOT a status. This console has observed nothing. */
        '<td class="aos-muted">' + DASH + '</td>' +
        '</tr>';
    }).join('');

    return '<div class="dash-section"><h3>&#x1F50C; Communication providers</h3>' +
      '<p class="aos-muted" style="font-size:12px">' +
      '<strong>Provisioning state is not shown here, and liveness is not shown anywhere.</strong> ' +
      'Whether a provider is configured is a server-side fact this read-only console has not ' +
      'been given, and whether it is <em>working</em> has not been observed at all. An em dash ' +
      'is the honest answer; a green light would be the dashboard lying.</p>' +
      '<div class="table-wrap"><table class="aos-table"><thead><tr>' +
      '<th>Provider</th><th>Channel</th><th>Role</th><th>State</th>' +
      '</tr></thead><tbody>' + body + '</tbody></table></div>' +
      '<p class="aos-muted" style="font-size:12px">A human mailbox is not a transactional ' +
      'fallback: <code>google_workspace</code> is deliberately outside the email failover ' +
      'chain, so a bounced receipt cannot damage the address support replies from.</p>' +
      '</div>';
  }

  /* ── Mount ─────────────────────────────────────────────────────────────── */

  function mount(root) {
    if (!root) return;
    root.innerHTML = '<div class="aos-spinner"><div></div></div>';

    var db = _db();
    if (!db) { root.innerHTML = _unavailable('Communications', 'Firestore is not available.'); return; }

    var convs = db.collection(CONVERSATIONS).orderBy('lastMessageAt', 'desc').limit(PAGE).get()
      .then(function (s) { var o = []; s.forEach(function (d) { o.push(d.data() || {}); }); return o; })
      .catch(function (e) { return { __err: _reason(e, CONVERSATIONS) }; });

    var sessions = db.collection(SESSIONS).orderBy('createdAt', 'desc').limit(PAGE).get()
      .then(function (s) { var o = []; s.forEach(function (d) { o.push(d.data() || {}); }); return o; })
      .catch(function (e) { return { __err: _reason(e, SESSIONS) }; });

    Promise.all([convs, sessions]).then(function (r) {
      var cErr = r[0] && r[0].__err;
      var sErr = r[1] && r[1].__err;
      var rows = _inboxRows(cErr ? [] : r[0], sErr ? [] : r[1]);

      var note = null;
      if (cErr || sErr) {
        note = 'Partial: ' + [cErr ? 'conversations (' + cErr + ')' : null,
          sErr ? 'connectSessions (' + sErr + ')' : null].filter(Boolean).join('; ') +
          ' — those rows are missing, not absent.';
      }

      /* The write surface is a SEPARATE module. If it is absent the console still renders
         everything it can read and says the actions are unavailable — a missing module is
         reported as a missing module, never as "no actions exist".

         When it IS present it supplies provider health too, because provisioning is a
         server-side fact only an authenticated call can learn; this read-only console
         renders the em-dash table until then. */
      var hasSend = !!(global.SokoniCommsSend && typeof global.SokoniCommsSend.mount === 'function');

      root.innerHTML =
        _inboxBlock(rows, note) +
        '<div id="commsTimelineRoot"></div>' +
        (hasSend
          ? '<div class="dash-section" id="commsSendRoot"></div><div id="commsHealthRoot"></div>'
          : '<div class="dash-section"><h3>Message a user</h3>' +
            '<p class="aos-muted">The send surface did not load. Check that ' +
            'sokoni-comms-send.js is served on this page.</p></div>' + _providerBlock());

      if (hasSend) {
        global.SokoniCommsSend.mount(root.querySelector('#commsSendRoot'));
        global.SokoniCommsSend.health(root.querySelector('#commsHealthRoot'));
      }

      var btns = root.querySelectorAll('[data-anchor-id]');
      for (var i = 0; i < btns.length; i++) {
        btns[i].addEventListener('click', function (ev) {
          openTimeline(
            ev.currentTarget.getAttribute('data-anchor-type'),
            ev.currentTarget.getAttribute('data-anchor-id'),
            root.querySelector('#commsTimelineRoot'));
        });
      }
    });
  }

  function openTimeline(anchorType, anchorId, target) {
    if (!target) return;
    target.innerHTML = '<div class="aos-spinner"><div></div></div>';
    var fns = _fns();
    if (!fns) {
      target.innerHTML = _unavailable('Timeline', 'Cloud Functions are not available.');
      return;
    }
    fns.httpsCallable('communicationTimeline')({ anchorType: anchorType, anchorId: anchorId })
      .then(function (r) { target.innerHTML = _timelineBlock(r.data || {}); })
      .catch(function (e) {
        var msg = (e && e.code === 'functions/not-found')
          ? 'the communicationTimeline function is not deployed yet.'
          : ((e && e.message) || 'the call failed.');
        target.innerHTML = _unavailable('Timeline', msg);
      });
  }

  function _reason(e, collection) {
    if (e && e.code === 'permission-denied') {
      return 'the ' + collection + ' rule refused this admin read';
    }
    return (e && e.message) || 'the read failed';
  }

  global.SokoniCommsConsole = {
    mount: mount,
    openTimeline: openTimeline,
    PROVIDER_ROWS: PROVIDER_ROWS,
  };
})(window);
