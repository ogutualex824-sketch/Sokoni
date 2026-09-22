/* ============================================================================
   SOKONI Connect Console — sokoni-connect-console.js   v1.1.0
   ============================================================================
   The platform's view of business communication sessions and video
   verifications, mounted by BOTH platform-admin consoles:

     admin-os.html    → panel "comms" → tab "connect"   (claims.admin)
     super-admin.html → panel "connect"                 (claims.superAdmin)

   admin.html is deliberately NOT a consumer. AdminOS is the canonical admin
   workspace; a second hand-written copy of this surface is how the merchant
   estate diverged.

   WHY A SHARED MODULE RATHER THAN A PANEL PER CONSOLE
   ---------------------------------------------------
   SOKONI is flat multi-page HTML with no router and no build step. Two
   consoles rendering the same sessions from two copies is how surfaces drift.
   One module, two mount points: a change to how a session is presented lands
   in both consoles at once, or in neither.

   THIS FILE CONTAINS NO WRITE PATH
   --------------------------------
   Deliberate, and the certification suite asserts it. The one write surface —
   opening a verification and recording its outcome — lives in
   sokoni-connect-verify.js, exactly as sokoni-gcp-admin.js is kept apart from
   sokoni-integrations.js. That guarantee is worth more than one fewer script
   tag.

   DATA AUTHORITY — READ THIS BEFORE ADDING A NUMBER
   -------------------------------------------------
   Every figure comes from a canonical Firestore collection written ONLY by
   functions/connect-calls.js:

     connectSessions/{id}         every chat/voice/video session
     connectVerifications/{id}    video verification sessions and their outcome

   Both are `allow write: if false` — for everyone, including admins. There is
   no client arithmetic, no localStorage, no seed data, no multiplier.

   UNKNOWN IS NOT ZERO
   -------------------
   A read that FAILS renders an em dash and names the reason. A read that
   SUCCEEDS and returns nothing renders a real canonical zero and SAYS it is
   one. "No calls today" and "we could not find out" must never look the same.

   Counts are always labelled with the window they were computed over. A count
   without its denominator is how "3 active calls" becomes a number nobody can
   reproduce.

   A VERIFICATION IS NOT A VERDICT
   -------------------------------
   `providerVerification` is the canonical authority for whether an account is
   verified, and an official identity additionally requires a passed identity
   check, a passed face check and a completed human review. A row here says a
   video session happened and what the admin observed. This console prints that
   distinction on the surface rather than trusting the reader to know it.

   RULES DEPENDENCY — STATED, NOT ASSUMED
   --------------------------------------
   The blocks for both collections are present in firestore.rules SOURCE and in
   firestore.rules.build, and are NOT DEPLOYED at the time of writing. Until
   they are, an admin read returns permission-denied and this console renders
   the unavailable state with that reason — which is correct behaviour, not a
   bug to route around. It does not invent a number to fill the space.
   ========================================================================= */
