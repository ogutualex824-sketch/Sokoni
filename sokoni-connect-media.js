/* ============================================================================
   SOKONI Connect — C3-C WebRTC adapter   sokoni-connect-media.js v1.0.0
   ============================================================================
   THE MEDIA STACK, AND NOTHING ELSE.

   Three things existed and did not meet:

     connectSignal          relayed offers, answers and candidates into
                            connectSessions/{id}/signals — and NOTHING ever
                            read them. A relay with no reader is half a path.
     reportableEvents       was projected to a client that had no media stack
                            to produce a single one of them.
     transportPlan:[webrtc] was authorized on every session and no code had
                            ever attempted it.

   This module closes those three. It is an OBSERVER and a TRANSPORT. It is
   not an authority, and the distinction is enforced by what it cannot say.

   ── IT CANNOT NAME A STATE ─────────────────────────────────────────────────
   There is no path from here to `connecting`, `connected` or `failed`. This
   module emits only the authority's MEDIA EVENT names, through C2's
   `reportObservation`, and the SERVER decides what an observation means —
   two layers of it: the event table maps the observation to an intended
   destination, and the state table decides whether that move is legal from
   where the session actually is.

   So a peer connection reaching `iceConnectionState === 'connected'` reports
   `ice_connected`, which the authority deliberately maps to NOTHING. An ICE
   pair is a route, not a conversation. `connected` is reached only by
   `media_flowing` — by media actually arriving.

   ── IT INVENTS NO TRANSPORT ────────────────────────────────────────────────
   There is no `stun:` or `turn:` URL in this file, and there is no default.
   SOKONI has no TURN or STUN infrastructure provisioned, so `iceServers` is
   empty, `configured` is false, and `describeIce()` says so in words the UI
   can show. Quietly falling back to a public STUN server would manufacture
   a transport the platform does not operate and cannot support — and it
   would make "the call connected" evidence of somebody else's infrastructure.

   With no ICE servers a peer connection can still pair HOST candidates, so
   two devices on the same network may connect. Anything across NAT will not.
   That is a real limitation, stated, not hidden behind a borrowed server.

   ── NOT PROVEN BY THIS FILE ────────────────────────────────────────────────
   That media ever flowed. That two browsers ever paired. That anything here
   is deployed. The suite drives this module against a FAKE RTCPeerConnection
   and proves what it REPORTS and what it REFUSES to say — which is a claim
   about this code, not about a network.
   ========================================================================= */
