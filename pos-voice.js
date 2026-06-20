/* SOKONI SmartPOS — Voice AI Cashier v1.0
   Requirements 21 & 24: English + Kiswahili voice commands
   + natural language business queries via AI assistant.
   Uses: Web Speech API (SpeechRecognition + SpeechSynthesis) */

'use strict';

const PosVoice = (() => {

  let _recog   = null;
  let _active  = false;
  let _wakeBtn = null;
  let _lastLang = 'en-US';

  /* ── Swahili number words → digits ────────────────────────── */
  const SW_NUMS = {
    sifuri:0, moja:1, mbili:2, tatu:3, nne:4, tano:5,
    sita:6, saba:7, nane:8, tisa:9, kumi:10,
    'kumi na moja':11,'kumi na mbili':12,'kumi na tatu':13,
    'kumi na nne':14,'kumi na tano':15,'ishirini':20,
    'thelathini':30,'arobaini':40,'hamsini':50,
    'sitini':60,'sabini':70,'themanini':80,'tisini':90,
    'mia':100,'elfu':1000,
  };

  /* ── Intent definitions ────────────────────────────────────── */
  const INTENTS = [
    {
      id: 'add_product',
      patterns: [
        /^(?:add|ongeza|weka)\s+(.+?)(?:\s+(?:to cart|kwenye cart|kwa|mara)\s*(\d+))?$/i,
        /^(\d+)\s+(?:x|za|times)\s+(.+)/i,
      ],
      sw: ['ongeza', 'weka', 'tia'],
      en: ['add', 'scan', 'include'],
    },
    {
      id: 'remove_product',
      patterns: [/^(?:remove|ondoa|toa)\s+(.+)/i],
      sw: ['ondoa', 'toa'],
      en: ['remove', 'delete', 'cancel'],
    },
    {
      id: 'clear_cart',
      patterns: [/^(?:clear|empty|futa|ondoa yote|cart yote)/i],
    },
    {
      id: 'checkout',
      patterns: [/^(?:checkout|pay|lipia|maliza|done|nimalize)/i],
    },
    {
      id: 'cash_payment',
      patterns: [/^(?:cash|pesa taslimu|taslimu)(?:\s+(\d+))?/i],
    },
    {
      id: 'mpesa_payment',
      patterns: [/^(?:mpesa|m-pesa|lipa mpesa)/i],
    },
    {
      id: 'total',
      patterns: [/^(?:total|jumla|kiasi|how much)/i],
    },
    {
      id: 'discount',
      patterns: [/^(?:discount|punguza|toa|give discount)\s+(.+)/i],
    },
    {
      id: 'price',
      patterns: [/^(?:price|bei|gharama|how much is)\s+(.+)/i],
    },
    {
      id: 'hold_cart',
      patterns: [/^(?:hold|simamisha|acha kidogo)/i],
    },
    {
      id: 'recall_cart',
      patterns: [/^(?:recall|load|rudisha cart|rudisha)/i],
    },
    {
      id: 'open_shift',
      patterns: [/^(?:open shift|anza siku|start shift|anza kazi)/i],
    },
    {
      id: 'close_shift',
      patterns: [/^(?:close shift|malizia siku|end shift|maliza kazi)/i],
    },
    /* AI business queries */
    {
      id: 'query_sales',
      patterns: [/(?:sales|mauzo|sold|uliuza|how much did|kiasi gani)/i],
    },
    {
      id: 'query_stock',
      patterns: [/(?:stock|hifadhi|low stock|bidhaa zake|running low|how many left)/i],
    },
    {
      id: 'query_profit',
      patterns: [/(?:profit|faida|earnings|mapato)/i],
    },
    {
      id: 'query_top',
      patterns: [/(?:best seller|top product|bidhaa bora|what sold best|inayoendea)/i],
    },
    {
      id: 'query_customers',
      patterns: [/(?:customer|mteja|customers|wateja)/i],
    },
    {
      id: 'help',
      patterns: [/^(?:help|msaada|commands|amri)/i],
    },
  ];

  /* ── Detect if utterance is Swahili ────────────────────────── */
  function _isSwahili(text) {
    const sw = ['ongeza','ondoa','futa','lipia','mpesa','jumla','bei','bidhaa',
                'hifadhi','mauzo','faida','msaada','tia','toa','weka'];
    const t  = text.toLowerCase();
    return sw.some(w => t.includes(w));
  }

  /* ── Parse number from text (EN + SW) ─────────────────────── */
  function _parseNumber(text) {
    if (!text) return null;
    const clean = text.trim().toLowerCase();
    /* Direct digit */
    if (/^\d+$/.test(clean)) return parseInt(clean, 10);
    /* Swahili words */
    for (const [word, val] of Object.entries(SW_NUMS)) {
      if (clean === word) return val;
    }
    return null;
  }

  /* ── Match intent from transcript ──────────────────────────── */
  function _matchIntent(text) {
    const t = text.trim();
    for (const intent of INTENTS) {
      if (intent.patterns) {
        for (const pattern of intent.patterns) {
          const m = t.match(pattern);
          if (m) return { id: intent.id, match: m, text: t };
        }
      }
    }
    /* Fallback: treat as AI query */
    if (t.length > 3) return { id: 'ai_query', text: t };
    return null;
  }

  /* ── Search products by voice term ────────────────────────── */
  async function _findProduct(term) {
    if (!window.PosDB) return null;
    const all = await PosDB.products.getAll();
    const t   = term.toLowerCase();
    /* Exact match first */
    let p = all.find(x => x.name?.toLowerCase() === t);
    if (p) return p;
    /* Starts-with */
    p = all.find(x => x.name?.toLowerCase().startsWith(t));
    if (p) return p;
    /* Contains */
    p = all.find(x => x.name?.toLowerCase().includes(t));
    return p || null;
  }

  /* ── AI business query handler ─────────────────────────────── */
  async function _handleAIQuery(text) {
    try {
      const today = await PosDB.reports.forDateRange(
        new Date().setHours(0,0,0,0),
        new Date().setHours(23,59,59,999),
      );

      /* Check simple patterns against local data first (fast) */
      if (/(?:sales|mauzo|how much|revenue)/i.test(text)) {
        return `Today's sales: KES ${today.total.toLocaleString()} from ${today.count} transactions.`;
      }
      if (/(?:profit|faida)/i.test(text)) {
        return `Today's profit: KES ${today.profit.toLocaleString()}.`;
      }
      if (/(?:top|best seller|bora)/i.test(text) && today.topProducts?.length) {
        const top = today.topProducts[0];
        return `Best seller today: ${top.name}, ${top.qty} units sold, KES ${top.revenue.toLocaleString()}.`;
      }
      if (/(?:stock|low|running|hifadhi)/i.test(text)) {
        const low = await PosDB.products.getLowStock(10);
        if (!low.length) return 'All products have sufficient stock.';
        return `${low.length} products running low. Lowest: ${low[0].name} with ${low[0].stock} units.`;
      }
      if (/(?:customer|mteja|wateja)/i.test(text)) {
        const custs = await PosDB.customers.getAll();
        return `You have ${custs.length} registered customers.`;
      }
      return `I heard: "${text}". Try asking about sales, profit, stock, or top sellers.`;
    } catch (e) {
      return 'Could not retrieve business data right now.';
    }
  }

  /* ── Execute a matched intent ──────────────────────────────── */
  async function _execute(intent) {
    if (!window.SPos) {
      _speak('POS not loaded yet.'); return;
    }

    const id = intent.id;
    const m  = intent.match;

    /* ── add_product ── */
    if (id === 'add_product') {
      const term = (m[1] || m[2] || '').trim();
      const qty  = _parseNumber(m[2] || m[1]) || 1;
      const product = await _findProduct(term.replace(/\d+/g, '').trim());
      if (!product) {
        _speak(`Product "${term}" not found.`); return;
      }
      const safeQty = isNaN(qty) ? 1 : Math.min(qty, 999);
      for (let i = 0; i < safeQty; i++) SPos.cart.addItem(product.id);
      _speak(`Added ${safeQty > 1 ? safeQty + ' ' : ''}${product.name}.`);
      return;
    }

    /* ── remove_product ── */
    if (id === 'remove_product') {
      const term    = (m[1] || '').trim();
      const product = await _findProduct(term);
      if (!product) { _speak(`Product "${term}" not found in cart.`); return; }
      SPos.cart.removeItem(product.id);
      _speak(`Removed ${product.name}.`);
      return;
    }

    /* ── clear_cart ── */
    if (id === 'clear_cart') {
      SPos.cart.clear();
      _speak('Cart cleared.');
      return;
    }

    /* ── total ── */
    if (id === 'total') {
      const total = SPos.cart.getTotal();
      _speak(`Total is KES ${total.toLocaleString()}.`);
      return;
    }

    /* ── checkout ── */
    if (id === 'checkout') {
      const total = SPos.cart.getTotal();
      if (total <= 0) { _speak('Cart is empty.'); return; }
      SPos.ui.switchTab('payment');
      _speak(`Proceeding to payment. Total: KES ${total.toLocaleString()}.`);
      return;
    }

    /* ── cash_payment ── */
    if (id === 'cash_payment') {
      SPos.payment.setMethod('cash');
      const amount = _parseNumber(m[1] || '');
      if (amount) {
        SPos.payment.setTendered(amount);
        _speak(`Cash payment of KES ${amount.toLocaleString()}.`);
      } else {
        _speak('Cash payment selected.');
      }
      return;
    }

    /* ── mpesa_payment ── */
    if (id === 'mpesa_payment') {
      SPos.payment.setMethod('mpesa');
      _speak('M-PESA selected. Enter customer phone to send STK push.');
      return;
    }

    /* ── discount ── */
    if (id === 'discount') {
      const raw  = (m[1] || '').trim();
      const pct  = /percent|%/.test(raw);
      const num  = parseFloat(raw.replace(/[^0-9.]/g, ''));
      if (!isNaN(num)) {
        SPos.cart.applyDiscount(num, pct ? 'pct' : 'flat');
        _speak(`Discount of ${pct ? num + '%' : 'KES ' + num} applied.`);
      } else {
        _speak('Please say a discount amount, for example: discount 10 percent.');
      }
      return;
    }

    /* ── price ── */
    if (id === 'price') {
      const term = (m[1] || '').trim();
      const p    = await _findProduct(term);
      if (!p) { _speak(`Product "${term}" not found.`); return; }
      _speak(`${p.name} costs KES ${p.price.toLocaleString()}.`);
      return;
    }

    /* ── hold / recall ── */
    if (id === 'hold_cart') {
      SPos.cart.hold();
      _speak('Cart held. You can recall it later.');
      return;
    }
    if (id === 'recall_cart') {
      SPos.cart.recall();
      _speak('Cart recalled.');
      return;
    }

    /* ── shift ── */
    if (id === 'open_shift')  { SPos.shift.open();  _speak('Opening shift.'); return; }
    if (id === 'close_shift') { SPos.shift.close(); _speak('Closing shift.'); return; }

    /* ── analytics queries ── */
    if (['query_sales','query_stock','query_profit','query_top','query_customers'].includes(id)
        || id === 'ai_query') {
      const response = await _handleAIQuery(intent.text);
      _speak(response);
      return;
    }

    /* ── help ── */
    if (id === 'help') {
      _speak('You can say: add sugar, remove milk, total, checkout, pay M-PESA, ' +
             'clear cart, price of bread, or ask about your sales, profit, or stock.');
      return;
    }
  }

  /* ── Speech synthesis ──────────────────────────────────────── */
  function _speak(text, lang) {
    if (!window.speechSynthesis) return;
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang  = lang || _lastLang;
    utter.rate  = 1.0;
    utter.pitch = 1.0;
    utter.volume = 1.0;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
    _updateDisplay(text, 'response');
  }

  /* ── UI feedback ───────────────────────────────────────────── */
  function _updateDisplay(text, role) {
    const el = document.getElementById('voice-transcript');
    if (!el) return;
    const line = document.createElement('div');
    line.className = role === 'user' ? 'voice-user-line' : 'voice-ai-line';
    line.textContent = (role === 'user' ? '🎙 ' : '🤖 ') + text;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
    /* Keep only last 6 lines */
    while (el.children.length > 6) el.removeChild(el.firstChild);
  }

  function _setListeningUI(on) {
    const btn = document.getElementById('voice-mic-btn');
    if (btn) {
      btn.classList.toggle('listening', on);
      btn.title = on ? 'Listening… (click to stop)' : 'Click to start voice commands';
    }
    const indicator = document.getElementById('voice-indicator');
    if (indicator) indicator.style.display = on ? 'flex' : 'none';
  }

  /* ── Init Web Speech API ───────────────────────────────────── */
  function _initRecognizer(lang) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return null;

    const r = new SpeechRecognition();
    r.continuous    = false;
    r.interimResults = false;
    r.maxAlternatives = 1;
    r.lang          = lang || 'en-US';

    r.onresult = async (e) => {
      const transcript = e.results[0][0].transcript.trim();
      const confidence = e.results[0][0].confidence;
      console.log(`[Voice] "${transcript}" (${(confidence*100).toFixed(0)}%)`);

      _updateDisplay(transcript, 'user');

      /* Auto-detect language */
      if (_isSwahili(transcript)) {
        _lastLang = 'sw-KE';
        r.lang    = 'sw-KE';
      } else {
        _lastLang = 'en-US';
      }

      const intent = _matchIntent(transcript);
      if (intent) {
        await _execute(intent);
      } else {
        _speak("I didn't understand. Say 'help' for commands.");
      }

      /* Auto-restart if still active */
      if (_active) {
        setTimeout(() => { try { r.start(); } catch(e2) {} }, 400);
      }
    };

    r.onerror = (e) => {
      if (e.error === 'no-speech') {
        if (_active) setTimeout(() => { try { r.start(); } catch(e2) {} }, 300);
      } else if (e.error !== 'aborted') {
        console.warn('[Voice] Error:', e.error);
        _setListeningUI(false);
        _active = false;
      }
    };

    r.onend = () => {
      if (_active) {
        setTimeout(() => { try { r.start(); } catch(e2) {} }, 300);
      } else {
        _setListeningUI(false);
      }
    };

    return r;
  }

  /* ── Public API ────────────────────────────────────────────── */
  function start() {
    if (_active) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      (window._skToast||alert)('Voice recognition not supported in this browser. Try Chrome or Edge.');
      return;
    }
    _recog  = _initRecognizer(_lastLang);
    _active = true;
    _setListeningUI(true);
    try { _recog.start(); } catch (e) {}
    _speak('Voice cashier ready. Say a command or ask a business question.');
  }

  function stop() {
    _active = false;
    if (_recog) { try { _recog.stop(); } catch(e) {} _recog = null; }
    _setListeningUI(false);
    window.speechSynthesis?.cancel();
  }

  function toggle() {
    if (_active) stop(); else start();
  }

  function isActive() { return _active; }

  function setLanguage(lang) {
    _lastLang = lang;
    if (_recog) _recog.lang = lang;
  }

  /* Render the floating voice UI panel */
  function renderPanel(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

    el.innerHTML = `
      <div class="voice-panel">
        <div class="voice-header">
          <span class="voice-title">🎙 Voice Cashier</span>
          <div id="voice-indicator" class="voice-indicator" style="display:none">
            <div class="voice-wave"></div><div class="voice-wave"></div><div class="voice-wave"></div>
          </div>
          <div style="display:flex;gap:6px;align-items:center">
            <select id="voice-lang-select" class="voice-lang-select" onchange="PosVoice.setLanguage(this.value)">
              <option value="en-US">English</option>
              <option value="sw-KE">Kiswahili</option>
            </select>
            <button id="voice-mic-btn" class="voice-mic-btn" onclick="PosVoice.toggle()"
              ${!SR ? 'disabled title="Not supported in this browser"' : ''}>
              🎤
            </button>
          </div>
        </div>
        <div id="voice-transcript" class="voice-transcript">
          <div class="voice-hint">Say a command — "Add sugar", "Total", "Pay M-PESA", "Best seller today"</div>
        </div>
        ${!SR ? '<div style="color:var(--red);font-size:11px;padding:6px">Voice not supported. Use Chrome or Edge.</div>' : ''}
      </div>
    `;
  }

  /* Inject quick command chip into cashier panel footer */
  function mountQuickChip(parentSel) {
    const parent = document.querySelector(parentSel);
    if (!parent) return;
    const chip = document.createElement('button');
    chip.className = 'voice-quick-chip';
    chip.innerHTML = '🎙 Voice';
    chip.onclick   = toggle;
    parent.appendChild(chip);
  }

  /* Return structured response for AI assistant (no TTS) */
  async function ask(text) {
    const intent = _matchIntent(text);
    if (!intent) return { ok: false, text: 'Unknown query.' };
    const response = await _handleAIQuery(text);
    return { ok: true, text: response };
  }

  return { start, stop, toggle, isActive, setLanguage, renderPanel, mountQuickChip, ask };
})();

window.PosVoice = PosVoice;

