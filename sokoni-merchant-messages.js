/* ════════════════════════════════════════════════════════════════════════════
   SOKONI Merchant Messages — the client layer (2D-2 step 5)

   Every operation goes through ONE server boundary, the deployed dispatcher:

       messagesDispatch { op: 'searchConversations' | 'sendMessage' |
                              'markRead' | 'getConversationContext' | … }

   The individual handlers are not re-exported in functions/index.js; the router
   is, and it routes straight into the same `messages._h[op]` functions. That is
   why the census classified Messages reachable rather than undeployed.

   ── The one Firestore access, and why it is a READ ──────────────────────────
   There is NO server op that returns a thread's messages. `searchConversations`
   returns the inbox, `getConversationContext` returns the conversation and its
   transaction — neither returns the message list. The thread body is read by the
   client, gated by `firestore.rules`:

       conversations/{id}/messages   allow read:   if participant
                                     allow create: if FALSE

   That `create: if false` is the whole reason this is safe. A client cannot
   write a message even by accident — `sendMessage` (Admin SDK) is the only
   writer, which is what stops senderId spoofing. So this module reads messages
   and writes NOTHING: every mutation is an op on the dispatcher.

   ── What is NOT carried over from seller.html ───────────────────────────────
   `localStorage.sokoniMessages`. seller.js kept the inbox on the device; a
   thread read on one phone stayed unread on another, and a message sent from the
   till never appeared on the laptop. The interaction model is worth porting; the
   storage model is the thing being replaced.

   ── Scope ───────────────────────────────────────────────────────────────────
   Conversations are PARTICIPANT-scoped, not shop-scoped: `userConversations/{uid}`
   is a per-account projection, and every op re-checks `participants.includes(uid)`
   server-side. A merchant sees the threads they are a party to, across everything
   they sell. Stated on screen rather than implied to be per-shop.
   ════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SokoniMerchantMessages = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DISPATCH = 'messagesDispatch';
  /* Ops this surface uses. Every admin op the router also exposes
     (adminGetReports, adminReviewReport, adminUpdateChatPolicy,
     adminGetChatStats) is deliberately absent — each is superAdmin-gated
     server-side, and a merchant surface has no business naming them. */
  var OPS = {
    inbox: 'searchConversations',
    context: 'getConversationContext',
    send: 'sendMessage',
    markRead: 'markRead',
    report: 'reportConversation',
  };

  var MAX_TEXT = 4000;      /* mirrors sendMessage's server-side cap */

  function scopeNote() {
    return {
      level: 'account',
      label: 'Conversations you are part of',
      note: 'Messages belong to a conversation you are a participant in, not to one shop, ' +
            'so this covers every thread across your account.',
    };
  }

  function _unwrap(res) { return (res && res.data) ? res.data : res; }

  /* One call shape for the whole surface: op + payload, through the router. */
  async function _op(dispatch, op, payload, failMessage) {
    if (typeof dispatch !== 'function') throw new Error('merchant messages: dispatch is required');
    try {
      var d = _unwrap(await dispatch(Object.assign({ op: op }, payload || {})));
      if (d && d.ok === false) return { ok: false, error: d.error || failMessage };
      return Object.assign({ ok: true }, d || {});
    } catch (e) {
      return { ok: false, error: (e && e.message) || failMessage, code: (e && e.code) || null };
    }
  }

  /* ── Inbox ────────────────────────────────────────────────────────────────
     `userConversations/{uid}/items` is a per-account projection: the caller can
     only ever be handed their own. Unread count is carried through as a real
     number, and a missing one is 0 — that is a genuine "none", not an unknown. */
  function projectThread(t) {
    return {
      id: t.conversationId || t.id || null,
      title: t.title || null,
      participantName: t.participantName || null,
      participantAvatar: t.participantAvatar || null,
      transactionType: t.transactionType || null,
      transactionId: t.transactionId || null,
      lastMessageText: t.lastMessageText || null,
      lastMessageAt: t.lastMessageAt || null,
      lastMessageSenderId: t.lastMessageSenderId || null,
      unreadCount: (typeof t.unreadCount === 'number') ? t.unreadCount : 0,
      status: t.status || 'active',
    };
  }

  async function listThreads(o) {
    var r = await _op(o.dispatch, OPS.inbox, { query: o.query || '' }, 'Your messages could not be loaded.');
    if (!r.ok) return r;
    var rows = (r.items || []).map(projectThread);
    /* Unread first, then most recent. A merchant opens this screen to find what
       is waiting on them. */
    rows.sort(function (a, b) {
      if ((a.unreadCount > 0) !== (b.unreadCount > 0)) return a.unreadCount > 0 ? -1 : 1;
      return (_ms(b.lastMessageAt) - _ms(a.lastMessageAt));
    });
    return { ok: true, threads: rows, count: rows.length, hasMore: r.hasMore === true,
      unreadTotal: rows.reduce(function (s, t) { return s + t.unreadCount; }, 0) };
  }

  function _ms(ts) {
    if (!ts) return 0;
    if (typeof ts === 'number') return ts;
    if (ts.seconds) return ts.seconds * 1000;
    if (ts._seconds) return ts._seconds * 1000;
    if (ts.toMillis) { try { return ts.toMillis(); } catch (_) { return 0; } }
    var t = Date.parse(ts); return isFinite(t) ? t : 0;
  }

  /* ── Thread body — the ONE read ───────────────────────────────────────────
     A query descriptor, so the surface never assembles its own path. Ordered
     oldest-first because that is how a conversation reads. */
  function messagesQuery(conversationId, limit) {
    if (!conversationId) throw new Error('merchant messages: conversationId is required');
    return {
      path: ['conversations', String(conversationId), 'messages'],
      orderBy: ['timestamp', 'asc'],
      limit: limit || 200,
    };
  }

  async function loadMessages(o) {
    if (typeof o.db !== 'object' || typeof o.db.queryMessages !== 'function') {
      throw new Error('merchant messages: a db adapter with queryMessages is required');
    }
    try {
      var rows = await o.db.queryMessages(messagesQuery(o.conversationId, o.limit));
      return { ok: true, messages: (rows || []).map(function (m) {
        return {
          id: m.id,
          senderId: m.senderId || null,
          senderName: m.senderName || null,
          type: m.type || 'text',
          text: m.text || '',
          timestamp: m.timestamp || null,
          deleted: m.deleted === true,
        };
      }) };
    } catch (e) {
      /* A rules refusal reaches here as permission-denied. Reported, never
         rendered as an empty conversation. */
      return { ok: false, error: (e && e.message) || 'This conversation could not be opened.',
        code: (e && e.code) || null };
    }
  }

  /* ── Send ─────────────────────────────────────────────────────────────────
     Text only from this surface. The server accepts several message types; a
     merchant workspace that offered attachments it cannot upload would be
     offering a control that fails. */
  function buildMessage(o) {
    if (!o.conversationId) throw new Error('merchant messages: conversationId is required');
    var text = String(o.text == null ? '' : o.text).trim();
    if (!text) throw new Error('Type a message first.');
    if (text.length > MAX_TEXT) throw new Error('That message is too long — keep it under ' + MAX_TEXT + ' characters.');
    return { conversationId: String(o.conversationId), type: 'text', text: text };
  }

  async function send(o) {
    return _op(o.dispatch, OPS.send, buildMessage(o), 'Your message could not be sent.');
  }

  async function markRead(o) {
    if (!o.conversationId) throw new Error('merchant messages: conversationId is required');
    return _op(o.dispatch, OPS.markRead, { conversationId: String(o.conversationId) },
      'This conversation could not be marked as read.');
  }

  async function getContext(o) {
    if (!o.conversationId) throw new Error('merchant messages: conversationId is required');
    return _op(o.dispatch, OPS.context, { conversationId: String(o.conversationId) },
      'The order behind this conversation could not be loaded.');
  }

  /* ── Display ──────────────────────────────────────────────────────────────
     A count of zero is a real answer and renders as nothing at all; a badge is
     shown only for a genuine unread count. */
  function unreadBadge(n) { return (typeof n === 'number' && n > 0) ? (n > 99 ? '99+' : String(n)) : null; }

  function timeLabel(ts) {
    var ms = _ms(ts);
    if (!ms) return '';
    var d = new Date(ms);
    var now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    try {
      return sameDay
        ? d.toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' })
        : d.toLocaleDateString('en-KE', { day: 'numeric', month: 'short' });
    } catch (_) { return ''; }
  }

  return {
    DISPATCH: DISPATCH,
    OPS: OPS,
    MAX_TEXT: MAX_TEXT,
    scopeNote: scopeNote,
    projectThread: projectThread,
    listThreads: listThreads,
    messagesQuery: messagesQuery,
    loadMessages: loadMessages,
    buildMessage: buildMessage,
    send: send,
    markRead: markRead,
    getContext: getContext,
    unreadBadge: unreadBadge,
    timeLabel: timeLabel,
  };
}));
