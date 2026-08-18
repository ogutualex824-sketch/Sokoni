/* ════════════════════════════════════════════════════════════════════════════
   SOKONI Merchant Messages — the native surface (2D-2 step 5)

       merchant.html → this surface → messagesDispatch { op: … }
                                    → conversations/{id}/messages  (READ only)

   ── The mobile defect this is built around ──────────────────────────────────
   The earlier Messages diagnostic found the structure sound but the composer far
   below the viewport on a long thread — because the composer was the last
   element of a scrolling column. Scroll to write; scroll back to read.

   Here the thread is a three-row flex column and the composer is a FOOTER, not
   content:

       header    fixed   (back, name, context)
       messages  flex:1  scrolls independently
       composer  fixed   always on screen, whatever the thread's length

   A long thread therefore scrolls under a composer that never moves. The
   `visualViewport` handler lifts that footer by the exact height of the software
   keyboard, so the field a merchant is typing into is never behind it — the case
   `env(safe-area-inset-bottom)` alone does not cover.

   ── Reads and writes ────────────────────────────────────────────────────────
   Sending, marking read and reading context are OPS on the dispatcher. The
   thread body is a Firestore READ, because no server op returns messages;
   `firestore.rules` gates it on participation and blocks client creates outright
   (`allow create: if false`), so a client cannot become the writer even by
   mistake. This surface performs no Firestore write of any kind.

   ── Not carried over ────────────────────────────────────────────────────────
   `localStorage.sokoniMessages`. seller.js kept the inbox on the device; the
   interaction model is worth porting, the storage model is what is being
   replaced.
   ════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SokoniMerchantMessagesUI = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CSS_ID = 'sokoni-merchant-messages-css';

  var CSS = [
    '#native-messages{padding:0!important;overflow:hidden!important;display:flex;flex-direction:column}',
    '.mmg{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;position:relative}',

    /* ── Inbox ── */
    '.mmg-top{flex:0 0 auto;padding:12px 14px;border-bottom:1px solid var(--line);background:var(--panel)}',
    '.mmg-find{display:flex;align-items:center;gap:8px;background:rgba(255,255,255,.06);',
      'border:1px solid var(--line);border-radius:13px;padding:0 12px;height:48px}',
    '.mmg-find input{flex:1;min-width:0;height:100%;background:none;border:none;outline:none;color:var(--txt);',
      'font-size:16px;font-weight:600;font-family:inherit}',
    '.mmg-find input::placeholder{color:var(--txt3);font-weight:500}',

    '.mmg-body{flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:8px 14px 16px}',

    '.mmg-row{display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--line);',
      'width:100%;text-align:left;background:none;border-left:none;border-right:none;border-top:none;',
      'color:var(--txt);font-family:inherit;cursor:pointer;min-height:68px}',
    '.mmg-row:last-child{border-bottom:none}',
    '.mmg-av{flex:0 0 auto;width:42px;height:42px;border-radius:14px;background:rgba(113,255,0,.12);',
      'border:1px solid rgba(113,255,0,.28);color:var(--acc);display:flex;align-items:center;',
      'justify-content:center;font-weight:900;font-size:14px}',
    '.mmg-av.unread{background:var(--acc);color:#000;border-color:var(--acc)}',
    /* min-width:0 is what lets a long name ellipsise instead of widening the row */
    '.mmg-info{flex:1;min-width:0}',
    '.mmg-nm{font-size:14px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.mmg-nm.unread{font-weight:900}',
    '.mmg-prev{font-size:12px;color:var(--txt3);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.mmg-meta{flex:0 0 auto;display:flex;flex-direction:column;align-items:flex-end;gap:6px}',
    '.mmg-time{font-size:10.5px;color:var(--txt3);white-space:nowrap}',
    '.mmg-badge{min-width:22px;height:22px;border-radius:11px;background:var(--acc);color:#000;',
      'font-size:11px;font-weight:900;display:flex;align-items:center;justify-content:center;padding:0 6px}',

    /* ── Thread — three rows, and the composer is NOT content ── */
    '.mmg-thread{position:absolute;inset:0;display:flex;flex-direction:column;background:var(--bg);z-index:5}',
    '.mmg-th-h{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:10px 12px;',
      'border-bottom:1px solid var(--line);background:var(--panel)}',
    '.mmg-back{flex:0 0 auto;width:44px;height:44px;border-radius:12px;border:1px solid var(--line);',
      'background:rgba(255,255,255,.05);color:var(--txt2);font-size:18px;cursor:pointer;font-family:inherit}',
    '.mmg-th-t{flex:1;min-width:0}',
    '.mmg-th-t .n{font-size:14px;font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.mmg-th-t .s{font-size:11px;color:var(--txt3);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',

    '.mmg-msgs{flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:14px 12px;',
      'display:flex;flex-direction:column;gap:8px}',
    '.mmg-msg{max-width:82%;padding:10px 13px;border-radius:16px;font-size:14px;line-height:1.45;',
      /* anywhere, not break-word: a 200-character URL with no spaces must wrap */
      'overflow-wrap:anywhere;word-break:break-word}',
    '.mmg-msg.them{align-self:flex-start;background:rgba(255,255,255,.07);border:1px solid var(--line);',
      'border-bottom-left-radius:5px}',
    '.mmg-msg.me{align-self:flex-end;background:rgba(113,255,0,.14);border:1px solid rgba(113,255,0,.3);',
      'color:var(--txt);border-bottom-right-radius:5px}',
    '.mmg-msg .t{font-size:10px;color:var(--txt3);margin-top:5px;text-align:right}',
    '.mmg-msg.deleted{opacity:.5;font-style:italic}',
    '.mmg-day{align-self:center;font-size:10.5px;color:var(--txt3);background:rgba(255,255,255,.05);',
      'border:1px solid var(--line);border-radius:9px;padding:4px 10px;margin:4px 0}',

    /* The composer. `flex:0 0 auto` inside the column keeps it on screen for any
       thread length; the keyboard inset is applied as padding so the field lifts
       with the software keyboard rather than sitting behind it. */
    '.mmg-composer{flex:0 0 auto;display:flex;align-items:flex-end;gap:9px;padding:10px 12px;',
      'border-top:1px solid var(--line);background:linear-gradient(180deg,#0c0c0c,#080808);',
      'padding-bottom:calc(10px + env(safe-area-inset-bottom,0px) + var(--mmg-kb,0px))}',
    '.mmg-composer textarea{flex:1;min-width:0;min-height:48px;max-height:132px;background:rgba(255,255,255,.06);',
      'border:1px solid var(--line);border-radius:14px;padding:13px 14px;color:var(--txt);',
      'font-size:16px;font-family:inherit;outline:none;resize:none;line-height:1.4}',
    '.mmg-composer textarea:focus{border-color:rgba(113,255,0,.42)}',
    '.mmg-send{flex:0 0 auto;width:48px;height:48px;border-radius:14px;border:1px solid var(--acc);',
      'background:var(--acc);color:#000;font-size:18px;font-weight:900;cursor:pointer;font-family:inherit}',
    '.mmg-send[disabled]{opacity:.4;cursor:default}',

    '.mmg-state{padding:40px 24px;text-align:center;color:var(--txt2);font-size:13.5px;line-height:1.6}',
    '.mmg-state .ic{font-size:36px;margin-bottom:12px}',
    '.mmg-state .hd{font-weight:800;font-size:15px;color:var(--txt);margin-bottom:8px}',
    '.mmg-btn{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:0 20px;',
      'border-radius:13px;font-weight:800;font-size:14px;cursor:pointer;font-family:inherit;',
      'border:1px solid rgba(113,255,0,.32);background:rgba(113,255,0,.13);color:var(--acc)}',
    '.mmg-banner{padding:11px 13px;border-radius:12px;background:rgba(255,255,255,.04);border:1px solid var(--line);',
      'font-size:11.5px;color:var(--txt2);line-height:1.55;margin-bottom:10px}',
    '.mmg-banner b{color:var(--txt)}',
    '.mmg-err{padding:11px 13px;border-radius:12px;background:rgba(255,90,90,.10);border:1px solid rgba(255,90,90,.34);',
      'color:#ff9a9a;font-size:12.5px;font-weight:700;line-height:1.5;margin:10px 12px}',
    '.mmg-sending{align-self:flex-end;font-size:10.5px;color:var(--txt3);padding-right:4px}',
    '@media (min-width:821px){.mmg-msg{max-width:min(68%,620px)}}',
  ].join('');

  function injectCSS(doc) {
    if (!doc || doc.getElementById(CSS_ID)) return;
    var s = doc.createElement('style');
    s.id = CSS_ID; s.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(s);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function initials(name) {
    var s = String(name || '').trim();
    if (!s) return '?';
    var parts = s.split(/\s+/).filter(Boolean);
    return ((parts[0] || '').charAt(0) + (parts.length > 1 ? (parts[parts.length - 1] || '').charAt(0) : ''))
      .toUpperCase() || '?';
  }

  function mount(host, ctx) {
    if (!host) return null;
    var doc = host.ownerDocument || document;
    injectCSS(doc);
    ctx = ctx || {};

    var MM = (typeof globalThis !== 'undefined' && globalThis.SokoniMerchantMessages) || null;
    if (!MM) {
      host.innerHTML = '<div class="mmg"><div class="mmg-state"><div class="ic">⚠️</div>' +
        '<div class="hd">Messages are unavailable</div>The messages module did not load. ' +
        'Reopen SOKONI Merchant.</div></div>';
      return null;
    }

    var S = {
      phase: 'loading',     /* loading | not_signed_in | error | ready */
      error: null,
      query: '',
      threads: [],
      open: null,           /* the thread being read */
      messages: [],
      msgPhase: 'idle',     /* idle | loading | error */
      msgError: null,
      draft: '',
      sending: false,
      sendError: null,
    };

    function toast(msg, kind) {
      if (typeof ctx.onToast === 'function') { try { ctx.onToast(msg, kind); return; } catch (_) {} }
      if (kind === 'error') console.error('[merchant messages] ' + msg);
    }

    var me = (ctx.scope && ctx.scope.sellerUid) || null;

    function load() {
      if (!ctx.scope || (!ctx.scope.ok && ctx.scope.reason === 'not_signed_in')) {
        S.phase = 'not_signed_in'; paint(); return Promise.resolve();
      }
      S.phase = 'loading'; paint();
      return MM.listThreads({ dispatch: ctx.dispatch, query: S.query }).then(function (r) {
        if (!r.ok) { S.phase = 'error'; S.error = r.error; paint(); return; }
        S.threads = r.threads || [];
        S.phase = 'ready'; paint();
      }).catch(function (e) {
        S.phase = 'error'; S.error = (e && e.message) || 'Your messages could not be loaded.'; paint();
      });
    }

    function openThread(t) {
      S.open = t; S.messages = []; S.msgPhase = 'loading'; S.msgError = null;
      S.draft = ''; S.sendError = null;
      paint();
      MM.loadMessages({ conversationId: t.id, db: ctx.db }).then(function (r) {
        if (!S.open || S.open.id !== t.id) return;
        if (!r.ok) { S.msgPhase = 'error'; S.msgError = r.error; paint(); return; }
        S.messages = r.messages || []; S.msgPhase = 'idle'; paint(); scrollToEnd();
      }).catch(function (e) {
        if (!S.open || S.open.id !== t.id) return;
        S.msgPhase = 'error'; S.msgError = (e && e.message) || 'This conversation could not be opened.'; paint();
      });
      /* Marking read is the server's; the badge clears when the list is re-read. */
      if (t.unreadCount > 0) {
        MM.markRead({ conversationId: t.id, dispatch: ctx.dispatch }).then(function (r) {
          if (r.ok) { t.unreadCount = 0; load(); }
        }).catch(function () {});
      }
    }

    function scrollToEnd() {
      var el = host.querySelector('.mmg-msgs');
      if (el) el.scrollTop = el.scrollHeight;
    }

    /* ── Render ───────────────────────────────────────────────────────────── */
    function paint() {
      host.innerHTML = '<div class="mmg">' + (S.open ? '' : (topHTML() + bodyHTML())) +
        (S.open ? threadHTML() : '') + '</div>';
      if (S.open) {
        var ta = host.querySelector('#mmg-draft');
        if (ta && S.focusDraft) { ta.focus(); S.focusDraft = false; }
        scrollToEnd();
      }
    }

    function topHTML() {
      return '<div class="mmg-top"><label class="mmg-find"><span aria-hidden="true">🔎</span>' +
        '<input id="mmg-q" type="search" inputmode="search" autocomplete="off" ' +
        'placeholder="Search your conversations" value="' + esc(S.query) + '" aria-label="Search conversations"></label></div>';
    }

    function bodyHTML() {
      if (S.phase === 'loading') {
        return '<div class="mmg-body"><div class="sk-line" style="width:70%"></div>' +
          '<div class="sk-line" style="width:52%"></div><div class="sk-line" style="width:62%"></div></div>';
      }
      if (S.phase === 'not_signed_in') {
        return '<div class="mmg-body"><div class="mmg-state"><div class="ic">🔒</div>' +
          '<div class="hd">Sign in to see your messages</div>Conversations belong to your account.</div></div>';
      }
      if (S.phase === 'error') {
        return '<div class="mmg-body"><div class="mmg-state"><div class="ic">⚠️</div>' +
          '<div class="hd">Your messages could not be loaded</div>' + esc(S.error || '') +
          '<div style="margin-top:18px"><button class="mmg-btn" data-act="reload">Try again</button></div></div></div>';
      }

      var sc = MM.scopeNote();
      var head = '<div class="mmg-banner"><b>' + esc(sc.label) + '.</b> ' + esc(sc.note) + '</div>';

      if (!S.threads.length) {
        return '<div class="mmg-body">' + head + '<div class="mmg-state"><div class="ic">💬</div>' +
          '<div class="hd">' + (S.query ? 'Nothing matches that search' : 'No conversations yet') + '</div>' +
          (S.query ? 'Try part of a name or a word from the message.'
                   : 'When a customer messages you about an order, the conversation appears here.') +
          '</div></div>';
      }

      return '<div class="mmg-body">' + head + S.threads.map(function (t, i) {
        var unread = t.unreadCount > 0;
        var badge = MM.unreadBadge(t.unreadCount);
        return '<button class="mmg-row" data-act="open" data-i="' + i + '">' +
          '<div class="mmg-av' + (unread ? ' unread' : '') + '">' + esc(initials(t.participantName || t.title)) + '</div>' +
          '<div class="mmg-info">' +
            '<div class="mmg-nm' + (unread ? ' unread' : '') + '">' + esc(t.participantName || t.title || 'Conversation') + '</div>' +
            '<div class="mmg-prev">' + esc(t.lastMessageText || 'No messages yet') + '</div>' +
          '</div>' +
          '<div class="mmg-meta">' +
            '<div class="mmg-time">' + esc(MM.timeLabel(t.lastMessageAt)) + '</div>' +
            (badge ? '<div class="mmg-badge">' + esc(badge) + '</div>' : '') +
          '</div>' +
        '</button>';
      }).join('') + '</div>';
    }

    function threadHTML() {
      var t = S.open;
      var body;
      if (S.msgPhase === 'loading') {
        body = '<div class="mmg-msgs"><div class="sk-line" style="width:60%"></div>' +
          '<div class="sk-line" style="width:44%;align-self:flex-end"></div></div>';
      } else if (S.msgPhase === 'error') {
        body = '<div class="mmg-msgs"><div class="mmg-state"><div class="ic">⚠️</div>' +
          '<div class="hd">This conversation could not be opened</div>' + esc(S.msgError || '') +
          '<div style="margin-top:16px"><button class="mmg-btn" data-act="retry-thread">Try again</button></div></div></div>';
      } else if (!S.messages.length) {
        body = '<div class="mmg-msgs"><div class="mmg-state"><div class="ic">👋</div>' +
          '<div class="hd">No messages yet</div>Say hello — they will see it straight away.</div></div>';
      } else {
        body = '<div class="mmg-msgs">' + S.messages.map(function (m) {
          var mine = me && m.senderId === me;
          return '<div class="mmg-msg ' + (mine ? 'me' : 'them') + (m.deleted ? ' deleted' : '') + '">' +
            esc(m.deleted ? 'This message was deleted' : m.text) +
            '<div class="t">' + esc(MM.timeLabel(m.timestamp)) + '</div></div>';
        }).join('') + (S.sending ? '<div class="mmg-sending">Sending…</div>' : '') + '</div>';
      }

      return '<div class="mmg-thread">' +
        '<div class="mmg-th-h">' +
          '<button class="mmg-back" data-act="back" aria-label="Back to conversations">‹</button>' +
          '<div class="mmg-th-t"><div class="n">' + esc(t.participantName || t.title || 'Conversation') + '</div>' +
            '<div class="s">' + esc(t.title || (t.transactionType ? t.transactionType + ' ' + (t.transactionId || '') : '')) + '</div></div>' +
        '</div>' +
        body +
        (S.sendError ? '<div class="mmg-err">' + esc(S.sendError) + '</div>' : '') +
        '<div class="mmg-composer">' +
          '<textarea id="mmg-draft" rows="1" maxlength="' + MM.MAX_TEXT + '" ' +
            'placeholder="Write a message"' + (S.sending ? ' disabled' : '') + '>' + esc(S.draft) + '</textarea>' +
          '<button class="mmg-send" data-act="send"' + (S.sending || !S.draft.trim() ? ' disabled' : '') +
            ' aria-label="Send">➤</button>' +
        '</div>' +
      '</div>';
    }

    /* ── Actions ──────────────────────────────────────────────────────────── */
    function send() {
      if (S.sending || !S.open) return;
      var text = S.draft;
      try { MM.buildMessage({ conversationId: S.open.id, text: text }); }
      catch (e) { S.sendError = e.message; paint(); return; }
      S.sending = true; S.sendError = null; paint();
      MM.send({ conversationId: S.open.id, text: text, dispatch: ctx.dispatch }).then(function (r) {
        S.sending = false;
        if (!r.ok) { S.sendError = r.error; paint(); return; }
        /* The message is NOT appended locally. The thread is re-read, so what
           appears on screen is what the server actually stored — a locally
           appended bubble would survive a failed write. */
        S.draft = '';
        var t = S.open;
        MM.loadMessages({ conversationId: t.id, db: ctx.db }).then(function (m) {
          if (!S.open || S.open.id !== t.id) return;
          if (m.ok) S.messages = m.messages;
          paint(); scrollToEnd();
        }).catch(function () { paint(); });
        load();
      }).catch(function (e) {
        S.sending = false;
        S.sendError = (e && e.message) || 'Your message could not be sent.';
        paint();
      });
    }

    function onClick(ev) {
      var el = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
      if (!el || !host.contains(el)) return;
      var act = el.getAttribute('data-act');
      var i = parseInt(el.getAttribute('data-i'), 10);

      if (act === 'open')          { var t = S.threads[i]; if (t) openThread(t); return; }
      if (act === 'back')          { S.open = null; S.messages = []; S.draft = ''; S.sendError = null; paint(); return; }
      if (act === 'reload')        { load(); return; }
      if (act === 'retry-thread')  { if (S.open) openThread(S.open); return; }
      if (act === 'send')          { send(); return; }
    }

    function onInput(ev) {
      var el = ev.target;
      if (!el) return;
      if (el.id === 'mmg-q') {
        S.query = el.value || '';
        clearTimeout(S._t);
        S._t = setTimeout(function () { S.focusSearch = true; load(); }, 260);
        return;
      }
      if (el.id === 'mmg-draft') {
        S.draft = el.value || '';
        /* Grow the field with the text, up to the CSS max — without repainting,
           so the caret and the keyboard both stay put. */
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, 132) + 'px';
        var btn = host.querySelector('.mmg-send');
        if (btn) btn.disabled = !!(S.sending || !S.draft.trim());
      }
    }

    /* Enter sends, Shift+Enter makes a new line — the convention every messaging
       app uses, and the reason a merchant does not have to reach for a button. */
    function onKey(ev) {
      if (ev.target && ev.target.id === 'mmg-draft' && ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault(); send();
      }
    }

    /* ── Keyboard-safe composer ───────────────────────────────────────────────
       env(safe-area-inset-bottom) covers the home indicator, not the software
       keyboard. On iOS the layout viewport does not shrink when the keyboard
       opens, so a bottom-anchored composer ends up behind it. visualViewport
       reports the real visible height; the difference is the keyboard, and it is
       applied as a CSS variable the composer pads by. */
    var vv = (typeof window !== 'undefined' && window.visualViewport) || null;
    function onViewport() {
      if (!vv) return;
      var kb = Math.max(0, (window.innerHeight || 0) - vv.height - (vv.offsetTop || 0));
      host.style.setProperty('--mmg-kb', kb > 40 ? kb + 'px' : '0px');
      if (kb > 40) scrollToEnd();
    }
    if (vv) { vv.addEventListener('resize', onViewport); vv.addEventListener('scroll', onViewport); }

    host.addEventListener('click', onClick);
    host.addEventListener('input', onInput);
    host.addEventListener('keydown', onKey);

    load();

    return {
      refresh: load,
      state: function () { return S; },
      destroy: function () {
        host.removeEventListener('click', onClick);
        host.removeEventListener('input', onInput);
        host.removeEventListener('keydown', onKey);
        if (vv) { vv.removeEventListener('resize', onViewport); vv.removeEventListener('scroll', onViewport); }
        clearTimeout(S._t);
      },
    };
  }

  return { mount: mount, CSS_ID: CSS_ID };
}));
