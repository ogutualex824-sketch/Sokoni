
/* Turn a caught error into advice that matches its cause. Blaming the
   connection for a permission failure sends people to reboot a router while the
   real answer sits unread in the exception. */
function _skWhy(e, fallback) {
  var c = String((e && (e.code || e.name)) || '').replace(/^functions\//, '');
  if (/permission-denied/.test(c)) return 'You do not have access to do that.';
  if (/unauthenticated/.test(c))   return 'Your session expired. Sign in again.';
  if (/not-found/.test(c))         return 'That item no longer exists.';
  if (/unavailable|deadline-exceeded/.test(c)) return 'Server did not respond. Worth retrying.';
  if (/failed-precondition/.test(c)) return 'Something needs setting up first.';
  return fallback + (c ? ' (' + c + ')' : '');
}

/**
 * sokoni-wallet-v2.js — SOKONI Wallet 2.0 Client SDK
 *
 * Architecture:
 *   - IIFE exposed as window.SokoniWalletV2
 *   - Auth-gated: redirects unauthenticated users to login.html
 *   - All UI writes via _esc() — XSS prevention
 *   - All CF calls via _cf() — lazy Firebase Functions SDK
 *   - Backward compatible: v1 flows (top-up, payout) use same CF names
 *
 * V1 CF calls (unchanged):
 *   initiateWalletTopUp, confirmWalletTopUp, getWalletTransactions,
 *   requestSellerPayout, getPayoutHistory
 *
 * V2 CF calls (new from wallet-engine.js):
 *   walletV2Dashboard, walletV2Send, walletV2Request, walletV2SavingsList,
 *   walletV2SavingsCreate, walletV2SavingsDeposit, walletV2SavingsWithdraw,
 *   walletV2SetPin, walletV2FreezeToggle, walletV2SetLimits,
 *   walletV2Analytics, walletV2GenerateQR, walletV2AiInsights
 */

window.SokoniWalletV2 = (function () {
  'use strict';

  /* ─── CONSTANTS ─── */
  const CF_REGION        = 'us-central1';
  const POLL_INTERVAL_MS = 3000;
  const MIN_SEND         = 10;        // KES — matches backend MIN_SEND (P2P minimum)
  const MAX_POLL_SECS    = 90;
  const PHONE_RE         = /^(?:254|\+254|0)[17]\d{8}$/;
  const TX_PAGE_SIZE     = 25;

  /* ─── STATE ─── */
  let _uid          = null;
  let _userPhone    = null;
  let _userName     = null;
  let _isSeller     = false;
  let _dashboard    = null;      // walletV2Dashboard result cache
  let _txAll        = [];        // full tx list cache
  let _txFilter     = 'all';
  let _txPage       = 1;
  let _txSearch     = '';
  let _pollTimer    = null;
  let _pollStart    = 0;
  let _stkTxId      = null;
  let _stkElapsed   = null;
  let _sendRecipient = null;    // { uid, name, phone }
  let _sendAmount    = 0;
  let _sendAmtStr    = '';
  let _vaults        = [];
  let _activeVaultId = null;
  let _pinBuffer     = '';
  let _pinStage      = 'set';   // 'set' | 'confirm'
  let _pinFirst      = '';
  let _frozen        = false;
  let _reqLinkUrl    = '';
  let _anPeriod      = 'month';
  let _qrMode        = 'static';
  let _qrData        = null;

  /* ─── FIREBASE HELPERS ─── */
  async function _cf(name) {
    const { getFunctions, httpsCallable } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js'
    );
    const fns = getFunctions(window.firebaseApp, CF_REGION);
    return httpsCallable(fns, name);
  }

  /* Invoke a callable with a hard timeout. A callable can hang indefinitely when
     the App Check token fetch stalls (App Check 403s intermittently) — leaving a
     disabled submit button that looks permanently dead. This guarantees the caller
     always resolves/rejects so the button re-enables and the user sees a message. */
  async function _callTimed(name, payload, ms = 20000) {
    const fn = await _cf(name);
    return Promise.race([
      fn(payload),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error('Request timed out — check your connection and try again.')), ms)),
    ]);
  }

  async function _db() {
    if (window.firebaseDB) return window.firebaseDB;
    const { getFirestore } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
    );
    return getFirestore(window.firebaseApp);
  }

  /* ─── SECURITY ─── */
  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function _fmt(n) {
    const v = Number(n) || 0;
    return v.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function _fmtShort(n) {
    const v = Number(n) || 0;
    return v.toLocaleString('en-KE', { maximumFractionDigits: 0 });
  }

  function _normalizePhone(p) {
    let s = String(p).replace(/\s+/g, '');
    if (s.startsWith('+')) s = s.slice(1);
    if (s.startsWith('0')) s = '254' + s.slice(1);
    return s;
  }

  function _relativeTime(ts) {
    const d = ts?.toDate ? ts.toDate() : (ts instanceof Date ? ts : new Date(ts));
    if (isNaN(d)) return '';
    const diff = Date.now() - d.getTime();
    const secs = Math.floor(diff / 1000);
    if (secs < 60) return 'Just now';
    if (secs < 3600) return Math.floor(secs / 60) + 'm ago';
    if (secs < 86400) return Math.floor(secs / 3600) + 'h ago';
    return d.toLocaleDateString('en-KE', { day: 'numeric', month: 'short' });
  }

  /* ─── PANEL NAVIGATION ─── */
  function showPanel(id) {
    document.querySelectorAll('.w-panel').forEach(p => p.classList.remove('active'));
    const panel = document.getElementById(id);
    if (panel) {
      panel.classList.add('active');
      document.getElementById('wal-panels').scrollTop = 0;
    }
    /* Update bottom nav */
    document.querySelectorAll('.wn-btn').forEach(b => b.classList.remove('active'));
    const navMap = {
      panHome: 'navHome', panSend: 'navSend', panQR: 'navQR',
      panHistory: 'navHistory', panMore: 'navMore'
    };
    if (navMap[id]) document.getElementById(navMap[id])?.classList.add('active');

    /* Panel-specific init */
    if (id === 'panHistory' && _txAll.length === 0) loadTransactions();
    if (id === 'panQR') initQR();
    if (id === 'panSend') { sendReset(); }
  }

  /* ─── OVERLAY MANAGEMENT ─── */
  function openOverlay(id) {
    const el = document.getElementById(id);
    if (el) el.classList.add('open');
  }

  function closeOverlay(id) {
    const el = document.getElementById(id);
    if (el) el.classList.remove('open');
  }

  /* ─── TOAST ─── */
  let _toastTimer;
  function toast(msg, type = 'default', ms = 3000) {
    const el = document.getElementById('wal-toast');
    if (!el) return;
    clearTimeout(_toastTimer);
    el.textContent = msg;
    el.className = 'show ' + type;
    _toastTimer = setTimeout(() => { el.className = ''; }, ms);
  }

  /* ─── INIT ─── */
  async function init() {
    try {
      const { getAuth, onAuthStateChanged } = await import(
        'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js'
      );
      const auth = getAuth(window.firebaseApp);
      onAuthStateChanged(auth, async user => {
        if (!user) {
          window.location.href = 'login.html?redirect=wallet.html';
          return;
        }
        _uid = user.uid;
        _userPhone = user.phoneNumber || '';
        _userName  = user.displayName || user.email?.split('@')[0] || 'User';

        /* Prompt phone-less accounts to verify a phone so they can RECEIVE money. */
        _showAddPhoneBanner(!_userPhone);

        /* Update avatar */
        const av = document.getElementById('wal-top-avatar');
        if (av) av.textContent = (_userName[0] || '?').toUpperCase();

        await loadDashboard();
        await checkSellerStatus();

        /* Deep-link from chat's "Send money": open the pay sheet for that contact. */
        try {
          const _pp = new URLSearchParams(location.search);
          const _payUid = _pp.get('pay');
          if (_payUid && _payUid !== _uid) {
            openPayToUid(_payUid, _pp.get('name') || 'this contact');
            history.replaceState(null, '', location.pathname);   // don't reopen on refresh
          }
        } catch (_) {}
      });
    } catch (e) {
      console.error('[WalletV2] init error', e);
    }
  }

  /* ─── DASHBOARD ─── */
  async function loadDashboard() {
    /* Optimistic: paint the last-known balance instantly from cache so the wallet
       doesn't sit blank while it re-syncs; the CF below refreshes it. */
    try { const _cb = localStorage.getItem('_walletBal'); const _be = document.getElementById('balVal'); if (_cb != null && _be && !_be.textContent.trim()) _be.textContent = _fmt(Number(_cb) || 0); } catch (_) {}
    try {
      let data;
      try {
        const fn = await _cf('walletV2Dashboard');
        const res = await fn({});
        data = res.data;
        _dashboard = data;
      } catch (cfErr) {
        /* Fallback to v1 balance if wallet-engine not deployed yet */
        console.warn('[WalletV2] walletV2Dashboard unavailable, falling back to v1', cfErr.message);
        const fn = await _cf('getWalletBalance');
        const res = await fn({});
        data = { balance: res.data.balance || 0, rewardPoints: 0, savingsBalance: 0, cashbackBalance: 0 };
      }

      /* Update balance */
      const balEl = document.getElementById('balVal');
      if (balEl) balEl.textContent = _fmt(data.balance);
      try { localStorage.setItem('_walletBal', String(data.balance || 0)); } catch (_) {}

      /* Sub-balance mini cards */
      _setText('savingsTotal', 'KSh ' + _fmtShort(data.savingsBalance || 0));
      _setText('cashbackVal', 'KSh ' + _fmtShort(data.cashbackBalance || 0));
      _setText('rewardPts', (data.rewardPoints || 0) + ' pts');
      _setText('todayPaidVal', 'KSh ' + _fmtShort(data.todayPaid || 0));
      _setText('monthPaidVal', 'KSh ' + _fmtShort(data.monthPaid || 0));
      _renderPendingPayout();   /* pending-withdrawals indicator */

      /* Keep the "Set PIN / Change PIN" label in sync with whether a PIN exists */
      const _pinBtnL = document.getElementById('pinBtnLabel');
      if (_pinBtnL) _pinBtnL.textContent = data.hasPin ? 'Change PIN' : 'Set PIN';

      /* Freeze badge */
      _frozen = !!data.frozen;
      const fb = document.getElementById('frozenBadge');
      if (fb) fb.style.display = _frozen ? 'flex' : 'none';

      /* Tier badge */
      if (data.tier) {
        const tiers = { bronze: 'tier-bronze', silver: 'tier-silver', gold: 'tier-gold', platinum: 'tier-platinum', diamond: 'tier-diamond' };
        const cls = tiers[data.tier?.toLowerCase()] || '';
        const tb = document.getElementById('balTier');
        if (tb && cls) tb.innerHTML = `<span class="tier-badge ${cls}"><i class="fas fa-medal"></i> ${_esc(data.tier)} Member</span>`;
      }

      /* Recent transactions */
      if (data.last5Transactions) {
        renderTxList(data.last5Transactions, 'recentTxList', true);
      }

      /* Savings vaults preview */
      if (data.savingsVaults) {
        renderSavingsStrip(data.savingsVaults);
        _vaults = data.savingsVaults;
      }

      /* AI insight */
      loadAiInsight();

      /* Limits info */
      if (data.dailyLimit) {
        _setText('limitsDesc', 'Daily: KSh ' + _fmtShort(data.dailyLimit));
      }

      /* Security panel prefill */
      const sl = document.getElementById('secDailyLimit');
      const sm = document.getElementById('secMonthlyLimit');
      if (sl && data.dailyLimit) sl.value = data.dailyLimit;
      if (sm && data.monthlyLimit) sm.value = data.monthlyLimit;

      /* PIN status */
      const pinBtn = document.getElementById('pinBtnLabel');
      if (pinBtn) pinBtn.textContent = data.hasPin ? 'Change PIN' : 'Set PIN';

      /* Freeze toggle state */
      const ft = document.getElementById('freezeToggle');
      if (ft) { if (_frozen) ft.classList.add('on'); else ft.classList.remove('on'); }

      /* Withdraw available */
      _setText('wdrAvail', 'KSh ' + _fmt(data.balance));

    } catch (e) {
      console.error('[WalletV2] loadDashboard error', e);
      _setText('balVal', '—');
    }
  }

  function _setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  /* ─── SELLER CHECK ─── */
  async function checkSellerStatus() {
    try {
      const { getFirestore, collection, query, where, limit, getDocs } = await import(
        'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
      );
      const db = getFirestore(window.firebaseApp);
      const q = query(collection(db, 'shops'), where('sellerUid', '==', _uid), limit(1));
      const snap = await getDocs(q);
      _isSeller = !snap.empty;
      const mc = document.getElementById('merchantCard');
      if (mc) mc.style.display = _isSeller ? 'block' : 'none';
    } catch (e) {
      /* Non-critical */
    }
  }

  /* ─── TRANSACTION RENDERING ─── */
  function _txIcon(tx) {
    const type = tx.type || '';
    const dir  = tx.direction || (tx.amount > 0 ? 'in' : 'out');
    if (type.includes('topup') || type === 'credit') return { cls: 'in', icon: 'fa-arrow-down-left', emoji: '💵' };
    if (type === 'send') return { cls: 'out', icon: 'fa-paper-plane', emoji: '📤' };
    if (type === 'receive') return { cls: 'in', icon: 'fa-arrow-down', emoji: '📥' };
    if (type.includes('savings')) return { cls: 'save', icon: 'fa-piggy-bank', emoji: '🐷' };
    if (type.includes('escrow')) return { cls: 'escrow', icon: 'fa-lock', emoji: '🔒' };
    if (type === 'payout') return { cls: 'out', icon: 'fa-arrow-up-right', emoji: '🏧' };
    if (type === 'refund') return { cls: 'in', icon: 'fa-rotate-left', emoji: '↩️' };
    if (dir === 'in') return { cls: 'in', icon: 'fa-arrow-down-left', emoji: '📥' };
    return { cls: 'out', icon: 'fa-arrow-up-right', emoji: '📤' };
  }

  function _txTitle(tx) {
    const t = tx.type || '';
    if (t === 'send') return 'Sent to ' + _esc(tx.recipientName || tx.toPhone || '—');
    if (t === 'receive') return 'Received from ' + _esc(tx.senderName || tx.fromPhone || '—');
    if (t === 'topup' || t === 'credit') return 'M-Pesa Top-up';
    if (t === 'savings_deposit') return 'To ' + _esc(tx.vaultName || 'Savings Vault');
    if (t === 'savings_withdrawal') return 'From ' + _esc(tx.vaultName || 'Savings Vault');
    if (t === 'payout') return 'Payout to M-Pesa';
    if (t === 'escrow_lock') return 'Escrow hold';
    if (t === 'escrow_release') return 'Escrow released';
    return _esc(tx.description || tx.note || 'Transaction');
  }

  function renderTxList(txs, targetId, compact = false) {
    const el = document.getElementById(targetId);
    if (!el) return;

    if (!txs || txs.length === 0) {
      el.innerHTML = '<div class="empty-state"><div class="empty-emoji">🧾</div><h4>No transactions</h4><p>Your transaction history will appear here</p></div>';
      return;
    }

    const limit = compact ? 5 : txs.length;
    const items = txs.slice(0, limit);

    el.innerHTML = items.map(tx => {
      const { cls, emoji } = _txIcon(tx);
      const isIn = cls === 'in' || cls === 'save';
      const amt = Math.abs(tx.amount || 0);
      const sign = isIn ? '+' : '−';
      const amtCls = isIn ? 'in' : (cls === 'escrow' ? '' : 'out');
      const time = _relativeTime(tx.createdAt);
      const title = _txTitle(tx);
      const note = tx.note || tx.description || tx.category || '';
      return `<div class="tx-item" onclick="W2.openTxDetail(${_esc(JSON.stringify(tx))})">
        <div class="tx-icon ${_esc(cls)} emoji">${emoji}</div>
        <div class="tx-info">
          <div class="tx-name">${title}</div>
          ${note ? `<div class="tx-desc">${_esc(note)}</div>` : ''}
        </div>
        <div class="tx-right">
          <div class="tx-amount ${_esc(amtCls)}">${sign}${_fmt(amt)}</div>
          <div class="tx-time">${_esc(time)}</div>
        </div>
      </div>`;
    }).join('');
  }

  /* ─── LOAD TRANSACTIONS (HISTORY PANEL) ─── */
  async function loadTransactions() {
    try {
      let txs;
      try {
        const fn = await _cf('getWalletTransactions');
        const res = await fn({ limit: 100 });
        txs = res.data.transactions || [];
      } catch (_) {
        txs = [];
      }
      _txAll = txs;
      _txPage = 1;
      applyTxFilter();
      const countEl = document.getElementById('txCountLabel');
      if (countEl) countEl.textContent = txs.length + ' transactions';
    } catch (e) {
      console.error('[WalletV2] loadTransactions', e);
    }
  }

  function filterTx() {
    _txSearch = (document.getElementById('txSearch')?.value || '').toLowerCase();
    applyTxFilter();
  }

  function setTxFilter(btn, filter) {
    _txFilter = filter;
    document.querySelectorAll('#txFilterTabs .ftab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    _txPage = 1;
    applyTxFilter();
  }

  function applyTxFilter() {
    let list = _txAll.slice();
    if (_txFilter === 'in') list = list.filter(t => (t.direction === 'in') || t.amount > 0);
    if (_txFilter === 'out') list = list.filter(t => (t.direction === 'out') || t.amount < 0);
    if (_txFilter === 'savings') list = list.filter(t => (t.type || '').includes('savings'));
    if (_txFilter === 'topup') list = list.filter(t => (t.type || '').includes('topup') || (t.type || '') === 'credit');
    if (_txSearch) {
      list = list.filter(t => {
        const hay = [t.description, t.note, t.type, t.recipientName, t.senderName, t.toPhone, t.fromPhone]
          .filter(Boolean).join(' ').toLowerCase();
        return hay.includes(_txSearch);
      });
    }
    const paged = list.slice(0, _txPage * TX_PAGE_SIZE);
    renderTxList(paged, 'historyTxList', false);
    const lm = document.getElementById('txLoadMore');
    if (lm) lm.style.display = list.length > paged.length ? 'block' : 'none';
  }

  function loadMoreTx() {
    _txPage++;
    applyTxFilter();
  }

  /* ─── SAVINGS STRIP ─── */
  function renderSavingsStrip(vaults) {
    const el = document.getElementById('savingsStrip');
    if (!el) return;
    const cards = (vaults || []).slice(0, 5).map(v => {
      const pct = v.targetAmount ? Math.min(100, Math.round((v.currentAmount / v.targetAmount) * 100)) : null;
      return `<div class="vault-card" onclick="W2.openVaultDetail('${_esc(v.id)}')">
        <div class="vault-emoji">${_esc(v.emoji || '💰')}</div>
        <div class="vault-name">${_esc(v.name)}</div>
        <div class="vault-amount">KSh ${_fmtShort(v.currentAmount || 0)}</div>
        ${pct !== null ? `<div class="vault-progress-bar"><div class="vault-progress-fill" style="width:${pct}%"></div></div><div class="vault-pct">${pct}% of KSh ${_fmtShort(v.targetAmount)}</div>` : ''}
      </div>`;
    }).join('');
    el.innerHTML = cards + `<div class="vault-add-card" onclick="W2.openNewVault()"><i class="fas fa-plus-circle"></i><span>New Vault</span></div>`;
  }

  /* ─── AI INSIGHT ─── */
  async function loadAiInsight() {
    try {
      const fn = await _cf('walletV2AiInsights');
      const res = await fn({});
      const insights = res.data?.insights || [];
      const el = document.getElementById('aiInsightText');
      if (el && insights.length > 0) {
        el.innerHTML = '<strong>💡 KASS Insight:</strong> ' + _esc(insights[0]);
      }
    } catch (e) {
      const el = document.getElementById('aiInsightText');
      if (el) el.innerHTML = '<strong>💡 Tip:</strong> Set a savings goal this week — even KSh 500 adds up!';
    }
  }

  /* ─── ADD MONEY (STK PUSH) ─── */
  function openAddMoney() {
    const phone = document.getElementById('topUpPhone');
    if (phone && !phone.value && _userPhone) {
      phone.value = _userPhone.replace(/^254/, '0');
    }
    document.getElementById('addMoneyBody').style.display = '';
    document.getElementById('stkStatus').classList.remove('show');
    openOverlay('ovlAddMoney');
  }

  function setTopUpAmt(amt) {
    const el = document.getElementById('topUpAmount');
    if (el) el.value = amt;
    document.querySelectorAll('.qa-amt').forEach(b => b.classList.remove('active'));
    event?.target?.classList.add('active');
  }

  async function initiateTopUp() {
    const amtEl = document.getElementById('topUpAmount');
    const phEl  = document.getElementById('topUpPhone');
    const amt   = Number(amtEl?.value);
    const phone = phEl?.value?.trim();

    if (!amt || amt < 10) return toast('Minimum top-up is KSh 10', 'error');
    if (!PHONE_RE.test(phone)) return toast('Enter a valid M-Pesa number', 'error');

    const normPhone = _normalizePhone(phone);
    const btn = document.getElementById('topUpBtn');
    if (btn) btn.disabled = true;

    try {
      const fn = await _cf('initiateWalletTopUp');
      const res = await fn({ amount: amt, phone: normPhone });
      _stkTxId = res.data.txId;
      _showStkStatus(normPhone, amt);
    } catch (e) {
      toast(e.message || 'Could not initiate payment. Try again.', 'error');
      if (btn) btn.disabled = false;
    }
  }

  function _showStkStatus(phone, amt) {
    document.getElementById('addMoneyBody').style.display = 'none';
    const st = document.getElementById('stkStatus');
    st.classList.add('show');
    document.getElementById('stkAnim').style.display = '';
    document.getElementById('stkSuccessIcon').style.display = 'none';
    document.getElementById('stkStatusTitle').textContent = 'Waiting for payment…';
    document.getElementById('stkStatusMsg').textContent = 'Enter your M-Pesa PIN to complete';
    document.getElementById('stkPhoneDisp').textContent = '+' + phone;

    _pollStart = Date.now();
    let elapsed = 0;
    _stkElapsed = setInterval(() => {
      elapsed = Math.floor((Date.now() - _pollStart) / 1000);
      _setText('stkTimer', 'Checking… ' + elapsed + 's');
    }, 1000);

    _pollTimer = setInterval(() => _pollTopUp(amt), POLL_INTERVAL_MS);
  }

  async function _pollTopUp(amt) {
    const elapsed = (Date.now() - _pollStart) / 1000;
    if (elapsed > MAX_POLL_SECS) {
      _stopPoll();
      document.getElementById('stkStatusTitle').textContent = 'Payment timed out';
      document.getElementById('stkStatusMsg').textContent = 'No M-Pesa prompt received. Please try again.';
      document.getElementById('stkAnim').style.display = 'none';
      return;
    }
    try {
      const fn = await _cf('confirmWalletTopUp');
      const res = await fn({ txId: _stkTxId });
      const s = res.data;
      /* confirmWalletTopUp returns 'completed' (matching the webhook/sweep and
         the wallet ledger) — not 'confirmed'. The old string never matched, so
         a successful top-up polled until timeout instead of showing success. */
      if (s.status === 'completed') {
        _stopPoll();
        document.getElementById('stkAnim').style.display = 'none';
        document.getElementById('stkSuccessIcon').style.display = 'flex';
        document.getElementById('stkStatusTitle').textContent = 'KSh ' + _fmt(s.amount || amt) + ' added!';
        document.getElementById('stkStatusMsg').textContent = 'Your wallet balance has been updated.';
        toast('Wallet topped up! KSh ' + _fmt(s.amount || amt), 'success');
        setTimeout(() => {
          closeOverlay('ovlAddMoney');
          loadDashboard();
        }, 2000);
      } else if (s.status === 'failed') {
        _stopPoll();
        document.getElementById('stkStatusTitle').textContent = 'Payment failed';
        document.getElementById('stkStatusMsg').textContent = s.message || 'M-Pesa payment was not completed.';
        document.getElementById('stkAnim').style.display = 'none';
      }
    } catch (_) { /* Poll will retry */ }
  }

  function cancelTopUp() {
    _stopPoll();
    closeOverlay('ovlAddMoney');
  }

  function _stopPoll() {
    clearInterval(_pollTimer); _pollTimer = null;
    clearInterval(_stkElapsed); _stkElapsed = null;
  }

  /* ─── SEND MONEY ─── */
  function sendReset() {
    _sendRecipient = null;
    _sendAmount    = 0;
    _sendAmtStr    = '';
    document.getElementById('sndPhone').value = '';
    document.getElementById('sndContactCard').style.display = 'none';
    document.getElementById('sndNotFound').style.display = 'none';
    document.getElementById('sndStep1Searching').style.display = 'none';
    document.getElementById('sndStep1Next').disabled = true;
    document.getElementById('sndAmtVal').textContent = '0';
    document.getElementById('sndAmtInput').value = '0';
    document.getElementById('sndStep2Next').disabled = true;
    document.getElementById('sndNote').value = '';
    /* Re-enable the confirm button: executeSend() disables it on submit and the success
       path never re-enables it, so a second send inherited a stuck-disabled ("unpressable")
       button. Reset it whenever a new send starts. */
    const _cb = document.getElementById('sndConfirmBtn'); if (_cb) _cb.disabled = false;
    if (document.getElementById('sndAmountDisplay')) document.getElementById('sndAmountDisplay').classList.remove('error');
    sendGoStep(1);
  }

  function sendGoStep(n) {
    document.querySelectorAll('.send-step').forEach(s => s.classList.remove('active'));
    const el = document.getElementById('sndStep' + n);
    if (el) el.classList.add('active');
  }

  async function searchRecipient() {
    const phone = document.getElementById('sndPhone')?.value?.trim();
    if (!phone || phone.length < 9) {
      document.getElementById('sndContactCard').style.display = 'none';
      document.getElementById('sndNotFound').style.display = 'none';
      document.getElementById('sndStep1Next').disabled = true;
      return;
    }
    if (!PHONE_RE.test(phone)) return;

    document.getElementById('sndStep1Searching').style.display = 'block';
    document.getElementById('sndContactCard').style.display = 'none';
    document.getElementById('sndNotFound').style.display = 'none';

    /* The recipient is resolved and validated SERVER-SIDE by walletV2Send. The
       client MUST NOT query the users collection here: firestore.rules restricts
       user reads to your own doc (auth.uid == userId), so the old
       where('phone','==',…) query returned permission-denied — surfaced as
       "You do not have access to do that" — and blocked EVERY transfer. Accept a
       valid Kenyan phone; walletV2Send returns the recipient's real name on
       success, rejects USER_NOT_FOUND, and blocks self-sends. */
    const normPhone = _normalizePhone(phone);
    if (!normPhone) {
      document.getElementById('sndStep1Searching').style.display = 'none';
      document.getElementById('sndNotFound').style.display = 'block';
      document.getElementById('sndStep1Next').disabled = true;
      _sendRecipient = null;
      return;
    }

    /* Resolve the recipient's NAME server-side before confirming (M-Pesa-style), so the
       user sees who they're paying. Read-only + rate-limited (walletV2ResolveRecipient).
       Falls back to the phone number if the lookup is unavailable — the send itself is
       still validated server-side by walletV2Send, so this only affects the label. */
    _sendRecipient = { uid: null, name: '+' + normPhone, phone: normPhone, registered: null };
    let label = '+' + normPhone, sub = 'Confirmed on send';
    try {
      const r = (await _callTimed('walletV2ResolveRecipient', { phone: normPhone }, 8000))?.data || {};
      if (r.self)            { sub = 'This is your own number'; }
      else if (r.registered) { label = r.name || label; sub = '+' + normPhone; _sendRecipient.name = r.name || _sendRecipient.name; _sendRecipient.registered = true; }
      else if (r.canReceive) { sub = 'Not on SOKONI yet — they’ll get an SMS to claim'; _sendRecipient.registered = false; }
    } catch (_) { /* lookup unavailable — keep phone label; server still validates on send */ }

    document.getElementById('sndStep1Searching').style.display = 'none';
    const av = document.getElementById('sndAvatar');
    if (av) av.textContent = (label && label[0] !== '+') ? label[0].toUpperCase() : '👤';
    _setText('sndName', label);
    _setText('sndPhoneDisp', sub);
    document.getElementById('sndContactCard').style.display = 'flex';
    document.getElementById('sndStep1Next').disabled = false;
  }

  function sendStep1Next() {
    if (!_sendRecipient) return;
    _setText('sndToName', _sendRecipient.name);
    sendGoStep(2);
    _updateSndDisplay();
  }

  /* Amount keypad */
  function sndKey(k) {
    if (_sendAmtStr.length >= 8) return;
    if (k === '0' && _sendAmtStr === '') return;
    _sendAmtStr += k;
    _sendAmount = parseInt(_sendAmtStr, 10) || 0;
    _updateSndDisplay();
  }

  function sndKeyDel() {
    _sendAmtStr = _sendAmtStr.slice(0, -1);
    _sendAmount = parseInt(_sendAmtStr, 10) || 0;
    _updateSndDisplay();
  }

  function setSendAmt(n) {
    _sendAmount = n;
    _sendAmtStr = String(n);
    document.querySelectorAll('.quick-amounts .qa-amt').forEach(b => b.classList.remove('active'));
    event?.target?.classList.add('active');
    _updateSndDisplay();
  }

  function _updateSndDisplay() {
    const disp = document.getElementById('sndAmtVal');
    if (disp) disp.textContent = _sendAmount > 0 ? _fmtShort(_sendAmount) : '0';
    const avail = _dashboard?.balance || 0;
    const over  = _sendAmount > avail;
    const d = document.getElementById('sndAmountDisplay');
    if (d) d.classList.toggle('error', over);
    document.getElementById('sndStep2Next').disabled = (_sendAmount < 10 || over);
    document.getElementById('sndAmtInput').value = _sendAmount;
  }

  function sendStep2Next() {
    if (_sendAmount < 10 || !_sendRecipient) return;
    /* Populate confirm screen */
    _setText('confTo', _sendRecipient.name);
    _setText('confPhone', '+' + _sendRecipient.phone);
    const note = document.getElementById('sndNote')?.value?.trim() || '';
    _setText('confNote', note || '—');
    const el = document.getElementById('confAmt');
    if (el) el.textContent = 'KSh ' + _fmt(_sendAmount);
    const after = (_dashboard?.balance || 0) - _sendAmount;
    _setText('confAfter', 'KSh ' + _fmt(after));
    sendGoStep(3);
  }

  async function executeSend() {
    if (!_sendRecipient || _sendAmount < 10) return;
    if (_frozen) return toast('Wallet is frozen. Unfreeze in Security settings.', 'error');
    let pin = null;
    if (_dashboard?.hasPin) {
      pin = await _promptPin('Enter your PIN to send KSh ' + _fmt(_sendAmount));
      if (!pin) return;   // cancelled — don't send
    }
    const btn = document.getElementById('sndConfirmBtn');
    if (btn) btn.disabled = true;

    try {
      const note = document.getElementById('sndNote')?.value?.trim() || '';
      const res = await _callTimed('walletV2Send', { phone: _sendRecipient.phone, amount: _sendAmount, note, pin });
      const d = res.data;
      if (d.success) {
        /* Update dashboard cache */
        if (_dashboard) _dashboard.balance = d.newBalance;
        _setText('balVal', _fmt(d.newBalance));
        _setText('wdrAvail', 'KSh ' + _fmt(d.newBalance));
        const rcptName = d.recipientName || _sendRecipient.name;
        const msgEl = document.getElementById('sndSuccessMsg');
        if (msgEl) msgEl.textContent = 'KSh ' + _fmt(_sendAmount) + ' sent to ' + rcptName;
        sendGoStep(4);
        toast('Sent KSh ' + _fmt(_sendAmount) + ' to ' + rcptName, 'success');
      } else {
        toast(d.error === 'USER_NOT_FOUND' ? 'Recipient not found on SOKONI' : 'Transfer failed', 'error');
        if (btn) btn.disabled = false;
      }
    } catch (e) {
      toast(e.message || 'Transfer failed. Try again.', 'error');
      if (btn) btn.disabled = false;
    }
  }

  /* ─── WITHDRAW / PAYOUT ─── */
  let _wdrIdemKey     = '';
  let _payoutStartedAt = 0;

  function openWithdraw() {
    openOverlay('ovlWithdraw');
    /* Reset to the form view (a prior success may have left the success panel up). */
    const form = document.getElementById('wdrForm');    if (form) form.style.display = '';
    const succ = document.getElementById('wdrSuccess');  if (succ) succ.style.display = 'none';
    _wdrClearError();
    const amtI = document.getElementById('wdrAmount'); if (amtI) amtI.value = '';
    const sum  = document.getElementById('wdrSummary'); if (sum) sum.style.display = 'none';

    /* Fresh idempotency key per withdraw session — reused across retries of THIS
       attempt so a double-tap or timeout-retry can't create two withdrawals. */
    _wdrIdemKey = (_uid || 'anon') + '_' + Date.now();

    /* Prefill the user's own M-Pesa number (most payouts go there). */
    const wp = document.getElementById('wdrPhone');
    if (wp && _userPhone) {
      wp.value = String(_userPhone).replace(/^\+?254/, '0');
      const note = document.getElementById('wdrSavedNote'); if (note) note.style.display = 'block';
    }

    if (_dashboard) {
      const b = _dashboard.balance || 0;
      _setText('wdrAvail', 'KSh ' + _fmt(b));
      _wdrApplyBalanceState(b);
    } else {
      _setText('wdrAvail', 'Loading…');
      loadDashboard().then(() => {
        const b = _dashboard?.balance || 0;
        _setText('wdrAvail', 'KSh ' + _fmt(b));
        _wdrApplyBalanceState(b);
      }).catch(() => {});
    }
  }

  /* Empty-state: below the minimum, hide the fields and show a helpful message. */
  function _wdrApplyBalanceState(bal) {
    const low    = (bal || 0) < 100;
    const empty  = document.getElementById('wdrEmpty');
    const fields = document.getElementById('wdrFields');
    if (empty)  empty.style.display  = low ? 'block' : 'none';
    if (fields) fields.style.display = low ? 'none'  : '';
  }

  function _wdrClearError() {
    const e = document.getElementById('wdrError');
    if (e) { e.style.display = 'none'; e.textContent = ''; }
  }
  function _wdrShowError(msg) {
    const e = document.getElementById('wdrError');
    if (e) { e.textContent = msg; e.style.display = 'block'; }
    console.warn('[payout] error surfaced:', msg);
  }

  /* Live withdrawal summary + button enable/disable as the amount changes. */
  function wdrAmountInput() {
    _wdrClearError();
    const amt = Number(document.getElementById('wdrAmount')?.value) || 0;
    const bal = _dashboard ? (_dashboard.balance || 0) : null;
    const sum = document.getElementById('wdrSummary');
    const btn = document.getElementById('wdrSubmitBtn');
    if (amt > 0) {
      _setText('wsAmount', 'KSh ' + _fmt(amt));
      _setText('wsFee', 'KSh 0');
      _setText('wsReceive', 'KSh ' + _fmt(amt));
      /* Client hint only — the server risk engine is authoritative. KSh 20,000 is the
         default instant ceiling; eligible sellers get it instantly, others 24h. */
      _setText('wsArrival', amt <= 20000 ? '⚡ Instant · 1–3 min' : '⏳ Under review');
      if (sum) sum.style.display = 'block';
    } else if (sum) {
      sum.style.display = 'none';
    }
    const ok = amt >= 100 && (bal == null || amt <= bal);
    if (btn) btn.disabled = !ok;
  }

  function wdrMethodChange() {
    const method = document.getElementById('wdrMethod')?.value;
    document.getElementById('wdrMpesaFields').style.display = method === 'mpesa' ? '' : 'none';
    document.getElementById('wdrBankFields').style.display  = method === 'bank'  ? '' : 'none';
  }

  /* Map any failure to a specific, honest message — never "something went wrong". */
  function _payoutErr(e) {
    const msg  = (typeof e === 'string') ? e : (e && e.message) || '';
    const code = (e && e.code) || '';
    if (!navigator.onLine)                                                        return 'You appear to be offline. Check your connection and try again.';
    if (/timed out|timeout/i.test(msg))                                           return 'The request timed out. Check your connection and try again.';
    if (code === 'unauthenticated' || /unauthenticat|sign ?in|token/i.test(msg))  return 'Your session expired. Please sign in again, then retry.';
    if (code === 'resource-exhausted' || /maximum|per day|too many/i.test(msg))   return msg || 'Payout limit reached. Try again later.';
    if (/insufficient/i.test(msg))                                                return 'Insufficient balance for this payout.';
    if (/minimum/i.test(msg))                                                     return 'Minimum payout is KSh 100.';
    if (/duplicate|already/i.test(msg))                                           return 'This withdrawal was already submitted.';
    return msg || 'Payout failed. Please try again.';
  }

  async function requestPayout() {
    console.log('[payout] button clicked');
    const btn = document.getElementById('wdrSubmitBtn');
    _wdrClearError();

    /* Non-sticking in-flight guard: block rapid double-taps, but auto-recover if the
       prior attempt is >30s old (iOS can suspend a backgrounded promise + its timeout,
       which used to leave the button permanently disabled → "does nothing"). */
    if (btn && btn.dataset.busy === '1' && (Date.now() - _payoutStartedAt) < 30000) {
      console.log('[payout] ignored — already in flight');
      return;
    }

    const amt    = Number(document.getElementById('wdrAmount')?.value);
    const method = document.getElementById('wdrMethod')?.value || 'mpesa';
    const bal    = _dashboard ? (_dashboard.balance || 0) : null;

    if (!amt || amt < 100)         return _wdrShowError('Enter an amount of at least KSh 100.');
    if (bal != null && amt > bal)  return _wdrShowError('Enter an amount between KSh 100 and your available balance (KSh ' + _fmt(bal) + ').');

    const payload = { amount: amt, method, idempotencyKey: _wdrIdemKey || ((_uid || 'anon') + '_' + Date.now()) };
    if (method === 'mpesa') {
      const phone = document.getElementById('wdrPhone')?.value?.trim();
      if (!PHONE_RE.test(phone || '')) { document.getElementById('wdrPhone')?.focus(); return _wdrShowError('Enter the M-Pesa number to receive the payout.'); }
      payload.accountNumber = _normalizePhone(phone);
    } else {
      payload.accountNumber = document.getElementById('wdrAccNum')?.value?.trim();
      payload.bankName      = document.getElementById('wdrBank')?.value?.trim();
      if (!payload.accountNumber || !payload.bankName) return _wdrShowError('Enter your account number and bank name.');
    }
    console.log('[payout] validation passed', { amount: amt, method });

    if (!navigator.onLine) return _wdrShowError('You appear to be offline. Check your connection and try again.');

    /* Instant payouts require a verified PIN — collect it if the user has one set.
       The server decides whether to grant instant; a missing PIN just routes to review. */
    if (_dashboard?.hasPin) {
      const pin = await _promptPin('Enter your PIN to withdraw KSh ' + _fmt(amt));
      if (!pin) return;   // cancelled — don't submit
      payload.pin = pin;
    }

    /* Loading state — "Sending your money…" + spinner, taps blocked. */
    const origLabel = btn ? btn.innerHTML : '';
    if (btn) {
      btn.dataset.busy = '1';
      btn.disabled = true;
      btn.innerHTML = '<span style="display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;vertical-align:-2px;margin-right:8px"></span>Sending your money…';
    }
    _payoutStartedAt = Date.now();
    const _reset = () => { if (btn) { btn.dataset.busy = '0'; btn.disabled = false; btn.innerHTML = origLabel || '🏧 Request Payout'; } };

    try {
      console.log('[payout] request sent', { amount: amt, method, key: payload.idempotencyKey });
      const res = await _callTimed('requestSellerPayout', payload, 25000);
      console.log('[payout] response received', res && res.data);
      const d = (res && res.data) || {};
      if (d.success) {
        const raw  = d.accountNumber || payload.accountNumber || '';
        const acct = raw ? ('0' + String(raw).slice(3)) : 'your account';
        /* Optimistic refresh — no page reload. */
        if (_dashboard) {
          _dashboard.balance       = Math.max(0, (_dashboard.balance || 0) - amt);
          _dashboard.pendingPayout = (_dashboard.pendingPayout || 0) + amt;
        }
        _setText('balVal', _fmt(_dashboard?.balance || 0));
        _renderPendingPayout();
        _wdrRenderSuccess(d, amt, acct);
        const form = document.getElementById('wdrForm');   if (form) form.style.display = 'none';
        const succ = document.getElementById('wdrSuccess'); if (succ) succ.style.display = 'block';
        _wdrIdemKey = '';   // consumed — next withdrawal gets a fresh key
        loadDashboard();    // authoritative refresh
        console.log('[payout] wallet refreshed');
      } else {
        _wdrShowError(_payoutErr(d.message));
      }
    } catch (e) {
      console.error('[payout] error', e);
      _wdrShowError(_payoutErr(e));
    } finally {
      _reset();
    }
  }

  /* Mode-aware success panel: instant (sent + ref + ETA), scheduled, or under review. */
  function _wdrRenderSuccess(d, amt, acct) {
    const mode    = d.mode || 'review';
    const titleEl = document.querySelector('#wdrSuccess h3');
    const emojiEl = document.querySelector('#wdrSuccess > div');
    let title, msg, emoji;
    if (mode === 'instant' || d.status === 'processing') {
      emoji = '✅'; title = 'KSh ' + _fmt(amt) + ' sent successfully';
      msg = 'On its way to ' + acct + '. Expected arrival: ' + (d.estimatedArrival || '1–3 minutes') + '.' +
            (d.reference ? '\nReference: ' + d.reference : '');
    } else if (mode === 'scheduled') {
      emoji = '🗓️'; title = 'Withdrawal scheduled';
      msg = 'KSh ' + _fmt(amt) + ' to ' + acct + ' — processed within 24 hours.';
    } else {
      emoji = '⏳'; title = 'Under review';
      msg = 'KSh ' + _fmt(amt) + ' to ' + acct + '. Approved withdrawals arrive within 24 hours.';
    }
    if (emojiEl) emojiEl.textContent = emoji;
    if (titleEl) titleEl.textContent = title;
    _setText('wdrSuccessMsg', msg);
  }

  /* Pending-withdrawals indicator on the dashboard (shown only when > 0). */
  function _renderPendingPayout() {
    const row = document.getElementById('pendingPayoutRow');
    if (!row) return;
    const p = _dashboard?.pendingPayout || 0;
    if (p > 0) { _setText('pendingPayoutVal', 'KSh ' + _fmt(p)); row.style.display = 'flex'; }
    else row.style.display = 'none';
  }

  /* ─── PAYOUT HISTORY / DETAILS ─── */
  async function openPayouts() {
    openOverlay('ovlPayouts');
    const list = document.getElementById('payoutsList');
    if (list) list.innerHTML = '<p style="text-align:center;color:var(--sub);font-size:13px;padding:20px 0">Loading…</p>';
    try {
      const res = await _callTimed('getPayoutHistory', {}, 20000);
      _renderPayouts(res?.data?.payouts || []);
    } catch (e) {
      if (list) list.innerHTML = '<p style="text-align:center;color:var(--sub);font-size:13px;padding:20px 0">Could not load withdrawals. ' + _esc(e.message || '') + '</p>';
    }
  }

  function _payoutStatusMeta(s) {
    const m = {
      pending:         { t: 'Requested',  c: 'var(--sub)', i: '🕒' },
      approving:       { t: 'Approving',  c: 'var(--sub)', i: '🕒' },
      approved:        { t: 'Approved',   c: 'var(--g)',   i: '✓'  },
      processing:      { t: 'Processing', c: '#f6c945',    i: '⏳' },
      approval_failed: { t: 'Retrying',   c: '#f6c945',    i: '⚠️' },
      paid:            { t: 'Paid',       c: 'var(--g)',   i: '✅' },
      rejected:        { t: 'Rejected',   c: 'var(--red)', i: '✕'  },
      failed:          { t: 'Failed',     c: 'var(--red)', i: '✕'  },
    };
    return m[s] || { t: s || 'Unknown', c: 'var(--sub)', i: '•' };
  }

  function _payoutDate(ts) {
    const secs = ts?._seconds ?? ts?.seconds;
    if (!secs) return '';
    const d = new Date(secs * 1000);
    return d.toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' }) +
           ' · ' + d.toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' });
  }

  function _renderPayouts(payouts) {
    const list = document.getElementById('payoutsList');
    if (!list) return;
    if (!payouts.length) {
      list.innerHTML = '<p style="text-align:center;color:var(--sub);font-size:13px;padding:24px 0">No withdrawals yet.</p>';
      return;
    }
    list.innerHTML = payouts.map((p) => {
      const st = _payoutStatusMeta(p.status);
      return '<div style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:14px;padding:12px 14px">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">' +
          '<span style="font-weight:800;font-size:15px">KSh ' + _fmt(p.amount) + '</span>' +
          '<span style="font-size:12px;font-weight:700;color:' + st.c + '">' + st.i + ' ' + _esc(st.t) + '</span>' +
        '</div>' +
        '<div style="font-size:12px;color:var(--sub);line-height:1.7">' +
          '<div>To ' + _esc(p.destinationMasked || '—') + ' · ' + _esc(String(p.method || '').toUpperCase()) + '</div>' +
          (p.fee ? '<div>Fee KSh ' + _fmt(p.fee) + ' · You receive KSh ' + _fmt(p.netAmount) + '</div>' : '') +
          '<div>' + _esc(_payoutDate(p.createdAt)) + '</div>' +
          (p.intasendRef ? '<div>Ref: ' + _esc(p.intasendRef) + '</div>' : '') +
          '<div style="opacity:.7">ID: ' + _esc(p.id) + '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  /* ─── REQUEST MONEY ─── */
  function openRequest() {
    document.getElementById('reqBody').style.display = '';
    document.getElementById('reqResult').style.display = 'none';
    document.getElementById('reqAmount').value = '';
    document.getElementById('reqNote').value = '';
    openOverlay('ovlRequest');
  }

  async function createRequest() {
    const amt  = Number(document.getElementById('reqAmount')?.value) || undefined;
    const note = document.getElementById('reqNote')?.value?.trim() || undefined;
    try {
      const fn = await _cf('walletV2Request');
      const res = await fn({ amount: amt, note });
      const d = res.data;
      _reqLinkUrl = d.shareLink || '';
      _setText('reqLink', _reqLinkUrl);
      document.getElementById('reqBody').style.display   = 'none';
      document.getElementById('reqResult').style.display = '';
    } catch (e) {
      toast(e.message || 'Could not create request. Try again.', 'error');
    }
  }

  function shareReqLink() {
    if (!_reqLinkUrl) return;
    if (navigator.share) {
      navigator.share({ title: 'Pay me on SOKONI', url: _reqLinkUrl }).catch(() => {});
    } else {
      copyReqLink();
    }
  }

  function copyReqLink() {
    if (!_reqLinkUrl) return;
    navigator.clipboard?.writeText(_reqLinkUrl).then(() => toast('Link copied!', 'success')).catch(() => toast('Copy failed', 'error'));
  }

  /* ─── SAVINGS ─── */
  function openVaultsList() {
    loadVaultsList();
    openOverlay('ovlVaults');
  }

  async function loadVaultsList() {
    try {
      const fn = await _cf('walletV2SavingsList');
      const res = await fn({});
      _vaults = res.data?.vaults || [];
      renderSavingsStrip(_vaults);
      renderVaultsList(_vaults);
    } catch (e) {
      /* Non-critical — vaults may be empty */
    }
  }

  function renderVaultsList(vaults) {
    const el = document.getElementById('vaultsListBody');
    if (!el) return;
    if (!vaults || vaults.length === 0) {
      el.innerHTML = '<div class="empty-state"><i class="fas fa-piggy-bank"></i><h4>No savings vaults</h4><p>Create your first savings goal to get started</p></div>';
      return;
    }
    el.innerHTML = vaults.map(v => {
      const pct = v.targetAmount ? Math.min(100, Math.round((v.currentAmount / v.targetAmount) * 100)) : null;
      return `<div style="background:var(--sur2);border:1px solid var(--bor);border-radius:var(--radius);padding:16px;margin-bottom:10px;cursor:pointer" onclick="W2.openVaultDetail('${_esc(v.id)}')">
        <div style="display:flex;align-items:center;gap:12px">
          <div style="font-size:32px">${_esc(v.emoji || '💰')}</div>
          <div style="flex:1">
            <div style="font-size:15px;font-weight:800">${_esc(v.name)}</div>
            <div style="font-size:22px;font-weight:900;color:var(--g);font-variant-numeric:tabular-nums">KSh ${_fmtShort(v.currentAmount || 0)}</div>
            ${pct !== null ? `<div class="vault-progress-bar" style="margin-top:8px"><div class="vault-progress-fill" style="width:${pct}%"></div></div><div class="vault-pct">${pct}% of KSh ${_fmtShort(v.targetAmount)}</div>` : ''}
          </div>
          <i class="fas fa-chevron-right" style="color:var(--dim)"></i>
        </div>
      </div>`;
    }).join('');
  }

  function openNewVault() {
    document.getElementById('nvEmoji').value = '🏠';
    document.getElementById('nvName').value = '';
    document.getElementById('nvTarget').value = '';
    document.getElementById('nvDeadline').value = '';
    document.getElementById('nvLockToggle').classList.remove('on');
    openOverlay('ovlNewVault');
  }

  function setVaultEmoji(el) {
    const emoji = el.dataset.e;
    document.getElementById('nvEmoji').value = emoji;
    document.querySelectorAll('[onclick^="W2.setVaultEmoji"]').forEach(e => {
      e.style.opacity = e.dataset.e === emoji ? '1' : '0.4';
    });
  }

  async function createVault() {
    const name   = document.getElementById('nvName')?.value?.trim();
    const emoji  = document.getElementById('nvEmoji')?.value || '💰';
    const target = Number(document.getElementById('nvTarget')?.value) || undefined;
    const dead   = document.getElementById('nvDeadline')?.value || undefined;
    const locked = document.getElementById('nvLockToggle')?.classList.contains('on') || false;

    if (!name) return toast('Enter a vault name', 'error');
    if (name.length > 50) return toast('Name too long (max 50 chars)', 'error');

    try {
      const fn = await _cf('walletV2SavingsCreate');
      await fn({ name, emoji, targetAmount: target, deadline: dead, locked });
      toast('Vault "' + name + '" created!', 'success');
      closeOverlay('ovlNewVault');
      loadVaultsList();
    } catch (e) {
      toast(e.message || 'Could not create vault', 'error');
    }
  }

  function openVaultDetail(vaultId) {
    const vault = _vaults.find(v => v.id === vaultId);
    if (!vault) return;
    _activeVaultId = vaultId;
    _setText('vdTitle', vault.name);
    _setText('vdEmoji', vault.emoji || '💰');
    _setText('vdAmount', 'KSh ' + _fmt(vault.currentAmount || 0));
    _setText('vdId', vaultId);
    const d = vault.createdAt?.toDate ? vault.createdAt.toDate() : new Date(vault.createdAt || Date.now());
    _setText('vdCreated', d.toLocaleDateString('en-KE'));
    const pct = vault.targetAmount ? Math.min(100, Math.round((vault.currentAmount / vault.targetAmount) * 100)) : null;
    const fillEl = document.getElementById('vdFill');
    const pctEl  = document.getElementById('vdPct');
    if (fillEl && pct !== null) fillEl.style.width = pct + '%';
    if (pctEl && pct !== null) pctEl.textContent = pct + '% of KSh ' + _fmtShort(vault.targetAmount);
    const tr = document.getElementById('vdTargetRow');
    if (tr) tr.style.display = vault.targetAmount ? '' : 'none';
    _setText('vdTarget', vault.targetAmount ? 'KSh ' + _fmt(vault.targetAmount) : '');
    document.getElementById('vdDepAmt').value = '';
    closeOverlay('ovlVaults');
    openOverlay('ovlVaultDetail');
  }

  async function vaultDeposit() {
    const amt = Number(document.getElementById('vdDepAmt')?.value);
    if (!amt || amt < 1) return toast('Enter deposit amount', 'error');
    if (amt > (_dashboard?.balance || 0)) return toast('Insufficient wallet balance', 'error');
    if (!_activeVaultId) return;
    try {
      const fn = await _cf('walletV2SavingsDeposit');
      const res = await fn({ vaultId: _activeVaultId, amount: amt });
      const d = res.data;
      if (_dashboard) _dashboard.balance = d.newBalance;
      _setText('balVal', _fmt(d.newBalance));
      toast('KSh ' + _fmt(amt) + ' deposited to vault', 'success');
      closeOverlay('ovlVaultDetail');
      loadDashboard();
    } catch (e) {
      toast(e.message || 'Deposit failed', 'error');
    }
  }

  async function vaultWithdraw() {
    const amt = Number(document.getElementById('vdDepAmt')?.value);
    if (!amt || amt < 1) return toast('Enter withdrawal amount', 'error');
    if (!_activeVaultId) return;
    try {
      const fn = await _cf('walletV2SavingsWithdraw');
      const res = await fn({ vaultId: _activeVaultId, amount: amt });
      const d = res.data;
      if (_dashboard) _dashboard.balance = d.newBalance;
      _setText('balVal', _fmt(d.newBalance));
      toast('KSh ' + _fmt(amt) + ' returned to wallet', 'success');
      closeOverlay('ovlVaultDetail');
      loadDashboard();
    } catch (e) {
      toast(e.message || 'Withdrawal failed. Vault may be locked.', 'error');
    }
  }

  /* ─── ANALYTICS ─── */
  function openAnalytics() {
    openOverlay('ovlAnalytics');
    loadAnalytics('month', document.getElementById('anTabMonth'));
  }

  async function loadAnalytics(period, btn) {
    _anPeriod = period;
    document.querySelectorAll('#ovlAnalytics .ftab').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');

    _setText('anIn', 'Loading…');
    _setText('anOut', 'Loading…');
    document.getElementById('anCategories').innerHTML = '<div class="skel" style="height:60px;border-radius:12px;margin-bottom:8px"></div>';

    try {
      const fn = await _cf('walletV2Analytics');
      const res = await fn({ period });
      const d = res.data;
      _setText('anIn', 'KSh ' + _fmt(d.totalIn || 0));
      _setText('anOut', 'KSh ' + _fmt(d.totalOut || 0));
      _drawAnalyticsChart(d.byDay || []);
      _renderCategories(d.byCategory || []);
    } catch (_) {
      _setText('anIn', 'KSh 0.00');
      _setText('anOut', 'KSh 0.00');
      _renderCategories([]);
    }
  }

  function _drawAnalyticsChart(byDay) {
    const canvas = document.getElementById('anChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.offsetWidth || 280;
    const H = 140;
    canvas.width  = W * window.devicePixelRatio;
    canvas.height = H * window.devicePixelRatio;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    canvas.style.width  = W + 'px';
    canvas.style.height = H + 'px';
    ctx.clearRect(0, 0, W, H);

    if (!byDay.length) {
      ctx.fillStyle = '#333';
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No data for this period', W / 2, H / 2);
      return;
    }

    const maxVal = Math.max(...byDay.map(d => Math.max(d.in || 0, d.out || 0)), 1);
    const n = byDay.length;
    const pad = 8;
    const barW = Math.max(4, ((W - pad * 2) / n) - 3);

    byDay.forEach((d, i) => {
      const x = pad + i * ((W - pad * 2) / n);
      /* Out bar (red) */
      const outH = ((d.out || 0) / maxVal) * (H - 20);
      ctx.fillStyle = 'rgba(239,68,68,0.4)';
      ctx.fillRect(x, H - 10 - outH, barW * 0.45, outH);
      /* In bar (green) */
      const inH = ((d.in || 0) / maxVal) * (H - 20);
      ctx.fillStyle = 'rgba(113,255,0,0.5)';
      ctx.fillRect(x + barW * 0.5, H - 10 - inH, barW * 0.45, inH);
    });
  }

  function _renderCategories(cats) {
    const el = document.getElementById('anCategories');
    if (!el) return;
    if (!cats.length) {
      el.innerHTML = '<p style="color:var(--sub);font-size:13px;text-align:center;padding:20px 0">No category data yet</p>';
      return;
    }
    const max = Math.max(...cats.map(c => c.total), 1);
    el.innerHTML = cats.slice(0, 8).map(c => `
      <div style="margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px">
          <span>${_esc(c.category || 'Other')}</span>
          <span style="font-weight:800;font-variant-numeric:tabular-nums">KSh ${_fmtShort(c.total)}</span>
        </div>
        <div style="height:6px;background:var(--bor2);border-radius:4px;overflow:hidden">
          <div style="height:100%;background:var(--g);border-radius:4px;width:${Math.round((c.total/max)*100)}%"></div>
        </div>
      </div>`).join('');
  }

  /* ─── SECURITY ─── */
  function openSecurity() {
    const ft = document.getElementById('freezeToggle');
    if (ft) { if (_frozen) ft.classList.add('on'); else ft.classList.remove('on'); }
    openOverlay('ovlSecurity');
  }

  async function toggleFreeze() {
    const newState = !_frozen;
    try {
      const fn = await _cf('walletV2FreezeToggle');
      await fn({ freeze: newState });
      _frozen = newState;
      const ft = document.getElementById('freezeToggle');
      if (ft) { if (_frozen) ft.classList.add('on'); else ft.classList.remove('on'); }
      const fb = document.getElementById('frozenBadge');
      if (fb) fb.style.display = _frozen ? 'flex' : 'none';
      toast(_frozen ? 'Wallet frozen — no outgoing transfers' : 'Wallet unfrozen', _frozen ? 'error' : 'success');
    } catch (e) {
      toast(e.message || 'Could not update freeze status', 'error');
    }
  }

  async function saveLimits() {
    const daily   = Number(document.getElementById('secDailyLimit')?.value)   || undefined;
    const monthly = Number(document.getElementById('secMonthlyLimit')?.value) || undefined;
    try {
      const fn = await _cf('walletV2SetLimits');
      await fn({ dailyLimit: daily, monthlyLimit: monthly });
      toast('Limits saved', 'success');
      closeOverlay('ovlSecurity');
      loadDashboard();
    } catch (e) {
      toast(e.message || 'Could not save limits', 'error');
    }
  }

  function openLimits() { openSecurity(); }

  /* ─── PIN SETUP ─── */
  function openPinSetup() {
    _pinBuffer = '';
    _pinStage  = 'set';
    _pinFirst  = '';
    _setText('pinSetupTitle', 'Set Wallet PIN');
    _setText('pinSetupSubtitle', 'Choose a 4-digit PIN for your wallet');
    _updatePinDots();
    closeOverlay('ovlSecurity');
    openOverlay('ovlPinSetup');
  }

  function pinKey(k) {
    if (_pinBuffer.length >= 4) return;
    _pinBuffer += k;
    _updatePinDots();
    if (_pinBuffer.length === 4) setTimeout(_onPinComplete, 200);
  }

  function pinKeyDel() {
    _pinBuffer = _pinBuffer.slice(0, -1);
    _updatePinDots();
  }

  function _updatePinDots() {
    const dots = document.querySelectorAll('#pinDots .pin-dot');
    dots.forEach((d, i) => d.classList.toggle('filled', i < _pinBuffer.length));
  }

  async function _onPinComplete() {
    if (_pinStage === 'set') {
      _pinFirst = _pinBuffer;
      _pinBuffer = '';
      _pinStage = 'confirm';
      _setText('pinSetupSubtitle', 'Confirm your PIN');
      _updatePinDots();
    } else {
      if (_pinBuffer !== _pinFirst) {
        toast('PINs do not match. Try again.', 'error');
        _pinBuffer = '';
        _pinFirst  = '';
        _pinStage  = 'set';
        _setText('pinSetupSubtitle', 'Choose a 4-digit PIN for your wallet');
        _updatePinDots();
        return;
      }
      try {
        const fn = await _cf('walletV2SetPin');
        await fn({ pin: _pinBuffer });
        toast('Wallet PIN set successfully', 'success');
        closeOverlay('ovlPinSetup');
        const pinBtn = document.getElementById('pinBtnLabel');
        if (pinBtn) pinBtn.textContent = 'Change PIN';
        _pinBuffer = '';
        _pinFirst  = '';
      } catch (e) {
        toast(e.message || 'Could not set PIN', 'error');
        _pinBuffer = '';
        _updatePinDots();
      }
    }
  }

  /* ─── PIN AUTHORIZATION (verify before a send) ───
     Server enforces the PIN too (walletV2Send → _assertPinOk); this just collects
     it so the user isn't rejected. Resolves the entered PIN, or null if cancelled. */
  let _pinResolve = null;
  function _promptPin(sub) {
    return new Promise((resolve) => {
      _pinResolve = resolve;
      const i = document.getElementById('pinVerifyInput'); if (i) i.value = '';
      _setText('pinVerifySub', sub || 'Authorize this payment');
      openOverlay('ovlPinVerify');
      setTimeout(() => document.getElementById('pinVerifyInput')?.focus(), 120);
    });
  }
  function pinVerifySubmit() {
    const pin = document.getElementById('pinVerifyInput')?.value?.trim();
    if (!/^\d{4}$/.test(pin || '')) return toast('Enter your 4-digit PIN', 'error');
    const r = _pinResolve; _pinResolve = null;
    closeOverlay('ovlPinVerify');
    if (r) r(pin);
  }
  function pinVerifyCancel() {
    const r = _pinResolve; _pinResolve = null;
    closeOverlay('ovlPinVerify');
    if (r) r(null);
  }

  /* ─── QR CODE ─── */
  function qrTabSwitch(mode) {
    _qrMode = mode;
    document.getElementById('qrTabStatic').classList.toggle('active', mode === 'static');
    document.getElementById('qrTabDynamic').classList.toggle('active', mode === 'dynamic');
    document.getElementById('qrAmountRow').style.display = mode === 'dynamic' ? 'flex' : 'none';
    if (mode === 'static') initQR();
  }

  function qrUpdateAmount() { /* Live update handled by qrGenerate */ }

  async function initQR() {
    _setText('qrName', _userName || 'SOKONI User');
    _setText('qrPhone', _userPhone ? '+' + _normalizePhone(_userPhone) : '—');
    await qrGenerate();
  }

  async function qrGenerate() {
    const amt = _qrMode === 'dynamic' ? (Number(document.getElementById('qrAmtInput')?.value) || undefined) : undefined;
    try {
      const fn = await _cf('walletV2GenerateQR');
      const res = await fn({ amount: amt });
      _qrData = res.data;
      _drawQR(_qrData.qrPayload, amt);
    } catch (_) {
      /* Draw a placeholder QR on error */
      _drawQR(JSON.stringify({ uid: _uid, v: 2 }), amt);
    }
  }

  function _drawQR(payload, amount) {
    const canvas = document.getElementById('qrCanvas');
    if (!canvas) return;
    const SIZE = 220;
    const DPR  = window.devicePixelRatio || 1;
    canvas.width  = SIZE * DPR;
    canvas.height = SIZE * DPR;
    canvas.style.width  = SIZE + 'px';
    canvas.style.height = SIZE + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(DPR, DPR);

    /* White background */
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, SIZE, SIZE);

    /* Generate a deterministic grid from payload hash */
    const hash = _simpleHash(payload);
    const CELLS = 25;
    const cellW = (SIZE - 24) / CELLS;
    const off   = 12;

    /* Draw timing patterns + finder patterns first */
    const reserved = new Set();
    /* Finder pattern positions */
    [[0,0],[0,CELLS-7],[CELLS-7,0]].forEach(([r,c]) => {
      for (let dr = 0; dr < 7; dr++) for (let dc = 0; dc < 7; dc++) reserved.add(`${r+dr},${c+dc}`);
    });
    /* Timing */
    for (let i = 8; i < CELLS - 8; i++) { reserved.add(`6,${i}`); reserved.add(`${i},6`); }

    /* Data cells from hash */
    for (let r = 0; r < CELLS; r++) {
      for (let c = 0; c < CELLS; c++) {
        if (reserved.has(`${r},${c}`)) continue;
        const bit = (hash[(r * CELLS + c) % hash.length].charCodeAt(0) + r * c) % 3 === 0;
        if (bit) {
          ctx.fillStyle = '#050505';
          ctx.fillRect(off + c * cellW, off + r * cellW, cellW - 1, cellW - 1);
        }
      }
    }

    /* Finder patterns */
    [[0,0],[0,CELLS-7],[CELLS-7,0]].forEach(([r,c]) => {
      ctx.fillStyle = '#050505';
      ctx.fillRect(off + c * cellW, off + r * cellW, 7 * cellW, 7 * cellW);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(off + (c+1) * cellW, off + (r+1) * cellW, 5 * cellW, 5 * cellW);
      ctx.fillStyle = '#050505';
      ctx.fillRect(off + (c+2) * cellW, off + (r+2) * cellW, 3 * cellW, 3 * cellW);
    });

    /* SOKONI logo in center */
    const logoSize = SIZE * 0.16;
    const logoX = (SIZE - logoSize) / 2;
    const logoY = (SIZE - logoSize) / 2;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(logoX - 4, logoY - 4, logoSize + 8, logoSize + 8);
    ctx.fillStyle = '#050505';
    const r = 4;
    ctx.beginPath();
    ctx.roundRect(logoX, logoY, logoSize, logoSize, r);
    ctx.fill();
    ctx.fillStyle = '#71ff00';
    ctx.font = `bold ${Math.round(logoSize * 0.55)}px 'Segoe UI',sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('S', SIZE / 2, SIZE / 2 + 1);

    /* Amount overlay */
    if (amount) {
      ctx.fillStyle = 'rgba(0,0,0,0.85)';
      ctx.fillRect(0, SIZE - 34, SIZE, 34);
      ctx.fillStyle = '#71ff00';
      ctx.font = `bold ${16}px 'Segoe UI',sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('KSh ' + _fmtShort(amount), SIZE / 2, SIZE - 17);
    }
  }

  function _simpleHash(str) {
    let s = '';
    for (let i = 0; i < Math.max(32, str.length); i++) {
      s += String.fromCharCode((str.charCodeAt(i % str.length) * 37 + i * 13) % 94 + 33);
    }
    return s;
  }

  async function qrShare() {
    const canvas = document.getElementById('qrCanvas');
    if (!canvas) return;
    try {
      const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
      const file = new File([blob], 'sokoni-wallet-qr.png', { type: 'image/png' });
      if (navigator.share && navigator.canShare({ files: [file] })) {
        await navigator.share({ title: 'Pay ' + _userName + ' on SOKONI', files: [file] });
      } else {
        qrDownload();
      }
    } catch (_) { qrDownload(); }
  }

  function qrDownload() {
    const canvas = document.getElementById('qrCanvas');
    if (!canvas) return;
    const a = document.createElement('a');
    a.download = 'sokoni-wallet-qr.png';
    a.href = canvas.toDataURL('image/png');
    a.click();
  }

  /* ─── SCAN TO PAY ───
     Lets a payer send to a recipient by scanning their "Pay Me" QR — the key path
     for phone-less users, who have no phone to be found by but always have a uid.
     Camera decode uses the native BarcodeDetector (Android Chrome); every other
     device (incl. iPhone Safari, which lacks BarcodeDetector) uses the paste box.
     Payment goes through walletV2Send({ toUid }), reusing all its guards. */
  let _scanStream  = null;
  let _scanTimer   = null;
  let _scanPayload = null;   // { uid, amount|null }

  function qrCopyCode() {
    const code = _qrData?.qrPayload;
    if (!code) return toast('Generate your QR first', 'error');
    try {
      navigator.clipboard.writeText(code);
      toast('Pay code copied — share it so anyone can pay you', 'success');
    } catch (_) {
      toast('Could not copy. Long-press to copy your QR image instead.', 'error');
    }
  }

  async function qrScan() {
    _scanPayload = null;
    const paste = document.getElementById('scanPaste'); if (paste) paste.value = '';
    /* Restore the scanner UI (a prior "pay contact" open may have hidden these) */
    const pg = document.getElementById('scanPasteGroup'); if (pg) pg.style.display = '';
    const amtG = document.getElementById('scanAmtGroup'); if (amtG) amtG.style.display = 'none';
    const amtI = document.getElementById('scanAmt'); if (amtI) amtI.value = '';
    _setText('scanStatus', 'Point your camera at a SOKONI Pay QR');
    openOverlay('ovlScan');
    _startScanCamera();
  }

  /* Open the pay sheet targeting a known uid (e.g. "Send money" from a chat).
     Reuses the scan-to-pay flow: no camera/paste, just the amount + Pay button. */
  function openPayToUid(uid, name) {
    _stopScanCamera();
    _scanPayload = { uid: String(uid), amount: null };
    const cam = document.getElementById('scanCamWrap');   if (cam) cam.style.display = 'none';
    const pg  = document.getElementById('scanPasteGroup'); if (pg)  pg.style.display = 'none';
    const amtG = document.getElementById('scanAmtGroup');  if (amtG) amtG.style.display = '';
    const amtI = document.getElementById('scanAmt');       if (amtI) amtI.value = '';
    _setText('scanStatus', 'Send money to ' + (name || 'this contact'));
    openOverlay('ovlScan');
  }

  async function _startScanCamera() {
    const wrap  = document.getElementById('scanCamWrap');
    const video = document.getElementById('scanVideo');
    if (!('BarcodeDetector' in window) || !navigator.mediaDevices?.getUserMedia) {
      _setText('scanStatus', 'Live scan isn\'t supported on this device — paste the pay code below.');
      return;
    }
    let detector;
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats?.();
      if (formats && !formats.includes('qr_code')) {
        _setText('scanStatus', 'QR scan unsupported here — paste the code below.'); return;
      }
      detector = new window.BarcodeDetector({ formats: ['qr_code'] });
    } catch (_) {
      _setText('scanStatus', 'QR scan unavailable — paste the code below.'); return;
    }
    try {
      _scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    } catch (_) {
      _setText('scanStatus', 'Camera blocked — allow access or paste the pay code below.'); return;
    }
    if (wrap) wrap.style.display = 'block';
    video.srcObject = _scanStream;
    try { await video.play(); } catch (_) {}
    const tick = async () => {
      if (!_scanStream) return;
      try {
        const codes = await detector.detect(video);
        if (codes && codes.length) { _onScanDecoded(codes[0].rawValue); return; }
      } catch (_) {}
      _scanTimer = setTimeout(tick, 350);
    };
    _scanTimer = setTimeout(tick, 400);
  }

  function _stopScanCamera() {
    if (_scanTimer) { clearTimeout(_scanTimer); _scanTimer = null; }
    if (_scanStream) { _scanStream.getTracks().forEach(t => t.stop()); _scanStream = null; }
    const wrap  = document.getElementById('scanCamWrap'); if (wrap) wrap.style.display = 'none';
    const video = document.getElementById('scanVideo'); if (video) video.srcObject = null;
  }

  function _parsePayCode(raw) {
    if (!raw) return null;
    try {
      const o = JSON.parse(String(raw).trim());
      if (o && o.uid) {
        return { uid: String(o.uid), amount: o.amount != null ? Number(o.amount) : null };
      }
    } catch (_) {}
    return null;
  }

  function _acceptScan(parsed) {
    _scanPayload = parsed;
    const amtG = document.getElementById('scanAmtGroup');
    if (parsed.amount && parsed.amount >= MIN_SEND) {
      if (amtG) amtG.style.display = 'none';
      _setText('scanStatus', 'Ready to pay KSh ' + _fmt(parsed.amount));
    } else {
      if (amtG) amtG.style.display = 'block';
      _setText('scanStatus', 'Pay code recognised — enter an amount to send.');
    }
  }

  function _onScanDecoded(raw) {
    _stopScanCamera();
    const parsed = _parsePayCode(raw);
    if (!parsed) { _setText('scanStatus', 'That QR isn\'t a SOKONI pay code.'); return; }
    _acceptScan(parsed);
  }

  function qrScanClose() {
    _stopScanCamera();
    closeOverlay('ovlScan');
  }

  async function qrScanPay() {
    if (!_scanPayload) {
      const parsed = _parsePayCode(document.getElementById('scanPaste')?.value);
      if (!parsed) return toast('Scan or paste a valid SOKONI pay code first', 'error');
      _acceptScan(parsed);
    }
    if (!_scanPayload) return;
    let amount = _scanPayload.amount;
    if (!amount || amount < MIN_SEND) amount = Number(document.getElementById('scanAmt')?.value);
    if (!amount || amount < MIN_SEND) return toast('Enter an amount (min KSh ' + MIN_SEND + ')', 'error');
    if (_frozen) return toast('Wallet is frozen. Unfreeze in Security settings.', 'error');
    if (_dashboard && amount > (_dashboard.balance || 0)) return toast('Insufficient balance', 'error');

    let pin = null;
    if (_dashboard?.hasPin) {
      pin = await _promptPin('Enter your PIN to send KSh ' + _fmt(amount));
      if (!pin) return;   // cancelled — don't send
    }

    const btn = document.getElementById('scanPayBtn');
    if (btn) btn.disabled = true;
    try {
      const res = await _callTimed('walletV2Send', { toUid: _scanPayload.uid, amount, note: 'Wallet payment', pin });
      const d = res.data;
      if (d.success) {
        if (_dashboard) _dashboard.balance = d.newBalance;
        _setText('balVal', _fmt(d.newBalance));
        toast('Sent KSh ' + _fmt(amount) + ' to ' + (d.recipientName || 'recipient'), 'success');
        qrScanClose();
        loadDashboard();
      } else {
        toast(d.error === 'USER_NOT_FOUND' ? 'Recipient not found on SOKONI' : 'Payment failed', 'error');
        if (btn) btn.disabled = false;
      }
    } catch (e) {
      toast(e.message || 'Payment failed. Try again.', 'error');
      if (btn) btn.disabled = false;
    }
  }

  /* ─── ADD PHONE (verify to receive money) ───
     Phone-less accounts (Google/email sign-ups) can't be found by senders. This
     links a Firebase-verified phone to the account via linkWithPhoneNumber, then
     walletV2SavePhone persists only the token-verified number. Firebase enforces
     one phone per account, so nobody can claim a number they don't control. */
  let _apStage    = 'send';
  let _apConfirm  = null;
  let _apVerifier = null;

  function _showAddPhoneBanner(show) {
    const b = document.getElementById('addPhoneBanner');
    if (b) b.style.display = show ? 'flex' : 'none';
  }

  function addPhoneOpen() {
    _apStage = 'send';
    _apConfirm = null;
    const pg = document.getElementById('apPhoneGroup'); if (pg) pg.style.display = '';
    const cg = document.getElementById('apCodeGroup');  if (cg) cg.style.display = 'none';
    const btn = document.getElementById('apSubmitBtn'); if (btn) { btn.textContent = '📲 Send code'; btn.disabled = false; }
    openOverlay('ovlAddPhone');
  }

  async function addPhoneSubmit() {
    const btn = document.getElementById('apSubmitBtn');

    if (_apStage === 'send') {
      const raw = document.getElementById('apPhone')?.value?.trim();
      const norm = _normalizePhone(raw);
      if (!norm) return toast('Enter a valid Kenyan phone number', 'error');
      const fullPhone = '+' + norm;
      if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
      try {
        const { getAuth, RecaptchaVerifier, linkWithPhoneNumber } = await import(
          'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js'
        );
        const auth = getAuth(window.firebaseApp);
        if (!auth.currentUser) throw new Error('Please sign in again.');
        if (!_apVerifier) {
          _apVerifier = new RecaptchaVerifier(auth, 'recaptcha-container', { size: 'invisible' });
        }
        _apConfirm = await linkWithPhoneNumber(auth.currentUser, fullPhone, _apVerifier);
        _apStage = 'verify';
        const pg = document.getElementById('apPhoneGroup'); if (pg) pg.style.display = 'none';
        const cg = document.getElementById('apCodeGroup');  if (cg) cg.style.display = '';
        document.getElementById('apCode')?.focus();
        if (btn) { btn.textContent = '✓ Verify & save'; btn.disabled = false; }
        toast('Code sent to ' + fullPhone, 'success');
      } catch (e) {
        let msg = e.message || 'Could not send code. Try again.';
        if (e.code === 'auth/credential-already-in-use' ||
            e.code === 'auth/account-exists-with-different-credential' ||
            e.code === 'auth/provider-already-linked') {
          msg = 'That number is already linked to a SOKONI account.';
        }
        toast(msg, 'error');
        try { _apVerifier?.clear(); } catch (_) {}
        _apVerifier = null;
        if (btn) { btn.disabled = false; btn.textContent = '📲 Send code'; }
      }
      return;
    }

    /* verify stage */
    const code = document.getElementById('apCode')?.value?.trim();
    if (!code || code.length < 6 || !_apConfirm) return toast('Enter the 6-digit code', 'error');
    if (btn) { btn.disabled = true; btn.textContent = 'Verifying…'; }
    try {
      await _apConfirm.confirm(code);   /* links & verifies the phone on the account */
      const { getAuth } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
      const auth = getAuth(window.firebaseApp);
      await auth.currentUser.getIdToken(true);   /* refresh so the token carries phone_number */
      const res = await _callTimed('walletV2SavePhone', {});
      if (res.data?.success) {
        _userPhone = String(res.data.phone || '').replace(/^\+/, '');
        _showAddPhoneBanner(false);
        closeOverlay('ovlAddPhone');
        toast('Phone verified — people can now send you money', 'success');
      } else {
        toast('Could not save your phone. Try again.', 'error');
        if (btn) { btn.disabled = false; btn.textContent = '✓ Verify & save'; }
      }
    } catch (e) {
      let msg = e.message || 'Wrong or expired code. Try again.';
      if (e.code === 'auth/invalid-verification-code') msg = 'Wrong code. Check your SMS and try again.';
      if (e.code === 'auth/code-expired')             msg = 'Code expired. Tap Send code again.';
      toast(msg, 'error');
      if (btn) { btn.disabled = false; btn.textContent = '✓ Verify & save'; }
    }
  }

  /* ─── MERCHANT WALLET ─── */
  function openMerchantWallet() {
    openWithdraw();
  }

  /* ─── SPLIT BILL (stub — opens request flow) ─── */
  function openSplit() {
    toast('Split bill coming soon! Use Request Money for now.', 'default', 4000);
  }

  /* ─── TRANSACTION DETAIL ─── */
  function openTxDetail(tx) {
    if (typeof tx === 'string') {
      try { tx = JSON.parse(tx); } catch (_) { return; }
    }
    const { cls, icon } = _txIcon(tx);
    const isIn  = cls === 'in';
    const amt   = Math.abs(tx.amount || 0);
    const sign  = isIn ? '+' : '−';
    const color = isIn ? 'var(--g)' : (cls === 'out' ? 'var(--red)' : 'var(--txt)');

    const iconEl = document.getElementById('txdIcon');
    if (iconEl) {
      iconEl.className = 'tx-icon ' + cls;
      iconEl.style.cssText = 'width:64px;height:64px;border-radius:20px;font-size:28px;margin:0 auto 12px';
      iconEl.innerHTML = `<i class="fas ${_esc(icon)}"></i>`;
    }

    const amtEl = document.getElementById('txdAmount');
    if (amtEl) {
      amtEl.style.color = color;
      amtEl.textContent = sign + 'KSh ' + _fmt(amt);
    }

    const statusEl = document.getElementById('txdStatus');
    if (statusEl) statusEl.textContent = tx.status || 'Completed';

    const rows = document.getElementById('txdRows');
    if (!rows) return;
    const fields = [
      ['Type',       tx.type || '—'],
      ['Date',       tx.createdAt ? _relativeTime(tx.createdAt) : '—'],
      ['Reference',  tx.id || tx.txId || '—'],
      ['Note',       tx.note || tx.description || '—'],
      ...(tx.recipientName ? [['To', tx.recipientName]] : []),
      ...(tx.senderName    ? [['From', tx.senderName]]  : []),
      ...(tx.category      ? [['Category', tx.category]] : []),
    ];
    rows.innerHTML = fields.map(([k, v]) => `
      <div class="info-row">
        <span class="k">${_esc(k)}</span>
        <span class="v" style="font-size:13px">${_esc(v)}</span>
      </div>`).join('');

    openOverlay('ovlTxDetail');
  }

  /* ─── PUBLIC API ─── */
  const API = {
    init, showPanel, openOverlay, closeOverlay, toast,
    /* Dashboard */
    loadDashboard,
    /* Top-up */
    openAddMoney, setTopUpAmt, initiateTopUp, cancelTopUp,
    /* Send */
    sendReset, sendGoStep, searchRecipient,
    sendStep1Next, sendStep2Next, executeSend,
    sndKey, sndKeyDel, setSendAmt,
    /* Withdraw */
    openWithdraw, wdrMethodChange, requestPayout, wdrAmountInput, openPayouts,
    /* Request */
    openRequest, createRequest, shareReqLink, copyReqLink,
    /* Savings */
    openVaultsList, openNewVault, setVaultEmoji, createVault,
    openVaultDetail, vaultDeposit, vaultWithdraw,
    /* Analytics */
    openAnalytics, loadAnalytics,
    /* Security */
    openSecurity, toggleFreeze, saveLimits, openLimits,
    /* PIN */
    openPinSetup, pinKey, pinKeyDel,
    pinVerifySubmit, pinVerifyCancel,
    /* QR */
    qrTabSwitch, qrUpdateAmount, qrGenerate, qrShare, qrDownload, qrScan,
    qrCopyCode, qrScanClose, qrScanPay,
    /* Add phone */
    addPhoneOpen, addPhoneSubmit,
    /* Merchant */
    openMerchantWallet,
    /* Split */
    openSplit,
    /* History */
    loadTransactions, filterTx, setTxFilter, loadMoreTx,
    /* TX detail */
    openTxDetail,
  };

  /* Notify page script */
  window.dispatchEvent(new CustomEvent('sokoniWalletV2Ready'));

  return API;
})();
