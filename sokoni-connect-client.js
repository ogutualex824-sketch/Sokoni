/* ============================================================================
   SOKONI Connect — C2 client projection layer   sokoni-connect-client.js v1.0.0
   ============================================================================
   A PROJECTION. Not an authority.

   The server answers one question — `connectGetSessionState` — and this module
   renders the answer. It holds no state machine, no transition table, no actor
   logic and no authorization. Its entire job is:

       server authority
             ↓
       client projection      ← this file
             ↓
       user / media action
             ↓
       server-authorized request

   and never:

       client state → client decides transition → backend accepts it

   WHAT MAKES THAT CHECKABLE
   -------------------------
   `actionsFor(projection)` returns actions from `offerable` ALONE. It never
   reads `state`. The suite proves it the only way that means anything:

     { state:'ringing', offerable:[] }              → renders NOTHING
     { state:'ended',   offerable:['accepted'] }    → renders Accept

   The second case is the important one. A client with its own state logic
   would "know" that an ended call cannot be accepted and would helpfully
   suppress the button — and in doing so would have become a second authority
   that can disagree with the first. This module renders what the server said.
   If the server is wrong, that is a server bug, and it should be visible.

   THE ACTION MAP IS ROUTING, NOT AUTHORITY
   ----------------------------------------
   `ACTIONS` is keyed by DESTINATION, never by state. It answers "which
   callable implements this destination, and what do we call the button" —
   a transport and labelling concern. It cannot answer "may I" and is never
   consulted to find out: an entry is used only when the server has already
   placed that destination in `offerable`.

   MEDIA IS OBSERVED, NEVER DECIDED
   --------------------------------
   The media adapter reports observations from `reportableEvents` through
   `connectReportMediaEvent`. There is no client path that writes `connected`,
   `failed` or `ended` — the server has no op for the first two, and the third
   is a human intention, not something a peer connection can conclude.

   NOT PROVEN BY THIS FILE
   -----------------------
   Real-device push delivery, real WebRTC connectivity, TURN/STUN traversal and
   cross-network establishment are all UNPROVEN. This module renders an
   incoming session and reports observations; it does not establish that a
   phone ever rang or that media ever flowed.
   ========================================================================= */
