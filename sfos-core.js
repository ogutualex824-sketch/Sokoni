/**
 * sfos-core.js — SOKONI Financial Operating System (SFOS) Client SDK
 *
 * Architecture:
 *   - IIFE exposed as window.SFOSCore
 *   - Auth-gated: redirects unauthenticated users to login.html
 *   - All CF calls via _cf() — lazy Firebase Functions SDK (no eager imports)
 *   - All DOM writes via _esc() — XSS prevention on every innerHTML assignment
 *   - Backward compatible: delegates to wallet-engine.js V2 CFs for money ops
 *   - Dispatches CustomEvent('sfosReady') when fully initialised
 *
 * V2 CF delegates (wallet-engine.js — unchanged):
 *   walletV2Dashboard, walletV2Send, walletV2Request, walletV2SavingsList,
 *   walletV2SavingsCreate, walletV2SavingsDeposit, walletV2SavingsWithdraw,
 *   walletV2SetPin, walletV2FreezeToggle, walletV2SetLimits,
 *   walletV2Analytics, walletV2GenerateQR, walletV2AiInsights
 *
 * SFOS CF calls (sfos-engine.js — new):
 *   sfosIdentityGet, sfosWalletGet, sfosTransact, sfosEscrowCreate,
 *   sfosEscrowRelease, sfosGroupCreate, sfosGroupGet, sfosMerchantDashboard,
 *   sfosMerchantSettle, sfosRewardsGet, sfosRewardsRedeem, sfosFinancialHealth,
 *   sfosNetWorth, sfosAnalyticsDetailed, sfosAiForecast, sfosRiskCheck
 *
 * @module sfos-core
 * @version 1.0.0
 * @since 2026-07-14
 */

