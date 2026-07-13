/* ================================================================
   KASS — SOKONI AI Concierge Widget  v3.0
   Polish sprint: auth-gate, auto-grow composer, visual-viewport
   keyboard fix, focus-trap, swipe-to-close, browser-back, ESC,
   44px tap targets, iOS safe-areas, accessibility, animations.
   Usage: <script defer src="kass-widget.js"></script>
================================================================ */
(function () {
  'use strict';
  if (document.getElementById('kassBtn')) return;

  var ENDPOINT = '/api/chat';

  /* ── Session state ───────────────────────────────────────────── */
  var _history     = [];
  var _greeted     = false;
  var _busy        = false;
  var _authState   = 'pending'; /* 'pending' | 'guest' | 'authed' */
  var _histPushed  = false;
  var _closingViaHistory = false;
  var _swipeStartY = 0;
  var _prevFocus   = null;

  /* ── SVG icons (stored once, reused) ────────────────────────── */
  var _SEND_SVG = [
    '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="#000"',
    ' stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">',
    '<line x1="22" y1="2" x2="11" y2="13"/>',
    '<polygon points="22 2 15 22 11 13 2 9 22 2"/>',
    '</svg>',
  ].join('');

  var _SPIN_SVG = [
    '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="#000"',
    ' stroke-width="2.5" stroke-linecap="round">',
    '<path d="M12 2a10 10 0 0 1 10 10" opacity=".3"/>',
    '<path d="M22 12a10 10 0 0 1-10 10"/>',
    '</svg>',
  ].join('');

  /* ── Auth helpers ────────────────────────────────────────────── */
  function _getAuthInstance() {
    try {
      if (window.firebaseAuth) return window.firebaseAuth;
      if (window.firebase && window.firebase.auth) return window.firebase.auth();
    } catch (_) {}
    return null;
  }

  function _getAuthToken() {
    return new Promise(function (resolve) {
      try {
        var auth = _getAuthInstance();
        if (!auth) { resolve(null); return; }
        var user = auth.currentUser;
        if (!user) { resolve(null); return; }
        user.getIdToken(false).then(resolve).catch(function () { resolve(null); });
      } catch (_) { resolve(null); }
    });
  }

  function _onAuthChange(user) {
    var prev = _authState;
    _authState = user ? 'authed' : 'guest';
    _syncAuthUI();
    /* If the user just signed in while the panel is open, show the greeting */
    if (prev !== 'authed' && _authState === 'authed' && _isOpen() && !_greeted) {
      _showGreeting();
    }
  }

  function _initAuth() {
    /* Immediate check */
    var auth = _getAuthInstance();
    _onAuthChange(auth ? auth.currentUser : null);

    /* Reactive subscription */
    try {
      var sub = (window.firebaseSDK && window.firebaseSDK.onAuthStateChanged)
        ? window.firebaseSDK.onAuthStateChanged
        : null;
      if (!sub && auth && auth.onAuthStateChanged) {
        sub = function (cb) { return auth.onAuthStateChanged(cb); };
      }
      if (sub) sub(_onAuthChange);
    } catch (_) {}
  }

  function _syncAuthUI() {
    var wall  = document.getElementById('kassAuthWall');
    var field = document.getElementById('kassField');
    var send  = document.getElementById('kassSend');
    if (!wall || !field || !send) return;

    if (_authState === 'authed') {
      wall.classList.add('k-hidden');
      field.disabled    = false;
      field.placeholder = 'Ask KASS anything…';
      send.disabled     = !field.value.trim();
    } else {
      wall.classList.remove('k-hidden');
      field.disabled    = true;
      field.placeholder = 'Sign in to chat with KASS';
      send.disabled     = true;
    }
  }

  /* ── XSS escape ──────────────────────────────────────────────── */
  function _esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ── Markdown → safe HTML ────────────────────────────────────── */
  function _md(text) {
    var s = _esc(String(text || ''));
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*\n]+?)\*/g, '<em>$1</em>');
    s = s.replace(/\[([^\]]{1,80})\]\(([^)]{1,200})\)/g,
      '<a href="$2">$1</a>');
    var lines = s.split('\n'), out = [], inList = false;
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (/^[-•] /.test(l)) {
        if (!inList) { out.push('<ul>'); inList = true; }
        out.push('<li>' + l.replace(/^[-•] /, '') + '</li>');
      } else {
        if (inList) { out.push('</ul>'); inList = false; }
        out.push(l);
      }
    }
    if (inList) out.push('</ul>');
    s = out.join('\n');
    s = s.replace(/\n{2,}/g, '</p><p>');
    s = s.replace(/\n/g, '<br>');
    return '<p>' + s + '</p>';
  }

  /* ── Result card ─────────────────────────────────────────────── */
  function _cardHtml(r) {
    var icons = {
      product:'🛍️', service:'🔧', bnb:'🏠', hotel:'🏨',
      event:'🎫', job:'💼', restaurant:'🍽️', order:'📦',
    };
    var icon  = icons[r.type] || '📦';
    var price = '';
    if (r.price) {
      price = 'KES ' + Number(r.price).toLocaleString();
      if (r.type === 'bnb' || r.type === 'hotel') price += '/night';
    }
    var statusBadge = r.status
      ? '<span class="kc-badge">' + _esc(r.status) + '</span>'
      : '';
    var rating = r.rating ? '★'.repeat(Math.min(5, Math.round(Number(r.rating)))) : '';
    var meta   = [r.city, r.company, rating].filter(Boolean).join(' · ');
    var url    = _esc(r.url || 'index.html');
    return [
      '<div class="kc-card" role="button" tabindex="0"',
        ' onclick="window.location.href=\'' + url + '\'"',
        ' onkeydown="if(event.key===\'Enter\')window.location.href=\'' + url + '\'">',
        r.image
          ? '<img class="kc-card-img" src="' + _esc(r.image) + '" loading="lazy" alt="' + _esc(r.name || '') + '" onerror="this.style.display=\'none\'">'
          : '<div class="kc-card-ph">' + icon + '</div>',
        '<div class="kc-card-body">',
          '<div class="kc-card-name">' + _esc(r.name || 'Listing') + statusBadge + '</div>',
          price ? '<div class="kc-card-price">' + price + '</div>' : '',
          meta  ? '<div class="kc-card-meta">' + _esc(meta) + '</div>'  : '',
        '</div>',
      '</div>',
    ].join('');
  }

  function _isSuccessMsg(t) {
    return /\b(added|saved|booked|cancelled|confirmed|sent|created)\b/i.test(t || '');
  }

  /* ── Inject styles ───────────────────────────────────────────── */
  var _css = document.createElement('style');
  _css.textContent = [

    /* ── FAB ── */
    '#kassBtn{position:fixed;',
    'bottom:var(--sk-kass-bottom,86px);right:16px;',
    'width:52px;height:52px;border-radius:50%;',
    'background:#0f0f0f;border:2px solid #71ff00;cursor:pointer;z-index:9999;',
    'display:flex;align-items:center;justify-content:center;overflow:visible;',
    'box-shadow:0 4px 20px rgba(113,255,0,.3);transition:transform .2s,bottom .2s;}',
    '#kassBtn:hover{transform:scale(1.08);}',
    '#kassBtn:focus-visible{outline:2px solid #71ff00;outline-offset:3px;}',

    '#kassUnread{position:absolute;top:-6px;right:-6px;min-width:20px;height:20px;',
    'border-radius:10px;padding:0 5px;',
    'background:#ff4444;color:#fff;font-size:11px;font-weight:800;display:none;',
    'align-items:center;justify-content:center;z-index:10;pointer-events:none;',
    'box-shadow:0 0 0 2px #0f0f0f;line-height:1;}',

    /* ── Modal ── */
    '#kassModal{position:fixed;bottom:148px;right:12px;width:360px;max-height:560px;',
    'background:#111;border:1px solid rgba(255,255,255,.1);border-radius:18px;',
    'display:none;flex-direction:column;z-index:9998;overflow:hidden;',
    'box-shadow:0 16px 56px rgba(0,0,0,.8);',
    'transform:translateY(10px) scale(.98);opacity:0;',
    'transition:transform .22s cubic-bezier(.22,1,.36,1),opacity .22s;}',
    '#kassModal.k-open{display:flex;}',
    '#kassModal.k-vis{transform:none;opacity:1;}',

    /* ── Header ── */
    '#kassHead{padding:10px 4px 10px 14px;background:#1a1a1a;',
    'display:flex;align-items:center;gap:10px;',
    'border-bottom:1px solid rgba(255,255,255,.06);flex-shrink:0;',
    'touch-action:none;}',

    '.kh-av{width:36px;height:36px;border-radius:50%;background:#71ff00;',
    'display:flex;align-items:center;justify-content:center;font-size:18px;',
    'flex-shrink:0;user-select:none;}',

    '.kh-info{flex:1;min-width:0;}',
    '.kh-name{font-size:13px;font-weight:800;color:#fff;line-height:1.2;}',
    '.kh-status{font-size:11px;color:#71ff00;font-weight:600;',
    'display:flex;align-items:center;gap:5px;margin-top:2px;}',
    '.kh-dot{width:7px;height:7px;border-radius:50%;background:#71ff00;',
    'display:inline-block;flex-shrink:0;box-shadow:0 0 5px rgba(113,255,0,.5);}',
    '.kh-dot.offline{background:#ff4444;box-shadow:0 0 5px rgba(255,68,68,.5);}',

    /* close — 44×44 tap target */
    '#kassClose{background:none;border:none;color:rgba(255,255,255,.45);font-size:18px;',
    'cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center;',
    'min-width:44px;min-height:44px;border-radius:10px;',
    'transition:color .12s,background .12s;padding:0;}',
    '#kassClose:hover{color:#fff;background:rgba(255,255,255,.07);}',
    '#kassClose:focus-visible{outline:2px solid #71ff00;outline-offset:2px;}',

    /* ── Auth wall ── */
    '#kassAuthWall{margin:14px 14px 0;border-radius:14px;',
    'background:rgba(255,170,0,.06);border:1px solid rgba(255,170,0,.2);',
    'padding:22px 16px;text-align:center;flex-shrink:0;}',
    '#kassAuthWall.k-hidden{display:none;}',
    '.kaw-icon{font-size:30px;margin-bottom:10px;}',
    '.kaw-title{font-size:13.5px;font-weight:800;color:#fff;margin-bottom:5px;}',
    '.kaw-desc{font-size:12px;color:rgba(255,255,255,.5);line-height:1.55;margin-bottom:16px;}',
    '.kaw-btn{display:inline-flex;align-items:center;gap:6px;padding:10px 22px;',
    'background:#71ff00;color:#000;font-size:13px;font-weight:800;border-radius:24px;',
    'text-decoration:none;transition:background .12s;}',
    '.kaw-btn:hover{background:#90ff30;color:#000;}',

    /* ── Messages ── */
    '#kassMsgs{flex:1;overflow-y:auto;padding:14px;',
    'display:flex;flex-direction:column;gap:10px;',
    'overscroll-behavior:contain;scroll-behavior:smooth;}',
    '#kassMsgs::-webkit-scrollbar{width:3px;}',
    '#kassMsgs::-webkit-scrollbar-track{background:transparent;}',
    '#kassMsgs::-webkit-scrollbar-thumb{background:rgba(255,255,255,.12);border-radius:3px;}',

    /* ── Bubbles ── */
    '.km{max-width:88%;padding:11px 14px;border-radius:16px;font-size:13px;',
    'line-height:1.65;word-break:break-word;}',
    '.km a{color:#71ff00;text-decoration:underline;}',
    '.km p{margin:0}.km p+p{margin-top:6px;}',
    '.km ul{margin:6px 0 4px 16px;padding:0;}',
    '.km li{margin-bottom:2px;}',
    '.km strong{font-weight:700;}',
    '.km.bot{background:rgba(255,255,255,.07);color:rgba(255,255,255,.92);',
    'align-self:flex-start;border-radius:4px 16px 16px 16px;}',
    '.km.user{background:#71ff00;color:#000;align-self:flex-end;font-weight:600;',
    'border-radius:16px 4px 16px 16px;}',
    '.km.err{background:rgba(255,68,68,.08);color:#ff9999;',
    'border:1px solid rgba(255,68,68,.18);font-size:12.5px;align-self:flex-start;}',

    /* ── Typing indicator ── */
    '.km.typing{background:rgba(255,255,255,.04);align-self:flex-start;',
    'padding:12px 14px;display:flex;align-items:center;gap:9px;',
    'border-radius:4px 16px 16px 16px;}',
    '.k-dots{display:flex;gap:4px;align-items:center;}',
    '.k-dot{width:6px;height:6px;border-radius:50%;background:#71ff00;',
    'animation:k-bounce .9s ease-in-out infinite;}',
    '.k-dot:nth-child(2){animation-delay:.15s;}',
    '.k-dot:nth-child(3){animation-delay:.3s;}',
    '.k-tlabel{font-size:11.5px;color:rgba(255,255,255,.4);font-weight:600;}',
    '@keyframes k-bounce{0%,60%,100%{transform:translateY(0)}30%{transform:translateY(-5px)}}',

    /* ── Result cards ── */
    '.kc-results{display:flex;flex-direction:column;gap:6px;margin-top:8px;}',
    '.kc-card{display:flex;align-items:center;gap:10px;',
    'background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);',
    'border-radius:10px;padding:8px 10px;cursor:pointer;transition:background .15s;text-align:left;}',
    '.kc-card:hover,.kc-card:focus{background:rgba(255,255,255,.1);outline:none;}',
    '.kc-card-img{width:50px;height:50px;object-fit:cover;border-radius:7px;',
    'flex-shrink:0;background:#222;}',
    '.kc-card-ph{width:50px;height:50px;border-radius:7px;background:#1e1e1e;',
    'display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0;}',
    '.kc-card-body{flex:1;min-width:0;}',
    '.kc-card-name{font-size:12.5px;font-weight:700;color:#fff;',
    'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.kc-card-price{font-size:12px;color:#71ff00;font-weight:700;margin-top:2px;}',
    '.kc-card-meta{font-size:11px;color:rgba(255,255,255,.4);margin-top:2px;}',
    '.kc-badge{font-size:10px;padding:2px 6px;border-radius:10px;',
    'background:rgba(113,255,0,.12);color:#71ff00;font-weight:700;margin-left:4px;',
    'vertical-align:middle;}',

    /* ── Action chips ── */
    '.kc-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;}',
    '.kc-action{display:inline-block;padding:5px 12px;',
    'background:rgba(113,255,0,.1);border:1px solid rgba(113,255,0,.3);',
    'border-radius:20px;font-size:11.5px;color:#71ff00;cursor:pointer;',
    'font-weight:700;text-decoration:none;transition:background .15s;}',
    '.kc-action:hover{background:rgba(113,255,0,.2);color:#71ff00;}',

    /* ── Success banner ── */
    '.kc-success{display:flex;align-items:flex-start;gap:8px;',
    'background:rgba(113,255,0,.08);border:1px solid rgba(113,255,0,.25);',
    'border-radius:10px;padding:10px 12px;margin-top:4px;}',
    '.kc-success-icon{font-size:18px;flex-shrink:0;margin-top:1px;}',
    '.kc-success-body{flex:1;min-width:0;font-size:12.5px;color:rgba(255,255,255,.9);}',

    /* ── Suggestion chips ── */
    '#kassChips{padding:0 12px 10px;display:flex;flex-wrap:wrap;gap:6px;flex-shrink:0;}',
    '.kchip{padding:5px 12px;background:rgba(113,255,0,.07);',
    'border:1px solid rgba(113,255,0,.2);border-radius:20px;font-size:11.5px;',
    'color:#71ff00;cursor:pointer;font-weight:600;user-select:none;',
    'transition:background .12s;}',
    '.kchip:hover{background:rgba(113,255,0,.16);}',

    /* ── Composer ── */
    '#kassInput{display:flex;gap:8px;padding:10px 12px;',
    'border-top:1px solid rgba(255,255,255,.06);flex-shrink:0;align-items:flex-end;',
    'padding-bottom:calc(10px + env(safe-area-inset-bottom,0px));}',

    '#kassField{flex:1;background:rgba(255,255,255,.05);',
    'border:1px solid rgba(255,255,255,.1);border-radius:16px;',
    'padding:10px 14px;color:#fff;font-size:16px;',
    'outline:none;font-family:inherit;line-height:1.45;resize:none;',
    'min-height:44px;max-height:120px;overflow-y:auto;',
    'transition:border-color .15s,background .15s;box-sizing:border-box;}',
    '#kassField::placeholder{color:rgba(255,255,255,.3);}',
    '#kassField:focus{border-color:rgba(113,255,0,.45);background:rgba(113,255,0,.02);}',
    '#kassField:disabled{opacity:.35;cursor:not-allowed;}',

    '#kassSend{width:44px;height:44px;min-width:44px;border-radius:50%;',
    'background:#71ff00;border:none;cursor:pointer;',
    'display:flex;align-items:center;justify-content:center;flex-shrink:0;',
    'transition:background .12s,opacity .12s;}',
    '#kassSend:hover:not(:disabled){background:#90ff30;}',
    '#kassSend:disabled{opacity:.35;cursor:default;}',
    '#kassSend.k-sending{animation:k-spin .7s linear infinite;}',
    '@keyframes k-spin{to{transform:rotate(360deg)}}',

    /* ── Mobile ── */
    '@media(max-width:540px){',
    '#kassModal{width:calc(100vw - 16px);right:8px;',
    'bottom:calc(var(--sk-kass-bottom,86px) + 62px);max-height:70vh;border-radius:18px;}}',
    '@media(max-width:380px){',
    '#kassModal{width:calc(100vw - 12px);right:6px;max-height:75vh;}}',

  ].join('');
  document.head.appendChild(_css);

  /* ── Build DOM ───────────────────────────────────────────────── */
  var _btn = document.createElement('button');
  _btn.id = 'kassBtn';
  _btn.setAttribute('aria-label', 'Ask KASS AI assistant');
  _btn.setAttribute('aria-haspopup', 'dialog');
  _btn.innerHTML = [
    '<div id="kassUnread" aria-hidden="true"></div>',
    '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#71ff00"',
    ' stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">',
    '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    '</svg>',
  ].join('');

  var _signInHref = 'login.html?redirect=' + encodeURIComponent(location.href);

  var _modal = document.createElement('div');
  _modal.id   = 'kassModal';
  _modal.setAttribute('role', 'dialog');
  _modal.setAttribute('aria-modal', 'true');
  _modal.setAttribute('aria-label', 'KASS — SOKONI AI Concierge');
  _modal.innerHTML = [
    /* Header */
    '<div id="kassHead" aria-hidden="true">',
    '  <div class="kh-av" role="img" aria-label="KASS avatar">🤖</div>',
    '  <div class="kh-info">',
    '    <div class="kh-name">KASS — SOKONI AI</div>',
    '    <div class="kh-status" aria-live="polite">',
    '      <span class="kh-dot" id="kassStatusDot" aria-hidden="true"></span>',
    '      <span id="kassStatusTxt">Online</span>',
    '    </div>',
    '  </div>',
    '  <button id="kassClose" aria-label="Close KASS chat">&#x2715;</button>',
    '</div>',

    /* Messages */
    '<div id="kassMsgs" role="log" aria-label="Conversation with KASS" aria-live="polite" aria-atomic="false">',
    /* Auth wall — shown to guests, hidden when authed */
    '  <div id="kassAuthWall" role="status" aria-live="polite">',
    '    <div class="kaw-icon" aria-hidden="true">✨</div>',
    '    <div class="kaw-title">Sign in to chat with KASS</div>',
    '    <div class="kaw-desc">KASS is your personal SOKONI AI agent — book stays, track orders, search the marketplace and more.</div>',
    '    <a class="kaw-btn" href="' + _signInHref + '">Sign in to continue →</a>',
    '  </div>',
    '</div>',

    /* Suggestion chips */
    '<div id="kassChips" aria-label="Suggested questions">',
    '  <span class="kchip" role="button" tabindex="0" data-q="I want a BnB in Nairobi">Find a BnB</span>',
    '  <span class="kchip" role="button" tabindex="0" data-q="Track my latest order">Track order</span>',
    '  <span class="kchip" role="button" tabindex="0" data-q="Show me restaurants near Westlands">Restaurants</span>',
    '  <span class="kchip" role="button" tabindex="0" data-q="What\'s in my cart?">View cart</span>',
    '</div>',

    /* Composer */
    '<div id="kassInput" role="form" aria-label="Send a message">',
    '  <textarea id="kassField"',
    '    placeholder="Sign in to chat with KASS"',
    '    maxlength="300" rows="1" autocomplete="off" spellcheck="true"',
    '    enterkeyhint="send" inputmode="text"',
    '    aria-label="Message input" aria-multiline="true"></textarea>',
    '  <button id="kassSend" aria-label="Send message" disabled>',
    + _SEND_SVG +
    '  </button>',
    '</div>',
  ].join('');

  document.body.appendChild(_btn);
  document.body.appendChild(_modal);

  /* ── DOM refs ────────────────────────────────────────────────── */
  var _msgs      = document.getElementById('kassMsgs');
  var _field     = document.getElementById('kassField');
  var _sendBtn   = document.getElementById('kassSend');
  var _chips     = document.getElementById('kassChips');
  var _statusDot = document.getElementById('kassStatusDot');
  var _statusTxt = document.getElementById('kassStatusTxt');
  var _unread    = document.getElementById('kassUnread');
  var _authWall  = document.getElementById('kassAuthWall');
  var _kassHead  = document.getElementById('kassHead');

  /* ── Connectivity indicator ─────────────────────────────────── */
  function _updateStatus() {
    var online = navigator.onLine !== false;
    _statusDot.className = 'kh-dot' + (online ? '' : ' offline');
    _statusTxt.textContent = online ? 'Online' : 'Offline';
  }
  window.addEventListener('online',  _updateStatus);
  window.addEventListener('offline', _updateStatus);
  _updateStatus();

  /* ── Message helpers ─────────────────────────────────────────── */
  function _scroll() {
    /* Smooth-scroll to newest message */
    _msgs.scrollTo({ top: _msgs.scrollHeight, behavior: 'smooth' });
  }

  function _addBot(html) {
    var el = document.createElement('div');
    el.className = 'km bot';
    el.innerHTML = html;
    _msgs.appendChild(el);
    _scroll();
    return el;
  }

  function _addUser(text) {
    var el = document.createElement('div');
    el.className = 'km user';
    el.textContent = text;
    _msgs.appendChild(el);
    _scroll();
  }

  function _addErr(msg) {
    var el = document.createElement('div');
    el.className = 'km err';
    el.setAttribute('role', 'alert');
    el.textContent = '⚠ ' + msg;
    _msgs.appendChild(el);
    _scroll();
  }

  function _showTyping() {
    var el = document.createElement('div');
    el.className = 'km typing';
    el.setAttribute('aria-label', 'KASS is thinking');
    el.innerHTML = [
      '<div class="k-dots" aria-hidden="true">',
      '  <div class="k-dot"></div>',
      '  <div class="k-dot"></div>',
      '  <div class="k-dot"></div>',
      '</div>',
      '<span class="k-tlabel">KASS is thinking…</span>',
    ].join('');
    _msgs.appendChild(el);
    _scroll();
    return el;
  }

  function _removeEl(el) { if (el && el.parentNode) el.parentNode.removeChild(el); }

  /* ── Render rich response ────────────────────────────────────── */
  function _renderResponse(data) {
    var html = '';
    var txt  = data.response || '';

    if (_isSuccessMsg(txt) && (!data.results || !data.results.length)) {
      html += '<div class="kc-success">'
            + '<div class="kc-success-icon">✅</div>'
            + '<div class="kc-success-body">' + _md(txt) + '</div>'
            + '</div>';
    } else if (txt) {
      html += _md(txt);
    }

    if (data.results && data.results.length) {
      html += '<div class="kc-results">';
      for (var i = 0; i < Math.min(data.results.length, 5); i++) {
        html += _cardHtml(data.results[i]);
      }
      html += '</div>';
    }

    if (data.actions && data.actions.length) {
      html += '<div class="kc-actions">';
      for (var j = 0; j < data.actions.length; j++) {
        html += '<a class="kc-action" href="' + _esc(data.actions[j].url || '#') + '">'
              + _esc(data.actions[j].label) + '</a>';
      }
      html += '</div>';
    }

    _addBot(html || _md("I'm here to help. What would you like to do on SOKONI?"));
  }

  /* ── API call ────────────────────────────────────────────────── */
  function _callKass(text) {
    _history.push({ role: 'user', content: text });
    return _getAuthToken().then(function (token) {
      var ctrl = new AbortController();
      var tid  = setTimeout(function () { ctrl.abort(); }, 35000);
      var body = { messages: _history.slice(-20) };
      if (token) body.auth_token = token;
      return fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      }).then(function (resp) {
        clearTimeout(tid);
        return resp.json().then(function (data) {
          if (!resp.ok) throw new Error(data.error || 'KASS is temporarily unavailable.');
          _history.push({ role: 'assistant', content: data.response || '' });
          return data;
        });
      }).catch(function (err) {
        clearTimeout(tid);
        _history.pop();
        if (err.name === 'AbortError') throw new Error('Request timed out — please try again.');
        throw err;
      });
    });
  }

  /* ── Send ────────────────────────────────────────────────────── */
  function _setSending(on) {
    if (on) {
      _sendBtn.classList.add('k-sending');
      _sendBtn.innerHTML = _SPIN_SVG;
      _sendBtn.disabled  = true;
      _sendBtn.setAttribute('aria-label', 'Sending…');
    } else {
      _sendBtn.classList.remove('k-sending');
      _sendBtn.innerHTML = _SEND_SVG;
      _sendBtn.disabled  = !_field.value.trim() || _authState !== 'authed';
      _sendBtn.setAttribute('aria-label', 'Send message');
    }
  }

  function _send(text) {
    text = (text || '').trim();
    if (!text || _busy || _authState !== 'authed') return;
    _busy = true;
    _field.value = '';
    _autoResize();
    _setSending(true);
    _chips.style.display = 'none';
    _addUser(text);
    var typing = _showTyping();

    _callKass(text)
      .then(function (data) {
        _removeEl(typing);
        _renderResponse(data);
      })
      .catch(function (err) {
        _removeEl(typing);
        _addErr(err.message || 'KASS is temporarily unavailable. Please try again.');
      })
      .then(function () {
        _busy = false;
        _setSending(false);
        setTimeout(function () { if (_isOpen()) _field.focus(); }, 50);
      });

    try { if (window.sokoniTrackEngagement) window.sokoniTrackEngagement('kass_query', 1); } catch (_) {}
    try { if (window.gtag) window.gtag('event', 'kass_query', { query_length: text.length }); } catch (_) {}
  }

  /* ── Textarea auto-resize ────────────────────────────────────── */
  function _autoResize() {
    _field.style.height = 'auto';
    _field.style.height = Math.min(_field.scrollHeight, 120) + 'px';
  }

  /* ── Greeting ────────────────────────────────────────────────── */
  function _showGreeting() {
    if (_greeted) return;
    _greeted = true;
    var name = '';
    try {
      name = (JSON.parse(localStorage.getItem('sokoniUser') || '{}')).name || '';
      /* Also try from Firebase auth */
      var auth = _getAuthInstance();
      if (!name && auth && auth.currentUser && auth.currentUser.displayName) {
        name = auth.currentUser.displayName;
      }
    } catch (_) {}
    var first  = name ? name.split(' ')[0] : '';
    var greet  = first ? 'Hey **' + first + '**!' : 'Hey there!';
    _addBot(_md(
      greet + " I'm **KASS**, your SOKONI AI agent.\n\n"
      + "I can search the marketplace, **book stays**, **track orders**, **manage your cart**, "
      + "check your wallet — or help with anything on SOKONI. What would you like to do?"
    ));
  }

  /* ── Keyboard handler (visual viewport — fixes iOS keyboard cover) */
  function _handleViewport() {
    var vv = window.visualViewport;
    if (!vv || !_isOpen()) return;
    var keyH = window.innerHeight - vv.height - (vv.offsetTop || 0);
    if (keyH > 80) {
      /* Keyboard showing: lift modal above it */
      _modal.style.bottom    = (keyH + 8) + 'px';
      _modal.style.maxHeight = (vv.height - 72) + 'px';
    } else {
      /* Keyboard gone: restore default (CSS takes over) */
      _modal.style.bottom    = '';
      _modal.style.maxHeight = '';
    }
  }

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', _handleViewport, { passive: true });
    window.visualViewport.addEventListener('scroll', _handleViewport, { passive: true });
  }

  /* ── Focus trap ─────────────────────────────────────────────── */
  function _getFocusable() {
    return Array.from(_modal.querySelectorAll(
      'button:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])'
    )).filter(function (el) { return el.offsetParent !== null; });
  }

  /* ── Open / close ────────────────────────────────────────────── */
  function _isOpen() {
    return _modal.classList.contains('k-open');
  }

  function _open() {
    if (_isOpen()) return;
    _prevFocus = document.activeElement;
    _modal.classList.add('k-open');
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { _modal.classList.add('k-vis'); });
    });

    /* Auth-reactive: hide chips if guest */
    if (_authState !== 'authed') {
      _chips.style.display = 'none';
    }

    /* Unread badge off */
    _unread.style.display = 'none';

    /* Greeting fires only for authed users on first open */
    if (_authState === 'authed' && !_greeted) _showGreeting();

    /* Push history state for browser-back support */
    try {
      history.pushState({ kassOpen: true }, '');
      _histPushed = true;
    } catch (_) {}

    setTimeout(function () {
      if (_authState === 'authed') _field.focus();
      else {
        var focusable = _getFocusable();
        if (focusable.length) focusable[0].focus();
      }
    }, 240);
  }

  function _doClose() {
    if (!_isOpen()) return;
    _modal.classList.remove('k-vis');
    setTimeout(function () { _modal.classList.remove('k-open'); }, 220);
    /* Restore keyboard-adjustment */
    _modal.style.bottom    = '';
    _modal.style.maxHeight = '';
    /* Return focus to FAB */
    try { (_prevFocus || _btn).focus(); } catch (_) {}
  }

  function _close() {
    _doClose();
    if (_histPushed) {
      _histPushed        = false;
      _closingViaHistory = true;
      try { history.back(); } catch (_) {}
    }
  }

  /* ── Event wiring ────────────────────────────────────────────── */

  /* FAB toggle */
  _btn.addEventListener('click', function () {
    _isOpen() ? _close() : _open();
  });

  /* Close button */
  document.getElementById('kassClose').addEventListener('click', _close);

  /* Backdrop click (outside modal) */
  document.addEventListener('click', function (e) {
    if (_isOpen() && !_modal.contains(e.target) && !_btn.contains(e.target)) {
      _close();
    }
  });

  /* Keyboard: ESC + focus-trap */
  document.addEventListener('keydown', function (e) {
    if (!_isOpen()) return;
    if (e.key === 'Escape') { e.preventDefault(); _close(); return; }
    if (e.key === 'Tab') {
      var focusable = _getFocusable();
      if (!focusable.length) return;
      var first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      }
    }
  });

  /* Browser back button */
  window.addEventListener('popstate', function () {
    if (_closingViaHistory) { _closingViaHistory = false; return; }
    if (_isOpen()) { _histPushed = false; _doClose(); }
  });

  /* Swipe-down to close (header touch only — avoids conflict with message scroll) */
  _kassHead.addEventListener('touchstart', function (e) {
    _swipeStartY = e.touches[0].clientY;
  }, { passive: true });
  _kassHead.addEventListener('touchend', function (e) {
    if (e.changedTouches[0].clientY - _swipeStartY > 60) _close();
  }, { passive: true });

  /* Textarea — auto-grow + send-button gating */
  _field.addEventListener('input', function () {
    _autoResize();
    _sendBtn.disabled = !this.value.trim() || _authState !== 'authed';
  });

  /* Enter sends (Shift+Enter = new line) */
  _field.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _send(_field.value); }
  });

  /* Send button */
  _sendBtn.addEventListener('click', function () { _send(_field.value); });

  /* Suggestion chips — keyboard + click */
  _chips.addEventListener('click', function (e) {
    var chip = e.target.closest('.kchip');
    if (chip) _send(chip.dataset.q);
  });
  _chips.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') {
      var chip = e.target.closest('.kchip');
      if (chip) { e.preventDefault(); _send(chip.dataset.q); }
    }
  });

  /* ── Unread badge (3 s after load, if not greeted) ───────────── */
  setTimeout(function () {
    if (!_isOpen() && !_greeted) {
      _unread.textContent    = '1';
      _unread.style.display  = 'flex';
    }
  }, 3000);

  /* ── Auth init — run after all DOM wiring is done ─────────────── */
  /* Small delay to let firebase.js finish exposing window.firebaseAuth */
  setTimeout(_initAuth, 200);

})();