(function (global) {
  'use strict';

  /* Destination → how to invoke it, and what to call it.
     KEYED BY DESTINATION, NEVER BY STATE. Adding a state here would be
     meaningless; adding a destination the server never offers is harmless,
     because nothing renders an entry that is absent from `offerable`. */
  var ACTIONS = {
    ringing:   { op: 'connectMarkRinging',     label: 'Ringing',  kind: 'silent'  },
    accepted:  { op: 'connectAnswerSession',   label: 'Accept',   kind: 'primary' },
    declined:  { op: 'connectDeclineSession',  label: 'Decline',  kind: 'danger'  },
    cancelled: { op: 'connectCancelSession',   label: 'Cancel',   kind: 'danger'  },
    ended:     { op: 'connectEndSession',      label: 'End call', kind: 'danger'  },
  };

  /**
   * actionsFor(projection) -> [{ destination, op, label, kind }]
   *
   * PURE. Derived from `offerable` alone — `projection.state` is never read.
   * A destination the server offers but this build has no route for is dropped
   * rather than guessed at, and reported through `unroutable` so a version skew
   * is visible instead of silently missing a button.
   */
  function actionsFor(projection) {
    var p = projection || {};
    var offerable = Array.isArray(p.offerable) ? p.offerable : [];
    var out = [];
    for (var i = 0; i < offerable.length; i++) {
      var dest = String(offerable[i]);
      if (!Object.prototype.hasOwnProperty.call(ACTIONS, dest)) continue;
      out.push({
        destination: dest,
        op: ACTIONS[dest].op,
        label: ACTIONS[dest].label,
        kind: ACTIONS[dest].kind,
      });
    }
    return out;
  }

  /** Destinations the server offered that this build cannot route. Surfaced, not swallowed. */
  function unroutable(projection) {
    var p = projection || {};
    var offerable = Array.isArray(p.offerable) ? p.offerable : [];
    return offerable.filter(function (d) {
      return !Object.prototype.hasOwnProperty.call(ACTIONS, String(d));
    }).map(String);
  }

  /**
   * eventsFor(projection) -> string[]
   *
   * PURE. The media observations the server will act on, verbatim. This module
   * neither extends nor filters the list — inventing an event the authority
   * does not know would be a client vocabulary, which is the thing C2 must not
   * grow.
   */
  function eventsFor(projection) {
    var p = projection || {};
    return Array.isArray(p.reportableEvents) ? p.reportableEvents.map(String) : [];
  }

  /**
   * mayReport(projection, event) -> boolean
   *
   * A courtesy check so the adapter does not spam the backend. It is NOT a
   * control: the server refuses an event it will not act on regardless, and
   * this returning true never means the server agreed.
   */
  function mayReport(projection, event) {
    return eventsFor(projection).indexOf(String(event)) !== -1;
  }

  /* ── Rendering ─────────────────────────────────────────────────────────── */

  function _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var DASH = '—';

  /**
   * renderHtml(projection) -> string
   *
   * The state is DISPLAYED, never interpreted. An unknown state renders as
   * itself; this module has no list of states to check it against, which is
   * precisely why it cannot drift from the authority.
   */
  function renderHtml(projection) {
    var p = projection || {};
    var actions = actionsFor(p);
    var stray = unroutable(p);
    var events = eventsFor(p);

    var buttons = actions.map(function (a) {
      return '<button class="cx-act cx-' + _esc(a.kind) + '" data-destination="' +
        _esc(a.destination) + '" data-op="' + _esc(a.op) + '">' + _esc(a.label) + '</button>';
    }).join('');

    return '' +
      '<div class="cx-state">' +
        '<div class="cx-k">Session</div>' +
        /* `status`, NOT `state`. The server has always sent `status` — the document
           field, the authority's own word — and this line asked for `state`, so the
           session state on connect.html rendered as a dash from the day it shipped. The
           C2 suite never caught it because it drives this function with synthetic
           projections it writes itself. A fixture is not a contract. */
        '<div class="cx-v" id="cxState">' + _esc(p.status || DASH) + '</div>' +
      '</div>' +
      '<div class="cx-meta">' +
        '<span>channel: ' + _esc(p.channel || DASH) + '</span>' +
        '<span>you are: ' + _esc(p.actor || DASH) + '</span>' +
        '<span>recording: ' + _esc(p.recording || DASH) + '</span>' +
      '</div>' +
      (p.mode ? '<div class="cx-meta"><span>mode: ' + _esc(p.mode) + '</span></div>' : '') +
      '<div class="cx-actions">' +
        (buttons || '<span class="cx-muted">No actions available' +
          (p.terminal ? ' — this session has ended.' : '.') + '</span>') +
      '</div>' +
      (stray.length
        ? '<p class="cx-warn">The server offered ' + _esc(stray.join(', ')) +
          ', which this build cannot route. Update the app.</p>'
        : '') +
      '<div class="cx-meta"><span>reportable: ' +
        _esc(events.join(', ') || 'none') + '</span></div>';
  }

  /* ── The live surface ──────────────────────────────────────────────────── */

  /**
   * mount(root, { sessionId, call, onProjection })
   *
   * `call(op, payload)` is injected rather than constructed here, so this
   * module has no opinion about how the platform reaches its backend — and so
   * the suite can drive it without a network.
   */
  function mount(root, opts) {
    var o = opts || {};
    if (!root) return null;
    var sessionId = String(o.sessionId || '');
    var call = typeof o.call === 'function' ? o.call : null;
    if (!sessionId || !call) {
      root.innerHTML = '<p class="cx-warn">No session.</p>';
      return null;
    }

    var projection = null;
    var timer = null;
    var stopped = false;

    function paint() {
      root.innerHTML = projection
        ? renderHtml(projection)
        : '<p class="cx-muted">Loading session' + DASH + '</p>';
      var btns = root.querySelectorAll('.cx-act');
      for (var i = 0; i < btns.length; i++) {
        btns[i].addEventListener('click', _onAction);
      }
    }

    function _onAction(ev) {
      var btn = ev.currentTarget;
      var op = btn.getAttribute('data-op');
      if (!op) return;
      btn.disabled = true;
      var prev = btn.textContent;
      btn.textContent = 'Working' + DASH;
      /* The payload carries the SESSION and nothing that could be mistaken for
         authority. No actor. No from-state. No destination override. */
      var payload = { sessionId: sessionId };
      if (btn.getAttribute('data-destination') === 'accepted') {
        /* Consent is collected at the moment of accepting, because that is when
           the person actually agrees. The server refuses without it. */
        payload.consentAcknowledged = _consent(projection);
        if (payload.consentAcknowledged !== true) {
          btn.disabled = false; btn.textContent = prev;
          return;
        }
      }
      call(op, payload).then(function () {
        return refresh();
      }).catch(function (e) {
        btn.disabled = false;
        btn.textContent = prev;
        _say(root, (e && e.message) || 'That action was refused.');
      });
    }

    /* Video needs an informed acceptance. Voice and chat do not, and asking
       would train people to dismiss a dialog that matters. */
    function _consent(p) {
      if (!p || String(p.channel) !== 'video') return true;
      /* The SIX-FIELD disclosure comes from the SERVER. This module holds no copy of what a
         person is being asked to agree to — a second copy is a second promise, and the two
         would drift the first time one was edited.

         A video session with NO disclosure is REFUSED. Falling back to a vague sentence would
         be inventing a promise on the platform's behalf, which is worse than not connecting. */
      var d = p.consentDisclosure;
      if (!d || !d.purpose || !d.recording || !d.retention || !d.access) return false;
      var msg = 'SOKONI video session\n\n' +
        'Purpose: ' + d.purpose + '\n' +
        'Camera: ' + d.camera + '\n' +
        'Microphone: ' + d.microphone + '\n' +
        'Recording: ' + d.recording + '\n' +
        'Retention: ' + d.retention + '\n' +
        'Access: ' + d.access + '\n\n' +
        'Agreeing lets this session take place. It does not verify your identity.\n\n' +
        'Join?';
      try { return global.confirm(msg) === true; } catch (e) { return false; }
    }

    function refresh() {
      return call('connectGetSessionState', { sessionId: sessionId })
        .then(function (data) {
          projection = data || null;
          paint();
          if (typeof o.onProjection === 'function') o.onProjection(projection);
          return projection;
        })
        .catch(function (e) {
          root.innerHTML = '<p class="cx-warn">Could not read this session ' + DASH + ' ' +
            _esc((e && e.message) || 'the call failed') + '</p>';
          return null;
        });
    }

    function stop() { stopped = true; if (timer) global.clearInterval(timer); timer = null; }

    paint();
    refresh();
    /* Polled rather than streamed: `connectSessions` is server-owned and a
       client subscription would need a rule that lets a participant read the
       document live. Polling keeps C2 free of a rules change it does not need.
       It stops once the server says the session is terminal. */
    timer = global.setInterval(function () {
      if (stopped) return;
      if (projection && projection.terminal === true) { stop(); return; }
      refresh();
    }, 3000);

    /**
     * The media adapter's ONLY route to the backend. It reports an observation;
     * it never names a state. Deliberately thin — C3 supplies the WebRTC that
     * produces these events, and it must find nothing here to shortcut.
     */
    function reportObservation(event) {
      if (!mayReport(projection, event)) {
        return Promise.resolve({ reported: false, reason: 'not_reportable_from_this_state' });
      }
      return call('connectReportMediaEvent', { sessionId: sessionId, event: String(event) })
        .then(function (r) { refresh(); return { reported: true, result: r }; });
    }

    return {
      refresh: refresh,
      stop: stop,
      reportObservation: reportObservation,
      projection: function () { return projection; },
    };
  }

  function _say(root, msg) {
    var el = root.querySelector('.cx-error');
    if (!el) {
      el = global.document.createElement('p');
      el.className = 'cx-error cx-warn';
      root.appendChild(el);
    }
    el.textContent = msg;
  }

  /* ── THE FROZEN C2 SURFACE ──────────────────────────────────────────────
     C2 is COMPLETE and FROZEN as of 2026-09-22. C3 consumes this module; it
     does not reopen it. Declared so the suite can assert the surface both
     ways — every declared name exported, every export declared — which makes
     a removal or a rename a visible failure rather than something the next
     consumer discovers.

     C3 ENTRY GATES, recorded here because this is the file C3 will reach for:

       1. CONSENT CONTRACT. `_consent` is a confirm() naming camera, microphone
          and recording status. Before real video, it must also state retention,
          who may access any recording, and the purpose of the session. Do NOT
          quietly widen the existing dialog — define the contract first.

       2. THERE IS NO SESSION-CREATION PATH. This module answers a session that
          already exists. Nothing yet turns a business surface into one.
          When that Call button is built it takes an ANCHOR, never a uid:

            Order    → Call Seller
            Delivery → Call Rider
            Shop     → Call Supplier
            Support  → Call Admin

          never `call(calleeUid)`. The caller identifies the business
          relationship, not the person to ring — the rule the whole layer is
          built on, and the one a convenience parameter would quietly end.

     C3 order: C3-A call initiation → C3-B incoming-call UX → C3-C WebRTC.
     RTCPeerConnection does not belong in this file or in connect.html until
     A and B are settled. */
  var CONTRACT = [
    'ACTIONS', 'actionsFor', 'unroutable', 'eventsFor', 'mayReport',
    'renderHtml', 'mount',
  ];

  global.SokoniConnectClient = {
    CONTRACT: CONTRACT,
    ACTIONS: ACTIONS,
    actionsFor: actionsFor,
    unroutable: unroutable,
    eventsFor: eventsFor,
    mayReport: mayReport,
    renderHtml: renderHtml,
    mount: mount,
  };
})(typeof window !== 'undefined' ? window : globalThis);