(function (global) {
  'use strict';

  /* The signalling kinds the server accepts. Stated here so the suite can
     assert the two lists are the same set; a kind this module sent that
     `connectSignal` refused would be a silent dead end. */
  var SIGNAL_KINDS = ['offer', 'answer', 'candidate'];

  /* ── The mapping: a media-stack observation to the authority's event name ──
     THESE ARE THE ONLY STRINGS THIS MODULE MAY EMIT. Every one is a member of
     connect-authority's MEDIA_EVENT_NAMES, and the suite asserts the whole
     range is a subset of it — so a typo here becomes a failure rather than an
     event the server silently refuses. */

  /**
   * eventForIceState(state) -> event name | null
   *
   * PURE. `null` means "nothing worth reporting", which is not the same as an
   * error: `new`, `checking` and `closed` are ordinary progress.
   */
  function eventForIceState(state) {
    switch (String(state || '')) {
      case 'connected':
      case 'completed':
        /* A ROUTE EXISTS. Deliberately not `media_flowing` — see the header. */
        return 'ice_connected';
      case 'disconnected':
        /* May recover. Reporting it as a failure would hang up on somebody
           crossing a cell boundary. */
        return 'ice_disconnected';
      case 'failed':
        return 'connection_failed';
      default:
        return null;
    }
  }

  /**
   * eventForConnectionState(state) -> event name | null
   *
   * PURE. The aggregate peer-connection state. `connected` here is NOT
   * reported as media: the aggregate goes connected when transport is up,
   * which is the same overclaim as reading an ICE pair as a conversation.
   */
  function eventForConnectionState(state) {
    switch (String(state || '')) {
      case 'failed':
        return 'connection_failed';
      case 'disconnected':
        return 'ice_disconnected';
      default:
        return null;
    }
  }

  /**
   * eventForTrack(phase) -> event name | null
   *
   * PURE. `media_flowing` is emitted for media actually arriving — an unmuted
   * inbound track — and `media_stopped` when one that was flowing stops.
   */
  function eventForTrack(phase) {
    switch (String(phase || '')) {
      case 'unmuted': return 'media_flowing';
      case 'muted':
      case 'ended': return 'media_stopped';
      default: return null;
    }
  }

  /** Every event this module is capable of emitting. Used by the suite to
   *  prove the range is a subset of the authority's vocabulary. */
  function emittableEvents() {
    var out = {};
    ['new', 'checking', 'connected', 'completed', 'disconnected', 'failed', 'closed']
      .forEach(function (s) { var e = eventForIceState(s); if (e) out[e] = 1; });
    ['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed']
      .forEach(function (s) { var e = eventForConnectionState(s); if (e) out[e] = 1; });
    ['unmuted', 'muted', 'ended'].forEach(function (p) {
      var e = eventForTrack(p); if (e) out[e] = 1;
    });
    out.negotiation_started = 1;
    return Object.keys(out).sort();
  }

  /* ── ICE configuration ─────────────────────────────────────────────────── */

  /**
   * describeIce(iceServers) -> { iceServers, configured, reason, traversal }
   *
   * PURE, and deliberately unhelpful when nothing is provisioned. It supplies
   * NO default. See the header: a borrowed public STUN would manufacture a
   * transport SOKONI does not operate.
   */
  function describeIce(iceServers) {
    var list = Array.isArray(iceServers) ? iceServers.filter(Boolean) : [];
    if (!list.length) {
      return {
        iceServers: [],
        configured: false,
        reason: 'no_ice_servers_configured',
        traversal: 'Host candidates only. Two devices on the same network may connect; ' +
          'anything across a router or a mobile network will not.',
      };
    }
    return {
      iceServers: list,
      configured: true,
      reason: 'ice_servers_supplied',
      /* Still not a promise. Supplying servers is not the same as them working. */
      traversal: 'Relay and reflexive candidates are available. Connectivity is still ' +
        'not guaranteed and has not been demonstrated.',
    };
  }

  /* ── The adapter ───────────────────────────────────────────────────────── */

  /**
   * attach(handle, opts) -> { close, pc, ice, negotiate }
   *
   * `handle`  the object C2's `mount` returned. Its `reportObservation` is the
   *           ONLY route from here to the backend for anything state-shaped.
   *
   * opts:
   *   createPeerConnection(config)  injected, so the suite drives a fake
   *   signal(kind, payload)         -> Promise; the page wires connectSignal
   *   subscribe(onSignal)           -> unsubscribe; the page wires the
   *                                    Firestore listener the RULES already
   *                                    authorize for the addressed peer
   *   getMedia()                    -> Promise<MediaStream>
   *   isCaller                      the caller makes the offer
   *   iceServers                    supplied by the page; [] today
   *   onLocalStream / onRemoteStream / onIce  display callbacks
   */
  function attach(handle, opts) {
    var o = opts || {};
    if (!handle || typeof handle.reportObservation !== 'function') {
      /* Without C2's reporting route this module could only either stay silent
         or invent its own path to the backend. It stays silent and says why. */
      return { error: 'no_report_route', close: function () {} };
    }
    var mk = typeof o.createPeerConnection === 'function' ? o.createPeerConnection : null;
    if (!mk) return { error: 'no_peer_connection_factory', close: function () {} };

    var ice = describeIce(o.iceServers);
    var pc = mk({ iceServers: ice.iceServers });
    var unsubscribe = null;
    var closed = false;
    /* Media may be reported flowing once and stopped once per run of flow.
       Without this a track that mutes and unmutes repeatedly would spray the
       backend; the server ignores duplicates, but a client that needs the
       server to absorb its noise is a client that is guessing. */
    var flowing = false;

    function report(event) {
      if (closed || !event) return Promise.resolve(null);
      /* mayReport is C2's courtesy check against the SERVER's reportableEvents.
         It is not a control and this module does not treat it as one — the
         server refuses what it will not act on regardless. */
      return handle.reportObservation(event);
    }

    function send(kind, payload) {
      if (closed || typeof o.signal !== 'function') return Promise.resolve(null);
      if (SIGNAL_KINDS.indexOf(kind) === -1) return Promise.resolve(null);
      return o.signal(kind, payload);
    }

    /* ── Peer-connection observation ───────────────────────────────────── */
    pc.oniceconnectionstatechange = function () {
      report(eventForIceState(pc.iceConnectionState));
    };
    pc.onconnectionstatechange = function () {
      report(eventForConnectionState(pc.connectionState));
    };
    pc.onicecandidate = function (ev) {
      if (!ev || !ev.candidate) return;
      send('candidate', JSON.stringify(ev.candidate));
      if (typeof o.onIce === 'function') o.onIce(ev.candidate);
    };
    pc.ontrack = function (ev) {
      var track = ev && ev.track;
      if (typeof o.onRemoteStream === 'function' && ev && ev.streams) {
        o.onRemoteStream(ev.streams[0]);
      }
      if (!track) return;
      /* MEDIA IS OBSERVED ON THE TRACK, not inferred from ontrack firing. A
         track can be added and carry nothing. */
      if (track.muted === false && !flowing) { flowing = true; report('media_flowing'); }
      track.onunmute = function () {
        if (!flowing) { flowing = true; report(eventForTrack('unmuted')); }
      };
      track.onmute = function () {
        if (flowing) { flowing = false; report(eventForTrack('muted')); }
      };
      track.onended = function () {
        if (flowing) { flowing = false; report(eventForTrack('ended')); }
      };
    };

    /* ── Signalling in ─────────────────────────────────────────────────── */
    function onSignal(sig) {
      if (closed || !sig) return Promise.resolve(null);
      var kind = String(sig.kind || '');
      var payload = sig.payload;
      try { payload = typeof payload === 'string' ? JSON.parse(payload) : payload; }
      catch (e) { return Promise.resolve(null); }

      if (kind === 'offer') {
        return Promise.resolve(pc.setRemoteDescription(payload))
          .then(function () { return pc.createAnswer(); })
          .then(function (answer) {
            return Promise.resolve(pc.setLocalDescription(answer)).then(function () {
              return send('answer', JSON.stringify(answer));
            });
          });
      }
      if (kind === 'answer') {
        return Promise.resolve(pc.setRemoteDescription(payload));
      }
      if (kind === 'candidate') {
        return Promise.resolve(pc.addIceCandidate(payload)).catch(function () {
          /* A candidate that arrives before the remote description is normal
             and is not a failure of the call. */
          return null;
        });
      }
      return Promise.resolve(null);
    }

    if (typeof o.subscribe === 'function') unsubscribe = o.subscribe(onSignal);

    /* ── Negotiation ───────────────────────────────────────────────────── */
    function negotiate() {
      /* The OBSERVATION that negotiation began. Reported before the offer so a
         caller whose offer never completes is still visibly negotiating rather
         than silently stuck in `accepted`. */
      return report('negotiation_started').then(function () {
        if (typeof o.getMedia !== 'function') return null;
        return Promise.resolve(o.getMedia()).then(function (stream) {
          if (stream && typeof pc.addTrack === 'function' &&
              typeof stream.getTracks === 'function') {
            stream.getTracks().forEach(function (t) { pc.addTrack(t, stream); });
          }
          if (typeof o.onLocalStream === 'function') o.onLocalStream(stream);
          /* Only the caller offers. Both sides offering is glare, and the
             answerer's job arrives through onSignal. */
          if (!o.isCaller) return null;
          return Promise.resolve(pc.createOffer()).then(function (offer) {
            return Promise.resolve(pc.setLocalDescription(offer)).then(function () {
              return send('offer', JSON.stringify(offer));
            });
          });
        });
      }).catch(function (e) {
        /* A local media failure is a REAL failure of this attempt and is
           reported as the observation it is — not as a state, and not
           swallowed. Permission refused, no microphone, no camera all land
           here, and the server decides what `connection_failed` means from
           wherever the session actually is. */
        report('connection_failed');
        return { error: (e && e.message) || 'negotiation_failed' };
      });
    }

    function close() {
      closed = true;
      if (typeof unsubscribe === 'function') { try { unsubscribe(); } catch (e) {} }
      try { pc.close(); } catch (e) {}
    }

    return { close: close, pc: pc, ice: ice, negotiate: negotiate, _onSignal: onSignal };
  }

  /* ── THE C3-C SURFACE ───────────────────────────────────────────────────
     Declared so the suite can assert it both ways. */
  var CONTRACT = [
    'CONTRACT', 'SIGNAL_KINDS', 'eventForIceState', 'eventForConnectionState',
    'eventForTrack', 'emittableEvents', 'describeIce', 'attach',
  ];

  global.SokoniConnectMedia = {
    CONTRACT: CONTRACT,
    SIGNAL_KINDS: SIGNAL_KINDS,
    eventForIceState: eventForIceState,
    eventForConnectionState: eventForConnectionState,
    eventForTrack: eventForTrack,
    emittableEvents: emittableEvents,
    describeIce: describeIce,
    attach: attach,
  };
})(typeof window !== 'undefined' ? window : globalThis);
