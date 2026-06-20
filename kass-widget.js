/* ================================================================
   KASS — Sokoni AI Assistant Widget  v1.0
   Cross-platform floating chat widget.
   Inject on any page: <script defer src="kass-widget.js"></script>
   Calls Firebase Function 'kass' (HTTPS callable) when online;
   falls back to rule-based answers offline.
================================================================ */
(function () {
  'use strict';

  /* ── Don't double-mount ── */
  if (document.getElementById('kassWidget')) return;

  /* ── Inject styles ── */
  var style = document.createElement('style');
  style.textContent = [
    '#kassBtn{position:fixed;bottom:80px;right:16px;width:52px;height:52px;border-radius:50%;',
    'background:#71ff00;border:none;cursor:pointer;z-index:9999;',
    'display:flex;align-items:center;justify-content:center;',
    'box-shadow:0 4px 20px rgba(113,255,0,0.4);transition:transform 0.2s;}',
    '#kassBtn:hover{transform:scale(1.08);}',
    '#kassBtn svg{width:26px;height:26px;}',
    '#kassModal{position:fixed;bottom:148px;right:12px;width:320px;max-height:480px;',
    'background:#111;border:1px solid rgba(255,255,255,0.1);border-radius:18px;',
    'display:none;flex-direction:column;z-index:9998;',
    'box-shadow:0 12px 40px rgba(0,0,0,0.6);overflow:hidden;}',
    '#kassModal.open{display:flex;}',
    '#kassHead{padding:14px 16px;background:#1a1a1a;display:flex;align-items:center;gap:10px;',
    'border-bottom:1px solid rgba(255,255,255,0.06);}',
    '#kassHead .kh-avatar{width:32px;height:32px;border-radius:50%;background:#71ff00;',
    'display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;}',
    '#kassHead .kh-info{flex:1;}',
    '#kassHead .kh-name{font-size:13px;font-weight:800;color:white;}',
    '#kassHead .kh-status{font-size:10px;color:#71ff00;font-weight:600;}',
    '#kassClose{background:none;border:none;color:rgba(255,255,255,0.4);',
    'font-size:20px;cursor:pointer;padding:0;line-height:1;}',
    '#kassClose:hover{color:white;}',
    '#kassMsgs{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;}',
    '.km{max-width:85%;padding:9px 12px;border-radius:14px;font-size:12.5px;line-height:1.5;word-break:break-word;}',
    '.km.bot{background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.85);align-self:flex-start;border-radius:4px 14px 14px 14px;}',
    '.km.user{background:#71ff00;color:#000;align-self:flex-end;font-weight:600;border-radius:14px 4px 14px 14px;}',
    '.km.typing{background:rgba(255,255,255,0.04);color:rgba(255,255,255,0.4);font-style:italic;}',
    '#kassInput{display:flex;gap:8px;padding:10px 12px;border-top:1px solid rgba(255,255,255,0.06);}',
    '#kassInput input{flex:1;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);',
    'border-radius:20px;padding:9px 14px;color:white;font-size:13px;outline:none;',
    'font-family:inherit;min-height:38px;}',
    '#kassInput input::placeholder{color:rgba(255,255,255,0.3);}',
    '#kassInput input:focus{border-color:rgba(113,255,0,0.4);}',
    '#kassSend{width:36px;height:36px;border-radius:50%;background:#71ff00;',
    'border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;}',
    '#kassSend:hover{background:#90ff30;}',
    '#kassSend svg{width:16px;height:16px;}',
    '#kassChips{padding:0 12px 8px;display:flex;flex-wrap:wrap;gap:6px;}',
    '.kchip{padding:5px 10px;background:rgba(113,255,0,0.08);border:1px solid rgba(113,255,0,0.2);',
    'border-radius:20px;font-size:11px;color:#71ff00;cursor:pointer;font-weight:600;}',
    '.kchip:hover{background:rgba(113,255,0,0.16);}',
    '@media(max-width:380px){#kassModal{width:calc(100vw - 24px);right:12px;}}'
  ].join('');
  document.head.appendChild(style);

  /* ── Build DOM ── */
  var btn = document.createElement('button');
  btn.id = 'kassBtn';
  btn.setAttribute('aria-label', 'Ask KASS AI');
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

  var modal = document.createElement('div');
  modal.id = 'kassModal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-label', 'KASS AI Assistant');
  modal.innerHTML = [
    '<div id="kassHead">',
    '  <div class="kh-avatar">&#129302;</div>',
    '  <div class="kh-info">',
    '    <div class="kh-name">KASS — Sokoni AI</div>',
    '    <div class="kh-status">&#9679; Online</div>',
    '  </div>',
    '  <button id="kassClose" aria-label="Close">&times;</button>',
    '</div>',
    '<div id="kassMsgs"></div>',
    '<div id="kassChips">',
    '  <span class="kchip" data-q="How do I sell on Sokoni?">Sell on Sokoni</span>',
    '  <span class="kchip" data-q="How do I earn loyalty points?">Loyalty points</span>',
    '  <span class="kchip" data-q="How do I track my order?">Track order</span>',
    '  <span class="kchip" data-q="What is a referral code?">Referrals</span>',
    '</div>',
    '<div id="kassInput">',
    '  <input type="text" placeholder="Ask KASS anything..." maxlength="200" autocomplete="off" id="kassField">',
    '  <button id="kassSend" aria-label="Send">',
    '    <svg viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
    '  </button>',
    '</div>'
  ].join('');

  document.body.appendChild(btn);
  document.body.appendChild(modal);

  /* ── State ── */
  var msgs = document.getElementById('kassMsgs');
  var field = document.getElementById('kassField');
  var greeted = false;

  /* ── Helpers ── */
  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function addMsg(text, cls) {
    var m = document.createElement('div');
    m.className = 'km ' + cls;
    m.innerHTML = esc(text);
    msgs.appendChild(m);
    msgs.scrollTop = msgs.scrollHeight;
    return m;
  }

  function showTyping() {
    return addMsg('KASS is typing…', 'bot typing');
  }

  function removeEl(el) {
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  /* ── Offline rule-based responder ── */
  var RULES = [
    [/sell|list|upload|shop|product/i,
      'To sell on Sokoni: tap "Seller" from the menu or go to seller.html. You can list products, manage orders, and track revenue — all from your dashboard.'],
    [/loyalty|point|reward|redeem/i,
      'You earn loyalty points on every purchase, referral, review, and daily login. Redeem them for cash, vouchers, or free delivery at loyalty.html.'],
    [/referr|invite|code/i,
      'Your referral code earns both you and your friend bonus points when they sign up and make their first purchase. Find your code at referral.html.'],
    [/track|order|deliver/i,
      'Track your orders at track.html. You\'ll see real-time status updates and estimated delivery times. You can also contact your driver from there.'],
    [/pay|mpesa|m-pesa|intasend|checkout/i,
      'Sokoni supports M-Pesa STK push. At checkout, enter your phone number and you\'ll receive a prompt to confirm payment within seconds.'],
    [/subscri|plan|business|premium/i,
      'Business subscription plans are at subscriptions.html. Plans unlock featured listings, priority support, advanced analytics, and lower commission rates.'],
    [/analytic|dashboard|stat|report/i,
      'Seller Analytics at seller-analytics.html shows your views, sales funnel, top products, and revenue trends with 30-day charts.'],
    [/driver|ride|deliver/i,
      'Sokoni has a delivery network for packages and goods. Book delivery at delivery.html. Drivers track orders live on the driver dashboard.'],
    [/property|house|rent|buy|land/i,
      'Browse properties to buy, rent, or lease at property-hub.html — houses, apartments, land, commercial spaces across Kenya.'],
    [/fitness|gym|workout|exercise/i,
      'The Fitness Hub at fitness-hub.html connects you to gyms, trainers, and fitness classes near you.'],
    [/legal|lawyer|advocate|court/i,
      'The Legal Hub at legal-hub.html has vetted advocates for consultation, contracts, and legal services.'],
    [/car|vehicle|rent car|hire/i,
      'Car Hub at car-hub.html has 17+ rental cars, NTSA services, GPS tracking, insurance, and garage bookings.'],
    [/hello|hi|hey|good/i,
      'Hello! I\'m KASS, your Sokoni AI assistant. I can help you navigate the platform, understand features, or answer any questions. What would you like to know?'],
    [/thank/i,
      'You\'re welcome! Is there anything else I can help you with on Sokoni?'],
  ];

  function offlineReply(q) {
    for (var i = 0; i < RULES.length; i++) {
      if (RULES[i][0].test(q)) return RULES[i][1];
    }
    return 'I\'m not sure about that one. You can browse all features at index.html or contact support through the inbox at messages.html.';
  }

  /* ── Send message ── */
  function send(text) {
    text = (text || '').trim();
    if (!text) return;
    field.value = '';
    document.getElementById('kassChips').style.display = 'none';
    addMsg(text, 'user');

    var typing = showTyping();

    /* Try Firebase Function first */
    var sent = false;
    if (window.firebase && firebase.functions) {
      try {
        var fn = firebase.functions().httpsCallable('kass');
        fn({ message: text })
          .then(function (result) {
            removeEl(typing);
            var reply = (result && result.data && result.data.reply) || offlineReply(text);
            addMsg(reply, 'bot');
          })
          .catch(function () {
            removeEl(typing);
            addMsg(offlineReply(text), 'bot');
          });
        sent = true;
      } catch(e) {}
    }

    if (!sent) {
      /* Simulate latency for offline mode */
      setTimeout(function () {
        removeEl(typing);
        addMsg(offlineReply(text), 'bot');
      }, 700 + Math.random() * 400);
    }

    /* Track in analytics */
    if (window.sokoniTrackEngagement) window.sokoniTrackEngagement('kass_query', 1);
    if (window.gtag) window.gtag('event', 'kass_query', { query_length: text.length });

    /* Store to history (max 30) */
    try {
      var hist = JSON.parse(localStorage.getItem('kassHistory') || '[]');
      hist.push({ q: text, ts: Date.now() });
      if (hist.length > 30) hist.shift();
      localStorage.setItem('kassHistory', JSON.stringify(hist));
    } catch(e) {}
  }

  /* ── Open / close ── */
  btn.addEventListener('click', function () {
    modal.classList.toggle('open');
    if (modal.classList.contains('open')) {
      if (!greeted) {
        greeted = true;
        var name = '';
        try { name = (JSON.parse(localStorage.getItem('sokoniUser') || '{}')).name || ''; } catch(e) {}
        addMsg('Hey' + (name ? ' ' + esc(name.split(' ')[0]) : '') + '! I\'m KASS, your Sokoni assistant. How can I help you today?', 'bot');
      }
      field.focus();
    }
  });

  document.getElementById('kassClose').addEventListener('click', function () {
    modal.classList.remove('open');
  });

  /* ── Send via button or Enter ── */
  document.getElementById('kassSend').addEventListener('click', function () {
    send(field.value);
  });
  field.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(field.value); }
  });

  /* ── Suggestion chips ── */
  document.getElementById('kassChips').addEventListener('click', function (e) {
    var chip = e.target.closest('.kchip');
    if (chip) send(chip.dataset.q);
  });

  /* ── Close on outside click ── */
  document.addEventListener('click', function (e) {
    if (!modal.contains(e.target) && e.target !== btn) {
      modal.classList.remove('open');
    }
  });

})();
