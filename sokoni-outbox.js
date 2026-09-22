/* ============================================================================
   SOKONI Communications — the offline outbox   sokoni-outbox.js   v1.0.0
   ============================================================================
   A message composed without a connection must not be lost, and must not be
   sent twice when the connection returns.

   IT IS A TRANSPORT BUFFER, NOT A MESSAGE STORE
   ---------------------------------------------
   The queue holds messages that have NOT yet been accepted by the server. The
   moment the server acknowledges one, the canonical record is the server's and
   the entry is dropped. Nothing here is ever read back as history — that would
   be a second message store, which the engine exists to prevent. A message that
   is `sent` lives in `conversations`; the outbox only remembers what is still
   owed.

   EXACTLY-ONCE LOGICAL IDENTITY
   -----------------------------
   The transport may retry as often as it likes; the MESSAGE must appear once.
   Every entry carries a `clientMessageId` minted when the user pressed send and
   never regenerated — not on retry, not after a reload, not after a timeout.
   The server dedupes on it. This is the one property that makes the difference
   between "offline support" and "your customer received the same message four
   times because they went through a tunnel".

   A TIMEOUT IS NOT A FAILURE
   ---------------------------
   The single hardest case: the client gives up waiting, the server had already
   accepted it. Marking that `failed` and letting the user resend would deliver
   it twice. So a timeout moves to `failed` and the retry reuses the SAME
   `clientMessageId`, which the server then recognises and does not duplicate.
   Retry is explicit and idempotent; nothing retries by itself.

   NO SUCCESS BEFORE ACKNOWLEDGEMENT
   ---------------------------------
   `sent` means the server said so. Not "we called the function", not "the
   promise resolved with something". The UI ladder a user sees —
   queued → sending → sent → delivered → read — never advances on optimism.

   PURITY
   ------
   The core is a state machine and a queue. Storage, the clock and the transport
   are all INJECTED, so every case below is testable without a browser, a
   network, or a wall clock — including the ones that only happen at 2am on a
   train.
   ========================================================================= */
