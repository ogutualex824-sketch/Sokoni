/* ============================================================================
   SOKONI Connect — the Call button   sokoni-connect-call.js   v1.0.0
   ============================================================================
   GATE C3-A. Turns a business surface into a session.

   THE ONE RULE, CARRIED INTO THE UI
   ---------------------------------
   The caller identifies the BUSINESS RELATIONSHIP, not the person to ring.

       Order    → Call Seller
       Delivery → Call Rider
       Shop     → Call Supplier
       Support  → Call Admin

   So this module sends `anchorType` and `anchorId` and nothing else that could
   identify a participant. There is no `calleeUid` parameter, no
   `participantUids`, no `actor` and no `fromState` — the server resolves every
   one of those from the anchor document.

   A convenience parameter here is exactly how SOKONI would stop being
   business-context communication and become arbitrary user-to-user telephony,
   so the suite asserts the absence rather than trusting the intent.

   A BUTTON IS NOT A PERMISSION
   ----------------------------
   `shouldShow()` consults the call-surface policy — a PRODUCT decision about
   which screens carry the action. It is deliberately narrower than the
   authority and it authorizes nothing. The server decides on every request and
   would refuse one this module happened to offer.

   UI visibility is not security. Hiding the button protects nobody; the
   callable is reachable directly, which is why the gate is server-side.

   TRUTHFUL RESULTS
   ----------------
   A session is created only after authorization succeeds. If the server says
   the callee cannot be rung, this reports that — it never shows "Calling…"
   over a session that was never dispatched. `reachable: true` is a pre-check,
   not a delivery receipt, so the copy says "Reaching" and not "Ringing".

   NOT IN THIS FILE
   ----------------
   No media. No RTCPeerConnection, no getUserMedia, no TURN/STUN. Creating a
   session and handing off to connect.html is the whole job; C3-B and C3-C are
   separate slices.
   ========================================================================= */
