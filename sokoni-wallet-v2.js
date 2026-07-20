
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

        /* Update avatar */
        const av = document.getElementById('wal-top-avatar');
        if (av) av.textContent = (_userName[0] || '?').toUpperCase();

        await loadDashboard();
        await checkSellerStatus();
      });
    } catch (e) {
      console.error('[WalletV2] init error', e);
    }
  }

  /* ─── DASHBOARD ─── */
  async function loadDashboard() {
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

      /* Sub-balance mini cards */
      _setText('savingsTotal', 'KSh ' + _fmtShort(data.savingsBalance || 0));
      _setText('cashbackVal', 'KSh ' + _fmtShort(data.cashbackBalance || 0));
      _setText('rewardPts', (data.rewardPoints || 0) + ' pts');

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
    if (type.includes('topup') || type === 'credit') return { cls: 'in', icon: 'fa-arrow-down-left', emoji: null };
    if (type === 'send') return { cls: 'out', icon: 'fa-paper-plane', emoji: null };
    if (type === 'receive') return { cls: 'in', icon: 'fa-arrow-down', emoji: null };
    if (type.includes('savings')) return { cls: 'save', icon: 'fa-piggy-bank', emoji: null };
    if (type.includes('escrow')) return { cls: 'escrow', icon: 'fa-lock', emoji: null };
    if (type === 'payout') return { cls: 'out', icon: 'fa-arrow-up-right', emoji: null };
    if (dir === 'in') return { cls: 'in', icon: 'fa-arrow-down-left', emoji: null };
    return { cls: 'out', icon: 'fa-arrow-up-right', emoji: null };
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
      el.innerHTML = '<div class="empty-state"><i class="fas fa-receipt"></i><h4>No transactions</h4><p>Your transaction history will appear here</p></div>';
      return;
    }

    const limit = compact ? 5 : txs.length;
    const items = txs.slice(0, limit);

    el.innerHTML = items.map(tx => {
      const { cls, icon } = _txIcon(tx);
      const isIn = cls === 'in' || cls === 'save';
      const amt = Math.abs(tx.amount || 0);
      const sign = isIn ? '+' : '−';
      const amtCls = isIn ? 'in' : (cls === 'escrow' ? '' : 'out');
      const time = _relativeTime(tx.createdAt);
      const title = _txTitle(tx);
      const note = tx.note || tx.description || tx.category || '';
      return `<div class="tx-item" onclick="W2.openTxDetail(${_esc(JSON.stringify(tx))})">
        <div class="tx-icon ${_esc(cls)}"><i class="fas ${_esc(icon)}"></i></div>
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
      if (s.status === 'confirmed') {
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

    try {
      /* Look up user via CF (walletV2Send will also validate — this is just UX preview) */
      const normPhone = _normalizePhone(phone);
      const { getFirestore, collection, query, where, limit, getDocs } = await import(
        'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
      );
      const db = getFirestore(window.firebaseApp);
      const q = query(collection(db, 'users'), where('phone', '==', normPhone), limit(1));
      const snap = await getDocs(q);

      document.getElementById('sndStep1Searching').style.display = 'none';

      if (snap.empty) {
        document.getElementById('sndNotFound').style.display = 'block';
        document.getElementById('sndStep1Next').disabled = true;
        _sendRecipient = null;
      } else {
        const user = snap.docs[0].data();
        if (snap.docs[0].id === _uid) {
          toast('You cannot send money to yourself', 'error');
          document.getElementById('sndNotFound').style.display = 'block';
          document.getElementById('sndStep1Next').disabled = true;
          _sendRecipient = null;
          return;
        }
        _sendRecipient = {
          uid: snap.docs[0].id,
          name: user.displayName || user.name || 'SOKONI User',
          phone: normPhone
        };
        const av = document.getElementById('sndAvatar');
        if (av) av.textContent = (_sendRecipient.name[0] || '?').toUpperCase();
        _setText('sndName', _sendRecipient.name);
        _setText('sndPhoneDisp', '+' + normPhone);
        document.getElementById('sndContactCard').style.display = 'flex';
        document.getElementById('sndStep1Next').disabled = false;
      }
    } catch (e) {
      document.getElementById('sndStep1Searching').style.display = 'none';
      console.error('[wallet] recipient search failed', e);
      toast(_skWhy(e, 'Could not search right now.'), 'error');
    }
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
    const btn = document.getElementById('sndConfirmBtn');
    if (btn) btn.disabled = true;

    try {
      const note = document.getElementById('sndNote')?.value?.trim() || '';
      const fn = await _cf('walletV2Send');
      const res = await fn({ phone: _sendRecipient.phone, amount: _sendAmount, note });
      const d = res.data;
      if (d.success) {
        /* Update dashboard cache */
        if (_dashboard) _dashboard.balance = d.newBalance;
        _setText('balVal', _fmt(d.newBalance));
        _setText('wdrAvail', 'KSh ' + _fmt(d.newBalance));
        const msgEl = document.getElementById('sndSuccessMsg');
        if (msgEl) msgEl.textContent = 'KSh ' + _fmt(_sendAmount) + ' sent to ' + _sendRecipient.name;
        sendGoStep(4);
        toast('Sent KSh ' + _fmt(_sendAmount) + ' to ' + _sendRecipient.name, 'success');
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
  function openWithdraw() {
    _setText('wdrAvail', 'KSh ' + _fmt(_dashboard?.balance || 0));
    openOverlay('ovlWithdraw');
  }

  function wdrMethodChange() {
    const method = document.getElementById('wdrMethod')?.value;
    document.getElementById('wdrMpesaFields').style.display = method === 'mpesa' ? '' : 'none';
    document.getElementById('wdrBankFields').style.display  = method === 'bank'  ? '' : 'none';
  }

  async function requestPayout() {
    const amt    = Number(document.getElementById('wdrAmount')?.value);
    const method = document.getElementById('wdrMethod')?.value || 'mpesa';
    if (!amt || amt < 100) return toast('Minimum withdrawal is KSh 100', 'error');
    if (amt > (_dashboard?.balance || 0)) return toast('Insufficient balance', 'error');

    let payload = { amount: amt, method };
    if (method === 'mpesa') {
      const phone = document.getElementById('wdrPhone')?.value?.trim();
      if (!PHONE_RE.test(phone)) return toast('Enter a valid M-Pesa number', 'error');
      payload.accountNumber = _normalizePhone(phone);
    } else {
      payload.accountNumber = document.getElementById('wdrAccNum')?.value?.trim();
      payload.bankName      = document.getElementById('wdrBank')?.value?.trim();
      if (!payload.accountNumber || !payload.bankName) return toast('Enter account and bank details', 'error');
    }

    try {
      const fn = await _cf('requestSellerPayout');
      const res = await fn(payload);
      if (res.data?.success) {
        toast('Payout requested! Processing within 24h.', 'success');
        closeOverlay('ovlWithdraw');
        loadDashboard();
      } else {
        toast(res.data?.message || 'Payout request failed', 'error');
      }
    } catch (e) {
      toast(e.message || 'Payout request failed. Try again.', 'error');
    }
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

  function qrScan() {
    toast('Point camera at a SOKONI QR code to pay', 'default', 4000);
    /* Camera scanning requires getUserMedia + QR decode library — see WALLET_V2_ARCHITECTURE.md */
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
    openWithdraw, wdrMethodChange, requestPayout,
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
    /* QR */
    qrTabSwitch, qrUpdateAmount, qrGenerate, qrShare, qrDownload, qrScan,
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
