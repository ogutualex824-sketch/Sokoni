/**
 * sokoni-wallet.js — SOKONI Wallet & Seller Payouts Module  v1.0
 *
 * Architecture:
 *   • IIFE exposed as window.SokoniWallet
 *   • Auth-gated: redirects unauthenticated users to login.html
 *   • All UI writes go through _esc() to prevent XSS
 *   • All Cloud Function calls through _cf() — lazy-loads Firebase Functions SDK
 *   • M-Pesa top-up: initiates STK via CF → polls confirmWalletTopUp every 3 s / max 90 s
 *   • Seller detection: Firestore shops collection query (limit 1)
 *   • Phone normalisation: 0XXXXXXXXX / +254XXXXXXXXX → 254XXXXXXXXX
 *   • Account numbers masked to last 4 digits in transaction list
 *
 * Cloud Functions consumed:
 *   getWalletBalance        ({})                         → { balance, lastTopUp }
 *   initiateWalletTopUp     ({ amount, phone })          → { txId, message }
 *   confirmWalletTopUp      ({ txId })                   → { status, balance?, amount? }
 *   getWalletTransactions   ({})                         → { transactions }
 *   requestSellerPayout     ({ amount, method,
 *                              accountNumber,
 *                              bankCode?, bankName? })   → { success, message }
 *   getPayoutHistory        ({})                         → { payouts }
 *
 * Security notes:
 *   • Never trusts client-side payment confirmation — status resolved server-side only
 *   • Amount and phone validated before any CF call
 *   • Phone normalised server-side as well; we send canonical 254XXXXXXXXX form
 *   • Balance displayed is read from CF, never from localStorage
 */