(function (global) {
  'use strict';

  /* The lifecycle. `sending` exists as its own state precisely so a reload
     mid-flight is distinguishable from one that never left. */
  var STATES = ['queued', 'sending', 'sent', 'delivered', 'read', 'failed'];

  /* Which transitions are legal. Same discipline as the Connect state machine:
     a whitelist, so a state nobody wrote down is refused rather than allowed by
     omission. */
  var TRANSITIONS = {
    queued:    ['sending', 'failed'],
    /* sending → queued is DELIBERATELY ABSENT. Going back to `queued` would let
       an automatic drain pick it up again while the first attempt may still be
       in flight, which is how one message becomes two. A stalled send goes to
       `failed` and waits for an explicit retry. */
    sending:   ['sent', 'failed'],
    sent:      ['delivered', 'failed'],
    delivered: ['read'],
    read:      [],
    /* failed → sending only via an EXPLICIT retry, which reuses the id. */
    failed:    ['sending'],
  };

  var TERMINAL = ['read'];

  function canTransition(from, to) {
    var f = String(from || ''), t = String(to || '');
    if (STATES.indexOf(f) === -1) return { ok: false, reason: 'unknown_from_state' };
    if (STATES.indexOf(t) === -1) return { ok: false, reason: 'unknown_to_state' };
    if (f === t) return { ok: false, reason: 'no_op' };
    if ((TRANSITIONS[f] || []).indexOf(t) === -1) return { ok: false, reason: 'not_permitted' };
    return { ok: true, reason: 'permitted' };
  }

  /**
   * newEntry({ anchorType, anchorId, conversationId, body, clientMessageId, at })
   *
   * PURE. The id is minted ONCE, here. `at` is injected so two entries created
   * in the same millisecond by a fake clock still differ — the id carries a
   * caller-supplied uniqueness component rather than trusting the clock.
   */
  function newEntry(input) {
    var i = input || {};
    var body = String(i.body || '').trim();
    if (!body) throw new Error('outbox: a message needs a body');
    if (!i.conversationId) throw new Error('outbox: a message needs a conversation');
    /* An anchor is not required to SEND — the conversation already carries the
       business context — but a malformed one is refused rather than dropped. */
    if ((i.anchorType || i.anchorId) && !(i.anchorType && i.anchorId)) {
      throw new Error('outbox: an anchor needs both anchorType and anchorId');
    }
    var id = i.clientMessageId
      ? String(i.clientMessageId)
      : ('cm_' + String(i.at || 0) + '_' + String(i.nonce || Math.random()).slice(2, 10));
    return {
      clientMessageId: id,
      conversationId: String(i.conversationId),
      anchorType: i.anchorType ? String(i.anchorType) : null,
      anchorId: i.anchorId ? String(i.anchorId) : null,
      body: body.slice(0, 2000),
      state: 'queued',
      attempts: 0,
      createdAt: i.at || 0,
      updatedAt: i.at || 0,
      lastError: null,
    };
  }

  /**
   * createOutbox({ storage, transport, now })
   *
   * `storage`   { read(): entries[], write(entries): void }
   * `transport` (entry) -> Promise<{ accepted: true, messageId }>   // or rejects
   * `now`       () -> number
   *
   * All injected. The outbox itself touches no browser API.
   */
  function createOutbox(deps) {
    var d = deps || {};
    var storage = d.storage;
    var transport = d.transport;
    var now = typeof d.now === 'function' ? d.now : function () { return 0; };
    if (!storage || typeof storage.read !== 'function' || typeof storage.write !== 'function') {
      throw new Error('outbox: storage with read/write is required');
    }

    /* Guards against a second concurrent drain in the same tab. The `sending`
       state guards across tabs and reloads; this guards within one. */
    var draining = false;

    function _load() {
      var raw = storage.read();
      return Array.isArray(raw) ? raw : [];
    }
    function _save(list) { storage.write(list); }

    function list() { return _load(); }

    function pending() {
      return _load().filter(function (e) { return e.state === 'queued' || e.state === 'failed'; });
    }

    /**
     * enqueue(input) -> entry
     *
     * IDEMPOTENT ON clientMessageId. Enqueuing the same id twice returns the
     * existing entry untouched — a double-tapped send button adds one message.
     */
    function enqueue(input) {
      var entry = newEntry(Object.assign({ at: now() }, input || {}));
      var listNow = _load();
      for (var i = 0; i < listNow.length; i++) {
        if (listNow[i].clientMessageId === entry.clientMessageId) return listNow[i];
      }
      listNow.push(entry);
      _save(listNow);
      return entry;
    }

    /** Applies a transition, refusing anything the table does not allow. */
    function _set(id, to, patch) {
      var listNow = _load();
      for (var i = 0; i < listNow.length; i++) {
        if (listNow[i].clientMessageId !== id) continue;
        var move = canTransition(listNow[i].state, to);
        if (!move.ok) return { ok: false, reason: move.reason, entry: listNow[i] };
        listNow[i] = Object.assign({}, listNow[i], patch || {}, {
          state: to, updatedAt: now(),
        });
        _save(listNow);
        return { ok: true, reason: 'ok', entry: listNow[i] };
      }
      return { ok: false, reason: 'not_found', entry: null };
    }

    /**
     * _attempt(entry) — one send. NEVER regenerates the id.
     */
    function _attempt(entry) {
      var moved = _set(entry.clientMessageId, 'sending', { attempts: (entry.attempts || 0) + 1 });
      if (!moved.ok) return Promise.resolve(moved);

      return transport({
        clientMessageId: entry.clientMessageId,
        conversationId: entry.conversationId,
        anchorType: entry.anchorType,
        anchorId: entry.anchorId,
        body: entry.body,
      }).then(function (res) {
        /* `sent` ONLY on an explicit acknowledgement. A resolved promise that
           did not say `accepted` is not an acknowledgement — treating it as one
           is how a UI shows a tick for a message the server never took. */
        if (!res || res.accepted !== true) {
          return _set(entry.clientMessageId, 'failed',
            { lastError: 'no_acknowledgement' });
        }
        return _set(entry.clientMessageId, 'sent', {
          serverMessageId: res.messageId || null, lastError: null,
        });
      }).catch(function (e) {
        /* A TIMEOUT LANDS HERE and is recorded as failed — but the id is kept,
           so the explicit retry is the SAME message and the server dedupes it.
           Nothing is resent automatically. */
        return _set(entry.clientMessageId, 'failed',
          { lastError: String((e && e.code) || (e && e.message) || 'send_failed') });
      });
    }

    /**
     * drain({ online }) -> Promise<{ attempted, skipped, reason }>
     *
     * Sends every queued entry once, in order. Refuses to run while offline and
     * refuses to run twice at once — a reconnect that fires two events must not
     * produce two sends.
     */
    function drain(opts) {
      var o = opts || {};
      if (o.online === false) {
        return Promise.resolve({ attempted: 0, skipped: pending().length, reason: 'offline' });
      }
      if (draining) {
        return Promise.resolve({ attempted: 0, skipped: pending().length, reason: 'already_draining' });
      }
      draining = true;
      /* Only `queued`. A `failed` entry waits for an explicit retry — draining
         it automatically would resend on every reconnect for ever. */
      var todo = _load().filter(function (e) { return e.state === 'queued'; });
      var attempted = 0;
      var chain = Promise.resolve();
      todo.forEach(function (e) {
        chain = chain.then(function () { attempted++; return _attempt(e); });
      });
      return chain.then(function () {
        draining = false;
        return { attempted: attempted, skipped: 0, reason: attempted ? 'drained' : 'nothing_queued' };
      }).catch(function (e) {
        draining = false;
        return { attempted: attempted, skipped: 0, reason: 'drain_error', error: String(e && e.message) };
      });
    }

    /**
     * retry(clientMessageId) — EXPLICIT and IDEMPOTENT.
     *
     * Reuses the id, so the server recognises a message it may already hold.
     */
    function retry(id) {
      var listNow = _load();
      for (var i = 0; i < listNow.length; i++) {
        if (listNow[i].clientMessageId !== String(id)) continue;
        if (listNow[i].state !== 'failed') {
          return Promise.resolve({ ok: false, reason: 'only_failed_can_retry', entry: listNow[i] });
        }
        return _attempt(listNow[i]);
      }
      return Promise.resolve({ ok: false, reason: 'not_found', entry: null });
    }

    /** The server later reports delivery/read. Both go through the table. */
    function markDelivered(id) { return _set(String(id), 'delivered', {}); }
    function markRead(id) { return _set(String(id), 'read', {}); }

    /**
     * forget(id) — drop an entry the server now owns.
     *
     * The outbox is a buffer: once a message is `sent` the canonical record is
     * the server's, and keeping a copy here would grow a second message store.
     * Refuses to drop anything the server has NOT accepted.
     */
    function forget(id) {
      var listNow = _load();
      var kept = [];
      var dropped = false;
      for (var i = 0; i < listNow.length; i++) {
        var e = listNow[i];
        if (e.clientMessageId === String(id) &&
            ['sent', 'delivered', 'read'].indexOf(e.state) !== -1) {
          dropped = true;
          continue;
        }
        kept.push(e);
      }
      if (dropped) _save(kept);
      return { ok: dropped, reason: dropped ? 'forgotten' : 'not_acknowledged_yet' };
    }

    return {
      list: list, pending: pending, enqueue: enqueue, drain: drain, retry: retry,
      markDelivered: markDelivered, markRead: markRead, forget: forget,
    };
  }

  var CONTRACT = ['STATES', 'TRANSITIONS', 'TERMINAL', 'canTransition', 'newEntry',
    'createOutbox'];

  global.SokoniOutbox = {
    CONTRACT: CONTRACT,
    STATES: STATES,
    TRANSITIONS: TRANSITIONS,
    TERMINAL: TERMINAL,
    canTransition: canTransition,
    newEntry: newEntry,
    createOutbox: createOutbox,
  };
})(typeof window !== 'undefined' ? window : globalThis);
