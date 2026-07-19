/* ================================================================
   SOKONI UNIVERSAL AI SUBSCRIPTION OPERATING SYSTEM
   sokoni-sasos.js — Client SDK v1.0.0  |  2026-06-21

   Zero-trust entitlement SDK for use on all SOKONI pages.
   Every entitlement check triggers a fresh server read.
   Never trust localStorage, cookies, or any client state.

   Usage:
     const ok = await SokoniSASOS.checkFeature('ai', 'aiChat');
     const usage = await SokoniSASOS.getUsage('marketplace');
     await SokoniSASOS.recordUsage('ai', 'aiMessages', 1);
     await SokoniSASOS.deductCredits('ai', 50, 'AI chat query');

   Event emitters (subscribe with SokoniSASOS.on(event, fn)):
     'feature:blocked'    — fired when checkFeature returns false
     'quota:warning'      — fired when usage > 80% of limit
     'quota:exceeded'     — fired when quota is full
     'subscription:ready' — fired after first successful plan load
     'plan:upgraded'      — fired after a subscribe() success
     'risk:restricted'    — fired when risk level is elevated
================================================================ */
(function (window) {
  'use strict';

  /* ── Internal helpers ─────────────────────────────────────── */
  const _listeners  = {};
  const _planCache  = { data: null, fetchedAt: 0, ttl: 60000 };   /* 60s TTL */
  const _featureReqs = new Map();                                   /* dedup inflight */

  function _emit(event, payload) {
    (_listeners[event] || []).forEach(fn => { try { fn(payload); } catch (_) {} });
  }

  function _callCF(name, data) {
    if (!window.firebase || !firebase.functions) throw new Error('Firebase Functions SDK not loaded.');
    const fn = firebase.functions().httpsCallable(name);
    return fn(data).then(r => r.data);
  }

  function _uid() {
    const user = firebase?.auth?.()?.currentUser;
    if (!user) throw new Error('User not authenticated.');
    return user.uid;
  }

  /* ── XSS-safe DOM helper ─────────────────────────────────── */
  function _sanitize(str) {
    const d = document.createElement('div');
    d.textContent = String(str || '');
    return d.innerHTML;
  }

  /* ================================================================
     ENTITLEMENT GATE UI
     Renders a dismissible gate overlay whenever a feature is blocked.
     Pass a targetEl to render inline; omit for a fullscreen overlay.
  ================================================================ */
  function _renderGate(opts = {}) {
    const id = 'sasos-gate-overlay';
    /* Remove existing gate if present */
    const existing = document.getElementById(id);
    if (existing) existing.remove();

    const planName = _sanitize(opts.planName || 'Pro');
    const product  = _sanitize(opts.product || '');
    const feature  = _sanitize(opts.feature || 'This feature');

    const overlay = document.createElement('div');
    overlay.id    = id;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Feature requires upgrade');
    overlay.style.cssText = [
      'position:fixed;inset:0;z-index:var(--sk-z-sheet,100010);background:rgba(0,0,0,.6)',
      'display:flex;align-items:center;justify-content:center;padding:16px',
    ].join(';');

    overlay.innerHTML = `
      <div style="background:#fff;border-radius:16px;padding:32px 24px;max-width:400px;width:100%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.25)">
        <div style="font-size:48px;margin-bottom:12px">🔒</div>
        <h2 style="font-size:1.25rem;font-weight:700;color:#0f172a;margin:0 0 8px">${feature} requires an upgrade</h2>
        <p style="color:#64748b;font-size:.9rem;margin:0 0 24px">This feature is available on the <strong>${planName}</strong> plan${product ? ` for ${product}` : ''}.</p>
        <button id="sasos-gate-upgrade" style="background:#2563eb;color:#fff;border:none;border-radius:10px;padding:12px 28px;font-size:1rem;font-weight:600;cursor:pointer;width:100%;margin-bottom:10px">
          Upgrade Now
        </button>
        <button id="sasos-gate-dismiss" style="background:transparent;border:none;color:#64748b;font-size:.875rem;cursor:pointer;padding:8px">
          Maybe later
        </button>
      </div>`;

    document.body.appendChild(overlay);

    document.getElementById('sasos-gate-upgrade').addEventListener('click', () => {
      overlay.remove();
      window.location.href = `/subscription-os.html?product=${encodeURIComponent(opts.product || '')}&upgrade=1`;
    });

    document.getElementById('sasos-gate-dismiss').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

    /* Trap focus inside overlay */
    const focusable = overlay.querySelectorAll('button');
    if (focusable.length) focusable[0].focus();
  }

  /* ================================================================
     USAGE PROGRESS BAR
     Renders a coloured progress bar for a usage stat.
     Used on subscription dashboards and feature UI.
  ================================================================ */
  function _renderUsageBar(containerEl, opts = {}) {
    const pct   = Math.min(100, Math.max(0, opts.pct || 0));
    const color = pct >= 90 ? '#ef4444' : pct >= 75 ? '#f59e0b' : '#22c55e';
    containerEl.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
        <span style="font-size:.75rem;font-weight:600;color:#374151">${_sanitize(opts.label || '')}</span>
        <span style="font-size:.75rem;color:#6b7280">${_sanitize(String(opts.used||0))} / ${_sanitize(String(opts.limit||0))}</span>
      </div>
      <div style="background:#e5e7eb;border-radius:9999px;height:8px;overflow:hidden">
        <div style="background:${color};width:${pct}%;height:100%;border-radius:9999px;transition:width .4s"></div>
      </div>`;
  }

  /* ================================================================
     PUBLIC API
  ================================================================ */
  const SokoniSASOS = {

    /* ── Event system ─────────────────────────────────────────── */
    on(event, fn) {
      if (!_listeners[event]) _listeners[event] = [];
      _listeners[event].push(fn);
      return this;
    },

    off(event, fn) {
      if (_listeners[event]) _listeners[event] = _listeners[event].filter(f => f !== fn);
      return this;
    },

    /* ── checkFeature (zero-trust) ───────────────────────────── */
    async checkFeature(product, featureKey, opts = {}) {
      const key = `${product}:${featureKey}`;
      /* Dedup parallel calls for the same feature */
      if (_featureReqs.has(key)) return _featureReqs.get(key);

      const promise = (async () => {
        try {
          const result = await _callCF('sasosCheckFeature', { product, featureKey });
          if (!result.allowed) {
            _emit('feature:blocked', { product, featureKey, reason: result.reason });
            if (opts.showGate !== false) {
              _renderGate({
                product,
                feature:  result.featureLabel  || featureKey,
                planName: result.requiredPlan   || 'Pro',
              });
            }
          }
          return result.allowed === true;
        } catch (err) {
          /* On error: fail closed (deny access) */
          console.warn('[SASOS] checkFeature failed:', err.message);
          return false;
        } finally {
          _featureReqs.delete(key);
        }
      })();

      _featureReqs.set(key, promise);
      return promise;
    },

    /* ── checkQuota (non-mutating pre-check) ─────────────────── */
    async checkQuota(product, counterKey, amount = 1) {
      try {
        return await _callCF('sasosCheckQuota', { product, counterKey, amount });
      } catch (err) {
        console.warn('[SASOS] checkQuota failed:', err.message);
        return { allowed: false, reason: 'check_failed' };
      }
    },

    /* ── recordUsage (atomic, quota-gated) ───────────────────── */
    async recordUsage(product, counterKey, amount = 1, meta = {}) {
      try {
        const result = await _callCF('sasosRecordUsage', { product, counterKey, amount, meta });
        if (!result.allowed) _emit('quota:exceeded', { product, counterKey, remaining: result.remaining });
        else if (result.warn)  _emit('quota:warning',  { product, counterKey, remaining: result.remaining });
        return result;
      } catch (err) {
        console.warn('[SASOS] recordUsage failed:', err.message);
        return { allowed: false };
      }
    },

    /* ── deductCredits ───────────────────────────────────────── */
    async deductCredits(product, amount, description) {
      try {
        return await _callCF('sasosDeductCredits', { product, amount, description });
      } catch (err) {
        console.warn('[SASOS] deductCredits failed:', err.message);
        return { success: false };
      }
    },

    /* ── getCredits ──────────────────────────────────────────── */
    async getCredits() {
      try {
        return await _callCF('sasosGetCredits', {});
      } catch (err) {
        console.warn('[SASOS] getCredits failed:', err.message);
        return { balance: 0, totalPurchased: 0, totalSpent: 0 };
      }
    },

    /* ── getUsage ────────────────────────────────────────────── */
    async getUsage(product) {
      try {
        return await _callCF('sasosGetUsage', { product });
      } catch (err) {
        console.warn('[SASOS] getUsage failed:', err.message);
        return { usage: {} };
      }
    },

    /* ── getSubscription ─────────────────────────────────────── */
    async getSubscription() {
      try {
        const result = await _callCF('sasosGetSubscription', {});
        _emit('subscription:ready', result);
        return result;
      } catch (err) {
        console.warn('[SASOS] getSubscription failed:', err.message);
        return { products: {} };
      }
    },

    /* ── listPlans (cached, public) ──────────────────────────── */
    async listPlans(product) {
      const now = Date.now();
      if (_planCache.data && (now - _planCache.fetchedAt) < _planCache.ttl) {
        const plans = _planCache.data;
        return product ? plans.filter(p => p.productId === product) : plans;
      }
      try {
        const result = await _callCF('sasosListPlans', { product });
        _planCache.data      = result.plans || [];
        _planCache.fetchedAt = Date.now();
        return _planCache.data;
      } catch (err) {
        console.warn('[SASOS] listPlans failed:', err.message);
        return [];
      }
    },

    /* ── subscribe ────────────────────────────────────────────── */
    async subscribe(planId, billing = 'monthly', paymentRef = null) {
      try {
        const result = await _callCF('sasosSubscribe', { planId, billing, paymentRef });
        if (result.success) _emit('plan:upgraded', { planId, billing });
        return result;
      } catch (err) {
        console.warn('[SASOS] subscribe failed:', err.message);
        throw err;
      }
    },

    /* ── cancel ───────────────────────────────────────────────── */
    async cancel(product, immediate = false) {
      try {
        return await _callCF('sasosCancel', { product, immediate });
      } catch (err) {
        console.warn('[SASOS] cancel failed:', err.message);
        throw err;
      }
    },

    /* ── getRiskProfile ──────────────────────────────────────── */
    async getRiskProfile() {
      try {
        const result = await _callCF('sasosGetRiskProfile', {});
        if (result.action === 'restrict' || result.action === 'suspend') {
          _emit('risk:restricted', result);
        }
        return result;
      } catch (err) {
        console.warn('[SASOS] getRiskProfile failed:', err.message);
        return { riskScore: 0, trustScore: 100, action: 'allow' };
      }
    },

    /* ── reportSignal (client-side fraud signal) ─────────────── */
    async reportSignal(signalType, context = {}) {
      try {
        return await _callCF('sasosUpdateRiskScore', {
          signals: [signalType],
          context: {
            ip:        null,
            userAgent: navigator.userAgent || '',
            deviceId:  context.deviceId  || '',
            page:      window.location.pathname,
          },
        });
      } catch (err) {
        console.warn('[SASOS] reportSignal failed:', err.message);
        return { riskScore: 0 };
      }
    },

    /* ── getInsights ─────────────────────────────────────────── */
    async getInsights() {
      try {
        return await _callCF('sasosGetInsights', {});
      } catch (err) {
        console.warn('[SASOS] getInsights failed:', err.message);
        return { scores: {} };
      }
    },

    /* ── getRecommendations ──────────────────────────────────── */
    async getRecommendations(product, withCopy = false) {
      try {
        return await _callCF('sasosGetRecommendations', { product, withCopy });
      } catch (err) {
        console.warn('[SASOS] getRecommendations failed:', err.message);
        return { recommendations: [] };
      }
    },

    /* ── UI utilities ─────────────────────────────────────────── */

    renderGate: _renderGate,
    renderUsageBar: _renderUsageBar,

    /* Inject a plan badge into any element (e.g. sidebar item) */
    renderPlanBadge(el, tier) {
      const colors = {
        free:       '#6b7280', starter:  '#3b82f6', pro:       '#a8ff58',
        business:   '#f59e0b', enterprise: '#ef4444',
      };
      const badge = document.createElement('span');
      badge.textContent = (tier || 'FREE').toUpperCase();
      badge.style.cssText = `
        display:inline-block;padding:2px 7px;border-radius:6px;
        font-size:.625rem;font-weight:700;color:#fff;
        background:${colors[tier] || '#6b7280'};margin-left:6px;vertical-align:middle`;
      el.appendChild(badge);
    },

    /* Render a full subscription overview into a container element */
    async renderSubscriptionOverview(containerEl, product) {
      if (!containerEl) return;
      containerEl.innerHTML = '<p style="color:#6b7280;font-size:.875rem">Loading subscription…</p>';

      try {
        const [sub, usage] = await Promise.all([
          this.getSubscription(),
          product ? this.getUsage(product) : Promise.resolve({ usage: {} }),
        ]);

        const products = product
          ? { [product]: sub.products?.[product] }
          : (sub.products || {});

        let html = '';
        for (const [prod, state] of Object.entries(products)) {
          if (!state) continue;
          const statusColor = { active: '#22c55e', trial: '#3b82f6', grace: '#f59e0b', suspended: '#ef4444', free: '#6b7280' }[state.status] || '#6b7280';
          html += `<div style="border:1px solid #e5e7eb;border-radius:12px;padding:16px;margin-bottom:12px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
              <strong style="text-transform:capitalize">${_sanitize(prod)}</strong>
              <span style="background:${statusColor};color:#fff;font-size:.7rem;font-weight:700;padding:3px 10px;border-radius:20px">${_sanitize((state.tier || 'free').toUpperCase())}</span>
            </div>`;

          const usageData = usage.usage || {};
          for (const [key, val] of Object.entries(usageData)) {
            const div = document.createElement('div');
            div.style.marginBottom = '8px';
            _renderUsageBar(div, { label: key, used: val.used, limit: val.limit, pct: val.pct });
            html += div.outerHTML;
          }

          if (state.periodEnd) {
            const days = Math.max(0, Math.round((state.periodEnd - Date.now()) / 86400000));
            html += `<p style="font-size:.75rem;color:#6b7280;margin:8px 0 0">Renews in <strong>${days} days</strong></p>`;
          }
          html += '</div>';
        }

        containerEl.innerHTML = html || '<p style="color:#6b7280">No active subscriptions.</p>';
      } catch (err) {
        containerEl.innerHTML = '<p style="color:#ef4444;font-size:.875rem">Failed to load subscription info.</p>';
      }
    },

    /* ── Initialise (call once on page load) ─────────────────── */
    async init(opts = {}) {
      if (!window.firebase || !firebase.auth) {
        console.warn('[SASOS] Firebase Auth SDK not loaded. SASOS will not function.');
        return;
      }

      firebase.auth().onAuthStateChanged(async user => {
        if (!user) return;
        try {
          await this.getSubscription();
        } catch (_) { /* silent */ }
      });

      /* Monitor for DevTools open (fraud signal) */
      if (opts.monitorDevtools !== false) {
        const _dt = () => { const t = new Date(); debugger; return new Date() - t > 100; };
        const _dtTimer = setInterval(() => { if (_dt()) this.reportSignal('devtools_open').catch(() => {}); }, 30000);
        window.addEventListener('pagehide', () => clearInterval(_dtTimer), { once: true });
      }
    },
  };

  /* ── Expose globally ─────────────────────────────────────── */
  window.SokoniSASOS = SokoniSASOS;

})(window);
