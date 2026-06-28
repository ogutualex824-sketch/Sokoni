/* ================================================================
   sokoni-loyalty.js  v2.0  —  SOKONI Loyalty & Rewards
   Buyer-facing dashboard module. Loaded AFTER /__/firebase/init.js
   (no defer on init.js — firebase compat SDK must be synchronous).

   IIFE exports:  window.SokoniLoyalty
   Entry point:   SokoniLoyalty.init()

   Cloud Functions called (firebase.functions().httpsCallable):
     getLoyaltyAccount  → { balance, tier, totalEarned, thisMonth,
                            nextTierThreshold, pointsToNextTier,
                            currentTierMin }
     getLoyaltyHistory  → { transactions: [ { type, description,
                            points, date } ] }
     getLoyaltyTiers    → { tiers: [ { name, icon, minPoints,
                            multiplier, perks[] } ],
                            earnRate, redemptionRate, minRedemption }

   Tier color / icon maps mirror the HTML static fallback so the
   page looks correct even before the CF resolves.
================================================================ */
'use strict';

window.SokoniLoyalty = (function () {

  /* ── Private state ── */
  var _uid          = null;
  var _balance      = 0;
  var _historyLoaded = false;
  var _tiersLoaded  = false;
  var _minRedeem    = 500;   /* CF may override */
  var _redeemRate   = 10;   /* 100 pts = KSh 10 → 1 pt = KSh 0.10 */
  var _fns          = null; /* firebase.functions() reference */

  /* ── Tier reference data (fallback / used before CF responds) ── */
  var TIER_COLORS = {
    Bronze:   '#cd7f32',
    Silver:   '#9e9e9e',
    Gold:     '#ffc107',
    Platinum: '#00bcd4'
  };
  var TIER_ICONS = {
    Bronze:   '🥉',
    Silver:   '🥈',
    Gold:     '🥇',
    Platinum: '💎'
  };
  /* Static tier thresholds — used for progress bar before CF responds */
  var TIER_MIN = {
    Bronze: 0, Silver: 1000, Gold: 5000, Platinum: 20000
  };
  var TIER_ORDER = ['Bronze', 'Silver', 'Gold', 'Platinum'];

  /* ── XSS escaping ── */
  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* ── Number formatting ── */
  function _fmt(n) {
    var num = Number(n) || 0;
    return num.toLocaleString('en-KE') + ' pts';
  }
  function _fmtKes(n) {
    return 'KSh ' + (Number(n) || 0).toLocaleString('en-KE');
  }
  function _fmtNum(n) {
    return (Number(n) || 0).toLocaleString('en-KE');
  }

  /* ── Toast notifications ── */
  function toast(msg, type) {
    var container = document.getElementById('loyToasts');
    if (!container) return;
    var el = document.createElement('div');
    el.className = 'loy-toast ' + (type || 'info');
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(function () {
      if (el.parentNode) {
        el.style.opacity = '0';
        el.style.transition = 'opacity .3s';
        setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 300);
      }
    }, 3500);
  }

  /* ── DOM helpers ── */
  function _setText(id, val) {
    var el = document.getElementById(id);
    if (el) el.textContent = val;
  }
  function _setHTML(id, val) {
    var el = document.getElementById(id);
    if (el) el.innerHTML = val;
  }

  /* ── Loading spinner HTML ── */
  function _spinner(msg) {
    return '<div class="loy-loading"><div class="loy-spinner"></div>'
         + '<span>' + _esc(msg || 'Loading…') + '</span></div>';
  }

  /* ── Firebase functions accessor (lazy) ── */
  function _getFns() {
    if (_fns) return _fns;
    try {
      /* firebase compat SDK must be loaded before this file */
      _fns = firebase.functions();
      return _fns;
    } catch (e) {
      console.error('[SokoniLoyalty] firebase.functions() unavailable:', e);
      return null;
    }
  }

  /* ── Callable helper ── */
  function _call(name, payload) {
    var fns = _getFns();
    if (!fns) return Promise.reject(new Error('Firebase Functions not available'));
    var fn = fns.httpsCallable(name);
    return fn(payload || {}).then(function (res) { return res.data; });
  }

  /* ================================================================
     RENDER: ACCOUNT (hero + KPIs + progress bar)
  ================================================================ */
  function renderAccount(data) {
    var bal            = Number(data.balance)            || 0;
    var tier           = String(data.tier                || 'Bronze');
    var totalEarned    = Number(data.totalEarned)        || 0;
    var thisMonth      = Number(data.thisMonth)          || 0;
    var nextThreshold  = Number(data.nextTierThreshold)  || 0;
    var ptsToNext      = Number(data.pointsToNextTier)   || 0;
    var currentMin     = Number(data.currentTierMin)
                         !== undefined ? Number(data.currentTierMin)
                         : (TIER_MIN[tier] || 0);

    _balance = bal;

    /* ── Hero balance ── */
    _setText('loyBalance', _fmtNum(bal));
    _setText('loyBalance2', _fmtNum(bal));

    /* ── Tier badge ── */
    var icon  = TIER_ICONS[tier]  || '🥉';
    var color = TIER_COLORS[tier] || '#cd7f32';
    _setText('loyTierIcon', icon);
    _setText('loyTier',     tier + ' Member');

    var badge = document.getElementById('loyTierBadge');
    if (badge) {
      badge.style.background   = 'rgba(255,255,255,.18)';
      badge.style.borderColor  = 'rgba(255,255,255,.4)';
    }

    /* ── KPI strip ── */
    _setText('loyTierKpi',     tier);
    _setText('loyTotalEarned', _fmtNum(totalEarned));
    _setText('loyThisMonth',   _fmtNum(thisMonth));

    /* ── Progress bar ── */
    var tierIdx  = TIER_ORDER.indexOf(tier);
    var isPlatinum = tier === 'Platinum' || tierIdx === TIER_ORDER.length - 1;
    var pct;

    if (isPlatinum) {
      pct = 100;
      var fill = document.getElementById('loyProgressFill');
      if (fill) {
        fill.style.width = '100%';
        fill.style.background = 'linear-gradient(90deg, #00bcd4, #00e5ff)';
      }
      _setText('loyTier2',      tier);
      _setText('loyNextTier',   '');
      _setText('loyProgressText', 'Maximum tier achieved 🎉');
    } else {
      var nextTierName = TIER_ORDER[tierIdx + 1] || 'Silver';
      var nextMin = nextThreshold || TIER_MIN[nextTierName] || (currentMin + 1000);
      var range = nextMin - currentMin;
      var progress = bal - currentMin;
      pct = range > 0 ? Math.min(100, Math.max(0, Math.round((progress / range) * 100))) : 0;

      var fillEl = document.getElementById('loyProgressFill');
      if (fillEl) fillEl.style.width = pct + '%';

      _setText('loyTier2',      tier);
      _setText('loyNextTier',   nextTierName);
      _setText('loyProgressText',
        _fmtNum(ptsToNext || (nextMin - bal)) + ' pts to ' + _esc(nextTierName));
    }

    /* ── Sync redeem slider max to current balance ── */
    _syncRedeemSlider();
  }

  /* ================================================================
     LOAD: ACCOUNT  (calls getLoyaltyAccount CF)
  ================================================================ */
  function loadAccount() {
    /* Show skeleton values while loading */
    _setText('loyBalance',      '…');
    _setText('loyBalance2',     '…');
    _setText('loyTierKpi',      '…');
    _setText('loyTotalEarned',  '…');
    _setText('loyThisMonth',    '…');
    _setText('loyProgressText', 'Loading…');

    return _call('getLoyaltyAccount', {})
      .then(function (data) {
        renderAccount(data);
      })
      .catch(function (err) {
        console.error('[SokoniLoyalty] getLoyaltyAccount error:', err);
        /* Graceful degradation — show zeros so UI is not broken */
        renderAccount({ balance: 0, tier: 'Bronze', totalEarned: 0, thisMonth: 0 });
        toast('Could not load your account. Please refresh.', 'error');
      });
  }

  /* ================================================================
     RENDER: HISTORY
  ================================================================ */
  function renderHistory(txs) {
    var container = document.getElementById('loyHistoryList');
    if (!container) return;

    if (!txs || txs.length === 0) {
      container.innerHTML =
        '<div class="loy-empty">'
        + '<div class="loy-empty-icon">📜</div>'
        + '<p>No points history yet.<br>Start shopping to earn your first points!</p>'
        + '</div>';
      return;
    }

    var rows = txs.map(function (tx) {
      var pts      = Number(tx.points) || 0;
      var txType   = String(tx.type || (pts >= 0 ? 'earn' : 'redeem'));
      var isEarn   = pts > 0;
      var isRedeem = pts < 0;
      var cls      = isEarn ? 'earn' : isRedeem ? 'redeem' : 'adjust';
      var icon     = isEarn ? '⭐' : isRedeem ? '🎁' : '⚙️';
      var ptsLabel = (isEarn ? '+' : '') + _fmtNum(pts) + ' pts';
      var desc     = _esc(tx.description || (isEarn ? 'Points earned' : 'Points redeemed'));
      var dateStr  = _esc(tx.date || '');

      return '<div class="loy-tx-row">'
           +   '<div class="loy-tx-icon ' + cls + '">' + icon + '</div>'
           +   '<div class="loy-tx-info">'
           +     '<div class="loy-tx-desc">' + desc + '</div>'
           +     '<div class="loy-tx-date">' + dateStr + '</div>'
           +   '</div>'
           +   '<div class="loy-tx-pts ' + cls + '">' + _esc(ptsLabel) + '</div>'
           + '</div>';
    }).join('');

    container.innerHTML = '<div class="loy-history-list">' + rows + '</div>';
  }

  /* ================================================================
     LOAD: HISTORY  (lazy — only called on first tab open)
  ================================================================ */
  function loadHistory() {
    if (_historyLoaded) return;
    _historyLoaded = true;

    _setHTML('loyHistoryList', _spinner('Loading history…'));

    _call('getLoyaltyHistory', {})
      .then(function (data) {
        renderHistory(data.transactions || []);
      })
      .catch(function (err) {
        console.error('[SokoniLoyalty] getLoyaltyHistory error:', err);
        _setHTML('loyHistoryList',
          '<div class="loy-error-msg">Could not load history. Please try again.</div>');
      });
  }

  /* ================================================================
     RENDER: TIERS
  ================================================================ */
  function renderTiers(tiers, currentTier) {
    var container = document.getElementById('loyLeaderboard');
    if (!container || !tiers || !tiers.length) return;

    var html = tiers.map(function (t) {
      var name        = _esc(t.name || 'Bronze');
      var icon        = _esc(t.icon || TIER_ICONS[t.name] || '🥉');
      var color       = TIER_COLORS[t.name] || '#cd7f32';
      var min         = Number(t.minPoints) || 0;
      var multiplier  = t.multiplier ? String(t.multiplier) + '×' : '1×';
      var perks       = Array.isArray(t.perks) ? t.perks : [];
      var isCurrent   = (t.name === currentTier);
      var nextTierIdx = TIER_ORDER.indexOf(t.name) + 1;
      var maxLabel    = nextTierIdx < TIER_ORDER.length
                        ? _fmtNum(min) + ' – ' + _fmtNum((TIER_MIN[TIER_ORDER[nextTierIdx]] || 0) - 1) + ' pts'
                        : _fmtNum(min) + '+ pts';

      var cardStyle = isCurrent
        ? 'border: 2px solid ' + color + '; box-shadow: 0 4px 18px rgba(0,0,0,.12);'
        : '';

      var perksHtml = perks.map(function (p) {
        return '<li>' + _esc(p) + '</li>';
      }).join('');

      return '<div class="loy-tier-card' + (isCurrent ? ' loy-tier-current' : '') + '" style="' + cardStyle + '">'
           +   '<div class="loy-tier-card-icon">' + icon + '</div>'
           +   '<div class="loy-tier-card-name" style="color:' + color + ';">' + name + '</div>'
           +   '<div class="loy-tier-card-range">' + _esc(maxLabel) + '</div>'
           +   '<div class="loy-multiplier">' + _esc(multiplier) + ' earn rate</div>'
           +   '<ul class="loy-tier-card-perks">' + perksHtml + '</ul>'
           + (isCurrent ? '<div class="loy-tier-current-badge">✓ Your Current Tier</div>' : '')
           + '</div>';
    }).join('');

    container.innerHTML = html;
  }

  /* ================================================================
     LOAD: TIERS  (called on init — used by Tiers tab + renders fast)
  ================================================================ */
  function loadTiers() {
    return _call('getLoyaltyTiers', {})
      .then(function (data) {
        /* Update redemption config */
        if (data.minRedemption)  _minRedeem  = Number(data.minRedemption);
        if (data.redemptionRate) _redeemRate = Number(data.redemptionRate);

        /* Re-sync slider now that minRedemption is known */
        _syncRedeemSlider();

        /* Render tier cards (only if Tiers tab is active or data is ready) */
        if (_tiersLoaded) {
          /* Tiers tab was already opened — render now */
          renderTiers(data.tiers || [], _currentTierName());
        } else {
          /* Store for when the tab opens */
          _tiersLoaded = true;
          _pendingTiersData = data;
        }
      })
      .catch(function (err) {
        console.error('[SokoniLoyalty] getLoyaltyTiers error:', err);
        /* Static fallback HTML is already in the DOM — leave it */
        _tiersLoaded = true;
      });
  }

  /* Pending tiers data before the tab is first opened */
  var _pendingTiersData = null;

  /* ── Helper: get current tier name from DOM ── */
  function _currentTierName() {
    var el = document.getElementById('loyTier');
    if (!el) return 'Bronze';
    var txt = el.textContent || '';
    /* strip " Member" suffix */
    return txt.replace(' Member', '').trim() || 'Bronze';
  }

  /* ================================================================
     REDEEM SLIDER
  ================================================================ */
  function _syncRedeemSlider() {
    var slider = document.getElementById('loyRedeemSlider');
    if (!slider) return;

    var minVal = _minRedeem;   /* default 500 */
    var maxVal = Math.floor(_balance / 100) * 100; /* round to nearest 100 */

    if (_balance < minVal) {
      /* Not enough points — disable everything */
      slider.disabled = true;
      slider.min = minVal;
      slider.max = minVal;
      slider.value = minVal;
      _setText('loyRedeemPts',  _fmt(minVal));
      _setText('loyRedeemPts2', _fmt(minVal));
      _setText('loyRedeemValue', _fmtKes(Math.floor(minVal / 100) * _redeemRate));

      var btn = document.getElementById('loyRedeemBtn');
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Need ' + _fmtNum(minVal) + ' pts to redeem';
      }
      return;
    }

    slider.disabled = false;
    slider.min   = String(minVal);
    slider.max   = String(Math.max(minVal, maxVal));
    slider.value = String(minVal);
    slider.step  = '100';

    _updateRedeemPreview(minVal);

    var btn2 = document.getElementById('loyRedeemBtn');
    if (btn2) {
      btn2.disabled    = false;
      btn2.textContent = 'Redeem at Checkout';
    }
  }

  function _updateRedeemPreview(pts) {
    var ptNum  = Number(pts) || _minRedeem;
    var kesVal = Math.floor(ptNum / 100) * _redeemRate;
    _setText('loyRedeemPts',  _fmt(ptNum));
    _setText('loyRedeemPts2', _fmt(ptNum));
    _setText('loyRedeemValue', _fmtKes(kesVal));
  }

  function initRedeemSlider() {
    var slider = document.getElementById('loyRedeemSlider');
    if (!slider) return;

    slider.addEventListener('input', function () {
      _updateRedeemPreview(Number(slider.value));
    });
  }

  /* ================================================================
     REDEEM ACTION
     Points are NOT deducted here — the user provides their order ID
     at checkout and the CF handles the deduction atomically.
  ================================================================ */
  function redeemPoints() {
    var slider = document.getElementById('loyRedeemSlider');
    if (!slider || slider.disabled) {
      toast('You need at least ' + _fmtNum(_minRedeem) + ' pts to redeem.', 'error');
      return;
    }

    var pts    = Number(slider.value);
    var minVal = Number(slider.min) || _minRedeem;

    if (pts < minVal) {
      toast('Minimum redemption is ' + _fmt(minVal) + '.', 'error');
      return;
    }

    if (pts > _balance) {
      toast('You only have ' + _fmt(_balance) + ' available.', 'error');
      return;
    }

    var kesVal = Math.floor(pts / 100) * _redeemRate;

    /* Confirmation message — points are redeemed at checkout */
    toast(
      '✅ At checkout, quote your order ID to save '
      + _fmtKes(kesVal) + ' using ' + _fmt(pts) + '.',
      'success'
    );

    /* Disable button briefly to prevent double-tap */
    var btn = document.getElementById('loyRedeemBtn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Noted! Show this at checkout ✓';
      setTimeout(function () {
        if (btn) {
          btn.disabled    = false;
          btn.textContent = 'Redeem at Checkout';
        }
      }, 4000);
    }
  }

  /* ================================================================
     TAB MANAGEMENT
  ================================================================ */
  function initTabs() {
    var tabs     = document.querySelectorAll('.loy-tab');
    var contents = document.querySelectorAll('.loy-tab-content');

    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        var name = tab.getAttribute('data-tab');

        /* Update tab active state */
        tabs.forEach(function (t) {
          t.classList.remove('active');
          t.setAttribute('aria-selected', 'false');
        });
        tab.classList.add('active');
        tab.setAttribute('aria-selected', 'true');

        /* Show matching content */
        contents.forEach(function (c) {
          var id = c.getAttribute('id');
          if (id === 'loy-tab-' + name) {
            c.classList.add('active');
          } else {
            c.classList.remove('active');
          }
        });

        /* Lazy-load data tabs */
        if (name === 'history') {
          loadHistory();
        }

        if (name === 'tiers') {
          if (!_tiersLoaded) {
            /* Tiers CF hasn't resolved yet — show spinner */
            var lg = document.getElementById('loyLeaderboard');
            if (lg) lg.innerHTML = _spinner('Loading tiers…');
          } else if (_pendingTiersData) {
            renderTiers(_pendingTiersData.tiers || [], _currentTierName());
            _pendingTiersData = null;
          }
        }
      });
    });
  }

  /* ================================================================
     AUTH GATE + INIT
  ================================================================ */
  function init() {
    /* firebase.auth() is synchronous on the compat SDK */
    try {
      firebase.auth().onAuthStateChanged(function (user) {
        if (!user) {
          /* Redirect to login, preserving the return URL */
          window.location.href = 'login.html?redirect=loyalty.html';
          return;
        }

        _uid = user.uid;

        /* Boot sequence */
        loadAccount();
        loadTiers();
        initTabs();
        initRedeemSlider();

        /* Wire redeem button */
        var btn = document.getElementById('loyRedeemBtn');
        if (btn) {
          btn.addEventListener('click', redeemPoints);
        }
      });
    } catch (e) {
      console.error('[SokoniLoyalty] Auth init error:', e);
      toast('Authentication error. Please reload.', 'error');
    }
  }

  /* ================================================================
     PUBLIC API
  ================================================================ */
  return {
    init:         init,
    loadAccount:  loadAccount,
    loadHistory:  loadHistory,
    loadTiers:    loadTiers,
    initTabs:     initTabs,
    initRedeemSlider: initRedeemSlider,
    redeemPoints: redeemPoints,
    renderAccount: renderAccount,
    renderHistory: renderHistory,
    renderTiers:  renderTiers,
    toast:        toast,
    /* Expose formatters for external use */
    fmt:  _fmt,
    esc:  _esc
  };

})();
