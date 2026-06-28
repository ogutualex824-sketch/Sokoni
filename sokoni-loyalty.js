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

  /* ── Tier reference data (v2.0 — 5 tiers) ── */
  var TIER_COLORS = {
    bronze: '#CD7F32', Bronze: '#CD7F32',
    silver: '#C0C0C0', Silver: '#C0C0C0',
    gold:   '#FFD700', Gold:   '#FFD700',
    platinum: '#E5E4E2', Platinum: '#E5E4E2',
    diamond:  '#B9F2FF', Diamond:  '#B9F2FF'
  };
  var TIER_ICONS = {
    bronze: '🥉', Bronze: '🥉',
    silver: '🥈', Silver: '🥈',
    gold:   '🥇', Gold:   '🥇',
    platinum: '💎', Platinum: '💎',
    diamond:  '💠', Diamond:  '💠'
  };
  var TIER_NAMES = {
    bronze: 'Bronze', silver: 'Silver', gold: 'Gold', platinum: 'Platinum', diamond: 'Diamond'
  };
  /* v2.0 thresholds — based on lifetimePoints */
  var TIER_MIN = {
    bronze: 0, Bronze: 0,
    silver: 5000, Silver: 5000,
    gold: 20000, Gold: 20000,
    platinum: 50000, Platinum: 50000,
    diamond: 100000, Diamond: 100000
  };
  var TIER_ORDER = ['bronze', 'silver', 'gold', 'platinum', 'diamond'];
  var TIER_ORDER_NAMES = ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond'];

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
    var bal           = Number(data.balance)       || 0;
    var tierKey       = String(data.tier           || 'bronze').toLowerCase();
    var lifetimePts   = Number(data.lifetimePoints || bal);
    var totalEarned   = Number(data.totalEarned)   || 0;
    var thisMonth     = Number(data.thisMonth)     || 0;

    _balance = bal;

    var tierName  = TIER_NAMES[tierKey] || TIER_NAMES[tierKey.charAt(0).toUpperCase() + tierKey.slice(1)] || 'Bronze';
    var icon      = TIER_ICONS[tierKey]  || '🥉';
    var color     = TIER_COLORS[tierKey] || '#CD7F32';

    /* ── Hero balance ── */
    _setText('loyBalance', _fmtNum(bal));
    _setText('loyBalance2', _fmtNum(bal));

    /* ── Tier badge ── */
    _setText('loyTierIcon', icon);
    _setText('loyTier',     tierName + ' Member');

    /* ── KPI strip ── */
    _setText('loyTierKpi',     tierName);
    _setText('loyTotalEarned', _fmtNum(totalEarned || lifetimePts));
    _setText('loyThisMonth',   _fmtNum(thisMonth));

    /* ── Progress bar — uses lifetimePoints for tier calculation ── */
    var tierIdx   = TIER_ORDER.indexOf(tierKey);
    var isDiamond = tierIdx === TIER_ORDER.length - 1;
    var currentMin = TIER_MIN[tierKey] || 0;

    if (isDiamond) {
      var fillD = document.getElementById('loyProgressFill');
      if (fillD) { fillD.style.width = '100%'; fillD.style.background = 'linear-gradient(90deg,#B9F2FF,#00e5ff)'; }
      _setText('loyTier2',       tierName);
      _setText('loyNextTier',    '');
      _setText('loyProgressText', 'Maximum tier achieved — Diamond 💠');
    } else {
      var nextKey  = TIER_ORDER[tierIdx + 1] || 'silver';
      var nextName = TIER_NAMES[nextKey] || 'Silver';
      var nextMin  = TIER_MIN[nextKey]   || 5000;
      var range    = nextMin - currentMin;
      var progress = lifetimePts - currentMin;
      var pct      = range > 0 ? Math.min(100, Math.max(0, Math.round(progress / range * 100))) : 0;
      var fillEl   = document.getElementById('loyProgressFill');
      if (fillEl) fillEl.style.width = pct + '%';
      _setText('loyTier2',       tierName);
      _setText('loyNextTier',    nextName);
      _setText('loyProgressText', _fmtNum(Math.max(0, nextMin - lifetimePts)) + ' pts to ' + _esc(nextName));
    }

    /* ── Hero stat row: points + cashback ── */
    var cashbackKes = Number(data.cashbackBalance) || 0;
    _setText('loyHeroPoints',  _fmtNum(bal) + ' pts');
    _setText('loyHeroCashback', _fmtKes(cashbackKes));

    /* ── Card tab: cashback summary ── */
    _setText('loyCardCashbackBalance', _fmtKes(cashbackKes));

    /* ── Cashback tab: balance display ── */
    _setText('loyCashbackBalance', _fmtKes(cashbackKes));
    var pendingEl = document.getElementById('loyCashbackPending');
    if (pendingEl) {
      var pendingKes = Number(data.cashbackPending) || 0;
      pendingEl.textContent = pendingKes > 0
        ? _fmtKes(pendingKes) + ' pending (clears after order delivery)'
        : '';
    }

    /* ── Sync redeem slider max to current balance ── */
    _syncRedeemSlider();
  }

  /* ── Private state additions ── */
  var _loyaltyId     = null;
  var _qrPayload     = null;
  var _cardLoaded    = false;
  var _rewardsLoaded = false;

  /* ================================================================
     RENDER: DIGITAL CARD
  ================================================================ */
  function renderCard(data) {
    if (!data) {
      var prompt = document.getElementById('loyCreateAccountPrompt');
      if (prompt) prompt.style.display = 'block';
      return;
    }
    var tierKey  = String(data.tier || 'bronze').toLowerCase();
    var tierName = TIER_NAMES[tierKey] || 'Bronze';
    var icon     = TIER_ICONS[tierKey]  || '🥉';
    var color    = TIER_COLORS[tierKey] || '#CD7F32';
    var bal      = Number(data.balance) || 0;
    var cardNum  = String(data.cardNumber || '').replace(/(\d{4})/g, '$1 ').trim();
    var name     = String(data.name || '').toUpperCase() || 'SOKONI MEMBER';
    _loyaltyId   = data.loyaltyId || null;
    _qrPayload   = data.qrPayload || null;

    _setText('loyCardNumber', cardNum || '•••• •••• ••••');
    _setText('loyCardName', name);
    _setText('loyCardPts', bal.toLocaleString('en-KE'));
    var tb = document.getElementById('loyCardTierBadge');
    if (tb) { tb.textContent = icon + ' ' + tierName; tb.style.color = color; }

    var qrContainer = document.getElementById('loyQRCanvas');
    if (qrContainer && _qrPayload) {
      qrContainer.innerHTML = '';
      try {
        if (typeof QRCode !== 'undefined') {
          new QRCode(qrContainer, { text: _qrPayload, width: 160, height: 160,
            colorDark: '#1a1a2e', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
        } else {
          qrContainer.innerHTML = '<p style="font-size:12px;color:var(--muted);">Show ID: <strong>' + _esc(_loyaltyId || '') + '</strong></p>';
        }
      } catch (e) {
        qrContainer.innerHTML = '<p style="font-size:12px;color:var(--muted);">Show ID: <strong>' + _esc(_loyaltyId || '') + '</strong></p>';
      }
    }
    _setText('loyLoyaltyId', _loyaltyId || '—');
    var cards = Array.isArray(data.linkedCards) ? data.linkedCards : [];
    if (cards.length) {
      var section = document.getElementById('loyLinkedCardsSection');
      var list    = document.getElementById('loyLinkedCardsList');
      if (section) section.style.display = 'block';
      if (list)    list.textContent = cards.join('  ·  ');
    }
  }

  /* ================================================================
     LOAD: CARD
  ================================================================ */
  function loadCard() {
    if (_cardLoaded) return;
    _cardLoaded = true;
    return _call('getLoyaltyCard', {})
      .then(function (data) { renderCard(data); })
      .catch(function (err) {
        if ((err.code || '').indexOf('not-found') !== -1 || (err.message || '').indexOf('not found') !== -1) {
          var prompt = document.getElementById('loyCreateAccountPrompt');
          if (prompt) prompt.style.display = 'block';
        } else {
          console.warn('[SokoniLoyalty] getLoyaltyCard:', err);
        }
      });
  }

  /* ================================================================
     CREATE ACCOUNT
  ================================================================ */
  function createAccount() {
    var phone = (prompt('Enter your phone number (e.g. 0712345678):') || '').trim().replace(/\s+/g, '');
    if (!phone) return;
    if (!/^(0\d{9}|\+254\d{9})$/.test(phone)) {
      toast('Please enter a valid Kenyan phone number.', 'error'); return;
    }
    _call('createLoyaltyAccount', { phone: phone })
      .then(function (data) {
        toast('🎉 Account created! You earned ' + (data.welcomePoints || 125) + ' welcome points.', 'success');
        _cardLoaded = false; loadCard(); loadAccount();
      })
      .catch(function (err) {
        toast(err.code === 'already-exists' ? 'A loyalty account already exists for this phone number.' : (err.message || 'Please try again.'), 'error');
      });
  }

  /* ================================================================
     RENDER + LOAD: REWARDS
  ================================================================ */
  function renderRewards(rewards, balance) {
    var container = document.getElementById('loyRewardGrid');
    if (!container) return;
    _setText('loyRewardBalance', (balance || 0).toLocaleString('en-KE') + ' pts');
    if (!rewards || !rewards.length) {
      container.innerHTML = '<div class="loy-empty"><div class="loy-empty-icon">🎁</div><p>No rewards available yet.<br>Check back soon!</p></div>';
      return;
    }
    var TYPE_ICONS = { discount:'🏷️', cashback:'💰', free_item:'🆓', gift_card:'🎁', voucher:'🎟️', free_delivery:'🚚', vip_upgrade:'👑', scratch_card:'🎰', lucky_draw:'🍀' };
    container.innerHTML = rewards.map(function (r) {
      var icon   = TYPE_ICONS[r.rewardType] || '🎁';
      var canBuy = r.canAfford !== false;
      var pts    = Number(r.pointsCost) || 0;
      var val    = Number(r.value)      || 0;
      var stock  = r.stock != null ? ' · ' + r.stock + ' left' : '';
      return '<div class="loy-reward-card' + (canBuy ? '' : ' unaffordable') + '">'
           + '<div class="loy-reward-icon">' + icon + '</div>'
           + '<div class="loy-reward-name">' + _esc(r.name) + '</div>'
           + '<div class="loy-reward-pts">' + pts.toLocaleString('en-KE') + ' pts</div>'
           + (val ? '<div class="loy-reward-value">Value: KES ' + val.toLocaleString('en-KE') + _esc(stock) + '</div>' : '')
           + '<button class="loy-reward-cta"' + (canBuy ? ' onclick="SokoniLoyalty.redeemReward(\'' + _esc(r.id) + '\')"' : ' disabled') + '>'
           + (canBuy ? 'Redeem' : 'Need ' + pts.toLocaleString('en-KE') + ' pts') + '</button>'
           + '</div>';
    }).join('');
  }

  function loadRewards() {
    if (_rewardsLoaded) return;
    _rewardsLoaded = true;
    var c = document.getElementById('loyRewardGrid');
    if (c) c.innerHTML = _spinner('Loading rewards…');
    _call('getAvailableRewards', {})
      .then(function (data) { renderRewards(data.rewards || [], data.pointsBalance); })
      .catch(function (err) {
        console.error('[SokoniLoyalty] getAvailableRewards:', err);
        var c2 = document.getElementById('loyRewardGrid');
        if (c2) c2.innerHTML = '<div class="loy-error-msg">Could not load rewards. Please try again.</div>';
      });
  }

  function redeemReward(rewardId) {
    if (!rewardId) return;
    if (!confirm('Redeem this reward now? Points will be deducted immediately.')) return;
    _call('redeemLoyaltyReward', { rewardId: rewardId })
      .then(function (data) {
        alert('🎉 Redeemed! Voucher code: ' + (data.voucherCode || '(see app)'));
        _rewardsLoaded = false; loadRewards();
        _cardLoaded = false; loadCard(); loadAccount();
      })
      .catch(function (err) { toast(err.message || 'Redemption failed. Please try again.', 'error'); });
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
        if (name === 'card')      loadCard();
        if (name === 'rewards')   loadRewards();
        if (name === 'history')   loadHistory();
        if (name === 'cashback')  loadAccount();   /* refreshes cashback balance */
        if (name === 'giftcards') _initGiftCardInput();

        if (name === 'tiers') {
          if (!_tiersLoaded) {
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

        /* Boot sequence — card is the landing tab (loads in parallel with account) */
        loadCard();
        loadAccount();
        loadTiers();
        initTabs();
        initRedeemSlider();
      });
    } catch (e) {
      console.error('[SokoniLoyalty] Auth init error:', e);
      toast('Authentication error. Please reload.', 'error');
    }
  }

  /* ================================================================
     GIFT CARD INPUT — auto-format XXXX-XXXX-XXXX-XXXX
  ================================================================ */
  var _gcInputWired = false;
  function _initGiftCardInput() {
    if (_gcInputWired) return;
    var el = document.getElementById('loyGiftCardInput');
    if (!el) return;
    el.addEventListener('input', function () {
      var digits = el.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 16);
      var formatted = digits.match(/.{1,4}/g);
      var pos = el.selectionStart;
      el.value = formatted ? formatted.join('-') : digits;
      /* restore caret approximately */
      try { el.setSelectionRange(pos, pos); } catch (e) { /* ignore */ }
    });
    _gcInputWired = true;
  }

  /* ================================================================
     SWITCH TAB (programmatic — used by cashback summary link)
  ================================================================ */
  function switchTab(name) {
    var tabs     = document.querySelectorAll('.loy-tab');
    var contents = document.querySelectorAll('.loy-tab-content');
    var matched  = false;

    tabs.forEach(function (tab) {
      if (tab.getAttribute('data-tab') === name) {
        tab.classList.add('active');
        tab.setAttribute('aria-selected', 'true');
        tab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        matched = true;
      } else {
        tab.classList.remove('active');
        tab.setAttribute('aria-selected', 'false');
      }
    });

    contents.forEach(function (c) {
      if (c.getAttribute('id') === 'loy-tab-' + name) {
        c.classList.add('active');
      } else {
        c.classList.remove('active');
      }
    });

    if (!matched) {
      console.warn('[SokoniLoyalty] switchTab: unknown tab "' + name + '"');
    }
  }

  /* ================================================================
     CASHBACK — REDEEM
  ================================================================ */
  function redeemCashback() {
    if (!_uid) {
      toast('Please log in to redeem cashback.', 'error');
      return;
    }
    var balEl = document.getElementById('loyCashbackBalance');
    var balStr = balEl ? balEl.textContent.replace(/[^0-9.]/g, '') : '0';
    var bal = parseFloat(balStr) || 0;

    if (bal < 10) {
      toast('Minimum cashback redemption is KES 10.', 'error');
      return;
    }

    toast('Cashback redemption will be applied at your next checkout. Minimum KES 10.', 'info');
  }

  /* ================================================================
     GIFT CARDS — CHECK / REDEEM
  ================================================================ */
  function checkGiftCard() {
    var inputEl  = document.getElementById('loyGiftCardInput');
    var resultEl = document.getElementById('loyGiftCardResult');
    if (!inputEl || !resultEl) return;

    var code = inputEl.value.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
    if (!code || code.length < 16) {
      resultEl.className     = 'loy-gift-card-result invalid';
      resultEl.style.display = 'block';
      resultEl.textContent   = 'Please enter a valid 16-character gift card code.';
      return;
    }

    /* Format input visually: XXXX-XXXX-XXXX-XXXX */
    var digits = code.replace(/-/g, '');
    if (digits.length >= 16) {
      inputEl.value = digits.slice(0, 4) + '-' + digits.slice(4, 8) + '-'
                    + digits.slice(8, 12) + '-' + digits.slice(12, 16);
    }

    if (!_uid) {
      toast('Please log in to redeem a gift card.', 'error');
      return;
    }

    resultEl.className     = 'loy-gift-card-result';
    resultEl.style.display = 'block';
    resultEl.textContent   = 'Checking gift card…';

    /* Call the Cloud Function to validate + redeem */
    firebase.functions().httpsCallable('redeemGiftCard')({ code: code, uid: _uid, merchantId: null, orderTotal: 999999 })
      .then(function (res) {
        var d = res.data || {};
        if (d.valid) {
          resultEl.className   = 'loy-gift-card-result valid';
          resultEl.textContent = 'Gift card valid! ' + _fmtKes(d.value || 0) + ' will be credited to your account.';
          toast('Gift card redeemed: ' + _fmtKes(d.value || 0) + ' added!', 'success');
          loadAccount(); /* refresh balance */
        } else {
          resultEl.className   = 'loy-gift-card-result invalid';
          resultEl.textContent = d.message || 'Gift card not found or already used.';
        }
      })
      .catch(function (err) {
        console.error('[SokoniLoyalty] checkGiftCard error:', err);
        /* Graceful fallback — CF may not exist yet */
        resultEl.className   = 'loy-gift-card-result invalid';
        resultEl.textContent = 'Gift card check is currently unavailable. Please try again later.';
      });
  }

  /* ================================================================
     ENTERPRISE v1.0 — LUCKY DRAWS
  ================================================================ */
  function loadDraws() {
    var el = document.getElementById('loyDrawsList');
    var entriesEl = document.getElementById('loyMyEntries');
    if (!el) return;
    el.innerHTML = '<div style="color:#888;text-align:center;padding:16px">Loading draws…</div>';
    var db = firebase.firestore();
    var now = firebase.firestore.Timestamp.now();
    db.collection('loyaltyDraws')
      .where('status', '==', 'active')
      .where('endsAt', '>', now)
      .limit(10)
      .get()
      .then(function(snap) {
        if (snap.empty) {
          el.innerHTML = '<div style="color:#888;padding:16px;text-align:center">No active draws. Shop to earn entries when draws go live!</div>';
          return;
        }
        el.innerHTML = snap.docs.map(function(doc) {
          var d = doc.data();
          var ends = d.endsAt && d.endsAt.toDate ? d.endsAt.toDate() : null;
          return '<div class="loy-draw-card">' +
            '<h4>' + _esc(d.name || 'Lucky Draw') + '</h4>' +
            '<div class="loy-draw-prize">🎁 Prize: ' + _esc((d.prize && (d.prize.description || d.prize.type)) || 'Mystery Prize') + '</div>' +
            '<div class="loy-draw-entries">Entry: Shop KES ' + _fmt(d.entryThreshold || 0) + '+</div>' +
            (ends ? '<div class="loy-draw-expires">Ends: ' + ends.toLocaleDateString('en-KE', {day:'numeric',month:'short',year:'numeric'}) + '</div>' : '') +
            '</div>';
        }).join('');
        if (entriesEl && _uid) {
          Promise.all(snap.docs.map(function(doc) {
            return db.collection('loyaltyDrawEntries').doc(_uid + '_' + doc.id).get()
              .then(function(e) { return e.exists ? { name: doc.data().name, entries: e.data().entries } : null; });
          })).then(function(results) {
            var valid = results.filter(Boolean);
            entriesEl.innerHTML = valid.length
              ? valid.map(function(e) { return '<div style="padding:8px 0;border-bottom:1px solid #222">' + _esc(e.name) + ' — <strong>' + e.entries + '</strong> ' + (e.entries === 1 ? 'entry' : 'entries') + '</div>'; }).join('')
              : '<div style="color:#888;font-size:0.9rem">Shop to earn draw entries!</div>';
          });
        }
      })
      .catch(function(e) { el.innerHTML = '<div style="color:#888">Could not load draws.</div>'; });
  }

  /* ================================================================
     ENTERPRISE v1.0 — PREFLIGHT CHECK (for POS integration)
  ================================================================ */
  function preflightCheck(opts) {
    if (!_uid || !opts.merchantId || !opts.total) return Promise.resolve(null);
    return _call('loyaltyPreflightCheck', {
      uid: _uid, merchantId: opts.merchantId, total: opts.total,
      items: opts.items || [], redeemPoints: opts.redeemPoints || 0
    }).then(function(res) { return res.data; })
      .catch(function(e) { console.warn('[SokoniLoyalty] preflight:', e); return null; });
  }

  /* ================================================================
     ENTERPRISE v1.0 — MEMBERSHIP BENEFITS
  ================================================================ */
  function loadMembershipBenefits() {
    if (!_uid) return;
    var el = document.getElementById('loyMembershipBenefits');
    if (!el) return;
    _call('getMembershipBenefits', { uid: _uid })
      .then(function(res) {
        var d = res.data || {};
        var benefits = d.benefits || {};
        var items = Object.keys(benefits).filter(function(k) { return benefits[k] === true; })
          .map(function(k) { return '<li>✓ ' + _esc(k.replace(/([A-Z])/g, ' $1').trim()) + '</li>'; }).join('');
        el.innerHTML = '<div style="font-weight:600;text-transform:capitalize;margin-bottom:8px">' + _esc(d.tier || '') + ' Benefits</div>' +
          '<ul style="list-style:none;padding:0;margin:0 0 12px;color:#ccc">' + (items || '<li>Basic benefits</li>') + '</ul>' +
          (d.nextTier ? '<div style="color:#888;font-size:0.85rem">' + _fmt(d.pointsToNextTier) + ' pts to ' + _esc(d.nextTier) + '</div>'
                      : '<div style="color:#B9F2FF;font-size:0.85rem">Maximum tier achieved! 💠</div>');
      })
      .catch(function(e) { console.warn('[SokoniLoyalty] benefits:', e.message); });
  }

  /* ================================================================
     PUBLIC API
  ================================================================ */
  return {
    init:               init,
    loadAccount:        loadAccount,
    loadCard:           loadCard,
    loadRewards:        loadRewards,
    loadHistory:        loadHistory,
    loadTiers:          loadTiers,
    loadDraws:          loadDraws,
    initTabs:           initTabs,
    initRedeemSlider:   initRedeemSlider,
    createAccount:      createAccount,
    redeemPoints:       redeemPoints,
    redeemReward:       redeemReward,
    redeemCashback:     redeemCashback,
    checkGiftCard:      checkGiftCard,
    switchTab:          switchTab,
    preflightCheck:     preflightCheck,
    loadMembershipBenefits: loadMembershipBenefits,
    renderAccount:  renderAccount,
    renderCard:     renderCard,
    renderRewards:  renderRewards,
    renderHistory:  renderHistory,
    renderTiers:    renderTiers,
    toast:          toast,
    fmt:            _fmt,
    esc:            _esc
  };

})();
