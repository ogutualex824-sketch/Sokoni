/* ============================================================================
   SOKONI Connect — C3-B incoming-call surface   sokoni-connect-incoming.js v1.0.0
   ============================================================================
   HOW A PERSON FINDS OUT THEY ARE BEING CALLED.

   Before this module the only route to a session was the deep link inside a
   push notification. That made the whole incoming path depend on a transport
   which is undeployed and, on a real handset, unproven — and anyone who swiped
   the notification away had no way back to a call that was still ringing.

   This is a DISCOVERY AND ROUTING layer. It holds:

     no state machine          the server says `offerable`; this renders it
     no action map             `SokoniConnectClient.ACTIONS` is the only one
     no consent dialog         C2 owns that, and there must not be a second
     no ring vocabulary        `item.ring` is built by the server
     no authority of any kind

   ── WHY ANSWER IS A NAVIGATION, NOT A CALL ─────────────────────────────────
   Accepting a session requires consent for video, and the consent contract
   lives inside `SokoniConnectClient.mount` where the SERVER's six-field
   disclosure is rendered. A banner that called `connectAnswerSession` itself
   would need its own copy of that dialog — a second consent contract, which is
   precisely the thing the C3 entry gates forbid. So Answer navigates to
   `/connect.html?session=…` and C2 accepts, exactly as it does for a push.

   Decline needs no consent, so it is routed here — through C2's map, by
   destination, and only when the server put `declined` in `offerable`.

   ── MARKING THE RING ───────────────────────────────────────────────────────
   The authority already defines `authorized → ringing` as `callee_or_server`
   and says the device's own evidence is the stronger of the two. Nothing took
   the callee side of that edge until now. When this banner actually PAINTS a
   session, that is the device alerting, so it reports it once — and only when
   `offerable` contains `ringing`, so it is the server's list that decides,
   not a guess about what state the session is in.

   It is EVIDENCE, NOT A CONTROL. A failure is swallowed: a banner that stopped
   working because the ring could not be recorded would turn a bookkeeping
   detail into a missed call.

   ── NOT PROVEN BY THIS FILE ────────────────────────────────────────────────
   That a physical device ever alerted, that a push was delivered, that media
   flowed, or that anything here has been deployed. This module polls a
   callable and draws a banner.
   ========================================================================= */
