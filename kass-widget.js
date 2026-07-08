/* ================================================================
   KASS — Sokoni AI Concierge Widget  v2.0
   Intelligent marketplace assistant with Firestore search,
   rich result cards, action chips, and conversation memory.
   Usage: <script defer src="kass-widget.js"></script>
================================================================ */
(function () {
  'use strict';
  if (document.getElementById('kassBtn')) return;

  var ENDPOINT = '/api/chat'; /* Firebase Hosting rewrite → sokoniChat CF */

  /* ── Conversation history (per session, in-memory) ── */
  var _history = [];
  var _greeted = false;
  var _busy    = false;

  /* ── Get Firebase ID token (optional — enables action tools) ── */
  function _getAuthToken() {
    return new Promise(function(resolve) {
      try {
        var auth = (typeof firebase !== 'undefined' && firebase.auth) ? firebase.auth() : null;
        if (!auth) { resolve(null); return; }
        var user = auth.currentUser;
        if (!user) { resolve(null); return; }
        user.getIdToken(false).then(resolve).catch(function() { resolve(null); });
      } catch(e) { resolve(null); }
    });
  }

  /* ── Escape HTML ── */
  function _esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  /* ── Markdown → safe HTML ── */
  function _md(text) {
    var s = _esc(String(text || ''));
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*\n]+?)\*/g, '<em>$1</em>');
    s = s.replace(/\[([^\]]{1,80})\]\(([^)]{1,200})\)/g,
      '<a href="$2" style="color:#71ff00;text-decoration:underline">$1</a>');

    /* bullet lists */
    var lines = s.split('\n'), out = [], inList = false;
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (/^[-•] /.test(l)) {
        if (!inList) { out.push('<ul style="margin:6px 0 4px 16px;padding:0">'); inList = true; }
        out.push('<li>' + l.replace(/^[-•] /, '') + '</li>');
      } else {
        if (inList) { out.push('</ul>'); inList = false; }
        out.push(l);
      }
    }
    if (inList) out.push('</ul>');
    s = out.join('\n');

    s = s.replace(/\n{2,}/g, '</p><p style="margin:6px 0 0">');
    s = s.replace(/\n/g, '<br>');
    return '<p style="margin:0">' + s + '</p>';
  }

  /* ── Result card HTML ── */
  function _cardHtml(r) {
    var icons = { product:'🛍️', service:'🔧', bnb:'🏠', hotel:'🏨', event:'🎫', job:'💼', restaurant:'🍽️', order:'📦' };
    var icon  = icons[r.type] || '📦';
    var price = '';
    if (r.price) {
      price = 'KES ' + Number(r.price).toLocaleString();
      if (r.type === 'bnb' || r.type === 'hotel') price += '/night';
    }
    var statusBadge = r.status
      ? '<span style="font-size:10px;padding:2px 6px;border-radius:10px;background:rgba(113,255,0,0.12);color:#71ff00;font-weight:700;margin-left:4px;">' + _esc(r.status) + '</span>'
      : '';
    var rating = r.rating ? '★'.repeat(Math.min(5, Math.round(Number(r.rating)))) : '';
    var meta   = [r.city, r.company, rating].filter(Boolean).join(' · ');
    var url    = _esc(r.url || 'index.html');
    var kp = 'if(event.key===\'Enter\')window.location.href=\'' + url + '\'';
    return [
      '<div class="kc-card" role="button" tabindex="0"',
        ' onclick="window.location.href=\'' + url + '\'"',
        ' onkeydown="' + kp + '">',
        r.image
          ? '<img class="kc-card-img" src="' + _esc(r.image) + '" loading="lazy" alt="' + _esc(r.name||'') + '" onerror="this.style.display=\'none\'">'
          : '<div class="kc-card-ph">' + icon + '</div>',
        '<div class="kc-card-body">',
          '<div class="kc-card-name">' + _esc(r.name || 'Listing') + statusBadge + '</div>',
          price ? '<div class="kc-card-price">' + price + '</div>' : '',
          meta  ? '<div class="kc-card-meta">' + _esc(meta) + '</div>' : '',
        '</div>',
      '</div>',
    ].join('');
  }

  /* ── Detect if a response text indicates a successful action ── */
  function _isSuccessMsg(text) {
    return /\b(added|saved|booked|cancelled|confirmed|sent|created)\b/i.test(text || '');
  }

  /* ── Inject styles ── */
  var _styleEl = document.createElement('style');
  _styleEl.textContent = [
    /* FAB */
    '#kassBtn{position:fixed;bottom:80px;right:16px;width:52px;height:52px;border-radius:50%;',
    'background:#0f0f0f;border:2px solid #71ff00;cursor:pointer;z-index:9999;',
    'display:flex;align-items:center;justify-content:center;overflow:visible;',
    'box-shadow:0 4px 20px rgba(113,255,0,0.3);transition:transform .2s;}',
    '#kassBtn:hover{transform:scale(1.08);}',
    '#kassUnread{position:absolute;top:-6px;right:-6px;min-width:20px;height:20px;',
    'border-radius:10px;padding:0 5px;',
    'background:#ff4444;color:#fff;font-size:11px;font-weight:800;display:none;',
    'align-items:center;justify-content:center;z-index:10;pointer-events:none;',
    'box-shadow:0 0 0 2px #0f0f0f;line-height:1;}',
    /* Modal */
    '#kassModal{position:fixed;bottom:148px;right:12px;width:360px;max-height:560px;',
    'background:#111;border:1px solid rgba(255,255,255,0.1);border-radius:18px;',
    'display:none;flex-direction:column;z-index:9998;',
    'box-shadow:0 12px 48px rgba(0,0,0,0.75);overflow:hidden;}',
    '#kassModal.open{display:flex;}',
    /* Header */
    '#kassHead{padding:14px 16px;background:#1a1a1a;display:flex;align-items:center;gap:10px;',
    'border-bottom:1px solid rgba(255,255,255,0.06);flex-shrink:0;}',
    '.kh-av{width:34px;height:34px;border-radius:50%;background:#71ff00;',
    'display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;}',
    '.kh-info{flex:1;min-width:0;}',
    '.kh-name{font-size:13px;font-weight:800;color:#fff;}',
    '.kh-status{font-size:11px;color:#71ff00;font-weight:600;display:flex;align-items:center;gap:5px;}',
    '.kh-dot{width:7px;height:7px;border-radius:50%;background:#71ff00;display:inline-block;flex-shrink:0;}',
    '.kh-dot.offline{background:#ff4444;}',
    '#kassClose{background:none;border:none;color:rgba(255,255,255,0.4);font-size:22px;',
    'cursor:pointer;padding:2px 4px;line-height:1;flex-shrink:0;}',
    '#kassClose:hover{color:#fff;}',
    /* Messages */
    '#kassMsgs{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;',
    'gap:8px;overscroll-behavior:contain;scroll-behavior:smooth;}',
    '.km{max-width:90%;padding:9px 12px;border-radius:14px;font-size:13px;',
    'line-height:1.55;word-break:break-word;}',
    '.km a{color:#71ff00;text-decoration:underline;}',
    '.km.bot{background:rgba(255,255,255,0.07);color:rgba(255,255,255,0.88);',
    'align-self:flex-start;border-radius:4px 14px 14px 14px;}',
    '.km.user{background:#71ff00;color:#000;align-self:flex-end;font-weight:600;',
    'border-radius:14px 4px 14px 14px;}',
    '.km.typing{background:rgba(255,255,255,0.04);color:rgba(255,255,255,0.5);',
    'font-size:18px;letter-spacing:3px;align-self:flex-start;padding:6px 14px;}',
    '.km.err{background:rgba(255,68,68,0.1);color:#ff9999;border:1px solid rgba(255,68,68,0.2);',
    'font-size:12.5px;align-self:flex-start;}',
    /* Cards */
    '.kc-results{display:flex;flex-direction:column;gap:6px;margin-top:8px;}',
    '.kc-card{display:flex;align-items:center;gap:10px;background:rgba(255,255,255,0.05);',
    'border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:8px 10px;',
    'cursor:pointer;transition:background .15s;text-align:left;}',
    '.kc-card:hover,.kc-card:focus{background:rgba(255,255,255,0.1);outline:none;}',
    '.kc-card-img{width:50px;height:50px;object-fit:cover;border-radius:7px;',
    'flex-shrink:0;background:#222;}',
    '.kc-card-ph{width:50px;height:50px;border-radius:7px;background:#1e1e1e;',
    'display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0;}',
    '.kc-card-body{flex:1;min-width:0;}',
    '.kc-card-name{font-size:12.5px;font-weight:700;color:#fff;',
    'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.kc-card-price{font-size:12px;color:#71ff00;font-weight:700;margin-top:2px;}',
    '.kc-card-meta{font-size:11px;color:rgba(255,255,255,0.4);margin-top:2px;}',
    /* Action chips (from server) */
    '.kc-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;}',
    '.kc-action{display:inline-block;padding:5px 12px;',
    'background:rgba(113,255,0,0.1);border:1px solid rgba(113,255,0,0.3);',
    'border-radius:20px;font-size:11.5px;color:#71ff00;cursor:pointer;',
    'font-weight:700;text-decoration:none;transition:background .15s;}',
    '.kc-action:hover{background:rgba(113,255,0,0.2);color:#71ff00;}',
    /* Action success banner */
    '.kc-success{display:flex;align-items:flex-start;gap:8px;background:rgba(113,255,0,0.08);',
    'border:1px solid rgba(113,255,0,0.25);border-radius:10px;padding:10px 12px;margin-top:8px;}',
    '.kc-success-icon{font-size:18px;flex-shrink:0;margin-top:1px;}',
    '.kc-success-body{flex:1;min-width:0;font-size:12.5px;color:rgba(255,255,255,0.88);}',
    /* Login prompt */
    '.kc-login{background:rgba(255,170,0,0.08);border:1px solid rgba(255,170,0,0.25);',
    'border-radius:10px;padding:10px 12px;margin-top:8px;font-size:12.5px;',
    'color:rgba(255,255,255,0.7);}',
    '.kc-login a{color:#ffaa00;text-decoration:underline;font-weight:700;}',
    /* Suggestion chips */
    '#kassChips{padding:4px 12px 10px;display:flex;flex-wrap:wrap;gap:6px;flex-shrink:0;}',
    '.kchip{padding:5px 11px;background:rgba(113,255,0,0.07);',
    'border:1px solid rgba(113,255,0,0.2);border-radius:20px;font-size:11.5px;',
    'color:#71ff00;cursor:pointer;font-weight:600;user-select:none;}',
    '.kchip:hover{background:rgba(113,255,0,0.16);}',
    /* Input row */
    '#kassInput{display:flex;gap:8px;padding:10px 12px;',
    'border-top:1px solid rgba(255,255,255,0.06);flex-shrink:0;}',
    '#kassField{flex:1;background:rgba(255,255,255,0.05);',
    'border:1px solid rgba(255,255,255,0.1);border-radius:20px;',
    'padding:9px 14px;color:#fff;font-size:13px;outline:none;font-family:inherit;}',
    '#kassField::placeholder{color:rgba(255,255,255,0.3);}',
    '#kassField:focus{border-color:rgba(113,255,0,0.5);}',
    '#kassSend{width:38px;height:38px;border-radius:50%;background:#71ff00;',
    'border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;',
    'flex-shrink:0;align-self:flex-end;}',
    '#kassSend:hover{background:#90ff30;}',
    '#kassSend:disabled{opacity:0.35;cursor:default;}',
    '@keyframes kass-blink{0%,100%{opacity:.2}50%{opacity:1}}',
    '@media(max-width:400px){#kassModal{width:calc(100vw - 24px);right:12px;bottom:80px;max-height:72vh;}}',
  ].join('');
  document.head.appendChild(_styleEl);

  /* ── Build DOM ── */
  var _btn = document.createElement('button');
  _btn.id = 'kassBtn';
  _btn.setAttribute('aria-label', 'Ask KASS AI assistant');
  _btn.innerHTML = [
    '<div id="kassUnread" aria-hidden="true"></div>',
    '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#71ff00"',
      ' stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">',
      '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    '</svg>',
  ].join('');

  var _modal = document.createElement('div');
  _modal.id = 'kassModal';
  _modal.setAttribute('role', 'dialog');
  _modal.setAttribute('aria-label', 'KASS — Sokoni AI Concierge');
  _modal.innerHTML = [
    '<div id="kassHead">',
    '  <div class="kh-av">🤖</div>',
    '  <div class="kh-info">',
    '    <div class="kh-name">KASS — Sokoni AI</div>',
    '    <div class="kh-status">',
    '      <span class="kh-dot" id="kassStatusDot"></span>',
    '      <span id="kassStatusTxt">Online</span>',
    '    </div>',
    '  </div>',
    '  <button id="kassClose" aria-label="Close">&times;</button>',
    '</div>',
    '<div id="kassMsgs" role="log" aria-live="polite" aria-atomic="false"></div>',
    '<div id="kassChips">',
    '  <span class="kchip" data-q="I want a BnB in Nairobi">Find a BnB</span>',
    '  <span class="kchip" data-q="Track my latest order">Track order</span>',
    '  <span class="kchip" data-q="Show me restaurants near Westlands">Restaurants</span>',
    '  <span class="kchip" data-q="What\'s in my cart?">View cart</span>',
    '</div>',
    '<div id="kassInput">',
    '  <input type="text" id="kassField"',
    '    placeholder="Ask KASS anything…"',
    '    maxlength="300" autocomplete="off" spellcheck="true">',
    '  <button id="kassSend" aria-label="Send message">',
    '    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#000"',
    '      stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">',
    '      <line x1="22" y1="2" x2="11" y2="13"/>',
    '      <polygon points="22 2 15 22 11 13 2 9 22 2"/>',
    '    </svg>',
    '  </button>',
    '</div>',
  ].join('');

  document.body.appendChild(_btn);
  document.body.appendChild(_modal);

  /* ── DOM refs ── */
  var _msgs      = document.getElementById('kassMsgs');
  var _field     = document.getElementById('kassField');
  var _sendBtn   = document.getElementById('kassSend');
  var _chips     = document.getElementById('kassChips');
  var _statusDot = document.getElementById('kassStatusDot');
  var _statusTxt = document.getElementById('kassStatusTxt');
  var _unread    = document.getElementById('kassUnread');

  /* ── Connectivity status ── */
  function _updateStatus() {
    var online = navigator.onLine !== false;
    _statusDot.className = 'kh-dot' + (online ? '' : ' offline');
    _statusTxt.textContent = online ? 'Online' : 'Offline';
  }
  window.addEventListener('online',  _updateStatus);
  window.addEventListener('offline', _updateStatus);
  _updateStatus();

  /* ── Message helpers ── */
  function _addBot(html) {
    var el = document.createElement('div');
    el.className = 'km bot';
    el.innerHTML = html;
    _msgs.appendChild(el);
    _msgs.scrollTop = _msgs.scrollHeight;
    return el;
  }

  function _addUser(text) {
    var el = document.createElement('div');
    el.className = 'km user';
    el.textContent = text;
    _msgs.appendChild(el);
    _msgs.scrollTop = _msgs.scrollHeight;
  }

  function _addErr(msg) {
    var el = document.createElement('div');
    el.className = 'km err';
    el.textContent = msg;
    _msgs.appendChild(el);
    _msgs.scrollTop = _msgs.scrollHeight;
  }

  function _showTyping() {
    var el = document.createElement('div');
    el.className = 'km typing';
    el.innerHTML = '<span style="animation:kass-blink 1.2s infinite">●</span>'
      + '<span style="animation:kass-blink 1.2s infinite .4s">●</span>'
      + '<span style="animation:kass-blink 1.2s infinite .8s">●</span>';
    _msgs.appendChild(el);
    _msgs.scrollTop = _msgs.scrollHeight;
    return el;
  }

  function _removeEl(el) { if (el && el.parentNode) el.parentNode.removeChild(el); }

  /* ── Render rich response ── */
  function _renderResponse(data) {
    var html = '';
    var responseText = data.response || '';

    /* Detect successful action and wrap in a success card */
    if (_isSuccessMsg(responseText) && (!data.results || !data.results.length)) {
      html += '<div class="kc-success"><div class="kc-success-icon">✅</div><div class="kc-success-body">' + _md(responseText) + '</div></div>';
    } else if (responseText) {
      html += _md(responseText);
    }

    /* Result cards (products, stays, events, orders, etc.) */
    if (data.results && data.results.length) {
      html += '<div class="kc-results">';
      for (var i = 0; i < Math.min(data.results.length, 5); i++) html += _cardHtml(data.results[i]);
      html += '</div>';
    }

    /* Action chips */
    if (data.actions && data.actions.length) {
      html += '<div class="kc-actions">';
      for (var j = 0; j < data.actions.length; j++) {
        html += '<a class="kc-action" href="' + _esc(data.actions[j].url || '#') + '">'
              + _esc(data.actions[j].label) + '</a>';
      }
      html += '</div>';
    }

    _addBot(html || _md("I'm here to help! What are you looking for on Sokoni?"));
  }

  /* ── API call (sends auth token if available) ── */
  function _callKass(text) {
    _history.push({ role: 'user', content: text });
    return _getAuthToken().then(function(token) {
      var controller = new AbortController();
      var timeoutId  = setTimeout(function() { controller.abort(); }, 35000);
      var body = { messages: _history.slice(-20) };
      if (token) body.auth_token = token;
      return fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      }).then(function(resp) {
        clearTimeout(timeoutId);
        return resp.json().then(function(data) {
          if (!resp.ok) throw new Error(data.error || 'KASS is temporarily unavailable.');
          _history.push({ role: 'assistant', content: data.response || '' });
          return data;
        });
      }).catch(function(err) {
        clearTimeout(timeoutId);
        _history.pop(); /* remove failed user message so retry is clean */
        if (err.name === 'AbortError') throw new Error('Request timed out — please try again.');
        throw err;
      });
    });
  }

  /* ── Send message ── */
  function _send(text) {
    text = (text || '').trim();
    if (!text || _busy) return;
    _busy = true;
    _field.value = '';
    _sendBtn.disabled = true;
    _chips.style.display = 'none';
    _addUser(text);
    var typing = _showTyping();

    _callKass(text).then(function(data) {
      _removeEl(typing);
      _renderResponse(data);
    }).catch(function(err) {
      _removeEl(typing);
      _addErr(err.message || 'KASS is temporarily unavailable. Please try again in a moment.');
    }).then(function() {
      /* always runs (finally polyfill via chained then) */
      _busy = false;
      _sendBtn.disabled = false;
      setTimeout(function() { _field.focus(); }, 50);
    });

    try { if (window.sokoniTrackEngagement) window.sokoniTrackEngagement('kass_query', 1); } catch(e) {}
    try { if (window.gtag) window.gtag('event', 'kass_query', { query_length: text.length }); } catch(e) {}
  }

  /* ── Open / close ── */
  function _open() {
    _modal.classList.add('open');
    _unread.style.display = 'none';
    if (!_greeted) {
      _greeted = true;
      var name = '';
      try { name = (JSON.parse(localStorage.getItem('sokoniUser') || '{}')).name || ''; } catch(e) {}
      var greet = name ? 'Hey **' + name.split(' ')[0] + '**!' : 'Hey there!';
      _addBot(_md(greet + " I'm **KASS**, your Sokoni AI agent.\n\nI can search the marketplace, **book stays**, **track orders**, **manage your cart**, check your wallet — or help with anything on SOKONI. What would you like to do?"));
    }
    setTimeout(function() { _field.focus(); }, 60);
  }

  function _close() { _modal.classList.remove('open'); }

  _btn.addEventListener('click', function() {
    _modal.classList.contains('open') ? _close() : _open();
  });

  document.getElementById('kassClose').addEventListener('click', _close);

  document.addEventListener('click', function(e) {
    if (_modal.classList.contains('open')
        && !_modal.contains(e.target)
        && !_btn.contains(e.target)) {
      _close();
    }
  });

  /* ── Input handlers ── */
  _sendBtn.addEventListener('click', function() { _send(_field.value); });
  _field.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _send(_field.value); }
  });
  _chips.addEventListener('click', function(e) {
    var chip = e.target.closest('.kchip');
    if (chip) _send(chip.dataset.q);
  });

  /* ── Show unread badge 3 s after load ── */
  setTimeout(function() {
    if (!_modal.classList.contains('open') && !_greeted) {
      _unread.textContent = '1';
      _unread.style.display = 'flex';
    }
  }, 3000);

})();
