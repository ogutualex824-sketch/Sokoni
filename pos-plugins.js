/* SOKONI SmartPOS — Plugin Architecture v1.0
   Requirement 40: Extensible plugin system with hook events,
   permission model, lifecycle management, and plugin store. */

'use strict';

const PosPlugins = (() => {

  /* ── Registry ──────────────────────────────────────────────── */
  const _registry  = new Map();  // id → plugin definition
  const _active    = new Map();  // id → { instance, enabled }
  const _hooks     = new Map();  // event → [{pluginId, fn, priority}]
  const _listeners = new Map();  // for cleanup

  /* ── Permission model ──────────────────────────────────────── */
  const PERMISSIONS = {
    'products:read':      () => PosDB.products.getAll(),
    'products:write':     null,
    'transactions:read':  () => PosDB.transactions.getAll(),
    'customers:read':     () => PosDB.customers.getAll(),
    'settings:read':      () => PosDB.settings.getAll(),
    'reports:read':       null,
    'ui:panel':           null,
    'ui:modal':           null,
    'notifications:send': null,
  };

  /* ── Hook event catalogue ──────────────────────────────────── */
  const HOOK_EVENTS = [
    'boot:before',       'boot:after',
    'sale:before',       'sale:after',
    'product:added',     'product:removed',
    'cart:updated',      'cart:cleared',
    'cashier:login',     'cashier:logout',
    'shift:open',        'shift:close',
    'inventory:updated', 'stock:low',
    'customer:selected', 'payment:before', 'payment:after',
    'tab:switch',        'barcode:scanned',
    'sync:complete',     'import:complete',
    'settings:changed',
  ];

  /* ── Context object passed to every plugin ─────────────────── */
  function _buildContext(pluginId) {
    const perms = _registry.get(pluginId)?.permissions || [];
    return {
      id:     pluginId,
      db:     PosDB,
      emit:   (event, data) => _emit(event, data, pluginId),
      toast:  (msg, type) => { if (window.SPos) SPos.toast(msg, type); },
      modal:  { open: id => SPos.modal.open(id), close: id => SPos.modal.close(id) },
      state:  () => window.SPos ? SPos.state : {},
      settings: () => PosDB.settings.getAll(),

      /* Scoped storage — each plugin has its own namespace */
      storage: {
        get:    key => PosDB.settings.get(`__plugin_${pluginId}_${key}`),
        set:    (key, val) => PosDB.settings.set(`__plugin_${pluginId}_${key}`, val),
        delete: key => PosDB.settings.delete(`__plugin_${pluginId}_${key}`),
      },

      /* Mount a UI panel into the BOS hub */
      mountPanel(containerId, html) {
        const el = document.getElementById(containerId);
        if (el) el.innerHTML = html;
      },

      /* Request permission (throws if not declared in manifest) */
      requirePermission(perm) {
        if (!perms.includes(perm)) throw new Error(`Plugin "${pluginId}" missing permission: ${perm}`);
      },
    };
  }

  /* ── Register a plugin ─────────────────────────────────────── */
  function register(manifest) {
    if (!manifest?.id) throw new Error('Plugin must have an id');
    if (_registry.has(manifest.id)) {
      console.warn(`[PosPlugins] Plugin already registered: ${manifest.id}`);
      return false;
    }

    /* Validate hooks are known events */
    const unknownHooks = Object.keys(manifest.hooks || {}).filter(h => !HOOK_EVENTS.includes(h));
    if (unknownHooks.length) console.warn(`[PosPlugins] Unknown hooks in ${manifest.id}:`, unknownHooks);

    _registry.set(manifest.id, {
      id:           manifest.id,
      name:         manifest.name         || manifest.id,
      version:      manifest.version      || '1.0.0',
      description:  manifest.description  || '',
      author:       manifest.author       || 'Unknown',
      permissions:  manifest.permissions  || [],
      hooks:        manifest.hooks        || {},
      settings:     manifest.settings     || [],
      icon:         manifest.icon         || '🔌',
      init:         manifest.init         || null,
    });

    console.log(`[PosPlugins] Registered: ${manifest.name || manifest.id} v${manifest.version || '1.0.0'}`);
    return true;
  }

  /* ── Enable / disable ──────────────────────────────────────── */
  async function enable(id) {
    const def = _registry.get(id);
    if (!def) throw new Error(`Plugin not found: ${id}`);

    const ctx = _buildContext(id);

    /* Run init */
    let instance = null;
    if (def.init) {
      instance = await def.init(ctx);
    }

    /* Register hooks */
    for (const [event, fn] of Object.entries(def.hooks)) {
      if (!_hooks.has(event)) _hooks.set(event, []);
      _hooks.get(event).push({ pluginId: id, fn, priority: def.priority || 10 });
    }

    _active.set(id, { instance, enabled: true, ctx });
    await PosDB.settings.set(`__plugin_${id}_enabled`, true);
    console.log(`[PosPlugins] Enabled: ${def.name}`);
  }

  async function disable(id) {
    if (!_active.has(id)) return;
    const { instance } = _active.get(id);

    /* Run cleanup if plugin provides it */
    if (instance?.destroy) await instance.destroy();

    /* Remove hooks */
    for (const [event, handlers] of _hooks.entries()) {
      _hooks.set(event, handlers.filter(h => h.pluginId !== id));
    }

    _active.delete(id);
    await PosDB.settings.set(`__plugin_${id}_enabled`, false);
  }

  async function uninstall(id) {
    await disable(id);
    _registry.delete(id);
    /* Clear plugin storage */
    const all = await PosDB.settings.getAll();
    for (const key of Object.keys(all)) {
      if (key.startsWith(`__plugin_${id}_`)) await PosDB.settings.delete(key);
    }
  }

  /* ── Emit an event ─────────────────────────────────────────── */
  async function _emit(event, data, sourceId) {
    const handlers = (_hooks.get(event) || [])
      .filter(h => h.pluginId !== sourceId)
      .sort((a, b) => a.priority - b.priority);

    let payload = data;
    for (const h of handlers) {
      try {
        const result = await h.fn(payload, _buildContext(h.pluginId));
        if (result === false) return false; /* cancel */
        if (result !== undefined && result !== null) payload = result;
      } catch (e) {
        console.error(`[PosPlugins] Hook error (${h.pluginId}:${event}):`, e);
      }
    }
    return payload;
  }

  /* Public emit (called by POS core) */
  async function emit(event, data) {
    return _emit(event, data, null);
  }

  /* ── Auto-enable plugins that were enabled in last session ──── */
  async function restoreEnabled() {
    for (const [id] of _registry) {
      const wasEnabled = await PosDB.settings.get(`__plugin_${id}_enabled`);
      if (wasEnabled === true || wasEnabled === 'true') {
        await enable(id).catch(e => console.error(`[PosPlugins] Failed to restore ${id}:`, e));
      }
    }
  }

  /* ── Render plugin management UI ───────────────────────────── */
  function renderManager(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;

    const plugins = [..._registry.values()];
    if (!plugins.length) {
      el.innerHTML = '<div class="pos-empty" style="padding:20px"><div class="empty-icon">🔌</div><p>No plugins installed.<br><small>Plugins extend POS functionality.</small></p></div>';
      return;
    }

    el.innerHTML = plugins.map(p => {
      const isActive = _active.has(p.id);
      return `
        <div class="plugin-card">
          <div class="plugin-card-icon">${p.icon}</div>
          <div class="plugin-card-info">
            <div class="plugin-card-name">${_esc(p.name)} <span class="plugin-version">v${p.version}</span></div>
            <div class="plugin-card-desc">${_esc(p.description)}</div>
            <div class="plugin-card-author">by ${_esc(p.author)}</div>
            ${p.permissions.length ? `<div class="plugin-perms">${p.permissions.map(perm => `<span class="perm-badge">${perm}</span>`).join('')}</div>` : ''}
          </div>
          <label class="toggle" title="${isActive ? 'Disable' : 'Enable'} plugin">
            <input type="checkbox" ${isActive ? 'checked' : ''} onchange="PosPlugins.toggle('${p.id}',this.checked)" style="accent-color:var(--green)">
            <div class="toggle-track"></div>
            <div class="toggle-thumb"></div>
          </label>
        </div>
      `;
    }).join('');
  }

  async function toggle(id, enabled) {
    if (enabled) await enable(id);
    else         await disable(id);
    if (window.SPos) SPos.toast(`Plugin ${enabled ? 'enabled' : 'disabled'}`, 'info');
  }

  /* ── Built-in example plugins ──────────────────────────────── */
  function installBuiltins() {
    /* Audit logger plugin */
    register({
      id:          'sokoni-audit',
      name:        'Audit Logger',
      version:     '1.0.0',
      description: 'Records every sale, login, and setting change to the audit log.',
      author:      'Sokoni',
      icon:        '📋',
      permissions: ['transactions:read'],
      hooks: {
        'sale:after': async (txn) => {
          if (window.PosAudit) PosAudit.log('sale', { receiptNo: txn.receiptNo, total: txn.total, cashierId: txn.cashierId });
        },
        'cashier:login': async (cashier) => {
          if (window.PosAudit) PosAudit.log('login', { cashierId: cashier?.id, cashierName: cashier?.name });
        },
        'settings:changed': async (changes) => {
          if (window.PosAudit) PosAudit.log('settings_changed', changes);
        },
      },
    });

    /* Low stock notifier plugin */
    register({
      id:          'sokoni-stockalert',
      name:        'Stock Alert',
      version:     '1.0.0',
      description: 'Sends real-time alerts to owner when products run low.',
      author:      'Sokoni',
      icon:        '📦',
      permissions: ['products:read', 'notifications:send'],
      hooks: {
        'stock:low': async (product, ctx) => {
          ctx.toast(`⚠️ Low stock: ${product.name} (${product.stock} left)`, 'error');
          if (window.PosNotify) PosNotify.send('stock_low', product);
        },
      },
    });

    /* Sales analytics plugin */
    register({
      id:          'sokoni-analytics-enhanced',
      name:        'Enhanced Analytics',
      version:     '1.0.0',
      description: 'Tracks hourly sales patterns and customer behavior.',
      author:      'Sokoni',
      icon:        '📊',
      permissions: ['transactions:read', 'customers:read'],
      hooks: {
        'sale:after': async (txn, ctx) => {
          /* Track hourly pattern */
          const hour = new Date().getHours();
          const stored = await ctx.storage.get('hourly_' + hour) || 0;
          await ctx.storage.set('hourly_' + hour, stored + (txn.total || 0));
        },
      },
    });
  }

  function _esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  return {
    register, enable, disable, uninstall, toggle,
    emit, restoreEnabled, renderManager, installBuiltins,
    get active() { return [..._active.keys()]; },
    get all()    { return [..._registry.values()]; },
    HOOK_EVENTS,
  };
})();

window.PosPlugins = PosPlugins;