(function (global) {
  'use strict';

  /* The surfaces that carry a Call button. MIRRORS
     functions/shared/connect-call-surface.js, which is the policy of record;
     the suite asserts the two agree exactly, so a divergence fails a gate
     rather than producing a button the server never expected.

     Keyed `anchorType:callerRole:targetRole` — order matters, because a
     surface is a screen somebody is looking at. */
  var CALL_SURFACES = {
    order:    ['buyer:seller', 'seller:buyer'],
    delivery: ['buyer:rider', 'rider:buyer', 'seller:rider'],
    supply:   ['seller:supplier'],
    support:  ['buyer:admin', 'admin:buyer'],
    booking:  ['buyer:provider', 'provider:buyer'],   /* 2026-09-27 — the booking conversation */
  };

  /* Only a live relationship. A closed order keeps its history and loses its
     telephone — the authority refuses voice on it, so a button would be a
     button that is always refused. */
  var ELIGIBLE_STATES = ['active'];

  var LABELS = {
    seller: 'Call seller',
    buyer: 'Call buyer',
    rider: 'Call rider',
    supplier: 'Call supplier',
    admin: 'Call support',
    provider: 'Call provider',
  };

  /**
   * shouldShow({ anchorType, callerRole, targetRole, relationshipState })
   *   -> { show, reason }
   *
   * PURE. A product decision, never an authorization. `show:false` blocks
   * nothing — it means this screen does not offer the action.
   */
  function shouldShow(input) {
    var i = input || {};
    var a = String(i.anchorType || '');
    var from = String(i.callerRole || '');
    var to = String(i.targetRole || '');
    var state = String(i.relationshipState || '');

    if (!Object.prototype.hasOwnProperty.call(CALL_SURFACES, a)) {
      return { show: false, reason: 'no_call_surface_for_anchor' };
    }
    if (!from || !to) return { show: false, reason: 'roles_required' };
    if (from === to) return { show: false, reason: 'self_call' };
    if (ELIGIBLE_STATES.indexOf(state) === -1) {
      return { show: false, reason: 'relationship_not_live' };
    }
    if (CALL_SURFACES[a].indexOf(from + ':' + to) === -1) {
      return { show: false, reason: 'surface_not_offered' };
    }
    return { show: true, reason: 'surface_offers_call' };
  }

  function _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /**
   * requestPayload({ anchorType, anchorId, targetRole, channel }) -> payload
   *
   * PURE, and the reason this function exists at its own name: it is the exact
   * thing the suite inspects to prove no participant identity is sent. A
   * `targetRole` is a ROLE the server validates against the anchor — never a
   * uid.
   */
  function requestPayload(input) {
    var i = input || {};
    var p = {
      anchorType: String(i.anchorType || ''),
      anchorId: String(i.anchorId || ''),
      channel: String(i.channel || 'voice'),
    };
    if (i.targetRole) p.targetRole = String(i.targetRole);
    if (i.purpose) p.purpose = String(i.purpose);
    return p;
  }

  /**
   * describeResult(result) -> { tone, message }
   *
   * PURE. Turns the server's answer into copy without inventing optimism.
   * A session that cannot be rung says so; it never reads as "Calling…".
   */
  function describeResult(result) {
    var r = result || {};
    if (!r.sessionId) {
      return { tone: 'error', message: 'The call could not be started.' };
    }
    if (r.reachable === false) {
      var why = String(r.reachableReason || '');
      if (why === 'no_push_target') {
        return {
          tone: 'warn',
          message: 'This person cannot be reached right now — their device is not set up ' +
            'to receive SOKONI calls.',
        };
      }
      if (why === 'no_route') {
        return {
          tone: 'warn',
          message: 'This call cannot be connected right now — no route is available.',
        };
      }
      return { tone: 'warn', message: 'This person cannot be reached right now.' };
    }
    /* "Reaching", never "Ringing". Nothing here knows that a phone rang. */
    return { tone: 'ok', message: 'Reaching them…' };
  }

  /**
   * mount(root, { anchorType, anchorId, callerRole, targetRole, relationshipState,
   *               channel, call, onSession })
   *
   * `call(op, payload)` is injected, so this module has no opinion about how
   * the platform reaches its backend and the suite can drive it without a
   * network.
   */
  function mount(root, opts) {
    var o = opts || {};
    if (!root) return null;

    var gate = shouldShow(o);
    if (!gate.show) { root.innerHTML = ''; return null; }

    var call = typeof o.call === 'function' ? o.call : null;
    if (!call) { root.innerHTML = ''; return null; }

    var label = LABELS[String(o.targetRole)] || 'Call';
    root.innerHTML =
      '<button class="cc-call" type="button">' + _esc(label) + '</button>' +
      '<div class="cc-result" role="status"></div>';

    var btn = root.querySelector('.cc-call');
    var out = root.querySelector('.cc-result');

    btn.addEventListener('click', function () {
      btn.disabled = true;
      var prev = btn.textContent;
      btn.textContent = 'Starting…';
      out.textContent = '';

      call('connectRequestSession', requestPayload(o)).then(function (res) {
        var d = describeResult(res);
        out.textContent = d.message;
        out.setAttribute('data-tone', d.tone);
        if (res && res.sessionId && typeof o.onSession === 'function') {
          o.onSession(res);
        }
      }).catch(function (e) {
        /* The server's refusal is the truth. It is shown, not softened — a
           caller who is told "calling" when the server said no learns nothing. */
        out.textContent = (e && e.message) || 'The call was refused.';
        out.setAttribute('data-tone', 'error');
      }).then(function () {
        btn.disabled = false;
        btn.textContent = prev;
      });
    });

    return { refresh: function () { return mount(root, o); } };
  }

  /**
   * mountForAnchor(root, { anchorType, anchorId, call, onSession })
   *
   * THE SERVER-BACKED PATH, and the one a business surface should use.
   *
   * `shouldShow` below is a pure mirror of the product policy and still needs a
   * `relationshipState` the client cannot know — deriving it would mean mapping
   * an order's lifecycle word in the browser, which connect-call-surface.js
   * forbids outright ("Do not invent a second set of order/delivery lifecycle
   * states inside Connect"). So this asks the server instead: it resolves the
   * anchor, derives the caller's role from the document, and returns only the
   * actions that BOTH the surface policy and the authority allow.
   *
   * Renders NOTHING when the server offers nothing — no dead button, no
   * "unavailable" placeholder on a page where the action was never meant to be.
   */
  function mountForAnchor(root, opts) {
    var o = opts || {};
    if (!root) return null;
    var call = typeof o.call === 'function' ? o.call : null;
    if (!call || !o.anchorType || !o.anchorId) { root.innerHTML = ''; return null; }

    root.innerHTML = '';
    return call('connectAvailableActions', {
      anchorType: String(o.anchorType), anchorId: String(o.anchorId),
    }).then(function (res) {
      var actions = (res && res.actions) || [];
      if (!actions.length) { root.innerHTML = ''; return null; }

      root.innerHTML = actions.map(function (a) {
        /* One control per CHANNEL the server allowed — Message for chat, Call
           for voice. A channel the authority refused simply is not drawn. */
        return (a.channels || []).map(function (ch) {
          var verb = ch === 'voice' ? 'Call' : 'Message';
          /* PRESENTATION ONLY. A surface may rename the NOUN a buyer reads —
             a storefront says "shop" where the relationship says "seller" —
             but it cannot change WHO is contacted or WHICH channels appear.
             Both of those come from the server response above and are never
             influenced by this string. */
          var noun = o.roleLabel ? String(o.roleLabel) : String(a.label || a.targetRole);
          return '<button class="cc-call cc-' + _esc(ch) + '" type="button"' +
            ' data-target-role="' + _esc(a.targetRole) + '"' +
            ' data-channel="' + _esc(ch) + '">' +
            _esc(verb + ' ' + noun.toLowerCase()) + '</button>';
        }).join('');
      }).join('') + '<div class="cc-result" role="status"></div>';

      var out = root.querySelector('.cc-result');
      var btns = root.querySelectorAll('.cc-call');
      for (var i = 0; i < btns.length; i++) {
        btns[i].addEventListener('click', function (ev) {
          var btn = ev.currentTarget;
          btn.disabled = true;
          var prev = btn.textContent;
          btn.textContent = 'Starting…';
          out.textContent = '';
          /* The SAME payload rule as the static button: an anchor and a ROLE,
             never a person. */
          call('connectRequestSession', requestPayload({
            anchorType: o.anchorType,
            anchorId: o.anchorId,
            targetRole: btn.getAttribute('data-target-role'),
            channel: btn.getAttribute('data-channel'),
          })).then(function (r) {
            var dsc = describeResult(r);
            out.textContent = dsc.message;
            out.setAttribute('data-tone', dsc.tone);
            if (r && r.sessionId && typeof o.onSession === 'function') o.onSession(r);
          }).catch(function (e) {
            /* The server's refusal is shown, not softened. */
            out.textContent = (e && e.message) || 'That was refused.';
            out.setAttribute('data-tone', 'error');
          }).then(function () {
            btn.disabled = false; btn.textContent = prev;
          });
        });
      }
      return res;
    }).catch(function () {
      /* A surface that cannot ask shows nothing rather than a broken control. */
      root.innerHTML = '';
      return null;
    });
  }

  /* ── THE FROZEN C3-A SURFACE ──────────────────────────────────────────────
     Declared so the suite can assert it both ways, exactly as C1 and C2 are.
     C3-B consumes this; it does not reopen it. */
  var CONTRACT = [
    'CALL_SURFACES', 'ELIGIBLE_STATES', 'LABELS',
    'shouldShow', 'requestPayload', 'describeResult', 'mount', 'mountForAnchor',
  ];

  global.SokoniConnectCall = {
    CONTRACT: CONTRACT,
    CALL_SURFACES: CALL_SURFACES,
    ELIGIBLE_STATES: ELIGIBLE_STATES,
    LABELS: LABELS,
    shouldShow: shouldShow,
    requestPayload: requestPayload,
    describeResult: describeResult,
    mount: mount,
    mountForAnchor: mountForAnchor,
  };
})(typeof window !== 'undefined' ? window : globalThis);