(function (global) {
  'use strict';

  var SESSIONS = 'connectSessions';
  var VERIFICATIONS = 'connectVerifications';
  var PAGE = 50;

  function _db() {
    if (!global.firebase || !global.firebase.firestore) return null;
    try { return global.firebase.firestore(); } catch (e) { return null; }
  }

  function _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* The neutral state. Never '0' — a dash says "not known", a zero says "none happened". */
  var DASH = '—';

  function _when(ts) {
    if (!ts) return DASH;
    try {
      var d = ts.toDate ? ts.toDate() : new Date(ts);
      if (isNaN(d.getTime())) return DASH;
      return d.toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' });
    } catch (e) { return DASH; }
  }

  var STATUS_BADGE = {
    requested: 'st-pending',
    ringing:   'st-pending',
    connected: 'st-active',
    ended:     'st-inactive',
    declined:  'st-inactive',
  };
  var OUTCOME_BADGE = {
    verified:     'st-active',
    not_verified: 'st-inactive',
    inconclusive: 'st-pending',
    abandoned:    'st-inactive',
  };

  function _badge(value, map) {
    var cls = map[value] || 'st-inactive';
    return '<span class="status-badge ' + cls + '">' + _esc(value || 'unknown') + '</span>';
  }

  function _tally(rows) {
    var t = { live: 0, video: 0, platform: 0, enterprise: 0, voice: 0 };
    rows.forEach(function (r) {
      if (r.status === 'connected' || r.status === 'ringing' || r.status === 'requested') t.live++;
      if (r.channel === 'video') t.video++;
      if (r.channel === 'voice') t.voice++;
      if (r.mode === 'PLATFORM') t.platform++;
      if (r.mode === 'ENTERPRISE') t.enterprise++;
    });
    return t;
  }

  /* The relationships a session was opened under, counted. This is the
     "communications centre" view — who is talking to whom, by business
     relationship, never by identity. */
  function _byRelationship(rows) {
    var m = {};
    rows.forEach(function (r) {
      var k = (r.context && r.context.relationship) || 'unknown';
      m[k] = (m[k] || 0) + 1;
    });
    return m;
  }

  function _unavailable(what, reason) {
    return '<div class="dash-section">' +
      '<h3>' + _esc(what) + '</h3>' +
      '<p class="aos-muted">Source unavailable &mdash; ' + _esc(reason) + '</p>' +
      '<p class="aos-muted" style="font-size:12px">' +
      'No figure is shown rather than a zero: this console cannot tell the difference ' +
      'between &ldquo;none&rdquo; and &ldquo;could not read&rdquo;, so it declines to guess.</p>' +
      '</div>';
  }

  function _stat(label, value, note) {
    return '<div class="stat-card"><div class="stat-label">' + _esc(label) + '</div>' +
      '<div class="stat-value">' + _esc(value) + '</div>' +
      (note ? '<div class="aos-muted" style="font-size:11px">' + _esc(note) + '</div>' : '') +
      '</div>';
  }

  function _sessionsBlock(rows) {
    var t = _tally(rows);
    var scope = 'of the last ' + rows.length + ' sessions';

    var head = '<div class="dash-section">' +
      '<h3>&#x1F4DE; Connect sessions</h3>' +
      '<div class="stat-grid">' +
      _stat('Open or ringing', String(t.live), scope) +
      _stat('Voice', String(t.voice), scope) +
      _stat('Video', String(t.video), scope) +
      _stat('Platform verifications', String(t.platform), scope) +
      _stat('Enterprise video', String(t.enterprise), scope) +
      '</div></div>';

    if (!rows.length) {
      return head + '<div class="dash-section"><p class="aos-muted">' +
        'No sessions recorded yet. This is a canonical zero &mdash; the collection was read ' +
        'successfully and is empty.</p></div>';
    }

    var rel = _byRelationship(rows);
    var relRows = Object.keys(rel).sort(function (a, b) { return rel[b] - rel[a]; })
      .map(function (k) {
        return '<div class="notif-row"><span>' + _esc(k) + '</span>' +
          '<span class="aos-muted">' + rel[k] + '</span></div>';
      }).join('');

    var body = rows.map(function (r) {
      var ctx = r.context || {};
      var anchor = ctx.anchorType && ctx.anchorId
        ? _esc(ctx.anchorType) + '/' + _esc(String(ctx.anchorId).slice(0, 24))
        : DASH;
      return '<tr>' +
        '<td>' + _when(r.createdAt) + '</td>' +
        '<td>' + _esc(r.channel || DASH) +
          (r.mode ? ' <span class="aos-muted">(' + _esc(r.mode) + ')</span>' : '') + '</td>' +
        '<td>' + _badge(r.status, STATUS_BADGE) + '</td>' +
        '<td>' + _esc(ctx.relationship || DASH) + '</td>' +
        '<td>' + anchor + '</td>' +
        '<td>' + _esc(ctx.purpose || DASH) + '</td>' +
        /* Handles, never numbers. */
        '<td class="aos-muted">' + _esc(r.callerHandle || DASH) + ' &rarr; ' +
          _esc(r.calleeHandle || DASH) + '</td>' +
        '<td>' + _esc((r.transportPlan || []).join(', ') || DASH) + '</td>' +
        '<td>' + _esc(r.recording || DASH) + '</td>' +
        '</tr>';
    }).join('');

    return head +
      '<div class="dash-section"><h3>By business relationship</h3>' +
      '<p class="aos-muted" style="font-size:12px">' + _esc(scope) +
      '. A SOKONI call is always about something; this is what they were about.</p>' +
      relRows + '</div>' +
      '<div class="dash-section"><h3>Recent sessions</h3>' +
      '<p class="aos-muted" style="font-size:12px">Metadata only. No audio or video is stored ' +
      'anywhere on the platform; the Recording column reads DISABLED on every record by ' +
      'construction, and a row that ever reads otherwise is a defect.</p>' +
      '<div class="table-wrap"><table class="aos-table"><thead><tr>' +
      '<th>When</th><th>Channel</th><th>Status</th><th>Relationship</th>' +
      '<th>Anchor</th><th>Purpose</th><th>Parties</th><th>Transport</th><th>Recording</th>' +
      '</tr></thead><tbody>' + body + '</tbody></table></div></div>';
  }

  function _verificationsBlock(rows) {
    var pending = rows.filter(function (r) { return !r.sessionOutcome; }).length;
    var head = '<div class="dash-section">' +
      '<h3>&#x1F4F9; Video verifications</h3>' +
      '<p class="aos-muted" style="font-size:12px">' +
      '<strong>A session is evidence, not a verdict.</strong> ' +
      '<code>providerVerification</code> is the authority for whether an account is verified, ' +
      'and an official identity additionally requires a passed identity check, a passed face ' +
      'check and a completed human review. Nothing on this surface grants any of them.</p>' +
      '<div class="stat-grid">' +
      _stat('Awaiting an outcome', String(pending), 'of the last ' + rows.length) +
      _stat('Recorded', String(rows.length - pending), 'of the last ' + rows.length) +
      '</div></div>';

    if (!rows.length) {
      return head + '<div class="dash-section"><p class="aos-muted">' +
        'No verification sessions yet. This is a canonical zero &mdash; the collection was read ' +
        'successfully and is empty.</p></div>';
    }

    var body = rows.map(function (r) {
      return '<tr>' +
        '<td>' + _when(r.startedAt || r.createdAt) + '</td>' +
        '<td>' + _esc(r.reason || DASH) + '</td>' +
        '<td class="aos-muted">' + _esc(String(r.subjectUid || DASH).slice(0, 12)) + '</td>' +
        '<td class="aos-muted">' + _esc(r.businessId ? String(r.businessId).slice(0, 16) : DASH) + '</td>' +
        '<td>' + (r.sessionOutcome ? _badge(r.sessionOutcome, OUTCOME_BADGE)
          : '<span class="aos-muted">awaiting outcome</span>') + '</td>' +
        '<td>' + _esc((r.documentsReferenced || []).length || DASH) + '</td>' +
        '<td>' + _when(r.endedAt) + '</td>' +
        '<td>' + _esc(r.consent && r.consent.recordingDisclosed ? r.consent.recordingDisclosed : DASH) + '</td>' +
        '</tr>';
    }).join('');

    return head +
      '<div class="dash-section"><h3>Recent verifications</h3>' +
      '<div class="table-wrap"><table class="aos-table"><thead><tr>' +
      '<th>Started</th><th>Reason</th><th>Subject</th><th>Business</th>' +
      '<th>Session outcome</th><th>Docs</th><th>Ended</th><th>Recording disclosed</th>' +
      '</tr></thead><tbody>' + body + '</tbody></table></div></div>';
  }

  /* The write surface is a SEPARATE module. If it is absent the console still renders
     everything it can read, and says the actions are unavailable — a missing module is
     reported as a missing module, never as "no actions exist". */
  function _actionsBlock() {
    if (global.SokoniConnectVerify && typeof global.SokoniConnectVerify.mount === 'function') {
      return '<div class="dash-section" id="connectVerifyRoot"></div>';
    }
    return '<div class="dash-section"><h3>Verification actions</h3>' +
      '<p class="aos-muted">The verification write surface did not load. Check that ' +
      'sokoni-connect-verify.js is served on this page.</p></div>';
  }

  function mount(root) {
    if (!root) return;
    root.innerHTML = '<div class="aos-spinner"><div></div></div>';

    var db = _db();
    if (!db) {
      root.innerHTML = _unavailable('Connect sessions', 'Firestore is not available on this page.');
      return;
    }

    /* The two reads are independent: one failing must not blank the other. An admin whose
       verification rule is deployed and whose session rule is not should see one table and
       one honest refusal, not a single empty page. */
    var sessions = db.collection(SESSIONS).orderBy('createdAt', 'desc').limit(PAGE).get()
      .then(function (snap) {
        var rows = []; snap.forEach(function (d) { rows.push(Object.assign({ id: d.id }, d.data())); });
        return _sessionsBlock(rows);
      })
      .catch(function (e) { return _unavailable('Connect sessions', _reason(e, SESSIONS)); });

    var verifications = db.collection(VERIFICATIONS).orderBy('createdAt', 'desc').limit(PAGE).get()
      .then(function (snap) {
        var rows = []; snap.forEach(function (d) { rows.push(Object.assign({ id: d.id }, d.data())); });
        return _verificationsBlock(rows);
      })
      .catch(function (e) { return _unavailable('Video verifications', _reason(e, VERIFICATIONS)); });

    Promise.all([sessions, verifications]).then(function (blocks) {
      root.innerHTML = blocks[0] + blocks[1] + _actionsBlock();
      var vr = root.querySelector('#connectVerifyRoot');
      if (vr && global.SokoniConnectVerify) global.SokoniConnectVerify.mount(vr);
    });
  }

  function _reason(e, collection) {
    if (e && e.code === 'permission-denied') {
      return 'the ' + collection + ' rule is not deployed yet, so this admin read is refused.';
    }
    return (e && e.message) || 'the read failed.';
  }

  global.SokoniConnectConsole = {
    mount: mount,
    SESSIONS: SESSIONS,
    VERIFICATIONS: VERIFICATIONS,
  };
})(window);