(function (global) {
  'use strict';

  var DASH = '—';
  var POLL_MS = 3000;

  /* The C2 module is a HARD dependency and is resolved at call time rather
     than captured at load, so script order cannot silently freeze in a null.
     If it is absent this module renders a warning — it does NOT fall back to
     an action map of its own, because that map would be a second authority
     arriving by the back door the first time a script tag was misordered. */
  function _c2() {
    return (global.SokoniConnectClient &&
            typeof global.SokoniConnectClient.actionsFor === 'function')
      ? global.SokoniConnectClient : null;
  }

  function _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** Every destination C2 routes for this item. The ONLY source of actions. */
  function _destinations(item) {
    var C = _c2();
    if (!C) return [];
    return C.actionsFor(item || {}).map(function (a) { return a.destination; });
  }

  /**
   * describe(item) -> { sessionId, title, about, channel, mode }
   *
   * PURE. The words come from `item.ring`, which the SERVER built with the same
   * helper that writes the push. This module keeps no copy: an absent ring
   * renders a neutral dash rather than an invented label, because "SOKONI is
   * calling about something" is a sentence the platform never said.
   */
  function describe(item) {
    var i = item || {};
    var r = i.ring || {};
    return {
      sessionId: String(i.sessionId || ''),
      title: r.title ? String(r.title) : DASH,
      about: r.about ? String(r.about) : DASH,
      channel: i.channel ? String(i.channel) : DASH,
      mode: i.mode ? String(i.mode) : null,
    };
  }

  /**
   * mayOpen(item) -> boolean
   *
   * Whether the banner offers a way through to the session. Derived from
   * `offerable` containing `accepted` — i.e. the server says this person may
   * still answer. It never reads `state`.
   */
  function mayOpen(item) {
    return _destinations(item).indexOf('accepted') !== -1;
  }

  /**
   * declineAction(item) -> { destination, op, label, kind } | null
   *
   * C2's own entry, unmodified. Null when the server did not offer `declined`.
   */
  function declineAction(item) {
    var C = _c2();
    if (!C) return null;
    var found = C.actionsFor(item || {}).filter(function (a) {
      return a.destination === 'declined';
    });
    return found.length ? found[0] : null;
  }

  /** Whether the device should report that it is alerting. Server-offered only. */
  function shouldMarkRinging(item) {
    return _destinations(item).indexOf('ringing') !== -1;
  }

  /** Where Answer goes. Pure, and the session id is encoded rather than pasted. */
  function openHref(item) {
    var id = String((item || {}).sessionId || '');
    return id ? '/connect.html?session=' + encodeURIComponent(id) : null;
  }

  /**
   * renderHtml(list) -> string
   *
   * One card per incoming session. An empty list renders an explicit
   * "no incoming calls" — never a blank region, which reads as a broken page.
   */
  function renderHtml(list) {
    var items = Array.isArray(list) ? list : [];
    if (!_c2()) {
      return '<p class="ci-warn">The Connect client did not load, so no call actions ' +
        'can be offered. Check that sokoni-connect-client.js is served on this page.</p>';
    }
    if (!items.length) {
      return '<p class="ci-muted">No incoming calls.</p>';
    }
    return items.map(function (item) {
      var d = describe(item);
      var dec = declineAction(item);
      var href = openHref(item);
      var buttons = '';
      if (mayOpen(item) && href) {
        buttons += '<a class="ci-act ci-primary" data-role="open" href="' + _esc(href) +
          '" data-session="' + _esc(d.sessionId) + '">Answer</a>';
      }
      if (dec) {
        buttons += '<button class="ci-act ci-danger" data-role="decline" data-op="' +
          _esc(dec.op) + '" data-session="' + _esc(d.sessionId) + '">' +
          _esc(dec.label) + '</button>';
      }
      return '<div class="ci-card" data-session="' + _esc(d.sessionId) + '">' +
        '<div class="ci-title">' + _esc(d.title) + '</div>' +
        '<div class="ci-about">' + _esc(d.about) + '</div>' +
        '<div class="ci-meta"><span>' + _esc(d.channel) + '</span>' +
          (d.mode ? '<span>' + _esc(d.mode) + '</span>' : '') +
          /* `status` only. Reading `state` first and falling back was tolerant, and the
             tolerance is what hid the seam: the banner rendered correctly while
             connect.html rendered a dash, so nothing looked broken. */
          '<span>' + _esc((item && item.status) || DASH) +
          '</span></div>' +
        '<div class="ci-actions">' + (buttons ||
          '<span class="ci-muted">No actions available.</span>') + '</div>' +
        '</div>';
    }).join('');
  }

  /**
   * mount(root, { call, navigate, onList, pollMs })
   *
   * `call` and `navigate` are injected so this module has no opinion about how
   * the platform reaches its backend or changes page — and so the suite can
   * drive the whole surface without a network or a browser.
   */
  function mount(root, opts) {
    var o = opts || {};
    if (!root) return null;
    var call = typeof o.call === 'function' ? o.call : null;
    if (!call) {
      root.innerHTML = '<p class="ci-warn">No backend.</p>';
      return null;
    }
    var navigate = typeof o.navigate === 'function' ? o.navigate : function (href) {
      global.location.href = href;
    };

    var list = [];
    var stopped = false;
    var timer = null;
    /* One report per session for the life of this surface. Reported BEFORE the
       result is known, so a slow or failing call cannot produce a second
       attempt on the next poll — a ring is evidence recorded once, and a retry
       loop against the backend would be a worse defect than a missing mark. */
    var alerted = {};

    function paint() {
      root.innerHTML = renderHtml(list);
      var acts = root.querySelectorAll('.ci-act');
      for (var i = 0; i < acts.length; i++) {
        acts[i].addEventListener('click', _onAction);
      }
    }

    function _onAction(ev) {
      var el = ev.currentTarget;
      var role = el.getAttribute('data-role');
      var sessionId = el.getAttribute('data-session');
      if (!sessionId) return;

      if (role === 'open') {
        /* Answering happens on connect.html, where C2 renders the SERVER's
           consent disclosure and calls connectAnswerSession. */
        if (ev.preventDefault) ev.preventDefault();
        navigate(openHref({ sessionId: sessionId }));
        return;
      }
      if (role !== 'decline') return;

      var op = el.getAttribute('data-op');
      if (!op) return;
      el.disabled = true;
      var prev = el.textContent;
      el.textContent = 'Working' + DASH;
      /* The payload carries the SESSION and nothing that could be mistaken for
         authority. No actor, no from-state, no destination override. */
      call(op, { sessionId: sessionId }).then(function () {
        return refresh();
      }).catch(function (e) {
        el.disabled = false;
        el.textContent = prev;
        _say(root, (e && e.message) || 'That action was refused.');
      });
    }

    /* The device says it is alerting. See the header: evidence, not a control. */
    function _markRinging() {
      for (var i = 0; i < list.length; i++) {
        var item = list[i];
        var id = item && item.sessionId;
        if (!id || alerted[id]) continue;
        if (!shouldMarkRinging(item)) continue;
        alerted[id] = true;
        var C = _c2();
        var op = C && C.ACTIONS && C.ACTIONS.ringing ? C.ACTIONS.ringing.op : null;
        if (!op) continue;
        call(op, { sessionId: id }).catch(function () { /* swallowed, deliberately */ });
      }
    }

    function refresh() {
      return call('connectListIncoming', {}).then(function (data) {
        list = (data && Array.isArray(data.incoming)) ? data.incoming : [];
        paint();
        _markRinging();
        if (typeof o.onList === 'function') o.onList(list);
        return list;
      }).catch(function (e) {
        root.innerHTML = '<p class="ci-warn">Could not check for calls ' + DASH + ' ' +
          _esc((e && e.message) || 'the call failed') + '</p>';
        return null;
      });
    }

    function stop() {
      stopped = true;
      if (timer) global.clearInterval(timer);
      timer = null;
    }

    paint();
    refresh();
    timer = global.setInterval(function () {
      if (stopped) return;
      refresh();
    }, Number(o.pollMs) > 0 ? Number(o.pollMs) : POLL_MS);

    return {
      refresh: refresh,
      stop: stop,
      list: function () { return list; },
    };
  }

  function _say(root, msg) {
    var el = root.querySelector('.ci-error');
    if (!el) {
      el = global.document.createElement('p');
      el.className = 'ci-error ci-warn';
      root.appendChild(el);
    }
    el.textContent = msg;
  }

  /* ── THE C3-B SURFACE ───────────────────────────────────────────────────
     Declared so the suite can assert it both ways — every declared name
     exported, every export declared — which makes a rename or a removal a
     visible failure rather than something the next consumer discovers. */
  var CONTRACT = [
    'CONTRACT', 'describe', 'mayOpen', 'declineAction', 'shouldMarkRinging',
    'openHref', 'renderHtml', 'mount',
  ];

  global.SokoniConnectIncoming = {
    CONTRACT: CONTRACT,
    describe: describe,
    mayOpen: mayOpen,
    declineAction: declineAction,
    shouldMarkRinging: shouldMarkRinging,
    openHref: openHref,
    renderHtml: renderHtml,
    mount: mount,
  };
})(typeof window !== 'undefined' ? window : globalThis);