window.SFOSCore = (function () {
  'use strict';

  /* ═══════════════════════════════════════════════════════════════════════
     CONSTANTS
  ═══════════════════════════════════════════════════════════════════════ */

  const CF_REGION     = 'us-central1';
  const FB_SDK        = 'https://www.gstatic.com/firebasejs/10.12.2';
  const LOGIN_URL     = 'login.html?redirect=sfos-wallet.html';
  const TX_PAGE_SIZE  = 20;
  const COUNT_DURATION = 1200; // ms for animated counters

  /* ═══════════════════════════════════════════════════════════════════════
     MODULE STATE
  ═══════════════════════════════════════════════════════════════════════ */

  let _uid          = null;
  let _identity     = null;   // sfosIdentityGet result
  let _walletState  = null;   // sfosWalletGet result
  let _frozen       = false;
  let _vaults       = [];
  let _toastTimer   = null;
  let _anPeriod     = 'month';
  let _cfCache      = {};     // name → httpsCallable (reuse references)

  /* ═══════════════════════════════════════════════════════════════════════
     INTERNAL HELPERS
  ═══════════════════════════════════════════════════════════════════════ */

  /**
   * Lazy Firebase Cloud Functions reference.
   * Caches callable references to avoid repeated SDK lookups.
   * @param {string} name — CF export name
   * @returns {Promise<import('firebase/functions').HttpsCallable>}
   */
  async function _cf(name) {
    if (_cfCache[name]) return _cfCache[name];
    const { getFunctions, httpsCallable } = await import(
      `${FB_SDK}/firebase-functions.js`
    );
    const fns = getFunctions(window.firebaseApp, CF_REGION);
    const callable = httpsCallable(fns, name);
    _cfCache[name] = callable;
    return callable;
  }

  /**
   * XSS escape — must be applied to every string written to innerHTML.
   * @param {*} s
   * @returns {string}
   */
  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Format number as KES with 2 decimal places and thousands separators.
   * @param {number|string} n
   * @returns {string} e.g. "12,345.00"
   */
  function _fmt(n) {
    const v = Number(n) || 0;
    return v.toLocaleString('en-KE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  /**
   * Short KES format — no decimals, thousands separators.
   * @param {number|string} n
   * @returns {string} e.g. "12,345"
   */
  function _fmtShort(n) {
    const v = Number(n) || 0;
    return v.toLocaleString('en-KE', { maximumFractionDigits: 0 });
  }

  /**
   * Human-readable relative time from a Firestore Timestamp, Date, or ISO string.
   * @param {*} ts
   * @returns {string} e.g. "2h ago", "3 Jan"
   */
  function _relativeTime(ts) {
    const d = ts?.toDate
      ? ts.toDate()
      : ts instanceof Date
        ? ts
        : new Date(ts);
    if (isNaN(d)) return '';
    const diff = Date.now() - d.getTime();
    const secs = Math.floor(diff / 1000);
    if (secs < 60)    return 'Just now';
    if (secs < 3600)  return `${Math.floor(secs / 60)}m ago`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
    if (secs < 604800) return `${Math.floor(secs / 86400)}d ago`;
    return d.toLocaleDateString('en-KE', { day: 'numeric', month: 'short' });
  }

  /**
   * Animate a numeric counter from 0 to target over duration ms.
   * @param {HTMLElement} el
   * @param {number} target
   * @param {number} duration — milliseconds
   */
  function _countUp(el, target, duration = COUNT_DURATION) {
    if (!el) return;
    const start = performance.now();
    const v = Number(target) || 0;
    function step(now) {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const ease = 1 - Math.pow(1 - progress, 3); // cubic ease-out
      el.textContent = _fmt(v * ease);
      if (progress < 1) requestAnimationFrame(step);
      else el.textContent = _fmt(v);
    }
    requestAnimationFrame(step);
  }

  /**
   * Draw a semi-circular health score gauge on a canvas element.
   * @param {HTMLCanvasElement} canvas
   * @param {number} score — 0-100
   * @param {string} grade — 'A'|'B'|'C'|'D'|'F'
   */
  function _drawHealthGauge(canvas, score, grade) {
    if (!canvas) return;
    const ctx  = canvas.getContext('2d');
    const w    = canvas.width;
    const h    = canvas.height;
    const cx   = w / 2;
    const cy   = h * 0.72;
    const r    = Math.min(w, h) * 0.42;
    const pct  = Math.max(0, Math.min(score, 100)) / 100;

    ctx.clearRect(0, 0, w, h);

    // Track arc (background)
    ctx.beginPath();
    ctx.arc(cx, cy, r, Math.PI, 0, false);
    ctx.strokeStyle = '#1e1e1e';
    ctx.lineWidth   = 14;
    ctx.lineCap     = 'round';
    ctx.stroke();

    // Colour band: red→amber→green gradient via score
    const hue = Math.round(pct * 120); // 0=red, 120=green
    ctx.beginPath();
    ctx.arc(cx, cy, r, Math.PI, Math.PI + pct * Math.PI, false);
    ctx.strokeStyle = `hsl(${hue},90%,52%)`;
    ctx.lineWidth   = 14;
    ctx.lineCap     = 'round';
    ctx.stroke();

    // Score label
    ctx.fillStyle    = '#e8e8e8';
    ctx.font         = `bold ${Math.round(r * 0.48)}px system-ui`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(String(Math.round(score)), cx, cy + 4);

    // Grade label
    ctx.font         = `${Math.round(r * 0.28)}px system-ui`;
    ctx.fillStyle    = '#71ff00';
    ctx.fillText(`Grade ${_esc(grade)}`, cx, cy + Math.round(r * 0.35));
  }

  /**
   * Draw a circular progress ring on a canvas element (savings vault).
   * @param {HTMLCanvasElement} canvas
   * @param {number} pct — 0-1
   * @param {string} color — CSS colour
   */
  function _drawProgressRing(canvas, pct, color = '#71ff00') {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w   = canvas.width;
    const h   = canvas.height;
    const cx  = w / 2;
    const cy  = h / 2;
    const r   = Math.min(w, h) / 2 - 6;
    const p   = Math.max(0, Math.min(pct, 1));

    ctx.clearRect(0, 0, w, h);

    // Background ring
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = '#1a1a1a';
    ctx.lineWidth   = 7;
    ctx.stroke();

    // Progress arc
    if (p > 0) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2, false);
      ctx.strokeStyle = color;
      ctx.lineWidth   = 7;
      ctx.lineCap     = 'round';
      ctx.stroke();
    }

    // Percentage text
    ctx.fillStyle    = '#e8e8e8';
    ctx.font         = `bold ${Math.round(r * 0.46)}px system-ui`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${Math.round(p * 100)}%`, cx, cy);
  }

  /**
   * Return icon and CSS class for a transaction type.
   * @param {string} type
   * @returns {{ icon: string, cls: string }}
   */
  function _txIcon(type) {
    const map = {
      send:      { icon: 'fa-arrow-up-right',   cls: 'tx-out'  },
      receive:   { icon: 'fa-arrow-down-left',   cls: 'tx-in'   },
      topup:     { icon: 'fa-plus',              cls: 'tx-in'   },
      withdrawal:{ icon: 'fa-money-bill-wave',   cls: 'tx-out'  },
      payment:   { icon: 'fa-bag-shopping',      cls: 'tx-out'  },
      refund:    { icon: 'fa-rotate-left',       cls: 'tx-in'   },
      escrow:    { icon: 'fa-lock',              cls: 'tx-hold' },
      release:   { icon: 'fa-lock-open',         cls: 'tx-in'   },
      savings:   { icon: 'fa-piggy-bank',        cls: 'tx-save' },
      reward:    { icon: 'fa-star',              cls: 'tx-in'   },
      fee:       { icon: 'fa-receipt',           cls: 'tx-out'  },
    };
    return map[type] || { icon: 'fa-circle', cls: 'tx-default' };
  }

  /**
   * Build safe HTML for one transaction row.
   * All user-supplied strings are passed through _esc().
   * @param {object} tx
   * @returns {string} HTML string
   */
  function _renderTxRow(tx) {
    const { icon, cls } = _txIcon(tx.type);
    const amount = Number(tx.amount) || 0;
    const sign   = (tx.type === 'receive' || tx.type === 'topup' ||
                    tx.type === 'release' || tx.type === 'refund' ||
                    tx.type === 'reward') ? '+' : '-';
    const amtCls = sign === '+' ? 'tx-amt-pos' : 'tx-amt-neg';

    return `
      <div class="tx-row" data-id="${_esc(tx.id)}">
        <div class="tx-icon-wrap ${_esc(cls)}">
          <i class="fa-solid ${_esc(icon)}"></i>
        </div>
        <div class="tx-body">
          <span class="tx-name">${_esc(tx.label || tx.description || tx.type)}</span>
          <span class="tx-time">${_esc(_relativeTime(tx.createdAt))}</span>
        </div>
        <span class="tx-amount ${_esc(amtCls)}">${_esc(sign)}KES ${_esc(_fmt(amount))}</span>
      </div>`;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     PUBLIC — CORE NAVIGATION
  ═══════════════════════════════════════════════════════════════════════ */

  /**
   * Switch the visible panel.
   * Hides all .sfos-panel elements and shows the target.
   * @param {string} id — panel element ID
   */
  function showPanel(id) {
    document.querySelectorAll('.sfos-panel').forEach(p => {
      p.classList.remove('active');
    });
    const panel = document.getElementById(id);
    if (panel) {
      panel.classList.add('active');
      const scroll = document.getElementById('sfos-panels');
      if (scroll) scroll.scrollTop = 0;
    }

    // Bottom-nav highlight
    document.querySelectorAll('.sfos-nav-btn').forEach(b => b.classList.remove('active'));
    const navMap = {
      sfos_home:     'sfosNavHome',
      sfos_send:     'sfosNavSend',
      sfos_qr:       'sfosNavQR',
      sfos_history:  'sfosNavHistory',
      sfos_more:     'sfosNavMore',
    };
    if (navMap[id]) document.getElementById(navMap[id])?.classList.add('active');

    // Lazy-load panel data on first visit
    const panelLoaders = {
      sfos_savings:   loadSavings,
      sfos_health:    loadHealthScore,
      sfos_networth:  loadNetWorth,
      sfos_rewards:   loadRewards,
      sfos_business:  loadMerchantDashboard,
      sfos_security:  loadSecurityStatus,
      sfos_qr:        () => generateQR(0),
    };
    if (panelLoaders[id]) panelLoaders[id]();
  }

  /**
   * Open a named overlay panel.
   * @param {string} id — overlay element ID
   */
  function openOverlay(id) {
    const el = document.getElementById(id);
    if (el) {
      el.classList.add('open');
      el.setAttribute('aria-hidden', 'false');
    }
  }

  /**
   * Close a named overlay panel.
   * @param {string} id — overlay element ID
   */
  function closeOverlay(id) {
    const el = document.getElementById(id);
    if (el) {
      el.classList.remove('open');
      el.setAttribute('aria-hidden', 'true');
    }
  }

  /**
   * Display a toast notification.
   * @param {string} msg   — message text (plain text, not HTML)
   * @param {string} type  — 'default' | 'success' | 'error' | 'warning'
   * @param {number} ms    — auto-dismiss delay
   */
  function toast(msg, type = 'default', ms = 3500) {
    const el = document.getElementById('sfos-toast');
    if (!el) return;
    clearTimeout(_toastTimer);
    el.textContent = msg;          // textContent is safe — no HTML injection
    el.className   = `sfos-toast show ${_esc(type)}`;
    _toastTimer    = setTimeout(() => { el.className = 'sfos-toast'; }, ms);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     PUBLIC — IDENTITY & WALLET STATE
  ═══════════════════════════════════════════════════════════════════════ */

  /**
   * Load the caller's SFOS financial identity via sfosIdentityGet.
   * Populates avatar, name, tier badge, and KYC status in the UI.
   */
  async function loadIdentity() {
    try {
      const fn  = await _cf('sfosIdentityGet');
      const res = await fn({});
      _identity = res.data;

      const { displayName, tier, kyc, phone, avatarInitial } = _identity;

      _set('sfos-user-name',   _esc(displayName || 'User'));
      _set('sfos-user-tier',   _esc(tier || 'Bronze'));
      _set('sfos-user-kyc',    _esc(kyc?.level || 'Basic'));
      _set('sfos-user-phone',  _esc(phone || ''));

      const avEl = document.getElementById('sfos-avatar');
      if (avEl) avEl.textContent = _esc(
        avatarInitial || (displayName?.[0] || '?').toUpperCase()
      );

    } catch (e) {
      console.error('[SFOS] loadIdentity error', e);
    }
  }

  /**
   * Load current wallet state and update all balance displays.
   * Calls sfosWalletGet (canonical) with fallback to walletV2Dashboard.
   */
  async function getWalletState() {
    try {
      let data;
      try {
        const fn = await _cf('sfosWalletGet');
        const res = await fn({});
        data = res.data;
      } catch {
        // Graceful fallback to Wallet 2.0 dashboard during SFOS rollout
        const fn = await _cf('walletV2Dashboard');
        const res = await fn({});
        data = res.data;
      }
      _walletState = data;
      _frozen      = data.frozen || false;
      _renderBalances(data);
      return data;
    } catch (e) {
      console.error('[SFOS] getWalletState error', e);
      toast('Could not load wallet data', 'error');
    }
  }

  /** Write balance figures into every balance display element. */
  function _renderBalances(data) {
    const bal  = data.balance          || 0;
    const sav  = data.savingsTotal     || 0;
    const escr = data.escrowTotal      || 0;
    const pts  = data.rewardPoints     || 0;

    const mainEl  = document.getElementById('sfos-balance-main');
    const savEl   = document.getElementById('sfos-balance-savings');
    const escrEl  = document.getElementById('sfos-balance-escrow');
    const ptsEl   = document.getElementById('sfos-reward-points');
    const freezeEl= document.getElementById('sfos-freeze-badge');

    _countUp(mainEl,  bal,  COUNT_DURATION);
    _countUp(savEl,   sav,  COUNT_DURATION);
    _countUp(escrEl,  escr, COUNT_DURATION);
    if (ptsEl)    ptsEl.textContent    = _fmtShort(pts) + ' pts';
    if (freezeEl) freezeEl.hidden      = !_frozen;
  }

  /** Safe textContent setter — avoids repeated getElementById chains. */
  function _set(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     PUBLIC — MONEY OPERATIONS
  ═══════════════════════════════════════════════════════════════════════ */

  /**
   * Execute a P2P send via walletV2Send (Wallet 2.0 CF — backward compat).
   * Performs client-side amount and phone validation before calling CF.
   * @param {string} phone  — recipient phone (any Kenyan format)
   * @param {number} amount — KES amount
   * @param {string} note   — optional payment note (max 100 chars)
   */
  async function executeSend(phone, amount, note = '') {
    const amt = Number(amount);
    if (!phone || !/^(?:254|\+254|0)[17]\d{8}$/.test(phone.replace(/\s/g, ''))) {
      toast('Enter a valid Kenyan phone number', 'error');
      return;
    }
    if (!amt || amt < 10) {
      toast('Minimum send amount is KES 10', 'error');
      return;
    }
    if (_frozen) {
      toast('Your wallet is frozen — unfreeze first', 'error');
      return;
    }

    const btn = document.getElementById('sfos-send-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }

    try {
      // Risk check before send
      await checkRisk(amt, null);

      const fn  = await _cf('walletV2Send');
      const res = await fn({
        toPhone: phone.replace(/\s/g, ''),
        amount:  amt,
        note:    note.slice(0, 100),
      });

      toast(`Sent KES ${_fmt(amt)} successfully`, 'success');
      closeOverlay('sfos-send-overlay');
      await getWalletState();

      const txId = res.data?.txId;
      if (txId) _prependTxRow(res.data);

    } catch (e) {
      console.error('[SFOS] executeSend error', e);
      toast(e.message || 'Send failed — please try again', 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Send'; }
    }
  }

  /**
   * Create a new escrow hold via sfosEscrowCreate.
   * @param {object} data — { toUid, amount, description, milestones[] }
   */
  async function openEscrow(data) {
    try {
      const fn  = await _cf('sfosEscrowCreate');
      const res = await fn(data);
      toast('Escrow created successfully', 'success');
      await getWalletState();
      return res.data;
    } catch (e) {
      console.error('[SFOS] openEscrow error', e);
      toast(e.message || 'Could not create escrow', 'error');
    }
  }

  /**
   * Release an escrow milestone to the recipient via sfosEscrowRelease.
   * @param {string} escrowId
   * @param {string} milestoneId — pass null to release full amount
   */
  async function releaseEscrow(escrowId, milestoneId) {
    try {
      const fn  = await _cf('sfosEscrowRelease');
      const res = await fn({ escrowId, milestoneId });
      toast('Escrow released', 'success');
      await getWalletState();
      return res.data;
    } catch (e) {
      console.error('[SFOS] releaseEscrow error', e);
      toast(e.message || 'Could not release escrow', 'error');
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════
     PUBLIC — SAVINGS
  ═══════════════════════════════════════════════════════════════════════ */

  /**
   * Load and render all savings vaults via walletV2SavingsList.
   */
  async function loadSavings() {
    const container = document.getElementById('sfos-vault-grid');
    if (container) container.innerHTML = '<p class="sfos-loading">Loading vaults…</p>';

    try {
      const fn  = await _cf('walletV2SavingsList');
      const res = await fn({});
      _vaults   = res.data?.vaults || [];
      renderVaultGrid(_vaults);
    } catch (e) {
      console.error('[SFOS] loadSavings error', e);
      toast('Could not load savings vaults', 'error');
    }
  }

  /**
   * Create a new savings vault via walletV2SavingsCreate.
   * @param {object} data — { name, target, locked, deadline, autoSave, autoSaveAmount }
   */
  async function createVault(data) {
    try {
      const fn  = await _cf('walletV2SavingsCreate');
      await fn(data);
      toast('Vault created', 'success');
      await loadSavings();
    } catch (e) {
      console.error('[SFOS] createVault error', e);
      toast(e.message || 'Could not create vault', 'error');
    }
  }

  /**
   * Deposit from wallet balance into a savings vault.
   * @param {string} vaultId
   * @param {number} amount — KES
   */
  async function depositToVault(vaultId, amount) {
    const amt = Number(amount);
    if (!amt || amt < 1) { toast('Minimum deposit is KES 1', 'error'); return; }
    try {
      const fn = await _cf('walletV2SavingsDeposit');
      await fn({ vaultId, amount: amt });
      toast(`Deposited KES ${_fmt(amt)}`, 'success');
      await loadSavings();
      await getWalletState();
    } catch (e) {
      console.error('[SFOS] depositToVault error', e);
      toast(e.message || 'Deposit failed', 'error');
    }
  }

  /**
   * Withdraw from a savings vault back to wallet balance.
   * @param {string} vaultId
   * @param {number} amount — KES
   */
  async function withdrawFromVault(vaultId, amount) {
    const amt = Number(amount);
    if (!amt || amt < 1) { toast('Minimum withdrawal is KES 1', 'error'); return; }
    try {
      const fn = await _cf('walletV2SavingsWithdraw');
      await fn({ vaultId, amount: amt });
      toast(`Withdrew KES ${_fmt(amt)}`, 'success');
      await loadSavings();
      await getWalletState();
    } catch (e) {
      console.error('[SFOS] withdrawFromVault error', e);
      toast(e.message || 'Withdrawal failed', 'error');
    }
  }

  /**
   * Render savings vault cards with canvas progress rings.
   * All user-supplied strings are passed through _esc().
   * @param {object[]} vaults
   */
  function renderVaultGrid(vaults) {
    const container = document.getElementById('sfos-vault-grid');
    if (!container) return;

    if (!vaults.length) {
      container.innerHTML = `
        <div class="sfos-empty">
          <i class="fa-solid fa-piggy-bank"></i>
          <p>No savings vaults yet.</p>
          <button class="sfos-btn" onclick="SFOSCore.openOverlay('sfos-vault-create')">
            Create First Vault
          </button>
        </div>`;
      return;
    }

    container.innerHTML = vaults.map(v => {
      const current = Number(v.balance)  || 0;
      const target  = Number(v.target)   || 0;
      const pct     = target > 0 ? Math.min(current / target, 1) : 0;
      const locked  = v.locked ? '<span class="sfos-badge badge-lock">Locked</span>' : '';
      const auto    = v.autoSave ? '<span class="sfos-badge badge-auto">Auto</span>' : '';

      return `
        <div class="sfos-vault-card" data-id="${_esc(v.id)}">
          <div class="sfos-vault-ring-wrap">
            <canvas id="ring-${_esc(v.id)}" width="72" height="72"></canvas>
          </div>
          <div class="sfos-vault-info">
            <h4>${_esc(v.name)}</h4>
            <p class="sfos-vault-bal">KES ${_esc(_fmt(current))}</p>
            ${target ? `<p class="sfos-vault-target">of KES ${_esc(_fmt(target))}</p>` : ''}
            <div class="sfos-vault-badges">${locked}${auto}</div>
          </div>
          <div class="sfos-vault-actions">
            <button class="sfos-btn-sm" onclick="SFOSCore.openOverlay('sfos-vault-deposit-${_esc(v.id)}')">
              Deposit
            </button>
            <button class="sfos-btn-sm btn-ghost" onclick="SFOSCore.withdrawFromVault('${_esc(v.id)}', 0)">
              Withdraw
            </button>
          </div>
        </div>`;
    }).join('');

    // Draw progress rings after DOM insertion
    requestAnimationFrame(() => {
      vaults.forEach(v => {
        const canvas  = document.getElementById(`ring-${v.id}`);
        const current = Number(v.balance) || 0;
        const target  = Number(v.target)  || 0;
        const pct     = target > 0 ? Math.min(current / target, 1) : 0;
        _drawProgressRing(canvas, pct, v.color || '#71ff00');
      });
    });
  }

  /* ═══════════════════════════════════════════════════════════════════════
     PUBLIC — BUSINESS / MERCHANT
  ═══════════════════════════════════════════════════════════════════════ */

  /**
   * Load merchant financial dashboard via sfosMerchantDashboard.
   * Renders revenue, settlement status, and pending payouts.
   */
  async function loadMerchantDashboard() {
    const el = document.getElementById('sfos-merchant-panel');
    if (el) el.innerHTML = '<p class="sfos-loading">Loading merchant data…</p>';

    try {
      const fn  = await _cf('sfosMerchantDashboard');
      const res = await fn({});
      const d   = res.data;

      if (!d || d.noMerchantProfile) {
        if (el) el.innerHTML = `
          <div class="sfos-empty">
            <i class="fa-solid fa-store"></i>
            <p>Register as a seller to access merchant finance.</p>
            <a class="sfos-btn" href="seller-register.html">Become a Seller</a>
          </div>`;
        return;
      }

      if (el) el.innerHTML = `
        <div class="sfos-merchant-grid">
          <div class="sfos-stat-tile">
            <span class="sfos-stat-label">Revenue (Month)</span>
            <span class="sfos-stat-value" id="sfos-m-rev">KES ${_esc(_fmt(d.monthRevenue || 0))}</span>
          </div>
          <div class="sfos-stat-tile">
            <span class="sfos-stat-label">Pending Settlement</span>
            <span class="sfos-stat-value" id="sfos-m-pend">KES ${_esc(_fmt(d.pendingSettlement || 0))}</span>
          </div>
          <div class="sfos-stat-tile">
            <span class="sfos-stat-label">Total Orders</span>
            <span class="sfos-stat-value">${_esc(d.totalOrders || 0)}</span>
          </div>
          <div class="sfos-stat-tile">
            <span class="sfos-stat-label">Commission Due</span>
            <span class="sfos-stat-value">KES ${_esc(_fmt(d.commissionDue || 0))}</span>
          </div>
        </div>
        <button class="sfos-btn" onclick="SFOSCore.settleMerchant()">
          <i class="fa-solid fa-circle-arrow-down"></i> Request Settlement
        </button>`;

    } catch (e) {
      console.error('[SFOS] loadMerchantDashboard error', e);
      toast('Could not load merchant data', 'error');
    }
  }

  /**
   * Trigger merchant settlement via sfosMerchantSettle.
   */
  async function settleMerchant() {
    const btn = document.getElementById('sfos-settle-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Requesting…'; }
    try {
      const fn  = await _cf('sfosMerchantSettle');
      const res = await fn({});
      toast(`Settlement of KES ${_fmt(res.data?.amount || 0)} requested`, 'success');
      await loadMerchantDashboard();
    } catch (e) {
      console.error('[SFOS] settleMerchant error', e);
      toast(e.message || 'Settlement request failed', 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Request Settlement'; }
    }
  }

  /**
   * Load a group/chama wallet via sfosGroupGet.
   * @param {string} groupId
   */
  async function loadGroupWallet(groupId) {
    try {
      const fn  = await _cf('sfosGroupGet');
      const res = await fn({ groupId });
      return res.data;
    } catch (e) {
      console.error('[SFOS] loadGroupWallet error', e);
      toast('Could not load group wallet', 'error');
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════
     PUBLIC — ANALYTICS
  ═══════════════════════════════════════════════════════════════════════ */

  /**
   * Load and render the financial health score via sfosFinancialHealth.
   * Draws a canvas gauge showing score (0-100) and letter grade.
   */
  async function loadHealthScore() {
    const canvas = document.getElementById('sfos-health-gauge');
    const gradeEl = document.getElementById('sfos-health-grade');

    try {
      const fn  = await _cf('sfosFinancialHealth');
      const res = await fn({});
      const d   = res.data;
      const score = d.score || 0;
      const grade = d.grade || 'F';

      _drawHealthGauge(canvas, score, grade);
      if (gradeEl) gradeEl.textContent = grade;

      // Render factor breakdown
      const factors = d.factors || [];
      const listEl  = document.getElementById('sfos-health-factors');
      if (listEl && factors.length) {
        listEl.innerHTML = factors.map(f => `
          <div class="sfos-factor-row">
            <span class="sfos-factor-name">${_esc(f.name)}</span>
            <span class="sfos-factor-score" style="color:${_esc(f.color || '#71ff00')}">
              ${_esc(f.score || 0)}/100
            </span>
          </div>`).join('');
      }
    } catch (e) {
      console.error('[SFOS] loadHealthScore error', e);
    }
  }

  /**
   * Load net worth summary via sfosNetWorth.
   * Renders asset and liability breakdown.
   */
  async function loadNetWorth() {
    try {
      const fn  = await _cf('sfosNetWorth');
      const res = await fn({});
      const d   = res.data;

      _set('sfos-networth-total', `KES ${_fmt(d.netWorth || 0)}`);
      _set('sfos-networth-assets', `KES ${_fmt(d.totalAssets || 0)}`);
      _set('sfos-networth-liabilities', `KES ${_fmt(d.totalLiabilities || 0)}`);

    } catch (e) {
      console.error('[SFOS] loadNetWorth error', e);
    }
  }

  /**
   * Load detailed spending analytics via sfosAnalyticsDetailed.
   * @param {string} period — 'week' | 'month' | 'year'
   */
  async function loadActivity(period = 'month') {
    _anPeriod = period;
    const container = document.getElementById('sfos-activity-container');
    if (container) container.innerHTML = '<p class="sfos-loading">Loading analytics…</p>';

    try {
      const fn  = await _cf('sfosAnalyticsDetailed');
      const res = await fn({ period });
      const d   = res.data;

      if (!container) return;

      const byCategory = d.byCategory || [];
      const catRows = byCategory.slice(0, 8).map(c => `
        <div class="sfos-cat-row">
          <span class="sfos-cat-name">${_esc(c.category)}</span>
          <div class="sfos-cat-bar-wrap">
            <div class="sfos-cat-bar" style="width:${_esc(c.pct || 0)}%"></div>
          </div>
          <span class="sfos-cat-amt">KES ${_esc(_fmt(c.amount))}</span>
        </div>`).join('');

      container.innerHTML = `
        <div class="sfos-an-summary">
          <div class="sfos-stat-tile">
            <span class="sfos-stat-label">Total Spent</span>
            <span class="sfos-stat-value">KES ${_esc(_fmt(d.totalSpent || 0))}</span>
          </div>
          <div class="sfos-stat-tile">
            <span class="sfos-stat-label">Total Received</span>
            <span class="sfos-stat-value">KES ${_esc(_fmt(d.totalReceived || 0))}</span>
          </div>
          <div class="sfos-stat-tile">
            <span class="sfos-stat-label">Transactions</span>
            <span class="sfos-stat-value">${_esc(d.txCount || 0)}</span>
          </div>
        </div>
        <h4 class="sfos-an-subtitle">Spending by Category</h4>
        <div class="sfos-cat-list">${catRows}</div>`;

    } catch (e) {
      console.error('[SFOS] loadActivity error', e);
      toast('Could not load analytics', 'error');
    }
  }

  /**
   * Load AI-powered financial forecast via sfosAiForecast.
   * Renders predictive spending, savings, and advice.
   */
  async function loadAiForecast() {
    const el = document.getElementById('sfos-forecast-container');
    if (el) el.innerHTML = '<p class="sfos-loading">Generating forecast…</p>';

    try {
      const fn  = await _cf('sfosAiForecast');
      const res = await fn({});
      const d   = res.data;

      if (!el) return;

      const insights = (d.insights || []).map(i => `
        <div class="sfos-insight-card">
          <i class="fa-solid fa-lightbulb sfos-insight-icon"></i>
          <p>${_esc(i.text)}</p>
          ${i.action ? `<a class="sfos-link" href="${_esc(i.actionUrl || '#')}">${_esc(i.action)}</a>` : ''}
        </div>`).join('');

      el.innerHTML = `
        <div class="sfos-forecast-grid">
          <div class="sfos-stat-tile">
            <span class="sfos-stat-label">Predicted Spend (next 30d)</span>
            <span class="sfos-stat-value">KES ${_esc(_fmt(d.predictedSpend || 0))}</span>
          </div>
          <div class="sfos-stat-tile">
            <span class="sfos-stat-label">Savings Opportunity</span>
            <span class="sfos-stat-value">KES ${_esc(_fmt(d.savingsOpportunity || 0))}</span>
          </div>
        </div>
        <h4 class="sfos-an-subtitle">AI Insights</h4>
        <div class="sfos-insights-list">${insights || '<p class="sfos-dim">No insights available.</p>'}</div>`;

    } catch (e) {
      console.error('[SFOS] loadAiForecast error', e);
      if (el) el.innerHTML = '<p class="sfos-dim">Forecast unavailable.</p>';
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════
     PUBLIC — SECURITY
  ═══════════════════════════════════════════════════════════════════════ */

  /**
   * Aggregate and render security feature status (freeze, PIN, limits).
   */
  async function loadSecurityStatus() {
    const el = document.getElementById('sfos-security-panel');
    try {
      const state = _walletState || await getWalletState();
      const frozen  = state.frozen || false;
      const pinSet  = state.pinSet  || false;
      const daily   = state.dailyLimit   || 0;
      const monthly = state.monthlyLimit || 0;

      if (!el) return;
      el.innerHTML = `
        <div class="sfos-sec-row">
          <div class="sfos-sec-info">
            <i class="fa-solid fa-snowflake"></i>
            <span>Wallet Freeze</span>
          </div>
          <button class="sfos-toggle ${frozen ? 'active' : ''}"
                  id="sfos-freeze-toggle"
                  onclick="SFOSCore.toggleFreeze()"
                  aria-pressed="${frozen}">
            ${frozen ? 'Frozen' : 'Active'}
          </button>
        </div>
        <div class="sfos-sec-row">
          <div class="sfos-sec-info">
            <i class="fa-solid fa-lock"></i>
            <span>Transaction PIN</span>
          </div>
          <span class="sfos-badge ${pinSet ? 'badge-ok' : 'badge-warn'}">
            ${pinSet ? 'Set' : 'Not Set'}
          </span>
        </div>
        <div class="sfos-sec-row">
          <div class="sfos-sec-info">
            <i class="fa-solid fa-gauge-high"></i>
            <span>Daily Limit</span>
          </div>
          <span class="sfos-badge">KES ${_esc(_fmtShort(daily))}</span>
        </div>
        <div class="sfos-sec-row">
          <div class="sfos-sec-info">
            <i class="fa-solid fa-calendar"></i>
            <span>Monthly Limit</span>
          </div>
          <span class="sfos-badge">KES ${_esc(_fmtShort(monthly))}</span>
        </div>
        <button class="sfos-btn" onclick="SFOSCore.openOverlay('sfos-limits-overlay')">
          Edit Limits
        </button>`;

    } catch (e) {
      console.error('[SFOS] loadSecurityStatus error', e);
    }
  }

  /**
   * Toggle wallet freeze state via walletV2FreezeToggle.
   */
  async function toggleFreeze() {
    const btn = document.getElementById('sfos-freeze-toggle');
    if (btn) btn.disabled = true;
    try {
      const fn  = await _cf('walletV2FreezeToggle');
      const res = await fn({});
      _frozen   = res.data?.frozen ?? !_frozen;
      const msg = _frozen ? 'Wallet frozen' : 'Wallet unfrozen';
      toast(msg, _frozen ? 'warning' : 'success');
      await loadSecurityStatus();
    } catch (e) {
      console.error('[SFOS] toggleFreeze error', e);
      toast(e.message || 'Could not toggle freeze', 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /**
   * Check transaction risk before executing a send.
   * Calls sfosRiskCheck. Throws if risk is HIGH.
   * @param {number} amount
   * @param {string|null} toUid
   */
  async function checkRisk(amount, toUid) {
    try {
      const fn  = await _cf('sfosRiskCheck');
      const res = await fn({ amount, toUid });
      const risk = res.data?.level || 'LOW';
      if (risk === 'HIGH') {
        throw new Error('Transaction blocked: high risk detected');
      }
      if (risk === 'MEDIUM') {
        toast('Unusual transaction — please verify recipient', 'warning', 5000);
      }
      return res.data;
    } catch (e) {
      if (e.message?.includes('blocked')) throw e;
      // Non-critical — log and continue on CF errors
      console.warn('[SFOS] checkRisk non-critical error', e);
    }
  }

  /**
   * Update daily and monthly spend limits via walletV2SetLimits.
   * @param {number} daily   — KES (max 500,000)
   * @param {number} monthly — KES (max 5,000,000)
   */
  async function setLimits(daily, monthly) {
    const d = Number(daily);
    const m = Number(monthly);
    if (d < 0 || d > 500_000)   { toast('Daily limit: 0 – 500,000', 'error'); return; }
    if (m < 0 || m > 5_000_000) { toast('Monthly limit: 0 – 5,000,000', 'error'); return; }
    try {
      const fn = await _cf('walletV2SetLimits');
      await fn({ dailyLimit: d, monthlyLimit: m });
      toast('Limits updated', 'success');
      await loadSecurityStatus();
    } catch (e) {
      console.error('[SFOS] setLimits error', e);
      toast(e.message || 'Could not update limits', 'error');
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════
     PUBLIC — REWARDS
  ═══════════════════════════════════════════════════════════════════════ */

  /**
   * Load rewards summary and history via sfosRewardsGet.
   */
  async function loadRewards() {
    const el = document.getElementById('sfos-rewards-panel');
    if (el) el.innerHTML = '<p class="sfos-loading">Loading rewards…</p>';
    try {
      const fn  = await _cf('sfosRewardsGet');
      const res = await fn({});
      const d   = res.data;

      if (!el) return;

      const history = (d.history || []).slice(0, 10).map(h => `
        <div class="sfos-rw-row">
          <span class="sfos-rw-desc">${_esc(h.description)}</span>
          <span class="sfos-rw-pts ${h.points > 0 ? 'pos' : 'neg'}">
            ${h.points > 0 ? '+' : ''}${_esc(h.points)} pts
          </span>
        </div>`).join('');

      el.innerHTML = `
        <div class="sfos-rw-header">
          <div class="sfos-rw-total">
            <span class="sfos-rw-big">${_esc(_fmtShort(d.totalPoints || 0))}</span>
            <span class="sfos-rw-label">Points Balance</span>
          </div>
          <div class="sfos-rw-tier">
            <i class="fa-solid fa-crown"></i>
            <span>${_esc(d.tier || 'Bronze')}</span>
          </div>
        </div>
        <button class="sfos-btn" onclick="SFOSCore.openOverlay('sfos-redeem-overlay')">
          Redeem Points
        </button>
        <h4 class="sfos-an-subtitle">Recent Activity</h4>
        <div class="sfos-rw-history">${history || '<p class="sfos-dim">No activity yet.</p>'}</div>`;

    } catch (e) {
      console.error('[SFOS] loadRewards error', e);
      toast('Could not load rewards', 'error');
    }
  }

  /**
   * Redeem loyalty points for wallet credit via sfosRewardsRedeem.
   * @param {number} points — points to redeem (must meet minimum threshold)
   */
  async function redeemPoints(points) {
    const pts = Number(points);
    if (!pts || pts < 100) { toast('Minimum redemption is 100 points', 'error'); return; }
    try {
      const fn  = await _cf('sfosRewardsRedeem');
      const res = await fn({ points: pts });
      toast(`Redeemed ${_fmtShort(pts)} pts for KES ${_fmt(res.data?.credited || 0)}`, 'success');
      await loadRewards();
      await getWalletState();
    } catch (e) {
      console.error('[SFOS] redeemPoints error', e);
      toast(e.message || 'Redemption failed', 'error');
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════
     PUBLIC — QR
  ═══════════════════════════════════════════════════════════════════════ */

  /**
   * Generate a signed QR code payload via walletV2GenerateQR.
   * Renders the result on the #sfos-qr-canvas element.
   * @param {number} amount — 0 for open-amount "pay me" QR
   */
  async function generateQR(amount) {
    const canvas = document.getElementById('sfos-qr-canvas');
    const amtEl  = document.getElementById('sfos-qr-amount-label');
    const amt    = Number(amount) || 0;

    if (amtEl) amtEl.textContent = amt > 0 ? `KES ${_fmt(amt)}` : 'Open amount';

    try {
      const fn  = await _cf('walletV2GenerateQR');
      const res = await fn({ amount: amt });
      const qrData = res.data?.payload;
      if (qrData && canvas) {
        await drawQRCanvas('sfos-qr-canvas', qrData, amt);
      }
      return res.data;
    } catch (e) {
      console.error('[SFOS] generateQR error', e);
      toast('Could not generate QR code', 'error');
    }
  }

  /**
   * Render a QR code onto a canvas element.
   * Uses the qrcode-generator library if available, otherwise draws a
   * placeholder with the payload text for debugging.
   * @param {string} canvasId
   * @param {string} payload — SFOS QR payload string
   * @param {number} amount  — KES amount for label
   */
  async function drawQRCanvas(canvasId, payload, amount) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w   = canvas.width;
    const h   = canvas.height;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);

    // Attempt to use qrcode library if loaded by the page
    if (window.qrcode) {
      try {
        const qr = window.qrcode(0, 'M');
        qr.addData(payload);
        qr.make();
        const size    = qr.getModuleCount();
        const cellSz  = Math.floor(w / (size + 4));
        const offset  = Math.floor((w - size * cellSz) / 2);

        for (let row = 0; row < size; row++) {
          for (let col = 0; col < size; col++) {
            ctx.fillStyle = qr.isDark(row, col) ? '#000000' : '#ffffff';
            ctx.fillRect(
              offset + col * cellSz,
              offset + row * cellSz,
              cellSz,
              cellSz
            );
          }
        }

        // SOKONI green accent bar at bottom
        ctx.fillStyle = '#71ff00';
        ctx.fillRect(0, h - 28, w, 28);
        ctx.fillStyle = '#050505';
        ctx.font      = 'bold 11px system-ui';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const label = amount > 0 ? `Pay KES ${_fmt(amount)}` : 'SOKONI Pay';
        ctx.fillText(label, w / 2, h - 14);
        return;
      } catch { /* fall through to placeholder */ }
    }

    // Fallback placeholder (no QR library)
    ctx.fillStyle   = '#050505';
    ctx.fillRect(8, 8, w - 16, h - 16);
    ctx.fillStyle   = '#71ff00';
    ctx.font        = `bold ${Math.round(w * 0.06)}px monospace`;
    ctx.textAlign   = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('SOKONI PAY', w / 2, h / 2 - 12);
    ctx.fillStyle   = '#888';
    ctx.font        = `${Math.round(w * 0.04)}px monospace`;
    ctx.fillText('QR library not loaded', w / 2, h / 2 + 12);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     INTERNAL — TRANSACTION UTILITIES
  ═══════════════════════════════════════════════════════════════════════ */

  /** Prepend a transaction row to the activity feed without a full reload. */
  function _prependTxRow(tx) {
    const feed = document.getElementById('sfos-tx-feed');
    if (!feed) return;
    const div = document.createElement('div');
    div.innerHTML = _renderTxRow(tx); // _renderTxRow uses _esc internally
    const first = feed.firstChild;
    if (first) feed.insertBefore(div.firstElementChild, first);
    else feed.appendChild(div.firstElementChild);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     PUBLIC — INIT (entry point)
  ═══════════════════════════════════════════════════════════════════════ */

  /**
   * Initialise the SFOS SDK.
   * Waits for Firebase Auth state, then loads identity and wallet state.
   * Dispatches CustomEvent('sfosReady') on window when complete.
   *
   * Call once from sfos-wallet.html: SFOSCore.init()
   */
  async function init() {
    try {
      const { getAuth, onAuthStateChanged } = await import(
        `${FB_SDK}/firebase-auth.js`
      );
      const auth = getAuth(window.firebaseApp);

      onAuthStateChanged(auth, async user => {
        if (!user) {
          window.location.href = LOGIN_URL;
          return;
        }
        _uid = user.uid;

        // Set avatar initial from Auth profile
        const initials = (user.displayName?.[0] || user.email?.[0] || 'U').toUpperCase();
        const avEl = document.getElementById('sfos-avatar');
        if (avEl) avEl.textContent = _esc(initials);

        // Parallelise initial data loads for fast first paint
        await Promise.allSettled([
          loadIdentity(),
          getWalletState(),
        ]);

        // Load home panel activity feed
        await loadActivity(_anPeriod).catch(() => {});

        // Signal readiness to the page
        window.dispatchEvent(new CustomEvent('sfosReady', {
          detail: { uid: _uid, identity: _identity, wallet: _walletState },
        }));

        console.info('[SFOS] Initialised successfully', { uid: _uid });
      });

    } catch (e) {
      console.error('[SFOS] init error', e);
      toast('Failed to initialise SFOS. Please reload.', 'error', 8000);
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════
     PUBLIC API
  ═══════════════════════════════════════════════════════════════════════ */

  return {
    // Core
    init,
    showPanel,
    openOverlay,
    closeOverlay,
    toast,

    // Identity & Wallet State
    loadIdentity,
    getWalletState,

    // Money
    executeSend,
    openEscrow,
    releaseEscrow,

    // Savings
    loadSavings,
    createVault,
    depositToVault,
    withdrawFromVault,
    renderVaultGrid,

    // Business
    loadMerchantDashboard,
    settleMerchant,
    loadGroupWallet,

    // Analytics
    loadHealthScore,
    loadNetWorth,
    loadActivity,
    loadAiForecast,

    // Security
    loadSecurityStatus,
    toggleFreeze,
    checkRisk,
    setLimits,

    // Rewards
    loadRewards,
    redeemPoints,

    // QR
    generateQR,
    drawQRCanvas,

    // Exposed helpers (useful for custom page logic)
    _esc,
    _fmt,
    _fmtShort,
    _relativeTime,
    _countUp,
    _drawHealthGauge,
    _drawProgressRing,
    _renderTxRow,
    _txIcon,
  };
})();