window.SokoniWallet = (function () {
  'use strict';

  /* ─────────────────────────────────────────────
     CONSTANTS
  ───────────────────────────────────────────── */
  const CF_REGION        = 'us-central1';
  const POLL_INTERVAL_MS = 3000;
  const MAX_POLL_SECS    = 90;
  const PHONE_RE         = /^(?:254|\+254|0)[17]\d{8}$/;
  const TX_PAGE_SIZE     = 20;

  /* ─────────────────────────────────────────────
     STATE
  ───────────────────────────────────────────── */
  let _uid        = null;
  let _isSeller   = false;
  let _pendingTxId = null;
  let _pollInterval = null;
  let _pollStart  = 0;
  let _elapsedTimer = null;
  let _txAll      = [];          // full transaction cache
  let _txFilter   = 'all';      // 'all' | 'credit' | 'debit'
  let _txPage     = 1;          // pagination cursor
  let _payoutsLoaded = false;   // lazy-load flag for payouts history

  /* ─────────────────────────────────────────────
     FIREBASE HELPERS
  ───────────────────────────────────────────── */

  /**
   * Return a callable Cloud Function reference (lazy-loads SDK).
   * Usage: const result = await _cf('myFunction')({ key: value });
   */
  async function _cf(name) {
    const { getFunctions, httpsCallable } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js'
    );
    const fns = getFunctions(window.firebaseApp, CF_REGION);
    return httpsCallable(fns, name);
  }

  /** Lazy Firestore reference */
  async function _db() {
    if (window.firebaseDB) return window.firebaseDB;
    const { getFirestore } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
    );
    return getFirestore(window.firebaseApp);
  }

  /* ─────────────────────────────────────────────
     XSS GUARD  — all untrusted data goes through here
  ───────────────────────────────────────────── */
  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* ─────────────────────────────────────────────
     NUMBER FORMATTING
  ───────────────────────────────────────────── */
  function _fmt(n) {
    const v = Number(n) || 0;
    return v.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  /** Mask account number: show only last 4 chars, rest as * */
  function _maskAccount(s) {
    s = String(s || '');
    if (s.length <= 4) return s;
    return '*'.repeat(s.length - 4) + s.slice(-4);
  }

  /* ─────────────────────────────────────────────
     PHONE VALIDATION & NORMALISATION
  ───────────────────────────────────────────── */
  function _normalisePhone(raw) {
    const s = String(raw || '').replace(/\s+/g, '');
    if (!PHONE_RE.test(s)) return null;
    if (s.startsWith('+254')) return '254' + s.slice(4);
    if (s.startsWith('254'))  return s;
    if (s.startsWith('0'))    return '254' + s.slice(1);
    return null;
  }

  /* ─────────────────────────────────────────────
     TOAST
  ───────────────────────────────────────────── */
  function toast(msg, type) {
    const container = document.getElementById('walToasts');
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'wal-toast' + (type ? ' ' + type : '');
    el.textContent = String(msg || '');
    container.appendChild(el);
    setTimeout(() => {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 3200);
  }

  /* ─────────────────────────────────────────────
     AUTH GATE
  ───────────────────────────────────────────── */
  function _getUid() {
    // Prefer window.firebaseUser set by auth.js / firebase.js
    if (window.firebaseUser && window.firebaseUser.uid) return window.firebaseUser.uid;
    // Fallback: localStorage token set by auth.js
    try {
      const u = JSON.parse(localStorage.getItem('sokoniUser') || 'null');
      return u && u.uid ? u.uid : null;
    } catch (_) { return null; }
  }

  function _requireAuth() {
    const uid = _getUid();
    if (!uid) {
      window.location.href = 'login.html?redirect=wallet.html';
      return null;
    }
    return uid;
  }

  /* ─────────────────────────────────────────────
     SELLER DETECTION
     Checks shops collection for a document where sellerUid == uid.
  ───────────────────────────────────────────── */
  async function _detectSeller(uid) {
    try {
      const { collection, query, where, limit, getDocs } = await import(
        'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
      );
      const db = await _db();
      const q = query(
        collection(db, 'shops'),
        where('sellerUid', '==', uid),
        limit(1)
      );
      const snap = await getDocs(q);
      return !snap.empty;
    } catch (_) {
      return false;
    }
  }

  /* ─────────────────────────────────────────────
     BALANCE CARD
  ───────────────────────────────────────────── */
  function renderBalance(data) {
    const balEl = document.getElementById('walBalance');
    if (balEl) {
      balEl.innerHTML =
        '<span class="wal-balance-currency">KSh</span>' +
        _esc(_fmt(data.balance));
    }
    const lastEl = document.getElementById('walLastTopUp');
    if (lastEl) {
      if (data.lastTopUp) {
        const d = data.lastTopUp.toDate
          ? data.lastTopUp.toDate()
          : new Date(data.lastTopUp);
        lastEl.textContent = 'Last top-up: ' +
          d.toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' });
      } else {
        lastEl.textContent = '';
      }
    }
  }

  async function loadBalance() {
    try {
      const fn = await _cf('getWalletBalance');
      const res = await fn({});
      if (res && res.data) renderBalance(res.data);
    } catch (e) {
      console.warn('[SokoniWallet] loadBalance error:', e);
    }
  }

  /* ─────────────────────────────────────────────
     TRANSACTIONS
  ───────────────────────────────────────────── */
  function renderTransactions(txs) {
    const list = document.getElementById('walTxList');
    const moreWrap = document.getElementById('walTxLoadMore');
    if (!list) return;

    if (!txs || txs.length === 0) {
      list.innerHTML =
        '<div class="wal-empty">' +
          '<div class="wal-empty-icon"><i class="fa-solid fa-receipt" style="font-size:36px;opacity:.3"></i></div>' +
          '<p>No transactions yet.<br>Top up to get started.</p>' +
        '</div>';
      if (moreWrap) moreWrap.style.display = 'none';
      return;
    }

    const visible = txs.slice(0, _txPage * TX_PAGE_SIZE);
    list.innerHTML = visible.map(_txRowHtml).join('');

    if (moreWrap) {
      moreWrap.style.display = txs.length > visible.length ? 'block' : 'none';
    }
  }

  function _txRowHtml(tx) {
    const isCredit = tx.type === 'credit' || tx.direction === 'in';
    const iconClass = isCredit ? 'credit' : 'debit';
    const iconGlyph = isCredit
      ? '<i class="fa-solid fa-arrow-down-to-line"></i>'
      : '<i class="fa-solid fa-arrow-up-from-line"></i>';
    const amtClass   = isCredit ? 'credit' : 'debit';
    const amtPrefix  = isCredit ? '+' : '-';
    const desc       = _esc(tx.description || tx.desc || tx.label || 'Transaction');
    const dateStr    = tx.createdAt
      ? _fmtDate(tx.createdAt)
      : (tx.ts ? _fmtDate(tx.ts) : '');
    const statusHtml = tx.status && tx.status !== 'completed'
      ? '<span class="wal-status-badge wal-status-' + _esc(tx.status) + '">' + _esc(tx.status) + '</span>'
      : '';
    return (
      '<div class="wal-tx-row">' +
        '<div class="wal-tx-icon ' + iconClass + '">' + iconGlyph + '</div>' +
        '<div class="wal-tx-body">' +
          '<div class="wal-tx-desc">' + desc + '</div>' +
          '<div class="wal-tx-date">' + _esc(dateStr) + '</div>' +
        '</div>' +
        '<div class="wal-tx-right">' +
          '<div class="wal-tx-amount ' + amtClass + '">' +
            amtPrefix + 'KSh ' + _esc(_fmt(tx.amount)) +
          '</div>' +
          statusHtml +
        '</div>' +
      '</div>'
    );
  }

  function _fmtDate(val) {
    try {
      const d = (val && typeof val.toDate === 'function')
        ? val.toDate()
        : new Date(typeof val === 'number' ? val : val);
      return d.toLocaleDateString('en-KE', { day: '2-digit', month: 'short', year: 'numeric' });
    } catch (_) { return ''; }
  }

  function filterTransactions(f) {
    _txFilter = f;
    _txPage   = 1;

    // Update ARIA + active state
    document.querySelectorAll('#walTxFilter .wal-filter-btn').forEach(btn => {
      const active = btn.dataset.filter === f;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });

    let filtered = _txAll;
    if (f === 'credit') {
      filtered = _txAll.filter(t => t.type === 'credit' || t.direction === 'in');
    } else if (f === 'debit') {
      filtered = _txAll.filter(t => t.type !== 'credit' && t.direction !== 'in');
    }
    renderTransactions(filtered);
  }

  async function loadTransactions() {
    const list = document.getElementById('walTxList');
    if (list) {
      list.innerHTML =
        '<div class="wal-loading">' +
          '<div class="wal-loading-spinner" aria-hidden="true"></div>' +
          '<p>Loading transactions...</p>' +
        '</div>';
    }
    try {
      const fn  = await _cf('getWalletTransactions');
      const res = await fn({});
      _txAll  = (res && res.data && res.data.transactions) ? res.data.transactions : [];
      _txPage = 1;
      filterTransactions(_txFilter);
    } catch (e) {
      console.warn('[SokoniWallet] loadTransactions error:', e);
      if (list) {
        list.innerHTML =
          '<div class="wal-empty">' +
            '<div class="wal-empty-icon"><i class="fa-solid fa-triangle-exclamation" style="font-size:32px;opacity:.4"></i></div>' +
            '<p>Could not load transactions.<br>Check your connection and try again.</p>' +
          '</div>';
      }
    }
  }

  /* ─────────────────────────────────────────────
     PAYOUT HISTORY
  ───────────────────────────────────────────── */
  function renderPayoutHistory(payouts) {
    const list = document.getElementById('walPayoutHistory');
    if (!list) return;

    if (!payouts || payouts.length === 0) {
      list.innerHTML =
        '<div class="wal-empty">' +
          '<div class="wal-empty-icon"><i class="fa-solid fa-money-bill-transfer" style="font-size:34px;opacity:.3"></i></div>' +
          '<p>No payout requests yet.</p>' +
        '</div>';
      return;
    }

    list.innerHTML = payouts.map(p => {
      const method  = p.method === 'bank' ? 'Bank Transfer' : 'M-Pesa';
      const masked  = _maskAccount(p.accountNumber || '');
      const date    = p.createdAt ? _fmtDate(p.createdAt) : '';
      const status  = p.status || 'pending';
      return (
        '<div class="wal-payout-row">' +
          '<div class="wal-payout-icon"><i class="fa-solid fa-paper-plane"></i></div>' +
          '<div class="wal-payout-body">' +
            '<div class="wal-payout-desc">' + _esc(method) + ' — ****' + _esc(masked.slice(-4)) + '</div>' +
            '<div class="wal-payout-meta">' + _esc(date) + '</div>' +
          '</div>' +
          '<div class="wal-payout-right">' +
            '<div class="wal-payout-amount">KSh ' + _esc(_fmt(p.amount)) + '</div>' +
            '<span class="wal-status-badge wal-status-' + _esc(status) + '">' + _esc(status) + '</span>' +
          '</div>' +
        '</div>'
      );
    }).join('');
  }

  async function loadPayoutHistory() {
    const list = document.getElementById('walPayoutHistory');
    if (list) {
      list.innerHTML =
        '<div class="wal-loading">' +
          '<div class="wal-loading-spinner" aria-hidden="true"></div>' +
          '<p>Loading payout history...</p>' +
        '</div>';
    }
    try {
      const fn  = await _cf('getPayoutHistory');
      const res = await fn({});
      renderPayoutHistory((res && res.data && res.data.payouts) ? res.data.payouts : []);
    } catch (e) {
      console.warn('[SokoniWallet] loadPayoutHistory error:', e);
      if (list) {
        list.innerHTML =
          '<div class="wal-empty">' +
            '<p>Could not load payout history. Try again later.</p>' +
          '</div>';
      }
    }
  }

  /* ─────────────────────────────────────────────
     TAB SYSTEM
  ───────────────────────────────────────────── */
  function initTabs() {
    document.querySelectorAll('.wal-tabs .wal-tab').forEach(tab => {
      tab.addEventListener('click', function () {
        _activateTab(this.dataset.tab);
      });
    });

    // Quick-action card buttons
    const btnTopUp = document.getElementById('walBtnTopUp');
    if (btnTopUp) btnTopUp.addEventListener('click', () => _activateTab('topup'));
    const btnPay = document.getElementById('walBtnPay');
    if (btnPay) btnPay.addEventListener('click', () => _activateTab('transactions'));

    // Payout sub-tabs
    document.querySelectorAll('.wal-payout-sub-tab').forEach(st => {
      st.addEventListener('click', function () {
        document.querySelectorAll('.wal-payout-sub-tab').forEach(x => {
          x.classList.remove('active');
          x.setAttribute('aria-selected', 'false');
        });
        document.querySelectorAll('.wal-payout-sub-panel').forEach(x => x.classList.remove('active'));
        this.classList.add('active');
        this.setAttribute('aria-selected', 'true');
        const target = this.dataset.sub === 'history' ? 'walPayoutHistPanel' : 'walPayoutReqPanel';
        const panel  = document.getElementById(target);
        if (panel) panel.classList.add('active');

        // Lazy-load payout history on first open
        if (this.dataset.sub === 'history' && !_payoutsLoaded) {
          _payoutsLoaded = true;
          loadPayoutHistory();
        }
      });
    });
  }

  function _activateTab(name) {
    document.querySelectorAll('.wal-tabs .wal-tab').forEach(t => {
      const isActive = t.dataset.tab === name;
      t.classList.toggle('active', isActive);
      t.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    document.querySelectorAll('.wal-tab-panel').forEach(p => {
      p.classList.remove('active');
    });
    const mapId = { topup: 'walPanelTopUp', transactions: 'walPanelTx', payouts: 'walPanelPayout' };
    const panel = document.getElementById(mapId[name]);
    if (panel) panel.classList.add('active');

    // Lazy-load on first open
    if (name === 'transactions' && _txAll.length === 0) loadTransactions();
    if (name === 'payouts' && !_payoutsLoaded) {
      // history panel is inactive by default; will load when sub-tab opened
    }
  }

  /* ─────────────────────────────────────────────
     QUICK AMOUNT CHIPS
  ───────────────────────────────────────────── */
  function initQuickAmounts() {
    const container = document.getElementById('walQuickAmounts');
    if (!container) return;
    container.querySelectorAll('.wal-amount-chip').forEach(chip => {
      chip.addEventListener('click', function () {
        selectQuickAmount(Number(this.dataset.amount));
      });
    });
  }

  function selectQuickAmount(amt) {
    document.querySelectorAll('#walQuickAmounts .wal-amount-chip').forEach(c => {
      c.classList.toggle('active', Number(c.dataset.amount) === amt);
    });
    const input = document.getElementById('walTopUpAmount');
    if (input) {
      input.value = amt;
      input.dispatchEvent(new Event('input'));
    }
  }

  /* ─────────────────────────────────────────────
     TOP-UP FLOW
  ───────────────────────────────────────────── */
  async function initiateTopUp() {
    const amtInput   = document.getElementById('walTopUpAmount');
    const phoneInput = document.getElementById('walTopUpPhone');
    const btn        = document.getElementById('walTopUpBtn');

    const rawAmt   = parseFloat(amtInput ? amtInput.value : '0');
    const rawPhone = phoneInput ? phoneInput.value.trim() : '';

    // Validate amount
    if (!rawAmt || rawAmt < 10) {
      toast('Minimum top-up amount is KSh 10', 'error');
      if (amtInput) amtInput.focus();
      return;
    }
    if (rawAmt > 70000) {
      toast('Maximum top-up amount is KSh 70,000', 'error');
      if (amtInput) amtInput.focus();
      return;
    }
    if (!Number.isInteger(rawAmt) && String(rawAmt).split('.')[1]?.length > 2) {
      toast('Enter a valid amount (up to 2 decimal places)', 'error');
      return;
    }

    // Validate phone
    const phone = _normalisePhone(rawPhone);
    if (!phone) {
      toast('Enter a valid Safaricom M-Pesa number (07XX or 01XX)', 'error');
      if (phoneInput) phoneInput.focus();
      return;
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Sending request...'; }

    try {
      const fn  = await _cf('initiateWalletTopUp');
      const res = await fn({ amount: rawAmt, phone });
      const { txId, message } = res.data || {};

      if (!txId) throw new Error(message || 'Top-up initiation failed');

      document.getElementById('walPendingTxId').value = txId;
      _showStatusArea(true);
      _updateStatusMsg('M-Pesa prompt sent! Enter your PIN on your phone.');
      startPolling(txId);
      toast(message || 'M-Pesa prompt sent to ' + rawPhone, 'info');

      // Clear input after success
      if (amtInput)   amtInput.value   = '';
      if (phoneInput) phoneInput.value = '';
      // Deselect chips
      document.querySelectorAll('#walQuickAmounts .wal-amount-chip')
        .forEach(c => c.classList.remove('active'));

    } catch (e) {
      console.error('[SokoniWallet] initiateTopUp error:', e);
      toast(e.message || 'Could not initiate M-Pesa payment. Try again.', 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-mobile-screen-button"></i> Request M-Pesa Payment';
      }
    }
  }

  /* ─────────────────────────────────────────────
     POLLING
  ───────────────────────────────────────────── */
  function startPolling(txId) {
    stopPolling(); // clear any previous
    _pendingTxId = txId;
    _pollStart   = Date.now();
    let attempts = 0;

    // Start elapsed-time display
    _elapsedTimer = setInterval(() => {
      const sec = Math.floor((Date.now() - _pollStart) / 1000);
      const el  = document.getElementById('walElapsed');
      if (el) el.textContent = sec + 's';
    }, 1000);

    _pollInterval = setInterval(async () => {
      attempts++;
      if (attempts > 30) { // 30 × 3 s = 90 s
        stopPolling();
        toast('Payment timeout. Check your M-Pesa messages.', 'error');
        _updateStatusMsg('Timed out. Check your M-Pesa inbox.');
        return;
      }
      try {
        const fn     = await _cf('confirmWalletTopUp');
        const result = await fn({ txId });
        const data   = result.data || {};

        if (data.status === 'completed') {
          stopPolling();
          _showStatusArea(false);
          toast('KSh ' + _fmt(data.amount) + ' added to wallet!', 'success');
          loadBalance();
          loadTransactions();
        } else if (data.status === 'failed') {
          stopPolling();
          _showStatusArea(false);
          toast(data.message || 'Payment failed. Please try again.', 'error');
        }
        // 'pending' → keep polling
      } catch (_) {
        // Network hiccup — keep polling
      }
    }, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (_pollInterval) { clearInterval(_pollInterval); _pollInterval = null; }
    if (_elapsedTimer) { clearInterval(_elapsedTimer); _elapsedTimer = null; }
    _pendingTxId = null;
    const el = document.getElementById('walElapsed');
    if (el) el.textContent = '';
  }

  function pollTopUpStatus() {
    const txId = document.getElementById('walPendingTxId')?.value || _pendingTxId;
    if (!txId) { toast('No pending payment to check', 'info'); return; }
    // Manually trigger one check immediately
    (async () => {
      try {
        const fn     = await _cf('confirmWalletTopUp');
        const result = await fn({ txId });
        const data   = result.data || {};
        if (data.status === 'completed') {
          stopPolling();
          _showStatusArea(false);
          toast('KSh ' + _fmt(data.amount) + ' added to wallet!', 'success');
          loadBalance();
          loadTransactions();
        } else if (data.status === 'failed') {
          stopPolling();
          _showStatusArea(false);
          toast('Payment failed.', 'error');
        } else {
          toast('Still waiting for M-Pesa confirmation...', 'info');
        }
      } catch (_) {
        toast('Status check failed. Polling continues...', 'info');
      }
    })();
  }

  function _showStatusArea(visible) {
    const area = document.getElementById('walTopUpStatus');
    if (area) area.classList.toggle('visible', visible);
  }

  function _updateStatusMsg(msg) {
    const el = document.getElementById('walStatusMsg');
    if (el) el.textContent = msg;
  }

  /* ─────────────────────────────────────────────
     PAYOUT FORM
  ───────────────────────────────────────────── */
  function toggleBankFields() {
    const bankFields = document.getElementById('walPayoutBankFields');
    const accountLabel = document.getElementById('walPayoutAccountLabel');
    const methodBtns   = document.querySelectorAll('#walPayoutMethod .wal-method-btn');

    let activeMethod = 'mpesa';
    methodBtns.forEach(btn => {
      if (btn.classList.contains('active')) activeMethod = btn.dataset.method;
    });

    if (bankFields) {
      bankFields.classList.toggle('visible', activeMethod === 'bank');
    }
    if (accountLabel) {
      accountLabel.textContent = activeMethod === 'bank' ? 'Account Number' : 'M-Pesa Number';
    }

    const accountInput = document.getElementById('walPayoutAccount');
    if (accountInput) {
      if (activeMethod === 'bank') {
        accountInput.type        = 'text';
        accountInput.inputMode   = 'numeric';
        accountInput.placeholder = 'e.g. 1234567890';
        accountInput.maxLength   = 20;
      } else {
        accountInput.type        = 'tel';
        accountInput.inputMode   = 'tel';
        accountInput.placeholder = 'e.g. 0712 345 678';
        accountInput.maxLength   = 13;
      }
    }
  }

  async function requestPayout() {
    const amtInput     = document.getElementById('walPayoutAmount');
    const accountInput = document.getElementById('walPayoutAccount');
    const bankCodeSel  = document.getElementById('walPayoutBankCode');
    const bankNameInput= document.getElementById('walPayoutBankName');
    const btn          = document.getElementById('walPayoutBtn');

    const rawAmt = parseFloat(amtInput ? amtInput.value : '0');
    const rawAcct = (accountInput ? accountInput.value.trim() : '');

    // Find active method
    let method = 'mpesa';
    document.querySelectorAll('#walPayoutMethod .wal-method-btn').forEach(b => {
      if (b.classList.contains('active')) method = b.dataset.method;
    });

    // Validate amount
    if (!rawAmt || rawAmt < 500) {
      toast('Minimum payout is KSh 500', 'error');
      if (amtInput) amtInput.focus();
      return;
    }

    // Validate account
    let normalised = rawAcct;
    if (method === 'mpesa') {
      const phone = _normalisePhone(rawAcct);
      if (!phone) {
        toast('Enter a valid Safaricom M-Pesa number', 'error');
        if (accountInput) accountInput.focus();
        return;
      }
      normalised = phone;
    } else {
      if (!rawAcct || rawAcct.length < 4) {
        toast('Enter a valid bank account number', 'error');
        if (accountInput) accountInput.focus();
        return;
      }
      const bankCode = bankCodeSel ? bankCodeSel.value : '';
      if (!bankCode) {
        toast('Please select your bank', 'error');
        if (bankCodeSel) bankCodeSel.focus();
        return;
      }
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Submitting...'; }

    try {
      const payload = {
        amount:        rawAmt,
        method,
        accountNumber: normalised,
      };
      if (method === 'bank') {
        payload.bankCode = bankCodeSel ? bankCodeSel.value : '';
        payload.bankName = bankNameInput ? bankNameInput.value.trim() : '';
      }

      const fn  = await _cf('requestSellerPayout');
      const res = await fn(payload);
      const data = res.data || {};

      if (data.success) {
        toast(data.message || 'Payout request submitted!', 'success');
        // Reset form
        if (amtInput)      amtInput.value      = '';
        if (accountInput)  accountInput.value   = '';
        if (bankCodeSel)   bankCodeSel.value    = '';
        if (bankNameInput) bankNameInput.value  = '';
        // Refresh history (force reload on next open)
        _payoutsLoaded = false;
      } else {
        toast(data.message || 'Payout request failed. Try again.', 'error');
      }
    } catch (e) {
      console.error('[SokoniWallet] requestPayout error:', e);
      toast(e.message || 'Could not submit payout request.', 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Request Payout';
      }
    }
  }

  /* ─────────────────────────────────────────────
     EVENT WIRING
  ───────────────────────────────────────────── */
  function _wireEvents() {
    // Top-up button
    const topUpBtn = document.getElementById('walTopUpBtn');
    if (topUpBtn) topUpBtn.addEventListener('click', initiateTopUp);

    // Check status (manual poll trigger)
    const checkBtn = document.getElementById('walCheckStatusBtn');
    if (checkBtn) checkBtn.addEventListener('click', pollTopUpStatus);

    // Cancel polling
    const cancelBtn = document.getElementById('walCancelPollBtn');
    if (cancelBtn) cancelBtn.addEventListener('click', () => {
      stopPolling();
      _showStatusArea(false);
      toast('M-Pesa check cancelled', 'info');
    });

    // Transaction filters
    document.querySelectorAll('#walTxFilter .wal-filter-btn').forEach(btn => {
      btn.addEventListener('click', function () {
        filterTransactions(this.dataset.filter);
      });
    });

    // Load more transactions
    const loadMoreBtn = document.getElementById('walLoadMoreBtn');
    if (loadMoreBtn) loadMoreBtn.addEventListener('click', () => {
      _txPage++;
      let filtered = _txAll;
      if (_txFilter === 'credit') filtered = _txAll.filter(t => t.type === 'credit' || t.direction === 'in');
      if (_txFilter === 'debit')  filtered = _txAll.filter(t => t.type !== 'credit' && t.direction !== 'in');
      renderTransactions(filtered);
    });

    // Payout method buttons
    document.querySelectorAll('#walPayoutMethod .wal-method-btn').forEach(btn => {
      btn.addEventListener('click', function () {
        document.querySelectorAll('#walPayoutMethod .wal-method-btn').forEach(b => {
          b.classList.remove('active');
          b.setAttribute('aria-pressed', 'false');
        });
        this.classList.add('active');
        this.setAttribute('aria-pressed', 'true');
        toggleBankFields();
      });
    });

    // Payout submit
    const payoutBtn = document.getElementById('walPayoutBtn');
    if (payoutBtn) payoutBtn.addEventListener('click', requestPayout);

    // Clear chip highlight when amount is typed manually
    const amtInput = document.getElementById('walTopUpAmount');
    if (amtInput) {
      amtInput.addEventListener('input', () => {
        const v = parseFloat(amtInput.value);
        document.querySelectorAll('#walQuickAmounts .wal-amount-chip').forEach(c => {
          c.classList.toggle('active', Number(c.dataset.amount) === v);
        });
      });
    }
  }

  /* ─────────────────────────────────────────────
     INIT
  ───────────────────────────────────────────── */
  async function init() {
    // 1. Auth gate
    _uid = _requireAuth();
    if (!_uid) return; // redirected

    // 2. Wire all events first so UI is responsive immediately
    initTabs();
    initQuickAmounts();
    _wireEvents();

    // 3. Pre-fill phone if user profile has one
    try {
      const stored = JSON.parse(localStorage.getItem('sokoniUser') || 'null');
      if (stored && stored.phone) {
        const phoneEl = document.getElementById('walTopUpPhone');
        if (phoneEl && !phoneEl.value) phoneEl.value = stored.phone;
        const payoutAccEl = document.getElementById('walPayoutAccount');
        if (payoutAccEl && !payoutAccEl.value) payoutAccEl.value = stored.phone;
      }
    } catch (_) {}

    // 4. Load balance (non-blocking)
    loadBalance();

    // 5. Detect seller role (shows payouts tab if true)
    _isSeller = await _detectSeller(_uid);
    if (_isSeller) {
      const tab = document.getElementById('walPayoutTab');
      if (tab) tab.style.display = '';
    }
  }

  /* ─────────────────────────────────────────────
     PUBLIC API
  ───────────────────────────────────────────── */
  return {
    init,
    loadBalance,
    loadTransactions,
    loadPayoutHistory,
    filterTransactions,
    requestPayout,
    startPolling,
    stopPolling,
    toast,
    /* Exposed for testing */
    _esc,
    _fmt,
    _normalisePhone,
    _maskAccount,
  };

})();
